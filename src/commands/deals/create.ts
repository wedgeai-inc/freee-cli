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
export interface DealsCreateOptions extends DealPlanOptions { execute?: boolean; expectTotal?: number; allowDuplicate?: boolean; taskId: string; logDir: string; }
export interface DealsCreateDeps { getClient: () => Promise<PublicFreeeClient>; appendAudit: (entry: DealAuditEntry) => Promise<void>; now: () => Date; }
export async function runDealsCreate(opts: DealsCreateOptions, deps: DealsCreateDeps) {
  const { payload, total } = buildDealPlan(opts);
  if (opts.execute && (opts.expectTotal === undefined || !Number.isSafeInteger(opts.expectTotal) || opts.expectTotal !== total)) throw new Error("--expect-total must match details total");
  const client = await deps.getClient();
  if (opts.execute) {
    const existing = await runDealsList({ companyId: opts.companyId, partnerId: opts.partnerId, startIssueDate: opts.issueDate, endIssueDate: opts.issueDate }, { client });
    for (const deal of existing.items) {
      assertId(deal.id as number, "response deal id"); assertId(deal.partner_id as number, "response partner_id");
      assertAmount(deal.amount as number, "response amount");
      if (typeof deal.issue_date !== "string") throw new Error("invalid response: deal issue_date");
      assertDate(deal.issue_date, "response issue_date");
    }
    if (existing.items.some(d => d.partner_id === opts.partnerId && d.issue_date === opts.issueDate && d.amount === total) && !opts.allowDuplicate) throw new Error("duplicate deal found; use --allow-duplicate only after checking");
  }
  const partner = await runPartnersGet({ companyId: opts.companyId, id: opts.partnerId }, { client });
  const accounts = await runAccountItemsList(opts, { client });
  const taxes = await runTaxesList(opts, { client });
  const names = { partner: partner.name, accountItems: payload.details.map(d => accounts.items.find(a => a.id === d.account_item_id)?.name), taxes: payload.details.map(d => taxes.items.find(t => t.code === d.tax_code)?.name) };
  if (typeof names.partner !== "string" || !names.partner || [...names.accountItems, ...names.taxes].some(name => typeof name !== "string" || !name)) throw new Error("name lookup failed: partner/account_item/tax not found");
  const mode = opts.execute ? "execute" as const : "dry-run" as const;
  const base = { task_id: opts.taskId, event: "deal_create" as const, mode, company_id: opts.companyId, payload_redacted: redactAccountingPayload(payload) };
  if (!opts.execute) {
    await deps.appendAudit({ ...base, timestamp: deps.now().toISOString(), status: "planned" });
    return { mode, payload, total, names };
  }
  const created = await auditedAccountingWrite(base, deps, () => client.post("/api/1/deals", { body: payload }), "deal");
  return { mode, payload, total, names, created };
}
