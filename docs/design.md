# 認証基盤バックエンド 設計書（学習用 v0.24）

## 1. 目的

パスワード保存の仕組み（Argon2id、ソルト、PHC 形式、定数時間比較、再ハッシュ）を、実際に動く最小の登録・ログイン API を通して理解する。

## 2. スコープ

### 実装するもの

1. `src/password` モジュール（ハッシュ化・検証・再ハッシュ判定・パスワードポリシー・同時実行制限）
2. 登録・ログイン API（`POST /v1/users`、`POST /v1/sessions`、`GET /healthz`）
3. SQLite のテーブル 2 つ（`users`、`password_credentials`）
4. GitHub Actions による CI（型検査、静的検査、整形確認、全テスト、カバレッジレポート、CodeQL による JavaScript/TypeScript のセキュリティ解析）
5. Dependabot による npm パッケージと GitHub Actions の依存更新
6. 同じ Node.js サーバーから配信する、登録・ログインを試す日本語の Web 画面
7. Go 実装から TypeScript 実装への移行（10 章の手順）

### 実装しないもの

JWT・リフレッシュトークン、ペッパー、メール確認、パスワードリセット、JWKS、レート制限、監査ログ、ORM、マイグレーションツール、testcontainers、MFA、Docker。

## 3. ディレクトリ構成

言語は TypeScript、実行環境は Node.js 26 系の 26.11.0 以上（2026-10-23 時点では Current。2026-10-28 に LTS へ移行する予定）。26.11.0 を下限とするのは、5.1 の `node:sqlite` の `Database` クラスがこの版で導入されたため。プロジェクトのフォルダ名は `auth-server`（旧フォルダ名 `auth-sever` から改名済み）。

モジュールの責務と依存の向きは [architecture.md](architecture.md) を正本とする。

```
auth-server/
├── src/
│   ├── main.ts              # エントリポイント
│   ├── errors.ts            # cause をたどってエラーを判定する補助関数
│   ├── log/                 # JSON ロガー
│   ├── config/              # 環境変数（DATABASE_PATH、PORT）
│   ├── httpapi/             # ハンドラ、Problem Details、Web 画面の配信
│   │   └── web/            # HTML・CSS・JavaScript
│   ├── auth/                # 登録とログインの処理
│   ├── password/            # Argon2id とパスワードポリシー
│   └── store/sqlite/        # SQLite による永続化（init.sql を open で実行）
├── docs/                    # design.md、architecture.md など
├── .nvmrc                   # Node のメジャーバージョン
├── .npmrc                   # engine-strict=true
├── .prettierignore
├── eslint.config.js
├── package.json
├── package-lock.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

- テストは対象と同じディレクトリに `*.test.ts`、ベンチマークは `*.bench.ts` として置く
- 移行の完了（10 章の手順 7）までは、Go 実装の `cmd/`・`internal/`・`go.mod`・`go.sum` が並存する

## 4. password モジュール

### 4.1 使用ライブラリ

すべて Node.js の標準モジュールを使い、外部パッケージに依存しない。

| 用途 | API |
|---|---|
| Argon2id | `node:crypto` の `argon2`（非同期版。暗号処理の自前実装は禁止） |
| ソルト生成 | `node:crypto` の `randomBytes`（`Math.random` は使用禁止） |
| 比較 | `node:crypto` の `timingSafeEqual` |
| 正規化 | `String.prototype.normalize('NFKC')` |

- `argon2` の非同期版は、Node の他の非同期暗号処理と同じく libuv のスレッドプール（既定 4 スレッド）で計算される。ドキュメントに明記が無いため、実装時に 4.7 の飽和ベンチマークで確認する
- 非同期版がメインのイベントループで鍵導出を行っていた不具合（nodejs/node#62861）は、2026-04 に nodejs/node#62863 で修正され、v24 系にもバックポートされている。対象の 26.11.0 以上は修正を含む想定だが、4.7 でイベントループの遅延を測って確かめる
- 同期版の `argon2Sync` は計算中にイベントループを止めるため使わない

### 4.2 パラメータ

型 `Params` で設定可能にする。

```ts
type Params = {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  saltLength: number;
  keyLength: number;
  maxConcurrent: number;
  waitTimeoutMs: number;
};
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

- `defaultParams()` が採用値を返す。省略した項目の暗黙補完は行わない
- 採用値は Go 実装のベンチマーク（4.7）で決めた値を出発点とし、TS 実装で再測定して 1 回 200〜500ms 程度に収まるか確認する
- 参考：RFC 9106 の推奨第 2 案は m=64 MiB、t=3、p=4。OWASP の最低ラインは m=19 MiB、t=2、p=1

生成設定と保存済み PHC の検証には、現行設定と独立した次の固定範囲を使う。上限はこの学習用実装でのリソース制限であり、Argon2 自体の上限ではない。

| 項目 | 許容範囲 |
|---|---|
| memory | `8 × parallelism` KiB 以上、262144 KiB（256 MiB）以下 |
| iterations | 1〜10 |
| parallelism | 1〜16 |
| salt 長 | 生成設定は 16〜64 バイト、保存済み PHC は 8〜64 バイト |
| 出力長 | 4〜64 バイト |

- すべての項目は `Number.isSafeInteger` を満たす整数に限る。`maxConcurrent` と `waitTimeoutMs` は正の整数に限る
- 不正な生成設定は `Hasher.create` が `InvalidParamsError` を投げる。保存済み PHC の範囲外の値は `InvalidHashError` とする
- memory・iterations・parallelism・出力長の下限は RFC 9106 の入力条件に従う。生成設定のソルト長の下限は RFC 9106 の推奨値 16 バイトとする。保存済み PHC のソルトの下限は、Node の `argon2` が nonce に要求する 8 バイトとする（Go 実装では 1 バイト以上を受理していた）

### 4.3 保存形式

```
$argon2id$v=19$m=131072,t=9,p=2$<salt>$<hash>
```

salt と hash は base64（パディングなし。標準のアルファベット `A-Z a-z 0-9 + /`）。

- アルゴリズムは `argon2id`、バージョンは `19` に限る
- パラメータは `m`・`t`・`p` がそれぞれ 1 回ずつ必要。解析時の順序は問わないが、生成時は `m,t,p` の順にする
- 不足・重複・未知の項目、数字以外を含む値、先頭が 0 の値、安全な整数の範囲を超える値、4.2 の範囲外の値を拒否する。数値は `^(0|[1-9][0-9]*)$` に一致することを確かめてから変換する
- ソルトと出力の符号化後の長さを検査してからデコードする。パディング、不正文字、改行、不正な末尾ビット、空要素を拒否する
- `Buffer.from(s, 'base64')` は不正文字を読み飛ばし、末尾ビットも検査しない。そのため、文字種を正規表現で検査し、デコード結果をパディングなしで再エンコードした文字列が入力と一致することを確かめる
- `EncodedHash.parse` が PHC を 1 回だけ解析する。`verify` と `needsRehash` は、その解析済みの値を使う

### 4.4 API

状態（パラメータ・セマフォ）を持つため、ハッシュ処理はクラス `Hasher` のメソッドとして提供する。外部の文字列は境界で値オブジェクトに解析し、内側ではその型を使う。

```ts
function defaultParams(): Params;

class Password {
  static parse(raw: string): Password;
}

class EncodedHash {
  static parse(encoded: string): EncodedHash;
  phc(): string;
}

class Hasher {
  static create(params: Params): Hasher;
  hash(password: Password, signal: AbortSignal): Promise<EncodedHash>;
  rehash(password: Password, signal: AbortSignal): Promise<EncodedHash>;
  verify(password: Password, encoded: EncodedHash, signal: AbortSignal): Promise<boolean>;
  needsRehash(encoded: EncodedHash): boolean;
}
```

