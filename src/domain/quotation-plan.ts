/**
 * quotations create の plan JSON 検証。
 * 共通の値検証・明細検証・金額計算は invoice-plan を唯一の実装として使う。
 * 帳票固有の許可キーだけは、この境界で判定する。
 */
import {
  parseInvoicePlan,
  type Fraction,
  type InvoicePlan,
  type InvoicePlanLine,
  type TaxEntryMethod,
} from "./invoice-plan.js";

export interface QuotationPlan {
  quotation_date: string;
  expiration_date?: string;
  delivery_deadline?: string;
  delivery_location?: string;
  quotation_note?: string;
  quotation_number?: string;
  partner_id?: number;
  partner_code?: string;
  partner_title: string;
  partner_display_name?: string;
  partner_contact_email_to?: string;
  partner_contact_email_cc?: string;
  subject?: string;
  branch_no?: number;
  template_id?: number;
  tax_entry_method: TaxEntryMethod;
  tax_fraction: Fraction;
  line_amount_fraction?: Fraction;
  withholding_tax_entry_method: "in" | "out";
  memo?: string;
  lines: InvoicePlanLine[];
}

const TOP_LEVEL_KEYS = new Set([
  "quotation_date", "expiration_date", "delivery_deadline", "delivery_location", "quotation_note", "quotation_number",
  "partner_id", "partner_code", "partner_title", "partner_display_name", "partner_contact_email_to", "partner_contact_email_cc",
  "subject", "branch_no", "template_id", "tax_entry_method", "tax_fraction", "line_amount_fraction",
  "withholding_tax_entry_method", "memo", "lines",
]);
const LINE_KEYS = new Set(["type", "description", "unit", "quantity", "unit_price", "tax_rate", "reduced_tax_rate", "withholding"]);
const REJECTED_KEYS = new Set(["company_id", "partner_sending_method"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quotationError(message: string): Error {
  return new Error(`quotation plan: ${message}`);
}

function optionalLimitedString(raw: Record<string, unknown>, key: string, min: number, max: number): void {
  const value = raw[key];
  if (value !== undefined && (typeof value !== "string" || value.length < min || value.length > max)) {
    throw quotationError(`${key} must be a string of ${min} to ${max} characters`);
  }
}

/** 帳票固有キーを拒否した後、invoice の共通検証器へ正規化して委譲する。 */
export function parseQuotationPlan(raw: unknown): QuotationPlan {
  if (!isRecord(raw)) throw quotationError("plan must be a single JSON object");
  for (const key of Object.keys(raw)) {
    if (REJECTED_KEYS.has(key)) throw quotationError(`${key} must not be included in the plan`);
    if (!TOP_LEVEL_KEYS.has(key)) throw quotationError(`${key} is not allowed`);
  }
  if (typeof raw.quotation_date !== "string" || !DATE_RE.test(raw.quotation_date)) {
    throw quotationError("quotation_date is required (YYYY-MM-DD)");
  }
  if (raw.expiration_date !== undefined && (typeof raw.expiration_date !== "string" || !DATE_RE.test(raw.expiration_date))) {
    throw quotationError("expiration_date must be YYYY-MM-DD");
  }
  optionalLimitedString(raw, "delivery_deadline", 1, 255);
  optionalLimitedString(raw, "delivery_location", 1, 255);
  optionalLimitedString(raw, "quotation_note", 0, 4000);
  optionalLimitedString(raw, "quotation_number", 0, 255);
  if (!Array.isArray(raw.lines)) throw quotationError("lines is required (non-empty array)");
  for (let index = 0; index < raw.lines.length; index++) {
    const line = raw.lines[index];
    if (!isRecord(line)) continue; // 共通検証器が同じ契約で例外にする
    for (const key of Object.keys(line)) {
      if (!LINE_KEYS.has(key)) throw quotationError(`lines[${index}].${key} is not allowed`);
    }
  }

  // invoice 固有の許可キーを quotation 側で先に閉じた上で、共通フィールドを invoice の検証器へ渡す。
  const { quotation_date, expiration_date, delivery_deadline, delivery_location, quotation_note, quotation_number, ...common } = raw;
  const invoice = parseInvoicePlan({ ...common, billing_date: quotation_date }) as InvoicePlan;
  const { billing_date: _billingDate, ...shared } = invoice;
  const plan: QuotationPlan = {
    ...shared,
    quotation_date,
  };
  if (expiration_date !== undefined) plan.expiration_date = expiration_date as string;
  if (delivery_deadline !== undefined) plan.delivery_deadline = delivery_deadline as string;
  if (delivery_location !== undefined) plan.delivery_location = delivery_location as string;
  if (quotation_note !== undefined) plan.quotation_note = quotation_note as string;
  if (quotation_number !== undefined) plan.quotation_number = quotation_number as string;
  return plan;
}
