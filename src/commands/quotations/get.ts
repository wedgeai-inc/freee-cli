import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import { toQuotationDetail, type QuotationDetail } from "../../types/quotation.js";
import { validateQuotationId } from "./id.js";
export { validateQuotationId } from "./id.js";
export interface QuotationsGetOptions { companyId: number; id: number; }
export interface QuotationsGetDeps { client: PublicFreeeClient; }
export interface QuotationsGetResult { quotation: QuotationDetail; }
export async function runQuotationsGet(opts: QuotationsGetOptions, deps: QuotationsGetDeps): Promise<QuotationsGetResult> { validateQuotationId(opts.id); const payload = await (await deps.client.get(`/quotations/${opts.id}`, { query: { company_id: opts.companyId } })).json() as { quotation?: unknown }; if (typeof payload.quotation !== "object" || payload.quotation === null || Array.isArray(payload.quotation)) throw new Error("quotation get: response is missing quotation"); const quotation = toQuotationDetail(payload.quotation as Record<string, unknown>); if (quotation.id !== opts.id) throw new Error("quotation get: mismatch:id"); if (quotation.company_id !== opts.companyId) throw new Error("quotation get: mismatch:company_id"); return { quotation }; }
export function formatQuotationDetail(result: QuotationsGetResult, format: "json" | "table"): string { if (format === "json") return JSON.stringify(result, null, 2); const q = result.quotation; return ["id\tquotation_number\tquotation_date\tpartner_name\ttotal_amount\tsending_status\tcancel_status\treport_url", [q.id, q.quotation_number, q.quotation_date, q.partner_name ?? "", q.total_amount, q.sending_status, q.cancel_status, q.report_url].join("\t")].join("\n"); }
