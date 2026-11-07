import { appendAccountingAudit, type AccountingAuditEntry } from "./accounting-audit.js";
export type ReceiptAuditEntry = AccountingAuditEntry & { event: "receipt_upload" | "receipt_update" };
export function appendReceiptAudit(logDir: string, entry: ReceiptAuditEntry): Promise<void> { return appendAccountingAudit(logDir, entry); }
