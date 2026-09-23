import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMainModule } from "../../src/lib/main-module.js";

const identity = (path: string) => path;

describe("isMainModule", () => {
  it("matches a path whose URL form is percent-encoded (space, Japanese, #)", () => {
    const path = "/tmp/work (1)/日本語#/dist/src/cli.js";
    expect(isMainModule(pathToFileURL(path).href, path, { realpath: identity })).toBe(true);
  });

  it("matches a Windows path against its file:///C:/ URL", () => {
    const path = "C:\\work\\freee-cli\\dist\\src\\cli.js";
    const toUrl = (p: string) => pathToFileURL(p, { windows: true });
    expect(isMainModule("file:///C:/work/freee-cli/dist/src/cli.js", path, { realpath: identity, toUrl })).toBe(true);
  });

  it("resolves a symlinked entry (npm link style) before comparing", () => {
    const link = "/usr/local/bin/freee";
    const real = "/opt/freee-cli/dist/src/cli.js";
    const realpath = (p: string) => (p === link ? real : p);
    expect(isMainModule(pathToFileURL(real).href, link, { realpath })).toBe(true);
  });

  it("falls back to the given path when it cannot be resolved", () => {
    const path = "/tmp/missing/cli.js";
    const realpath = () => {
      throw new Error("ENOENT");
    };
    expect(isMainModule(pathToFileURL(path).href, path, { realpath })).toBe(true);
  });

  it("does not match another module or a missing argv[1]", () => {
    const moduleUrl = pathToFileURL("/opt/freee-cli/dist/src/cli.js").href;
    expect(isMainModule(moduleUrl, "/opt/freee-cli/dist/src/other.js", { realpath: identity })).toBe(false);
    expect(isMainModule(moduleUrl, undefined, { realpath: identity })).toBe(false);
  });
});

describe("built CLI in a directory with URL-encoded characters", () => {
  let dir: string;

  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: process.cwd(), stdio: "pipe" });
    dir = mkdtempSync(join(tmpdir(), "freee cli (1) 日本語#"));
    cpSync("dist", join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    symlinkSync(resolve("node_modules"), join(dir, "node_modules"), "dir");
  }, 30000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("prints help instead of exiting silently", () => {
    const out = execFileSync(process.execPath, [join(dir, "dist", "src", "cli.js"), "--help"], { encoding: "utf-8" });
    expect(out).toContain("Usage: freee");
  });

  it("prints help when started through a symlink", () => {
    const link = join(dir, "freee");
    symlinkSync(join(dir, "dist", "src", "cli.js"), link);
    const out = execFileSync(process.execPath, [link, "--help"], { encoding: "utf-8" });
    expect(out).toContain("Usage: freee");
  });
});
