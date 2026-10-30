import { computeNextNumber, readNumberedDocuments, type NextNumberOptions, type NextNumberDeps } from "../../lib/next-number.js";
import { PAGINATION_MAX_OFFSET } from "./list.js";

export async function runInvoicesNextNumber(opts: NextNumberOptions, deps: NextNumberDeps) {
  const docs = await readNumberedDocuments(opts, deps, "invoices", "invoice_number", PAGINATION_MAX_OFFSET);
  return { prefix: opts.prefix, ...computeNextNumber(opts.prefix, docs, opts) };
}
