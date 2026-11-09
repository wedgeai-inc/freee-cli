# OAuth token store保存失敗の診断

確認日: 2026-11-09 JST

## 結論と根拠

保存失敗の主メッセージを維持し、固定enumの追加プロパティで段階を識別する。
既存実装は保存時と呼び出し側のcatchで診断を失っていた。
原文: `freee OAuth token store could not be updated`

参照: [変更前の保存処理](https://github.com/wedgeai-inc/freee-cli/blob/83ff214a8ca99f276dc9bfac87b931bf0c8dd9bb/src/lib/one-password-token-store.ts#L86-L113)、
[変更前の呼び出し側](https://github.com/wedgeai-inc/freee-cli/blob/83ff214a8ca99f276dc9bfac87b931bf0c8dd9bb/src/lib/token-config-loader.ts#L144-L148)。

## テストリスト

- [x] preread / edit / readback / mismatchの識別
- [x] nonzero / timeout / stdin / spawnの分類保持
- [x] refreshとloginの呼び出し側で診断を保持し、未知の例外は無害化
- [x] 60秒ちょうどでrefresh、60秒+1msではrefresh/saveなし
- [x] 非空のFREEE_ACCESS_TOKENはstoreを呼ばない
- [x] companiesの保存失敗時はAPI非呼出、stdout空
- [x] loginの保存失敗時は成功通知なし
- [x] token、item、vault、op出力、raw causeを診断やログに含めない

## 検証と未確認事項

実認証・本番op・ネットワーク呼び出しは実施しない。本番障害の失敗段階は未確認。

- ベースライン: 対象4ファイル56件成功。
- 追加した診断の試験は、段階情報・分類・呼び出し側での保持がないことによるRedを確認後、実装してGreenを確認。
- 対象unit: 4ファイル82件成功（追加26ケース）。
- `npm test`: 73ファイル、4,193件成功、失敗0件。
- `npm run typecheck`: exit 0。
- `git diff --check`: exit 0。
- ローカルChecker: Medium以上の指摘なし。独自の安全なモック検証28件成功、CIの`npm test`への配線を確認。
- 実行したVitestは5.0.1。worktreeに依存パッケージがなかったため、既存checkoutの依存パッケージをworktree内のGit対象外`node_modules`へコピーして使用した。設定・lockfileは変更していない。
- コミット・push・PR作成は行っていない。PRの独立セッションレビューは今回の作業範囲外。

## 実装

`src/lib/one-password-token-store.ts`の`TokenStoreUpdateError`にstage、operation、categoryを追加。
`save`のprereadにはitem読取・JSON解析・編集用template検証を含め、readbackには再読取・bundle検証を含める。
照合不一致はmismatchとし、opが成功した後の解析失敗にはcategoryを付けない。
初回loadの主メッセージは従来どおり。

`runOp`は同期/非同期spawn失敗、stdin失敗、timeout、非正常終了（nullを含む）を固定分類にする。
timeoutは分類を確定してから終了処理内でkillし、同期closeで分類が上書きされるのを防ぐ。
refreshとloginのcatchでは許可された追加プロパティだけを新しいエラーへ再構築し、元の例外を保持しない。
CLIの表示文言とloginのログ文言は変更しない。

## 追加したテスト名

`tests/unit/one-password-token-store.test.ts`（21ケース）:

- `drops forged diagnostics and non-enum values at the caller boundary`
- `identifies invalid %s item data without an op failure category`（preread/readback）
- `preserves the %s runOp category across every save operation without secrets`（nonzero/null-exit/timeout/stdin/stdin-throw/spawn/spawn-throw。各ケースでpreread/edit/readbackを検証）
- `identifies %s failure with only closed diagnostics`（edit/readback/mismatch）
- `identifies preread failure without retaining sensitive exception details`
- `refreshes only when expiry is at or below the %i ms skew boundary`（60,000/60,001）
- `does not create, load, or save a OnePassword store when FREEE_ACCESS_TOKEN is nonempty`
- `preserves %s diagnostics after refresh and strips unrelated error properties`（保存4段階）

`tests/unit/oauth-login.test.ts`（4ケース）:

- `preserves %s diagnostics without success notification or secret output`（保存4段階）

`tests/unit/companies-list.test.ts`（1ケース）:

- `does not call the companies API or write stdout when saving refreshed tokens fails`

