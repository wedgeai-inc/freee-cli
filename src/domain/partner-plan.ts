export interface PartnerPlan {
  name: string;
  code?: string;
  shortcut1?: string;
  shortcut2?: string;
  org_code?: 1 | 2 | null;
  country_code?: "JP" | "ZZ";
  long_name?: string;
  name_kana?: string;
  default_title?: "御中" | "様" | "";
  phone?: string;
  contact_name?: string;
  email?: string;
  qualified_invoice_issuer?: boolean;
  invoice_registration_number?: string | null;
  address_attributes?: { zipcode?: string; prefecture_code?: number; street_name1?: string; street_name2?: string };
  payment_term_attributes?: PaymentTerm;
  invoice_payment_term_attributes?: PaymentTerm;
  partner_doc_setting_attributes?: { sending_method?: SendingMethod | null };
}
type PaymentTerm = { cutoff_day?: number; additional_months?: number; fixed_day?: number };
type SendingMethod = "email" | "posting" | "email_and_posting" | "pdf_delivery" | "pdf_delivery_and_posting";
type FieldType = "string" | "integer" | "boolean";
type FieldValue = string | number | boolean;

export class PartnerPlanError extends Error { constructor(message: string) { super(`partner plan: ${message}`); this.name = "PartnerPlanError"; } }
export interface PartnerPlanField {
  path: readonly string[];
  type: FieldType;
  validValue: FieldValue;
  validValues?: readonly FieldValue[];
  invalidValues?: readonly FieldValue[];
  required?: boolean;
  nullable?: boolean;
  maxLength?: number;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: readonly FieldValue[];
  pattern?: RegExp;
  nonBlank?: boolean;
}

/** Single source of truth for plan shape, validation, readback, and boundary tests. */
export const PARTNER_PLAN_FIELDS: readonly PartnerPlanField[] = [
  { path: ["name"], type: "string", validValue: "取引先", required: true, maxLength: 255, nonBlank: true },
  { path: ["code"], type: "string", validValue: "code", maxLength: 255, nonBlank: true },
  { path: ["shortcut1"], type: "string", validValue: "shortcut", maxLength: 255 },
  { path: ["shortcut2"], type: "string", validValue: "shortcut", maxLength: 255 },
  { path: ["org_code"], type: "integer", validValue: 1, enum: [1, 2], nullable: true },
  { path: ["country_code"], type: "string", validValue: "JP", enum: ["JP", "ZZ"] },
  { path: ["long_name"], type: "string", validValue: "正式名称", maxLength: 255 },
  { path: ["name_kana"], type: "string", validValue: "トリヒキサキ", maxLength: 255 },
  { path: ["default_title"], type: "string", validValue: "御中", enum: ["御中", "様", ""] },
  { path: ["phone"], type: "string", validValue: "03-1234-5678" },
  { path: ["contact_name"], type: "string", validValue: "担当者", maxLength: 255 },
  { path: ["email"], type: "string", validValue: "contact@example.test", maxLength: 255 },
  { path: ["qualified_invoice_issuer"], type: "boolean", validValue: true },
  { path: ["invoice_registration_number"], type: "string", validValue: "T1234567890123", validValues: ["1234567890123", "T1234567890123"], invalidValues: ["X1234567890123", "T0123456789012"], minLength: 13, maxLength: 14, nullable: true, pattern: /^T?[1-9][0-9]{12}$/ },
  { path: ["address_attributes", "zipcode"], type: "string", validValue: "1000001", maxLength: 8 },
  { path: ["address_attributes", "prefecture_code"], type: "integer", validValue: 1, minimum: -1, maximum: 46 },
  { path: ["address_attributes", "street_name1"], type: "string", validValue: "千代田", maxLength: 255 },
  { path: ["address_attributes", "street_name2"], type: "string", validValue: "1-1", maxLength: 255 },
  ...["payment_term_attributes", "invoice_payment_term_attributes"].flatMap((parent) => [
    { path: [parent, "cutoff_day"], type: "integer" as const, validValue: 1, minimum: 1, maximum: 32 },
    { path: [parent, "additional_months"], type: "integer" as const, validValue: 0, minimum: 0, maximum: 6 },
    { path: [parent, "fixed_day"], type: "integer" as const, validValue: 1, minimum: 1, maximum: 32 },
  ]),
  { path: ["partner_doc_setting_attributes", "sending_method"], type: "string", validValue: "email", nullable: true, enum: ["email", "posting", "email_and_posting", "pdf_delivery", "pdf_delivery_and_posting"] },
];

const forbidden = new Set(["company_id", "payer_walletable_id", "transfer_fee_handling_side", "partner_bank_account_attributes"]);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hasLeaf = (value: Record<string, unknown>): boolean => Object.values(value).some((child) => !isRecord(child) || hasLeaf(child));
const fail = (message: string): never => { throw new PartnerPlanError(message); };
const getPath = (value: Record<string, unknown>, path: readonly string[]): unknown => path.reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, value);
function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current = target;
  for (const key of path.slice(0, -1)) current = (current[key] ??= {}) as Record<string, unknown>;
  current[path.at(-1)!] = value;
}

interface FieldNode { field?: PartnerPlanField; children: Map<string, FieldNode>; }
const tree: FieldNode = { children: new Map() };
for (const field of PARTNER_PLAN_FIELDS) {
  let node = tree;
  for (const key of field.path) { let child = node.children.get(key); if (!child) { child = { children: new Map() }; node.children.set(key, child); } node = child; }
  node.field = field;
}

