import { describe, expect, it, vi } from "vitest";
import { FreeeApiError, PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";

describe("PublicFreeeClient", () => {
  it("forwards redirect only when explicitly requested", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "token-123", fetchFn: fetchMock });

    await client.get("/default");
    await client.put("/manual", { redirect: "manual" });

    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("redirect");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("retries GET after 429 and returns the successful response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const sleepFn = vi.fn(async (_ms: number) => undefined);
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "token-123",
      fetchFn: fetchMock,
      sleepFn,
    });

    const response = await client.get("/api/1/receipts/1/download");

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(1000);
  });

  it("honors Retry-After seconds for GET retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429, headers: { "Retry-After": "7" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const sleepFn = vi.fn(async (_ms: number) => undefined);
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "token-123",
      fetchFn: fetchMock,
      sleepFn,
    });

    await client.get("/api/1/receipts/1/download");

    expect(sleepFn).toHaveBeenCalledWith(7000);
  });

  it("honors an HTTP-date Retry-After value", async () => {
    const now = Date.parse("2026-08-11T14:00:00Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "Tue, 11 Aug 2026 14:00:07 GMT" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const sleepFn = vi.fn(async (_ms: number) => undefined);
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "token-123",
      fetchFn: fetchMock,
      sleepFn,
      nowFn: () => now,
    });

    await client.get("/api/1/receipts/1/download");

    expect(sleepFn).toHaveBeenCalledWith(7000);
  });

  it.each([
    "Tuesday, 11-Aug-26 14:00:07 GMT",
    "Tue Aug 11 14:00:07 2026",
  ])("accepts obsolete HTTP-date Retry-After form %j", async (retryAfter) => {
    const now = Date.parse("2026-08-11T14:00:00Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429, headers: { "Retry-After": retryAfter } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const sleepFn = vi.fn(async (_ms: number) => undefined);
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "token-123",
      fetchFn: fetchMock,
      sleepFn,
      nowFn: () => now,
    });

    await client.get("/api/1/receipts/1/download");

    expect(sleepFn).toHaveBeenCalledWith(7000);
  });

  it.each([
    "Tuesday, 31-Feb-26 14:00:07 GMT",
    "Monday, 11-Aug-26 14:00:07 GMT",
    "Tue Feb 31 14:00:07 2026",
    "Mon Aug 11 14:00:07 2026",
  ])("falls back for a semantically invalid HTTP-date %j", async (retryAfter) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429, headers: { "Retry-After": retryAfter } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const sleepFn = vi.fn(async (_ms: number) => undefined);
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "token-123",
      fetchFn: fetchMock,
      sleepFn,
      nowFn: () => Date.parse("2026-01-01T00:00:00Z"),
    });

    await client.get("/api/1/receipts/1/download");

    expect(sleepFn).toHaveBeenCalledWith(1000);
  });

  it.each([
    [75, 2075, 60_000],
    [76, 1976, 0],
  ])("resolves RFC850 year %s against the current century", async (shortYear, resolvedYear, expectedDelay) => {
    const target = new Date(Date.UTC(resolvedYear, 7, 11, 14, 0, 7));
    const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
      target.getUTCDay()
    ];
    const retryAfter = `${weekday}, 11-Aug-${shortYear} 14:00:07 GMT`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429, headers: { "Retry-After": retryAfter } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const sleepFn = vi.fn(async (_ms: number) => undefined);
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "token-123",
      fetchFn: fetchMock,
      sleepFn,
      nowFn: () => Date.parse("2026-01-01T00:00:00Z"),
    });

    await client.get("/api/1/receipts/1/download");

    expect(sleepFn).toHaveBeenCalledWith(expectedDelay);
  });

  it("accepts a leap second in an HTTP-date", async () => {
    const date = new Date(Date.UTC(2026, 11, 31, 23, 59, 58));
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": `${weekday}, 31 Dec 2026 23:59:60 GMT` },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const sleepFn = vi.fn(async (_ms: number) => undefined);
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "token-123",
      fetchFn: fetchMock,
      sleepFn,
      nowFn: () => date.getTime(),
    });

    await client.get("/api/1/receipts/1/download");

    expect(sleepFn).toHaveBeenCalledWith(2000);
  });

  it("caps an excessive Retry-After delay", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429, headers: { "Retry-After": "999" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const sleepFn = vi.fn(async (_ms: number) => undefined);
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "token-123",
      fetchFn: fetchMock,
      sleepFn,
    });

    await client.get("/api/1/receipts/1/download");

    expect(sleepFn).toHaveBeenCalledWith(60_000);
  });

  it.each(["", "0x10", "1e3", "1.5", "+7", "-1"])(
    "falls back for malformed Retry-After value %j",
    async (retryAfter) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response("rate limited", { status: 429, headers: { "Retry-After": retryAfter } }),
        )
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));
      const sleepFn = vi.fn(async (_ms: number) => undefined);
      const client = new PublicFreeeClient({
        baseUrl: "https://api.freee.co.jp",
        token: "token-123",
        fetchFn: fetchMock,
        sleepFn,
      });

      await client.get("/api/1/receipts/1/download");

      expect(sleepFn).toHaveBeenCalledWith(1000);
    },
  );

  it("saturates an arbitrarily large decimal Retry-After value", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "9".repeat(10_000) },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const sleepFn = vi.fn(async (_ms: number) => undefined);
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "token-123",
      fetchFn: fetchMock,
      sleepFn,
    });

    await client.get("/api/1/receipts/1/download");

    expect(sleepFn).toHaveBeenCalledWith(60_000);
  });

  it("fails after the bounded number of 429 GET retries", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));
    const sleepFn = vi.fn(async (_ms: number) => undefined);
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "token-123",
      fetchFn: fetchMock,
      sleepFn,
    });

    await expect(client.get("/api/1/receipts/1/download")).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleepFn.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000]);
  });

  it(
    "cancels a non-terminating 429 body before retrying",
    async () => {
      let cancelled = false;
      const neverEndingBody = new ReadableStream<Uint8Array>({
        cancel: () => {
          cancelled = true;
        },
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(neverEndingBody, { status: 429 }))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));
      const client = new PublicFreeeClient({
        baseUrl: "https://api.freee.co.jp",
        token: "token-123",
        fetchFn: fetchMock,
        sleepFn: async () => undefined,
      });

      const response = await client.get("/api/1/receipts/1/download");

      expect(response.status).toBe(200);
      expect(cancelled).toBe(true);
    },
    500,
  );

  it(
    "aborts while waiting to retry a GET",
    async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } }),
      );
      const client = new PublicFreeeClient({
        baseUrl: "https://api.freee.co.jp",
        token: "token-123",
        fetchFn: fetchMock,
      });
      const abortController = new AbortController();

      const request = client.get("/api/1/receipts/1/download", {
        signal: abortController.signal,
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      abortController.abort();

      await expect(request).rejects.toMatchObject({ name: "AbortError" });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
    500,
  );

  it.each([
    ["GET 404", (client: PublicFreeeClient) => client.get("/api/1/missing"), 404],
    ["POST 429", (client: PublicFreeeClient) => client.post("/api/1/write", { body: {} }), 429],
  ])("does not retry %s", async (_name, request, status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("error", { status }));
    const sleepFn = vi.fn(async (_ms: number) => undefined);
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "token-123",
      fetchFn: fetchMock,
      sleepFn,
    });

    await expect(request(client)).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("preserves the error body snippet for a POST 429", async () => {
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "token-123",
      fetchFn: async () => new Response("write-error-detail", { status: 429 }),
    });

    await expect(client.post("/api/1/write", { body: {} })).rejects.toMatchObject({
      status: 429,
      body_snippet: "write-error-detail",
    });
  });

  it("supports request method matrix (GET/POST/PUT/PATCH/DELETE)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "token-123",
      fetchFn: fetchMock,
    });

    await client.get("/v1/r1");
    await client.post("/v1/r2", { body: { a: 1 } });
    await client.put("/v1/r3", { body: { b: 2 } });
    await client.patch("/v1/r4", { body: { c: 3 } });
    await client.delete("/v1/r5");

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.map((c) => c[1]?.method)).toEqual([
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ]);
  });

  it("listAll paginates with limit/offset", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ expense_applications: [{ id: 1 }, { id: 2 }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ expense_applications: [{ id: 3 }] }), {
          status: 200,
        }),
      );
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "token-123",
      fetchFn: fetchMock,
    });

    const rows: Array<{ id: number }> = [];
    for await (const row of client.listAll<{ id: number }>("/api/1/expense_applications", {
      limit: 2,
      offset: 0,
      company_id: 1234567,
    })) {
      rows.push(row);
    }

    expect(rows.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("limit=2");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("offset=0");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("offset=2");
  });

  it("throws FreeeApiError with redacted message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":"token=secret@example.com"}', { status: 401 }),
    );
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "token-123",
      fetchFn: fetchMock,
    });

    await expect(client.get("/api/1/expense_applications")).rejects.toBeInstanceOf(FreeeApiError);
    await expect(client.get("/api/1/expense_applications")).rejects.toMatchObject({
      status: 401,
      path: "/api/1/expense_applications",
      redacted: true,
    });
    try {
      await client.get("/api/1/expense_applications");
    } catch (error) {
      const e = error as FreeeApiError;
      expect(e.message).toContain("401");
      expect(e.message).toContain("/api/1/expense_applications");
      expect(e.message).not.toContain("secret@example.com");
    }
  });

  it("caps body_snippet to 500 chars", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("x".repeat(600), { status: 500 }));
    const client = new PublicFreeeClient({
      baseUrl: "https://api.freee.co.jp",
      token: "token-123",
      fetchFn: fetchMock,
    });

    try {
      await client.get("/api/1/expense_applications");
    } catch (error) {
      const e = error as FreeeApiError;
      expect(e.body_snippet.length).toBe(500);
      return;
    }
    throw new Error("expected FreeeApiError");
  });
});
