import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli.js";
import * as auth from "../../src/lib/token-config-loader.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInvoiceClient } from "../../src/lib/clients/freee-invoice-client.js";
import { InvoiceCreatedButUnverifiedError, formatInvoiceCreate, runInvoicesCreate } from "../../src/commands/invoices/create.js";
import { QuotationCreatedButUnverifiedError, formatQuotationCreate, runQuotationsCreate } from "../../src/commands/quotations/create.js";

const invoicePlan = {
  billing_date: "2026-10-31",
  partner_id: 10,
  partner_title: "御中",
  tax_entry_method: "out",
  tax_fraction: "omit",
  withholding_tax_entry_method: "out",
  lines: [{ description: "10月分", quantity: 1, unit: "式", unit_price: "100000", tax_rate: 10 }],
};

const quotationPlan = {
  quotation_date: "2026-10-31",
  partner_id: 10,
  partner_title: "御中",
  subject: "見積",
  tax_entry_method: "out",
  tax_fraction: "omit",
  withholding_tax_entry_method: "out",
  lines: [{ description: "作業", quantity: 1, unit: "式", unit_price: "100000", tax_rate: 10 }],
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/** 一覧 GET には既存の番号を返し、POST と読み戻し GET は送られた番号で応える模擬 freee */
function fakeFreee(resource: "invoices" | "quotations", existing: string[]) {
  const numberKey = resource === "invoices" ? "invoice_number" : "quotation_number";
  const single = resource === "invoices" ? "invoice" : "quotation";
  let posted: Record<string, unknown> | undefined;
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname.endsWith(`/${resource}`)) {
      const rows = url.searchParams.get("cancel_status") === "uncanceled"
        ? existing.map((n, i) => ({ id: i + 1, [numberKey]: n, partner_id: 10 }))
        : [];
      return json({ [resource]: rows });
    }
    if (method === "POST") {
      posted = JSON.parse(String(init?.body));
      return json({ [single]: { id: 900 } }, 201);
    }
    return json({
      [single]: {
        ...posted, id: 900, company_id: 1, total_amount: 110000, partner_id: 10,
        billing_date: posted?.billing_date, quotation_date: posted?.quotation_date,
        report_url: "https://example.com/r", cancel_status: "uncanceled",
      },
    });
  });
  return { fetchMock, posted: () => posted };
}

function deps(fetchMock: ReturnType<typeof vi.fn>, plan: Record<string, unknown>) {
  const client = createInvoiceClient({ token: "t", fetchFn: fetchMock as unknown as typeof fetch });
  return { getClient: vi.fn(async () => client), readFile: async () => JSON.stringify(plan), appendAudit: vi.fn(async () => {}), now: () => new Date("2026-10-30T00:00:00Z") };
}

const base = { companyId: 1, planPath: "plan.json", logDir: "./audit-logs", taskId: "t" };

