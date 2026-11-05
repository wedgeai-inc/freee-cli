# 公表情報照会の実装・検証記録

対象: https://github.com/wedgeai-inc/freee-cli/issues/56

## 取得仕様

- 法人番号: [Web-API Ver.4仕様](https://www.houjin-bangou.nta.go.jp/pc/webapi/images/k-web-api-kinou-ver4.pdf)のUTF-8 CSV（type=02）。履歴を除外し、名称では部分一致検索。
- インボイス: [Web-API仕様](https://www.invoice-kohyo.nta.go.jp/files/k-web-api-kinou.pdf)のJSON（type=21、history=0）。名称検索は法人番号APIから番号を解決して照会する。個人事業者の名称逆引きには対応しない。
- [法人番号API利用規約](https://www.houjin-bangou.nta.go.jp/pc/webapi/riyokiyaku.html)、[インボイスAPI利用規約](https://www.invoice-kohyo.nta.go.jp/web-api/riyou_kiyaku.html)に従い、公式APIのみを利用する。HTMLの巡回・スクレイピングは行わない。
- 取得元・国税庁による保証がない旨はREADMEに明示する。

## テストリスト

- [x] 法人番号・候補名から正式名称、法人番号、所在地を取得
- [x] 0件、複数候補、分割応答で単一候補を断定しない
- [x] T番号から名称・所在地と登録状態を取得
- [x] 未登録、取消・失効、登録前、名称不一致を区別
- [x] 名称からの法人候補解決、曖昧な候補で照会を停止
- [x] 不正入力、設定不足、HTTP・通信失敗、不正応答を区別
- [x] CLIのJSON出力、認証不要、help表示

## 検証結果

- 既存CLI試験6件を変更前のベースラインとして確認。新規コマンド関数の未実装、曖昧候補の誤判定、入力・通信失敗、登録状態、CLI未配線の失敗を確認後、実装して成功を確認。
- `npm test`: 70ファイル、3985件成功。追加のモック試験は2ファイル、17件。
- `npm run typecheck`: 成功。
- ソース直接実行で`partners --help`・`partners verify-invoice --help`に新コマンド・オプションが表示されることを確認。
- 読み取り専用の独立Checkerが公式サンプルとの列・キー照合と対象17件を再確認。High／Medium指摘なし。PR段階の独立セッションレビューは今回の範囲外。
- 実API照会は未実施。特に0件JSONの`announcement: []`は合成fixtureで確認しており、実APIでの応答形式は未検証。利用可能なアプリケーションIDを実行時に注入した環境で確認する必要がある。
- 名称からのインボイス照会は法人に限定。個人事業者はT番号を使う。分割応答の後続ページは取得せず、不完全である旨と曖昧なstatusを返す。
- commit・push・PR操作は行わず、変更ファイルのみ引き渡す。
