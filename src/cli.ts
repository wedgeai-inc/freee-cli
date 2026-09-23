#!/usr/bin/env node
import { Command } from "commander";
import { isMainModule } from "./lib/main-module.js";
import { loadApiAuth } from "./lib/token-config-loader.js";
import { OnePasswordTokenStore } from "./lib/one-password-token-store.js";
import { runOAuthLogin } from "./commands/auth/oauth-login.js";
import { runExpenseList, formatExpenseList } from "./commands/expense/list.js";
import { PublicFreeeClient } from "./lib/clients/freee-public-client.js";
import { parseCompanyId } from "./lib/company-id.js";
import { parseMonth } from "./lib/month.js";
import { runExportReceipts } from "./commands/export/receipts.js";
import { runExportJournals } from "./commands/export/journals.js";
import { runExportWalletTxns } from "./commands/export/wallet-txns.js";
import { runExportExpenseApplications } from "./commands/export/expense-applications.js";
import { createInvoiceClient } from "./lib/clients/freee-invoice-client.js";
import { runInvoicesList, formatInvoicesList, validateInvoicesListOptions, type InvoicesListOptions } from "./commands/invoices/list.js";
import { runInvoicesGet, formatInvoiceDetail, validateInvoiceId } from "./commands/invoices/get.js";
import { runInvoicesTemplates, formatInvoiceTemplates } from "./commands/invoices/templates.js";
import { runInvoicesCreate, formatInvoiceCreate } from "./commands/invoices/create.js";
import { runInvoicesCancel, formatInvoiceCancel } from "./commands/invoices/cancel.js";
import { validateInvoiceMutationId } from "./commands/invoices/id.js";
import { runInvoicesUncancel, formatInvoiceUncancel } from "./commands/invoices/uncancel.js";
import { runInvoicesUpdate, formatInvoiceUpdate, UNOBSERVABLE_WARNING, UNOBSERVABLE_DETAIL } from "./commands/invoices/update.js";
import { appendInvoiceAudit, appendInvoiceCancelAudit, appendInvoiceUncancelAudit, appendInvoiceUpdateAudit } from "./lib/audit/invoice-audit.js";
import { runQuotationsList, formatQuotationsList, validateQuotationsListOptions, type QuotationsListOptions } from "./commands/quotations/list.js";
import { runQuotationsGet, formatQuotationDetail } from "./commands/quotations/get.js";
import { validateQuotationId } from "./commands/quotations/id.js";
import { runQuotationsTemplates, formatQuotationTemplates } from "./commands/quotations/templates.js";
import { runQuotationsCreate, formatQuotationCreate } from "./commands/quotations/create.js";
import { runQuotationsCancel, formatQuotationCancel } from "./commands/quotations/cancel.js";
import { runQuotationsUncancel, formatQuotationUncancel } from "./commands/quotations/uncancel.js";
import { appendQuotationAudit, appendQuotationCancelAudit, appendQuotationUncancelAudit } from "./lib/audit/quotation-audit.js";
import { appendPartnerAudit, appendPartnerUpdateAudit } from "./lib/audit/partner-audit.js";
import { runPartnersCreate, formatPartnerCreate } from "./commands/partners/create.js";
import { runPartnersGet, formatPartnerGet } from "./commands/partners/get.js";
import { runPartnersUpdate, formatPartnerUpdate } from "./commands/partners/update.js";
import { readFile as fsReadFile } from "node:fs/promises";
import { formatCompaniesList, runCompaniesList } from "./commands/companies/list.js";
import { formatPartnersSearch, runPartnersSearch } from "./commands/partners/search.js";
import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";

function parseInvoiceId(raw: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error("--id must be a positive integer");
  return Number(raw);
}

function parsePartnerId(raw: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error("--id must be a positive safe integer");
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) throw new Error("--id must be a positive safe integer");
  return id;
}

