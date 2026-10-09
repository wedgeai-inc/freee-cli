import { describe, expect, it } from "vitest";
import * as reader from "../../src/reader.js";

describe("reader entry (read-only surface)", () => {
  it("exports only the read functions and the client, no write commands", () => {
    expect(Object.keys(reader).sort()).toEqual(
      [
        "FreeeApiError",
        "INVOICE_API_BASE_URL",
        "PAGINATION_MAX_OFFSET",
        "PublicFreeeClient",
        "createInvoiceClient",
        "invoiceWebUrl",
        "runExpenseList",
        "runInvoicesList",
        "runPartnersSearch",
      ].sort(),
    );
  });

  it("lists invoices through a injected fetch with a Bearer token", async () => {
    const seen: Array<{ url: string; method: string | undefined; auth: string | undefined }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method, auth: (init?.headers as Record<string, string>)["Authorization"] });
      return new Response(JSON.stringify({ invoices: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = reader.createInvoiceClient({ token: "t", fetchFn });
    const result = await reader.runInvoicesList({ companyId: 1 }, { client });
    expect(result.items).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.auth).toBe("Bearer t");
  });
});
