import { assertId, assertDate } from "../../../lib/accounting-validation.js";
import { auditedAccountingWrite } from "../../../lib/accounting-write.js";
import { isRecord, responseArray } from "../../../lib/accounting-read.js";
import { redactAccountingPayload, type AccountingAuditEntry } from "../../../lib/audit/accounting-audit.js";
import type { PublicFreeeClient } from "../../../lib/clients/freee-public-client.js";

export interface DealsPaymentsCreateOptions {
  companyId: number; dealId: number; date: string;
  fromWalletableType: "bank_account" | "credit_card" | "wallet" | "private_account_item";
  fromWalletableId: number; amount: number; expectAmount?: number; execute?: boolean;
  logDir: string; taskId: string;
}
export interface DealsPaymentsCreateDeps {
  getClient: () => Promise<PublicFreeeClient>;
  appendAudit: (entry: AccountingAuditEntry) => Promise<void>;
  now: () => Date;
}
export async function runDealsPaymentsCreate(opts: DealsPaymentsCreateOptions, deps: DealsPaymentsCreateDeps) {
  assertId(opts.companyId, "company_id");
  assertId(opts.dealId, "deal_id");
  assertDate(opts.date, "date");
  assertId(opts.fromWalletableId, "from_walletable_id");
  assertId(opts.amount, "amount");
  if (!["bank_account", "credit_card", "wallet", "private_account_item"].includes(opts.fromWalletableType)) throw new Error("invalid from_walletable_type");
  if (opts.expectAmount !== undefined) assertId(opts.expectAmount, "--expect-amount");
  if (opts.execute && opts.expectAmount === undefined) throw new Error("--expect-amount is required with --execute");
  const payload = { company_id: opts.companyId, date: opts.date, from_walletable_type: opts.fromWalletableType, from_walletable_id: opts.fromWalletableId, amount: opts.amount };
  const client = await deps.getClient();
  const path = `/api/1/deals/${opts.dealId}`;
  const response: unknown = await (await client.get(path, { query: { company_id: opts.companyId } })).json();
  const deal = isRecord(response) ? response.deal : undefined;
  if (!isRecord(deal) || deal.id !== opts.dealId) throw new Error("invalid response: deal");
  let walletable;
  if (opts.fromWalletableType !== "private_account_item") {
    const wallets = responseArray(await (await client.get("/api/1/walletables", { query: { company_id: opts.companyId } })).json(), "walletables", "/api/1/walletables");
    walletable = wallets.find(w => w.id === opts.fromWalletableId && w.type === opts.fromWalletableType);
  }
  const names = { walletable: walletable?.name };
  const guards = {
    expectedAmountMatches: opts.expectAmount === undefined || opts.expectAmount === opts.amount,
    companyMatches: deal.company_id === opts.companyId,
    hasOutstandingAmount: typeof deal.due_amount === "number" && Number.isSafeInteger(deal.due_amount) && deal.due_amount > 0,
    amountMatchesDue: deal.due_amount === opts.amount,
    walletableExists: opts.fromWalletableType === "private_account_item" || walletable !== undefined,
  };
  if (opts.execute && Object.values(guards).some(ok => !ok)) throw new Error(`payment guard failed: ${Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name).join(", ")}`);
  const mode = opts.execute ? "execute" as const : "dry-run" as const;
  const base = { task_id: opts.taskId, event: "deal_payment_create" as const, target_id: opts.dealId, mode, company_id: opts.companyId, payload_redacted: redactAccountingPayload(payload) };
  if (!opts.execute) {
    await deps.appendAudit({ ...base, timestamp: deps.now().toISOString(), status: "planned" });
    return { mode, payload, names, guards };
  }
  const created = await auditedAccountingWrite(base, deps, () => client.post(`${path}/payments`, { body: payload }), "deal");
  return { mode, payload, names, guards, created };
}
