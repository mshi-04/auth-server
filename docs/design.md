# 認証基盤バックエンド 設計書（学習用 v0.9）

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

パッケージの責務と依存の向きは [architecture.md](architecture.md) を正本とする。

```
auth-server/
├── cmd/authd/              # エントリポイント
├── internal/
│   ├── config/             # 環境変数（DATABASE_PATH、PORT）
│   ├── httpapi/            # ハンドラ、ミドルウェア、Problem Details
│   ├── auth/               # 登録とログインの処理
│   ├── password/           # Argon2id とパスワードポリシー
│   └── store/sqlite/       # SQLite による永続化（init.sql を埋め込んで起動時に実行）
├── db/init.sql             # テーブル作成（マイグレーションツールは使わない）
├── docs/                   # design.md、architecture.md など
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

```go
type Params struct {
    MemoryKiB     uint32
    Iterations    uint32
    Parallelism   uint8
    SaltLength    uint32
    KeyLength     uint32
    MaxConcurrent int
    WaitTimeout   time.Duration
}
```

| 項目 | 初期値 | ベンチマーク後の採用値 |
|---|---|---|
| memory | 64 MiB（65536 KiB） | 128 MiB（131072 KiB） |
| iterations | 3 | 9 |
| parallelism | 2 | 2 |
| salt 長 | 16 バイト | 16 バイト |
| 出力長 | 32 バイト | 32 バイト |
| 同時ハッシュ数（セマフォ） | 4 | 4 |
| セマフォ待機タイムアウト | 5 秒 | 5 秒 |

- `DefaultParams()` が採用値を返す。ゼロ値の暗黙補完は行わない
- 初期値は学習用の出発点であり、最終値は 4.7 のベンチマークで 1 回 200〜500ms 程度になるよう調整する
- 参考：RFC 9106 の推奨第 2 案は m=64 MiB、t=3、p=4。OWASP の最低ラインは m=19 MiB、t=2、p=1

生成設定と保存済み PHC の検証には、現行設定と独立した次の固定範囲を使う。上限はこの学習用実装でのリソース制限であり、Argon2 自体の上限ではない。

| 項目 | 許容範囲 |
|---|---|
| memory | `8 × parallelism` KiB 以上、262144 KiB（256 MiB）以下 |
| iterations | 1〜10 |
| parallelism | 1〜16 |
| salt 長 | 生成設定は 16〜64 バイト、保存済み PHC は 1〜64 バイト |
| 出力長 | 4〜64 バイト |

- `MaxConcurrent` と `WaitTimeout` は正数に限る
- 不正な生成設定は `New` が `ErrInvalidParams` を返す。保存済み PHC の範囲外の値は `ErrInvalidHash` とする
- memory・iterations・parallelism・出力長の下限は RFC 9106 の入力条件に従う。生成設定のソルト長の下限は RFC 9106 の推奨値 16 バイトとし、保存済み PHC のソルトは空でなければ受理する

### 4.3 保存形式

```
$argon2id$v=19$m=131072,t=9,p=2$<salt>$<hash>
```

salt と hash は base64（パディングなし、`base64.RawStdEncoding`）。

- アルゴリズムは `argon2id`、バージョンは `19` に限る
- パラメータは `m`・`t`・`p` がそれぞれ 1 回ずつ必要。解析時の順序は問わないが、生成時は `m,t,p` の順にする
- 不足・重複・未知の項目、数字以外を含む値、先頭が 0 の値、整数の桁あふれ、4.2 の範囲外の値を拒否する
- ソルトと出力の符号化後の長さを検査してからデコードする。パディング、不正文字、改行、不正な末尾ビット、空要素を拒否する
- `Verify` と `NeedsRehash` は同じ PHC パーサーを使う

### 4.4 API

状態（パラメータ・セマフォ）を持つため、関数ではなく構造体のメソッドとして提供する。

```go
params := password.DefaultParams()
h, err := password.New(params) // (*password.Hasher, error)
```

| メソッド | 振る舞い |
|---|---|
| `Hash(ctx, password) (string, error)` | **NFKC 正規化 → ポリシー検査（4.5）** → セマフォ取得 → ソルト生成 → Argon2id → PHC 文字列 |
| `Verify(ctx, password, encoded) (bool, error)` | **NFKC 正規化 → 不正な UTF-8 と最大長の検査** → PHC をパース → セマフォ取得 → 保存済みパラメータとソルトでハッシュ → 定数時間比較。不一致・最大長超過・不正な UTF-8 は `(false, nil)`、PHC 異常はエラー |
| `NeedsRehash(encoded) bool` | memory・iterations・parallelism・ソルト長・出力長のいずれかが現行設定と異なれば `true`。PHC が不正な場合も `true`。同時数と待機時間は比較しない |

- `New(params Params) (*Hasher, error)` は設定を検証し、値のコピーとセマフォを保持する
- エラーは `ErrInvalidParams`（生成設定。`New` を通さないゼロ値の `Hasher` で `Hash`・`Verify` を呼んだ場合も含む）、`ErrPolicyViolation`（Hash のポリシー違反）、`ErrInvalidHash`（PHC 異常）、`ErrBusy`（セマフォ待機の打ち切り）とし、`errors.Is` で判定できる
- `Hash` と `Verify` は**同じ正規化処理**を通す。正規化をずらすと、全角文字などを含むパスワードで「登録できるがログインできない」状態になる
- `Verify` では最小長を検査しない（ポリシーを後から強化しても既存ユーザーがログインできなくなるのを防ぐ）
- セマフォの待機は `ctx` のキャンセル・期限切れとタイムアウト（既定 5 秒）で打ち切り、いずれも `ErrBusy` を返す。`ctx` による打ち切りでは `ctx.Err()` も包み、クライアントの切断や期限切れを `errors.Is` で過負荷と区別できるようにする。キャンセル済みの `ctx` では、空き枠があっても計算を開始しない
- パスワードと PHC をログやエラーメッセージに含めない

### 4.5 パスワードポリシー

- NFKC 正規化した後の **Unicode コードポイント数**（`utf8.RuneCountInString`）で長さを判定する
- 最小 12 文字、最大 128 文字
- 文字種の組み合わせは強制しない
- 不正な UTF-8 を含む入力は拒否する（`Hash` は `ErrPolicyViolation`、`Verify` は `(false, nil)`）

### 4.6 同時実行制限

- セマフォで同時に計算するハッシュの数を 4 に制限する（`Hash` と `Verify` の両方に適用）。制限するのは枠数であり、メモリ量ではない。1 回あたりのメモリは採用値で 128 MiB（4 並列で 512 MiB）だが、`Verify` は保存済み PHC のパラメータで計算するため、最悪で 1 回 256 MiB（4.2 の上限）、4 並列で 1 GiB になる
- 待機がタイムアウトしたら `ErrBusy` を返し、API 層で 503 に変換する
- 同じ `Hasher` の `Hash` と `Verify` はセマフォを共有する。Argon2id の計算開始後はキャンセルで中断せず、完了まで枠を保持し、終了時に必ず解放する

### 4.7 テスト・ベンチマーク

| 種別 | 内容 |
|---|---|
| 正常系 | Hash → Verify が true |
| 誤パスワード | Verify が false |
| 正規化の一貫性 | 全角英数字で Hash し、半角英数字で Verify して true（逆も同様） |
| PHC パース異常 | アルゴリズム名・バージョン・パラメータ・base64 の不正でエラー |
| NeedsRehash | パラメータ変更後に true、同一なら false、不正な PHC で true |
| ポリシー境界値 | 11 / 12 / 128 / 129 文字、NFKC で文字数が変わる入力、不正な UTF-8 |
| セマフォ | 同時数を超えた呼び出しがタイムアウトで `ErrBusy` になる。Argon2id の計算中は枠を保持し、終了後に解放する |
| ベンチマーク | `BenchmarkHash`（既定のパラメータ）、`BenchmarkHashSaturated`（既定のパラメータで同時ハッシュ数いっぱいに並列実行したときの 1 回あたりの所要時間）、`BenchmarkHashCandidates`（下記の候補）。`go test -bench=. ./internal/password` で計測 |

- 単体テストは小さい計算パラメータを使う。セマフォのテストはテスト側で枠を占有し、重い計算の実行時間に依存させない
- ベンチマークは WSL の Go 1.27.2、`CGO_ENABLED=0` で 3 回測定し、中央値を使う。まず 64 MiB・並列 2 のまま反復 2〜10 を評価する
- 候補は `go test -run='^$' -bench=BenchmarkHashCandidates -count=3 ./internal/password` で測る。`BenchmarkHashCandidates` は 64 MiB と 128 MiB の反復 2〜10 を含む。ほかのメモリ設定を評価するときは候補に加える
- 目標の 200〜500ms に入る候補が無ければ、速すぎる場合は 128→256 MiB、遅すぎる場合は 32→19 MiB の順に評価する。最初に目標に入るメモリ設定で、中央値が 300ms に最も近い反復数を採用する。同差なら反復数が多い方を採用する
- 採用値と初期値の測定結果を本書へ記録し、採用値を本書へ反映してから `DefaultParams()` を変更する。候補内で目標を達成できなければ、未達を報告し、次段階へ進む前に調整方針を確認する

#### 性能調整の結果（2026-10-18）

環境：WSL Ubuntu 24.04、Go 1.27.2、linux/amd64、`CGO_ENABLED=0`、Intel Core i7-12700。ベンチマークの `GOMAXPROCS` は 4。

- 初期値（64 MiB・反復 3・並列 2）：55.459 / 50.652 / 50.809 ms、中央値 **50.809 ms**。下の候補表とは別に測定したため、候補表の同じ構成（50.873 ms）とは一致しない
- 採用候補（128 MiB・反復 9・並列 2）：306.265 / 318.128 / 313.139 ms、中央値 **313.139 ms**
- 採用値を `DefaultParams()` に反映した直後の `BenchmarkHash`（第 1 回）：347.418 / 308.070 / 304.739 ms、中央値 **308.070 ms**（目標の 200〜500 ms 内）
- PR #3 作成前の `BenchmarkHash` 再測定（第 2 回、対象コミット `d0883fc`）：351.634 / 329.852 / 338.685 ms、中央値 **338.685 ms**（目標の 200〜500 ms 内）。これが最新の測定結果で、PR 説明にも同じ値を記録している
- 採用値で同時ハッシュ数いっぱい（4 並列）に飽和させた `BenchmarkHashSaturated`：1073.526 / 961.919 / 875.585 ms、中央値 **961.919 ms**。4 件を同時に計算し終えるまでの時間で、競合時のハッシュ 1 回の所要時間にあたる。1 回あたりの確保量は約 512 MiB（4 × 128 MiB）
- 64 MiB では反復 2〜10 の全候補が 200 ms 未満だったため、次の 128 MiB を評価した。128 MiB の目標内の候補では反復 9 が 300 ms に最も近いため採用した

各候補を 3 回測定した中央値（ms）：

| iterations | 64 MiB | 128 MiB |
|---|---|---|
| 2 | 35.217 | 73.526 |
| 3 | 50.873 | 107.082 |
| 4 | 66.103 | 144.060 |
| 5 | 86.237 | 173.205 |
| 6 | 100.725 | 206.776 |
| 7 | 111.814 | 243.153 |
| 8 | 129.069 | 273.917 |
| 9 | 143.897 | 313.139 |
| 10 | 162.180 | 349.729 |

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
   - ダミーハッシュは**起動時に現行パラメータで生成**する（ポリシーを満たすランダムな文字列を `Hash` する）。古いパラメータのダミーを使うと、存在しないユーザーの方が応答が速くなり、列挙対策が崩れる。逆に、パラメータを引き上げた後は、まだ再ハッシュされていない既存ユーザーが旧パラメータで検証されるため、ダミーより速く応答する（7 章の既知の制限）
   - 保存済みハッシュが不正（`ErrInvalidHash`）な場合も、ダミーハッシュに対して Verify を実行して応答時間を揃え、`slog` でエラーを出して 401 にする（ハッシュはログに出さない）。即座に失敗を返すと、応答時間から壊れた行の存在が分かるため
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
| `WriteTimeout` | 30 秒 |
| `IdleTimeout` | 60 秒 |

`WriteTimeout` は、1 リクエストで起こりうる最長の待ち時間より長くする。最長になるのは再ハッシュを伴うログインで、セマフォ待機（最大 5 秒）とハッシュをそれぞれ 2 回（Verify と再ハッシュ）、ストアへのアクセスを 2 回（読み込みと更新。`busy_timeout` で各最大 5 秒）行う。待機だけで最大 20 秒になり、そこへ競合で遅くなったハッシュ 2 回分（4.7 の `BenchmarkHashSaturated` で 1 回約 1 秒）が加わるため、合計は約 22 秒になる。30 秒なら、ハッシュ 1 回が 5 秒かかるまで収まる。これより短いと、503 などの応答を書く前に接続が切られる。

### 6.7 テスト

- 登録とログインの処理（ダミーハッシュの経路、再ハッシュ、エラーの統一）は、`auth` のテストで偽 `UserStore` を使って検証する
- ハンドラのテストは `httptest` で行い、ステータスコードと Problem Details の形を検証する
- パッケージごとのテスト方法は [architecture.md](architecture.md) の「テスト」を参照

## 7. 既知の制限（README に明記する）

- 登録 API は重複時に 409 を返すため、**メールアドレスが登録済みかどうかを第三者が確認できる**（ユーザー列挙）
- ペッパー、レート制限、トークン発行がないため、本番利用には適さない
- パラメータを引き上げた後、まだ再ハッシュされていない既存ユーザーは旧パラメータで検証されるため、存在しないユーザー（ダミーハッシュ）より速く応答する。該当ユーザーが次に正しくログインして再ハッシュされるまで、応答時間から登録済みかどうかを推測できる
- NFKC の安定性が保証されるのは割り当て済みの文字だけである。`golang.org/x/text` の Unicode 表で未割り当ての文字を含むパスワードは、x/text の更新でその文字に分解が定義されると正規化の結果が変わり、正しいパスワードでもログインできなくなる

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
4. auth と API（httpapi）を実装し、テストを通す
5. README を書き、完了条件を確認する

各段階でテストが通ってから次へ進む。不明点や本書と矛盾する点があれば、推測で進めず質問する。

## 11. 決定事項（v0.4 の未決事項を確定）

| # | 論点 | 決定 | 反映先 |
|---|---|---|---|
| 1 | モジュールパスとフォルダ名 | どちらも `auth-server`。フォルダは改名済み | 3 章 |
| 2 | password の API の形 | `password.New(Params) (*Hasher, error)` で設定を検証し、メソッドで提供 | 4.4 |
| 3 | ログイン時のポリシー適用 | 最小長は検査しない。NFKC 正規化と最大長のみ | 4.4 |
| 4 | 文字数の数え方 | NFKC 正規化後の Unicode コードポイント数 | 4.5 |
| 5 | セマフォ待機タイムアウト | 5 秒（設定可能）。タイムアウト時は 503 | 4.2、4.6、6.2 |
| 6 | エラー時のステータス | JSON 不正 400、ポリシー違反 422、ボディ上限超過 413 | 6.2 |
| 7 | メールアドレスの形式チェック | `net/mail.ParseAddress` で解析でき、表示名を含まない | 6.3 |
| 8 | UUID の生成元 | アプリ側で `github.com/google/uuid` の v4 | 5.2 |
| 9 | テスト方法 | DB は `t.TempDir()` の SQLite、auth と API は偽 `UserStore` | 5.5、6.7 |
| 10 | 不正な PHC の `NeedsRehash` | `true` を返す | 4.4 |
| 11 | `DATABASE_PATH` 未設定 | 起動エラー | 6.5 |
| 12 | ログイン時のメールアドレス形式不正 | ユーザー不在と同じ扱い（ダミー Verify → 401） | 6.2、6.4 |
| 13 | ログイン時の再ハッシュ失敗 | 警告ログを出して 200 | 6.4 |
| 14 | サーバータイムアウト値 | ReadHeader 5 秒、Read 10 秒、Write 30 秒、Idle 60 秒 | 6.6 |

## 変更履歴

- v0.9：コードレビューの指摘を反映。生成設定のソルト長の下限を 16 バイトに変更。PHC の先頭が 0 の値と、不正な UTF-8 のパスワードを拒否。ゼロ値の `Hasher` は `ErrInvalidParams`、`ctx` による打ち切りの `ErrBusy` は `ctx.Err()` も包むよう変更。4.6 の制限を枠数として書き直し、メモリの最悪値を明記。保存済みハッシュ不正時のログインの扱いを追記。6.6 の見積もりを再ハッシュ込みに直し、`WriteTimeout` を 30 秒に変更。ベンチマークに飽和時と候補の計測を追加し、飽和時の測定結果を記録。既知の制限（パラメータ引き上げ後の応答時間差、未割り当て文字の正規化）を追記
- v0.8：password の設定構造体と `DefaultParams()`、設定検証・エラーを確定。`New` に error を追加。生成設定と PHC の固定範囲、PHC の解析規則、再ハッシュ比較項目、キャンセルとセマフォ解放、性能調整の手順と測定結果を追記。採用値を 128 MiB・反復 9・並列 2 に調整
- v0.7：architecture.md（3 層構成）に合わせ、ディレクトリ構成に `internal/auth` を追加。テスト方針と作業手順を auth 層前提に修正
- v0.6：ログイン時のメールアドレス形式不正を 401 に統一。再ハッシュ失敗時の扱いを追記。サーバータイムアウト値を確定（6.6）。フォルダ改名済みを反映
- v0.5：Hash の処理順を「正規化 → ポリシー検査」に修正。Verify にも NFKC 正規化と最大長検査を追加。PRAGMA を DSN 指定に変更し `_txlock=immediate` を追加。ダミーハッシュを起動時に現行パラメータで生成する旨を追記。未決事項を確定し本文に反映。フォルダ名を `auth-server` に統一
