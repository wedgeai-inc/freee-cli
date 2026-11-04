# 請求書と取引の紐付け方針

## 結論

確認したfreeeの公開APIには、請求書と取引を紐付ける手段がない。このため、`deals create`は`--invoice-id`を拒否する。請求書から取引を登録する場合は、freeeのWeb画面を使う。

## 公開APIの根拠

公式OpenAPIスキーマと会計APIリファレンスの確認日：2026-11-04。

- [会計APIの公式OpenAPIスキーマ](https://github.com/freee/freee-api-schema/blob/master/v2020_06_15/open-api-3/api-schema.json)：取引作成（`POST /api/1/deals`）の`dealCreateParams`には、`issue_date`・`type`・`company_id`・`due_date`・`partner_id`・`partner_code`・`ref_number`・`details`・`payments`・`receipt_ids`・`parent_id`が定義されている。請求書IDの項目はなく、取引更新（`PUT /api/1/deals/{id}`）の`dealUpdateParams`にもない。
- [請求書APIの公式OpenAPIスキーマ](https://github.com/freee/freee-api-schema/blob/master/iv/open-api-3/api-schema.yml)：請求書の作成・更新に使う`InvoiceRequest`には取引IDの項目がない。一方、請求書の応答には`deal_status`（`registered`・`unregistered`）と`deal_id`（integer・nullable）が定義され、`unregistered`のとき`deal_id`は`null`になる。これらは読み取り用の応答項目であり、紐付けを指定する入力項目ではない。
- 上記スキーマと[会計APIリファレンス](https://developer.freee.co.jp/reference/accounting/reference)では、請求書と取引を結び付ける専用エンドポイントは見つからなかった。

取引一覧（`GET /api/1/deals`）のクエリには、`company_id`・`partner_id`・`account_item_id`・`partner_code`・`status`・`type`・`start_issue_date`・`end_issue_date`・`start_due_date`・`end_due_date`・`start_renew_date`・`end_renew_date`・`min_due_amount`・`offset`・`limit`・`accruals`があり、`ref_number`での絞り込みはない。応答の取引にはnullableの`ref_number`が含まれるため、管理番号の検索はCLI側で行う（[会計APIの公式OpenAPIスキーマ](https://github.com/freee/freee-api-schema/blob/master/v2020_06_15/open-api-3/api-schema.json)）。

## CLIの挙動

- [`deals create`](../src/commands/deals/create.ts)：`--invoice-id`または`--expect-invoice-number`を指定すると、dry-run・`--execute`のどちらでも認証・API呼び出し・監査記録の前にエラーになる。請求書指定のない取引作成と既存の重複検知は維持する。
- [`invoices get`・`invoices list`の応答変換](../src/types/invoice.ts)：API応答の`deal_id`が数値または`null`ならJSONにそのまま含める。未指定またはそれ以外の型なら省略する。数値の`deal_id`は`deals get`に渡して対応する取引を確認できる。表の列は変更しない。
- [`deals list --ref-number`](../src/commands/deals/list.ts)：既存のAPI検索条件で全ページを取得した後、`ref_number`を完全一致で絞る。一致が1件の場合だけ成功し、CLIはJSON配列を返す。0件なら管理番号の確認、2件以上なら取引先・種別・発生日・決済状態などの条件追加を求めてエラーになる。空文字・空白だけの指定も拒否する。

利用方法は[README](../README.md)の「未決済取引の作成（dry-run既定）」と「請求書」も参照。

## 未確認事項と制約

- 実在データを使ったAPIの実機確認は未実施であり、実環境での応答や動作は未確認。
- Web画面で請求書から登録した取引の管理番号が請求書番号になるかは、確認した仕様書に記載がなく未確認。管理番号による検索には、両者が一致することの確認が必要であり、検索結果だけでは請求書との紐付けを証明できない。
- `invoices get`で従来`deal_id`が表示されなかった原因は、CLIの項目の許可リストによるものと推測している。実機での原因確認は未実施。
- **二重計上に注意する。** CLIで取引を作った後にWeb画面で同じ請求書から取引登録すると、売掛金が二重に計上される可能性がある。Web画面で登録する前に、既存取引と請求書の登録状態を確認する。

## 関連テスト

以下はモックと架空データによるテストであり、実機確認を代替しない。

- [`deals-create.test.ts`](../tests/unit/deals-create.test.ts)：請求書指定・確認番号の拒否と、既存の作成・重複検知。
- [`invoice-deal-cli.test.ts`](../tests/unit/invoice-deal-cli.test.ts)：CLI経由の拒否、管理番号検索、JSON配列の出力とエラー。
- [`invoice-deal-id.test.ts`](../tests/unit/invoice-deal-id.test.ts)：請求書get・listのJSONで数値・nullを保持し、不正な型・未指定を省略する挙動。
- [`deals-ref-number.test.ts`](../tests/unit/deals-ref-number.test.ts)：全ページ取得後の完全一致、既存条件との併用、一致しない場合・複数一致の場合のエラー、空文字・空白の拒否。
