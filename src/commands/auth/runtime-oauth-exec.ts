import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  exchangeAuthorizationCode,
  parseRuntimePlan,
  type RuntimeOAuthConfig,
} from "../../lib/runtime-oauth.js";
import { createRuntimeOAuthHandler } from "../../lib/runtime-oauth-http.js";
import { RuntimeOAuthGate, runRuntimePlan } from "../../lib/runtime-oauth-session.js";

const REDIRECT_URI = "http://127.0.0.1:54321/callback";
const START_URL = "http://127.0.0.1:54321/start";
const AUTH_TIMEOUT_MS = 15 * 60 * 1000;

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === "--") cliArgs.shift();
if (cliArgs.length !== 2 || cliArgs[0] !== "--plan") {
  throw new Error("Usage: runtime-oauth-exec -- --plan <validated-runtime-plan.json>");
}
const plan = parseRuntimePlan(readFileSync(cliArgs[1]!, "utf-8"));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliPath = fileURLToPath(new URL("../../cli.ts", import.meta.url));

const clientId = process.env.FREEE_CLIENT_ID;
const clientSecret = process.env.FREEE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  throw new Error("FREEE_CLIENT_ID and FREEE_CLIENT_SECRET are required");
}

const config: RuntimeOAuthConfig = {
  clientId,
  clientSecret,
  redirectUri: REDIRECT_URI,
  state: randomBytes(32).toString("base64url"),
};

const gate = new RuntimeOAuthGate(config.state);
let timeout: NodeJS.Timeout;
let server: ReturnType<typeof createServer>;
const handler = createRuntimeOAuthHandler({
  expectedHost: "127.0.0.1:54321",
  startUrl: START_URL,
  config,
  gate,
  exchangeFn: (code, signal) => exchangeAuthorizationCode(config, code, fetch, signal),
  executeFn: async (accessToken, _refreshToken, expiresIn, signal, onStarted) => {
    try {
      await runRuntimePlan(plan, accessToken, {
        cliPath,
        cwd: repoRoot,
        baseEnv: process.env,
        expiresIn,
        signal,
        onFirstSpawn: onStarted,
      });
      process.exitCode = 0;
    } catch (error) {
      process.exitCode = 1;
      throw error;
    }
  },
  onClose: () => {
    clearTimeout(timeout);
    server.close();
    if (gate.phase === "failed" || gate.phase === "timed_out") process.exitCode = 1;
  },
  onLog: (message) => console.error(message),
});
server = createServer(handler);

server.on("error", () => {
  console.error("freee OAuth listener failed to start");
  clearTimeout(timeout);
  process.exitCode = 1;
});

server.listen(54321, "127.0.0.1", () => {
  console.log(`freee OAuth listener ready: ${START_URL}`);
});

timeout = setTimeout(() => {
  gate.timeout();
  console.error("freee OAuth authorization timed out before runtime plan started");
  server.close();
  process.exitCode = 1;
}, AUTH_TIMEOUT_MS);
