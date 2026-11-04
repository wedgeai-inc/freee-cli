import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { appendInvoiceAudit, appendInvoiceCancelAudit, appendInvoiceUncancelAudit, appendInvoiceUpdateAudit } from "../../src/lib/audit/invoice-audit.js";
import { appendQuotationAudit, appendQuotationCancelAudit, appendQuotationUncancelAudit } from "../../src/lib/audit/quotation-audit.js";
import { appendPartnerAudit, appendPartnerUpdateAudit } from "../../src/lib/audit/partner-audit.js";
import { appendDealAudit } from "../../src/lib/audit/deal-audit.js";
import { appendReceiptAudit } from "../../src/lib/audit/receipt-audit.js";
import { appendAccountingAudit } from "../../src/lib/audit/accounting-audit.js";

const entry = {
  timestamp: "2026-01-15T00:00:00.000Z", task_id: "fictional-test",
  mode: "dry-run", status: "planned", company_id: 1, payload_redacted: {},
} as const;
const routes: [string, (dir: string) => Promise<void>][] = [
  ["invoice-create", dir => appendInvoiceAudit(dir, { ...entry, event: "invoice_create" })],
  ["invoice-cancel", dir => appendInvoiceCancelAudit(dir, { ...entry, event: "invoice_cancel", invoice_id: 2 })],
  ["invoice-uncancel", dir => appendInvoiceUncancelAudit(dir, { ...entry, event: "invoice_uncancel", invoice_id: 2 })],
  ["invoice-update", dir => appendInvoiceUpdateAudit(dir, { ...entry, event: "invoice_update", invoice_id: 2, put_state: "not_attempted" })],
  ["quotation-create", dir => appendQuotationAudit(dir, { ...entry, event: "quotation_create" })],
  ["quotation-cancel", dir => appendQuotationCancelAudit(dir, { ...entry, event: "quotation_cancel", quotation_id: 3 })],
  ["quotation-uncancel", dir => appendQuotationUncancelAudit(dir, { ...entry, event: "quotation_uncancel", quotation_id: 3 })],
  ["partner-create", dir => appendPartnerAudit(dir, { ...entry, event: "partner_create" })],
  ["partner-update", dir => appendPartnerUpdateAudit(dir, { ...entry, event: "partner_update", partner_id: 4, put_state: "not_attempted" })],
  ["deal-create", dir => appendDealAudit(dir, { ...entry, event: "deal_create" })],
  ["receipt-upload", dir => appendReceiptAudit(dir, { ...entry, event: "receipt_upload" })],
  ["deal-payment-create", dir => appendAccountingAudit(dir, { ...entry, event: "deal_payment_create" })],
  ["wallet-txn-reconcile", dir => appendAccountingAudit(dir, { ...entry, event: "wallet_txn_reconcile" })],
];
const permissions = (path: string) => statSync(path).mode & 0o7777;

it.each([0o022, 0o000])("umask=%iでも新規ログは600、中間を含む新規ディレクトリは700になる", async (mask) => {
  const root = mkdtempSync(join(tmpdir(), "freee-permissions-"));
  const original = process.umask(mask);
  try {
    for (const [name, append] of routes) {
      const dir = join(root, name, "logs");
      await append(dir);
      expect(permissions(join(dir, `freee-${name}-2026-01-15.jsonl`)), name).toBe(0o600);
      expect(permissions(join(root, name)), name).toBe(0o700);
      expect(permissions(dir), name).toBe(0o700);
    }
  } finally {
    process.umask(original);
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(routes)("%sの既存644ログを600にし、内容へ追記して既存ディレクトリを変えない", async (name, append) => {
  const root = mkdtempSync(join(tmpdir(), "freee-permissions-"));
  const path = join(root, `freee-${name}-2026-01-15.jsonl`);
  try {
    chmodSync(root, 0o755);
    await append(root);
    const line = readFileSync(path, "utf8");
    writeFileSync(path, line);
    chmodSync(path, 0o644);
    await append(root);
    expect(permissions(path)).toBe(0o600);
    expect(permissions(root)).toBe(0o755);
    expect(readFileSync(path, "utf8")).toBe(line + line);
    expect(JSON.parse(line).event).toBe(name.replaceAll("-", "_"));
    expect(line.endsWith("\n")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(["link", "directory"])("監査ファイルが%sなら追記せず、リンク先の権限と内容を変えない", async (kind) => {
  const root = mkdtempSync(join(tmpdir(), "freee-permissions-"));
  const path = join(root, "freee-invoice-create-2026-01-15.jsonl");
  const target = join(root, "target.jsonl");
  try {
    writeFileSync(target, "fictional-original\n");
    chmodSync(target, 0o644);
    if (kind === "link") symlinkSync(target, path);
    else mkdirSync(path);
    await expect(appendInvoiceAudit(root, { ...entry, event: "invoice_create" })).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("fictional-original\n");
    expect(permissions(target)).toBe(0o644);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
