# アーキテクチャ

モジュールの分け方、責務、依存の向きをまとめる。機能の仕様は [design.md](design.md)、採用技術は [tech-stack.md](tech-stack.md) を参照。

この文書は TypeScript 実装の構成を定める。移行の完了（design.md 10 章の手順 7）までは、Go 実装（`cmd/authd`、`internal/` 配下の同名パッケージ）が同じ責務と依存の向きで並存する。

## 構成（軽量な Clean Architecture）

HTTP の処理、認証の処理、永続化を分け、依存を内側の auth と password へ向ける。モジュールは層名ではなく責務ごとに `src/` 配下のディレクトリへ分ける。

```
main.ts ── 組み立て（設定の読み込み、DB 接続、依存の注入、サーバー起動）
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
├── src/
│   ├── main.ts              # 組み立てと起動
│   ├── errors.ts            # cause をたどってエラーを判定する補助関数
│   ├── log/                 # JSON ロガー
│   ├── config/              # 環境変数の読み込みと検証
│   ├── httpapi/             # ルーティング、JSON の入出力、Problem Details
│   │   └── web/            # 配信する HTML・CSS・JavaScript
│   ├── auth/                # 登録とログインの処理、UserStore インターフェース
│   ├── password/            # Password・EncodedHash の解析と契約、Argon2id、PHC 形式、パスワードポリシー、セマフォ
│   └── store/sqlite/        # UserStore の SQLite 実装と init.sql
└── docs/
```

- 各ディレクトリは `index.ts` で公開する名前だけを export する。他のモジュールからは `index.ts` だけを import し、内部のファイルを直接 import しない
- import には `.ts` の拡張子を書く。型だけの import には `import type` を使う

## モジュールの責務

| モジュール | 責務 | 依存してよい先 |
|---|---|---|
| `main.ts` | 設定の読み込み、DB 接続、`Hasher`・`AuthService`・ハンドラ・`http.Server` の生成、サーバー起動と終了処理 | すべて |
| `errors.ts` | `cause` をたどって特定のエラークラスを探す補助関数 | Node 標準のみ |
| `log` | 1 行 1 件の JSON ロガー | Node 標準のみ |
| `config` | 環境変数の読み込みと検証 | Node 標準のみ |
| `httpapi` | ルーティング、JSON の入出力、ボディ上限、要求ごとの `signal`、`auth` のエラーからステータスコードへの変換、Problem Details、Web 画面の配信 | `auth`、`log`、`errors.ts` |
| `auth` | メールアドレスの検証と正規化、ユーザー ID の生成、登録、ログイン（ダミーハッシュ、エラーの統一、再ハッシュ） | `password`、`log`、`errors.ts` |
| `password` | Password・EncodedHash の解析と契約、Argon2id、PHC 形式、パスワードポリシー、セマフォ | `errors.ts` |
| `store/sqlite` | 接続の所有（`open`・`close`）、`UserStore` の実装、`init.sql` の実行、SQLite のエラーから `auth` のエラーへの変換 | `auth`、`errors.ts` |

- 「依存してよい先」の表はプロジェクト内のモジュールへの依存を示す。Node の標準モジュール（`node:*`）は、どのモジュールから使ってもよい。ただし `node:http` は `httpapi` と `main.ts` だけ、`node:sqlite` は `store/sqlite` だけが使う。「Node 標準のみ」は、プロジェクト内のどのモジュールにも依存しないことを表す
- 依存は表の向きだけにする。`auth` は `httpapi` と `store/sqlite` を import しない
- `httpapi` は `password` と `store/sqlite` を直接使わない。パスワードポリシー違反やセマフォのタイムアウトも、`auth` のエラーとして受け取る
- `UserStore` は使う側の `auth` で定義する
- 表にない依存と、他のモジュールの `index.ts` 以外のファイルの import は、ESLint の `no-restricted-imports` でモジュールごとに禁止する（`eslint.config.js`）

## auth モジュール

### AuthService

```ts
class AuthService {
  static create(store: UserStore, hasher: Hasher, logger: Logger, signal: AbortSignal): Promise<AuthService>;

  register(email: string, password: string, signal: AbortSignal): Promise<string>;
  login(email: string, password: string, signal: AbortSignal): Promise<string>;
}
```

