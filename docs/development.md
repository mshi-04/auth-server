# 開発ガイド

開発環境、コマンド、Git の運用をまとめる。

TypeScript 実装の手順を正本とする。移行の完了（design.md 10 章の手順 7）までは、Go 実装の手順と CI も残る。それらは末尾の「Go 実装（移行完了まで）」にまとめる。

## 開発環境

- Node.js 26 は WSL（ディストリビューション名 `Ubuntu-24.04`）にだけ入れる。Windows 側には入れない
- Node のメジャーバージョンはリポジトリのルートの `.nvmrc` を正本とする。WSL では nvm で入れ、リポジトリのルートで `nvm install` と `nvm use` を実行する
- ソースは Windows 側のフォルダ（例：`C:\Users\<ユーザー名>\repos\auth-server`）に置く。WSL からは `/mnt/c/Users/<ユーザー名>/repos/auth-server` で見える
- `npm ci` で作る `node_modules/` も Windows 側のフォルダに置かれる。`/mnt/c` 経由のファイルアクセスは遅いため、インストールとテストに時間がかかる
- npm は WSL からだけ実行する。Windows 側の Node や npm で `node_modules/` を作り直さない
- エディターの補完は、エディターに同梱の TypeScript と、WSL で作った `node_modules/@types/node` で動く。Windows 側に Node は要らない

### Windows から Node のコマンドを実行する

Windows 側のリポジトリのルートで実行する。wsl.exe は呼び出し元のフォルダを WSL のパスに変換して作業ディレクトリにするため、`cd` は要らない。

```
wsl -d Ubuntu-24.04 --exec bash -lc 'npm test'
```

- `--exec` を必ず付ける。付けないと wsl.exe が外側のシェルでコマンドを解釈し、`$VAR` が bash に渡る前に空へ展開される
- `bash -lc` のログインシェルで nvm の設定を読み込む。読み込まれないと `node` と `npm` が見つからない
- 込み入った処理はスクリプトファイルにして `wsl -d Ubuntu-24.04 --exec bash <スクリプトのパス>` で実行する

### SQLite の DB ファイル

- DB ファイルは `/mnt/c` 配下に置かない。WSL 側（例：`~/.local/share/auth-server/auth.db`）に置く
- 親ディレクトリは自動で作られないため、初回は `mkdir -p -m 700 ~/.local/share/auth-server` で所有者専用に作っておく
- 既存の親ディレクトリは `chmod 700 ~/.local/share/auth-server` で権限を制限する。DB と既存の `-wal`・`-shm`・`-journal` ファイルにも所有者以外の権限があれば、該当ファイルを `chmod 600` にしてから起動する。親とファイルの所有者は実行ユーザーと一致させる。シンボリックリンクは使わない
- `/mnt/c` ではファイルロックや WAL の共有メモリが正しく動かないことがある
- 置き場所は環境変数 `DATABASE_PATH` で指定する（未設定なら起動エラー）

## コマンド

WSL 上のリポジトリのルートで実行する。`npm run` の名前は `package.json` の `scripts` に定義する。

| 目的 | コマンド | 中身 |
|---|---|---|
| 依存のインストール | `npm ci` | `package-lock.json` のとおりに入れる |
| 型検査 | `npm run typecheck` | `tsc --noEmit` |
| テスト | `npm test` | `vitest run` |
| カバレッジ | `npm run coverage` | `vitest run --coverage` |
| ベンチマーク（ハッシュ 1 回の所要時間） | `npm run bench` | `vitest bench --run src/password` |
| 起動 | `DATABASE_PATH=~/.local/share/auth-server/auth.db npm start` | `node src/main.ts` |

## CI

CI の実行条件と出力はこの節を正本とする。GitHub Actions の `.github/workflows/ci.yml` で、`develop`・`main` 向けの PR と両ブランチへの push 時に、次の 3 ジョブを独立して並行実行する。ジョブ間の依存は設けず、それぞれの結果を PR のチェックとして表示する。CodeQL の解析は別の `.github/workflows/codeql.yml` で独立して実行する。

| ジョブ | 内容 |
|---|---|
| Lint | `npm ci`（`package.json` と `package-lock.json` が食い違うと失敗する）、`npm run typecheck` |
| Test | `npm test` |
| Coverage | `npm run coverage` と、カバレッジレポートの生成・保存 |

Test と Coverage はそれぞれ別にテストを実行する。Coverage は `src/` 配下の全ファイル（テストとベンチマークを除く）を計測対象にし、テストから読み込まれないファイルも集計に含める。

