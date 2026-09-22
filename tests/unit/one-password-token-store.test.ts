import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { buildOpSpawnArgs, createPipelineKill, killProcessGroup, OnePasswordTokenStore, spawnOpChild, getOAuthItemReference, getOAuthVault, runOp, type OpChild } from "../../src/lib/one-password-token-store.js";
import { loadApiAuth } from "../../src/lib/token-config-loader.js";
import { exchangeAuthorizationCode } from "../../src/lib/runtime-oauth.js";
import { persistInitialOAuthTokens } from "../../src/commands/auth/oauth-login.js";

describe("OnePasswordTokenStore", () => {
  it("builds an op invocation that interposes cat so stdin is a real FIFO", () => {
    // op は stdin が FIFO のときだけ template として読む。Node の spawn が渡す stdin は
    // macOS では socketpair になり、op は exit 0 と version 更新を返しながら field の値を
    // 更新しない（実測）。cat を挟んで本物の FIFO を作る
    const built = buildOpSpawnArgs(["item", "edit", "injected-reference-a", "--vault", "injected-vault"]);
    expect(built.command).toBe("/bin/sh");
    expect(built.argv).toEqual([
      "-c", 'exec /bin/cat | "$@"', "op", "op",
      "item", "edit", "injected-reference-a", "--vault", "injected-vault",
    ]);
    // detached を外すと timeout 時に pipeline の op が生き残る
    expect(built.options).toEqual({ stdio: ["pipe", "pipe", "ignore"], detached: true });
  });

  it("gives op a real FIFO on stdin (a socketpair makes op silently ignore the template)", async () => {
    // op は stdin が FIFO のときだけ template として読む。Node の spawn が渡す
    // stdin は macOS では socketpair になり、op は exit 0 と version 更新を返しながら
    // field の値を更新しない。実装は cat を挟んで FIFO を作る
    const { spawn } = await import("node:child_process");
    const observed = await new Promise<string>((resolve) => {
      // 実装と同じ形で子を起動し、子から見た stdin の種類を報告させる
      // 実装が組み立てる argv の "op" を、stdin の種類を報告する sh へ差し替えて実行する
      const built = buildOpSpawnArgs([
        "-c", 'if [ -p /dev/stdin ]; then echo FIFO; elif [ -S /dev/stdin ]; then echo SOCKET; else echo OTHER; fi; cat >/dev/null',
      ]);
      const argv = built.argv.map((a, i) => (i === 3 ? "/bin/sh" : a));
      const child = spawn(built.command, argv, { stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
      child.once("close", () => resolve(out.trim()));
      child.stdin.end("payload");
    });
    expect(observed).toBe("FIFO");
  });

  it("wires plan → spawn → timeout → group kill end to end (real spawn through runOp)", async () => {
    // 部品を個別に固定するだけでは、配線（spawnOpChild の kill 差し替え）を
    // 外しても通ってしまう。runOp の timeout 経路が実際にグループ kill を
    // 使うことを、実 spawn で 1 本に繋いで確かめる
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "op-wiring-"));
    const pidFile = join(dir, "survivor.pid");
    try {
      await expect(
        runOp([`-c`, `echo $$ > ${pidFile}; sleep 20`], undefined, {
          // 実 op を起動しないよう executable だけ差し替え、配線は本物を使う
          spawnFn: (a) => spawnOpChild(a, "/bin/sh"),
          timeoutMs: 1_500,
        }),
      ).rejects.toThrow(/timed out/i);

      const recorded = Number.parseInt(await readFile(pidFile, "utf8").catch(() => "0"), 10) || 0;
      expect(recorded).toBeGreaterThan(1);
      let alive = true;
      for (let i = 0; i < 60 && alive; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try { process.kill(recorded, 0); } catch { alive = false; }
      }
      expect(alive).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("forwards SIGINT to the pipeline and still lets the parent exit (subprocess e2e)", async () => {
    // 転送ハンドラは自分へシグナルを送り直すため、同一プロセスで emit すると
    // テストランナーごと落ちる。別プロセスで実際に SIGINT を送って確かめる
    const { spawn } = await import("node:child_process");
    const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "op-sigint-e2e-"));
    const pidFile = join(dir, "grandchild.pid");
    const script = join(dir, "run.mts");
    const storeUrl = fileURLToPath(new URL("../../src/lib/one-password-token-store.ts", import.meta.url));
    await writeFile(script, [
      `import { runOp, spawnOpChild } from ${JSON.stringify(storeUrl)};`,
      `runOp(["-c", "echo $$ > ${pidFile}; sleep 30"], undefined, {`,
      `  spawnFn: (a) => spawnOpChild(a, "/bin/sh"), timeoutMs: 60000,`,
      `}).catch(() => {});`,
      `setInterval(() => {}, 10000);`,
    ].join("\n"));
    // npx を挟むと close を観測する相手が npx になり、「親が終了する」半分が
    // 再送の有無にかかわらず成立してしまう。store を動かすプロセスを直接観測する
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: "ignore", cwd: repoRoot });
    try {
      let grandchild = 0;
      for (let i = 0; i < 150 && grandchild === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
        grandchild = Number.parseInt(await readFile(pidFile, "utf8").catch(() => "0"), 10) || 0;
      }
      expect(grandchild).toBeGreaterThan(1);

      const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGINT");

      // 親が既定どおり終了すること（ハンドラ登録で終了動作を殺していないこと）
      await Promise.race([exited, new Promise((_, r) => setTimeout(() => r(new Error("親が終了しない")), 10_000))]);

      // 右辺が消えること（転送が届いていること）
      let alive = true;
      for (let i = 0; i < 100 && alive; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try { process.kill(grandchild, 0); } catch { alive = false; }
      }
      expect(alive, "SIGINT が pipeline へ転送されていない").toBe(false);
    } finally {
      try { child.kill("SIGKILL"); } catch { /* 既に終了 */ }
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
  it("forwards every shutdown signal it registers, not just SIGINT", () => {
    // service 停止で実際に飛ぶのは SIGTERM。SIGINT だけ見ていると
    // forwarded から SIGTERM / SIGHUP を落としても検出できない
    const before = new Map(
      (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((s) => [s, process.listenerCount(s)]),
    );
    const pending = runOp(["-c", "sleep 0.3"], undefined, {
      spawnFn: (a) => spawnOpChild(a, "/bin/sh"),
      timeoutMs: 30_000,
    });
    pending.catch(() => undefined);
    for (const [signal, count] of before) {
      expect(process.listenerCount(signal), `${signal} が転送対象に含まれていない`).toBe(count + 1);
    }
    return pending.catch(() => undefined).then(() => {
      for (const [signal, count] of before) expect(process.listenerCount(signal)).toBe(count);
    });
  }, 30_000);

  it("escalates to SIGKILL on the signal path too, before the parent exits", async () => {
    // 転送直後に自分へ再送すると親が即死し、SIGTERM を無視する子への昇格が
    // 発火しないまま op が生き残る。pipeline が消えるまで再送を待つことを確かめる
    const { spawn } = await import("node:child_process");
    const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "op-sig-escalate-"));
    const pidFile = join(dir, "grandchild.pid");
    const script = join(dir, "run.mts");
    const storeUrl = fileURLToPath(new URL("../../src/lib/one-password-token-store.ts", import.meta.url));
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    await writeFile(script, [
      `import { runOp, spawnOpChild } from ${JSON.stringify(storeUrl)};`,
      `runOp(["-c", "trap '' INT TERM; echo $$ > ${pidFile}; sleep 30"], undefined, {`,
      `  spawnFn: (a) => spawnOpChild(a, "/bin/sh"), timeoutMs: 60000,`,
      `}).catch(() => {});`,
      `setInterval(() => {}, 10000);`,
    ].join("\n"));
    const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: "ignore", cwd: repoRoot });
    try {
      let grandchild = 0;
      for (let i = 0; i < 150 && grandchild === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
        grandchild = Number.parseInt(await readFile(pidFile, "utf8").catch(() => "0"), 10) || 0;
      }
      expect(grandchild).toBeGreaterThan(1);

      const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGINT");
      await Promise.race([exited, new Promise((_, r) => setTimeout(() => r(new Error("親が終了しない")), 15_000))]);

      // SIGTERM を無視する子でも、昇格によって落ちていること
      let alive = true;
      for (let i = 0; i < 100 && alive; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try { process.kill(grandchild, 0); } catch { alive = false; }
      }
      expect(alive, "停止シグナル経路で SIGKILL 昇格が発火していない").toBe(false);
    } finally {
      try { child.kill("SIGKILL"); } catch { /* 既に終了 */ }
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("waits for every concurrent pipeline before letting the parent exit", async () => {
    // pipeline ごとに handler を持つと、先に閉じた 1 本が親を終了させ、
    // SIGTERM を無視する別の pipeline は昇格を受けないまま生き残る
    const { spawn } = await import("node:child_process");
    const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "op-concurrent-"));
    const stubbornPid = join(dir, "stubborn.pid");
    const script = join(dir, "run.mts");
    const storeUrl = fileURLToPath(new URL("../../src/lib/one-password-token-store.ts", import.meta.url));
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    await writeFile(script, [
      `import { runOp, spawnOpChild } from ${JSON.stringify(storeUrl)};`,
      `const sh = (a: readonly string[]) => spawnOpChild(a, "/bin/sh");`,
      // シグナルで即座に閉じる 1 本。これが単独で親を終了させると、下の 1 本が残る
      `runOp(["-c", "sleep 30"], undefined, { spawnFn: sh, timeoutMs: 60000 }).catch(() => {});`,
      `runOp(["-c", "trap '' INT TERM; echo $$ > ${stubbornPid}; sleep 30"], undefined, {`,
      `  spawnFn: sh, timeoutMs: 60000,`,
      `}).catch(() => {});`,
      `setInterval(() => {}, 10000);`,
    ].join("\n"));
    const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: "ignore", cwd: repoRoot });
    try {
      let stubborn = 0;
      for (let i = 0; i < 150 && stubborn === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
        stubborn = Number.parseInt(await readFile(stubbornPid, "utf8").catch(() => "0"), 10) || 0;
      }
      expect(stubborn).toBeGreaterThan(1);
      const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGINT");
      await Promise.race([exited, new Promise((_, r) => setTimeout(() => r(new Error("親が終了しない")), 15_000))]);

      let alive = true;
      for (let i = 0; i < 100 && alive; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try { process.kill(stubborn, 0); } catch { alive = false; }
      }
      expect(alive, "並行する別 pipeline が昇格を受けずに生き残っている").toBe(false);
    } finally {
      try { child.kill("SIGKILL"); } catch { /* 既に終了 */ }
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("does not re-raise when the host app owns the signal", async () => {
    // 自己再送は「自分の handler を外したので既定へ戻す」ための手段でしかない。
    // 呼び出し側が listener を持つ場合、再送するとそれが 2 回発火する
    const { spawn } = await import("node:child_process");
    const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "op-host-signal-"));
    const hits = join(dir, "hits");
    const script = join(dir, "run.mts");
    const storeUrl = fileURLToPath(new URL("../../src/lib/one-password-token-store.ts", import.meta.url));
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    await writeFile(script, [
      `import { appendFileSync } from "node:fs";`,
      `import { runOp, spawnOpChild } from ${JSON.stringify(storeUrl)};`,
      // 呼び出し側が持つ listener。受信のたびに 1 行足す
      `process.on("SIGINT", () => { appendFileSync(${JSON.stringify(hits)}, "x\\n"); });`,
      `runOp(["-c", "sleep 30"], undefined, {`,
      `  spawnFn: (a) => spawnOpChild(a, "/bin/sh"), timeoutMs: 60000,`,
      `}).catch(() => {});`,
      `setInterval(() => {}, 10000);`,
    ].join("\n"));
    const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: "ignore", cwd: repoRoot });
    try {
      await new Promise((r) => setTimeout(r, 1500));
      child.kill("SIGINT");
      await new Promise((r) => setTimeout(r, 3500));
      const count = (await readFile(hits, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
      expect(count, "呼び出し側の listener が 2 回発火している").toBe(1);
    } finally {
      try { child.kill("SIGKILL"); } catch { /* 既に終了 */ }
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("tears down the pipeline when it fails for a non-timeout reason", async () => {
    // timeout を消し転送も外したあと、失敗経路で pipeline を放置すると
    // 止める仕掛けが何も残らず、op が動き続けて書き込みを完了しうる
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "op-nontimeout-"));
    const pidFile = join(dir, "survivor.pid");
    try {
      await expect(
        runOp([`-c`, `echo $$ > ${pidFile}; sleep 25`], undefined, {
          spawnFn: (a) => {
            const child = spawnOpChild(a, "/bin/sh");
            // timeout ではない失敗（child の error）を誘発する。
            // stdin は end 済みなので destroy しても error は出ない
            setTimeout(() => { child.emit("error", new Error("induced")); }, 400);
            return child;
          },
          timeoutMs: 30_000,   // timeout では落ちない長さ
        }),
      ).rejects.toThrow("op command failed");

      const recorded = Number.parseInt(await readFile(pidFile, "utf8").catch(() => "0"), 10) || 0;
      expect(recorded).toBeGreaterThan(1);
      let alive = true;
      for (let i = 0; i < 80 && alive; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try { process.kill(recorded, 0); } catch { alive = false; }
      }
      expect(alive, "失敗報告後も pipeline が生き残っている").toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 40_000);

  it("escalates to SIGKILL when the pipeline ignores SIGTERM", async () => {
    // SIGTERM を無視する子には escalation が無いと生き残る
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "op-escalate-"));
    const pidFile = join(dir, "survivor.pid");
    try {
      await expect(
        runOp([`-c`, `trap '' TERM; echo $$ > ${pidFile}; sleep 20`], undefined, {
          spawnFn: (a) => spawnOpChild(a, "/bin/sh"),
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow("op command timed out");
      const recorded = Number.parseInt(await readFile(pidFile, "utf8").catch(() => "0"), 10) || 0;
      expect(recorded).toBeGreaterThan(1);
      let alive = true;
      for (let i = 0; i < 100 && alive; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try { process.kill(recorded, 0); } catch { alive = false; }
      }
      expect(alive, "SIGTERM を無視した子が SIGKILL で落ちていない").toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("propagates the right-hand exit code of the pipeline (not cat's)", async () => {
    await expect(
      runOp(["-c", "exit 3"], undefined, { spawnFn: (a) => spawnOpChild(a, "/bin/sh") }),
    ).rejects.toThrow("op command failed");   // timeout でも stdin 失敗でもなく、右辺の非 0 終了で落ちる
  }, 15_000);

  it("does not recurse when the group kill falls back to the child kill", () => {
    // 単体: 差し替え前の kill を渡していれば 1 回だけ呼ばれる
    let calls = 0;
    const original = { kill: () => { calls += 1; return true; } };
    expect(killProcessGroup(undefined, "SIGTERM", original, true)).toBe(true);
    expect(killProcessGroup(12_345, "SIGTERM", original, false)).toBe(true);
    expect(calls).toBe(2);
  });

  it("calls the pre-replacement kill exactly once when the group kill fails (no recursion)", () => {
    // wrapped と child は同一オブジェクト。差し替え後の kill を fallback へ渡すと
    // 自分を再び呼び無限再帰する。group kill を失敗させて fallback を必ず通す
    let originalCalls = 0;
    const kill = createPipelineKill({
      pid: 4_242,
      detached: true,
      originalKill: () => { originalCalls += 1; return true; },
      isExited: () => false,
      killGroup: (_pid, signal, child) => child.kill(signal),   // 常に fallback へ落とす
    });
    expect(kill("SIGTERM")).toBe(true);
    expect(originalCalls).toBe(1);
  });

  it("does not touch the process group once the child has exited (stale pid reuse)", () => {
    let groupCalls = 0;
    let originalCalls = 0;
    const kill = createPipelineKill({
      pid: 4_242,
      detached: true,
      originalKill: () => { originalCalls += 1; return true; },
      isExited: () => true,
      killGroup: () => { groupCalls += 1; return true; },
    });
    expect(kill("SIGTERM")).toBe(false);
    expect(groupCalls).toBe(0);
    expect(originalCalls).toBe(0);
  });
  it("kills the whole pipeline on timeout, not just the sh wrapper (real spawn)", async () => {
    // child が /bin/sh になったため child.kill() は wrapper にしか届かず、
    // pipeline の op が生き残って timeout 後に書き込みを完了しうる。
    // detached でプロセスグループを作り、グループごと落とすことを実 spawn で確かめる
    const { spawn } = await import("node:child_process");
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "op-killgroup-"));
    const pidFile = join(dir, "survivor.pid");
    try {
      const built = buildOpSpawnArgs(["-c", `echo $$ > ${pidFile}; sleep 20`]);
      // 実装が組み立てた argv の "op"（$1）を /bin/sh へ差し替えて起動する
      const argv = built.argv.map((a, i) => (i === 3 ? "/bin/sh" : a));
      const child = spawn(built.command, argv, built.options);
      child.stdin?.end("payload");
      // 右辺が pid を書くまで待つ
      let recorded = 0;
      for (let i = 0; i < 60 && recorded === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
        recorded = Number.parseInt(await readFile(pidFile, "utf8").catch(() => "0"), 10) || 0;
      }
      expect(recorded).toBeGreaterThan(1);

      // 実装が使う関数をそのまま通す（直接 process.kill(-pid) すると実装の kill 経路を検査できない）
      expect(child.pid).toBeTruthy();
      expect(killProcessGroup(child.pid, "SIGTERM", child, true)).toBe(true);   // 実装と同じく detached を明示

      let alive = true;
      for (let i = 0; i < 60 && alive; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try { process.kill(recorded, 0); } catch { alive = false; }
      }
      expect(alive).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("passes stdin through without altering it", async () => {
    const { spawn } = await import("node:child_process");
    const received = await new Promise<string>((resolve) => {
      const built = buildOpSpawnArgs([]);
      const argv = built.argv.map((a, i) => (i === 3 ? "/bin/cat" : a));
      const child = spawn(built.command, argv, { stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
      child.once("close", () => resolve(out));
      child.stdin.end('{"fields":[]}\n');
    });
    expect(received).toBe('{"fields":[]}\n');
  });


  it("passes --vault to both get and edit when a vault is injected (service account requires it)", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[1] === "get") {
        return { stdout: JSON.stringify({ fields: [
          { label: "access_token", value: "a" },
          { label: "refresh_token", value: "r" },
          { label: "expires_at", value: "42" },
        ] }) };
      }
      return { stdout: "" };
    });
    const store = new OnePasswordTokenStore({
      run,
      resolveItem: () => "injected-reference-a",
      resolveVault: () => "injected-vault",
    });
    await store.save("alpha", { accessToken: "a", refreshToken: "r", expiresAt: 42 });
    // get / edit / read-back の 3 回すべてに --vault が付く
    expect(calls).toHaveLength(3);
    // get / edit / read-back の 3 回とも argv を完全一致で固定する
    const expectedGet = ["item", "get", "injected-reference-a", "--format", "json", "--reveal", "--vault", "injected-vault"];
    expect(calls[0]).toEqual(expectedGet);
    expect(calls[1]).toEqual(["item", "edit", "injected-reference-a", "--vault", "injected-vault"]);
    expect(calls[2]).toEqual(expectedGet);
  });

  it("passes --vault on the load path too (highest-frequency call)", async () => {
    // load は認証付き全コマンドの最初の op 呼び出し。ここが欠けると
    // service account 環境で全コマンドが "a vault query must be provided" で落ちる
    const calls: string[][] = [];
    const run = vi.fn(async (args: readonly string[]) => {
      calls.push([...args]);
      return { stdout: JSON.stringify({ fields: [
        { label: "access_token", value: "a" },
        { label: "refresh_token", value: "r" },
        { label: "expires_at", value: "42" },
      ] }) };
    });
    const store = new OnePasswordTokenStore({
      run,
      resolveItem: () => "injected-reference-a",
      resolveVault: () => "injected-vault",
    });
    await store.load("alpha");
    expect(calls[0]).toEqual([
      "item", "get", "injected-reference-a", "--format", "json", "--reveal", "--vault", "injected-vault",
    ]);
  });

  it("omits --vault when none is injected (personal account)", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (args: readonly string[]) => {
      calls.push([...args]);
      return { stdout: JSON.stringify({ fields: [
        { label: "access_token", value: "a" },
        { label: "refresh_token", value: "r" },
        { label: "expires_at", value: "42" },
      ] }) };
    });
    const store = new OnePasswordTokenStore({
      run,
      resolveItem: () => "injected-reference-a",
      resolveVault: () => undefined,
    });
    await store.load("alpha");
    expect(calls[0]).not.toContain("--vault");
  });

  it("reads the vault from the injected per-profile environment variable", () => {
    expect(getOAuthVault("acme", { FREEE_OAUTH_VAULT_ACME: "injected-vault" })).toBe("injected-vault");
    expect(getOAuthVault("acme-a", { FREEE_OAUTH_VAULT_ACME_A: " injected-vault " })).toBe("injected-vault");
    expect(getOAuthVault("acme", {})).toBeUndefined();
    expect(getOAuthVault("acme", { FREEE_OAUTH_VAULT_ACME: "  " })).toBeUndefined();
    expect(() => getOAuthVault("Acme", {})).toThrow("freee OAuth profile is invalid");
  });


  it("rejects profiles that would collide in the injected environment variable name", () => {
    // 大文字化 + "-"→"_" の生成規則では acme-a / acme_a / ACME_A が同名になる。
    // 小文字とハイフンだけを受理して単射にする
    for (const invalid of ["acme_a", "ACME_A", "Acme-A", "-acme", "acme a", ""]) {
      expect(() => getOAuthItemReference(invalid, {})).toThrow("freee OAuth profile is invalid");
    }
    expect(() => getOAuthItemReference("acme-a", {})).toThrow(
      "freee OAuth token store is not configured for this profile",
    );
    // 戻り値の trim も vault 側と対称に固定する（前後空白付きの注入で op の参照解決が失敗する）
    expect(getOAuthItemReference("acme", { FREEE_OAUTH_ITEM_REFERENCE_ACME: " ref " })).toBe("ref");
    // 同じ検証を vault 側にも当てる（片方だけ緩めても落ちるようにする）
    for (const invalid of ["acme_a", "ACME_A", "Acme-A", "-acme", "acme a", ""]) {
      expect(() => getOAuthVault(invalid, {})).toThrow("freee OAuth profile is invalid");
    }
  });

  it("never writes token, secret or authorization code to stdout, stderr or logs (refresh and code-exchange paths)", async () => {
    const SECRETS = [
      "sentinel-old-refresh",
      "sentinel-new-access",
      "sentinel-new-refresh",
      "sentinel-client-secret",
      "sentinel-auth-code",
    ];
    const captured: string[] = [];
    const push = (chunk: unknown) => { captured.push(String(chunk)); return true; };
    const spyOut = vi.spyOn(process.stdout, "write").mockImplementation(push as never);
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(push as never);
    const spyLog = vi.spyOn(console, "log").mockImplementation((...a) => { captured.push(a.join(" ")); });
    const spyErrLog = vi.spyOn(console, "error").mockImplementation((...a) => { captured.push(a.join(" ")); });
    const spyWarn = vi.spyOn(console, "warn").mockImplementation((...a) => { captured.push(a.join(" ")); });
    try {
      // 1) refresh 経路: 旧 refresh token と client secret を実際に投入し、新 token を受け取る
      const store = {
        load: vi.fn(async () => ({ accessToken: "expired", refreshToken: "sentinel-old-refresh", expiresAt: 1 })),
        save: vi.fn(async () => undefined),
      };
      const result = await loadApiAuth({
        tokenStore: store,
        profile: "alpha",
        env: { FREEE_CLIENT_ID: "client", FREEE_CLIENT_SECRET: "sentinel-client-secret" },
        now: () => 1_000_000,
        fetchFn: async (_url, init) => {
          // 送信 body にも secret が載るが、これは freee への送信であって出力ではない
          captured.push(`fetch-called:${typeof (init as RequestInit)?.body}`);
          return new Response(
            JSON.stringify({ access_token: "sentinel-new-access", refresh_token: "sentinel-new-refresh", expires_in: 21600 }),
            { status: 200 },
          );
        },
      });
      expect(result.accessToken).toBe("sentinel-new-access");
      expect(store.save).toHaveBeenCalled();

      // 2) 認可コード交換の経路: 認可コードと client secret を実際に投入する
      const exchanged = await exchangeAuthorizationCode(
        { clientId: "client", clientSecret: "sentinel-client-secret", redirectUri: "http://127.0.0.1:54321/callback", state: "s" },
        "sentinel-auth-code",
        (async () => new Response(
          JSON.stringify({ access_token: "sentinel-new-access", refresh_token: "sentinel-new-refresh", expires_in: 21600 }),
          { status: 200 },
        )) as unknown as typeof fetch,
      );
      expect(exchanged.accessToken).toBe("sentinel-new-access");

      // 3) 実 store.save の経路: rotate 後の refresh token を実際に書き戻す
      const realStore = new OnePasswordTokenStore({
        run: async (args) => {
          captured.push(args.join(" "));
          if (args[1] === "get") {
            return { stdout: JSON.stringify({ fields: [
              { label: "access_token", value: "sentinel-new-access" },
              { label: "refresh_token", value: "sentinel-new-refresh" },
              { label: "expires_at", value: "1234567890" },
            ] }) };
          }
          return { stdout: "" };
        },
        resolveItem: () => "injected-reference-a",
        resolveVault: () => undefined,   // 実行環境の FREEE_OAUTH_VAULT_* から隔離する
      });
      await realStore.save("alpha", {
        accessToken: "sentinel-new-access",
        refreshToken: "sentinel-new-refresh",
        expiresAt: 1234567890,
      });

      // 4) 初回認可の保存経路
      await persistInitialOAuthTokens(
        { save: async () => undefined },
        "alpha",
        { accessToken: "sentinel-new-access", refreshToken: "sentinel-new-refresh", expiresIn: 21600 },
        () => 1_000_000,
      );
    } finally {
      spyOut.mockRestore(); spyErr.mockRestore(); spyLog.mockRestore(); spyErrLog.mockRestore(); spyWarn.mockRestore();
    }
    const haystack = captured.join("\n");
    for (const secret of SECRETS) expect(haystack).not.toContain(secret);
  });

  it("keeps the refresh path free of any process-launching capability (no automatic browser launch)", async () => {
    const store = {
      load: vi.fn(async () => ({ accessToken: "expired", refreshToken: "old", expiresAt: 1 })),
      save: vi.fn(),
    };
    const error = await loadApiAuth({
      tokenStore: store,
      profile: "alpha",
      env: { FREEE_CLIENT_ID: "client", FREEE_CLIENT_SECRET: "secret" },
      now: () => 1_000_000,
      fetchFn: async () => new Response("{}", { status: 401 }),
    }).catch((cause: unknown) => cause);
    // 再認可を促すだけで、勝手にブラウザを開かない
    expect((error as Error).message).toContain("freee auth login");
    expect(store.save).not.toHaveBeenCalled();

    // ESM では spawn を spy できないため、refresh 経路のモジュールが
    // プロセス起動やブラウザ起動の手段を持たないことを静的に固定する。
    // 自動起動を足すには、まずこれらの import が必要になる
    const source = await readFile(new URL("../../src/lib/token-config-loader.ts", import.meta.url), "utf8");
    for (const forbidden of ["node:child_process", "child_process", "xdg-open", "openExternal"]) {
      expect(source).not.toContain(forbidden);
    }
  });
  it("loads the token bundle through the injected profile reference", async () => {
    const run = vi.fn(async () => ({ stdout: JSON.stringify({ fields: [
      { label: "access_token", value: "access" },
      { label: "refresh_token", value: "refresh" },
      { label: "expires_at", value: "21600000" },
    ] }) }));
    const resolveItem = vi.fn(() => "injected-reference-a");
    // 実行環境の FREEE_OAUTH_VAULT_* から隔離する（設定されていると argv の期待値が変わる）
    const store = new OnePasswordTokenStore({ run, resolveItem, resolveVault: () => undefined });

    await expect(store.load("alpha")).resolves.toEqual({ accessToken: "access", refreshToken: "refresh", expiresAt: 21600000 });
    expect(resolveItem).toHaveBeenCalledWith("alpha");
    expect(run).toHaveBeenCalledWith(["item", "get", "injected-reference-a", "--format", "json", "--reveal"]);
  });

  it("writes a minimal fields-only template through stdin, preserves unrelated fields, and reads it back", async () => {
    const writes: Array<{ args: readonly string[]; stdin?: string }> = [];
    const original = { fields: [
      { label: "access_token", value: "old-access" },
      { label: "refresh_token", value: "old-refresh" },
      { label: "expires_at", value: "1" },
      { label: "unrelated", value: "retain-me", section: { id: "section-id" } },
    ], id: "read-only-id", category: "LOGIN", vault: { id: "read-only-vault" } };
    const run = vi.fn(async (args: readonly string[], stdin?: string) => {
      writes.push({ args, stdin });
      if (args[1] === "get") return { stdout: JSON.stringify({ ...original, fields: args === writes[0]?.args ? original.fields : [
        { label: "access_token", value: "new-access" },
        { label: "refresh_token", value: "new-refresh" },
        { label: "expires_at", value: "21600000" },
        { label: "unrelated", value: "retain-me", section: { id: "section-id" } },
      ] }) };
      return { stdout: "" };
    });
    const store = new OnePasswordTokenStore({ run, resolveItem: () => "injected-reference-a", resolveVault: () => undefined });

    await store.save("alpha", { accessToken: "new-access", refreshToken: "new-refresh", expiresAt: 21600000 });

    const edit = writes[1]!;
    expect(edit.args).toEqual(["item", "edit", "injected-reference-a"]);
    expect(JSON.stringify(edit.args)).not.toContain("new-access");
    expect(JSON.stringify(edit.args)).not.toContain("new-refresh");
    expect(edit.stdin).toContain("new-access");
    expect(edit.stdin).toContain("new-refresh");
    const template = JSON.parse(edit.stdin ?? "{}") as { fields?: Array<{ label: string; value: string }> };
    expect(Object.keys(template)).toEqual(["fields"]);
    expect(template.fields).toContainEqual({ label: "unrelated", value: "retain-me", section: { id: "section-id" } });
    expect(writes[2]?.args).toEqual(["item", "get", "injected-reference-a", "--format", "json", "--reveal"]);
  });

  it("fails closed when read-back does not match the rotated token bundle", async () => {
    let getCount = 0;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[1] === "edit") return { stdout: "" };
      getCount += 1;
      return { stdout: JSON.stringify({ fields: [
        { label: "access_token", value: "new-access" },
        { label: "refresh_token", value: getCount === 1 ? "old-refresh" : "stale-refresh" },
        { label: "expires_at", value: "21600000" },
      ] }) };
    });
    const store = new OnePasswordTokenStore({ run, resolveItem: () => "injected-reference-a", resolveVault: () => undefined });
    await expect(store.save("alpha", { accessToken: "new-access", refreshToken: "new-refresh", expiresAt: 21600000 }))
      .rejects.toThrow("freee OAuth token store could not be updated");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("uses a distinct injected reference for each profile without embedding references in the resolver", () => {
    const env = { FREEE_OAUTH_ITEM_REFERENCE_ALPHA: "injected-reference-a", FREEE_OAUTH_ITEM_REFERENCE_BETA: "injected-reference-b" };
    expect(getOAuthItemReference("alpha", env)).toBe("injected-reference-a");
    expect(getOAuthItemReference("beta", env)).toBe("injected-reference-b");
  });

  it("uses stable errors without echoing sensitive op output", async () => {
    const store = new OnePasswordTokenStore({
      run: async () => { throw new Error("refresh=must-not-leak"); },
      resolveItem: () => "injected-reference-a",
      resolveVault: () => undefined,   // 実行環境の FREEE_OAUTH_VAULT_* から隔離する
    });
    const error = await store.load("alpha").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("freee OAuth token store could not be read");
    expect((error as Error).message).not.toContain("must-not-leak");
  });

  it("terminates a timed-out op process and rejects with a stable error", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as OpChild;
      child.stdout = new EventEmitter() as OpChild["stdout"];
      child.stdin = new EventEmitter() as OpChild["stdin"];
      child.stdin.end = vi.fn();
      child.kill = vi.fn(() => true);
      const pending = runOp(["item", "get", "injected-reference-a"], undefined, {
        spawnFn: () => child,
        timeoutMs: 100,
      });
      const outcome = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);
      expect(await outcome).toMatchObject({ message: "op command timed out" });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles stdin errors without an uncaught exception", async () => {
    const child = new EventEmitter() as OpChild;
    child.stdout = new EventEmitter() as OpChild["stdout"];
    child.stdin = new EventEmitter() as OpChild["stdin"];
    child.stdin.end = vi.fn(() => { queueMicrotask(() => child.stdin.emit("error", new Error("sensitive EPIPE"))); });
    child.kill = vi.fn(() => true);
    await expect(runOp(["item", "edit", "injected-reference-a"], "sensitive-template", { spawnFn: () => child, timeoutMs: 1000 }))
      .rejects.toThrow("op stdin failed");
  });
});

