import { isRecord } from "../../lib/accounting-read.js";
import { assertId, assertAmount, assertDate } from "../../lib/accounting-validation.js";
import { auditedAccountingWrite } from "../../lib/accounting-write.js";
import { runDealsList } from "./list.js";
import { buildDealPlan, type DealPlanOptions } from "../../domain/deal-plan.js";
import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import { runAccountItemsList } from "../account-items/list.js";
import { runTaxesList } from "../taxes/list.js";
import { runPartnersGet } from "../partners/get.js";
import { redactAccountingPayload } from "../../lib/audit/accounting-audit.js";
import type { DealAuditEntry } from "../../lib/audit/deal-audit.js";
export interface DealsCreateOptions extends DealPlanOptions { execute?: boolean; expectTotal?: number; allowDuplicate?: boolean; invoiceId?: number; expectInvoiceNumber?: string; taskId: string; logDir: string; }
export interface DealsCreateDeps { getClient: () => Promise<PublicFreeeClient>; appendAudit: (entry: DealAuditEntry) => Promise<void>; now: () => Date; }
export async function runDealsCreate(opts: DealsCreateOptions, deps: DealsCreateDeps) {
  const { payload, total } = buildDealPlan(opts);
  if (opts.execute && (opts.expectTotal === undefined || !Number.isSafeInteger(opts.expectTotal) || opts.expectTotal !== total)) throw new Error("--expect-total must match details total");
  if (opts.invoiceId !== undefined) {
    assertId(opts.invoiceId, "invoice_id");
    if (opts.type !== "income") throw new Error("--invoice-id requires income");
    if (opts.execute && opts.expectInvoiceNumber === undefined) throw new Error("--expect-invoice-number is required with --invoice-id and --execute");
  } else if (opts.expectInvoiceNumber !== undefined) throw new Error("--expect-invoice-number requires --invoice-id");
  if (opts.expectInvoiceNumber !== undefined && (typeof opts.expectInvoiceNumber !== "string" || !opts.expectInvoiceNumber)) throw new Error("invalid --expect-invoice-number");
  const client = await deps.getClient();
  const invoiceCheck = opts.invoiceId === undefined ? undefined : await readInvoice(client, opts, total);
  const existing = await runDealsList({ companyId: opts.companyId, partnerId: opts.partnerId, startIssueDate: opts.issueDate, endIssueDate: opts.issueDate }, { client });
  for (const deal of existing.items) {
    assertId(deal.id as number, "response deal id"); assertId(deal.partner_id as number, "response partner_id");
    assertAmount(deal.amount as number, "response amount");
    if (typeof deal.issue_date !== "string") throw new Error("invalid response: deal issue_date");
    assertDate(deal.issue_date, "response issue_date");
  }
  const dealIds = existing.items.filter(d => d.partner_id === opts.partnerId && d.issue_date === opts.issueDate && d.amount === total).map(d => d.id as number);
  const duplicateCheck = { found: dealIds.length > 0, dealIds, blocked: dealIds.length > 0 && !opts.allowDuplicate };
  if (opts.execute && duplicateCheck.blocked) throw new Error("duplicate deal found; use --allow-duplicate only after checking");
  const partner = await runPartnersGet({ companyId: opts.companyId, id: opts.partnerId }, { client });
  const accounts = await runAccountItemsList(opts, { client });
  const taxes = await runTaxesList(opts, { client });
  const names = { partner: partner.name, accountItems: payload.details.map(d => accounts.items.find(a => a.id === d.account_item_id)?.name), taxes: payload.details.map(d => taxes.items.find(t => t.code === d.tax_code)?.name) };
  if (typeof names.partner !== "string" || !names.partner || [...names.accountItems, ...names.taxes].some(name => typeof name !== "string" || !name)) throw new Error("name lookup failed: partner/account_item/tax not found");
  const mode = opts.execute ? "execute" as const : "dry-run" as const;
  const base = { task_id: opts.taskId, event: "deal_create" as const, mode, company_id: opts.companyId, payload_redacted: redactAccountingPayload(payload) };
  if (!opts.execute) {
    await deps.appendAudit({ ...base, timestamp: deps.now().toISOString(), status: "planned" });
    return { mode, payload, total, names, duplicateCheck, ...(invoiceCheck === undefined ? {} : { invoiceCheck }),
      ...(opts.expectTotal === undefined ? {} : { checks: { expectTotal: { expected: opts.expectTotal, actual: total, matches: Number.isSafeInteger(opts.expectTotal) && opts.expectTotal === total } } }) };
  }
  const created = await auditedAccountingWrite(base, deps, () => client.post("/api/1/deals", { body: payload }), "deal");
  if (opts.invoiceId !== undefined) {
    try {
      const invoiceReadback = await readInvoice(client, opts, total, created.id);
      return { mode, payload, total, names, created, invoiceReadback };
    } catch {
      try {
        await deps.appendAudit({ ...base, timestamp: deps.now().toISOString(), status: "failed", write_state: "succeeded", created_id: created.id, reason: "invoice_readback_failed" });
      } catch { /* 作成済みの状態と再実行禁止の警告を維持する。 */ }
      throw new InvoiceDealReadbackError(created.id);
    }
  }
  return { mode, payload, total, names, created };
}

async function readInvoice(client: PublicFreeeClient, opts: DealsCreateOptions, total: number, createdId?: number) {
  const payload: unknown = await (await client.get(`/iv/invoices/${opts.invoiceId}`, { query: { company_id: opts.companyId } })).json();
  const invoice = isRecord(payload) ? payload.invoice : undefined;
  if (!isRecord(invoice)) throw new Error("invalid invoice response");
  if (invoice.id !== opts.invoiceId || invoice.company_id !== opts.companyId ||
      typeof invoice.invoice_number !== "string" || !invoice.invoice_number ||
      (opts.expectInvoiceNumber !== undefined && invoice.invoice_number !== opts.expectInvoiceNumber) ||
      (createdId === undefined
        ? invoice.deal_status !== "unregistered" || (invoice.deal_id !== undefined && invoice.deal_id !== null)
        : invoice.deal_status !== "registered" || invoice.deal_id !== createdId) ||
      invoice.cancel_status !== "uncanceled" || invoice.total_amount !== total ||
      invoice.partner_id !== opts.partnerId || invoice.billing_date !== opts.issueDate ||
      (invoice.payment_date ?? null) !== (opts.dueDate ?? null)) throw new Error("invoice preflight mismatch");
  return { id: invoice.id, invoice_number: invoice.invoice_number, deal_id: invoice.deal_id, deal_status: invoice.deal_status };
}

export class InvoiceDealReadbackError extends Error {
  readonly writeState = "succeeded";
  constructor(readonly createdId: number) {
    super(`警告:取引は作成済み(id=${createdId})。請求書の取引登録・紐付けを確認できません。再実行や画面での取引登録をせず、invoices getとdeals getで確認してください`);
    this.name = "InvoiceDealReadbackError";
  }
}