| メソッド | 振る舞い |
|---|---|
| `Password.parse(raw)` | 不正な文字列の検査 → NFKC 正規化 → 最大 128 文字の検査 → `Password`。最小長は検査せず、空文字や短い既存パスワードも受理する。違反時は `PolicyViolationError` |
| `EncodedHash.parse(encoded)` | 4.3 の規則で PHC を解析 → `EncodedHash`。異常時は `InvalidHashError` |
| `EncodedHash.phc()` | 保存用の PHC 文字列を返す。解析した PHC は元の表記を保持する |
| `hash(password, signal)` | 最小 12 文字の検査（`PolicyViolationError`）→ セマフォ取得 → ソルト生成 → Argon2id → 正規の PHC を持つ `EncodedHash` |
| `rehash(password, signal)` | ログイン成功後の再ハッシュ用。最小長を検査しない点を除き `hash` と同じ。短い既存パスワードも現行パラメータへ移行できる。登録には使わない |
| `verify(password, encoded, signal)` | セマフォ取得 → 解析済みの保存パラメータとソルトでハッシュ → 定数時間比較。不一致は `false` |
| `needsRehash(encoded)` | memory・iterations・parallelism・ソルト長・出力長のいずれかが現行設定と異なるか、保存済みの表記が正規の表記（`m,t,p` の順）と異なれば `true`。同時数と待機時間は比較しない |

- `Params` は設定を組み立てるための入力であり、公開プロパティを維持する。`Hasher.create` は設定を検証し、値のコピーとセマフォを保持する。コンストラクタは公開せず、生成経路を `create` に限る
- `Password` と `EncodedHash` のコンストラクタも公開せず、生成経路を `parse` と `Hasher` の戻り値に限る。値は private フィールド（`#`）に保持し、変更可能な内部データ（`Buffer` など）は公開しない。`===` は参照の比較であり、値の比較には使わない。解析済みの空文字は有効な `Password` である
- 生成済みのハッシュも再解析せず、`EncodedHash` で返す
- 両クラスは `toString()`・`toJSON()`・`[util.inspect.custom]` で固定文字列 `[REDACTED]` を返す。テンプレートリテラル、`JSON.stringify`、`console.log`・`util.inspect`（別のオブジェクトのプロパティに入れた場合も含む）で中身が出ないようにする。PHC の保存には `phc()` を明示的に使う
- エラーは `InvalidParamsError`（生成設定）、`PolicyViolationError`（パスワードの解析・`hash` の最小長。利用者の入力の違反に限る）、`InvalidHashError`（PHC の解析）、`BusyError`（セマフォ待機の打ち切り）とする。いずれも `Error` を継承したクラスで、文脈を付けて包む場合は `cause` に元のエラーを入れ、`cause` をたどって判定できるようにする
- `hash`・`rehash`・`verify` は、**同じ `Password.parse` で正規化した値**を使い、正規化や最大長の検査を繰り返さない。不正な文字列と最大長超過は解析時の `PolicyViolationError` となり、auth がログイン時の認証失敗へ変換する
- `verify` と `rehash` では最小長を検査しない（ポリシーを後から強化しても、既存ユーザーがログインできなくなったり、現行パラメータへ移行できなくなったりするのを防ぐ）
- セマフォの待機は `signal` の中断とタイムアウト（既定 5 秒）で打ち切り、いずれも `BusyError` を投げる。`signal` による打ち切りでは `cause` に `signal.reason` を入れ、クライアントの切断や期限切れを過負荷と区別できるようにする。中断済みの `signal` では、空き枠があっても計算を開始しない
- パスワードと PHC をログやエラーメッセージに含めない

### 4.5 パスワードポリシー

- NFKC 正規化した後の **Unicode コードポイント数**（`for...of` で数える。UTF-16 のコード単位数の `length` は使わない）で長さを判定する
- 最小 12 文字、最大 128 文字
- 文字種の組み合わせは強制しない
- JavaScript の文字列は UTF-16 のため、Go 実装の「不正な UTF-8」の拒否は、ペアになっていないサロゲートを含む文字列の拒否（`String.prototype.isWellFormed()` が `false`）に置き換える。HTTP の本文の不正な UTF-8 は、デコード時に U+FFFD へ置き換わる（6.1）。JSON のエスケープ（`"\ud800"`）で入ったペアになっていないサロゲートは、ここで拒否する
- `Password.parse` が不正な文字列と最大長超過を `PolicyViolationError` で拒否し、`hash` が最小長を検査する。`verify` と `rehash` は解析済みの短い値や空文字も扱える

### 4.6 同時実行制限

- セマフォで同時に計算するハッシュの数を 4 に制限する（`hash` と `verify` の両方に適用）。Node に標準のセマフォは無いため、待ち行列を持つ小さなクラスを自前で実装する
- 制限するのは枠数であり、メモリ量ではない。1 回あたりのメモリは採用値で 128 MiB（4 並列で 512 MiB）だが、`verify` は保存済み PHC のパラメータで計算するため、最悪で 1 回 256 MiB（4.2 の上限）、4 並列で 1 GiB になる
- 待機がタイムアウトしたら `BusyError` を投げ、API 層で 503 に変換する
- 同じ `Hasher` の `hash` と `verify` はセマフォを共有する。Argon2id の計算開始後は中断せず、完了まで枠を保持し、`finally` で必ず解放する
- 同時数の 4 は libuv のスレッドプールの既定のスレッド数と同じであり、計算中はスレッドプールが埋まる。静的ファイルの読み込みは起動時に済ませる。非同期版の `randomBytes` など、要求の処理で Argon2id 以外のスレッドプール処理を使う場合は、その待ち時間も 4.7 で測る

### 4.7 テスト・ベンチマーク

| 種別 | 内容 |
|---|---|
| 正常系 | `hash` → `verify` が true |
| 誤パスワード | `verify` が false |
| 正規化の一貫性 | 全角英数字で `hash` し、半角英数字で `verify` して true（逆も同様） |
| PHC パース異常 | `EncodedHash.parse` がアルゴリズム名・バージョン・パラメータ・base64 の不正でエラー。解析後の `phc()` は元の表記を返す |
| needsRehash | パラメータ変更後と非正規の表記で true、同一なら false |
| rehash | 短い既存パスワードを現行パラメータで再ハッシュできる |
| ポリシー境界値 | 11 / 12 / 128 / 129 文字、NFKC で文字数が変わる入力、サロゲートペアを含む入力、ペアになっていないサロゲート。解析時の最大長検査と `hash` の最小長検査を分けて検証 |
| 値オブジェクト | 解析済みの空文字、全出力経路（`toString`・`toJSON`・`util.inspect`・別のオブジェクトのプロパティ）での伏字、エラーに秘密を含めないこと |
| セマフォ | 同時数を超えた呼び出しがタイムアウトで `BusyError` になる。中断済みの `signal` で計算を開始しない。Argon2id の計算中は枠を保持し、終了後に解放する |
| ベンチマーク | `hash`（既定のパラメータ）、`hash saturated`（既定のパラメータで同時ハッシュ数いっぱいに並列実行したときの 1 回あたりの所要時間）、`hash candidates`（下記の候補）。`vitest bench` で計測 |
| イベントループ遅延 | 既定のパラメータで同時ハッシュ数いっぱいに並列実行している間、`node:perf_hooks` の `monitorEventLoopDelay` でイベントループの遅延を測る。遅延の最大値が 1 回のハッシュの所要時間より十分に小さく（目安は 50ms 未満）、計算中も他の処理が止まらないことを確かめる |
| スレッドプール待ち | 非同期版の `randomBytes` など、要求の処理で Argon2id 以外の libuv スレッドプール処理を採用する場合だけ、同時ハッシュ数いっぱいの状態で、その処理の開始から完了までの時間を測る。対象となる処理が無ければ測定は不要とする。`monitorEventLoopDelay` とは別に測り、スレッドプールのキュー待ちによる遅延を確かめる |

