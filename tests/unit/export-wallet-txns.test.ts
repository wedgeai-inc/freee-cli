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
