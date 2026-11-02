import { isRecord } from "./accounting-read.js";
import { assertId } from "./accounting-validation.js";
import type { AccountingAuditEntry } from "./audit/accounting-audit.js";
import { FreeeApiError } from "./clients/freee-public-client.js";
import { stableClock } from "./clock.js";

export interface AccountingWriteDeps<E extends AccountingAuditEntry> { appendAudit: (entry: E) => Promise<void>; now: () => Date; }
export class AccountingWriteError extends Error {
  constructor(readonly writeState: AccountingAuditEntry["write_state"], readonly createdId?: number) {
    super(`accounting write: ${writeState === "succeeded" ? "作成・更新済み" : writeState === "rejected" ? "APIが拒否" : "送信結果が不明"}。再実行の前に deals list/get または receipts get で確認すること`);
    this.name = "AccountingWriteError";
  }
}
export function auditedAccountingWrite<E extends AccountingAuditEntry>(
  base: Omit<E, "timestamp" | "status" | "write_state">, deps: AccountingWriteDeps<E>,
  send: () => Promise<Response>, envelope: "deal" | "receipt",
): Promise<{ id: number }>;
export function auditedAccountingWrite<E extends AccountingAuditEntry, R>(
  base: Omit<E, "timestamp" | "status" | "write_state">, deps: AccountingWriteDeps<E>,
  send: () => Promise<Response>, validate: (payload: unknown) => R,
): Promise<R>;
export async function auditedAccountingWrite<E extends AccountingAuditEntry>(
  base: Omit<E, "timestamp" | "status" | "write_state">,
  deps: AccountingWriteDeps<E>,
  send: () => Promise<Response>,
  envelope: "deal" | "receipt" | ((payload: unknown) => unknown),
): Promise<unknown> {
  const now = stableClock(deps.now);
  const timestamp = now().toISOString();
  try {
    await deps.appendAudit({ ...base, timestamp, status: "attempting", write_state: "not_attempted" } as E);
  } catch { throw new Error("accounting write: audit write failed (not_attempted)"); }
  let state: AccountingAuditEntry["write_state"] = "unknown";
  let id: number | undefined;
  let reason = "request_failed";
  try {
    const response = await send();
    state = "succeeded";
    reason = "invalid_response";
    const payload = await response.json();
    let result: unknown;
    if (typeof envelope === "function") {
      result = envelope(payload);
    } else {
      const item = isRecord(payload) ? payload[envelope] : undefined;
      id = isRecord(item) && typeof item.id === "number" ? item.id : undefined;
      assertId(id!, "response id");
      if (isRecord(item) && item.company_id !== undefined && item.company_id !== base.company_id) throw new Error("invalid response company_id");
      if (base.target_id !== undefined && id !== base.target_id) throw new Error("invalid response target id");
      result = { id: id! };
    }
    reason = "audit_write_failed";
    await deps.appendAudit({ ...base, timestamp: now().toISOString(), status: "succeeded", write_state: state, ...(id === undefined ? {} : { created_id: id }) } as E);
    return result;
  } catch (error) {
    if (error instanceof FreeeApiError) {
      state = error.status >= 400 && error.status < 500 ? "rejected" : "unknown";
      reason = `http:${error.status}`;
    }
    try { await deps.appendAudit({ ...base, timestamp: now().toISOString(), status: "failed", write_state: state, ...(Number.isSafeInteger(id) && id! > 0 ? { created_id: id } : {}), reason } as E); } catch { /* 送信後は監査の失敗にかかわらず、再実行前の確認を要求する。 */ }
    throw new AccountingWriteError(state, Number.isSafeInteger(id) && id! > 0 ? id : undefined);
  }
}
