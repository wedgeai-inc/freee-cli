export interface RegistryDeps {
  applicationId?: string;
  fetch?: typeof fetch;
}

export interface LegalItem {
  corporateNumber: string;
  name: string;
  address: string;
}

export interface LegalResult {
  status: "found" | "not_found" | "ambiguous";
  total: number;
  complete: boolean;
  items: LegalItem[];
}

export interface RegistryFailure {
  status: "invalid_input" | "configuration_error" | "network_error" | "http_error" | "invalid_response";
  message: string;
}

function validQuery(opts: { number?: string; name?: string }, pattern: RegExp): boolean {
  if ((opts.number === undefined) === (opts.name === undefined)) return false;
  return opts.number !== undefined ? typeof opts.number === "string" && pattern.test(opts.number) :
    typeof opts.name === "string" && opts.name.trim().length > 0 && opts.name.length <= 300 && !/[\x00-\x1f\x7f]/.test(opts.name);
}

const invalidResponse = (): RegistryFailure => ({ status: "invalid_response", message: "Registry returned an invalid or inconsistent response." });

async function request(url: URL, deps: RegistryDeps): Promise<string | RegistryFailure> {
  try {
    const response = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!response.ok) return { status: "http_error", message: `Registry returned HTTP ${response.status}.` };
    return await response.text();
  } catch {
    // fetchの例外や応答本文にはアプリケーションIDが含まれ得るため出力しない。
    return { status: "network_error", message: "Registry request failed or timed out." };
  }
}

function countValue(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Invalid count");
  return Number(value);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** CSVの引用符、二重引用符、フィールド内改行を扱う。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], value = "", quoted = false, closed = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { value += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else value += c;
    } else if (c === "," || c === "\n" || c === "\r") {
      row.push(value); value = ""; closed = false;
      if (c !== ",") {
        rows.push(row); row = [];
        if (c === "\r" && input[i + 1] === "\n") i++;
      }
    } else if (c === '"' && !value && !closed) quoted = true;
    else {
      if (closed || c === '"') throw new Error("Invalid CSV");
      value += c;
    }
  }
  if (quoted) throw new Error("Invalid CSV");
  if (row.length || value || closed) rows.push([...row, value]);
  return rows;
}

export async function runResolveLegal(
  opts: { number?: string; name?: string }, deps: RegistryDeps,
): Promise<LegalResult | RegistryFailure> {
  if (!validQuery(opts, /^[0-9]{13}$/)) return { status: "invalid_input", message: "Specify exactly one of --number (13 digits) or --name (nonempty)." };
  if (!deps.applicationId?.trim()) return { status: "configuration_error", message: "NTA_CORPORATE_APPLICATION_ID is required." };
  const url = new URL(`https://api.houjin-bangou.nta.go.jp/4/${opts.number ? "num" : "name"}`);
  url.search = new URLSearchParams({ id: deps.applicationId, type: "02", history: "0",
    ...(opts.number ? { number: opts.number } : { name: opts.name!, mode: "2", change: "0" }),
  }).toString();
  const body = await request(url, deps);
  if (typeof body !== "string") return body;
  try {
    const rows = parseCsv(body), header = rows[0];
    if (header?.length !== 4 || !validDate(header[0]) || header[2] !== "1") return invalidResponse();
    const total = countValue(header[1]), divisions = countValue(header[3]);
    const items = rows.slice(1).map((r) => {
      const address = r[16] || r[9] + r[10] + r[11];
      if (r.length !== 30 || !/^[0-9]{13}$/.test(r[1]) || !r[6]?.trim() ||
        !address?.trim() || r[23] !== "1" || (opts.number && r[1] !== opts.number)) throw new Error("Invalid corporation");
      return { corporateNumber: r[1], name: r[6], address };
    });
    if (divisions < 1 || total < items.length || (divisions === 1 && total !== items.length)) return invalidResponse();
    const complete = divisions === 1 && total === items.length;
    return { status: total === 0 ? "not_found" : total > 1 || !complete ? "ambiguous" : "found", total, complete, items };
  } catch { return invalidResponse(); }
}

export interface InvoiceItem {
  invoiceNumber: string;
  name: string;
  address: string | null;
  registered: boolean;
  nameMatches: boolean | null;
  registrationDate: string;
  disposalDate: string;
  expireDate: string;
}

export interface InvoiceResult {
  status: "registered" | "not_registered" | "name_mismatch" | "not_yet_registered";
  items: InvoiceItem[];
}

export async function runVerifyInvoice(
  opts: { number?: string; name?: string; expectName?: string },
  deps: RegistryDeps & { corporateApplicationId?: string; now?: () => Date },
): Promise<InvoiceResult | RegistryFailure | LegalResult> {
  if (!validQuery(opts, /^T[0-9]{13}$/) || (opts.expectName !== undefined && !validQuery({ name: opts.expectName }, /^$/))) {
    return { status: "invalid_input", message: "Specify exactly one of --number (T + 13 digits) or --name; --expect-name must be nonempty." };
  }
  if (!deps.applicationId?.trim()) return { status: "configuration_error", message: "NTA_INVOICE_APPLICATION_ID is required." };
  if (opts.name !== undefined) {
    const legal = await runResolveLegal({ name: opts.name }, { applicationId: deps.corporateApplicationId, fetch: deps.fetch });
    if (legal.status !== "found") return legal;
    const candidate = legal.items[0];
    return runVerifyInvoice({ number: `T${candidate.corporateNumber}`, expectName: opts.expectName ?? candidate.name }, deps);
  }
  const url = new URL("https://web-api.invoice-kohyo.nta.go.jp/1/num");
  url.search = new URLSearchParams({ id: deps.applicationId, number: opts.number!, type: "21", history: "0" }).toString();
  const body = await request(url, deps);
  if (typeof body !== "string") return body;
  try {
    const data: unknown = JSON.parse(body);
    if (!record(data) || !validDate(data.lastUpdateDate) || data.divideNumber !== "1" || data.divideSize !== "1" ||
      !Array.isArray(data.announcement) || countValue(data.count) !== data.announcement.length || data.announcement.length > 1) return invalidResponse();
    const today = new Date((deps.now?.() ?? new Date()).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const items: InvoiceItem[] = data.announcement.map((r: unknown) => {
      if (!record(r) || typeof r.registratedNumber !== "string" || r.registratedNumber !== opts.number || typeof r.name !== "string" || !r.name.trim() ||
        r.latest !== "1" || !validDate(r.registrationDate) ||
        !(r.disposalDate === "" || validDate(r.disposalDate)) || !(r.expireDate === "" || validDate(r.expireDate)) ||
        typeof r.address !== "string" || typeof r.addressRequest !== "string" || typeof r.addressInside !== "string") {
        throw new Error("Invalid announcement");
      }
      return {
        invoiceNumber: r.registratedNumber, name: r.name, address: r.address || r.addressRequest || r.addressInside || null,
        registrationDate: r.registrationDate, disposalDate: r.disposalDate, expireDate: r.expireDate,
        registered: r.registrationDate <= today && !(r.disposalDate && r.disposalDate <= today) && !(r.expireDate && r.expireDate <= today),
        nameMatches: opts.expectName === undefined ? null : opts.expectName === r.name,
      };
    });
    const item = items[0];
    const status = !item ? "not_registered" : item.nameMatches === false ? "name_mismatch" :
      item.registrationDate > today ? "not_yet_registered" : item.registered ? "registered" : "not_registered";
    return { status, items };
  } catch { return invalidResponse(); }
}
