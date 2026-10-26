# アーキテクチャ

レイヤードアーキテクチャ、依存関係の注入（DI）、Provider 分離を定める。機能の仕様は [design.md](design.md)、採用技術は [tech-stack.md](tech-stack.md)、型と実装の規則は [typescript-coding-guidelines.md](typescript-coding-guidelines.md) を参照。

## 現状と移行先

この文書は移行先全体の設計を定める。移行の基点は PR #17 マージ後の `develop` のコミット `195aeeed3524123131f991842f2eb83452a17ab3`（2026-10-25）。手順 2a で `models/`・`errors/`・`config/`、Repository と Provider の interface、各層の依存検査を追加した。値オブジェクトと保存契約は新配置に移し、旧 `src/auth/` と `src/errors.ts` は撤去済みである。ハッシュ計算は手順 2b まで `src/password/` の `Hasher`、SQLite 実装は手順 3 まで `src/store/sqlite/` の `SqliteStore` に残る。認証サービス・HTTP・起動処理は Go の `cmd/authd/` と `internal/` にあり、`package.json` の起動先 `src/main.ts` はまだ存在しない。

実装済み TS の再配置と、残る Go の機能の移植を段階的に行う。Go 実装と Go 用 CI は design.md 10 章の手順 7 まで残す。文書を更新する段階では、実装、設定、スクリプト、静的ファイルを変更しない。各実装段階の順番とブランチは design.md 10 章を正本とする。

## 構成と依存の向き

業務処理の呼び出しは次の向きに統一する。`services` は HTTP・DB・暗号ライブラリを直接呼ばず、Repository と Provider の interface を使う。

```text
routes → controllers → services → repositories の interface
                              └→ providers の interface

index.ts: 設定・具体実装の生成、DI、HTTP 境界の組み立て、起動と終了
middlewares / schemas: HTTP の入力・構造検証・中断・エラー応答
models / errors: 共通の型・値オブジェクト・エラー（上位層に依存しない）
```

Interface の定義は `repositories/` と `providers/` に置く。具体実装もそれぞれの配下に置くが、Service は interface だけを import する。実装クラスの選択と注入は `index.ts` に限定する。DI コンテナ、デコレーター、サービスロケーターは使わない。

## ディレクトリ

```text
auth-server/
├── src/
│   ├── config/
│   │   ├── index.ts
│   │   └── env.ts
│   ├── routes/
│   │   ├── index.ts
│   │   ├── auth-routes.ts
│   │   ├── health-routes.ts
│   │   └── web-routes.ts
│   ├── controllers/
│   │   ├── index.ts
│   │   ├── auth-controller.ts
│   │   ├── health-controller.ts
│   │   └── web-controller.ts
│   ├── middlewares/
│   │   ├── index.ts
│   │   ├── read-json.ts
│   │   ├── validate-request.ts
│   │   ├── request-lifecycle.ts
│   │   ├── security-headers.ts
│   │   └── error-handler.ts
│   ├── schemas/
│   │   ├── index.ts
│   │   ├── credentials-schema.ts
│   │   └── auth-response.ts
│   ├── services/
│   │   ├── index.ts
│   │   └── auth-service.ts
│   ├── repositories/
│   │   ├── index.ts
│   │   ├── user-repository.ts
│   │   └── sqlite/
│   │       ├── index.ts
│   │       ├── sqlite-user-repository.ts
│   │       ├── initialization.ts
│   │       ├── permissions.ts
│   │       ├── errors.ts
│   │       ├── node-sqlite.d.ts
│   │       └── init.sql
│   ├── providers/
│   │   ├── index.ts
│   │   ├── password-provider.ts
│   │   ├── id-provider.ts
│   │   ├── logger-provider.ts
│   │   ├── crypto-id-provider.ts
│   │   ├── json-logger-provider.ts
│   │   └── password/
│   │       ├── index.ts
│   │       ├── argon2-password-provider.ts
│   │       ├── derive.ts
│   │       ├── params.ts
│   │       └── semaphore.ts
│   ├── models/
│   │   ├── index.ts
│   │   ├── user.ts
│   │   ├── credential.ts
│   │   ├── auth.ts
│   │   ├── email.ts
│   │   └── password/
│   │       ├── values.ts
│   │       ├── phc.ts
│   │       └── hash-parameters.ts
│   ├── errors/
│   │   ├── index.ts
│   │   ├── auth-errors.ts
│   │   ├── password-errors.ts
│   │   ├── request-errors.ts
│   │   ├── config-errors.ts
│   │   └── find-error.ts
│   └── index.ts
├── public/
│   ├── index.html
│   ├── app.css
│   └── app.js
└── docs/
```

