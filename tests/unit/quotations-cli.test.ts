import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProgram } from "../../src/cli.js";

const plan = { quotation_date: "2026-09-08", partner_id: 1, partner_title: "御中", tax_entry_method: "out", tax_fraction: "omit", withholding_tax_entry_method: "out", lines: [{ description: "x", quantity: 1, unit_price: "100", tax_rate: 10 }] };
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
async function parse(argv: string[], fetchMock: ReturnType<typeof vi.fn>) {
  const previous = process.env.FREEE_ACCESS_TOKEN;
  process.env.FREEE_ACCESS_TOKEN = "test-token";
  vi.stubGlobal("fetch", fetchMock);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try { return await createProgram().parseAsync(argv, { from: "user" }); }
  finally { log.mockRestore(); vi.unstubAllGlobals(); if (previous === undefined) delete process.env.FREEE_ACCESS_TOKEN; else process.env.FREEE_ACCESS_TOKEN = previous; }
}

describe("quotations CLI entrypoints", () => {
  it("list forwards whitespace-sensitive filters unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ quotations: [] }));
    await parse(["quotations", "list", "--company-id", "1", "--quotation-number", " Q 1 ", "--subject", " subject with spaces ", "--partner-ids", "1,2", "--sales-management-origin"], fetchMock);
    const query = new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams;
    expect(query.get("quotation_number")).toBe(" Q 1 "); expect(query.get("subject")).toBe(" subject with spaces "); expect(query.get("partner_ids")).toBe("1,2"); expect(query.get("sales_management_origin")).toBe("true");
  });
  it("get forwards the validated id through the CLI", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ quotation: { id: 100, company_id: 1, quotation_number: "Q", subject: "", quotation_date: "2026-09-08", partner_id: 1, total_amount: 1, amount_including_tax: 1, amount_excluding_tax: 1, amount_tax: 0, sending_status: "unsent", cancel_status: "uncanceled", report_url: "url", created_at: "2026-09-08 00:00:00", delivery_deadline: "", delivery_location: "", quotation_note: "", memo: "", lines: [] } }));
    await parse(["quotations", "get", "--company-id", "1", "--id", "100"], fetchMock);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/quotations/100?company_id=1");
  });
  it("templates forwards company-id through the CLI", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ templates: [] })); await parse(["quotations", "templates", "--company-id", "1"], fetchMock); expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/quotations/templates?company_id=1");
  });
  it("create preserves task/log values and dry-run never POSTs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quotation-cli-")); const path = join(dir, "plan.json"); writeFileSync(path, JSON.stringify(plan)); const fetchMock = vi.fn();
    const logDir = `${dir}/ log `; await parse(["quotations", "create", "--company-id", "1", "--plan", path, "--task-id", " exact-task ", "--log-dir", logDir], fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();
    const file = readdirSync(logDir).find((name) => name.startsWith("freee-quotation-create-")); expect(file).toBeDefined(); expect(JSON.parse(readFileSync(join(logDir, file!), "utf8")).task_id).toBe(" exact-task ");
  });
  it("cancel preserves task/log/expect values; dry-run and mismatch never PUT", async () => {
    const get = response({ quotation: { id: 1, company_id: 1, quotation_number: " Q 1 ", total_amount: 1, partner_id: 2 } }); const dry = vi.fn().mockResolvedValue(get); const dir = mkdtempSync(join(tmpdir(), "quotation-cancel-cli-"));
    const logDir = `${dir}/ log dir `; await parse(["quotations", "cancel", "--company-id", "1", "--id", "1", "--task-id", " exact-task ", "--log-dir", logDir], dry); expect(dry.mock.calls.map((call) => call[1]?.method)).toEqual(["GET"]); const file = readdirSync(logDir).find((name) => name.startsWith("freee-quotation-cancel-")); expect(file).toBeDefined(); expect(JSON.parse(readFileSync(join(logDir, file!), "utf8")).task_id).toBe(" exact-task ");
    const mismatch = vi.fn().mockResolvedValue(response({ quotation: { id: 1, company_id: 1, quotation_number: " Q 1 ", total_amount: 1, partner_id: 2 } }));
    await expect(parse(["quotations", "cancel", "--company-id", "1", "--id", "1", "--execute", "--expect-quotation-number", "different value"], mismatch)).rejects.toThrow(/quotation_number/); expect(mismatch.mock.calls.map((call) => call[1]?.method)).toEqual(["GET"]);
  });
  it.each(["1e2", " 100 ", "0x64", "0", "2147483648"])("get/cancel reject id %j before authentication", async (id) => {
    const prior = process.env.FREEE_ACCESS_TOKEN; process.env.FREEE_ACCESS_TOKEN = "";
    try { for (const command of ["get", "cancel"]) await expect(createProgram().parseAsync(["quotations", command, "--company-id", "1", "--id", id], { from: "user" })).rejects.toThrow(/--id/); }
    finally { if (prior === undefined) delete process.env.FREEE_ACCESS_TOKEN; else process.env.FREEE_ACCESS_TOKEN = prior; }
  });
  it.each([
    ["list", ["quotations", "list", "--company-id", "invalid"]],
    ["get", ["quotations", "get", "--company-id", "invalid", "--id", "1"]],
    ["templates", ["quotations", "templates", "--company-id", "invalid"]],
    ["create", ["quotations", "create", "--company-id", "invalid", "--plan", "plan.json"]],
    ["cancel", ["quotations", "cancel", "--company-id", "invalid", "--id", "1"]],
  ])("%s rejects invalid company-id before loading authentication", async (_command, argv) => {
    const previous = process.env.FREEE_ACCESS_TOKEN; process.env.FREEE_ACCESS_TOKEN = "";
    try { await expect(createProgram().parseAsync(argv, { from: "user" })).rejects.toThrow('--company-id must be a positive integer (got: "invalid")'); }
    finally { if (previous === undefined) delete process.env.FREEE_ACCESS_TOKEN; else process.env.FREEE_ACCESS_TOKEN = previous; }
  });
});
