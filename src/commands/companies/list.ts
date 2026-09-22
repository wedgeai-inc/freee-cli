import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";

export interface CompanySummary {
  id: number;
  name: string;
  display_name: string;
  role: string;
  company_number?: string;
}

export interface CompaniesListDeps {
  client: PublicFreeeClient;
}

export interface CompaniesListResult {
  items: CompanySummary[];
}

/** API 応答から Summary の項目だけを取り出す（未定義フィールドを JSON 出力へ素通ししない）。 */
function toCompanySummary(raw: Record<string, unknown>): CompanySummary {
  const item: CompanySummary = {
    id: Number(raw.id),
    name: String(raw.name ?? ""),
    display_name: String(raw.display_name ?? ""),
    role: String(raw.role ?? ""),
  };
  if (typeof raw.company_number === "string") item.company_number = raw.company_number;
  return item;
}

export async function runCompaniesList(deps: CompaniesListDeps): Promise<CompaniesListResult> {
  const response = await deps.client.get("/api/1/companies");
  const payload = (await response.json()) as { companies?: Array<Record<string, unknown>> };
  return { items: (payload.companies ?? []).map(toCompanySummary) };
}

export function formatCompaniesList(result: CompaniesListResult, format: "json" | "table"): string {
  if (format === "json") {
    return JSON.stringify(result.items, null, 2);
  }
  return [
    "id\t\trole\t\tname\t\tdisplay_name",
    ...result.items.map((item) => `${item.id}\t\t${item.role}\t\t${item.name}\t\t${item.display_name}`),
  ].join("\n");
}
