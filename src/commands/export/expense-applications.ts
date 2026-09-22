import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import { mimeTypeToExtension } from "../../lib/mime.js";

const EXPENSE_APPLICATIONS_PAGE_LIMIT = 100;

export interface ExpenseApplicationSummary {
  id: number;
  purchase_lines?: Array<{
    id?: number;
    transaction_date?: string;
    receipt_id?: number | null;
    sub_receipt_ids?: number[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface ExpenseReceiptSummary {
  id: number;
  mime_type?: string;
  [key: string]: unknown;
}

export interface ExportExpenseApplicationsOptions {
  companyId: number;
  startDate: string;
  endDate: string;
  outDir: string;
}

export interface ExportExpenseApplicationsDeps {
  client: PublicFreeeClient;
  ensureDir: (path: string) => Promise<void>;
  writeFile: (path: string, data: Buffer | string) => Promise<void>;
}

export interface ExportExpenseApplicationsResult {
  total: number;
  receiptIds: number[];
  savedReceipts: number;
  failedReceipts: Array<{ id: number; reason: string }>;
  indexPath: string;
  receiptsIndexPath: string;
  filesDir: string;
}

function isWithinDateRange(value: string | undefined, startDate: string, endDate: string): boolean {
  return Boolean(value && value >= startDate && value <= endDate);
}

function receiptIdsForPeriod(
  applications: ExpenseApplicationSummary[],
  startDate: string,
  endDate: string,
): number[] {
  const ids = new Set<number>();
  for (const application of applications) {
    for (const line of application.purchase_lines ?? []) {
      if (!isWithinDateRange(line.transaction_date, startDate, endDate)) continue;
      if (typeof line.receipt_id === "number") ids.add(line.receipt_id);
      for (const id of line.sub_receipt_ids ?? []) {
        if (typeof id === "number") ids.add(id);
      }
    }
  }
  return [...ids].sort((a, b) => a - b);
}

async function fetchReceiptSummary(client: PublicFreeeClient, companyId: number, id: number): Promise<ExpenseReceiptSummary> {
  const response = await client.get(`/api/1/receipts/${id}`, {
    query: { company_id: companyId },
  });
  const payload = (await response.json()) as unknown;
  if (payload && typeof payload === "object" && "receipt" in payload) {
    const receipt = (payload as { receipt?: ExpenseReceiptSummary }).receipt;
    if (receipt) return receipt;
  }
  if (payload && typeof payload === "object" && "id" in payload) {
    return payload as ExpenseReceiptSummary;
  }
  throw new Error(`receipt ${id} response did not include receipt metadata`);
}

/**
 * freee 経費精算申請を public API から read-only export する。
 *
 * - index.json: expense_applications の raw response rows
 * - receipts-index.json: 対象月 purchase line に紐づく receipt metadata
 * - files/: 対象月 purchase line に紐づく receipt files
 */
export async function runExportExpenseApplications(
  opts: ExportExpenseApplicationsOptions,
  deps: ExportExpenseApplicationsDeps,
): Promise<ExportExpenseApplicationsResult> {
  const filesDir = `${opts.outDir}/files`;
  const indexPath = `${opts.outDir}/index.json`;
  const receiptsIndexPath = `${opts.outDir}/receipts-index.json`;
  await deps.ensureDir(filesDir);

  const applications: ExpenseApplicationSummary[] = [];
  for await (const application of deps.client.listAll<ExpenseApplicationSummary>("/api/1/expense_applications", {
    company_id: opts.companyId,
    start_transaction_date: opts.startDate,
    end_transaction_date: opts.endDate,
    limit: EXPENSE_APPLICATIONS_PAGE_LIMIT,
  })) {
    applications.push(application);
  }

  await deps.writeFile(indexPath, `${JSON.stringify(applications, null, 2)}\n`);

  const receiptIds = receiptIdsForPeriod(applications, opts.startDate, opts.endDate);
  const receiptIndex: ExpenseReceiptSummary[] = [];
  const failedReceipts: Array<{ id: number; reason: string }> = [];
  let savedReceipts = 0;

  for (const id of receiptIds) {
    try {
      const receipt = await fetchReceiptSummary(deps.client, opts.companyId, id);
      receiptIndex.push(receipt);
      const response = await deps.client.get(`/api/1/receipts/${id}/download`, {
        query: { company_id: opts.companyId },
      });
      const ext = mimeTypeToExtension(receipt.mime_type ?? "");
      const buffer = Buffer.from(await response.arrayBuffer());
      await deps.writeFile(`${filesDir}/${id}.${ext}`, buffer);
      savedReceipts += 1;
    } catch (error) {
      failedReceipts.push({
        id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await deps.writeFile(receiptsIndexPath, `${JSON.stringify(receiptIndex, null, 2)}\n`);

  return {
    total: applications.length,
    receiptIds,
    savedReceipts,
    failedReceipts,
    indexPath,
    receiptsIndexPath,
    filesDir,
  };
}
