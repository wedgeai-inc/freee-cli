import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { redact } from "../../src/lib/audit/redactor.js";
import { appendPartnerAudit, appendPartnerUpdateAudit } from "../../src/lib/audit/partner-audit.js";

describe("partner audit redaction", () => {
  it.each(["long_name", "name_kana", "contact_name", "phone", "zipcode", "street_name1", "street_name2", "invoice_registration_number"])("does not retain %s", (key) => {
    const value = `secret-${key}`;
    const redacted = JSON.stringify(redact({ [key]: value }));
    expect(redacted).not.toContain(value);
    expect(redacted).toContain("[REDACTED]");
  });
});

describe("partner audit persistence guard", () => {
  const entry = (payload_redacted: unknown) => ({
    timestamp: "2026-09-07T00:00:00.000Z", task_id: "job", event: "partner_create" as const,
    mode: "dry-run" as const, status: "planned" as const, company_id: 1, payload_redacted,
  });

  it("rejects an email address embedded in a persisted field", async () => {
    await expect(appendPartnerAudit("/tmp/partner-audit-test", { ...entry({}), task_id: "job user@example.com" })).rejects.toThrow(/redact leak/);
  });

  it("rejects a raw value under a sensitive key", async () => {
    await expect(appendPartnerAudit("/tmp/partner-audit-test", entry({ name_kana: "トリヒキサキ" }))).rejects.toThrow(/redact leak/);
  });

  it("rejects a Bearer token in an audit entry", async () => {
    await expect(appendPartnerAudit("/tmp/partner-audit-test", entry({ note: "Bearer secret-token" }))).rejects.toThrow(/redact leak/);
  });
});

describe("partner update audit persistence", () => {
  const entry = (payload_redacted: unknown) => ({
    timestamp: "2026-09-08T00:00:00.000Z", task_id: "job", event: "partner_update" as const,
    mode: "execute" as const, status: "updated" as const, company_id: 1, partner_id: 100,
    payload_redacted, ignored: [], put_state: "succeeded" as const,
  });

  it("writes the update entry to its dated JSONL file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "partner-update-audit-"));
    try {
      const value = entry({ name: "[REDACTED]" });
      await appendPartnerUpdateAudit(dir, value);
      expect(JSON.parse(await readFile(join(dir, "freee-partner-update-2026-09-08.jsonl"), "utf8"))).toEqual(value);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each(["Bearer secret-token", "person@example.com"])("rejects a leaked update entry value: %s", async (leak) => {
    await expect(appendPartnerUpdateAudit("/tmp/partner-update-audit-test", { ...entry({}), task_id: `job ${leak}` })).rejects.toThrow(/redact leak/);
  });
});
