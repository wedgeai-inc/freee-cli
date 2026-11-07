import { afterEach, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli.js";
import { parseRuntimePlan } from "../../src/lib/runtime-oauth.js";
import { appendAccountingAudit } from "../../src/lib/audit/accounting-audit.js";

vi.mock("../../src/lib/token-config-loader.js", () => ({ loadApiAuth: vi.fn(async () => ({ accessToken: "synthetic-token" })) }));
vi.mock("../../src/lib/audit/accounting-audit.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/lib/audit/accounting-audit.js")>(),
  appendAccountingAudit: vi.fn().mockResolvedValue(undefined),
}));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

const commands = [
  ["wallet-txns", "list", "--company-id", "1"],
  ["walletables", "list", "--company-id", "1"],
  ["wallet-txns", "reconcile", "8", "--company-id", "1", "--deal-id", "6", "--amount", "123"],
  ["wallet-txns", "create-deal", "8", "--company-id", "1", "--partner-id", "3", "--account-item-id", "4", "--tax-code", "0", "--amount", "123"],
  ["deals", "payments", "create", "6", "--company-id", "1", "--date", "2026-01-15", "--from-walletable-type", "wallet", "--from-walletable-id", "2", "--amount", "123"],
];

it("許可した5コマンドは検証済みplanからCLIで動作し既定ではGETのみになる", async () => {
  const fetchFn = vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    const body = path.endsWith("/wallet_txns") ? { wallet_txns: [{ id: 8 }] }
      : path.endsWith("/walletables") ? { walletables: [{ id: 2, type: "wallet", name: "架空口座" }] }
      : path.endsWith("/wallet_txns/8") ? { wallet_txn: { id: 8, company_id: 1, date: "2026-01-15", amount: 123, due_amount: 123, entry_side: "expense", status: 1 } }
      : path.endsWith("/deals") ? { deals: [] }
      : path.endsWith("/partners/3") ? { partner: { id: 3, company_id: 1, name: "架空取引先" } }
      : path.endsWith("/account_items") ? { account_items: [{ id: 4, name: "架空科目" }] }
      : path.endsWith("/taxes/companies/1") ? { taxes: [{ code: 0, name: "架空税区分" }] }
      : { deal: { id: 6, company_id: 1, type: "expense", issue_date: "2026-01-15", due_amount: 123, status: "unsettled", partner_id: null } };
    return new Response(JSON.stringify(body));
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  for (const command of parseRuntimePlan(JSON.stringify({ commands }))) {
    await createProgram().exitOverride().parseAsync(command, { from: "user" });
  }
  expect(fetchFn.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    "/api/1/wallet_txns", "/api/1/walletables", "/api/1/wallet_txns/8", "/api/1/deals/6",
    "/api/1/wallet_txns/8", "/api/1/deals", "/api/1/partners/3", "/api/1/account_items", "/api/1/taxes/companies/1",
    "/api/1/deals/6", "/api/1/walletables",
  ]);
  expect(fetchFn.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  expect(log).toHaveBeenCalledTimes(5);
  for (const index of [2, 3, 4]) expect(JSON.parse(log.mock.calls[index]![0])).toMatchObject({ mode: "dry-run", guards: { expectedAmountMatches: true } });
  expect(vi.mocked(appendAccountingAudit).mock.calls.map(([, entry]) => [entry.event, entry.status])).toEqual([
    ["wallet_txn_reconcile", "planned"], ["wallet_txn_create_deal", "planned"], ["deal_payment_create", "planned"],
  ]);
});

it.each(commands.slice(2).map(command => [command]))("許可した書き込み%jもexecute時のexpect-amount必須ガードを維持する", async command => {
  const fetchFn = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
  const [args] = parseRuntimePlan(JSON.stringify({ commands: [[...command, "--execute"]] }));
  await expect(createProgram().exitOverride().parseAsync(args!, { from: "user" })).rejects.toThrow("--expect-amount is required with --execute");
  expect(fetchFn).not.toHaveBeenCalled();
  expect(appendAccountingAudit).not.toHaveBeenCalled();
});
