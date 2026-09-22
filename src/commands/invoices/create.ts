import type { PublicFreeeClient } from "../../lib/clients/freee-public-client.js";
import { FreeeApiError } from "../../lib/clients/freee-public-client.js";
import { invoiceWebUrl } from "../../lib/clients/freee-invoice-client.js";
import { redact } from "../../lib/audit/redactor.js";
import type { InvoiceAuditEntry } from "../../lib/audit/invoice-audit.js";
import { computeInvoiceTotals, parseInvoicePlan, type InvoiceTotals } from "../../domain/invoice-plan.js";

export interface InvoiceCreateOptions {
  companyId: number;
  planPath: string;
  execute: boolean;
  logDir: string;
  taskId: string;
}

export interface InvoiceCreateDeps {
  /** execute 時にだけ呼ぶ。dry-run では認証もネットワークも発生させない */
  getClient: () => Promise<PublicFreeeClient>;
  readFile: (path: string) => Promise<string>;
  appendAudit: (entry: InvoiceAuditEntry) => Promise<void>;
  now: () => Date;
}

export interface InvoiceCreated {
  id: number;
  invoice_number: string;
  total_amount: number;
  webUrl: string;
}

export interface InvoiceCreateResult {
  mode: "dry-run" | "execute";
  payload: Record<string, unknown>;
  totals: InvoiceTotals;
  created?: InvoiceCreated;
}

/**
 * 請求書ドラフトを 1 件作成する。dry-run 既定。execute 時のみ POST → 読み戻し GET。
 */
export async function runInvoicesCreate(opts: InvoiceCreateOptions, deps: InvoiceCreateDeps): Promise<InvoiceCreateResult> {
  const raw: unknown = JSON.parse(await deps.readFile(opts.planPath));
  const plan = parseInvoicePlan(raw);
  const totals = computeInvoiceTotals(plan);
  const payload: Record<string, unknown> = { company_id: opts.companyId, ...plan };
  const mode: "dry-run" | "execute" = opts.execute ? "execute" : "dry-run";
  const base = {
    task_id: opts.taskId,
    event: "invoice_create" as const,
    mode,
    company_id: opts.companyId,
    payload_redacted: redact(payload),
  };

  if (!opts.execute) {
    await deps.appendAudit({ ...base, timestamp: deps.now().toISOString(), status: "planned" });
    return { mode, payload, totals };
  }

  // POST の状態を持ち、「再実行してよいか」を状態から決める。
  //   not_attempted: POST を送っていない（再実行可）
  //   rejected:      4xx 応答（サーバーは作成していない。再実行可）
  //   unknown:       送信後・応答前に通信が失敗、または 5xx 応答（サーバー側で作成済みかもしれない。再実行禁止）
  //   succeeded:     2xx（作成済み。再実行禁止。id が取れれば created_id を残す）
  let postState = "not_attempted" as PostState;
  let createdId: number | undefined;
  try {
    const client = await deps.getClient();
    let postRes: Response;
    try {
      postState = "unknown"; // await の前に「送った」ことを記録する
      postRes = await client.post("/invoices", { body: payload });
      postState = "succeeded";
    } catch (postErr) {
      // 4xx は要求が拒否された（サーバーは作成していない）→ rejected（再実行可）。
      // 5xx は永続化の後に返った可能性を排除できない → unknown（再実行禁止）。通信断も unknown のまま
      if (postErr instanceof FreeeApiError && postErr.status < 500) postState = "rejected";
      throw postErr;
    }
    createdId = readCreatedId(await parseJson(postRes, "/invoices"));
    const getRes = await client.get(`/invoices/${createdId}`, { query: { company_id: opts.companyId } });
    const created = readCreatedDetail(await parseJson(getRes, "/invoices/{id}"), createdId);
    await appendAuditSafely(deps, { ...base, timestamp: deps.now().toISOString(), status: "created", created_id: createdId }, postState);
    return { mode, payload, totals, created };
  } catch (err) {
    // audit 書き込みの失敗は元の結果を置き換えない（AuditWriteError のまま投げる。POST 状態と createdId を持つ）
    if (err instanceof AuditWriteError) throw err;
    const reason = classifyFailure(err);
    const entry: InvoiceAuditEntry = { ...base, timestamp: deps.now().toISOString(), status: "failed", reason };
    if (createdId !== undefined) entry.created_id = createdId;
    await appendAuditSafely(deps, entry, postState);
    if (postState === "succeeded" || postState === "unknown") throw new InvoiceCreatedButUnverifiedError(createdId, reason, postState);
    throw err;
  }
}

export type PostState = "not_attempted" | "rejected" | "unknown" | "succeeded";

