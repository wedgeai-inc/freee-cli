import { describe, expect, it } from "vitest";
import { computeInvoiceTotals, parseInvoicePlan } from "../../src/domain/invoice-plan.js";

const basePlan = {
  billing_date: "2026-09-05",
  payment_date: "2026-10-31",
  partner_id: 123,
  partner_title: "御中",
  subject: "2026年8月分 業務委託料",
  tax_entry_method: "out",
  tax_fraction: "omit",
  withholding_tax_entry_method: "out",
  lines: [
    { type: "item", description: "開発支援", quantity: 56.07, unit: "時間", unit_price: "10000", tax_rate: 10 },
  ],
};

describe("parseInvoicePlan", () => {
  it("accepts a valid plan", () => {
    const plan = parseInvoicePlan(basePlan);
    expect(plan.partner_id).toBe(123);
    expect(plan.lines[0]?.type).toBe("item");
  });

  it("defaults line type to item", () => {
    const { type: _t, ...line } = basePlan.lines[0]!;
    const plan = parseInvoicePlan({ ...basePlan, lines: [line] });
    expect(plan.lines[0]?.type).toBe("item");
  });

  it.each([
    "billing_date",
    "partner_title",
    "tax_entry_method",
    "tax_fraction",
    "withholding_tax_entry_method",
    "lines",
  ])("rejects a plan missing %s", (key) => {
    const { [key]: _removed, ...rest } = basePlan as Record<string, unknown>;
    expect(() => parseInvoicePlan(rest)).toThrow(new RegExp(key));
  });

  it("rejects a plan without partner_id and partner_code", () => {
    const { partner_id: _p, ...rest } = basePlan;
    expect(() => parseInvoicePlan(rest)).toThrow(/partner_id/);
  });

  it("rejects a plan with both partner_id and partner_code", () => {
    expect(() => parseInvoicePlan({ ...basePlan, partner_code: "P001" })).toThrow(/partner_id.*partner_code/);
  });

  it("rejects numeric unit_price", () => {
    const line = { ...basePlan.lines[0]!, unit_price: 10000 };
    expect(() => parseInvoicePlan({ ...basePlan, lines: [line] })).toThrow(/unit_price/);
  });

  it("rejects tax_rate outside 0/8/10", () => {
    const line = { ...basePlan.lines[0]!, tax_rate: 5 };
    expect(() => parseInvoicePlan({ ...basePlan, lines: [line] })).toThrow(/tax_rate/);
  });

  it("rejects empty lines", () => {
    expect(() => parseInvoicePlan({ ...basePlan, lines: [] })).toThrow(/lines/);
  });

  it("rejects unknown keys", () => {
    expect(() => parseInvoicePlan({ ...basePlan, foo: 1 })).toThrow(/foo/);
  });

  it("rejects company_id inside the plan", () => {
    expect(() => parseInvoicePlan({ ...basePlan, company_id: 1 })).toThrow(/company_id/);
  });

  it("rejects partner_sending_method", () => {
    expect(() => parseInvoicePlan({ ...basePlan, partner_sending_method: "email" })).toThrow(/partner_sending_method/);
  });

  it("rejects more than ten tag_ids", () => {
    const line = { ...basePlan.lines[0]!, tag_ids: Array.from({ length: 11 }, (_, i) => i + 1) };
    expect(() => parseInvoicePlan({ ...basePlan, lines: [line] })).toThrow(/tag_ids/);
  });

  it("rejects an array plan", () => {
    expect(() => parseInvoicePlan([basePlan])).toThrow(/object/);
  });

  it("accepts text lines with description only", () => {
    const plan = parseInvoicePlan({ ...basePlan, lines: [...basePlan.lines, { type: "text", description: "備考" }] });
    expect(plan.lines).toHaveLength(2);
  });
});

describe("parseInvoicePlan non-empty and decimals", () => {
  it("enforces schema string limits and branch_no maximum", () => {
    expect(() => parseInvoicePlan({ ...basePlan, subject: "" })).toThrow(/subject/);
    expect(() => parseInvoicePlan({ ...basePlan, memo: "" })).toThrow(/memo/);
    expect(() => parseInvoicePlan({ ...basePlan, partner_contact_email_to: "" })).toThrow(/partner_contact_email_to/);
    expect(() => parseInvoicePlan({ ...basePlan, subject: "x".repeat(256) })).toThrow(/subject/);
    expect(() => parseInvoicePlan({ ...basePlan, lines: [{ ...basePlan.lines[0]!, description: "x".repeat(256) }] })).toThrow(/description/);
    expect(() => parseInvoicePlan({ ...basePlan, lines: [{ ...basePlan.lines[0]!, unit: "x".repeat(256) }] })).toThrow(/unit/);
    expect(() => parseInvoicePlan({ ...basePlan, branch_no: 2147483648 })).toThrow(/branch_no/);
  });
  it("rejects empty partner_code and empty description", () => {
    const { partner_id: _p, ...rest } = basePlan;
    expect(() => parseInvoicePlan({ ...rest, partner_code: "" })).toThrow(/partner_code must not be empty/);
    const line = { ...basePlan.lines[0]!, description: "" };
    expect(() => parseInvoicePlan({ ...basePlan, lines: [line] })).toThrow(/description must not be empty/);
    expect(() => parseInvoicePlan({ ...basePlan, lines: [{ type: "text", description: "" }] })).toThrow(/description must not be empty/);
  });

  it("rejects quantity above the API maximum and accepts the maximum", () => {
    const over = { ...basePlan.lines[0]!, quantity: 100_000_000 };
    expect(() => parseInvoicePlan({ ...basePlan, lines: [over] })).toThrow(/API maximum/);
    const max = { ...basePlan.lines[0]!, quantity: 99_999_999.999 };
    expect(parseInvoicePlan({ ...basePlan, lines: [max] }).lines[0]?.quantity).toBe(99_999_999.999);
  });

  it("accepts three-decimal quantities such as 1.001 and rejects four", () => {
    const ok = { ...basePlan.lines[0]!, quantity: 1.001 };
    expect(parseInvoicePlan({ ...basePlan, lines: [ok] }).lines[0]?.quantity).toBe(1.001);
    for (const q of [1.0001, 4e-10, 1.0000000004]) {
      const ng = { ...basePlan.lines[0]!, quantity: q };
      expect(() => parseInvoicePlan({ ...basePlan, lines: [ng] })).toThrow(/3 decimals/);
    }
  });
});

