# 開発ガイド

開発環境、コマンド、Git の運用をまとめる。

## 開発環境

- Go は WSL（ディストリビューション名 `Ubuntu-24.04`）にだけ入っている。Windows 側には無い
- ソースは Windows 側のフォルダ（例：`C:\Users\<ユーザー名>\repos\auth-server`）に置く。WSL からは `/mnt/c/Users/<ユーザー名>/repos/auth-server` で見える
- Go のモジュールキャッシュは WSL 側（`~/go`）に置かれる

### Windows から Go のコマンドを実行する

Windows 側のリポジトリのルートで実行する。wsl.exe は呼び出し元のフォルダを WSL のパスに変換して作業ディレクトリにするため、`cd` は要らない。

```
wsl -d Ubuntu-24.04 --exec bash -lc 'go test ./...'
```

- `--exec` を必ず付ける。付けないと wsl.exe が外側のシェルでコマンドを解釈し、`$VAR` が bash に渡る前に空へ展開される
- 込み入った処理はスクリプトファイルにして `wsl -d Ubuntu-24.04 --exec bash <スクリプトのパス>` で実行する

### SQLite の DB ファイル

- DB ファイルは `/mnt/c` 配下に置かない。WSL 側（例：`~/.local/share/auth-server/auth.db`）に置く
- 親ディレクトリは自動で作られないため、初回は `mkdir -p -m 700 ~/.local/share/auth-server` で所有者専用に作っておく
- 既存の親ディレクトリは `chmod 700 ~/.local/share/auth-server` で権限を制限する。DB と既存の `-wal`・`-shm`・`-journal` ファイルにも所有者以外の権限があれば、該当ファイルを `chmod 600` にしてから起動する。親とファイルの所有者は実行ユーザーと一致させる。シンボリックリンクは使わない
- `/mnt/c` ではファイルロックや WAL の共有メモリが正しく動かないことがある
- 置き場所は環境変数 `DATABASE_PATH` で指定する（未設定なら起動エラー）

## コマンド

WSL 上のリポジトリのルートで実行する。

| 目的 | コマンド |
|---|---|
| 整形確認 | `gofmt -l .`（出力が空なら整形済み。`gofmt -w .` で整形する） |
| go.mod の整理確認 | `go mod tidy -diff` |
| 静的検査 | `go vet ./...` |
| テスト | `go test ./...` |
| ベンチマーク（ハッシュ 1 回の所要時間） | `go test -bench=. ./internal/password` |
| 起動 | `DATABASE_PATH=~/.local/share/auth-server/auth.db go run ./cmd/authd` |

## CI

CI の実行条件と出力はこの節を正本とする。GitHub Actions の `.github/workflows/ci.yml` で、`develop`・`main` 向けの PR と両ブランチへの push 時に、次の 4 ジョブを独立して並行実行する。ジョブ間の依存は設けず、それぞれの結果を PR のチェックとして表示する。CodeQL の解析は別の `.github/workflows/codeql.yml` で独立して実行する。

| ジョブ | 内容 |
|---|---|
| Lint | `gofmt -l .` による整形確認（ファイルは書き換えない）、`go mod tidy -diff`、`go vet ./...` |
| Test | `go test -count=1 ./...` |
| Coverage | `go test -count=1 -covermode=atomic -coverpkg=./... -coverprofile=coverage/coverage.out ./...` とカバレッジレポートの生成・保存 |
| Race | `CGO_ENABLED=1 go test -count=1 -race ./...` |

Test と Coverage はそれぞれ別にテストを実行し、キャッシュ済みの結果を使わない。Coverage は全パッケージを計測対象にし、テストのないパッケージのコードも集計に含める。

- 合計カバレッジは GitHub Actions の実行サマリーに表示する
- 同じリポジトリのブランチから作った PR には、合計・関数別カバレッジ、計測したコミット、実行ログと artifact へのリンクをコメントする。初回だけ作成し、Coverage ジョブの再実行時は同じコメントを更新する。テストやレポート生成に失敗したときも、以前の数値を残さず失敗表示へ更新する。取り消された実行、現在の PR と異なるコミットの実行、すでにコメントした実行より古い実行は更新しない
- コメント投稿用の `pull-requests: write` 権限は Coverage ジョブだけに付与する。push、外部フォークの PR、トークンが読み取り専用になる Dependabot の実行ではコメントせず、従来どおり実行サマリーと artifact を出力する
- Coverage ジョブのテスト成功時に `coverage-report` artifact を 14 日間保存する。`coverage.html` はブラウザでソース行ごとの実行状況を確認でき、`coverage.txt` は関数別一覧、`coverage.out` は Go 標準の計測データ。再実行時は同名の artifact を上書きする
- ローカルで同じコマンドを実行するときも、先に `mkdir -p coverage` を行う。`go tool cover -func=coverage/coverage.out` で関数別一覧を、`go tool cover -html=coverage/coverage.out -o coverage/coverage.html` で HTML を生成できる。生成先の `coverage/` は Git の管理対象から外す
- 実行環境は Ubuntu 24.04、`CGO_ENABLED=0`。Go のバージョンは `go.mod` から読み込む
- レース検出は cgo が必要なため、Race ジョブだけ `CGO_ENABLED=1` にする。対象は全パッケージ。WSL には gcc が無いため、ローカルでは実行しない
- Go のインストールとキャッシュの復元は `.github/actions/setup-go` にまとめ、各ジョブから呼ぶ。キャッシュ（モジュールとビルド結果）はジョブごとに分け、`go.mod` と `go.sum` が変わるまで再利用する
- 各ジョブの制限時間は 15 分。同じ PR で新しい実行が始まったら、古い実行を取り消す。`develop`・`main` への push では実行中の CI を取り消さないが、同じブランチの待機中の実行は新しい push によって置き換わることがある
- 性能測定は WSL で行い、ベンチマークは CI では実行しない

