export interface InvoiceSummary {
  id: number;
  company_id: number;
  invoice_number: string;
  subject: string;
  billing_date: string;
  payment_date?: string | null;
  partner_id: number;
  partner_name?: string | null;
  total_amount: number;
  amount_excluding_tax: number;
  amount_tax: number;
  sending_status: "sent" | "unsent";
  /** freee 請求書 API スキーマ（iv/open-api-3）の 5 値 */
  payment_status: "settled" | "unsettled" | "canceled" | "unprocessed" | "failed";
  deal_status: "registered" | "unregistered";
  cancel_status: "canceled" | "uncanceled";
}

/** 明細行（公式スキーマ InvoiceResponse_invoice_lines の部分集合。行金額は amount_excluding_tax） */
export interface InvoiceLine {
  id?: number;
  type?: "item" | "text";
  description?: string;
  sales_date?: string;
  quantity?: number;
  unit?: string;
  unit_price?: string;
  tax_rate?: number;
  reduced_tax_rate?: boolean;
  withholding?: boolean;
  amount_excluding_tax?: number;
}

export interface InvoiceDetail extends InvoiceSummary {
  lines: InvoiceLine[];
  invoice_note?: string;
  memo?: string;
  template_id?: number;
  tax_entry_method?: string;
  tax_fraction?: string;
}

export interface InvoiceTemplate {
  id: number;
  name: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}
function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0);
}
function optStr(v: unknown): string | null | undefined {
  return v === undefined ? undefined : v === null ? null : String(v);
}

/** API 応答から InvoiceSummary の項目だけを取り出す。未知フィールドは出力に含めない。 */
export function toInvoiceSummary(raw: Record<string, unknown>): InvoiceSummary {
  const out: InvoiceSummary = {
    id: num(raw.id),
    company_id: num(raw.company_id),
    invoice_number: str(raw.invoice_number),
    subject: str(raw.subject),
    billing_date: str(raw.billing_date),
    partner_id: num(raw.partner_id),
    total_amount: num(raw.total_amount),
    amount_excluding_tax: num(raw.amount_excluding_tax),
    amount_tax: num(raw.amount_tax),
    sending_status: str(raw.sending_status) as InvoiceSummary["sending_status"],
    payment_status: str(raw.payment_status) as InvoiceSummary["payment_status"],
    deal_status: str(raw.deal_status) as InvoiceSummary["deal_status"],
    cancel_status: str(raw.cancel_status) as InvoiceSummary["cancel_status"],
  };
  const pd = optStr(raw.payment_date);
  if (pd !== undefined) out.payment_date = pd;
  const pn = optStr(raw.partner_name);
  if (pn !== undefined) out.partner_name = pn;
  return out;
}

function toInvoiceLine(raw: Record<string, unknown>): InvoiceLine {
  const line: InvoiceLine = {};
  if (typeof raw.id === "number") line.id = raw.id;
  if (raw.type === "item" || raw.type === "text") line.type = raw.type;
  if (typeof raw.description === "string") line.description = raw.description;
  if (typeof raw.sales_date === "string") line.sales_date = raw.sales_date;
  if (typeof raw.quantity === "number") line.quantity = raw.quantity;
  if (typeof raw.unit === "string") line.unit = raw.unit;
  if (typeof raw.unit_price === "string") line.unit_price = raw.unit_price;
  if (typeof raw.tax_rate === "number") line.tax_rate = raw.tax_rate;
  if (typeof raw.reduced_tax_rate === "boolean") line.reduced_tax_rate = raw.reduced_tax_rate;
  if (typeof raw.withholding === "boolean") line.withholding = raw.withholding;
  if (typeof raw.amount_excluding_tax === "number") line.amount_excluding_tax = raw.amount_excluding_tax;
  return line;
}

/** API 応答から InvoiceDetail の項目だけを取り出す。 */
export function toInvoiceDetail(raw: Record<string, unknown>): InvoiceDetail {
  const out: InvoiceDetail = {
    ...toInvoiceSummary(raw),
    lines: Array.isArray(raw.lines) ? raw.lines.map((l) => toInvoiceLine((l ?? {}) as Record<string, unknown>)) : [],
  };
  if (typeof raw.invoice_note === "string") out.invoice_note = raw.invoice_note;
  if (typeof raw.memo === "string") out.memo = raw.memo;
  if (typeof raw.template_id === "number") out.template_id = raw.template_id;
  if (typeof raw.tax_entry_method === "string") out.tax_entry_method = raw.tax_entry_method;
  if (typeof raw.tax_fraction === "string") out.tax_fraction = raw.tax_fraction;
  return out;
}

/** API 応答から InvoiceTemplate の項目だけを取り出す。 */
export function toInvoiceTemplate(raw: Record<string, unknown>): InvoiceTemplate {
  return { id: num(raw.id), name: str(raw.name) };
}
