import { responseArray } from "../../lib/accounting-read.js";
import { assertId } from "../../lib/accounting-validation.js";
import type { AccountingReadDeps, CompanyOptions, AccountingRecord } from "../../lib/accounting-read.js";
export async function runAccountItemsList(opts: CompanyOptions, deps: AccountingReadDeps): Promise<{ items: AccountingRecord[] }> {
  assertId(opts.companyId, "company_id");
  const payload = await (await deps.client.get("/api/1/account_items", { query: { company_id: opts.companyId } })).json();
  return { items: responseArray(payload, "account_items", "/api/1/account_items") };
}
