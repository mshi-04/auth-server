# TypeScript のコーディング方針

このリポジトリ（TypeScript 製の学習用認証 API）でコードを書くときの方針。
仕様は [design.md](design.md)、モジュール構成・責務・依存の向き・テスト方法は [architecture.md](architecture.md) を正本とし、この方針と食い違う場合はそちらを優先する。

移行中の Go 実装は、移行の完了（design.md 10 章の手順 7）で削除するまで機能を追加しない。

## 構成

- 軽量な Clean Architecture として扱う。依存は内側（`auth`、`password`）へ向け、内側は外側（`httpapi`、`store/sqlite`、`node:http`、`node:sqlite`）を知らない
- モジュールは層の名前（`domain`、`usecase` など）ではなく、architecture.md の責務ごとに分ける
- インターフェースは使う側のモジュールで定義し、使うメソッドだけに絞る。実装が 1 つしかないクラスを、理由なくインターフェースにしない
- 「インターフェースを受け取り、具体的なクラスを返す」を基本にする
- ユースケースごとの入出力ポート、DTO、Presenter は作らない。`httpapi` のハンドラ内での変換で済ませる

## 型

- `tsconfig.json` の `strict` を有効にし、`any` と型アサーション（`as`）を使わない。外から来た値は `unknown` で受け取り、検査して型を絞る。ESLint の `no-explicit-any`・`no-unsafe-*`・`consistent-type-assertions`（`assertionStyle: 'never'`）で検査する
- Node の型除去が扱えない構文（`enum`、実行時コードを持つ `namespace`、パラメータプロパティ、デコレーター）を使わない。列挙は文字列リテラルの union 型で表す
- 型だけの import には `import type`（または `import { type X }`）を使う。import には `.ts` の拡張子を書く
- `null` と `undefined` を混ぜない。値が無いことは `undefined` で表し、省略可能な項目は `?` で表す

## 関数の書き方

- 不正な入力とエラーは早期リターン（`return`・`throw`）で先に弾き、正常系を左端にまっすぐ書く。`return` や `throw` の後に `else` を書かない
- 非同期処理は `async`・`await` で書く。`then` の連鎖やコールバックは、Node の API が要求する場合（`crypto.argon2`）を `Promise` に包む箇所だけにする
- 後始末は `try`・`finally` で書く。トランザクションは `BEGIN IMMEDIATE` の成功を確かめた後に `try` を始め、`COMMIT` まで進まなければ `ROLLBACK` する
- 中断の `signal: AbortSignal` は最後の引数で受け取り、下の層（DB 呼び出し、`hash`、`verify`）までそのまま渡す。クラスのフィールドに保存しない
- 待たない `Promise` を作らない。作った `Promise` は必ず `await` するか、失敗を処理する。条件式に `Promise` を渡さない（`if (hasher.verify(...))` は常に真になる）。ESLint の `no-floating-promises`・`no-misused-promises` で検査する

## 値オブジェクト

- 次のどれかに当てはまる値だけを値オブジェクトにする
  - 守るべき条件がある（検証済み、正規化済み、範囲内など）
  - 同じ基本型の値を取り違えやすい
  - 同じ検証をあちこちで繰り返している
- 値は private フィールド（`#`）に置き、コンストラクタを `private` にして、有効な値の生成経路を検証してから作る static メソッド（`parse`、`create`）に限定する。外から来た値は境界で 1 回だけ解析し、内側では型だけを扱う
- TypeScript の型は構造で比較されるため、同じ形の別の型と取り違えないよう、値オブジェクトは private フィールドを持つクラスにする
- 秘密を持つ値オブジェクトは、`toString`・`toJSON`・`[util.inspect.custom]` で伏字を返す。型ごとの扱いは design.md に定める
- JSON の入出力用の型、DB の行を受ける型、素通りするだけの値は、値オブジェクトにしない
- `Params` は設定入力の型として公開プロパティを維持し、`Hasher.create` で検証する。不変の値オブジェクトにはしない
- 値オブジェクトの導入で architecture.md のインターフェース（例：`UserStore` の引数の型）が変わる場合は、先に architecture.md を更新する

## エラー

