import { describe, expect, it } from "vitest";
import { computeInvoiceTotals } from "../../src/domain/invoice-plan.js";
import { parseQuotationPlan } from "../../src/domain/quotation-plan.js";

const basePlan = {
  quotation_date: "2026-09-08",
  partner_id: 123,
  partner_title: "御中",
  tax_entry_method: "out",
  tax_fraction: "omit",
  withholding_tax_entry_method: "out",
  lines: [{ description: "開発支援", quantity: 1, unit_price: "10000", tax_rate: 10 }],
};

describe("parseQuotationPlan", () => {
  it("accepts the quotation-specific plan and shares invoice totals", () => {
    const plan = parseQuotationPlan({ ...basePlan, expiration_date: "2026-10-08", delivery_deadline: "翌月末", quotation_note: "備考" });
    expect(plan.quotation_date).toBe("2026-09-08");
    expect(computeInvoiceTotals(plan)).toEqual({ subtotal: 10000, tax: 1000, total: 11000 });
  });

  it.each([
    ["quotation_date", undefined, /quotation_date/],
    ["billing_date", "2026-09-08", /billing_date is not allowed/],
    ["company_id", 1, /company_id must not be included/],
    ["partner_sending_method", "email", /partner_sending_method must not be included/],
  ])("rejects %s", (key, value, message) => {
    const raw: Record<string, unknown> = { ...basePlan };
    if (value === undefined) delete raw[key];
    else raw[key] = value;
    expect(() => parseQuotationPlan(raw)).toThrow(message);
  });

  it.each(["sales_date", "tag_ids", "item_id", "account_item_id", "section_id", "tax_code"])("rejects quotation-unsupported line key %s", (key) => {
    expect(() => parseQuotationPlan({ ...basePlan, lines: [{ ...basePlan.lines[0], [key]: key === "tag_ids" ? [1] : key === "sales_date" ? "2026-09-08" : "x" }] })).toThrow(new RegExp(key));
  });

  it("limits quotation-only strings", () => {
    expect(() => parseQuotationPlan({ ...basePlan, delivery_deadline: "x".repeat(256) })).toThrow(/delivery_deadline/);
    expect(() => parseQuotationPlan({ ...basePlan, quotation_note: "x".repeat(4001) })).toThrow(/quotation_note/);
    expect(() => parseQuotationPlan({ ...basePlan, delivery_deadline: "" })).toThrow(/delivery_deadline/);
    expect(() => parseQuotationPlan({ ...basePlan, delivery_location: "" })).toThrow(/delivery_location/);
    expect(() => parseQuotationPlan({ ...basePlan, subject: "" })).toThrow(/subject/);
    expect(() => parseQuotationPlan({ ...basePlan, branch_no: 2147483648 })).toThrow(/branch_no/);
  });
});
