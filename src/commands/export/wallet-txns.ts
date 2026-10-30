import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";

const WALLET_TXNS_PAGE_LIMIT = 100;
const WALLETABLE_TYPES = ["bank_account", "credit_card", "wallet"] as const;
const ENTRY_SIDES = ["income", "expense"] as const;

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
  walletableId?: number;
  walletableType?: string;
  sourceName: string;
  entrySide?: "income" | "expense";
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

/** 入力検証。CLI では認証ロード（token refresh の fetch を伴いうる）より前に呼ぶ。 */
export function validateExportWalletTxnsOptions(
  opts: Pick<ExportWalletTxnsOptions, "walletableId" | "walletableType" | "entrySide">,
): void {
  const hasWalletableId = opts.walletableId !== undefined;
  const hasWalletableType = opts.walletableType !== undefined;
  if (hasWalletableId !== hasWalletableType) {
    throw new Error("walletable id and type must both be specified or both omitted");
  }
  if (
    opts.walletableId !== undefined &&
    !(Number.isSafeInteger(opts.walletableId) && opts.walletableId > 0)
  ) {
    throw new Error(`walletable id must be a positive integer (got: "${String(opts.walletableId)}")`);
  }
  if (
    hasWalletableType &&
    !(WALLETABLE_TYPES as readonly string[]).includes(opts.walletableType as string)
  ) {
    throw new Error(
      `walletable type must be bank_account, credit_card, or wallet (got: "${opts.walletableType}")`,
    );
  }
  if (opts.entrySide !== undefined && !(ENTRY_SIDES as readonly string[]).includes(opts.entrySide)) {
    throw new Error(`entry side must be income or expense (got: "${opts.entrySide}")`);
  }
}

/**
 * freee wallet/card 明細を public API から read-only export する。
 *
 * 口座の種類（wallet / credit_card / bank_account）と ID は任意で、両方指定するか両方省く。
 * 口座を省いたときは walletable_id / walletable_type をクエリに付けない。
 * entrySide（income / expense）を指定すると収支で絞り込む。
 */
export async function runExportWalletTxns(
  opts: ExportWalletTxnsOptions,
  deps: ExportWalletTxnsDeps,
): Promise<ExportWalletTxnsResult> {
  validateExportWalletTxnsOptions(opts);

  const hasWalletableId = opts.walletableId !== undefined;
  const hasWalletableType = opts.walletableType !== undefined;

  await deps.ensureDir(opts.outDir);

  const query: Record<string, string | number | boolean | null | undefined> = {
    company_id: opts.companyId,
    start_date: opts.startDate,
    end_date: opts.endDate,
    limit: WALLET_TXNS_PAGE_LIMIT,
  };
  if (hasWalletableId && hasWalletableType) {
    query.walletable_id = opts.walletableId;
    query.walletable_type = opts.walletableType;
  }
  if (opts.entrySide !== undefined) query.entry_side = opts.entrySide;

  const txns: Array<WalletTxnSummary & { source_name: string }> = [];
  for await (const txn of deps.client.listAll<WalletTxnSummary>("/api/1/wallet_txns", query)) {
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
