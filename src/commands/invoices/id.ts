/** 請求書 ID の境界。cancel / uncancel / CLI で共用する。 */
export function validateInvoiceMutationId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) {
    throw new Error("--id must be an integer between 1 and 2147483647");
  }
}
