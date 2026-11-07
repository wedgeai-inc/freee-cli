import { assertId, assertDate, assertAmount, assertTaxCode } from "../../lib/accounting-validation.js";
import { isRecord } from "../../lib/accounting-read.js";
import { auditedAccountingWrite } from "../../lib/accounting-write.js";
import { redactAccountingPayload, type AccountingAuditEntry } from "../../lib/audit/accounting-audit.js";
import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import { runDealsList } from "../deals/list.js";
import { runPartnersGet } from "../partners/get.js";
import { runAccountItemsList } from "../account-items/list.js";
import { runTaxesList } from "../taxes/list.js";

export interface WalletTxnsCreateDealOptions {
  walletTxnId: number; companyId: number; partnerId: number; accountItemId: number; taxCode: number; amount: number;
  issueDate?: string; description?: string; expectAmount?: number; expectDate?: string;
  execute?: boolean; logDir: string; taskId: string;
}
export interface WalletTxnsCreateDealDeps {
  getClient: () => Promise<PublicFreeeClient>;
  appendAudit: (entry: AccountingAuditEntry) => Promise<void>;
  now: () => Date;
}
function validDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { assertDate(value, "date"); return true; } catch { return false; }
}
export async function runWalletTxnsCreateDeal(opts: WalletTxnsCreateDealOptions, deps: WalletTxnsCreateDealDeps) {
  assertId(opts.walletTxnId, "wallet_txn_id");
  assertId(opts.companyId, "company_id");
  assertId(opts.partnerId, "partner_id");
  assertId(opts.accountItemId, "account_item_id");
  assertId(opts.amount, "amount");
  assertTaxCode(opts.taxCode);
  if (opts.issueDate !== undefined) assertDate(opts.issueDate, "--issue-date");
  if (opts.expectDate !== undefined) assertDate(opts.expectDate, "--expect-date");
  if (opts.expectAmount !== undefined) assertId(opts.expectAmount, "--expect-amount");
  if (opts.description !== undefined && typeof opts.description !== "string") throw new Error("description must be a string");
  if (opts.execute && opts.expectAmount === undefined) throw new Error("--expect-amount is required with --execute");
  const client = await deps.getClient();
  const response: unknown = await (await client.get(`/api/1/wallet_txns/${opts.walletTxnId}`, { query: { company_id: opts.companyId } })).json();
  const wallet = isRecord(response) ? response.wallet_txn : undefined;
  if (!isRecord(wallet) || wallet.id !== opts.walletTxnId) throw new Error("invalid response: wallet_txn");
  const issueDate = opts.issueDate ?? wallet.date;
  let dealIds: number[] = [];
  // 不正な明細日付はガードで表示し、日付を使う検索は行わない。
  if (validDate(issueDate)) {
    const existing = await runDealsList({ companyId: opts.companyId, partnerId: opts.partnerId, startIssueDate: issueDate, endIssueDate: issueDate }, { client });
    for (const deal of existing.items) {
      assertId(deal.id as number, "response deal id");
      assertId(deal.partner_id as number, "response partner_id");
      assertAmount(deal.amount as number, "response amount");
      if (!validDate(deal.issue_date)) throw new Error("invalid response: deal issue_date");
      if (deal.company_id !== undefined && deal.company_id !== opts.companyId) throw new Error("invalid response: deal company_id");
    }
    dealIds = existing.items.filter(d => d.partner_id === opts.partnerId && d.issue_date === issueDate && d.amount === opts.amount).map(d => d.id as number);
  }
  const duplicateCheck = { found: dealIds.length > 0, dealIds, blocked: dealIds.length > 0 };
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(deps.now());
  const guards = {
    expectedAmountMatches: opts.expectAmount === undefined || opts.expectAmount === opts.amount,
    expectedDateMatches: opts.expectDate === undefined || opts.expectDate === wallet.date,
    walletTxnCompanyMatches: wallet.company_id === opts.companyId,
    walletTxnUnreconciled: wallet.status === 1 && typeof wallet.amount === "number" && Number.isSafeInteger(wallet.amount) && wallet.amount > 0 && wallet.due_amount === wallet.amount,
    walletTxnAmountMatches: wallet.amount === opts.amount,
    entrySideKnown: wallet.entry_side === "income" || wallet.entry_side === "expense",
    issueDateNotAfterWalletDate: validDate(issueDate) && validDate(wallet.date) && issueDate <= wallet.date,
    dateNotFuture: validDate(wallet.date) && wallet.date <= today,
    noExistingDeal: !duplicateCheck.found,
  };
  const payload = { company_id: opts.companyId, issue_date: issueDate, partner_id: opts.partnerId, deal_lines: [{ amount: opts.amount, account_item_id: opts.accountItemId, tax_code: opts.taxCode, ...(opts.description === undefined ? {} : { description: opts.description }) }] };
  const mode = opts.execute ? "execute" as const : "dry-run" as const;
  const base = { task_id: opts.taskId, event: "wallet_txn_create_deal" as const, target_id: opts.walletTxnId, company_id: opts.companyId, mode, payload_redacted: redactAccountingPayload(payload) };
  const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);
  if (opts.execute && failedGuards.length) {
    const message = `create-deal guard failed: ${failedGuards.join(", ")}${duplicateCheck.found ? "; use wallet-txns reconcile for existing deals" : ""}`;
    try {
      await deps.appendAudit({ ...base, timestamp: deps.now().toISOString(), status: "failed", write_state: "not_attempted", reason: `guard_failed:${failedGuards.join(",")}` });
    } catch { throw new Error(`${message}; audit append failed (write not_attempted)`); }
    throw new Error(message);
  }
  const partner = await runPartnersGet({ companyId: opts.companyId, id: opts.partnerId }, { client });
  const accounts = await runAccountItemsList(opts, { client });
  const taxes = await runTaxesList(opts, { client });
  const names = { partner: partner.name, accountItems: [accounts.items.find(a => a.id === opts.accountItemId)?.name], taxes: [taxes.items.find(t => t.code === opts.taxCode)?.name] };
  if (typeof names.partner !== "string" || !names.partner || [...names.accountItems, ...names.taxes].some(name => typeof name !== "string" || !name)) throw new Error("name lookup failed: partner/account_item/tax not found");
  let created: { deal_ids: number[] } | undefined;
  let readback: Record<string, boolean> | undefined;
  if (!opts.execute) {
    await deps.appendAudit({ ...base, timestamp: deps.now().toISOString(), ...(failedGuards.length ? { status: "guard_failed", guards } as const : { status: "planned" } as const) });
  } else {
    let createdId: number | undefined;
    let invalidResponse = false;
    const writeDeps = { ...deps, appendAudit: (entry: AccountingAuditEntry) => deps.appendAudit({ ...entry, ...(createdId === undefined ? {} : { created_id: createdId }) }) };
    try {
      created = await auditedAccountingWrite(base, writeDeps, () => client.post(`/api/1/wallet_txns/${opts.walletTxnId}/create_deal`, { body: payload }), response => {
        if (!isRecord(response) || !Array.isArray(response.deal_ids) || response.deal_ids.length !== 1 || !Number.isSafeInteger(response.deal_ids[0]) || response.deal_ids[0] <= 0) {
          invalidResponse = true;
          throw new Error("invalid create_deal response");
        }
        createdId = response.deal_ids[0] as number;
        return { deal_ids: [createdId] };
      });
    } catch (error) {
      if (error instanceof Error) {
        if (invalidResponse) error.message += "; invalid create_deal response";
        if (createdId !== undefined) error.message += `; deal_id=${createdId}`;
      }
      throw error;
    }
    try {
      const walletResponse: unknown = await (await client.get(`/api/1/wallet_txns/${opts.walletTxnId}`, { query: { company_id: opts.companyId } })).json();
      const updatedWallet = isRecord(walletResponse) ? walletResponse.wallet_txn : undefined;
      const dealResponse: unknown = await (await client.get(`/api/1/deals/${createdId}`, { query: { company_id: opts.companyId } })).json();
      const deal = isRecord(dealResponse) ? dealResponse.deal : undefined;
      readback = {
        walletTxnReconciled: isRecord(updatedWallet) && updatedWallet.id === opts.walletTxnId && updatedWallet.company_id === opts.companyId && updatedWallet.status === 2 && updatedWallet.due_amount === 0,
        dealCompanyMatches: isRecord(deal) && deal.id === createdId && deal.company_id === opts.companyId,
        dealPartnerMatches: isRecord(deal) && deal.partner_id === opts.partnerId,
        dealAmountMatches: isRecord(deal) && deal.amount === opts.amount,
        dealIssueDateMatches: isRecord(deal) && deal.issue_date === issueDate,
        dealTypeMatches: isRecord(deal) && (wallet.entry_side === "income" || wallet.entry_side === "expense") && deal.type === wallet.entry_side,
      };
      if (Object.values(readback).some(ok => !ok)) throw new Error("readback mismatch");
    } catch {
      try {
        await deps.appendAudit({ ...base, timestamp: deps.now().toISOString(), status: "failed", write_state: "succeeded", created_id: createdId, reason: "readback_failed", ...(readback === undefined ? {} : { guards: readback }) });
      } catch { /* 監査失敗でも、作成済みIDを含む例外を優先する。 */ }
      throw Object.assign(new Error(`読み戻しに失敗。作成済みの可能性があります (deal_id=${createdId})。再実行しないでください。deals getで確認してください`), { createdId, readback });
    }
  }
  return { mode, payload, names, guards, duplicateCheck, wallet_txn: { id: wallet.id, date: wallet.date, amount: wallet.amount, entry_side: wallet.entry_side, status: wallet.status, due_amount: wallet.due_amount }, ...(created === undefined ? {} : { created, readback }) };
}
