export function parseCompanyId(value: string | undefined): number {
  if (value === undefined || value === "") {
    throw new Error("--company-id is required");
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`--company-id must be a positive integer (got: "${value}")`);
  }
  const num = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(num)) {
    throw new Error(`--company-id exceeds safe integer range (got: "${value}")`);
  }
  return num;
}
