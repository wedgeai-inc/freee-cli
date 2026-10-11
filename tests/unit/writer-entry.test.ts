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
      await expect(writer.createInvoice({ ...input, companyId: companyId as number, execute: true }, s.deps)).rejects.toThrow(/companyId|plain data/);
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
    await expect(writer.createInvoice({ ...input, plan: p }, s.deps)).rejects.toThrow(/plain data/);
  });
  it("a getter on the plan is rejected without being invoked", async () => {
    let n = 0;
    const p = livePlan();
    Object.defineProperty(p, "partner_title", { enumerable: true, get: () => (n++ === 0 ? "御中" : "殿") });
    const s = setup();
    await expect(writer.createInvoice({ ...input, plan: p, execute: true }, s.deps)).rejects.toThrow(/plain data/);
    expect(n).toBe(0); // getter は実行されない
    expect(s.getToken).not.toHaveBeenCalled();
  });
  it("a Proxy plan is rejected without running its traps", async () => {
    let n = 0;
    const base = livePlan();
    const p = new Proxy(base, { get: (t, k) => (k === "partner_id" && n++ > 0 ? 7 : (t as any)[k]) });
    const s = setup();
    await expect(writer.createInvoice({ ...input, plan: p, execute: true }, s.deps)).rejects.toThrow(/plain data/);
    expect(n).toBe(0);
  });
  for (const [name, p] of [["BigInt", { ...plan, partner_id: 1n }], ["circular", (() => { const o: any = { ...plan }; o.self = o; return o; })()], ["function", () => 1]] as const) {
    it(`non-JSON plan (${name}) rejected before token/network`, async () => {
      const s = setup();
      await expect(writer.createInvoice({ ...input, plan: p, execute: true }, s.deps)).rejects.toThrow(/plain data/);
      expect(s.getToken).not.toHaveBeenCalled();
    });
  }
  it("toJSON on the plan is rejected (a function value), never executed", async () => {
    const p = livePlan();
    p.toJSON = () => ({ ...plan, partner_id: 5 });
    const s = setup();
    await expect(writer.createInvoice({ ...input, plan: p, execute: true }, s.deps)).rejects.toThrow(/plain data/);
    expect(s.fetchFn).not.toHaveBeenCalled();
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
    await expect(writer.createInvoice({ ...input, expectedTotalAmount: NaN }, s.deps)).rejects.toThrow(/plain data|expectedTotalAmount/);
    await expect(writer.createInvoice({ ...input, expectedTotalAmount: "1" as unknown as number }, s.deps)).rejects.toThrow(/expectedTotalAmount/);
  });
  it("mismatch is audited as failed with a fixed reason", async () => {
    const s = setup([postOk, () => getOk({ partner_id: 1 })]);
    await writer.createInvoice({ ...input, execute: true }, s.deps).catch(() => undefined);
    expect(s.audits.map((a) => [a.status, a.reason, a.created_id])).toEqual([["failed", "readback_mismatch:partner_id", 555]]);
  });
});

