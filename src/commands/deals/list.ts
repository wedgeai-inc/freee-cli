import { responseArray } from "../../lib/accounting-read.js";
import { assertId, assertDate } from "../../lib/accounting-validation.js";
import type { AccountingReadDeps, CompanyOptions, AccountingRecord } from "../../lib/accounting-read.js";
export interface DealsListOptions extends CompanyOptions { partnerId?: number; type?: "income" | "expense"; startIssueDate?: string; endIssueDate?: string; status?: "settled" | "unsettled"; refNumber?: string; }
export async function runDealsList(opts: DealsListOptions, deps: AccountingReadDeps): Promise<{ items: AccountingRecord[] }> {
  validateDealRefNumber(opts.refNumber);
  assertId(opts.companyId, "company_id");
  if (opts.partnerId !== undefined) assertId(opts.partnerId, "partner_id");
  if (opts.type !== undefined && !["income", "expense"].includes(opts.type)) throw new Error("type must be income or expense");
  if (opts.status !== undefined && !["settled", "unsettled"].includes(opts.status)) throw new Error("status must be settled or unsettled");
  if (opts.startIssueDate !== undefined) assertDate(opts.startIssueDate, "start_issue_date");
  if (opts.endIssueDate !== undefined) assertDate(opts.endIssueDate, "end_issue_date");
  if (opts.startIssueDate && opts.endIssueDate && opts.startIssueDate > opts.endIssueDate) throw new Error("start_issue_date must not follow end_issue_date");
  const items: AccountingRecord[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const payload = await (await deps.client.get("/api/1/deals", { query: { company_id: opts.companyId, partner_id: opts.partnerId, type: opts.type, start_issue_date: opts.startIssueDate, end_issue_date: opts.endIssueDate, status: opts.status, limit, offset } })).json();
    const page = responseArray(payload, "deals", "/api/1/deals");
    items.push(...page);
    if (page.length < limit) break;
  }
  if (opts.refNumber === undefined) return { items };
  const matches = items.filter(item => item.ref_number === opts.refNumber);
  if (matches.length === 0) throw new Error("管理番号に一致する取引は0件です。管理番号が請求書番号と一致していない可能性があります。管理番号を確認してください");
  if (matches.length > 1) throw new Error(`管理番号に一致する取引は${matches.length}件です。取引先・種別・発生日・決済状態などの絞り込み条件を追加してください`);
  return { items: matches };
}

export function validateDealRefNumber(value: string | undefined): void {
  if (value !== undefined && (typeof value !== "string" || !value.trim())) {
    throw new Error("--ref-numberに空文字・空白だけの値は指定できません");
  }
}
