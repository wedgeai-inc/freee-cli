import { describe, expect, it } from "vitest";
import * as reader from "../../src/reader.js";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function mock(body: unknown = { invoices: [], partners: [], expense_applications: [] }) {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    seen.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}

const WRITE_NAMES = ["post", "put", "patch", "delete", "request"];

describe("reader entry (read-only surface)", () => {
  it("exports exactly the allowed names; no PublicFreeeClient / createInvoiceClient / write commands", () => {
    expect(Object.keys(reader).sort()).toEqual(
      [
        "FreeeApiError",
        "INVOICE_API_BASE_URL",
        "PAGINATION_MAX_OFFSET",
        "createReadOnlyClient",
        "invoiceWebUrl",
        "runExpenseList",
        "runInvoicesList",
        "runPartnersSearch",
      ].sort(),
    );
    const exported = reader as Record<string, unknown>;
    expect(exported["PublicFreeeClient"]).toBeUndefined();
    expect(exported["createInvoiceClient"]).toBeUndefined();
  });

  for (const api of ["accounting", "invoice"] as const) {
    it(`${api}: the client has only get and listAll, is frozen, and does not expose the wrapped instance`, () => {
      const client = reader.createReadOnlyClient({ api, token: "t", fetchFn: mock().fetchFn });
      expect(Reflect.ownKeys(client).sort()).toEqual(["get", "listAll"]);
      expect(Object.isFrozen(client)).toBe(true);
      expect(Object.getPrototypeOf(client)).toBe(Object.prototype);
      const bag = client as unknown as Record<string, unknown>;
      for (const name of WRITE_NAMES) expect(bag[name]).toBeUndefined();
      // 包んだ実体を、関数の bind 先・プロパティ・prototype のどこからも取れない。
      for (const key of Reflect.ownKeys(client)) {
        const v = (client as unknown as Record<string | symbol, unknown>)[key];
        expect(typeof v).toBe("function");
        expect(Reflect.ownKeys(v as object).filter((k) => k !== "length" && k !== "name")).toEqual([]);
      }
      expect(() => {
        (client as unknown as Record<string, unknown>)["post"] = () => undefined;
      }).toThrow();
    });
  }

  it("sends only GET through every public route (client, run* functions), including retried requests", async () => {
    const { seen, fetchFn } = mock();
    const acc = reader.createReadOnlyClient({ api: "accounting", token: "t", fetchFn });
    const inv = reader.createReadOnlyClient({ api: "invoice", token: "t", fetchFn });
    await acc.get("/api/1/partners", { query: { company_id: 1 } });
    for await (const _ of acc.listAll("/api/1/partners", { company_id: 1 })) void _;
    await inv.get("/invoices", { query: { company_id: 1 } });
    await reader.runInvoicesList({ companyId: 1 }, { client: inv });
    await reader.runExpenseList({ companyId: 1 }, { client: acc });
    await reader.runPartnersSearch({ companyId: 1, keyword: "a" }, { client: acc });
    expect(seen.length).toBeGreaterThanOrEqual(6);
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(["GET"]));
    expect(seen.every((s) => s.headers["Authorization"] === "Bearer t")).toBe(true);
    expect(seen.some((s) => s.url.startsWith("https://api.freee.co.jp/iv/invoices"))).toBe(true);
  });

  it("keeps GET on 429 retries", async () => {
    const seen: string[] = [];
    let n = 0;
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      seen.push(init?.method ?? "GET");
      return n++ === 0 ? new Response("", { status: 429 }) : new Response(JSON.stringify({ partners: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = reader.createReadOnlyClient({ api: "accounting", token: "t", fetchFn, sleepFn: async () => undefined });
    await c.get("/api/1/partners");
    expect(seen).toEqual(["GET", "GET"]);
  });

  it("ignores extra options smuggled in (headers / method / body / redirect) and refuses non-relative paths", async () => {
    const { seen, fetchFn } = mock();
    const c = reader.createReadOnlyClient({ api: "accounting", token: "t", fetchFn });
    const sneaky = { query: { a: 1 }, headers: { Authorization: "Bearer evil", "X-HTTP-Method-Override": "DELETE" }, method: "DELETE", body: { x: 1 }, redirect: "manual" };
    await c.get("/api/1/partners", sneaky as never);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.headers["Authorization"]).toBe("Bearer t");
    expect(seen[0]?.headers["X-HTTP-Method-Override"]).toBeUndefined();
    for (const bad of ["https://evil.example/x", "//evil.example/x", "api/1/partners", "/a\\b", ""]) {
      expect(() => c.get(bad)).toThrow(/relative|相対/);
      expect(() => c.listAll(bad)).toThrow(/相対/);
    }
    expect(seen).toHaveLength(1);
  });

  it("run* work with a lookalike that has only get/listAll (type-level read-only contract)", async () => {
    const fake: reader.ReadOnlyClient = {
      get: async () => new Response(JSON.stringify({ invoices: [] }), { status: 200 }),
      listAll: async function* () {},
    };
    expect((await reader.runInvoicesList({ companyId: 1 }, { client: fake })).items).toEqual([]);
  });
});
