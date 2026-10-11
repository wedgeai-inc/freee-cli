import { describe, expect, it, vi } from "vitest";
import * as writer from "../../src/writer.js";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plan = {
  billing_date: "2026-09-05",
  partner_id: 123,
  partner_title: "御中",
  tax_entry_method: "out",
  tax_fraction: "omit",
  withholding_tax_entry_method: "out",
  lines: [{ description: "開発支援", quantity: 2, unit: "時間", unit_price: "10000", tax_rate: 10 }],
};

const postOk = () => new Response(JSON.stringify({ invoice: { id: 555 } }), { status: 201 });
const getOk = (over: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({ invoice: { id: 555, invoice_number: "INV-1", total_amount: 22000, partner_id: 123, billing_date: "2026-09-05", ...over } }),
    { status: 200 },
  );

function setup(responses: Array<() => Response | Promise<Response>> = []) {
  const queue = [...responses];
  const calls: Array<{ url: string; method: string; auth: string; body?: string }> = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", auth: String((init?.headers as Record<string, string>)?.Authorization ?? ""), body: init?.body as string | undefined });
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  }) as unknown as typeof fetch;
  const getToken = vi.fn(async () => "tok-1");
  const audits: writer.InvoiceAuditEntry[] = [];
  const deps = { getToken, fetchFn, appendAudit: async (e: writer.InvoiceAuditEntry) => void audits.push(e), now: () => new Date("2026-09-05T13:00:00Z") };
  return { calls, fetchFn, getToken, audits, deps };
}
const input = { companyId: 999, plan, taskId: "t-1" };

describe("writer entry surface", () => {
  it("exports exactly the allowed names; no raw clients", () => {
    expect(Object.keys(writer).sort()).toEqual(
      ["AuditWriteError", "FreeeApiError", "InvoiceCreatedButUnverifiedError", "ResponseParseError", "WriterError", "appendInvoiceAudit", "classifyFailure", "createInvoice", "parseInvoicePlan", "readBackInvoice"].sort(),
    );
    const bag = writer as Record<string, unknown>;
    for (const n of ["PublicFreeeClient", "createInvoiceClient", "runInvoicesCreate", "createInvoiceFromPlan"]) expect(bag[n]).toBeUndefined();
  });
});

describe("createInvoice: dry-run is the default", () => {
  for (const execute of [undefined, false] as const) {
    it(`execute=${String(execute)} sends nothing and never asks for a token`, async () => {
      const s = setup();
      const r = await writer.createInvoice({ ...input, ...(execute === undefined ? {} : { execute }) }, s.deps);
      expect(r.mode).toBe("dry-run");
      expect(s.fetchFn).not.toHaveBeenCalled();
      expect(s.getToken).not.toHaveBeenCalled();
      expect(s.audits.map((a) => a.status)).toEqual(["planned"]);
    });
  }
  for (const bad of ["true", 1, "yes", null, {}, [], 0, "false"]) {
    it(`execute=${JSON.stringify(bad)} (non-boolean) is rejected before anything happens`, async () => {
      const s = setup();
      await expect(writer.createInvoice({ ...input, execute: bad as unknown as boolean }, s.deps)).rejects.toThrow(/execute must be a boolean/);
      expect(s.fetchFn).not.toHaveBeenCalled();
      expect(s.getToken).not.toHaveBeenCalled();
      expect(s.audits).toEqual([]);
    });
  }
});