- `register` と `login` は成功時にユーザー ID を返し、失敗時は下の「エラー」の表のエラーを投げる
- ダミーハッシュは `create` の中で、ポリシーを満たすランダムな文字列を `Password.parse` で解析し、現行パラメータで `hash` して `EncodedHash` として保持する。生成に失敗したら起動エラーにする。コンストラクタは公開せず、生成経路を `create` に限る
- `register` と `login` の入口で `Password.parse` を 1 回呼び、内側では `Password` を使う。解析失敗は `register` で `WeakPasswordError`、`login` で `InvalidCredentialsError` にする。`login` の解析失敗ではユーザー検索や暗号計算を行わない。`hash` の最小長違反も `register` では `WeakPasswordError` に変換する
- ストアから取得した PHC は `EncodedHash.parse` で 1 回解析し、`verify` と `needsRehash` に同じ `EncodedHash` を渡す。再ハッシュでは解析済みの `Password` を `rehash` に渡す（最小長を検査しないため、短い既存パスワードも移行できる）
- 登録・再ハッシュの保存時は `EncodedHash.phc()` を明示的に呼ぶ。`UserStore` と入出力用の型の文字列は維持し、httpapi は password を直接使わない
- `login` で再ハッシュの保存に失敗しても、警告ログを出して成功として返す
- 予期しないエラーは通常 httpapi でログに出す。再ハッシュ失敗と保存済み PHC 異常は auth で記録し、httpapi は成功・通常の認証失敗として重複記録しない

### UserStore

```ts
interface UserStore {
  createUser(user: NewUser, signal: AbortSignal): Promise<void>;
  findCredentialByEmail(emailNormalized: string, signal: AbortSignal): Promise<Credential>;
  updatePasswordHash(userId: string, passwordHash: string, signal: AbortSignal): Promise<void>;
}

type NewUser = {
  id: string;
  email: string;
  emailNormalized: string;
  passwordHash: string;
};

type Credential = {
  userId: string;
  passwordHash: string;
};
```

- SQLite の実装は同期で処理するが、偽 `UserStore` と同じ契約にするため `Promise` を返す
- `createUser` は `users` と `password_credentials` を 1 トランザクションで挿入する。正規化済みメールアドレスの重複時だけ `EmailTakenError` を投げる
- `findCredentialByEmail` はユーザーが存在しなければ `UserNotFoundError` を投げる
- `updatePasswordHash` はハッシュと UTC の変更時刻を同時に更新し、対象の資格情報が存在しなければ `UserNotFoundError` を投げる

### エラー

`auth` のエラーと、`httpapi` で変換するステータスコードの対応。エラーはすべて `Error` を継承したクラスで、下の層のエラーを包むときは `cause` に入れる。判定は `errors.ts` の補助関数で `cause` をたどって行う。

| エラー | 発生する場面 | ステータス |
|---|---|---|
| `InvalidEmailError` | 登録時のメールアドレス形式不正 | 422 |
| `WeakPasswordError` | 登録時のパスワードポリシー違反 | 422 |
| `EmailTakenError` | 登録時のメールアドレス重複 | 409 |
| `InvalidCredentialsError` | ログイン失敗（原因を区別しない） | 401 |
| `BusyError` | ハッシュのセマフォ待機の打ち切り、または DB の書き込みロック待機の打ち切り。password の `BusyError` は `auth` が、`SQLITE_BUSY` は `store/sqlite` が `auth` の `BusyError` へ変換し、`signal.reason` は `cause` に残す。httpapi まで伝播し、要求が中断されておらず応答を書ける場合は 503。要求の `signal` の中断は、このエラーに包まれているかを問わずログに出さず、design.md 6.6 の応答規則を優先する | 503（要求中断時を除く） |
| `UserNotFoundError` | `UserStore` の検索・ハッシュ更新で対象がない場合に投げる。`login` の検索では `InvalidCredentialsError` に変換し、再ハッシュ保存では警告して成功を返す | — |
| password の `InvalidHashError` | 保存済みハッシュが壊れているときに `EncodedHash.parse` が投げる。`login` の中でダミーハッシュの `verify` を実行して応答時間を揃え、エラーログを出して `InvalidCredentialsError` に変換する | — |
| password の `InvalidParamsError` | 組み立ての誤りというプログラムの誤り。`auth` は利用者向けのエラーに変換せず、文脈を付けて包んで投げる。`httpapi` は予期しないエラーとして 500 にし、ログに出す | 500 |

## httpapi モジュール

```ts
function createHandler(service: AuthService, logger: Logger): Promise<http.RequestListener>;
```

- メソッドとパスの対応表で API と Web 画面のルート、404・405 を処理する。有効な `AuthService` と `Logger` を渡して生成する
- 入力・応答・エラー形式は design.md 6.1 に従う。入力検証は HTTP の形式に限り、メール・パスワードの意味的な検証は auth に任せる
- 要求ごとに、応答の期限（30 秒）とクライアントの切断をまとめた `signal` を作り、auth に渡す。クライアント切断時は応答を書かず、応答期限超過時は応答を書かずに接続を破棄する。これらは成功応答やエラーのステータスコードへの変換より優先する（design.md 6.6）
- httpapi は password や SQLite を直接参照しない
- `web/index.html`・`web/app.css`・`web/app.js` を `createHandler` の中でメモリへ読み込み、design.md 6.8 に従って明示したパスだけに配信する。Web 画面も既存 API を呼び、認証処理を重複実装しない

