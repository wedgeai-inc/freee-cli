import { isRecord, type AccountingRecord } from "./accounting-read.js";

/** CLI出力専用。entry_sideによる控除行の判定は推測で、実在の応答では未確認。 */
export function withSignedDealAmounts(deal: AccountingRecord): AccountingRecord {
  if (!Array.isArray(deal.details)) {
    return { ...deal, signed_totals: { amount: null, vat: null } };
  }
  let amount: number | null = 0;
  let vat: number | null = 0;
  const details = deal.details.map((detail: unknown) => {
    if (!isRecord(detail)) {
      amount = vat = null;
      return detail;
    }
    const normalSide = deal.type === "income" ? "credit" : deal.type === "expense" ? "debit" : undefined;
    const sign = normalSide === undefined || (detail.entry_side !== "credit" && detail.entry_side !== "debit")
      ? null : detail.entry_side === normalSide ? 1 : -1;
    const signed_amount = signedValue(detail.amount, sign);
    const signed_vat = signedValue(detail.vat, sign);
    amount = add(amount, signed_amount);
    vat = add(vat, signed_vat);
    return { ...detail, signed_amount, signed_vat };
  });
  return { ...deal, details, signed_totals: { amount, vat } };
}

function signedValue(value: unknown, sign: number | null): number | null {
  return sign !== null && typeof value === "number" && Number.isFinite(value) ? sign * value : null;
}

function add(total: number | null, value: number | null): number | null {
  if (total === null || value === null) return null;
  const sum = total + value;
  return Number.isFinite(sum) ? sum : null;
}
