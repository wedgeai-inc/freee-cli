import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgram } from "../../src/cli.js";
import { parseRuntimePlan } from "../../src/lib/runtime-oauth.js";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
vi.mock("../../src/lib/token-config-loader.js", () => ({ loadApiAuth: vi.fn(async () => ({ accessToken: "test-token" })) }));
afterEach(() => vi.restoreAllMocks());
it("9コマンドをCLIから利用でき、runtime OAuthはreceiptsと旧export形式を区別する", async () => {
  const dir = await mkdtemp(join(tmpdir(), "freee-cli-test-"));
  try {
    await writeFile(join(dir, "sample.pdf"), "fictional pdf");
    const fetchFn = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      const body = path.endsWith("account_items") ? { account_items: [{ id: 3, name: "架空科目" }] }
        : path.includes("taxes") ? { taxes: [{ code: 4, name: "架空税区分" }] }
        : path.includes("partners/") ? { partner: { id: 2, company_id: 1, name: "架空取引先" } }
        : path.endsWith("deals") ? { deals: [] }
        : path.includes("deals/") ? { deal: { id: 6, company_id: 1, type: "expense", issue_date: "2026-01-15", partner_id: 2, amount: 1500, details: [{ id: 9, account_item_id: 3, tax_code: 4, amount: 1500, vat: 136 }], receipts: [] } }
        : { receipt: { id: 5, company_id: 1 } };
      return new Response(JSON.stringify(body));
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const commands = [
      ["account-items", "list"], ["taxes", "list"], ["deals", "list", "--partner-id", "2", "--type", "expense", "--start-issue-date", "2026-01-01", "--end-issue-date", "2026-01-31", "--status", "unsettled"], ["deals", "get", "6"], ["receipts", "get", "5"],
      ["deals", "create", "--type", "expense", "--issue-date", "2026-01-15", "--partner-id", "2", "--detail", "account_item_id=3,tax_code=4,amount=1500", "--log-dir", dir],
      ["deals", "attach-receipt", "6", "--receipt-id", "5", "--log-dir", dir],
      ["receipts", "upload", "--file", join(dir, "sample.pdf"), "--issue-date", "2026-01-15", "--partner-name", "架空発行元", "--amount", "0", "--log-dir", dir],
      ["receipts", "update", "5", "--partner-name", "架空発行元", "--issue-date", "2026-01-15", "--amount", "-123", "--log-dir", dir],
    ].map(args => [...args, "--company-id", "1"]);
    expect(parseRuntimePlan(JSON.stringify({ commands }))).toEqual(commands);
    for (const args of commands) await createProgram().parseAsync(args, { from: "user" });
    expect(log).toHaveBeenCalledTimes(9);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ mode: "dry-run", payload: { company_id: 1, receipt_metadatum: { partner_name: "架空発行元", issue_date: "2026-01-15", amount: -123 } } });
    expect(fetchFn.mock.calls.every(c => c[1]?.method === "GET")).toBe(true);
    expect(parseRuntimePlan(JSON.stringify({ commands: [["receipts", "--company-id", "1", "--out", "sample"]] }))[0]).toEqual(["export", "receipts", "--company-id", "1", "--out", "sample"]);
  } finally { await rm(dir, { recursive: true }); }
});

it("deals get/listだけに符号付き金額を追加し、内部の読み取りとreceipts出力は保持する", async () => {
  const { PublicFreeeClient } = await import("../../src/lib/clients/freee-public-client.js");
  const { runDealsGet } = await import("../../src/commands/deals/get.js");
  const { runDealsList } = await import("../../src/commands/deals/list.js");
  const deal = { id: 6, company_id: 1, type: "income", details: [
    { amount: 1100, vat: 100, entry_side: "credit" },
    { amount: 220, vat: 20, entry_side: "debit" },
    { amount: 55, vat: 5 },
  ] };
  const fetchFn = vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    return new Response(JSON.stringify(path.endsWith("/deals") ? { deals: [deal] }
      : path.includes("/deals/") ? { deal } : { receipt: { id: 5 } }));
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const enriched = { ...deal, details: [
    { ...deal.details[0], signed_amount: 1100, signed_vat: 100 },
    { ...deal.details[1], signed_amount: -220, signed_vat: -20 },
    { ...deal.details[2], signed_amount: null, signed_vat: null },
  ], signed_totals: { amount: null, vat: null } };
  for (const args of [["deals", "get", "6"], ["deals", "list"], ["receipts", "get", "5"]]) {
    await createProgram().parseAsync([...args, "--company-id", "1"], { from: "user" });
  }
  expect(log.mock.calls.map(([value]) => JSON.parse(value))).toEqual([enriched, [enriched], { id: 5 }]);
  const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn });
  expect(await runDealsGet({ companyId: 1, id: 6 }, { client })).toEqual(deal);
  expect(await runDealsList({ companyId: 1 }, { client })).toEqual({ items: [deal] });
  expect(fetchFn.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
});

it("負の取引合計もexpect-totalで完全一致を確認して証憑を追加できる", async () => {
  const { Command } = await import("commander");
  const { registerAccountingCommands } = await import("../../src/commands/accounting-cli.js");
  const dir = await mkdtemp(join(tmpdir(), "freee-cli-negative-test-"));
  try {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ deal: init?.method === "PUT" ? { id: 6 } : { id: 6, company_id: 1, type: "expense", issue_date: "2026-01-15", amount: -300, details: [{ id: 9, account_item_id: 3, tax_code: 0, amount: -300, vat: -27 }], receipts: [] } })));
    const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn: fetchFn as typeof fetch });
    const program = new Command();
    registerAccountingCommands(program, async () => client, async () => client);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await program.parseAsync(["deals", "attach-receipt", "6", "--company-id", "1", "--receipt-id", "5", "--expect-total", "-300", "--execute", "--log-dir", dir], { from: "user" });
    expect(fetchFn.mock.calls.filter(c => c[1]?.method === "PUT")).toHaveLength(1);
    const payload = JSON.parse(fetchFn.mock.calls[1]![1]!.body as string);
    expect(payload.details).toEqual([{ id: 9, account_item_id: 3, tax_code: 0, amount: -300, vat: -27 }]);
  } finally { await rm(dir, { recursive: true }); }
});

it.each([[], ["--amount", "1.5"], ["--amount", "1e2"], ["--amount", ""], ["--amount", "1000000000000"], ["--issue-date", "2026-02-30"]].map(flags => [flags]))("receipts updateの不正入力%jは認証前に拒否", async flags => {
  const { loadApiAuth } = await import("../../src/lib/token-config-loader.js");
  vi.mocked(loadApiAuth).mockClear();
  await expect(createProgram().parseAsync(["receipts", "update", "5", "--company-id", "1", ...flags], { from: "user" })).rejects.toThrow(flags[0] === "--amount" ? "amount" : flags.length ? "issue_date" : "specify");
  expect(loadApiAuth).not.toHaveBeenCalled();
});
