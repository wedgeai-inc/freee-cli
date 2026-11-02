import { expect, it, vi } from "vitest";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { runAccountItemsList } from "../../src/commands/account-items/list.js";
import { runTaxesList } from "../../src/commands/taxes/list.js";
import { runDealsList } from "../../src/commands/deals/list.js";
import { runDealsGet } from "../../src/commands/deals/get.js";
import { runReceiptsGet } from "../../src/commands/receipts/get.js";

it("5つの読み取りを公開APIのGETで実行し、一覧の検索条件を送る", async () => {
  const fetchFn = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const body = path.endsWith("account_items") ? { account_items: [{ id: 2, name: "架空科目" }] }
      : path.includes("taxes") ? { taxes: [{ code: 3, name: "架空税区分" }] }
      : path.endsWith("deals") ? { deals: [{ id: 4 }] }
      : path.includes("deals/") ? { deal: { id: 4, company_id: 1 } }
      : { receipt: { id: 5, company_id: 1 } };
    return new Response(JSON.stringify(body));
  });
  const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn: fetchFn as typeof fetch });
  expect(await runAccountItemsList({ companyId: 1 }, { client })).toEqual({ items: [{ id: 2, name: "架空科目" }] });
  expect(await runTaxesList({ companyId: 1 }, { client })).toEqual({ items: [{ code: 3, name: "架空税区分" }] });
  expect(await runDealsList({ companyId: 1, partnerId: 6, type: "expense", startIssueDate: "2026-01-01", endIssueDate: "2026-01-31", status: "unsettled" }, { client })).toEqual({ items: [{ id: 4 }] });
  expect(await runDealsGet({ companyId: 1, id: 4 }, { client })).toEqual({ id: 4, company_id: 1 });
  expect(await runReceiptsGet({ companyId: 1, id: 5 }, { client })).toEqual({ id: 5, company_id: 1 });
  expect(fetchFn.mock.calls.map(call => new URL(call[0]).pathname)).toEqual(["/api/1/account_items", "/api/1/taxes/companies/1", "/api/1/deals", "/api/1/deals/4", "/api/1/receipts/5"]);
  expect(new URL(fetchFn.mock.calls[0]![0]).search).toBe("?company_id=1");
  expect(new URL(fetchFn.mock.calls[1]![0]).search).toBe("");
  const query = new URL(fetchFn.mock.calls[2]![0]).searchParams;
  expect(Object.fromEntries(query)).toEqual({ limit: "100", offset: "0", company_id: "1", partner_id: "6", type: "expense", start_issue_date: "2026-01-01", end_issue_date: "2026-01-31", status: "unsettled" });
});

it("不正な応答と検索条件を拒否し、重複検知で使う一覧の全ページを読む", async () => {
  const badClient = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn: vi.fn().mockResolvedValue(new Response('{"deals":[null]}')) });
  await expect(runDealsList({ companyId: 1 }, { client: badClient })).rejects.toThrow("invalid response");
  const fetchFn = vi.fn(async (_url: string) => new Response(JSON.stringify({ deals: fetchFn.mock.calls.length === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) : [{ id: 101 }] })));
  const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn: fetchFn as typeof fetch });
  expect((await runDealsList({ companyId: 1 }, { client })).items).toHaveLength(101);
  expect(fetchFn.mock.calls.map(call => Object.fromEntries(new URL(call[0]).searchParams))).toEqual([
    { company_id: "1", limit: "100", offset: "0" }, { company_id: "1", limit: "100", offset: "100" },
  ]);
  const invalidOptions = [{ companyId: 0 }, { companyId: 1, type: "bad" }, { companyId: 1, status: "bad" }, { companyId: 1, startIssueDate: "2026-02-30" }, { companyId: 1, startIssueDate: "2026-01-31", endIssueDate: "2026-01-01" }];
  for (const opts of invalidOptions) await expect(runDealsList(opts as Parameters<typeof runDealsList>[0], { client })).rejects.toThrow();
  for (const run of [runDealsGet, runReceiptsGet]) {
    await expect(run({ companyId: 1, id: 0 }, { client })).rejects.toThrow();
    const wrong = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn: vi.fn().mockResolvedValue(new Response('{"deal":{"id":4,"company_id":2},"receipt":{"id":4,"company_id":2}}')) });
    await expect(run({ companyId: 1, id: 4 }, { client: wrong })).rejects.toThrow("invalid response");
  }
});

it("receiptResponseにはcompany_idがなくても証憑を取得でき、dealの事業所照合は維持する", async () => {
  const receipt = { id: 5, status: "confirmed", mime_type: "application/pdf", origin: "public_api", created_at: "2026-01-15T09:00:00+09:00", user: null };
  const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ receipt })));
  const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn });
  expect(await runReceiptsGet({ companyId: 1, id: 5 }, { client })).toEqual(receipt);
  expect(new URL(fetchFn.mock.calls[0]![0]).pathname).toBe("/api/1/receipts/5");
  expect(new URL(fetchFn.mock.calls[0]![0]).search).toBe("?company_id=1");
  for (const payload of [{ receipt: { ...receipt, id: 6 } }, { deal: { id: 5 } }]) {
    fetchFn.mockResolvedValueOnce(new Response(JSON.stringify(payload)));
    await expect(("receipt" in payload ? runReceiptsGet : runDealsGet)({ companyId: 1, id: 5 }, { client })).rejects.toThrow("invalid response");
  }
});
