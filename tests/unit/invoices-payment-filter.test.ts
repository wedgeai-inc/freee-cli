import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli.js";
import { runInvoicesList, formatInvoicesList, validateInvoicesListOptions } from "../../src/commands/invoices/list.js";
import { createInvoiceClient } from "../../src/lib/clients/freee-invoice-client.js";

vi.mock("../../src/lib/token-config-loader.js", () => ({ loadApiAuth: vi.fn(async () => ({ accessToken: "synthetic" })) }));

const row = (id: number, payment_date: unknown = "2026-10-15", cancel_status: unknown = "uncanceled") => ({
  id, invoice_number: `TEST-${id}`, payment_date, cancel_status,
  payment_status: "unsettled", deal_status: "unregistered",
});
const setup = (pages: unknown[][]) => {
  const fetchFn = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ invoices: pages.shift() ?? [] })));
  return { fetchFn, client: createInvoiceClient({ token: "synthetic", fetchFn }) };
};

describe("invoice payment date filtering", () => {
  it("filters inclusive bounds locally across pages without stopping on an empty matched page", async () => {
    const { client, fetchFn } = setup([
      Array.from({ length: 100 }, (_, i) => row(i + 1, "2026-10-01")),
      [row(101, "2026-10-14"), row(102, "2026-10-15"), row(103, "2026-10-31"), row(104, "2026-11-01")],
    ]);
    const result = await runInvoicesList({ companyId: 1, startPaymentDate: "2026-10-15", endPaymentDate: "2026-10-31" }, { client });
    expect(result.items.map(x => x.id)).toEqual([102, 103]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const query = new URL(String(fetchFn.mock.calls[1]?.[0])).searchParams;
    expect(query.get("offset")).toBe("100");
    expect(query.has("start_payment_date")).toBe(false);
    expect(query.has("end_payment_date")).toBe(false);
  });

  it.each([
    [{ startPaymentDate: "2026-10-15" }, [2, 3]],
    [{ endPaymentDate: "2026-10-15" }, [1, 2]],
    [{ startPaymentDate: "2026-10-15", endPaymentDate: "2026-10-15" }, [2]],
  ])("supports one-sided and same-day bounds: %j", async (opts, ids) => {
    const { client } = setup([[row(1, "2026-10-14"), row(2), row(3, "2026-10-16")]]);
    expect((await runInvoicesList({ companyId: 1, ...opts }, { client })).items.map(x => x.id)).toEqual(ids);
  });

  it("warns for every missing or invalid payment date instead of silently omitting them", async () => {
    const missing = row(1); delete (missing as Partial<typeof missing>).payment_date;
    const { client } = setup([[missing, row(2, null), row(3, ""), row(4, "2026-02-30"), row(5)]]);
    const result = await runInvoicesList({ companyId: 1, startPaymentDate: "2026-10-15" }, { client });
    expect(result.items.map(x => x.id)).toEqual([5]);
    expect(result.warnings).toHaveLength(4);
    for (const id of [1, 2, 3, 4]) expect(result.warnings?.join("\n")).toContain(`id=${id}: payment_date`);
  });

  it("preserves missing dates and canceled invoices by default", async () => {
    const { client } = setup([[row(1, null), row(2, "", "canceled")]]);
    expect((await runInvoicesList({ companyId: 1 }, { client })).items.map(x => x.id)).toEqual([1, 2]);
  });

  it.each(["all", "uncanceled", "canceled"] as const)("handles cancellation explicitly and warns on unknown states with %s", async cancelStatus => {
    const { client } = setup([[row(1), row(2, "2026-10-15", "canceled"), row(3, "2026-09-01", "future"), row(4, "2026-10-15", null)]]);
    const result = await runInvoicesList({ companyId: 1, cancelStatus, startPaymentDate: "2026-10-01" }, { client });
    expect(result.items.map(x => x.id)).toEqual(cancelStatus === "all" ? [1, 2, 4] : cancelStatus === "uncanceled" ? [1] : [2]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings?.join("\n")).toContain("id=3: cancel_status");
    expect(result.warnings?.join("\n")).toContain("id=4: cancel_status");
  });

  it.each([
    { startPaymentDate: "2026/10/01" }, { endPaymentDate: "2026-02-29" },
    { startPaymentDate: "2026-13-01" }, { startPaymentDate: "2026-10-31", endPaymentDate: "2026-10-01" },
    { cancelStatus: "unknown" },
  ])("rejects invalid options before fetching: %j", async opts => {
    const { client, fetchFn } = setup([]);
    await expect(runInvoicesList({ companyId: 1, ...opts } as Parameters<typeof runInvoicesList>[0], { client })).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("accepts leap day", () => {
    expect(() => validateInvoicesListOptions({ companyId: 1, startPaymentDate: "2028-02-29" })).not.toThrow();
  });

  it("keeps the pagination cap based on fetched rows even when no dates match", async () => {
    const { client, fetchFn } = setup(Array.from({ length: 3 }, () => Array.from({ length: 100 }, (_, i) => row(i + 1))));
    await expect(runInvoicesList({ companyId: 1, startPaymentDate: "2027-01-01", maxOffset: 200 }, { client })).rejects.toThrow(/取得済み 200 件/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("finishes below the pagination cap and fails closed at exactly the cap", async () => {
    const full = Array.from({ length: 100 }, (_, i) => row(i + 1));
    const below = setup([full, [row(101)]]);
    expect((await runInvoicesList({ companyId: 1, maxOffset: 200 }, below)).items).toHaveLength(101);
    const exact = setup([full, full]);
    await expect(runInvoicesList({ companyId: 1, maxOffset: 200 }, exact)).rejects.toThrow(/期間を月単位などに絞って/);
    expect(exact.fetchFn).toHaveBeenCalledTimes(2);
  });

  it("appends requested status details while preserving the default table and JSON shape", async () => {
    const { client } = setup([[row(1)]]);
    const result = await runInvoicesList({ companyId: 1 }, { client });
    const originalHeader = "id\tinvoice_number\tbilling_date\tpartner_name\ttotal_amount\tsending_status\tpayment_status\tweb_url";
    expect(formatInvoicesList(result, "table").split("\n")[0]).toBe(originalHeader);
    const detailed = formatInvoicesList(result, "table", true).split("\n");
    expect(detailed[0]).toBe(`${originalHeader}\tpayment_date\tcancel_status\tdeal_status`);
    expect(detailed[1]).toContain("\t2026-10-15\tuncanceled\tunregistered");
    expect(JSON.parse(formatInvoicesList(result, "json", true))).toEqual(result.items);
  });

  it("documents local filtering, cancellation defaults and extra table columns in CLI help", () => {
    const command = createProgram().commands.find(x => x.name() === "invoices")!.commands.find(x => x.name() === "list")!;
    const help = command.helpInformation();
    expect(help).toContain("--start-payment-date");
    expect(help).toContain("--end-payment-date");
    expect(help).toContain("client-side");
    expect(help).toContain("--cancel-status");
    expect(help).toContain("all (default)");
    expect(help).toContain("--with-status-details");
  });
});


describe("invoice payment date CLI wiring", () => {
  it("passes filters and detailed columns through the CLI and emits warnings only to stderr", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ invoices: [row(1), row(2, null), row(3, "2026-10-15", "canceled"), row(4, "2026-10-15", "future")] })));
    vi.stubGlobal("fetch", fetchFn);
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await createProgram().exitOverride().parseAsync(["invoices", "list", "--company-id", "1", "--start-payment-date", "2026-10-15", "--end-payment-date", "2026-10-15", "--cancel-status", "uncanceled", "--with-status-details", "--format", "table"], { from: "user" });
      expect(out).toHaveBeenCalledOnce();
      const text = String(out.mock.calls[0]?.[0]);
      expect(text).toContain("payment_date\tcancel_status\tdeal_status");
      expect(text).toContain("TEST-1");
      expect(text).not.toContain("TEST-2");
      expect(text).not.toContain("TEST-3");
      expect(text).not.toContain("TEST-4");
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.flat().join("\n")).toContain("id=2: payment_date");
      expect(warn.mock.calls.flat().join("\n")).toContain("id=4: cancel_status");
    } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });

  it("rejects invalid date options before loading credentials", async () => {
    const { loadApiAuth } = await import("../../src/lib/token-config-loader.js");
    vi.mocked(loadApiAuth).mockClear();
    await expect(createProgram().exitOverride().parseAsync(["invoices", "list", "--company-id", "1", "--end-payment-date", "2026-02-30"], { from: "user" })).rejects.toThrow(/end-payment-date/);
    expect(loadApiAuth).not.toHaveBeenCalled();
  });
});
