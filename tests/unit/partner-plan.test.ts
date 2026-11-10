import { describe, expect, it } from "vitest";
import { PARTNER_PLAN_FIELDS, PartnerPlanError, parsePartnerPlan, parsePartnerUpdatePlan } from "../../src/domain/partner-plan.js";

type Field = (typeof PARTNER_PLAN_FIELDS)[number];
const requiredField = PARTNER_PLAN_FIELDS.find((field) => field.required)!;
const nestedRoots = [...new Set(PARTNER_PLAN_FIELDS.filter((field) => field.path.length > 1).map((field) => field.path[0]!))];

function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current = target;
  for (const key of path.slice(0, -1)) current = (current[key] ??= {}) as Record<string, unknown>;
  current[path.at(-1)!] = value;
}
function deletePath(target: Record<string, unknown>, path: readonly string[]): void {
  let current = target;
  for (const key of path.slice(0, -1)) current = current[key] as Record<string, unknown>;
  delete current[path.at(-1)!];
}

function planFor(field: Field, value: unknown): Record<string, unknown> {
  const plan: Record<string, unknown> = {};
  setPath(plan, requiredField.path, requiredField.validValue);
  setPath(plan, field.path, value);
  return plan;
}

function acceptedValues(field: Field): unknown[] {
  const values: unknown[] = field.validValues ? [...field.validValues] : [field.validValue];
  if (field.enum) values.push(...field.enum);
  if (field.type === "string" && field.maxLength !== undefined && !field.pattern) values.push("x".repeat(field.maxLength));
  if (field.type === "integer" && field.minimum !== undefined && field.maximum !== undefined) values.push(field.minimum, field.minimum + 1, field.maximum);
  if (field.type === "boolean") values.push(false, true);
  if (field.nullable) values.push(null);
  return [...new Set(values)];
}

function rejectedValues(field: Field): unknown[] {
  const values: unknown[] = field.type === "string"
    ? [1, true, false, {}, []]
    : field.type === "integer"
      ? [1.5, NaN, Infinity, "1", true, {}, []]
      : ["true", 1, 0, {}, []];
  if (!field.nullable) values.push(null);
  if (field.type === "string" && field.maxLength !== undefined) values.push("x".repeat(field.maxLength + 1));
  if (field.type === "integer") {
    if (field.minimum !== undefined) values.push(field.minimum - 1);
    if (field.maximum !== undefined) values.push(field.maximum + 1);
  }
  if (field.nonBlank) values.push("", "   ");
  if (field.invalidValues) values.push(...field.invalidValues);
  if (field.enum) values.push(field.type === "integer" ? Math.max(...field.enum.filter((value): value is number => typeof value === "number")) + 1 : "not-an-enum-value");
  return values;
}

