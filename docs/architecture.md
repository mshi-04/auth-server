# アーキテクチャ

パッケージの分け方、責務、依存の向きをまとめる。機能の仕様は [design.md](design.md)、採用技術は [tech-stack.md](tech-stack.md) を参照。

## 構成（軽量な Clean Architecture）

HTTP の処理、認証の処理、永続化を分け、依存を内側の auth と password へ向ける。パッケージは層名ではなく責務ごとに分ける。

```
cmd/authd ── 組み立て（設定の読み込み、DB 接続、依存の注入、サーバー起動）
   │
   ▼
httpapi ──▶ auth ──▶ password
              │
              ├─ UserStore（interface。auth で定義）
              │       ▲
              │  store/sqlite（実装）
              │       │
              └───────┘ store/sqlite は auth の型とエラーを使う
```

内側の `auth` は、外側の HTTP や SQLite を知らない。

## ディレクトリ

```
auth-server/
├── cmd/authd/              # 組み立てと起動
├── internal/
│   ├── config/             # 環境変数の読み込みと検証
│   ├── httpapi/            # ルーティング、JSON の入出力、Problem Details
│   ├── auth/               # 登録とログインの処理、UserStore インターフェース
│   ├── password/           # Password・EncodedHash の解析と契約、Argon2id、PHC 形式、パスワードポリシー、セマフォ
│   └── store/sqlite/       # UserStore の SQLite 実装と埋め込み用 init.sql
└── docs/
```

## パッケージの責務

| パッケージ | 責務 | 依存してよい先 |
|---|---|---|
| `cmd/authd` | 設定の読み込み、DB 接続、`password.Hasher`・`auth.Service`・`httpapi` の生成、サーバー起動 | すべて |
| `config` | 環境変数の読み込みと検証 | 標準ライブラリのみ |
| `httpapi` | ルーティング、JSON の入出力、ボディ上限、`auth` のエラーからステータスコードへの変換、Problem Details | `auth` |
| `auth` | メールアドレスの検証と正規化、ユーザー ID の生成、登録、ログイン（ダミーハッシュ、エラーの統一、再ハッシュ） | `password`、`github.com/google/uuid` |
| `password` | Password・EncodedHash の解析と契約、Argon2id、PHC 形式、パスワードポリシー、セマフォ | `golang.org/x/crypto`、`golang.org/x/text` |
| `store/sqlite` | 接続プールの所有（`Open`・`Close`）、`auth.UserStore` の実装、`init.sql` の実行、SQLite のエラーから `auth` のエラーへの変換 | `auth`、`modernc.org/sqlite` |

- 依存は表の向きだけにする。`auth` は `httpapi` と `store/sqlite` を import しない
- `httpapi` は `password` と `store/sqlite` を直接使わない。パスワードポリシー違反やセマフォのタイムアウトも、`auth` のエラーとして受け取る
- `UserStore` は使う側の `auth` で定義する（Go の慣習）

## auth パッケージ

### Service

```go
func NewService(store UserStore, hasher *password.Hasher, logger *slog.Logger) (*Service, error)

func (s *Service) Register(ctx context.Context, email, password string) (userID string, err error)
func (s *Service) Login(ctx context.Context, email, password string) (userID string, err error)
```

- ダミーハッシュは `NewService` の中で、ポリシーを満たすランダムな文字列を `password.ParsePassword` で解析し、現行パラメータで Hash して `password.EncodedHash` として保持する。生成に失敗したら起動エラーにする。nil の `Hasher` も起動エラーにする
- Register と Login の入口で `password.ParsePassword` を 1 回呼び、内側では `password.Password` を使う。解析失敗は Register で `ErrWeakPassword`、Login で `ErrInvalidCredentials` にする。Login の解析失敗ではユーザー検索や暗号計算を行わない。Hash の最小長違反も Register では `ErrWeakPassword` に変換する
- ストアから取得した PHC は `password.ParseEncodedHash` で 1 回解析し、Verify と NeedsRehash に同じ `password.EncodedHash` を渡す。再ハッシュでは解析済みの Password を `Rehash` に渡す（最小長を検査しないため、短い既存パスワードも移行できる）
- 登録・再ハッシュの保存時は `EncodedHash.PHC()` を明示的に呼ぶ。UserStore と入出力用構造体の文字列は維持し、httpapi は password を直接使わない
- `Login` で再ハッシュの保存に失敗しても、警告ログを出して成功として返す
- 予期しない返却エラーは通常 httpapi でログに出す。再ハッシュ失敗と保存済み PHC 異常は auth で記録し、httpapi は成功・通常の認証失敗として重複記録しない

