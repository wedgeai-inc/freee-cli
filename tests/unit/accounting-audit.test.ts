import { expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDealAudit } from "../../src/lib/audit/deal-audit.js";
import { appendReceiptAudit } from "../../src/lib/audit/receipt-audit.js";

it("JSONLの自由記述・名前・credentialをマスクし、証憑本文とパスを記録しない", async () => {
  const dir = await mkdtemp(join(tmpdir(), "freee-audit-test-"));
  try {
    const base = { timestamp: "2026-01-15T00:00:00.000Z", task_id: "sample", mode: "dry-run" as const, status: "planned" as const, company_id: 1, payload_redacted: { description: "架空摘要", receipt_metadatum_issue_date: "2026-01-15", ref_number: "private-reference", name: "架空氏名", authorization: "Bearer fictional-secret", details: [{ description: "private-detail", amount: 1500 }] } };
    await appendDealAudit(dir, { ...base, event: "deal_create" });
    await appendReceiptAudit(dir, { ...base, event: "receipt_upload", filename: "sample.pdf", sha256: "a".repeat(64) });
    const files = await readdir(dir);
    expect(files).toHaveLength(2);
    for (const file of files) {
      const text = await readFile(join(dir, file), "utf8");
      expect(text.endsWith("\n")).toBe(true);
      expect(JSON.parse(text).payload_redacted.description).toBe("[REDACTED]");
      expect(JSON.parse(text).payload_redacted.receipt_metadatum_issue_date).toBe("[REDACTED]");
      for (const value of ["架空摘要", "private-reference", "架空氏名", "fictional-secret", "private-detail"]) expect(text).not.toContain(value);
    }
  } finally { await rm(dir, { recursive: true }); }
});
it("自由文字列中のBearer値もマスクする", async () => {
  const dir = await mkdtemp(join(tmpdir(), "freee-audit-test-"));
  try {
    await appendReceiptAudit(dir, { timestamp: "2026-01-15T00:00:00.000Z", task_id: "Bearer fictional-task-secret", event: "receipt_upload", mode: "dry-run", status: "planned", company_id: 1, payload_redacted: { arbitrary: "Bearer fictional-field-secret" }, filename: "Bearer fictional-file-secret.pdf", sha256: "a".repeat(64) });
    const text = await readFile(join(dir, (await readdir(dir))[0]!), "utf8");
    expect(text).not.toContain("fictional-");
  } finally { await rm(dir, { recursive: true }); }
});