describe("partner plan", () => {
  it("accepts the metadata-derived smallest plan", () => {
    expect(parsePartnerPlan(planFor(requiredField, requiredField.validValue))).toEqual(planFor(requiredField, requiredField.validValue));
  });

  it("accepts an empty nested object", () => {
    expect(parsePartnerPlan({ ...planFor(requiredField, requiredField.validValue), address_attributes: {} })).toEqual({ ...planFor(requiredField, requiredField.validValue), address_attributes: {} });
  });

  it.each([{}, { address_attributes: {} }, { partner_doc_setting_attributes: {} }])("rejects an update plan with no leaf values: %j", (plan) => {
    expect(() => parsePartnerUpdatePlan(plan)).toThrow(PartnerPlanError);
  });

  it("rejects a plan that omits the required name", () => {
    expect(() => parsePartnerPlan({})).toThrow(PartnerPlanError);
  });

  it.each(PARTNER_PLAN_FIELDS.filter((field) => field.required))("rejects an omitted required field: %s", (field) => {
    const plan: Record<string, unknown> = {};
    for (const required of PARTNER_PLAN_FIELDS.filter((candidate) => candidate.required)) setPath(plan, required.path, required.validValue);
    deletePath(plan, field.path);
    expect(() => parsePartnerPlan(plan)).toThrow(PartnerPlanError);
  });

  it.each([[], null, "x", 1, true])("rejects non-object top-level plans: %j", (raw) => {
    expect(() => parsePartnerPlan(raw)).toThrow(PartnerPlanError);
  });

  it.each([
    ["company_id", 1],
    ["payer_walletable_id", 1],
    ["transfer_fee_handling_side", "payer"],
    ["partner_bank_account_attributes", {}],
    ["unknown", true],
  ])("rejects forbidden top-level key %s", (key, value) => {
    expect(() => parsePartnerPlan({ ...planFor(requiredField, requiredField.validValue), [key]: value })).toThrow(PartnerPlanError);
  });

  it.each(nestedRoots)("rejects unknown nested keys under %s", (root) => {
    expect(() => parsePartnerPlan({ ...planFor(requiredField, requiredField.validValue), [root]: { unknown: 1 } })).toThrow(PartnerPlanError);
  });

  it.each(nestedRoots.flatMap((root) => [null, [], "x", 1, true].map((value) => [root, value] as const)))("rejects a non-object nested value for %s: %j", (root, value) => {
    expect(() => parsePartnerPlan({ ...planFor(requiredField, requiredField.validValue), [root]: value })).toThrow(PartnerPlanError);
  });

  it.each(PARTNER_PLAN_FIELDS)("accepts every metadata-derived valid boundary for %s", (field) => {
    for (const value of acceptedValues(field)) expect(parsePartnerPlan(planFor(field, value))).toEqual(planFor(field, value));
  });

  it.each(PARTNER_PLAN_FIELDS)("rejects every metadata-derived invalid value for %s", (field) => {
    for (const value of rejectedValues(field)) expect(() => parsePartnerPlan(planFor(field, value))).toThrow(PartnerPlanError);
  });
});

describe("partner plan specification conformance", () => {
  // この表は metadata contract の完全な写し。**メタデータから導出しないこと**
  // （導出すると、メタデータを変える変異が検出できなくなる）。
  // metadata key の provenance: ① OpenAPI=type/required/nullable/minLength/minimum/maximum/pattern と
  // maxLength・enum（code.maxLength と default_title.enum を除く）、② CLI=nonBlank と前記の例外、
  // ③ テスト用=validValue/validValues/invalidValues、④ 構造=path。
  const provenance = {
    path: "structure", type: "openapi", validValue: "test", validValues: "test", invalidValues: "test",
    required: "openapi", nullable: "openapi", maxLength: "openapi-or-cli", minLength: "openapi",
    minimum: "openapi", maximum: "openapi", enum: "openapi-or-cli", pattern: "openapi", nonBlank: "cli",
  } as const;
  const oracle = [
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
    { path: ["payment_term_attributes", "cutoff_day"], type: "integer", validValue: 1, minimum: 1, maximum: 32 },
    { path: ["payment_term_attributes", "additional_months"], type: "integer", validValue: 0, minimum: 0, maximum: 6 },
    { path: ["payment_term_attributes", "fixed_day"], type: "integer", validValue: 1, minimum: 1, maximum: 32 },
    { path: ["invoice_payment_term_attributes", "cutoff_day"], type: "integer", validValue: 1, minimum: 1, maximum: 32 },
    { path: ["invoice_payment_term_attributes", "additional_months"], type: "integer", validValue: 0, minimum: 0, maximum: 6 },
    { path: ["invoice_payment_term_attributes", "fixed_day"], type: "integer", validValue: 1, minimum: 1, maximum: 32 },
    { path: ["partner_doc_setting_attributes", "sending_method"], type: "string", validValue: "email", nullable: true, enum: ["email", "posting", "email_and_posting", "pdf_delivery", "pdf_delivery_and_posting"] },
  ];

  it("matches the complete literal metadata contract in both directions", () => {
    const projection = PARTNER_PLAN_FIELDS.map((field) => Object.fromEntries(Object.entries(field)));
    expect(projection).toEqual(oracle);
  });

  it("classifies every metadata key", () => {
    const keys = [...new Set(PARTNER_PLAN_FIELDS.flatMap((field) => Object.keys(field)))].sort();
    expect(keys).toEqual(Object.keys(provenance).sort());
  });
});

