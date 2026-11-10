import { stableClock } from "../../lib/clock.js";
import { FreeeApiError, type PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import { isAccountNumberKey, maskAccountNumber, redact } from "../../lib/audit/redactor.js";
import type { PartnerUpdateAuditEntry } from "../../lib/audit/partner-audit.js";
import { PARTNER_BANK_ACCOUNT_KEY, PartnerPlanError, parsePartnerUpdatePlan } from "../../domain/partner-plan.js";

export type PartnerUpdatePutState = "not_attempted" | "rejected" | "unknown" | "succeeded";
type PartnerUpdatePhase = "initial_get" | "put" | "readback";
export interface PartnerUpdateOptions { companyId: number; id: number; planPath: string; execute: boolean; logDir: string; taskId: string; expectName?: string; expectAccountLast4?: string; allowReplaceBankAccount?: boolean; }
export interface PartnerUpdateDeps { getClient: () => Promise<PublicFreeeClient>; readFile: (path: string) => Promise<string>; appendAudit: (entry: PartnerUpdateAuditEntry) => Promise<void>; now: () => Date; }
export interface PartnerUpdateResult { mode: "dry-run" | "execute"; companyId: number; id: number; current: { name: string }; changes: Array<{ path: string; current: unknown; next: unknown; same: boolean }>; payload: Record<string, unknown>; bankAccount?: { registered: boolean; current: Record<string, unknown> | null; next: Record<string, unknown> }; updated?: { id: number; name: string; ignored: string[]; bankAccount?: { verified: true; account: Record<string, unknown> } }; }
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
/** 出力用のコピー。account_number だけを下4桁以外伏せにする（PUT へ送る payload は変更しない） */
function maskAccounts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskAccounts);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, isAccountNumberKey(key) ? maskAccountNumber(child) : maskAccounts(child)]));
}
const maskedRecord = (value: Record<string, unknown>): Record<string, unknown> => maskAccounts(value) as Record<string, unknown>;
const isBlank = (value: unknown): boolean => value === null || value === undefined || value === "";
/** 口座を特定できる値（account_type 以外の空でない項目）があれば登録済みとみなす */
function registeredBankAccount(partner: Record<string, unknown>): boolean {
  const account = partner[PARTNER_BANK_ACCOUNT_KEY];
  return isRecord(account) && Object.entries(account).some(([key, value]) => key !== "account_type" && !isBlank(value));
}
const isBankPath = (path: readonly string[]): boolean => path[0] === PARTNER_BANK_ACCOUNT_KEY;
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
    const actual = getPath(current, path); const mask = (item: unknown) => isAccountNumberKey(path.at(-1)!) ? maskAccountNumber(item) : item;
    return { path: path.join("."), current: mask(actual === undefined ? null : actual), next: mask(value), same: equal(project(path, actual), project(path, value)) };
  });
}
/** 口座は ignored で済ませない。plan に含めた項目が1つでも読み戻しと違えば失敗させる（値は出さず項目名だけ） */
function verifyBankAccount(partner: Record<string, unknown>, bankPlan: Record<string, unknown>): void {
  const mismatched = leaves(bankPlan, [PARTNER_BANK_ACCOUNT_KEY]).filter(({ path, value }) => !equal(getPath(partner, path), value)).map(({ path }) => path.join("."));
  if (mismatched.length > 0) throw new PartnerUpdateGuardError(`bank_account_readback_mismatch:${mismatched.join(",")}`);
}
function readback(partner: Record<string, unknown>, payload: Record<string, unknown>, id: number): NonNullable<PartnerUpdateResult["updated"]> {
  const ignored = leaves(payload).filter(({ path }) => path[0] !== "company_id" && !isBankPath(path)).filter(({ path, value }) => !equal(project(path, getPath(partner, path)), project(path, value))).map(({ path }) => path.join("."));
  return { id, name: partner.name as string, ignored };
}
export async function runPartnersUpdate(opts: PartnerUpdateOptions, deps: PartnerUpdateDeps): Promise<PartnerUpdateResult> { deps = { ...deps, now: stableClock(deps.now) };
  let raw: unknown; try { raw = JSON.parse(await deps.readFile(opts.planPath)); } catch (error) { throw error instanceof SyntaxError ? new PartnerPlanError("invalid JSON") : new PartnerPlanError("plan file cannot be read"); }
  const plan = parsePartnerUpdatePlan(raw) as Record<string, unknown>; const bankPlan = isRecord(plan[PARTNER_BANK_ACCOUNT_KEY]) ? plan[PARTNER_BANK_ACCOUNT_KEY] : undefined; const mode = opts.execute ? "execute" as const : "dry-run" as const;
  let payload: Record<string, unknown> = { company_id: opts.companyId, ...plan };
  const base = () => ({ timestamp: deps.now().toISOString(), task_id: opts.taskId, event: "partner_update" as const, mode, company_id: opts.companyId, partner_id: opts.id, payload_redacted: redact(payload) });
  let putState: PartnerUpdatePutState = "not_attempted"; let phase: PartnerUpdatePhase = "initial_get"; let clientFailureAudited = false;
  try {
    if (opts.execute && opts.expectName === undefined) throw new PartnerUpdateGuardError("mismatch:name");
    if (opts.expectAccountLast4 !== undefined) {
      if (!bankPlan) throw new PartnerUpdateGuardError("unexpected:expect_account_last4");
      if (!/^[0-9]{4}$/.test(opts.expectAccountLast4)) throw new PartnerUpdateGuardError("invalid:expect_account_last4");
    }
    // 口座を変える実行は、plan の口座番号の下4桁との一致を認証前に要求する
    if (bankPlan && (opts.execute || opts.expectAccountLast4 !== undefined) && opts.expectAccountLast4 !== String(bankPlan.account_number).slice(-4)) throw new PartnerUpdateGuardError("mismatch:account_last4");
    let client: PublicFreeeClient; try { client = await deps.getClient(); } catch (error) { await append(deps, { ...base(), status: "failed", reason: "client_unavailable", put_state: putState }); clientFailureAudited = true; throw error; }
    const current = parsePartner(await parseJson(await client.get(partnerPath(opts.id), { query: { company_id: opts.companyId } }), partnerPath(opts.id)), opts.id, opts.companyId);
    payload = { company_id: opts.companyId, name: current.name, ...plan };
    if (opts.expectName !== undefined && current.name !== opts.expectName) throw new PartnerUpdateGuardError("mismatch:name");
    const registered = registeredBankAccount(current);
    if (opts.execute && bankPlan && registered && !opts.allowReplaceBankAccount) throw new PartnerUpdateGuardError("bank_account_already_registered");
    const currentAccount = current[PARTNER_BANK_ACCOUNT_KEY];
    const result: PartnerUpdateResult = { mode, companyId: opts.companyId, id: opts.id, current: { name: current.name as string }, changes: changes(current, payload), payload: maskedRecord(payload) };
    if (bankPlan) result.bankAccount = { registered, current: isRecord(currentAccount) ? maskedRecord(currentAccount) : null, next: maskedRecord(bankPlan) };
    if (!opts.execute) { await append(deps, { ...base(), status: "planned", put_state: putState }); return result; }
    try { phase = "put"; putState = "unknown"; await client.put(partnerPath(opts.id), { body: payload, redirect: "manual" }); putState = "succeeded"; } catch (error) { putState = classifyPutState(error); throw error; }
    phase = "readback";
    const after = parsePartner(await parseJson(await client.get(partnerPath(opts.id), { query: { company_id: opts.companyId } }), partnerPath(opts.id)), opts.id, opts.companyId);
    if (bankPlan) verifyBankAccount(after, bankPlan);
    const updated = readback(after, payload, opts.id);
    const afterAccount = after[PARTNER_BANK_ACCOUNT_KEY];
    if (bankPlan && isRecord(afterAccount)) updated.bankAccount = { verified: true, account: maskedRecord(afterAccount) };
    await append(deps, { ...base(), status: "updated", ignored: updated.ignored, put_state: putState }); return { ...result, updated };
  } catch (error) {
    const finalState = putState as PartnerUpdatePutState; const reason = failureReason(error, phase); let auditFailure = error instanceof AuditWriteError;
    if (!auditFailure && !clientFailureAudited) { try { await append(deps, { ...base(), status: "failed", reason, put_state: finalState }); } catch (auditError) { auditFailure = true; if (finalState === "not_attempted" || finalState === "rejected") throw auditError; } }
    if (finalState === "unknown" || finalState === "succeeded") throw new PartnerUpdateUnverifiedError(auditFailure ? "audit_write_failed" : reason, finalState);
    throw error;
  }
}
export function formatPartnerUpdate(result: PartnerUpdateResult): string { return JSON.stringify(result, null, 2); }
