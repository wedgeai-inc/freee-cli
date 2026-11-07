import { runWalletTxnsCreateDeal } from "./wallet-txns/create-deal.js";
import { runWalletTxnsReconcile } from "./wallet-txns/reconcile.js";
import { runWalletTxnsList, validateWalletTxnsListOptions, type WalletTxnsListOptions } from "./wallet-txns/list.js";
import type { ReadOnlyClient } from "../lib/clients/read-only-client.js";
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import type { PublicFreeeClient } from "../lib/clients/freee-public-client.js";
import { parseCompanyId, parsePositiveIntegerOption } from "../lib/company-id.js";
import { runAccountItemsList } from "./account-items/list.js";
import { runTaxesList } from "./taxes/list.js";
import { runDealsList, validateDealRefNumber } from "./deals/list.js";
import { runDealsGet } from "./deals/get.js";
import { withSignedDealAmounts } from "../lib/deal-signed-output.js";
import { runDealsPaymentsCreate } from "./deals/payments/create.js";
import { appendAccountingAudit } from "../lib/audit/accounting-audit.js";
import { runDealsCreate } from "./deals/create.js";
import { runDealsAttachReceipt } from "./deals/attach-receipt.js";
import { runReceiptsGet } from "./receipts/get.js";
import { runReceiptsList, validateReceiptsListOptions } from "./receipts/list.js";
import { runReceiptsUpdate } from "./receipts/update.js";
import { runReceiptsUpload } from "./receipts/upload.js";
import { appendDealAudit } from "../lib/audit/deal-audit.js";
import { appendReceiptAudit } from "../lib/audit/receipt-audit.js";