## config モジュール

```ts
type Config = {
  databasePath: string;
  port: number;
};

function loadConfig(env: NodeJS.ProcessEnv): Config;
```

- 環境変数を受け取り、design.md 6.5 に従って検証する。不正な値は起動エラーとして投げる。`databasePath` は絶対パスで返す。リンク解決は /mnt/c の検査に使い、保存層に渡すパス自体のリンクは隠さない
- config はファイル・ディレクトリを作成せず、保存層の権限検査を繰り返さない

## log モジュール

```ts
interface Logger {
  info(msg: string, attrs?: Record<string, unknown>): void;
  warn(msg: string, attrs?: Record<string, unknown>): void;
  error(msg: string, attrs?: Record<string, unknown>): void;
}

function createLogger(stream: NodeJS.WritableStream): Logger;
```

- 1 件を 1 行の JSON（`time`・`level`・`msg` と属性）として書く
- パスワード・ハッシュ・リクエストボディを属性に渡さない。`Password`・`EncodedHash` を誤って渡しても、`toJSON` により `[REDACTED]` と出る

## main.ts

- JSON ロガー、config、SQLite、既定の `Hasher`、`AuthService`、ハンドラ、`http.Server` を組み立てる
- 設定・DB・認証の初期化に失敗したらサーバーを起動しない。DB の所有者として起動失敗時と終了時に `close` する
- サーバーのタイムアウトと終了処理は design.md 6.5・6.6 に従う

## store/sqlite モジュール

```ts
class SqliteStore implements UserStore {
  static open(path: string, signal: AbortSignal): Promise<SqliteStore>;
  close(): void;
}
```

- `SqliteStore` は `UserStore` を実装し、接続を 1 つだけ所有する。`open` で接続確認、WAL の確認、`init.sql` によるスキーマの初期化を行う。失敗時は接続を閉じ、成功時は呼び出し元が `close` する。コンストラクタは公開せず、`open` が返した値だけを使う
- パスの扱いと接続設定は design.md 5.3 に従う
- 接続前に、親ディレクトリと既存 DB・関連ファイルの所有者・権限・ファイル種別を検査する。新規 DB は `0o600` で用意し、権限の自動修正やプロセス全体の umask 変更はしない
- `open` の WAL 切り替えが `SQLITE_BUSY` の場合だけ、接続を閉じて再試行する。開始期限・待機・中断の契約は design.md 5.3 に従い、通常の読み書きには再試行処理を追加しない
- 保存層は受け取った文字列をそのまま保存・検索し、メールアドレスの正規化や PHC の解析を行わない。`SQLITE_BUSY` は `auth` の `BusyError` へ変換し、失敗時に `signal` が中断されていれば `signal.reason` も `cause` に含める（design.md 5.4）。予期しないエラーは文脈を付けて投げ、ログは出さない

## テスト

テストは Vitest で書き、対象と同じディレクトリの `*.test.ts` に置く。

| 対象 | 方法 |
|---|---|
| `password` | 単体テスト。値の解析・伏字と、`hash`・`verify`・`needsRehash` を検証する。ベンチマーク（`*.bench.ts`）は `Password` の解析を計測外に置き、既定のパラメータ（`hash`、`hash saturated`）と性能調整の候補（`hash candidates`）で計測する。それ以外は小さいパラメータで実行する。測定結果は design.md に記録する |
| `auth` | メモリ上の偽 `UserStore` と、小さいパラメータの本物の `Hasher` で実行する。ダミーハッシュの経路、再ハッシュ、再ハッシュの保存失敗、エラーの統一をここで検証する |
| `store/sqlite` | 一時ディレクトリに SQLite ファイルを作り、毎回まっさらな DB で実行する。UNIQUE 違反・PRIMARY KEY 違反・`SQLITE_BUSY` の判定に使う `errcode` もここで固定する |
| `httpapi` | ポート 0 で起動した `http.Server` へ `fetch` で要求を送り、本物の `AuthService`（偽 `UserStore`）で実行する。API と静的ファイルのステータスコード・ヘッダー・本文、Problem Details の形を検証する。Web の操作は Windows のブラウザーから実接続で確認する |
| `config`・`log` | 環境変数の値を引数で渡し、書き込み先にメモリ上のストリームを使って検証する |
