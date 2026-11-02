import { responseArray } from "../../lib/accounting-read.js";
import { assertDate, assertId } from "../../lib/accounting-validation.js";
import type { AccountingReadDeps, AccountingRecord, CompanyOptions } from "../../lib/accounting-read.js";

export interface ReceiptsListOptions extends CompanyOptions {
  startDate: string;
  endDate: string;
  userName?: string;
  number?: number;
  commentType?: "posted" | "raised" | "resolved";
  commentImportant?: boolean;
  category?: "all" | "without_deal" | "with_expense_application_line" | "with_deal" | "ignored";
  limit?: number;
  offset?: number;
}
export interface ReceiptsListResult { items: AccountingRecord[]; }

export function validateReceiptsListOptions(opts: ReceiptsListOptions): void {
  assertId(opts.companyId, "company_id");
  assertDate(opts.startDate, "start_date");
  assertDate(opts.endDate, "end_date");
  if (opts.startDate > opts.endDate) throw new Error("start_date must not follow end_date");
  if (opts.number !== undefined) assertId(opts.number, "number");
  if (opts.limit !== undefined) {
    assertId(opts.limit, "limit");
    if (opts.limit > 3000) throw new Error("limit must be between 1 and 3000");
  }
  if (opts.offset !== undefined && (!Number.isSafeInteger(opts.offset) || opts.offset < 0)) throw new Error("offset must be a non-negative safe integer");
  if (opts.commentType !== undefined && !["posted", "raised", "resolved"].includes(opts.commentType)) throw new Error("comment_type must be posted, raised, or resolved");
  if (opts.category !== undefined && !["all", "without_deal", "with_expense_application_line", "with_deal", "ignored"].includes(opts.category)) throw new Error("category must be all, without_deal, with_expense_application_line, with_deal, or ignored");
}

export async function runReceiptsList(opts: ReceiptsListOptions, deps: AccountingReadDeps): Promise<ReceiptsListResult> {
  validateReceiptsListOptions(opts);
  const items: AccountingRecord[] = [];
  const limit = opts.limit ?? 100;
  const singlePage = opts.limit !== undefined || opts.offset !== undefined;
  for (let offset = opts.offset ?? 0; ; offset += limit) {
    const payload = await (await deps.client.get("/api/1/receipts", { query: {
      company_id: opts.companyId, start_date: opts.startDate, end_date: opts.endDate,
      user_name: opts.userName, number: opts.number, comment_type: opts.commentType,
      comment_important: opts.commentImportant, category: opts.category,
      limit, offset,
    } })).json();
    const page = responseArray(payload, "receipts", "/api/1/receipts");
    items.push(...page);
    if (singlePage || page.length < limit) return { items };
  }
}
