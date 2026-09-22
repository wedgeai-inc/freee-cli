import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), readFile: vi.fn() }));
vi.mock("../../src/lib/token-config-loader.js", () => ({ loadApiAuth: vi.fn(async () => ({ accessToken: "token" })) }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("../../src/lib/clients/freee-public-client.js", () => ({ PublicFreeeClient: class { get = mocks.get; put = mocks.put; constructor(_: unknown) {} } }));
vi.mock("../../src/lib/audit/partner-audit.js", () => ({ appendPartnerAudit: vi.fn(), appendPartnerUpdateAudit: vi.fn(async () => undefined) }));

import { createProgram } from "../../src/cli.js";
import * as partnerUpdate from "../../src/commands/partners/update.js";

const wrapped = (partner: Record<string, unknown>) => new Response(JSON.stringify({ partner }));
const current = { id: 100, company_id: 1, name: "現在名" };

describe("partners update CLI entry", () => {
  beforeEach(() => { mocks.get.mockReset(); mocks.put.mockReset(); mocks.readFile.mockReset(); mocks.readFile.mockResolvedValue(JSON.stringify({ shortcut1: "next" })); vi.spyOn(console, "log").mockImplementation(() => undefined); });

  it("dry-run forwards validated arguments and never calls PUT", async () => {
    mocks.get.mockResolvedValue(wrapped(current));
    await createProgram().parseAsync(["node", "freee", "partners", "update", "--company-id", "1", "--id", "100", "--plan", "plan.json", "--task-id", "exact-task"]);
    expect(mocks.get).toHaveBeenCalledWith("/api/1/partners/100", { query: { company_id: 1 } });
    expect(mocks.readFile).toHaveBeenCalledWith("plan.json", "utf8");
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("does not call PUT when the expected name differs", async () => {
    mocks.get.mockResolvedValue(wrapped(current));
    await expect(createProgram().parseAsync(["node", "freee", "partners", "update", "--company-id", "1", "--id", "100", "--plan", "plan.json", "--expect-name", "別名"])).rejects.toThrow("mismatch:name");
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("forwards execute, log-dir, task-id, and a whitespace-bearing expected name unchanged", async () => {
    const run = vi.spyOn(partnerUpdate, "runPartnersUpdate").mockResolvedValue({ mode: "execute", companyId: 1, id: 100, current: { name: " 現在名 " }, changes: [], payload: {} });
    await createProgram().parseAsync(["node", "freee", "partners", "update", "--company-id", "1", "--id", "100", "--plan", "plan.json", "--execute", "--log-dir", "custom-audit", "--task-id", " exact-task ", "--expect-name", " 現在名 "]);
    expect(run).toHaveBeenCalledWith({ companyId: 1, id: 100, planPath: "plan.json", execute: true, logDir: "custom-audit", taskId: " exact-task ", expectName: " 現在名 " }, expect.any(Object));
    run.mockRestore();
  });
});
