import { describe, expect, it, vi } from "vitest";
import { createLoginExecutor, persistInitialOAuthTokens } from "../../src/commands/auth/oauth-login.js";

describe("OAuth login token persistence", () => {
  it("stores the initial access and refresh token bundle before completing login", async () => {
    const save = vi.fn(async () => undefined);
    await persistInitialOAuthTokens({ save }, "alpha", { accessToken: "access", refreshToken: "refresh", expiresIn: 21600 }, () => 1_000_000);
    expect(save).toHaveBeenCalledWith("alpha", { accessToken: "access", refreshToken: "refresh", expiresAt: 22_600_000 });
  });

  it("does not signal success until the store write has completed", async () => {
    const order: string[] = [];
    let releaseSave: () => void = () => {};
    const pendingSave = new Promise<void>((resolve) => { releaseSave = resolve; });
    const executor = createLoginExecutor(
      { save: async () => { order.push("save:start"); await pendingSave; order.push("save:done"); } },
      "alpha",
      () => 1_000_000,
    );
    const running = executor("access", "refresh", 21600, undefined, () => order.push("onStarted"));
    await Promise.resolve();
    // 保存が終わる前に成功通知が出ていないこと
    expect(order).toEqual(["save:start"]);
    releaseSave();
    await running;
    expect(order).toEqual(["save:start", "save:done", "onStarted"]);
  });

  it("does not signal success when the store write fails", async () => {
    const onStarted = vi.fn();
    const executor = createLoginExecutor({ save: async () => { throw new Error("boom"); } }, "alpha");
    await expect(executor("access", "refresh", 21600, undefined, onStarted)).rejects.toThrow(
      "freee OAuth token store could not be updated",
    );
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("does not leak a failed store write", async () => {
    const error = await persistInitialOAuthTokens(
      { save: async () => { throw new Error("refresh-must-not-leak"); } },
      "alpha",
      { accessToken: "access", refreshToken: "refresh", expiresIn: 21600 },
    ).catch((cause: unknown) => cause);
    expect((error as Error).message).toBe("freee OAuth token store could not be updated");
    expect((error as Error).message).not.toContain("must-not-leak");
  });
});
