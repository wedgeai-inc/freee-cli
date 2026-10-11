import { describe, expect, it, vi } from "vitest";
import { createInvoiceClient } from "../../src/lib/clients/freee-invoice-client.js";
import { InvoiceCreatedButUnverifiedError, runInvoicesCreate } from "../../src/commands/invoices/create.js";
import { QuotationCreatedButUnverifiedError, runQuotationsCreate } from "../../src/commands/quotations/create.js";
import { stableClock } from "../../src/lib/clock.js";

/** 1 回目だけ成功し、以降は失敗する時計（書き込みの後に時計が壊れる状況） */
function brokenAfterFirst(mode: "throw" | "invalid" = "throw") {
  let n = 0;
  return () => {
    if (n++ === 0) return new Date("2026-09-08T00:00:00Z");
    if (mode === "throw") throw new Error("clock broke");
    return new Date(NaN);
  };
}

/** fetch（書き込み）が呼ばれた後は壊れる時計 */
function brokenAfterWrite(fetchFn: ReturnType<typeof vi.fn>, mode: "throw" | "invalid" = "throw") {
  return () => {
    if (fetchFn.mock.calls.length === 0) return new Date("2026-09-08T00:00:00Z");
    if (mode === "throw") throw new Error("clock broke");
    return new Date(NaN);
  };
}

const invPlan = { billing_date: "2026-09-05", partner_id: 1, partner_title: "御中", tax_entry_method: "out", tax_fraction: "omit", withholding_tax_entry_method: "out", lines: [{ description: "x", quantity: 1, unit_price: "100", tax_rate: 10 }] };
const quoPlan = { quotation_date: "2026-09-08", partner_id: 1, partner_title: "御中", tax_entry_method: "out", tax_fraction: "omit", withholding_tax_entry_method: "out", lines: [{ description: "x", quantity: 1, unit_price: "100", tax_rate: 10 }] };

describe("stableClock", () => {
  it("falls back to the first reading when the clock throws or returns an invalid date", () => {
    for (const mode of ["throw", "invalid"] as const) {
      const c = stableClock(brokenAfterFirst(mode));
      expect(c().toISOString()).toBe("2026-09-08T00:00:00.000Z");
      expect(c().toISOString()).toBe("2026-09-08T00:00:00.000Z");
    }
  });
  it("fails at the first reading (before any write) if the clock is already broken", () => {
    expect(() => stableClock(() => { throw new Error("x"); })).toThrow();
    expect(() => stableClock(() => new Date(NaN))).toThrow();
    expect(() => stableClock((() => "2026") as unknown as () => Date)).toThrow();
  });
});

describe("a clock failure after the write keeps the no-rerun state", () => {
  for (const mode of ["throw", "invalid"] as const) {
    it(`invoices create: POST 2xx + read-back 404 + clock ${mode} -> unverified with createdId`, async () => {
      const fetchFn = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { id: 7 } }), { status: 201 })).mockResolvedValueOnce(new Response("{}", { status: 404 }));
      const audits: any[] = [];
      const e = await runInvoicesCreate({ companyId: 1, planPath: "p", execute: true, logDir: "x", taskId: "t" }, {
        getClient: async () => createInvoiceClient({ token: "t", fetchFn }), readFile: async () => JSON.stringify(invPlan), appendAudit: async (a) => void audits.push(a), now: brokenAfterWrite(fetchFn, mode),
      }).catch((x) => x);
      expect(e).toBeInstanceOf(InvoiceCreatedButUnverifiedError);
      expect(e).toMatchObject({ createdId: 7, postState: "succeeded" });
      expect(audits[0].timestamp).toBe("2026-09-08T00:00:00.000Z");
    });
    it(`invoices create: 5xx on POST + clock ${mode} -> unverified (unknown)`, async () => {
      const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 503 }));
      const e = await runInvoicesCreate({ companyId: 1, planPath: "p", execute: true, logDir: "x", taskId: "t" }, {
        getClient: async () => createInvoiceClient({ token: "t", fetchFn }), readFile: async () => JSON.stringify(invPlan), appendAudit: async () => {}, now: brokenAfterWrite(fetchFn, mode),
      }).catch((x) => x);
      expect(e).toBeInstanceOf(InvoiceCreatedButUnverifiedError);
      expect(e.postState).toBe("unknown");
    });
    it(`quotations create: POST 2xx + read-back 404 + clock ${mode} -> unverified with createdId`, async () => {
      const fetchFn = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ quotation: { id: 9 } }), { status: 201 })).mockResolvedValueOnce(new Response("{}", { status: 404 }));
      const e = await runQuotationsCreate({ companyId: 1, planPath: "p", execute: true, logDir: "x", taskId: "t" }, {
        getClient: async () => createInvoiceClient({ token: "t", fetchFn }), readFile: async () => JSON.stringify(quoPlan), appendAudit: async () => {}, now: brokenAfterWrite(fetchFn, mode),
      }).catch((x) => x);
      expect(e).toBeInstanceOf(QuotationCreatedButUnverifiedError);
      expect(e).toMatchObject({ createdId: 9, postState: "succeeded" });
    });
  }
  it("a clock that is broken from the start fails before any POST", async () => {
    const fetchFn = vi.fn();
    await expect(runInvoicesCreate({ companyId: 1, planPath: "p", execute: true, logDir: "x", taskId: "t" }, {
      getClient: async () => createInvoiceClient({ token: "t", fetchFn }), readFile: async () => JSON.stringify(invPlan), appendAudit: async () => {}, now: () => { throw new Error("x"); },
    })).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
