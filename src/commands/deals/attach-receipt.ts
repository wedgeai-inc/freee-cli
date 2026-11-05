import { assertId, assertAmount, assertTaxCode, assertDate } from "../../lib/accounting-validation.js";
import { isRecord } from "../../lib/accounting-read.js";
import { auditedAccountingWrite } from "../../lib/accounting-write.js";
import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import type { DealAuditEntry } from "../../lib/audit/deal-audit.js";
import { redactAccountingPayload } from "../../lib/audit/accounting-audit.js";
import { runDealsGet } from "./get.js";
export interface DealsAttachReceiptOptions { companyId: number; id: number; receiptIds: number[]; execute?: boolean; expectTotal?: number; logDir: string; taskId: string; }
export interface DealsAttachReceiptDeps { getClient: () => Promise<PublicFreeeClient>; appendAudit: (entry: DealAuditEntry) => Promise<void>; now: () => Date; }
// Public accounting schema: dealUpdateParams.properties.details.items.properties.
const DETAIL_FIELDS = ["id", "account_item_id", "tax_code", "amount", "description", "item_id", "section_id", "tag_ids", "segment_1_tag_id", "segment_2_tag_id", "segment_3_tag_id", "partner_id", "vat"];
export async function runDealsAttachReceipt(opts: DealsAttachReceiptOptions, deps: DealsAttachReceiptDeps) {
  assertId(opts.companyId, "company_id"); assertId(opts.id);
  if (!Array.isArray(opts.receiptIds) || opts.receiptIds.length === 0) throw new Error("--receipt-id is required");
  opts.receiptIds.forEach(id => assertId(id, "receipt_id"));
  const client = await deps.getClient();
  const deal = await runDealsGet(opts, { client });
  if (opts.execute && (opts.expectTotal === undefined || !Number.isSafeInteger(opts.expectTotal) || opts.expectTotal !== deal.amount)) throw new Error("--expect-total must match deal total");
  assertAmount(deal.amount as number, "response amount");
  if (typeof deal.type !== "string" || !["income", "expense"].includes(deal.type) || typeof deal.issue_date !== "string") throw new Error("invalid response: deal type/issue_date");
  assertDate(deal.issue_date, "response issue_date");
  if (!Array.isArray(deal.details) || (deal.details.length === 0 || deal.details.length > 100) || !deal.details.every(isRecord)) throw new Error("invalid response: deal details");
  for (const detail of deal.details) {
    assertId(detail.id as number, "response detail id"); assertId(detail.account_item_id as number, "response account_item_id");
    assertTaxCode(detail.tax_code as number, "response tax_code"); assertAmount(detail.amount as number, "response detail amount");
  }
  // GETの直後、監査やPUTの前に、各明細のvatを確かめる。
  // vatが0・null・未定義・整数でない場合は、税額不要の区分か0円の課税明細かを公開APIから判別できないため、更新しない。
  deal.details.forEach((detail, i) => {
    const vat = detail.vat;
    if (typeof vat !== "number" || !Number.isInteger(vat) || vat === 0) {
      const idPart = typeof detail.id === "number" ? ` (id: ${detail.id})` : "";
      throw new Error(`deal detail at index ${i}${idPart} has zero or unknown VAT; the Public API cannot distinguish a tax category that forbids an explicit VAT amount from a zero-amount taxed detail, so the update is rejected. Attach the receipt in the freee Web UI. For a new deal, use \`deals create --receipt-id\` to attach the receipt at creation time.`);
    }
  });
  const details = (deal.details as Record<string, unknown>[]).map(d => Object.fromEntries(Object.entries(d).filter(([key, value]) => DETAIL_FIELDS.includes(key) && value !== undefined && (value !== null || key === "partner_id"))));
  const receiptIds: number[] = [];
  if (deal.receipts !== undefined) {
    if (!Array.isArray(deal.receipts) || !deal.receipts.every(isRecord)) throw new Error("invalid response: receipts");
    for (const receipt of deal.receipts) { assertId(receipt.id as number, "response receipt id"); receiptIds.push(receipt.id as number); }
  }
  if (deal.receipt_ids !== undefined) {
    if (!Array.isArray(deal.receipt_ids)) throw new Error("invalid response: receipt_ids");
    for (const id of deal.receipt_ids) { assertId(id as number, "response receipt id"); receiptIds.push(id as number); }
  }
  if (deal.receipts === undefined && deal.receipt_ids === undefined) throw new Error("invalid response: missing receipts");
  // GET returns null for unset optional fields; PUT only allows null for detail partner_id.
  // Prefer the stable ID when GET also includes its equivalent code (PUT forbids both).
  const partner = deal.partner_id != null ? { partner_id: deal.partner_id }
    : deal.partner_code != null ? { partner_code: deal.partner_code } : {};
  const payload = {
    company_id: opts.companyId, type: deal.type, issue_date: deal.issue_date,
    ...(deal.due_date == null ? {} : { due_date: deal.due_date }),
    ...partner,
    ...(deal.ref_number == null ? {} : { ref_number: deal.ref_number }),
    details, receipt_ids: [...new Set([...receiptIds, ...opts.receiptIds])],
  };
  const mode = opts.execute ? "execute" as const : "dry-run" as const;
  const base = { task_id: opts.taskId, event: "deal_attach_receipt" as const, mode, company_id: opts.companyId, target_id: opts.id, payload_redacted: redactAccountingPayload(payload) };
  if (!opts.execute) {
    await deps.appendAudit({ ...base, timestamp: deps.now().toISOString(), status: "planned" });
    return { mode, total: deal.amount, payload };
  }
  const updated = await auditedAccountingWrite(base, deps, () => client.put(`/api/1/deals/${opts.id}`, { body: payload }), "deal");
  return { mode, total: deal.amount, payload, updated };
}