# AGENTS.md — wedgeai-inc/freee-cli

AI コーディングエージェント向けの作業規約です。CC は `CLAUDE.md`（本ファイルを import）、Codex などは本ファイルを直接読みます。人間の貢献者向けの内容は `CONTRIBUTING.md` にあります。

## 前提

- **本 repo は public です。** コード・Issue・PR・commit message はすべて公開されます。実在の事業所 ID・取引先・個人の氏名やメールアドレス・token・社内のパスや repo 名を書かないでください（`LICENSE` の著作権者表示は除く）。
- **freee の公開 API（Public API）だけを使います。** Web 画面の内部 API（`/api/p/...`）や cookie 認証は使いません。

## 実装

- テストを先に書く（Red → Green → Refactor）
- API へ書き込むコマンドは dry-run を既定とし、`--execute` のときだけ書き込む
- 取消・復元・更新の `--execute` では、対象の番号や名前の完全一致を要求する
- 検証は `npm run typecheck` と `npm test`

## credential

- token はファイルに平文で保存しない。1Password への保管か、実行時のメモリ上だけで扱う
- credential の値をログ・argv・Issue・PR・commit に出さない
- `op` への書き込みは終了コードで成否を判断せず、読み戻して値を照合する

## 本番の freee へ影響する操作

次は dry-run では対象外で、`--execute` を付けると実際の事業所のデータが変わります。エージェントが実行する前に、必ず人の個別承認を得てください。

- `invoices create|update|cancel|uncancel --execute`
- `quotations create|cancel|uncancel --execute`
- `partners create|update --execute`
- `freee auth login`（ブラウザでの認可）
