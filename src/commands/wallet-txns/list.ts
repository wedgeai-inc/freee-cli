import { responseArray, type AccountingReadDeps, type AccountingRecord, type CompanyOptions } from "../../lib/accounting-read.js";
import { assertId, assertDate } from "../../lib/accounting-validation.js";
import type { WalletableType } from "../walletables/list.js";

export interface WalletTxnsListOptions extends CompanyOptions {
  walletableType?: WalletableType; walletableId?: number;
  startDate?: string; endDate?: string; entrySide?: "income" | "expense";
  sortType?: "created_at_desc"; limit?: number; offset?: number;
}
export function validateWalletTxnsListOptions(opts: WalletTxnsListOptions): void {
  assertId(opts.companyId, "company_id");
  if ((opts.walletableType === undefined) !== (opts.walletableId === undefined)) throw new Error("walletable_type and walletable_id must be specified together");
  if (opts.walletableType !== undefined && !["bank_account", "credit_card", "wallet"].includes(opts.walletableType)) throw new Error("invalid walletable_type");
  if (opts.walletableId !== undefined) assertId(opts.walletableId, "walletable_id");
  if (opts.startDate !== undefined) assertDate(opts.startDate, "start_date");
  if (opts.endDate !== undefined) assertDate(opts.endDate, "end_date");
  if (opts.startDate && opts.endDate && opts.startDate > opts.endDate) throw new Error("start_date must not follow end_date");
  if (opts.entrySide !== undefined && !["income", "expense"].includes(opts.entrySide)) throw new Error("invalid entry_side");
  if (opts.sortType !== undefined && opts.sortType !== "created_at_desc") throw new Error("invalid sort_type");
  if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > 100)) throw new Error("--limit must be an integer between 1 and 100");
  if (opts.offset !== undefined && (!Number.isSafeInteger(opts.offset) || opts.offset < 0)) throw new Error("offset must be a non-negative safe integer");
}
export async function runWalletTxnsList(opts: WalletTxnsListOptions, deps: AccountingReadDeps): Promise<{ items: AccountingRecord[] }> {
  validateWalletTxnsListOptions(opts);
  const items: AccountingRecord[] = [];
  const limit = opts.limit ?? 100;
  for (let offset = opts.offset ?? 0; ; offset += limit) {
    const payload = await (await deps.client.get("/api/1/wallet_txns", { query: { company_id: opts.companyId, walletable_type: opts.walletableType, walletable_id: opts.walletableId, start_date: opts.startDate, end_date: opts.endDate, entry_side: opts.entrySide, sort_type: opts.sortType, limit, offset } })).json();
    const page = responseArray(payload, "wallet_txns", "/api/1/wallet_txns");
    items.push(...page);
    if (opts.limit !== undefined || opts.offset !== undefined || page.length < limit) return { items };
  }
}
