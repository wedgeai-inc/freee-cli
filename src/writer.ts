/**
 * 書き込みの公開口（請求書の作成だけ）。他の repo が、人の承認を経た plan を freee に 1 件作るために使う。
 *
 * 入口と出口の決まり（この口は、呼び手の入力と依存先の例外のどちらも信用しない）:
 * - 入口: 入力は「plain なデータ」だけを受ける（プロトタイプが Object.prototype か null・自分のデータのプロパティだけ・getter / Proxy /
 *   Symbol / 関数 / 継承を持たない）。受けたら全値を 1 回だけ取り出して複製し、以降は複製だけを使う（呼び手の参照を二度と読まない）。
 *   依存先（getToken・fetchFn・now・appendAudit）の関数も、入口で 1 回だけ取り出す
 * - 出口: 依存先が投げたものは型を問わず包み直し、外へは内部で作った固定の分類の例外だけを出す（元の message・name・cause・path は出さない）。
 *   取得した token の文字列が戻り値・例外・audit に含まれていれば失敗にする（最後の検査を 1 か所に置く）
 * - 書き込みは CLI（`invoices create`）と同じ `createInvoiceFromPlan` を通る（検査・POST 状態・読み戻し・audit を複製しない）
 * - dry-run が既定。`execute: true`（真偽値の true そのもの）のときだけ送る
 * - `PublicFreeeClient` / `createInvoiceClient` は出さない（任意のパスへ書けてしまうため）
 * - freee の請求書 API に冪等キーがあるかは公式 docs から確認できていない（UNKNOWN）。二重作成の防止は呼び手が読み戻しで照合する
 */
import { types } from "node:util";
import { appendInvoiceAudit, type InvoiceAuditEntry } from "./lib/audit/invoice-audit.js";
import { createInvoiceClient, invoiceWebUrl } from "./lib/clients/freee-invoice-client.js";
import { createReadOnlyClient } from "./lib/clients/read-only-client.js";
import {
  AuditWriteError,
  InvoiceCreatedButUnverifiedError,
  createInvoiceFromPlan,
  type InvoiceCreateResult,
} from "./commands/invoices/create.js";
import { FreeeApiError } from "./lib/clients/freee-public-client.js";
import { PlanError } from "./domain/invoice-plan.js";

export { AuditWriteError, InvoiceCreatedButUnverifiedError, ResponseParseError, classifyFailure } from "./commands/invoices/create.js";
export type { InvoiceCreated, InvoiceCreateResult, PostState } from "./commands/invoices/create.js";
export { FreeeApiError } from "./lib/clients/freee-public-client.js";
export { appendInvoiceAudit } from "./lib/audit/invoice-audit.js";
export type { InvoiceAuditEntry } from "./lib/audit/invoice-audit.js";
export type { InvoicePlan, InvoicePlanLine, InvoiceTotals } from "./domain/invoice-plan.js";
export { parseInvoicePlan } from "./domain/invoice-plan.js";

export type WriterErrorCode =
  | "token-unavailable"
  | "http-failed"
  | "audit-failed"
  | "invalid-response"
  | "clock-failed"
  | "request-failed";

const CODES = new Set<string>(["token-unavailable", "http-failed", "audit-failed", "invalid-response", "clock-failed", "request-failed"]);
const FIXED_PATHS = new Set<string>(["/invoices", "/invoices/{id}"]);

/**
 * 外部に依存する部分（token の取得・HTTP・audit の書き込み・時計・応答の解釈）の失敗を、固定の分類で表す例外。
 * 元の例外のメッセージ・cause は持たない。http-failed のときだけ status（100〜599 の整数）と、内部の固定の path を持つ。
 */
