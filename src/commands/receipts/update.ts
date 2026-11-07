import { assertId } from "../../lib/accounting-validation.js";
import { auditedAccountingWrite } from "../../lib/accounting-write.js";
import { redactAccountingPayload } from "../../lib/audit/accounting-audit.js";
import type { ReceiptAuditEntry } from "../../lib/audit/receipt-audit.js";
import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import { runReceiptsGet } from "./get.js";
import { receiptMetadata, readbackReceipt, type ReceiptMetadataOptions } from "./metadata.js";

export interface ReceiptsUpdateOptions extends ReceiptMetadataOptions { id: number; companyId: number; execute?: boolean; logDir: string; taskId: string; }
export interface ReceiptsUpdateDeps { getClient: () => Promise<PublicFreeeClient>; appendAudit: (entry: ReceiptAuditEntry) => Promise<void>; now: () => Date; }
export async function runReceiptsUpdate(opts: ReceiptsUpdateOptions, deps: ReceiptsUpdateDeps) {
  assertId(opts.id); assertId(opts.companyId, "company_id");
  const metadata = receiptMetadata(opts);
  if (!Object.keys(metadata).length) throw new Error("specify --partner-name, --issue-date or --amount");
  const client = await deps.getClient();
  const current = await runReceiptsGet(opts, { client });
  if (current.company_id !== undefined && current.company_id !== opts.companyId) throw new Error("invalid response company_id");
  const payload = { company_id: opts.companyId, receipt_metadatum: metadata };
  const mode = opts.execute ? "execute" as const : "dry-run" as const;
  const base = { task_id: opts.taskId, event: "receipt_update" as const, mode, company_id: opts.companyId, target_id: opts.id,
    payload_redacted: redactAccountingPayload({ current: { id: current.id, company_id: current.company_id, receipt_metadatum: current.receipt_metadatum }, payload }) };
  if (!opts.execute) {
    await deps.appendAudit({ ...base, timestamp: deps.now().toISOString(), status: "planned" });
    return { mode, current, payload };
  }
  const updated = await auditedAccountingWrite(base, deps, () => client.put(`/api/1/receipts/${opts.id}`, { body: payload }), "receipt");
  const readback = await readbackReceipt(opts.id, opts.companyId, opts, base, deps, client);
  return { mode, current, payload, updated, readback };
}
