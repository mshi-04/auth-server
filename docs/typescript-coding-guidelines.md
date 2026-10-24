# TypeScript のコーディング方針

このリポジトリ（TypeScript 製の学習用認証 API）でコードを書くときの方針。
仕様は [design.md](design.md)、モジュール構成・責務・依存の向き・テスト方法は [architecture.md](architecture.md) を正本とし、この方針と食い違う場合はそちらを優先する。

移行中の Go 実装は、移行の完了（design.md 10 章の手順 7）で削除するまで機能を追加しない。

以下はレイヤードアーキテクチャへの移行後の方針を定める。現在の TypeScript 実装は `src/errors.ts` と `src/password/` までで、ファイルの移動・各層の実装・ESLint の依存規則の変更は design.md 10 章の後続手順で行う。

## 構成

- `routes` → `controllers` → `services` → `repositories` / `providers` の順に依存するレイヤードアーキテクチャとする。各層の責務と依存の一覧は architecture.md に従う
- HTTP の形式は `controllers`・`middlewares`・`schemas` に閉じ込める。`services` に `req`・`res`、HTTP ステータスコード、`node:http`・`node:sqlite`・`node:crypto` の直接呼び出しを書かない
- `repositories` に `UserRepository`、`providers` に `PasswordProvider`・`IdProvider`・`LoggerProvider` を定義する。サービスはこれらのインターフェースだけに依存し、具体的な実装は `src/index.ts` から注入する
- `repositories/index.ts`・`providers/index.ts` はインターフェースを公開し、実装用の公開口は `src/index.ts` だけが利用する。型 import と再 export にも同じ依存制約を適用する。具体的な公開口と内部 import の例外は architecture.md に従う
- テスト・ベンチマークの対象内部へのアクセスや、本物の Provider を注入する結合テストの import は、architecture.md の検証用の例外に従う。本番コードの依存規則を緩めず、対象のテストファイルに限って許可する
- 「インターフェースを受け取り、具体的なクラスを返す」を基本にする
- インターフェースはサービスが必要とする操作に絞り、DB 接続や暗号ライブラリの型を漏らさない。サービスのテストでは手書きの偽物に置き換え、`Argon2PasswordProvider` のテストと結合テストでは本物を小さいパラメータで使う
- 状態や依存を持つものはクラスにし、生成経路を static メソッド（`create`、`open`、`parse`）に限る。状態を持たない処理は関数にする
- ドメインモデル、値オブジェクト、サービスの入出力型は `models` に置く。`AuthInput` は `{ email, rawPassword }`、`AuthResult` は `{ userId }` とし、HTTP の項目名をサービスへ持ち込まない
- HTTP の入力 DTO `{ email, password }` と出力 DTO `{ user_id }`、入力の解析関数は `schemas` に置き、コントローラーでサービスの入出力型と変換する。ユースケースごとのポートや Presenter は追加しない
- バリデーションは `unknown` を受ける小さい手書きの解析関数とし、`middlewares` で実行する。HTTP の型検査と、サービスが行うメール・パスワードの意味的な検証を混ぜない。ログインの短い既存パスワードを入力形式で拒否しない

## 型

- `tsconfig.json` の `strict`・`noUncheckedIndexedAccess`・`exactOptionalPropertyTypes` を有効にする
- `any`、型アサーション（`as`。`as const` も含む）、非 null アサーション（`!`）を使わない。外から来た値は `unknown` で受け取り、検査して型を絞る。型を合わせたいときは、型注釈か `satisfies` を使う。ESLint の `no-explicit-any`・`no-unsafe-*`・`consistent-type-assertions`（`assertionStyle: 'never'`）・`no-non-null-assertion`・`no-restricted-syntax` で検査する
- 添字アクセス（`parts[3]`、`record[key]`）の結果は `undefined` を含む。分割した文字列の要素数などは、使う前に検査して弾く
- Node の型除去が扱えない構文（`enum`、実行時コードを持つ `namespace`、パラメータプロパティ、デコレーター）を使わない。デコレーターは ESLint の `no-restricted-syntax`、それ以外は `erasableSyntaxOnly` で検査する
- 列挙は文字列リテラルの union 型で表す。union 型を `switch` で分岐するときはすべての値を `case` で扱う。ESLint の `switch-exhaustiveness-check` で検査する
- import の書き方（`index.ts` 経由、`.ts` の拡張子、`import type`）は architecture.md の「ディレクトリ」に従う
- `null` と `undefined` を混ぜない。値が無いことは `undefined` で表し、省略可能な項目は `?` で表す。`?` の項目に `undefined` を代入せず、項目ごと省く
- `null` を返す外部の値（`node:sqlite` が返す SQL の NULL、`JSON.parse` が返す JSON の null）は、境界の層（`repositories`、`schemas`）で検査して弾くか `undefined` に変換し、内側へ `null` を渡さない

## 関数の書き方

