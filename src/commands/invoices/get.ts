import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import { invoiceWebUrl } from "../../lib/clients/freee-invoice-client.js";
import { toInvoiceDetail, type InvoiceDetail } from "../../types/invoice.js";

export interface InvoicesGetOptions {
  companyId: number;
  id: number;
  format?: "json" | "table";
}

export interface InvoicesGetDeps {
  client: PublicFreeeClient;
}

export interface InvoicesGetResult {
  invoice: InvoiceDetail;
  webUrl: string;
}

/** 入力検証。CLI では認証ロードより前に呼ぶ。 */
export function validateInvoiceId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("--id must be a positive integer");
  }
}

export async function runInvoicesGet(
  opts: InvoicesGetOptions,
  deps: InvoicesGetDeps,
): Promise<InvoicesGetResult> {
  validateInvoiceId(opts.id);
  const response = await deps.client.get(`/invoices/${opts.id}`, { query: { company_id: opts.companyId } });
  const payload = (await response.json()) as { invoice?: Record<string, unknown> };
  return { invoice: toInvoiceDetail(payload.invoice ?? {}), webUrl: invoiceWebUrl(opts.id) };
}

export function formatInvoiceDetail(result: InvoicesGetResult, format: "json" | "table"): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  return [
    "id\tinvoice_number\tbilling_date\tpartner_name\ttotal_amount\tweb_url",
    [
      result.invoice.id,
      result.invoice.invoice_number,
      result.invoice.billing_date,
      result.invoice.partner_name ?? "",
      result.invoice.total_amount,
      result.webUrl,
    ].join("\t"),
  ].join("\n");
}