export function createProgram(): Command {
  const program = new Command();
  program.name("freee").description("Unofficial CLI for the freee public API").option("--profile <name>", "OAuth profile");
  const loadPublicApiAuth = () => loadApiAuth({ profile: program.opts<{ profile?: string }>().profile });

  const auth = program.command("auth").description("OAuth authentication");
  auth
    .command("login")
    .description("authorize once in a browser and store the OAuth token bundle")
    .option("--profile <name>", "OAuth profile")
    .action((opts) => {
      const clientId = process.env.FREEE_CLIENT_ID;
      const clientSecret = process.env.FREEE_CLIENT_SECRET;
      if (!clientId || !clientSecret) throw new Error("freee client credential environment is incomplete.");
      const profile = opts.profile ?? program.opts<{ profile?: string }>().profile ?? process.env.FREEE_OAUTH_PROFILE ?? "default";
      runOAuthLogin({ profile, clientId, clientSecret, store: new OnePasswordTokenStore() });
    });

  const expense = program.command("expense").description("expense operations");

  expense
    .command("list")
    .description("list expense applications")
    .requiredOption("--company-id <id>", "freee company ID")
    .option("--status <status>", "filter by status (e.g. approved)")
    .option("--start-transaction-date <YYYY-MM-DD>", "start transaction date")
    .option("--end-transaction-date <YYYY-MM-DD>", "end transaction date")
    .option("--format <format>", "output format: json or table", "json")
    .action(async (opts) => {
      const auth = await loadPublicApiAuth();
      const client = new PublicFreeeClient({
        baseUrl: "https://api.freee.co.jp",
        token: auth.accessToken,
      });
      const result = await runExpenseList(
        {
          companyId: parseCompanyId(opts.companyId),
          status: opts.status,
          startTransactionDate: opts.startTransactionDate,
          endTransactionDate: opts.endTransactionDate,
          format: opts.format === "table" ? "table" : "json",
        },
        { client },
      );
      console.log(formatExpenseList(result, opts.format === "table" ? "table" : "json"));
    });

  const invoices = program.command("invoices").description("invoice operations (list/get/templates are read-only; create is dry-run by default)");
  invoices
    .command("list")
    .description("list invoices")
    .requiredOption("--company-id <id>", "freee company ID")
    .option("--start-billing-date <YYYY-MM-DD>", "billing date lower bound")
    .option("--end-billing-date <YYYY-MM-DD>", "billing date upper bound")
    .option("--partner-ids <csv>", "up to three comma-separated partner IDs")
    .option("--sending-status <status>", "sent or unsent")
    .option("--payment-status <status>", "settled, unsettled, canceled, unprocessed, or failed")
    .option("--format <format>", "output format: json or table", "json")
    .action(async (opts) => {
      const format: "json" | "table" = opts.format === "table" ? "table" : "json";
      // 入力検証は認証ロード（token refresh の fetch を伴いうる）より前に行う
      const listOpts: InvoicesListOptions = {
        companyId: parseCompanyId(opts.companyId),
        startBillingDate: opts.startBillingDate,
        endBillingDate: opts.endBillingDate,
        partnerIds: opts.partnerIds,
        sendingStatus: opts.sendingStatus,
        paymentStatus: opts.paymentStatus,
        format,
      };
      validateInvoicesListOptions(listOpts);
      const auth = await loadPublicApiAuth();
      const client = createInvoiceClient({ token: auth.accessToken });
      const result = await runInvoicesList(listOpts, { client });
      console.log(formatInvoicesList(result, format));
    });

  invoices
    .command("get")
    .description("get an invoice")
    .requiredOption("--company-id <id>", "freee company ID")
    .requiredOption("--id <id>", "invoice ID")
    .option("--format <format>", "output format: json or table", "json")
    .action(async (opts) => {
      const format = opts.format === "table" ? "table" : "json";
      const companyId = parseCompanyId(opts.companyId);
      const id = parseInvoiceId(opts.id);
      validateInvoiceId(id);
      const auth = await loadPublicApiAuth();
      const client = createInvoiceClient({ token: auth.accessToken });
      const result = await runInvoicesGet({ companyId, id, format }, { client });
      console.log(formatInvoiceDetail(result, format));
    });

  invoices
    .command("templates")
    .description("list invoice templates")
    .requiredOption("--company-id <id>", "freee company ID")
    .option("--format <format>", "output format: json or table", "json")
    .action(async (opts) => {
      const format = opts.format === "table" ? "table" : "json";
      const companyId = parseCompanyId(opts.companyId);
      const auth = await loadPublicApiAuth();
      const client = createInvoiceClient({ token: auth.accessToken });
      const result = await runInvoicesTemplates({ companyId, format }, { client });
      console.log(formatInvoiceTemplates(result, format));
    });

  invoices
    .command("create")
    .description("create one invoice draft from a plan JSON (default: dry-run)")
    .requiredOption("--company-id <id>", "freee company ID")
    .requiredOption("--plan <path>", "plan JSON path (POST /invoices body without company_id)")
    .option("--execute", "execute real POST (default: dry-run)")
    .option("--log-dir <path>", "audit log output directory", "./audit-logs")
    .option("--task-id <id>", "task ID for audit log", "freee-invoice-create")
    .action(async (opts) => {
      const logDir: string = opts.logDir;
      const result = await runInvoicesCreate(
        {
          companyId: parseCompanyId(opts.companyId),
          planPath: opts.plan,
          execute: Boolean(opts.execute),
          logDir,
          taskId: opts.taskId,
        },
        {
          getClient: async () => {
            const auth = await loadPublicApiAuth();
            return createInvoiceClient({ token: auth.accessToken });
          },
          readFile: (p) => fsReadFile(p, "utf8"),
          appendAudit: (entry) => appendInvoiceAudit(logDir, entry),
          now: () => new Date(),
        },
      );
      console.log(formatInvoiceCreate(result));
    });

  invoices
    .command("cancel")
    .description("cancel one invoice (default: dry-run; linked registered deal requires explicit approval)")
    .requiredOption("--company-id <id>", "freee company ID")
    .requiredOption("--id <id>", "invoice ID")
    .option("--expect-invoice-number <number>", "required with --execute; must exactly match the read invoice number")
    .option("--allow-deal-deletion", "allow cancellation when a linked deal is registered")
    .option("--execute", "execute real PUT (default: dry-run)")
    .option("--log-dir <path>", "audit log output directory", "./audit-logs")
    .option("--task-id <id>", "task ID for audit log", "freee-invoice-cancel")
    .action(async (opts) => {
      const id = parseInvoiceId(opts.id);
      validateInvoiceMutationId(id);
      const logDir: string = opts.logDir;
      const result = await runInvoicesCancel(
        { companyId: parseCompanyId(opts.companyId), id, execute: Boolean(opts.execute), logDir, taskId: opts.taskId, expectInvoiceNumber: opts.expectInvoiceNumber, allowDealDeletion: Boolean(opts.allowDealDeletion) },
        {
          getClient: async () => { const auth = await loadPublicApiAuth(); return createInvoiceClient({ token: auth.accessToken }); },
          appendAudit: (entry) => appendInvoiceCancelAudit(logDir, entry),
          now: () => new Date(),
        },
      );
      console.log(formatInvoiceCancel(result));
    });

  invoices
    .command("update")
    .description("update one invoice from a partial plan (default: dry-run)")
    .requiredOption("--company-id <id>", "freee company ID")
    .requiredOption("--id <id>", "invoice ID")
    .requiredOption("--plan <path>", "partial plan JSON")
    .option("--expect-invoice-number <number>", "required with --execute; must exactly match the read invoice number")
    .option("--allow-deal-registered", "allow update when a linked deal is registered")
    .option("--execute", "execute real PUT (default: dry-run)")
    .option("--log-dir <path>", "audit log output directory", "./audit-logs")
    .option("--task-id <id>", "task ID for audit log", "freee-invoice-update")
    .action(async (opts) => {
      const id = parseInvoiceId(opts.id); validateInvoiceMutationId(id); const logDir: string = opts.logDir;
      try {
        const result = await runInvoicesUpdate(
          { companyId: parseCompanyId(opts.companyId), id, planPath: opts.plan, execute: Boolean(opts.execute), logDir, taskId: opts.taskId, expectInvoiceNumber: opts.expectInvoiceNumber, allowDealRegistered: Boolean(opts.allowDealRegistered) },
          { getClient: async () => { const auth = await loadPublicApiAuth(); return createInvoiceClient({ token: auth.accessToken }); }, readFile: (p) => fsReadFile(p, "utf8"), appendAudit: (entry) => appendInvoiceUpdateAudit(logDir, entry), now: () => new Date() },
        );
        console.log(formatInvoiceUpdate(result));
      } finally {
        console.error(UNOBSERVABLE_WARNING);
        console.error(UNOBSERVABLE_DETAIL);
      }
    });

  invoices.command("uncancel").description("restore one canceled invoice (default: dry-run)").requiredOption("--company-id <id>", "freee company ID").requiredOption("--id <id>", "invoice ID").option("--expect-invoice-number <number>", "required with --execute; must exactly match the read invoice number").option("--execute", "execute real PUT (default: dry-run)").option("--log-dir <path>", "audit log output directory", "./audit-logs").option("--task-id <id>", "task ID for audit log", "freee-invoice-uncancel").action(async (opts) => { const companyId = parseCompanyId(opts.companyId); const id = parseInvoiceId(opts.id); validateInvoiceMutationId(id); const result = await runInvoicesUncancel({ companyId, id, execute: Boolean(opts.execute), logDir: opts.logDir, taskId: opts.taskId, expectInvoiceNumber: opts.expectInvoiceNumber }, { getClient: async () => { const auth = await loadPublicApiAuth(); return createInvoiceClient({ token: auth.accessToken }); }, appendAudit: (entry) => appendInvoiceUncancelAudit(opts.logDir, entry), now: () => new Date() }); console.log(formatInvoiceUncancel(result)); });

  const quotations = program.command("quotations").description("quotation operations (create/cancel are dry-run by default)");
  quotations.command("list").requiredOption("--company-id <id>").option("--quotation-number <number>").option("--subject <subject>").option("--partner-ids <csv>").option("--sending-status <status>").option("--cancel-status <status>").option("--start-quotation-date <YYYY-MM-DD>").option("--end-quotation-date <YYYY-MM-DD>").option("--start-expiration-date <YYYY-MM-DD>").option("--end-expiration-date <YYYY-MM-DD>").option("--sales-management-origin").option("--format <format>", "output format", "json").action(async (opts) => { const format = opts.format === "table" ? "table" : "json"; const values: QuotationsListOptions = { companyId: parseCompanyId(opts.companyId), quotationNumber: opts.quotationNumber, subject: opts.subject, partnerIds: opts.partnerIds, sendingStatus: opts.sendingStatus, cancelStatus: opts.cancelStatus, startQuotationDate: opts.startQuotationDate, endQuotationDate: opts.endQuotationDate, startExpirationDate: opts.startExpirationDate, endExpirationDate: opts.endExpirationDate, salesManagementOrigin: opts.salesManagementOrigin }; validateQuotationsListOptions(values); const auth = await loadPublicApiAuth(); console.log(formatQuotationsList(await runQuotationsList(values, { client: createInvoiceClient({ token: auth.accessToken }) }), format)); });
  quotations.command("get").requiredOption("--company-id <id>").requiredOption("--id <id>").option("--format <format>", "output format", "json").action(async (opts) => { const companyId = parseCompanyId(opts.companyId); const id = parseInvoiceId(opts.id); validateQuotationId(id); const auth = await loadPublicApiAuth(); const result = await runQuotationsGet({ companyId, id }, { client: createInvoiceClient({ token: auth.accessToken }) }); console.log(formatQuotationDetail(result, opts.format === "table" ? "table" : "json")); });
  quotations.command("templates").requiredOption("--company-id <id>").option("--format <format>", "output format", "json").action(async (opts) => { const companyId = parseCompanyId(opts.companyId); const auth = await loadPublicApiAuth(); console.log(formatQuotationTemplates(await runQuotationsTemplates({ companyId }, { client: createInvoiceClient({ token: auth.accessToken }) }), opts.format === "table" ? "table" : "json")); });
  quotations.command("create").requiredOption("--company-id <id>").requiredOption("--plan <path>").option("--execute").option("--log-dir <path>", "audit log output directory", "./audit-logs").option("--task-id <id>", "task ID", "freee-quotation-create").action(async (opts) => { const result = await runQuotationsCreate({ companyId: parseCompanyId(opts.companyId), planPath: opts.plan, execute: Boolean(opts.execute), logDir: opts.logDir, taskId: opts.taskId }, { getClient: async () => { const auth = await loadPublicApiAuth(); return createInvoiceClient({ token: auth.accessToken }); }, readFile: (p) => fsReadFile(p, "utf8"), appendAudit: (entry) => appendQuotationAudit(opts.logDir, entry), now: () => new Date() }); console.log(formatQuotationCreate(result)); });
  quotations.command("cancel").requiredOption("--company-id <id>").requiredOption("--id <id>").option("--expect-quotation-number <number>").option("--execute").option("--log-dir <path>", "audit log output directory", "./audit-logs").option("--task-id <id>", "task ID", "freee-quotation-cancel").action(async (opts) => { const id = parseInvoiceId(opts.id); validateQuotationId(id); const result = await runQuotationsCancel({ companyId: parseCompanyId(opts.companyId), id, execute: Boolean(opts.execute), logDir: opts.logDir, taskId: opts.taskId, expectQuotationNumber: opts.expectQuotationNumber }, { getClient: async () => { const auth = await loadPublicApiAuth(); return createInvoiceClient({ token: auth.accessToken }); }, appendAudit: (entry) => appendQuotationCancelAudit(opts.logDir, entry), now: () => new Date() }); console.log(formatQuotationCancel(result)); });
  quotations.command("uncancel").requiredOption("--company-id <id>").requiredOption("--id <id>").option("--expect-quotation-number <number>").option("--execute").option("--log-dir <path>", "audit log output directory", "./audit-logs").option("--task-id <id>", "task ID", "freee-quotation-uncancel").action(async (opts) => { const companyId = parseCompanyId(opts.companyId); const id = parseInvoiceId(opts.id); validateQuotationId(id); const result = await runQuotationsUncancel({ companyId, id, execute: Boolean(opts.execute), logDir: opts.logDir, taskId: opts.taskId, expectQuotationNumber: opts.expectQuotationNumber }, { getClient: async () => { const auth = await loadPublicApiAuth(); return createInvoiceClient({ token: auth.accessToken }); }, appendAudit: (entry) => appendQuotationUncancelAudit(opts.logDir, entry), now: () => new Date() }); console.log(formatQuotationUncancel(result)); });

  const companies = program.command("companies").description("read-only company operations");
  companies
    .command("list")
    .description("list companies")
    .option("--format <format>", "output format: json or table", "json")
    .action(async (opts) => {
      const auth = await loadPublicApiAuth();
      const client = new PublicFreeeClient({
        baseUrl: "https://api.freee.co.jp",
        token: auth.accessToken,
      });
      const format = opts.format === "table" ? "table" : "json";
      const result = await runCompaniesList({ client });
      console.log(formatCompaniesList(result, format));
    });

  const partners = program.command("partners").description("partner read and write operations");
  partners
    .command("search")
    .description("search partners")
    .requiredOption("--company-id <id>", "freee company ID")
    .option("--keyword <keyword>", "partner name or code keyword")
    .option("--format <format>", "output format: json or table", "json")
    .action(async (opts) => {
      const companyId = parseCompanyId(opts.companyId);
      const auth = await loadPublicApiAuth();
      const client = new PublicFreeeClient({
        baseUrl: "https://api.freee.co.jp",
        token: auth.accessToken,
      });
      const format = opts.format === "table" ? "table" : "json";
      const result = await runPartnersSearch(
        { companyId, keyword: opts.keyword, format },
        { client },
      );
      console.log(formatPartnersSearch(result, format));
    });

  partners
    .command("create")
    .description("create one partner from a plan JSON (default: dry-run)")
    .requiredOption("--company-id <id>", "freee company ID")
    .requiredOption("--plan <path>", "plan JSON path (POST /api/1/partners body without company_id)")
    .option("--execute", "execute real POST (default: dry-run)")
    .option("--log-dir <path>", "audit log output directory", "./audit-logs")
    .option("--task-id <id>", "task ID for audit log", "freee-partner-create")
    .action(async (opts) => {
      const logDir: string = opts.logDir;
      const result = await runPartnersCreate(
        { companyId: parseCompanyId(opts.companyId), planPath: opts.plan, execute: Boolean(opts.execute), logDir, taskId: opts.taskId },
        {
          getClient: async () => { const auth = await loadPublicApiAuth(); return new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: auth.accessToken }); },
          readFile: (p) => fsReadFile(p, "utf8"), appendAudit: (entry) => appendPartnerAudit(logDir, entry), now: () => new Date(),
        },
      );
      console.log(formatPartnerCreate(result));
    });

  partners
    .command("get")
    .description("get one partner as JSON")
    .requiredOption("--company-id <id>", "freee company ID")
    .requiredOption("--id <id>", "partner ID")
    .action(async (opts) => {
      const companyId = parseCompanyId(opts.companyId);
      const id = parsePartnerId(opts.id);
      const auth = await loadPublicApiAuth();
      const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: auth.accessToken });
      const result = await runPartnersGet({ companyId, id }, { client });
      console.log(formatPartnerGet(result));
    });

  partners
    .command("update")
    .description("update one partner from a plan JSON (default: dry-run)")
    .requiredOption("--company-id <id>", "freee company ID")
    .requiredOption("--id <id>", "partner ID")
    .requiredOption("--plan <path>", "plan JSON path (PUT /api/1/partners/{id} body without company_id)")
    .option("--expect-name <name>", "expected current partner name (required with --execute)")
    .option("--execute", "execute real PUT (default: dry-run)")
    .option("--log-dir <path>", "audit log output directory", "./audit-logs")
    .option("--task-id <id>", "task ID for audit log", "freee-partner-update")
    .action(async (opts) => {
      const logDir: string = opts.logDir;
      const companyId = parseCompanyId(opts.companyId);
      const id = parsePartnerId(opts.id);
      const result = await runPartnersUpdate(
        { companyId, id, planPath: opts.plan, execute: Boolean(opts.execute), logDir, taskId: opts.taskId, expectName: opts.expectName },
        { getClient: async () => { const auth = await loadPublicApiAuth(); return new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: auth.accessToken }); }, readFile: (p) => fsReadFile(p, "utf8"), appendAudit: (entry) => appendPartnerUpdateAudit(logDir, entry), now: () => new Date() },
      );
      console.log(formatPartnerUpdate(result));
    });

  const exportCmd = program
    .command("export")
    .description("export evidence/journals into a local validation dataset (read-only)");

  function resolveDateRange(opts: { month?: string; startDate?: string; endDate?: string }): {
    startDate: string;
    endDate: string;
  } {
    if (opts.month) {
      const range = parseMonth(opts.month);
      return {
        startDate: opts.startDate ?? range.startDate,
        endDate: opts.endDate ?? range.endDate,
      };
    }
    if (opts.startDate && opts.endDate) {
      return { startDate: opts.startDate, endDate: opts.endDate };
    }
    throw new Error("Specify --month YYYY-MM, or both --start-date and --end-date");
  }

  const fsDeps = {
    ensureDir: async (p: string) => {
      await mkdir(p, { recursive: true });
    },
    writeFile: async (p: string, data: Buffer | string) => {
      await fsWriteFile(p, data);
    },
  };

  exportCmd
    .command("receipts")
    .description("download filebox receipts (index.json + files/) for a period")
    .requiredOption("--company-id <id>", "freee company ID")
    .requiredOption("--out <dir>", "output directory")
    .option("--month <YYYY-MM>", "target month (sets start/end of month)")
    .option("--start-date <YYYY-MM-DD>", "start date (overrides --month start)")
    .option("--end-date <YYYY-MM-DD>", "end date (overrides --month end)")
    .action(async (opts) => {
      const { startDate, endDate } = resolveDateRange(opts);
      const auth = await loadPublicApiAuth();
      const client = new PublicFreeeClient({
        baseUrl: "https://api.freee.co.jp",
        token: auth.accessToken,
      });
      const result = await runExportReceipts(
        { companyId: parseCompanyId(opts.companyId), startDate, endDate, outDir: opts.out },
        { client, ...fsDeps },
      );
      console.log(
        `receipts: ${result.saved}/${result.total} saved` +
          (result.failed.length ? `, ${result.failed.length} failed` : ""),
      );
      console.log(`  index: ${result.indexPath}`);
      console.log(`  files: ${result.filesDir}`);
      if (result.failed.length) {
        for (const f of result.failed) console.warn(`  failed ${f.id}: ${f.reason}`);
        process.exitCode = 1;
      }
    });

  exportCmd
    .command("journals")
    .description("export the journal book (async) for a period and save it locally")
    .requiredOption("--company-id <id>", "freee company ID")
    .requiredOption("--out <dir>", "output directory")
    .option("--month <YYYY-MM>", "target month (sets start/end of month)")
    .option("--start-date <YYYY-MM-DD>", "start date (overrides --month start)")
    .option("--end-date <YYYY-MM-DD>", "end date (overrides --month end)")
    .option("--download-type <type>", "generic_v2 | generic | csv | pdf (encoding applies to generic*)", "generic_v2")
    .option("--encoding <enc>", "utf-8 | sjis (generic/generic_v2 only)", "utf-8")
    .action(async (opts) => {
      const { startDate, endDate } = resolveDateRange(opts);
      const auth = await loadPublicApiAuth();
      const client = new PublicFreeeClient({
        baseUrl: "https://api.freee.co.jp",
        token: auth.accessToken,
      });
      const result = await runExportJournals(
        {
          companyId: parseCompanyId(opts.companyId),
          startDate,
          endDate,
          outDir: opts.out,
          downloadType: opts.downloadType,
          encoding: opts.encoding,
        },
        {
          client,
          ...fsDeps,
          sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
        },
      );
      console.log(`journals: ${result.status} (report ${result.id})`);
      console.log(`  output: ${result.outputPath}`);
    });

  exportCmd
    .command("wallet-txns")
    .description("export wallet/card transactions for a period as JSON and CSV")
    .requiredOption("--company-id <id>", "freee company ID")
    .requiredOption("--out <dir>", "output directory")
    .requiredOption("--walletable-id <id>", "freee walletable ID")
    .requiredOption("--walletable-type <type>", "walletable type: wallet, credit_card, bank_account")
    .requiredOption("--source-name <name>", "source label to embed in output, e.g. card-a")
    .option("--month <YYYY-MM>", "target month (sets start/end of month)")
    .option("--start-date <YYYY-MM-DD>", "start date (overrides --month start)")
    .option("--end-date <YYYY-MM-DD>", "end date (overrides --month end)")
    .action(async (opts) => {
      const { startDate, endDate } = resolveDateRange(opts);
      const auth = await loadPublicApiAuth();
      const client = new PublicFreeeClient({
        baseUrl: "https://api.freee.co.jp",
        token: auth.accessToken,
      });
      const result = await runExportWalletTxns(
        {
          companyId: parseCompanyId(opts.companyId),
          startDate,
          endDate,
          outDir: opts.out,
          walletableId: parseCompanyId(opts.walletableId),
          walletableType: opts.walletableType,
          sourceName: opts.sourceName,
        },
        { client, ...fsDeps },
      );
      console.log(`wallet-txns: ${result.total} exported`);
      console.log(`  json: ${result.jsonPath}`);
      console.log(`  csv: ${result.csvPath}`);
    });

  exportCmd
    .command("expense-applications")
    .description("export expense applications and attached receipts for a period")
    .requiredOption("--company-id <id>", "freee company ID")
    .requiredOption("--out <dir>", "output directory")
    .option("--month <YYYY-MM>", "target month (sets start/end of month)")
    .option("--start-date <YYYY-MM-DD>", "start date (overrides --month start)")
    .option("--end-date <YYYY-MM-DD>", "end date (overrides --month end)")
    .action(async (opts) => {
      const { startDate, endDate } = resolveDateRange(opts);
      const auth = await loadPublicApiAuth();
      const client = new PublicFreeeClient({
        baseUrl: "https://api.freee.co.jp",
        token: auth.accessToken,
      });
      const result = await runExportExpenseApplications(
        {
          companyId: parseCompanyId(opts.companyId),
          startDate,
          endDate,
          outDir: opts.out,
        },
        { client, ...fsDeps },
      );
      console.log(
        `expense-applications: ${result.total} exported, ` +
          `${result.savedReceipts}/${result.receiptIds.length} receipts saved` +
          (result.failedReceipts.length ? `, ${result.failedReceipts.length} failed` : ""),
      );
      console.log(`  index: ${result.indexPath}`);
      console.log(`  receipts: ${result.receiptsIndexPath}`);
      console.log(`  files: ${result.filesDir}`);
      if (result.failedReceipts.length) {
        for (const f of result.failedReceipts) console.warn(`  failed ${f.id}: ${f.reason}`);
        process.exitCode = 1;
      }
    });

  return program;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  createProgram().parseAsync(process.argv).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}
