import { describe, expect, it, vi } from "vitest";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { runExportExpenseApplications } from "../../src/commands/export/expense-applications.js";

function jsonRes(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function binRes(body: string, mime: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": mime } });
}

describe("runExportExpenseApplications", () => {
  it("exports applications and downloads attached receipts", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      if (u.pathname === "/api/1/expense_applications") {
        return jsonRes({
          expense_applications: [
            {
              id: 1,
              purchase_lines: [
                { id: 10, transaction_date: "2026-02-10", receipt_id: 101, sub_receipt_ids: [102] },
                { id: 11, transaction_date: "2026-03-01", receipt_id: 103, sub_receipt_ids: [] },
              ],
            },
          ],
        });
      }
      if (u.pathname === "/api/1/receipts/101") return jsonRes({ receipt: { id: 101, mime_type: "application/pdf" } });
      if (u.pathname === "/api/1/receipts/102") return jsonRes({ receipt: { id: 102, mime_type: "image/jpeg" } });
      if (u.pathname === "/api/1/receipts/101/download") return binRes("pdf", "application/pdf");
      if (u.pathname === "/api/1/receipts/102/download") return binRes("jpg", "image/jpeg");
      throw new Error(`unexpected URL: ${url}`);
    });

    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "t",
      fetchFn: fetchMock,
    });
    const writes: Array<{ path: string; isString: boolean }> = [];
    const dirs: string[] = [];

    const result = await runExportExpenseApplications(
      {
        companyId: 1234567,
        startDate: "2026-02-01",
        endDate: "2026-02-28",
        outDir: "/out/expense-reports",
      },
      {
        client,
        ensureDir: async (path) => {
          dirs.push(path);
        },
        writeFile: async (path, data) => {
          writes.push({ path, isString: typeof data === "string" });
        },
      },
    );

    expect(result.total).toBe(1);
    expect(result.receiptIds).toEqual([101, 102]);
    expect(result.savedReceipts).toBe(2);
    expect(dirs).toContain("/out/expense-reports/files");
    expect(writes.some((w) => w.path === "/out/expense-reports/index.json" && w.isString)).toBe(true);
    expect(writes.some((w) => w.path === "/out/expense-reports/receipts-index.json" && w.isString)).toBe(true);
    expect(writes.some((w) => w.path === "/out/expense-reports/files/101.pdf" && !w.isString)).toBe(true);
    expect(writes.some((w) => w.path === "/out/expense-reports/files/102.jpg" && !w.isString)).toBe(true);
  });
});
