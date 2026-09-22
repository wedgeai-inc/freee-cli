import { describe, expect, it, vi } from "vitest";
import { createInvoiceClient } from "../../src/lib/clients/freee-invoice-client.js";
import {
  InvoiceCancelGuardError,
  InvoiceCancelUnverifiedError,
  ResponseParseError,
  AuditWriteError,
  formatInvoiceCancel,
  runInvoicesCancel,
  type InvoiceCancelAuditEntry,
} from "../../src/commands/invoices/cancel.js";
import { validateInvoiceMutationId } from "../../src/commands/invoices/id.js";
import { FreeeApiError } from "../../src/lib/clients/freee-public-client.js";
import { appendInvoiceCancelAudit } from "../../src/lib/audit/invoice-audit.js";
import { createProgram } from "../../src/cli.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const opts = {
  companyId: 999,
  id: 777,
  execute: false,
  logDir: "./audit-logs",
  taskId: "invoice-cancel-test",
  allowDealDeletion: false,
};

const validReadInvoice: Record<string, unknown> = {
  id: 777,
  company_id: 999,
  invoice_number: "INV-777",
  deal_status: "unregistered",
  total_amount: 1,
  partner_id: 2,
};

const readFieldDefinitions = [
  { field: "id", invalidValues: [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "777", true, null, {}, []] },
  { field: "company_id", invalidValues: [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "999", true, null, {}, []] },
  { field: "invoice_number", invalidValues: [777, true, null, {}, []] },
  { field: "deal_status", invalidValues: ["other", 777, true, null, {}, []] },
  { field: "total_amount", invalidValues: ["1", true, null, {}, []] },
  { field: "partner_id", invalidValues: [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "2", true, null, {}, []] },
] as const;

const rejectedPutStatuses = new Set([400, 401, 403, 404]);
const putStatusCases: Array<{ status: number; putState: "rejected" | "unknown" }> = [];
for (let status = 100; status < 600; status += 1) {
  if (status >= 200 && status < 300) continue;
  putStatusCases.push({ status, putState: rejectedPutStatuses.has(status) ? "rejected" : "unknown" });
}

async function readTargetError(invoice: Record<string, unknown>): Promise<unknown> {
  return runInvoicesCancel(opts, {
    getClient: async () => ({
      get: async () => ({ json: async () => ({ invoice }) }),
    }) as never,
    appendAudit: async () => {},
    now: () => new Date(),
  }).catch((error) => error);
}

async function parseCancelCli(argv: string[], fetchMock: ReturnType<typeof vi.fn>): Promise<unknown> {
  const savedToken = process.env.FREEE_ACCESS_TOKEN;
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", fetchMock);
  process.env.FREEE_ACCESS_TOKEN = "test-token";
  try {
    return await createProgram().parseAsync(argv, { from: "user" }).catch((error) => error);
  } finally {
    vi.unstubAllGlobals();
    logSpy.mockRestore();
    if (savedToken === undefined) delete process.env.FREEE_ACCESS_TOKEN;
    else process.env.FREEE_ACCESS_TOKEN = savedToken;
  }
}

