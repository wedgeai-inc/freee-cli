import { Command } from "commander";
import { readFile } from "node:fs/promises";
import type { PublicFreeeClient } from "../lib/clients/freee-public-client.js";
import { parseCompanyId, parsePositiveIntegerOption } from "../lib/company-id.js";
import { runAccountItemsList } from "./account-items/list.js";
import { runTaxesList } from "./taxes/list.js";
import { runDealsList } from "./deals/list.js";
import { runDealsGet } from "./deals/get.js";
import { runDealsCreate } from "./deals/create.js";
import { runReceiptsGet } from "./receipts/get.js";
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
function expectedTotal(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^-?[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error("--expect-total must be a safe integer");
  return Number(raw);
}
export function registerAccountingCommands(program: Command, getClient: () => Promise<PublicFreeeClient>): void {
  company(program.command("account-items").command("list")).action(async opts => output((await runAccountItemsList({ companyId: parseCompanyId(opts.companyId) }, { client: await getClient() })).items));
  company(program.command("taxes").command("list")).action(async opts => output((await runTaxesList({ companyId: parseCompanyId(opts.companyId) }, { client: await getClient() })).items));
  const deals = program.command("deals").description("deal operations (default: dry-run)");
  const receipts = program.command("receipts").description("receipt operations (default: dry-run)");
  company(deals.command("list")).option("--partner-id <id>").option("--type <type>").option("--start-issue-date <YYYY-MM-DD>").option("--end-issue-date <YYYY-MM-DD>").option("--status <status>")
    .action(async opts => output((await runDealsList({ companyId: parseCompanyId(opts.companyId), partnerId: opts.partnerId === undefined ? undefined : parsePositiveIntegerOption(opts.partnerId, "--partner-id"), type: opts.type, startIssueDate: opts.startIssueDate, endIssueDate: opts.endIssueDate, status: opts.status }, { client: await getClient() })).items));
  for (const [root, run] of [[deals, runDealsGet], [receipts, runReceiptsGet]] as const) {
    company(root.command("get <id>")).action(async (id, opts) => output(await run({ companyId: parseCompanyId(opts.companyId), id: parsePositiveIntegerOption(id, "id") }, { client: await getClient() })));
  }
  writeOptions(deals.command("create")).requiredOption("--type <type>", "income or expense").requiredOption("--issue-date <YYYY-MM-DD>").option("--due-date <YYYY-MM-DD>")
    .requiredOption("--partner-id <id>").requiredOption("--detail <detail>", "account_item_id=...,tax_code=...,amount=...,description=... (repeatable)", collect, [])
    .option("--receipt-id <id>", "receipt ID (repeatable)", collect, []).option("--ref-number <text>").option("--expect-total <amount>").option("--allow-duplicate")
    .action(async opts => output(await runDealsCreate({ companyId: parseCompanyId(opts.companyId), type: opts.type, issueDate: opts.issueDate, dueDate: opts.dueDate, partnerId: parsePositiveIntegerOption(opts.partnerId, "--partner-id"), details: opts.detail, receiptIds: opts.receiptId.map((id: string) => parsePositiveIntegerOption(id, "--receipt-id")), refNumber: opts.refNumber, execute: Boolean(opts.execute), expectTotal: expectedTotal(opts.expectTotal), allowDuplicate: Boolean(opts.allowDuplicate), logDir: opts.logDir, taskId: opts.taskId }, { getClient, appendAudit: entry => appendDealAudit(opts.logDir, entry), now: () => new Date() })));
  writeOptions(receipts.command("upload")).requiredOption("--file <path>").requiredOption("--issue-date <YYYY-MM-DD>").option("--description <text>").option("--expect-sha256 <hash>")
    .action(async opts => output(await runReceiptsUpload({ companyId: parseCompanyId(opts.companyId), file: opts.file, issueDate: opts.issueDate, description: opts.description, execute: Boolean(opts.execute), expectSha256: opts.expectSha256, logDir: opts.logDir, taskId: opts.taskId }, { getClient, readFile, appendAudit: entry => appendReceiptAudit(opts.logDir, entry), now: () => new Date() })));
}
