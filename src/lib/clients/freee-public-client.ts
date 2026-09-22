export interface PublicFreeeClientOptions {
  baseUrl: string;
  token: string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  nowFn?: () => number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** 指定時だけ fetch の redirect policy を上書きする。未指定なら fetch の既定を維持する。 */
  redirect?: "follow" | "error" | "manual";
}

const IMF_FIXDATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/;
const RFC850_DATE = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), ([0-9]{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/;
const ASCTIME_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/;
const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export class FreeeApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body_snippet: string;
  readonly retryAfterMs?: number;
  readonly redacted = true;

  constructor(params: { status: number; path: string; bodySnippet: string; retryAfterMs?: number }) {
    super(`freee API request failed: ${params.status} ${params.path}`);
    this.name = "FreeeApiError";
    this.status = params.status;
    this.path = params.path;
    this.body_snippet = params.bodySnippet;
    this.retryAfterMs = params.retryAfterMs;
  }
}

function capSnippet(text: string, max = 500): string {
  return text.length <= max ? text : text.slice(0, max);
}

function redactSnippet(text: string): string {
  const maskedToken = text.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]");
  return maskedToken.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  if (/^[0-9]+$/.test(value)) {
    const seconds = BigInt(value);
    return seconds >= 60n ? 60_000 : Number(seconds) * 1000;
  }
  const dateMs = parseHttpDateMs(value, nowMs);
  if (dateMs === undefined) return undefined;
  return Math.max(0, Math.min(dateMs - nowMs, 60_000));
}

function parseHttpDateMs(value: string, nowMs: number): number | undefined {
  const imf = IMF_FIXDATE.exec(value);
  if (imf) {
    return validatedUtcMs(imf[1]!, SHORT_WEEKDAYS, imf[2]!, imf[3]!, imf[4]!, imf[5]!, imf[6]!, imf[7]!);
  }
  const rfc850 = RFC850_DATE.exec(value);
  if (rfc850) {
    const shortYear = Number(rfc850[4]);
    const now = new Date(nowMs);
    let year = Math.floor(now.getUTCFullYear() / 100) * 100 + shortYear;
    const candidate = rawUtcMs(year, rfc850[2]!, rfc850[3]!, rfc850[5]!, rfc850[6]!, rfc850[7]!);
    const threshold = new Date(nowMs);
    threshold.setUTCFullYear(threshold.getUTCFullYear() + 50);
    if (candidate !== undefined && candidate > threshold.getTime()) year -= 100;
    return validatedUtcMs(
      rfc850[1]!,
      LONG_WEEKDAYS,
      rfc850[2]!,
      rfc850[3]!,
      String(year),
      rfc850[5]!,
      rfc850[6]!,
      rfc850[7]!,
    );
  }
  const asctime = ASCTIME_DATE.exec(value);
  if (asctime) {
    return validatedUtcMs(
      asctime[1]!,
      SHORT_WEEKDAYS,
      asctime[3]!.trim(),
      asctime[2]!,
      asctime[7]!,
      asctime[4]!,
      asctime[5]!,
      asctime[6]!,
    );
  }
  return undefined;
}

function rawUtcMs(
  year: number,
  dayText: string,
  monthText: string,
  hourText: string,
  minuteText: string,
  secondText: string,
): number | undefined {
  const month = MONTHS.indexOf(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1601 || month < 0 || hour > 23 || minute > 59 || second > 60) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== Math.min(second, 59)
  ) {
    return undefined;
  }
  return date.getTime() + (second === 60 ? 1000 : 0);
}

function validatedUtcMs(
  weekday: string,
  weekdayNames: string[],
  dayText: string,
  monthText: string,
  yearText: string,
  hourText: string,
  minuteText: string,
  secondText: string,
): number | undefined {
  const ms = rawUtcMs(Number(yearText), dayText, monthText, hourText, minuteText, secondText);
  if (ms === undefined) return undefined;
  const weekdayInstant = new Date(ms - (Number(secondText) === 60 ? 1000 : 0));
  return weekdayNames[weekdayInstant.getUTCDay()] === weekday ? ms : undefined;
}

function extractArrayPayload<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }
  if (payload && typeof payload === "object") {
    for (const value of Object.values(payload)) {
      if (Array.isArray(value)) {
        return value as T[];
      }
    }
  }
  return [];
}

export class PublicFreeeClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly nowFn: () => number;

  constructor(options: PublicFreeeClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn = options.sleepFn ?? abortableSleep;
    this.nowFn = options.nowFn ?? Date.now;
  }

  async request(method: string, path: string, options?: RequestOptions): Promise<Response> {
    const base = new URL(this.baseUrl);
    const hasBasePath = base.pathname !== "/";
    const resolvedPath = hasBasePath
      ? `${this.baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`
      : path;
    const url = new URL(resolvedPath, this.baseUrl);
    for (const [key, value] of Object.entries(options?.query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      ...(options?.headers ?? {}),
    };
    let body: string | undefined;
    if (options && Object.prototype.hasOwnProperty.call(options, "body")) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body ?? {});
    }

    const response = await this.fetchFn(url.toString(), {
      method,
      headers,
      body,
      signal: options?.signal,
      ...(options?.redirect === undefined ? {} : { redirect: options.redirect }),
    });
    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"), this.nowFn());
      if (response.status === 429 && method === "GET") {
        void response.body?.cancel().catch(() => undefined);
        throw new FreeeApiError({ status: response.status, path, bodySnippet: "", retryAfterMs });
      }
      const raw = await response.text().catch(() => "");
      throw new FreeeApiError({
        status: response.status,
        path,
        bodySnippet: capSnippet(redactSnippet(raw)),
        retryAfterMs,
      });
    }
    return response;
  }

  async get(path: string, options?: Omit<RequestOptions, "body">): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.request("GET", path, options);
      } catch (error) {
        if (!(error instanceof FreeeApiError) || error.status !== 429 || attempt >= 3) throw error;
        const delayMs = error.retryAfterMs ?? 1000 * 2 ** attempt;
        if (options?.signal) await this.sleepFn(delayMs, options.signal);
        else await this.sleepFn(delayMs);
      }
    }
  }

  post(path: string, options?: RequestOptions): Promise<Response> {
    return this.request("POST", path, options);
  }

  put(path: string, options?: RequestOptions): Promise<Response> {
    return this.request("PUT", path, options);
  }

  patch(path: string, options?: RequestOptions): Promise<Response> {
    return this.request("PATCH", path, options);
  }

  delete(path: string, options?: Omit<RequestOptions, "body">): Promise<Response> {
    return this.request("DELETE", path, options);
  }

  async *listAll<T>(
    path: string,
    options?: { limit?: number; offset?: number } & Record<string, string | number | boolean | null | undefined>,
  ): AsyncIterable<T> {
    const limit = options?.limit ?? 200;
    let offset = options?.offset ?? 0;
    const { limit: _l, offset: _o, ...restQuery } = options ?? {};

    while (true) {
      const response = await this.get(path, {
        query: { ...restQuery, limit, offset },
      });
      const payload = (await response.json()) as unknown;
      const items = extractArrayPayload<T>(payload);
      for (const item of items) {
        yield item;
      }
      if (items.length < limit) {
        return;
      }
      offset += items.length;
    }
  }
}
