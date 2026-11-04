import { describe, expect, it } from "vitest";
import { withSignedDealAmounts } from "../../src/lib/deal-signed-output.js";

describe("取引出力の符号付き金額", () => {
  it.each([
    ["income", "credit", "debit"],
    ["expense", "debit", "credit"],
  ])("%sの通常行と控除行に符号を付け、元の項目を保持する", (type, normal, deduction) => {
    const deal = {
      id: 6, company_id: 1, type, amount: 880, extra: { name: "架空取引" },
      details: [
        { id: 7, amount: 1100, vat: 100, entry_side: normal, description: "架空通常行" },
        { id: 8, amount: 220, vat: 20, entry_side: deduction, description: "架空控除行" },
      ],
    };
    const before = structuredClone(deal);
    expect(withSignedDealAmounts(deal)).toEqual({
      ...deal,
      details: [
        { ...deal.details[0], signed_amount: 1100, signed_vat: 100 },
        { ...deal.details[1], signed_amount: -220, signed_vat: -20 },
      ],
      signed_totals: { amount: 880, vat: 80 },
    });
    expect(deal).toEqual(before);
  });

  it.each([undefined, "unknown", null])("type=%sでは推測せずnullにする", type => {
    expect(withSignedDealAmounts({ type, details: [{ amount: 1100, vat: 100, entry_side: "credit" }] })).toMatchObject({
      details: [{ signed_amount: null, signed_vat: null }], signed_totals: { amount: null, vat: null },
    });
  });

  it.each([undefined, "unknown", null])("entry_side=%sでは合計もnullにする", entry_side => {
    expect(withSignedDealAmounts({ type: "income", details: [
      { amount: 1100, vat: 100, entry_side: "credit" }, { amount: 220, vat: 20, entry_side },
    ] })).toMatchObject({
      details: [{ signed_amount: 1100, signed_vat: 100 }, { signed_amount: null, signed_vat: null }],
      signed_totals: { amount: null, vat: null },
    });
  });

  it.each([undefined, null, "100", NaN, Infinity, -Infinity])("非数値・非有限値%sは該当する値と合計だけnullにする", invalid => {
    for (const field of ["amount", "vat"] as const) {
      const other = field === "amount" ? "vat" : "amount";
      expect(withSignedDealAmounts({ type: "expense", details: [
        { amount: 1100, vat: 100, entry_side: "debit", [field]: invalid },
      ] })).toMatchObject({
        details: [{ [`signed_${field}`]: null, [`signed_${other}`]: other === "amount" ? 1100 : 100 }],
        signed_totals: { [field]: null, [other]: other === "amount" ? 1100 : 100 },
      });
    }
  });

  it("空の明細は合計0、明細の欠落や不正な形は合計nullで元の値を保持する", () => {
    expect(withSignedDealAmounts({ type: "income", details: [] })).toEqual({ type: "income", details: [], signed_totals: { amount: 0, vat: 0 } });
    for (const deal of [{}, { details: null }, { details: "invalid" }, { details: [null] }]) {
      expect(withSignedDealAmounts(deal)).toEqual({ ...deal, signed_totals: { amount: null, vat: null } });
    }
  });
});
