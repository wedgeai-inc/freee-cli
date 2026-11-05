import { describe, expect, it, vi } from "vitest";
import { runResolveLegal, runVerifyInvoice } from "../../src/commands/partners/registry.js";

// 合成データ。実在の取引先情報ではない。
const number = "1234567890123";
function corporateCsv(numbers = [number], total = numbers.length, divisions = 1) {
  return [`2026-11-01,${total},1,${divisions}`, ...numbers.map((n) => {
    const row = Array<string>(30).fill("");
    row[0] = "1"; row[1] = n; row[3] = "1";
    row[6] = '"株式会社テスト,合成"';
    row[9] = "東京都"; row[10] = "合成市"; row[11] = "試験町１番";
    row[22] = "2020-01-01"; row[23] = "1";
    return row.join(",");
  })].join("\r\n") + "\r\n";
}
const deps = (body: string) => ({ applicationId: "mock-id", fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)) });
const invoiceRecord = (extra = {}) => ({
  registratedNumber: `T${number}`, name: "株式会社合成", address: "東京都合成市",
  addressRequest: "", addressInside: "", registrationDate: "2023-10-01",
  disposalDate: "", expireDate: "", latest: "1", ...extra,
});
const invoiceJson = (records = [invoiceRecord()]) => JSON.stringify({
  lastUpdateDate: "2026-11-01", count: String(records.length), divideNumber: "1", divideSize: "1", announcement: records,
});

