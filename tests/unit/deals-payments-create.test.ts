import { expect, it, vi } from "vitest";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { runDealsPaymentsCreate } from "../../src/commands/deals/payments/create.js";

const options = { companyId: 1, dealId: 6, date: "2026-01-15", fromWalletableType: "bank_account" as const, fromWalletableId: 2, amount: 123, taskId: "sample", logDir: "unused" };
function setup(deal: Record<string, unknown> = {}, walletables: unknown = [{ id: 2, type: "bank_account", name: "架空口座" }]) {
  let due = 123;
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (init?.method === "POST") due = 0;
    const body = path.endsWith("walletables") ? { walletables } : { deal: { id: 6, company_id: 1, due_amount: due, ...deal } };
    return new Response(JSON.stringify(body));
  });
  const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "dummy", fetchFn: fetchFn as typeof fetch });
  const deps = { getClient: vi.fn(async () => client), appendAudit: vi.fn().mockResolvedValue(undefined), now: () => new Date("2026-01-15T00:00:00Z") };
  return { deps, fetchFn, writes: () => fetchFn.mock.calls.filter(c => c[1]?.method === "POST") };
}
it("既定はdry-runで取引と口座だけを読み、支払内容とガードの判定を表示する", async () => {
  const { deps, fetchFn, writes } = setup();
  const result = await runDealsPaymentsCreate(options, deps);
  expect(result).toMatchObject({ mode: "dry-run", payload: { company_id: 1, date: options.date, from_walletable_type: "bank_account", from_walletable_id: 2, amount: 123 }, names: { walletable: "架空口座" } });
  expect(Object.values(result.guards).every(Boolean)).toBe(true);
  expect(fetchFn.mock.calls.map(c => new URL(c[0]).pathname)).toEqual(["/api/1/deals/6", "/api/1/walletables"]);
  expect(writes()).toHaveLength(0);
  expect(deps.appendAudit).toHaveBeenCalledWith(expect.objectContaining({ event: "deal_payment_create", target_id: 6, mode: "dry-run", status: "planned" }));
});

it.each([
  { dealId: 0 }, { companyId: 0 }, { date: "2026-02-30" }, { fromWalletableId: 0 },
  { fromWalletableType: "other" }, { amount: 0 }, { amount: -1 }, { amount: 1.5 },
  { amount: NaN }, { amount: Infinity }, { amount: Number.MAX_SAFE_INTEGER + 1 },
  { expectAmount: 0 }, { expectAmount: 1.5 }, { expectAmount: NaN }, { execute: true },
])("入力%jは認証読み込みより前に拒否する", async override => {
  const { deps } = setup();
  await expect(runDealsPaymentsCreate({ ...options, ...override } as never, deps)).rejects.toThrow();
  expect(deps.getClient).not.toHaveBeenCalled();
});

it.each([
  ["expectedAmountMatches", { expectAmount: 124 }, {}, undefined],
  ["companyMatches", {}, { company_id: 9 }, undefined],
  ["hasOutstandingAmount", {}, { due_amount: 0 }, undefined],
  ["hasOutstandingAmount", {}, { due_amount: -1 }, undefined],
  ["amountMatchesDue", {}, { due_amount: 124 }, undefined],
  ["amountMatchesDue", {}, { due_amount: "123" }, undefined],
  ["hasOutstandingAmount", {}, { due_amount: undefined }, undefined],
  ["walletableExists", {}, {}, []],
  ["walletableExists", {}, {}, [{ id: 2, type: "wallet", name: "架空口座" }]],
] as const)("ガード%sの不成立をdry-runでは表示しexecuteでは送信しない", async (guard, override, deal, wallets) => {
  const dry = setup(deal, wallets);
  const opts = { ...options, expectAmount: 123, ...override };
  const result = await runDealsPaymentsCreate(opts, dry.deps);
  expect(result.guards).toHaveProperty(guard, false);
  expect(dry.writes()).toHaveLength(0);
  const live = setup(deal, wallets);
  await expect(runDealsPaymentsCreate({ ...opts, execute: true }, live.deps)).rejects.toThrow("guard");
  expect(live.writes()).toHaveLength(0);
});

