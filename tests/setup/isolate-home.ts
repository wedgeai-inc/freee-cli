import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point HOME at a throwaway directory for every test file, so code that falls back to
// homedir() (e.g. the default token refresh lock directory) never touches the real home.
const originalHome = process.env.HOME;
const temporaryHome = mkdtempSync(join(tmpdir(), "freee-cli-test-home-"));
process.env.HOME = temporaryHome;

afterAll(() => {
  try {
    rmSync(temporaryHome, { recursive: true, force: true });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