describe("インボイス公表情報", () => {
  it("HTTP404や通信失敗は未登録にせず、非公表所在地はnullを返す", async () => {
    const d = deps(invoiceJson());
    d.fetch.mockResolvedValueOnce(new Response("", { status: 404 }));
    expect(await runVerifyInvoice({ number: `T${number}` }, d)).toMatchObject({ status: "http_error" });
    d.fetch.mockRejectedValueOnce(new Error("offline"));
    expect(await runVerifyInvoice({ number: `T${number}` }, d)).toMatchObject({ status: "network_error" });
    const hidden = deps(invoiceJson([invoiceRecord({ address: "" })]));
    expect(await runVerifyInvoice({ number: `T${number}`, expectName: "株式会社合成" }, hidden)).toMatchObject({
      status: "registered", items: [{ address: null, nameMatches: true }],
    });
  });
  it("名称の法人候補が一意のときだけT番号を照会し正式名称も照合する", async () => {
    const d = { ...deps(corporateCsv()), corporateApplicationId: "mock-corporate-id" };
    d.fetch.mockResolvedValueOnce(new Response(corporateCsv())).mockResolvedValueOnce(new Response(invoiceJson()));
    expect(await runVerifyInvoice({ name: "テスト" }, d)).toMatchObject({ status: "name_mismatch" });
    expect(new URL(String(d.fetch.mock.calls[1][0])).searchParams.get("number")).toBe(`T${number}`);
    const ambiguous = { ...deps(corporateCsv([number, "2234567890123"])), corporateApplicationId: "mock-corporate-id" };
    expect(await runVerifyInvoice({ name: "テスト" }, ambiguous)).toMatchObject({ status: "ambiguous" });
    expect(ambiguous.fetch).toHaveBeenCalledTimes(1);
    const empty = { ...deps(corporateCsv([])), corporateApplicationId: "mock-corporate-id" };
    expect(await runVerifyInvoice({ name: "テスト" }, empty)).toMatchObject({ status: "not_found" });
    expect(empty.fetch).toHaveBeenCalledTimes(1);
  });
  it("異常JSON・不整合・番号違い・複数レコードを登録済みにしない", async () => {
    for (const body of ["broken", "null", "{}", invoiceJson([invoiceRecord({ registratedNumber: "T2234567890123" })]),
      invoiceJson([invoiceRecord(), invoiceRecord()]), invoiceJson([invoiceRecord({ registrationDate: "2026-02-30" })]),
      invoiceJson([invoiceRecord({ disposalDate: undefined })]), invoiceJson([invoiceRecord({ latest: "0" })]),
      invoiceJson([invoiceRecord({ name: "" })]), invoiceJson().replace('"count":"1"', '"count":"0"'),
    ]) {
      expect(await runVerifyInvoice({ number: `T${number}` }, deps(body))).toMatchObject({ status: "invalid_response" });
    }
  });
  it("T番号・期待名称の不正値や設定不足を通信前に返す", async () => {
    const d = deps(invoiceJson());
    for (const opts of [{}, { number: "T123" }, { number: `t${number}` }, { name: " " }, { number: `T${number}`, name: "合成" }, { number: `T${number}`, expectName: " " }]) {
      expect(await runVerifyInvoice(opts, d)).toMatchObject({ status: "invalid_input" });
    }
    expect(await runVerifyInvoice({ number: `T${number}` }, { ...d, applicationId: undefined })).toMatchObject({ status: "configuration_error" });
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it("登録前・取消・失効はJSTの当日を基準に判定する", async () => {
    for (const [extra, status, registered] of [
      [{ registrationDate: "2026-11-06" }, "not_yet_registered", false],
      [{ disposalDate: "2026-11-05" }, "not_registered", false],
      [{ expireDate: "2026-11-04" }, "not_registered", false],
      [{ expireDate: "2026-11-06" }, "registered", true],
    ] as const) {
      const d = { ...deps(invoiceJson([invoiceRecord(extra)])), now: () => new Date("2026-11-04T16:00:00Z") };
      expect(await runVerifyInvoice({ number: `T${number}` }, d)).toMatchObject({ status, items: [{ registered }] });
    }
  });
  it("0件は未登録、名称違いは登録有無と別に返す", async () => {
    expect(await runVerifyInvoice({ number: `T${number}` }, deps(invoiceJson([])))).toMatchObject({ status: "not_registered", items: [] });
    expect(await runVerifyInvoice({ number: `T${number}`, expectName: "別の名称" }, deps(invoiceJson()))).toMatchObject({
      status: "name_mismatch", items: [{ registered: true, nameMatches: false }],
    });
  });
  it("T番号から登録名称・所在地・登録状態を取得する", async () => {
    const d = { ...deps(invoiceJson()), now: () => new Date("2026-11-05T00:00:00+09:00") };
    expect(await runVerifyInvoice({ number: `T${number}` }, d)).toMatchObject({
      status: "registered", items: [{ invoiceNumber: `T${number}`, name: "株式会社合成", address: "東京都合成市", registered: true }],
    });
    const url = new URL(String(d.fetch.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://web-api.invoice-kohyo.nta.go.jp/1/num");
    expect(Object.fromEntries(url.searchParams)).toEqual({ id: "mock-id", number: `T${number}`, type: "21", history: "0" });
  });
});

describe("法人公表情報", () => {
  it("UTF-8 BOM、引用符内の改行・二重引用符と国外所在地を扱う", async () => {
    const body = "\uFEFF" + corporateCsv().replace('"株式会社テスト,合成"', '"株式会社\nテスト""合成"');
    expect(await runResolveLegal({ number }, deps(body))).toMatchObject({
      status: "found", items: [{ name: '株式会社\nテスト"合成' }],
    });
    const rows = corporateCsv().split("\r\n");
    // 名称のカンマは置換してから列を編集する。
    const row = rows[1].replace('"株式会社テスト,合成"', "合成法人").split(",");
    row[9] = ""; row[10] = ""; row[11] = ""; row[16] = "架空国合成市";
    rows[1] = row.join(",");
    expect(await runResolveLegal({ number }, deps(rows.join("\r\n")))).toMatchObject({
      status: "found", items: [{ address: "架空国合成市" }],
    });
  });
  it("通信・HTTP・壊れた応答を0件と取り違えず、エラーの本文やURLを出さない", async () => {
    const d = deps("");
    d.fetch.mockRejectedValueOnce(new Error("private URL mock-id"));
    expect(await runResolveLegal({ number }, d)).toEqual({ status: "network_error", message: "Registry request failed or timed out." });
    d.fetch.mockResolvedValueOnce(new Response("private response", { status: 403 }));
    expect(await runResolveLegal({ number }, d)).toEqual({ status: "http_error", message: "Registry returned HTTP 403." });
    for (const body of ["<html>maintenance</html>", "", corporateCsv().replace(number, "999"), corporateCsv().replace(",1,1,1", ",0,1,1"), corporateCsv().replace('"株式会社テスト,合成"', '"unclosed')]) {
      d.fetch.mockResolvedValueOnce(new Response(body));
      expect(await runResolveLegal({ number }, d)).toMatchObject({ status: "invalid_response" });
    }
  });
  it("不正入力と設定不足では通信しない", async () => {
    const d = deps(corporateCsv());
    for (const opts of [{}, { number: "123" }, { name: " " }, { number, name: "合成" }, { number: "１２３４５６７８９０１２３" }]) {
      expect(await runResolveLegal(opts, d)).toMatchObject({ status: "invalid_input" });
    }
    expect(await runResolveLegal({ number }, { ...d, applicationId: undefined })).toMatchObject({ status: "configuration_error" });
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it.each([[[], 0, 1, "not_found", true], [[number], 2001, 2, "ambiguous", false]] as const)(
    "0件・分割応答を明示する (%s)", async (numbers, total, divisions, status, complete) => {
      const d = deps(corporateCsv([...numbers], total, divisions));
      expect(await runResolveLegal({ name: "テスト" }, d)).toMatchObject({ status, total, complete });
    },
  );
  it("候補名を部分一致検索し、複数候補を選択しない", async () => {
    const d = deps(corporateCsv([number, "2234567890123"]));
    const result = await runResolveLegal({ name: "テスト&合成" }, d);
    expect(result.status).toBe("ambiguous");
    expect("items" in result && result.items).toHaveLength(2);
    const url = new URL(String(d.fetch.mock.calls[0][0]));
    expect(url.pathname).toBe("/4/name");
    expect(url.searchParams.get("name")).toBe("テスト&合成");
    expect(url.searchParams.get("mode")).toBe("2");
    expect(url.searchParams.get("change")).toBe("0");
  });
  it("法人番号から正式名称・番号・所在地を返す", async () => {
    const d = deps(corporateCsv());
    expect(await runResolveLegal({ number }, d)).toMatchObject({
      status: "found", total: 1, complete: true,
      items: [{ corporateNumber: number, name: "株式会社テスト,合成", address: "東京都合成市試験町１番" }],
    });
    const url = new URL(String(d.fetch.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://api.houjin-bangou.nta.go.jp/4/num");
    expect(Object.fromEntries(url.searchParams)).toEqual({ id: "mock-id", number, type: "02", history: "0" });
  });
});
