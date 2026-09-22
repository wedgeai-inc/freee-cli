import { spawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { buildChildEnvironment, extractAuthorizationCode, normalizeLegacyExportCommand, type RuntimePlan } from "./runtime-oauth.js";

export type RuntimeOAuthPhase = "pending" | "exchanging" | "completed" | "failed" | "timed_out";

export class RuntimeOAuthGate {
  #phase: RuntimeOAuthPhase = "pending";
  readonly #state: string;
  readonly #abortController = new AbortController();

  constructor(state: string) {
    this.#state = state;
  }

  get phase(): RuntimeOAuthPhase {
    return this.#phase;
  }

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  begin(callbackUrl: URL): string {
    if (this.#phase !== "pending") {
      throw new Error("freee authorization is already in progress or completed");
    }
    const code = extractAuthorizationCode(callbackUrl, this.#state);
    this.#phase = "exchanging";
    return code;
  }

  complete(): boolean {
    if (this.#phase !== "exchanging") return false;
    this.#phase = "completed";
    return true;
  }

  fail(): void {
    if (this.#phase === "pending" || this.#phase === "exchanging") this.#phase = "failed";
  }

  timeout(): void {
    if (this.#phase !== "pending" && this.#phase !== "exchanging") return;
    this.#phase = "timed_out";
    this.#abortController.abort();
  }
}

export interface ExportChild extends EventEmitter {
  kill(signal?: NodeJS.Signals): boolean;
}

export type ExportSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ExportChild;

export interface ExportPlanRunnerOptions {
  cliPath: string;
  cwd: string;
  baseEnv: NodeJS.ProcessEnv;
  expiresIn: number;
  now?: () => number;
  spawnFn?: ExportSpawn;
  onFirstSpawn?: () => void;
  signal?: AbortSignal;
}

export async function runRuntimePlan(
  plan: RuntimePlan,
  accessToken: string,
  options: ExportPlanRunnerOptions,
): Promise<void> {
  const now = options.now ?? Date.now;
  const spawnFn = options.spawnFn ?? (spawn as unknown as ExportSpawn);
  const expiresAt = now() + options.expiresIn * 1000;
  let firstSpawned = false;

  for (const command of plan) {
    if (options.signal?.aborted) throw new Error("freee runtime plan was aborted");
    const remainingMs = expiresAt - now();
    if (remainingMs <= 0) throw new Error("freee access token expired before runtime plan completed");
    await runOneRuntimeCommand(command, accessToken, remainingMs, options, spawnFn, () => {
      if (!firstSpawned) {
        firstSpawned = true;
        options.onFirstSpawn?.();
      }
    });
  }
}

/**
 * 旧 API 互換。旧 runExportPlan は "export" 前置の無い plan（[["journals",...]]）を受け取り
 * `export journals` として起動していた。runRuntimePlan は前置しないので、ここで正規化してから渡す。
 */
export async function runExportPlan(
  plan: RuntimePlan,
  accessToken: string,
  options: ExportPlanRunnerOptions,
): Promise<void> {
  return runRuntimePlan(plan.map(normalizeLegacyExportCommand), accessToken, options);
}

async function runOneRuntimeCommand(
  command: string[],
  accessToken: string,
  remainingMs: number,
  options: ExportPlanRunnerOptions,
  spawnFn: ExportSpawn,
  onSpawn: () => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnFn(
      process.execPath,
      ["--import", "tsx", options.cliPath, ...command],
      {
        cwd: options.cwd,
        env: buildChildEnvironment(options.baseEnv, accessToken),
        stdio: "inherit",
      },
    );
    let spawned = false;
    let expired = false;
    const expiryTimer = setTimeout(() => {
      expired = true;
      child.kill("SIGTERM");
    }, remainingMs);
    expiryTimer.unref();
    const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal);
    const onSigint = () => forwardSignal("SIGINT");
    const onSigterm = () => forwardSignal("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    const onAbort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(expiryTimer);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.once("spawn", () => {
      spawned = true;
      onSpawn();
    });
    child.once("error", () => {
      cleanup();
      reject(new Error(spawned ? "runtime plan child process failed" : "runtime plan child failed to start"));
    });
    child.once("exit", (code: number | null) => {
      cleanup();
      if (options.signal?.aborted) {
        reject(new Error("freee runtime plan was aborted"));
      } else if (expired) {
        reject(new Error("freee access token expired during runtime plan"));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`runtime plan child exited with code ${code ?? "signal"}`));
      }
    });
  });
}