- 単体テストは小さい計算パラメータを使う。セマフォのテストはテスト側で枠を占有し、Vitest の偽タイマーで待機時間を進めて、重い計算の実行時間に依存させない
- ベンチマークは WSL の Node 26 で `npm run bench`（`vitest bench --run src/password`）を 3 回実行し、各回の平均の中央値を使う
- TS 実装ではまず既定値（128 MiB・反復 9・並列 2）の `hash` を測り、中央値が 200〜500ms に入るか確認する。入れば既定パラメータは変更しない
- 目標から外れた場合は、64 MiB と 128 MiB の反復 2〜10 を候補として測る。候補に入る設定が無ければ、速すぎる場合は 128→256 MiB、遅すぎる場合は 32→19 MiB の順に評価する。最初に目標に入るメモリ設定で、中央値が 300ms に最も近い反復数を採用する。同差なら反復数が多い方を採用する
- 採用値と測定結果を本書へ記録し、採用値を本書へ反映してから `defaultParams()` を変更する。候補内で目標を達成できなければ、未達を報告し、次段階へ進む前に調整方針を確認する

#### Go 実装時の記録：性能調整の結果（2026-10-18）

Go 実装（`golang.org/x/crypto/argon2`）で採用値を決めたときの記録。TS 実装の測定結果は別に記録する。

環境：WSL Ubuntu 24.04、Go 1.27.2、linux/amd64、`CGO_ENABLED=0`、Intel Core i7-12700。ベンチマークの `GOMAXPROCS` は 4。

- 初期値（64 MiB・反復 3・並列 2）：55.459 / 50.652 / 50.809 ms、中央値 **50.809 ms**。下の候補表とは別に測定したため、候補表の同じ構成（50.873 ms）とは一致しない
- 採用候補（128 MiB・反復 9・並列 2）：306.265 / 318.128 / 313.139 ms、中央値 **313.139 ms**
- 採用値を `DefaultParams()` に反映した直後の `BenchmarkHash`（第 1 回）：347.418 / 308.070 / 304.739 ms、中央値 **308.070 ms**（目標の 200〜500 ms 内）
- PR #3 作成前の文字列 API の `BenchmarkHash` 再測定（第 2 回、対象コミット `d0883fc`）：351.634 / 329.852 / 338.685 ms、中央値 **338.685 ms**（目標の 200〜500 ms 内）。PR #3 説明にも同じ値を記録している
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

#### Go 実装時の記録：型付き API 移行後の再測定（2026-10-19）

環境は上記と同じ WSL Ubuntu 24.04、Go 1.27.2、linux/amd64、`CGO_ENABLED=0`、Intel Core i7-12700、`GOMAXPROCS=4`。v0.10 の型付き API で、`ParsePassword` は計測外に置いた。

- 既定値（128 MiB・反復 9・並列 2）の `BenchmarkHash`：358.733 / 399.144 / 351.600 ms、中央値 **358.733 ms**。目標の 200〜500 ms 内であり、既定パラメータは変更しない
- 測定コマンド：`CGO_ENABLED=0 go test -run=^$ -bench=^BenchmarkHash$ -benchmem -count=3 ./internal/password`
- 2026-10-18 の文字列 API の結果は正規化も計測内に含む。今回の測定は解析済みの `Password` を渡すため、測定範囲を区別して記録する

## 5. データベース

### 5.1 ドライバ

Node 標準の `node:sqlite` の `Database` クラス（v26.11.0 で `DatabaseSync` から改名。`DatabaseSync` は非推奨の別名として残る）。外部パッケージやネイティブのビルドは不要。26.11.0 未満の Node は対象外とし（3 章）、`DatabaseSync` との互換処理は持たない。

- `node:sqlite` の安定度は 1.2（Release candidate）である
- `Database` の API はすべて同期で実行され、SQL の実行中とロックの待機中はイベントループが止まる

### 5.2 スキーマ（`src/store/sqlite/init.sql`）

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
- `email` は 6.3 の規則で解析したアドレス（大文字小文字は入力のまま）。山括弧や前後の空白は含めない
- `email_normalized` はメールアドレスを小文字化した値。重複判定に使う
- 時刻は UTC の ISO 8601 文字列
- ユーザー ID はアプリ側で `node:crypto` の `randomUUID()`（UUID v4）を使って生成する（SQLite には UUID 生成関数が無いため）

### 5.3 初期化と接続設定

- `src/store/sqlite/init.sql` を `open` のたびに読み込んで実行する（`IF NOT EXISTS` なので何度実行しても安全）。マイグレーションツールは使わない
- `SqliteStore.open(path, signal)` が接続を 1 つだけ所有する `SqliteStore` を返す（`Promise`）。接続確認、WAL の確認、スキーマ初期化のどれかに失敗した場合は接続を閉じる。利用後は `close()` で閉じる
- `SqliteStore` のコンストラクタは公開せず、`open` が返した値だけを使う
- 空のパスは拒否し、親ディレクトリは自動作成しない
- 接続前に、直上の親ディレクトリと既存の DB・`-wal`・`-shm`・`-journal` ファイルが実効 UID（`process.geteuid()`）の所有であり、グループと他ユーザーへの権限がない（`mode & 0o077` が 0）ことを `fs.lstat` で検査する。親は実ディレクトリ、既存ファイルは通常ファイルに限り、これらのパス自体がシンボリックリンクの場合も拒否する。所有者以外に権限がある場合は、権限を自動変更せず起動エラーにする。パスの祖先は信頼でき、実行中に外部から置き換えられないことを前提とする
- 新規 DB は SQLite の接続前に、排他的なファイル作成（`fs.open` のフラグ `'wx'`、モード `0o600`）で用意する。WAL・SHM・ジャーナルも DB の権限を引き継ぐ。プロセス全体の umask は変更しない。中断済みの `signal` ではファイル作成を開始しない
- パスは Linux（WSL）の形式を前提とし、Windows のドライブ文字付きのパスは扱わない
- パスは `path.resolve` で絶対パスにしてから `Database` に渡す。`/` で始まる絶対パスに限ることで、`file:` で始まる URI として解釈させない
- 接続は 1 つだけなので、接続ごとの設定は開いた直後に一度だけ行う。外部キー制約と busy timeout はコンストラクタのオプションで、WAL は `PRAGMA journal_mode = WAL` で設定する
- SQLite は `journal_mode` を変更できない保存先（共有メモリを使えない VFS など）でエラーにせず元のモードのまま続けるため、`open` は `PRAGMA journal_mode = WAL` の結果を読み、`wal` でなければエラーにする
- WAL への切り替えが `SQLITE_BUSY` になった場合（他のプロセスが DB を使っている場合）は、接続を閉じ、10ms 間隔で新しい接続による切り替えを再試行する。再試行の開始は最初の試行から 5 秒以内に限り、`signal` の中断でも終了する。5 秒経過時は直近の DB エラーを投げ、`signal` が中断された場合はその理由も `cause` に含める。再試行は `open` の WAL 切り替えだけに限定し、スキーマ初期化・通常の読み書き・`SQLITE_BUSY` 以外のエラーには適用しない

| 設定 | 指定方法 | 値 | 理由 |
|---|---|---|---|
| 外部キー制約 | オプション `enableForeignKeyConstraints` | `true` | 既定値も `true` だが、依存する設定として明示する |
| busy timeout | オプション `timeout` | `5000` | 他のプロセスとの書き込み競合時に即エラーにせず待つ |
| `journal_mode` | `PRAGMA journal_mode = WAL` | `WAL` | 他のプロセスの読み込みと、このプロセスの書き込みを並行できる |
| トランザクションの開始 | `BEGIN IMMEDIATE` | — | 開始時に書き込みロックを取り、読み込み→書き込みへの昇格時に busy timeout が効かず即 `SQLITE_BUSY` になる問題を防ぐ |

