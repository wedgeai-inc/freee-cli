import { describe, expect, it, vi } from "vitest";
import { runInvoicesGet, formatInvoiceDetail } from "../../src/commands/invoices/get.js";
import { runInvoicesList, formatInvoicesList } from "../../src/commands/invoices/list.js";
import { runInvoicesTemplates } from "../../src/commands/invoices/templates.js";
import { createInvoiceClient } from "../../src/lib/clients/freee-invoice-client.js";
import { createProgram } from "../../src/cli.js";

function jsonRes(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function invoice(id: number) {
  return {
    id,
    company_id: 1,
    invoice_number: `INV-${id}`,
    subject: "Consulting",
    billing_date: "2026-09-01",
    partner_id: 10,
    partner_name: "Example Co.",
    total_amount: 11000,
    amount_excluding_tax: 10000,
    amount_tax: 1000,
    sending_status: "unsent" as const,
    payment_status: "unsettled" as const,
    deal_status: "unregistered" as const,
    cancel_status: "uncanceled" as const,
  };
}

describe("invoice read commands", () => {
  it("registers list, get, and templates as invoices subcommands", () => {
    const invoices = createProgram().commands.find((command) => command.name() === "invoices");

    expect(invoices?.commands.map((command) => command.name())).toEqual(["list", "get", "templates", "create", "cancel", "update", "uncancel"]);
    expect(invoices?.commands.find((command) => command.name() === "list")?.options.map((option) => option.long)).toContain("--company-id");
    expect(invoices?.commands.find((command) => command.name() === "get")?.options.map((option) => option.long)).toContain("--id");
  });

  it("lists all invoice pages with the API maximum limit", async () => {
    const page1 = Array.from({ length: 100 }, (_, index) => invoice(index + 1));
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/iv/invoices");
      expect(parsed.searchParams.get("limit")).toBe("100");
      return jsonRes({ invoices: parsed.searchParams.get("offset") === "0" ? page1 : [invoice(101)] });
    });
    const client = createInvoiceClient({ token: "t", fetchFn: fetchMock });

    const result = await runInvoicesList({ companyId: 1 }, { client });

    expect(result.items).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("offset=100");
  });

  it("includes only supplied filters in the list query and formats table rows with web URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ invoices: [invoice(1)] }));
    const client = createInvoiceClient({ token: "t", fetchFn: fetchMock });

    const result = await runInvoicesList(
      {
        companyId: 1,
        startBillingDate: "2026-09-01",
        endBillingDate: "2026-09-30",
        partnerIds: "10,11",
        sendingStatus: "unsent",
        paymentStatus: "unsettled",
      },
      { client },
    );

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("company_id")).toBe("1");
    expect(url.searchParams.get("start_billing_date")).toBe("2026-09-01");
    expect(url.searchParams.get("end_billing_date")).toBe("2026-09-30");
    expect(url.searchParams.get("partner_ids")).toBe("10,11");
    expect(url.searchParams.get("sending_status")).toBe("unsent");
    expect(url.searchParams.get("payment_status")).toBe("unsettled");
    expect(url.searchParams.has("unused")).toBe(false);
    expect(formatInvoicesList(result, "table")).toContain(
      "https://invoice.secure.freee.co.jp/reports/invoices/1",
    );
  });

  it("gets one invoice and returns its web URL", async () => {
    const detail = { ...invoice(123), lines: [] };
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ invoice: detail }));
    const client = createInvoiceClient({ token: "t", fetchFn: fetchMock });

    const result = await runInvoicesGet({ companyId: 1, id: 123 }, { client });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/iv/invoices/123?company_id=1");
    expect(result.webUrl).toBe("https://invoice.secure.freee.co.jp/reports/invoices/123");
    expect(formatInvoiceDetail(result, "table")).toContain(result.webUrl);
  });

  it("returns templates from the templates response key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ templates: [{ id: 1, name: "Standard" }] }));
    const client = createInvoiceClient({ token: "t", fetchFn: fetchMock });

    await expect(runInvoicesTemplates({ companyId: 1 }, { client })).resolves.toEqual({
      items: [{ id: 1, name: "Standard" }],
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/iv/invoices/templates?company_id=1");
  });

  it.each([
    ["invalid billing date", (client: ReturnType<typeof createInvoiceClient>) => runInvoicesList({ companyId: 1, startBillingDate: "2026/09/01" }, { client }), /start-billing-date must be YYYY-MM-DD/],
    ["four partner IDs", (client: ReturnType<typeof createInvoiceClient>) => runInvoicesList({ companyId: 1, partnerIds: "1,2,3,4" }, { client }), /--partner-ids/],
    ["zero invoice ID", (client: ReturnType<typeof createInvoiceClient>) => runInvoicesGet({ companyId: 1, id: 0 }, { client }), /--id must be a positive integer/],
  ])("rejects %s before calling fetch", async (_name, run, message) => {
    const fetchMock = vi.fn();
    const client = createInvoiceClient({ token: "t", fetchFn: fetchMock });
    await expect(run(client)).rejects.toThrow(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("projects list / get / templates onto the declared fields only", async () => {
    const extra = { internal_flag: true, partner_contact_email_to: "a@example.com" };
    const summary = { id: 1, company_id: 9, invoice_number: "N1", subject: "S", billing_date: "2026-09-01", partner_id: 2, total_amount: 1, amount_excluding_tax: 1, amount_tax: 0, sending_status: "unsent", payment_status: "unprocessed", deal_status: "unregistered", cancel_status: "uncanceled", ...extra };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ invoices: [summary] }))
      .mockResolvedValueOnce(jsonRes({ invoice: { ...summary, lines: [{ id: 3, description: "d", quantity: 1, unit_price: "1", tax_rate: 10, amount_excluding_tax: 1, hidden: 1 }], memo: "m", secret: "x" } }))
      .mockResolvedValueOnce(jsonRes({ templates: [{ id: 5, name: "T", layout: "x" }] }));
    const client = createInvoiceClient({ token: "t", fetchFn: fetchMock });
    const list = await runInvoicesList({ companyId: 9 }, { client });
    const got = await runInvoicesGet({ companyId: 9, id: 1 }, { client });
    const tpl = await runInvoicesTemplates({ companyId: 9 }, { client });
    const all = JSON.stringify([list, got, tpl]);
    expect(all).not.toContain("internal_flag");
    expect(all).not.toContain("partner_contact_email_to");
    expect(all).not.toContain("hidden");
    expect(all).not.toContain("secret");
    expect(all).not.toContain("layout");
    expect(list.items[0]?.payment_status).toBe("unprocessed");
    expect(got.invoice.lines).toEqual([{ id: 3, description: "d", quantity: 1, unit_price: "1", tax_rate: 10, amount_excluding_tax: 1 }]);
    expect(tpl.items).toEqual([{ id: 5, name: "T" }]);
  });

  it.each([
    [["invoices", "list", "--company-id", "1", "--start-billing-date", "2026/09/01"], /start-billing-date must be YYYY-MM-DD/],
    [["invoices", "list", "--company-id", "1", "--partner-ids", "1,2,3,4"], /--partner-ids/],
    [["invoices", "get", "--company-id", "1", "--id", "0"], /--id must be a positive integer/],
  ])("CLI rejects invalid input before loading credentials: %j", async (argv, message) => {
    const { createProgram } = await import("../../src/cli.js");
    const saved = process.env.FREEE_ACCESS_TOKEN;
    // 認証ロードへ到達すると env token 空エラーになる。検証が先なら検証メッセージで落ちる
    process.env.FREEE_ACCESS_TOKEN = "";
    try {
      await expect(createProgram().parseAsync(argv, { from: "user" })).rejects.toThrow(message);
    } finally {
      if (saved === undefined) delete process.env.FREEE_ACCESS_TOKEN;
      else process.env.FREEE_ACCESS_TOKEN = saved;
    }
  });

  it.each(["unprocessed", "failed"] as const)("passes payment_status=%s to the query", async (status) => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      expect(new URL(String(url)).searchParams.get("payment_status")).toBe(status);
      return jsonRes({ invoices: [] });
    });
    const client = createInvoiceClient({ token: "t", fetchFn: fetchMock });
    await runInvoicesList({ companyId: 1, paymentStatus: status }, { client });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops before limit + offset exceeds the pagination cap", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
    const fetchMock = vi.fn().mockImplementation(async () => jsonRes({ invoices: full }));
    const client = createInvoiceClient({ token: "t", fetchFn: fetchMock });
    await expect(runInvoicesList({ companyId: 1, maxOffset: 250 }, { client })).rejects.toThrow(/期間を月単位などに絞って/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // offset 0, 100 は取得し、200+100 > 250 で中断
  });
});