- 必要な公開 API を各モジュールの `index.ts` から export する。import には `.ts` を付け、型だけの import は `import type` を使う。
- 組み立ての入口 `src/index.ts` と各モジュールの公開口 `index.ts` は同じファイル名であり、`../index.ts` という指定は置き場所によって入口にも公開口にもなる。入口への import の禁止は、指定子のパターンではなく、解決後のパスで判定する。
- `repositories/index.ts`・`providers/index.ts` は Service 向けの interface を公開し、具体実装は `repositories/sqlite/index.ts`・`providers/password/index.ts` などの実装用の公開口から `src/index.ts` が取得する。具体実装の生成関数も Service に公開しない。
- 単一ファイルの実装用公開口である `providers/crypto-id-provider.ts`・`providers/json-logger-provider.ts` は、組み立てを行う `src/index.ts` だけが直接 import できる。
- `models/index.ts` は値オブジェクトと共通型を公開し、秘密値を扱う内部関数は公開しない。Provider 専用の内部 import の例外は下記で定める。
- テストは対象と同じディレクトリの `*.test.ts`、ベンチマークは `*.bench.ts` に置く。
- `public/` は TS のソースと分離した配信資源である。HTTP 移行時に Go の `internal/httpapi/web/` から内容を変えずにコピーし、Go 削除まで両方を保持する。

## 各層の責務と許可する依存

表はプロジェクト内の依存を示す。型専用 import にも同じ制約を適用し、interface と実装を区別する。

依存表と実装用公開口の制約は本番コードを対象にする。テスト・ベンチマークでは、対象モジュール内部の検証や本物の Provider を注入する結合テストに必要な import を、対象ファイルに限定して許可する。テスト用の例外を本番コードから利用したり、Service の実装へ具体クラスの依存を持ち込んだりしない。

| 層 | 責務 | 依存してよい先 |
|---|---|---|
| `config` | 環境変数の検証と `Config` | `errors`、Node 標準 |
| `routes` | メソッド・パスと Controller、Middleware の対応を定義 | `controllers`、`middlewares`、`schemas`、`models`、`errors` |
| `controllers` | HTTP 入力と Service 入力の変換、Service 呼び出し、成功応答 | `services`、`schemas`、`models`、`errors` |
| `middlewares` | 本文上限、JSON 読み込み、構造検証の実行、中断管理、共通ヘッダー、エラー応答 | `schemas`、`models`、`errors`、`LoggerProvider` の型 |
| `schemas` | HTTP の入出力 DTO、`unknown` から DTO への構造検証 | `errors` |
| `services` | 登録・ログイン・再ハッシュの手順と失敗時の方針 | `models`、`errors`、Repository・Provider の interface |
| `repositories` | DB 操作の契約、SQLite 接続・SQL・トランザクション・DB エラー変換 | `models`、`errors` |
| `providers` | 暗号・乱数・ログの契約と具体実装 | `models`、`errors` |
| `models` | ドメインの型、メールとパスワードの値検証・正規化、PHC 形式 | `errors` |
| `errors` | HTTP 非依存のカスタムエラーと `cause` 探索 | Node 標準のみ |
| `index.ts` | 設定、資源の所有、具体実装の生成、DI、サーバー起動・終了 | すべて |