### 5.4 書き込み

- 登録時は `users` と `password_credentials` を 1 トランザクション（`BEGIN IMMEDIATE` … `COMMIT`。失敗時は `ROLLBACK`）で挿入する
- `node:sqlite` が SQLite のエラーを投げると、`code` が `'ERR_SQLITE_ERROR'` になり、拡張結果コードが数値の `errcode` に入る。`errcode` は Node のドキュメントに記載が無いため、対象の Node 26 系（26.11.0 以上）での形を 5.5 のテストで固定する。Node の更新で形が変わった場合は、このテストが失敗して気づける
- 下の UNIQUE 違反と `SQLITE_BUSY` の判定は、`code` が `'ERR_SQLITE_ERROR'` で、かつ `errcode` が数値の場合に限って行う。どちらかを満たさないエラーは、メール重複にも `BusyError` にも変換せず、予期しないエラーとして文脈を付けて投げる（httpapi で 500）。メッセージの文字列での判定はしない。説明の `errstr` やメッセージは判定にもログにも使わない
- メールアドレスの重複は `users` 挿入時の UNIQUE 制約違反（`errcode` が `SQLITE_CONSTRAINT_UNIQUE`＝2067）で検出し、`EmailTakenError` に変換する。API 層がこれを 409 に変換する。ID の PRIMARY KEY 制約違反（`SQLITE_CONSTRAINT_PRIMARYKEY`＝1555）など、ほかの制約違反はメール重複として扱わない
- ハッシュ更新では `hash` と `changed_at` を同時に更新する。時刻はスキーマと同じ UTC の ISO 8601 文字列とする。更新対象の資格情報が存在しなければ `UserNotFoundError` を投げる
- 保存層は受け取った正規化済みメールアドレスと PHC 文字列をそのまま扱い、正規化やハッシュの解析を繰り返さない
- 接続は 1 つで API は同期のため、このプロセス内の書き込みは常に 1 つずつ実行され、互いに競合しない。`SQLITE_BUSY` になるのは、他のプロセス（`sqlite3` コマンドなど）が DB のロックを持っている場合に限られる
- busy timeout を超えてもロックを取れない場合（`errcode & 0xff` が `SQLITE_BUSY`＝5）は、`auth` の `BusyError` を `cause` 付きで投げ、API 層がこれを 503 に変換する
- 同期の呼び出しは `signal` で中断できない。呼び出しの前に `signal` が中断されていれば実行せず、失敗したときに `signal` が中断されていれば、SQLite のエラーにかかわらず `signal.reason` を `cause` に含めた `BusyError` を投げる
- 登録の流量は Argon2id のセマフォ（4.6）で絞られる

### 5.5 テスト

- Vitest の各テストで一時ディレクトリ（`fs.mkdtemp`）に SQLite ファイルを作り、毎回まっさらな DB で実行する（skip しない）

## 6. API

### 6.1 エンドポイント

| メソッド | パス | リクエスト | 成功 | 主なエラー |
|---|---|---|---|---|
| POST | `/v1/users` | `{email, password}` | 201 `{user_id}` | 400 / 409 / 413 / 422 / 503 |
| POST | `/v1/sessions` | `{email, password}` | 200 `{user_id}` | 400 / 401 / 413 / 503 |
| GET | `/healthz` | なし | 200 | |

- HTTP は標準 `node:http` の `createServer` を使い、メソッドとパスの対応表で振り分ける。Web フレームワークは使わない
- ログイン成功時にトークンは発行しない（スコープ外）
- 登録とログインの成功応答は `application/json`。`GET /healthz` は DB を照会せず、本文なしの 200 を返す。GET のルートは HEAD も受け付ける

#### JSON 入力

- 本文は 16 KiB 以下の JSON オブジェクト 1 つとし、文字列の `email` と `password` を必須にする
- 不正な JSON、オブジェクト以外（配列・`null` を含む）、未知の項目、必須項目の欠落・null・文字列以外、後続の JSON や空白以外のデータは 400。末尾の空白も含めた本文全体の上限超過は 413。`Content-Length` が上限を超える場合は本文を読まずに 413 とし、宣言の無い本文も読みながら上限を数える
- 空文字は入力形式エラーにせず auth へ渡し、auth の検証・認証結果に従う。登録では入力検証で 422 になる。既存の空パスワードは `verify`・`rehash` の契約に従ってログインと移行ができる
- Content-Type ヘッダーは必須にせず、本文を検査する
- 本文のバイト列は `TextDecoder`（UTF-8、`fatal: false`）で文字列にし、不正な UTF-8 は U+FFFD に置き換える。その後 `JSON.parse` で解析する
- 項目名は大文字小文字を区別して完全一致で照合する（Go 実装の `encoding/json` は区別しなかった）。重複項目は `JSON.parse` の動作どおり後勝ちとする
- JSON のエスケープで入ったペアになっていないサロゲートは置き換えずに auth へ渡し、パスワードは 4.5 の規則で、メールアドレスは 6.3 の ASCII 制限で拒否する

#### エラー応答

- 404・405 を含めて `application/problem+json` とし、`type: "about:blank"`、HTTP 標準の英語 `title`、数値の `status`、原因別の固定された日本語 `detail` を返す。`instance` や拡張項目は付けない
- 401 の `detail` は「メールアドレスまたはパスワードが正しくありません」。500 は内部の原因を含めない。405 は許可するメソッドを `Allow` ヘッダーへ設定する
- 401 には `WWW-Authenticate` を付けない。認証情報を本文で受け取る方式で、該当する HTTP 認証スキームが無いため、RFC 9110 の要求から意図的に外れる
- 通常の入力エラーや認証失敗はログに出さず、予期しないエラーだけ httpapi で 1 回記録する。JSON の解析エラー自体は本文の一部を含むことがあるためログに出さない
- 本文の読み込み自体の失敗（上限超過以外の通信エラー）は 400 とし、JSON 不正とは別の `detail` を返す
- 要求の行やヘッダーが不正な要求、`headersTimeout`・`requestTimeout`（6.6）を超えた要求には、Node の HTTP サーバーが自動で 400・408 を返して接続を閉じる。これらはハンドラに届かないため、Problem Details にならない
- 対応表にないパス（`*` などのパス以外の要求先を含む）は 404 の Problem Details にする。パスの正規化やリダイレクトは行わない
- ステータスコードへの変換と成功応答は、要求が中断されておらず、応答を書ける場合に限る。クライアントの切断と応答期限による要求の `signal` の中断は、どの層で起きても予期しないエラーとして記録せず、6.6 の規則を優先する

### 6.2 ステータスコード

| 状況 | ステータス |
|---|---|
| JSON 不正 | 400 |
| 認証失敗（ユーザー不在・パスワード不一致・ログイン時のパスワード解析失敗（最大長超過・不正な文字列）・ログイン時のメールアドレス形式不正を区別しない） | 401 |
| メールアドレス重複 | 409 |
| ボディ上限（16 KiB）超過 | 413 |
| パスワードポリシー違反、登録時のメールアドレス形式不正 | 422 |
| セマフォ待機タイムアウト、DB の書き込みロック待機の打ち切りによる `BusyError` が httpapi まで伝播した場合（要求が中断されておらず、応答を書ける場合） | 503 |
| クライアントの切断 | 応答を書かない |
| サーバーの応答期限（30 秒）の超過 | 応答を書かず、接続を破棄する |

### 6.3 メールアドレスの検証

Node には Go の `net/mail.ParseAddress` に相当する標準 API が無いため、受理する形式をここで定め、auth で解析する。

