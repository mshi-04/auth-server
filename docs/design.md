# 認証基盤バックエンド 設計書（学習用 v0.28）

## 目的

パスワード保存の仕組み（Argon2id、ソルト、PHC 形式、定数時間比較、再ハッシュ）を、実際に動く最小の登録・ログイン API を通して理解する。

## スコープ

### 実装するもの

1. `models/` のパスワード値オブジェクトと `providers/password/` のパスワード処理（ハッシュ化・検証・再ハッシュ判定・パスワードポリシー・同時実行制限）
2. 登録・ログイン API（`POST /v1/users`、`POST /v1/sessions`、`GET /healthz`）
3. SQLite のテーブル 2 つ（`users`、`password_credentials`）
4. GitHub Actions による CI（型検査、静的検査、整形確認、全テスト、カバレッジレポート、CodeQL による JavaScript/TypeScript のセキュリティ解析）
5. Dependabot による npm パッケージと GitHub Actions の依存更新
6. 同じ Node.js サーバーから配信する、登録・ログインを試す日本語の Web 画面
7. Go 実装から TypeScript 実装への移行（[移行手順](migration.md)）

### 実装しないもの

JWT・リフレッシュトークン、ペッパー、メール確認、パスワードリセット、JWKS、レート制限、監査ログ、ORM、マイグレーションツール、testcontainers、MFA、Docker。

## 文書の正本と読む順序

実装前に本書、[アーキテクチャ](architecture.md)、[TypeScript のコーディング方針](typescript-coding-guidelines.md)、[移行手順](migration.md)を読む。続けて担当する機能の仕様と、変更の影響が及ぶ関連契約を確認する。

| 文書 | 正本とする内容・読む場面 |
|---|---|
| [パスワード仕様](specs/password.md) | PHC、パラメータ、ポリシー、ハッシュ・検証・再ハッシュ、同時実行制限 |
| [DB 仕様](specs/database.md) | スキーマ、接続・権限・トランザクション、保存時のエラー |
| [API・認証・サーバー仕様](specs/api.md) | 入出力、認証手順、ログ、設定、起動・終了、タイムアウト、Web 画面 |
| [アーキテクチャ](architecture.md) | モジュール構成、責務、依存、内部契約、テストの組み立て方 |
| [移行手順](migration.md) | 残りの作業順序、段階別ブランチ、移行中の確認事項 |
| [開発ガイド](development.md) | WSL、コマンド、CI、依存更新、Git の運用 |
| [テックスタック](tech-stack.md) | 採用技術と使わない技術 |
| [TypeScript のコーディング方針](typescript-coding-guidelines.md) | 型・実装・エラー処理・テストの書き方 |
| [性能測定と調査記録](password-benchmarks.md) | 測定条件・結果・実行経路の根拠。性能・既定値・並行性に触れる作業で読む |

- パスワードの変更では、API 仕様の認証・エラー変換・要求中断も確認する。
- DB の変更では、API 仕様の設定・エラー応答・タイムアウトも確認する。
- 認証・HTTP の変更では、パスワードの公開契約と DB の保存契約も確認する。
- 各仕様書は振る舞いと必須の検証項目、architecture.md は配置・依存・テスト方法、development.md は実行方法を定める。
- 仕様を変えるときはコードより先に担当仕様書を更新し、本書の版数も更新する。スコープ変更は本書へ反映する。版数は本書で一元管理する。

## 既知の制限

以下は README にも明記する。

