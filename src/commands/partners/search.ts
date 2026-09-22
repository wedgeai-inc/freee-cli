import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";

export interface PartnersSearchOptions {
  companyId: number;
  keyword?: string;
  limit?: number;
  format?: "json" | "table";
}

export interface PartnerSummary {
  id: number;
  code?: string | null;
  name: string;
  email?: string | null;
}

export interface PartnersSearchDeps {
  client: PublicFreeeClient;
}

export interface PartnersSearchResult {
  items: PartnerSummary[];
}

/** API 応答から Summary の項目だけを取り出す（未定義フィールドを JSON 出力へ素通ししない）。 */
function toPartnerSummary(raw: Record<string, unknown>): PartnerSummary {
  return {
    id: Number(raw.id),
    code: typeof raw.code === "string" ? raw.code : null,
    name: String(raw.name ?? ""),
    email: typeof raw.email === "string" ? raw.email : null,
  };
}

export async function runPartnersSearch(
  opts: PartnersSearchOptions,
  deps: PartnersSearchDeps,
): Promise<PartnersSearchResult> {
  const items: PartnerSummary[] = [];
  for await (const raw of deps.client.listAll<Record<string, unknown>>("/api/1/partners", {
    company_id: opts.companyId,
    ...(opts.keyword !== undefined ? { keyword: opts.keyword } : {}),
    limit: opts.limit ?? 100,
  })) {
    items.push(toPartnerSummary(raw));
  }
  return { items };
}

export function formatPartnersSearch(result: PartnersSearchResult, format: "json" | "table"): string {
  if (format === "json") {
    return JSON.stringify(result.items, null, 2);
  }
  return [
    "id\t\tcode\t\tname\t\temail",
    ...result.items.map((item) => `${item.id}\t\t${item.code ?? ""}\t\t${item.name}\t\t${item.email || "-"}`),
  ].join("\n");
}
