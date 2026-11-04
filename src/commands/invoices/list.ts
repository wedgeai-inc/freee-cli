import type { ReadOnlyClient } from "../../lib/clients/read-only-client.js";
import { invoiceWebUrl } from "../../lib/clients/freee-invoice-client.js";
import { toInvoiceSummary, type InvoiceSummary } from "../../types/invoice.js";

export interface InvoicesListOptions {
  companyId: number;
  startBillingDate?: string;
  endBillingDate?: string;
  startPaymentDate?: string;
  endPaymentDate?: string;
  cancelStatus?: "all" | "uncanceled" | "canceled";
  partnerIds?: string;
  sendingStatus?: "sent" | "unsent";
  paymentStatus?: "settled" | "unsettled" | "canceled" | "unprocessed" | "failed";
  format?: "json" | "table";
  /** limit + offset がこの値以上になる取得を止める（freee 請求書 API は 2026-09-21 から 10,000 超をエラーにする） */
  maxOffset?: number;
}

export interface InvoicesListDeps {
  client: ReadOnlyClient;
}

export interface InvoicesListResult {
  items: InvoiceSummary[];
  /** 要確認の行。CLIでは標準エラーへ出力し、JSON配列の形を維持する。 */
  warnings?: string[];
}

/** freee 請求書 API の一覧取得は 2026-09-21 以降 limit + offset > 10,000 でエラーになる（developer.freee.co.jp/invoice/invoice-improvement/8076） */
export const PAGINATION_MAX_OFFSET = 10_000;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validateDate(name: string, value: string | undefined): void {
  if (value !== undefined && !DATE_PATTERN.test(value)) {
    throw new Error(`--${name} must be YYYY-MM-DD`);
  }
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validatePaymentDate(name: string, value: string | undefined): void {
  if (value !== undefined && !isCalendarDate(value)) {
    throw new Error(`--${name} must be a valid calendar date (YYYY-MM-DD)`);
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
  validatePaymentDate("start-payment-date", opts.startPaymentDate);
  validatePaymentDate("end-payment-date", opts.endPaymentDate);
  if (opts.startPaymentDate && opts.endPaymentDate && opts.startPaymentDate > opts.endPaymentDate) {
    throw new Error("--start-payment-date must be on or before --end-payment-date");
  }
  if (opts.cancelStatus !== undefined && !["all", "uncanceled", "canceled"].includes(opts.cancelStatus)) {
    throw new Error("--cancel-status must be all, uncanceled, or canceled");
  }
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
  const warnings: string[] = [];
  const filterPaymentDate = opts.startPaymentDate !== undefined || opts.endPaymentDate !== undefined;
  let offset = 0;
  while (true) {
    if (offset + limit > maxOffset) {
      throw new Error(
        `invoices list: limit + offset が ${maxOffset} を超えるため中断しました（取得済み ${offset} 件）。期日の絞り込みは取得後に行うため取得件数を減らしません。` +
          " --start-billing-date / --end-billing-date で期間を月単位などに絞ってください",
      );
    }
    const response = await deps.client.get("/invoices", { query: { ...query, limit, offset } });
    const payload = (await response.json()) as { invoices?: Array<Record<string, unknown>> };
    const page = payload.invoices ?? [];
    for (const raw of page) {
      const item = toInvoiceSummary(raw);
      // 絞り込みで除外される行についても、未知の取消状態を黙って落とさない。
      if (item.cancel_status !== "uncanceled" && item.cancel_status !== "canceled") {
        warnings.push(`invoices list: id=${item.id}: cancel_statusが未知です。要確認（allでは保持、状態指定時は除外）。`);
      }
      const invalidPaymentDate = filterPaymentDate && !isCalendarDate(item.payment_date);
      if (invalidPaymentDate) {
        warnings.push(`invoices list: id=${item.id}: payment_dateが空または不正です。要確認（期日範囲から除外）。`);
      }
      if (opts.cancelStatus && opts.cancelStatus !== "all" && item.cancel_status !== opts.cancelStatus) continue;
      if (filterPaymentDate) {
        if (invalidPaymentDate) continue;
        const paymentDate = item.payment_date as string;
        if (opts.startPaymentDate && paymentDate < opts.startPaymentDate) continue;
        if (opts.endPaymentDate && paymentDate > opts.endPaymentDate) continue;
      }
      items.push(item);
    }
    if (page.length < limit) break;
    offset += page.length;
  }
  return { items, ...(warnings.length ? { warnings } : {}) };
}

export function formatInvoicesList(result: InvoicesListResult, format: "json" | "table", withStatusDetails = false): string {
  if (format === "json") return JSON.stringify(result.items, null, 2);
  return [
    "id\tinvoice_number\tbilling_date\tpartner_name\ttotal_amount\tsending_status\tpayment_status\tweb_url" +
      (withStatusDetails ? "\tpayment_date\tcancel_status\tdeal_status" : ""),
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
        ...(withStatusDetails ? [item.payment_date ?? "", item.cancel_status, item.deal_status] : []),
      ].join("\t"),
    ),
  ].join("\n");
}
