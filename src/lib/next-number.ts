import type { ReadOnlyClient } from "./clients/read-only-client.js";

export interface NumberedDocument { id: number; number: string; partner_id: number; }
export interface NextNumberOptions {
  companyId: number;
  prefix: string;
  partnerId?: number;
  width?: number;
  maxOffset?: number;
}
export interface NextNumberDeps { client: Pick<ReadOnlyClient, "get">; }

export function validateNumberPrefix(prefix: string): void {
  if (prefix.length < 1 || prefix.length > 20 || prefix.match(/^[A-Z0-9]+(-[A-Z0-9]+)*$/)?.[0] !== prefix) {
    throw new Error("--prefix must be 1–20 uppercase letters, digits, or single separating hyphens");
  }
}

export function computeNextNumber(
  prefix: string,
  docs: NumberedDocument[],
  opts: { partnerId?: number; width?: number } = {},
) {
  validateNumberPrefix(prefix);
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`);
  const matched: NumberedDocument[] = [];
  let max: number | null = null;
  let width = opts.width ?? 3;
  let partnerId = opts.partnerId;
  for (const document of docs) {
    const match = pattern.exec(document.number);
    if (!match || match[0] !== document.number) continue;
    if (partnerId !== undefined && document.partner_id !== partnerId) {
      throw new Error("number prefix matches a different partner");
    }
    partnerId = document.partner_id;
    const digits = match[1]!;
    const value = Number(digits);
    if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
      throw new Error("number sequence exceeds safe integer range");
    }
    max = Math.max(max ?? 0, value);
    width = Math.max(width, digits.length);
    matched.push(document);
  }
  return { next: `${prefix}-${String((max ?? 0) + 1).padStart(width, "0")}`, max, width, matched };
}

/** Read both cancellation states without filtering partners, validating every row before deduplication. */
export async function readNumberedDocuments(
  opts: NextNumberOptions,
  deps: NextNumberDeps,
  resource: "invoices" | "quotations",
  numberKey: "invoice_number" | "quotation_number",
  defaultMaxOffset: number,
): Promise<NumberedDocument[]> {
  validateNumberPrefix(opts.prefix);
  const documents = new Map<number, NumberedDocument>();
  const limit = 100;
  const maxOffset = opts.maxOffset ?? defaultMaxOffset;
  for (const cancelStatus of ["canceled", "uncanceled"] as const) {
    let offset = 0;
    while (true) {
      if (offset + limit > maxOffset) {
        throw new Error(`${resource} next-number: limit + offset exceeds ${maxOffset}; cannot compute from incomplete results`);
      }
      const response = await deps.client.get(`/${resource}`, {
        query: { company_id: opts.companyId, cancel_status: cancelStatus, sales_management_origin: true, limit, offset },
      });
      const payload: unknown = await response.json();
      const page = payload && typeof payload === "object" ? (payload as Record<string, unknown>)[resource] : undefined;
      if (!Array.isArray(page)) throw new Error(`${resource} next-number: invalid response array`);
      for (const raw of page) {
        if (!raw || typeof raw !== "object" || !Number.isSafeInteger(raw.id) || raw.id <= 0 ||
            typeof raw[numberKey] !== "string" || !Number.isSafeInteger(raw.partner_id) || raw.partner_id <= 0) {
          throw new Error(`${resource} next-number: invalid id, ${numberKey}, or partner_id`);
        }
        const document = { id: raw.id as number, number: raw[numberKey] as string, partner_id: raw.partner_id as number };
        const previous = documents.get(document.id);
        if (previous && (previous.number !== document.number || previous.partner_id !== document.partner_id)) {
          throw new Error(`${resource} next-number: conflicting duplicate id or partner`);
        }
        documents.set(document.id, document);
      }
      if (page.length < limit) break;
      offset += page.length;
    }
  }
  return [...documents.values()];
}
