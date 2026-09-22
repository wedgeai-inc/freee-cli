import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const PUBLIC_ROOT_COMMANDS = ["auth", "expense", "invoices", "quotations", "companies", "partners", "export"];
const REMOVED_COMMANDS = ["review", "register-deal", "apply-pay"];

function commandNames(help: string): string[] {
  const section = help.split(/^Commands:$/m)[1] ?? "";
  return section
    .split("\n")
    .map((line) => line.match(/^  ([a-z][a-z-]*)/)?.[1])
    .filter((name): name is string => name !== undefined && name !== "help");
}

describe("build entrypoint", () => {
  it("exposes only the public API commands through the package bin path documented in README", { timeout: 30000 }, () => {
    execFileSync("npm", ["run", "build"], { cwd: process.cwd(), stdio: "pipe" });

    const packageJson = JSON.parse(readFileSync("package.json", "utf-8")) as { bin: { freee: string } };
    const binPath = packageJson.bin.freee;
    expect(existsSync(binPath)).toBe(true);
    expect(readFileSync("README.md", "utf-8")).toContain(`node ${binPath} --help`);

    const run = (...args: string[]) => execFileSync(process.execPath, [binPath, ...args], { cwd: process.cwd(), encoding: "utf-8" });

    expect(commandNames(run("--help")).sort()).toEqual([...PUBLIC_ROOT_COMMANDS].sort());
    expect(commandNames(run("expense", "--help"))).toEqual(["list"]);
    for (const name of REMOVED_COMMANDS) {
      expect(run("--help")).not.toMatch(new RegExp(`^  ${name}\\b`, "m"));
      expect(run("expense", "--help")).not.toMatch(new RegExp(`^  ${name}\\b`, "m"));
    }
  });
});
