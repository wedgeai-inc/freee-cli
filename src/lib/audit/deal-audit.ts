import { appendAccountingAudit, type AccountingAuditEntry } from "./accounting-audit.js";
export type DealAuditEntry = AccountingAuditEntry & { event: "deal_create" | "deal_attach_receipt" };
export function appendDealAudit(logDir: string, entry: DealAuditEntry): Promise<void> { return appendAccountingAudit(logDir, entry); }
