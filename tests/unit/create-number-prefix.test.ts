import { describe, expect, it, vi } from "vitest";
import { createInvoiceClient } from "../../src/lib/clients/freee-invoice-client.js";
import { runInvoicesCreate } from "../../src/commands/invoices/create.js";
import { runQuotationsCreate } from "../../src/commands/quotations/create.js";

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
    expect(result.created?.[numberKey as "invoice_number"]).toBe("ABC-002");
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

  it("keeps the existing behaviour when --number-prefix is not given (dry-run makes no request)", async () => {
    const f = fakeFreee(resource, ["ABC-001"]);
    const d = deps(f.fetchMock, plan);
    const result = await run({ ...base, execute: false }, d as never);
    expect(result.payload[numberKey]).toBeUndefined();
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(d.getClient).not.toHaveBeenCalled();
  });
});