function validateShape(value: Record<string, unknown>, node: FieldNode, prefix = ""): void {
  for (const [key, child] of Object.entries(value)) {
    const next = node.children.get(key) ?? fail(`${prefix}${key} is not allowed`);
    if (next.children.size > 0) {
      validateShape(isRecord(child) ? child : fail(`${prefix}${key} must be an object`), next, `${prefix}${key}.`);
    }
  }
}

function validateField(field: PartnerPlanField, value: unknown): FieldValue | null | undefined {
  const label = field.path.join(".");
  if (value === undefined) { if (field.required) fail(`${label} is required`); return undefined; }
  if (value === null) { if (field.nullable) return null; fail(`${label} must not be null`); }
  if (field.type === "string") {
    const text = typeof value === "string" ? value : fail(`${label} must be a string`);
    if (field.minLength !== undefined && text.length < field.minLength) fail(`${label} is too short`);
    if (field.maxLength !== undefined && text.length > field.maxLength) fail(`${label} is too long`);
    if (field.nonBlank && text.trim() === "") fail(`${label} must not be blank`);
    if (field.pattern && !field.pattern.test(text)) fail(`${label} has an invalid format`);
  } else if (field.type === "integer") {
    const integer = typeof value === "number" && Number.isSafeInteger(value) ? value : fail(`${label} must be a safe integer`);
    if (field.minimum !== undefined && integer < field.minimum) fail(`${label} is too small`);
    if (field.maximum !== undefined && integer > field.maximum) fail(`${label} is too large`);
  } else if (typeof value !== "boolean") fail(`${label} must be a boolean`);
  if (field.enum && !field.enum.includes(value as FieldValue)) fail(`${label} is not an allowed value`);
  return value as FieldValue;
}

function copyContainers(input: Record<string, unknown>, node: FieldNode, output: Record<string, unknown>, prefix: readonly string[] = []): void {
  for (const [key, child] of node.children) {
    const path = [...prefix, key];
    if (child.children.size > 0 && getPath(input, path) !== undefined) { setPath(output, path, {}); copyContainers(input, child, output, path); }
  }
}

export function parsePartnerPlan(raw: unknown): PartnerPlan {
  const input = isRecord(raw) ? raw : fail("plan must be a single JSON object");
  for (const key of Object.keys(input)) if (forbidden.has(key)) fail(`${key} must not be included in the plan`);
  validateShape(input, tree);
  const plan: Record<string, unknown> = {};
  copyContainers(input, tree, plan);
  for (const field of PARTNER_PLAN_FIELDS) {
    const value = validateField(field, getPath(input, field.path));
    if (value !== undefined) setPath(plan, field.path, value);
  }
  return plan as unknown as PartnerPlan;
}

export type PartnerUpdatePlan = Omit<PartnerPlan, "name" | "payment_term_attributes" | "invoice_payment_term_attributes"> & {
  name?: string;
  available?: boolean;
  payment_term_attributes?: PaymentTerm | null;
  invoice_payment_term_attributes?: PaymentTerm | null;
};

const updateFields: readonly PartnerPlanField[] = [
  ...PARTNER_PLAN_FIELDS.map((field) => field.path[0] === "name" ? { ...field, required: false } : field),
  { path: ["available"], type: "boolean", validValue: true },
];
const updateTree: FieldNode = { children: new Map() };
for (const field of updateFields) {
  let node = updateTree;
  for (const key of field.path) { let child = node.children.get(key); if (!child) { child = { children: new Map() }; node.children.set(key, child); } node = child; }
  node.field = field;
}

/** Update accepts the create schema with a deliberately narrower null contract. */
export function parsePartnerUpdatePlan(raw: unknown): PartnerUpdatePlan {
  const input = isRecord(raw) ? structuredClone(raw) : fail("plan must be a single JSON object");
  if (Object.keys(input).length === 0) fail("plan must not be empty");
  for (const key of Object.keys(input)) if (forbidden.has(key) || key === "code") fail(`${key} must not be included in the plan`);
  for (const path of [["org_code"], ["invoice_registration_number"], ["partner_doc_setting_attributes", "sending_method"]] as const) {
    if (getPath(input, path) === null) fail(`${path.join(".")} must not be null`);
  }
  const nullTerms: Array<"payment_term_attributes" | "invoice_payment_term_attributes"> = [];
  for (const key of ["payment_term_attributes", "invoice_payment_term_attributes"] as const) {
    const term = input[key];
    if (term === null) { nullTerms.push(key); delete input[key]; continue; }
    if (term !== undefined && (!isRecord(term) || ["cutoff_day", "additional_months", "fixed_day"].some((part) => !(part in term)))) fail(`${key} must include cutoff_day, additional_months, and fixed_day`);
  }
  validateShape(input, updateTree);
  const plan: Record<string, unknown> = {};
  copyContainers(input, updateTree, plan);
  for (const field of updateFields) {
    const value = validateField(field, getPath(input, field.path));
    if (value !== undefined) setPath(plan, field.path, value);
  }
  for (const key of nullTerms) plan[key] = null;
  if (!hasLeaf(plan)) fail("plan must not be empty");
  return plan as PartnerUpdatePlan;
}
