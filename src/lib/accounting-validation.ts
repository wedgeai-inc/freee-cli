export function assertId(value: number, label = "id"): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}
export function assertAmount(value: number, label = "amount"): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
}
export function assertDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error(`${label} must be a valid YYYY-MM-DD`);
}

export function assertTaxCode(value: number, label = "tax_code"): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw new Error(`${label} must be an integer between 0 and 2147483647`);
}
