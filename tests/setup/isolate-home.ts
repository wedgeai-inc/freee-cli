import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point HOME at a throwaway directory for every test file, so code that falls back to
// homedir() (e.g. the default token refresh lock directory) never touches the real home.
process.env.HOME = mkdtempSync(join(tmpdir(), "freee-cli-test-home-"));