// ---------------------------------------------------------------------------
// round 2: 入口（plain なデータだけ・1 回だけ取り出す）と出口（依存先の例外を包み直す・token の最終検査）
// ---------------------------------------------------------------------------
describe("entry: only plain data is accepted, and each value is taken exactly once", () => {
  const rejectsInput = async (bad: unknown, extra: Partial<ReturnType<typeof setup>["deps"]> = {}) => {
    const s = setup();
    await expect(writer.createInvoice(bad as never, { ...s.deps, ...extra })).rejects.toThrow(/plain data|input must be an object|unknown input field/);
    expect(s.getToken).not.toHaveBeenCalled();
    expect(s.fetchFn).not.toHaveBeenCalled();
    expect(s.audits).toEqual([]);
  };
  it("getter on input.execute is rejected and never invoked", async () => {
    let n = 0;
    const bad = { ...input }; Object.defineProperty(bad, "execute", { enumerable: true, get: () => (n++ === 0 ? false : true) });
    await rejectsInput(bad); expect(n).toBe(0);
  });
  it("getter on companyId / taskId / expectedTotalAmount / logDir is rejected", async () => {
    for (const k of ["companyId", "taskId", "expectedTotalAmount", "logDir"]) {
      const bad: Record<string, unknown> = { ...input, expectedTotalAmount: 1, logDir: "x" };
      Object.defineProperty(bad, k, { enumerable: true, get: () => bad[k] });
      await rejectsInput(bad);
    }
  });
  it("toJSON as an own function property is rejected, never run", async () => {
    let ran = false;
    await rejectsInput({ ...input, toJSON: () => { ran = true; return {}; } }); expect(ran).toBe(false);
  });
  it("Proxy input (traps never run)", async () => {
    let trapped = 0;
    await rejectsInput(new Proxy({ ...input }, { get: () => { trapped++; return undefined; }, ownKeys: () => { trapped++; return []; } })); expect(trapped).toBe(0);
  });
  it("inherited fields (Object.create) are rejected", async () => { await rejectsInput(Object.create({ ...input, execute: true })); });
  it("class instance input is rejected", async () => { class C { companyId = 999; plan = plan; taskId = "t"; } await rejectsInput(new C()); });
  it("Symbol key on input is rejected", async () => { await rejectsInput({ ...input, [Symbol("x")]: 1 }); });
  it("non-enumerable property is rejected", async () => {
    const bad = { ...input }; Object.defineProperty(bad, "execute", { value: true, enumerable: false }); await rejectsInput(bad);
  });
  it("unknown input field is rejected", async () => { await rejectsInput({ ...input, getClient: () => 1 }); });
  it("array / null / string / undefined as input are rejected", async () => { for (const b of [[], null, "x", undefined, 5]) await rejectsInput(b); });
  it("a frozen input is fine (dry-run)", async () => {
    const s = setup(); const r = await writer.createInvoice(Object.freeze({ ...input, plan: Object.freeze(JSON.parse(JSON.stringify(plan))) }), s.deps);
    expect(r.mode).toBe("dry-run");
  });
  it("a null-prototype input and plan are fine", async () => {
    const s = setup(); const p = Object.assign(Object.create(null), JSON.parse(JSON.stringify(plan)));
    const r = await writer.createInvoice(Object.assign(Object.create(null), { ...input, plan: p }), s.deps);
    expect(r.mode).toBe("dry-run");
  });
  it("Symbol / function / BigInt / Date / Map values inside the plan are rejected", async () => {
    for (const v of [Symbol("x"), () => 1, 1n, new Date(), new Map(), new Set(), /x/, NaN, Infinity]) await rejectsInput({ ...input, plan: { ...plan, memo: v } });
  });
  it("sparse array, array subclass, array with extra property inside the plan", async () => {
    class A extends Array {}
    const sparse = JSON.parse(JSON.stringify(plan.lines)); sparse.length = 3;
    await rejectsInput({ ...input, plan: { ...plan, lines: sparse } });
    await rejectsInput({ ...input, plan: { ...plan, lines: A.from(plan.lines) } });
    const extra: any = [...plan.lines]; extra.evil = 1;
    await rejectsInput({ ...input, plan: { ...plan, lines: extra } });
  });
  it("accessor inside an array element", async () => {
    const lines: any[] = [];
    Object.defineProperty(lines, "0", { enumerable: true, get: () => plan.lines[0] });
    await rejectsInput({ ...input, plan: { ...plan, lines } });
  });
  it("deeply nested / circular plan is rejected", async () => {
    let deep: any = {}; const root = deep; for (let i = 0; i < 20; i++) { deep.a = {}; deep = deep.a; }
    await rejectsInput({ ...input, plan: root });
    const c: any = { ...plan }; c.self = c; await rejectsInput({ ...input, plan: c });
  });
  it("an own __proto__ key in the plan is refused by the validator", async () => {
    const s = setup();
    await expect(writer.createInvoice({ ...input, plan: JSON.parse('{"__proto__":{"x":1},' + JSON.stringify(plan).slice(1)) }, s.deps)).rejects.toThrow();
    expect(s.fetchFn).not.toHaveBeenCalled();
  });
  it("mutating the input / plan after the call started changes nothing (execute, companyId, expectedTotalAmount, plan)", async () => {
    const inp: any = { companyId: 999, plan: JSON.parse(JSON.stringify(plan)), taskId: "t-1", execute: true, expectedTotalAmount: 22000 };
    const s = setup([postOk, () => getOk()]);
    let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    const pending = writer.createInvoice(inp, { ...s.deps, getToken: async () => { await gate; return "tok-1"; } });
    inp.execute = false; inp.companyId = 1; inp.expectedTotalAmount = 1; inp.plan.partner_id = 5; inp.taskId = "evil";
    release();
    const r = await pending;
    expect(r.mode).toBe("execute");
    expect(JSON.parse(s.calls[0]!.body!)).toMatchObject({ company_id: 999, partner_id: 123 });
    expect(s.audits[0]!.task_id).toBe("t-1");
  });
  it("deps functions are taken once (a getter-based deps object cannot swap them mid-call)", async () => {
    const s = setup([postOk, () => getOk()]);
    let reads = 0;
    const deps: any = { fetchFn: s.fetchFn, appendAudit: s.deps.appendAudit, now: s.deps.now };
    Object.defineProperty(deps, "getToken", { enumerable: true, get: () => { reads++; return async () => "tok-1"; } });
    await writer.createInvoice({ ...input, execute: true }, deps);
    expect(reads).toBe(1);
  });
  it("deps with a non-function getToken / fetchFn / appendAudit / now are rejected before anything", async () => {
    const s = setup();
    for (const k of ["getToken", "fetchFn", "appendAudit", "now"]) {
      await expect(writer.createInvoice({ ...input, execute: true }, { ...s.deps, [k]: "x" } as never)).rejects.toThrow(new RegExp(k));
    }
    await expect(writer.createInvoice({ ...input }, null as never)).rejects.toThrow(/deps/);
    expect(s.fetchFn).not.toHaveBeenCalled();
  });
  it("readBackInvoice: getter / Proxy / unknown field / mutation during the token wait", async () => {
    const s = setup();
    const auth = { getToken: s.getToken, fetchFn: s.fetchFn };
    const g: any = { companyId: 1 }; let n = 0; Object.defineProperty(g, "id", { enumerable: true, get: () => (n++, 1) });
    await expect(writer.readBackInvoice(g, auth)).rejects.toThrow(/plain data/); expect(n).toBe(0);
    await expect(writer.readBackInvoice(new Proxy({ companyId: 1, id: 1 }, {}), auth)).rejects.toThrow(/plain data/);
    await expect(writer.readBackInvoice({ companyId: 1, id: 1, extra: 1 } as never, auth)).rejects.toThrow(/unknown input/);
    expect(s.fetchFn).not.toHaveBeenCalled();
    const s2 = setup([() => getOk()]);
    const inp = { companyId: 999, id: 555 };
    let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    const p = writer.readBackInvoice(inp, { getToken: async () => { await gate; return "tok-1"; }, fetchFn: s2.fetchFn });
    inp.id = 1; inp.companyId = 2; release();
    expect((await p).id).toBe(555);
    expect(s2.calls[0]!.url).toContain("/invoices/555?company_id=999");
  });
});

