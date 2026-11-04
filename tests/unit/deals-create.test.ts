import { expect, it, vi } from "vitest";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { runDealsCreate } from "../../src/commands/deals/create.js";

const options = { companyId: 1, type: "expense", issueDate: "2026-01-15", partnerId: 2, details: ["account_item_id=3,tax_code=4,amount=1500,description=架空摘要"], execute: false, taskId: "sample", logDir: "unused" };
function setup(duplicate = false) {
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = path.endsWith("account_items") ? { account_items: [{ id: 3, name: "架空科目" }] }
      : path.includes("taxes") ? { taxes: [{ code: 4, name: "架空税区分" }] }
      : path.includes("partners/") ? { partner: { id: 2, company_id: 1, name: "架空取引先" } }
      : init?.method === "POST" ? { deal: { id: 6, company_id: 1 } }
      : { deals: duplicate ? [{ id: 7, partner_id: 2, issue_date: options.issueDate, amount: 1500 }] : [] };
    return new Response(JSON.stringify(body));
  });
  const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn: fetchFn as typeof fetch });
  const appendAudit = vi.fn().mockResolvedValue(undefined);
  return { fetchFn, client, deps: { getClient: async () => client, appendAudit, now: () => new Date("2026-01-15T00:00:00Z") } };
}
it("dry-runはJSON全体・名前解決・税込合計を返し、書き込まない", async () => {
  const { deps, fetchFn } = setup();
  const result = await runDealsCreate(options, deps);
  expect(result).toMatchObject({ mode: "dry-run", total: 1500, names: { partner: "架空取引先", accountItems: ["架空科目"], taxes: ["架空税区分"] }, payload: { company_id: 1, details: [{ amount: 1500 }] } });
  expect(result.payload).not.toHaveProperty("payments");
  expect(fetchFn.mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
  expect(deps.appendAudit).toHaveBeenCalledWith(expect.objectContaining({ status: "planned", payload_redacted: expect.objectContaining({ details: [expect.objectContaining({ description: "[REDACTED]" })] }) }));
});
it("executeはexpect-total完全一致を必須とし、重複時もPOSTを止める", async () => {
  for (const expectTotal of [undefined, 1499, NaN, Infinity]) {
    const { deps, fetchFn } = setup();
    await expect(runDealsCreate({ ...options, execute: true, expectTotal }, deps)).rejects.toThrow("--expect-total");
    expect(fetchFn).not.toHaveBeenCalled();
  }
  const { deps, fetchFn } = setup(true);
  await expect(runDealsCreate({ ...options, execute: true, expectTotal: 1500 }, deps)).rejects.toThrow("duplicate");
  expect(fetchFn.mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
});
it("合計確認後にPOSTし、allow-duplicateだけが重複を許可する", async () => {
  const { deps, fetchFn } = setup(true);
  const result = await runDealsCreate({ ...options, execute: true, expectTotal: 1500, allowDuplicate: true }, deps);
  expect(result).toMatchObject({ mode: "execute", created: { id: 6 } });
  const writes = fetchFn.mock.calls.filter(call => call[1]?.method === "POST");
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0]![1]!.body as string)).toEqual(result.payload);
  expect(deps.appendAudit.mock.calls.map(c => c[0].status)).toEqual(["attempting", "succeeded"]);
});
it("名前解決不能や重複照合に必要な応答項目がない場合は送信しない", async () => {
  const payloads = [
    { deals: [{ id: 7 }] },
    { deals: [{ id: 7, partner_id: 2, issue_date: options.issueDate, amount: "1500" }] },
    { deals: "invalid" },
    { account_items: [] },
    { taxes: [] },
  ];
  for (const override of payloads) {
    const { client, deps, fetchFn } = setup();
    const original = client.get.bind(client);
    vi.spyOn(client, "get").mockImplementation(async (path, opts) => {
      if (path.endsWith("deals") && "deals" in override || path.endsWith("account_items") && "account_items" in override || path.includes("taxes") && "taxes" in override) return new Response(JSON.stringify(override));
      return original(path, opts);
    });
    await expect(runDealsCreate({ ...options, execute: true, expectTotal: 1500 }, deps)).rejects.toThrow();
    expect(fetchFn.mock.calls.some(c => c[1]?.method === "POST")).toBe(false);
  }
});

it("dry-runは合計確認の一致・不一致を報告し、未指定ならchecksを追加しない", async () => {
  for (const expected of [1500, 1499, NaN, Infinity, 1500.5, undefined]) {
    const { deps, fetchFn } = setup();
    const result = await runDealsCreate({ ...options, expectTotal: expected }, deps);
    if (expected === undefined) expect(result).not.toHaveProperty("checks");
    else expect(result).toMatchObject({ checks: { expectTotal: { expected, actual: 1500, matches: expected === 1500 } } });
    expect(fetchFn.mock.calls.every(c => c[1]?.method === "GET")).toBe(true);
    expect(deps.appendAudit.mock.calls.map(c => c[0].status)).toEqual(["planned"]);
  }
});

