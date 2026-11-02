# freee-cli

[freee](https://www.freee.co.jp/) の公開 API（Public API）を操作するコマンドラインツールです。請求書・見積書・取引先の作成、請求書と取引先の更新、請求書と見積書の取消・復元、各種データのエクスポートを、端末から安全に実行することを目的にしています。

> **非公式ツールです。** 本ツールは freee 株式会社とは無関係の個人・有志によるもので、freee 株式会社による提供・保証・サポートはありません。freee の API 利用規約に従って利用してください。

## 特徴

- **書き込みは dry-run が既定です。** 請求書・見積書・取引先を変更するコマンドは、`--execute` を付けたときだけ API へ書き込みます。
- **対象の取り違えを防ぎます。** 取消・復元・更新の実行時には、請求書番号・見積書番号・取引先名の完全一致を要求します。
- **書き込みの記録を残します。** 実行結果を `./audit-logs/` に JSONL で保存します。メールアドレス・氏名・Authorization ヘッダーなど既知の項目名の値に加え、自由記述の中でもメールアドレスの形に一致する部分はマスクします。ただし個人情報を網羅的に検出するものではなく、件名・摘要や、請求書・見積書を作成したときの `partner_display_name` などはそのまま残ります（請求書の更新では `partner_display_name` や住所・担当者名もマスクします）。記録ファイルの扱いに注意してください。
- **token をファイルに平文で保存しません。** 認証情報は 1Password に保管するか、実行時にだけメモリ上で扱います。

> **エラー終了は「書き込まれていない」ことを意味しません。** 書き込み系コマンドは API へ送ってから応答の確認・必要に応じた読み戻し・記録保存をするため、送信後の結果不明・読み戻し失敗・記録保存の失敗でもエラー終了し、記録が `failed` になったり残らなかったりします。エラー終了したら、freee Web や `get` / `list` で対象を確かめるまで再実行しないでください。

## 必要なもの

- macOS・Linux などの POSIX 環境（Windows ネイティブ環境での動作は確認していません）
- Node.js 22.12 以上
- freee アプリストアで作成したアプリ（Client ID / Client Secret）
- token の保管に 1Password CLI（`op`）を使う場合は、その CLI。この方式は `/bin/sh`・`/bin/cat` と POSIX のプロセスグループ操作を使います

## インストール

```bash
git clone https://github.com/wedgeai-inc/freee-cli.git
cd freee-cli
npm ci
npm run build
node dist/src/cli.js --help
```

`--help` でヘルプ本文が表示されることを確かめてください。

以降の例は `freee` コマンドで書いています。リポジトリのルートで次のようにシェル関数を設定するか、`freee` を `node dist/src/cli.js` に読み替えてください（パスに `(` や `$` が含まれても壊れないよう、alias ではなく関数にしています。以前の README の `alias freee=…` を使っていた場合は、1 行目で解除し、シェルの起動ファイルに書いた alias も削除してください）。

```bash
unalias freee 2>/dev/null || :
FREEE_CLI_JS="$(pwd -P)/dist/src/cli.js"
freee() {
  node "$FREEE_CLI_JS" "$@"
}
```

この設定をシェルの起動ファイル（`~/.zshrc` など）に書く場合は、`$(pwd -P)` の部分をリポジトリの絶対パスに置き換えてください。起動ファイルが読まれるときのディレクトリで解決されてしまうためです。二重引用符の中では `$`・`` ` ``・`"` が展開されるので、絶対パスはシングルクォートで囲んで `FREEE_CLI_JS='/path/to/freee-cli/dist/src/cli.js'` のように書いてください（パスに `'` を含む場所は避けてください）。

## 認証

freee アプリストアでアプリを作成し、コールバック URL に `http://127.0.0.1:54321/callback` を登録してください。実行時には `FREEE_CLIENT_ID` と `FREEE_CLIENT_SECRET` を環境変数で渡します。値はファイルに保存せず、実行のたびにパスワードマネージャなどから注入してください。

認証方式は次の 2 つです。

- **1Password に token を保管する方式**: 初回だけブラウザで認可し、以後は refresh token で自動更新します。詳細は下の「1Password 管理の OAuth」を参照してください。
- **token を保存しない方式**: 実行のたびにブラウザで認可し、token をメモリ上でだけ使います。詳細は下の「credential を保存しない runtime OAuth」を参照してください。

1Password を使わない場合は、`FREEE_ACCESS_TOKEN` 環境変数に access token を設定しても実行できます。この場合、token の自動更新は行いません。

**`FREEE_ACCESS_TOKEN` が設定されていると、`--profile` の指定にかかわらず最優先で使われます。** 1Password の profile を使うときは、この環境変数を解除してください。

## コマンド

以下の例の `--company-id 1234567` は、ご自身の事業所 ID に置き換えてください。事業所 ID は `freee companies list` で確認できます。

| コマンド | 種別 |
|---|---|
| `auth login` | 1Password に token を保存する初回認可 |
| `companies list` | 読み取り |
| `walletables list` | 読み取り |
| `wallet-txns list` | 読み取り（口座明細） |
| `wallet-txns reconcile <wallet-txn-id>` | 書き込み（全額消込・dry-run既定） |
| `partners search` / `get` | 読み取り |
| `partners create` / `update` | 書き込み（dry-run 既定） |
| `invoices list` / `get` / `templates` | 読み取り |
| `invoices create` / `update` / `cancel` / `uncancel` | 書き込み（dry-run 既定） |
| `quotations list` / `get` / `templates` | 読み取り |
| `quotations create` / `cancel` / `uncancel` | 書き込み（dry-run 既定） |
| `account-items list` / `taxes list` | 読み取り（勘定科目・税区分） |
| `deals list` / `get <id>` | 読み取り |
| `receipts get <id>` | 読み取り |
| `deals create` | 書き込み（dry-run既定） |
| `deals payments create <deal-id>` | 書き込み（dry-run既定） |
| `receipts upload` | 書き込み（dry-run既定） |
| `expense list` | 読み取り |
| `export receipts` / `journals` / `wallet-txns` / `expense-applications` | 読み取り（ローカルへ保存） |

共通のオプション:

- `--format json|table`: 読み取り系の出力形式（既定 `json`）。`partners get`と`account-items`・`taxes`・`deals`・`receipts`・`wallet-txns`はJSON固定です。`export` は `--format` に対応せず、標準出力には件数や保存先などの実行結果を表示し、データは `--out` のファイルへ保存します
- `--log-dir <path>`: 書き込み系の audit log の出力先（既定 `./audit-logs`）
- `--task-id <id>`: audit log に記録する task ID
- `--profile <name>`: 1Password 管理の OAuth で使う profile（`FREEE_OAUTH_PROFILE` でも指定可）

### 事業所

```bash
freee companies list --format table
```

### 口座

```bash
freee walletables list --company-id <company-id> --format table
freee walletables list --company-id <company-id> --type bank_account
```

- `--type` に `bank_account` / `credit_card` / `wallet` を指定すると口座の種類で絞り込む。省略すると全種類を返す。
- 同期状況と最終同期日時を含める。残高は出さない。

#### 口座明細の一覧

```bash
freee wallet-txns list --company-id 1
freee wallet-txns list --company-id 1 --walletable-type bank_account --walletable-id 2 \
  --start-date 2026-01-01 --end-date 2026-01-31 --entry-side income \
  --sort-type created_at_desc --limit 100 --offset 0
```

上のIDは架空です。`--walletable-type`（`bank_account|credit_card|wallet`）と`--walletable-id`は両方指定するか両方省略します。`--entry-side`は`income|expense`、`--sort-type`は`created_at_desc`だけを指定できます。日付は実在する`YYYY-MM-DD`で、開始日は終了日以前にします。

出力はAPIの要素をそのまま含むJSON配列です。`--limit`は1〜100、`--offset`は0以上の整数です。両方を省略すると100件ずつ全ページを取得し、いずれかを指定するとそのページだけを取得します。ファイルへ保存する`export wallet-txns`は従来どおりです。

出力の`status`はAPIの数値をそのまま返します。

| status | 意味 |
| --- | --- |
| 1 | 消込待ち |
| 2 | 消込済み |
| 3 | 無視 |
| 4 | 消込中 |
| 6 | 対象外 |

### 取引・証憑

以下はすべて架空のID・名称・金額です。事業所・取引先・勘定科目・税区分は実行先の値に置き換えてください。

```bash
freee account-items list --company-id 1
freee taxes list --company-id 1
freee deals list --company-id 1 --partner-id 2 --type expense \
  --start-issue-date 2026-01-01 --end-issue-date 2026-01-31 --status unsettled
freee deals get 6 --company-id 1
freee receipts get 5 --company-id 1
```

`deals list`のフィルターは任意です。`--type`は`income|expense`、`--status`は`settled|unsettled`を指定します。一覧は全ページを取得します。

#### 証憑のアップロード（dry-run既定）

```bash
freee receipts upload --company-id 1 --file ./sample.pdf \
  --issue-date 2026-01-15 --description '架空証憑'
```

ファイル名・バイト数・拡張子から推定したMIME・SHA-256・送信予定項目をJSONで表示します。dry-runでは認証も送信も行いません。実行する場合は表示されたハッシュを確認して、同じ引数に`--execute --expect-sha256 <確認したSHA-256>`を追加します。一致したバイト列をメモリ上に保持してmultipartで送信し、結果の`created.id`に`receipt.id`を出力します。ファイルの内容は監査ログに保存しません。ファイルサイズは64MBまで（単位が未定義のため64×1024×1024バイトと解釈し、上限ちょうどは許可）で、超過時は認証・監査ログの記録前にエラーにします。dry-runで`--expect-sha256`を指定すると、`checks.expectSha256`に期待値・実際のハッシュ・一致結果を返し、形式不正や不一致の理由も表示します。不一致でも送信せず、監査ログは`planned`のままです。

#### 未決済取引の作成（dry-run既定）

```bash
freee deals create --company-id 1 --type expense --issue-date 2026-01-15 \
  --due-date 2026-02-15 --partner-id 2 \
  --detail 'account_item_id=3,tax_code=4,amount=1500,description=架空明細' \
  --receipt-id 5 --ref-number sample-001
```

`--detail`と`--receipt-id`は繰り返し指定できます。明細はカンマ区切りの`key=value`形式で、摘要にカンマは使えません。`--due-date`・`--receipt-id`・`--ref-number`と明細の`description`は任意です。金額は税込の安全な整数で、明細・合計とも負の値を許します。`payments`は送らず未決済で登録します。

dry-runの出力例（架空の値）:

```json
{
  "mode": "dry-run",
  "payload": {
    "company_id": 1,
    "type": "expense",
    "issue_date": "2026-01-15",
    "due_date": "2026-02-15",
    "partner_id": 2,
    "details": [{"account_item_id": 3, "tax_code": 4, "amount": 1500, "description": "架空明細"}],
    "receipt_ids": [5],
    "ref_number": "sample-001"
  },
  "total": 1500,
  "names": {"partner": "架空取引先", "accountItems": ["架空科目"], "taxes": ["架空税区分"]},
  "duplicateCheck": {"found": false, "dealIds": [], "blocked": false}
}
```

名前の解決と重複検知にはdry-runでも読み取りAPIと認証が必要です。dry-runでも全ページを照合し、`duplicateCheck`に重複の有無・一致した取引ID・実行時に阻止されるか（重複あり、かつ`--allow-duplicate`なし）を返します。重複があってもdry-runは例外にせず報告し、APIへの書き込みは行いません。`--expect-total`を指定すると、`checks.expectTotal`に期待値・明細合計・一致結果を返し、不一致でも報告のみです。確認オプション未指定なら`checks`は追加しません。実行する場合は同じ引数に`--execute --expect-total 1500`を追加します。明細合計が一致しなければ送信しません。同じ取引先・発生日・合計の取引を全ページで照合し、既存取引があれば止まります。取引種別・決済状態を問わず照合します。意図した重複を確認した場合だけ`--allow-duplicate`を付けてください。同時実行との間には競合の余地があるため、この照合はAPI側の冪等性を保証しません。

#### 取引の支払行の作成（dry-run既定）

```bash
freee deals payments create 6 --company-id 1 --date 2026-01-15 \
  --from-walletable-type bank_account --from-walletable-id 2 --amount 123
```

上のIDと金額は架空です。dry-runでも認証し、取引と口座を読み、送信予定の`payload`・口座名の`names`・`guards`の各判定・取引情報の`deal`をJSONで表示します。dry-runはガードがすべて成立すれば終了コード0、不成立ならJSONを標準出力へ出した上で終了コード1になります。自動化する側は終了コード1のとき`guards`を確認してください。

`deal`は送信前の`id`・`type`・`issue_date`・`amount`・`due_amount`・`partner_id`・`partner_name`を含み、executeでも返します。取引先IDがあるときは取引先取得APIから名前を取得し、取得に失敗すれば停止します。取引先IDがnullなら名前もnullです。

`private_account_item`では`--from-walletable-id`を勘定科目IDとして、`GET /api/1/account_items?company_id=...`で実在確認します。存在しない場合は`walletableExists=false`です。他の口座区分は`bank_account|credit_card|wallet`で、従来どおり口座一覧の区分とIDの組を照合し、勘定科目一覧は取得しません。金額とIDは1以上の安全な整数、日付は実在する`YYYY-MM-DD`を指定します。

支払日が取引の発生日より前なら`dateNotBeforeIssueDate=false`、Asia/Tokyoの今日より未来なら`dateNotFuture=false`になります。発生日と同日・今日の支払は許可します。取引の発生日が取得できない、または不正なら応答エラーで停止します。

実行には同じ引数に`--execute --expect-amount 123`を追加します。`--expect-amount`がないと認証前に停止します。確認金額と支払金額の不一致、取引の事業所の不一致、支払残額が0以下、支払金額と支払残額の不一致、口座・勘定科目の不存在、日付ガードの不成立では送信しません。一部支払は扱いません。支払行が作成された後の再実行は、支払残額が0になるため停止します。同時実行を排他する仕組みではありません。

#### 口座明細と既存取引の消込（dry-run既定）

```bash
freee wallet-txns reconcile 8 --company-id 1 --deal-id 6 --amount 123 \
  --expect-date 2026-01-15 --log-dir ./audit-logs --task-id sample
# 実行する場合は同じ引数に --execute --expect-amount 123 を追加
```

上のIDと金額は架空です。既定はdry-runで、明細と取引を読み取り、`payload`・`wallet_txn`・`deal`・`guards`をJSONで返します。`--execute`には`--expect-amount`が必須で、省略すると認証前に停止します。IDと金額は正の安全な整数、`--expect-date`は実在する`YYYY-MM-DD`で指定します。1明細↔1取引の全額消込だけに対応し、差額を自動吸収しません（`adjustment_deal`非対応）。本文は`{ company_id, deals: [{ deal_id, amount }] }`だけです。

次のガードをすべて満たす場合だけPOSTします。欠落・null・型違いの判定対象値は不成立です。

| ガード | 成立条件 |
|---|---|
| `expectedAmountMatches` | `--expect-amount`が未指定、または`--amount`と一致 |
| `expectedDateMatches` | `--expect-date`が未指定、または明細日と一致 |
| `walletTxnCompanyMatches` / `dealCompanyMatches` | 明細・取引それぞれの事業所IDが指定値と一致 |
| `walletTxnUnreconciled` | 明細金額が正の安全な整数で、`status=1`かつ`due_amount=amount`（`status=4`の一部消込済みは不可） |
| `walletTxnAmountMatches` | 明細金額が正の安全な整数で、指定金額と完全一致 |
| `dealHasOutstandingAmount` | 取引の残額が正の安全な整数 |
| `dealAmountMatchesDue` | 取引の残額が指定金額と一致 |
| `entrySideMatchesDealType` | 明細の入出金区分と取引の収支区分が`income`同士または`expense`同士 |
| `dateNotBeforeIssueDate` | 明細日が有効で、取引の発生日以降（同日を含む） |
| `dateNotFuture` | 明細日が有効で、Asia/Tokyoの今日以前（今日を含む） |
| `dealStatusUnsettled` | 取引の`status=unsettled` |

ガード不成立のdry-runもJSONを標準出力へ返し、終了コード1になります。全成立なら終了コード0です。明細の摘要（`description`）は出力しません。`deal.partner_id`がある場合は取引先APIから`partner_name`を取得し、取得失敗はエラーにします。取引先IDがなければ名前もnullです。execute成功時は`created: { wallet_txn_id, deal_ids }`を追加します。

freee側で明細または取引が既に別の対象で消込・決済済みならHTTP 409です。消込後の再実行は明細・取引のstatusや残額が変わるためガードで止まります。同時実行を排他する仕組みではありません。応答の明細ID・`deal_ids`が要求した取引IDだけの配列（長さ1）であること・`new_deal_id=null`を検証し、不正なら送信済みとして停止します。`new_deal_id`が非nullなら想定外の差額取引が作られた旨を表示し、再実行前の確認を要求します。実機での動作は未検証です。

出典：[freee公式APIリファレンス](https://developer.freee.co.jp/docs/accounting/reference)、[公式OpenAPIスキーマ](https://github.com/freee/freee-api-schema/blob/master/v2020_06_15/open-api-3/api-schema.json)（2026-11-02時点の抜粋に準拠）、[消込APIのお知らせ](https://developer.freee.co.jp/accounting/accounting-improvement/8614)。

#### 取引・証憑・支払・消込の監査ログ

これら4つの書き込みは`--log-dir`（既定`./audit-logs`）にJSONLを残します。摘要・参照番号・既知の個人情報・Bearer値をマスクし、証憑はファイル名とSHA-256だけを記録します。送信前に監査ログを保存できなければ送信しません。送信後の失敗では作成・更新済みの可能性があるため、`deals list/get`・`receipts get`で確認してから再実行してください。成功時はAPI応答のIDを返します。登録内容は上の`get`コマンドで確認できます。

支払のイベント名は`deal_payment_create`、ファイル名は`freee-deal-payment-create-YYYY-MM-DD.jsonl`です。`target_id`に取引IDを記録し、成功時の`created_id`も取引IDです。既存の書き込みと同様、`mode`（`dry-run|execute`）、`status`（`planned|attempting|succeeded|failed`）、`payload_redacted`を記録します。executeでガードが不成立なら、送信前に`status=failed`・`write_state=not_attempted`・`reason=guard_failed:<不成立のガード名をカンマ区切り>`を1件記録します。監査への追記も失敗した場合は、ガードエラーに監査失敗のメッセージを添えて停止します。送信時は`write_state`で未送信（`not_attempted`）・拒否（`rejected`）・結果不明（`unknown`）・成功（`succeeded`）を区別します。

消込のイベント名は`wallet_txn_reconcile`、ファイル名は`freee-wallet-txn-reconcile-YYYY-MM-DD.jsonl`です。`target_id`は明細ID、`payload_redacted`は送信本文の`company_id`と`deals`で、`created_id`は保存しません。dry-runは`planned`を1件記録します。executeのガード不成立は支払と同じく`failed / not_attempted / guard_failed:<ガード名,...>`を1件記録し、POSTしません。送信前に`attempting`を保存し、成功は`succeeded`、失敗は`failed`と`write_state`を保存します。HTTP 409は`rejected`、通信障害やサーバーエラーは`unknown`、成功応答の検証失敗（想定外の差額取引を含む）や送信後の監査失敗は`succeeded`です。送信結果を確認してから再実行してください。

### 取引先

#### 検索

```bash
freee partners search --company-id 1234567 --keyword "取引先名" --format table
```

#### 作成（dry-run 既定）

```bash
# dry-run: plan を検証して監査記録を残すが、POST はしない
freee partners create --company-id 1234567 --plan ./partner-plan.json

# execute: POST → 読み戻し照合 → audit log
freee partners create --company-id 1234567 --plan ./partner-plan.json --execute
```

plan は `POST /api/1/partners` の body のうち、CLI が対応する項目だけを書いた JSON です（許可する項目は [`src/domain/partner-plan.ts`](./src/domain/partner-plan.ts)）。body を `partner` でラップしません。`company_id` と、口座・振込に関わる `payer_walletable_id` / `transfer_fee_handling_side` / `partner_bank_account_attributes`、未知のキーは拒否します。

```json
{"name":"株式会社サンプル","code":"sample","default_title":"御中","country_code":"JP"}
```

- `name` は空・空白のみを拒否します。`code` は255文字以内かつ空・空白のみを拒否します。`default_title` は `"御中"` / `"様"` / `""` のみです（いずれも CLI 固有の制限）。
- `shortcut1` / `shortcut2` / `long_name` / `name_kana` / `contact_name` / `email` / `phone` / `address_attributes.zipcode` / `address_attributes.street_name1` / `address_attributes.street_name2` は空文字列を許します。住所の項目は `address_attributes` の下に書きます。
- 読み戻しで指定値との一致を確認できなかった項目は `created.ignored` に出ます。**空でなくても終了コードは成功**なので、実行後に確認し、残った項目は freee Web で確かめてください。
- コマンド自身は POST 後に再試行しません。`unknown` で終了した場合、プロセスをまたぐ重複は自動判定できないため、再実行前に `partners search` で作成済みか確認してください。

#### 取得・更新（dry-run 既定）

```bash
freee partners get --company-id 1234567 --id 100
freee partners update --company-id 1234567 --id 100 --plan ./partner-update.json
freee partners update --company-id 1234567 --id 100 --plan ./partner-update.json --expect-name "株式会社サンプル" --execute
```

`get` は API 応答の `partner` を JSON で返します。`update` は GET した変更対象との差分を dry-run で表示します。`--execute` では `--expect-name` が必須で、現在名が完全一致した場合だけ PUT します。plan の `name` は任意で、省略時は現在名を送ります。`code` は update plan では受け付けません。`available` と、3項目すべてを持つか `null` の期日設定を更新できます。`org_code`、`invoice_registration_number`、`partner_doc_setting_attributes.sending_method` は update plan で `null` を受け付けず、CLI から未設定へ戻せません（API 一次情報の記述が衝突しているため、保守的に拒否します）。

```json
{"available":false,"address_attributes":{"zipcode":"1000001"}}
```

- PUT 後に読み戻しを行います。指定値との一致を確認できなかった項目は `updated.ignored` に出ます。**空でなくても終了コードは成功**なので、実行後に確認してください。結果不明で終了した場合は、再実行せず freee Web で対象を確認してください。

### 請求書

#### 一覧・取得・テンプレート

```bash
freee invoices list --company-id 1234567 --start-billing-date 2026-09-01 --end-billing-date 2026-09-30 --format table
freee invoices get --company-id 1234567 --id 123 --format json
freee invoices templates --company-id 1234567 --format table
```

`freee invoices next-number --company-id <company-id> --prefix ABC`は、取消済みを含む既存の請求書から`ABC-001`形式の次の番号を計算します。`--partner-id <partner-id>`で取引先の一致を確認でき、同じ接頭辞が複数の取引先に使われている場合は停止します。`--width 4`で最小桁数を指定でき（1〜10、既定3）、既存番号の桁数は維持します。出力は既定JSON、`--format table`で表形式です。全ページを取得できない場合は番号を返しません。番号の予約や帳票への書き込みは行いません。freee販売から作られた帳票も含めて数えます（freee販売の帳票へのアクセス権限が無い場合はAPIがエラーを返し、番号は返しません）。

- `list` は `--partner-ids 1,2,3`（最大3件）、`--sending-status sent|unsent`、`--payment-status settled|unsettled|canceled|unprocessed|failed` で絞り込めます。
- freee 請求書 API は 2026-09-21 以降 `limit + offset` が 10,000 を超える取得をエラーにするため、`list` はその手前で中断します。上限に達すると終了コード 1 で終わり、取得済みの分も出力しません（ちょうど 10,000 件でも失敗します）。件数が多い場合は `--start-billing-date` / `--end-billing-date` で期間を絞ってください。
- `invoices list`は、freee販売から作成された請求書を含める `sales_management_origin` には対応していません。
- PDF の取得・請求書の送付は freee 請求書 API にないため、Web で行ってください。

#### 作成（dry-run 既定）

```bash
# dry-run（既定）: plan を検証し、参考金額と送信予定 payload を表示。実 POST しない
freee invoices create --company-id 1234567 --plan ./plan.json

# execute: 実 POST → 読み戻し → audit log（./audit-logs/freee-invoice-create-<date>.jsonl）
freee invoices create --company-id 1234567 --plan ./plan.json --execute
```

接頭辞から番号を自動採番するには、`--number-prefix ABC`を指定します。

```bash
freee invoices create --company-id <company-id> --plan ./plan.json --number-prefix ABC
freee invoices create --company-id <company-id> --plan ./plan.json --number-prefix ABC --execute
```

`partner_id`が正の整数であるplanが必要です。`partner_code`だけのplanや、`invoice_number`キーを含むplan（空文字を含む）とは併用できません。取消済みとfreee販売の帳票を含む一覧から次の番号を計算し、同じ接頭辞が別の取引先で使われていれば停止します。dry-runでも認証して一覧をGETで読みます。帳票への書き込みはしませんが、認証トークンの更新は他の読み取りコマンドと同じく起こりえます。`--execute`では実行の直前に一覧から計算し直し、dry-runの番号を引き継ぎません。番号は予約しないため、同時に別の帳票を作ると番号がずれうる点に注意してください。


plan JSON は `POST /invoices` のボディのうち、CLI が対応する項目だけを書いたもの（許可する項目と値は [`src/domain/invoice-plan.ts`](./src/domain/invoice-plan.ts)）。`company_id` と `partner_sending_method`、未知キーは拒否する。API で定義されていても CLI が受け付けない項目・値がある（例: `payment_type` は `transfer` / `direct_debit` のみ）。

```json
{
  "billing_date": "2026-09-05",
  "payment_date": "2026-10-31",
  "partner_id": 123,
  "partner_title": "御中",
  "subject": "2026年8月分 業務委託料",
  "tax_entry_method": "out",
  "tax_fraction": "omit",
  "withholding_tax_entry_method": "out",
  "lines": [
    { "description": "開発支援（2026年8月分）", "quantity": 56.07, "unit": "時間", "unit_price": "10000", "tax_rate": 10 }
  ]
}
```

- 1 回の実行で作成する請求書は 1 件のみ。送付（メール・郵送）は行わない
- dry-run の金額は参考値。確定値は `--execute` 後に読み戻した freee の応答を正とする

#### 更新（dry-run 既定）

plan は**作成 plan の許可項目に限る部分パッチ**。GET で読んだ現在値から完全な body を組み立て、plan に書いた項目だけを上書きして PUT する。GET から引き継いで送る項目のうち、plan の許可項目にないもの（`issue_date` や住所など）は plan に書くと拒否される。
省略した項目は現在値がそのまま送られるので、変えない項目を書き直す必要はない。`lines` は**配列ごと置換**（行単位のマージはしない）。

plan で変えない現在値も、送る前に同じ制約で検証する。部署名・担当者名・住所の建物名などが空文字で返る請求書では、別の項目だけの更新でも PUT 前に停止することがある。このとき出るエラーメッセージには、原因となった項目名（例: `partner_contact_department`）が具体的に含まれる。これらは plan で変更できない項目なので、plan に足したりダミー値を入れたりせず、必要な変更は freee Web で行う。

```bash
# dry-run（既定）: 現在値との差分・参考金額・送る body を出す
freee invoices update --company-id 1234567 --id 123 --plan ./patch.json

# execute: 請求書番号を完全一致で照合してから更新する（--expect-invoice-number は必須）
freee invoices update --company-id 1234567 --id 123 --plan ./patch.json --expect-invoice-number INV-123 --execute

# registered の取引が紐づく場合は明示許可する
freee invoices update --company-id 1234567 --id 123 --plan ./patch.json --expect-invoice-number INV-123 --allow-deal-registered --execute
```

- 取消済み（`cancel_status: canceled`）は常に拒否する。先に `uncancel` する
- **GET から復元して送れない 12 項目**がある。plan に明示すれば `partner_contact_email_to` / `partner_contact_email_cc` / `lines[].tag_ids` の **3 項目は送れる**が、`include_amount_brought_forward` / `partner_sending_method` と明細の `account_item_id` / `tax_code` / `item_id` / `section_id` / `segment_1_tag_id` / `segment_2_tag_id` / `segment_3_tag_id` の **9 項目は allowlist 外で送れない**。上位4項目はメール宛先・送付方法・繰越設定、明細8項目は取引登録の下書きに関わる。PUT が置換動作であれば、plan に明示しない既存値が失われる可能性がある。警告は成否を問わず stderr に出る。
- GET 応答に未知のキーが現れたら PUT せずに停止する（`unmapped_response_key:<key>`）
- GET と PUT の間の競合更新は検出できない。API に version / ETag による条件付き更新が無いため、更新直前の対象確認と更新後の freee Web 確認が必要。

#### 取消（dry-run 既定）

```bash
# dry-run（既定）: 対象の請求書番号・金額・取引先 ID・取引状態を GET して audit に planned を残す
freee invoices cancel --company-id 1234567 --id 123

# execute: 請求書番号を完全一致で照合してから取消する
freee invoices cancel --company-id 1234567 --id 123 --expect-invoice-number INV-123 --execute

# registered の取引が紐づく場合は、取引削除を明示許可する必要がある
freee invoices cancel --company-id 1234567 --id 123 --expect-invoice-number INV-123 --allow-deal-deletion --execute
```

`--execute` には `--expect-invoice-number` が必須です。取消すると紐づく取引も削除されるため、`deal_status: registered` の対象では `--allow-deal-deletion` も必要です。audit log は `./audit-logs/freee-invoice-cancel-<date>.jsonl` に残ります。

#### 復元（dry-run 既定）

```bash
# dry-run: 取消済みか確認して audit に planned を残す
freee invoices uncancel --company-id 1234567 --id 123

# execute: 請求書番号を完全一致で照合してから復元する
freee invoices uncancel --company-id 1234567 --id 123 --expect-invoice-number INV-123 --execute
```

`canceled` の対象だけを復元します。`--execute` には `--expect-invoice-number` が必須です。PUT 応答で ID と `uncanceled` を照合しますが、復元後の番号は確認していません。audit log は `./audit-logs/freee-invoice-uncancel-<date>.jsonl` に残ります。

取消時に削除された紐づく取引が復元で戻るかは確認していません。

### 見積書

#### 一覧・取得・テンプレート

```bash
freee quotations list --company-id 1234567 --start-quotation-date 2026-09-01 --end-quotation-date 2026-09-30 --format table
freee quotations get --company-id 1234567 --id 123 --format json
freee quotations templates --company-id 1234567 --format table
```

`freee quotations next-number --company-id <company-id> --prefix ABC`は、取消済みを含む既存の見積書から`ABC-001`形式の次の番号を計算します。`--partner-id <partner-id>`で取引先の一致を確認でき、同じ接頭辞が複数の取引先に使われている場合は停止します。`--width 4`で最小桁数を指定でき（1〜10、既定3）、既存番号の桁数は維持します。出力は既定JSON、`--format table`で表形式です。全ページを取得できない場合は番号を返しません。番号の予約や帳票への書き込みは行いません。freee販売から作られた帳票も含めて数えます（freee販売の帳票へのアクセス権限が無い場合はAPIがエラーを返し、番号は返しません）。

- `list` は `--quotation-number`、`--subject`、`--partner-ids 1,2,3`（最大3件）、`--sending-status sent|unsent`、`--cancel-status canceled|uncanceled`、`--start-expiration-date` / `--end-expiration-date` で絞り込めます。
- `--sales-management-origin` は絞り込みではなく、freee販売から作成された見積書**も含める**フラグです（既定では含めません。付けるには freee販売の帳票へのアクセス権限が必要です）。
- 請求書と同じく、`limit + offset` が 10,000 を超える手前で終了コード 1 で中断し、取得済みの分も出力しません。件数が多い場合は期間で絞ってください。

#### 作成（dry-run 既定）

```bash
# dry-run（既定）: plan を検証し、参考金額と送信予定 payload を表示。実 POST しない
freee quotations create --company-id 1234567 --plan ./quotation-plan.json

# execute: 実 POST → 読み戻し → audit log（./audit-logs/freee-quotation-create-<date>.jsonl）
freee quotations create --company-id 1234567 --plan ./quotation-plan.json --execute
```

接頭辞から番号を自動採番するには、`--number-prefix ABC`を指定します。

```bash
freee quotations create --company-id <company-id> --plan ./quotation-plan.json --number-prefix ABC
freee quotations create --company-id <company-id> --plan ./quotation-plan.json --number-prefix ABC --execute
```

`partner_id`が正の整数であるplanが必要です。`partner_code`だけのplanや、`quotation_number`キーを含むplan（空文字を含む）とは併用できません。取消済みとfreee販売の帳票を含む一覧から次の番号を計算し、同じ接頭辞が別の取引先で使われていれば停止します。dry-runでも認証して一覧をGETで読みます。帳票への書き込みはしませんが、認証トークンの更新は他の読み取りコマンドと同じく起こりえます。`--execute`では実行の直前に一覧から計算し直し、dry-runの番号を引き継ぎません。番号は予約しないため、同時に別の帳票を作ると番号がずれうる点に注意してください。


plan JSON は `POST /quotations` のボディのうち、CLI が対応する項目だけを書いたものです（`company_id` と `partner_sending_method`、未知キーは拒否）。API で定義されていても、`partner_address_zipcode` などの住所項目は受け付けません。`quotation_date` は必須です（許可する項目は [`src/domain/quotation-plan.ts`](./src/domain/quotation-plan.ts)）。明細の数量・単価・税率の書き方は請求書と同じですが、請求書の明細で使える `sales_date` と `tag_ids` は見積書では使えません。

```json
{
  "quotation_date": "2026-09-05",
  "expiration_date": "2026-10-05",
  "partner_id": 123,
  "partner_title": "御中",
  "subject": "開発支援のお見積り",
  "tax_entry_method": "out",
  "tax_fraction": "omit",
  "withholding_tax_entry_method": "out",
  "lines": [
    { "description": "開発支援", "quantity": 40, "unit": "時間", "unit_price": "10000", "tax_rate": 10 }
  ]
}
```

- 1 回の実行で作成する見積書は 1 件のみ。送付は行いません
- 見積書番号の採番設定は API から読めないため、dry-run では `quotation_number` の要否を検証しません

#### 取消・復元（dry-run 既定）

```bash
# 取消
freee quotations cancel --company-id 1234567 --id 123
freee quotations cancel --company-id 1234567 --id 123 --expect-quotation-number Q-123 --execute

# 復元（取消済みの見積書だけが対象）
freee quotations uncancel --company-id 1234567 --id 123
freee quotations uncancel --company-id 1234567 --id 123 --expect-quotation-number Q-123 --execute
```

`--execute` には `--expect-quotation-number` の完全一致が必須です。結果が不明で終了した場合は、再実行せず freee Web で対象を確認してください。audit log は `./audit-logs/freee-quotation-cancel-<date>.jsonl` / `freee-quotation-uncancel-<date>.jsonl` に残ります。

### 経費申請の一覧

```bash
freee expense list --company-id 1234567 --start-transaction-date 2026-09-01 --end-transaction-date 2026-09-30 --format table
```

- `--status`（例: `approved`）で絞り込めます。読み取りのみで、承認・取引登録は行いません。
- runtime OAuth の plan では実行できません（下の「credential を保存しない runtime OAuth」の許可リストに含まれないため）。添付ファイルまで保存する場合は `export expense-applications` を使ってください。

## 1Password 管理の OAuth（初回認可後は refresh）

`FREEE_ACCESS_TOKEN` が設定されていない場合、通常の Public API コマンドは 1Password を token bundle の唯一の管理元として使用する。初回だけ `freee auth login --profile <name>` を実行し、表示されたローカルの `/start` をブラウザで開く。認可成功後、access token・single-use refresh token・期限は 1Password item の stdin template 更新で保存する。以後は同じ `--profile`（または `FREEE_OAUTH_PROFILE`）で item を選び、期限内は refresh せず、期限切れ時だけ refresh token を回転して保存完了後に API を呼ぶ。

profile ごとの item 参照は実行時に `FREEE_OAUTH_ITEM_REFERENCE_<PROFILE>` として注入する（`<PROFILE>` は大文字、`-` は `_`）。profile 名は `^[a-z0-9][a-z0-9-]*$`（小文字・数字・ハイフン）に限る。大文字や `_` を許すと環境変数名が衝突し、別 profile の rotation が互いの item を上書きしうるため。

**1Password の service account で実行する場合は `FREEE_OAUTH_VAULT_<PROFILE>` に vault 名も注入する。** service account では `op item get` / `op item edit` に vault の指定が必須で、無いと `a vault query must be provided when this command is called by a service account` で失敗する。個人アカウント（Touch ID）では省略してよい。対象 item は事前に `access_token`、`refresh_token`、`expires_at` の各 field を持たせる。token・secret・認可コードをファイル、ログ、標準出力、argv に置かない。**item 参照は `op` の argv に渡す**（値そのものではなく、どの item かを指す名前であり credential ではない）。ソース・テスト・fixture には埋め込まず、実行時に注入する。`op item edit` への token bundle は標準入力だけで渡す。refresh が無効な場合は自動でブラウザを開かず、`freee auth login --profile <name>` を明示的に実行して再認可する。

従来の `~/.config/freee-mcp/tokens.json` は通常 CLI の token 管理元としては使用しない。`FREEE_ACCESS_TOKEN` は runtime OAuth が子プロセスへ token を渡す経路と、手元での一時的な利用のためのもので、永続保存先ではない。設定されていると `--profile` より優先される。

## credential を保存しない runtime OAuth（read-only export と invoices / quotations / partners write に共用）

`FREEE_CLIENT_ID`と`FREEE_CLIENT_SECRET`をruntime注入し、ローカルの`/start`をブラウザで開く。callbackの認可コードをメモリ上でtokenへ交換し、Access Tokenを検証済みのCLI runtime plan にだけ渡す。token、code、secret、stateはファイルや標準出力へ保存しない。

plan v2 は CLI ルートからの引数配列を `commands` に含むJSONで、最大500コマンド・1 コマンドあたり引数 64 個まで受け付ける（旧形式を正規化したあとの数で数える）。許可される先頭2要素は `export journals` / `export receipts` / `export wallet-txns` / `export expense-applications`、`companies list`、`partners search` / `create` / `get` / `update`、`invoices list` / `get` / `templates` / `create` / `update` / `cancel` / `uncancel`、`quotations list` / `get` / `templates` / `create` / `cancel` / `uncancel` のみである。旧形式の `journals` などの export subcommand は `export journals` に正規化して互換実行する。任意のshell・実行ファイル・`expense` / `auth` 等の未許可コマンドは拒否する。

`invoices create` / `update` / `cancel` / `uncancel`、`quotations create` / `cancel` / `uncancel`、`partners create`、`partners update` は dry-run が既定だが、plan に `--execute` を含めると runtime OAuth 経由でも実際に API write をする。`invoices update --execute` / `cancel --execute` / `uncancel --execute` には `--expect-invoice-number` が、`quotations cancel --execute` / `uncancel --execute` には `--expect-quotation-number` が、`partners update --execute` には `--expect-name` が必須である。実行前に対象と plan 内容を確認すること。

- 事前の検証は、plan の形・コマンド数・許可された先頭 2 要素までで、各コマンドのオプションや参照先の plan JSON の中身は実行時に検証される。
- `commands` は**先頭から 1 つずつ実行し、失敗した時点で止まる**。先に成功した書き込みは取り消さず、途中から再開する機能もない。失敗したら各コマンドの結果を確かめ、実行済みの作成コマンドを含む plan を丸ごと再実行しない。
- `commands` の中の相対パス（`--plan` / `--out` / `--log-dir`）は、runtime plan ファイルの場所ではなく**リポジトリのルートを基準**に解決される。リポジトリの外のファイルは絶対パスで書く。

```bash
cat > plan.json <<'EOF'
{"commands":[["companies","list"]]}
EOF
npm run runtime-oauth-exec -- --plan ./plan.json
# listener起動後に http://127.0.0.1:54321/start をブラウザで開く
```

認可後に `companies list` が事業所一覧を返れば疎通できている。請求書APIを使うplan（例: `invoices templates --company-id <company-id>`）で `/iv` が 401 または 403 になる場合、アプリに請求書 API の scope が付与されていない可能性がある。401 は token の有効性、403 は scope・権限・対象サービスの利用条件・アクセス制限を切り分ける。コードや token 保存で回避しない。

## export（検証用データ取得・read-only）

検証用の過去データ（証憑・仕訳など）をローカルに取得する。**この節の export サブコマンド（receipts / journals / wallet-txns / expense-applications）はすべて GET のみ（データ write なし）**。以下の例のように `freee export …` を直接実行すると、ほかのコマンドと同じ認証（`FREEE_ACCESS_TOKEN`、なければ 1Password。必要なら refresh token を更新して保存する）を使う。token を保存せずに実行する場合は、引数を runtime plan の `commands` に入れて `runtime-oauth-exec` で実行する（例: `{"commands":[["export","journals","--company-id","1234567","--month","2026-02","--out","/absolute/path/to/out"]]}`）。

### 証憑（ファイルボックス）

```bash
freee export receipts \
  --company-id 1234567 \
  --month 2026-02 \
  --out ./tmp/freee-validation/2026-02/receipts
```

- `<out>/index.json` に証憑メタ一覧、`<out>/files/<id>.<ext>` に証憑ファイル本体を保存する。
- 期間は `--month YYYY-MM`、または `--start-date` / `--end-date` で指定（`--month` と併用時は個別指定が優先）。
- 一覧フィルタ（start_date/end_date）は freee 側ではアップロード日（created_at）基準。
- この CLI は `limit=100` でページングする。個々の DL 失敗は記録して継続する。

### 仕訳一覧（仕訳帳）

```bash
freee export journals \
  --company-id 1234567 \
  --month 2026-02 \
  --out ./tmp/freee-validation/2026-02
```

- 非同期エクスポート（要求 → status ポーリング → download）を内部で処理し、`<out>/journals-<start>_<end>.<ext>` に保存する。
- `--download-type` は `generic_v2`（既定・freee 汎用形式の新 CSV）/ `generic`（旧 CSV）/ `csv`（弥生会計形式）/ `pdf`。列の構成は取得したファイルのヘッダーを参照する。
- `--encoding`（既定 `utf-8`）は **`generic` / `generic_v2` でだけ API へ送る**。`csv` / `pdf` では指定しても無視する（API に `encoding` を送ると 400 になるため）。
- ダウンロードしたファイルは文字コードを変換せず、受け取ったバイト列のまま（BOM が付いていれば BOM も含めて）保存する。`--encoding sjis` を指定したときや `--download-type csv` のときは、freee が返した文字コード（Shift_JIS など）のファイルになる。

### カード・ウォレット明細

```bash
freee export wallet-txns \
  --company-id <company-id> \
  --month 2026-02 \
  --walletable-type wallet \
  --walletable-id <walletable-id> \
  --source-name card-a \
  --out ./tmp/freee-validation/2026-02/card/card-a
```

口座を省くと事業所の全口座の明細を書き出す（`--source-name` の既定は `all`）。`--entry-side` で収入または支出だけに絞れる。

```bash
freee export wallet-txns \
  --company-id <company-id> \
  --month 2026-02 \
  --entry-side income \
  --out ./tmp/freee-validation/2026-02/wallet-txns
```

- `<out>/wallet-txns.json` と `<out>/wallet-txns.csv` を保存する。
- 書き出す CSV には明細ごとの残高（`balance` 列）が含まれる。これは口座の残高を出さない `walletables list` とは別である。
- `--walletable-id` と `--walletable-type` は両方指定するか両方省く。口座の種類は `bank_account` / `credit_card` / `wallet`。
- `--entry-side` に `income` / `expense` を指定すると収支で絞り込む。
- すべて GET のみ。明細の登録・更新は行わない。

### 経費精算申請

```bash
freee export expense-applications \
  --company-id 1234567 \
  --month 2026-02 \
  --out ./tmp/freee-validation/2026-02/expense-reports
```

- `<out>/index.json` に経費精算申請、`<out>/receipts-index.json` に添付 receipt metadata、`<out>/files/<id>.<ext>` に添付ファイルを保存する。
- 添付 receipt は、対象期間内の `purchase_lines[].transaction_date` に紐づく `receipt_id` / `sub_receipt_ids` のみを保存する。
- すべて GET のみ。経費精算の承認・取引登録は行わない。

## 他の repo から読み取りだけ使う

`freee-cli/reader`（`src/reader.ts`）は、一覧取得（請求書・経費申請・取引先）と、GET だけを実行できる読み取り専用 client（`createReadOnlyClient`）を出す。
`PublicFreeeClient` と書き込みコマンドの関数は出さない（post / put / patch / delete / 任意メソッドの request を持たず、包んだ実体も取り出せない）。
`npm pack` で作った tarball を `file:` 依存にして使う（`prepack` が `npm run build` を実行する）。

```ts
import { createReadOnlyClient, runInvoicesList } from "freee-cli/reader";
const client = createReadOnlyClient({ api: "invoice", token });
await runInvoicesList({ companyId }, { client });
```

## 開発

```bash
npm ci
npm run typecheck
npm test
```

## ライセンス

[MIT](./LICENSE)