- `node:http`・`node:https`・`node:http2` は `routes`・`controllers`・`middlewares`・`index.ts` に限る。
- `node:sqlite` は `repositories/sqlite` に限る。`index.ts` も Repository の API から接続を開閉し、DB 接続や行型を上位へ漏らさない。
- `node:crypto` は `providers` の具体実装に限る。Service の UUID・ダミーハッシュ用乱数も Provider を経由する。モデルの正規化・PHC 構文解析は暗号計算を行わない。
- Service は `req`・`res`・HTTP ステータス、HTTP DTO、環境変数、SQLite、暗号 API を参照しない。Repository・Provider から Service への逆依存も禁止する。
- Routes は Service や Repository を直接呼ばない。Controller はエラーを HTTP 応答へ変換せず、上位へ伝播させる。
- Middleware は Service や Routes を import しない。`index.ts` がルート解決関数を Middleware の HTTP 境界へ渡して組み立て、循環を避ける。
- `index.ts` は起動時に静的ファイルを読み込んで WebController へ渡す。要求中のファイル読み込み、任意のディレクトリ公開は行わない。

### import の検査

基盤実装段階で `eslint.config.js` の旧 `auth`・`password`・`httpapi`・`store/sqlite` 向け規則を上の表へ更新し、`.github/scripts/eslint-config.test.ts` で検証する。新ディレクトリを追加するだけで依存検査が機能したとは扱わない。Service から具体実装への型 import、実装用公開口へのアクセス、再 export や動的 import による回避も禁止する。

手順 2a で依存規則とそのテストを更新した。`src/auth/store.ts` の interface は `repositories` の `UserRepository`、`NewUser`・`Credential` は `models`、既存の認証エラーと `src/errors.ts` の探索関数は `errors` へ移設済みである。`src/store/sqlite/` とそのテストの import・実装する interface も新しい契約に合わせ、旧 `src/auth/` の定義と公開口を除去した。

移行期間中は旧 `src/password/` と `src/store/sqlite/` に必要な依存だけを暫定的に許可する。手順 2a で値クラスを先に移す際は、値オブジェクト・PHC・パラメータのテストも `models/` の実装の隣へ移し、`hasher.test.ts` の値オブジェクトの検証もこのとき分ける。旧 `src/password/` に残る `hasher.ts` と、そのテスト・ベンチマーク（`Hasher`・セマフォ・鍵導出の検証）にだけモデル内部契約へのアクセスを限定して許可し、手順 2b の Provider 移行完了時にその旧経路と暫定規則を除去する。旧 `src/store/sqlite/` には `repositories` の interface、`models`、`errors` と `node:sqlite` の利用を許可し、手順 3 で SQLite モジュール全体とテストを `repositories/sqlite/` へ移した後に旧経路と暫定規則を除去する。`src/index.ts` を唯一の組み立て経路とする。

## 型と Interface の契約

### Models と DTO

| 型 | 配置・内容 |
|---|---|
| `AuthInput` | `models/auth.ts`。`email: string`、`rawPassword: string` |
| `AuthResult` | `models/auth.ts`。`userId: string` |
| `NewUser` | `models/user.ts`。`id`、`email`、`emailNormalized`、`passwordHash` は文字列 |
| `Credential` | `models/credential.ts`。`userId`、`passwordHash` は文字列 |
| `Password` | `models/password/values.ts`。正規化・最大長検査済みの生パスワード |
| `EncodedHash` | 同上。検証済み PHC。保存時だけ `phc()` で文字列を取り出す |
| `Params`・`Cost` | `models/password/hash-parameters.ts`。設定・PHC のコスト型と純粋な範囲検証 |
| HTTP 入出力 DTO | `schemas/`。要求は `{email, password}`、成功応答は `{user_id}` |

Controller が HTTP の `password` を Service の `rawPassword` へ、Service の `userId` を HTTP の `user_id` へ変換する。Domain・DB の型に HTTP の項目名やステータスを持たせない。DB の `passwordHash` は PHC 文字列であることを名前と保存境界で明示し、既存の文字列契約を維持する。

