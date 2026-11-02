import { expect, it, vi } from "vitest";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { runDealsAttachReceipt } from "../../src/commands/deals/attach-receipt.js";

const options = { companyId: 1, id: 6, receiptIds: [8, 5], logDir: "unused", taskId: "sample" };
const deal = { id: 6, company_id: 1, type: "expense", issue_date: "2026-01-15", due_date: "2026-02-15", partner_id: 2, amount: 1500, ref_number: "sample", details: [{ id: 9, account_item_id: 3, tax_code: 4, amount: 1500, description: "架空明細", item_id: 10, section_id: 11, tag_ids: [12], segment_1_tag_id: 13, segment_2_tag_id: 14, segment_3_tag_id: 15, partner_id: 2, tax_calc_type: "inclusive", account_item_code: "account-code", partner_code: "partner-code", item_code: "item-code", section_code: "section-code", segment_1_tag_code: "segment-code", unexpected: true, entry_side: "debit", vat: 136 }], receipts: [{ id: 5 }] };
function setup() {
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ deal: init?.method === "PUT" ? { id: 6 } : deal })));
  const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn: fetchFn as typeof fetch });
  return { fetchFn, deps: { getClient: async () => client, appendAudit: vi.fn().mockResolvedValue(undefined), now: () => new Date("2026-01-15T00:00:00Z") } };
}
it("dry-runは既存明細の書き込み項目と証憑を保ち、新しい証憑を重複なく足す", async () => {
  const { deps, fetchFn } = setup();
  const result = await runDealsAttachReceipt(options, deps);
  expect(result).toMatchObject({ mode: "dry-run", total: 1500, payload: { company_id: 1, type: "expense", issue_date: deal.issue_date, due_date: deal.due_date, partner_id: 2, ref_number: "sample", receipt_ids: [5, 8], details: [{ id: 9, account_item_id: 3, tax_code: 4, amount: 1500, description: "架空明細", item_id: 10, section_id: 11, tag_ids: [12], segment_1_tag_id: 13, segment_2_tag_id: 14, segment_3_tag_id: 15, partner_id: 2, vat: 136 }] } });
  expect(result.payload.details[0]).not.toHaveProperty("entry_side");
  expect(Object.keys(result.payload.details[0]!).sort()).toEqual(["id", "account_item_id", "tax_code", "amount", "description", "item_id", "section_id", "partner_id", "tag_ids", "segment_1_tag_id", "segment_2_tag_id", "segment_3_tag_id", "vat"].sort());
  expect(fetchFn).toHaveBeenCalledTimes(1);
});
it("executeは既存取引の合計とexpect-totalが一致したときだけPUTする", async () => {
  for (const expectTotal of [undefined, 1499, NaN]) {
    const { deps, fetchFn } = setup();
    await expect(runDealsAttachReceipt({ ...options, execute: true, expectTotal }, deps)).rejects.toThrow("--expect-total");
    expect(fetchFn.mock.calls.some(c => c[1]?.method === "PUT")).toBe(false);
  }
  const { deps, fetchFn } = setup();
  const result = await runDealsAttachReceipt({ ...options, execute: true, expectTotal: 1500 }, deps);
  expect(result).toMatchObject({ mode: "execute", updated: { id: 6 } });
  expect(fetchFn.mock.calls.filter(c => c[1]?.method === "PUT")).toHaveLength(1);
  expect(JSON.parse(fetchFn.mock.calls[1]![1]!.body as string)).toEqual(result.payload);
});
it("取得内容や入力が不正ならPUTせず、receipt_ids形式の既存証憑も保持する", async () => {
  for (const patch of [{ id: 0 }, { companyId: 0 }, { receiptIds: [] }, { receiptIds: [0] }]) {
    const { deps, fetchFn } = setup();
    await expect(runDealsAttachReceipt({ ...options, ...patch, execute: true, expectTotal: 1500 }, deps)).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  }
  for (const patch of [{ details: [] }, { details: [null] }, { details: [{ account_item_id: 3, tax_code: 4, amount: 1500 }] }, { amount: NaN }, { receipts: [{ id: 0 }] }, { receipts: undefined }, { type: "invalid" }]) {
    const { deps, fetchFn } = setup();
    fetchFn.mockImplementation(async () => new Response(JSON.stringify({ deal: { ...deal, ...patch } })));
    await expect(runDealsAttachReceipt({ ...options, execute: true, expectTotal: 1500 }, deps)).rejects.toThrow();
    expect(fetchFn.mock.calls.some(c => c[1]?.method === "PUT")).toBe(false);
  }
  const { deps, fetchFn } = setup();
  fetchFn.mockImplementation(async () => new Response(JSON.stringify({ deal: { ...deal, receipts: undefined, receipt_ids: [5] } })));
  expect((await runDealsAttachReceipt(options, deps)).payload.receipt_ids).toEqual([5, 8]);
});

it("GETのnullをPUTのnullable指定に合わせ、取引先IDとコードを同時送信しない", async () => {
  for (const [partner, expected] of [
    [{ partner_id: 2, partner_code: "sample-code" }, { partner_id: 2 }],
    [{ partner_id: null, partner_code: "sample-code" }, { partner_code: "sample-code" }],
    [{ partner_id: null, partner_code: null }, {}],
  ]) {
    const { deps, fetchFn } = setup();
    const existing = { ...deal, ...partner, due_date: null, ref_number: null, details: [{ ...deal.details[0], partner_id: null, item_id: null, section_id: null, description: null, segment_1_tag_id: null, segment_2_tag_id: null, segment_3_tag_id: null }] };
    fetchFn.mockImplementation(async (_url, init) => new Response(JSON.stringify({ deal: init?.method === "PUT" ? { id: 6 } : existing })));
    const result = await runDealsAttachReceipt({ ...options, execute: true, expectTotal: 1500 }, deps);
    const payload = JSON.parse(fetchFn.mock.calls[1]![1]!.body as string);
    expect(payload).toEqual({ company_id: 1, type: "expense", issue_date: deal.issue_date, ...expected, details: [{ id: 9, account_item_id: 3, tax_code: 4, amount: 1500, partner_id: null, tag_ids: [12], vat: 136 }], receipt_ids: [5, 8] });
    expect(result.payload).toEqual(payload);
  }
});

it("PUTの税コード上限と100明細の制限を守り、負の明細・合計も保持する", async () => {
  const { deps, fetchFn } = setup();
  const details = [{ id: 9, account_item_id: 3, tax_code: 0, amount: -300, partner_id: 0, vat: 0 }];
  for (const patch of [{ details: [{ ...details[0], tax_code: -1 }] }, { details: [{ ...details[0], tax_code: 2147483648 }] }, { details: Array.from({ length: 101 }, (_, i) => ({ ...details[0], id: i + 1 })) }]) {
    fetchFn.mockImplementation(async () => new Response(JSON.stringify({ deal: { ...deal, ...patch } })));
    await expect(runDealsAttachReceipt({ ...options, execute: true, expectTotal: 1500 }, deps)).rejects.toThrow();
    expect(fetchFn.mock.calls.some(c => c[1]?.method === "PUT")).toBe(false);
  }
  fetchFn.mockImplementation(async (_url, init) => new Response(JSON.stringify({ deal: init?.method === "PUT" ? { id: 6 } : { ...deal, amount: -300, details } })));
  expect((await runDealsAttachReceipt({ ...options, execute: true, expectTotal: -300 }, deps)).payload.details).toEqual(details);
});