- 不正な入力とエラーは早期リターン（`return`・`throw`）で先に弾き、正常系を左端にまっすぐ書く。`return` や `throw` の後に `else` を書かない
- 非同期処理は `async`・`await` で書く。`then` の連鎖やコールバックは、Node の API が要求する場合（`crypto.argon2`）を `Promise` に包む箇所だけにする
- 契約として `Promise` を返すが中身が同期の処理（`SqliteUserRepository` のメソッド）は、`async` を付けずに書く。`await` の無い `async` 関数は `require-await` に指摘される。同期の処理を `try` で囲み、成功は `Promise.resolve`、失敗は変換したエラーを `Promise.reject` で返す。呼び出し元へ同期的に例外を投げない
- 後始末は `try`・`finally` で書く。トランザクションは `BEGIN IMMEDIATE` の成功を確かめた後に `try` を始め、`COMMIT` まで進まなければ `ROLLBACK` する
- 中断の `signal: AbortSignal` は最後の引数で受け取り、下の層（DB 呼び出し、`hash`、`verify`）までそのまま渡す。クラスのフィールドに保存しない
- 待たない `Promise` を作らない。作った `Promise` は必ず `await` するか、失敗を処理する。条件式に `Promise` を渡さない（`if (passwordProvider.verify(...))` は常に真になる）。ESLint の `no-floating-promises`・`no-misused-promises` で検査する

## 値オブジェクト

- 次のどれかに当てはまる値だけを値オブジェクトにする
  - 守るべき条件がある（検証済み、正規化済み、範囲内など）
  - 同じ基本型の値を取り違えやすい
  - 同じ検証をあちこちで繰り返している
- 値は private フィールド（`#`）に置き、コンストラクタを `private` にして、有効な値の生成経路を検証してから作る static メソッド（`parse`、`create`）に限定する。外から来た値は境界で 1 回だけ解析し、内側では型だけを扱う
- TypeScript の型は構造で比較されるため、同じ形の別の型と取り違えないよう、値オブジェクトは private フィールドを持つクラスにする
- 秘密を持つ値オブジェクトは、`toString`・`toJSON`・`[util.inspect.custom]` で伏字を返す。型ごとの扱いは design.md に定める
- `Password` と `EncodedHash` は `models` に置き、`#` フィールドで生パスワードとハッシュを区別する。変数名も `rawPassword`・`encodedHash` などで区別する。PHC の構文解析、`Cost`、解析済みの値はモデル内部に置き、`models` から `providers` に依存させない
- 暗号計算のための秘密値の読み出しとハッシュ生成は、具体的な `providers/password/argon2-password-provider.ts` に限って使えるモデル内部の契約とする。公開の `models/index.ts` からは export せず、専用の内部 import の例外を依存規則に定める。移行中の旧 `src/password/hasher.ts` の暫定的な許可と撤去時期は architecture.md に従う。一般公開の生パスワード getter や変更可能な `Buffer` の getter は追加しない。保存用の PHC は従来どおり `EncodedHash.phc()` を明示的に呼ぶ
- JSON の入出力用の型、DB の行を受ける型、素通りするだけの値は、値オブジェクトにしない
- `Params` は設定入力の型として公開プロパティを維持し、`Argon2PasswordProvider.create` で検証する。不変の値オブジェクトにはしない
- 値オブジェクトの導入で architecture.md のインターフェース（例：`UserRepository` の引数の型）が変わる場合は、先に architecture.md を更新する

## エラー

- 判定が必要なエラーは `Error` を継承したクラスとして定義し、`name` を設定する。文字列のメッセージで判定しない
- カスタムエラーと `cause` をたどる補助関数は `errors` に置く。エラークラスに HTTP ステータスコードを持たせず、変換は最上位のエラーハンドリング Middleware に集約する
- 下の層のエラーは `new XxxError('何をしていたか', { cause: err })` で包んで投げる。判定は `errors` の補助関数で `cause` をたどって行う
- `catch` した値は `unknown` として扱い、`Error` 以外が投げられた場合も考える
- 各層はエラーを自分の契約に変換する。`repositories` は SQLite のエラーを `EmailTakenError`・`UserNotFoundError`・`BusyError` などへ、`services` はパスワード Provider の `PasswordBusyError` を `BusyError` などへ変換する。コントローラーや Middleware が SQLite のエラーを直接判定しない
- コントローラー・バリデーション Middleware・ルーターは、失敗時にカスタムエラーを投げる。エラーハンドリング Middleware が Problem Details と HTTP ステータスコードへ変換する。要求中断時は design.md 6.6 の応答規則を優先する
- エラーは、伝播を止めた層で 1 回だけログに出す。投げたエラーは最上位のエラーハンドリング Middleware で記録し、握りつぶして成功や通常の失敗に変換したエラーは、変換したその場で記録する。ログに出したエラーをさらに投げて、別の層で重複して記録しない。具体的な場面は design.md 6.5 を参照する
- パスワード、ハッシュ、リクエストボディを、ログにもエラーメッセージにも含めない

