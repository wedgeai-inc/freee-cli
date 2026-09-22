import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeOAuthHandler } from "../../src/lib/runtime-oauth-http.js";
import { RuntimeOAuthGate } from "../../src/lib/runtime-oauth-session.js";

async function invoke(
  handler: ReturnType<typeof createRuntimeOAuthHandler>,
  url: string,
): Promise<{ status: number; body: string }> {
  let status = 0;
  let body = "";
  const request = {
    method: "GET",
    url,
    headers: { host: "127.0.0.1:54321" },
  } as IncomingMessage;
  const response = {
    writeHead: (nextStatus: number) => {
      status = nextStatus;
      return response;
    },
    end: (chunk?: string) => {
      body += chunk ?? "";
      return response;
    },
  } as unknown as ServerResponse;
  await handler(request, response);
  return { status, body };
}

describe("runtime OAuth HTTP handler", () => {
  it("rejects a concurrent callback without cancelling the first exchange", async () => {
    const gate = new RuntimeOAuthGate("expected-state");
    let resolveExchange!: (value: { accessToken: string; refreshToken: string; expiresIn: number }) => void;
    const exchangeFn = vi.fn(
      () =>
        new Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>((resolve) => {
          resolveExchange = resolve;
        }),
    );
    const executeFn = vi.fn(async (_token: string, _refresh: string, _expires: number, _signal: AbortSignal, onStarted: () => void) => {
      onStarted();
    });
    const options = {
      expectedHost: "127.0.0.1:54321",
      startUrl: "http://127.0.0.1:54321/start",
      config: {
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://127.0.0.1/callback",
        state: "expected-state",
      },
      gate,
      exchangeFn,
      executeFn,
      onClose: vi.fn(),
      onLog: vi.fn(),
    };
    const handler = createRuntimeOAuthHandler(options);

    const first = invoke(handler, "/callback?code=first&state=expected-state");
    await vi.waitFor(() => expect(exchangeFn).toHaveBeenCalledOnce());
    const second = await invoke(handler, "/callback?code=second&state=expected-state");
    expect(second.status).toBe(409);

    resolveExchange({ accessToken: "access", refreshToken: "refresh", expiresIn: 21600 });
    expect((await first).status).toBe(200);
    expect(executeFn).toHaveBeenCalledOnce();
    expect(gate.phase).toBe("completed");
  });

  it("does not execute after timeout aborts a pending exchange", async () => {
    const gate = new RuntimeOAuthGate("expected-state");
    const exchangeFn = vi.fn((_code: string, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("sensitive abort detail")), { once: true });
      }),
    );
    const executeFn = vi.fn();
    const options = {
      expectedHost: "127.0.0.1:54321",
      startUrl: "http://127.0.0.1:54321/start",
      config: {
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://127.0.0.1/callback",
        state: "expected-state",
      },
      gate,
      exchangeFn,
      executeFn,
      onClose: vi.fn(),
      onLog: vi.fn(),
    };
    const handler = createRuntimeOAuthHandler(options);

    const callback = invoke(handler, "/callback?code=first&state=expected-state");
    await vi.waitFor(() => expect(exchangeFn).toHaveBeenCalledOnce());
    gate.timeout();

    expect((await callback).status).toBe(408);
    expect(executeFn).not.toHaveBeenCalled();
    expect(options.onLog).toHaveBeenCalledWith("freee OAuth authorization timed out");
    expect(JSON.stringify(options.onLog.mock.calls)).not.toContain("sensitive abort detail");
  });
});
