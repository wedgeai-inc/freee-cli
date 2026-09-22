import { FreeeApiError, type PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import type { QuotationCancelAuditEntry } from "../../lib/audit/quotation-audit.js";
import { validateQuotationId } from "./id.js";

export type QuotationCancelPutState = "not_attempted" | "rejected" | "unknown" | "succeeded";
type Phase = "initial_get" | "put";
export interface QuotationCancelOptions { companyId: number; id: number; execute: boolean; logDir: string; taskId: string; expectQuotationNumber?: string; }
export interface QuotationCancelDeps { getClient: () => Promise<PublicFreeeClient>; appendAudit: (entry: QuotationCancelAuditEntry) => Promise<void>; now: () => Date; }
export interface QuotationCancelResult { mode: "dry-run" | "execute"; companyId: number; id: number; target: { quotation_number: string; total_amount: number; partner_id: number }; canceled?: { id: number; cancel_status: "canceled" }; }

export class ResponseParseError extends Error { constructor(readonly path: string) { super(`invalid response: ${path}`); this.name = "ResponseParseError"; } }
export class QuotationCancelGuardError extends Error { constructor(readonly reason: string) { super(`quotation cancel: guard rejected (${reason})`); this.name = "QuotationCancelGuardError"; } }
export class QuotationCancelAuditWriteError extends Error { constructor(readonly detail: string) { super(`quotation cancel: audit write failed (${detail})`); this.name = "QuotationCancelAuditWriteError"; } }
export class QuotationCancelUnverifiedError extends Error { constructor(readonly reason: string, readonly putState: Extract<QuotationCancelPutState, "unknown" | "succeeded">) { super(`quotation cancel: ${putState === "succeeded" ? "取消済みの可能性がある" : "PUT の結果が不明"}ため、再実行せず freee Web で確認すること（${reason}）`); this.name = "QuotationCancelUnverifiedError"; } }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const pathFor = (id: number) => `/quotations/${id}`;
async function parseJson(response: Response, path: string): Promise<unknown> { try { return await response.json(); } catch { throw new ResponseParseError(path); } }
function readTarget(payload: unknown, id: number, companyId: number): QuotationCancelResult["target"] { const quotation = isRecord(payload) && isRecord(payload.quotation) ? payload.quotation : undefined; const path = pathFor(id); if (!quotation || !positiveInteger(quotation.id) || !positiveInteger(quotation.company_id) || typeof quotation.quotation_number !== "string" || typeof quotation.total_amount !== "number" || !positiveInteger(quotation.partner_id)) throw new ResponseParseError(path); if (quotation.id !== id) throw new QuotationCancelGuardError("mismatch:id"); if (quotation.company_id !== companyId) throw new QuotationCancelGuardError("mismatch:company_id"); return { quotation_number: quotation.quotation_number, total_amount: quotation.total_amount, partner_id: quotation.partner_id }; }
function readCanceled(payload: unknown, id: number): { id: number; cancel_status: "canceled" } { const path = `${pathFor(id)}/cancel`; const quotation = isRecord(payload) && isRecord(payload.quotation) ? payload.quotation : undefined; if (!quotation || !positiveInteger(quotation.id)) throw new ResponseParseError(path); if (quotation.id !== id) throw new QuotationCancelGuardError("mismatch:id"); if (quotation.cancel_status !== "canceled") throw new QuotationCancelGuardError("mismatch:cancel_status"); return { id: quotation.id, cancel_status: "canceled" }; }
async function appendAudit(deps: QuotationCancelDeps, entry: QuotationCancelAuditEntry): Promise<void> { try { await deps.appendAudit(entry); } catch (error) { throw new QuotationCancelAuditWriteError(error instanceof Error ? error.message : String(error)); } }
function phaseReasonPrefix(phase: Phase): Phase { switch (phase) { case "initial_get": return "initial_get"; case "put": return "put"; } const unhandled: never = phase; return unhandled; }
function reason(error: unknown, phase: Phase): string { if (error instanceof QuotationCancelGuardError) return error.reason; if (error instanceof QuotationCancelAuditWriteError) return "audit_write_failed"; if (error instanceof ResponseParseError) return `invalid_response:${error.path}`; const prefix = phaseReasonPrefix(phase); if (error instanceof FreeeApiError) return `${prefix}_http:${error.status}`; return `${prefix}_network`; }
function classifyPutState(error: unknown): QuotationCancelPutState { return error instanceof FreeeApiError && [400, 401, 403, 404].includes(error.status) ? "rejected" : "unknown"; }
function canExposeAuditError(state: QuotationCancelPutState): boolean { return state === "not_attempted" || state === "rejected"; }
function mustWrapUnverified(state: QuotationCancelPutState): state is "unknown" | "succeeded" { return state === "unknown" || state === "succeeded"; }

export async function runQuotationsCancel(opts: QuotationCancelOptions, deps: QuotationCancelDeps): Promise<QuotationCancelResult> {
  validateQuotationId(opts.id);
  const mode = opts.execute ? "execute" as const : "dry-run" as const;
  const base = { task_id: opts.taskId, event: "quotation_cancel" as const, mode, company_id: opts.companyId, quotation_id: opts.id };
  let putState: QuotationCancelPutState = "not_attempted";
  let phase: Phase = "initial_get";
  let clientFailureAudited = false;
  try {
    if (opts.execute && opts.expectQuotationNumber === undefined) throw new QuotationCancelGuardError("mismatch:quotation_number");
    let client: PublicFreeeClient;
    try { client = await deps.getClient(); } catch (error) { await appendAudit(deps, { ...base, timestamp: deps.now().toISOString(), status: "failed", reason: "client_unavailable", put_state: putState }); clientFailureAudited = true; throw error; }
    const target = readTarget(await parseJson(await client.get(pathFor(opts.id), { query: { company_id: opts.companyId } }), pathFor(opts.id)), opts.id, opts.companyId);
    if (opts.expectQuotationNumber !== undefined && target.quotation_number !== opts.expectQuotationNumber) throw new QuotationCancelGuardError("mismatch:quotation_number");
    if (!opts.execute) { await appendAudit(deps, { ...base, timestamp: deps.now().toISOString(), status: "planned", put_state: putState }); return { mode, companyId: opts.companyId, id: opts.id, target }; }
    phase = "put";
    let response: Response;
    try { putState = "unknown"; response = await client.put(`${pathFor(opts.id)}/cancel`, { body: { company_id: opts.companyId }, redirect: "manual" }); putState = "succeeded"; } catch (error) { putState = classifyPutState(error); throw error; }
    const canceled = readCanceled(await parseJson(response, `${pathFor(opts.id)}/cancel`), opts.id);
    await appendAudit(deps, { ...base, timestamp: deps.now().toISOString(), status: "canceled", put_state: putState });
    return { mode, companyId: opts.companyId, id: opts.id, target, canceled };
  } catch (error) {
    const failureReason = reason(error, phase);
    let auditFailure = error instanceof QuotationCancelAuditWriteError;
    if (!auditFailure && !clientFailureAudited) {
      try { await appendAudit(deps, { ...base, timestamp: deps.now().toISOString(), status: "failed", reason: failureReason, put_state: putState }); }
      catch (auditError) { auditFailure = true; if (canExposeAuditError(putState)) throw auditError; }
    }
    if (mustWrapUnverified(putState)) throw new QuotationCancelUnverifiedError(auditFailure ? "audit_write_failed" : failureReason, putState);
    throw error;
  }
}
export function formatQuotationCancel(result: QuotationCancelResult): string { return [`mode: ${result.mode}`, `target: quotation_number=${result.target.quotation_number} total_amount=${result.target.total_amount} partner_id=${result.target.partner_id}`, result.canceled ? `canceled: id=${result.canceled.id} cancel_status=canceled` : "実 PUT は行っていません（--execute で取消）"].join("\n"); }
