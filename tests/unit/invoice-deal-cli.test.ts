import { afterEach, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli.js";
import { appendDealAudit } from "../../src/lib/audit/deal-audit.js";
vi.mock("../../src/lib/token-config-loader.js", () => ({ loadApiAuth: vi.fn(async () => ({ accessToken: "test-token" })) }));
vi.mock("../../src/lib/audit/deal-audit.js", () => ({ appendDealAudit: vi.fn(async () => {}) }));
afterEach(() => vi.restoreAllMocks());
const args = ["deals", "create", "--company-id", "1", "--type", "income", "--issue-date", "2026-01-15", "--due-date", "2026-02-15", "--partner-id", "2", "--detail", "account_item_id=3,tax_code=4,amount=1500", "--invoice-id", "8", "--expect-invoice-number", "SAMPLE-8"];
function mockApi(registered = false) {
  let reads = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = path === "/iv/invoices/8" ? { invoice: { id: 8, company_id: 1, invoice_number: "SAMPLE-8", cancel_status: "uncanceled", deal_status: ++reads > 1 && registered ? "registered" : "unregistered", deal_id: reads > 1 && registered ? 6 : null, total_amount: 1500, partner_id: 2, billing_date: "2026-01-15", payment_date: "2026-02-15" } }
      : path.endsWith("account_items") ? { account_items: [{ id: 3, name: "架空科目" }] }
      : path.includes("taxes") ? { taxes: [{ code: 4, name: "架空税区分" }] }
      : path.includes("partners/") ? { partner: { id: 2, company_id: 1, name: "架空取引先" } }
      : init?.method === "POST" ? { deal: { id: 6, company_id: 1 } } : { deals: [] };
    return new Response(JSON.stringify(body));
  });
}
it("CLIの請求書確認オプションはdry-runで請求書を読み、POSTしない", async () => {
  const fetchFn = mockApi();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await createProgram().exitOverride().parseAsync(args, { from: "user" });
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ mode: "dry-run", invoiceCheck: { id: 8 } });
  expect(fetchFn.mock.calls.some(c => new URL(String(c[0])).pathname === "/iv/invoices/8")).toBe(true);
  expect(fetchFn.mock.calls.every(c => c[1]?.method === "GET")).toBe(true);
});
it("CLIのexecuteは請求書が未登録のままなら警告を含む例外を上位へ返す", async () => {
  const fetchFn = mockApi();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await expect(createProgram().parseAsync([...args, "--execute", "--expect-total", "1500"], { from: "user" })).rejects.toThrow(/警告.*作成済み.*再実行/);
  expect(fetchFn.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(1);
  expect(log).not.toHaveBeenCalled();
  expect(appendDealAudit).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ reason: "invoice_readback_failed", write_state: "succeeded", created_id: 6 }));
});
it("CLIのexecuteは登録と取引IDの一致を確認してJSONを返す", async () => {
  mockApi(true);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await createProgram().parseAsync([...args, "--execute", "--expect-total", "1500"], { from: "user" });
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ invoiceReadback: { deal_status: "registered", deal_id: 6 } });
});
it("CLI入口は請求書読み戻し失敗の警告を標準エラーに出し終了コード1を設定する", async () => {
  const previousArgs = process.argv;
  const previousExitCode = process.exitCode;
  mockApi();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    vi.resetModules();
    vi.doMock("../../src/lib/main-module.js", () => ({ isMainModule: () => true }));
    process.argv = [previousArgs[0]!, "synthetic-cli", ...args, "--execute", "--expect-total", "1500"];
    process.exitCode = undefined;
    await import("../../src/cli.js");
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/警告.*作成済み.*再実行/));
  } finally {
    process.argv = previousArgs;
    process.exitCode = previousExitCode;
    vi.doUnmock("../../src/lib/main-module.js");
    vi.resetModules();
  }
});
