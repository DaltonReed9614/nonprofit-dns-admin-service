import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import {
  applyNonprofitDns,
  InfraiDnsClient,
  InfraiError
} from "./nonprofit_dns_service.js";

const planSchema = z.object({
  domain: z.string().min(1),
  receipt_spf: z.string().startsWith("v=spf1 "),
  reminder_target: z.string().min(1),
  reporting_target: z.string().min(1)
}).strict();

const managedRecordSchema = z.object({
  purpose: z.enum(["donor-receipts", "volunteer-reminders", "campaign-reporting"]),
  record_type: z.enum(["TXT", "CNAME"]),
  name: z.string().min(1),
  content: z.string().min(1),
  ttl: z.number().int().positive()
}).strict();

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("apply"), plan: planSchema }).strict(),
  z.object({ action: z.literal("list"), domain: z.string().min(1) }).strict(),
  z.object({
    action: z.literal("update"),
    domain: z.string().min(1),
    record: managedRecordSchema,
    record_id: z.string().min(1).optional()
  }).strict(),
  z.object({ action: z.literal("delete"), domain: z.string().min(1) }).strict()
]);

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body, null, 2));
}

async function runAction(client: InfraiDnsClient, input: z.infer<typeof actionSchema>): Promise<unknown> {
  if (input.action === "apply") return applyNonprofitDns(client, input.plan);
  const zone_id = await client.getZoneId(input.domain);
  if (input.action === "list") return { zone_id, records: await client.listRecords(zone_id) };
  if (input.action === "delete") return { zone_id, deleted: await client.deleteRecords(zone_id) };
  return {
    zone_id,
    updated: await client.updateRecord(zone_id, input.record, input.record_id)
  };
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST" || request.url !== "/admin/dns") {
    reply(response, 404, { error: "Route not found" });
    return;
  }

  try {
    const input = actionSchema.parse(await readJson(request));
    const result = await runAction(new InfraiDnsClient(), input);
    reply(response, 200, { ok: true, result });
  } catch (error) {
    if (error instanceof z.ZodError) {
      reply(response, 400, { ok: false, error: "Invalid request body", details: error.issues });
      return;
    }
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      reply(response, status, { ok: false, error: error.message, code: error.code });
      return;
    }
    reply(response, 502, { ok: false, error: error instanceof Error ? error.message : "Request failed" });
  }
}

const port = Number(process.env.PORT ?? 3000);
const server = createServer((request, response) => void handle(request, response));
server.listen(port, () => {
  console.log(`Nonprofit DNS admin listening at http://localhost:${port}/admin/dns`);
});

if (process.argv.includes("--demo")) {
  console.log("Send the apply body from README.md to the endpoint above.");
}
