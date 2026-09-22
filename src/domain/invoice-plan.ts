/**
 * invoices create の plan JSON 検証と金額計算。
 * freee 請求書 API `POST /invoices` のリクエストボディから company_id を除いた部分集合を受け付ける。
 * 未知キー・送付設定・company_id 同梱は fail-closed で拒否する。
 */

export type TaxEntryMethod = "in" | "out";
export type Fraction = "omit" | "round_up" | "round";

export interface InvoicePlanLine {
  type: "item" | "text";
  description?: string;
  sales_date?: string;
  unit?: string;
  quantity?: number;
  unit_price?: string;
  tax_rate?: 0 | 8 | 10;
  reduced_tax_rate?: boolean;
  withholding?: boolean;
  tag_ids?: number[];
}

export interface InvoicePlan {
  billing_date: string;
  payment_date?: string;
  payment_type?: "transfer" | "direct_debit";
  partner_id?: number;
  partner_code?: string;
  partner_title: string;
  partner_display_name?: string;
  partner_contact_email_to?: string;
  partner_contact_email_cc?: string;
  subject?: string;
  invoice_number?: string;
  branch_no?: number;
  template_id?: number;
  tax_entry_method: TaxEntryMethod;
  tax_fraction: Fraction;
  line_amount_fraction?: Fraction;
  withholding_tax_entry_method: "in" | "out";
  invoice_note?: string;
  memo?: string;
  lines: InvoicePlanLine[];
}

export interface InvoiceTotals {
  subtotal: number;
  tax: number;
  total: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UNIT_PRICE_RE = /^-?[0-9]{0,13}(\.[0-9]{1,3})?$/;
const PARTNER_TITLES = new Set(["御中", "様", "(空白)"]);
const FRACTIONS = new Set<string>(["omit", "round_up", "round"]);
const IN_OUT = new Set<string>(["in", "out"]);
const PAYMENT_TYPES = new Set<string>(["transfer", "direct_debit"]);
const TAX_RATES = new Set<number>([0, 8, 10]);
/** 公式スキーマ: quantity は整数部 8 桁・小数部 3 桁（最大 99999999.999） */
const QUANTITY_MAX = 99_999_999.999;

const REJECTED_KEYS = new Set(["company_id", "partner_sending_method"]);
export const INVOICE_PLAN_ALLOWED_KEYS = [
  "billing_date",
  "payment_date",
  "payment_type",
  "partner_id",
  "partner_code",
  "partner_title",
  "partner_display_name",
  "partner_contact_email_to",
  "partner_contact_email_cc",
  "subject",
  "invoice_number",
  "branch_no",
  "template_id",
  "tax_entry_method",
  "tax_fraction",
  "line_amount_fraction",
  "withholding_tax_entry_method",
  "invoice_note",
  "memo",
  "lines",
 ] as const;
const ALLOWED_KEYS = new Set<string>(INVOICE_PLAN_ALLOWED_KEYS);
export const INVOICE_PLAN_ALLOWED_LINE_KEYS = [
  "type",
  "description",
  "sales_date",
  "unit",
  "quantity",
  "unit_price",
  "tax_rate",
  "reduced_tax_rate",
  "withholding",
  "tag_ids",
 ] as const;
const ALLOWED_LINE_KEYS = new Set<string>(INVOICE_PLAN_ALLOWED_LINE_KEYS);

class PlanError extends Error {
  constructor(message: string) {
    super(`invoice plan: ${message}`);
    this.name = "InvoicePlanError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) throw new PlanError(`${key} is required (string)`);
  return v;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new PlanError(`${key} must be a string`);
  return v;
}

function optionalNonEmptyString(obj: Record<string, unknown>, key: string, label = key): string | undefined {
  const v = optionalString(obj, key);
  if (v !== undefined && v.length === 0) throw new PlanError(`${label} must not be empty`);
  return v;
}

function optionalBoundedString(obj: Record<string, unknown>, key: string, minLength: number, maxLength: number, label = key): string | undefined {
  const value = optionalString(obj, key);
  if (value !== undefined && value.length < minLength) { if (minLength === 1 && value.length === 0) throw new PlanError(`${label} must not be empty`); throw new PlanError(`${label} must be at least ${minLength} characters`); }
  if (value !== undefined && value.length > maxLength) throw new PlanError(`${label} must be at most ${maxLength} characters`);
  return value;
}

function optionalDate(obj: Record<string, unknown>, key: string): string | undefined {
  const v = optionalString(obj, key);
  if (v !== undefined && !DATE_RE.test(v)) throw new PlanError(`${key} must be YYYY-MM-DD`);
  return v;
}

function optionalPositiveInt(obj: Record<string, unknown>, key: string, min = 1): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) {
    throw new PlanError(`${key} must be an integer >= ${min}`);
  }
  return v;
}

