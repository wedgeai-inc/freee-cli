import { expect, it, vi } from "vitest";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { runDealsList } from "../../src/commands/deals/list.js";

it("管理番号は全ページ取得後に完全一致で絞り、既存のAPI検索条件と併用する", async () => {
  const match = { id: 101, ref_number: "SAMPLE-8" };
  const fetchFn = vi.fn(async (url: string) => new Response(JSON.stringify({ deals: new URL(url).searchParams.get("offset") === "0"
    ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, ref_number: ["SAMPLE-80", "sample-8", " SAMPLE-8 ", null][i % 4] }))
    : [match, { id: 102 }] })));
  const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn: fetchFn as typeof fetch });
  const result = await runDealsList({ companyId: 1, partnerId: 2, type: "income", startIssueDate: "2026-01-01", endIssueDate: "2026-01-31", status: "unsettled", refNumber: "SAMPLE-8" }, { client });
  expect(result).toEqual({ items: [match] });
  expect(fetchFn.mock.calls.map(([url]) => Object.fromEntries(new URL(url).searchParams))).toEqual([0, 100].map(offset => ({ company_id: "1", partner_id: "2", type: "income", start_issue_date: "2026-01-01", end_issue_date: "2026-01-31", status: "unsettled", limit: "100", offset: String(offset) })));
});

it("管理番号の一致が0件またはページをまたいだ複数件なら件数と対処を示す", async () => {
  for (const count of [0, 2, 3]) {
    const first = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, ref_number: count > 0 && i === 0 ? "SAMPLE-8" : "OTHER" }));
    const second = Array.from({ length: Math.max(0, count - 1) }, (_, i) => ({ id: i + 101, ref_number: "SAMPLE-8" }));
    const fetchFn = vi.fn(async (url: string) => new Response(JSON.stringify({ deals: new URL(url).searchParams.get("offset") === "0" ? first : second })));
    const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn: fetchFn as typeof fetch });
    await expect(runDealsList({ companyId: 1, refNumber: "SAMPLE-8" }, { client })).rejects.toThrow(count === 0 ? /0件.*管理番号.*請求書番号.*一致/ : new RegExp(`${count}件.*絞り込み条件`));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  }
});

it("空文字・空白だけの管理番号はAPI呼び出し前に拒否する", async () => {
  const fetchFn = vi.fn().mockRejectedValue(new Error("通信に到達"));
  const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn });
  for (const refNumber of ["", " ", "\t\n", "　"]) {
    await expect(runDealsList({ companyId: 1, refNumber }, { client })).rejects.toThrow(/--ref-number.*空/);
  }
  expect(fetchFn).not.toHaveBeenCalled();
});
