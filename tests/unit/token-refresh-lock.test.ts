import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { link, mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { withTokenRefreshLock } from "../../src/lib/token-refresh-lock.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, unlink: vi.fn(fs.unlink), link: vi.fn(fs.link) };
});
const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

let lockDir: string;

beforeEach(async () => {
  vi.mocked(unlink).mockReset().mockImplementation(realFs.unlink);
  vi.mocked(link).mockReset().mockImplementation(realFs.link);
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

  it("preserves a lock replaced after the stale PID was read", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(lockDir, { recursive: true });
    const path = join(lockDir, "alpha.lock");
    await writeFile(path, "999999 stale\n");
    let ran = false;
    await expect(withTokenRefreshLock("alpha", {
      lockDir,
      isProcessAlive: () => {
        writeFileSync(path, "999998 other-live\n");
        return false;
      },
    }, async () => { ran = true; })).rejects.toThrow("既に実行中です");
    expect(ran).toBe(false);
    expect(await readFile(path, "utf8")).toBe("999998 other-live\n");
    expect(await readdir(lockDir)).toEqual(["alpha.lock"]);
  });

  it("does not retry or wait if another lock appears immediately after stale-lock removal", async () => {
    await mkdir(lockDir, { recursive: true });
    const path = join(lockDir, "alpha.lock");
    await writeFile(path, "999999 stale\n");
    let removals = 0;
    vi.mocked(unlink).mockImplementation(async (target) => {
      await realFs.unlink(target);
      if (target === path) {
        removals++;
        await writeFile(path, "999998 competing\n");
      }
    });
    const callback = vi.fn();
    const started = performance.now();
    await expect(withTokenRefreshLock("alpha", { lockDir, isProcessAlive: () => false }, callback))
      .rejects.toThrow("既に実行中です");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(removals).toBe(1);
    expect(vi.mocked(link).mock.calls.filter(([, target]) => target === path)).toHaveLength(2);
    expect(callback).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe("999998 competing\n");
    expect(await readdir(lockDir)).toEqual(["alpha.lock"]);
  }, 2000);

  it("fails when another reclaimer holds the exclusive reclaim file", async () => {
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "alpha.lock"), "999999 stale\n");
    await writeFile(join(lockDir, "alpha.lock.reclaim"), "999998 other-reclaimer\n");
    const callback = vi.fn();
    await expect(withTokenRefreshLock("alpha", { lockDir, isProcessAlive: () => false }, callback))
      .rejects.toThrow("既に実行中です");
    expect(callback).not.toHaveBeenCalled();
    expect(await readFile(join(lockDir, "alpha.lock"), "utf8")).toBe("999999 stale\n");
    expect(await readFile(join(lockDir, "alpha.lock.reclaim"), "utf8")).toBe("999998 other-reclaimer\n");
  });

  it("only publishes fully written lock and reclaim files without overwriting existing files", async () => {
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "alpha.lock"), "999999 stale\n");
    const published: string[] = [];
    vi.mocked(link).mockImplementation(async (source, target) => {
      expect(await readFile(source, "utf8")).toMatch(/^[1-9][0-9]* [^\s]+\n$/);
      await realFs.link(source, target);
      published.push(String(target));
    });
    await withTokenRefreshLock("alpha", { lockDir, isProcessAlive: () => false }, async () => undefined);
    expect(published).toEqual([join(lockDir, "alpha.lock.reclaim"), join(lockDir, "alpha.lock")]);
    expect(await readdir(lockDir)).toEqual([]);
  });

  it("preserves a reclaim file replaced by another owner", async () => {
    await mkdir(lockDir, { recursive: true });
    const path = join(lockDir, "alpha.lock");
    const reclaim = `${path}.reclaim`;
    await writeFile(path, "999999 stale\n");
    vi.mocked(unlink).mockImplementation(async (target) => {
      if (target === path) await writeFile(reclaim, "999998 other-reclaimer\n");
      await realFs.unlink(target);
    });
    await withTokenRefreshLock("alpha", { lockDir, isProcessAlive: () => false }, async () => undefined);
    expect(await readFile(reclaim, "utf8")).toBe("999998 other-reclaimer\n");
    expect(await readdir(lockDir)).toEqual(["alpha.lock.reclaim"]);
  });

  it.each(["", "garbage\n"])("reclaims an old unparseable lock containing %j", async (content) => {
    await mkdir(lockDir, { recursive: true });
    const path = join(lockDir, "alpha.lock");
    await writeFile(path, content);
    const past = new Date(Date.now() - 120_000);
    await utimes(path, past, past);
    await expect(withTokenRefreshLock("alpha", { lockDir }, async () => "taken")).resolves.toBe("taken");
    expect(await readdir(lockDir)).toEqual([]);
  });

  it.each(["", "garbage\n"])("preserves a new unparseable lock containing %j", async (content) => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "alpha.lock"), content);
    await expect(withTokenRefreshLock("alpha", { lockDir, isProcessAlive: () => false }, async () => "x")).rejects.toThrow("既に実行中です");
    expect(await readFile(join(lockDir, "alpha.lock"), "utf8")).toBe(content);
    expect(await readdir(lockDir)).toEqual(["alpha.lock"]);
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
