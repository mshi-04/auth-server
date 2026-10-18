# アーキテクチャ

パッケージの分け方、責務、依存の向きをまとめる。機能の仕様は [design.md](design.md)、採用技術は [tech-stack.md](tech-stack.md) を参照。

## 構成（3 層）

HTTP の処理、認証の処理、永続化を分けた 3 層構成にする。

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
│   ├── password/           # Argon2id、PHC 形式、パスワードポリシー、セマフォ
│   └── store/sqlite/       # UserStore の SQLite 実装
├── db/init.sql
└── docs/
```

## パッケージの責務

| パッケージ | 責務 | 依存してよい先 |
|---|---|---|
| `cmd/authd` | 設定の読み込み、DB 接続、`password.Hasher`・`auth.Service`・`httpapi` の生成、サーバー起動 | すべて |
| `config` | 環境変数の読み込みと検証 | 標準ライブラリのみ |
| `httpapi` | ルーティング、JSON の入出力、ボディ上限、`auth` のエラーからステータスコードへの変換、Problem Details | `auth` |
| `auth` | メールアドレスの検証と正規化、ユーザー ID の生成、登録、ログイン（ダミーハッシュ、エラーの統一、再ハッシュ） | `password`、`github.com/google/uuid` |
| `password` | Argon2id、PHC 形式、パスワードポリシー、セマフォ | `golang.org/x/crypto`、`golang.org/x/text` |
| `store/sqlite` | `auth.UserStore` の実装、`init.sql` の実行、SQLite のエラーから `auth` のエラーへの変換 | `auth`、`modernc.org/sqlite` |

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

- ダミーハッシュは `NewService` の中で、現行パラメータを使って生成する。生成に失敗したら起動エラーにする
- `Login` で再ハッシュの保存に失敗しても、警告ログを出して成功として返す

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

- `CreateUser` は `users` と `password_credentials` を 1 トランザクションで挿入する。重複時は `ErrEmailTaken` を返す
- `FindCredentialByEmail` はユーザーが存在しなければ `ErrUserNotFound` を返す

### エラー

`auth` のエラーと、`httpapi` で変換するステータスコードの対応。

| エラー | 発生する場面 | ステータス |
|---|---|---|
| `ErrInvalidEmail` | 登録時のメールアドレス形式不正 | 422 |
| `ErrWeakPassword` | 登録時のパスワードポリシー違反 | 422 |
| `ErrEmailTaken` | 登録時のメールアドレス重複 | 409 |
| `ErrInvalidCredentials` | ログイン失敗（原因を区別しない） | 401 |
| `ErrBusy` | ハッシュのセマフォ待機タイムアウト | 503 |
| `ErrUserNotFound` | `UserStore` が返す。`Login` の中で `ErrInvalidCredentials` に変換し、外へは出さない | — |
| `password.ErrInvalidHash` | 保存済みハッシュが壊れているときに `Verify` が返す。`Login` の中でダミーハッシュの Verify を実行して応答時間を揃え、エラーログを出して `ErrInvalidCredentials` に変換する | — |

## テスト

| 対象 | 方法 |
|---|---|
| `password` | 単体テスト。ベンチマークは既定のパラメータ（`BenchmarkHash`、`BenchmarkHashSaturated`）と性能調整の候補（`BenchmarkHashCandidates`）で計測し、それ以外は小さいパラメータで実行する。初期値と性能調整後の測定結果は design.md に記録する |
| `auth` | メモリ上の偽 `UserStore` と、小さいパラメータの本物の `password.Hasher` で実行する。ダミーハッシュの経路、再ハッシュ、再ハッシュの保存失敗、エラーの統一をここで検証する |
| `store/sqlite` | `t.TempDir()` に SQLite ファイルを作り、毎回まっさらな DB で実行する |
| `httpapi` | `httptest` と、本物の `auth.Service`（偽 `UserStore`）で実行する。ステータスコードと Problem Details の形を検証する |
