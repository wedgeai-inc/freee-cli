import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import { toInvoiceTemplate, type InvoiceTemplate } from "../../types/invoice.js";

export interface InvoicesTemplatesOptions {
  companyId: number;
  format?: "json" | "table";
}

export interface InvoicesTemplatesDeps {
  client: PublicFreeeClient;
}

export interface InvoicesTemplatesResult {
  items: InvoiceTemplate[];
}

export async function runInvoicesTemplates(
  opts: InvoicesTemplatesOptions,
  deps: InvoicesTemplatesDeps,
): Promise<InvoicesTemplatesResult> {
  const response = await deps.client.get("/invoices/templates", { query: { company_id: opts.companyId } });
  const payload = (await response.json()) as Record<string, unknown>;
  const items = Array.isArray(payload.templates)
    ? payload.templates
    : Object.values(payload).find(Array.isArray) ?? [];
  return { items: (items as Array<Record<string, unknown>>).map(toInvoiceTemplate) };
}

export function formatInvoiceTemplates(
  result: InvoicesTemplatesResult,
  format: "json" | "table",
): string {
  if (format === "json") return JSON.stringify(result.items, null, 2);
  return ["id\tname", ...result.items.map((item) => `${item.id}\t${item.name}`)].join("\n");
}