describe("exit: dependency failures are re-wrapped into fixed classifications; a token never leaves", () => {
  const SECRET2 = "SECRET-TOKEN-abc123"; // 取得した token と同じ値を返す getToken を使う
  const withSecret = (s: ReturnType<typeof setup>) => ({ ...s.deps, getToken: async () => SECRET2 });
  const forgedApi = () => new writer.FreeeApiError({ status: 418, path: `/x?t=${SECRET2}`, bodySnippet: SECRET2 });
  const forgedWriter = () => Object.assign(new writer.WriterError("http-failed", { status: 599, path: "/invoices" }), { cause: new Error(SECRET2), message: SECRET2 });

  it("fetchFn throws a caller-built FreeeApiError -> NOT trusted as http-failed (unknown POST)", async () => {
    const s = setup([() => { throw forgedApi(); }]);
    const e = await writer.createInvoice({ ...input, execute: true }, withSecret(s)).catch((x) => x);
    expect(e).toBeInstanceOf(writer.InvoiceCreatedButUnverifiedError);
    expect(e.postState).toBe("unknown");
    expect(leaks(e)).toBe(false);
    expect(e.reason).toBe("request_failed:/invoices");
  });
  it("fetchFn throws a caller-built WriterError / InvoiceCreatedButUnverifiedError / AuditWriteError", async () => {
    for (const make of [forgedWriter, () => new writer.InvoiceCreatedButUnverifiedError(1, SECRET2, "succeeded"), () => new writer.AuditWriteError("created", 1, SECRET2, "succeeded")]) {
      const s = setup([() => { throw make(); }]);
      const e = await writer.createInvoice({ ...input, execute: true }, withSecret(s)).catch((x) => x);
      expect(e).toBeInstanceOf(writer.InvoiceCreatedButUnverifiedError);
      expect(e.createdId).toBeUndefined(); // 呼び手が与えた createdId は信用しない
      expect(leaks(e)).toBe(false);
    }
  });
  it("fetchFn returns a non-Response -> unverified even if the fake looks valid", async () => {
    const fake = (() => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ invoice: { id: 555, invoice_number: "INV-1", total_amount: 22000, partner_id: 123, billing_date: "2026-09-05" } }) })) as never;
    const s = setup([fake, fake]);
    const e = await writer.createInvoice({ ...input, execute: true }, withSecret(s)).catch((x) => x);
    expect(e).toBeInstanceOf(writer.InvoiceCreatedButUnverifiedError);
  });
  it("fetchFn throws on the read-back GET after a 2xx POST -> succeeded state with createdId", async () => {
    const s = setup([postOk, () => { throw forgedApi(); }]);
    const e = await writer.createInvoice({ ...input, execute: true }, withSecret(s)).catch((x) => x);
    expect(e).toMatchObject({ postState: "succeeded", createdId: 555 });
    expect(leaks(e)).toBe(false);
  });
  it("readBack: fetchFn forged FreeeApiError -> request-failed (status/path not copied)", async () => {
    const s = setup([() => { throw forgedApi(); }]);
    const e = await writer.readBackInvoice({ companyId: 1, id: 1 }, { getToken: async () => SECRET2, fetchFn: s.fetchFn }).catch((x) => x);
    expect(e).toMatchObject({ code: "request-failed" });
    expect(e.status).toBeUndefined(); expect(e.path).toBeUndefined();
    expect(leaks(e)).toBe(false);
  });
  it("a real HTTP error carries only the real status and a fixed path", async () => {
    const s = setup([() => new Response(SECRET2, { status: 418 })]);
    const e = await writer.createInvoice({ ...input, execute: true }, withSecret(s)).catch((x) => x);
    expect(e).toMatchObject({ code: "http-failed", status: 418, path: "/invoices" });
    expect(Object.keys(e).sort()).toEqual(["code", "name", "path", "status"]);
    expect(e.cause).toBeUndefined();
  });
  it("WriterError normalizes forged codes / paths / statuses", () => {
    const e = new writer.WriterError("x" as never, { status: 99999, path: `/leak/${SECRET2}` });
    expect(e.code).toBe("request-failed"); expect(e.status).toBeUndefined(); expect(e.path).toBeUndefined();
    expect(e.message).not.toContain(SECRET2);
  });
  it("now() throws a WriterError carrying a cause -> clock-failed, no cause, nothing sent", async () => {
    const s = setup();
    const e = await writer.createInvoice({ ...input, execute: true }, { ...withSecret(s), now: () => { throw forgedWriter(); } }).catch((x) => x);
    expect(e).toMatchObject({ code: "clock-failed" });
    expect(e.cause).toBeUndefined(); expect(leaks(e)).toBe(false);
    expect(s.fetchFn).not.toHaveBeenCalled();
  });
  it("now() returns an invalid value -> clock-failed (not a TypeError with details)", async () => {
    for (const bad of [new Date(NaN), "2026-01-01", 5, null]) {
      const s = setup();
      const e = await writer.createInvoice({ ...input }, { ...s.deps, now: () => bad as never }).catch((x) => x);
      expect(e).toMatchObject({ code: "clock-failed" });
    }
  });
  it("review repro: the clock fails after the POST -> state and createdId survive", async () => {
    const s = setup([postOk, () => new Response("{}", { status: 500 }), () => new Response("{}", { status: 500 }), () => new Response("{}", { status: 500 }), () => new Response("{}", { status: 500 })]);
    let n = 0;
    const e = await writer.createInvoice({ ...input, execute: true }, { ...s.deps, now: () => { if (n++ === 0) return new Date("2026-09-05T13:00:00Z"); throw new Error(SECRET); } }).catch((x) => x);
    expect(e).toBeInstanceOf(writer.InvoiceCreatedButUnverifiedError);
    expect(e).toMatchObject({ postState: "succeeded", createdId: 555 });
    expect(leaks(e)).toBe(false);
  });
  it("review repro: the clock fails after a successful POST+read-back -> still a success", async () => {
    const s = setup([postOk, () => getOk()]);
    let n = 0;
    const r = await writer.createInvoice({ ...input, execute: true }, { ...s.deps, now: () => { if (n++ === 0) return new Date("2026-09-05T13:00:00Z"); throw new Error("x"); } });
    expect(r.created?.id).toBe(555);
    expect(s.audits[0]!.timestamp).toBe("2026-09-05T13:00:00.000Z");
  });
  it("appendAudit throws a caller-built FreeeApiError / WriterError -> audit-failed (dry-run)", async () => {
    for (const make of [forgedApi, forgedWriter]) {
      const s = setup();
      const e = await writer.createInvoice(input, { ...withSecret(s), appendAudit: async () => { throw make(); } }).catch((x) => x);
      expect(e).toMatchObject({ code: "audit-failed" });
      expect(e.cause).toBeUndefined(); expect(leaks(e)).toBe(false);
    }
  });
  it("appendAudit throws after the POST -> AuditWriteError with fixed text and the real state", async () => {
    const s = setup([postOk, () => getOk()]);
    const e = await writer.createInvoice({ ...input, execute: true }, { ...withSecret(s), appendAudit: async () => { throw forgedApi(); } }).catch((x) => x);
    expect(e).toBeInstanceOf(writer.AuditWriteError);
    expect(e).toMatchObject({ postState: "succeeded", createdId: 555 });
    expect(leaks(e)).toBe(false);
  });
  it("getToken throws a caller-built WriterError / FreeeApiError -> token-unavailable with a fixed message", async () => {
    for (const make of [forgedWriter, forgedApi]) {
      const s = setup();
      const e = await writer.createInvoice({ ...input, execute: true }, { ...s.deps, getToken: async () => { throw make(); } }).catch((x) => x);
      expect(e).toMatchObject({ code: "token-unavailable" });
      expect(e.message).toBe("freee-cli writer: token-unavailable");
      expect(e.cause).toBeUndefined();
    }
  });
  it("last check: an invoice_number echoing the token in the response -> the result is not returned", async () => {
    const s = setup([postOk, () => getOk({ invoice_number: `INV-${SECRET2}` })]);
    const e = await writer.createInvoice({ ...input, execute: true }, withSecret(s)).catch((x) => x);
    expect(e).toBeInstanceOf(writer.InvoiceCreatedButUnverifiedError);
    expect(e).toMatchObject({ createdId: 555, postState: "succeeded" });
    expect(leaks(e)).toBe(false);
  });
  it("last check: readBackInvoice does not return a token-bearing field", async () => {
    const s = setup([() => getOk({ invoice_number: `INV-${SECRET2}` })]);
    const e = await writer.readBackInvoice({ companyId: 1, id: 555 }, { getToken: async () => SECRET2, fetchFn: s.fetchFn }).catch((x) => x);
    expect(e).toMatchObject({ code: "invalid-response" });
    expect(leaks(e)).toBe(false);
  });
  it("last check: an audit entry containing the token is not written", async () => {
    const s = setup([postOk, () => getOk()]);
    const p = { ...plan, memo: `note ${SECRET2}` };
    const e = await writer.createInvoice({ ...input, plan: p, execute: true }, withSecret(s)).catch((x) => x);
    expect(e).toBeInstanceOf(writer.AuditWriteError);
    expect(s.audits).toEqual([]);
    expect(leaks(e)).toBe(false);
  });
  it("last check: JSON-escaped forms of the token are also caught", async () => {
    const tok = 'SECRET"quote\\slash-1234';
    const s = setup([postOk, () => getOk({ invoice_number: tok })]);
    const e = await writer.createInvoice({ ...input, execute: true }, { ...s.deps, getToken: async () => tok }).catch((x) => x);
    expect(e).toBeInstanceOf(writer.InvoiceCreatedButUnverifiedError);
  });
  it("a short token is not checked (avoids false positives); a long one is", async () => {
    const s = setup([postOk, () => getOk({ invoice_number: "tok-1" })]);
    const r = await writer.createInvoice({ ...input, execute: true }, s.deps);
    expect(r.created?.invoice_number).toBe("tok-1");
  });
  it("plan validation errors contain no token and keep their type", async () => {
    const s = setup();
    const e = await writer.createInvoice({ ...input, plan: { ...plan, bad_key: SECRET2 }, execute: true }, withSecret(s)).catch((x) => x);
    expect(e.name).toBe("InvoicePlanError");
    expect(s.getToken).not.toHaveBeenCalled();
  });
  it("a thrown non-Error value (string / object / null) from every dependency is contained", async () => {
    for (const thrown of ["Bearer " + SECRET2, { message: SECRET2 }, null, undefined]) {
      const s = setup([() => { throw thrown; }]);
      const e = await writer.createInvoice({ ...input, execute: true }, withSecret(s)).catch((x) => x);
      expect(e).toBeInstanceOf(writer.InvoiceCreatedButUnverifiedError);
      expect(leaks(e)).toBe(false);
      const s2 = setup();
      const e2 = await writer.createInvoice({ ...input, execute: true }, { ...s2.deps, getToken: async () => { throw thrown; } }).catch((x) => x);
      expect(e2).toMatchObject({ code: "token-unavailable" });
    }
  });
});
