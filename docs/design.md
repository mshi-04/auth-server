# 認証基盤バックエンド 設計書（学習用 v0.6）

## 1. 目的

パスワード保存の仕組み（Argon2id、ソルト、PHC 形式、定数時間比較、再ハッシュ）を、実際に動く最小の登録・ログイン API を通して理解する。

## 2. スコープ

### 実装するもの

1. `internal/password` パッケージ（ハッシュ化・検証・再ハッシュ判定・パスワードポリシー・同時実行制限）
2. 登録・ログイン API（`POST /v1/users`、`POST /v1/sessions`、`GET /healthz`）
3. SQLite のテーブル 2 つ（`users`、`password_credentials`）

### 実装しないもの

JWT・リフレッシュトークン、ペッパー、メール確認、パスワードリセット、JWKS、レート制限、監査ログ、sqlc、goose、testcontainers、MFA、Docker。

## 3. ディレクトリ構成

Go のモジュールパスは `auth-server`。プロジェクトのフォルダ名も `auth-server`（旧フォルダ名 `auth-sever` から改名済み）。

```
auth-server/
├── cmd/authd/              # エントリポイント
├── internal/
│   ├── config/             # 環境変数（DATABASE_PATH、PORT）
│   ├── password/           # Argon2id とパスワードポリシー
│   ├── store/sqlite/       # SQLite による永続化（init.sql を埋め込んで起動時に実行）
│   └── httpapi/            # ハンドラ、ミドルウェア、Problem Details
├── db/init.sql             # テーブル作成（マイグレーションツールは使わない）
├── docs/design.md
└── README.md
```

## 4. password パッケージ

### 4.1 使用ライブラリ

| 用途 | ライブラリ |
|---|---|
| Argon2id | `golang.org/x/crypto/argon2` の `IDKey`（暗号処理の自前実装は禁止） |
| ソルト生成 | `crypto/rand`（`math/rand` は使用禁止） |
| 比較 | `crypto/subtle.ConstantTimeCompare` |
| 正規化 | `golang.org/x/text/unicode/norm`（NFKC） |

### 4.2 パラメータ

構造体 `Params` で設定可能にする。

| 項目 | 初期値 |
|---|---|
| memory | 64 MiB（65536 KiB） |
| iterations | 3 |
| parallelism | 2 |
| salt 長 | 16 バイト |
| 出力長 | 32 バイト |
| 同時ハッシュ数（セマフォ） | 4 |
| セマフォ待機タイムアウト | 5 秒 |

- 初期値は学習用の出発点であり、最終値は 4.7 のベンチマークで 1 回 200〜500ms 程度になるよう調整する
- 参考：RFC 9106 の推奨第 2 案は m=64 MiB、t=3、p=4。OWASP の最低ラインは m=19 MiB、t=2、p=1

### 4.3 保存形式

```
$argon2id$v=19$m=65536,t=3,p=2$<salt>$<hash>
```

salt と hash は base64（パディングなし、`base64.RawStdEncoding`）。

### 4.4 API

状態（パラメータ・セマフォ）を持つため、関数ではなく構造体のメソッドとして提供する。

```go
h := password.New(params) // *password.Hasher
```

| メソッド | 振る舞い |
|---|---|
| `Hash(ctx, password) (string, error)` | **NFKC 正規化 → ポリシー検査（4.5）** → セマフォ取得 → ソルト生成 → Argon2id → PHC 文字列 |
| `Verify(ctx, password, encoded) (bool, error)` | **NFKC 正規化 → 最大長検査** → PHC をパース → セマフォ取得 → 保存済みパラメータとソルトでハッシュ → 定数時間比較。不一致・最大長超過は `(false, nil)`、PHC 異常はエラー |
| `NeedsRehash(encoded) bool` | 保存済みパラメータが現行設定と異なれば `true`。PHC が不正な場合も `true` |