### UserRepository

`repositories/user-repository.ts` に定義する。旧 `src/auth/store.ts` の `UserStore` を手順 2a で改名・移動し、`NewUser`・`Credential` を Models へ移した。次の契約を維持し、既存の `SqliteStore` の import と実装する interface も同じ段階で更新した。

```ts
interface UserRepository {
  createUser(user: NewUser, signal: AbortSignal): Promise<void>;
  findCredentialByEmail(emailNormalized: string, signal: AbortSignal): Promise<Credential>;
  updatePasswordHash(userId: string, passwordHash: string, signal: AbortSignal): Promise<void>;
}
```

メール重複だけを `EmailTakenError` に変換する。検索・更新の対象なしは `UserNotFoundError`。登録は 2 テーブルを 1 トランザクションで挿入し、ハッシュ更新は UTC の変更時刻も同時に更新する。メール正規化や PHC の解析は Repository で繰り返さない。

### Provider の Interface

| Interface | 定義ファイル | 契約 | 具体実装 |
|---|---|---|---|
| `PasswordProvider` | `providers/password-provider.ts` | `hash(Password, signal)`・`rehash(Password, signal)` は `Promise<EncodedHash>`、`verify(Password, EncodedHash, signal)` は `Promise<boolean>`、`needsRehash(EncodedHash)` は `boolean` | `Argon2PasswordProvider` |
| `IdProvider` | `providers/id-provider.ts` | `newUserId(): string` は UUID v4、`newDummyPassword(): string` はポリシーを満たす暗号学的なランダム文字列 | `CryptoIdProvider` |
| `LoggerProvider` | `providers/logger-provider.ts` | `info`・`warn`・`error` はメッセージと任意の `Record<string, unknown>` 属性を受け取り `void` を返す。属性の `Error` は `name`・`message` と `cause` の連鎖を同じ形で書き、`stack` は書かない。循環参照や `bigint` など JSON にできない値は固定の文字列に置き換え、例外を投げない | `JsonLoggerProvider` |

Interface は利用するメソッドだけに絞る。JWT・Cookie・リフレッシュトークン・認証状態の維持はスコープ外であり、将来用の Provider や認証 Middleware は先に作らない。

## Password Model と Provider の分離

`Password.parse` と `EncodedHash.parse`、伏字、PHC 構文解析は Models、非同期 Argon2id・ソルト生成・定数時間比較・セマフォは Provider に置く。`Argon2PasswordProvider.create(params)` が検証済み設定のコピーとセマフォを保持し、公開コンストラクタは設けない。`defaultParams()` は Provider の `params.ts` で現行の採用値を返す。詳細は design.md 4 章に従う。

既存の `hasher.ts` は同一モジュール内の関数で `Password`・`EncodedHash` の `#secret` を共有するため、クラスだけを別ファイルへ動かさない。値の読み取り・生成に必要な内部関数を `models/password/values.ts` 内にまとめ、具体的な `providers/password/argon2-password-provider.ts` だけに内部 import を許可する。Provider が使う PHC の内部（解析済みのコスト・ソルト・鍵の読み取り、正規の PHC 文字列の生成、保存済みの表記が正規かの判定）も `values.ts` の内部関数として提供し、Provider は `models/password/phc.ts` を直接 import しない。例外の対象は `values.ts` の 1 ファイルだけとし、ESLint とそのテストで固定する。

内部関数を Models の公開口から再 export しない。Controller・Service・Repository・他の Provider に生パスワードや可変 Buffer を公開せず、一般向け getter も追加しない。`models` から `providers` を import する逆依存は作らない。`#private`、非公開コンストラクタ、`toString`・`toJSON`・`util.inspect.custom` の `[REDACTED]` を維持する。生成済みハッシュも内部生成契約から `EncodedHash` にし、再解析しない。

