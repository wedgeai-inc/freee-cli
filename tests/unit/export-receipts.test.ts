import { describe, expect, it, vi } from "vitest";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { runExportReceipts } from "../../src/commands/export/receipts.js";

function jsonRes(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function binRes(body: string, mime: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": mime } });
}

describe("runExportReceipts", () => {
  it("lists receipts, writes index.json, and downloads each file with correct extension", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({
          receipts: [
            { id: 101, mime_type: "image/jpeg" },
            { id: 102, mime_type: "application/pdf" },
          ],
        }),
      )
      .mockResolvedValueOnce(binRes("jpegdata", "image/jpeg"))
      .mockResolvedValueOnce(binRes("%PDF-1.4", "application/pdf"));

    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "t",
      fetchFn: fetchMock,
    });

    const writes: Array<{ path: string; isString: boolean }> = [];
    const dirs: string[] = [];
    const result = await runExportReceipts(
      { companyId: 1234567, startDate: "2026-02-01", endDate: "2026-02-28", outDir: "/out" },
      {
        client,
        ensureDir: async (p) => {
          dirs.push(p);
        },
        writeFile: async (p, data) => {
          writes.push({ path: p, isString: typeof data === "string" });
        },
      },
    );

    expect(result.total).toBe(2);
    expect(result.saved).toBe(2);
    expect(result.failed).toEqual([]);

    expect(writes.some((w) => w.path === "/out/index.json" && w.isString)).toBe(true);
    expect(writes.some((w) => w.path === "/out/files/101.jpg" && !w.isString)).toBe(true);
    expect(writes.some((w) => w.path === "/out/files/102.pdf" && !w.isString)).toBe(true);
    expect(dirs).toContain("/out/files");

    const listUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(listUrl).toContain("/api/1/receipts");
    expect(listUrl).toContain("company_id=1234567");
    expect(listUrl).toContain("start_date=2026-02-01");
    expect(listUrl).toContain("end_date=2026-02-28");

    const dlUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(dlUrl).toContain("/api/1/receipts/101/download");
    expect(dlUrl).toContain("company_id=1234567");
  });

  it("records failures and continues with remaining receipts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({
          receipts: [
            { id: 201, mime_type: "image/jpeg" },
            { id: 202, mime_type: "image/png" },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(binRes("pngdata", "image/png"));

    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "t",
      fetchFn: fetchMock,
    });

    const saved: string[] = [];
    const result = await runExportReceipts(
      { companyId: 1, startDate: "2026-02-01", endDate: "2026-02-28", outDir: "/o" },
      {
        client,
        ensureDir: async () => {},
        writeFile: async (p) => {
          saved.push(p);
        },
      },
    );

    expect(result.total).toBe(2);
    expect(result.saved).toBe(1);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]?.id).toBe(201);
    expect(saved).toContain("/o/files/202.png");
  });

  it("paginates beyond the 100-item page cap without dropping receipts", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, mime_type: "image/jpeg" }));
    const page2 = [{ id: 2000, mime_type: "image/png" }];

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      if (u.pathname === "/api/1/receipts") {
        const offset = Number(u.searchParams.get("offset"));
        const limit = u.searchParams.get("limit");
        expect(limit).toBe("100");
        return jsonRes({ receipts: offset === 0 ? page1 : offset === 100 ? page2 : [] });
      }
      return new Response("data", { status: 200, headers: { "content-type": "image/jpeg" } });
    });

    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "t",
      fetchFn: fetchMock,
    });

    const result = await runExportReceipts(
      { companyId: 1, startDate: "2026-02-01", endDate: "2026-02-28", outDir: "/o" },
      { client, ensureDir: async () => {}, writeFile: async () => {} },
    );

    expect(result.total).toBe(101);
    expect(result.saved).toBe(101);
  });

});