describe("partner update plan: partner_bank_account_attributes", () => {
  const account = {
    bank_name: "サンプル銀行", bank_name_kana: "サンプルギンコウ", bank_code: "0001",
    branch_name: "テスト支店", branch_kana: "テストシテン", branch_code: "101",
    account_type: "ordinary", account_number: "1234567",
    long_account_name: "カブシキガイシャサンプル", account_name: "カブシキガイシャサンプル",
  };

  it("accepts all ten official child keys on update", () => {
    expect(parsePartnerUpdatePlan({ partner_bank_account_attributes: account })).toEqual({ partner_bank_account_attributes: account });
  });

  it.each(["ordinary", "checking", "earmarked", "savings", "other"])("accepts account_type %s", (accountType) => {
    expect(parsePartnerUpdatePlan({ partner_bank_account_attributes: { ...account, account_type: accountType } })).toMatchObject({ partner_bank_account_attributes: { account_type: accountType } });
  });

  it("accepts a partial account that includes account_number", () => {
    expect(parsePartnerUpdatePlan({ partner_bank_account_attributes: { account_number: "1010101" } })).toEqual({ partner_bank_account_attributes: { account_number: "1010101" } });
  });

  it.each([
    ["unknown child key", { ...account, swift: "X" }],
    ["account_type earning", { ...account, account_type: "earning" }],
    ["account_type typo", { ...account, account_type: "ordinal" }],
    ["account_type empty", { ...account, account_type: "" }],
    ["account_type null", { ...account, account_type: null }],
    ["bank_code 3 digits", { ...account, bank_code: "001" }],
    ["bank_code 5 digits", { ...account, bank_code: "00011" }],
    ["bank_code letters", { ...account, bank_code: "00A1" }],
    ["bank_code number", { ...account, bank_code: 1 }],
    ["branch_code 2 digits", { ...account, branch_code: "10" }],
    ["branch_code 4 digits", { ...account, branch_code: "1011" }],
    ["branch_code full-width", { ...account, branch_code: "１０１" }],
    ["account_number 6 digits", { ...account, account_number: "123456" }],
    ["account_number 8 digits", { ...account, account_number: "12345678" }],
    ["account_number hyphen", { ...account, account_number: "123-4567" }],
    ["account_number trailing newline", { ...account, account_number: "1234567\n" }],
    ["account_number numeric", { ...account, account_number: 1234567 }],
    ["account_number missing", { bank_code: "0001" }],
    ["empty account object", {}],
    ["null account", null],
    ["array account", []],
    ["string account", "1234567"],
    ["non-string bank_name", { ...account, bank_name: 1 }],
  ])("rejects %s", (_case, value) => {
    expect(() => parsePartnerUpdatePlan({ partner_bank_account_attributes: value })).toThrow(PartnerPlanError);
  });

  it("still rejects partner_bank_account_attributes on create", () => {
    expect(() => parsePartnerPlan({ name: "取引先", partner_bank_account_attributes: account })).toThrow(/partner_bank_account_attributes must not be included/);
  });

  it("still rejects payer_walletable_id and transfer_fee_handling_side on update", () => {
    for (const key of ["payer_walletable_id", "transfer_fee_handling_side"]) expect(() => parsePartnerUpdatePlan({ partner_bank_account_attributes: account, [key]: 1 })).toThrow(PartnerPlanError);
  });
});