- `Hash` と `Verify` は**同じ正規化処理**を通す。正規化をずらすと、全角文字などを含むパスワードで「登録できるがログインできない」状態になる
- `Verify` では最小長を検査しない（ポリシーを後から強化しても既存ユーザーがログインできなくなるのを防ぐ）
- セマフォの待機は `ctx` とタイムアウト（5 秒）で打ち切り、`ErrBusy` を返す

### 4.5 パスワードポリシー

- NFKC 正規化した後の **Unicode コードポイント数**（`utf8.RuneCountInString`）で長さを判定する
- 最小 12 文字、最大 128 文字
- 文字種の組み合わせは強制しない

### 4.6 同時実行制限

- Argon2id は 1 回で 64 MiB を消費するため、セマフォで同時ハッシュ数を 4 に制限する（`Hash` と `Verify` の両方に適用）
- 待機がタイムアウトしたら `ErrBusy` を返し、API 層で 503 に変換する

### 4.7 テスト・ベンチマーク

| 種別 | 内容 |
|---|---|
| 正常系 | Hash → Verify が true |
| 誤パスワード | Verify が false |
| 正規化の一貫性 | 全角英数字で Hash し、半角英数字で Verify して true（逆も同様） |
| PHC パース異常 | アルゴリズム名・バージョン・パラメータ・base64 の不正でエラー |
| NeedsRehash | パラメータ変更後に true、同一なら false、不正な PHC で true |
| ポリシー境界値 | 11 / 12 / 128 / 129 文字、NFKC で文字数が変わる入力 |
| セマフォ | 同時数を超えた呼び出しがタイムアウトで `ErrBusy` になる |
| ベンチマーク | `BenchmarkHash`。`go test -bench=. ./internal/password` で 1 回あたりの所要時間を計測 |

## 5. データベース

### 5.1 ドライバ

`database/sql` + `modernc.org/sqlite`（純 Go 実装）。cgo が不要なため、WSL に gcc を入れずにビルドできる。

### 5.2 スキーマ（`db/init.sql`）

SQLite には `uuid` 型や `timestamptz` 型が無いため、どちらも `TEXT` で持つ。

```sql
CREATE TABLE IF NOT EXISTS users (
    id               TEXT PRIMARY KEY,             -- UUID 文字列
    email            TEXT NOT NULL,
    email_normalized TEXT NOT NULL UNIQUE,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE IF NOT EXISTS password_credentials (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    hash       TEXT NOT NULL,                      -- PHC 文字列
    changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
```

- `STRICT` テーブルにして、型の異なる値が入るのを防ぐ
- `email_normalized` はメールアドレスを小文字化した値。重複判定に使う
- 時刻は UTC の ISO 8601 文字列
- ユーザー ID はアプリ側で `github.com/google/uuid` の v4 を使って生成する（SQLite には UUID 生成関数が無いため）

### 5.3 初期化と接続設定

- `db/init.sql` を `go:embed` でバイナリに埋め込み、起動時に実行する（`IF NOT EXISTS` なので何度実行しても安全）
- PRAGMA は **DSN の `_pragma` パラメータで指定**する。`database/sql` はコネクションプールのため、起動時に `db.Exec("PRAGMA ...")` しても 1 接続にしか効かない

```
file:<DATABASE_PATH>?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_txlock=immediate
```

| 設定 | 値 | 理由 |
|---|---|---|
| `foreign_keys` | `1` | SQLite は既定で外部キー制約を検査しない |
| `journal_mode` | `WAL` | 読み込みと書き込みを並行できる |
| `busy_timeout` | `5000` | 書き込みの競合時に即エラーにせず待つ |
| `_txlock` | `immediate` | トランザクション開始時に書き込みロックを取り、読み込み→書き込みへの昇格時に `busy_timeout` が効かず即 `SQLITE_BUSY` になる問題を防ぐ |

### 5.4 書き込み

- 登録時は `users` と `password_credentials` を 1 トランザクションで挿入する
- 重複は UNIQUE 制約違反（`SQLITE_CONSTRAINT_UNIQUE`）で検出し、409 に変換する
- SQLite は同時に書き込めるのが 1 接続だけのため、書き込みの競合は `busy_timeout` の待機で吸収する

