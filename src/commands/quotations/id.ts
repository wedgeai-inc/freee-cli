/** 見積書 ID の境界。get / cancel / CLI で共用する。 */
export function validateQuotationId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) {
    throw new Error("--id must be an integer between 1 and 2147483647");
  }
}