describe("runInvoicesCancel", () => {
  it("dry-run reads and displays the target, without PUT, then records planned", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      invoice: { id: 777, company_id: 999, invoice_number: "INV-777", deal_status: "registered", total_amount: 12345, partner_id: 456 },
    }), { status: 200 }));
    const audits: InvoiceCancelAuditEntry[] = [];
    const result = await runInvoicesCancel(opts, {
      getClient: async () => createInvoiceClient({ token: "t", fetchFn: fetchMock as unknown as typeof fetch }),
      appendAudit: async (entry) => { audits.push(entry); },
      now: () => new Date("2026-09-07T00:00:00Z"),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(result.target).toEqual({ invoice_number: "INV-777", total_amount: 12345, partner_id: 456, deal_status: "registered" });
    expect(audits).toEqual([{
      timestamp: "2026-09-07T00:00:00.000Z",
      task_id: "invoice-cancel-test",
      event: "invoice_cancel",
      mode: "dry-run",
      status: "planned",
      company_id: 999,
      invoice_id: 777,
      put_state: "not_attempted",
    }]);
    expect(formatInvoiceCancel(result)).toContain("INV-777");
    expect(formatInvoiceCancel(result)).toContain("12345");
    expect(formatInvoiceCancel(result)).toContain("registered");
  });

  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1])("rejects invalid invoice ID %s before authentication", async (id) => {
    const getClient = vi.fn();
    await expect(runInvoicesCancel({ ...opts, id }, { getClient, appendAudit: async () => {}, now: () => new Date() })).rejects.toThrow("--id must be an integer between 1 and 2147483647");
    expect(getClient).not.toHaveBeenCalled();
    expect(() => validateInvoiceMutationId(id)).toThrow();
  });

  it("requires the expected invoice number before GET in execute mode", async () => {
    const getClient = vi.fn();
    const err = await runInvoicesCancel({ ...opts, execute: true }, { getClient, appendAudit: async () => {}, now: () => new Date() }).catch((e) => e);
    expect(err).toBeInstanceOf(InvoiceCancelGuardError);
    expect((err as InvoiceCancelGuardError).reason).toBe("mismatch:invoice_number");
    expect(getClient).not.toHaveBeenCalled();
  });

  it("records a client-unavailable read failure before GET", async () => {
    const audits: InvoiceCancelAuditEntry[] = [];
    const error = await runInvoicesCancel(opts, {
      getClient: async () => { throw new Error("client unavailable"); },
      appendAudit: async (entry) => { audits.push(entry); },
      now: () => new Date("2026-09-07T03:04:05Z"),
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(audits).toEqual([{
      timestamp: "2026-09-07T03:04:05.000Z",
      task_id: "invoice-cancel-test",
      event: "invoice_cancel",
      mode: "dry-run",
      status: "failed",
      company_id: 999,
      invoice_id: 777,
      reason: "client_unavailable",
      put_state: "not_attempted",
    }]);
  });

  it.each([
    ["HTTP 500", vi.fn().mockResolvedValueOnce(new Response("server error", { status: 500 })), "readback_http:500"],
    ["network failure", vi.fn().mockRejectedValueOnce(new TypeError("network")), "readback_network"],
  ])("records a %s read failure before PUT", async (_name, fetchMock, reason) => {
    const audits: InvoiceCancelAuditEntry[] = [];
    const error = await runInvoicesCancel(opts, {
      getClient: async () => createInvoiceClient({ token: "t", fetchFn: fetchMock as unknown as typeof fetch }),
      appendAudit: async (entry) => { audits.push(entry); },
      now: () => new Date("2026-09-07T04:05:06Z"),
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(audits).toEqual([{
      timestamp: "2026-09-07T04:05:06.000Z",
      task_id: "invoice-cancel-test",
      event: "invoice_cancel",
      mode: "dry-run",
      status: "failed",
      company_id: 999,
      invoice_id: 777,
      reason,
      put_state: "not_attempted",
    }]);
  });

  it("guards company, invoice number, and registered deals before PUT", async () => {
    const scenarios = [
      [{ id: 777, company_id: 1000, invoice_number: "INV-777", deal_status: "unregistered", total_amount: 1, partner_id: 2 }, "INV-777", "mismatch:company_id"],
      [{ id: 777, company_id: 999, invoice_number: "OTHER", deal_status: "unregistered", total_amount: 1, partner_id: 2 }, "INV-777", "mismatch:invoice_number"],
      [{ id: 777, company_id: 999, invoice_number: "INV-777", deal_status: "registered", total_amount: 1, partner_id: 2 }, "INV-777", "deal_registered"],
    ] as const;
    for (const [invoice, expectInvoiceNumber, reason] of scenarios) {
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ invoice }), { status: 200 }));
      const audits: InvoiceCancelAuditEntry[] = [];
      const err = await runInvoicesCancel({ ...opts, execute: true, expectInvoiceNumber }, {
        getClient: async () => createInvoiceClient({ token: "t", fetchFn: fetchMock as unknown as typeof fetch }),
        appendAudit: async (entry) => { audits.push(entry); }, now: () => new Date(),
      }).catch((e) => e);
      expect(err).toBeInstanceOf(InvoiceCancelGuardError);
      expect((err as InvoiceCancelGuardError).reason).toBe(reason);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(audits).toMatchObject([{ status: "failed", reason, put_state: "not_attempted" }]);
    }
  });

  it("checks an optional expected invoice number in dry-run", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ invoice: validReadInvoice }), { status: 200 }));
    const audits: InvoiceCancelAuditEntry[] = [];
    const error = await runInvoicesCancel({ ...opts, expectInvoiceNumber: "OTHER" }, {
      getClient: async () => createInvoiceClient({ token: "t", fetchFn: fetchMock as unknown as typeof fetch }),
      appendAudit: async (entry) => { audits.push(entry); }, now: () => new Date(),
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(InvoiceCancelGuardError);
    expect((error as InvoiceCancelGuardError).reason).toBe("mismatch:invoice_number");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(audits).toMatchObject([{ status: "failed", reason: "mismatch:invoice_number", put_state: "not_attempted" }]);
  });

  it.each([
    "inv-0000000002", " INV-0000000002", "INV-0000000002 ", "ＩＮＶ-０００００００００２", "",
    "INV-000000000", "INV-00000000021",
  ])("rejects non-exact invoice number %j", async (expectInvoiceNumber) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { ...validReadInvoice, invoice_number: "INV-0000000002" } }), { status: 200 }));
    const error = await runInvoicesCancel({ ...opts, execute: true, expectInvoiceNumber }, {
      getClient: async () => createInvoiceClient({ token: "t", fetchFn: fetchMock as unknown as typeof fetch }),
      appendAudit: async () => {}, now: () => new Date(),
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(InvoiceCancelGuardError);
    expect((error as InvoiceCancelGuardError).reason).toBe("mismatch:invoice_number");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "does not PUT when --execute is absent",
      argv: ["invoices", "cancel", "--company-id", "999", "--id", "777", "--expect-invoice-number", "INV-777"],
      invoice: validReadInvoice,
      responseCount: 1,
      expectedError: undefined,
    },
    {
      name: "does not PUT for a registered deal without --allow-deal-deletion",
      argv: ["invoices", "cancel", "--company-id", "999", "--id", "777", "--expect-invoice-number", "INV-777", "--execute"],
      invoice: { ...validReadInvoice, deal_status: "registered" },
      responseCount: 1,
      expectedError: InvoiceCancelGuardError,
    },
    {
      name: "PUTs only with --execute and --allow-deal-deletion",
      argv: ["invoices", "cancel", "--company-id", "999", "--id", "777", "--expect-invoice-number", "INV-777", "--execute", "--allow-deal-deletion"],
      invoice: { ...validReadInvoice, deal_status: "registered" },
      responseCount: 2,
      expectedError: undefined,
    },
  ])("CLI $name", async ({ argv, invoice, responseCount, expectedError }) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ invoice }), { status: 200 }));
    if (responseCount === 2) fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { id: 777, cancel_status: "canceled" } }), { status: 200 }));

    const result = await parseCancelCli([...argv, "--log-dir", mkdtempSync(join(tmpdir(), "invoice-cancel-cli-"))], fetchMock);

    if (expectedError) expect(result).toBeInstanceOf(expectedError);
    else expect(result).not.toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(responseCount);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(responseCount === 2);
  });

  it("CLI dry-run writes the requested cancel audit JSONL", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "invoice-cancel-cli-audit-"));
    const now = new Date("2026-09-07T05:06:07Z");
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ invoice: validReadInvoice }), { status: 200 }));
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const result = await parseCancelCli([
        "invoices", "cancel", "--company-id", "999", "--id", "777", "--expect-invoice-number", "INV-777",
        "--task-id", "cli-cancel-audit", "--log-dir", logDir,
      ], fetchMock);
      expect(result).not.toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const lines = readFileSync(join(logDir, "freee-invoice-cancel-2026-09-07.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      timestamp: "2026-09-07T05:06:07.000Z",
      task_id: "cli-cancel-audit",
      event: "invoice_cancel",
      mode: "dry-run",
      status: "planned",
      company_id: 999,
      invoice_id: 777,
      put_state: "not_attempted",
    });
  });

  it.each(["1e2", " 100 ", "0x64", "+100", "0100", "100.0"])("CLI rejects non-decimal --id %j before GET", async (id) => {
    const fetchMock = vi.fn();
    const result = await parseCancelCli([
      "invoices", "cancel", "--company-id", "999", "--id", id, "--expect-invoice-number", "INV-100",
      "--execute", "--log-dir", mkdtempSync(join(tmpdir(), "invoice-cancel-cli-")),
    ], fetchMock);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("--id must be a positive integer");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["ＩＮＶ-７７７", "DIFFERENT-777"])("CLI does not PUT when --expect-invoice-number is non-matching: %j", async (expectInvoiceNumber) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ invoice: validReadInvoice }), { status: 200 }));
    const result = await parseCancelCli([
      "invoices", "cancel", "--company-id", "999", "--id", "777", "--expect-invoice-number", expectInvoiceNumber,
      "--execute", "--log-dir", mkdtempSync(join(tmpdir(), "invoice-cancel-cli-")),
    ], fetchMock);

    expect(result).toBeInstanceOf(InvoiceCancelGuardError);
    expect((result as InvoiceCancelGuardError).reason).toBe("mismatch:invoice_number");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("CLI forwards id, company ID, and invoice number without transforming them", async () => {
    const companyId = 1234;
    const id = 4567;
    const invoiceNumber = "  ｉｎｖ-Ａ0001 test  ";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { ...validReadInvoice, id, company_id: companyId, invoice_number: invoiceNumber } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { id, cancel_status: "canceled" } }), { status: 200 }));

    const result = await parseCancelCli([
      "invoices", "cancel", "--company-id", String(companyId), "--id", String(id), "--expect-invoice-number", invoiceNumber,
      "--execute", "--log-dir", mkdtempSync(join(tmpdir(), "invoice-cancel-cli-")),
    ], fetchMock);

    expect(result).not.toBeInstanceOf(Error);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://api.freee.co.jp/iv/invoices/${id}?company_id=${companyId}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`https://api.freee.co.jp/iv/invoices/${id}/cancel`);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "PUT", body: JSON.stringify({ company_id: companyId }) });
  });

  it("cancels only after GET and sends company_id in the PUT body", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { id: 777, company_id: 999, invoice_number: "INV-777", deal_status: "unregistered", total_amount: 12345, partner_id: 456 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { id: 777, cancel_status: "canceled" } }), { status: 200 }));
    const audits: InvoiceCancelAuditEntry[] = [];
    const result = await runInvoicesCancel({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, {
      getClient: async () => createInvoiceClient({ token: "t", fetchFn: fetchMock as unknown as typeof fetch }),
      appendAudit: async (entry) => { audits.push(entry); }, now: () => new Date("2026-09-07T01:02:03Z"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://api.freee.co.jp/iv/invoices/777/cancel");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "PUT", body: JSON.stringify({ company_id: 999 }), redirect: "manual" });
    expect(result.canceled).toEqual({ id: 777, cancel_status: "canceled" });
    expect(audits).toEqual([{
      timestamp: "2026-09-07T01:02:03.000Z",
      task_id: "invoice-cancel-test",
      event: "invoice_cancel",
      mode: "execute",
      status: "canceled",
      company_id: 999,
      invoice_id: 777,
      put_state: "succeeded",
    }]);
  });

  it.each(putStatusCases)("classifies PUT status $status as $putState", async ({ status, putState }) => {
    const audits: InvoiceCancelAuditEntry[] = [];
    const err = await runInvoicesCancel({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, {
      getClient: async () => ({
        get: async () => new Response(JSON.stringify({ invoice: validReadInvoice }), { status: 200 }),
        put: async () => { throw new FreeeApiError({ status, path: "/invoices/777/cancel", bodySnippet: "" }); },
      }) as never,
      appendAudit: async (entry) => { audits.push(entry); }, now: () => new Date(),
    }).catch((e) => e);
    if (putState === "rejected") expect(err).toBeInstanceOf(FreeeApiError);
    else expect(err).toBeInstanceOf(InvoiceCancelUnverifiedError);
    expect(audits).toMatchObject([{ status: "failed", reason: `put_http:${status}`, put_state: putState }]);
  });

  it("uses manual redirect handling so an observed 302 is unknown", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: validReadInvoice }), { status: 200 }))
      .mockResolvedValueOnce(new Response("redirect", { status: 302 }));
    const audits: InvoiceCancelAuditEntry[] = [];
    const err = await runInvoicesCancel({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, {
      getClient: async () => createInvoiceClient({ token: "t", fetchFn: fetchMock as unknown as typeof fetch }), appendAudit: async (entry) => { audits.push(entry); }, now: () => new Date("2026-09-07T02:03:04Z"),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(InvoiceCancelUnverifiedError);
    expect((err as InvoiceCancelUnverifiedError).putState).toBe("unknown");
    expect((err as Error).message).toContain("再実行せず");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ redirect: "manual" });
    expect(audits).toEqual([{
      timestamp: "2026-09-07T02:03:04.000Z",
      task_id: "invoice-cancel-test",
      event: "invoice_cancel",
      mode: "execute",
      status: "failed",
      company_id: 999,
      invoice_id: 777,
      reason: "put_http:302",
      put_state: "unknown",
    }]);
  });

  it("wraps invalid successful PUT responses and audit failures after PUT", async () => {
    const invoice = { id: 777, company_id: 999, invoice_number: "INV-777", deal_status: "unregistered", total_amount: 1, partner_id: 2 };
    const responseFailure = await runInvoicesCancel({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, {
      getClient: async () => createInvoiceClient({ token: "t", fetchFn: vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ invoice }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { id: 777, cancel_status: "uncanceled" } }), { status: 200 })) as unknown as typeof fetch }),
      appendAudit: async () => {}, now: () => new Date(),
    }).catch((e) => e);
    expect(responseFailure).toBeInstanceOf(InvoiceCancelUnverifiedError);
    expect((responseFailure as InvoiceCancelUnverifiedError).reason).toBe("mismatch:cancel_status");
    expect((responseFailure as Error).message).toContain("再実行せず");
    const auditFailure = await runInvoicesCancel({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, {
      getClient: async () => createInvoiceClient({ token: "t", fetchFn: vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ invoice }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { id: 777, cancel_status: "canceled" } }), { status: 200 })) as unknown as typeof fetch }),
      appendAudit: async () => { throw new Error("disk full"); }, now: () => new Date(),
    }).catch((e) => e);
    expect(auditFailure).toBeInstanceOf(InvoiceCancelUnverifiedError);
    expect((auditFailure as InvoiceCancelUnverifiedError).reason).toBe("audit_write_failed");
  });

  it("treats a mismatched PUT response id as an unverified cancellation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: validReadInvoice }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { id: 778, cancel_status: "canceled" } }), { status: 200 }));
    const audits: InvoiceCancelAuditEntry[] = [];
    const error = await runInvoicesCancel({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, {
      getClient: async () => createInvoiceClient({ token: "t", fetchFn: fetchMock as unknown as typeof fetch }),
      appendAudit: async (entry) => { audits.push(entry); },
      now: () => new Date(),
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(InvoiceCancelUnverifiedError);
    expect((error as InvoiceCancelUnverifiedError).reason).toBe("mismatch:id");
    expect((error as InvoiceCancelUnverifiedError).putState).toBe("succeeded");
    expect(audits).toMatchObject([{ status: "failed", reason: "mismatch:id", put_state: "succeeded" }]);
  });

  it("rejects a mismatched GET response id before PUT", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { ...validReadInvoice, id: 778 } }), { status: 200 }));
    const error = await runInvoicesCancel({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, {
      getClient: async () => createInvoiceClient({ token: "t", fetchFn: fetchMock as unknown as typeof fetch }),
      appendAudit: async () => {},
      now: () => new Date(),
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(InvoiceCancelGuardError);
    expect((error as InvoiceCancelGuardError).reason).toBe("mismatch:id");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe("GET response fields", () => {
    for (const { field, invalidValues } of readFieldDefinitions) {
      it(`${field} is required`, async () => {
        const invoice = { ...validReadInvoice };
        delete invoice[field];
        await expect(readTargetError(invoice)).resolves.toBeInstanceOf(ResponseParseError);
      });

      it.each(invalidValues)(`${field} rejects invalid value %j`, async (invalidValue) => {
        await expect(readTargetError({ ...validReadInvoice, [field]: invalidValue })).resolves.toBeInstanceOf(ResponseParseError);
      });
    }
  });

  it("uses the state table when audit writing fails", async () => {
    const invoice = { id: 777, company_id: 999, invoice_number: "INV-777", deal_status: "unregistered", total_amount: 1, partner_id: 2 };
    const rejected = await runInvoicesCancel({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, {
      getClient: async () => createInvoiceClient({ token: "t", fetchFn: vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ invoice }), { status: 200 })).mockResolvedValueOnce(new Response("no", { status: 400 })) as unknown as typeof fetch }),
      appendAudit: async () => { throw new Error("disk full"); }, now: () => new Date(),
    }).catch((e) => e);
    expect(rejected).toBeInstanceOf(AuditWriteError);
    const unknown = await runInvoicesCancel({ ...opts, execute: true, expectInvoiceNumber: "INV-777" }, {
      getClient: async () => createInvoiceClient({ token: "t", fetchFn: vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ invoice }), { status: 200 })).mockResolvedValueOnce(new Response("no", { status: 500 })) as unknown as typeof fetch }),
      appendAudit: async () => { throw new Error("disk full"); }, now: () => new Date(),
    }).catch((e) => e);
    expect(unknown).toBeInstanceOf(InvoiceCancelUnverifiedError);
    expect((unknown as InvoiceCancelUnverifiedError).reason).toBe("audit_write_failed");
  });

  describe("appendInvoiceCancelAudit", () => {
    const entry: InvoiceCancelAuditEntry = {
      timestamp: "2026-09-07T00:00:00.000Z",
      task_id: "invoice-cancel-audit-test",
      event: "invoice_cancel",
      mode: "dry-run",
      status: "planned",
      company_id: 999,
      invoice_id: 777,
      put_state: "not_attempted",
    };

    const freeTextFields = ["task_id", "reason"] as const;
    const sensitiveValues = [
      ["Bearer token", "Bearer test-token"],
      ["raw email address", "billing@example.com"],
    ] as const;

    it.each(freeTextFields.flatMap((field) => sensitiveValues.map(([name, value]) => ({ field, name, value }))))(
      "rejects a $name in audit $field",
      async ({ field, value }) => {
        const leakedEntry: InvoiceCancelAuditEntry = field === "task_id" ? { ...entry, task_id: value } : { ...entry, reason: value };
      await expect(
          appendInvoiceCancelAudit(mkdtempSync(join(tmpdir(), "invoice-cancel-audit-")), leakedEntry),
      ).rejects.toThrow(/Bearer|email/);
      },
    );
  });
});