- 前後の空白（`String.prototype.trim()` の対象）を除いた入力が、アドレス（`a@example.com`）そのものか、それを山括弧で囲んだもの（`<a@example.com>`）であること
- アドレスは RFC 5322 の dot-atom 形式の `ローカル部@ドメイン` に限る
  - ローカル部とドメインは、それぞれ 1 文字以上の atext（`A-Z a-z 0-9` と `` !#$%&'*+-/=?^_`{|}~ ``）をドット `.` でつないだもの。先頭・末尾・連続のドットは拒否する
  - 表示名（`"Name" <a@example.com>` 形式）、グループ構文（`Group: a@example.com;`）、コメント、引用符付きのローカル部、ドメインリテラル（`a@[192.0.2.1]`）は拒否する
- アドレスは ASCII に限る（atext が ASCII だけのため、上の規則で満たされる）。Unicode の小文字化で見た目の異なるアドレスが同じ正規化値になるのを防ぐため。ログインで ASCII 以外を含む場合は形式不正と同じく扱う（6.4）
- 正規化はアドレス全体の小文字化

### 6.4 ログインの振る舞い

登録・ログインの入口では `Password.parse` を 1 回呼ぶ。解析失敗は登録時に `WeakPasswordError`（422）、ログイン時に `InvalidCredentialsError`（401）へ変換する。ログインの解析失敗ではユーザー検索や暗号計算を行わず、存在の有無を問わず同じ認証失敗を返す。登録の `hash` で最小長に違反した場合も `WeakPasswordError` とする。

1. メールアドレスを正規化してユーザーを検索する
   - 形式が不正な場合は 422 にせず、ユーザー不在と同じ扱いにする（2 へ進む）。形式チェックだけ速く返すと応答時間がずれるため
2. ユーザーが存在しなければ、**ダミーハッシュ**に対して `verify` を実行し、応答時間を揃える
   - ダミーハッシュは**起動時に現行パラメータで生成**する（ポリシーを満たすランダムな文字列を `Password.parse` で解析して `hash` し、`EncodedHash` として保持する）。古いパラメータのダミーを使うと、存在しないユーザーの方が応答が速くなり、列挙対策が崩れる。逆に、パラメータを引き上げた後は、まだ再ハッシュされていない既存ユーザーが旧パラメータで検証されるため、ダミーより速く応答する（7 章の既知の制限）
   - 保存済みの PHC は auth で `EncodedHash.parse` を 1 回呼び、以降の `verify` と `needsRehash` で同じ値を使う。解析失敗（`InvalidHashError`）ではダミーハッシュに対して `verify` を実行して応答時間を揃え、ロガーでエラーを出して 401 にする（ハッシュはログに出さない）。即座に失敗を返すと、応答時間から壊れた行の存在が分かるため。このダミー検証が `BusyError` で失敗した場合は、通常のログインと同じく `BusyError`（503）を投げる。負荷時は存在するユーザーでも同じ 503 になるため、応答から行の存在は分からない。PHC 異常の記録は auth の 1 回だけとし、`BusyError` は別の障害として 6.5 の規則で扱う
3. 失敗時のメッセージは、原因を問わず「メールアドレスまたはパスワードが正しくありません」に統一する
4. 成功時に `needsRehash` が true なら、再ハッシュして `password_credentials` を更新する
   - 解析済みの同じ `Password` を `rehash` に渡す。`rehash` は最小長を検査しないため、短い既存パスワードも移行できる。生成した `EncodedHash` は `phc()` で文字列へ変換して保存する。登録時は `hash` で同じ手順で保存し、`UserStore` の文字列の契約は維持する
   - 再ハッシュや保存に失敗しても認証自体は成功しているため、ロガーで警告を出して 200 を返す。次回ログイン時に再試行される。ただし、要求の `signal` の中断を原因とする失敗は警告を出さず、httpapi は 6.6 に従って応答を書かない

### 6.5 横断的な要件

| 項目 | 内容 |
|---|---|
| エラー形式 | RFC 9457（Problem Details、`application/problem+json`） |
| ログ | 1 件を 1 行の JSON（`time`・`level`・`msg` と属性）として `process.stdout` に書く小さなロガー。パスワードとリクエストボディは出力しない |
| ボディ上限 | 16 KiB（本文を読みながら数える） |
| サーバータイムアウト | 6.6 の値を設定 |
| 設定 | 環境変数 `DATABASE_PATH`（必須。未設定なら起動エラー）、`PORT`（任意、既定 8080） |

- `DATABASE_PATH` は未設定・空を起動エラーとする。絶対パス化したパスと、既存の DB または既存の親ディレクトリのリンク解決（`fs.realpath`）後のパスが `/mnt/c` またはその配下なら、DB 接続前に拒否する。パスの自動作成・権限変更・`~` 展開は行わない。所有者・権限・ファイル種別の検査は既存の保存層が担当する
- `PORT` は未設定・空なら 8080。それ以外は十進数字だけで表す 1〜65535 とし、符号や空白は拒否する
- `src/main.ts` は IPv4 の全インターフェース（`0.0.0.0`）で待ち受ける。WSL の IPv6 待ち受けから Windows の IPv4 への転送に依存せず、`127.0.0.1` で接続できるようにする。IPv6 では待ち受けない
- SIGINT・SIGTERM を受けたら `server.close()` で新しい接続の受け付けを止め、処理中の要求の完了を最大 30 秒待つ。期限を超えたら `server.closeAllConnections()` で残りの接続を閉じ、DB を閉じて終了する。起動失敗も DB を閉じて非ゼロで終了する

通常の予期しないエラーは httpapi で 1 回だけログに出す。6.4 の再ハッシュ失敗と保存済み PHC 異常は auth で記録する例外とし、httpapi は成功または通常の認証失敗として扱って重複記録しない。

### 6.6 サーバータイムアウト

| 設定 | 値 | 内容 |
|---|---|---|
| `headersTimeout` | 5 秒 | ヘッダーの受信の上限 |
| `requestTimeout` | 10 秒 | ヘッダーと本文を含む要求全体の受信の上限 |
| 応答の期限（自前） | 30 秒 | 要求の受信開始から応答の完了までの上限。超えたら応答を書かずに接続を破棄する（Go 実装の `WriteTimeout` にあたる） |
| `keepAliveTimeout` | 60 秒 | 応答後に次の要求を待つ上限 |
| `connectionsCheckingInterval` | 1 秒 | `headersTimeout`・`requestTimeout` を検査する間隔。既定の 30 秒では、上の値が 30 秒単位でしか効かない |

- 要求ごとに、応答期限の `AbortSignal.timeout(30_000)` と、クライアントの切断で中断する `signal` を作り、`AbortSignal.any` でまとめて auth に渡す。元の `signal` も保持し、応答期限とクライアント切断を区別できるようにする
- クライアントが切断したら応答を書かない。応答期限を超えたら応答を書かずに接続を破棄する。これらは、auth が成功を返した場合や `BusyError` を包んでいない中断理由を投げた場合も、6.1・6.2 の応答や 6.4 の再ハッシュ失敗時の 200 より優先する。中断を原因とするエラーは予期しないエラーや再ハッシュ失敗の警告として記録しない
- セマフォ待機タイムアウトと SQLite の busy timeout は、要求の `signal` を中断しない。これらによる `BusyError` が httpapi まで伝播し、要求が中断されておらず応答を書ける場合は 503 を返す。認証成功後の再ハッシュ中の失敗は、6.4 の規則に従う
- 応答の期限は、1 リクエストで起こりうる最長の待ち時間より長くする。最長になるのは再ハッシュを伴うログインで、セマフォ待機（最大 5 秒）とハッシュをそれぞれ 2 回（`verify` と再ハッシュ）、ストアへのアクセスを 2 回（読み込みと更新。busy timeout で各最大 5 秒）行う。待機だけで最大 20 秒になり、そこへ競合で遅くなったハッシュ 2 回分（Go 実装の `BenchmarkHashSaturated` で 1 回約 1 秒。TS 実装で再測定する）が加わるため、合計は約 22 秒になる。30 秒なら、ハッシュ 1 回が 5 秒かかるまで収まる。これより短いと、503 などの応答を書く前にサーバーが接続を破棄する

