import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgram } from "../../src/cli.js";
import { parseRuntimePlan } from "../../src/lib/runtime-oauth.js";
vi.mock("../../src/lib/token-config-loader.js", () => ({ loadApiAuth: vi.fn(async () => ({ accessToken: "test-token" })) }));
afterEach(() => vi.restoreAllMocks());
it("7コマンドをCLIから利用でき、runtime OAuthはreceiptsと旧export形式を区別する", async () => {
  const dir = await mkdtemp(join(tmpdir(), "freee-cli-test-"));
  try {
    await writeFile(join(dir, "sample.pdf"), "fictional pdf");
    const fetchFn = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      const body = path.endsWith("account_items") ? { account_items: [{ id: 3, name: "架空科目" }] }
        : path.includes("taxes") ? { taxes: [{ code: 4, name: "架空税区分" }] }
        : path.includes("partners/") ? { partner: { id: 2, company_id: 1, name: "架空取引先" } }
        : path.endsWith("deals") ? { deals: [] }
        : path.includes("deals/") ? { deal: { id: 6, company_id: 1, type: "expense", issue_date: "2026-01-15", partner_id: 2, amount: 1500, details: [{ id: 9, account_item_id: 3, tax_code: 4, amount: 1500 }], receipts: [] } }
        : { receipt: { id: 5, company_id: 1 } };
      return new Response(JSON.stringify(body));
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const commands = [
      ["account-items", "list"], ["taxes", "list"], ["deals", "list", "--partner-id", "2", "--type", "expense", "--start-issue-date", "2026-01-01", "--end-issue-date", "2026-01-31", "--status", "unsettled"], ["deals", "get", "6"], ["receipts", "get", "5"],
      ["deals", "create", "--type", "expense", "--issue-date", "2026-01-15", "--partner-id", "2", "--detail", "account_item_id=3,tax_code=4,amount=1500", "--log-dir", dir],
      ["receipts", "upload", "--file", join(dir, "sample.pdf"), "--issue-date", "2026-01-15", "--log-dir", dir],
    ].map(args => [...args, "--company-id", "1"]);
    expect(parseRuntimePlan(JSON.stringify({ commands }))).toEqual(commands);
    for (const args of commands) await createProgram().parseAsync(args, { from: "user" });
    expect(log).toHaveBeenCalledTimes(7);
    expect(fetchFn.mock.calls.every(c => c[1]?.method === "GET")).toBe(true);
    expect(parseRuntimePlan(JSON.stringify({ commands: [["receipts", "--company-id", "1", "--out", "sample"]] }))[0]).toEqual(["export", "receipts", "--company-id", "1", "--out", "sample"]);
  } finally { await rm(dir, { recursive: true }); }
});
