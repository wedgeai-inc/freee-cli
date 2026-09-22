import { describe, expect, it, vi } from "vitest";
import { formatCompaniesList, runCompaniesList } from "../../src/commands/companies/list.js";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("runCompaniesList", () => {
  it("GET /api/1/companies を1回だけ呼び、2件をtable形式で返す", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/api/1/companies");
      expect([...parsed.searchParams]).toEqual([]);
      return jsonRes({
        companies: [
          { id: 1, name: "Alpha", display_name: "Alpha Co.", role: "admin" },
          { id: 2, name: "Beta", display_name: "Beta Co.", role: "member" },
        ],
      });
    });
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "t",
      fetchFn: fetchMock,
    });

    const result = await runCompaniesList({ client });

    expect(result.items).toHaveLength(2);
    expect(formatCompaniesList(result, "table")).toContain("1");
    expect(formatCompaniesList(result, "table")).toContain("2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("companies キーがない payload は空配列として返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({}));
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "t",
      fetchFn: fetchMock,
    });

    await expect(runCompaniesList({ client })).resolves.toEqual({ items: [] });
  });
});

describe("runCompaniesList field mapping", () => {
  it("drops fields that are not part of CompanySummary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({ companies: [{ id: 1, name: "A", display_name: "A社", role: "admin", company_number: "abc", secret_flag: true, contact_email: "x@example.com" }] }),
    );
    const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "t", fetchFn: fetchMock });
    const result = await runCompaniesList({ client });
    expect(result.items[0]).toEqual({ id: 1, name: "A", display_name: "A社", role: "admin", company_number: "abc" });
    expect(JSON.stringify(result.items)).not.toContain("secret_flag");
  });
});
