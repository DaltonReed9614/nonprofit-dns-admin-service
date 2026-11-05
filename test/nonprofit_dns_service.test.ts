import assert from "node:assert/strict";
import test from "node:test";
import { buildManagedRecords } from "../src/nonprofit_dns_service.js";

test("the nonprofit plan separates receipts, reminders, and reporting", () => {
  const records = buildManagedRecords({
    domain: "helping-hands.example",
    receipt_spf: "v=spf1 include:mail.example -all",
    reminder_target: "reminders.provider.example",
    reporting_target: "reports.analytics.example"
  });

  assert.deepEqual(records, [
    {
      purpose: "donor-receipts",
      record_type: "TXT",
      name: "receipts",
      content: "v=spf1 include:mail.example -all",
      ttl: 300
    },
    {
      purpose: "volunteer-reminders",
      record_type: "CNAME",
      name: "reminders",
      content: "reminders.provider.example",
      ttl: 300
    },
    {
      purpose: "campaign-reporting",
      record_type: "CNAME",
      name: "reports",
      content: "reports.analytics.example",
      ttl: 900
    }
  ]);
});
