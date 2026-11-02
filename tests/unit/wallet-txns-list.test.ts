import { expect, it, vi } from "vitest";
import { runWalletTxnsList } from "../../src/commands/wallet-txns/list.js";
import { createReadOnlyClient } from "../../src/lib/clients/read-only-client.js";

it("読み取り専用クライアントで100件ずつ全ページを読み、API要素をそのまま返す", async () => {
  const row = { id: 9, balance: null, description: "架空明細", status: 1 };
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({ wallet_txns: fetchFn.mock.calls.length === 1 ? Array(100).fill(row) : [row] })));
  const client = createReadOnlyClient({ api: "accounting", token: "dummy", fetchFn: fetchFn as typeof fetch });
  const result = await runWalletTxnsList({ companyId: 1 }, { client });
  expect(result.items).toEqual(Array(101).fill(row));
  expect(fetchFn.mock.calls).toHaveLength(2);
});

it.each([
  { companyId: 0 }, { companyId: NaN }, { walletableType: "bank_account" }, { walletableId: 2 },
  { walletableType: "private_account_item", walletableId: 2 }, { walletableType: "wallet", walletableId: 0 },
  { startDate: "2026-02-30" }, { endDate: "2026-13-01" }, { startDate: "2026-02-02", endDate: "2026-02-01" },
  { entrySide: "other" }, { sortType: "date_desc" }, { limit: 0 }, { limit: 101 }, { limit: 1.5 },
  { offset: -1 }, { offset: Infinity }, { offset: 0.5 },
])("不正な入力%jはGETより前に拒否する", async override => {
  const get = vi.fn();
  await expect(runWalletTxnsList({ companyId: 1, ...override } as never, { client: { get, listAll: async function* () {} } })).rejects.toThrow();
  expect(get).not.toHaveBeenCalled();
});

it.each([{ limit: 100 }, { offset: 0 }, { offset: 7 }])("limitかoffset指定時%jは満杯でも1ページだけを返す", async paging => {
  const get = vi.fn(async () => new Response(JSON.stringify({ wallet_txns: Array(100).fill({ id: 9 }) })));
  const result = await runWalletTxnsList({ companyId: 1, ...paging }, { client: { get, listAll: async function* () {} } });
  expect(result.items).toHaveLength(100);
  expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.calls[0]).toEqual(["/api/1/wallet_txns", { query: expect.objectContaining({ company_id: 1, limit: 100, offset: paging.offset ?? 0 }) }]);
});
it.each([{}, { wallet_txns: null }, { wallet_txns: [null] }, { wallet_txns: {} }])("不正な一覧応答%jを拒否する", async body => {
  await expect(runWalletTxnsList({ companyId: 1 }, { client: { get: async () => new Response(JSON.stringify(body)), listAll: async function* () {} } })).rejects.toThrow("invalid response");
});
