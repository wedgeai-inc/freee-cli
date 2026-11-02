import { assertId } from "./accounting-validation.js";
import type { ReadOnlyClient } from "./clients/read-only-client.js";

export type AccountingRecord = Record<string, unknown>;
export interface AccountingReadDeps { client: ReadOnlyClient; }
export interface CompanyOptions { companyId: number; }
export interface AccountingGetOptions extends CompanyOptions { id: number; }

export function isRecord(value: unknown): value is AccountingRecord { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function responseArray(payload: unknown, key: string, path: string): AccountingRecord[] {
  const items = isRecord(payload) ? payload[key] : undefined;
  if (!Array.isArray(items) || !items.every(isRecord)) throw new Error(`invalid response: ${path}`);
  return items;
}

export async function accountingGet(resource: "deals" | "receipts", opts: AccountingGetOptions, deps: AccountingReadDeps): Promise<AccountingRecord> {
  assertId(opts.companyId, "company_id"); assertId(opts.id);
  const path = `/api/1/${resource}/${opts.id}`;
  const payload = await (await deps.client.get(path, { query: { company_id: opts.companyId } })).json();
  const item = isRecord(payload) ? payload[resource === "deals" ? "deal" : "receipt"] : undefined;
  if (!isRecord(item) || item.id !== opts.id || ((resource === "deals" || item.company_id !== undefined) && item.company_id !== opts.companyId)) throw new Error(`invalid response: ${path}`);
  return item;
}
