# TypeScript への移行手順

Go 実装を動かしたまま、TS 実装を段階的に移行し、仕様をすべて満たしてから Go 実装を削除する。現在の配置は [アーキテクチャの現状と移行先](architecture.md#現状と移行先)、import 規則は [import の検査](architecture.md#import-の検査)を参照する。

完了した手順も見出しとアンカーを残し、本文を「完了」の 1 行にする。ほかの文書のリンクと「手順 3」などの参照は、手順の完了後も同じ見出しを指す。

<a id="step-1"></a>

## 手順 1：土台

完了

<a id="step-2"></a>

## 手順 2：password

完了

<a id="step-2a"></a>

## 手順 2a：基盤

完了

<a id="step-2b"></a>

## 手順 2b：Provider

完了

<a id="step-3"></a>

## 手順 3：Repository

完了

<a id="step-4a"></a>

## 手順 4a：サービス

`services/AuthService` に `UserRepository`・`PasswordProvider`・`IdProvider`・`LoggerProvider` を注入し、登録・ログイン・ダミー検証・再ハッシュ・エラー統一を実装する。この段階で `models/email.ts`（[メールアドレスの検証](specs/api.md#メールアドレスの検証)に従う解析）、`models/auth.ts`（`AuthInput`・`AuthResult`）と、未移植の認証エラー（`InvalidEmailError`・`WeakPasswordError`・`InvalidCredentialsError`）を `errors/auth-errors.ts` に追加する。サービスは HTTP・DB・暗号 API を直接参照しない。偽実装による単体テストと本物の Provider を使う結合テストを通す

<a id="step-4b"></a>

## 手順 4b：HTTP と起動

`schemas`・`middlewares`・`controllers`・`routes` と、要求のエラー（`errors/request-errors.ts`）を実装し、`src/index.ts` で依存の注入とサーバーの起動・終了を組み立てる。最初に `internal/httpapi/web/` の 3 ファイルを内容を変えずに `public/` へコピーし、配信のテストも書く。Go の `internal/httpapi/static.go` が `go:embed` で元のファイルを参照するため、移動はしない。既存の `start` を `node src/index.ts` へ変更し、Prettier・ESLint の静的ファイルの除外を `public/` に変え、旧 `src/httpapi/web/` の除外指定もこの段階で整理する

<a id="step-5"></a>

## 手順 5：Windows からの接続確認

Windows のブラウザーから TS 実装のサーバーへ実際に接続し、Web 画面で登録・ログイン・重複登録・誤パスワードの応答を確認する

<a id="step-6"></a>

## 手順 6：README

README を TS 実装の手順に書き換える

<a id="step-7"></a>

## 手順 7：Go 実装の削除

Go 実装を削除する。対象は `cmd/`、`internal/`（`internal/httpapi/web/` を含む）、`go.mod`、`go.sum`、`.github/actions/setup-go/`、`ci.yml` の Go 用のジョブ、`codeql.yml` の `go` の解析、`dependabot.yml` の `gomod` と `/.github/actions/setup-go` の確認先、development.md の「Go 実装（移行完了まで）」の節、tech-stack.md の「Go 実装（移行完了まで）」の節、仕様書と architecture.md の Go 実装との差分の注記

<a id="step-8"></a>

## 手順 8：完了条件の確認

[設計書の完了条件](design.md#完了条件)のうち、移行のブランチで確かめられるものをすべて確認する。Dependabot の npm の最初の更新 PR だけは、設定が `main` に入った後の週次実行で確認する

## ブランチと確認

コードや README を変更する手順は、下表の段階ごとに feature ブランチを作る。複数の段階を 1 つのブランチにまとめない。

コードを変更する手順は、レビューの量を抑えるため、実装とテストでブランチを分ける。

- 実装のブランチは `develop` から作り、`develop` へ PR を出す
- テストのブランチは実装のブランチから作り、実装のブランチへ PR を出す（スタック）
- 実装の PR を `develop` へマージした後、テストの PR の base を `develop` へ切り替えてマージする
- 表のテストのブランチが「—」の手順は、1 つのブランチで `develop` へ PR を出す

前の段階の PR がすべて `develop` にマージされてから、次の段階のブランチを作る。

| 手順 | 実装のブランチ | テストのブランチ |
|---|---|---|
| 4a | `feature/ts-services` | `feature/ts-services-tests` |
| 4b | `feature/ts-http-api` | `feature/ts-http-api-tests` |
| 6 | `feature/ts-readme` | — |
| 7 | `feature/remove-go` | — |

確認だけの手順 5 と 8 にはブランチを作らない。確認で直す点が見つかったら、その修正のための feature ブランチを `develop` から作る。

各段階で TS 用の CI と CodeQL も通ってから次へ進む。Go 用の CI は手順 7 まで残し、Go 実装を壊さない。手順 4b から 7 までの間は、Web 画面の 3 ファイルが 2 か所にある。2 か所の内容は一致させ（`diff -r internal/httpapi/web public` が差分なしで終わる）、この間に画面を変える場合は両方に同じ変更を入れる。`public/` は Prettier・ESLint・カバレッジの対象から外す（[開発ガイド](development.md#レイヤー分離時の設定と検証)）。

各段階でテストが通ってから次へ進む。不明点や仕様書と矛盾する点があれば、推測で進めず質問する。
