import { describe, expect, it, vi } from "vitest";
import {
  INVOICE_API_BASE_URL,
  createInvoiceClient,
  invoiceWebUrl,
} from "../../src/lib/clients/freee-invoice-client.js";

describe("invoice client", () => {
  it("uses the invoice API base URL and the standard authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const client = createInvoiceClient({ token: "token-123", fetchFn: fetchMock });

    await client.get("/invoices");

    expect(INVOICE_API_BASE_URL).toBe("https://api.freee.co.jp/iv");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.freee.co.jp/iv/invoices",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer token-123" }),
      }),
    );
    expect(invoiceWebUrl(123)).toBe("https://invoice.secure.freee.co.jp/reports/invoices/123");
  });
});