export class WriterError extends Error {
  readonly code: WriterErrorCode;
  readonly status?: number;
  readonly path?: string;
  constructor(code: WriterErrorCode, extra?: { status?: number; path?: string }) {
    const known = CODES.has(code) ? code : "request-failed";
    const status = extra?.status !== undefined && Number.isInteger(extra.status) && extra.status >= 100 && extra.status <= 599 ? extra.status : undefined;
    const path = extra?.path !== undefined && FIXED_PATHS.has(extra.path) ? extra.path : undefined;
    super(`freee-cli writer: ${known}${status !== undefined ? ` (${status}${path ? ` ${path}` : ""})` : ""}`);
    this.name = "WriterError";
    this.code = known as WriterErrorCode;
    if (status !== undefined) this.status = status;
    if (path !== undefined) this.path = path;
  }
}

/** fetchFn の失敗は型を問わずこの内部の目印に置き換える（呼び手が FreeeApiError などを投げて分類を偽装できない）。 */
class TransportFailure extends Error {
  constructor() {
    super("transport failure");
  }
}

// ---- 入口: plain なデータだけを受け、全値を 1 回だけ取り出して複製する ----

class InputError extends Error {}

const MAX_DEPTH = 8;

function plainCopy(v: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new InputError("too deep");
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new InputError("non-finite number");
    return v;
  }
  if (typeof v !== "object") throw new InputError("unsupported value");
  if (types.isProxy(v)) throw new InputError("proxy");
  const keys = Reflect.ownKeys(v);
  if (keys.some((k) => typeof k === "symbol")) throw new InputError("symbol key");
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype) throw new InputError("array subclass");
    const len = v.length;
    if (keys.length !== len + 1) throw new InputError("array has extra or missing properties");
    const out: unknown[] = [];
    for (let i = 0; i < len; i += 1) {
      const d = Object.getOwnPropertyDescriptor(v, String(i));
      if (!d || !("value" in d) || d.get || d.set) throw new InputError("array accessor or hole");
      out.push(plainCopy(d.value, depth + 1));
    }
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw new InputError("non-plain prototype");
  const out: Record<string, unknown> = {};
  for (const k of keys as string[]) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !("value" in d) || d.get || d.set || !d.enumerable) throw new InputError("accessor or non-enumerable property");
    if (d.value === undefined) continue; // undefined は「無い」と同じ扱い
    Object.defineProperty(out, k, { value: plainCopy(d.value, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function takeInput(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  let copy: unknown;
  try {
    copy = plainCopy(input, 0);
  } catch {
    throw new Error("writer: input must be plain data (no getter / Proxy / Symbol / function / inherited properties)");
  }
  if (copy === null || typeof copy !== "object" || Array.isArray(copy)) throw new Error("writer: input must be an object");
  for (const k of Object.keys(copy)) if (!allowed.includes(k)) throw new Error(`writer: unknown input field`);
  return copy as Record<string, unknown>;
}

// ---- 出口: 固定の分類の例外だけを出し、token の流出を最後に検査する ----

function serializeForLeakCheck(v: unknown): string {
  try {
    if (v instanceof Error) {
      const o: Record<string, unknown> = {};
      for (const k of Object.getOwnPropertyNames(v)) o[k] = (v as unknown as Record<string, unknown>)[k];
      return JSON.stringify(o);
    }
    return JSON.stringify(v) ?? "";
  } catch {
    return "[unserializable]";
  }
}

const MIN_CHECKED_TOKEN_LENGTH = 8;

/** 取得した token の文字列を含むものは失敗にする。token はこの口の中の 1 か所（Guard）にだけ置く。 */
class Guard {
  private token: string | undefined;
  remember(t: string): void {
    this.token = t;
  }
  leaks(v: unknown): boolean {
    const t = this.token;
    if (t === undefined || t.length < MIN_CHECKED_TOKEN_LENGTH) return false;
    return serializeForLeakCheck(v).includes(t) || serializeForLeakCheck(v).includes(JSON.stringify(t).slice(1, -1));
  }
}

/** 外へ出す例外を、内部で作った固定の分類のものだけにする。 */
function sanitize(err: unknown, guard: Guard, path: "/invoices" | "/invoices/{id}"): Error {
  let out: Error;
  if (err instanceof WriterError || err instanceof InvoiceCreatedButUnverifiedError || err instanceof AuditWriteError || err instanceof PlanError) out = err;
  else if (err instanceof FreeeApiError) out = new WriterError("http-failed", { status: err.status, path });
  else out = new WriterError("request-failed");
  if (!guard.leaks(out)) return out;
  if (out instanceof InvoiceCreatedButUnverifiedError) return new InvoiceCreatedButUnverifiedError(out.createdId, "redacted", out.postState);
  if (out instanceof AuditWriteError) return new AuditWriteError("failed", out.createdId, "redacted", out.postState);
  return new WriterError("request-failed");
}

export interface WriterAuth {
  /** token の供給元。execute のときだけ、POST の直前に 1 回呼ぶ（読み戻しも同じ token）。値はログへ出さない */
  getToken: () => Promise<string>;
  fetchFn?: typeof fetch;
}

export interface CreateInvoiceInput {
  companyId: number;
  /** freee-cli の `invoices create --plan` と同じ形の plain なオブジェクト（company_id を含めない・未知のキーは拒否） */
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

/** 依存先の関数を入口で 1 回だけ取り出し、失敗を固定の分類に包み直した形にする。 */
function bindDeps(deps: CreateInvoiceDeps | WriterAuth, guard: Guard) {
  if (deps === null || typeof deps !== "object") throw new Error("writer: deps must be an object");
  const d = deps as CreateInvoiceDeps;
  const getTokenFn = d.getToken;
  const fetchFn = d.fetchFn;
  const appendAuditFn = d.appendAudit;
  const nowFn = d.now;
  if (typeof getTokenFn !== "function") throw new Error("writer: getToken must be a function");
  if (fetchFn !== undefined && typeof fetchFn !== "function") throw new Error("writer: fetchFn must be a function");
  if (appendAuditFn !== undefined && typeof appendAuditFn !== "function") throw new Error("writer: appendAudit must be a function");
  if (nowFn !== undefined && typeof nowFn !== "function") throw new Error("writer: now must be a function");
  const realFetch = fetchFn ?? fetch;
  return {
    hasAppendAudit: appendAuditFn !== undefined,
    appendAuditFn,
    async getToken(): Promise<string> {
      let token: unknown;
      try {
        token = await getTokenFn();
      } catch {
        throw new WriterError("token-unavailable"); // 元の例外は出さない
      }
      if (typeof token !== "string" || token.trim() === "") throw new WriterError("token-unavailable");
      guard.remember(token);
      return token;
    },
    fetchFn: (async (...args: Parameters<typeof fetch>): Promise<Response> => {
      let res: unknown;
      try {
        res = await realFetch(...args);
      } catch {
        throw new TransportFailure();
      }
      if (!(res instanceof Response)) throw new TransportFailure();
      return res;
    }) as typeof fetch,
    now(): Date {
      if (nowFn === undefined) return new Date();
      try {
        const t = nowFn();
        if (!(t instanceof Date) || Number.isNaN(t.getTime())) throw new Error("invalid");
        return new Date(t.getTime());
      } catch {
        throw new WriterError("clock-failed");
      }
    },
  };
}

/** 請求書ドラフトを 1 件作る。execute が true でなければ何も送らない（認証もネットワークも発生しない）。 */
export async function createInvoice(rawInput: CreateInvoiceInput, rawDeps: CreateInvoiceDeps): Promise<InvoiceCreateResult> {
  const guard = new Guard();
  // 入口: 入力を 1 回だけ取り出して複製し、依存先の関数も 1 回だけ取り出す。以降は複製だけを使う
  const input = takeInput(rawInput, ["companyId", "plan", "execute", "expectedTotalAmount", "taskId", "logDir"]);
  const deps = bindDeps(rawDeps, guard);
  const { companyId, plan, execute, expectedTotalAmount, taskId, logDir } = input;
  assertCompanyId(companyId);
  if (execute !== undefined && typeof execute !== "boolean") throw new Error("writer: execute must be a boolean");
  if (typeof taskId !== "string" || taskId === "") throw new Error("writer: taskId is required");
  if (logDir !== undefined && typeof logDir !== "string") throw new Error("writer: logDir must be a string");
  if (expectedTotalAmount !== undefined && (typeof expectedTotalAmount !== "number" || !Number.isFinite(expectedTotalAmount))) {
    throw new Error("writer: expectedTotalAmount must be a finite number");
  }
  const sink = deps.appendAuditFn ?? (logDir ? (e: InvoiceAuditEntry) => appendInvoiceAudit(logDir, e) : undefined);
  if (!sink) throw new Error("writer: appendAudit or logDir is required (no write without an audit log)");
  const appendAudit = async (entry: InvoiceAuditEntry): Promise<void> => {
    if (guard.leaks(entry)) throw new WriterError("audit-failed"); // token を含む記録は書かない
    try {
      await sink(entry);
    } catch {
      throw new WriterError("audit-failed"); // 元の例外は出さない
    }
  };
  let result: InvoiceCreateResult;
  try {
    result = await createInvoiceFromPlan(
      plan,
      { companyId, execute: execute === true, logDir: logDir ?? "", taskId, ...(expectedTotalAmount !== undefined ? { expectedTotal: expectedTotalAmount } : {}) },
      {
        getClient: async () => createInvoiceClient({ token: await deps.getToken(), fetchFn: deps.fetchFn }),
        appendAudit,
        now: deps.now,
      },
    );
  } catch (err) {
    throw sanitize(err, guard, "/invoices");
  }
  // 最後の検査: 戻り値に token が含まれていたら成功にしない（作成済みの可能性があるので unverified）
  if (guard.leaks(result)) throw new InvoiceCreatedButUnverifiedError(result.created?.id, "token_in_result", "succeeded");
  return result;
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
export async function readBackInvoice(rawInput: { companyId: number; id: number }, rawAuth: WriterAuth): Promise<InvoiceReadBack> {
  const guard = new Guard();
  const input = takeInput(rawInput, ["companyId", "id"]);
  const deps = bindDeps(rawAuth, guard);
  const { companyId, id } = input;
  assertCompanyId(companyId);
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("writer: id must be a positive integer");
  try {
    const client = createReadOnlyClient({ api: "invoice", token: await deps.getToken(), fetchFn: deps.fetchFn });
    let json: unknown;
    try {
      const res = await client.get(`/invoices/${id}`, { query: { company_id: companyId } });
      json = await res.json();
    } catch (err) {
      if (err instanceof FreeeApiError) throw new WriterError("http-failed", { status: err.status, path: "/invoices/{id}" });
      if (err instanceof SyntaxError) throw new WriterError("invalid-response");
      throw new WriterError("request-failed");
    }
    const inv = (json as { invoice?: Record<string, unknown> } | null)?.invoice;
    if (
      !inv || inv.id !== id || typeof inv.invoice_number !== "string" || typeof inv.total_amount !== "number" ||
      typeof inv.partner_id !== "number" || typeof inv.billing_date !== "string"
    ) {
      throw new WriterError("invalid-response");
    }
    const out: InvoiceReadBack = {
      id,
      invoice_number: inv.invoice_number,
      partner_id: inv.partner_id,
      billing_date: inv.billing_date,
      total_amount: inv.total_amount,
      webUrl: invoiceWebUrl(id),
    };
    if (guard.leaks(out)) throw new WriterError("invalid-response"); // 応答の欄に token が入っていたら返さない
    return out;
  } catch (err) {
    throw sanitize(err, guard, "/invoices/{id}");
  }
}
