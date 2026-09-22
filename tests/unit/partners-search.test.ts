import { describe, expect, it, vi } from "vitest";
import { formatPartnersSearch, runPartnersSearch } from "../../src/commands/partners/search.js";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("runPartnersSearch", () => {
  it("keyword 指定時は company_id と keyword をクエリに載せて取得する", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/api/1/partners");
      expect(parsed.searchParams.get("company_id")).toBe("123");
      expect(parsed.searchParams.get("keyword")).toBe("Acme");
      expect(parsed.searchParams.get("limit")).toBe("100");
      expect(parsed.searchParams.get("offset")).toBe("0");
      return jsonRes({ partners: [{ id: 1, code: "A-1", name: "Acme", email: "a@example.com" }] });
    });
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "t",
      fetchFn: fetchMock,
    });

    await expect(runPartnersSearch({ companyId: 123, keyword: "Acme" }, { client })).resolves.toEqual({
      items: [{ id: 1, code: "A-1", name: "Acme", email: "a@example.com" }],
    });
  });

  it("keyword 未指定時は keyword をクエリに載せない", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get("company_id")).toBe("123");
      expect(parsed.searchParams.has("keyword")).toBe(false);
      return jsonRes({ partners: [] });
    });
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "t",
      fetchFn: fetchMock,
    });

    await expect(runPartnersSearch({ companyId: 123 }, { client })).resolves.toEqual({ items: [] });
  });

  it("2ページを跨いで全件を返す", async () => {
    const page1 = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, name: `Partner ${index + 1}` }));
    const page2 = [{ id: 101, name: "Partner 101" }];
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get("limit")).toBe("100");
      const offset = Number(parsed.searchParams.get("offset"));
      return jsonRes({ partners: offset === 0 ? page1 : offset === 100 ? page2 : [] });
    });
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "t",
      fetchFn: fetchMock,
    });

    const result = await runPartnersSearch({ companyId: 123 }, { client });

    expect(result.items).toHaveLength(101);
    expect(result.items[100]).toEqual({ id: 101, code: null, name: "Partner 101", email: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("table 形式では空の email を - として表示する", () => {
    const output = formatPartnersSearch(
      { items: [{ id: 1, code: null, name: "Acme", email: null }] },
      "table",
    );

    expect(output).toContain("1\t\t\t\tAcme\t\t-");
  });
});

describe("runPartnersSearch field mapping", () => {
  it("drops fields that are not part of PartnerSummary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({ partners: [{ id: 7, code: "P7", name: "取引先", email: "a@example.com", phone: "000", address_attributes: { zipcode: "1" } }] }),
    );
    const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "t", fetchFn: fetchMock });
    const result = await runPartnersSearch({ companyId: 1 }, { client });
    expect(result.items).toEqual([{ id: 7, code: "P7", name: "取引先", email: "a@example.com" }]);
  });
});

describe("formatPartnersSearch email placeholder", () => {
  it("shows - for empty string, null, and undefined email", () => {
    const out = formatPartnersSearch(
      { items: [{ id: 1, name: "A", email: "" }, { id: 2, name: "B", email: null }, { id: 3, name: "C" }] },
      "table",
    );
    const rows = out.split("\n").slice(1);
    expect(rows.every((r) => r.endsWith("\t\t-"))).toBe(true);
  });
});
