/**
 * 書き込みの公開口（請求書の作成だけ）。他の repo が、人の承認を経た plan を freee に 1 件作るために使う。
 * - 書き込みの処理は CLI（`invoices create`）と同じ `createInvoiceFromPlan` を通る（検査・POST 状態・読み戻し・audit を複製しない）
 * - dry-run が既定。`execute: true`（真偽値の true そのもの）のときだけ送る
 * - token は `getToken` で注入する（1Password 管理の OAuth・環境変数・試験用の fake のどれでもよい）。dry-run では呼ばない
 * - `PublicFreeeClient` / `createInvoiceClient` は出さない（任意のパスへ書けてしまうため）
 * - freee の請求書 API に冪等キーがあるかは公式 docs から確認できていない（UNKNOWN）。二重作成の防止は呼び手が読み戻しで照合する
 */
import { appendInvoiceAudit, type InvoiceAuditEntry } from "./lib/audit/invoice-audit.js";
import { createInvoiceClient } from "./lib/clients/freee-invoice-client.js";
import { createReadOnlyClient } from "./lib/clients/read-only-client.js";
import {
  AuditWriteError,
  InvoiceCreatedButUnverifiedError,
  createInvoiceFromPlan,
  type InvoiceCreateResult,
} from "./commands/invoices/create.js";
import { FreeeApiError } from "./lib/clients/freee-public-client.js";
import { invoiceWebUrl } from "./lib/clients/freee-invoice-client.js";

export { AuditWriteError, InvoiceCreatedButUnverifiedError, ResponseParseError, classifyFailure } from "./commands/invoices/create.js";
export type { InvoiceCreated, InvoiceCreateResult, PostState } from "./commands/invoices/create.js";
export { FreeeApiError } from "./lib/clients/freee-public-client.js";
export { appendInvoiceAudit } from "./lib/audit/invoice-audit.js";
export type { InvoiceAuditEntry } from "./lib/audit/invoice-audit.js";
export type { InvoicePlan, InvoicePlanLine, InvoiceTotals } from "./domain/invoice-plan.js";
export { parseInvoicePlan } from "./domain/invoice-plan.js";

export type WriterErrorCode = "token-unavailable" | "http-failed" | "audit-failed" | "invalid-response" | "request-failed";

/**
 * 外部に依存する部分（token の取得・HTTP・audit の書き込み・応答の解釈）の失敗を、固定の分類で表す例外。
 * 元の例外のメッセージ・cause は持たない（token などが紛れ込みうるため）。http-failed のときだけ status と path を持つ。
 */
export class WriterError extends Error {
  readonly code: WriterErrorCode;
  readonly status?: number;
  readonly path?: string;
  constructor(code: WriterErrorCode, extra?: { status?: number; path?: string }) {
    super(`freee-cli writer: ${code}${extra?.status !== undefined ? ` (${extra.status} ${extra.path ?? ""})` : ""}`);
    this.name = "WriterError";
    this.code = code;
    if (extra?.status !== undefined) this.status = extra.status;
    if (extra?.path !== undefined) this.path = extra.path;
  }
}

/** 公開の口から外へ出す例外を、固定の分類のものだけにする。POST の状態を持つ例外はそのまま通す（メッセージは固定の分類のみで作られている）。 */
function sanitize(err: unknown): Error {
  if (err instanceof WriterError || err instanceof InvoiceCreatedButUnverifiedError || err instanceof AuditWriteError) return err;
  if (err instanceof FreeeApiError) return new WriterError("http-failed", { status: err.status, path: err.path });
  if (err instanceof Error && err.name === "InvoicePlanError") return err; // plan の検査の失敗。plan の内容だけから作られる
  return new WriterError("request-failed");
}

export interface WriterAuth {
  /** token の供給元。execute のときだけ、POST の直前に 1 回呼ぶ（読み戻しも同じ token）。値はログへ出さない */
  getToken: () => Promise<string>;
  fetchFn?: typeof fetch;
}

export interface CreateInvoiceInput {
  companyId: number;
  /** freee-cli の `invoices create --plan` と同じ形のオブジェクト（company_id を含めない・未知のキーは拒否） */
  plan: unknown;
  /** 省略時は dry-run。送るには true を明示する（true 以外の値は拒否） */
  execute?: boolean;
  /** 指定すると、読み戻した合計金額がこの値と一致しなければ成功にしない（承認した内容の合計を渡す） */
  expectedTotalAmount?: number;
  taskId: string;
  /** audit log（JSONL）の出力先。appendAudit を渡すときは不要 */
  logDir?: string;
}

export interface CreateInvoiceDeps extends WriterAuth {
  /** 省略時は logDir へ JSONL を追記する。どちらも無ければ拒否する（audit 無しで書かない） */
  appendAudit?: (entry: InvoiceAuditEntry) => Promise<void>;
  now?: () => Date;
}

function assertCompanyId(id: unknown): asserts id is number {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("writer: companyId must be a positive integer");
}

