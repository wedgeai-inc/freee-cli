import { accountingGet, type AccountingGetOptions, type AccountingReadDeps } from "../../lib/accounting-read.js";
export function runDealsGet(opts: AccountingGetOptions, deps: AccountingReadDeps) { return accountingGet("deals", opts, deps); }
