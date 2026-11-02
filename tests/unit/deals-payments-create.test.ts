import { expect, it, vi } from "vitest";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { runDealsPaymentsCreate } from "../../src/commands/deals/payments/create.js";

const options = { companyId: 1, dealId: 6, date: "2026-01-15", fromWalletableType: "bank_account" as const, fromWalletableId: 2, amount: 123, taskId: "sample", logDir: "unused" };
function setup(deal: Record<string, unknown> = {}, walletables: unknown = [{ id: 2, type: "bank_account", name: "架空口座" }], accountItems: unknown = [{ id: 2, name: "架空科目" }]) {
  let due = 123;
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (init?.method === "POST") due = 0;
    const body = path.endsWith("account_items") ? { account_items: accountItems } : path.endsWith("walletables") ? { walletables } : { deal: { id: 6, company_id: 1, type: "expense", issue_date: "2026-01-15", amount: 123, partner_id: null, due_amount: due, ...deal } };
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
  const failed = Object.entries(result.guards).filter(([, ok]) => !ok).map(([name]) => name);
  expect(live.deps.appendAudit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    status: "failed", mode: "execute", write_state: "not_attempted", reason: `guard_failed:${failed.join(",")}`, payload_redacted: result.payload,
  }));
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

it.each([
  ["2026-01-14", "2026-01-15T00:00:00Z", false, true],
  ["2026-01-15", "2026-01-15T00:00:00Z", true, true],
  ["2026-01-16", "2026-01-15T14:59:59Z", true, false],
  ["2026-01-16", "2026-01-15T15:00:00Z", true, true],
  ["2026-01-17", "2026-01-15T15:00:00Z", true, false],
])("支払日%sはJST境界%sで発生日・未来日ガードを判定する", async (date, now, before, future) => {
  const { deps, writes } = setup();
  deps.now = () => new Date(now);
  const result = await runDealsPaymentsCreate({ ...options, date }, deps);
  expect(result.guards).toMatchObject({ dateNotBeforeIssueDate: before, dateNotFuture: future });
  expect(writes()).toHaveLength(0);
  if (before && future) {
    await runDealsPaymentsCreate({ ...options, date, execute: true, expectAmount: 123 }, deps);
    expect(writes()).toHaveLength(1);
  }
});

it.each([undefined, null, "", "2026-02-30", "2026-1-15", 20260115, {}, "2026-13-01"])("不正な発生日%jはdeal応答エラーとして拒否する", async issue_date => {
  const { deps, writes } = setup({ issue_date });
  await expect(runDealsPaymentsCreate(options, deps)).rejects.toThrow("invalid response: deal");
  expect(writes()).toHaveLength(0);
  expect(deps.appendAudit).not.toHaveBeenCalled();
});

it.each([true, false])("private_account_itemの実在%sを勘定科目一覧で照合する", async exists => {
  const { deps, fetchFn, writes } = setup({}, undefined, exists ? [{ id: 2, name: "架空科目" }] : [{ id: 3, name: "別の架空科目" }]);
  const opts = { ...options, fromWalletableType: "private_account_item" as const };
  const result = await runDealsPaymentsCreate(opts, deps);
  expect(result.guards.walletableExists).toBe(exists);
  expect(fetchFn.mock.calls.map(c => new URL(c[0]).pathname)).toEqual(["/api/1/deals/6", "/api/1/account_items"]);
  expect(new URL(fetchFn.mock.calls[1]![0]).searchParams.get("company_id")).toBe("1");
  if (exists) {
    await runDealsPaymentsCreate({ ...opts, execute: true, expectAmount: 123 }, deps);
    expect(writes()).toHaveLength(1);
  } else {
    await expect(runDealsPaymentsCreate({ ...opts, execute: true, expectAmount: 123 }, deps)).rejects.toThrow("walletableExists");
    expect(writes()).toHaveLength(0);
  }
});

