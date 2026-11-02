import { responseArray } from "../../lib/accounting-read.js";
import { assertId } from "../../lib/accounting-validation.js";
import type { AccountingReadDeps, CompanyOptions, AccountingRecord } from "../../lib/accounting-read.js";
export async function runTaxesList(opts: CompanyOptions, deps: AccountingReadDeps): Promise<{ items: AccountingRecord[] }> {
  assertId(opts.companyId, "company_id");
  const path = `/api/1/taxes/companies/${opts.companyId}`;
  const payload = await (await deps.client.get(path)).json();
  return { items: responseArray(payload, "taxes", path) };
}
