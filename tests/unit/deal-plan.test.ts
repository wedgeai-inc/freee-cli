import { expect, it } from "vitest";
import { buildDealPlan } from "../../src/domain/deal-plan.js";

export const input = { companyId: 1, type: "expense", issueDate: "2026-01-15", partnerId: 2, details: ["account_item_id=3,tax_code=4,amount=1200,description=架空明細", "account_item_id=3,tax_code=4,amount=300"], receiptIds: [5], refNumber: "sample-001" };
it("複数明細の税込合計と未決済JSONを作る", () => {
  expect(buildDealPlan(input)).toEqual({ total: 1500, payload: { company_id: 1, type: "expense", issue_date: "2026-01-15", partner_id: 2, details: [{ account_item_id: 3, tax_code: 4, amount: 1200, description: "架空明細" }, { account_item_id: 3, tax_code: 4, amount: 300 }], receipt_ids: [5], ref_number: "sample-001" } });
});

it("不正な日付・ID・明細・安全整数外の金額を拒否する", () => {
  const patches = [
    { companyId: 0 }, { partnerId: NaN }, { type: "other" }, { issueDate: "2026-02-30" }, { dueDate: "bad" }, { dueDate: "2026-01-01" }, { receiptIds: [0] }, { details: [] },
    ...["", "account_item_id=3,tax_code=4", "account_item_id=3,tax_code=4,amount=", "account_item_id=3,tax_code=4,amount=NaN", "account_item_id=3,tax_code=4,amount=1.5", "account_item_id=3,tax_code=4,amount=1e3", "account_item_id=3,tax_code=4,amount=2,amount=3", "account_item_id=3,tax_code=4,amount=2,payments=yes", "account_item_id=3,tax_code=4,amount=2,garbage", "account_item_id=3,tax_code=-1,amount=2", "account_item_id=0,tax_code=4,amount=2", "account_item_id=3,tax_code=4,amount=9007199254740992"].map(detail => ({ details: [detail] })),
    { details: ["account_item_id=3,tax_code=4,amount=9007199254740991", "account_item_id=3,tax_code=4,amount=1"] },
  ];
  for (const patch of patches) expect(() => buildDealPlan({ ...input, ...patch })).toThrow();
  expect(buildDealPlan({ ...input, details: ["account_item_id=3,tax_code=0,amount=0,description=a=b"] }).total).toBe(0);
});

it("dealCreateParamsの負の税込明細を保持し、tax_codeと明細数の上限を守る", () => {
  const details = ["account_item_id=3,tax_code=2147483647,amount=1200", "account_item_id=3,tax_code=0,amount=-300"];
  expect(buildDealPlan({ ...input, details })).toMatchObject({ total: 900, payload: { details: [{ amount: 1200 }, { amount: -300 }] } });
  expect(buildDealPlan({ ...input, details: [details[1]!] }).total).toBe(-300);
  expect(buildDealPlan({ ...input, details: Array(100).fill(details[0]) }).payload.details).toHaveLength(100);
  expect(() => buildDealPlan({ ...input, details: ["account_item_id=3,tax_code=2147483648,amount=1"] })).toThrow("tax_code");
  expect(() => buildDealPlan({ ...input, details: Array(101).fill(details[0]) })).toThrow("100");
});
