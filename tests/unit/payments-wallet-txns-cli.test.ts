import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProgram } from "../../src/cli.js";
import { loadApiAuth } from "../../src/lib/token-config-loader.js";
vi.mock("../../src/lib/token-config-loader.js", () => ({ loadApiAuth: vi.fn(async () => ({ accessToken: "dummy" })) }));
afterEach(() => { vi.restoreAllMocks(); vi.mocked(loadApiAuth).mockClear(); });

it("wallet-txns listは全フィルターをクエリへ渡しJSON配列を表示する", async () => {
  const fetchFn = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ wallet_txns: [{ id: 9, balance: null }] })));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await createProgram().parseAsync(["wallet-txns", "list", "--company-id", "1", "--walletable-type", "bank_account", "--walletable-id", "2", "--start-date", "2026-01-01", "--end-date", "2026-01-31", "--entry-side", "income", "--sort-type", "created_at_desc", "--limit", "1", "--offset", "0"], { from: "user" });
  const url = new URL(String(fetchFn.mock.calls[0]![0]));
  expect(url.pathname).toBe("/api/1/wallet_txns");
  expect(Object.fromEntries(url.searchParams)).toEqual({ company_id: "1", walletable_type: "bank_account", walletable_id: "2", start_date: "2026-01-01", end_date: "2026-01-31", entry_side: "income", sort_type: "created_at_desc", limit: "1", offset: "0" });
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(fetchFn.mock.calls[0]![1]?.method).toBe("GET");
  expect(JSON.parse(log.mock.calls[0]![0])).toEqual([{ id: 9, balance: null }]);
});

it("deals payments createをCLIから実行でき監査JSONLに取引IDを記録する", async () => {
  const dir = await mkdtemp(join(tmpdir(), "freee-payment-cli-"));
  try {
    const fetchFn = vi.spyOn(globalThis, "fetch").mockImplementation(async url => new Response(JSON.stringify(new URL(String(url)).pathname.endsWith("walletables") ? { walletables: [{ id: 2, type: "wallet", name: "架空口座" }] } : { deal: { id: 6, company_id: 1, due_amount: 123 } })));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["deals", "payments", "create", "6", "--company-id", "1", "--date", "2026-01-15", "--from-walletable-type", "wallet", "--from-walletable-id", "2", "--amount", "123", "--log-dir", dir, "--task-id", "sample"], { from: "user" });
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ mode: "dry-run", guards: { amountMatchesDue: true } });
    expect(fetchFn.mock.calls.every(c => c[1]?.method === "GET")).toBe(true);
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^freee-deal-payment-create-\d{4}-\d{2}-\d{2}\.jsonl$/);
    expect(JSON.parse(await readFile(join(dir, files[0]!), "utf8"))).toMatchObject({ event: "deal_payment_create", status: "planned", target_id: 6, task_id: "sample" });
  } finally { await rm(dir, { recursive: true }); }
});

const walletArgs = ["wallet-txns", "list", "--company-id", "1"];
const paymentArgs = ["deals", "payments", "create", "6", "--company-id", "1", "--date", "2026-01-15", "--from-walletable-type", "bank_account", "--from-walletable-id", "2", "--amount", "123"];
const invalidCliCases = [
  ...["--limit", "--walletable-id"].flatMap(flag => ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "1e2", " "].map(value => [...walletArgs, flag, value])),
  ...["-1", "0.5", "NaN", "Infinity", "9007199254740992", "1e2", " "].map(value => [...walletArgs, "--offset", value]),
  ...["--amount", "--from-walletable-id", "--expect-amount"].flatMap(flag => ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "1e2", " "].map(value => [...paymentArgs, flag, value])),
  [...walletArgs, "--walletable-type", "wallet"], [...walletArgs, "--start-date", "2026-02-30"],
  [...walletArgs, "--start-date", "2026-02-02", "--end-date", "2026-02-01"],
  [...walletArgs, "--entry-side", "other"], [...walletArgs, "--sort-type", "date_desc"],
  [...walletArgs, "--limit", "101"], [...paymentArgs, "--execute"],
  [...paymentArgs, "--date", "2026-02-30"], [...paymentArgs, "--from-walletable-type", "other"],
];
it.each(invalidCliCases.map(args => [args]))("不正なCLI入力%jを認証前に拒否する", async args => {
  const fetchFn = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
  await expect(createProgram().exitOverride().parseAsync(args, { from: "user" })).rejects.toThrow();
  expect(loadApiAuth).not.toHaveBeenCalled();
  expect(fetchFn).not.toHaveBeenCalled();
});

it("executeとexpect-amountをCLIから渡して1回だけ支払を送信する", async () => {
  const dir = await mkdtemp(join(tmpdir(), "freee-payment-execute-cli-"));
  try {
    const fetchFn = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => new Response(JSON.stringify(new URL(String(url)).pathname.endsWith("walletables") ? { walletables: [{ id: 2, type: "bank_account", name: "架空口座" }] } : { deal: { id: 6, company_id: 1, due_amount: init?.method === "POST" ? 0 : 123 } })));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync([...paymentArgs, "--execute", "--expect-amount", "123", "--log-dir", dir], { from: "user" });
    expect(fetchFn.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(1);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ mode: "execute", created: { id: 6 } });
    const entries = (await readFile(join(dir, (await readdir(dir))[0]!), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(entries.map(e => e.status)).toEqual(["attempting", "succeeded"]);
    expect(entries[1]).toMatchObject({ event: "deal_payment_create", target_id: 6, created_id: 6, write_state: "succeeded" });
  } finally { await rm(dir, { recursive: true }); }
});
