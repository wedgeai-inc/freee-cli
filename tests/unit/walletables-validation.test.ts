import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli.js";
import { formatWalletablesList, runWalletablesList } from "../../src/commands/walletables/list.js";
import { runExportWalletTxns } from "../../src/commands/export/wallet-txns.js";
import { parsePositiveIntegerOption } from "../../src/lib/company-id.js";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(fetchMock: ReturnType<typeof vi.fn>): PublicFreeeClient {
  return new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "t", fetchFn: fetchMock as typeof fetch });
}

const exportBase = { companyId: 1, startDate: "2026-02-01", endDate: "2026-02-28", outDir: "/out", sourceName: "x" };

describe("parsePositiveIntegerOption", () => {
  it("正の整数を数値にする", () => {
    expect(parsePositiveIntegerOption("42", "--walletable-id")).toBe(42);
  });

  it.each(["", "0", "-1", "1.5", "abc", " 1", "9007199254740992"])("%j をオプション名つきで拒否する", (value) => {
    expect(() => parsePositiveIntegerOption(value, "--walletable-id")).toThrow("--walletable-id");
    expect(() => parsePositiveIntegerOption(value, "--walletable-id")).not.toThrow("--company-id");
  });
});

describe("export wallet-txns CLI（認証前の検査）", () => {
  const run = (...extra: string[]) =>
    createProgram().parseAsync(["node", "freee", "export", "wallet-txns", "--company-id", "1", "--out", "/tmp/x", "--month", "2026-02", ...extra]);

  it("不正な --walletable-id は --walletable-id を名指しして拒否する", async () => {
    await expect(run("--walletable-id", "abc", "--walletable-type", "bank_account")).rejects.toThrow("--walletable-id");
  });

  it("口座の片方だけの指定は認証前に拒否する", async () => {
    await expect(run("--walletable-id", "5")).rejects.toThrow(/walletable/);
    await expect(run("--walletable-type", "bank_account")).rejects.toThrow(/walletable/);
  });

  it("未知の --walletable-type は認証前に拒否する", async () => {
    await expect(run("--walletable-id", "5", "--walletable-type", "bank")).rejects.toThrow(/walletable type/);
  });

  it("未知の --entry-side は認証前に拒否する", async () => {
    await expect(run("--entry-side", "INCOME")).rejects.toThrow(/entry side/);
  });
});

describe("walletables list CLI（認証前の検査）", () => {
  it("未知の --type は認証前に拒否する", async () => {
    await expect(
      createProgram().parseAsync(["node", "freee", "walletables", "list", "--company-id", "1", "--type", "bank"]),
    ).rejects.toThrow(/type must be/);
  });
});

describe("runExportWalletTxns の直接呼び出し", () => {
  it.each([0, -1, 1.5, Number.NaN])("walletableId %s は API を呼ぶ前に拒否する", async (walletableId) => {
    const fetchMock = vi.fn();
    await expect(
      runExportWalletTxns(
        { ...exportBase, walletableId, walletableType: "bank_account" },
        { client: clientWith(fetchMock), ensureDir: async () => {}, writeFile: async () => {} },
      ),
    ).rejects.toThrow(/walletable id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("空文字の walletableType は API を呼ぶ前に拒否する", async () => {
    const fetchMock = vi.fn();
    await expect(
      runExportWalletTxns(
        { ...exportBase, walletableId: 5, walletableType: "" },
        { client: clientWith(fetchMock), ensureDir: async () => {}, writeFile: async () => {} },
      ),
    ).rejects.toThrow(/walletable type/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("walletables list の応答と表示", () => {
  it.each([undefined, 0, "abc", -3])("id が %j の口座を含む応答は拒否する", async (id) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ walletables: [{ id, name: "A", type: "wallet" }] }));
    await expect(runWalletablesList({ companyId: 1 }, { client: clientWith(fetchMock) })).rejects.toThrow(/id/);
  });

  it("table 出力では名前のタブ・改行を空白に置き換える", () => {
    const text = formatWalletablesList(
      { items: [{ id: 1, type: "wallet", name: "A\tB\nC\r\nD", sync_status: "success" }] },
      "table",
    );
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1].split("\t")).toHaveLength(5);
    expect(lines[1]).toContain("A B C D");
  });
});
