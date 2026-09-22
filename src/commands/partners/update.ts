import { FreeeApiError, type PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import { redact } from "../../lib/audit/redactor.js";
import type { PartnerUpdateAuditEntry } from "../../lib/audit/partner-audit.js";
import { PartnerPlanError, parsePartnerUpdatePlan } from "../../domain/partner-plan.js";

export type PartnerUpdatePutState = "not_attempted" | "rejected" | "unknown" | "succeeded";
type PartnerUpdatePhase = "initial_get" | "put" | "readback";
export interface PartnerUpdateOptions { companyId: number; id: number; planPath: string; execute: boolean; logDir: string; taskId: string; expectName?: string; }
export interface PartnerUpdateDeps { getClient: () => Promise<PublicFreeeClient>; readFile: (path: string) => Promise<string>; appendAudit: (entry: PartnerUpdateAuditEntry) => Promise<void>; now: () => Date; }
export interface PartnerUpdateResult { mode: "dry-run" | "execute"; companyId: number; id: number; current: { name: string }; changes: Array<{ path: string; current: unknown; next: unknown; same: boolean }>; payload: Record<string, unknown>; updated?: { id: number; name: string; ignored: string[] }; }
export class PartnerUpdateGuardError extends Error { constructor(readonly reason: string) { super(`partner update: guard rejected (${reason})`); this.name = "PartnerUpdateGuardError"; } }
export class PartnerUpdateUnverifiedError extends Error { constructor(readonly reason: string, readonly putState: Extract<PartnerUpdatePutState, "unknown" | "succeeded">) { super(`partner update: ${putState === "succeeded" ? "更新済みの可能性がある" : "PUT の結果が不明"}ため、再実行せず freee Web で確認すること（${reason}）`); this.name = "PartnerUpdateUnverifiedError"; } }
class ResponseParseError extends Error { constructor(readonly path: string) { super(`invalid response: ${path}`); this.name = "ResponseParseError"; } }
class AuditWriteError extends Error { constructor(detail: string) { super(`partner update: audit write failed (${detail})`); this.name = "AuditWriteError"; } }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const safeId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const getPath = (value: Record<string, unknown>, path: readonly string[]): unknown => path.reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, value);
const partnerPath = (id: number) => `/api/1/partners/${id}`;
const project = (path: readonly string[], value: unknown): unknown => path[0] === "invoice_registration_number" && typeof value === "string" && /^[0-9]{13}$/.test(value) ? `T${value}` : value === undefined ? null : value;
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
function leaves(value: Record<string, unknown>, prefix: string[] = []): Array<{ path: string[]; value: unknown }> {
  return Object.entries(value).flatMap(([key, child]) => isRecord(child) ? leaves(child, [...prefix, key]) : [{ path: [...prefix, key], value: child }]);
}
async function parseJson(response: Response, path: string): Promise<unknown> { try { return await response.json(); } catch { throw new ResponseParseError(path); } }
function parsePartner(payload: unknown, id: number, companyId: number): Record<string, unknown> {
  const path = partnerPath(id); const partner = isRecord(payload) && isRecord(payload.partner) ? payload.partner : undefined;
  if (!partner || !safeId(partner.id) || !safeId(partner.company_id) || typeof partner.name !== "string") throw new ResponseParseError(path);
  if (partner.id !== id) throw new PartnerUpdateGuardError("mismatch:id");
  if (partner.company_id !== companyId) throw new PartnerUpdateGuardError("mismatch:company_id");
  return partner;
}
async function append(deps: PartnerUpdateDeps, entry: PartnerUpdateAuditEntry): Promise<void> { try { await deps.appendAudit(entry); } catch (error) { throw new AuditWriteError(error instanceof Error ? error.message : String(error)); } }
function classifyPutState(error: unknown): PartnerUpdatePutState { return error instanceof FreeeApiError && [400, 401, 403, 404].includes(error.status) ? "rejected" : "unknown"; }
function phaseReasonPrefix(phase: PartnerUpdatePhase): PartnerUpdatePhase {
  switch (phase) {
    case "initial_get": return "initial_get";
    case "put": return "put";
    case "readback": return "readback";
  }
  const unhandled: never = phase;
  return unhandled;
}
function failureReason(error: unknown, phase: PartnerUpdatePhase): string {
  if (error instanceof PartnerUpdateGuardError) return error.reason;
  if (error instanceof ResponseParseError) return `invalid_response:${error.path}`;
  if (error instanceof AuditWriteError) return "audit_write_failed";
  const prefix = phaseReasonPrefix(phase);
  if (error instanceof FreeeApiError) return `${prefix}_http:${error.status}`;
  return `${prefix}_network`;
}
function changes(current: Record<string, unknown>, payload: Record<string, unknown>): PartnerUpdateResult["changes"] {
  return leaves(payload).filter(({ path }) => path[0] !== "company_id").map(({ path, value }) => {
    const actual = getPath(current, path); return { path: path.join("."), current: actual === undefined ? null : actual, next: value, same: equal(project(path, actual), project(path, value)) };
  });
}
function readback(partner: Record<string, unknown>, payload: Record<string, unknown>, id: number): NonNullable<PartnerUpdateResult["updated"]> {
  const ignored = leaves(payload).filter(({ path }) => path[0] !== "company_id").filter(({ path, value }) => !equal(project(path, getPath(partner, path)), project(path, value))).map(({ path }) => path.join("."));
  return { id, name: partner.name as string, ignored };
}
export async function runPartnersUpdate(opts: PartnerUpdateOptions, deps: PartnerUpdateDeps): Promise<PartnerUpdateResult> {
  let raw: unknown; try { raw = JSON.parse(await deps.readFile(opts.planPath)); } catch (error) { throw error instanceof SyntaxError ? new PartnerPlanError("invalid JSON") : new PartnerPlanError("plan file cannot be read"); }
  const plan = parsePartnerUpdatePlan(raw) as Record<string, unknown>; const mode = opts.execute ? "execute" as const : "dry-run" as const;
  let payload: Record<string, unknown> = { company_id: opts.companyId, ...plan };
  const base = () => ({ timestamp: deps.now().toISOString(), task_id: opts.taskId, event: "partner_update" as const, mode, company_id: opts.companyId, partner_id: opts.id, payload_redacted: redact(payload) });
  let putState: PartnerUpdatePutState = "not_attempted"; let phase: PartnerUpdatePhase = "initial_get"; let clientFailureAudited = false;
  try {
    if (opts.execute && opts.expectName === undefined) throw new PartnerUpdateGuardError("mismatch:name");
    let client: PublicFreeeClient; try { client = await deps.getClient(); } catch (error) { await append(deps, { ...base(), status: "failed", reason: "client_unavailable", put_state: putState }); clientFailureAudited = true; throw error; }
    const current = parsePartner(await parseJson(await client.get(partnerPath(opts.id), { query: { company_id: opts.companyId } }), partnerPath(opts.id)), opts.id, opts.companyId);
    payload = { company_id: opts.companyId, name: current.name, ...plan };
    if (opts.expectName !== undefined && current.name !== opts.expectName) throw new PartnerUpdateGuardError("mismatch:name");
    const result: PartnerUpdateResult = { mode, companyId: opts.companyId, id: opts.id, current: { name: current.name as string }, changes: changes(current, payload), payload };
    if (!opts.execute) { await append(deps, { ...base(), status: "planned", put_state: putState }); return result; }
    try { phase = "put"; putState = "unknown"; await client.put(partnerPath(opts.id), { body: payload, redirect: "manual" }); putState = "succeeded"; } catch (error) { putState = classifyPutState(error); throw error; }
    phase = "readback";
    const after = parsePartner(await parseJson(await client.get(partnerPath(opts.id), { query: { company_id: opts.companyId } }), partnerPath(opts.id)), opts.id, opts.companyId);
    const updated = readback(after, payload, opts.id); await append(deps, { ...base(), status: "updated", ignored: updated.ignored, put_state: putState }); return { ...result, updated };
  } catch (error) {
    const finalState = putState as PartnerUpdatePutState; const reason = failureReason(error, phase); let auditFailure = error instanceof AuditWriteError;
    if (!auditFailure && !clientFailureAudited) { try { await append(deps, { ...base(), status: "failed", reason, put_state: finalState }); } catch (auditError) { auditFailure = true; if (finalState === "not_attempted" || finalState === "rejected") throw auditError; } }
    if (finalState === "unknown" || finalState === "succeeded") throw new PartnerUpdateUnverifiedError(auditFailure ? "audit_write_failed" : reason, finalState);
    throw error;
  }
}
export function formatPartnerUpdate(result: PartnerUpdateResult): string { return JSON.stringify(result, null, 2); }
