import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerAccountingCommands } from "../../src/commands/accounting-cli.js";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { createProgram } from "../../src/cli.js";
import { parseRuntimePlan } from "../../src/lib/runtime-oauth.js";
vi.mock("../../src/lib/token-config-loader.js", () => ({ loadApiAuth: vi.fn(async () => ({ accessToken: "test-token" })) }));
afterEach(() => vi.restoreAllMocks());
it("8コマンドをCLIから利用でき、runtime OAuthはreceiptsと旧export形式を区別する", async () => {
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
      ["deals", "attach-receipt", "6", "--receipt-id", "5", "--log-dir", dir],
      ["receipts", "upload", "--file", join(dir, "sample.pdf"), "--issue-date", "2026-01-15", "--log-dir", dir],
    ].map(args => [...args, "--company-id", "1"]);
    expect(parseRuntimePlan(JSON.stringify({ commands }))).toEqual(commands);
    for (const args of commands) await createProgram().parseAsync(args, { from: "user" });
    expect(log).toHaveBeenCalledTimes(8);
    expect(fetchFn.mock.calls.every(c => c[1]?.method === "GET")).toBe(true);
    expect(parseRuntimePlan(JSON.stringify({ commands: [["receipts", "--company-id", "1", "--out", "sample"]] }))[0]).toEqual(["export", "receipts", "--company-id", "1", "--out", "sample"]);
  } finally { await rm(dir, { recursive: true }); }
});

it("負の取引合計もexpect-totalで完全一致を確認して証憑を追加できる", async () => {
  const dir = await mkdtemp(join(tmpdir(), "freee-cli-negative-test-"));
  try {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ deal: init?.method === "PUT" ? { id: 6 } : { id: 6, company_id: 1, type: "expense", issue_date: "2026-01-15", amount: -300, details: [{ id: 9, account_item_id: 3, tax_code: 0, amount: -300, vat: 0 }], receipts: [] } })));
    const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn: fetchFn as typeof fetch });
    const program = new Command();
    registerAccountingCommands(program, async () => client);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await program.parseAsync(["deals", "attach-receipt", "6", "--company-id", "1", "--receipt-id", "5", "--expect-total", "-300", "--execute", "--log-dir", dir], { from: "user" });
    expect(fetchFn.mock.calls.filter(c => c[1]?.method === "PUT")).toHaveLength(1);
  } finally { await rm(dir, { recursive: true }); }
});
