import { beforeAll, describe, expect, it, vi } from "vitest";
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

describe.each([
  ["invoices", "invoice_number", runInvoicesNextNumber],
  ["quotations", "quotation_number", runQuotationsNextNumber],
] as const)("%s next-number boundaries", (resource, numberKey, run) => {
  const raw = (id = 1) => ({ id, [numberKey]: `ABC-${String(id).padStart(3, "0")}`, partner_id: 10 });
  it("counts sales-management-origin documents when computing the next number", async () => {
    const get = vi.fn(async (_path, init) => jsonRes({
      [resource]: init.query.sales_management_origin === true ? [raw(1), raw(2)] : [raw(1)],
    }));
    const result = await run({ companyId: 1, prefix: "ABC", partnerId: 10 }, { client: { get } });
    expect(result.next).toBe("ABC-003");
  });
  it("rejects sales-management-origin documents belonging to a different partner", async () => {
    const get = vi.fn(async (_path, init) => jsonRes({
      [resource]: init.query.sales_management_origin === true ? [raw(1), { ...raw(2), partner_id: 11 }] : [raw(1)],
    }));
    await expect(run({ companyId: 1, prefix: "ABC", partnerId: 10 }, { client: { get } })).rejects.toThrow(/partner/);
  });
  it("pages each state independently and never filters by partner", async () => {
    const get = vi.fn(async (path, init) => {
      expect(path).toBe(`/${resource}`);
      expect(init.query).not.toHaveProperty("partner_id");
      expect(init.query).not.toHaveProperty("partner_ids");
      expect(init.query.limit).toBe(100);
      const page = init.query.offset === 0 ? Array.from({ length: 100 }, (_, i) => raw(i + 1)) : [raw(101)];
      return jsonRes({ [resource]: page });
    });
    const result = await run({ companyId: 1, prefix: "ABC", partnerId: 10, maxOffset: 200 }, { client: { get } });
    expect(result.next).toBe("ABC-102");
    expect(result.matched).toHaveLength(101);
    expect(get.mock.calls.map(([, init]) => [init.query.cancel_status, init.query.offset])).toEqual([
      ["canceled", 0], ["canceled", 100], ["uncanceled", 0], ["uncanceled", 100],
    ]);
    expect(get).toHaveBeenCalledTimes(4);
    for (const [, init] of get.mock.calls) {
      expect(init.query).toHaveProperty("sales_management_origin", true);
    }
  });
  it("stops before exceeding the cap without returning partial results", async () => {
    const get = vi.fn(async () => jsonRes({ [resource]: Array.from({ length: 100 }, (_, i) => raw(i + 1)) }));
    await expect(run({ companyId: 1, prefix: "ABC", maxOffset: 250 }, { client: { get } })).rejects.toThrow(/limit \+ offset/);
    expect(get).toHaveBeenCalledTimes(2);
  });
  it.each([null, {}, { [resource]: null }, { [resource]: {} }, ...[
    null, { ...raw(), id: 0 }, { ...raw(), id: 1.5 }, { ...raw(), id: "1" },
    { ...raw(), [numberKey]: 1 }, { ...raw(), partner_id: 0 }, { ...raw(), partner_id: "10" },
  ].map((item) => ({ [resource]: [item] }))])("rejects malformed response %j", async (payload) => {
    const get = vi.fn(async () => jsonRes(payload));
    await expect(run({ companyId: 1, prefix: "ABC" }, { client: { get } })).rejects.toThrow(/invalid/);
  });
  it("validates duplicate rows too", async () => {
    const get = vi.fn().mockResolvedValueOnce(jsonRes({ [resource]: [raw()] }))
      .mockResolvedValueOnce(jsonRes({ [resource]: [{ ...raw(), partner_id: null }] }));
    await expect(run({ companyId: 1, prefix: "ABC" }, { client: { get } })).rejects.toThrow(/invalid/);
  });
  it("rejects conflicting duplicate IDs", async () => {
    const get = vi.fn().mockResolvedValueOnce(jsonRes({ [resource]: [raw()] }))
      .mockResolvedValueOnce(jsonRes({ [resource]: [{ ...raw(), partner_id: 11 }] }));
    await expect(run({ companyId: 1, prefix: "ABC" }, { client: { get } })).rejects.toThrow(/partner/);
  });
  it("rejects invalid prefixes before GET", async () => {
    const get = vi.fn();
    await expect(run({ companyId: 1, prefix: "abc" }, { client: { get } })).rejects.toThrow(/--prefix/);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("additional number calculation cases", () => {
  it("honors width while preserving wider existing numbers", () => {
    expect(computeNextNumber("ABC", [], { width: 1 })).toEqual({ next: "ABC-1", max: null, width: 1, matched: [] });
    expect(computeNextNumber("ABC", [doc(1, "ABC-01")], { width: 5 }).next).toBe("ABC-00002");
    expect(computeNextNumber("ABC", [doc(1, "ABC-00001")], { width: 1 }).next).toBe("ABC-00002");
  });
  it("does not allow an imprecise sequence increment", () => {
    expect(() => computeNextNumber("ABC", [doc(1, "ABC-9007199254740992")])).toThrow(/safe integer/);
  });
  it("rejects a single different partner and ignores unrelated prefixes", () => {
    expect(() => computeNextNumber("ABC", [doc(1, "ABC-001", 11)], { partnerId: 10 })).toThrow(/partner/);
    expect(computeNextNumber("ABC", [doc(1, "OTHER-001", 11)], { partnerId: 10 }).next).toBe("ABC-001");
  });
});

describe.each(["invoices", "quotations"])("%s next-number CLI", (resource) => {
  let createProgram: typeof import("../../src/cli.js").createProgram;
  beforeAll(async () => {
    ({ createProgram } = await import("../../src/cli.js"));
  });
  it.each([
    ["--prefix", "abc"], ["--company-id", "0"], ["--partner-id", "0"],
    ["--width", "0"], ["--width", "11"], ["--width", "1.5"], ["--width", "1e1"], ["--format", "csv"],
  ])("validates %s=%s before authentication", async (flag, value) => {
    const previous = process.env.FREEE_ACCESS_TOKEN;
    process.env.FREEE_ACCESS_TOKEN = "";
    try {
      const argv = [resource, "next-number", "--company-id", "1", "--prefix", "ABC", flag, value];
      await expect(createProgram().parseAsync(argv, { from: "user" })).rejects.toThrow(flag);
    } finally {
      if (previous === undefined) delete process.env.FREEE_ACCESS_TOKEN;
      else process.env.FREEE_ACCESS_TOKEN = previous;
    }
  });
  it.each(["json", "table"])("prints %s using GET only", async (format) => {
    const previous = process.env.FREEE_ACCESS_TOKEN;
    process.env.FREEE_ACCESS_TOKEN = "test-token";
    const fetchMock = vi.fn(async () => jsonRes({ [resource]: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await createProgram().parseAsync([resource, "next-number", "--company-id", "1", "--prefix", "ABC", "--partner-id", "10", "--width", "10", "--format", format], { from: "user" });
      const output = log.mock.calls[0]?.[0];
      if (format === "table") expect(output).toBe("next\tmax\tmatched_count\nABC-0000000001\t\t0");
      else expect(JSON.parse(output)).toEqual({ prefix: "ABC", next: "ABC-0000000001", max: null, width: 10, matched: [] });
      expect(fetchMock.mock.calls).toHaveLength(2);
      expect(fetchMock.mock.calls.every((call) => (call as unknown[])[1] && ((call as unknown[])[1] as RequestInit).method === "GET")).toBe(true);
    } finally {
      log.mockRestore(); vi.unstubAllGlobals();
      if (previous === undefined) delete process.env.FREEE_ACCESS_TOKEN;
      else process.env.FREEE_ACCESS_TOKEN = previous;
    }
  });
});

it("requires the entire prefix and number to match, including trailing newlines", () => {
  expect(() => validateNumberPrefix("ABC\n")).toThrow(/--prefix/);
  expect(computeNextNumber("ABC", [doc(1, "ABC-999\n")]).next).toBe("ABC-001");
});
