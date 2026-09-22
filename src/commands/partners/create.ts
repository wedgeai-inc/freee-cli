import { FreeeApiError, type PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import { redact } from "../../lib/audit/redactor.js";
import type { PartnerAuditEntry } from "../../lib/audit/partner-audit.js";
import { PARTNER_PLAN_FIELDS, PartnerPlanError, parsePartnerPlan } from "../../domain/partner-plan.js";

export interface PartnerCreateOptions { companyId: number; planPath: string; execute: boolean; logDir: string; taskId: string; }
export interface PartnerCreateDeps { getClient: () => Promise<PublicFreeeClient>; readFile: (path: string) => Promise<string>; appendAudit: (entry: PartnerAuditEntry) => Promise<void>; now: () => Date; }
export interface PartnerCreateResult { mode: "dry-run" | "execute"; payload: Record<string, unknown>; created?: { id: number; name: string; code: string | null; ignored: string[] }; }
export type PartnerPostState = "not_attempted" | "rejected" | "unknown" | "succeeded";
export class PartnerCreatedButUnverifiedError extends Error { constructor(readonly createdId: number | undefined, readonly reason: string, readonly postState: PartnerPostState) { super(`partner create: ${postState === "succeeded" ? "作成済みの可能性がある" : "POST の結果が不明"}ため、再実行の前に partners search で作成済みか確認すること（${reason}）`); this.name = "PartnerCreatedButUnverifiedError"; } }
export class PartnerAuditWriteError extends Error { constructor(detail: string) { super(`partner create: audit write failed (${detail})`); this.name = "AuditWriteError"; } }
class ResponseParseError extends Error { constructor(readonly path: string) { super(`invalid response: ${path}`); } }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const safeId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const getPath = (value: Record<string, unknown>, path: readonly string[]) => path.reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, value);