describe("computeInvoiceTotals", () => {
  it.each([
    ["omit", -10],
    ["round_up", -11],
    ["round", -11],
  ])("handles negative line amounts with %s toward the expected direction", (fraction, expected) => {
    const plan = parseInvoicePlan({
      ...basePlan,
      tax_entry_method: "out",
      tax_fraction: "omit",
      line_amount_fraction: fraction,
      lines: [{ description: "値引", quantity: 1, unit_price: "-10.5", tax_rate: 0 }],
    });
    expect(computeInvoiceTotals(plan).subtotal).toBe(expected);
  });

  it("computes out/omit totals", () => {
    const plan = parseInvoicePlan(basePlan);
    expect(computeInvoiceTotals(plan)).toEqual({ subtotal: 560_700, tax: 56_070, total: 616_770 });
  });

  it("computes in/round totals", () => {
    const plan = parseInvoicePlan({
      ...basePlan,
      tax_entry_method: "in",
      tax_fraction: "round",
      lines: [{ description: "x", quantity: 1, unit_price: "11000", tax_rate: 10 }],
    });
    expect(computeInvoiceTotals(plan)).toEqual({ subtotal: 10_000, tax: 1_000, total: 11_000 });
  });

  it.each([
    ["out", "round_up", { subtotal: 2, tax: 2, total: 4 }],
    ["in", "round_up", { subtotal: 0, tax: 2, total: 2 }],
  ])("rounds tax per category so standard 8%% and reduced 8%% are not merged (%s/%s)", (method, fraction, expected) => {
    const plan = parseInvoicePlan({
      ...basePlan,
      tax_entry_method: method,
      tax_fraction: fraction,
      lines: [
        { description: "標準 8%", quantity: 1, unit_price: "1", tax_rate: 8 },
        { description: "軽減 8%", quantity: 1, unit_price: "1", tax_rate: 8, reduced_tax_rate: true },
      ],
    });
    // 同一バケットに集約すると 2 円 × 8% = 0.16 → round_up で税 1 円になる。区分別なら 1 円ずつで税 2 円
    expect(computeInvoiceTotals(plan)).toEqual(expected);
  });

  it("still merges lines of the same category", () => {
    const plan = parseInvoicePlan({
      ...basePlan,
      tax_entry_method: "out",
      tax_fraction: "round_up",
      lines: [
        { description: "a", quantity: 1, unit_price: "1", tax_rate: 8, reduced_tax_rate: true },
        { description: "b", quantity: 1, unit_price: "1", tax_rate: 8, reduced_tax_rate: true },
      ],
    });
    expect(computeInvoiceTotals(plan)).toEqual({ subtotal: 2, tax: 1, total: 3 });
  });

  it("computes exactly at the schema maximums without floating-point drift", () => {
    const plan = parseInvoicePlan({
      ...basePlan,
      tax_entry_method: "out",
      tax_fraction: "omit",
      lines: [{ description: "max", quantity: 99999999.999, unit_price: "9999999999999.999", tax_rate: 0 }],
    });
    // 99999999.999 × 9999999999999.999 = 999999999989999900000.000001 → 切り捨てで 999999999989999900000。Number では表現できないので拒否する
    expect(() => computeInvoiceTotals(plan)).toThrow(/MAX_SAFE_INTEGER/);
  });

  it("computes decimal products exactly where floating point would drift", () => {
    const plan = parseInvoicePlan({
      ...basePlan,
      tax_entry_method: "out",
      tax_fraction: "omit",
      lines: [{ description: "d", quantity: 0.1, unit_price: "0.2", tax_rate: 10 }, { description: "e", quantity: 3, unit_price: "0.333", tax_rate: 10 }],
    });
    // 0.02 → 0、0.999 → 0（omit）
    expect(computeInvoiceTotals(plan)).toEqual({ subtotal: 0, tax: 0, total: 0 });
    const plan2 = parseInvoicePlan({ ...basePlan, line_amount_fraction: "round", lines: [{ description: "f", quantity: 1.005, unit_price: "100", tax_rate: 10 }] });
    // 100.5 → 101（四捨五入。浮動小数だと 100.49999 になりうる）
    expect(computeInvoiceTotals(plan2).subtotal).toBe(101);
  });

  it("ignores text lines", () => {
    const plan = parseInvoicePlan({ ...basePlan, lines: [...basePlan.lines, { type: "text", description: "備考" }] });
    expect(computeInvoiceTotals(plan).total).toBe(616_770);
  });
});
