import { responseArray } from "../../lib/accounting-read.js";
import { assertId, assertDate } from "../../lib/accounting-validation.js";
import type { AccountingReadDeps, CompanyOptions, AccountingRecord } from "../../lib/accounting-read.js";
export interface DealsListOptions extends CompanyOptions { partnerId?: number; type?: "income" | "expense"; startIssueDate?: string; endIssueDate?: string; status?: "settled" | "unsettled"; }
export async function runDealsList(opts: DealsListOptions, deps: AccountingReadDeps): Promise<{ items: AccountingRecord[] }> {
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
    if (page.length < limit) return { items };
  }
}
