import { computeNextNumber, readNumberedDocuments, type NextNumberOptions, type NextNumberDeps } from "../../lib/next-number.js";
import { QUOTATION_PAGINATION_MAX_OFFSET } from "./list.js";

export async function runQuotationsNextNumber(opts: NextNumberOptions, deps: NextNumberDeps) {
  const docs = await readNumberedDocuments(opts, deps, "quotations", "quotation_number", QUOTATION_PAGINATION_MAX_OFFSET);
  return { prefix: opts.prefix, ...computeNextNumber(opts.prefix, docs, opts) };
}
