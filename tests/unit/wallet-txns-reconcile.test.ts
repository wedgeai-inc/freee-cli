import { expect, it, vi } from "vitest";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { runWalletTxnsReconcile } from "../../src/commands/wallet-txns/reconcile.js";

const options = { walletTxnId: 8, companyId: 1, dealId: 6, amount: 123, logDir: "unused", taskId: "sample" };
function setup(wallet: Record<string, unknown> = {}, deal: Record<string, unknown> = {}) {
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.method === "POST" ? { wallet_txn_id: 8, deal_ids: [6], new_deal_id: null }
      : path.includes("wallet_txns/") ? { wallet_txn: { id: 8, company_id: 1, date: "2026-01-15", amount: 123, due_amount: 123, entry_side: "expense", status: 1, walletable_type: "bank_account", walletable_id: 2, description: "fictional-private-description", ...wallet } }
      : path.includes("partners/") ? { partner: { id: 3, company_id: 1, name: "架空取引先" } }
      : { deal: { id: 6, company_id: 1, type: "expense", issue_date: "2026-01-15", amount: 123, due_amount: 123, status: "unsettled", partner_id: null, ...deal } };
    return new Response(JSON.stringify(body));
  });
  const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "dummy", fetchFn: fetchFn as typeof fetch });
  const deps = { getClient: vi.fn(async () => client), appendAudit: vi.fn().mockResolvedValue(undefined), now: () => new Date("2026-01-15T00:00:00Z") };
  return { deps, fetchFn, writes: () => fetchFn.mock.calls.filter(c => c[1]?.method === "POST") };
}
it("dry-runは2件を読み全ガードと送信予定を返し摘要を公開せずplannedを記録する", async () => {
  const { deps, fetchFn, writes } = setup();
  const result = await runWalletTxnsReconcile(options, deps);
  expect(result).toMatchObject({ mode: "dry-run", payload: { company_id: 1, deals: [{ deal_id: 6, amount: 123 }] }, wallet_txn: { id: 8 }, deal: { id: 6, partner_name: null } });
  expect(Object.values(result.guards)).toHaveLength(12);
  expect(Object.values(result.guards).every(Boolean)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("description");
  expect(writes()).toHaveLength(0);
  expect(fetchFn.mock.calls.map(c => new URL(c[0]).pathname)).toEqual(["/api/1/wallet_txns/8", "/api/1/deals/6"]);
  expect(fetchFn.mock.calls.every(c => new URL(c[0]).searchParams.get("company_id") === "1")).toBe(true);
  expect(deps.appendAudit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "wallet_txn_reconcile", target_id: 8, status: "planned", payload_redacted: result.payload }));
});
it.each([
  { walletTxnId: 0 }, { companyId: 0 }, { dealId: -1 }, { amount: 0 }, { amount: -1 }, { amount: 1.5 },
  { amount: NaN }, { amount: Infinity }, { amount: Number.MAX_SAFE_INTEGER + 1 },
  { expectAmount: 0 }, { expectAmount: NaN }, { expectAmount: 1.5 }, { expectDate: "2026-02-30" }, { execute: true },
])("入力%jは認証前に拒否する", async override => {
  const { deps } = setup();
  await expect(runWalletTxnsReconcile({ ...options, ...override }, deps)).rejects.toThrow();
  expect(deps.getClient).not.toHaveBeenCalled();
});
it("executeは送信前監査を保存し公式本文だけをPOSTしてフラットな結果を返す", async () => {
  const { deps, writes } = setup();
  deps.appendAudit.mockImplementation(async entry => { if (entry.status === "attempting") expect(writes()).toHaveLength(0); });
  const result = await runWalletTxnsReconcile({ ...options, execute: true, expectAmount: 123 }, deps);
  expect(result).toMatchObject({ mode: "execute", created: { wallet_txn_id: 8, deal_ids: [6] } });
  expect(writes()).toHaveLength(1);
  expect(new URL(writes()[0]![0]).pathname).toBe("/api/1/wallet_txns/8/reconcile");
  expect(JSON.parse(writes()[0]![1]!.body as string)).toEqual({ company_id: 1, deals: [{ deal_id: 6, amount: 123 }] });
  expect(deps.appendAudit.mock.calls.map(c => c[0].status)).toEqual(["attempting", "succeeded"]);
  expect(deps.appendAudit.mock.calls.every(c => !("created_id" in c[0]))).toBe(true);
});
it.each([
  ["expectedAmountMatches", { expectAmount: 124 }, {}, {}],
  ["expectedDateMatches", { expectDate: "2026-01-14" }, {}, {}],
  ["walletTxnCompanyMatches", {}, { company_id: 9 }, {}],
  ["dealCompanyMatches", {}, {}, { company_id: 9 }],
  ["walletTxnUnreconciled", {}, { status: 4 }, {}],
  ["walletTxnUnreconciled", {}, { due_amount: 122 }, {}],
  ["walletTxnAmountMatches", {}, { amount: 124, due_amount: 124 }, {}],
  ["dealHasOutstandingAmount", {}, {}, { due_amount: 0 }],
  ["dealHasOutstandingAmount", {}, {}, { due_amount: -1 }],
  ["dealHasOutstandingAmount", {}, {}, { due_amount: 1.5 }],
  ["dealHasOutstandingAmount", {}, {}, { due_amount: Number.MAX_SAFE_INTEGER + 1 }],
  ["dealAmountMatchesDue", {}, {}, { due_amount: 124 }],
  ["entrySideMatchesDealType", {}, { entry_side: "income" }, {}],
  ["entrySideMatchesDealType", {}, { entry_side: null }, { type: null }],
  ["dateNotBeforeIssueDate", {}, { date: "2026-01-14" }, {}],
  ["dateNotFuture", {}, { date: "2026-01-16" }, {}],
  ["dealStatusUnsettled", {}, {}, { status: "settled" }],
  ...[undefined, null, "invalid", {}].flatMap(value => [
    ["walletTxnCompanyMatches", {}, { company_id: value }, {}],
    ["dealCompanyMatches", {}, {}, { company_id: value }],
    ["walletTxnUnreconciled", {}, { status: value }, {}],
    ["walletTxnUnreconciled", {}, { due_amount: value }, {}],
    ["walletTxnAmountMatches", {}, { amount: value }, {}],
    ["dealHasOutstandingAmount", {}, {}, { due_amount: value }],
    ["dealAmountMatchesDue", {}, {}, { due_amount: value }],
    ["entrySideMatchesDealType", {}, { entry_side: value }, {}],
    ["entrySideMatchesDealType", {}, {}, { type: value }],
    ["dateNotBeforeIssueDate", {}, {}, { issue_date: value }],
    ["dateNotFuture", {}, { date: value }, {}],
    ["dealStatusUnsettled", {}, {}, { status: value }],
  ]),
] as [string, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>][])("ガード%sの不成立はdry-runで表示しexecuteは監査1件で拒否する(%j/%j/%j)", async (guard, override, wallet, deal) => {
  const opts = { ...options, expectAmount: 123, ...override };
  const dry = setup(wallet, deal);
  const result = await runWalletTxnsReconcile(opts, dry.deps);
  expect(result.guards).toHaveProperty(guard, false);
  expect(dry.writes()).toHaveLength(0);
  const live = setup(wallet, deal);
  await expect(runWalletTxnsReconcile({ ...opts, execute: true }, live.deps)).rejects.toThrow("guard");
  expect(live.writes()).toHaveLength(0);
  const failed = Object.entries(result.guards).filter(([, ok]) => !ok).map(([name]) => name);
  expect(live.deps.appendAudit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "failed", write_state: "not_attempted", reason: `guard_failed:${failed.join(",")}`, payload_redacted: result.payload }));
});
it.each([
  ["2026-01-14", "2026-01-15T00:00:00Z", false, true],
  ["2026-01-15", "2026-01-15T00:00:00Z", true, true],
  ["2026-01-16", "2026-01-15T14:59:59Z", true, false],
  ["2026-01-16", "2026-01-15T15:00:00Z", true, true],
  ["2026-01-17", "2026-01-15T15:00:00Z", true, false],
  ["2026-02-30", "2026-03-01T00:00:00Z", false, false],
])("明細日%sはJST境界%sで発生日・未来日を照合する", async (date, now, before, future) => {
  const { deps } = setup({ date });
  deps.now = () => new Date(now);
  const result = await runWalletTxnsReconcile(options, deps);
  expect(result.guards).toMatchObject({ dateNotBeforeIssueDate: before, dateNotFuture: future });
});
it.each(["income", "expense"])("%sの符号付き明細と取引先名を確認する", async type => {
  const { deps } = setup({ amount: -123, due_amount: -123, entry_side: type }, { type, partner_id: 3 });
  const result = await runWalletTxnsReconcile({ ...options, expectDate: "2026-01-15", expectAmount: 123, execute: true }, deps);
  expect(Object.values(result.guards).every(Boolean)).toBe(true);
  expect(result.deal.partner_name).toBe("架空取引先");
});
it.each(["attempting", "guard"])("送信前監査失敗%sではPOSTしない", async failure => {
  const { deps, writes } = setup(failure === "guard" ? { status: 4 } : {});
  deps.appendAudit.mockRejectedValue(new Error("fictional storage error"));
  await expect(runWalletTxnsReconcile({ ...options, expectAmount: 123, execute: true }, deps)).rejects.toThrow("not_attempted");
  expect(writes()).toHaveLength(0);
  expect(deps.appendAudit).toHaveBeenCalledTimes(1);
});
it.each([409, 500, "network", "invalid", "wrong-id", "missing-deal", "bad-deal", "adjustment", "missing-new-id", "audit"] as const)("送信後の異常%sを適切なwrite_stateで監査する", async failure => {
  const { deps, fetchFn } = setup();
  const original = fetchFn.getMockImplementation()!;
  fetchFn.mockImplementation(async (url, init) => {
    if (init?.method !== "POST") return original(url, init);
    if (typeof failure === "number") return new Response("{}", { status: failure });
    if (failure === "network") throw new Error("fictional disconnect");
    if (failure === "invalid") return new Response("not-json");
    return new Response(JSON.stringify({ wallet_txn_id: failure === "wrong-id" ? 9 : 8, deal_ids: failure === "missing-deal" ? [7] : failure === "bad-deal" ? [6, "invalid"] : [6], new_deal_id: failure === "adjustment" ? 10 : failure === "missing-new-id" ? undefined : null }));
  });
  if (failure === "audit") deps.appendAudit.mockImplementation(async entry => { if (entry.status === "succeeded") throw new Error("fictional storage error"); });
  const error = await runWalletTxnsReconcile({ ...options, execute: true, expectAmount: 123 }, deps).catch(e => e);
  expect(error.message).toContain("再実行");
  if (failure === "adjustment") expect(error.message).toContain("想定外の差額取引が作られた");
  expect(deps.appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", write_state: failure === 409 ? "rejected" : failure === 500 || failure === "network" ? "unknown" : "succeeded" }));
  expect(deps.appendAudit.mock.calls.every(c => !("created_id" in c[0]))).toBe(true);
});
it.each(["wallet_txn", "deal"])("%sの同一性・応答形式が不正なら読み取りで止める", async envelope => {
  for (const item of [null, [], "invalid", { id: 9 }]) {
    const { deps, fetchFn, writes } = setup();
    const original = fetchFn.getMockImplementation()!;
    fetchFn.mockImplementation(async (url, init) => new URL(url).pathname.includes(envelope === "deal" ? "/deals/" : "/wallet_txns/") ? new Response(JSON.stringify({ [envelope]: item })) : original(url, init));
    await expect(runWalletTxnsReconcile(options, deps)).rejects.toThrow(`invalid response: ${envelope}`);
    expect(writes()).toHaveLength(0);
  }
});
it.each(["http", "network", "invalid", "wrong-id", "wrong-company"])("取引先取得失敗%sでは送信しない", async failure => {
  const { deps, fetchFn, writes } = setup({}, { partner_id: 3 });
  const original = fetchFn.getMockImplementation()!;
  fetchFn.mockImplementation(async (url, init) => {
    if (!new URL(url).pathname.includes("/partners/")) return original(url, init);
    if (failure === "network") throw new Error("fictional disconnect");
    if (failure === "http") return new Response("{}", { status: 400 });
    if (failure === "invalid") return new Response("{}");
    return new Response(JSON.stringify({ partner: { id: failure === "wrong-id" ? 4 : 3, company_id: failure === "wrong-company" ? 9 : 1, name: "架空取引先" } }));
  });
  await expect(runWalletTxnsReconcile({ ...options, execute: true, expectAmount: 123 }, deps)).rejects.toThrow();
  expect(writes()).toHaveLength(0);
});
it("消込後にstatusと残額が変わった再実行はガードで止まる", async () => {
  const { deps, fetchFn, writes } = setup();
  const original = fetchFn.getMockImplementation()!;
  let settled = false;
  fetchFn.mockImplementation(async (url, init) => {
    if (init?.method === "POST") { settled = true; return original(url, init); }
    if (!settled) return original(url, init);
    return new Response(JSON.stringify(new URL(url).pathname.includes("/wallet_txns/")
      ? { wallet_txn: { id: 8, company_id: 1, date: "2026-01-15", amount: 123, due_amount: 0, status: 2, entry_side: "expense" } }
      : { deal: { id: 6, company_id: 1, issue_date: "2026-01-15", due_amount: 0, type: "expense", status: "settled" } }));
  });
  const opts = { ...options, execute: true, expectAmount: 123 };
  await runWalletTxnsReconcile(opts, deps);
  await expect(runWalletTxnsReconcile(opts, deps)).rejects.toThrow("walletTxnUnreconciled");
  expect(writes()).toHaveLength(1);
});
it("executeのガード拒否は取引先の参照より先に監査し送信を止める", async () => {
  const { deps, fetchFn, writes } = setup({}, { company_id: 9, partner_id: 3 });
  const original = fetchFn.getMockImplementation()!;
  fetchFn.mockImplementation(async (url, init) => {
    if (new URL(url).pathname.includes("/partners/")) throw new Error("fictional partner failure");
    return original(url, init);
  });
  await expect(runWalletTxnsReconcile({ ...options, execute: true, expectAmount: 123 }, deps)).rejects.toThrow("guard failed: dealCompanyMatches");
  expect(deps.appendAudit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "failed", write_state: "not_attempted", reason: "guard_failed:dealCompanyMatches" }));
  expect(fetchFn.mock.calls.some(c => new URL(c[0]).pathname.includes("/partners/"))).toBe(false);
  expect(writes()).toHaveLength(0);
});