### 6.7 テスト

- 登録とログインの処理（ダミーハッシュの経路、再ハッシュ、エラーの統一）は、`auth` のテストで偽 `UserStore` を使って検証する
- ハンドラのテストは、ポート 0 で実際に起動した `http.Server` へ `fetch` で要求を送り、ステータスコードと Problem Details の形を検証する
- クライアント切断時と応答期限超過時は応答を書かないこと、セマフォ・DB の待機タイムアウトが伝播した場合は 503、認証成功後の再ハッシュ失敗は要求を継続できる場合に 200 になることを分けて検証する
- モジュールごとのテスト方法は [architecture.md](architecture.md) の「テスト」を参照

### 6.8 Web 画面

- `GET /` で日本語の登録・ログイン画面を返す。`src/httpapi/web/` の `index.html`・`app.css`・`app.js` の 3 ファイルだけを、ハンドラの生成時にメモリへ読み込んで配信する。読み込みに失敗したら起動エラーにする
- 配信するパスは `GET /`・`GET /assets/app.css`・`GET /assets/app.js` だけとする。各パスは `HEAD` にも対応し、それ以外のメソッドは既存と同じ Problem Details の 405 を返す。未知のパスは 404 とし、ディレクトリ一覧は配信しない
- HTML・CSS・JavaScript は標準のブラウザー機能だけを使い、別の開発サーバー、ビルドツール、外部ライブラリは追加しない。Web 画面と API は同じオリジンとし、API を相対 URL で呼ぶ
- 登録・ログインの切り替え、パスワードの表示切り替え、処理中の重複送信防止、成功・失敗の表示、`GET /healthz` による接続確認と再確認を提供する。成功時は `user_id` を画面に表示する。ヘルスチェックは HTTP サーバーへの疎通だけを示す
- メールとパスワードの意味的な検証は API に任せる。ブラウザーの文字数制限で NFKC 後の判定や短い既存パスワードのログインを妨げない。メール欄は `type="email"` の値の書き換え（国際化ドメインの punycode 化など）を避けるため `type="text"` とし、入力をそのまま送る。エラーの表示にはテキストを使い、サーバーの応答を HTML として解釈しない
- パスワードは JSON の本文で送信し、URL・ログ・Web Storage には保存しない。要求の終了後はパスワード欄を消去する。Cookie やトークンは使わず、ログイン状態を維持しない。JavaScript が無効な場合は送信フォームを表示しない
- API・Problem Details を含むすべての応答に `Cache-Control: no-store` と `X-Content-Type-Options: nosniff` を付ける。静的ファイルには正しい UTF-8 の Content-Type を付ける。Content Security Policy は同じオリジンのスクリプト・スタイル・通信だけを許可し、フォームによる画面遷移、フレームへの埋め込み、base URL の変更を禁止する
- Windows のブラウザーから IPv4 の `http://127.0.0.1:8080/` を開いて登録・ログインを確認する。Android アプリは今回の対象に含めない

## 7. 既知の制限（README に明記する）

- 登録 API は重複時に 409 を返すため、**メールアドレスが登録済みかどうかを第三者が確認できる**（ユーザー列挙）
- ペッパー、レート制限、トークン発行がないため、本番利用には適さない
- パラメータを引き上げた後、まだ再ハッシュされていない既存ユーザーは旧パラメータで検証されるため、存在しないユーザー（ダミーハッシュ）より速く応答する。該当ユーザーが次に正しくログインして再ハッシュされるまで、応答時間から登録済みかどうかを推測できる
- `node:sqlite` の API は同期のため、SQLite が他のプロセスのロックを待っている間（busy timeout の最大 5 秒）は、イベントループが止まり、すべての要求の処理が止まる。この間は要求の `signal` の中断も効かない
- `open` の接続初期化でも、PRAGMA がロックを待っている間はイベントループが止まり、`signal` の中断も効かない。再試行の開始期限は 5 秒だが、期限直前に始めた 1 回の接続処理がロックを待つと、`open` 全体はその待機時間だけ長くなる
- 他のプロセスの書き込みが続いて、ロック待ちが 5 秒を超えた登録やハッシュ更新は 503 になる
- NFKC の安定性が保証されるのは割り当て済みの文字だけである。Node が同梱する ICU の Unicode 表で未割り当ての文字を含むパスワードは、Node の更新でその文字に分解が定義されると正規化の結果が変わり、正しいパスワードでもログインできなくなる
- 認証なしの要求で Argon2id の同時計算枠（4 つ）を埋められる。登録・ログインの要求が続くと、ほかの利用者の要求が待機切れで 503 になり、ログインの試行回数にも上限がない（レート制限はスコープ外）
- `DATABASE_PATH` の起動時検査が拒否するのは `/mnt/c` とその配下だけである。ほかのドライブ（`/mnt/d` など）、`/etc/wsl.conf` で automount の root を変えた場合、Windows 側のパスのバインドマウントは検出しない
- 正常終了の期限（30 秒）を超えて残った処理（Argon2id の計算の完了待ちなど）は、接続を閉じた後も動き続けることがあり、DB を閉じた後のアクセスが失敗してログを出す。書き込みは SQLite のトランザクションで守られる
- 不正な要求の行・ヘッダーと、`headersTimeout`・`requestTimeout` の超過には Node が 400・408 を返すため、Problem Details の形にならない
- サーバーは IPv4 の全インターフェースで待ち受けるため、WSL の仮想ネットワーク（mirrored モードでは LAN）からも登録・ログイン API と Web 画面に届く
- API は Content-Type を必須にせず、Origin・Host も検査しない。サーバーの起動中に利用者が開いた別のサイトから、`text/plain` の POST で登録やログインの要求を送れる（応答は読めないが副作用は起きる）。DNS リバインドを使えば応答も読める

## 8. 開発環境

- Node.js 26 は WSL（Ubuntu 24.04）に nvm でインストールする。Windows 側にほかの用途の Node が入っていても、このプロジェクトでは使わない。WSL の非対話シェルでは nvm を明示的に読み込む（development.md）。プロジェクトは Windows 側のフォルダに置き、WSL から `/mnt/c` 経由で実行する
- DB は SQLite のファイル 1 つで、別途サーバーを起動する必要はない
- SQLite のファイルは `/mnt/c` 配下ではなく、WSL 側のファイルシステム（例：`~/.local/share/auth-server/auth.db`）に置く。`/mnt/c` はファイルロックや WAL の共有メモリが正しく動かないことがあるため
- `*.db`、`*.db-wal`、`*.db-shm`、`*.db-journal`、`node_modules/`、`coverage/` は `.gitignore` に入れる
- `open` は親ディレクトリを作らないため、DB を置くディレクトリは事前に所有者専用で作っておく（例：`mkdir -p -m 700 ~/.local/share/auth-server`）。既存のディレクトリは `chmod 700`、既存の DB と関連ファイルは `chmod 600` で所有者専用にしてから起動する
- Windows のブラウザーから `http://127.0.0.1:8080/` に接続する。WSL のローカルホスト転送と接続できない場合の切り分けは README に記載する

## 9. 完了条件