- 合計カバレッジは GitHub Actions の実行サマリーに表示する
- 同じリポジトリのブランチから作った PR には、合計・ファイル別カバレッジ、計測したコミット、実行ログと artifact へのリンクをコメントする。初回だけ作成し、Coverage ジョブの再実行時は同じコメントを更新する。テストやレポート生成に失敗したときも、以前の数値を残さず失敗表示へ更新する。取り消された実行、現在の PR と異なるコミットの実行、すでにコメントした実行より古い実行は更新しない
- コメント投稿用の `pull-requests: write` 権限は Coverage ジョブだけに付与する。push、外部フォークの PR、トークンが読み取り専用になる Dependabot の実行ではコメントせず、従来どおり実行サマリーと artifact を出力する
- Coverage ジョブのテスト成功時に `coverage-report` artifact を 14 日間保存する。`index.html` はブラウザでソース行ごとの実行状況を確認でき、`coverage-summary.json` はファイル別の集計、`coverage-final.json` は V8 の計測データ。再実行時は同名の artifact を上書きする
- カバレッジの出力先と形式は `vitest.config.ts` に定義する。生成先の `coverage/` は Git の管理対象から外す
- 実行環境は Ubuntu 24.04。Node のバージョンは `.nvmrc` から読み込む
- Node のインストールと npm のキャッシュの復元は `.github/actions/setup-node` にまとめ、各ジョブから呼ぶ。キャッシュは `package-lock.json` が変わるまで再利用する
- 各ジョブの制限時間は 15 分。同じ PR で新しい実行が始まったら、古い実行を取り消す。`develop`・`main` への push では実行中の CI を取り消さないが、同じブランチの待機中の実行は新しい push によって置き換わることがある
- 性能測定は WSL で行い、ベンチマークは CI では実行しない
- Go 実装にあったレース検出（Race ジョブ）に相当する仕組みは Node に無いため、TS 実装ではジョブを設けない。並行性の振る舞いはテストで検証する

### CodeQL

- `develop`・`main` 向けの PR と両ブランチへの push 時に JavaScript/TypeScript を解析する。手動実行にも対応する。毎週月曜 03:17 UTC（日本時間 12:17）には既定ブランチの `main` を解析する。定期・手動実行はワークフローが `main` に入ってから利用できる。public リポジトリでは 60 日間活動がないと定期実行が自動で無効になるため、止まっていたら Actions 画面で有効にし直す
- Markdown ファイルだけを変える PR では実行しない（`paths-ignore`）。CodeQL を必須チェックにする場合は、この除外で PR がチェック待ちのまま止まらないか見直す
- 言語は `javascript-typescript`、`build-mode: none` で解析する。ビルドの工程は無い。クエリは `security-extended` を使う。テストコード（`*.test.ts`・`*.bench.ts`）は CodeQL の設定ファイルの `paths-ignore` で解析対象から外す
- 解析結果は GitHub code scanning にアップロードし、PR のチェックとリポジトリのセキュリティ画面で確認する。結果のアップロード用に `security-events: write` を CodeQL ジョブだけに付与し、リポジトリの内容は `contents: read` で読み取る。fork からの PR はトークンが読み取り専用になるため、解析だけ行い結果はアップロードしない
- 制限時間は 20 分。同じ PR の古い実行は取り消し、push・定期・手動の実行中ジョブは取り消さない。Lint・Test・Coverage との依存は設けない

## 依存関係の更新

