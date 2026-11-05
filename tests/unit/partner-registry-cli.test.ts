import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli.js";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("partners public registry CLI", () => {
  it("設定不足・不正入力もstdoutにJSONを出し、freee認証や通信を行わない", async () => {
    vi.stubEnv("NTA_CORPORATE_APPLICATION_ID", "");
    vi.stubEnv("NTA_INVOICE_APPLICATION_ID", "");
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const [command, args, status] of [
      ["resolve-legal", ["--number", "1234567890123"], "configuration_error"],
      ["verify-invoice", ["--number", "T1234567890123"], "configuration_error"],
      ["resolve-legal", ["--number", "oops"], "invalid_input"],
      ["verify-invoice", [], "invalid_input"],
    ] as const) {
      await createProgram().parseAsync(["node", "freee", "partners", command, ...args]);
      expect(JSON.parse(log.mock.calls.at(-1)![0]).status).toBe(status);
    }
    expect(network).not.toHaveBeenCalled();
  });
  it("環境からのIDを使って照会結果だけをJSON出力する", async () => {
    vi.stubEnv("NTA_INVOICE_APPLICATION_ID", "mock-id");
    const network = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      lastUpdateDate: "2026-11-01", count: "0", divideNumber: "1", divideSize: "1", announcement: [],
    })));
    vi.stubGlobal("fetch", network);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["node", "freee", "partners", "verify-invoice", "--number", "T1234567890123"]);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ status: "not_registered", items: [] });
    expect(log).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("両照会コマンドとオプションをhelpに表示する", () => {
    const partners = createProgram().commands.find((c) => c.name() === "partners")!;
    expect(partners.helpInformation()).toContain("resolve-legal");
    expect(partners.helpInformation()).toContain("verify-invoice");
    for (const name of ["resolve-legal", "verify-invoice"]) {
      const help = partners.commands.find((c) => c.name() === name)!.helpInformation();
      expect(help).toContain("--number"); expect(help).toContain("--name");
    }
  });
});
