/**
 * 読み取り専用の公開口。他の repo が freee のデータを「読む」ためだけに使う。
 * PublicFreeeClient と createInvoiceClient は出さない（post / put / patch / delete / request で書き込めてしまうため）。
 * 代わりに GET だけを持つ createReadOnlyClient を出す。書き込みコマンド（create / update / cancel / uncancel）の関数も出さない。
 */
export { createReadOnlyClient } from "./lib/clients/read-only-client.js";
export type {
  CreateReadOnlyClientOptions,
  ReadOnlyApi,
  ReadOnlyClient,
  ReadOnlyGetOptions,
} from "./lib/clients/read-only-client.js";
export { FreeeApiError } from "./lib/clients/freee-public-client.js";
export { invoiceWebUrl, INVOICE_API_BASE_URL } from "./lib/clients/freee-invoice-client.js";
export { runInvoicesList, PAGINATION_MAX_OFFSET } from "./commands/invoices/list.js";
export type { InvoicesListOptions, InvoicesListResult } from "./commands/invoices/list.js";
export { runExpenseList } from "./commands/expense/list.js";
export type { ExpenseListOptions, ExpenseListResult } from "./commands/expense/list.js";
export { runPartnersSearch } from "./commands/partners/search.js";
export type { PartnersSearchOptions, PartnersSearchResult, PartnerSummary } from "./commands/partners/search.js";
export type { InvoiceSummary } from "./types/invoice.js";
export type { ExpenseApplicationSummary } from "./types/expense.js";
