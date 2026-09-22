import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";

export interface ExportJournalsOptions {
  companyId: number;
  startDate: string;
  endDate: string;
  outDir: string;
  /** csv | pdf | generic | generic_v2 */
  downloadType: string;
  /** utf-8 | sjis */
  encoding: string;
}

export interface ExportJournalsDeps {
  client: PublicFreeeClient;
  ensureDir: (path: string) => Promise<void>;
  writeFile: (path: string, data: Buffer | string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  maxPolls?: number;
  pollIntervalMs?: number;
}

export interface ExportJournalsResult {
  id: number;
  status: string;
  outputPath: string;
  downloadType: string;
}

interface JournalsEnvelope {
  journals?: { id?: number; status?: string };
}

const DEFAULT_MAX_POLLS = 60;
const DEFAULT_POLL_INTERVAL_MS = 2000;

function extensionForDownloadType(downloadType: string): string {
  return downloadType === "pdf" ? "pdf" : "csv";
}

/**
 * 仕訳帳を非同期エクスポートする (read-only)。
 * 1) GET /api/1/journals でエクスポート要求 → リクエスト ID 取得
 * 2) GET /api/1/journals/reports/{id}/status を uploaded までポーリング
 * 3) GET /api/1/journals/reports/{id}/download でファイル取得・保存
 *
 * encoding=utf-8 を既定にすることで UTF-8 環境での文字化けを避ける。
 */
export async function runExportJournals(
  opts: ExportJournalsOptions,
  deps: ExportJournalsDeps,
): Promise<ExportJournalsResult> {
  const maxPolls = deps.maxPolls ?? DEFAULT_MAX_POLLS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  await deps.ensureDir(opts.outDir);

  const supportsEncoding = opts.downloadType === "generic" || opts.downloadType === "generic_v2";
  const requestRes = await deps.client.get("/api/1/journals", {
    query: {
      company_id: opts.companyId,
      download_type: opts.downloadType,
      // encoding は freee 仕様上 generic / generic_v2 のみ有効。csv/pdf に付けると 400。
      ...(supportsEncoding ? { encoding: opts.encoding } : {}),
      start_date: opts.startDate,
      end_date: opts.endDate,
    },
  });
  const requestJson = (await requestRes.json()) as JournalsEnvelope;
  const id = requestJson.journals?.id;
  if (typeof id !== "number") {
    throw new Error("journals export request did not return a report id");
  }

  let status = "";
  let polls = 0;
  for (;;) {
    const statusRes = await deps.client.get(`/api/1/journals/reports/${id}/status`, {
      query: { company_id: opts.companyId },
    });
    const statusJson = (await statusRes.json()) as JournalsEnvelope;
    status = statusJson.journals?.status ?? "";

    if (status === "uploaded") break;
    if (status === "enqueued" || status === "working") {
      polls += 1;
      if (polls >= maxPolls) {
        throw new Error(`journals export timed out after ${maxPolls} polls (last status: ${status})`);
      }
      await deps.sleep(pollIntervalMs);
      continue;
    }
    throw new Error(`journals export failed (status: ${status || "unknown"})`);
  }

  const downloadRes = await deps.client.get(`/api/1/journals/reports/${id}/download`, {
    query: { company_id: opts.companyId },
  });
  const ext = extensionForDownloadType(opts.downloadType);
  const outputPath = `${opts.outDir}/journals-${opts.startDate}_${opts.endDate}.${ext}`;

  if (opts.downloadType === "pdf") {
    const buffer = Buffer.from(await downloadRes.arrayBuffer());
    await deps.writeFile(outputPath, buffer);
  } else {
    const text = await downloadRes.text();
    await deps.writeFile(outputPath, text);
  }

  return { id, status, outputPath, downloadType: opts.downloadType };
}