- 判定が必要なエラーは `Error` を継承したクラスとして定義し、`name` を設定する。文字列のメッセージで判定しない
- 下の層のエラーは `new XxxError('何をしていたか', { cause: err })` で包んで投げる。判定は `errors.ts` の補助関数で `cause` をたどって行う
- `catch` した値は `unknown` として扱い、`Error` 以外が投げられた場合も考える
- 各層はエラーを自分の契約に変換する。`store/sqlite` は SQLite のエラーを `auth` のエラーへ、`auth` は `password` のエラーを `auth` のエラーへ、`httpapi` は `auth` のエラーをステータスコードへ変換する。`httpapi` が SQLite のエラーを直接見ない
- エラーは、伝播を止めた層で 1 回だけログに出す。投げたエラーは最上位（`httpapi`）で記録し、握りつぶして成功や通常の失敗に変換したエラーは、変換したその場で記録する。ログに出したエラーをさらに投げて、別の層で重複して記録しない。具体的な場面は design.md 6.5 を参照する
- パスワード、ハッシュ、リクエストボディを、ログにもエラーメッセージにも含めない

## 依存と組み立て

- 依存は static の生成メソッドや関数の引数で渡し、`main.ts` で組み立てる
- DB 接続やロガーなどの依存をモジュールのトップレベルの変数に置かない。テストの差し込み口が必要なときだけ例外とし、最小限にとどめる
- `password` の Argon2id の計算を差し替える口は、計算中のセマフォの枠保持を決定的に検証するための、テスト用の最小限の例外とする。差し替えるテストは並列実行せず、終了時に必ず元へ戻す

## 並行処理

- Node のコードは 1 つのスレッドで動くが、`await` の前後で他の要求の処理が割り込む。`await` をまたいで共有する状態（セマフォの枠、トランザクション）は、割り込まれても壊れないようにする
- タイマーやイベントの購読を始めるときは、止める条件（`signal` の中断、`clearTimeout`、`removeEventListener`）を先に決める
- 共有する資源（セマフォの枠、トランザクション）は、取得と解放を対にして `finally` で解放する
- 同期 API（`node:sqlite`、`*Sync` の関数）はイベントループを止める。起動時以外で使うのは `node:sqlite` だけにする

## 名前

- クラスと型は PascalCase、関数と変数は camelCase、定数も camelCase にする
- モジュールのディレクトリ名を文脈として使う（`password` の `Hasher`。`PasswordHasher` にしない）
- ゲッターに `get` を付けない
- スコープが短い変数は短い名前、広い変数は説明的な名前にする
- コメントで説明したくなったら、まず名前、型、早期リターン、関数の分割で表現できないかを考える。コメントの規約は [CLAUDE.md](../CLAUDE.md) に従う

## テスト

- Vitest の `describe`・`it` で書き、境界値は `it.each` の行を足して増やす
- 外部への依存は、モックライブラリや `vi.mock` ではなく手書きの偽物（メモリ上の `UserStore` など）で置き換える
- 共通の準備はヘルパー関数にまとめ、失敗したときにどの入力か分かるテスト名にする
- 変更した振る舞いには、その振る舞いが壊れたら失敗するテストを付ける。必ず通ってしまうテストを書かない
- 時間に依存するテストは、Vitest の偽タイマー（`vi.useFakeTimers`）で決定的にする。並行性に依存するテストは、`Promise` の解決の順序をテスト側で制御する

## 検査と整形

- 書式は Prettier に任せ、手で揃えない。整形だけの変更を、ほかの変更と同じコミットに混ぜない
- ESLint は typescript-eslint の `strictTypeChecked` を基本にし、このプロジェクトの禁止事項（`Math.random`、`node:crypto` の `argon2Sync`、architecture.md の依存の向きに反する import）も規則で禁止する
- ESLint の指摘は抑制コメントで消さず、コードを直す。どうしても抑制する場合は、`eslint-disable-next-line` で規則名を明示し、理由を同じ行に書く

## 作りすぎない

- 要件にない抽象化、設定項目、拡張点を先回りして作らない
- 迷ったら、より単純な書き方を選ぶ。複雑さが必要になった時点で足す
