import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { PublicFreeeClient } from "../../src/lib/clients/freee-public-client.js";
import { runReceiptsUpload } from "../../src/commands/receipts/upload.js";

const bytes = Buffer.from("fictional pdf content");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const options = { companyId: 1, file: "fixtures/sample.pdf", issueDate: "2026-01-15", description: "架空証憑", logDir: "unused", taskId: "sample" };
function setup() {
  const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ receipt: { id: 5 } })));
  const client = new PublicFreeeClient({ baseUrl: "https://api.freee.co.jp", token: "test-token", fetchFn });
  const getClient = vi.fn(async () => client);
  const readFile = vi.fn(async () => bytes);
  const appendAudit = vi.fn().mockResolvedValue(undefined);
  return { fetchFn, deps: { getClient, readFile, appendAudit, now: () => new Date("2026-01-15T00:00:00Z") } };
}
it("dry-runはファイル名・サイズ・MIME・SHA-256・送信予定項目だけを返す", async () => {
  const { deps, fetchFn } = setup();
  const result = await runReceiptsUpload(options, deps);
  expect(result).toEqual({ mode: "dry-run", file: { filename: "sample.pdf", size: bytes.length, mime: "application/pdf", sha256 }, fields: { company_id: 1, receipt_metadatum_issue_date: "2026-01-15", description: "架空証憑" } });
  expect(fetchFn).not.toHaveBeenCalled();
  expect(deps.getClient).not.toHaveBeenCalled();
  const audit = JSON.stringify(deps.appendAudit.mock.calls);
  expect(audit).not.toContain(bytes.toString());
  expect(audit).not.toContain("fixtures/");
  expect(audit).not.toContain("架空証憑");
  expect(deps.appendAudit.mock.calls[0]![0].payload_redacted).toEqual({ company_id: 1, receipt_metadatum_issue_date: "[REDACTED]", description: "[REDACTED]" });
});
it("executeはハッシュ一致した同じバイト列だけをmultipartで送る", async () => {
  for (const expectSha256 of [undefined, "b".repeat(64), "invalid"]) {
    const { deps, fetchFn } = setup();
    await expect(runReceiptsUpload({ ...options, execute: true, expectSha256 }, deps)).rejects.toThrow("--expect-sha256");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(deps.getClient).not.toHaveBeenCalled();
  }
  const { deps, fetchFn } = setup();
  const result = await runReceiptsUpload({ ...options, execute: true, expectSha256: sha256 }, deps);
  expect(result).toMatchObject({ mode: "execute", created: { id: 5 } });
  expect(deps.readFile).toHaveBeenCalledTimes(1);
  const init = fetchFn.mock.calls[0]![1];
  const form = init.body as FormData;
  expect(init.headers).not.toHaveProperty("Content-Type");
  expect(form.get("company_id")).toBe("1");
  expect([...form.keys()].sort()).toEqual(["company_id", "description", "receipt", "receipt_metadatum_issue_date"]);
  expect(form.get("receipt_metadatum_issue_date")).toBe("2026-01-15");
  expect(form.has("issue_date")).toBe(false);
  expect(form.get("description")).toBe("架空証憑");
  const file = form.get("receipt") as File;
  expect(file.name).toBe("sample.pdf");
  expect(file.type).toBe("application/pdf");
  expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
  expect(deps.appendAudit.mock.calls.map(c => c[0].status)).toEqual(["attempting", "succeeded"]);
});
it("不正な日付・事業所・空ファイル・読めないファイルを送信前に拒否する", async () => {
  for (const patch of [{ companyId: 0 }, { issueDate: "2026-02-30" }]) {
    const { deps, fetchFn } = setup();
    await expect(runReceiptsUpload({ ...options, ...patch }, deps)).rejects.toThrow();
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  }
  const { deps } = setup();
  deps.readFile.mockResolvedValueOnce(Buffer.alloc(0));
  await expect(runReceiptsUpload(options, deps)).rejects.toThrow("empty");
  deps.readFile.mockRejectedValueOnce(new Error("private-file-path"));
  await expect(runReceiptsUpload(options, deps)).rejects.toThrow("file cannot be read");
});

it("receiptCreateParams.descriptionの255文字上限を送信前に検証する", async () => {
  const { deps, fetchFn } = setup();
  await expect(runReceiptsUpload({ ...options, description: "a".repeat(256) }, deps)).rejects.toThrow("255");
  expect(deps.readFile).not.toHaveBeenCalled();
  expect(fetchFn).not.toHaveBeenCalled();
  expect((await runReceiptsUpload({ ...options, description: "a".repeat(255) }, deps)).fields.description).toHaveLength(255);
});