- `.github/dependabot.yml` で npm パッケージ（`npm`）と GitHub Actions（`github-actions`）を毎週月曜 09:00（`Asia/Tokyo`）に確認する。すべての設定に `target-branch: develop` を指定し、`develop` 上の依存情報を調べ、更新 PR のマージ先も `develop` に固定する
- 更新はエコシステムごとに 1 件の PR にまとめる（`groups`）
- npm パッケージはルートの `package.json`・`package-lock.json`、GitHub Actions は `.github/workflows/` と `.github/actions/setup-node/action.yml` を対象にする。共通アクション内の依存も更新できるよう、GitHub Actions の確認先に `/` と `/.github/actions/setup-node` を指定する
- Node のメジャーバージョン（`.nvmrc`）は Dependabot の対象外とし、手で更新する
- Dependabot は既定ブランチの設定ファイルを読むため、定期更新はこの設定が `main` に入ってから有効になる。設定ファイルの配置先と、更新 PR のマージ先の `develop` は異なる
- GitHub の自動セキュリティ更新 PR は `target-branch` に従わず既定ブランチの `main` 向けになるため、リポジトリ設定で無効にする。Dependabot alerts（脆弱性の通知）は有効のまま残す。[GitHub の target-branch 仕様](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#target-branch)を参照
- 通知された脆弱性は、修正 PR を手で `develop` 向けに作るか、週次の更新 PR で直す。通知は `main` の依存関係から計算されるため、修正が `main` に入るまで通知は残り、`main` には脆弱な版が残る。急ぐ場合は、修正後すぐに `develop` を `main` へマージする
- 設定の確認：自動セキュリティ更新が無効で通知が有効であることを、`gh api repos/mshi-04/auth-server/automated-security-fixes`（`"enabled":false`）と `gh api -i repos/mshi-04/auth-server/vulnerability-alerts`（`204`）で確かめる。この設定と `dependabot.yml` が `main` に入った後、最初の週次更新で `develop` 向けの PR が作られることを確認する

## 環境変数

| 名前 | 必須 | 既定値 | 内容 |
|---|---|---|---|
| `DATABASE_PATH` | 必須 | なし | SQLite ファイルのパス |
| `PORT` | 任意 | `8080` | 待ち受けポート |

`DATABASE_PATH` が空、または絶対パス化・リンク解決の前後で `/mnt/c` 配下なら起動エラーになる。親ディレクトリは先に用意する。`PORT` は未設定・空なら 8080、それ以外は十進数字の 1〜65535 に限る。サーバーは IPv4 の全インターフェースで待ち受け、SIGINT・SIGTERM で最大 30 秒の正常終了を待つ。

## Web 画面と Windows からの接続

- Node サーバーの起動後、Windows のブラウザーで `http://127.0.0.1:8080/` を開く。画面と API は同じサーバーが配信するため、フロントエンド用の起動コマンドや依存のインストールは不要
- HTML・CSS・JavaScript は `src/httpapi/web/` に置き、サーバーの起動時にメモリへ読み込む。変更後はサーバーを再起動する
- WSL 2.4.11.0 のこの開発環境では、IPv6 の全アドレスで待ち受けると Windows 側に IPv6 のループバックだけが転送され、IPv4 の `127.0.0.1` が失敗した。サーバーは `0.0.0.0` で待ち受け、この差を避ける。IPv6 の接続は対象外
- 接続確認は通常の Windows PowerShell またはブラウザーで行う。エージェントの実行サンドボックスからの失敗だけでは、Windows ホストから到達できないとは判断しない
- 起動直後の転送待ちと、WSL 内・Windows 側の切り分け手順は [README](../README.md#接続できない場合) を参照

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

## Go 実装（移行完了まで）

design.md 10 章の手順 7 で、この節ごと削除する。それまでは Go 実装を壊さないよう、Go 用の CI も通す。

### 環境とコマンド

- Go は WSL にだけ入っている。モジュールキャッシュは WSL 側（`~/go`）に置かれる。Windows からは `wsl -d Ubuntu-24.04 --exec bash -lc 'go test ./...'` の形で実行する

| 目的 | コマンド |
|---|---|
| 整形確認 | `gofmt -l .`（出力が空なら整形済み。`gofmt -w .` で整形する） |
| go.mod の整理確認 | `go mod tidy -diff` |
| 静的検査 | `go vet ./...` |
| テスト | `go test ./...` |
| ベンチマーク | `go test -bench=. ./internal/password` |
| 起動 | `DATABASE_PATH=~/.local/share/auth-server/auth.db go run ./cmd/authd` |

### CI・CodeQL・Dependabot

- `.github/workflows/ci.yml` の Go 用のジョブは、TS 用のジョブと並べて次の 4 つを独立して実行する。design.md 10 章の手順 1 で TS 用のジョブを追加するとき、既存のジョブ名と artifact 名に `Go`・`go-` を付けて区別する

| ジョブ | 内容 |
|---|---|
| Go Lint | `gofmt -l .` による整形確認（ファイルは書き換えない）、`go mod tidy -diff`、`go vet ./...` |
| Go Test | `go test -count=1 ./...` |
| Go Coverage | `go test -count=1 -covermode=atomic -coverpkg=./... -coverprofile=coverage/coverage.out ./...` とカバレッジレポートの生成・保存 |
| Go Race | `CGO_ENABLED=1 go test -count=1 -race ./...` |

- 実行環境は Ubuntu 24.04、`CGO_ENABLED=0`。Go のバージョンは `go.mod` から読み込む。Race ジョブだけ `CGO_ENABLED=1` にする。WSL には gcc が無いため、Race はローカルでは実行しない
- Go のインストールとキャッシュの復元は `.github/actions/setup-go` にまとめる。キャッシュ（モジュールとビルド結果）はジョブごとに分け、`go.mod` と `go.sum` が変わるまで再利用する
- Go Coverage の PR コメントと artifact の扱いは TS の Coverage と同じ規則に従う。Go の artifact は `go-coverage-report` とし、`coverage.html`・`coverage.txt`（関数別一覧）・`coverage.out` を保存する
- CodeQL は `go` も解析する。`build-mode: manual` で `go build ./...` を実行し、共通の Go セットアップを使う
- Dependabot は `gomod` のルートの `go.mod`・`go.sum` と、`/.github/actions/setup-go` の GitHub Actions も確認する
