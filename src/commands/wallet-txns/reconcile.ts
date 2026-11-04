import { auditedAccountingWrite } from "../../lib/accounting-write.js";
import { runPartnersGet } from "../partners/get.js";
import { assertDate, assertId } from "../../lib/accounting-validation.js";
import { isRecord } from "../../lib/accounting-read.js";
import type { AccountingAuditEntry } from "../../lib/audit/accounting-audit.js";
import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";

export interface WalletTxnsReconcileOptions {
  walletTxnId: number; companyId: number; dealId: number; amount: number;
  expectAmount?: number; expectDate?: string; execute?: boolean; logDir: string; taskId: string;
}
export interface WalletTxnsReconcileDeps {
  getClient: () => Promise<PublicFreeeClient>;
  appendAudit: (entry: AccountingAuditEntry) => Promise<void>;
  now: () => Date;
}
function validDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { assertDate(value, "date"); return true; } catch { return false; }
}
export async function runWalletTxnsReconcile(opts: WalletTxnsReconcileOptions, deps: WalletTxnsReconcileDeps) {
  assertId(opts.walletTxnId, "wallet_txn_id");
  assertId(opts.companyId, "company_id");
  assertId(opts.dealId, "deal_id");
  assertId(opts.amount, "amount");
  if (opts.expectAmount !== undefined) assertId(opts.expectAmount, "--expect-amount");
  if (opts.expectDate !== undefined) assertDate(opts.expectDate, "--expect-date");
  if (opts.execute && opts.expectAmount === undefined) throw new Error("--expect-amount is required with --execute");
  const client = await deps.getClient();
  const walletResponse: unknown = await (await client.get(`/api/1/wallet_txns/${opts.walletTxnId}`, { query: { company_id: opts.companyId } })).json();
  const wallet = isRecord(walletResponse) ? walletResponse.wallet_txn : undefined;
  if (!isRecord(wallet) || wallet.id !== opts.walletTxnId) throw new Error("invalid response: wallet_txn");
  const dealResponse: unknown = await (await client.get(`/api/1/deals/${opts.dealId}`, { query: { company_id: opts.companyId } })).json();
  const deal = isRecord(dealResponse) ? dealResponse.deal : undefined;
  if (!isRecord(deal) || deal.id !== opts.dealId) throw new Error("invalid response: deal");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(deps.now());
  const guards = {
    expectedAmountMatches: opts.expectAmount === undefined || opts.expectAmount === opts.amount,
    expectedDateMatches: opts.expectDate === undefined || opts.expectDate === wallet.date,
    walletTxnCompanyMatches: wallet.company_id === opts.companyId,
    dealCompanyMatches: deal.company_id === opts.companyId,
    walletTxnUnreconciled: wallet.status === 1 && typeof wallet.amount === "number" && Number.isSafeInteger(wallet.amount) && wallet.amount > 0 && wallet.due_amount === wallet.amount,
    walletTxnAmountMatches: typeof wallet.amount === "number" && Number.isSafeInteger(wallet.amount) && wallet.amount > 0 && wallet.amount === opts.amount,
    dealHasOutstandingAmount: typeof deal.due_amount === "number" && Number.isSafeInteger(deal.due_amount) && deal.due_amount > 0,
    dealAmountMatchesDue: deal.due_amount === opts.amount,
    entrySideMatchesDealType: (wallet.entry_side === "income" || wallet.entry_side === "expense") && wallet.entry_side === deal.type,
    dateNotBeforeIssueDate: validDate(wallet.date) && validDate(deal.issue_date) && wallet.date >= deal.issue_date,
    dateNotFuture: validDate(wallet.date) && wallet.date <= today,
    dealStatusUnsettled: deal.status === "unsettled",
  };
  const payload = { company_id: opts.companyId, deals: [{ deal_id: opts.dealId, amount: opts.amount }] };
  const mode = opts.execute ? "execute" as const : "dry-run" as const;
  const base = { task_id: opts.taskId, event: "wallet_txn_reconcile" as const, target_id: opts.walletTxnId, company_id: opts.companyId, mode, payload_redacted: payload };
  const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);
  if (opts.execute && failedGuards.length > 0) {
    const message = `reconcile guard failed: ${failedGuards.join(", ")}`;
    try {
      await deps.appendAudit({ ...base, timestamp: deps.now().toISOString(), status: "failed", write_state: "not_attempted", reason: `guard_failed:${failedGuards.join(",")}` });
    } catch { throw new Error(`${message}; audit append failed (write not_attempted)`); }
    throw new Error(message);
  }
  const partnerId = deal.partner_id ?? null;
  let partnerName: unknown = null;
  if (partnerId !== null) {
    assertId(partnerId as number, "invalid response: deal partner_id");
    partnerName = (await runPartnersGet({ companyId: opts.companyId, id: partnerId as number }, { client })).name ?? null;
  }
  let created: { wallet_txn_id: number; deal_ids: number[] } | undefined;
  if (!opts.execute) {
    await deps.appendAudit({ ...base, timestamp: deps.now().toISOString(), ...(failedGuards.length > 0 ? { status: "guard_failed", guards } as const : { status: "planned" } as const) });
  } else {
    let unexpectedAdjustment = false;
    try {
      created = await auditedAccountingWrite(base, deps, () => client.post(`/api/1/wallet_txns/${opts.walletTxnId}/reconcile`, { body: payload }), response => {
        unexpectedAdjustment = isRecord(response) && response.new_deal_id !== undefined && response.new_deal_id !== null;
        if (!isRecord(response) || response.wallet_txn_id !== opts.walletTxnId || !Array.isArray(response.deal_ids) || !response.deal_ids.every(id => typeof id === "number" && Number.isSafeInteger(id) && id > 0) || (response.deal_ids.length !== 1 || response.deal_ids[0] !== opts.dealId) || response.new_deal_id !== null) throw new Error("invalid reconcile response");
        return { wallet_txn_id: opts.walletTxnId, deal_ids: response.deal_ids as number[] };
      });
    } catch (error) {
      if (unexpectedAdjustment && error instanceof Error) error.message = `想定外の差額取引が作られた。${error.message}`;
      throw error;
    }
  }
  return { mode, payload, wallet_txn: { id: wallet.id, date: wallet.date ?? null, amount: wallet.amount ?? null, entry_side: wallet.entry_side ?? null, status: wallet.status ?? null, due_amount: wallet.due_amount ?? null, walletable_type: wallet.walletable_type ?? null, walletable_id: wallet.walletable_id ?? null }, deal: { id: deal.id, type: deal.type ?? null, issue_date: deal.issue_date ?? null, amount: deal.amount ?? null, due_amount: deal.due_amount ?? null, partner_id: partnerId, partner_name: partnerName }, guards, ...(created === undefined ? {} : { created }) };
}