async function json(response: Response, path: string): Promise<unknown> { try { return await response.json(); } catch { throw new ResponseParseError(path); } }
function partner(payload: unknown, path: string): Record<string, unknown> { const result = isRecord(payload) && isRecord(payload.partner) ? payload.partner : undefined; if (!result) throw new ResponseParseError(path); return result; }
function auditError(error: unknown): PartnerAuditWriteError { return new PartnerAuditWriteError(error instanceof Error ? error.message : String(error)); }
async function append(deps: PartnerCreateDeps, entry: PartnerAuditEntry): Promise<void> { try { await deps.appendAudit(entry); } catch (error) { throw auditError(error); } }
function reason(error: unknown, state: PartnerPostState): string {
  if (error instanceof PartnerCreatedButUnverifiedError) return error.reason;
  if (error instanceof PartnerAuditWriteError) return "audit_write_failed";
  if (error instanceof FreeeApiError) return error.path.startsWith("/api/1/partners/") ? `readback_http:${error.status}` : `post_http:${error.status}`;
  if (error instanceof ResponseParseError) return `invalid_response:${error.path}`;
  if (error instanceof TypeError) return state === "succeeded" ? "readback_network" : "post_network";
  return state === "succeeded" ? "readback_network" : "post_network";
}
function normalizeExpected(path: readonly string[], value: unknown): unknown { return path[0] === "invoice_registration_number" && typeof value === "string" && /^[0-9]{13}$/.test(value) ? `T${value}` : value; }
function checkDetail(value: Record<string, unknown>, id: number, companyId: number, expected: Record<string, unknown>): { name: string; code: string | null; ignored: string[] } {
  for (const [key, actual] of [["id", value.id], ["company_id", value.company_id]] as const) { if (!safeId(actual)) throw new ResponseParseError(`/api/1/partners/${id}`); if (actual !== (key === "id" ? id : companyId)) throw new Error(`mismatch:${key}`); }
  if (typeof value.name !== "string") throw new ResponseParseError(`/api/1/partners/${id}`); if (value.name !== expected.name) throw new Error("mismatch:name");
  if (!("code" in value) || (value.code !== null && typeof value.code !== "string")) throw new ResponseParseError(`/api/1/partners/${id}`);
  const ignored: string[] = [];
  for (const field of PARTNER_PLAN_FIELDS) {
    const path = field.path; const key = path.join("."); const wanted = getPath(expected, path);
    if (wanted === undefined || path[0] === "name") continue;
    const actual = getPath(value, path);
    if (path[0] === "invoice_registration_number" && actual !== undefined && actual !== null && (typeof actual !== "string" || !/^T[1-9][0-9]{12}$/.test(actual))) throw new ResponseParseError(`/api/1/partners/${id}`);
    if (actual === undefined || actual !== normalizeExpected(path, wanted)) ignored.push(key);
  }
  return { name: value.name, code: value.code as string | null, ignored };
}
function classifyPost(error: unknown): PartnerPostState { return error instanceof FreeeApiError && error.status >= 400 && error.status < 500 ? "rejected" : "unknown"; }
export async function runPartnersCreate(opts: PartnerCreateOptions, deps: PartnerCreateDeps): Promise<PartnerCreateResult> {
  let raw: unknown; try { raw = JSON.parse(await deps.readFile(opts.planPath)); } catch (error) { throw error instanceof SyntaxError ? new PartnerPlanError("invalid JSON") : new PartnerPlanError("plan file cannot be read"); }
  const plan = parsePartnerPlan(raw); const payload: Record<string, unknown> = { company_id: opts.companyId, ...plan }; const mode = opts.execute ? "execute" as const : "dry-run" as const;
  const base = { task_id: opts.taskId, event: "partner_create" as const, mode, company_id: opts.companyId, payload_redacted: redact(payload) };
  if (!opts.execute) { await append(deps, { ...base, timestamp: deps.now().toISOString(), status: "planned" }); return { mode, payload }; }
  let state: PartnerPostState = "not_attempted"; let createdId: number | undefined; let clientFailureAudited = false;
  try {
    let client: PublicFreeeClient; try { client = await deps.getClient(); } catch (error) { await append(deps, { ...base, timestamp: deps.now().toISOString(), status: "failed", reason: "client_unavailable", post_state: state }); clientFailureAudited = true; throw error; }
    let response: Response; try { state = "unknown"; response = await client.post("/api/1/partners", { body: payload }); state = "succeeded"; } catch (error) { state = classifyPost(error); throw error; }
    const postPartner = partner(await json(response, "/api/1/partners"), "/api/1/partners"); if (!safeId(postPartner.id)) throw new ResponseParseError("/api/1/partners"); createdId = postPartner.id;
    const readback = await client.get(`/api/1/partners/${createdId}`, { query: { company_id: opts.companyId } });
    const created = checkDetail(partner(await json(readback, `/api/1/partners/${createdId}`), `/api/1/partners/${createdId}`), createdId, opts.companyId, payload);
    await append(deps, { ...base, timestamp: deps.now().toISOString(), status: "created", created_id: createdId, ignored: created.ignored, post_state: state }); return { mode, payload, created: { id: createdId, ...created } };
  } catch (error) {
    const finalState = state as PartnerPostState;
    const failureReason = error instanceof Error && error.message.startsWith("mismatch:") ? error.message : reason(error, finalState);
    if (error instanceof PartnerAuditWriteError && (finalState === "not_attempted" || finalState === "rejected")) throw error;
    let auditFailed = error instanceof PartnerAuditWriteError;
    if (!auditFailed && !clientFailureAudited) { try { await append(deps, { ...base, timestamp: deps.now().toISOString(), status: "failed", reason: failureReason, ...(createdId === undefined ? {} : { created_id: createdId }), post_state: finalState }); } catch (auditFailure) { auditFailed = true; if (finalState === "not_attempted" || finalState === "rejected") throw auditFailure; } }
    if (finalState === "unknown" || finalState === "succeeded") throw new PartnerCreatedButUnverifiedError(createdId, auditFailed ? "audit_write_failed" : failureReason, finalState);
    throw error;
  }
}
export function formatPartnerCreate(result: PartnerCreateResult): string { return JSON.stringify(result, null, 2); }