it.each([null, 3])("取引先ID%jに対応する取引情報をdry-runとexecuteで返す", async partner_id => {
  for (const execute of [false, true]) {
    const { deps, fetchFn } = setup({ partner_id });
    const original = fetchFn.getMockImplementation()!;
    fetchFn.mockImplementation(async (url, init) => new URL(url).pathname === "/api/1/partners/3"
      ? new Response(JSON.stringify({ partner: { id: 3, company_id: 1, name: "架空取引先" } })) : original(url, init));
    const result = await runDealsPaymentsCreate({ ...options, execute, expectAmount: 123 }, deps);
    expect(result).toHaveProperty("deal", { id: 6, type: "expense", issue_date: "2026-01-15", amount: 123, due_amount: 123, partner_id, partner_name: partner_id === null ? null : "架空取引先" });
    const requests = fetchFn.mock.calls.filter(c => new URL(c[0]).pathname.startsWith("/api/1/partners"));
    expect(requests).toHaveLength(partner_id === null ? 0 : 1);
    if (partner_id !== null) expect(new URL(requests[0]![0]).searchParams.get("company_id")).toBe("1");
  }
});

it.each(["2026-01-14", "2026-01-16"])("executeの日付拒否%sを未送信の監査1件に残す", async date => {
  const { deps, writes } = setup();
  const guard = date === "2026-01-14" ? "dateNotBeforeIssueDate" : "dateNotFuture";
  await expect(runDealsPaymentsCreate({ ...options, date, execute: true, expectAmount: 123 }, deps)).rejects.toThrow(guard);
  expect(writes()).toHaveLength(0);
  expect(deps.appendAudit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    status: "failed", mode: "execute", write_state: "not_attempted", reason: `guard_failed:${guard}`,
    payload_redacted: { company_id: 1, date, from_walletable_type: "bank_account", from_walletable_id: 2, amount: 123 },
  }));
});

it("複数のガード拒否で監査が失敗してもガード名と監査失敗を伝えPOSTしない", async () => {
  const { deps, writes } = setup();
  deps.appendAudit.mockRejectedValue(new Error("fictional storage failure"));
  const error = await runDealsPaymentsCreate({ ...options, date: "2026-01-14", execute: true, expectAmount: 124 }, deps).catch(e => e);
  expect(error.message).toContain("payment guard failed: dateNotBeforeIssueDate, expectedAmountMatches");
  expect(error.message).toContain("audit");
  expect(deps.appendAudit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "guard_failed:dateNotBeforeIssueDate,expectedAmountMatches", write_state: "not_attempted" }));
  expect(writes()).toHaveLength(0);
});

it.each(["http", "network", "invalid", "wrong-id", "wrong-company"])("取引先取得失敗%sを伝え支払を送信しない", async failure => {
  const { deps, fetchFn, writes } = setup({ partner_id: 3 });
  const original = fetchFn.getMockImplementation()!;
  fetchFn.mockImplementation(async (url, init) => {
    if (new URL(url).pathname !== "/api/1/partners/3") return original(url, init);
    if (failure === "network") throw new Error("fictional partner disconnect");
    if (failure === "http") return new Response("{}", { status: 400 });
    if (failure === "invalid") return new Response("{}");
    return new Response(JSON.stringify({ partner: { id: failure === "wrong-id" ? 4 : 3, company_id: failure === "wrong-company" ? 9 : 1, name: "架空取引先" } }));
  });
  await expect(runDealsPaymentsCreate({ ...options, execute: true, expectAmount: 123 }, deps)).rejects.toThrow(failure === "network" ? "fictional partner disconnect" : failure === "http" ? "400" : "invalid response: /api/1/partners/3");
  expect(writes()).toHaveLength(0);
});

it.each([null, {}, [null]])("private_account_itemの不正な勘定科目一覧%jでは停止する", async items => {
  const { deps, writes } = setup({}, undefined, items);
  await expect(runDealsPaymentsCreate({ ...options, fromWalletableType: "private_account_item" }, deps)).rejects.toThrow("invalid response: /api/1/account_items");
  expect(writes()).toHaveLength(0);
});
