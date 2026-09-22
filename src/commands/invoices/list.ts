import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import { invoiceWebUrl } from "../../lib/clients/freee-invoice-client.js";
import { toInvoiceSummary, type InvoiceSummary } from "../../types/invoice.js";

export interface InvoicesListOptions {
  companyId: number;
  startBillingDate?: string;
  endBillingDate?: string;
  partnerIds?: string;
  sendingStatus?: "sent" | "unsent";
  paymentStatus?: "settled" | "unsettled" | "canceled" | "unprocessed" | "failed";
  format?: "json" | "table";
  /** limit + offset がこの値以上になる取得を止める（freee 請求書 API は 2026-09-21 から 10,000 超をエラーにする） */
  maxOffset?: number;
}

export interface InvoicesListDeps {
  client: PublicFreeeClient;
}

export interface InvoicesListResult {
  items: InvoiceSummary[];
}

/** freee 請求書 API の一覧取得は 2026-09-21 以降 limit + offset > 10,000 でエラーになる（developer.freee.co.jp/invoice/invoice-improvement/8076） */
export const PAGINATION_MAX_OFFSET = 10_000;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validateDate(name: string, value: string | undefined): void {
  if (value !== undefined && !DATE_PATTERN.test(value)) {
    throw new Error(`--${name} must be YYYY-MM-DD`);
  }
}

function validatePartnerIds(value: string | undefined): void {
  if (value === undefined) return;
  const ids = value.split(",");
  if (ids.length === 0 || ids.length > 3 || ids.some((id) => !/^[1-9]\d*$/.test(id))) {
    throw new Error("--partner-ids must be one to three comma-separated positive integer IDs");
  }
}

/** 入力検証。CLI では認証ロード（token refresh の fetch を伴いうる）より前に呼ぶ。 */
export function validateInvoicesListOptions(opts: InvoicesListOptions): void {
  validateDate("start-billing-date", opts.startBillingDate);
  validateDate("end-billing-date", opts.endBillingDate);
  validatePartnerIds(opts.partnerIds);
}

export async function runInvoicesList(
  opts: InvoicesListOptions,
  deps: InvoicesListDeps,
): Promise<InvoicesListResult> {
  validateInvoicesListOptions(opts);

  const limit = 100; // API 上限
  const maxOffset = opts.maxOffset ?? PAGINATION_MAX_OFFSET;
  const query: Record<string, string | number | boolean | null | undefined> = {
    company_id: opts.companyId,
    ...(opts.startBillingDate ? { start_billing_date: opts.startBillingDate } : {}),
    ...(opts.endBillingDate ? { end_billing_date: opts.endBillingDate } : {}),
    ...(opts.partnerIds ? { partner_ids: opts.partnerIds } : {}),
    ...(opts.sendingStatus ? { sending_status: opts.sendingStatus } : {}),
    ...(opts.paymentStatus ? { payment_status: opts.paymentStatus } : {}),
  };
  const items: InvoiceSummary[] = [];
  let offset = 0;
  while (true) {
    if (offset + limit > maxOffset) {
      throw new Error(
        `invoices list: limit + offset が ${maxOffset} を超えるため中断しました（取得済み ${items.length} 件）。` +
          " --start-billing-date / --end-billing-date で期間を月単位などに絞ってください",
      );
    }
    const response = await deps.client.get("/invoices", { query: { ...query, limit, offset } });
    const payload = (await response.json()) as { invoices?: Array<Record<string, unknown>> };
    const page = payload.invoices ?? [];
    for (const raw of page) items.push(toInvoiceSummary(raw));
    if (page.length < limit) break;
    offset += page.length;
  }
  return { items };
}

export function formatInvoicesList(result: InvoicesListResult, format: "json" | "table"): string {
  if (format === "json") return JSON.stringify(result.items, null, 2);
  return [
    "id\tinvoice_number\tbilling_date\tpartner_name\ttotal_amount\tsending_status\tpayment_status\tweb_url",
    ...result.items.map((item) =>
      [
        item.id,
        item.invoice_number,
        item.billing_date,
        item.partner_name ?? "",
        item.total_amount,
        item.sending_status,
        item.payment_status,
        invoiceWebUrl(item.id),
      ].join("\t"),
    ),
  ].join("\n");
}
