import { describe, expect, it, vi } from "vitest";
import { computeNextNumber, validateNumberPrefix } from "../../src/lib/next-number.js";
import { runInvoicesNextNumber } from "../../src/commands/invoices/next-number.js";
import { runQuotationsNextNumber } from "../../src/commands/quotations/next-number.js";

const doc = (id: number, number: string, partner_id = 10) => ({ id, number, partner_id });

describe("computeNextNumber", () => {
  it("returns <prefix>-001 when nothing matches", () => {
    expect(computeNextNumber("ABC", [doc(1, "INV-0000000001")]).next).toBe("ABC-001");
  });

  it("returns max + 1, not count + 1", () => {
    const result = computeNextNumber("ABC", [doc(1, "ABC-001"), doc(2, "ABC-005"), doc(3, "ABC-002")]);
    expect(result.next).toBe("ABC-006");
    expect(result.matched).toHaveLength(3);
  });

  it("keeps the widest existing width", () => {
    expect(computeNextNumber("ABC", [doc(1, "ABC-0099")]).next).toBe("ABC-0100");
    expect(computeNextNumber("ABC", [doc(1, "ABC-999")]).next).toBe("ABC-1000");
  });

  it("does not treat a longer prefix as a match", () => {
    expect(computeNextNumber("ABC", [doc(1, "ABC-X-003"), doc(2, "XABC-004"), doc(3, "ABC-004a")]).next).toBe("ABC-001");
    expect(computeNextNumber("Q-ABC", [doc(1, "ABC-007")]).next).toBe("Q-ABC-001");
  });

  it("fails when the prefix is used by another partner", () => {
    expect(() => computeNextNumber("ABC", [doc(1, "ABC-001", 10), doc(2, "ABC-002", 11)], { partnerId: 10 })).toThrow(/partner/);
  });

  it("fails when matches span several partners even without --partner-id", () => {
    expect(() => computeNextNumber("ABC", [doc(1, "ABC-001", 10), doc(2, "ABC-002", 11)])).toThrow(/partner/);
  });
});

describe("validateNumberPrefix", () => {
  it.each(["ABC", "Q-ABC", "A1", "AB-2C"])("accepts %s", (p) => expect(() => validateNumberPrefix(p)).not.toThrow());
  it.each(["", "abc", "ABC-", "-ABC", "A--B", "A B", "ＡＢＣ", "A".repeat(21)])("rejects %j", (p) =>
    expect(() => validateNumberPrefix(p)).toThrow(/--prefix/),
  );
});

function jsonRes(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

describe("next-number commands", () => {
  it("invoices: counts canceled and uncanceled invoices", async () => {
    const get = vi.fn(async (_path: string, init: { query: Record<string, unknown> }) =>
      jsonRes({
        invoices:
          init.query.cancel_status === "canceled"
            ? [{ id: 2, invoice_number: "ABC-002", partner_id: 10, cancel_status: "canceled" }]
            : [{ id: 1, invoice_number: "ABC-001", partner_id: 10, cancel_status: "uncanceled" }],
      }),
    );
    const result = await runInvoicesNextNumber({ companyId: 1, prefix: "ABC", partnerId: 10 }, { client: { get } as never });
    expect(result.next).toBe("ABC-003");
    const statuses = get.mock.calls.map((call) => call[1].query.cancel_status).sort();
    expect(statuses).toEqual(["canceled", "uncanceled"]);
  });

  it("quotations: counts canceled and uncanceled quotations", async () => {
    const get = vi.fn(async (_path: string, init: { query: Record<string, unknown> }) =>
      jsonRes({
        quotations:
          init.query.cancel_status === "canceled"
            ? [{ id: 5, quotation_number: "Q-ABC-004", partner_id: 10, cancel_status: "canceled" }]
            : [],
      }),
    );
    const result = await runQuotationsNextNumber({ companyId: 1, prefix: "Q-ABC" }, { client: { get } as never });
    expect(result.next).toBe("Q-ABC-005");
  });

  it("rejects an invalid prefix before calling the API", async () => {
    const get = vi.fn();
    await expect(runInvoicesNextNumber({ companyId: 1, prefix: "abc" }, { client: { get } as never })).rejects.toThrow(/--prefix/);
    expect(get).not.toHaveBeenCalled();
  });
});
