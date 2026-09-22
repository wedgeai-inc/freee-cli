import { describe, expect, it, vi } from "vitest";
import { runQuotationsGet, formatQuotationDetail } from "../../src/commands/quotations/get.js";
import { runQuotationsList, formatQuotationsList } from "../../src/commands/quotations/list.js";
import { runQuotationsTemplates } from "../../src/commands/quotations/templates.js";
import { createInvoiceClient } from "../../src/lib/clients/freee-invoice-client.js";
import { toQuotationDetail } from "../../src/types/quotation.js";

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const quotation = (id: number, company_id = 1) => ({ id, company_id, quotation_number: `Q-${id}`, subject: "Consulting", quotation_date: "2026-09-08", partner_id: 10, partner_name: "Example Co.", total_amount: 11000, amount_including_tax: 11000, amount_excluding_tax: 10000, amount_tax: 1000, sending_status: "unsent", cancel_status: "uncanceled", report_url: `https://example.test/r/${id}`, created_at: "2026-09-08 00:00:00", delivery_deadline: "2026-09-30", delivery_location: "Tokyo", quotation_note: "note", memo: "memo", lines: [] });

describe("quotation read commands", () => {
  it("omits sales_management_origin unless explicitly requested", async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ quotations: [] }));
    await runQuotationsList({ companyId: 1 }, { client: createInvoiceClient({ token: "t", fetchFn }) });
    expect(new URL(String(fetchFn.mock.calls[0]?.[0])).searchParams.has("sales_management_origin")).toBe(false);
  });
  it("sends only quotation filters including sales_management_origin and preserves report_url", async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ quotations: [quotation(1)] }));
    const result = await runQuotationsList({ companyId: 1, quotationNumber: "Q 1", subject: "A B", partnerIds: "1,2", sendingStatus: "unsent", cancelStatus: "uncanceled", startQuotationDate: "2026-09-01", endQuotationDate: "2026-09-30", startExpirationDate: "2026-10-01", endExpirationDate: "2026-10-31", salesManagementOrigin: true }, { client: createInvoiceClient({ token: "t", fetchFn }) });
    const url = new URL(String(fetchFn.mock.calls[0]?.[0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ company_id: "1", quotation_number: "Q 1", subject: "A B", partner_ids: "1,2", sales_management_origin: "true" });
    expect(result.items[0]?.report_url).toBe("https://example.test/r/1");
  });

  it("stops before the CLI pagination safety cap", async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ quotations: Array.from({ length: 100 }, (_, i) => quotation(i + 1)) }));
    await expect(runQuotationsList({ companyId: 1, maxOffset: 150 }, { client: createInvoiceClient({ token: "t", fetchFn }) })).rejects.toThrow(/10,000|中断/);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("allows offset + limit exactly 10,000 and stops on the next page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => quotation(index + 1));
    const fetchFn = vi.fn().mockImplementation(() => json({ quotations: fullPage }));
    await expect(runQuotationsList({ companyId: 1 }, { client: createInvoiceClient({ token: "t", fetchFn }) })).rejects.toThrow(/10,000|中断/);
    expect(fetchFn).toHaveBeenCalledTimes(100);
  });

  it.each([2147483647, 1])("gets valid boundary id %i and validates returned id/company", async (id) => {
    const fetchFn = vi.fn().mockResolvedValue(json({ quotation: quotation(id) }));
    const result = await runQuotationsGet({ companyId: 1, id }, { client: createInvoiceClient({ token: "t", fetchFn }) });
    expect(result.quotation.id).toBe(id);
    expect(formatQuotationDetail(result, "table")).toContain(`\t${quotation(id).report_url}`);
  });

  it.each([0, 2147483648])("rejects invalid id %i before fetch", async (id) => {
    const fetchFn = vi.fn();
    await expect(runQuotationsGet({ companyId: 1, id }, { client: createInvoiceClient({ token: "t", fetchFn }) })).rejects.toThrow(/2147483647/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects get response identity mismatch and returns templates", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ quotation: quotation(2) })).mockResolvedValueOnce(json({ templates: [{ id: 1, name: "Standard" }] }));
    const client = createInvoiceClient({ token: "t", fetchFn });
    await expect(runQuotationsGet({ companyId: 1, id: 1 }, { client })).rejects.toThrow(/mismatch:id/);
    await expect(runQuotationsTemplates({ companyId: 1 }, { client })).resolves.toEqual({ items: [{ id: 1, name: "Standard" }] });
  });
  it("fails closed for missing wrappers and numeric identity fields", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({ quotation: { ...quotation(1), id: "1" } }));
    const client = createInvoiceClient({ token: "t", fetchFn });
    await expect(runQuotationsList({ companyId: 1 }, { client })).rejects.toThrow(/missing quotations/);
    await expect(runQuotationsTemplates({ companyId: 1 }, { client })).rejects.toThrow(/missing templates/);
    await expect(runQuotationsGet({ companyId: 1, id: 1 }, { client })).rejects.toThrow(/id must be a positive safe integer/);
  });
  it("projects known quotation detail fields and omits unknown line fields", async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ quotation: { ...quotation(1), expiration_date: "2026-10-08", delivery_deadline: "2026-10-31", delivery_location: "Tokyo", quotation_note: "note", memo: "memo", template_id: 2, tax_entry_method: "out", tax_fraction: "omit", lines: [{ id: 1, type: "item", description: "x", withholding: false, quantity: 1, unknown: "hidden" }] } }));
    const result = await runQuotationsGet({ companyId: 1, id: 1 }, { client: createInvoiceClient({ token: "t", fetchFn }) });
    expect(result.quotation).toMatchObject({ expiration_date: "2026-10-08", delivery_deadline: "2026-10-31", delivery_location: "Tokyo", quotation_note: "note", memo: "memo", template_id: 2, tax_entry_method: "out", tax_fraction: "omit", lines: [{ description: "x", quantity: 1 }] });
    expect(result.quotation.lines[0]).not.toHaveProperty("unknown");
  });
  it.each([
    ["missing required string", { ...quotation(1), quotation_number: undefined }, /quotation_number/],
    ["wrong required string type", { ...quotation(1), subject: 1 }, /subject/],
    ["invalid sending enum", { ...quotation(1), sending_status: "queued" }, /sending_status/],
    ["invalid cancel enum", { ...quotation(1), cancel_status: "pending" }, /cancel_status/],
    ["negative id", { ...quotation(-1) }, /id.*positive safe integer/],
    ["fractional id", { ...quotation(1), id: 1.5 }, /id.*positive safe integer/],
    ["non-array lines", { ...quotation(1), lines: {} }, /lines.*array/],
    ["non-object line", { ...quotation(1), lines: ["line"] }, /lines\[0\].*object/],
    ["string amount", { ...quotation(1), amount_excluding_tax: "10000" }, /amount_excluding_tax.*finite number/],
  ])("rejects %s instead of coercing the quotation response", async (_name, raw, message) => {
    const client = createInvoiceClient({ token: "t", fetchFn: vi.fn().mockResolvedValue(json({ quotation: raw })) });
    await expect(runQuotationsGet({ companyId: 1, id: 1 }, { client })).rejects.toThrow(message);
  });
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("rejects %s amounts (fetch 経由では JSON が null へ潰すため変換関数を直接呼ぶ)", (_name, value) => {
    expect(() => toQuotationDetail({ ...quotation(1), total_amount: value })).toThrow(/total_amount.*finite number/);
    expect(() => toQuotationDetail({ ...quotation(1), lines: [{ id: 1, type: "item", description: "x", withholding: false, quantity: value, unit_price: "1", tax_rate: 10 }] })).toThrow(/lines\[0\]\.quantity.*finite number/);
  });

  it("accepts nullable detail fields and text-line null amounts", () => {
    const detail = toQuotationDetail({ ...quotation(1), expiration_date: null, tax_entry_method: null, tax_fraction: null, line_amount_fraction: null, withholding_tax_entry_method: null, branch_no: null, partner_code: null, amount_withholding_tax: null, amount_including_tax_10: null, lines: [{ id: 1, type: "text", description: "note", withholding: false, quantity: null, unit_price: null, tax_rate: null, amount_excluding_tax: null }] });
    expect(detail).toMatchObject({ expiration_date: null, tax_entry_method: null, tax_fraction: null, line_amount_fraction: null, withholding_tax_entry_method: null, branch_no: null, partner_code: null, amount_withholding_tax: null, amount_including_tax_10: null, lines: [{ id: 1, type: "text", description: "note", withholding: false, quantity: null, unit_price: null, tax_rate: null, amount_excluding_tax: null }] });
  });
  it.each(["id", "type", "description", "withholding"] as const)("rejects a line missing required %s", (key) => {
    const line: Record<string, unknown> = { id: 1, type: "item", description: "x", withholding: false }; delete line[key];
    expect(() => toQuotationDetail({ ...quotation(1), lines: [line] })).toThrow(new RegExp(`lines\\[0\\]\\.${key}`));
  });
  it("rejects an empty line and tax rates outside the response enum", () => {
    expect(() => toQuotationDetail({ ...quotation(1), lines: [{}] })).toThrow(/lines\[0\]\.id/);
    expect(() => toQuotationDetail({ ...quotation(1), lines: [{ id: 1, type: "item", description: "x", withholding: false, tax_rate: 5 }] })).toThrow(/lines\[0\]\.tax_rate/);
  });

  it("rejects malformed summaries and templates instead of returning coerced values", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ quotations: [{ ...quotation(1), partner_id: -1 }] })).mockResolvedValueOnce(json({ templates: [{ id: 1, name: 1 }] }));
    const client = createInvoiceClient({ token: "t", fetchFn });
    await expect(runQuotationsList({ companyId: 1 }, { client })).rejects.toThrow(/partner_id.*positive safe integer/);
    await expect(runQuotationsTemplates({ companyId: 1 }, { client })).rejects.toThrow(/template.name/);
  });
});
