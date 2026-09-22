import { describe, expect, it, vi } from "vitest";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { runExportJournals } from "../../src/commands/export/journals.js";

function jsonRes(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("runExportJournals", () => {
  it("requests export, polls until uploaded, and downloads the csv", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ journals: { id: 555, status_url: "x" } }))
      .mockResolvedValueOnce(jsonRes({ journals: { id: 555, status: "working" } }))
      .mockResolvedValueOnce(jsonRes({ journals: { id: 555, status: "uploaded", download_url: "x" } }))
      .mockResolvedValueOnce(
        new Response("発生日,借方,貸方\n2026-02-01,x,y", {
          status: 200,
          headers: { "content-type": "text/csv" },
        }),
      );

    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "t",
      fetchFn: fetchMock,
    });

    const writes: Array<{ path: string; data: string | Buffer }> = [];
    const sleeps: number[] = [];
    const result = await runExportJournals(
      {
        companyId: 1234567,
        startDate: "2026-02-01",
        endDate: "2026-02-28",
        outDir: "/out",
        downloadType: "generic_v2",
        encoding: "utf-8",
      },
      {
        client,
        ensureDir: async () => {},
        writeFile: async (p, d) => {
          writes.push({ path: p, data: d });
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(result.id).toBe(555);
    expect(result.status).toBe("uploaded");
    expect(writes.length).toBe(1);
    expect(writes[0]?.path).toBe("/out/journals-2026-02-01_2026-02-28.csv");
    expect(String(writes[0]?.data)).toContain("発生日,借方,貸方");
    expect(sleeps.length).toBe(1);

    const reqUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(reqUrl).toContain("/api/1/journals");
    expect(reqUrl).toContain("download_type=generic_v2");
    expect(reqUrl).toContain("encoding=utf-8");
    expect(reqUrl).toContain("company_id=1234567");
    expect(reqUrl).toContain("start_date=2026-02-01");
    expect(reqUrl).toContain("end_date=2026-02-28");

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/api/1/journals/reports/555/status");
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain("/api/1/journals/reports/555/download");
  });

  it("throws when export status becomes failed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ journals: { id: 1 } }))
      .mockResolvedValueOnce(jsonRes({ journals: { id: 1, status: "failed" } }));

    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "t",
      fetchFn: fetchMock,
    });

    await expect(
      runExportJournals(
        {
          companyId: 1,
          startDate: "2026-02-01",
          endDate: "2026-02-28",
          outDir: "/o",
          downloadType: "csv",
          encoding: "utf-8",
        },
        { client, ensureDir: async () => {}, writeFile: async () => {}, sleep: async () => {} },
      ),
    ).rejects.toThrow(/failed/i);
  });

  it("times out after maxPolls while still working", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ journals: { id: 1 } }))
      .mockImplementation(async () => jsonRes({ journals: { id: 1, status: "working" } }));

    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "t",
      fetchFn: fetchMock,
    });

    await expect(
      runExportJournals(
        {
          companyId: 1,
          startDate: "2026-02-01",
          endDate: "2026-02-28",
          outDir: "/o",
          downloadType: "csv",
          encoding: "utf-8",
        },
        {
          client,
          ensureDir: async () => {},
          writeFile: async () => {},
          sleep: async () => {},
          maxPolls: 3,
        },
      ),
    ).rejects.toThrow(/timed out/i);
  });

  it("omits encoding for download_type=csv (encoding only valid for generic/generic_v2)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ journals: { id: 9 } }))
      .mockResolvedValueOnce(jsonRes({ journals: { id: 9, status: "uploaded" } }))
      .mockResolvedValueOnce(new Response("a,b", { status: 200, headers: { "content-type": "text/csv" } }));

    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "t",
      fetchFn: fetchMock,
    });

    await runExportJournals(
      {
        companyId: 1,
        startDate: "2026-02-01",
        endDate: "2026-02-28",
        outDir: "/o",
        downloadType: "csv",
        encoding: "utf-8",
      },
      { client, ensureDir: async () => {}, writeFile: async () => {}, sleep: async () => {} },
    );

    const reqUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(reqUrl).toContain("download_type=csv");
    expect(reqUrl).not.toContain("encoding=");
  });

});
