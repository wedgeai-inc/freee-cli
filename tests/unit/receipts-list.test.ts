import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerAccountingCommands } from "../../src/commands/accounting-cli.js";
import { runReceiptsList } from "../../src/commands/receipts/list.js";
import { createReadOnlyClient } from "../../src/lib/clients/read-only-client.js";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";

const base = { companyId: 1, startDate: "2026-02-01", endDate: "2026-02-28" };
const receipt = { id: 2, status: "confirmed", mime_type: "application/pdf", origin: "public_api", created_at: "2026-02-03T09:00:00+09:00", user: { id: 3, email: "dummy@example.invalid", display_name: "架空ユーザー" }, description: "架空メモ" };
const jsonRes = (body: unknown) => new Response(JSON.stringify(body));
const clientWith = (fetchFn: ReturnType<typeof vi.fn>) => createReadOnlyClient({ api: "accounting", token: "dummy-token", fetchFn: fetchFn as typeof fetch });
afterEach(() => vi.restoreAllMocks());

it("必須と任意の検索条件をGETで送り、証憑の全項目をそのまま返す", async () => {
  const fetchFn = vi.fn().mockResolvedValue(jsonRes({ receipts: [receipt] }));
  const result = await runReceiptsList({ ...base, userName: "架空", number: 4, commentType: "posted", commentImportant: true, category: "with_deal", limit: 3000, offset: 0 }, { client: clientWith(fetchFn) });
  expect(result).toEqual({ items: [receipt] });
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(new URL(fetchFn.mock.calls[0]![0]).pathname).toBe("/api/1/receipts");
  expect(Object.fromEntries(new URL(fetchFn.mock.calls[0]![0]).searchParams)).toEqual({ company_id: "1", start_date: base.startDate, end_date: base.endDate, user_name: "架空", number: "4", comment_type: "posted", comment_important: "true", category: "with_deal", limit: "3000", offset: "0" });
  expect(fetchFn.mock.calls[0]![1].method).toBe("GET");
});

it("ページ指定なしでは全ページを連結し、検索条件を各ページに維持する", async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ ...receipt, id: i + 1 }));
  const fetchFn = vi.fn().mockResolvedValueOnce(jsonRes({ receipts: first })).mockResolvedValueOnce(jsonRes({ receipts: [receipt] }));
  expect(await runReceiptsList({ ...base, userName: "架空" }, { client: clientWith(fetchFn) })).toEqual({ items: [...first, receipt] });
  expect(fetchFn.mock.calls.map(call => Object.fromEntries(new URL(call[0]).searchParams))).toEqual([0, 100].map(offset => ({ company_id: "1", start_date: base.startDate, end_date: base.endDate, user_name: "架空", limit: "100", offset: String(offset) })));
});

it("CLIから全フィルターを指定してJSON配列を出力する", async () => {
  const fetchFn = vi.fn().mockResolvedValue(jsonRes({ receipts: [receipt] }));
  const getClient = vi.fn(async () => new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "dummy-token", fetchFn }));
  const getReadOnlyClient = vi.fn(async () => clientWith(fetchFn));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const program = new Command().exitOverride();
  registerAccountingCommands(program, getClient, getReadOnlyClient);
  await program.parseAsync(["receipts", "list", "--company-id", "1", "--start-date", base.startDate, "--end-date", base.endDate, "--user-name", "架空", "--number", "4", "--comment-type", "raised", "--comment-important", "--category", "ignored", "--limit", "1", "--offset", "2"], { from: "user" });
  expect(getClient).not.toHaveBeenCalled();
  expect(getReadOnlyClient).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0]![0])).toEqual([receipt]);
  expect(Object.fromEntries(new URL(fetchFn.mock.calls[0]![0]).searchParams)).toEqual({ company_id: "1", start_date: base.startDate, end_date: base.endDate, user_name: "架空", number: "4", comment_type: "raised", comment_important: "true", category: "ignored", limit: "1", offset: "2" });
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it.each([
  { flags: [], expected: undefined },
  { flags: ["--comment-important"], expected: true },
  { flags: ["--no-comment-important"], expected: false },
])("CLIのコメント重要度指定$flagsをGETクエリへ渡す", async ({ flags, expected }) => {
  const fetchFn = vi.fn().mockResolvedValue(jsonRes({ receipts: [] }));
  const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "dummy-token", fetchFn });
  const get = vi.spyOn(client, "get");
  const getClient = vi.fn(async () => client);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  const getReadOnlyClient = vi.fn(async () => client);
  registerAccountingCommands(program, getClient, getReadOnlyClient);
  await program.parseAsync(["receipts", "list", "--company-id", "1", "--start-date", base.startDate, "--end-date", base.endDate, ...flags], { from: "user" });
  expect(getClient).not.toHaveBeenCalled();
  expect(getReadOnlyClient).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledWith("/api/1/receipts", { query: expect.objectContaining({ comment_important: expected }) });
  const query = new URL(fetchFn.mock.calls[0]![0]).searchParams;
  if (expected === undefined) expect(query.has("comment_important")).toBe(false);
  else expect(query.get("comment_important")).toBe(String(expected));
});

it("不正な日付はCLIの認証読み込みと直接呼び出しのGETより前に拒否する", async () => {
  const fetchFn = vi.fn();
  await expect(runReceiptsList({ ...base, startDate: "2026-02-30" }, { client: clientWith(fetchFn) })).rejects.toThrow(/start_date/);
  expect(fetchFn).not.toHaveBeenCalled();
  const getClient = vi.fn();
  const program = new Command().exitOverride();
  registerAccountingCommands(program, getClient, vi.fn());
  await expect(program.parseAsync(["receipts", "list", "--company-id", "1", "--start-date", "2026-02-30", "--end-date", base.endDate], { from: "user" })).rejects.toThrow(/start_date/);
  expect(getClient).not.toHaveBeenCalled();
});