- 登録 API は重複時に 409 を返すため、**メールアドレスが登録済みかどうかを第三者が確認できる**（ユーザー列挙）
- ペッパー、レート制限、トークン発行がないため、本番利用には適さない
- パラメータを引き上げた後、まだ再ハッシュされていない既存ユーザーは旧パラメータで検証されるため、存在しないユーザー（ダミーハッシュ）より速く応答する。該当ユーザーが次に正しくログインして再ハッシュされるまで、応答時間から登録済みかどうかを推測できる
- `node:sqlite` の API は同期のため、SQLite が他のプロセスのロックを待っている間（busy timeout の最大 5 秒）は、イベントループが止まり、すべての要求の処理が止まる。この間は要求の `signal` の中断も効かない
- `open` の接続初期化でも、PRAGMA がロックを待っている間はイベントループが止まり、`signal` の中断も効かない。再試行の開始期限は 5 秒だが、期限直前に始めた 1 回の接続処理がロックを待つと、`open` 全体はその待機時間だけ長くなる
- 他のプロセスの書き込みが続いて、ロック待ちが 5 秒を超えた登録は 503 になる。ログイン成功後のハッシュ更新が同じ理由で失敗した場合は、警告を記録してログインは成功させ、次回のログインで再試行する
- NFKC の安定性が保証されるのは割り当て済みの文字だけである。Node が同梱する ICU の Unicode 表で未割り当ての文字を含むパスワードは、Node の更新でその文字に分解が定義されると正規化の結果が変わり、正しいパスワードでもログインできなくなる
- 認証なしの要求で Argon2id の同時計算枠（4 つ）を埋められる。登録・ログインの要求が続くと、ほかの利用者の要求が待機切れで 503 になり、ログインの試行回数にも上限がない（レート制限はスコープ外）
- `DATABASE_PATH` の起動時検査が拒否するのは `/mnt/c` とその配下だけである。ほかのドライブ（`/mnt/d` など）、`/etc/wsl.conf` で automount の root を変えた場合、Windows 側のパスのバインドマウントは検出しない
- 正常終了の期限（30 秒）を超えて残った処理（Argon2id の計算の完了待ちなど）は、接続を閉じた後も動き続けることがあり、DB を閉じた後のアクセスが失敗してログを出す。書き込みは SQLite のトランザクションで守られる
- 不正な要求の行・ヘッダーと、`headersTimeout`・`requestTimeout` の超過には Node が 400・408 を返すため、Problem Details の形にならない
- サーバーは IPv4 の全インターフェースで待ち受けるため、WSL の仮想ネットワーク（mirrored モードでは LAN）からも登録・ログイン API と Web 画面に届く
- API は Content-Type を必須にせず、Origin・Host も検査しない。サーバーの起動中に利用者が開いた別のサイトから、`text/plain` の POST で登録やログインの要求を送れる（応答は読めないが副作用は起きる）。DNS リバインドを使えば応答も読める

## 完了条件

- `npm run typecheck`（`tsc --noEmit`）、`npm run lint`（`eslint .`）、`npm run format:check`（`prettier --check .`）、`npm test`（`vitest run`）が通る
- GitHub Actions の CI（`.github/workflows/ci.yml`）で型検査・静的検査・整形確認・全テスト・カバレッジレポートが通る。同じリポジトリの PR ではカバレッジ用のコメントを 1 件作り、Coverage ジョブの再実行時に更新する。実行条件と出力は [開発ガイドの CI](development.md#ci)を正本とする
- CodeQL（`.github/workflows/codeql.yml`）で JavaScript/TypeScript の解析と結果のアップロードが成功する。実行条件と出力は [開発ガイドの CI](development.md#ci)を正本とする
- Dependabot（`.github/dependabot.yml`）の npm の設定が `main` に入った後、[開発ガイドの依存関係の更新](development.md#依存関係の更新)にある設定の確認を行い、npm の最初の更新 PR が作られることを確認する。設定と運用は [開発ガイドの依存関係の更新](development.md#依存関係の更新)を正本とする
- `npm run bench`（`vitest bench --run src/providers/password`）でハッシュ 1 回の所要時間が出て、TS 実装の測定結果を [性能測定と調査記録](password-benchmarks.md)に記録している
- README に起動手順、curl による登録・ログイン例、Windows のブラウザーからの利用方法と WSL への接続の切り分けがある
- Windows から WSL 上のサーバーへ疎通でき、Web 画面で登録・ログイン・重複登録・誤パスワードの応答を確認できる
- Go 実装のコード（`cmd/`、`internal/`、`go.mod`、`go.sum`）と Go 用の CI・CodeQL・Dependabot の設定が削除されている