describe("createInvoice: execute", () => {
  it("posts, reads back, audits created; token injected as Bearer", async () => {
    const s = setup([postOk, () => getOk()]);
    const r = await writer.createInvoice({ ...input, execute: true }, s.deps);
    expect(r.created).toMatchObject({ id: 555, invoice_number: "INV-1", total_amount: 22000 });
    expect(s.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
    expect(s.calls.every((c) => c.auth === "Bearer tok-1")).toBe(true);
    expect(JSON.parse(s.calls[0]!.body!).company_id).toBe(999);
    expect(s.audits.map((a) => a.status)).toEqual(["created"]);
    expect(s.getToken).toHaveBeenCalledTimes(1);
  });
  it("4xx -> WriterError http-failed with status/path only, not 'unverified' (re-runnable)", async () => {
    const s = setup([() => new Response("{}", { status: 422 })]);
    const e = await writer.createInvoice({ ...input, execute: true }, s.deps).catch((x) => x);
    expect(e).toBeInstanceOf(writer.WriterError);
    expect(e).toMatchObject({ code: "http-failed", status: 422 });
    expect(s.audits.map((a) => a.status)).toEqual(["failed"]);
  });
  for (const status of [500, 502, 503]) {
    it(`${status} -> InvoiceCreatedButUnverifiedError postState=unknown`, async () => {
      const s = setup([() => new Response("{}", { status }), () => new Response("{}", { status }), () => new Response("{}", { status }), () => new Response("{}", { status })]);
      const e = await writer.createInvoice({ ...input, execute: true }, s.deps).catch((x) => x);
      expect(e).toBeInstanceOf(writer.InvoiceCreatedButUnverifiedError);
      expect(e.postState).toBe("unknown");
      expect(s.calls.filter((c) => c.method === "POST").length).toBe(1);
    });
  }
  it("network failure after sending -> unknown, no second POST", async () => {
    const s = setup([() => { throw new TypeError("fetch failed"); }]);
    const e = await writer.createInvoice({ ...input, execute: true }, s.deps).catch((x) => x);
    expect(e).toBeInstanceOf(writer.InvoiceCreatedButUnverifiedError);
    expect(e.postState).toBe("unknown");
    expect(s.calls).toHaveLength(1);
  });
  it("2xx but read-back fails -> unverified with createdId (succeeded)", async () => {
    const s = setup([postOk, () => new Response("{}", { status: 404 })]);
    const e = await writer.createInvoice({ ...input, execute: true }, s.deps).catch((x) => x);
    expect(e).toBeInstanceOf(writer.InvoiceCreatedButUnverifiedError);
    expect(e.createdId).toBe(555);
    expect(e.postState).toBe("succeeded");
  });
  it("2xx with a body lacking invoice.id -> unverified (never success)", async () => {
    const s = setup([() => new Response("{}", { status: 201 })]);
    const e = await writer.createInvoice({ ...input, execute: true }, s.deps).catch((x) => x);
    expect(e).toBeInstanceOf(writer.InvoiceCreatedButUnverifiedError);
    expect(e.createdId).toBeUndefined();
  });
  it("2xx with non-JSON body -> unverified", async () => {
    const s = setup([() => new Response("<html>", { status: 201 })]);
    await expect(writer.createInvoice({ ...input, execute: true }, s.deps)).rejects.toBeInstanceOf(writer.InvoiceCreatedButUnverifiedError);
  });
  it("audit write failure does not hide the POST state", async () => {
    const s = setup([postOk, () => getOk()]);
    const e = await writer.createInvoice({ ...input, execute: true }, { ...s.deps, appendAudit: async () => { throw new Error("disk full"); } }).catch((x) => x);
    expect(e).toBeInstanceOf(writer.AuditWriteError);
    expect(e.postState).toBe("succeeded");
    expect(e.createdId).toBe(555);
  });
});

describe("createInvoice: plan validation (loophole sweep)", () => {
  const mutate = (f: (p: Record<string, any>) => void) => { const p = JSON.parse(JSON.stringify(plan)); f(p); return p; };
  const bad: Array<[string, unknown]> = [
    ["unknown top-level key", mutate((p) => { p.extra = 1; })],
    ["company_id inside plan", mutate((p) => { p.company_id = 1; })],
    ["sending settings (sending_status)", mutate((p) => { p.sending_status = "sent"; })],
    ["cancel_status", mutate((p) => { p.cancel_status = "canceled"; })],
    ["id", mutate((p) => { p.id = 1; })],
    ["invoice_contents (raw API key)", mutate((p) => { p.invoice_contents = []; })],
    ["__proto__ key", JSON.parse('{"__proto__":{"x":1},"billing_date":"2026-09-05"}')],
    ["unknown line key", mutate((p) => { p.lines[0].foo = 1; })],
    ["line type invalid", mutate((p) => { p.lines[0].type = "other"; })],
    ["billing_date wrong format", mutate((p) => { p.billing_date = "2026/09/05"; })],
    ["billing_date number", mutate((p) => { p.billing_date = 20260905; })],
    ["billing_date missing", mutate((p) => { delete p.billing_date; })],
    ["partner_title invalid", mutate((p) => { p.partner_title = "殿"; })],
    ["tax_entry_method invalid", mutate((p) => { p.tax_entry_method = "x"; })],
    ["tax_fraction invalid", mutate((p) => { p.tax_fraction = "floor"; })],
    ["withholding invalid", mutate((p) => { p.withholding_tax_entry_method = "none"; })],
    ["lines empty", mutate((p) => { p.lines = []; })],
    ["lines not array", mutate((p) => { p.lines = {}; })],
    ["lines missing", mutate((p) => { delete p.lines; })],
    ["unit_price number (must be string)", mutate((p) => { p.lines[0].unit_price = 10000; })],
    ["unit_price garbage", mutate((p) => { p.lines[0].unit_price = "1e3"; })],
    ["unit_price too many decimals", mutate((p) => { p.lines[0].unit_price = "1.2345"; })],
    ["quantity string", mutate((p) => { p.lines[0].quantity = "2"; })],
    ["quantity NaN-like (too large)", mutate((p) => { p.lines[0].quantity = 1e12; })],
    ["tax_rate 5", mutate((p) => { p.lines[0].tax_rate = 5; })],
    ["tax_rate string", mutate((p) => { p.lines[0].tax_rate = "10"; })],
    ["partner_id string", mutate((p) => { p.partner_id = "123"; })],
    ["partner_id negative", mutate((p) => { p.partner_id = -1; })],
    ["partner_id float", mutate((p) => { p.partner_id = 1.5; })],
    ["memo too long", mutate((p) => { p.memo = "a".repeat(2001); })],
    ["payment_type invalid", mutate((p) => { p.payment_type = "cash"; })],
    ["tag_ids non-array", mutate((p) => { p.lines[0].tag_ids = 1; })],
    ["null plan", null],
    ["undefined plan", undefined],
    ["string plan", "{}"],
    ["number plan", 1],
    ["array plan", []],
    ["empty object", {}],
  ];
  for (const [name, p] of bad) {
    it(`rejects ${name} before token/network, even with execute:true`, async () => {
      const s = setup();
      await expect(writer.createInvoice({ ...input, plan: p, execute: true }, s.deps)).rejects.toThrow();
      expect(s.getToken).not.toHaveBeenCalled();
      expect(s.fetchFn).not.toHaveBeenCalled();
      expect(s.audits).toEqual([]);
    });
  }
});

describe("createInvoice: input and injection errors", () => {
  for (const companyId of [0, -1, 1.5, NaN, Infinity, "999", null, undefined, 2 ** 60]) {
    it(`companyId=${String(companyId)} rejected`, async () => {
      const s = setup();
      await expect(writer.createInvoice({ ...input, companyId: companyId as number, execute: true }, s.deps)).rejects.toThrow(/companyId/);
      expect(s.fetchFn).not.toHaveBeenCalled();
    });
  }
  for (const taskId of ["", undefined, 5]) {
    it(`taskId=${String(taskId)} rejected`, async () => {
      const s = setup();
      await expect(writer.createInvoice({ ...input, taskId: taskId as string }, s.deps)).rejects.toThrow(/taskId/);
    });
  }
  for (const tok of ["", "   ", undefined, null, 5]) {
    it(`getToken returning ${JSON.stringify(tok)} -> no POST`, async () => {
      const s = setup();
      await expect(writer.createInvoice({ ...input, execute: true }, { ...s.deps, getToken: async () => tok as unknown as string })).rejects.toMatchObject({ code: "token-unavailable" });
      expect(s.fetchFn).not.toHaveBeenCalled();
    });
  }
  it("getToken throwing -> no POST, fixed classification", async () => {
    const s = setup();
    await expect(writer.createInvoice({ ...input, execute: true }, { ...s.deps, getToken: async () => { throw new Error("op failed"); } })).rejects.toMatchObject({ code: "token-unavailable" });
    expect(s.fetchFn).not.toHaveBeenCalled();
  });
  it("getToken not a function -> rejected, no POST", async () => {
    const s = setup();
    await expect(writer.createInvoice({ ...input, execute: true }, { ...s.deps, getToken: "tok" as unknown as () => Promise<string> })).rejects.toThrow(/getToken/);
    expect(s.fetchFn).not.toHaveBeenCalled();
  });
  it("no appendAudit and no logDir -> refuses to write (audit is mandatory)", async () => {
    const s = setup([postOk, () => getOk()]);
    await expect(writer.createInvoice({ ...input, execute: true }, { getToken: s.getToken, fetchFn: s.fetchFn })).rejects.toThrow(/audit/);
    expect(s.fetchFn).not.toHaveBeenCalled();
  });
  it("logDir writes a JSONL audit file without the token or e-mail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w-audit-"));
    const s = setup([postOk, () => getOk()]);
    await writer.createInvoice({ ...input, execute: true, logDir: dir }, { getToken: s.getToken, fetchFn: s.fetchFn, now: s.deps.now });
    const f = readdirSync(dir);
    expect(f).toEqual(["freee-invoice-create-2026-09-05.jsonl"]);
    const text = readFileSync(join(dir, f[0]!), "utf8");
    expect(text).not.toContain("tok-1");
    expect(text).toContain('"status":"created"');
  });
  it("plan with an e-mail value is refused by the audit guard in dry-run too", async () => {
    const s = setup();
    const p = { ...plan, memo: "mail me at a@example.com" };
    const r = await writer.createInvoice({ ...input, plan: p }, s.deps);
    expect(JSON.stringify(s.audits[0]!.payload_redacted)).not.toContain("a@example.com");
    expect(r.mode).toBe("dry-run");
  });
});

