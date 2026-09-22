export interface QuotationSummary {
  id: number; company_id: number; quotation_number: string; subject: string; quotation_date: string;
  partner_id: number; partner_name?: string; total_amount: number; amount_excluding_tax: number; amount_tax: number;
  sending_status: "sent" | "unsent"; cancel_status: "canceled" | "uncanceled"; report_url: string;
}
export interface QuotationLine { id: number; type: "item" | "text"; description: string; withholding: boolean; quantity?: number | null; unit?: string; unit_price?: string | null; tax_rate?: 0 | 8 | 10 | null; reduced_tax_rate?: boolean; amount_excluding_tax?: number | null; }
export interface QuotationDetail extends QuotationSummary {
  lines: QuotationLine[]; created_at: string; amount_including_tax: number; delivery_deadline: string; delivery_location: string; quotation_note: string; memo: string;
  expiration_date?: string | null; tax_entry_method?: "in" | "out" | null; tax_fraction?: "omit" | "round_up" | "round" | null; line_amount_fraction?: "omit" | "round_up" | "round" | null; withholding_tax_entry_method?: "in" | "out" | null; branch_no?: number | null; partner_code?: string | null; amount_withholding_tax?: number | null; amount_including_tax_10?: number | null; amount_excluding_tax_10?: number | null; amount_tax_10?: number | null; amount_including_tax_8?: number | null; amount_excluding_tax_8?: number | null; amount_tax_8?: number | null; amount_including_tax_8_reduced?: number | null; amount_excluding_tax_8_reduced?: number | null; amount_tax_8_reduced?: number | null; amount_including_tax_0?: number | null; amount_excluding_tax_0?: number | null; amount_tax_0?: number | null; template_id?: number;
}
export interface QuotationTemplate { id: number; name: string; }

function responseError(field: string, expected: string): Error { return new Error(`quotation response: ${field} must be ${expected}`); }
function requiredString(value: unknown, field: string): string { if (typeof value !== "string") throw responseError(field, "a string"); return value; }
function requiredFiniteNumber(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw responseError(field, "a finite number"); return value; }
function positiveSafeInteger(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw responseError(field, "a positive safe integer"); return value; }
function nonNegativeSafeInteger(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw responseError(field, "a non-negative safe integer"); return value; }
function optionalString(value: unknown, field: string): string | undefined { if (value === undefined) return undefined; return requiredString(value, field); }
function optionalNullableString(value: unknown, field: string): string | null | undefined { if (value === undefined || value === null) return value; return requiredString(value, field); }
function optionalNullableFiniteNumber(value: unknown, field: string): number | null | undefined { if (value === undefined || value === null) return value; return requiredFiniteNumber(value, field); }
function requiredEnum<T extends string | number>(value: unknown, field: string, values: readonly T[]): T { if (!values.includes(value as T)) throw responseError(field, values.join(" or ")); return value as T; }
function optionalNullableEnum<T extends string | number>(value: unknown, field: string, values: readonly T[]): T | null | undefined { if (value === undefined || value === null) return value; return requiredEnum(value, field, values); }
function record(value: unknown, field: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw responseError(field, "an object"); return value as Record<string, unknown>; }

