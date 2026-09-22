import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";

const WALLET_TXNS_PAGE_LIMIT = 100;

export interface WalletTxnSummary {
  id: number;
  date?: string;
  amount?: number;
  description?: string;
  walletable_type?: string;
  walletable_id?: number;
  [key: string]: unknown;
}

export interface ExportWalletTxnsOptions {
  companyId: number;
  startDate: string;
  endDate: string;
  outDir: string;
  walletableId: number;
  walletableType: string;
  sourceName: string;
}

export interface ExportWalletTxnsDeps {
  client: PublicFreeeClient;
  ensureDir: (path: string) => Promise<void>;
  writeFile: (path: string, data: Buffer | string) => Promise<void>;
}

export interface ExportWalletTxnsResult {
  total: number;
  jsonPath: string;
  csvPath: string;
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "\"\"";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function stringifyWalletTxnsCsv(rows: Array<WalletTxnSummary & { source_name: string }>): string {
  const headers = [
    "source_name",
    "walletable_type",
    "walletable_id",
    "id",
    "date",
    "entry_side",
    "amount",
    "due_amount",
    "balance",
    "status",
    "rule_matched",
    "description",
  ];
  return `${[
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\n")}\n`;
}

/**
 * freee wallet/card 明細を public API から read-only export する。
 *
 * 口座の種類（wallet / credit_card / bank_account）と ID は呼び出し側が明示する。
 */
export async function runExportWalletTxns(
  opts: ExportWalletTxnsOptions,
  deps: ExportWalletTxnsDeps,
): Promise<ExportWalletTxnsResult> {
  await deps.ensureDir(opts.outDir);

  const txns: Array<WalletTxnSummary & { source_name: string }> = [];
  for await (const txn of deps.client.listAll<WalletTxnSummary>("/api/1/wallet_txns", {
    company_id: opts.companyId,
    start_date: opts.startDate,
    end_date: opts.endDate,
    walletable_id: opts.walletableId,
    walletable_type: opts.walletableType,
    limit: WALLET_TXNS_PAGE_LIMIT,
  })) {
    txns.push({ source_name: opts.sourceName, ...txn });
  }

  const jsonPath = `${opts.outDir}/wallet-txns.json`;
  const csvPath = `${opts.outDir}/wallet-txns.csv`;
  await deps.writeFile(jsonPath, `${JSON.stringify(txns, null, 2)}\n`);
  await deps.writeFile(csvPath, stringifyWalletTxnsCsv(txns));

  return {
    total: txns.length,
    jsonPath,
    csvPath,
  };
}
