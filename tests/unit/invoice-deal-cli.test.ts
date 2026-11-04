import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerAccountingCommands } from "../../src/commands/accounting-cli.js";

afterEach(() => vi.restoreAllMocks());
const args = ["deals", "create", "--company-id", "1", "--type", "income", "--issue-date", "2026-01-15", "--partner-id", "2", "--detail", "account_item_id=3,tax_code=4,amount=1500"];
it("CLIは請求書指定・確認番号をdry-runとexecuteの両方で認証前に拒否する", async () => {
  for (const option of [["--invoice-id", "8"], ["--expect-invoice-number", "SAMPLE-8"], ["--invoice-id", "8", "--expect-invoice-number", "SAMPLE-8"]]) {
    for (const mode of [[], ["--execute"]]) {
      const getClient = vi.fn().mockRejectedValue(new Error("認証に到達"));
      const fetchFn = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("通信に到達"));
      const program = new Command();
      registerAccountingCommands(program, getClient, getClient);
      await expect(program.parseAsync([...args, ...option, ...mode], { from: "user" })).rejects.toThrow(/公開API.*紐付け.*Web画面/);
      expect(getClient).not.toHaveBeenCalled();
      expect(fetchFn).not.toHaveBeenCalled();
    }
  }
});

it("CLIの取引一覧は管理番号を渡し、JSON配列を維持する", async () => {
  const { PublicFreeeClient } = await import("../../src/lib/clients/freee-public-client.js");
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({ deals: [{ id: 6, ref_number: "SAMPLE-8" }, { id: 7, ref_number: "SAMPLE-80" }] })));
  const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn });
  const getClient = vi.fn(async () => client);
  const program = new Command();
  registerAccountingCommands(program, getClient, getClient);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await program.parseAsync(["deals", "list", "--company-id", "1", "--ref-number", "SAMPLE-8"], { from: "user" });
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual([{ id: 6, ref_number: "SAMPLE-8", signed_totals: { amount: null, vat: null } }]);
});

it("CLIは空の管理番号を認証前に拒否し、0件・複数件では結果を出力しない", async () => {
  const { PublicFreeeClient } = await import("../../src/lib/clients/freee-public-client.js");
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({ deals: [] })));
  const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn });
  const getClient = vi.fn(async () => client);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  for (const refNumber of ["", " ", "　"]) {
    const program = new Command().exitOverride();
    registerAccountingCommands(program, getClient, getClient);
    await expect(program.parseAsync(["deals", "list", "--company-id", "1", "--ref-number", refNumber], { from: "user" })).rejects.toThrow(/--ref-number.*空/);
  }
  expect(getClient).not.toHaveBeenCalled();
  for (const count of [0, 2]) {
    fetchFn.mockImplementation(async () => new Response(JSON.stringify({ deals: Array.from({ length: count }, (_, i) => ({ id: i + 1, ref_number: "SAMPLE-8" })) })));
    const program = new Command().exitOverride();
    registerAccountingCommands(program, getClient, getClient);
    await expect(program.parseAsync(["deals", "list", "--company-id", "1", "--ref-number", "SAMPLE-8"], { from: "user" })).rejects.toThrow(`${count}件`);
  }
  expect(log).not.toHaveBeenCalled();
});