/** API 応答を declared summary 型へ検証して投影する。未知フィールドは出力に含めない。 */
export function toQuotationSummary(raw: Record<string, unknown>): QuotationSummary {
  const out: QuotationSummary = {
    id: positiveSafeInteger(raw.id, "id"), company_id: positiveSafeInteger(raw.company_id, "company_id"), quotation_number: requiredString(raw.quotation_number, "quotation_number"), subject: requiredString(raw.subject, "subject"), quotation_date: requiredString(raw.quotation_date, "quotation_date"), partner_id: positiveSafeInteger(raw.partner_id, "partner_id"), total_amount: requiredFiniteNumber(raw.total_amount, "total_amount"), amount_excluding_tax: requiredFiniteNumber(raw.amount_excluding_tax, "amount_excluding_tax"), amount_tax: requiredFiniteNumber(raw.amount_tax, "amount_tax"), sending_status: requiredEnum(raw.sending_status, "sending_status", ["sent", "unsent"] as const), cancel_status: requiredEnum(raw.cancel_status, "cancel_status", ["canceled", "uncanceled"] as const), report_url: requiredString(raw.report_url, "report_url"),
  };
  const partnerName = optionalString(raw.partner_name, "partner_name"); if (partnerName !== undefined) out.partner_name = partnerName;
  return out;
}
function toQuotationLine(value: unknown, index: number): QuotationLine {
  const raw = record(value, `lines[${index}]`);
  const line: QuotationLine = { id: positiveSafeInteger(raw.id, `lines[${index}].id`), type: requiredEnum(raw.type, `lines[${index}].type`, ["item", "text"] as const), description: requiredString(raw.description, `lines[${index}].description`), withholding: (() => { if (typeof raw.withholding !== "boolean") throw responseError(`lines[${index}].withholding`, "a boolean"); return raw.withholding; })() };
  const quantity = optionalNullableFiniteNumber(raw.quantity, `lines[${index}].quantity`); if (quantity !== undefined) line.quantity = quantity;
  const unit = optionalString(raw.unit, `lines[${index}].unit`); if (unit !== undefined) line.unit = unit;
  const unitPrice = optionalNullableString(raw.unit_price, `lines[${index}].unit_price`); if (unitPrice !== undefined) line.unit_price = unitPrice;
  const taxRate = optionalNullableEnum(raw.tax_rate, `lines[${index}].tax_rate`, [0, 8, 10] as const); if (taxRate !== undefined) line.tax_rate = taxRate;
  if (raw.reduced_tax_rate !== undefined) { if (typeof raw.reduced_tax_rate !== "boolean") throw responseError(`lines[${index}].reduced_tax_rate`, "a boolean"); line.reduced_tax_rate = raw.reduced_tax_rate; }
  const amount = optionalNullableFiniteNumber(raw.amount_excluding_tax, `lines[${index}].amount_excluding_tax`); if (amount !== undefined) line.amount_excluding_tax = amount;
  return line;
}
function setNullableString(out: QuotationDetail, raw: Record<string, unknown>, key: "expiration_date" | "partner_code"): void { const value = optionalNullableString(raw[key], key); if (value !== undefined) out[key] = value; }
function setNullableNumber(out: QuotationDetail, raw: Record<string, unknown>, key: "amount_withholding_tax" | "amount_including_tax_10" | "amount_excluding_tax_10" | "amount_tax_10" | "amount_including_tax_8" | "amount_excluding_tax_8" | "amount_tax_8" | "amount_including_tax_8_reduced" | "amount_excluding_tax_8_reduced" | "amount_tax_8_reduced" | "amount_including_tax_0" | "amount_excluding_tax_0" | "amount_tax_0"): void { const value = optionalNullableFiniteNumber(raw[key], key); if (value !== undefined) out[key] = value; }
/** API 応答を declared detail 型へ検証して投影する。required は欠落で、nullable は型不正で拒否する。 */
export function toQuotationDetail(raw: Record<string, unknown>): QuotationDetail {
  if (!Array.isArray(raw.lines)) throw responseError("lines", "an array");
  const out: QuotationDetail = { ...toQuotationSummary(raw), lines: raw.lines.map(toQuotationLine), created_at: requiredString(raw.created_at, "created_at"), amount_including_tax: requiredFiniteNumber(raw.amount_including_tax, "amount_including_tax"), delivery_deadline: requiredString(raw.delivery_deadline, "delivery_deadline"), delivery_location: requiredString(raw.delivery_location, "delivery_location"), quotation_note: requiredString(raw.quotation_note, "quotation_note"), memo: requiredString(raw.memo, "memo") };
  setNullableString(out, raw, "expiration_date"); setNullableString(out, raw, "partner_code");
  for (const key of ["tax_entry_method", "withholding_tax_entry_method"] as const) { const value = optionalNullableEnum(raw[key], key, ["in", "out"] as const); if (value !== undefined) out[key] = value; }
  for (const key of ["tax_fraction", "line_amount_fraction"] as const) { const value = optionalNullableEnum(raw[key], key, ["omit", "round_up", "round"] as const); if (value !== undefined) out[key] = value; }
  if (raw.branch_no !== undefined) out.branch_no = raw.branch_no === null ? null : nonNegativeSafeInteger(raw.branch_no, "branch_no");
  if (raw.template_id !== undefined) out.template_id = positiveSafeInteger(raw.template_id, "template_id");
  for (const key of ["amount_withholding_tax", "amount_including_tax_10", "amount_excluding_tax_10", "amount_tax_10", "amount_including_tax_8", "amount_excluding_tax_8", "amount_tax_8", "amount_including_tax_8_reduced", "amount_excluding_tax_8_reduced", "amount_tax_8_reduced", "amount_including_tax_0", "amount_excluding_tax_0", "amount_tax_0"] as const) setNullableNumber(out, raw, key);
  return out;
}
export function toQuotationTemplate(raw: Record<string, unknown>): QuotationTemplate { return { id: positiveSafeInteger(raw.id, "template.id"), name: requiredString(raw.name, "template.name") }; }