### 5.5 テスト

- `t.TempDir()` に SQLite ファイルを作り、毎回まっさらな DB で実行する（skip しない）

## 6. API

### 6.1 エンドポイント

| メソッド | パス | リクエスト | 成功 | 主なエラー |
|---|---|---|---|---|
| POST | `/v1/users` | `{email, password}` | 201 | 400 / 409 / 413 / 422 / 503 |
| POST | `/v1/sessions` | `{email, password}` | 200 `{user_id}` | 400 / 401 / 413 / 503 |
| GET | `/healthz` | なし | 200 | |

- HTTP は標準 `net/http`（Go 1.22 以降の `ServeMux` パターン）。Web フレームワークは使わない
- ログイン成功時にトークンは発行しない（スコープ外）

### 6.2 ステータスコード

| 状況 | ステータス |
|---|---|
| JSON 不正 | 400 |
| 認証失敗（ユーザー不在・パスワード不一致・最大長超過・ログイン時のメールアドレス形式不正を区別しない） | 401 |
| メールアドレス重複 | 409 |
| ボディ上限（16 KiB）超過 | 413 |
| パスワードポリシー違反、登録時のメールアドレス形式不正 | 422 |
| セマフォ待機タイムアウト（`ErrBusy`） | 503 |

### 6.3 メールアドレスの検証

- `net/mail.ParseAddress` で解析でき、表示名（`"Name" <a@example.com>` 形式）を含まないこと
- 正規化はアドレス全体の小文字化

### 6.4 ログインの振る舞い

1. メールアドレスを正規化してユーザーを検索する
   - 形式が不正な場合は 422 にせず、ユーザー不在と同じ扱いにする（2 へ進む）。形式チェックだけ速く返すと応答時間がずれるため
2. ユーザーが存在しなければ、**ダミーハッシュ**に対して Verify を実行し、応答時間を揃える
   - ダミーハッシュは**起動時に現行パラメータで生成**する（ポリシーを満たすランダムな文字列を `Hash` する）。古いパラメータのダミーを使うと、存在しないユーザーの方が応答が速くなり、列挙対策が崩れる
3. 失敗時のメッセージは、原因を問わず「メールアドレスまたはパスワードが正しくありません」に統一する
4. 成功時に `NeedsRehash` が true なら、再ハッシュして `password_credentials` を更新する
   - 再ハッシュや保存に失敗しても認証自体は成功しているため、`slog` で警告を出して 200 を返す。次回ログイン時に再試行される

### 6.5 横断的な要件

| 項目 | 内容 |
|---|---|
| エラー形式 | RFC 9457（Problem Details、`application/problem+json`） |
| ログ | `log/slog` の JSON 出力。パスワードとリクエストボディは出力しない |
| ボディ上限 | 16 KiB（`http.MaxBytesReader`） |
| サーバータイムアウト | 6.6 の値を設定 |
| 設定 | 環境変数 `DATABASE_PATH`（必須。未設定なら起動エラー）、`PORT`（任意、既定 8080） |

### 6.6 サーバータイムアウト

| 設定 | 値 |
|---|---|
| `ReadHeaderTimeout` | 5 秒 |
| `ReadTimeout` | 10 秒 |
| `WriteTimeout` | 20 秒 |
| `IdleTimeout` | 60 秒 |

`WriteTimeout` は、1 リクエストで起こりうる最長の待ち時間より長くする。最長の待ち時間は、セマフォ待機（最大 5 秒）、ハッシュ（数百 ms）、`busy_timeout`（最大 5 秒）の合計になる。これより短いと、503 などの応答を書く前に接続が切られる。

### 6.7 テスト

- ハンドラのテストはメモリ上の偽 Repository で行う（`httptest` を使用）

## 7. 既知の制限（README に明記する）

- 登録 API は重複時に 409 を返すため、**メールアドレスが登録済みかどうかを第三者が確認できる**（ユーザー列挙）
- ペッパー、レート制限、トークン発行がないため、本番利用には適さない

## 8. 開発環境

