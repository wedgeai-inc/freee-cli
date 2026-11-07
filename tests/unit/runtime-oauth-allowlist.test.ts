import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseRuntimePlan, RUNTIME_PLAN_ALLOWLIST } from "../../src/lib/runtime-oauth.js";

it.each([
  ["wallet-txns", "list", "--company-id", "1"],
  ["wallet-txns", "reconcile", "8", "--company-id", "1", "--deal-id", "6", "--amount", "123"],
  ["wallet-txns", "create-deal", "8", "--company-id", "1", "--partner-id", "3", "--account-item-id", "4", "--tax-code", "0", "--amount", "123"],
  ["walletables", "list", "--company-id", "1"],
  ["deals", "payments", "create", "6", "--company-id", "1", "--date", "2026-01-15", "--from-walletable-type", "wallet", "--from-walletable-id", "2", "--amount", "123"],
].map(command => [command]))("消込用コマンド%jを旧export形式へ変換せず許可する", command => {
  expect(parseRuntimePlan(JSON.stringify({ commands: [command] }))).toEqual([command]);
});

it("未許可の兄弟コマンドと3階層未満の支払コマンドを拒否する", () => {
  for (const command of [
    ["wallet-txns", "delete"], ["wallet-txns", "reconcile-all"], ["wallet-txns", "create-deal-all"],
    ["walletables", "create"], ["deals", "payments"],
    ["deals", "payments", "delete"], ["deals", "payments", "create-all"],
    ["deals", "payments", "--execute"],
  ]) {
    expect.soft(() => parseRuntimePlan(JSON.stringify({ commands: [command] }))).toThrow("Invalid runtime plan command");
  }
});

it("wallet-txnsの旧形式と明示export形式は従来どおり正規化する", () => {
  const legacy = ["wallet-txns", "--company-id", "1", "--start-date", "2026-01-01", "--end-date", "2026-01-31", "--out", "synthetic-output"];
  const explicit = ["export", ...legacy];
  expect(parseRuntimePlan(JSON.stringify({ commands: [legacy, explicit] }))).toEqual([explicit, explicit]);
});

it("READMEのruntime許可リストが実装と完全一致する", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const section = readme.split("<!-- runtime-plan-allowlist:start -->")[1]?.split("<!-- runtime-plan-allowlist:end -->")[0];
  expect(section, "READMEに許可リストの境界が必要").toBeDefined();
  const documented = [...section!.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]!);
  expect(documented.sort()).toEqual(RUNTIME_PLAN_ALLOWLIST.map(prefix => prefix.join(" ")).sort());
  const commands = documented.map(command => command.split(" "));
  expect(parseRuntimePlan(JSON.stringify({ commands }))).toEqual(commands);
});
