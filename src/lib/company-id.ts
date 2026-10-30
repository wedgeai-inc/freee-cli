export function parsePositiveIntegerOption(value: string | undefined, flag: string): number {
  if (value === undefined || value === "") {
    throw new Error(`${flag} is required`);
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${flag} must be a positive integer (got: "${value}")`);
  }
  const num = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(num)) {
    throw new Error(`${flag} exceeds safe integer range (got: "${value}")`);
  }
  return num;
}

export function parseCompanyId(value: string | undefined): number {
  return parsePositiveIntegerOption(value, "--company-id");
}

