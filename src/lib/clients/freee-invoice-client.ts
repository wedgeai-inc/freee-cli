import { PublicFreeeClient } from "./freee-public-client.js";

export const INVOICE_API_BASE_URL = "https://api.freee.co.jp/iv";

export function createInvoiceClient(params: {
  token: string;
  fetchFn?: typeof fetch;
}): PublicFreeeClient {
  return new PublicFreeeClient({
    baseUrl: INVOICE_API_BASE_URL,
    token: params.token,
    fetchFn: params.fetchFn,
  });
}

export function invoiceWebUrl(id: number): string {
  return `https://invoice.secure.freee.co.jp/reports/invoices/${id}`;
}