it("executeは監査を先に保存して1回POSTし、再実行では支払済みのため送信しない", async () => {
  const { deps, writes } = setup();
  deps.appendAudit.mockImplementation(async entry => {
    if (entry.status === "attempting") expect(writes()).toHaveLength(0);
  });
  const opts = { ...options, execute: true, expectAmount: 123 };
  const result = await runDealsPaymentsCreate(opts, deps);
  expect(result).toMatchObject({ mode: "execute", created: { id: 6 } });
  expect(writes()).toHaveLength(1);
  expect(new URL(writes()[0]![0]).pathname).toBe("/api/1/deals/6/payments");
  expect(JSON.parse(writes()[0]![1]!.body as string)).toEqual(result.payload);
  expect(deps.appendAudit.mock.calls.map(c => c[0])).toEqual([
    expect.objectContaining({ status: "attempting", write_state: "not_attempted", target_id: 6 }),
    expect.objectContaining({ status: "succeeded", write_state: "succeeded", target_id: 6, created_id: 6 }),
  ]);
  await expect(runDealsPaymentsCreate(opts, deps)).rejects.toThrow("hasOutstandingAmount");
  expect(writes()).toHaveLength(1);
});

it("送信前の監査保存が失敗したらPOSTしない", async () => {
  const { deps, writes } = setup();
  deps.appendAudit.mockRejectedValue(new Error("fictional storage error"));
  await expect(runDealsPaymentsCreate({ ...options, execute: true, expectAmount: 123 }, deps)).rejects.toThrow("not_attempted");
  expect(writes()).toHaveLength(0);
});
it("private_account_itemでは口座一覧を読まず支払を送信する", async () => {
  const { deps, fetchFn, writes } = setup();
  await runDealsPaymentsCreate({ ...options, fromWalletableType: "private_account_item", execute: true, expectAmount: 123 }, deps);
  expect(fetchFn.mock.calls.some(c => c[0].includes("walletables"))).toBe(false);
  expect(writes()).toHaveLength(1);
});
it.each([400, 500, "network", "invalid", "wrong-id", "wrong-company", "audit"] as const)("送信後の失敗%sは監査へ状態を保存する", async failure => {
  const { deps, fetchFn } = setup();
  const original = fetchFn.getMockImplementation()!;
  fetchFn.mockImplementation(async (url, init) => {
    if (init?.method !== "POST") return original(url, init);
    if (typeof failure === "number") return new Response("{}", { status: failure });
    if (failure === "network") throw new Error("fictional disconnect");
    if (failure === "invalid") return new Response("{}");
    return new Response(JSON.stringify({ deal: { id: failure === "wrong-id" ? 7 : 6, company_id: failure === "wrong-company" ? 9 : 1 } }));
  });
  if (failure === "audit") deps.appendAudit.mockImplementation(async entry => { if (entry.status === "succeeded") throw new Error("fictional audit failure"); });
  await expect(runDealsPaymentsCreate({ ...options, execute: true, expectAmount: 123 }, deps)).rejects.toThrow("accounting write");
  expect(deps.appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({
    event: "deal_payment_create", target_id: 6, status: "failed",
    write_state: failure === 400 ? "rejected" : failure === 500 || failure === "network" ? "unknown" : "succeeded",
  }));
});
it.each([{ id: 7 }, null, [], "invalid"])("対象の同一性が不明な応答%jでは送信しない", async deal => {
  const { deps, fetchFn, writes } = setup();
  fetchFn.mockResolvedValue(new Response(JSON.stringify({ deal })));
  await expect(runDealsPaymentsCreate({ ...options, execute: true, expectAmount: 123 }, deps)).rejects.toThrow("invalid response");
  expect(writes()).toHaveLength(0);
});
