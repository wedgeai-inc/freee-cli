import type { IncomingMessage, ServerResponse } from "node:http";
import { buildAuthorizationUrl, type RuntimeOAuthConfig } from "./runtime-oauth.js";
import { RuntimeOAuthGate } from "./runtime-oauth-session.js";

interface RuntimeTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface RuntimeOAuthHttpOptions {
  expectedHost: string;
  startUrl: string;
  config: RuntimeOAuthConfig;
  gate: RuntimeOAuthGate;
  exchangeFn: (code: string, signal: AbortSignal) => Promise<RuntimeTokens>;
  executeFn: (
    accessToken: string,
    refreshToken: string,
    expiresIn: number,
    signal: AbortSignal,
    onStarted: () => void,
  ) => Promise<void>;
  onClose: () => void;
  onLog: (message: string) => void;
}

const SAFE_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

export function createRuntimeOAuthHandler(options: RuntimeOAuthHttpOptions) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestUrl = new URL(request.url ?? "/", options.startUrl);
    if (request.method !== "GET" || request.headers.host !== options.expectedHost) {
      respond(response, 400, "Invalid local request.\n");
      return;
    }
    if (requestUrl.pathname === "/start") {
      if (options.gate.phase !== "pending") {
        respond(response, 409, "Authorization is already in progress or completed.\n");
        return;
      }
      response.writeHead(302, {
        Location: buildAuthorizationUrl(options.config),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      response.end();
      return;
    }
    if (requestUrl.pathname !== "/callback") {
      respond(response, 404, "Not found\n");
      return;
    }

    let code: string;
    try {
      code = options.gate.begin(requestUrl);
    } catch {
      respond(
        response,
        options.gate.phase === "pending" ? 400 : 409,
        "freee authorization callback was rejected.\n",
      );
      return;
    }

    try {
      const tokens = await options.exchangeFn(code, options.gate.signal);
      let startedResolve!: () => void;
      let startedReject!: (error: Error) => void;
      const started = new Promise<void>((resolve, reject) => {
        startedResolve = resolve;
        startedReject = reject;
      });
      const execution = options.executeFn(
        tokens.accessToken,
        tokens.refreshToken,
        tokens.expiresIn,
        options.gate.signal,
        startedResolve,
      );
      void execution.then(
        () => undefined,
        (error: unknown) => {
          startedReject(error instanceof Error ? error : new Error("runtime plan failed"));
          options.onLog("freee runtime plan failed");
        },
      );
      await started;
      if (!options.gate.complete()) throw new Error("freee authorization session expired");
      respond(
        response,
        200,
        "freee authorization succeeded and the validated runtime plan started. You can return to the terminal.\n",
      );
      options.onClose();
    } catch {
      const timedOut = options.gate.phase === "timed_out";
      if (options.gate.phase === "exchanging") options.gate.fail();
      options.onLog(timedOut ? "freee OAuth authorization timed out" : "freee OAuth callback failed");
      respond(response, timedOut ? 408 : 400, "freee authorization failed. Return to the terminal and retry.\n");
      if (options.gate.phase === "failed" || timedOut) options.onClose();
    }
  };
}

function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, SAFE_HEADERS);
  response.end(body);
}
