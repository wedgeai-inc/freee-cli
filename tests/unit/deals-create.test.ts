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
      const result = await runDealsCreate({ ...options, allowDuplicate }, deps);
      expect(result).toMatchObject({ duplicateCheck: { found: duplicate, dealIds: duplicate ? [7] : [], blocked: duplicate && !allowDuplicate } });
      const listCall = fetchFn.mock.calls.find(c => new URL(c[0]).pathname === "/api/1/deals");
      expect(listCall).toBeDefined();
      const query = new URL(listCall![0]).searchParams;
      expect(Object.fromEntries(query)).toMatchObject({ company_id: "1", partner_id: "2", start_issue_date: options.issueDate, end_issue_date: options.issueDate });
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

const invoiceOptions = { ...options, type: "income", dueDate: "2026-02-15", invoiceId: 8, expectInvoiceNumber: "SAMPLE-8" };
const invoice = { id: 8, company_id: 1, invoice_number: "SAMPLE-8", deal_status: "unregistered", deal_id: null, cancel_status: "uncanceled", total_amount: 1500, partner_id: 2, billing_date: "2026-01-15", payment_date: "2026-02-15" };
function setupInvoice(before: unknown = invoice, after: unknown = { ...invoice, deal_status: "registered", deal_id: 6 }) {
  const setupResult = setup();
  const original = setupResult.client.get.bind(setupResult.client);
  let reads = 0;
  const get = vi.spyOn(setupResult.client, "get").mockImplementation(async (path, opts) => {
    if (path !== "/iv/invoices/8") return original(path, opts);
    reads++;
    return new Response(JSON.stringify({ invoice: reads === 1 ? before : after }));
  });
  return { ...setupResult, get };
}
it("請求書指定のdry-runは対象と金額・取引先・請求日・期日を照合し、紐付け項目を送らない", async () => {
  const { deps, get, fetchFn } = setupInvoice();
  const result = await runDealsCreate(invoiceOptions, deps);
  expect(get).toHaveBeenCalledWith("/iv/invoices/8", { query: { company_id: 1 } });
  expect(result).toMatchObject({ invoiceCheck: { id: 8, invoice_number: "SAMPLE-8", deal_status: "unregistered" } });
  expect(result.payload).not.toHaveProperty("invoice_id");
  expect(fetchFn.mock.calls.every(c => c[1]?.method === "GET")).toBe(true);
  expect(deps.appendAudit).toHaveBeenCalledWith(expect.objectContaining({ status: "planned" }));
});
it("請求書の状態・識別子・照合項目の不一致や欠落はdry-runとexecuteの両方でPOST前に拒否する", async () => {
  const patches = [
    { id: 9 }, { company_id: 9 }, { invoice_number: "OTHER" }, { invoice_number: undefined },
    { deal_status: "registered" }, { deal_status: undefined }, { deal_id: 9 },
    { cancel_status: "canceled" }, { cancel_status: undefined },
    { total_amount: 1499 }, { total_amount: "1500" }, { total_amount: undefined },
    { partner_id: 9 }, { partner_id: "2" }, { partner_id: undefined },
    { billing_date: "2026-01-16" }, { billing_date: undefined },
    { payment_date: "2026-02-16" }, { payment_date: undefined },
  ];
  for (const patch of patches) for (const execute of [false, true]) {
    const { deps, fetchFn } = setupInvoice({ ...invoice, ...patch });
    await expect(runDealsCreate({ ...invoiceOptions, execute, expectTotal: 1500 }, deps)).rejects.toThrow(/invoice/);
    expect(fetchFn.mock.calls.some(c => c[1]?.method === "POST")).toBe(false);
    expect(deps.appendAudit).not.toHaveBeenCalled();
  }
});
it("請求書指定はincome限定で不正ID・孤立した確認番号・executeの確認番号欠落を認証前に拒否する", async () => {
  const patches = [
    { type: "expense" }, ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(invoiceId => ({ invoiceId })),
    { invoiceId: undefined }, { execute: true, expectTotal: 1500, expectInvoiceNumber: undefined },
    { expectInvoiceNumber: "" },
  ];
  for (const patch of patches) {
    const { deps } = setupInvoice();
    const getClient = vi.fn(deps.getClient);
    await expect(runDealsCreate({ ...invoiceOptions, ...patch }, { ...deps, getClient })).rejects.toThrow(/invoice/);
    expect(getClient).not.toHaveBeenCalled();
  }
});
it("取引登録後は請求書を読み戻し、未登録・別取引・不正応答なら作成済みの警告と失敗監査を返す", async () => {
  for (const after of [invoice, { ...invoice, deal_id: 6 }, { ...invoice, deal_status: "registered", deal_id: 9 }, { ...invoice, deal_status: "registered", deal_id: undefined }, { ...invoice, id: 9, deal_status: "registered", deal_id: 6 }, null]) {
    const { deps, fetchFn, get } = setupInvoice(invoice, after);
    await expect(runDealsCreate({ ...invoiceOptions, execute: true, expectTotal: 1500 }, deps)).rejects.toMatchObject({
      message: expect.stringMatching(/警告.*作成済み.*再実行/), createdId: 6, writeState: "succeeded",
    });
    expect(get.mock.calls.filter(c => c[0] === "/iv/invoices/8")).toHaveLength(2);
    expect(fetchFn.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(1);
    expect(deps.appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", write_state: "succeeded", created_id: 6, reason: "invoice_readback_failed" }));
  }
});
it("登録後のregisteredと作成した取引IDの一致を返し、GETはPOSTの前後に1回ずつ行う", async () => {
  const { deps, get, fetchFn } = setupInvoice();
  const result = await runDealsCreate({ ...invoiceOptions, execute: true, expectTotal: 1500 }, deps);
  expect(result).toMatchObject({ created: { id: 6 }, invoiceReadback: { id: 8, deal_status: "registered", deal_id: 6 } });
  const reads = get.mock.invocationCallOrder.filter((_, i) => get.mock.calls[i]?.[0] === "/iv/invoices/8");
  const write = fetchFn.mock.invocationCallOrder.find((_, i) => fetchFn.mock.calls[i]?.[1]?.method === "POST")!;
  expect(reads).toHaveLength(2);
  expect(reads[0]).toBeLessThan(write);
  expect(reads[1]).toBeGreaterThan(write);
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
it("請求書の読み戻し通信や失敗監査が失敗しても作成済みIDと警告を失わない", async () => {
  const { deps, get } = setupInvoice();
  let reads = 0;
  const original = get.getMockImplementation()!;
  get.mockImplementation(async (path, opts) => {
    if (path === "/iv/invoices/8" && ++reads > 1) throw new Error("synthetic read failure");
    return original(path, opts);
  });
  deps.appendAudit.mockImplementation(async entry => { if (entry.status === "failed") throw new Error("synthetic audit failure"); });
  await expect(runDealsCreate({ ...invoiceOptions, execute: true, expectTotal: 1500 }, deps)).rejects.toMatchObject({ createdId: 6, writeState: "succeeded", message: expect.stringMatching(/警告/) });
});
