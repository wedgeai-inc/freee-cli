# wallet-txns create-deal の設計

対象Issue：#58

## 目的

口座・カードの明細1件から取引を1件登録し、同時に消し込みます。呼び出し側が承認した1行を、安全に1回だけ実行するための道具です。経理の判断（科目・税区分の選択）は持ちません。

## スコープ

**やること：** 1明細につき1行、円の全額での取引登録。dry-run既定、照合、二重作成の拒否、読み戻し、監査ログ。

**やらないこと：** 複数行、差額、一部入金、外貨の判定、証憑の紐付け（既存の`deals attach-receipt`を使う）、消込の取消、外部ガードの呼び出し口、バッチ実行。

## インターフェース

```text
freee wallet-txns create-deal <wallet-txn-id> --company-id <id>
  --partner-id <id> --account-item-id <id> --tax-code <n> --amount <n>
  [--issue-date YYYY-MM-DD] [--description <text>]
  [--expect-amount <n>] [--expect-date YYYY-MM-DD]
  [--execute] [--log-dir <path>] [--task-id <id>]
```

- `--partner-id`・`--account-item-id`・`--tax-code`は必須です。APIでは省略できますが、既定の税区分や取引先なしを暗黙に適用しません
- `--amount`は正の安全な整数です
- `--execute`には`--expect-amount`が必須で、なければ認証前に停止します
- `--issue-date`を省略したら明細の日付を使います

既存の`wallet-txns reconcile`（`src/commands/wallet-txns/reconcile.ts`）と同じ形（オプション検証、依存の注入、ガード、監査）で作ります。

## API

- 読み取り：`GET /api/1/wallet_txns/{id}`、既存の`runDealsList`、`runPartnersGet`、`deals create`が使う勘定科目と税区分の名前の解決
- 書き込み：`POST /api/1/wallet_txns/{id}/create_deal`
- 本文：`{ company_id, issue_date, partner_id, deal_lines: [{ amount, account_item_id, tax_code, description? }] }`。`vat`と`tax_entry_method`は送りません
- 応答：`deal_ids`が正の安全な整数1件の配列であること。それ以外は`invalid create_deal response`

## ガード

`guards`の各項目が真のときだけ`--execute`で送信します。

| 項目 | 条件 |
|---|---|
| `expectedAmountMatches` | `--expect-amount`が未指定、または`--amount`と一致 |
| `expectedDateMatches` | `--expect-date`が未指定、または明細の日付と一致 |
| `walletTxnCompanyMatches` | 明細の`company_id`が指定と一致 |
| `walletTxnUnreconciled` | `status`が1、金額が正の安全な整数、`due_amount`が金額と一致 |
| `walletTxnAmountMatches` | 明細の金額と`--amount`が一致 |
| `entrySideKnown` | `entry_side`が`income`か`expense` |
| `issueDateNotAfterWalletDate` | 発生日が明細の日付以前（API仕様） |
| `dateNotFuture` | 明細の日付がJSTの今日以前 |
| `noExistingDeal` | 同じ事業所、同じ`partner_id`、同じ発生日、同じ金額の取引が0件 |

`noExistingDeal`が偽のときは、`wallet-txns reconcile`を使うべきなので、上書きのオプションは作りません。dry-runでは`duplicateCheck`に一致した取引IDを返します。

## 副作用の順序

1. 入力の検証（認証の前）
2. 読み取りとガードの判定
3. dry-run：`planned`か`guard_failed`を監査ログへ記録し、結果を返します。ガードが不成立なら終了コード1です
4. execute：ガード不成立なら`failed`・`not_attempted`を記録して例外にします
5. execute：`auditedAccountingWrite`で送信前の監査を保存し、保存できなければ送信しません
6. execute：読み戻します。明細が`status`2・`due_amount`0で、取引の事業所・取引先・金額・発生日が指定と一致すること、取引の`type`が明細の`entry_side`と一致すること（`dealTypeMatches`）を確かめます

**読み戻しの失敗や不一致は例外にし、作成済みの可能性と取引IDを出力します。自動で取消も再実行もしません。**

## 監査

- イベント名は`wallet_txn_create_deal`、ファイル名は`freee-wallet-txn-create-deal-YYYY-MM-DD.jsonl`です
- `target_id`は明細ID、`created_id`は作成された取引IDです
- 摘要は既存の`redactAccountingPayload`でマスクします
- 読み戻しの結果も`guards`と同じ形で実行結果のJSONへ含めます

## 受け入れ条件

1. dry-runは書き込みを行わず、送信予定、名前、全ガード、`duplicateCheck`を返し、`planned`を記録する
2. `--execute`は上の本文だけをPOSTし、`attempting`→`succeeded`の順に記録する
3. `--expect-amount`がない`--execute`は認証前に停止する
4. `--expect-amount`を1円ずらすと送信しない
5. ガードの各項目が1つ偽になると、それぞれ送信しない
6. 消込済みの明細と、既存の取引がある明細では送信しない（再実行で二度作られない）
7. 監査の保存に失敗すると送信しない
8. 読み戻しが不一致のとき、例外に取引IDを含め、再実行を促さない
9. README、AGENTS.mdの承認必須コマンドの一覧、監査ログの節に追記されている

## 承認の境界

`wallet-txns create-deal --execute`は本番の帳簿を変えます。人の個別承認の対象です。

## 検証コマンド

- 反復中：`npx vitest run tests/unit/wallet-txns-create-deal.test.ts tests/unit/wallet-txns-create-deal-cli.test.ts`
- 最後に1回：`npm run typecheck`と`npm test`

このrepoはpublicです。テストとドキュメントに実在の値を書きません。
