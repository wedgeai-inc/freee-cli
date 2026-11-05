import { secureAppend } from "./secure-append.js";
import { join } from "node:path";
import { redact } from "./redactor.js";

export interface AccountingAuditEntry {
  timestamp: string; task_id: string; event: "deal_create" | "deal_attach_receipt" | "deal_payment_create" | "receipt_upload" | "wallet_txn_reconcile";
  mode: "dry-run" | "execute"; status: "planned" | "guard_failed" | "attempting" | "succeeded" | "failed";
  company_id: number; payload_redacted: unknown; target_id?: number; created_id?: number;
  write_state?: "not_attempted" | "rejected" | "unknown" | "succeeded"; reason?: string;
  guards?: Record<string, boolean>;
  filename?: string; sha256?: string;
}
export function redactAccountingPayload(value: unknown): unknown {
  const masked = redact(value, ["description", "ref_number", "receipt_metadatum_issue_date"]);
  const scrub = (item: unknown): unknown => {
    if (typeof item === "string") return item.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, scrub(child)]));
    return item;
  };
  return scrub(masked);
}
export async function appendAccountingAudit(logDir: string, entry: AccountingAuditEntry): Promise<void> {
  if (entry.guards !== undefined && (entry.guards === null || typeof entry.guards !== "object" || Array.isArray(entry.guards) || Object.values(entry.guards).some(value => typeof value !== "boolean"))) throw new Error("audit guards must contain only boolean values");
  // 任意の追加プロパティ（ファイル本文やパスなど）を永続化しない。
  const safe = {
    timestamp: entry.timestamp, task_id: redactAccountingPayload(entry.task_id), event: entry.event,
    mode: entry.mode, status: entry.status, company_id: entry.company_id, guards: entry.guards,
    payload_redacted: redactAccountingPayload(entry.payload_redacted), target_id: entry.target_id,
    created_id: entry.created_id, write_state: entry.write_state, reason: redactAccountingPayload(entry.reason),
    filename: entry.filename === undefined ? undefined : redactAccountingPayload(entry.filename), sha256: entry.sha256,
  };
  secureAppend(join(logDir, `freee-${entry.event.replaceAll("_", "-")}-${entry.timestamp.slice(0, 10)}.jsonl`), `${JSON.stringify(safe)}\n`);
}
