import { accountingGet, type AccountingGetOptions, type AccountingReadDeps } from "../../lib/accounting-read.js";
export function runReceiptsGet(opts: AccountingGetOptions, deps: AccountingReadDeps) { return accountingGet("receipts", opts, deps); }