async function resolveToken(getToken: () => Promise<string>): Promise<string> {
  if (typeof getToken !== "function") throw new Error("writer: getToken must be a function");
  let token: unknown;
  try {
    token = await getToken();
  } catch {
    throw new WriterError("token-unavailable"); // 元の例外のメッセージは出さない
  }
  if (typeof token !== "string" || token.trim() === "") throw new WriterError("token-unavailable");
  return token;
}

/** 請求書ドラフトを 1 件作る。execute が true でなければ何も送らない（認証もネットワークも発生しない）。 */
export async function createInvoice(input: CreateInvoiceInput, deps: CreateInvoiceDeps): Promise<InvoiceCreateResult> {
  assertCompanyId(input.companyId);
  if (input.execute !== undefined && typeof input.execute !== "boolean") throw new Error("writer: execute must be a boolean");
  if (typeof input.taskId !== "string" || input.taskId === "") throw new Error("writer: taskId is required");
  const logDir = input.logDir;
  const appendAudit = deps.appendAudit ?? (logDir ? (e: InvoiceAuditEntry) => appendInvoiceAudit(logDir, e) : undefined);
  if (!appendAudit) throw new Error("writer: appendAudit or logDir is required (no write without an audit log)");
  if (typeof deps.getToken !== "function") throw new Error("writer: getToken must be a function");
  if (input.expectedTotalAmount !== undefined && (typeof input.expectedTotalAmount !== "number" || !Number.isFinite(input.expectedTotalAmount))) {
    throw new Error("writer: expectedTotalAmount must be a finite number");
  }
  // 入口で、呼び手のオブジェクトから独立した素のデータにする。以降の待ち（token の取得など）の間に呼び手が書き換えても、検査済みの内容が送られる。
  // 検査（parseInvoicePlan）も、このコピーに対してだけ行う
  const plan = snapshotPlan(input.plan);
  const wrappedAudit = async (entry: InvoiceAuditEntry): Promise<void> => {
    try {
      await appendAudit(entry);
    } catch {
      throw new WriterError("audit-failed"); // 元の例外のメッセージは出さない
    }
  };
  try {
    return await createInvoiceFromPlan(
      plan,
      {
        companyId: input.companyId,
        execute: input.execute === true,
        logDir: logDir ?? "",
        taskId: input.taskId,
        ...(input.expectedTotalAmount !== undefined ? { expectedTotal: input.expectedTotalAmount } : {}),
      },
      {
        getClient: async () => createInvoiceClient({ token: await resolveToken(deps.getToken), ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}) }),
        appendAudit: wrappedAudit,
        now: deps.now ?? (() => new Date()),
      },
    );
  } catch (err) {
    throw sanitize(err);
  }
}

/** JSON の往復で素のデータにする（getter は 1 回評価され、Proxy・独自のメソッドは残らない）。JSON にできないものは拒否する。 */
function snapshotPlan(plan: unknown): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(plan);
  } catch {
    throw new Error("writer: plan must be JSON-serializable");
  }
  if (text === undefined) throw new Error("writer: plan must be JSON-serializable");
  return JSON.parse(text);
}

export interface InvoiceReadBack {
  id: number;
  invoice_number: string;
  partner_id: number;
  billing_date: string;
  total_amount: number;
  webUrl: string;
}

/** 作成した請求書を GET で読み戻す（読み取り専用の client。冪等性の照合に使う）。形が合わなければ例外。 */
export async function readBackInvoice(input: { companyId: number; id: number }, auth: WriterAuth): Promise<InvoiceReadBack> {
  assertCompanyId(input.companyId);
  if (!Number.isSafeInteger(input.id) || input.id <= 0) throw new Error("writer: id must be a positive integer");
  const client = createReadOnlyClient({ api: "invoice", token: await resolveToken(auth.getToken), ...(auth.fetchFn ? { fetchFn: auth.fetchFn } : {}) });
  let json: unknown;
  try {
    const res = await client.get(`/invoices/${input.id}`, { query: { company_id: input.companyId } });
    json = await res.json();
  } catch (err) {
    if (err instanceof FreeeApiError) throw new WriterError("http-failed", { status: err.status, path: err.path });
    if (err instanceof SyntaxError) throw new WriterError("invalid-response");
    throw new WriterError("request-failed");
  }
  const inv = (json as { invoice?: Record<string, unknown> } | null)?.invoice;
  if (
    !inv || inv.id !== input.id || typeof inv.invoice_number !== "string" || typeof inv.total_amount !== "number" ||
    typeof inv.partner_id !== "number" || typeof inv.billing_date !== "string"
  ) {
    throw new WriterError("invalid-response");
  }
  return {
    id: input.id,
    invoice_number: inv.invoice_number,
    partner_id: inv.partner_id,
    billing_date: inv.billing_date,
    total_amount: inv.total_amount,
    webUrl: invoiceWebUrl(input.id),
  };
}