- Go は WSL（Ubuntu 24.04）にインストール済み。プロジェクトは Windows 側のフォルダに置き、WSL から `/mnt/c` 経由でビルドする
- DB は SQLite のファイル 1 つで、別途サーバーを起動する必要はない
- SQLite のファイルは `/mnt/c` 配下ではなく、WSL 側のファイルシステム（例：`~/.local/share/auth-server/auth.db`）に置く。`/mnt/c` はファイルロックや WAL の共有メモリが正しく動かないことがあるため
- `*.db`、`*.db-wal`、`*.db-shm` は `.gitignore` に入れる
- Android エミュレータから叩く場合、接続先はホストを指す `10.0.2.2`。HTTP（cleartext）通信は Android 9 以降でデフォルト禁止のため、デバッグビルドの Network Security Config で `10.0.2.2` のみ許可する。README にこの注意を記載する

## 9. 完了条件

- `go vet ./...` と `go test ./...` が通る
- `go test -bench=. ./internal/password` でハッシュ 1 回の所要時間が出る
- README に起動手順、curl による登録・ログイン例、Android エミュレータからの接続先と cleartext 通信の注意がある

## 10. 作業手順

1. ファイル構成と作業手順を提示して確認を取る
2. password パッケージを実装し、テストとベンチマークを通す
3. DB（init.sql、store/sqlite）を実装し、テストを通す
4. API を実装し、テストを通す
5. README を書き、完了条件を確認する

各段階でテストが通ってから次へ進む。不明点や本書と矛盾する点があれば、推測で進めず質問する。

## 11. 決定事項（v0.4 の未決事項を確定）

| # | 論点 | 決定 | 反映先 |
|---|---|---|---|
| 1 | モジュールパスとフォルダ名 | どちらも `auth-server`。フォルダは改名済み | 3 章 |
| 2 | password の API の形 | `password.New(Params)` で `*Hasher` を作り、メソッドで提供 | 4.4 |
| 3 | ログイン時のポリシー適用 | 最小長は検査しない。NFKC 正規化と最大長のみ | 4.4 |
| 4 | 文字数の数え方 | NFKC 正規化後の Unicode コードポイント数 | 4.5 |
| 5 | セマフォ待機タイムアウト | 5 秒（設定可能）。タイムアウト時は 503 | 4.2、4.6、6.2 |
| 6 | エラー時のステータス | JSON 不正 400、ポリシー違反 422、ボディ上限超過 413 | 6.2 |
| 7 | メールアドレスの形式チェック | `net/mail.ParseAddress` で解析でき、表示名を含まない | 6.3 |
| 8 | UUID の生成元 | アプリ側で `github.com/google/uuid` の v4 | 5.2 |
| 9 | テスト方法 | DB は `t.TempDir()` の SQLite、API は偽 Repository | 5.5、6.7 |
| 10 | 不正な PHC の `NeedsRehash` | `true` を返す | 4.4 |
| 11 | `DATABASE_PATH` 未設定 | 起動エラー | 6.5 |
| 12 | ログイン時のメールアドレス形式不正 | ユーザー不在と同じ扱い（ダミー Verify → 401） | 6.2、6.4 |
| 13 | ログイン時の再ハッシュ失敗 | 警告ログを出して 200 | 6.4 |
| 14 | サーバータイムアウト値 | ReadHeader 5 秒、Read 10 秒、Write 20 秒、Idle 60 秒 | 6.6 |

## 変更履歴

- v0.6：ログイン時のメールアドレス形式不正を 401 に統一。再ハッシュ失敗時の扱いを追記。サーバータイムアウト値を確定（6.6）。フォルダ改名済みを反映
- v0.5：Hash の処理順を「正規化 → ポリシー検査」に修正。Verify にも NFKC 正規化と最大長検査を追加。PRAGMA を DSN 指定に変更し `_txlock=immediate` を追加。ダミーハッシュを起動時に現行パラメータで生成する旨を追記。未決事項を確定し本文に反映。フォルダ名を `auth-server` に統一