describe("1Password-backed API auth", () => {
  it("does not refresh an unexpired access token", async () => {
    const store = { load: vi.fn(async () => ({ accessToken: "access", refreshToken: "refresh", expiresAt: 22_000_000 })), save: vi.fn() };
    const fetchFn = vi.fn();
    await expect(loadApiAuth({ tokenStore: store, profile: "alpha", now: () => 1_000_000, fetchFn: fetchFn as typeof fetch })).resolves.toMatchObject({ mode: "onepassword", accessToken: "access" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it("uses the generated 1Password store for a normal profile-only call and never reads a plaintext token file", async () => {
    // 読み取りの spy を deps に注入すると legacy のファイル経路へ分岐してしまうため、node:fs 自体を差し替えて監視する。
    const readFileSync = vi.fn(() => { throw new Error("plaintext token file must not be read"); });
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:fs")>()), readFileSync }));
    try {
      const { loadApiAuth: loadWithMockedFs } = await import("../../src/lib/token-config-loader.js");
      const createTokenStore = vi.fn(() => ({ load: vi.fn(async () => ({ accessToken: "access", refreshToken: "refresh", expiresAt: 22_000_000 })), save: vi.fn() }));
      await expect(loadWithMockedFs({ env: {}, profile: "alpha", createTokenStore, now: () => 1_000_000 })).resolves.toMatchObject({ mode: "onepassword", accessToken: "access" });
      expect(createTokenStore).toHaveBeenCalledOnce();
      expect(readFileSync).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("persists the rotated refresh token before returning access", async () => {
    const store = { load: vi.fn(async () => ({ accessToken: "expired", refreshToken: "old-refresh", expiresAt: 1 })), save: vi.fn(async () => undefined) };
    const result = await loadApiAuth({
      tokenStore: store,
      profile: "alpha",
      env: { FREEE_CLIENT_ID: "client", FREEE_CLIENT_SECRET: "secret" },
      now: () => 1_000_000,
      fetchFn: async () => new Response(JSON.stringify({ access_token: "fresh", refresh_token: "new-refresh", expires_in: 21600 }), { status: 200 }),
    });
    expect(store.save).toHaveBeenCalledWith("alpha", { accessToken: "fresh", refreshToken: "new-refresh", expiresAt: 22_600_000 });
    expect(result.accessToken).toBe("fresh");
  });

  it("fails closed when persistence fails and never returns the fresh access token", async () => {
    const store = { load: vi.fn(async () => ({ accessToken: "expired", refreshToken: "old-refresh", expiresAt: 1 })), save: vi.fn(async () => { throw new Error("new-refresh"); }) };
    const error = await loadApiAuth({
      tokenStore: store,
      profile: "alpha",
      env: { FREEE_CLIENT_ID: "client", FREEE_CLIENT_SECRET: "secret" },
      now: () => 1_000_000,
      fetchFn: async () => new Response(JSON.stringify({ access_token: "fresh", refresh_token: "new-refresh", expires_in: 21600 }), { status: 200 }),
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("freee OAuth token store could not be updated");
    expect((error as Error).message).not.toContain("fresh");
  });

  it("requires explicit reauthorization for an invalid refresh without opening a browser", async () => {
    const store = { load: vi.fn(async () => ({ accessToken: "expired", refreshToken: "old-refresh", expiresAt: 1 })), save: vi.fn() };
    const error = await loadApiAuth({
      tokenStore: store,
      profile: "alpha",
      env: { FREEE_CLIENT_ID: "client", FREEE_CLIENT_SECRET: "secret" },
      now: () => 1_000_000,
      fetchFn: async () => new Response("invalid_grant", { status: 400 }),
    }).catch((cause: unknown) => cause);
    expect((error as Error).message).toBe("freee OAuth refresh is invalid. Run freee auth login --profile alpha.");
    expect(store.save).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing rotated refresh token", { access_token: "fresh", expires_in: 21600 }],
    ["a blank rotated refresh token", { access_token: "fresh", refresh_token: " ", expires_in: 21600 }],
    ["an access-token lifetime longer than six hours", { access_token: "fresh", refresh_token: "new-refresh", expires_in: 21601 }],
  ])("fails closed for %s", async (_name, response) => {
    const store = { load: vi.fn(async () => ({ accessToken: "expired", refreshToken: "old-refresh", expiresAt: 1 })), save: vi.fn() };
    await expect(loadApiAuth({
      tokenStore: store,
      profile: "alpha",
      env: { FREEE_CLIENT_ID: "client", FREEE_CLIENT_SECRET: "secret" },
      now: () => 1_000_000,
      fetchFn: async () => new Response(JSON.stringify(response), { status: 200 }),
    })).rejects.toThrow("freee token refresh returned an invalid response");
    expect(store.save).not.toHaveBeenCalled();
  });
});
