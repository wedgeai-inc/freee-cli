# OAuth token store保存失敗の診断

確認日: 2026-11-09 JST

## 結論と根拠

保存失敗の主メッセージを維持し、固定enumの追加プロパティで段階を識別する。
CLIのtop-level catchでも既存のsanitizeを適用し、利用者向け文言の次の行に存在する許可enumだけを表示する。
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
- [x] stage / operation / categoryのgetter、Proxyのprototype / descriptor検査失敗をrefresh・loginの境界で無害化
- [x] 直接saveのpreread / edit / readbackでも診断抽出の例外を無害化
- [x] getterを実行せず、継承プロパティを除外し、own data propertyの許可enum値だけを保持
- [x] CLIの保存失敗でstderrは利用者文言と許可enum行だけ、stdoutは空
- [x] CLI表示前のsanitizeで不正値・getter・継承値・Proxyの診断を除外し、欠落フィールドを補わない
- [x] 通常エラーは従来の`Error: ${message}`だけを表示

## 検証と未確認事項

実認証・本番op・ネットワーク呼び出しは実施しない。本番障害の失敗段階は未確認。

- ベースライン: 対象4ファイル56件成功。
- 追加した診断の試験は、段階情報・分類・呼び出し側での保持がないことによるRedを確認後、実装してGreenを確認。
- 対象unit: 4ファイル82件成功（追加26ケース）。
- High指摘修正のベースライン: token store / loginの2ファイル67件成功。
- High指摘の回帰テスト: 境界6件と直接saveの3段階でRedを確認し、修正後にGreenを確認。追加9ケースと既存の境界入力表を拡張。
- `npm test`: 73ファイル、4,202件成功、失敗0件。
- `npm run typecheck`: exit 0。
- `git diff --check`: exit 0。
- High指摘修正のローカルChecker: 指摘なし。関連17テスト、正常診断75組、revoked Proxy・不正descriptor・primitiveなど9入力を独自に検証。CIの`npm test`への配線も確認。PRの独立セッションレビューの代替にはしない。
- 実行したVitestは5.0.1。worktreeに依存パッケージがなかったため、既存checkoutの依存パッケージをworktree内のGit対象外`node_modules`へコピーして使用した。設定・lockfileは変更していない。
- CLI表示対応は既存コミット上の未コミット差分として作業し、この対応ではコミット・push・PR作成を行わない。PRの独立セッションレビューは今回の作業範囲外。

## 実装

`src/lib/one-password-token-store.ts`の`TokenStoreUpdateError`にstage、operation、categoryを追加。
`save`のprereadにはitem読取・JSON解析・編集用template検証を含め、readbackには再読取・bundle検証を含める。
照合不一致はmismatchとし、opが成功した後の解析失敗にはcategoryを付けない。
初回loadの主メッセージは従来どおり。

`runOp`は同期/非同期spawn失敗、stdin失敗、timeout、非正常終了（nullを含む）を固定分類にする。
timeoutは分類を確定してから終了処理内でkillし、同期closeで分類が上書きされるのを防ぐ。
refreshとloginのcatchでは許可された追加プロパティだけを新しいエラーへ再構築し、元の例外を保持しない。
`sanitizeTokenStoreUpdateError`と`opFailureCategory`は型判定・descriptor検査をcatchで囲む。
own data propertyのenum値だけを読み、getter・継承プロパティを診断に使わない。
診断抽出自体が失敗した場合も元の例外を保持せず、固定文言へ閉じる。
CLIの1行目とloginのログ文言は変更しない。
CLI末尾のcatchは`reportCliError`を呼び、`TokenStoreUpdateError`だけを再sanitizeする。
追加行は`Token store diagnostics: stage=edit operation=edit category=nonzero`の形式で、存在するフィールドだけを固定順に出す。診断がなければ追加行も出さない。

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

High指摘修正で追加した`tests/unit/one-password-token-store.test.ts`のテスト（9ケース）:

- `closes $name to a secret-free fixed error after refresh and login`（getter3種、Proxy2種）
- `closes hostile op diagnostics during %s without exposing secrets`（preread/edit/readback）
- `retains only own enum data properties without invoking getters or proxy get traps`

既存の`drops forged diagnostics and non-enum values at the caller boundary`の入力表にもgetter3種とProxy2種を追加。

CLI表示対応の`tests/unit/cli-error.test.ts`（44ケース）:

- `prints only the user message and enum diagnostics to stderr when refreshed tokens cannot be saved`（1ケース。refresh・保存失敗からCLIのcatchまで）
- `prints allowed diagnostics $stage/$operation/$category without raw error details`（32ケース。全許可値の組み合わせ）
- `does not invent missing diagnostic fields (%#)`（4ケース）
- `omits untrusted diagnostics from %s`（5ケース。不正値・getter・継承値・Proxyのget/descriptor trap）
- `keeps the existing output for other errors (%#)`（2ケース）

CLI表示対応の検証:

- ベースライン: companies / token storeの2ファイル72件成功。
- Red: 既存catchの表示処理を抽出した状態で、期待する診断行がstderrにないことを確認。
- Green: CLI表示の44ケース成功、`npm run typecheck`成功。
- `npm test`: 74ファイル4,246件成功、失敗0件。
- ローカル独立Checkerは欠落値を含む診断75組とCLI/CI配線を確認。consoleの追加引数も秘密検査に含める指摘を反映し、出力捕捉を`format(...args)`へ変更。
- 実認証・本番opは未使用。本番障害の失敗段階は引き続き未確認。

