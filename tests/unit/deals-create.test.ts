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
