import { afterEach, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";

const hooks = vi.hoisted(() => ({ cleanup: [] as Array<() => void> }));
vi.mock("vitest", async (importOriginal) => ({
  ...await importOriginal<typeof import("vitest")>(),
  afterAll: (callback: () => void) => { hooks.cleanup.push(callback); },
}));

const originalHome = process.env.HOME;
let temporaryHome: string | undefined;

afterEach(() => {
  if (temporaryHome && temporaryHome !== originalHome) rmSync(temporaryHome, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  hooks.cleanup.length = 0;
});

it.each([true, false])("removes only the temporary HOME and restores the previous environment (HOME present: %j)", async (hasHome) => {
  if (!hasHome) delete process.env.HOME;
  vi.resetModules();
  await import("../setup/isolate-home.js");
  temporaryHome = process.env.HOME;
  expect(temporaryHome).toBeDefined();
  expect(temporaryHome).not.toBe(originalHome);
  expect(existsSync(temporaryHome!)).toBe(true);
  expect(hooks.cleanup).toHaveLength(1);
  hooks.cleanup[0]();
  expect(existsSync(temporaryHome!)).toBe(false);
  expect(process.env.HOME).toBe(hasHome ? originalHome : undefined);
  if (originalHome) expect(existsSync(originalHome)).toBe(true);
});
