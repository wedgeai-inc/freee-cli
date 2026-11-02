import { assertId, assertAmount, assertTaxCode, assertDate } from "../lib/accounting-validation.js";
export interface DealPlanOptions {
  companyId: number; type: string; issueDate: string; dueDate?: string; partnerId: number;
  details: string[]; receiptIds?: number[]; refNumber?: string;
}
export interface DealDetail { account_item_id: number; tax_code: number; amount: number; description?: string; }
export interface DealPayload {
  company_id: number; type: string; issue_date: string; partner_id: number; details: DealDetail[];
  due_date?: string; receipt_ids?: number[]; ref_number?: string;
}
export function buildDealPlan(opts: DealPlanOptions): { payload: DealPayload; total: number } {
  assertId(opts.companyId, "company_id"); assertId(opts.partnerId, "partner_id");
  if (!["income", "expense"].includes(opts.type)) throw new Error("type must be income or expense");
  assertDate(opts.issueDate, "issue_date");
  if (opts.dueDate !== undefined) { assertDate(opts.dueDate, "due_date"); if (opts.dueDate < opts.issueDate) throw new Error("due_date must not precede issue_date"); }
  opts.receiptIds?.forEach(id => assertId(id, "receipt_id"));
  if (!Array.isArray(opts.details) || opts.details.length === 0) throw new Error("--detail is required");
  if (opts.details.length > 100) throw new Error("details must contain at most 100 rows");
  const details = opts.details.map((text) => {
    const fields: Record<string, string> = {};
    for (const part of text.split(",")) {
      const pos = part.indexOf("="); const key = part.slice(0, pos);
      if (pos < 1 || !["account_item_id", "tax_code", "amount", "description"].includes(key) || Object.hasOwn(fields, key)) throw new Error("invalid --detail field");
      fields[key] = part.slice(pos + 1);
    }
    for (const key of ["account_item_id", "tax_code", "amount"]) {
      if (!(key === "amount" ? /^-?[0-9]+$/ : /^[0-9]+$/).test(fields[key] ?? "")) throw new Error(`invalid --detail ${key}`);
      assertAmount(Number(fields[key]), key);
    }
    assertTaxCode(Number(fields.tax_code));
    assertId(Number(fields.account_item_id), "account_item_id");
    return { account_item_id: Number(fields.account_item_id), tax_code: Number(fields.tax_code), amount: Number(fields.amount), ...(fields.description === undefined ? {} : { description: fields.description }) };
  });
  const total = details.reduce((sum, detail) => sum + detail.amount, 0);
  assertAmount(total, "total");
  return { total, payload: {
    company_id: opts.companyId, type: opts.type, issue_date: opts.issueDate, partner_id: opts.partnerId, details,
    ...(opts.dueDate === undefined ? {} : { due_date: opts.dueDate }),
    ...(opts.receiptIds === undefined ? {} : { receipt_ids: opts.receiptIds }),
    ...(opts.refNumber === undefined ? {} : { ref_number: opts.refNumber }),
  } };
}
