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
  logDir = await mkdtemp(join(tmpdir(), "freee-create-deal-cli-"));
  previousExitCode = process.exitCode;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-15T00:00:00Z"));
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers(); vi.mocked(loadApiAuth).mockClear();
  process.exitCode = previousExitCode;
  await rm(logDir, { recursive: true });
});
const args = ["wallet-txns", "create-deal", "8", "--company-id", "1", "--partner-id", "3", "--account-item-id", "4", "--tax-code", "0", "--amount", "123"];
it.each([true, false])("CLIのdry-runはガード成立%sに応じた終了コードとマスク済み監査を返す", async valid => {
  process.exitCode = 0;
  const fetchFn = vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    return new Response(JSON.stringify(path.includes("wallet_txns/") ? { wallet_txn: { id: 8, company_id: 1, date: "2026-01-15", amount: 123, due_amount: 123, status: valid ? 1 : 2, entry_side: "expense" } }
      : path === "/api/1/deals" ? { deals: [] }
      : path.includes("partners/") ? { partner: { id: 3, company_id: 1, name: "架空取引先" } }
      : path.includes("account_items") ? { account_items: [{ id: 4, name: "架空科目" }] } : { taxes: [{ code: 0, name: "架空税区分" }] }));
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await createProgram().parseAsync([...args, "--description", "fictional-private-description", "--log-dir", logDir, "--task-id", "sample"], { from: "user" });
  const result = JSON.parse(log.mock.calls[0]![0]);
  expect(result).toMatchObject({ mode: "dry-run", guards: { walletTxnUnreconciled: valid } });
  expect(process.exitCode).toBe(valid ? 0 : 1);
  expect(fetchFn.mock.calls.every(c => c[1]?.method === "GET")).toBe(true);
  const files = await readdir(logDir);
  expect(files).toEqual(["freee-wallet-txn-create-deal-2026-01-15.jsonl"]);
  const text = await readFile(join(logDir, files[0]!), "utf8");
  expect(text).not.toContain("fictional-private-description");
  expect(JSON.parse(text)).toMatchObject({ event: "wallet_txn_create_deal", target_id: 8, task_id: "sample", status: valid ? "planned" : "guard_failed" });
  if (!valid) expect(JSON.parse(text).guards).toEqual(result.guards);
});
it.each([
  ["--execute"], ["--amount", "0"], ["--amount", "1.5"], ["--partner-id", "0"],
  ["--account-item-id", "NaN"], ["--tax-code", "-1"], ["--tax-code", "1.5"], ["--tax-code", "2147483648"],
  ["--expect-amount", "NaN"], ["--issue-date", "2026-02-30"], ["--expect-date", "bad"],
].map(extra => [extra]))("CLI不正入力%jは認証前に停止する", async extra => {
  const fetchFn = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
  await expect(createProgram().exitOverride().parseAsync([...args, ...extra, "--log-dir", logDir], { from: "user" })).rejects.toThrow();
  expect(loadApiAuth).not.toHaveBeenCalled();
  expect(fetchFn).not.toHaveBeenCalled();
  expect(await readdir(logDir)).toEqual([]);
});
it.each(["--partner-id", "--account-item-id", "--tax-code", "--amount"])("必須%sを省略すると認証前に拒否する", async option => {
  const filtered = [...args];
  filtered.splice(filtered.indexOf(option), 2);
  await expect(createProgram().exitOverride().configureOutput({ writeErr: () => {} }).parseAsync(filtered, { from: "user" })).rejects.toThrow();
  expect(loadApiAuth).not.toHaveBeenCalled();
});
it("CLI executeは1回POSTし読み戻しと作成ID入り監査を返す", async () => {
  let posted = false;
  const fetchFn = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "POST") { posted = true; return new Response(JSON.stringify({ deal_ids: [6] })); }
    return new Response(JSON.stringify(path.includes("wallet_txns/") ? { wallet_txn: { id: 8, company_id: 1, date: "2026-01-15", amount: 123, due_amount: posted ? 0 : 123, status: posted ? 2 : 1, entry_side: "income" } }
      : path === "/api/1/deals" ? { deals: [] }
      : path === "/api/1/deals/6" ? { deal: { id: 6, company_id: 1, partner_id: 3, amount: 123, issue_date: "2026-01-15" } }
      : path.includes("partners/") ? { partner: { id: 3, company_id: 1, name: "架空取引先" } }
      : path.includes("account_items") ? { account_items: [{ id: 4, name: "架空科目" }] } : { taxes: [{ code: 0, name: "架空税区分" }] }));
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await createProgram().parseAsync([...args, "--execute", "--expect-amount", "123", "--expect-date", "2026-01-15", "--issue-date", "2026-01-15", "--log-dir", logDir], { from: "user" });
  const result = JSON.parse(log.mock.calls[0]![0]);
  expect(result.created).toEqual({ deal_ids: [6] });
  expect(Object.values(result.readback).every(Boolean)).toBe(true);
  expect(fetchFn.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(1);
  const entries = (await readFile(join(logDir, (await readdir(logDir))[0]!), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(entries.map(e => e.status)).toEqual(["attempting", "succeeded"]);
  expect(entries[1]).toMatchObject({ target_id: 8, created_id: 6 });
});