function noRerunWarning(state: PostState, createdId: number | undefined): string {
  const which = createdId !== undefined ? `id=${createdId}` : "id 不明";
  if (state === "succeeded") return `請求書は作成済みの可能性がある（POST は 2xx・${which}）。再実行せず Web で確認すること`;
  if (state === "unknown") return "POST の結果が不明（送信後の通信失敗または 5xx 応答）。サーバー側で作成済みかもしれないため、再実行せず Web で確認すること";
  return state === "rejected" ? "POST は 4xx で拒否された（再実行可）" : "POST は行っていない（再実行可）";
}

/**
 * POST を送った後（2xx 受信、または結果不明）に失敗したときの例外。呼び手は再 POST せず freee Web で確認する。
 * createdId は id が取れていれば入る。
 */
export class InvoiceCreatedButUnverifiedError extends Error {
  readonly createdId: number | undefined;
  readonly reason: string;
  readonly postState: PostState;
  constructor(createdId: number | undefined, reason: string, postState: PostState = "succeeded") {
    super(`invoice create: ${noRerunWarning(postState, createdId)}（${reason}）`);
    this.name = "InvoiceCreatedButUnverifiedError";
    this.createdId = createdId;
    this.reason = reason;
    this.postState = postState;
  }
}

/** 応答 JSON の解析失敗を path 付きで表す（reason を `invalid_response:<path>` に分類するため）。 */
export class ResponseParseError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`invoice create: response from ${path} is not valid JSON`);
    this.name = "ResponseParseError";
    this.path = path;
  }
}

async function parseJson(res: Response, path: string): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new ResponseParseError(path);
  }
}

function readCreatedId(json: unknown): number {
  const id = (json as { invoice?: { id?: unknown } } | null)?.invoice?.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error("invoice create: response did not include invoice.id");
  }
  return id;
}

function readCreatedDetail(json: unknown, id: number): InvoiceCreated {
  const inv = (json as { invoice?: Record<string, unknown> } | null)?.invoice;
  if (!inv || inv.id !== id || typeof inv.invoice_number !== "string" || typeof inv.total_amount !== "number") {
    throw new Error("invoice create: read-back response is missing id / invoice_number / total_amount");
  }
  return { id, invoice_number: inv.invoice_number, total_amount: inv.total_amount, webUrl: invoiceWebUrl(id) };
}

/** audit の書き込み失敗は元の処理の結果を置き換えない（AuditWriteError として投げる。POST 状態と createdId を持つ）。 */
async function appendAuditSafely(deps: InvoiceCreateDeps, entry: InvoiceAuditEntry, postState: PostState): Promise<void> {
  try {
    await deps.appendAudit(entry);
  } catch (auditErr) {
    const msg = auditErr instanceof Error ? auditErr.message : String(auditErr);
    throw new AuditWriteError(entry.status, entry.created_id, msg, postState);
  }
}

/**
 * audit 書き込みの失敗。message は CLI がそのまま表示するので、POST 状態と再実行可否を message に含める。
 */
export class AuditWriteError extends Error {
  readonly createdId: number | undefined;
  readonly postState: PostState;
  /** 互換: succeeded のときだけ true */
  get postSucceeded(): boolean {
    return this.postState === "succeeded";
  }
  constructor(status: string, createdId: number | undefined, detail: string, postState: PostState) {
    super(`invoice create: audit（${status}）の書き込みに失敗（${detail}）。${noRerunWarning(postState, createdId)}`);
    this.name = "AuditWriteError";
    this.createdId = createdId;
    this.postState = postState;
  }
}

/** audit の reason は固定分類 + 操作 path のみ（任意のエラーメッセージを監査ログへ流さない）。 */
export function classifyFailure(err: unknown): string {
  if (err instanceof FreeeApiError) return `api_error:${err.status}:${err.path}`;
  if (err instanceof AuditWriteError) return "audit_write_failed";
  if (err instanceof InvoiceCreatedButUnverifiedError) return err.reason;
  if (err instanceof Error && err.message.startsWith("invoice create: response did not include invoice.id")) {
    return "invalid_response:/invoices";
  }
  if (err instanceof Error && err.message.startsWith("invoice create: read-back response")) {
    return "invalid_response:/invoices/{id}";
  }
  if (err instanceof ResponseParseError) return `invalid_response:${err.path}`;
  return "request_failed:/invoices";
}

export function formatInvoiceCreate(result: InvoiceCreateResult): string {
  const lines = [
    `mode: ${result.mode}`,
    `参考値（確定値は freee の応答を正とする）: 小計 ${result.totals.subtotal} / 消費税 ${result.totals.tax} / 合計 ${result.totals.total}`,
  ];
  if (result.created) {
    lines.push(
      `created: id=${result.created.id} invoice_number=${result.created.invoice_number} total_amount=${result.created.total_amount}`,
      `web: ${result.created.webUrl}`,
    );
  } else {
    lines.push("実 POST は行っていません（--execute で作成）");
  }
  lines.push("payload:", JSON.stringify(result.payload, null, 2));
  return lines.join("\n");
}