`hash` だけ最小長を検査し、`verify`・`rehash` は短い既存パスワードや空文字を扱える。検証には保存済み PHC のコストを使う。セマフォは全メソッドで共有し、Argon2id 開始後は中断しても計算完了まで枠を保持する。待機打ち切りは `PasswordBusyError`（旧 `password.BusyError`）とし、`signal.reason` を `cause` に保持する。

## AuthService

`AuthService.create(repository, passwordProvider, idProvider, logger, signal)` が各 interface を受け取り、起動時のダミーハッシュを生成して `Promise<AuthService>` を返す。生成に失敗したら起動しない。依存はフィールドに保持し、呼び出しごとの `signal` は保存しない。

`register(input: AuthInput, signal)`・`login(input: AuthInput, signal)` は `Promise<AuthResult>` を返す。順序と失敗時の方針は design.md 6 章に従い、特に次を保持する。

- 入口で `Password.parse` を 1 回呼ぶ。登録の解析失敗・最小長違反は `WeakPasswordError`、ログインの解析失敗は `InvalidCredentialsError`。ログインのパスワード解析失敗では検索・暗号計算を行わない。
- メール解析・正規化は `models/email.ts` を使う。登録では不正形式を拒否し、ログインの不正メールは不在ユーザーと同じダミー検証へ進める。
- ダミー用の値は `IdProvider.newDummyPassword()` から取得し、`Password.parse` と `PasswordProvider.hash` を経て保持する。ユーザー ID は `IdProvider.newUserId()` で生成する。
- 保存済み PHC は `EncodedHash.parse` で 1 回解析し、同じ値を `verify`・`needsRehash` に渡す。保存時は `phc()` を明示する。
- ユーザー不在・不一致・保存済み PHC 異常などは `InvalidCredentialsError` に統一する。保存済み PHC 異常はダミー検証を行い、秘密値を含めず Service で記録する。
- 認証成功後の再ハッシュ生成・保存失敗は警告して成功とする。要求中断を原因とする失敗は警告せず、HTTP 境界で中断規則を優先する。

## HTTP 境界

HTTP フレームワークは使わず、`node:http` 向けの関数として構成する。

- Routes は API・ヘルスチェック・静的ファイルの対応表を持つ。未知パスと非対応メソッドはカスタムエラーにし、エラー本文は Error Middleware だけで生成する。405 の許可メソッドもエラーの情報として渡す。
- `index.ts` は要求ごとに、外側から `security-headers` → `request-lifecycle` → `error-handler` → ルート解決（未知パス・405 を含む）→ `read-json` → `validate-request` → Controller の順に組み立てる。共通ヘッダーと中断管理はルートの一致より外側で行い、404・405・エラー応答にも適用する。`error-handler` は `read-json` を含む内側のすべての失敗を受ける。
- 各 Middleware と Controller は `req`・`res` と、`request-lifecycle.ts` が作る要求の文脈を受け取る。文脈は下位層へ渡す `signal`、切断と応答期限のそれぞれの signal、応答を書けるかの判定を持つ。
- `read-json.ts` は Content-Length と実際に読んだバイト数を確認し、16 KiB を超えたら拒否する。JSON の解析結果は `unknown` として扱い、読み込み失敗と JSON 不正を区別する。JSON の解析エラーは本文の一部を含みうるため、`BadRequestError` の `cause` に入れない。
- `credentials-schema.ts` はオブジェクト・必須の文字列項目・未知項目の有無だけを検証する。Content-Type の必須化、空文字の拒否、メール形式、パスワード最小長の検査は追加しない。
- `validate-request.ts` が Schema を実行し、型が確定した DTO を Controller へ渡す。Controller に入力形式の検査や業務ロジックを重複させない。
- `request-lifecycle.ts` は要求ごとに切断と 30 秒の応答期限をまとめた `AbortSignal` を作り、Controller を通して下位層へ渡す。クライアントの切断は `res` の `close` で `res.writableFinished` が `false` の場合に判定する。`req` の `close` は本文を読み終えた時点でも発火するため、切断の判定に使わない。応答期限は design.md 6.6 に従い、`setTimeout` で中断する `AbortController` から作る。タイマー・イベント購読を後始末する。
- Controller の成功応答と `error-handler` のエラー応答は、文脈の判定で応答を書けることを確かめてから書く。切断済みなら応答を書かず、応答期限を超えていれば接続を破棄する。この判定は文脈の signal の状態で行い、エラーの `cause` の連鎖には依存しない。
- `security-headers.ts` は成功・失敗を含む共通ヘッダーを担当する。HEAD・CSP・静的ファイルの Content-Type は design.md 6.8 に従う。
- `WebController` は起動時に注入された 3 ファイルを返す。`HealthController` は DB を参照しない。

