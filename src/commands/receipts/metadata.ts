import { assertDate } from "../../lib/accounting-validation.js";
import { isRecord } from "../../lib/accounting-read.js";
import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import type { ReceiptAuditEntry } from "../../lib/audit/receipt-audit.js";
import { runReceiptsGet } from "./get.js";

export interface ReceiptMetadataOptions { partnerName?: string; issueDate?: string; amount?: number; }
export function receiptMetadata(opts: ReceiptMetadataOptions) {
  if (opts.partnerName !== undefined && (typeof opts.partnerName !== "string" || [...opts.partnerName].length > 255)) throw new Error("partner_name must contain at most 255 characters");
  if (opts.issueDate !== undefined) assertDate(opts.issueDate, "issue_date");
  if (opts.amount !== undefined && (!Number.isSafeInteger(opts.amount) || Math.abs(opts.amount) > 999999999999)) throw new Error("amount must be an integer between -999999999999 and 999999999999");
  return { ...(opts.partnerName === undefined ? {} : { partner_name: opts.partnerName }), ...(opts.issueDate === undefined ? {} : { issue_date: opts.issueDate }), ...(opts.amount === undefined ? {} : { amount: opts.amount }) };
}
export async function readbackReceipt(
  id: number, companyId: number, opts: ReceiptMetadataOptions,
  base: Omit<ReceiptAuditEntry, "timestamp" | "status">,
  deps: { appendAudit: (entry: ReceiptAuditEntry) => Promise<void>; now: () => Date },
  client: PublicFreeeClient,
) {
  let readback: Record<string, boolean> | undefined;
  try {
    const receipt = await runReceiptsGet({ id, companyId }, { client });
    if (receipt.company_id !== companyId) throw new Error("invalid response company_id");
    const metadata = isRecord(receipt.receipt_metadatum) ? receipt.receipt_metadatum : {};
    readback = {
      ...(opts.issueDate === undefined ? {} : { issueDateMatches: metadata.issue_date === opts.issueDate }),
      ...(opts.partnerName === undefined ? {} : { partnerNameMatches: metadata.partner_name === opts.partnerName }),
      ...(opts.amount === undefined ? {} : { amountMatches: metadata.amount === opts.amount }),
    };
    if (Object.values(readback).some(ok => !ok)) throw new Error("readback mismatch");
    return readback;
  } catch {
    try {
      await deps.appendAudit({ ...base, timestamp: deps.now().toISOString(), status: "failed", write_state: "succeeded", created_id: id, reason: "readback_failed", ...(readback === undefined ? {} : { guards: readback }) });
    } catch { /* 書き込み済みIDと再実行禁止の例外を優先する。 */ }
    const action = base.event === "receipt_upload" ? "作成" : "更新";
    throw Object.assign(new Error(`読み戻しに失敗。${action}済みです (receipt_id=${id})。再実行しないでください。receipts getで確認してください`), { createdId: id, readback });
  }
}