function optionalEnum<T extends string>(obj: Record<string, unknown>, key: string, allowed: Set<string>): T | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !allowed.has(v)) {
    throw new PlanError(`${key} must be one of ${[...allowed].join(" / ")}`);
  }
  return v as T;
}

function requireEnum<T extends string>(obj: Record<string, unknown>, key: string, allowed: Set<string>): T {
  const v = obj[key];
  if (typeof v !== "string" || !allowed.has(v)) {
    throw new PlanError(`${key} is required and must be one of ${[...allowed].join(" / ")}`);
  }
  return v as T;
}

function optionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new PlanError(`${key} must be a boolean`);
  return v;
}

export function parseInvoicePlanLine(raw: unknown, index: number): InvoicePlanLine {
  const at = `lines[${index}]`;
  if (!isRecord(raw)) throw new PlanError(`${at} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_LINE_KEYS.has(key)) throw new PlanError(`${at}.${key} is not allowed`);
  }
  const type = raw.type === undefined ? "item" : raw.type;
  if (type !== "item" && type !== "text") throw new PlanError(`${at}.type must be item or text`);
  const description = optionalBoundedString(raw, "description", 1, 255, `${at}.description`);
  if (type === "text") {
    if (description === undefined) throw new PlanError(`${at}.description is required for text lines`);
    const extra = Object.keys(raw).filter((k) => k !== "type" && k !== "description");
    if (extra.length > 0) throw new PlanError(`${at} text line allows description only (found ${extra.join(", ")})`);
    return { type, description };
  }
  if (description === undefined) throw new PlanError(`${at}.description is required`);
  const quantity = raw.quantity;
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) {
    throw new PlanError(`${at}.quantity is required (positive number)`);
  }
  if (quantity > QUANTITY_MAX) throw new PlanError(`${at}.quantity must be <= ${QUANTITY_MAX} (API maximum)`);
  // 「小数 3 桁まで」= 3 桁へ丸めた値と元の値が同一（1.001 は有効。1.0001 / 4e-10 / 1.0000000004 は無効）。payload には元の値がそのまま載る
  if (Number(quantity.toFixed(3)) !== quantity) throw new PlanError(`${at}.quantity allows up to 3 decimals`);
  const unitPrice = raw.unit_price;
  if (typeof unitPrice !== "string" || !UNIT_PRICE_RE.test(unitPrice) || unitPrice === "" || unitPrice === "-") {
    throw new PlanError(`${at}.unit_price is required (string matching ^-?[0-9]{0,13}(\\.[0-9]{1,3})?$)`);
  }
  const taxRate = raw.tax_rate;
  if (typeof taxRate !== "number" || !TAX_RATES.has(taxRate)) throw new PlanError(`${at}.tax_rate must be 0, 8 or 10`);
  const reduced = optionalBoolean(raw, "reduced_tax_rate");
  if (reduced === true && taxRate !== 8) throw new PlanError(`${at}.reduced_tax_rate requires tax_rate 8`);
  const tagIds = raw.tag_ids;
  if (tagIds !== undefined) {
    if (!Array.isArray(tagIds) || tagIds.length > 10 || tagIds.some((t) => !Number.isSafeInteger(t) || (t as number) < 1)) {
      throw new PlanError(`${at}.tag_ids must be up to 10 positive integers`);
    }
  }
  const line: InvoicePlanLine = {
    type,
    description,
    quantity,
    unit_price: unitPrice,
    tax_rate: taxRate as 0 | 8 | 10,
  };
  const unit = optionalBoundedString(raw, "unit", 1, 255, `${at}.unit`);
  if (unit !== undefined) line.unit = unit;
  const salesDate = optionalDate(raw, "sales_date");
  if (salesDate !== undefined) line.sales_date = salesDate;
  if (reduced !== undefined) line.reduced_tax_rate = reduced;
  const withholding = optionalBoolean(raw, "withholding");
  if (withholding !== undefined) line.withholding = withholding;
  if (tagIds !== undefined) line.tag_ids = tagIds as number[];
  return line;
}

export function parseInvoicePlan(raw: unknown): InvoicePlan {
  if (!isRecord(raw)) throw new PlanError("plan must be a single JSON object");
  for (const key of Object.keys(raw)) {
    if (REJECTED_KEYS.has(key)) throw new PlanError(`${key} must not be included in the plan`);
    if (!ALLOWED_KEYS.has(key)) throw new PlanError(`${key} is not allowed`);
  }

  const billingDate = requireString(raw, "billing_date");
  if (!DATE_RE.test(billingDate)) throw new PlanError("billing_date must be YYYY-MM-DD");

  const partnerId = optionalPositiveInt(raw, "partner_id");
  const partnerCode = optionalNonEmptyString(raw, "partner_code");
  if (partnerId === undefined && partnerCode === undefined) throw new PlanError("partner_id or partner_code is required");
  if (partnerId !== undefined && partnerCode !== undefined) {
    throw new PlanError("partner_id and partner_code must not be specified together");
  }

  const partnerTitle = requireString(raw, "partner_title");
  if (!PARTNER_TITLES.has(partnerTitle)) throw new PlanError("partner_title must be 御中 / 様 / (空白)");

  const linesRaw = raw.lines;
  if (!Array.isArray(linesRaw) || linesRaw.length === 0) throw new PlanError("lines is required (non-empty array)");

  const plan: InvoicePlan = {
    billing_date: billingDate,
    partner_title: partnerTitle,
    tax_entry_method: requireEnum<TaxEntryMethod>(raw, "tax_entry_method", IN_OUT),
    tax_fraction: requireEnum<Fraction>(raw, "tax_fraction", FRACTIONS),
    withholding_tax_entry_method: requireEnum<"in" | "out">(raw, "withholding_tax_entry_method", IN_OUT),
    lines: linesRaw.map((l, i) => parseInvoicePlanLine(l, i)),
  };
  if (partnerId !== undefined) plan.partner_id = partnerId;
  if (partnerCode !== undefined) plan.partner_code = partnerCode;

  const optionalStrings: Array<[keyof InvoicePlan, number, number]> = [
    ["partner_display_name", 0, 255],
    ["partner_contact_email_to", 1, 255],
    ["partner_contact_email_cc", 1, 255],
    ["subject", 1, 255],
    ["invoice_number", 0, 255],
    ["invoice_note", 0, 4000],
    ["memo", 1, 2000],
  ];
  for (const [key, minLength, maxLength] of optionalStrings) {
    const v = optionalBoundedString(raw, key, minLength, maxLength);
    if (v !== undefined) (plan as unknown as Record<string, unknown>)[key] = v;
  }
  const paymentDate = optionalDate(raw, "payment_date");
  if (paymentDate !== undefined) plan.payment_date = paymentDate;
  const paymentType = optionalEnum<"transfer" | "direct_debit">(raw, "payment_type", PAYMENT_TYPES);
  if (paymentType !== undefined) plan.payment_type = paymentType;
  const lineFraction = optionalEnum<Fraction>(raw, "line_amount_fraction", FRACTIONS);
  if (lineFraction !== undefined) plan.line_amount_fraction = lineFraction;
  const branchNo = optionalPositiveInt(raw, "branch_no", 0);
  if (branchNo !== undefined && branchNo > 2_147_483_647) throw new PlanError("branch_no must be <= 2147483647");
  if (branchNo !== undefined) plan.branch_no = branchNo;
  const templateId = optionalPositiveInt(raw, "template_id");
  if (templateId !== undefined) plan.template_id = templateId;
  return plan;
}

/** update 用の部分 plan。現在値を検証せず、create と同じ allowlist・値検証だけを再利用する。 */
export function parseInvoiceUpdatePlan(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new PlanError("plan must be a single JSON object");
  // create parser の必須項目だけを無害な値で補う。GET 由来の値は一切ここへ渡さない。
  // raw の各項目・lines（指定されたときだけ）は create と同一の validator を通る。
  const placeholder: Record<string, unknown> = {
    billing_date: "2000-01-01", partner_id: 1, partner_title: "御中",
    tax_entry_method: "out", tax_fraction: "omit", withholding_tax_entry_method: "out",
    lines: [{ type: "item", description: "placeholder", quantity: 1, unit_price: "0", tax_rate: 0 }],
  };
  if (raw.partner_code !== undefined) delete placeholder.partner_id;
  const parsed = parseInvoicePlan({ ...placeholder, ...raw }) as unknown as Record<string, unknown>;
  // placeholder は必須項目を満たすためだけのもの。利用者が指定したキーだけを、parser の正規化結果で返す。
  return Object.fromEntries(Object.keys(raw).map((key) => [key, parsed[key]]));
}

// 金額計算は浮動小数を使わず、十進文字列を 1/1000 単位の BigInt にして行う（quantity 小数 3 桁・unit_price 小数 3 桁）。
const MILLI = 1000n;

function toMilli(text: string): bigint {
  const m = /^(-?)(\d*)(?:\.(\d{1,3}))?$/.exec(text);
  if (!m) throw new PlanError(`cannot parse decimal: ${text}`);
  const sign = m[1] === "-" ? -1n : 1n;
  const whole = BigInt(m[2] || "0");
  const frac = BigInt((m[3] ?? "").padEnd(3, "0"));
  return sign * (whole * MILLI + frac);
}

function quantityToMilli(q: number): bigint {
  // parseLine で小数 3 桁までに制限済み。文字列化して十進で読む
  return toMilli(q.toFixed(3));
}

/** 端数処理を「分母 den で割った商」に対して行う。負数は絶対値に対して処理し符号を戻す。 */
function divWithFraction(num: bigint, den: bigint, fraction: Fraction): bigint {
  const sign = num < 0n ? -1n : 1n;
  const a = num < 0n ? -num : num;
  const q = a / den;
  const r = a % den;
  if (r === 0n) return sign * q;
  if (fraction === "omit") return sign * q;
  if (fraction === "round_up") return sign * (q + 1n);
  return sign * (r * 2n >= den ? q + 1n : q);
}

function toNumberChecked(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PlanError("amount exceeds Number.MAX_SAFE_INTEGER; cannot be represented exactly");
  }
  return Number(v);
}

/**
 * dry-run 表示用の参考値。確定値は freee の応答を正とする。
 * 行金額 = quantity × unit_price（十進・1/1000 単位同士の積を 1/1,000,000 で割って円へ）を line_amount_fraction で整数化。
 * 消費税は税区分（tax_rate × reduced_tax_rate）ごとに Σ行金額から算出して tax_fraction で整数化する。
 */
/**
 * 請求書・見積書共通の金額計算。帳票別の許可キー判定は各 plan parser に残す。
 */
export function computeInvoiceTotals(plan: Pick<InvoicePlan, "lines" | "tax_entry_method" | "tax_fraction" | "line_amount_fraction">): InvoiceTotals {
  const lineFraction = plan.line_amount_fraction ?? "omit";
  // 税区分（税率 × 軽減税率フラグ）ごとに集約する。通常 8% と軽減 8% は freee 上も別区分で、区分ごとに端数処理される
  const byCategory = new Map<string, { rate: number; amount: bigint }>();
  for (const line of plan.lines) {
    if (line.type !== "item") continue;
    const amount = divWithFraction(quantityToMilli(line.quantity ?? 0) * toMilli(line.unit_price ?? "0"), MILLI * MILLI, lineFraction);
    const rate = line.tax_rate ?? 0;
    const key = `${rate}:${line.reduced_tax_rate === true ? "reduced" : "standard"}`;
    const bucket = byCategory.get(key) ?? { rate, amount: 0n };
    bucket.amount += amount;
    byCategory.set(key, bucket);
  }
  let lineSum = 0n;
  let tax = 0n;
  for (const { rate, amount } of byCategory.values()) {
    lineSum += amount;
    const r = BigInt(rate);
    if (plan.tax_entry_method === "out") {
      tax += divWithFraction(amount * r, 100n, plan.tax_fraction);
    } else {
      tax += divWithFraction(amount * r, 100n + r, plan.tax_fraction);
    }
  }
  if (plan.tax_entry_method === "out") {
    return { subtotal: toNumberChecked(lineSum), tax: toNumberChecked(tax), total: toNumberChecked(lineSum + tax) };
  }
  return { subtotal: toNumberChecked(lineSum - tax), tax: toNumberChecked(tax), total: toNumberChecked(lineSum) };
}
