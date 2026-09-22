import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  RuntimeOAuthGate,
  runExportPlan,
  runRuntimePlan,
  type ExportChild,
} from "../../src/lib/runtime-oauth-session.js";

describe("RuntimeOAuthGate", () => {
  it("allows only one valid callback to begin token exchange", () => {
    const gate = new RuntimeOAuthGate("expected-state");
    expect(
      gate.begin(new URL("http://127.0.0.1:54321/callback?code=first&state=expected-state")),
    ).toBe("first");
    expect(() =>
      gate.begin(new URL("http://127.0.0.1:54321/callback?code=second&state=expected-state")),
    ).toThrow("already in progress");
  });

  it("aborts pending exchange and cannot complete after timeout", () => {
    const gate = new RuntimeOAuthGate("expected-state");
    gate.begin(new URL("http://127.0.0.1:54321/callback?code=first&state=expected-state"));
    gate.timeout();
    expect(gate.signal.aborted).toBe(true);
    expect(gate.complete()).toBe(false);
    expect(gate.phase).toBe("timed_out");
  });
});

describe("runRuntimePlan", () => {
  it("runs allowlisted CLI routes sequentially with a safe env and no token argv leak", async () => {
    const calls: Array<{ executable: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const spawnFn = vi.fn((executable: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ executable, args: [...args], env: options.env });
      const child = new EventEmitter() as ExportChild;
      child.kill = vi.fn(() => true);
      queueMicrotask(() => {
        child.emit("spawn");
        child.emit("exit", 0, null);
      });
      return child;
    });
    const onFirstSpawn = vi.fn();

    await runRuntimePlan(
      [["companies", "list"], ["export", "receipts", "--month", "2026-07"]],
      "must-not-leak-access-token",
      {
        cliPath: "/repo/src/cli.ts",
        cwd: "/repo",
        baseEnv: { PATH: "/bin", GITHUB_TOKEN: "github-token-must-not-leak" },
        expiresIn: 21600,
        now: () => 1_000,
        spawnFn,
        onFirstSpawn,
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      executable: process.execPath,
      args: ["--import", "tsx", "/repo/src/cli.ts", "companies", "list"],
      env: { PATH: "/bin", FREEE_ACCESS_TOKEN: "must-not-leak-access-token" },
    });
    expect(calls[1]?.args).toEqual([
      "--import", "tsx", "/repo/src/cli.ts", "export", "receipts", "--month", "2026-07",
    ]);
    expect(JSON.stringify(calls)).not.toContain("github-token-must-not-leak");
    expect(JSON.stringify(calls.map(({ args }) => args))).not.toContain("must-not-leak-access-token");
    expect(onFirstSpawn).toHaveBeenCalledTimes(1);
  });

  it("prefixes export for legacy plans passed directly to runExportPlan", async () => {
    const calls: Array<{ args: string[] }> = [];
    const spawnFn = vi.fn((_executable: string, args: readonly string[]) => {
      calls.push({ args: [...args] });
      const child = new EventEmitter() as ExportChild;
      child.kill = vi.fn(() => true);
      queueMicrotask(() => {
        child.emit("spawn");
        child.emit("exit", 0, null);
      });
      return child;
    });
    await runExportPlan([["journals", "--month", "2026-07"]], "access-token", {
      cliPath: "/repo/src/cli.ts",
      cwd: "/repo",
      baseEnv: { PATH: "/bin" },
      expiresIn: 21600,
      now: () => 1_000,
      spawnFn,
    });
    expect(calls[0]?.args).toEqual(["--import", "tsx", "/repo/src/cli.ts", "export", "journals", "--month", "2026-07"]);
  });

  it("reports spawn errors before declaring authorization successful", async () => {
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter() as ExportChild;
      child.kill = vi.fn(() => true);
      queueMicrotask(() => child.emit("error", new Error("ENOENT secret detail")));
      return child;
    });
    const onFirstSpawn = vi.fn();

    await expect(
      runExportPlan([["journals"]], "access-token", {
        cliPath: "/repo/src/cli.ts",
        cwd: "/repo",
        baseEnv: {},
        expiresIn: 21600,
        now: () => 1_000,
        spawnFn,
        onFirstSpawn,
      }),
    ).rejects.toThrow("runtime plan child failed to start");
    expect(onFirstSpawn).not.toHaveBeenCalled();
  });

  it("terminates an in-flight child when the OAuth session times out", async () => {
    const abortController = new AbortController();
    let child!: ExportChild;
    const spawnFn = vi.fn(() => {
      child = new EventEmitter() as ExportChild;
      child.kill = vi.fn(() => {
        queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
        return true;
      });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    const execution = runExportPlan([["export", "journals"]], "access-token", {
      cliPath: "/repo/src/cli.ts",
      cwd: "/repo",
      baseEnv: {},
      expiresIn: 21600,
      spawnFn,
      signal: abortController.signal,
    });
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledOnce());
    abortController.abort();

    await expect(execution).rejects.toThrow("runtime plan was aborted");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