- `npm run typecheck`（`tsc --noEmit`）、`npm run lint`（`eslint .`）、`npm run format:check`（`prettier --check .`）、`npm test`（`vitest run`）が通る
- GitHub Actions の CI（`.github/workflows/ci.yml`）で型検査・静的検査・整形確認・全テスト・カバレッジレポートが通る。同じリポジトリの PR ではカバレッジ用のコメントを 1 件作り、Coverage ジョブの再実行時に更新する。実行条件と出力は development.md の「CI」を正本とする
- CodeQL（`.github/workflows/codeql.yml`）で JavaScript/TypeScript の解析と結果のアップロードが成功する。実行条件と出力は development.md の「CI」を正本とする
- Dependabot（`.github/dependabot.yml`）の npm の設定が `main` に入った後、development.md の「依存関係の更新」にある設定の確認を行い、npm の最初の更新 PR が作られることを確認する。設定と運用は development.md の「依存関係の更新」を正本とする
- `npm run bench`（`vitest bench --run src/password`）でハッシュ 1 回の所要時間が出て、TS 実装の測定結果を 4.7 に記録している
- README に起動手順、curl による登録・ログイン例、Windows のブラウザーからの利用方法と WSL への接続の切り分けがある
- Windows から WSL 上のサーバーへ疎通でき、Web 画面で登録・ログイン・重複登録・誤パスワードの応答を確認できる
- Go 実装のコード（`cmd/`、`internal/`、`go.mod`、`go.sum`）と Go 用の CI・CodeQL・Dependabot の設定が削除されている

## 10. 作業手順

Go 実装を動かしたまま、TS 実装を `src/` に段階的に作り、仕様をすべて満たしてから Go 実装を削除する。

1. 土台を作る：`.nvmrc`（`26`）、`.npmrc`（`engine-strict=true`）、`package.json`（`engines.node` に `>=26.11.0 <27`）、`package-lock.json`、`tsconfig.json`、`vitest.config.ts`、`eslint.config.js`、`.prettierignore`、`.gitignore`。TS 用の CI ジョブ、CodeQL の JavaScript/TypeScript の解析、Dependabot の npm の設定を Go 用の設定と並べて追加する。型検査・静的検査・テスト・カバレッジの対象が空のまま CI が失敗しないよう、依存の無い `src/errors.ts` とそのテストもこの段階で作る。Vitest の `passWithNoTests` は使わない
2. password を実装し、テストを通す。ベンチマークで既定パラメータを確認し、結果を 4.7 に記録する
3. DB（init.sql、store/sqlite）を実装し、テストを通す
4. auth と API（httpapi、config、log、main）を実装し、テストを通す。httpapi は生成時に Web 画面のファイルを読み込むため（6.8）、この段階の最初に `internal/httpapi/web/` の 3 ファイルを内容を変えずに `src/httpapi/web/` へコピーし、配信のテストもこの段階で書く。Go の `internal/httpapi/static.go` が `go:embed` で元のファイルを参照しているため、移動はしない
5. Windows のブラウザーから TS 実装のサーバーへ実際に接続し、Web 画面で登録・ログイン・重複登録・誤パスワードの応答を確認する
6. README を TS 実装の手順に書き換える
7. Go 実装を削除する。対象は `cmd/`、`internal/`（`internal/httpapi/web/` を含む）、`go.mod`、`go.sum`、`.github/actions/setup-go/`、`ci.yml` の Go 用のジョブ、`codeql.yml` の `go` の解析、`dependabot.yml` の `gomod` と `/.github/actions/setup-go` の確認先、development.md の「Go 実装（移行完了まで）」の節、tech-stack.md の「Go 実装で使っていたもの」の節
8. 9 章の完了条件のうち、移行のブランチで確かめられるものをすべて確認する。Dependabot の npm の最初の更新 PR だけは、設定が `main` に入った後の週次実行で確認する

手順 1 の後は、各段階で TS 用の CI と CodeQL も通ってから次へ進む。Go 用の CI は手順 7 まで残し、Go 実装を壊さない。手順 4 から 7 までの間は、Web 画面の 3 ファイルが 2 か所にある。2 か所の内容は一致させ（`diff -r internal/httpapi/web src/httpapi/web` が差分なしで終わる）、この間に画面を変える場合は両方に同じ変更を入れる。`src/httpapi/web/` は Prettier・ESLint・カバレッジの対象から外す（development.md）。

各段階でテストが通ってから次へ進む。不明点や本書と矛盾する点があれば、推測で進めず質問する。

## 11. 決定事項（v0.4 の未決事項を確定）

| # | 論点 | 決定 | 反映先 |
|---|---|---|---|
| 1 | モジュールパスとフォルダ名 | フォルダは `auth-server`（改名済み）。npm のパッケージ名も `auth-server` | 3 章 |
| 2 | password の API の形 | `Hasher.create(params)` で設定を検証し、メソッドで提供 | 4.4 |
| 3 | ログイン時のポリシー適用 | `Password.parse` で NFKC 正規化・不正な文字列・最大長を検査し、`verify` では最小長を検査しない | 4.4 |
| 4 | 文字数の数え方 | NFKC 正規化後の Unicode コードポイント数 | 4.5 |
| 5 | セマフォ待機タイムアウト | 5 秒（設定可能）。タイムアウト時は 503 | 4.2、4.6、6.2 |
| 6 | エラー時のステータス | JSON 不正 400、ポリシー違反 422、ボディ上限超過 413 | 6.2 |
| 7 | メールアドレスの形式チェック | 6.3 の dot-atom 形式で解析でき、表示名を含まない | 6.3 |
| 8 | UUID の生成元 | アプリ側で `crypto.randomUUID()`（v4） | 5.2 |
| 9 | テスト方法 | DB は一時ディレクトリの SQLite、auth と API は偽 `UserStore` | 5.5、6.7 |
| 10 | 不正な PHC と `needsRehash` | `EncodedHash.parse` が解析エラーを投げる。`needsRehash` は非正規の表記で `true` を返す | 4.4 |
| 11 | `DATABASE_PATH` 未設定 | 起動エラー | 6.5 |
| 12 | ログイン時のメールアドレス形式不正 | ユーザー不在と同じ扱い（ダミー `verify` → 401） | 6.2、6.4 |
| 13 | ログイン時の再ハッシュ失敗 | 警告ログを出し、応答を書ける場合に 200。中断を原因とする失敗は警告を出さず、中断時の応答は 6.6 を優先する | 6.4、6.6 |
| 14 | サーバータイムアウト値 | ヘッダー 5 秒、要求全体 10 秒、応答の期限 30 秒、keep-alive 60 秒 | 6.6 |
| 15 | DB の書き込みロック待機の打ち切り | `BusyError`（503）。接続は 1 つ | 5.4、6.2 |
| 16 | 言語と実行環境 | TypeScript、Node.js 26 系の 26.11.0 以上（2026-10-28 に LTS へ移行する予定）。Next.js などのフレームワークは使わない | 3 章 |
| 17 | 暗号と DB の実装 | Node 標準の `crypto.argon2` と `node:sqlite`。外部パッケージに依存しない | 4.1、5.1 |
| 18 | テスト | Vitest。Vite は使わない | 4.7、6.7 |
| 19 | 移行の進め方 | 同じリポジトリで TS 実装を `src/` に作り、仕様をすべて満たしてから Go 実装を削除する | 10 章 |
| 20 | 静的検査と整形 | ESLint（typescript-eslint の `strictTypeChecked`）と Prettier。Biome は使わない | 9 章、10 章 |

## 変更履歴

