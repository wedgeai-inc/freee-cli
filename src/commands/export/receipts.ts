import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import { mimeTypeToExtension } from "../../lib/mime.js";

/** freee receipts API の 1 ページあたり最大件数。 */
const RECEIPTS_PAGE_LIMIT = 100;

export interface ReceiptSummary {
  id: number;
  mime_type?: string;
  [key: string]: unknown;
}

export interface ExportReceiptsOptions {
  companyId: number;
  startDate: string;
  endDate: string;
  outDir: string;
}

export interface ExportReceiptsDeps {
  client: PublicFreeeClient;
  ensureDir: (path: string) => Promise<void>;
  writeFile: (path: string, data: Buffer | string) => Promise<void>;
}

export interface ExportReceiptsResult {
  total: number;
  saved: number;
  failed: Array<{ id: number; reason: string }>;
  indexPath: string;
  filesDir: string;
}

/**
 * 指定期間のファイルボックス証憑を取得し、メタ一覧 (index.json) と
 * 証憑ファイル本体 (files/<id>.<ext>) をローカルへ保存する (read-only)。
 *
 * - 一覧フィルタ start_date/end_date は freee 側ではアップロード日 (created_at) 基準。
 * - 個々のダウンロード失敗は failed に記録して処理を継続する。
 */
export async function runExportReceipts(
  opts: ExportReceiptsOptions,
  deps: ExportReceiptsDeps,
): Promise<ExportReceiptsResult> {
  const filesDir = `${opts.outDir}/files`;
  const indexPath = `${opts.outDir}/index.json`;
  await deps.ensureDir(filesDir);

  const receipts: ReceiptSummary[] = [];
  for await (const receipt of deps.client.listAll<ReceiptSummary>("/api/1/receipts", {
    company_id: opts.companyId,
    start_date: opts.startDate,
    end_date: opts.endDate,
    // freee の receipts は 1 ページ最大 100 件。listAll は items.length < limit で
    // 終端判定するため、limit は API 上限の 100 に合わせないと取りこぼす。
    limit: RECEIPTS_PAGE_LIMIT,
  })) {
    receipts.push(receipt);
  }

  await deps.writeFile(indexPath, JSON.stringify(receipts, null, 2));

  const failed: Array<{ id: number; reason: string }> = [];
  let saved = 0;

  for (const receipt of receipts) {
    try {
      const response = await deps.client.get(`/api/1/receipts/${receipt.id}/download`, {
        query: { company_id: opts.companyId },
      });
      const ext = mimeTypeToExtension(receipt.mime_type ?? "");
      const buffer = Buffer.from(await response.arrayBuffer());
      await deps.writeFile(`${filesDir}/${receipt.id}.${ext}`, buffer);
      saved += 1;
    } catch (error) {
      failed.push({
        id: receipt.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { total: receipts.length, saved, failed, indexPath, filesDir };
}
