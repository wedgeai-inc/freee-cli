import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import { toQuotationTemplate, type QuotationTemplate } from "../../types/quotation.js";
export interface QuotationsTemplatesOptions { companyId: number; }
export interface QuotationsTemplatesDeps { client: PublicFreeeClient; }
export interface QuotationsTemplatesResult { items: QuotationTemplate[]; }
export async function runQuotationsTemplates(opts: QuotationsTemplatesOptions, deps: QuotationsTemplatesDeps): Promise<QuotationsTemplatesResult> { const payload = await (await deps.client.get("/quotations/templates", { query: { company_id: opts.companyId } })).json() as { templates?: unknown }; if (!Array.isArray(payload.templates)) throw new Error("quotations templates: response is missing templates"); return { items: (payload.templates as Array<Record<string, unknown>>).map(toQuotationTemplate) }; }
export function formatQuotationTemplates(result: QuotationsTemplatesResult, format: "json" | "table"): string { return format === "json" ? JSON.stringify(result.items, null, 2) : ["id\tname", ...result.items.map((item) => `${item.id}\t${item.name}`)].join("\n"); }