### エラーの一元化

カスタムエラーは `errors/` に集約し、HTTP ステータスを保持させない。`findError` は既存の循環検出を維持する。Repository は DB エラー、Service は Provider・Model のエラーを契約に合わせて変換する。HTTP 境界は SQLite のコードや暗号の例外を直接判定しない。

| エラー・状況 | Error Middleware の扱い |
|---|---|
| `BadRequestError` | 400。本文読み込み失敗と入力不正は固定の detail で区別 |
| `InvalidCredentialsError` | 401。原因を公開しない |
| `NotFoundError`・`MethodNotAllowedError` | 404・405。405 は `Allow` も設定 |
| `EmailTakenError` | 409 |
| `PayloadTooLargeError` | 413 |
| `InvalidEmailError`・`WeakPasswordError` | 422 |
| `BusyError` | 要求が有効で応答を書ける場合だけ 503 |
| 予期しないエラー | 500。内部原因を応答へ含めず、1 回だけ記録 |

`PasswordBusyError` は Service が業務用の `BusyError` へ、`SQLITE_BUSY` は Repository が `BusyError` へ変換する。`UserNotFoundError` は Service が検索・再ハッシュ保存の文脈で処理する。`InvalidHashError` はダミー検証と記録の後に認証失敗へ変換する。組み立ての誤りである `InvalidParamsError` は入力エラーへ変換しない。

`cause` は元の原因を保持するために使い、上位で変換したエラーの意味を優先する。例えば `InvalidCredentialsError` の内側の `InvalidHashError` を HTTP 境界で再分類しない。切断時は応答を書かず、応答期限時は接続を破棄する。この判定はエラーの包み方を問わず、ステータス変換・成功応答・ログ記録より優先する。

エラー本文は RFC 9457 の `application/problem+json` とし、design.md 6.1 に従う。Node がハンドラへ渡す前に返す 400・408 は既存の例外として残る。再ハッシュ失敗と保存済み PHC 異常は Service で記録する例外であり、Middleware で重複記録しない。パスワード・ハッシュ・リクエスト本文はログに含めない。

## Config・Repository・起動処理

`config/env.ts` の `loadConfig(env: NodeJS.ProcessEnv): Config` は `databasePath: string` と `port: number` を返す。環境変数、絶対パス化、`/mnt/c` とリンク解決後の検査は design.md 6.5 に従う。不正な値は `errors/` の設定エラーとして投げる。`databasePath` は絶対パス化しただけのパスで返し、リンク解決の結果は `/mnt/c` の検査だけに使う。Repository の検査（design.md 5.3）がシンボリックリンクを拒否できるよう、渡すパスのリンクを解決しない。Config はファイルやディレクトリを作らず、Repository の所有者・権限検査を重複しない。

`SqliteUserRepository.open(path, signal)` は接続を 1 つだけ所有する具体実装を返す（`Promise`）。`open`・`close` は組み立て用の API で、Service 向けの `UserRepository` には含めない。接続確認・WAL・`init.sql` 初期化の失敗時は接続を閉じる。権限検査、新規 DB の `0o600`、WAL 切り替えだけの再試行、`BEGIN IMMEDIATE`、SQLite エラーの `code` と数値 `errcode` による変換は design.md 5 章を維持する。

