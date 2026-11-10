import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { format } from "node:util";
import { createProgram, reportCliError } from "../../src/cli.js";
import { OnePasswordTokenStore, TokenStoreUpdateError } from "../../src/lib/one-password-token-store.js";

// Route Vitest's intercepted console through the CLI's actual output streams.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation((...args) => { process.stderr.write(`${format(...args)}\n`); });
  vi.spyOn(console, "log").mockImplementation((...args) => { process.stdout.write(`${format(...args)}\n`); });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("prints only the user message and enum diagnostics to stderr when refreshed tokens cannot be saved", async () => {
  const previousExitCode = process.exitCode;
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.stubEnv("FREEE_ACCESS_TOKEN", undefined);
  vi.stubEnv("FREEE_CLIENT_ID", "synthetic-client");
  vi.stubEnv("FREEE_CLIENT_SECRET", "synthetic-secret");
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({
    access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 21600,
  })));
  vi.stubGlobal("fetch", fetchFn);
  vi.spyOn(OnePasswordTokenStore.prototype, "load").mockResolvedValue({
    accessToken: "synthetic-expired", refreshToken: "synthetic-old-refresh", expiresAt: 1,
  });
  // The first save is the pre-refresh write check; the second (rotated bundle) fails.
  vi.spyOn(OnePasswordTokenStore.prototype, "save").mockResolvedValueOnce(undefined).mockRejectedValue(Object.assign(
    new TokenStoreUpdateError("edit", "edit", "nonzero"),
    { message: "synthetic-raw-error", cause: new Error("synthetic-cause"),
      token: "synthetic-token", item: "synthetic-item", vault: "synthetic-vault", stdout: "synthetic-op-output" },
  ));
  try {
    await createProgram().parseAsync(["companies", "list"], { from: "user" }).catch(reportCliError);
    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toBe("Error: freee OAuth token store could not be updated\nToken store diagnostics: stage=edit operation=edit category=nonzero\n");
    expect(stdout).not.toHaveBeenCalled();
    expect(output).not.toContain("synthetic-");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

function captureError(error: unknown): string {
  const previousExitCode = process.exitCode;
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    reportCliError(error);
    expect(process.exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    return stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
  } finally {
    process.exitCode = previousExitCode;
  }
}

const enumCases = (["preread", "edit", "readback", "mismatch"] as const).flatMap(stage =>
  (["get", "edit"] as const).flatMap(operation =>
    (["nonzero", "timeout", "stdin", "spawn"] as const).map(category => ({ stage, operation, category }))),
);

it.each(enumCases)("prints allowed diagnostics $stage/$operation/$category without raw error details", ({ stage, operation, category }) => {
  const error = Object.assign(new TokenStoreUpdateError(stage, operation, category), {
    message: "synthetic-raw-error", cause: new Error("synthetic-cause"),
    token: "synthetic-token", item: "synthetic-item", vault: "synthetic-vault", stderr: "synthetic-op-output", exitCode: 99,
  });
  expect(captureError(error)).toBe(`Error: freee OAuth token store could not be updated\nToken store diagnostics: stage=${stage} operation=${operation} category=${category}\n`);
});

it.each([
  [new TokenStoreUpdateError("mismatch"), "Token store diagnostics: stage=mismatch\n"],
  [new TokenStoreUpdateError(undefined, "get"), "Token store diagnostics: operation=get\n"],
  [new TokenStoreUpdateError(undefined, undefined, "spawn"), "Token store diagnostics: category=spawn\n"],
  [new TokenStoreUpdateError(), ""],
])("does not invent missing diagnostic fields (%#)", (error, diagnostic) => {
  expect(captureError(error)).toBe(`Error: freee OAuth token store could not be updated\n${diagnostic}`);
});

it.each([
  ["non-enum values", () => Object.assign(new TokenStoreUpdateError(), { stage: "synthetic-secret", operation: {}, category: 99 })],
  ["getters", () => {
    const error = new TokenStoreUpdateError();
    for (const key of ["stage", "operation", "category"]) {
      Object.defineProperty(error, key, { get() { throw new Error("synthetic-secret"); } });
    }
    return error;
  }],
  ["inherited values", () => Object.create(new TokenStoreUpdateError("edit", "edit", "nonzero"))],
  ["proxy get traps", () => new Proxy(new TokenStoreUpdateError(), { get() { throw new Error("synthetic-secret"); } })],
  ["proxy descriptor traps", () => new Proxy(new TokenStoreUpdateError(), { getOwnPropertyDescriptor() { throw new Error("synthetic-secret"); } })],
] as const)("omits untrusted diagnostics from %s", (_name, makeError) => {
  expect(captureError(makeError())).toBe("Error: freee OAuth token store could not be updated\n");
});

it.each([
  Object.assign(new Error("ordinary failure"), { stage: "edit", operation: "edit", category: "nonzero" }),
  "ordinary failure",
])("keeps the existing output for other errors (%#)", error => {
  expect(captureError(error)).toBe("Error: ordinary failure\n");
});