const invalidOptions = [
  ["companyId", 0, "company_id"], ["companyId", Number.NaN, "company_id"],
  ["startDate", "2026-2-01", "start_date"], ["endDate", "2026-02-29", "end_date"],
  ["startDate", "2026-03-01", "start_date"],
  ["number", 0, "number"], ["number", -1, "number"], ["number", 1.5, "number"], ["number", Number.MAX_SAFE_INTEGER + 1, "number"],
  ["limit", 0, "limit"], ["limit", 3001, "limit"], ["limit", 1.5, "limit"], ["limit", Number.NaN, "limit"],
  ["offset", -1, "offset"], ["offset", 1.5, "offset"], ["offset", Number.MAX_SAFE_INTEGER + 1, "offset"],
  ["commentType", "unknown", "comment_type"], ["category", "unknown", "category"],
] as const;

it.each(invalidOptions)("%s=%sをGET前に拒否する", async (key, value, label) => {
  const fetchFn = vi.fn();
  await expect(runReceiptsList({ ...base, [key]: value } as Parameters<typeof runReceiptsList>[0], { client: clientWith(fetchFn) })).rejects.toThrow(label);
  expect(fetchFn).not.toHaveBeenCalled();
});

it.each(["", " ", "0x10", "1e2", "+1", "1.0", "-1", "abc", "9007199254740992"])("不正なoffset=%jを認証前に拒否する", async value => {
  const getClient = vi.fn();
  const program = new Command().exitOverride();
  registerAccountingCommands(program, getClient, vi.fn());
  await expect(program.parseAsync(["receipts", "list", "--company-id", "1", "--start-date", base.startDate, "--end-date", base.endDate, "--offset", value], { from: "user" })).rejects.toThrow(/offset/);
  expect(getClient).not.toHaveBeenCalled();
});

it.each([
  ["--company-id", "0", "company-id"], ["--start-date", "2026-03-01", "start_date"], ["--end-date", "2026-02-29", "end_date"],
  ["--number", "0", "number"], ["--number", "1.5", "number"], ["--number", "abc", "number"],
  ["--limit", "3001", "limit"], ["--limit", "0", "limit"], ["--limit", "1e2", "limit"],
  ["--comment-type", "unknown", "comment_type"], ["--category", "unknown", "category"],
])("%s=%sを認証前に拒否する", async (flag, value, label) => {
  const getClient = vi.fn();
  const program = new Command().exitOverride();
  registerAccountingCommands(program, getClient, vi.fn());
  await expect(program.parseAsync(["receipts", "list", "--company-id", "1", "--start-date", base.startDate, "--end-date", base.endDate, flag, value], { from: "user" })).rejects.toThrow(label);
  expect(getClient).not.toHaveBeenCalled();
});

it.each(["--company-id", "--start-date", "--end-date"])("必須の%sがないと認証を読まない", async flag => {
  const getClient = vi.fn();
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerAccountingCommands(program, getClient, vi.fn());
  const args = ["--company-id", "1", "--start-date", base.startDate, "--end-date", base.endDate];
  args.splice(args.indexOf(flag), 2);
  await expect(program.parseAsync(["receipts", "list", ...args], { from: "user" })).rejects.toThrow(flag);
  expect(getClient).not.toHaveBeenCalled();
});

it.each([null, {}, { receipts: {} }, { receipts: null }, { receipts: [null] }, { receipts: [[]] }])("不正な応答%jを拒否する", async payload => {
  const fetchFn = vi.fn().mockResolvedValue(jsonRes(payload));
  await expect(runReceiptsList(base, { client: clientWith(fetchFn) })).rejects.toThrow("invalid response: /api/1/receipts");
});

it.each([{ limit: 1 }, { offset: 0 }, { offset: 100 }])("ページ指定%jでは満杯でも1ページだけ取得する", async paging => {
  const limit = paging.limit ?? 100;
  const rows = Array.from({ length: limit }, (_, i) => ({ id: i + 1 }));
  const fetchFn = vi.fn().mockResolvedValue(jsonRes({ receipts: rows }));
  expect(await runReceiptsList({ ...base, ...paging }, { client: clientWith(fetchFn) })).toEqual({ items: rows });
  expect(fetchFn).toHaveBeenCalledTimes(1);
  const query = new URL(fetchFn.mock.calls[0]![0]).searchParams;
  expect(query.get("limit")).toBe(String(limit));
  expect(query.get("offset")).toBe(String(paging.offset ?? 0));
  for (const key of ["user_name", "number", "comment_type", "comment_important", "category"]) expect(query.has(key)).toBe(false);
});

it.each(["all", "without_deal", "with_expense_application_line", "with_deal", "ignored"] as const)("category=%sとコメント状態を受け付ける", async category => {
  for (const commentType of ["posted", "raised", "resolved"] as const) {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ receipts: [] }));
    expect(await runReceiptsList({ ...base, category, commentType, commentImportant: false }, { client: clientWith(fetchFn) })).toEqual({ items: [] });
    const query = new URL(fetchFn.mock.calls[0]![0]).searchParams;
    expect(query.get("category")).toBe(category);
    expect(query.get("comment_type")).toBe(commentType);
    expect(query.get("comment_important")).toBe("false");
  }
});

it("読み取り専用の公開口から一覧を利用できる", async () => {
  const reader = await import("../../src/reader.js");
  expect(reader).toHaveProperty("runReceiptsList", runReceiptsList);
});