describe("readBackInvoice", () => {
  const auth = (s: ReturnType<typeof setup>) => ({ getToken: s.getToken, fetchFn: s.fetchFn });
  it("returns the 5 comparison values and uses GET only", async () => {
    const s = setup([() => getOk()]);
    const r = await writer.readBackInvoice({ companyId: 999, id: 555 }, auth(s));
    expect(r).toEqual({ id: 555, invoice_number: "INV-1", partner_id: 123, billing_date: "2026-09-05", total_amount: 22000, webUrl: expect.stringContaining("/555") });
    expect(s.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(s.calls[0]!.url).toContain("company_id=999");
  });
  for (const over of [{ id: 556 }, { invoice_number: 1 }, { partner_id: "123" }, { billing_date: 20260905 }, { total_amount: "22000" }, { partner_id: undefined }]) {
    it(`mismatched shape ${JSON.stringify(over)} -> throws`, async () => {
      const s = setup([() => getOk(over)]);
      await expect(writer.readBackInvoice({ companyId: 999, id: 555 }, auth(s))).rejects.toMatchObject({ code: "invalid-response" });
    });
  }
  for (const id of [0, -1, 1.5, NaN]) {
    it(`id=${id} rejected without network`, async () => {
      const s = setup();
      await expect(writer.readBackInvoice({ companyId: 999, id }, auth(s))).rejects.toThrow();
      expect(s.fetchFn).not.toHaveBeenCalled();
    });
  }
  it("non-JSON body -> throws", async () => {
    const s = setup([() => new Response("x", { status: 200 })]);
    await expect(writer.readBackInvoice({ companyId: 999, id: 555 }, auth(s))).rejects.toMatchObject({ code: "invalid-response" });
  });
  it("404 -> WriterError http-failed", async () => {
    const s = setup([() => new Response("{}", { status: 404 })]);
    await expect(writer.readBackInvoice({ companyId: 999, id: 555 }, auth(s))).rejects.toMatchObject({ code: "http-failed", status: 404 });
  });
  it("empty token -> no network", async () => {
    const s = setup();
    await expect(writer.readBackInvoice({ companyId: 999, id: 555 }, { getToken: async () => "", fetchFn: s.fetchFn })).rejects.toMatchObject({ code: "token-unavailable" });
    expect(s.fetchFn).not.toHaveBeenCalled();
  });
});

const SECRET = "SECRET-TOKEN-abc123";
function leaks(e: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (v: unknown): boolean => {
    if (typeof v === "string") return v.includes(SECRET);
    if (v === null || typeof v !== "object" || seen.has(v)) return false;
    seen.add(v);
    const o = v as Record<string, unknown>;
    return [...Object.getOwnPropertyNames(o), "message", "stack", "cause"].some((k) => { try { return walk(o[k]); } catch { return false; } });
  };
  return walk(e) || JSON.stringify(e, Object.getOwnPropertyNames(e as object)).includes(SECRET);
}

describe("no path leaks a token via exception text (error sanitization)", () => {
  const boom = () => { throw new Error(`Bearer ${SECRET} rejected`); };
  it("getToken throws (create)", async () => {
    const s = setup();
    const e = await writer.createInvoice({ ...input, execute: true }, { ...s.deps, getToken: async () => boom() }).catch((x) => x);
    expect(e).toMatchObject({ code: "token-unavailable" });
    expect(leaks(e)).toBe(false);
  });
  it("getToken throws (readBack)", async () => {
    const s = setup();
    const e = await writer.readBackInvoice({ companyId: 1, id: 1 }, { getToken: async () => boom(), fetchFn: s.fetchFn }).catch((x) => x);
    expect(e).toMatchObject({ code: "token-unavailable" });
    expect(leaks(e)).toBe(false);
  });
  it("fetch throws a token-bearing error on POST (unknown state kept)", async () => {
    const s = setup([() => boom()]);
    const e = await writer.createInvoice({ ...input, execute: true }, s.deps).catch((x) => x);
    expect(e).toBeInstanceOf(writer.InvoiceCreatedButUnverifiedError);
    expect(e.postState).toBe("unknown");
    expect(leaks(e)).toBe(false);
  });
  it("fetch throws on read-back GET (readBack)", async () => {
    const s = setup([() => boom()]);
    const e = await writer.readBackInvoice({ companyId: 1, id: 1 }, { getToken: s.getToken, fetchFn: s.fetchFn }).catch((x) => x);
    expect(e).toMatchObject({ code: "request-failed" });
    expect(leaks(e)).toBe(false);
  });
  it("API error body that echoes the token is not copied (create 4xx / readBack)", async () => {
    const s = setup([() => new Response(`bad ${SECRET}`, { status: 400 })]);
    const e = await writer.createInvoice({ ...input, execute: true }, s.deps).catch((x) => x);
    expect(leaks(e)).toBe(false);
    const s2 = setup([() => new Response(`bad ${SECRET}`, { status: 403 })]);
    const e2 = await writer.readBackInvoice({ companyId: 1, id: 1 }, { getToken: s2.getToken, fetchFn: s2.fetchFn }).catch((x) => x);
    expect(leaks(e2)).toBe(false);
  });
  it("audit write throws a token-bearing error (execute, after POST): AuditWriteError keeps the POST state", async () => {
    const s = setup([postOk, () => getOk()]);
    const e = await writer.createInvoice({ ...input, execute: true }, { ...s.deps, appendAudit: async () => boom() }).catch((x) => x);
    expect(e).toBeInstanceOf(writer.AuditWriteError);
    expect(e.postState).toBe("succeeded");
    expect(leaks(e)).toBe(false);
  });
  it("audit write throws in dry-run", async () => {
    const s = setup();
    const e = await writer.createInvoice(input, { ...s.deps, appendAudit: async () => boom() }).catch((x) => x);
    expect(e).toMatchObject({ code: "audit-failed" });
    expect(leaks(e)).toBe(false);
  });
  it("now() throws a token-bearing error", async () => {
    const s = setup();
    const e = await writer.createInvoice(input, { ...s.deps, now: () => boom() }).catch((x) => x);
    expect(leaks(e)).toBe(false);
  });
  it("2xx + response body echoing the token + failed read-back", async () => {
    const s = setup([postOk, () => new Response(`x ${SECRET}`, { status: 500 }), () => new Response(`x ${SECRET}`, { status: 500 })]);
    const e = await writer.createInvoice({ ...input, execute: true }, s.deps).catch((x) => x);
    expect(e).toBeInstanceOf(writer.InvoiceCreatedButUnverifiedError);
    expect(leaks(e)).toBe(false);
  });
});

describe("plan snapshot: caller mutation during the token wait cannot change what is sent", () => {
  function livePlan() {
    return JSON.parse(JSON.stringify({ ...plan, lines: [{ ...plan.lines[0], tag_ids: [1, 2] }] }));
  }
  it("mutating tag_ids / lines / amounts while getToken is pending does not affect the body", async () => {
    const p = livePlan();
    const s = setup([postOk, () => getOk()]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pending = writer.createInvoice({ ...input, plan: p, execute: true }, { ...s.deps, getToken: async () => { await gate; return "tok-1"; } });
    p.lines[0].tag_ids.push(-5, "x");
    p.lines[0].unit_price = "99999999";
    p.lines.push({ description: "x" });
    p.partner_id = 999999;
    release();
    await pending;
    const body = JSON.parse(s.calls[0]!.body!);
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].tag_ids).toEqual([1, 2]);
    expect(body.lines[0].unit_price).toBe("10000");
    expect(body.partner_id).toBe(123);
  });
  it("overridden some/map/slice on the input arrays are not called", async () => {
    const p = livePlan();
    p.lines[0].tag_ids.some = () => false;
    p.lines[0].tag_ids.slice = () => [-1];
    p.lines[0].tag_ids.push(-9);
    p.lines.map = () => [];
    const s = setup();
    await expect(writer.createInvoice({ ...input, plan: p }, s.deps)).rejects.toThrow(/tag_ids/);
  });
  it("a getter that returns a valid value first and a bad one later is evaluated once", async () => {
    let n = 0;
    const p = livePlan();
    Object.defineProperty(p, "partner_title", { enumerable: true, get: () => (n++ === 0 ? "御中" : "殿") });
    const s = setup([postOk, () => getOk()]);
    await writer.createInvoice({ ...input, plan: p, execute: true }, s.deps);
    expect(JSON.parse(s.calls[0]!.body!).partner_title).toBe("御中");
  });
  it("a Proxy plan is flattened to plain data", async () => {
    let n = 0;
    const base = livePlan();
    const p = new Proxy(base, { get: (t, k) => (k === "partner_id" && n++ > 0 ? 7 : (t as any)[k]) });
    const s = setup([postOk, () => getOk()]);
    await writer.createInvoice({ ...input, plan: p, execute: true }, s.deps);
    expect(JSON.parse(s.calls[0]!.body!).partner_id).toBe(123);
  });
  for (const [name, p] of [["BigInt", { ...plan, partner_id: 1n }], ["circular", (() => { const o: any = { ...plan }; o.self = o; return o; })()], ["function", () => 1]] as const) {
    it(`non-JSON plan (${name}) rejected before token/network`, async () => {
      const s = setup();
      await expect(writer.createInvoice({ ...input, plan: p, execute: true }, s.deps)).rejects.toThrow(/JSON-serializable/);
      expect(s.getToken).not.toHaveBeenCalled();
    });
  }
  it("toJSON on the plan is flattened (cannot smuggle a different object past the validator)", async () => {
    const p = livePlan();
    p.toJSON = () => ({ ...plan, partner_id: 5 });
    const s = setup([postOk, () => getOk({ partner_id: 5 })]);
    await writer.createInvoice({ ...input, plan: p, execute: true }, s.deps);
    // 検査も送信も、同じ snapshot（toJSON の結果）に対して行われる
    expect(JSON.parse(s.calls[0]!.body!).partner_id).toBe(5);
  });
});

