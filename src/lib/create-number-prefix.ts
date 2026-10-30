import type { PublicFreeeClient } from "./clients/freee-public-client.js";
import { computeNextNumber, readNumberedDocuments, validateNumberPrefix } from "./next-number.js";

export interface AssignedNumber {
  prefix: string;
  number: string;
  max: number | null;
  matched_count: number;
}

/** CLIの作成呼び出しごとに読み直す。番号の予約やdry-runからの引き継ぎは行わない。 */
export async function assignCreateNumber(
  raw: unknown,
  opts: { companyId: number; numberPrefix: string },
  getClient: () => Promise<PublicFreeeClient>,
  resource: "invoices" | "quotations",
  numberKey: "invoice_number" | "quotation_number",
  maxOffset: number,
) {
  validateNumberPrefix(opts.numberPrefix);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("--number-prefix requires a plan object with a positive integer partner_id");
  }
  const plan = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(plan.partner_id) || (plan.partner_id as number) <= 0) {
    throw new Error("--number-prefix requires a positive integer partner_id in the plan");
  }
  if (Object.hasOwn(plan, numberKey)) {
    throw new Error(`--number-prefix cannot be combined with ${numberKey} in the plan`);
  }
  const client = await getClient();
  const docs = await readNumberedDocuments(
    { companyId: opts.companyId, prefix: opts.numberPrefix }, { client }, resource, numberKey, maxOffset,
  );
  const next = computeNextNumber(opts.numberPrefix, docs, { partnerId: plan.partner_id as number });
  const assignedNumber: AssignedNumber = {
    prefix: opts.numberPrefix, number: next.next, max: next.max, matched_count: next.matched.length,
  };
  return { raw: { ...plan, [numberKey]: next.next }, assignedNumber, client };
}

export function formatAssignedNumber(value: AssignedNumber): string {
  return `number: ${value.number}（--number-prefix で自動採番。一致 ${value.matched_count} 件・最大 ${value.max ?? "なし"}）`;
}
