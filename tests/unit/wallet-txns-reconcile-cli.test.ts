import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProgram } from "../../src/cli.js";
import { loadApiAuth } from "../../src/lib/token-config-loader.js";
vi.mock("../../src/lib/token-config-loader.js", () => ({ loadApiAuth: vi.fn(async () => ({ accessToken: "dummy" })) }));
let logDir: string;
let previousExitCode: typeof process.exitCode;
beforeEach(async () => {
  logDir = await mkdtemp(join(tmpdir(), "freee-payment-validation-cli-"));
  previousExitCode = process.exitCode;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-15T00:00:00Z"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.mocked(loadApiAuth).mockClear();
  process.exitCode = previousExitCode;
  await rm(logDir, { recursive: true });
});

const args = ["wallet-txns", "reconcile", "8", "--company-id", "1", "--deal-id", "6", "--amount", "123"];
it.each([true, false])("CLIのdry-runはガード成立%sで終了コードと監査JSONLを返す", async valid => {
  process.exitCode = 0;
  const fetchFn = vi.spyOn(globalThis, "fetch").mockImplementation(async url => new Response(JSON.stringify(new URL(String(url)).pathname.includes("wallet_txns/")
    ? { wallet_txn: { id: 8, company_id: 1, date: "2026-01-15", amount: 123, due_amount: 123, entry_side: "expense", status: valid ? 1 : 4, description: "fictional-private-description" } }
    : { deal: { id: 6, company_id: 1, type: "expense", issue_date: "2026-01-15", due_amount: 123, status: "unsettled", partner_id: null } })));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await createProgram().parseAsync([...args, "--expect-date", "2026-01-15", "--expect-amount", "123", "--log-dir", logDir, "--task-id", "sample"], { from: "user" });
  expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ mode: "dry-run", guards: { walletTxnUnreconciled: valid } });
  expect(log.mock.calls[0]![0]).not.toContain("description");
  expect(process.exitCode).toBe(valid ? 0 : 1);
  expect(fetchFn.mock.calls.every(c => c[1]?.method === "GET")).toBe(true);
  const files = await readdir(logDir);
  expect(files).toEqual(["freee-wallet-txn-reconcile-2026-01-15.jsonl"]);
  expect(JSON.parse(await readFile(join(logDir, files[0]!), "utf8"))).toMatchObject({ event: "wallet_txn_reconcile", target_id: 8, task_id: "sample", status: "planned", payload_redacted: { company_id: 1, deals: [{ deal_id: 6, amount: 123 }] } });
});
it.each([
  ["--execute"], ["--amount", "0"], ["--deal-id", "1.5"], ["--expect-amount", "NaN"], ["--expect-date", "2026-02-30"],
].map(extra => [extra]))("CLIの不正入力%jは認証前に拒否する", async extra => {
  const fetchFn = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
  await expect(createProgram().exitOverride().parseAsync([...args, ...extra, "--log-dir", logDir], { from: "user" })).rejects.toThrow();
  expect(loadApiAuth).not.toHaveBeenCalled();
  expect(fetchFn).not.toHaveBeenCalled();
});
it("CLIのexecuteでフラットな成功応答とcreated_idなしの監査を返す", async () => {
  const fetchFn = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => new Response(JSON.stringify(init?.method === "POST"
    ? { wallet_txn_id: 8, deal_ids: [6], new_deal_id: null }
    : new URL(String(url)).pathname.includes("wallet_txns/")
      ? { wallet_txn: { id: 8, company_id: 1, date: "2026-01-15", amount: 123, due_amount: 123, entry_side: "expense", status: 1 } }
      : { deal: { id: 6, company_id: 1, type: "expense", issue_date: "2026-01-15", due_amount: 123, status: "unsettled" } })));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await createProgram().parseAsync([...args, "--execute", "--expect-amount", "123", "--log-dir", logDir], { from: "user" });
  expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ created: { wallet_txn_id: 8, deal_ids: [6] } });
  expect(fetchFn.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(1);
  const entries = (await readFile(join(logDir, (await readdir(logDir))[0]!), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(entries.map(e => e.status)).toEqual(["attempting", "succeeded"]);
  expect(entries[1]).not.toHaveProperty("created_id");
});