describe.each([
  ["invoices", "invoice_number", invoicePlan, runInvoicesCreate],
  ["quotations", "quotation_number", quotationPlan, runQuotationsCreate],
] as const)("%s create --number-prefix", (resource, numberKey, plan, run) => {
  it.each([
    ["missing date", { partner_id: 10 }, resource === "invoices" ? "invoice plan: billing_date is required (string)" : "quotation plan: quotation_date is required (YYYY-MM-DD)"],
    ["invalid lines", { ...plan, lines: [{ ...plan.lines[0], quantity: 0 }] }, "invoice plan: lines[0].quantity is required (positive number)"],
    ["unknown key", { ...plan, unexpected: true }, `${resource === "invoices" ? "invoice" : "quotation"} plan: unexpected is not allowed`],
    ["both partner identifiers", { ...plan, partner_code: "X1" }, "invoice plan: partner_id and partner_code must not be specified together"],
  ])("rejects %s with the parser error before authentication or requests", async (_name, input, message) => {
    const f = fakeFreee(resource, []);
    const d = deps(f.fetchMock, input);
    const error = await run({ ...base, execute: false, numberPrefix: "ABC" }, d as never).catch(e => e);
    expect.soft(d.getClient).not.toHaveBeenCalled();
    expect.soft(f.fetchMock).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(message);
  });

  it("dry-run shows the next number in the payload without POST", async () => {
    const f = fakeFreee(resource, ["ABC-001", "ABC-002"]);
    const result = await run({ ...base, execute: false, numberPrefix: "ABC" }, deps(f.fetchMock, plan) as never);
    expect(result.payload[numberKey]).toBe("ABC-003");
    expect(f.fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("execute posts the number recomputed right before POST", async () => {
    const f = fakeFreee(resource, ["ABC-001"]);
    const result = await run({ ...base, execute: true, numberPrefix: "ABC" }, deps(f.fetchMock, plan) as never);
    expect(f.posted()?.[numberKey]).toBe("ABC-002");
    expect((result.created as { invoice_number?: string; quotation_number?: string } | undefined)?.[numberKey]).toBe("ABC-002");
  });

  it("rejects a plan that already has a number, before any request", async () => {
    const f = fakeFreee(resource, []);
    const d = deps(f.fetchMock, { ...plan, [numberKey]: "ABC-009" });
    await expect(run({ ...base, execute: false, numberPrefix: "ABC" }, d as never)).rejects.toThrow(/--number-prefix/);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a plan without partner_id, before any request", async () => {
    const f = fakeFreee(resource, []);
    const { partner_id: _drop, ...withoutPartner } = plan;
    const d = deps(f.fetchMock, { ...withoutPartner, partner_code: "X1" });
    await expect(run({ ...base, execute: false, numberPrefix: "ABC" }, d as never)).rejects.toThrow(/partner_id/);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid prefix before any request", async () => {
    const f = fakeFreee(resource, []);
    await expect(run({ ...base, execute: false, numberPrefix: "abc" }, deps(f.fetchMock, plan) as never)).rejects.toThrow(/--prefix|--number-prefix/);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a different read-back number as created but unverified", async () => {
    const f = fakeFreee(resource, ["ABC-001"]);
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const response = await f.fetchMock(input, init);
      if (new URL(String(input)).pathname.endsWith(`/${resource}/900`)) {
        const detail = await response.json() as Record<string, Record<string, unknown>>;
        detail[resource === "invoices" ? "invoice" : "quotation"]![numberKey] = "ABC-999";
        return json(detail);
      }
      return response;
    });
    const d = deps(fetchMock, plan);
    const error = await run({ ...base, execute: true, numberPrefix: "ABC" }, d as never).catch(e => e);
    expect(error).toBeInstanceOf(resource === "invoices" ? InvoiceCreatedButUnverifiedError : QuotationCreatedButUnverifiedError);
    expect(error).toMatchObject({ createdId: 900, postState: "succeeded", reason: `readback_mismatch:${numberKey}` });
    expect(d.appendAudit).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", created_id: 900, reason: `readback_mismatch:${numberKey}` }));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it.each([
    ["abc", { partner_id: 0, [numberKey]: "" }, /--prefix|--number-prefix/],
    ["ABC", null, /plan: plan must be a single JSON object/],
    ["ABC", [], /plan: plan must be a single JSON object/],
    ["ABC", { ...plan, partner_id: 0, [numberKey]: "" }, /partner_id/],
    ["ABC", { ...plan, partner_id: -1 }, /partner_id/],
    ["ABC", { ...plan, partner_id: 1.5 }, /partner_id/],
    ["ABC", { ...plan, partner_id: "10" }, /partner_id/],
    ["ABC", { ...plan, [numberKey]: "" }, /--number-prefix/],
    ["ABC", { ...plan, [numberKey]: null }, new RegExp(`plan: ${numberKey} must be a string`)],
    ["ABC", { ...plan, partner_id: undefined, partner_code: "X1" }, /partner_id/],
  ])("CLI validates prefix %s and plan %j before authentication", async (prefix, input, message) => {
    const dir = mkdtempSync(join(tmpdir(), "create-prefix-"));
    const path = join(dir, "plan.json");
    writeFileSync(path, JSON.stringify(input));
    const loadAuth = vi.spyOn(auth, "loadApiAuth").mockRejectedValue(new Error("authentication must not run"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const program = createProgram().exitOverride().configureOutput({ writeErr: () => {} });
      await expect(program.parseAsync([resource, "create", "--company-id", "1", "--plan", path, "--number-prefix", prefix, "--execute"], { from: "user" })).rejects.toThrow(message);
      expect(loadAuth).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      loadAuth.mockRestore();
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true });
    }
  });

  it("rejects a matching prefix belonging to another partner without POST", async () => {
    const f = fakeFreee(resource, []);
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/${resource}`)) return json({ [resource]: [{ id: 1, [numberKey]: "ABC-001", partner_id: 11 }] });
      return f.fetchMock(input, init);
    });
    await expect(run({ ...base, execute: true, numberPrefix: "ABC" }, deps(fetchMock, plan) as never)).rejects.toThrow(/different partner/);
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    expect(f.posted()).toBeUndefined();
  });

  it("recomputes after a dry-run when another document has been created", async () => {
    const existing = ["ABC-001"];
    const f = fakeFreee(resource, existing);
    const d = deps(f.fetchMock, plan);
    const dryRun = await run({ ...base, execute: false, numberPrefix: "ABC" }, d as never);
    expect(dryRun.payload[numberKey]).toBe("ABC-002");
    existing.push("ABC-002");
    const executed = await run({ ...base, execute: true, numberPrefix: "ABC" }, d as never);
    expect(f.posted()?.[numberKey]).toBe("ABC-003");
    expect(executed.assignedNumber).toEqual({ prefix: "ABC", number: "ABC-003", max: 2, matched_count: 2 });
    const formatted = resource === "invoices" ? formatInvoiceCreate(executed as never) : formatQuotationCreate(executed as never);
    expect(formatted).toContain("number: ABC-003（--number-prefix で自動採番。一致 2 件・最大 2）");
    expect(d.appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({ status: "created", payload_redacted: expect.objectContaining({ [numberKey]: "ABC-003" }) }));
  });

  it("reports an empty sequence with max null", async () => {
    const f = fakeFreee(resource, []);
    const result = await run({ ...base, execute: false, numberPrefix: "ABC" }, deps(f.fetchMock, plan) as never);
    expect(result.assignedNumber).toEqual({ prefix: "ABC", number: "ABC-001", max: null, matched_count: 0 });
    const formatted = resource === "invoices" ? formatInvoiceCreate(result as never) : formatQuotationCreate(result as never);
    expect(formatted).toContain("number: ABC-001（--number-prefix で自動採番。一致 0 件・最大 なし）");
  });

  it("validates an invalid prefix before reading a malformed plan", async () => {
    const f = fakeFreee(resource, []);
    const d = { ...deps(f.fetchMock, plan), readFile: vi.fn(async () => "{broken") };
    await expect(run({ ...base, execute: false, numberPrefix: "abc" }, d as never)).rejects.toThrow(/--prefix|--number-prefix/);
    expect(d.readFile).not.toHaveBeenCalled();
    expect(d.getClient).not.toHaveBeenCalled();
  });

  it("keeps the existing behaviour when --number-prefix is not given (dry-run makes no request)", async () => {
    const f = fakeFreee(resource, ["ABC-001"]);
    const d = deps(f.fetchMock, plan);
    const result = await run({ ...base, execute: false }, d as never);
    expect(result.payload[numberKey]).toBeUndefined();
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(d.getClient).not.toHaveBeenCalled();
  });
});