### CodeQL

- `develop`・`main` 向けの PR と両ブランチへの push 時に Go を解析する。手動実行にも対応する。毎週月曜 03:17 UTC（日本時間 12:17）には既定ブランチの `main` を解析する。定期・手動実行はワークフローが `main` に入ってから利用できる。public リポジトリでは 60 日間活動がないと定期実行が自動で無効になるため、止まっていたら Actions 画面で有効にし直す
- Markdown ファイルだけを変える PR では実行しない（`paths-ignore`）。CodeQL を必須チェックにする場合は、この除外で PR がチェック待ちのまま止まらないか見直す
- Ubuntu 24.04、`CGO_ENABLED=0` で、共通の Go セットアップを使う。CodeQL 初期化後に `build-mode: manual` で `go build ./...` を実行する。クエリは `security-extended` を使い、Go の本番コードを対象にする（テストコードは既定で解析対象外）
- 解析結果は GitHub code scanning にアップロードし、PR のチェックとリポジトリのセキュリティ画面で確認する。結果のアップロード用に `security-events: write` を CodeQL ジョブだけに付与し、リポジトリの内容は `contents: read` で読み取る。fork からの PR はトークンが読み取り専用になるため、解析だけ行い結果はアップロードしない
- 制限時間は 20 分。同じ PR の古い実行は取り消し、push・定期・手動の実行中ジョブは取り消さない。Lint・Test・Coverage・Race との依存は設けない

## 依存関係の更新

- `.github/dependabot.yml` で Go モジュール（`gomod`）と GitHub Actions（`github-actions`）を毎週月曜 09:00（`Asia/Tokyo`）に確認する。すべての設定に `target-branch: develop` を指定し、`develop` 上の依存情報を調べ、更新 PR のマージ先も `develop` に固定する
- 更新はエコシステムごとに 1 件の PR にまとめる（`groups`）
- Go モジュールはルートの `go.mod`・`go.sum`、GitHub Actions は `.github/workflows/` と `.github/actions/setup-go/action.yml` を対象にする。共通アクション内の依存も更新できるよう、GitHub Actions の確認先に `/` と `/.github/actions/setup-go` を指定する
- Dependabot は既定ブランチの設定ファイルを読むため、定期更新はこの設定が `main` に入ってから有効になる。設定ファイルの配置先と、更新 PR のマージ先の `develop` は異なる
- GitHub の自動セキュリティ更新 PR は `target-branch` に従わず既定ブランチの `main` 向けになるため、リポジトリ設定で無効にする。Dependabot alerts（脆弱性の通知）は有効のまま残す。[GitHub の target-branch 仕様](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#target-branch)を参照
- 通知された脆弱性は、修正 PR を手で `develop` 向けに作るか、週次の更新 PR で直す。通知は `main` の依存関係から計算されるため、修正が `main` に入るまで通知は残り、`main` には脆弱な版が残る。急ぐ場合は、修正後すぐに `develop` を `main` へマージする
- 設定の確認：自動セキュリティ更新が無効で通知が有効であることを、`gh api repos/mshi-04/auth-server/automated-security-fixes`（`"enabled":false`）と `gh api -i repos/mshi-04/auth-server/vulnerability-alerts`（`204`）で確かめる。この設定と `dependabot.yml` が `main` に入った後、最初の週次更新で `develop` 向けの PR が作られることを確認する

## 環境変数

| 名前 | 必須 | 既定値 | 内容 |
|---|---|---|---|
| `DATABASE_PATH` | 必須 | なし | SQLite ファイルのパス |
| `PORT` | 任意 | `8080` | 待ち受けポート |

`DATABASE_PATH` が空、または絶対パス化・リンク解決の前後で `/mnt/c` 配下なら起動エラーになる。親ディレクトリは先に用意する。`PORT` は未設定・空なら 8080、それ以外は十進数字の 1〜65535 に限る。サーバーは全インターフェースで待ち受け、SIGINT・SIGTERM で最大 30 秒の正常終了を待つ。

## Git

### ブランチ

| ブランチ | 用途 |
|---|---|
| `main` | 安定版。デフォルトブランチ |
| `develop` | 統合先 |
| `feature/*` | 作業用。`develop` から作り、`develop` へ PR を出す |

### コミット

- メッセージは日本語。1 行目に要約を書き、必要なら空行の後に箇条書きで内容を書く
- このリポジトリの `user.email` は GitHub の noreply アドレス（`94366044+mshi-04@users.noreply.github.com`）に設定済み。リポジトリは public なので、個人のメールアドレスが入ったコミットを push しない
- 改行コードは LF。`.gitattributes` で固定している

### 並行するブランチの統合

- design.md の版数と変更履歴は、`develop` へマージする順に付ける
- 並行するブランチが同じ版数や同じファイル（`.gitignore` など）を変えている場合は、先にマージするブランチを決める。後のブランチは `develop` を取り込んで衝突を解消する。そのとき版数を繰り上げ、変更履歴を新しい順に並べ、`.gitignore` は両方の行を残す

### リモート

- `origin`：https://github.com/mshi-04/auth-server（public）
