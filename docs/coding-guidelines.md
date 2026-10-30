# TypeScript のコーディング方針

このリポジトリ（TypeScript 製の学習用認証 API）でコードを書くときの方針。
機能仕様は [README の文書一覧](../README.md#文書の正本と読む順序)から担当領域と関連契約を参照する。モジュール構成・責務・依存の向き・テスト方法は [architecture.md](architecture.md) を正本とし、この方針と食い違う場合はそちらを優先する。

本書の「する」「しない」は必須規約とし、例外は明記した範囲だけに認める。本番コードを主な対象とし、TypeScript のテスト・ベンチマーク・CI スクリプト・設定ファイルにも型安全性・Promise・後始末の規則を適用する。テスト固有の例外は「テスト」と「検査と整形」に定める。

配置は [アーキテクチャの現状と移行先](architecture.md#現状と移行先)、import 規則は [import の検査](architecture.md#import-の検査)、有効な検査設定と適用範囲は「[現在の検査設定](#現在の検査設定)」に従う。

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

- `tsconfig.json` の `strict`・`noImplicitReturns`・`noFallthroughCasesInSwitch`・`noUncheckedIndexedAccess`・`exactOptionalPropertyTypes` を有効にする
- `any`、型アサーション（`as`。`as const` も含む）、非 null アサーション（`!`）を使わない。外から来た値は `unknown` で受け取り、検査して型を絞る。型を合わせたいときは、型注釈か `satisfies` を使う。ESLint の `no-explicit-any`・`no-unsafe-*`・`consistent-type-assertions`（`assertionStyle: 'never'`）・`no-non-null-assertion`・`no-restricted-syntax` で検査する
- `@ts-ignore`・`@ts-nocheck`・`@ts-expect-error` を使わない。テストにも例外を設けず、型が合わない場合は入力の検証か型定義を直す。型検査を有効にする `@ts-check` は禁止しない
- 本番コードの入力・結果・DTO と、生成後に変更しないモデルのプロパティは `readonly` にする。設定入力の `Params` は「値オブジェクト」に定める例外とする。公開する型の変更時は architecture.md の契約も確認する
- `readonly` はプロパティの再代入を防ぐだけで、参照先の配列・`Set`・`Buffer` の変更や実行時の不変性を保証しない。参照を保持する側が所有者を明確にし、呼び出し元の変更から守る必要がある値はコピーする。内部の可変な値を外へ公開しない
- 添字アクセス（`parts[3]`、`record[key]`）の結果は `undefined` を含む。分割した文字列の要素数などは、使う前に検査して弾く
- Node の型除去が扱えない構文（`enum`、実行時コードを持つ `namespace`、パラメータプロパティ、デコレーター）を使わない。デコレーターは ESLint の `no-restricted-syntax`、それ以外は `erasableSyntaxOnly` で検査する
- 列挙は文字列リテラルの union 型で表す。union 型を `switch` で分岐するときはすべての値を `case` で扱う。ESLint の `switch-exhaustiveness-check` で検査する
- import の書き方（`index.ts` 経由、`.ts` の拡張子、`import type`）は [アーキテクチャの構成と依存の向き](architecture.md#構成と依存の向き)に従う
- `null` と `undefined` を混ぜない。値が無いことは `undefined` で表し、省略可能な項目は `?` で表す。`?` の項目に `undefined` を代入せず、項目ごと省く
- `null` を返す外部の値（`node:sqlite` が返す SQL の NULL、`JSON.parse` が返す JSON の null）は、境界の層（`repositories`、`schemas`）で検査して弾くか `undefined` に変換し、内側へ `null` を渡さない

## 関数の書き方

- 不正な入力・エラー・処理不要の条件は早期リターン（`return`・`throw`）で先に扱い、正常系を左端にまっすぐ書く。処理が終了する分岐の後に不要な `else` を書かない。ログインの不正メール・保存済み PHC 異常のダミー検証、中断時の資源解放など、仕様上必要な処理を省いたり順序を変えたりしない
- 本番コードの公開関数と公開メソッドは、引数と戻り値の型を明示する。内部の補助関数・コールバック・ローカル変数は型推論を利用できる
- 再代入が不要な変数は `const` にする。`let` は再代入する場合や、エラー変換のための `try` の外で結果を受け取るなど、宣言と初期化を分ける必要がある場合に限る。クラスの依存先や生成後に差し替えないフィールドは `readonly` にする。カウンター・待機列・接続状態など、役割上必要な状態変更は所有するクラスや関数に閉じ込める
- 条件式には boolean を使う。文字列・数値・省略可能な値は、空文字・ゼロ・`undefined` など、何を判定するかを明示的に比較する。外部の `null` は境界で明示的に扱い、数値の妥当性は必要に応じて `Number.isFinite`・`Number.isSafeInteger` などで検査する。値を返す関数は必要な全経路で値を返すか例外を投げ、`switch` の意図しない通り抜けを作らない
- 関数は名前で説明できる一つの目的を持たせ、独立した目的を持つ部分処理は名前付きの関数へ分ける。複雑な条件は判定の意味を表す関数にする。boolean 引数で異なる処理を切り替え、呼び出し側で意図が分からなくなる場合は、用途別の関数か名前付きのオプションで表す。分割の判断は責務と読みやすさで行う
- 非同期処理は `async`・`await` で書く。Node のコールバック API（`crypto.argon2` など）を `Promise` に包む箇所と、Node のイベントの入口で失敗を処理する終端の `catch` を例外とし、処理手順を `then` の連鎖で書かない
- 契約として `Promise` を返すが中身が同期の処理（`SqliteUserRepository` のメソッド）は、`async` を付けずに書く。`await` の無い `async` 関数は `require-await` に指摘される。同期の処理を `try` で囲み、成功は `Promise.resolve`、失敗は変換したエラーを `Promise.reject` で返す。呼び出し元へ同期的に例外を投げない
- 後始末は `try`・`finally` で書く。トランザクションは `BEGIN IMMEDIATE` の成功を確かめた後に `try` を始め、`COMMIT` まで進まなければ `ROLLBACK` する。返す Promise の失敗をその場で捕捉する場合や、処理の完了まで資源を保持する場合は `return await` を使う。待機を省いて `finally` の資源解放を先に実行しない（[return-await の根拠](https://typescript-eslint.io/rules/return-await/)）
- 中断の `signal: AbortSignal` は最後の引数で受け取り、下の層（DB 呼び出し、`hash`、`verify`）までそのまま渡す。クラスのフィールドに保存しない
- 作った `Promise` は `await` するか、呼び出し元へ `return` して責任を渡すか、終端の `catch` で失敗を処理する。空の処理で失敗を握りつぶさない。`void` を付けるだけでは失敗を処理したことにならない（[no-floating-promises の根拠](https://typescript-eslint.io/rules/no-floating-promises/#ignorevoid)）。条件式に `Promise` を渡さない（`if (passwordProvider.verify(...))` は常に真になる）。検査設定は「[現在の検査設定](#現在の検査設定)」に定める

## 値オブジェクト

- 次のどれかに当てはまる値だけを値オブジェクトにする
  - 守るべき条件がある（検証済み、正規化済み、範囲内など）
  - 同じ基本型の値を取り違えやすい
  - 同じ検証をあちこちで繰り返している
- 値は `readonly` な private フィールド（`#`）に置き、コンストラクタを `private` にする。公開する生成経路は、型が保証する条件を検証してから作る static メソッド（`parse`、`create`）に限定する。Provider 専用の内部生成は下記の秘密値契約に従い、生成済みのハッシュを再解析しない。外から来た値は境界で 1 回だけ解析し、内側では型だけを扱う。生成後に内容を変えるメソッドを設けず、外部から参照先を書き換えられないようにする
- 値そのものの条件とユースケース固有のポリシーを区別する。`Password.parse` は正規化・最大長などを保証し、登録時の最小長は `hash` が検査する。ログイン・再ハッシュで短い既存パスワードを拒否しない
- TypeScript の型は構造で比較されるため、同じ形の別の型と取り違えないよう、値オブジェクトは private フィールドを持つクラスにする
- 秘密を持つ値オブジェクトは、`toString`・`toJSON`・`[util.inspect.custom]` で伏字を返す。型ごとの扱いは [パスワード仕様](password.md#公開契約)に定める
- `Password` と `EncodedHash` は `models` に置き、`#` フィールドで生パスワードとハッシュを区別する。変数名も `rawPassword`・`encodedHash` などで区別する。PHC の構文解析、`Cost`、解析済みの値はモデル内部に置き、`models` から `providers` に依存させない
- 暗号計算のための秘密値の読み出しとハッシュ生成は、具体的な `providers/password/argon2-password-provider.ts` に限って使えるモデル内部の契約とする。公開の `models/index.ts` からは export せず、専用の内部 import と検証用の例外は architecture.md に従う。一般公開の生パスワード getter や変更可能な `Buffer` の getter は追加しない。保存用の PHC は従来どおり `EncodedHash.phc()` を明示的に呼ぶ
- JSON の入出力用の型、DB の行を受ける型、素通りするだけの値は、値オブジェクトにしない
- `Params` は設定入力の型として変更可能な公開プロパティを維持する。`Argon2PasswordProvider.create` がコピーして検証し、呼び出し元の変更が保持する設定に影響しないようにする。不変の値オブジェクトにはしない
- 値オブジェクトの導入で architecture.md のインターフェース（例：`UserRepository` の引数の型）が変わる場合は、先に architecture.md を更新する

## エラー

- 判定が必要なエラーは `Error` を継承したクラスとして定義し、`name` を設定する。文字列のメッセージで判定しない
- カスタムエラーと `cause` をたどる補助関数は `errors` に置く。エラークラスに HTTP ステータスコードを持たせず、変換は最上位のエラーハンドリング Middleware に集約する
- 下の層のエラーは `new XxxError('何をしていたか', { cause: err })` で包んで投げる。判定は `errors` の補助関数で `cause` をたどって行う
- `catch` した値は `unknown` として扱い、`Error` 以外が投げられた場合も考える
- 各層はエラーを自分の契約に変換する。`repositories` は SQLite のエラーを `EmailTakenError`・`UserNotFoundError`・`BusyError` などへ、`services` はパスワード Provider の `PasswordBusyError` を `BusyError` などへ変換する。コントローラーや Middleware が SQLite のエラーを直接判定しない
- コントローラー・バリデーション Middleware・ルーターは、失敗時にカスタムエラーを投げる。エラーハンドリング Middleware が Problem Details と HTTP ステータスコードへ変換する。要求中断時は [サーバータイムアウト](api.md#サーバータイムアウト) の応答規則を優先する
- エラーは、伝播を止めた層で 1 回だけログに出す。投げたエラーは最上位のエラーハンドリング Middleware で記録し、握りつぶして成功や通常の失敗に変換したエラーは、変換したその場で記録する。ログに出したエラーをさらに投げて、別の層で重複して記録しない。具体的な場面は [横断的な要件](api.md#横断的な要件) を参照する
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
- 判定する関数は `is`・`has`・`can` など、呼び出し側で条件の意味が分かる名前にする。時間・サイズなどの数値は `timeoutMs`・`memoryKiB` のように単位を明示し、業務上の上限値や待機時間は意味のある名前付き定数で表す
- コメントで説明したくなったら、まず名前、型、早期リターン、関数の分割で表現できないかを考える。コメントの規約は [AGENTS.md](../AGENTS.md) に従う

## テスト

- ヘルパー・偽物には、本番の公開関数の型明示とデータの `readonly` を一律に要求しない。偽物の呼び出し記録やシナリオ用の状態変更を認める。型安全性・Promise・後始末の規則は共通とし、型アサーションや TypeScript の抑制コメントで不正な入力を作らず、`unknown` を受ける境界で検証する
- Vitest の `describe`・`it` で書き、境界値は `it.each` の行を足して増やす
- 外部への依存は、モックライブラリや `vi.mock` ではなく、インターフェースを実装する手書きの偽物（メモリ上の `UserRepository`、固定値を返す `IdProvider` など）で置き換える
- サービスの分岐とエラー変換は偽の `PasswordProvider` で検証する。小さいパラメータの本物の `Argon2PasswordProvider` を使う結合テストも残し、PHC・NFKC・再ハッシュの連携を確かめる
- `#` フィールドだけを持つ `Password`・`EncodedHash` は、`toEqual`・`toStrictEqual` では別の値でも等しくなる。偽物に渡された値は `toBe`（参照の同一性）、`EncodedHash` の内容は `phc()` で比べる
- 共通の準備はヘルパー関数にまとめ、失敗したときにどの入力か分かるテスト名にする
- 共有する偽物と補助関数の配置・利用範囲は architecture.md に従う。異なる用途をモードで切り替える万能な偽物を作らず、各テストで新しいインスタンスを作る
- エラーを取り出して検査するときは、同期例外を共有の `caught`、Promise の失敗を `rejected` で捕捉する。同じ処理を複数回呼んで別の属性を検査しない。同期的に投げないことや失敗前の状態を確かめる観測は残す
- 同じ分岐でも入力経路・副作用・原因・中断条件が異なる確認は残す。アサーションを削るときは残る確認先を明らかにし、固定変換と各層の連携の責任を分ける
- 変更した振る舞いには、その振る舞いが壊れたら失敗するテストを付ける。必ず通ってしまうテストを書かない
- 時間に依存するテストは、Vitest の偽タイマー（`vi.useFakeTimers`）で決定的にする。並行性に依存するテストは、`Promise` の解決の順序をテスト側で制御する

## 検査と整形

- 書式は Prettier に任せ、手で揃えない。整形だけの変更を、ほかの変更と同じコミットに混ぜない
- ESLint は typescript-eslint の `strictTypeChecked` を基本にする。AGENTS.md の禁止事項（乱数 API の制限など）、イベントループを止める `argon2Sync`、依存規則を回避する動的 import と `createRequire` も禁止する
- 層や共有補助コードの構成を変えるときは `eslint.config.js` を合わせ、設定テストの代表例を見直す。`services` の HTTP・DB・暗号モジュールへの直接依存、`repositories/sqlite` 以外の `node:sqlite`、具体的な Provider 以外の暗号呼び出し、逆向きの import を禁止する。旧 `src/store/sqlite/` の経路と暫定規則は撤去済みである。モデル内部へのアクセスは上記の秘密値契約だけを例外とし、`src/index.ts` は全体を組み立てる唯一の入口にする
- `eslint.config.js` は層ごとの依存規則を検査する。`.github/scripts/eslint-config.test.ts` は許可・拒否の代表例による最小限の確認とし、層の全組み合わせや回避構文は網羅しない。禁止する名前やパターンの実際の一覧は `eslint.config.js` を正本とする
- ESLint の指摘はコードを直して解消し、本番コードで抑制しない。例外は `*.test.ts` で、規則が禁止する書き方自体を試す必要がある場合だけとする。例として、秘密値をテンプレートリテラルへ埋め込んでも伏字になることを確かめるテストがある。この例外で `any`・型アサーション・TypeScript の抑制禁止を回避しない
- 例外には対象行だけの `eslint-disable-next-line` を使い、規則名と検証のために必要な理由を同じ行に書く。ファイル全体・範囲全体の抑制、規則名や理由の省略を認めない

### 現在の検査設定

`tsconfig.json` の `strict`・`noImplicitReturns`・`noFallthroughCasesInSwitch`・`noUncheckedIndexedAccess`・`exactOptionalPropertyTypes` と、`eslint.config.js` の `strictTypeChecked` および個別設定により、型の安全性、Promise の扱い、union の分岐漏れ、依存の向きを検査している。`@typescript-eslint/return-await` の `error-handling-correctness-only` も有効である。

各規則の設定と適用範囲は次のとおりとする。ESLint 規則の重大度はすべて `error` とする。

| 検査 | 設定・適用範囲 |
|---|---|
| `no-else-return` | `allowElseIf: false`。検査対象の TypeScript に適用する。`throw` 後の不要な分岐や、必要な処理の順序はレビューでも確認する |
| `@typescript-eslint/prefer-readonly` | 本番 TypeScript に適用し、コンストラクタ以外で変更しない private フィールドを `readonly` にする。DTO のプロパティや参照先の不変性はレビューで確認する |
| `@typescript-eslint/explicit-module-boundary-types` | 本番 TypeScript の公開関数・公開メソッドに適用する。テスト・ベンチマークのヘルパーには要求しない |
| `@typescript-eslint/strict-boolean-expressions` | `allowString`・`allowNumber`・`allowNullableObject` は `false`。ほかの非 boolean を許可するオプションも既定の `false` を維持し、検査対象の TypeScript に適用する |
| `noImplicitReturns`・`noFallthroughCasesInSwitch` | 両方を `true` とし、`tsconfig.json` の検査対象に適用する |
| `@typescript-eslint/no-floating-promises` | `ignoreVoid: false` とし、型情報を使う検査対象の TypeScript で `void` 付きの放置も検出する |
| `@typescript-eslint/ban-ts-comment` | `ts-ignore`・`ts-nocheck`・`ts-expect-error` をすべて `true`（禁止）にし、テストを含む検査対象の TypeScript に適用する |
| `linterOptions.reportUnusedDisableDirectives` | `error` にし、不要になった ESLint の抑制を残さない |

上表の「本番 TypeScript」は `src/` のうち `*.test.ts`・`*.bench.ts` を除いたコードを指す。実際の検査対象は [開発ガイド](development.md#コマンド)に従う。関数分割・命名、値オブジェクトが保証する条件、入力・結果の `readonly`、可変な参照の所有権、テスト用の抑制理由は自動検査だけでは保証できないため、レビューで確認する。

## 作りすぎない

- 要件にない抽象化、設定項目、拡張点を先回りして作らない
- 迷ったら、より単純な書き方を選ぶ。複雑さが必要になった時点で足す
