# テックスタック

採用技術と、その理由をまとめる。仕様の詳細は [design.md](design.md) を参照。依存ライブラリのバージョンは、実装後は `go.mod` を正本とする。

## 言語・実行環境

| 項目 | 採用 | 理由 |
|---|---|---|
| 言語 | Go 1.27.2 | 標準ライブラリだけで HTTP サーバー、暗号、ログがそろう |
| 開発環境 | WSL2（Ubuntu 24.04） | Go は WSL にだけ入れる。ソースは Windows 側のフォルダに置く |
| cgo | 使わない（CI のレース検出だけで使う） | WSL に gcc を入れずにビルドできるようにするため |
| CI | GitHub Actions（実行条件は development.md の「CI」） | PR と統合後の変更に対し、テスト・レース検出・Lint・カバレッジレポートを同じ Go バージョンで実行するため |
| セキュリティ解析 | GitHub CodeQL（実行条件は development.md の「CodeQL」） | Go の脆弱性を検査し、GitHub code scanning に結果を集約するため |
| 依存更新 | Dependabot（設定は development.md の「依存関係の更新」） | 依存の更新を PR で検証してから取り込むため |

## ライブラリ

| 用途 | 採用 | 理由 |
|---|---|---|
| HTTP | 標準 `net/http`（Go 1.22 以降の `ServeMux` パターン） | メソッドとパスのルーティングが標準で足りる。フレームワークの挙動を覚える必要がない |
| Web 画面 | HTML・CSS・JavaScript と標準 `embed` | Go の実行ファイルだけで画面と API を同じオリジンから配信し、別のビルドツールやフロントエンドの依存を増やさない |
| パスワードハッシュ | `golang.org/x/crypto/argon2`（Argon2id） | RFC 9106 と OWASP が推奨。暗号処理は自前で実装しない |
| ソルト生成 | 標準 `crypto/rand` | 暗号論的に安全な乱数 |
| ハッシュ比較 | 標準 `crypto/subtle.ConstantTimeCompare` | 比較時間から一致箇所を推測されないようにする |
| Unicode 正規化 | `golang.org/x/text/unicode/norm`（NFKC） | 全角と半角などの表記ゆれで、登録とログインのパスワードが食い違わないようにする |
| DB アクセス | 標準 `database/sql` | ORM を挟まず SQL をそのまま書く |
| DB ドライバ | `modernc.org/sqlite` | 純 Go 実装で cgo が不要 |
| UUID | `github.com/google/uuid`（v4） | SQLite に UUID 生成関数が無いため、アプリ側で生成する |
| ログ | 標準 `log/slog`（JSON） | 構造化ログが標準で書ける |
| エラー形式 | RFC 9457（Problem Details） | HTTP API のエラー表現の標準 |

## データベース

| 項目 | 採用 | 理由 |
|---|---|---|
| DB | SQLite（ファイル 1 つ） | 別途サーバーや Docker を起動せずに済む |
| スキーマ管理 | `internal/store/sqlite/init.sql` を同じパッケージから `go:embed` で埋め込み、`Open` で実行 | テーブルが 2 つだけなのでマイグレーションツールは不要 |
| 接続設定 | DSN の `_pragma` で `foreign_keys`、`journal_mode=WAL`、`busy_timeout` を指定し、`_txlock=immediate` を付ける | `database/sql` のコネクションプールの全接続に設定を効かせるため |

## テスト

| 対象 | 方法 |
|---|---|
| password パッケージ | 標準 `testing`。ベンチマークは `BenchmarkHash` |
| DB | `t.TempDir()` に SQLite ファイルを作り、毎回まっさらな DB で実行する |
| HTTP ハンドラ | 標準 `net/http/httptest` と、メモリ上の偽 Repository |

## 使わないもの

| 対象 | 理由 |
|---|---|
| Web フレームワーク（Gin、Echo など） | 標準 `net/http` で足りる |
| ORM、sqlc | SQL を直接書いて、何が実行されるかを見えるようにする |
| goose などのマイグレーションツール | `init.sql` 1 つで足りる |
| Docker、testcontainers | SQLite で DB サーバーが不要になった |
| JWT ライブラリ | トークン発行はスコープ外 |
