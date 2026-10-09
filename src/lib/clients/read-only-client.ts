import { PublicFreeeClient } from "./freee-public-client.js";
import { INVOICE_API_BASE_URL } from "./freee-invoice-client.js";

/** 読み取りに要る口だけ。post / put / patch / delete / request を型として持たない。 */
export interface ReadOnlyClient {
  get(path: string, options?: ReadOnlyGetOptions): Promise<Response>;
  listAll<T>(
    path: string,
    options?: { limit?: number; offset?: number } & Record<string, string | number | boolean | null | undefined>,
  ): AsyncIterable<T>;
}

/** 任意の header・redirect の上書きは受けない（Authorization の差し替えなどを防ぐ）。 */
export interface ReadOnlyGetOptions {
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
}

export type ReadOnlyApi = "accounting" | "invoice";

export const ACCOUNTING_API_BASE_URL = "https://api.freee.co.jp";

export interface CreateReadOnlyClientOptions {
  /** 接続先は 2 つの freee API のどちらかに固定する。任意のホストは指定できない。 */
  api: ReadOnlyApi;
  token: string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  nowFn?: () => number;
}

/** 相対パス（先頭が / で、// で始まらない）だけ通す。絶対 URL は token を別のホストへ送りうるため拒否する。 */
function assertApiPath(path: string): void {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error("read-only client: path は / で始まる freee API の相対パスだけ（relative path only）");
  }
}

/**
 * GET だけを実行できる client。内部で PublicFreeeClient を包むが、実体は閉包に閉じ込めて外へ出さない
 * （プロパティを持たず、返す object は凍結する）。書き込み系のメソッドは実行時にも存在しない。
 */
export function createReadOnlyClient(options: CreateReadOnlyClientOptions): ReadOnlyClient {
  const inner = new PublicFreeeClient({
    baseUrl: options.api === "invoice" ? INVOICE_API_BASE_URL : ACCOUNTING_API_BASE_URL,
    token: options.token,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options.sleepFn ? { sleepFn: options.sleepFn } : {}),
    ...(options.nowFn ? { nowFn: options.nowFn } : {}),
  });
  return Object.freeze({
    get(path: string, getOptions?: ReadOnlyGetOptions): Promise<Response> {
      assertApiPath(path);
      return inner.get(path, {
        ...(getOptions?.query ? { query: getOptions.query } : {}),
        ...(getOptions?.signal ? { signal: getOptions.signal } : {}),
      });
    },
    listAll<T>(
      path: string,
      listOptions?: { limit?: number; offset?: number } & Record<string, string | number | boolean | null | undefined>,
    ): AsyncIterable<T> {
      assertApiPath(path);
      return inner.listAll<T>(path, listOptions);
    },
  });
}