手順 3 では実装済みの `src/store/sqlite/store.ts` の `SqliteStore` を `SqliteUserRepository` へ改名・再配置する。初期化・権限検査・DB エラー変換・スキーマ・公開口・型補助宣言と既存テストをモジュール全体で移し、接続の所有と SQL の振る舞いを維持する。`@types/node` 26.6.5 にない `Database` の型だけを補う `node-sqlite.d.ts` は、型定義が改名に対応するまで保持する。実行時は `Database` を直接使う。

SQLite のメソッドは同期 API を使うが、interface は `Promise` を返し、同期例外を外へ投げない。Service へ接続・行型・トランザクション操作を公開しない。予期しない DB エラーは文脈と `cause` を付けて投げ、Repository ではログを出さない。

`index.ts` は次の順に組み立てる。

1. Logger と Config を生成する。
2. SQLite Repository を開き、Password・ID Provider を生成する。Password Provider はプロセス内で共用する。
3. `AuthService.create` へ各 interface を注入し、ダミーハッシュの初期化を完了する。
4. `public/` の 3 ファイルを読み込み、Controller・Routes・Middleware を組み立てる。
5. `http.Server` を生成し、design.md 6.5・6.6 の待ち受け・タイムアウト・終了処理を設定して起動する。

初期化失敗時は起動せず、開いた DB を閉じる。SIGINT・SIGTERM と起動後の終了でも DB を解放する。DB や Logger をグローバル変数へ置かない。

## ファイル移行マッピング

「Go」からの移植と「TS」の再配置を区別する。Go 実装の削除は最後に行う。

| 既存 | 移行先・分割内容 |
|---|---|
| TS `src/errors.ts` とテスト | `errors/find-error.ts` とテスト |
| TS `src/password/hasher.ts` の値クラス | `models/password/values.ts` |
| 同ファイルの `Hasher` | `providers/password/argon2-password-provider.ts` |
| TS `src/password/phc.ts` | `models/password/phc.ts` |
| TS `src/password/params.ts` | 型・範囲検証は `models/password/hash-parameters.ts`、既定値は `providers/password/params.ts` |
| TS `src/password/derive.ts`・`semaphore.ts` | `providers/password/` |
| TS `src/password/errors.ts` | `errors/password-errors.ts`。`BusyError` は `PasswordBusyError` へ改名 |
| TS `src/password/index.ts` | Models・Providers・Errors の公開口へ分割 |
| TS password テスト・ベンチマーク | 対応する実装の隣へ移す。値オブジェクト・PHC・パラメータのテストは手順 2a で `models/` へ、`Hasher`・セマフォ・鍵導出のテストとベンチマークは手順 2b で `providers/password/` へ移す。ベンチマークは `providers/password/password.bench.ts` |
| TS `src/auth/store.ts` | 手順 2a：`UserStore` を `repositories/user-repository.ts` の `UserRepository` へ改名し、`NewUser`・`Credential` を `models/user.ts`・`credential.ts` へ移す |
| TS `src/auth/errors.ts`・`index.ts` | 手順 2a：既存の認証エラーを `errors/auth-errors.ts` へ移し、Models・Repositories・Errors の公開口へ分割。旧定義と公開口を除去する |
| Go `internal/auth/service.go` | 手順 4a：`services/auth-service.ts`。メール解析は `models/email.ts`、入出力型は `models/auth.ts`、UUID・乱数・ログ・暗号は Provider へ分割 |
| Go `internal/auth/errors.go` | 手順 4a：未移植の認証エラーを `errors/auth-errors.ts` に追加。TS に存在する `EmailTakenError`・`UserNotFoundError`・`BusyError` は再利用する |
| Go `internal/httpapi/handler.go` | 手順 4b：Routes、Controllers、本文・検証・エラー応答の Middlewares、DTO の Schemas へ分割。要求のエラーは `errors/request-errors.ts` に追加 |
| Go `internal/httpapi/static.go` | Web の Route・Controller と `index.ts` の起動時読み込み |
| Go `internal/httpapi/web/*` | `public/*` へコピー |
| TS `src/store/sqlite/store.ts` | 手順 3：`repositories/sqlite/sqlite-user-repository.ts` へ移し、`SqliteStore` を `SqliteUserRepository` へ改名 |
| TS `src/store/sqlite/initialization.ts`・`permissions.ts`・`errors.ts`・`init.sql`・`index.ts` | 手順 3：`repositories/sqlite/` の対応ファイルへ移す |
| TS `src/store/sqlite/node-sqlite.d.ts` | 手順 3：`repositories/sqlite/node-sqlite.d.ts` へ移す。`@types/node` が `Database` に対応したら削除する型専用の補助宣言 |
| TS `src/store/sqlite/*.test.ts` | 手順 2a で契約と import を更新し、手順 3 で実装の隣へ移す。既存の検証内容を維持する |
| Go `internal/config/config.go` | `config/env.ts`。設定エラーは `errors/config-errors.ts` |
| Go `cmd/authd/main.go` | `src/index.ts` |