### UserStore

```go
type UserStore interface {
    CreateUser(ctx context.Context, u NewUser) error
    FindCredentialByEmail(ctx context.Context, emailNormalized string) (Credential, error)
    UpdatePasswordHash(ctx context.Context, userID, passwordHash string) error
}

type NewUser struct {
    ID              string
    Email           string
    EmailNormalized string
    PasswordHash    string
}

type Credential struct {
    UserID       string
    PasswordHash string
}
```

- `CreateUser` は `users` と `password_credentials` を 1 トランザクションで挿入する。正規化済みメールアドレスの重複時だけ `ErrEmailTaken` を返す
- `FindCredentialByEmail` はユーザーが存在しなければ `ErrUserNotFound` を返す
- `UpdatePasswordHash` はハッシュと UTC の変更時刻を同時に更新し、対象の資格情報が存在しなければ `ErrUserNotFound` を返す

### エラー

`auth` のエラーと、`httpapi` で変換するステータスコードの対応。

| エラー | 発生する場面 | ステータス |
|---|---|---|
| `ErrInvalidEmail` | 登録時のメールアドレス形式不正 | 422 |
| `ErrWeakPassword` | 登録時のパスワードポリシー違反 | 422 |
| `ErrEmailTaken` | 登録時のメールアドレス重複 | 409 |
| `ErrInvalidCredentials` | ログイン失敗（原因を区別しない） | 401 |
| `ErrBusy` | ハッシュのセマフォ待機の打ち切り、または DB の書き込みロック待機の打ち切り。`password.ErrBusy` は `auth` が、`SQLITE_BUSY` は `store/sqlite` が `auth` の `ErrBusy` へ変換し、`ctx.Err()` は包んだまま残す | 503 |
| `ErrUserNotFound` | `UserStore` の検索・ハッシュ更新で対象がない場合に返す。`Login` の検索では `ErrInvalidCredentials` に変換し、再ハッシュ保存では警告して成功を返す | — |
| `password.ErrInvalidHash` | 保存済みハッシュが壊れているときに `ParseEncodedHash` が返す。`Login` の中でダミーハッシュの Verify を実行して応答時間を揃え、エラーログを出して `ErrInvalidCredentials` に変換する | — |
| `password.ErrInvalidParams`・`password.ErrInvalidPassword` | 組み立てやゼロ値の誤用というプログラムの誤り。`auth` は利用者向けのエラーに変換せず、文脈を付けて包んで返す。`httpapi` は予期しないエラーとして 500 にし、ログに出す | 500 |

## store/sqlite パッケージ

```go
func Open(ctx context.Context, path string) (*Store, error)
func (s *Store) Close() error
```

- `Store` は `auth.UserStore` を実装し、接続プールを所有する。`Open` で接続確認、WAL の確認、同じパッケージの `init.sql` を埋め込んだスキーマの初期化を行う。失敗時は接続プールを閉じ、成功時は呼び出し元が `Close` する。nil やゼロ値の `Store` は扱わない
- パスの扱いと接続設定は design.md 5.3 に従う
- 保存層は受け取った文字列をそのまま保存・検索し、メールアドレスの正規化や PHC の解析を行わない。`SQLITE_BUSY` は `auth.ErrBusy` へ変換し、失敗時に `ctx` が終了していれば `ctx.Err()` も包む（design.md 5.4）。予期しないエラーは文脈を付けて返し、ログは出さない

## テスト

| 対象 | 方法 |
|---|---|
| `password` | 単体テスト。値の解析・ゼロ値・伏字と、型付き Hash・Verify・NeedsRehash を検証する。ベンチマークは Password の解析を計測外に置き、既定のパラメータ（`BenchmarkHash`、`BenchmarkHashSaturated`）と性能調整の候補（`BenchmarkHashCandidates`）で計測する。それ以外は小さいパラメータで実行する。測定結果と API ごとの測定範囲は design.md に記録する |
| `auth` | メモリ上の偽 `UserStore` と、小さいパラメータの本物の `password.Hasher` で実行する。ダミーハッシュの経路、再ハッシュ、再ハッシュの保存失敗、エラーの統一をここで検証する |
| `store/sqlite` | `t.TempDir()` に SQLite ファイルを作り、毎回まっさらな DB で実行する |
| `httpapi` | `httptest` と、本物の `auth.Service`（偽 `UserStore`）で実行する。ステータスコードと Problem Details の形を検証する |