it("dry-runは重複の有無とallowDuplicateによる実行阻止の有無をGETだけで報告する", async () => {
  for (const duplicate of [false, true]) {
    for (const allowDuplicate of [false, true]) {
      const { deps, fetchFn } = setup(duplicate);
      const result = await runDealsCreate({ ...options, allowDuplicate, refNumber: "SAMPLE-8" }, deps);
      expect(result).toMatchObject({ duplicateCheck: { found: duplicate, dealIds: duplicate ? [7] : [], blocked: duplicate && !allowDuplicate } });
      const listCall = fetchFn.mock.calls.find(c => new URL(c[0]).pathname === "/api/1/deals");
      expect(listCall).toBeDefined();
      const query = new URL(listCall![0]).searchParams;
      expect(Object.fromEntries(query)).toMatchObject({ company_id: "1", partner_id: "2", start_issue_date: options.issueDate, end_issue_date: options.issueDate });
      expect(query.has("ref_number")).toBe(false);
      expect(query.has("type")).toBe(false);
      expect(query.has("status")).toBe(false);
      expect(fetchFn.mock.calls.every(c => c[1]?.method === "GET")).toBe(true);
      expect(deps.appendAudit.mock.calls.map(c => c[0].status)).toEqual(["planned"]);
    }
  }
});

it("dry-runも重複照合の不正な応答を監査・書き込み前に拒否する", async () => {
  const valid = { id: 7, partner_id: 2, issue_date: options.issueDate, amount: 1500 };
  for (const deals of ["invalid", [null], [{}], ...[
    { id: 0 }, { partner_id: 0 }, { amount: "1500" }, { amount: 1.5 },
    { issue_date: 20260115 }, { issue_date: "2026-02-30" },
  ].map(patch => [{ ...valid, ...patch }])]) {
    const { client, deps, fetchFn } = setup();
    const original = client.get.bind(client);
    vi.spyOn(client, "get").mockImplementation(async (path, opts) => path === "/api/1/deals"
      ? new Response(JSON.stringify({ deals })) : original(path, opts));
    await expect(runDealsCreate(options, deps)).rejects.toThrow();
    expect(deps.appendAudit).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  }
});

it("dry-runは全ページを照合し、取引先・日付・合計がすべて一致するIDだけを報告する", async () => {
  const { client, deps, fetchFn } = setup();
  const valid = { id: 7, partner_id: 2, issue_date: options.issueDate, amount: 1500 };
  const pages = [
    Array.from({ length: 100 }, (_, i) => ({ ...valid, id: i + 10, amount: 1400 })),
    [valid, { ...valid, id: 8 }, { ...valid, id: 9, partner_id: 3 }, { ...valid, id: 110, issue_date: "2026-01-16" }],
  ];
  const original = client.get.bind(client);
  const offsets: unknown[] = [];
  vi.spyOn(client, "get").mockImplementation(async (path, opts) => {
    if (path !== "/api/1/deals") return original(path, opts);
    offsets.push(opts?.query?.offset);
    return new Response(JSON.stringify({ deals: pages[Number(opts?.query?.offset) / 100] }));
  });
  const result = await runDealsCreate(options, deps);
  expect(result).toMatchObject({ duplicateCheck: { found: true, dealIds: [7, 8], blocked: true } });
  expect(offsets).toEqual([0, 100]);
  expect(fetchFn.mock.calls.every(c => c[1]?.method === "GET")).toBe(true);
  expect(deps.appendAudit.mock.calls.map(c => c[0].status)).toEqual(["planned"]);
});

it("executeも全ページの同一取引先・発生日・金額を検出し、allow-duplicateなしで送信しない", async () => {
  const { client, deps, fetchFn } = setup();
  const original = client.get.bind(client);
  const offsets: unknown[] = [];
  vi.spyOn(client, "get").mockImplementation(async (path, opts) => {
    if (path !== "/api/1/deals") return original(path, opts);
    offsets.push(opts?.query?.offset);
    const deals = opts?.query?.offset === 0
      ? Array.from({ length: 100 }, (_, i) => ({ id: i + 10, partner_id: 2, issue_date: options.issueDate, amount: 1400 }))
      : [{ id: 7, partner_id: 2, issue_date: options.issueDate, amount: 1500, type: "income", status: "settled" }];
    return new Response(JSON.stringify({ deals }));
  });
  await expect(runDealsCreate({ ...options, execute: true, expectTotal: 1500 }, deps)).rejects.toThrow("duplicate");
  expect(offsets).toEqual([0, 100]);
  expect(fetchFn).not.toHaveBeenCalled();
  expect(deps.appendAudit).not.toHaveBeenCalled();
});

it("請求書指定と確認番号はdry-run・executeとも認証・API・監査の前に拒否する", async () => {
  for (const execute of [false, true]) {
    for (const invoiceOptions of [{ invoiceId: 8 }, { expectInvoiceNumber: "SAMPLE-8" }, { invoiceId: 8, expectInvoiceNumber: "SAMPLE-8" }]) {
      const { deps, fetchFn } = setup();
      const getClient = vi.fn(deps.getClient);
      await expect(runDealsCreate({ ...options, ...invoiceOptions, execute, expectTotal: 1500 }, { ...deps, getClient })).rejects.toThrow(/公開API.*紐付け.*Web画面/);
      expect(getClient).not.toHaveBeenCalled();
      expect(fetchFn).not.toHaveBeenCalled();
      expect(deps.appendAudit).not.toHaveBeenCalled();
    }
  }
});