実装時に start を `node src/index.ts`、bench を `vitest bench --run src/providers/password` へ変更する。ESLint の依存規則とテスト、Vitest・ESLint・Prettier の静的ファイルの除外経路、関連文書も対象段階でそろえる。今回の文書更新では設定ファイルを変更しない。

## テスト

| 対象 | 方法 |
|---|---|
| Models・Errors | パスワード・PHC・メールの検証、伏字、`cause` の循環検出 |
| Password Provider | 本物の Argon2id を低コストで使用。Go 生成 PHC の互換性、再ハッシュ、共有枠の保持・解放・中断・待機期限を維持 |
| AuthService | 手書きの偽 Repository・Provider で手順・エラー変換を検証。`Password`・`EncodedHash` は `#` フィールドだけを持ち偽物から中身を読めず、`toEqual` では別の値も等しくなる。偽 `PasswordProvider` は受け取った値を記録して決めた結果を返し、渡した値は `toBe`（参照の同一性）、`EncodedHash` は `phc()` で比べる。正規化・PHC・再ハッシュの連携は、本物の低コスト Password Provider を注入するテストで検証する。本物の Provider を import できるのは `services/auth-service.test.ts` と `services/auth-service.integration.test.ts` だけとする |
| SQLite Repository | 既存の TS 保存層テストを移行先へ移し、一時ディレクトリの実 DB でトランザクション・重複・対象なし・権限・BUSY の検証を維持。対象 Node の `errcode` の形も固定 |
| Schemas | `unknown` からの構造検証。空文字を意味検査の前に拒否しない |
| HTTP 境界 | ポート 0 の実 `http.Server` と `fetch` でステータス・ヘッダー・本文・Problem Details・HEAD・静的配信・404/405 を確認 |
| 要求のライフサイクル | 切断・応答期限時は応答なし、待機切れは要求継続可能なら 503、再ハッシュ失敗は要求継続可能なら成功、と区別。応答期限は Vitest の偽タイマーで進める。本文を読み終えた後も切断と判定しないことを確かめる |
| Config・Logger | 環境変数を引数で渡し、メモリ上の出力先で検証 |
| 依存規則 | 禁止 import、具体実装へのアクセス、モデル内部 API の例外範囲、動的 import などの回避を検証 |

JSON キー大小文字、孤立サロゲート、保存済み PHC のソルト長下限など、TS 移行仕様が Go と異なる項目は design.md を優先する。Go のテストをそのまま移すことで TS 仕様を戻さない。登録・ログインの応答、ダミー検証、再ハッシュ失敗時の成功、秘密値の非公開は維持する。

各実装段階で型検査・Lint・整形確認・テスト・カバレッジを確認する。ベンチマークは Provider 移行段階で既存の測定範囲を維持して確認し、性能や既定値を変える場合だけ design.md の手順で再測定する。Windows のブラウザーからの実接続確認は design.md 10 章の手順 5 で行う。
