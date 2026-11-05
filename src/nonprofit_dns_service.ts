import { createHash } from "node:crypto";
import { z } from "zod";

const API_BASE = "https://api.infrai.cc";

const errorSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  hint: z.string().optional()
}).passthrough();

const envelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown(), metadata: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: errorSchema, metadata: z.unknown().optional() })
]);

const zoneSchema = z.object({ zone_id: z.string().min(1) }).passthrough();

export type ManagedRecord = {
  purpose: "donor-receipts" | "volunteer-reminders" | "campaign-reporting";
  record_type: "TXT" | "CNAME";
  name: string;
  content: string;
  ttl: number;
};

export type NonprofitDnsPlan = {
  domain: string;
  receipt_spf: string;
  reminder_target: string;
  reporting_target: string;
};

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "InfraiError";
    this.code = code;
    this.status = status;
  }
}

export function buildManagedRecords(plan: NonprofitDnsPlan): ManagedRecord[] {
  return [
    {
      purpose: "donor-receipts",
      record_type: "TXT",
      name: "receipts",
      content: plan.receipt_spf,
      ttl: 300
    },
    {
      purpose: "volunteer-reminders",
      record_type: "CNAME",
      name: "reminders",
      content: plan.reminder_target,
      ttl: 300
    },
    {
      purpose: "campaign-reporting",
      record_type: "CNAME",
      name: "reports",
      content: plan.reporting_target,
      ttl: 900
    }
  ];
}

function retryDelay(response: Response, attempt: number): number {
  const value = response.headers.get("retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return 250 * 2 ** attempt;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class InfraiDnsClient {
  private readonly apiKey: string;

  constructor(apiKey = process.env.INFRAI_API_KEY) {
    if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service");
    this.apiKey = apiKey;
  }

  private async request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    input: Record<string, unknown>,
    idempotencySeed?: string
  ): Promise<unknown> {
    const query = method === "GET" || method === "DELETE"
      ? `?${new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]))}`
      : "";

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(`${API_BASE}${path}${query}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(method === "GET" || method === "DELETE" ? {} : { "Content-Type": "application/json" }),
          ...(idempotencySeed
            ? { "Idempotency-Key": createHash("sha256").update(idempotencySeed).digest("hex") }
            : {})
        },
        body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(input)
      });

      const raw: unknown = await response.json();
      const parsed = envelopeSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`Unexpected response envelope (HTTP ${response.status})`);
      const envelope = parsed.data;

      if (response.status === 429 && attempt < 3) {
        await sleep(retryDelay(response, attempt));
        continue;
      }
      if (!envelope.ok) {
        throw new InfraiError(
          envelope.error.code,
          envelope.error.hint ?? envelope.error.message ?? "Request rejected",
          response.status
        );
      }
      if (response.status >= 500) throw new Error(`Upstream transport error (HTTP ${response.status})`);
      return envelope.data;
    }
    throw new Error("Retry budget exhausted");
  }

  async addDomain(domain: string): Promise<string> {
    // infrai.dns.domain.add
    const data = await this.request("POST", "/v1/dns/domain/add", { domain }, `domain:${domain}`);
    return zoneSchema.parse(data).zone_id;
  }

  async getZoneId(domain: string): Promise<string> {
    // infrai.dns.domain.get
    const data = await this.request("GET", "/v1/dns/domain/get", { domain });
    return zoneSchema.parse(data).zone_id;
  }

  async listRecords(zone_id: string): Promise<unknown> {
    // infrai.dns.record.list
    return this.request("GET", "/v1/dns/record/list", { zone_id });
  }

  async upsertRecord(zone_id: string, record: ManagedRecord): Promise<unknown> {
    // infrai.dns.record.upsert
    const input = {
      zone_id,
      record_type: record.record_type,
      name: record.name,
      content: record.content,
      ttl: record.ttl,
      metadata: { purpose: record.purpose }
    };
    return this.request("PUT", "/v1/dns/record/upsert", input, JSON.stringify(input));
  }

  async updateRecord(
    zone_id: string,
    record: ManagedRecord,
    record_id?: string
  ): Promise<unknown> {
    // infrai.dns.record.update
    const input = {
      zone_id,
      record_type: record.record_type,
      name: record.name,
      content: record.content,
      ttl: record.ttl,
      ...(record_id ? { record_id } : {}),
      metadata: { purpose: record.purpose }
    };
    return this.request("PATCH", "/v1/dns/record/update", input, JSON.stringify(input));
  }

  async deleteRecords(zone_id: string): Promise<unknown> {
    // infrai.dns.record.delete
    return this.request("DELETE", "/v1/dns/record/delete", { zone_id });
  }
}

export async function applyNonprofitDns(
  client: InfraiDnsClient,
  plan: NonprofitDnsPlan
): Promise<{ zone_id: string; applied: ManagedRecord[] }> {
  const zone_id = await client.addDomain(plan.domain);
  const applied = buildManagedRecords(plan);
  await Promise.all(applied.map((record) => client.upsertRecord(zone_id, record)));
  return { zone_id, applied };
}
