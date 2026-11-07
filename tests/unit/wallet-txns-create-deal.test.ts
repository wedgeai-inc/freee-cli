import { expect, it, vi } from "vitest";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { runWalletTxnsCreateDeal } from "../../src/commands/wallet-txns/create-deal.js";

const options = { walletTxnId: 8, companyId: 1, partnerId: 3, accountItemId: 4, taxCode: 0, amount: 123, description: "fictional-private-description", logDir: "unused", taskId: "sample" };
function setup(wallet: Record<string, unknown> = {}, existing: Record<string, unknown>[] = []) {
  let posted = false;
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (init?.method === "POST") { posted = true; return new Response(JSON.stringify({ deal_ids: [6] })); }
    const body = path.includes("wallet_txns/") ? { wallet_txn: { id: 8, company_id: 1, date: "2026-01-15", amount: 123, due_amount: posted ? 0 : 123, status: posted ? 2 : 1, entry_side: "expense", ...wallet } }
      : path === "/api/1/deals" ? { deals: existing }
      : path === "/api/1/deals/6" ? { deal: { id: 6, company_id: 1, partner_id: 3, amount: 123, issue_date: "2026-01-15", type: "expense" } }
      : path.includes("partners/") ? { partner: { id: 3, company_id: 1, name: "架空取引先" } }
      : path.includes("account_items") ? { account_items: [{ id: 4, name: "架空科目" }] }
      : { taxes: [{ code: 0, name: "架空税区分" }] };
    return new Response(JSON.stringify(body));
  });
  const client = new PublicFreeeClient({ baseUrl: "https://example.invalid", token: "dummy", fetchFn: fetchFn as typeof fetch });
  const deps = { getClient: vi.fn(async () => client), appendAudit: vi.fn().mockResolvedValue(undefined), now: () => new Date("2026-01-15T00:00:00Z") };
  return { deps, fetchFn, writes: () => fetchFn.mock.calls.filter(c => c[1]?.method === "POST") };
}
it.each([
  [],
  [{ id: 6, company_id: 1, partner_id: 3, issue_date: "2026-01-15", amount: 124 }],
  [{ id: 6, company_id: 1, partner_id: 3, issue_date: "2026-01-14", amount: 123 }],
].map(existing => [existing]))("dry-runは異なる金額・日付の取引%jを重複にせず全ガード・名前・予定を返す", async existing => {
  const { deps, writes } = setup({}, existing);
  const result = await runWalletTxnsCreateDeal(options, deps);
  expect(result).toMatchObject({ mode: "dry-run", payload: { company_id: 1, issue_date: "2026-01-15", partner_id: 3, deal_lines: [{ amount: 123, account_item_id: 4, tax_code: 0, description: options.description }] }, names: { partner: "架空取引先", accountItems: ["架空科目"], taxes: ["架空税区分"] }, duplicateCheck: { found: false, dealIds: [], blocked: false } });
  expect(Object.values(result.guards)).toEqual(Array(9).fill(true));
  expect(writes()).toHaveLength(0);
  expect(deps.appendAudit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "wallet_txn_create_deal", target_id: 8, status: "planned" }));
  expect(JSON.stringify(deps.appendAudit.mock.calls)).not.toContain(options.description);
});
it.each([
  { execute: true }, { amount: 0 }, { amount: 1.5 }, { amount: Number.MAX_SAFE_INTEGER + 1 },
  { walletTxnId: 0 }, { companyId: 0 }, { partnerId: 0 }, { accountItemId: 0 }, { taxCode: -1 },
  { taxCode: 1.5 }, { taxCode: 2147483648 }, { issueDate: "2026-02-30" }, { expectDate: "bad" }, { expectAmount: NaN },
  { description: 123 },
])("不正入力%jを認証より前に拒否する", async override => {
  const { deps, writes } = setup();
  await expect(runWalletTxnsCreateDeal({ ...options, ...override } as typeof options, deps)).rejects.toThrow();
  expect(deps.getClient).not.toHaveBeenCalled();
  expect(writes()).toHaveLength(0);
});
it.each([
  ["expectedAmountMatches", { expectAmount: 124 }, {}],
  ["expectedDateMatches", { expectDate: "2026-01-14" }, {}],
  ["walletTxnCompanyMatches", {}, { company_id: 9 }],
  ["walletTxnUnreconciled", {}, { status: 2, due_amount: 0 }],
  ["walletTxnUnreconciled", {}, { status: 2 }],
  ["walletTxnUnreconciled", {}, { status: 4 }],
  ["walletTxnUnreconciled", {}, { due_amount: 122 }],
  ["walletTxnUnreconciled", {}, { amount: -123, due_amount: -123 }],
  ["walletTxnAmountMatches", {}, { amount: 124, due_amount: 124 }],
  ["entrySideKnown", {}, { entry_side: "unknown" }],
  ["issueDateNotAfterWalletDate", { issueDate: "2026-01-16" }, {}],
  ["dateNotFuture", {}, { date: "2026-01-16" }],
  ["dateNotFuture", {}, { date: "2026-02-30" }],
  ["noExistingDeal", {}, {}],
] as [string, Record<string, unknown>, Record<string, unknown>][])("ガード%sはdry-runで不成立を返しexecuteでは監査して拒否する", async (guard, override, wallet) => {
  const existing = guard === "noExistingDeal" ? [{ id: 6, company_id: 1, partner_id: 3, issue_date: "2026-01-15", amount: 123 }] : [];
  const opts = { ...options, expectAmount: 123, ...override };
  const dry = setup(wallet, existing);
  const result = await runWalletTxnsCreateDeal(opts, dry.deps);
  expect(result.guards).toHaveProperty(guard, false);
  expect(dry.deps.appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({ status: "guard_failed", guards: result.guards }));
  if (existing.length) expect(result.duplicateCheck).toEqual({ found: true, dealIds: [6], blocked: true });
  const live = setup(wallet, existing);
  await expect(runWalletTxnsCreateDeal({ ...opts, execute: true }, live.deps)).rejects.toThrow(guard);
  expect(live.writes()).toHaveLength(0);
  expect(live.deps.appendAudit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "failed", write_state: "not_attempted", reason: expect.stringContaining(guard) }));
});
it("executeは指定本文だけをPOSTし作成IDを監査して読み戻し、再実行を拒否する", async () => {
  const { deps, fetchFn, writes } = setup();
  const result = await runWalletTxnsCreateDeal({ ...options, execute: true, expectAmount: 123 }, deps);
  expect(writes()).toHaveLength(1);
  expect(new URL(writes()[0]![0]).pathname).toBe("/api/1/wallet_txns/8/create_deal");
  expect(JSON.parse(writes()[0]![1]!.body as string)).toEqual({ company_id: 1, issue_date: "2026-01-15", partner_id: 3, deal_lines: [{ amount: 123, account_item_id: 4, tax_code: 0, description: options.description }] });
  expect(result).toMatchObject({ created: { deal_ids: [6] }, readback: { walletTxnReconciled: true, dealCompanyMatches: true, dealPartnerMatches: true, dealAmountMatches: true, dealIssueDateMatches: true, dealTypeMatches: true } });
  expect(deps.appendAudit.mock.calls.map(c => c[0].status)).toEqual(["attempting", "succeeded"]);
  expect(deps.appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({ target_id: 8, created_id: 6 }));
  expect(fetchFn.mock.calls.slice(-2).map(c => new URL(c[0]).pathname)).toEqual(["/api/1/wallet_txns/8", "/api/1/deals/6"]);
  await expect(runWalletTxnsCreateDeal({ ...options, execute: true, expectAmount: 123 }, deps)).rejects.toThrow("walletTxnUnreconciled");
  expect(writes()).toHaveLength(1);
});
it.each(["wallet-status", "wallet-due", "wallet-id", "wallet-company", "deal-id", "deal-company", "deal-partner", "deal-amount", "deal-date", "deal-type", "network", "json"])("読み戻し失敗%sは取引IDと作成済みの可能性を出して止まり、再送しない", async failure => {
  const { deps, fetchFn, writes } = setup();
  const original = fetchFn.getMockImplementation()!;
  let posted = false;
  fetchFn.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (init?.method === "POST") { posted = true; return response; }
    if (!posted) return response;
    if (failure === "network") throw new Error("fictional disconnect");
    if (failure === "json") return new Response("invalid-json");
    const body = await response.json() as Record<string, Record<string, unknown>>;
    const patches: Record<string, Record<string, unknown>> = {
      "wallet-status": { status: 1 }, "wallet-due": { due_amount: 1 }, "wallet-id": { id: 9 }, "wallet-company": { company_id: 9 },
      "deal-id": { id: 9 }, "deal-company": { company_id: 9 }, "deal-partner": { partner_id: 9 }, "deal-amount": { amount: 124 }, "deal-date": { issue_date: "2026-01-14" },
      "deal-type": { type: "income" },
    };
    const envelope = failure.startsWith("wallet") ? "wallet_txn" : "deal";
    if (body[envelope]) Object.assign(body[envelope], patches[failure]);
    return new Response(JSON.stringify(body));
  });
  const error = await runWalletTxnsCreateDeal({ ...options, execute: true, expectAmount: 123 }, deps).catch(e => e);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain("deal_id=6");
  expect(error.message).toContain("作成済み");
  expect(error.message).toContain("再実行しない");
  expect(error.createdId).toBe(6);
  expect(writes()).toHaveLength(1);
  expect(deps.appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", write_state: "succeeded", created_id: 6, reason: "readback_failed" }));
});
it.each(["attempting", "guard", "succeeded", "readback"])("監査失敗%sでは未送信または作成IDを保った例外になる", async failure => {
  const { deps, writes } = setup(failure === "guard" ? { status: 2 } : failure === "readback" ? { due_amount: 123 } : {});
  deps.appendAudit.mockImplementation(async entry => {
    if (failure === "attempting" || failure === "guard" || entry.status === "succeeded" && failure === "succeeded" || entry.reason === "readback_failed") throw new Error("fictional storage error");
  });
  const error = await runWalletTxnsCreateDeal({ ...options, execute: true, expectAmount: 123 }, deps).catch(e => e);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain(failure === "attempting" || failure === "guard" ? "not_attempted" : "deal_id=6");
  expect(writes()).toHaveLength(failure === "attempting" || failure === "guard" ? 0 : 1);
});
it.each([[], [6, 7], [6, 6], [0], [-1], [1.5], ["6"], [null], [Number.MAX_SAFE_INTEGER + 1]])("不正な作成応答%jを送信後の検証失敗として停止する", async (...ids) => {
  const { deps, fetchFn, writes } = setup();
  const original = fetchFn.getMockImplementation()!;
  fetchFn.mockImplementation(async (url, init) => init?.method === "POST" ? new Response(JSON.stringify({ deal_ids: ids })) : original(url, init));
  await expect(runWalletTxnsCreateDeal({ ...options, execute: true, expectAmount: 123 }, deps)).rejects.toThrow("invalid create_deal response");
  expect(writes()).toHaveLength(1);
  expect(deps.appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", write_state: "succeeded", reason: "invalid_response" }));
});
it.each([409, 500, "network", "json"])("POST失敗%sは送信結果を区別し再送しない", async failure => {
  const { deps, fetchFn, writes } = setup();
  const original = fetchFn.getMockImplementation()!;
  fetchFn.mockImplementation(async (url, init) => {
    if (init?.method !== "POST") return original(url, init);
    if (failure === "network") throw new Error("fictional disconnect");
    return new Response(failure === "json" ? "invalid-json" : "{}", { status: typeof failure === "number" ? failure : 200 });
  });
  await expect(runWalletTxnsCreateDeal({ ...options, execute: true, expectAmount: 123 }, deps)).rejects.toThrow("accounting write");
  expect(writes()).toHaveLength(1);
  expect(deps.appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", write_state: failure === 409 ? "rejected" : failure === "json" ? "succeeded" : "unknown" }));
});
it.each(["income", "expense"])("%sで発生日指定・摘要省略を送信し、重複検索は指定日に絞る", async entrySide => {
  const { deps, fetchFn } = setup({ entry_side: entrySide });
  const opts = { ...options, description: undefined, issueDate: "2026-01-14" };
  const result = await runWalletTxnsCreateDeal(opts, deps);
  expect(result.payload.issue_date).toBe("2026-01-14");
  expect(result.payload.deal_lines[0]).not.toHaveProperty("description");
  expect(Object.values(result.guards).every(Boolean)).toBe(true);
  const query = new URL(fetchFn.mock.calls.find(c => new URL(c[0]).pathname === "/api/1/deals")![0]).searchParams;
  expect(Object.fromEntries(query)).toMatchObject({ company_id: "1", partner_id: "3", start_issue_date: "2026-01-14", end_issue_date: "2026-01-14" });
});
it.each([
  ["2026-01-16T14:59:59Z", false], ["2026-01-16T15:00:00Z", true],
])("JSTの日付境界%sで未来日を判定する", async (now, allowed) => {
  const { deps } = setup({ date: "2026-01-17" });
  deps.now = () => new Date(now as string);
  expect((await runWalletTxnsCreateDeal(options, deps)).guards.dateNotFuture).toBe(allowed);
});
it.each(["/api/1/account_items", "/api/1/taxes/companies/1", "/api/1/partners/3", "/api/1/deals", "/api/1/wallet_txns/8"])("不正な読み取り応答%sでは送信しない", async path => {
  const { deps, fetchFn, writes } = setup();
  const original = fetchFn.getMockImplementation()!;
  fetchFn.mockImplementation(async (url, init) => new URL(url).pathname === path ? new Response("{}") : original(url, init));
  await expect(runWalletTxnsCreateDeal({ ...options, execute: true, expectAmount: 123 }, deps)).rejects.toThrow();
  expect(writes()).toHaveLength(0);
});
