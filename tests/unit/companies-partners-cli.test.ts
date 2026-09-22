import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli.js";

describe("companies / partners CLI", () => {
  it("partners search の不正な company-id は既存の parseCompanyId エラーになる", async () => {
    const program = createProgram();

    await expect(
      program.parseAsync(["node", "freee", "partners", "search", "--company-id", "invalid"]),
    ).rejects.toThrow('--company-id must be a positive integer (got: "invalid")');
  });

  it.each(["1e2", " 100 ", "0x64", "0", "9007199254740992"])("partners get/update の id %s を認証前に拒否する", async (id) => {
    for (const command of ["get", "update"]) {
      const program = createProgram();
      const args = ["node", "freee", "partners", command, "--company-id", "1", "--id", id];
      if (command === "update") args.push("--plan", "p.json");
      await expect(program.parseAsync(args)).rejects.toThrow("--id must be a positive safe integer");
    }
  });
});
