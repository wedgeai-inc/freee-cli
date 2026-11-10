import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { withTokenRefreshLock } from "../../src/lib/token-refresh-lock.js";

let lockDir: string;

beforeEach(async () => {
  lockDir = join(await mkdtemp(join(tmpdir(), "freee-cli-lock-test-")), "locks");
});

afterEach(async () => {
  await rm(join(lockDir, ".."), { recursive: true, force: true });
});

describe("withTokenRefreshLock", () => {
  it("creates the lock directory, holds <profile>.lock with the PID during the call, and removes it on success", async () => {
    let during = "";
    const result = await withTokenRefreshLock("alpha", { lockDir }, async () => {
      during = await readFile(join(lockDir, "alpha.lock"), "utf8");
      return "done";
    });
    expect(result).toBe("done");
    expect(during.split(/\s/)[0]).toBe(String(process.pid));
    expect(await readdir(lockDir)).toEqual([]);
  });

  it("removes its own lock when the callback fails", async () => {
    await expect(withTokenRefreshLock("alpha", { lockDir }, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await readdir(lockDir)).toEqual([]);
  });

  it("fails immediately in Japanese without running the callback when a live process holds the lock", async () => {
    await withTokenRefreshLock("alpha", { lockDir }, async () => {
      let ran = false;
      const error = await withTokenRefreshLock("alpha", { lockDir }, async () => { ran = true; })
        .catch((cause: unknown) => cause) as Error;
      expect(ran).toBe(false);
      expect(error.message).toContain("同じprofileのtoken更新が既に実行中です");
      expect(error.message).toContain("alpha.lock");
      // the other holder's lock must survive the failed attempt
      expect(await readdir(lockDir)).toEqual(["alpha.lock"]);
    });
  });

  it("does not delete a lock it did not create", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "alpha.lock"), `${process.pid} someone-else\n`);
    await expect(withTokenRefreshLock("alpha", { lockDir }, async () => "x")).rejects.toThrow("既に実行中です");
    expect(await readFile(join(lockDir, "alpha.lock"), "utf8")).toBe(`${process.pid} someone-else\n`);
  });

  it("takes over a stale lock whose PID is no longer alive", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "alpha.lock"), "999999 stale\n");
    const result = await withTokenRefreshLock("alpha", { lockDir, isProcessAlive: () => false }, async () => "taken");
    expect(result).toBe("taken");
    expect(await readdir(lockDir)).toEqual([]);
  });

  it("fails when the lock holder cannot be judged (unparseable PID)", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "alpha.lock"), "garbage\n");
    await expect(withTokenRefreshLock("alpha", { lockDir, isProcessAlive: () => false }, async () => "x")).rejects.toThrow("既に実行中です");
    expect(await readFile(join(lockDir, "alpha.lock"), "utf8")).toBe("garbage\n");
  });

  it.each(["../escape", "Alpha", "a/b", "", "-x", "a_b"])("rejects the invalid profile %j without creating any file", async (profile) => {
    let ran = false;
    await expect(withTokenRefreshLock(profile, { lockDir }, async () => { ran = true; })).rejects.toThrow("freee OAuth profile is invalid");
    expect(ran).toBe(false);
    await expect(readdir(lockDir)).rejects.toThrow();
  });

  it("runs tests with an isolated HOME so a forgotten lockDir never touches the real home", () => {
    expect(homedir().startsWith(tmpdir()) || homedir().startsWith("/private" + tmpdir())).toBe(true);
  });
});
