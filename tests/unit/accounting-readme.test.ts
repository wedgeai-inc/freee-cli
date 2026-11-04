import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("支払行作成の二重計上リスクと支払・消込のdry-run監査を説明する", async () => {
  const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
  const payment = readme.split("#### 取引の支払行の作成")[1]!.split("#### 口座明細と既存取引の消込")[0]!;
  expect(payment).toContain("未処理の口座明細を消込しません");
  expect(payment).toContain("二重計上");
  expect(payment).toContain("`wallet-txns reconcile`");
  const audit = readme.split("#### 取引・証憑・支払・消込の監査ログ")[1]!.split("### 取引先")[0]!;
  expect(audit).toContain("status=guard_failed");
  expect(audit).toContain("`guards`");
  expect(audit).toContain("真偽値");
});
