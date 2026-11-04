# 請求書と取引の紐付け確認

## 結論と調査範囲

2026-11-04にローカルの`src/`、`README.md`、`scripts/`、`tests/fixtures/`を確認した範囲では、既存の請求書と会計取引を紐付ける書き込みAPIは見つからない。請求書の取引登録を起動するAPIも見つからない。ネットワークは使っておらず、公開API全体に存在しないという結論ではない。

OpenAPI全文（生成スクリプトが参照する`.iv-schema.yml`を含む）はこのcheckoutに見つからない。同梱されているのはOpenAPIから抽出したプロパティ一覧・リクエスト制約のfixtureであり、全エンドポイントや各レスポンス項目の型・意味の定義は確認できない。公式スキーマ全文の最新確認と実機確認は未実施。

## 確認できた項目と根拠

|対象|項目・手段|ローカルの根拠|
|---|---|---|
|請求書取得レスポンス|`deal_status`、`deal_id`|[OpenAPI由来fixtureの`invoice`](../tests/fixtures/iv-invoice-show-keys.json)。取得日は2026-09-08、元スキーマのSHA-256は同ファイルの`_upstreamSha256`|
|請求書のCLI型|`deal_status`は`registered`または`unregistered`。従来の`invoices get`の整形結果は`deal_id`を出力しない|[`InvoiceSummary`と`toInvoiceDetail`](../src/types/invoice.ts)|
|請求書リクエスト|抽出済み`InvoiceRequest`の`requestConstraints`に`deal_id`、`deal_status`、既存取引の指定項目は見つからない|[fixtureの`requestConstraints`](../tests/fixtures/iv-invoice-show-keys.json)、[生成スクリプト](../scripts/gen-iv-invoice-show-keys.mjs)|
|請求書更新|`deal_id`、`deal_status`はレスポンスから落とす項目で、更新本文へ転記しない|[`RESPONSE_DROP_KEYS`と`runInvoicesUpdate`](../src/commands/invoices/update.ts)|
|会計取引作成|`DealPayload`は`company_id`、`type`、`issue_date`、`partner_id`、`details`、任意の`due_date`、`receipt_ids`、`ref_number`。`invoice_id`等の請求書指定項目は見つからない|[`DealPayload`と`buildDealPlan`](../src/domain/deal-plan.ts)、[`runDealsCreate`](../src/commands/deals/create.ts)|
|README|請求書の取消と紐づく取引の削除に関する注意はあるが、既存取引を紐付けるコマンドは見つからない|[READMEの請求書取消](../README.md)|

fixtureの取得元は[公式の請求書OpenAPI](https://github.com/freee/freee-api-schema/blob/master/iv/open-api-3/api-schema.yml)。このURLの内容は今回取得していない。レスポンスに項目が存在することと、その項目を書き込み可能なことは別である。

## 実装した確認オプション

`deals create --type income --invoice-id <id>`は、`invoices get`と同じ`GET /iv/invoices/{id}?company_id=...`で請求書を読む確認オプションである。請求書を紐付ける書き込みではなく、`POST /api/1/deals`の本文にも請求書指定項目は追加しない。

事前にID・事業所・未取消・`deal_status=unregistered`・`deal_id`が未指定またはnullであることを照合する。金額は`total_amount`と明細合計、取引先は`partner_id`、発生日は`billing_date`、期日は`payment_date`と`--due-date`を完全一致で照合する。これはCLIが採用する照合ルールであり、API側で紐付くことを意味しない。期日未指定はnullまたは欠落同士のみ許可する。異なる日付を使う必要がある請求書はこのオプションでは扱わない。

既定はdry-runで、`invoiceCheck`を返す。照合失敗はdry-runでも例外とし、送信しない。executeでは従来の`--expect-total`に加え、`--expect-invoice-number`の完全一致を必須とする。`--allow-duplicate`を付けても請求書の照合は省略しない。

登録後に同じGETで読み戻し、事前と同じ照合項目に加えて`deal_status=registered`と`deal_id=作成した取引ID`を要求する。一致すれば`invoiceReadback`を返す。未登録・別取引・取得失敗などでは、取引作成済みIDを含む警告の例外を返す。CLI入口の既存エラー処理により終了コード1になる。自動再試行・自動取消は行わない。

監査は既存の`deal_create`の`planned`または`attempting`→`succeeded`を使用する。作成後の請求書確認に失敗した場合は、続けて`failed`、`write_state=succeeded`、`created_id`、`reason=invoice_readback_failed`を記録する。`succeeded`は取引POSTの成功であり、請求書確認の成功を表さない。追加の失敗監査が書けなくても、警告と作成済み状態を維持する。監査に請求書の全文・番号は追加しない。

## 運用上の限界

公開APIによる紐付け手段を確認できていないため、会計取引を作成しても請求書が未登録のまま残り、事後確認が失敗する可能性がある。失敗時に再実行したり、画面で請求書から取引登録したりすると、二重の売掛金が立つおそれがある。警告時は処理を止め、`invoices get`と`deals get`で確認する。既存の`invoices get`では取引登録状態を確認でき、取引IDとの一致は本オプションの`invoiceReadback`で確認する。

同一取引先・発生日・金額の既存取引は、種別・決済状態を問わず全ページで照合し、`--allow-duplicate`なしのexecuteを止める。ただし同時実行や後日の画面操作を排他する仕組みはなく、二重計上を全面的に防ぐものではない。実機確認では、既存の請求書と取引を読むところから始め、書き込みは個別承認後に実施する。
