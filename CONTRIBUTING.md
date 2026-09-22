# コントリビューションガイド

Issue と Pull Request を歓迎します。

## 開発環境

```bash
npm ci
npm run typecheck
npm test
```

Node.js 22 以上が必要です。

## 方針

- **freee の公開 API（Public API）だけを使います。** Web 画面の内部 API や cookie 認証を使う変更は受け付けません。
- **書き込みは dry-run を既定にします。** API へ書き込むコマンドは、`--execute` を付けたときだけ書き込むようにしてください。
- **テストを先に書きます。** 変更にはテストを添えてください。
- **実データを含めないでください。** テスト・fixture・Issue・PR に、実在の事業所 ID・取引先・氏名・メールアドレス・token を書かないでください。

## 請求書 API の schema から fixture を再生成する

`tests/fixtures/iv-invoice-show-keys.json` は freee 公式の OpenAPI schema から生成しています。

```bash
curl -fsSL https://raw.githubusercontent.com/freee/freee-api-schema/master/iv/open-api-3/api-schema.yml -o .iv-schema.yml
node scripts/gen-iv-invoice-show-keys.mjs
```