## 依存と組み立て

- 依存は static の生成メソッドや関数の引数で渡し、`src/index.ts` で組み立てる。非公開のコンストラクタでは引数を明示的なフィールドへ代入し、parameter properties を使わない
- `AuthService` に `UserRepository`・`PasswordProvider`・`IdProvider`・`LoggerProvider` を注入する。`IdProvider` の `newUserId`・`newDummyPassword` で乱数の利用を隠し、サービスは `node:crypto` を直接 import しない
- DI コンテナー、デコレーター、Service Locator は使わない。依存の数が少ないため、エントリーポイントの明示的な生成で組み立てを追えるようにする
- DB 接続やロガーなどの依存をモジュールのトップレベルの変数に置かない。テストの差し込み口が必要なときだけ例外とし、最小限にとどめる
- `providers/password` の Argon2id の計算を差し替える口は、計算中のセマフォの枠保持を決定的に検証するための、テスト用の最小限の例外とする。差し替えるテストは、同じファイル内で並行実行（`it.concurrent`・`describe.concurrent`）せず、終了時に必ず元へ戻す。Vitest の既定の設定（`isolate: true`）ではテストファイルごとにモジュールが分かれるため、ファイルをまたいだ影響は考えなくてよい

## 並行処理

- Node のコードは 1 つのスレッドで動くが、`await` の前後で他の要求の処理が割り込む。`await` をまたいで共有する状態（セマフォの枠、トランザクション）は、割り込まれても壊れないようにする
- タイマーやイベントの購読を始めるときは、止める条件（`signal` の中断、`clearTimeout`、`removeEventListener`）を先に決める
- 共有する資源（セマフォの枠、トランザクション）は、取得と解放を対にして `finally` で解放する
- 同期 API（`node:sqlite`、`*Sync` の関数）はイベントループを止める。起動時以外で使うのは `node:sqlite` だけにする

## 名前

- クラスと型は PascalCase、関数と変数は camelCase、定数も camelCase にする
- 層の名前だけでは対象が分からないため、公開する型やクラスは `UserRepository`・`SqliteUserRepository`・`PasswordProvider`・`Argon2PasswordProvider` など、対象と責務が分かる名前にする
- ゲッターに `get` を付けない
- スコープが短い変数は短い名前、広い変数は説明的な名前にする
- コメントで説明したくなったら、まず名前、型、早期リターン、関数の分割で表現できないかを考える。コメントの規約は [AGENTS.md](../AGENTS.md) に従う

## テスト

- Vitest の `describe`・`it` で書き、境界値は `it.each` の行を足して増やす
- 外部への依存は、モックライブラリや `vi.mock` ではなく、インターフェースを実装する手書きの偽物（メモリ上の `UserRepository`、固定値を返す `IdProvider` など）で置き換える
- サービスの分岐とエラー変換は偽の `PasswordProvider` で検証する。小さいパラメータの本物の `Argon2PasswordProvider` を使う結合テストも残し、PHC・NFKC・再ハッシュの連携を確かめる
- 共通の準備はヘルパー関数にまとめ、失敗したときにどの入力か分かるテスト名にする
- 変更した振る舞いには、その振る舞いが壊れたら失敗するテストを付ける。必ず通ってしまうテストを書かない
- 時間に依存するテストは、Vitest の偽タイマー（`vi.useFakeTimers`）で決定的にする。並行性に依存するテストは、`Promise` の解決の順序をテスト側で制御する

## 検査と整形

- 書式は Prettier に任せ、手で揃えない。整形だけの変更を、ほかの変更と同じコミットに混ぜない
- ESLint は typescript-eslint の `strictTypeChecked` を基本にする。AGENTS.md の禁止事項（乱数 API の制限など）、イベントループを止める `argon2Sync`、依存規則を回避する動的 import と `createRequire` も禁止する
- 移行時に `eslint.config.js` とその検証テストを新しい層へ合わせる。`services` の HTTP・DB・暗号モジュールへの直接依存、`repositories/sqlite` 以外の `node:sqlite`、具体的な Provider 以外の暗号呼び出し、逆向きの import を禁止する。モデル内部へのアクセスは上記の秘密値契約だけを例外とし、`src/index.ts` は全体を組み立てる唯一の入口にする
- 現在の `eslint.config.js` は旧モジュール構成を対象にしており、新しい依存規則はまだ適用されていない。移行後の規則とテストをそろえてから検証済みとする。禁止する名前やパターンの実際の一覧は `eslint.config.js` を正本とする
- ESLint の指摘は抑制コメントで消さず、コードを直す。どうしても抑制する場合は、`eslint-disable-next-line` で規則名を明示し、理由を同じ行に書く

## 作りすぎない

- 要件にない抽象化、設定項目、拡張点を先回りして作らない
- 迷ったら、より単純な書き方を選ぶ。複雑さが必要になった時点で足す
