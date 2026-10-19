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
- `/mnt/c` ではファイルロックや WAL の共有メモリが正しく動かないことがある
- 置き場所は環境変数 `DATABASE_PATH` で指定する（未設定なら起動エラー）

## コマンド

WSL 上のリポジトリのルートで実行する。

| 目的 | コマンド |
|---|---|
| 静的検査 | `go vet ./...` |
| テスト | `go test ./...` |
| ベンチマーク（ハッシュ 1 回の所要時間） | `go test -bench=. ./internal/password` |
| 起動 | `DATABASE_PATH=~/.local/share/auth-server/auth.db go run ./cmd/authd` |

## CI

GitHub Actions の `.github/workflows/ci.yml` で、`develop`・`main` 向けの PR と両ブランチへの push 時に、次の 2 ジョブを並行して実行する。

| ジョブ | 内容 |
|---|---|
| Lint | `gofmt` による Go ファイルの整形確認（ファイルは書き換えない）と `go vet ./...` |
| Test and coverage | `go test -count=1 -covermode=atomic -coverpkg=./... -coverprofile=coverage/coverage.out ./...` とカバレッジレポートの生成・保存 |

テストはキャッシュ済みの結果を使わず実行する。全パッケージをカバレッジの計測対象にし、テストのないパッケージのコードも集計に含める。

- 合計カバレッジは GitHub Actions の実行サマリーに表示する
- テスト成功時に `coverage-report` artifact を 14 日間保存する。`coverage.html` はブラウザでソース行ごとの実行状況を確認でき、`coverage.txt` は関数別一覧、`coverage.out` は Go 標準の計測データ
- ローカルで同じコマンドを実行するときも、先に `mkdir -p coverage` を行う。`go tool cover -func=coverage/coverage.out` で関数別一覧を、`go tool cover -html=coverage/coverage.out -o coverage/coverage.html` で HTML を生成できる。生成先の `coverage/` は Git の管理対象から外す

- 実行環境は Ubuntu 24.04、`CGO_ENABLED=0`。Go のバージョンは `go.mod` から読み込む
- Go のキャッシュは `go.sum` を基準に再利用する
- 各ジョブの制限時間は 10 分。同じ PR またはブランチの新しい実行が始まったら、古い実行を取り消す
- 性能測定は WSL で行い、ベンチマークは CI では実行しない

## 環境変数

| 名前 | 必須 | 既定値 | 内容 |
|---|---|---|---|
| `DATABASE_PATH` | 必須 | なし | SQLite ファイルのパス |
| `PORT` | 任意 | `8080` | 待ち受けポート |

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

### リモート

- `origin`：https://github.com/mshi-04/auth-server（public）
