import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";

export interface PartnerGetOptions { companyId: number; id: number; }
export interface PartnerGetDeps { client: PublicFreeeClient; }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export async function runPartnersGet(opts: PartnerGetOptions, deps: PartnerGetDeps): Promise<Record<string, unknown>> {
  const path = `/api/1/partners/${opts.id}`;
  const response = await deps.client.get(path, { query: { company_id: opts.companyId } });
  const payload: unknown = await response.json();
  const partner = isRecord(payload) && isRecord(payload.partner) ? payload.partner : undefined;
  if (!partner || partner.id !== opts.id || partner.company_id !== opts.companyId) throw new Error(`invalid response: ${path}`);
  return partner;
}

export function formatPartnerGet(result: Record<string, unknown>): string { return JSON.stringify(result, null, 2); }