const collect = (value: string, previous: string[]) => [...previous, value];
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
function company(command: Command): Command { return command.requiredOption("--company-id <id>", "freee company ID"); }
function writeOptions(command: Command): Command {
  return company(command).option("--execute", "execute real write (default: dry-run)")
    .option("--log-dir <path>", "audit log output directory", "./audit-logs")
    .option("--task-id <id>", "task ID", "freee-accounting-write");
}
function expectedTotal(raw: string | undefined, flag = "--expect-total"): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^-?[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`${flag} must be a safe integer`);
  return Number(raw);
}
function parseOffset(raw: string): number {
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 2147483647) throw new Error("--offset must be an integer between 0 and 2147483647");
  return Number(raw);
}
export function registerAccountingCommands(program: Command, getClient: () => Promise<PublicFreeeClient>, getReadOnlyClient: () => Promise<ReadOnlyClient>): void {
  company(program.command("account-items").command("list")).action(async opts => output((await runAccountItemsList({ companyId: parseCompanyId(opts.companyId) }, { client: await getClient() })).items));
  company(program.command("taxes").command("list")).action(async opts => output((await runTaxesList({ companyId: parseCompanyId(opts.companyId) }, { client: await getClient() })).items));
  const walletTxns = program.command("wallet-txns");
  company(walletTxns.command("list"))
    .option("--walletable-type <type>").option("--walletable-id <id>")
    .option("--start-date <YYYY-MM-DD>").option("--end-date <YYYY-MM-DD>")
    .option("--entry-side <side>").option("--sort-type <type>")
    .option("--limit <n>").option("--offset <n>")
    .action(async opts => {
      const options: WalletTxnsListOptions = {
        companyId: parseCompanyId(opts.companyId), walletableType: opts.walletableType,
        walletableId: opts.walletableId === undefined ? undefined : parsePositiveIntegerOption(opts.walletableId, "--walletable-id"),
        startDate: opts.startDate, endDate: opts.endDate, entrySide: opts.entrySide, sortType: opts.sortType,
        limit: opts.limit === undefined ? undefined : /^[0-9]+$/.test(opts.limit) ? Number(opts.limit) : NaN,
        offset: opts.offset === undefined ? undefined : parseOffset(opts.offset),
      };
      validateWalletTxnsListOptions(options);
      output((await runWalletTxnsList(options, { client: await getReadOnlyClient() })).items);
    });
  writeOptions(walletTxns.command("reconcile <wallet-txn-id>"))
    .requiredOption("--deal-id <id>").requiredOption("--amount <n>")
    .option("--expect-amount <n>").option("--expect-date <YYYY-MM-DD>")
    .action(async (walletTxnId, opts) => {
      const result = await runWalletTxnsReconcile({
        walletTxnId: parsePositiveIntegerOption(walletTxnId, "wallet-txn-id"),
        companyId: parseCompanyId(opts.companyId), dealId: parsePositiveIntegerOption(opts.dealId, "--deal-id"),
        amount: parsePositiveIntegerOption(opts.amount, "--amount"),
        expectAmount: opts.expectAmount === undefined ? undefined : parsePositiveIntegerOption(opts.expectAmount, "--expect-amount"),
        expectDate: opts.expectDate, execute: Boolean(opts.execute), logDir: opts.logDir, taskId: opts.taskId,
      }, { getClient, appendAudit: entry => appendAccountingAudit(opts.logDir, entry), now: () => new Date() });
      output(result);
      if (result.mode === "dry-run" && Object.values(result.guards).some(ok => !ok)) process.exitCode = 1;
    });
  writeOptions(walletTxns.command("create-deal <wallet-txn-id>"))
    .requiredOption("--partner-id <id>").requiredOption("--account-item-id <id>")
    .requiredOption("--tax-code <n>").requiredOption("--amount <n>")
    .option("--issue-date <YYYY-MM-DD>").option("--description <text>")
    .option("--expect-amount <n>").option("--expect-date <YYYY-MM-DD>")
    .action(async (walletTxnId, opts) => {
      const result = await runWalletTxnsCreateDeal({
        walletTxnId: parsePositiveIntegerOption(walletTxnId, "wallet-txn-id"),
        companyId: parseCompanyId(opts.companyId), partnerId: parsePositiveIntegerOption(opts.partnerId, "--partner-id"),
        accountItemId: parsePositiveIntegerOption(opts.accountItemId, "--account-item-id"),
        taxCode: /^[0-9]+$/.test(opts.taxCode) ? Number(opts.taxCode) : NaN,
        amount: parsePositiveIntegerOption(opts.amount, "--amount"),
        issueDate: opts.issueDate, description: opts.description,
        expectAmount: opts.expectAmount === undefined ? undefined : parsePositiveIntegerOption(opts.expectAmount, "--expect-amount"),
        expectDate: opts.expectDate, execute: Boolean(opts.execute), logDir: opts.logDir, taskId: opts.taskId,
      }, { getClient, appendAudit: entry => appendAccountingAudit(opts.logDir, entry), now: () => new Date() });
      output(result);
      if (result.mode === "dry-run" && Object.values(result.guards).some(ok => !ok)) process.exitCode = 1;
    });
  const deals = program.command("deals").description("deal operations (default: dry-run)");
  const receipts = program.command("receipts").description("receipt operations (default: dry-run)");
  company(receipts.command("list")).requiredOption("--start-date <YYYY-MM-DD>").requiredOption("--end-date <YYYY-MM-DD>")
    .option("--user-name <text>").option("--number <n>").option("--comment-type <type>").option("--comment-important").option("--no-comment-important")
    .option("--category <category>").option("--limit <n>").option("--offset <n>")
    .action(async opts => {
      if (opts.offset !== undefined && !/^[0-9]+$/.test(opts.offset)) throw new Error("--offset must be a non-negative integer");
      const options = {
        companyId: parseCompanyId(opts.companyId), startDate: opts.startDate, endDate: opts.endDate,
        userName: opts.userName, number: opts.number === undefined ? undefined : parsePositiveIntegerOption(opts.number, "--number"),
        commentType: opts.commentType, commentImportant: opts.commentImportant, category: opts.category,
        limit: opts.limit === undefined ? undefined : parsePositiveIntegerOption(opts.limit, "--limit"),
        offset: opts.offset === undefined ? undefined : Number(opts.offset),
      };
      validateReceiptsListOptions(options);
      output((await runReceiptsList(options, { client: await getReadOnlyClient() })).items);
    });
  company(deals.command("list")).option("--partner-id <id>").option("--type <type>").option("--start-issue-date <YYYY-MM-DD>").option("--end-issue-date <YYYY-MM-DD>").option("--status <status>").option("--ref-number <text>", "全ページ取得後に管理番号で完全一致検索し、1件だけの場合に成功")
    .action(async opts => {
      validateDealRefNumber(opts.refNumber);
      output((await runDealsList({ companyId: parseCompanyId(opts.companyId), partnerId: opts.partnerId === undefined ? undefined : parsePositiveIntegerOption(opts.partnerId, "--partner-id"), type: opts.type, startIssueDate: opts.startIssueDate, endIssueDate: opts.endIssueDate, status: opts.status, refNumber: opts.refNumber }, { client: await getClient() })).items.map(withSignedDealAmounts));
    });
  for (const [root, run] of [[deals, runDealsGet], [receipts, runReceiptsGet]] as const) {
    company(root.command("get <id>")).action(async (id, opts) => {
      const result = await run({ companyId: parseCompanyId(opts.companyId), id: parsePositiveIntegerOption(id, "id") }, { client: await getClient() });
      output(root === deals ? withSignedDealAmounts(result) : result);
    });
  }
  writeOptions(deals.command("create")).requiredOption("--type <type>", "income or expense").requiredOption("--issue-date <YYYY-MM-DD>").option("--due-date <YYYY-MM-DD>")
    .requiredOption("--partner-id <id>").requiredOption("--detail <detail>", "account_item_id=...,tax_code=...,amount=...,description=... (repeatable)", collect, [])
    .option("--receipt-id <id>", "receipt ID (repeatable)", collect, []).option("--ref-number <text>").option("--expect-total <amount>").option("--allow-duplicate").option("--invoice-id <id>", "公開APIでは請求書と取引を紐付けできないため、指定するとエラー").option("--expect-invoice-number <number>", "取引作成では非対応。指定するとエラー")
    .action(async opts => output(await runDealsCreate({ companyId: parseCompanyId(opts.companyId), type: opts.type, issueDate: opts.issueDate, dueDate: opts.dueDate, partnerId: parsePositiveIntegerOption(opts.partnerId, "--partner-id"), details: opts.detail, receiptIds: opts.receiptId.map((id: string) => parsePositiveIntegerOption(id, "--receipt-id")), refNumber: opts.refNumber, execute: Boolean(opts.execute), expectTotal: expectedTotal(opts.expectTotal), allowDuplicate: Boolean(opts.allowDuplicate), invoiceId: opts.invoiceId === undefined ? undefined : parsePositiveIntegerOption(opts.invoiceId, "--invoice-id"), expectInvoiceNumber: opts.expectInvoiceNumber, logDir: opts.logDir, taskId: opts.taskId }, { getClient, appendAudit: entry => appendDealAudit(opts.logDir, entry), now: () => new Date() })));
  writeOptions(deals.command("attach-receipt <id>")).requiredOption("--receipt-id <id>", "receipt ID (repeatable)", collect, []).option("--expect-total <amount>")
    .action(async (id, opts) => output(await runDealsAttachReceipt({ companyId: parseCompanyId(opts.companyId), id: parsePositiveIntegerOption(id, "id"), receiptIds: opts.receiptId.map((value: string) => parsePositiveIntegerOption(value, "--receipt-id")), execute: Boolean(opts.execute), expectTotal: expectedTotal(opts.expectTotal), logDir: opts.logDir, taskId: opts.taskId }, { getClient, appendAudit: entry => appendDealAudit(opts.logDir, entry), now: () => new Date() })));
  writeOptions(deals.command("payments").command("create <deal-id>"))
    .requiredOption("--date <YYYY-MM-DD>").requiredOption("--from-walletable-type <type>")
    .requiredOption("--from-walletable-id <id>").requiredOption("--amount <n>").option("--expect-amount <n>")
    .action(async (dealId, opts) => {
      const result = await runDealsPaymentsCreate({
        companyId: parseCompanyId(opts.companyId), dealId: parsePositiveIntegerOption(dealId, "deal-id"),
        date: opts.date, fromWalletableType: opts.fromWalletableType,
        fromWalletableId: parsePositiveIntegerOption(opts.fromWalletableId, "--from-walletable-id"),
        amount: parsePositiveIntegerOption(opts.amount, "--amount"),
        expectAmount: opts.expectAmount === undefined ? undefined : parsePositiveIntegerOption(opts.expectAmount, "--expect-amount"),
        execute: Boolean(opts.execute), logDir: opts.logDir, taskId: opts.taskId,
      }, { getClient, appendAudit: entry => appendAccountingAudit(opts.logDir, entry), now: () => new Date() });
      output(result);
      if (result.mode === "dry-run" && Object.values(result.guards).some(ok => !ok)) process.exitCode = 1;
    });
  writeOptions(receipts.command("update <id>")).option("--partner-name <text>").option("--issue-date <YYYY-MM-DD>").option("--amount <n>")
    .action(async (id, opts) => output(await runReceiptsUpdate({ companyId: parseCompanyId(opts.companyId), id: parsePositiveIntegerOption(id, "id"), partnerName: opts.partnerName, issueDate: opts.issueDate, amount: expectedTotal(opts.amount, "--amount"), execute: Boolean(opts.execute), logDir: opts.logDir, taskId: opts.taskId }, { getClient, appendAudit: entry => appendReceiptAudit(opts.logDir, entry), now: () => new Date() })));
  writeOptions(receipts.command("upload")).requiredOption("--file <path>").requiredOption("--issue-date <YYYY-MM-DD>").option("--description <text>").option("--partner-name <text>").option("--amount <n>").option("--expect-sha256 <hash>")
    .action(async opts => output(await runReceiptsUpload({ companyId: parseCompanyId(opts.companyId), file: opts.file, issueDate: opts.issueDate, partnerName: opts.partnerName, amount: expectedTotal(opts.amount, "--amount"), description: opts.description, execute: Boolean(opts.execute), expectSha256: opts.expectSha256, logDir: opts.logDir, taskId: opts.taskId }, { getClient, readFile, appendAudit: entry => appendReceiptAudit(opts.logDir, entry), now: () => new Date() })));
}