describe("read-back must match what was approved", () => {
  const run = (over: Record<string, unknown>, extra: Record<string, unknown> = {}, plan2: unknown = plan) => {
    const s = setup([postOk, () => getOk(over)]);
    return writer.createInvoice({ ...input, plan: plan2, execute: true, ...extra }, s.deps).catch((x) => x);
  };
  it("matching values succeed (with expected total)", async () => {
    const r = await run({}, { expectedTotalAmount: 22000 });
    expect(r.created.id).toBe(555);
  });
  for (const [name, over, extra] of [
    ["billing_date", { billing_date: "2026-09-06" }, {}],
    ["partner_id", { partner_id: 124 }, {}],
    ["total_amount", { total_amount: 22001 }, { expectedTotalAmount: 22000 }],
    ["billing_date (missing)", { billing_date: undefined }, {}],
    ["partner_id (missing)", { partner_id: undefined }, {}],
  ] as const) {
    it(`${name} differs -> unverified with createdId and succeeded state`, async () => {
      const e = await run(over, extra);
      expect(e).toBeInstanceOf(writer.InvoiceCreatedButUnverifiedError);
      expect(e.createdId).toBe(555);
      expect(e.postState).toBe("succeeded");
      expect(e.reason).toMatch(/^readback_mismatch:|^invalid_response/);
    });
  }
  it("invoice_number differs from the one the plan specified", async () => {
    const e = await run({ invoice_number: "OTHER" }, {}, { ...plan, invoice_number: "INV-9" });
    expect(e).toBeInstanceOf(writer.InvoiceCreatedButUnverifiedError);
    expect(e.reason).toBe("readback_mismatch:invoice_number");
  });
  it("invoice_number equal -> ok", async () => {
    const r = await run({ invoice_number: "INV-9" }, {}, { ...plan, invoice_number: "INV-9" });
    expect(r.created.invoice_number).toBe("INV-9");
  });
  it("partner_code plans skip the partner_id comparison (no id to compare)", async () => {
    const { partner_id: _omit, ...rest } = plan;
    const r = await run({ partner_id: 77 }, {}, { ...rest, partner_code: "C-1" });
    expect(r.created.id).toBe(555);
  });
  it("expectedTotalAmount must be a finite number", async () => {
    const s = setup();
    await expect(writer.createInvoice({ ...input, expectedTotalAmount: NaN }, s.deps)).rejects.toThrow(/expectedTotalAmount/);
    await expect(writer.createInvoice({ ...input, expectedTotalAmount: "1" as unknown as number }, s.deps)).rejects.toThrow(/expectedTotalAmount/);
  });
  it("mismatch is audited as failed with a fixed reason", async () => {
    const s = setup([postOk, () => getOk({ partner_id: 1 })]);
    await writer.createInvoice({ ...input, execute: true }, s.deps).catch(() => undefined);
    expect(s.audits.map((a) => [a.status, a.reason, a.created_id])).toEqual([["failed", "readback_mismatch:partner_id", 555]]);
  });
});
