import { FreeeApiError, type PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import type { InvoiceCancelAuditEntry } from "../../lib/audit/invoice-audit.js";
import { validateInvoiceMutationId } from "./id.js";

export type InvoiceCancelPutState = "not_attempted" | "rejected" | "unknown" | "succeeded";
export type { InvoiceCancelAuditEntry } from "../../lib/audit/invoice-audit.js";
export interface InvoiceCancelOptions { companyId: number; id: number; execute: boolean; logDir: string; taskId: string; expectInvoiceNumber?: string; allowDealDeletion: boolean; }
export interface InvoiceCancelDeps { getClient: () => Promise<PublicFreeeClient>; appendAudit: (entry: InvoiceCancelAuditEntry) => Promise<void>; now: () => Date; }
export interface InvoiceCancelResult { mode: "dry-run" | "execute"; companyId: number; id: number; target: { invoice_number: string; total_amount: number; partner_id: number; deal_status: "registered" | "unregistered" }; canceled?: { id: number; cancel_status: "canceled" }; }
export class ResponseParseError extends Error { constructor(readonly path: string) { super(`invalid response: ${path}`); this.name = "ResponseParseError"; } }
export class InvoiceCancelGuardError extends Error { constructor(readonly reason: string) { super(`invoice cancel: guard rejected (${reason})`); this.name = "InvoiceCancelGuardError"; } }
export class AuditWriteError extends Error { constructor(readonly detail: string) { super(`invoice cancel: audit write failed (${detail})`); this.name = "AuditWriteError"; } }
export class InvoiceCancelUnverifiedError extends Error { constructor(readonly reason: string, readonly putState: Extract<InvoiceCancelPutState, "unknown" | "succeeded">) { super(`invoice cancel: ${putState === "succeeded" ? "取消済みの可能性がある" : "PUT の結果が不明"}ため、再実行せず freee Web で確認すること（${reason}）`); this.name = "InvoiceCancelUnverifiedError"; } }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const safePositiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const invoicePath = (id: number) => `/invoices/${id}`;
async function parseJson(response: Response, path: string): Promise<unknown> { try { return await response.json(); } catch { throw new ResponseParseError(path); } }
function assertMatchingReadInvoiceId(actualId: number, expectedId: number): void { if (actualId !== expectedId) throw new InvoiceCancelGuardError("mismatch:id"); }
function assertMatchingCanceledInvoiceId(actualId: number, expectedId: number): void { if (actualId !== expectedId) throw new InvoiceCancelGuardError("mismatch:id"); }
function readTarget(payload: unknown, id: number, companyId: number): InvoiceCancelResult["target"] { const invoice = isRecord(payload) && isRecord(payload.invoice) ? payload.invoice : undefined; const path = invoicePath(id); if (!invoice || !safePositiveInteger(invoice.id) || !safePositiveInteger(invoice.company_id) || typeof invoice.invoice_number !== "string" || (invoice.deal_status !== "registered" && invoice.deal_status !== "unregistered") || typeof invoice.total_amount !== "number" || !safePositiveInteger(invoice.partner_id)) throw new ResponseParseError(path); assertMatchingReadInvoiceId(invoice.id, id); if (invoice.company_id !== companyId) throw new InvoiceCancelGuardError("mismatch:company_id"); return { invoice_number: invoice.invoice_number, total_amount: invoice.total_amount, partner_id: invoice.partner_id, deal_status: invoice.deal_status }; }
function readCanceled(payload: unknown, id: number): { id: number; cancel_status: "canceled" } { const path = `${invoicePath(id)}/cancel`; const invoice = isRecord(payload) && isRecord(payload.invoice) ? payload.invoice : undefined; if (!invoice || !safePositiveInteger(invoice.id)) throw new ResponseParseError(path); assertMatchingCanceledInvoiceId(invoice.id, id); if (invoice.cancel_status !== "canceled") throw new InvoiceCancelGuardError("mismatch:cancel_status"); return { id: invoice.id, cancel_status: "canceled" }; }
async function appendAudit(deps: InvoiceCancelDeps, entry: InvoiceCancelAuditEntry): Promise<void> { try { await deps.appendAudit(entry); } catch (error) { throw new AuditWriteError(error instanceof Error ? error.message : String(error)); } }
function classifyReason(error: unknown, state: InvoiceCancelPutState): string { if (error instanceof InvoiceCancelGuardError) return error.reason; if (error instanceof AuditWriteError) return "audit_write_failed"; if (error instanceof ResponseParseError) return `invalid_response:${error.path}`; if (error instanceof FreeeApiError) return state === "not_attempted" ? `readback_http:${error.status}` : `put_http:${error.status}`; return state === "not_attempted" ? "readback_network" : "put_network"; }
export function classifyInvoicePutState(error: unknown): "rejected" | "unknown" { return error instanceof FreeeApiError && [400, 401, 403, 404].includes(error.status) ? "rejected" : "unknown"; }
function classifyPutState(error: unknown): InvoiceCancelPutState { return classifyInvoicePutState(error); }
function canExposeAuditError(state: InvoiceCancelPutState): boolean { return state === "not_attempted" || state === "rejected"; }
function mustWrapUnverified(state: InvoiceCancelPutState): state is "unknown" | "succeeded" { return state === "unknown" || state === "succeeded"; }
export async function runInvoicesCancel(opts: InvoiceCancelOptions, deps: InvoiceCancelDeps): Promise<InvoiceCancelResult> {
  validateInvoiceMutationId(opts.id); const mode = opts.execute ? "execute" as const : "dry-run" as const; const base = { task_id: opts.taskId, event: "invoice_cancel" as const, mode, company_id: opts.companyId, invoice_id: opts.id }; let putState: InvoiceCancelPutState = "not_attempted"; let clientFailureAudited = false;
  try {
    if (opts.execute && opts.expectInvoiceNumber === undefined) throw new InvoiceCancelGuardError("mismatch:invoice_number");
    let client: PublicFreeeClient; try { client = await deps.getClient(); } catch (error) { await appendAudit(deps, { ...base, timestamp: deps.now().toISOString(), status: "failed", reason: "client_unavailable", put_state: putState }); clientFailureAudited = true; throw error; }
    const target = readTarget(await parseJson(await client.get(invoicePath(opts.id), { query: { company_id: opts.companyId } }), invoicePath(opts.id)), opts.id, opts.companyId);
    if (opts.expectInvoiceNumber !== undefined && target.invoice_number !== opts.expectInvoiceNumber) throw new InvoiceCancelGuardError("mismatch:invoice_number");
    if (opts.execute && target.deal_status === "registered" && !opts.allowDealDeletion) throw new InvoiceCancelGuardError("deal_registered");
    if (!opts.execute) { await appendAudit(deps, { ...base, timestamp: deps.now().toISOString(), status: "planned", put_state: putState }); return { mode, companyId: opts.companyId, id: opts.id, target }; }
    let response: Response; try { putState = "unknown"; response = await client.put(`${invoicePath(opts.id)}/cancel`, { body: { company_id: opts.companyId }, redirect: "manual" }); putState = "succeeded"; } catch (error) { putState = classifyPutState(error); throw error; }
    const canceled = readCanceled(await parseJson(response, `${invoicePath(opts.id)}/cancel`), opts.id); await appendAudit(deps, { ...base, timestamp: deps.now().toISOString(), status: "canceled", put_state: putState }); return { mode, companyId: opts.companyId, id: opts.id, target, canceled };
  } catch (error) {
    const finalState: InvoiceCancelPutState = putState;
    const failureReason = classifyReason(error, finalState); let auditFailure = error instanceof AuditWriteError;
    if (!auditFailure && !clientFailureAudited) { try { await appendAudit(deps, { ...base, timestamp: deps.now().toISOString(), status: "failed", reason: failureReason, put_state: finalState }); } catch (auditError) { auditFailure = true; if (canExposeAuditError(finalState)) throw auditError; } }
    if (mustWrapUnverified(finalState)) throw new InvoiceCancelUnverifiedError(auditFailure ? "audit_write_failed" : failureReason, finalState); throw error;
  }
}
export function formatInvoiceCancel(result: InvoiceCancelResult): string { return [`mode: ${result.mode}`, `target: invoice_number=${result.target.invoice_number} total_amount=${result.target.total_amount} partner_id=${result.target.partner_id} deal_status=${result.target.deal_status}`, result.canceled ? `canceled: id=${result.canceled.id} cancel_status=${result.canceled.cancel_status}` : "実 PUT は行っていません（--execute で取消）"].join("\n"); }
