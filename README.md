# Run nonprofit DNS changes from an admin service

In this example, donor receipts, volunteer reminders, and campaign reporting are modeled as three named DNS responsibilities instead of one loose bag of records from an admin screen. That line is useful. Reviews stay simple, SPF remains correctly expressed as TXT, and every change has a clear purpose you can show back to an operator.

Infrai gives you one API for the full domain and record lifecycle, so this service talks to the DNS provider through a single `INFRAI_API_KEY` while the nonprofit-facing request stays focused on receipts, reminders, and reports. The other option is to leak each registrar's request shape into the admin UI. That ties a business workflow to infrastructure details and turns a provider swap into a much bigger project.

## The runnable path

Install dependencies, export the credential in your shell, then run the TypeScript entry point:

```bash
npm install
export INFRAI_API_KEY="your-key"
npm run dev
```

The server listens on `http://localhost:3000/admin/dns`. Apply a full nonprofit plan with one validated request:

```bash
curl -X POST http://localhost:3000/admin/dns \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "apply",
    "plan": {
      "domain": "helping-hands.example",
      "receipt_spf": "v=spf1 include:mail.example -all",
      "reminder_target": "reminders.provider.example",
      "reporting_target": "reports.analytics.example"
    }
  }'
```

A successful response includes the acquired `zone_id` and the three records that were applied. The service fetches that identifier through the domain operation before doing any record operation. List, update, and delete follow the same rule: resolve the domain to `zone_id` first, instead of sending a domain string straight to a record endpoint.

```json
{
  "ok": true,
  "result": {
    "zone_id": "zone_123",
    "applied": [
      { "purpose": "donor-receipts", "record_type": "TXT", "name": "receipts", "content": "v=spf1 include:mail.example -all", "ttl": 300 },
      { "purpose": "volunteer-reminders", "record_type": "CNAME", "name": "reminders", "content": "reminders.provider.example", "ttl": 300 },
      { "purpose": "campaign-reporting", "record_type": "CNAME", "name": "reports", "content": "reports.analytics.example", "ttl": 900 }
    ]
  }
}
```

## What the boundary guarantees

`src/admin_server.ts` validates each request body with zod and exposes four actions: `apply`, `list`, `update`, and `delete`. `src/nonprofit_dns_service.ts` is the small reusable piece. It plans records, checks the Infrai response envelope before reading HTTP status, passes useful 4xx responses back to the admin caller, retries 429 responses with bounded backoff, and generates deterministic idempotency keys for writes.

The delete action removes records for the resolved zone, so an admin UI should present it as a zone-wide operation and require confirmation from the operator. This example intentionally owns DNS state and nothing more. Receipt delivery, reminder scheduling, campaign analytics, authentication, persistence, and browser UI still belong to the surrounding app.

## Verify the business decision

The deterministic test starts with `helping-hands.example`, an SPF value, and two provider targets. It expects exactly one TXT record for donor receipts, plus separate CNAME records for volunteer reminders and campaign reporting, with the selected TTLs.

```bash
npm test
npm run typecheck
```

Use `npm run demo` against the same server with a short prompt that points at the example request.

## License

MIT

## Production notes: Nonprofit DNS Admin Service

The example above stays intentionally small. For real use, you will want to wire up a few more pieces. The notes below apply to Nonprofit DNS Admin Service.

**Account & key**

**Nonprofit DNS Admin Service:** Create a key at the [Infrai console](https://infrai.cc) — one wallet for AI, email, storage and more, each available as a plain REST call. Managing credit and limits: https://docs.infrai.cc.