- v0.24：PR #14 のレビューを反映。セマフォ・DB の待機タイムアウトによる 503 と、クライアント切断・応答期限超過による応答なしの扱いを分け、要求の中断時は成功応答や再ハッシュ失敗時の 200 より優先することを明記。Argon2id 以外の非同期スレッドプール処理を要求時に採用する場合だけ、飽和時の待ち時間も測定する
- v0.23：バックエンドを Go から TypeScript（Node.js 26 系の 26.11.0 以上）へ移行する方針に改訂。Argon2id・SQLite・UUID・正規化を Node 標準の API に置き換え、外部の実行時依存をなくした。値オブジェクトの伏字を private フィールドと `util.inspect.custom` で行い、Go のゼロ値に関する契約を削除。`ctx` を `AbortSignal` に、エラーを `cause` 付きのクラスに置き換えた。保存済み PHC のソルトの下限を 8 バイトに変更。「不正な UTF-8」の拒否をペアになっていないサロゲートの拒否に置き換えた。JSON の項目名を大文字小文字を区別する照合に変更。メールアドレスの受理形式を dot-atom として明記し、ドメインリテラルを拒否する。SQLite を 1 接続の同期 API とし、イベントループが止まる制限を追記。SQLite のエラーは `code` と数値の `errcode` がそろう場合だけ判定し、それ以外は予期しないエラーとする。Argon2id の飽和時にイベントループの遅延も測る。サーバータイムアウトを Node の設定に対応させ、Node が自動で返す 400・408 を既知の制限に追記。テストを Vitest に変更。静的検査に ESLint（typescript-eslint）、整形に Prettier を採用。Go 実装の性能測定の結果は記録として残し、TS 実装で再測定する。移行の作業手順を追加。Node は WSL に nvm で入れ、Windows 側の Node は使わない。対象外の Node での `npm ci` を `.npmrc` の `engine-strict=true` で失敗させる。作業手順では、Web 画面のファイルを httpapi の段階（手順 4）で移動せずにコピーし、移行中は Go 実装と内容を一致させる。土台の段階（手順 1）で `src/errors.ts` とそのテストを作り、CI の対象を空にしない。Go 実装の削除対象を列挙し、完了条件の確認を Go 実装の削除後の手順 8 に置く
- v0.22：同じ Go サーバーから配信する最小の Web 画面を追加。静的ファイルの配信、入力と結果の表示、パスワードの扱いを確定。WSL から Windows の IPv4 への転送のため IPv4 の待ち受けを明示。Android の接続案内を Windows のブラウザーからの利用・実接続確認へ置き換え。コードレビューを反映し、すべての応答への no-store・nosniff、メール欄の `type="text"`、待ち受け範囲と別サイトからの要求を既知の制限に追記
- v0.21：メールアドレスを ASCII に限定。401 に `WWW-Authenticate` を付けない理由を明記。既知の制限に、Argon2id の同時計算枠の枯渇、`/mnt/c` 以外の Windows ドライブを検出しないこと、正常終了の期限切れ後のハンドラと DB の後始末を追記
- v0.20：コードレビューの指摘を反映。メールアドレスはグループ構文・コメント・引用符付きのローカル部を拒否し、`users.email` には解析したアドレスを保存する。リクエストの `ctx` の取り消し・期限切れを 503 に統一して記録しない。本文の読み込み失敗に専用の `detail` を返し、authority 形式の CONNECT も Problem Details の 404 にする
- v0.19：登録成功時の user_id、JSON 入力の必須項目・未知項目・本文上限・標準デコード動作、404・405 を含む Problem Details を確定。設定の検証、リンク解決を含む /mnt/c の起動時拒否、サーバーの待ち受けと終了処理を確定
- v0.18：Dependabot による依存更新をスコープ、完了条件、作業手順に追加。設定と運用は development.md の「依存関係の更新」を正本とする
- v0.17：Go の CodeQL 解析をスコープ、完了条件、作業手順に追加。実行条件と出力は development.md の「CI」を正本とする
- v0.16：同じリポジトリの PR にカバレッジコメントを表示し、Coverage ジョブの実行ごとに同じコメントを更新する。計測に失敗した場合は失敗表示に更新し、古い実行結果で新しい結果を上書きしない。実行サマリーと artifact の保存も継続する
- v0.15：GitHub Actions による CI（Lint、全テスト、レース検出、カバレッジレポート）をスコープ、完了条件、作業手順に追加。実行条件と出力は development.md の「CI」を正本とする。v0.13 は `feature/ci` で仮に使っていた番号で、`develop` へのマージ順に合わせて振り直したため欠番
- v0.14：PR #6 のレビューを反映。SQLite 接続前に親ディレクトリと既存 DB・関連ファイルの所有者と権限を検査し、シンボリックリンクを拒否する。新規 DB は `0600` で排他的に作成し、既存の権限やプロセス全体の umask は自動変更しない。初回接続の `SQLITE_BUSY` では接続プールを破棄し、10ms 間隔・開始期限 5 秒・`ctx` の取り消しに従って再試行する。ドライバのロック待機中は取り消せない制限も明記
- v0.12：SQLite 永続化の契約を確定。初期化 SQL を `internal/store/sqlite/init.sql` に配置し、同じパッケージから埋め込む。接続プールの所有と解放、空パスの拒否、親ディレクトリを作成しないこと、パスの URI エスケープを明記。メール重複と ID 重複を区別し、ハッシュ更新時の `changed_at` 更新と対象なしの `ErrUserNotFound` を確定。コードレビューの指摘を反映し、`SQLITE_BUSY` の `auth.ErrBusy`（503）への変換、失敗時に `ctx` のエラーを包むこと、`Open` での WAL の確認、絶対パス化とその理由、Linux 形式のパスの前提、`Store` のゼロ値を扱わないことを追記。接続プールに上限を設けないことと、ロック待ちに関する既知の制限を追記
- v0.11：コードレビューの指摘を反映。両型に `fmt.Formatter` を実装し、秘密を関数値の奥に置いて、全書式と非公開フィールドでの伏字を保証。`Password` を `==` で比較できないようにした。ゼロ値の `Password` は `ErrInvalidPassword` に分離。最小長を検査しない `Rehash` を追加し、短い既存パスワードも再ハッシュできるようにした。`NeedsRehash` は非正規の表記で `true`、ゼロ値と無効な `Hasher` で `false` に変更。nil の `Hasher` をゼロ値と同じく扱う。6.2 の 401 に不正な UTF-8 を追記し、6.4 に保存済み PHC 異常時のダミー検証が `ErrBusy` になった場合の扱いを追記
- v0.10：Go のコーディング方針を文書化。`Password`・`EncodedHash` と公開コンストラクタを導入し、Hash・Verify・NeedsRehash を型付き API に変更。正規化と入力検証を境界へ移し、ゼロ値・伏字・明示的な PHC 取得の契約を確定。auth のエラー変換と保存処理を追随させ、ログ記録の例外とベンチマークの測定範囲を明記
- v0.9：コードレビューの指摘を反映。生成設定のソルト長の下限を 16 バイトに変更。PHC の先頭が 0 の値と、不正な UTF-8 のパスワードを拒否。ゼロ値の `Hasher` は `ErrInvalidParams`、`ctx` による打ち切りの `ErrBusy` は `ctx.Err()` も包むよう変更。4.6 の制限を枠数として書き直し、メモリの最悪値を明記。保存済みハッシュ不正時のログインの扱いを追記。6.6 の見積もりを再ハッシュ込みに直し、`WriteTimeout` を 30 秒に変更。ベンチマークに飽和時と候補の計測を追加し、飽和時の測定結果を記録。既知の制限（パラメータ引き上げ後の応答時間差、未割り当て文字の正規化）を追記
- v0.8：password の設定構造体と `DefaultParams()`、設定検証・エラーを確定。`New` に error を追加。生成設定と PHC の固定範囲、PHC の解析規則、再ハッシュ比較項目、キャンセルとセマフォ解放、性能調整の手順と測定結果を追記。採用値を 128 MiB・反復 9・並列 2 に調整
- v0.7：architecture.md（3 層構成）に合わせ、ディレクトリ構成に `internal/auth` を追加。テスト方針と作業手順を auth 層前提に修正
- v0.6：ログイン時のメールアドレス形式不正を 401 に統一。再ハッシュ失敗時の扱いを追記。サーバータイムアウト値を確定（6.6）。フォルダ改名済みを反映
- v0.5：Hash の処理順を「正規化 → ポリシー検査」に修正。Verify にも NFKC 正規化と最大長検査を追加。PRAGMA を DSN 指定に変更し `_txlock=immediate` を追加。ダミーハッシュを起動時に現行パラメータで生成する旨を追記。未決事項を確定し本文に反映。フォルダ名を `auth-server` に統一
