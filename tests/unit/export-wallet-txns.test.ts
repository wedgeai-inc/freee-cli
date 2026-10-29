import { describe, expect, it, vi } from "vitest";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { runExportWalletTxns } from "../../src/commands/export/wallet-txns.js";

function jsonRes(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("runExportWalletTxns", () => {
  it("exports paginated wallet transactions as json and csv", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 + i,
      date: "2026-02-01",
      amount: 100 + i,
      description: `row ${i}`,
      walletable_type: "wallet",
      walletable_id: 1001,
    }));
    const page2 = [
      {
        id: 2000,
        date: "2026-02-28",
        amount: 800,
        description: "last",
        walletable_type: "wallet",
        walletable_id: 1001,
      },
    ];
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      expect(u.pathname).toBe("/api/1/wallet_txns");
      expect(u.searchParams.get("walletable_id")).toBe("1001");
      expect(u.searchParams.get("walletable_type")).toBe("wallet");
      expect(u.searchParams.get("limit")).toBe("100");
      const offset = Number(u.searchParams.get("offset"));
      return jsonRes({ wallet_txns: offset === 0 ? page1 : offset === 100 ? page2 : [] });
    });

    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "t",
      fetchFn: fetchMock,
    });
    const writes: Array<{ path: string; data: string | Buffer }> = [];

    const result = await runExportWalletTxns(
      {
        companyId: 1234567,
        startDate: "2026-02-01",
        endDate: "2026-02-28",
        outDir: "/out/card/card-a",
        walletableId: 1001,
        walletableType: "wallet",
        sourceName: "card-a",
      },
      {
        client,
        ensureDir: async () => {},
        writeFile: async (path, data) => {
          writes.push({ path, data });
        },
      },
    );

    expect(result.total).toBe(101);
    expect(result.jsonPath).toBe("/out/card/card-a/wallet-txns.json");
    expect(result.csvPath).toBe("/out/card/card-a/wallet-txns.csv");
    expect(writes.some((w) => w.path.endsWith("wallet-txns.json"))).toBe(true);
    expect(writes.some((w) => w.path.endsWith("wallet-txns.csv") && String(w.data).includes('"source_name","walletable_type"'))).toBe(true);
  });
});

describe("runExportWalletTxns without walletable", () => {
  function emptyClient(onUrl: (u: URL) => void) {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      onUrl(new URL(String(url)));
      return jsonRes({ wallet_txns: [] });
    });
    return { fetchMock, client: new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "t", fetchFn: fetchMock }) };
  }
  const deps = { ensureDir: async () => {}, writeFile: async () => {} };

  it("口座を省いたら walletable_* をクエリに含めない", async () => {
    const { client, fetchMock } = emptyClient((u) => {
      expect(u.searchParams.has("walletable_id")).toBe(false);
      expect(u.searchParams.has("walletable_type")).toBe(false);
    });
    await runExportWalletTxns(
      { companyId: 1, startDate: "2026-02-01", endDate: "2026-02-28", outDir: "/out", sourceName: "all" },
      { client, ...deps },
    );
    expect(fetchMock).toHaveBeenCalled();
  });

  it("walletable の片方だけなら API を呼ぶ前に拒否する", async () => {
    const { client, fetchMock } = emptyClient(() => {});
    await expect(
      runExportWalletTxns(
        { companyId: 1, startDate: "2026-02-01", endDate: "2026-02-28", outDir: "/out", sourceName: "x", walletableId: 5 },
        { client, ...deps },
      ),
    ).rejects.toThrow(/walletable/);
    await expect(
      runExportWalletTxns(
        { companyId: 1, startDate: "2026-02-01", endDate: "2026-02-28", outDir: "/out", sourceName: "x", walletableType: "bank_account" },
        { client, ...deps },
      ),
    ).rejects.toThrow(/walletable/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("entrySide を指定したら entry_side を付ける", async () => {
    const { client } = emptyClient((u) => {
      expect(u.searchParams.get("entry_side")).toBe("income");
    });
    await runExportWalletTxns(
      { companyId: 1, startDate: "2026-02-01", endDate: "2026-02-28", outDir: "/out", sourceName: "all", entrySide: "income" },
      { client, ...deps },
    );
  });

  it("未知の entrySide は API を呼ぶ前に拒否する", async () => {
    const { client, fetchMock } = emptyClient(() => {});
    await expect(
      runExportWalletTxns(
        { companyId: 1, startDate: "2026-02-01", endDate: "2026-02-28", outDir: "/out", sourceName: "all", entrySide: "in" as never },
        { client, ...deps },
      ),
    ).rejects.toThrow(/entry/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
