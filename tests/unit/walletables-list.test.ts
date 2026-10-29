import { describe, expect, it, vi } from "vitest";
import { formatWalletablesList, runWalletablesList } from "../../src/commands/walletables/list.js";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(fetchMock: ReturnType<typeof vi.fn>): PublicFreeeClient {
  return new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "t", fetchFn: fetchMock });
}

describe("runWalletablesList", () => {
  it("GET /api/1/walletables を同期状況と最終同期日時つきで1回だけ呼ぶ", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      expect(u.pathname).toBe("/api/1/walletables");
      expect(u.searchParams.get("company_id")).toBe("1234567");
      expect(u.searchParams.get("with_sync_status")).toBe("true");
      expect(u.searchParams.get("with_last_synced_at")).toBe("true");
      expect(u.searchParams.has("type")).toBe(false);
      return jsonRes({
        walletables: [
          { id: 11, name: "Bank A", bank_id: 3, type: "bank_account", sync_status: "success", last_synced_at: "2026-02-01T09:00:00+09:00" },
          { id: 12, name: "Cash", bank_id: 0, type: "wallet", sync_status: "disabled" },
        ],
      });
    });

    const result = await runWalletablesList({ companyId: 1234567 }, { client: clientWith(fetchMock) });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual([
      { id: 11, type: "bank_account", name: "Bank A", sync_status: "success", last_synced_at: "2026-02-01T09:00:00+09:00" },
      { id: 12, type: "wallet", name: "Cash", sync_status: "disabled" },
    ]);
  });

  it("--type を指定したら type クエリを付ける", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      expect(new URL(String(url)).searchParams.get("type")).toBe("bank_account");
      return jsonRes({ walletables: [] });
    });

    await expect(
      runWalletablesList({ companyId: 1, type: "bank_account" }, { client: clientWith(fetchMock) }),
    ).resolves.toEqual({ items: [] });
  });

  it("未知の type は API を呼ぶ前に拒否する", async () => {
    const fetchMock = vi.fn();
    await expect(
      runWalletablesList({ companyId: 1, type: "bank" as never }, { client: clientWith(fetchMock) }),
    ).rejects.toThrow(/type/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Summary にない項目（残高など）を出力へ素通ししない", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({ walletables: [{ id: 1, name: "A", bank_id: 9, type: "wallet", walletable_balance: 999, last_balance: 1 }] }),
    );
    const result = await runWalletablesList({ companyId: 1 }, { client: clientWith(fetchMock) });
    expect(JSON.stringify(result.items)).not.toContain("999");
  });

  it("table 形式で id・type・name・sync_status・last_synced_at を並べる", () => {
    const text = formatWalletablesList(
      { items: [{ id: 11, type: "bank_account", name: "Bank A", sync_status: "success", last_synced_at: "2026-02-01T09:00:00+09:00" }] },
      "table",
    );
    expect(text.split("\n")[0]).toMatch(/id.*type.*name.*sync_status.*last_synced_at/);
    expect(text).toContain("Bank A");
    expect(text).toContain("2026-02-01T09:00:00+09:00");
  });
});
