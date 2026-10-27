# パスワードのモデルと Provider

機能仕様の正本とする。設計全体の入口は [design.md](../design.md)、配置と依存は [architecture.md](../architecture.md)を参照する。

## 使用ライブラリ

すべて Node.js の標準モジュールを使い、外部パッケージに依存しない。

| 用途 | API |
|---|---|
| Argon2id | `node:crypto` の `argon2`（非同期版。暗号処理の自前実装は禁止） |
| ソルト生成 | `node:crypto` の `randomBytes`（`Math.random` は使用禁止） |
| 比較 | `node:crypto` の `timingSafeEqual` |
| 正規化 | `String.prototype.normalize('NFKC')` |

- 非同期 Argon2id の実行経路の調査根拠は [性能測定と調査記録](../password-benchmarks.md#node-の実行経路)を参照する
- 同期版の `argon2Sync` は計算中にイベントループを止めるため使わない

## パラメータ

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

type Cost = Pick<Params, "memoryKiB" | "iterations" | "parallelism">;
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
- 採用値は [Go の性能調整結果](../password-benchmarks.md#go-tuning-2026-10-18)で決めた値を出発点とし、TS 実装で再測定して 1 回 200〜500ms 程度に収まるか確認する
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
- 不正な生成設定は `Argon2PasswordProvider.create` が `InvalidParamsError` を投げる。保存済み PHC の範囲外の値は `InvalidHashError` とする
- memory・iterations・parallelism・出力長の下限は RFC 9106 の入力条件に従う。生成設定のソルト長の下限は RFC 9106 の推奨値 16 バイトとする。保存済み PHC のソルトの下限は、Node の `argon2` が nonce に要求する 8 バイトとする（Go 実装では 1 バイト以上を受理していた）

## 保存形式

```
$argon2id$v=19$m=131072,t=9,p=2$<salt>$<hash>
```

salt と hash は base64（パディングなし。標準のアルファベット `A-Z a-z 0-9 + /`）。

- アルゴリズムは `argon2id`、バージョンは `19` に限る
- パラメータは `m`・`t`・`p` がそれぞれ 1 回ずつ必要。解析時の順序は問わないが、生成時は `m,t,p` の順にする
- 不足・重複・未知の項目、数字以外を含む値、先頭が 0 の値、安全な整数の範囲を超える値、[パラメータ](#パラメータ) の範囲外の値を拒否する。数値は `^(0|[1-9][0-9]*)$` に一致することを確かめてから変換する
- ソルトと出力の符号化後の長さを検査してからデコードする。パディング、不正文字、改行、不正な末尾ビット、空要素を拒否する
- `Buffer.from(s, 'base64')` は不正文字を読み飛ばし、末尾ビットも検査しない。そのため、文字種を正規表現で検査し、デコード結果をパディングなしで再エンコードした文字列が入力と一致することを確かめる
- `EncodedHash.parse` が PHC を 1 回だけ解析する。`verify` と `needsRehash` は、その解析済みの値を使う

## 公開契約

状態（パラメータ・セマフォ）を持つハッシュ処理は、`PasswordProvider` インターフェースと、それを実装する `Argon2PasswordProvider` で提供する。`Password`・`EncodedHash`・`Params`・`Cost` は `models/` に置く。外部の文字列はサービスの入口で値オブジェクトに解析し、内側ではその型を使う。

```ts
function defaultParams(): Params;

class Password {
  static parse(raw: string): Password;
}

class EncodedHash {
  static parse(encoded: string): EncodedHash;
  phc(): string;
}

interface PasswordProvider {
  hash(password: Password, signal: AbortSignal): Promise<EncodedHash>;
  rehash(password: Password, signal: AbortSignal): Promise<EncodedHash>;
  verify(password: Password, encoded: EncodedHash, signal: AbortSignal): Promise<boolean>;
  needsRehash(encoded: EncodedHash): boolean;
}

class Argon2PasswordProvider implements PasswordProvider {
  static create(params: Params): Argon2PasswordProvider;
  // PasswordProvider の各メソッドを実装する
}
```

| メソッド | 振る舞い |
|---|---|
| `Password.parse(raw)` | 不正な文字列の検査 → NFKC 正規化 → 最大 128 文字の検査 → `Password`。最小長は検査せず、空文字や短い既存パスワードも受理する。違反時は `PolicyViolationError` |
| `EncodedHash.parse(encoded)` | [保存形式](#保存形式) の規則で PHC を解析 → `EncodedHash`。異常時は `InvalidHashError` |
| `EncodedHash.phc()` | 保存用の PHC 文字列を返す。解析した PHC は元の表記を保持する |
| `hash(password, signal)` | 最小 12 文字の検査（`PolicyViolationError`）→ セマフォ取得 → ソルト生成 → Argon2id → 正規の PHC を持つ `EncodedHash` |
| `rehash(password, signal)` | ログイン成功後の再ハッシュ用。最小長を検査しない点を除き `hash` と同じ。短い既存パスワードも現行パラメータへ移行できる。登録には使わない |
| `verify(password, encoded, signal)` | セマフォ取得 → 解析済みの保存パラメータとソルトでハッシュ → 定数時間比較。不一致は `false` |
| `needsRehash(encoded)` | memory・iterations・parallelism・ソルト長・出力長のいずれかが現行設定と異なるか、保存済みの表記が正規の表記（`m,t,p` の順）と異なれば `true`。同時数と待機時間は比較しない |

- `Params` は設定を組み立てるための入力であり、公開プロパティを維持する。`Argon2PasswordProvider.create` は設定を検証し、値のコピーとセマフォを保持する。コンストラクタは公開せず、生成経路を `create` に限る
- `Password` と `EncodedHash` のコンストラクタも公開せず、生成経路を `parse` と `PasswordProvider` の戻り値に限る。値は private フィールド（`#`）に保持し、変更可能な内部データ（`Buffer` など）は公開しない。`===` は参照の比較であり、値の比較には使わない。解析済みの空文字は有効な `Password` である
- 生成済みのハッシュも再解析せず、`EncodedHash` で返す
- 両クラスは `toString()`・`toJSON()`・`[util.inspect.custom]` で固定文字列 `[REDACTED]` を返す。テンプレートリテラル、`JSON.stringify`、`console.log`・`util.inspect`（別のオブジェクトのプロパティに入れた場合も含む）で中身が出ないようにする。PHC の保存には `phc()` を明示的に使う
- エラーは `InvalidParamsError`（生成設定）、`PolicyViolationError`（パスワードの解析・`hash` の最小長。利用者の入力の違反に限る）、`InvalidHashError`（PHC の解析）、`PasswordBusyError`（セマフォ待機の打ち切り）とする。いずれも `Error` を継承したクラスで、文脈を付けて包む場合は `cause` に元のエラーを入れ、`cause` をたどって判定できるようにする
- `hash`・`rehash`・`verify` は、**同じ `Password.parse` で正規化した値**を使い、正規化や最大長の検査を繰り返さない。不正な文字列と最大長超過は解析時の `PolicyViolationError` となり、`AuthService` がログイン時の認証失敗へ変換する
- `verify` と `rehash` では最小長を検査しない（ポリシーを後から強化しても、既存ユーザーがログインできなくなったり、現行パラメータへ移行できなくなったりするのを防ぐ）
- セマフォの待機は `signal` の中断とタイムアウト（既定 5 秒）で打ち切り、いずれも `PasswordBusyError` を投げる。`signal` による打ち切りでは `cause` に `signal.reason` を入れ、クライアントの切断や期限切れを過負荷と区別できるようにする。中断済みの `signal` では、空き枠があっても計算を開始しない
- パスワードと PHC をログやエラーメッセージに含めない

## パスワードポリシー

- NFKC 正規化した後の **Unicode コードポイント数**（文字列のイテレーターで数える。UTF-16 のコード単位数の `length` は使わない）で長さを判定する
- 最小 12 文字、最大 128 文字
- 文字種の組み合わせは強制しない
- JavaScript の文字列は UTF-16 のため、Go 実装の「不正な UTF-8」の拒否は、ペアになっていないサロゲートを含む文字列の拒否（`String.prototype.isWellFormed()` が `false`）に置き換える。HTTP の本文の不正な UTF-8 は、デコード時に U+FFFD へ置き換わる（[エンドポイント](api.md#エンドポイント)）。JSON のエスケープ（`"\ud800"`）で入ったペアになっていないサロゲートは、ここで拒否する
- `Password.parse` が不正な文字列と最大長超過を `PolicyViolationError` で拒否し、`hash` が最小長を検査する。`verify` と `rehash` は解析済みの短い値や空文字も扱える

## 同時実行制限

- セマフォで同時に計算するハッシュの数を 4 に制限する（`hash` と `verify` の両方に適用）。Node に標準のセマフォは無いため、待ち行列を持つ小さなクラスを自前で実装する
- 制限するのは枠数であり、メモリ量ではない。1 回あたりのメモリは採用値で 128 MiB（4 並列で 512 MiB）だが、`verify` は保存済み PHC のパラメータで計算するため、最悪で 1 回 256 MiB（[パラメータ](#パラメータ) の上限）、4 並列で 1 GiB になる
- 待機がタイムアウトしたら `PasswordBusyError` を投げる。`AuthService` が業務の `BusyError` に包み、エラーハンドリング Middleware が要求を継続できる場合に 503 へ変換する
- 同じ `Argon2PasswordProvider` の `hash` と `verify` はセマフォを共有する。Argon2id の計算開始後は中断せず、完了まで枠を保持し、`finally` で必ず解放する
- 同時数の 4 は、同時に計算する Argon2id の件数の上限とし、アプリが同時に使用するメモリと CPU を間接的に制限する。1 件の計算の `parallelism` は計算チェーン（lane）の数を示す（[Node 26.12.1 の API 定義](https://github.com/nodejs/node/blob/v26.12.1/doc/api/crypto.md#L3439-L3440)）。OS スレッド数と CPU 使用量は Node.js・OpenSSL・実行環境に依存するため、同時数 × `parallelism` をスレッド数の上限として扱わない。保存済み PHC の上限 p=16 を CPU 容量や応答期限の見積もりに使う場合は、その条件で別途測定する。同時数は `UV_THREADPOOL_SIZE` と独立した設定であり、プールのサイズを変更しても自動では変えない。確認した Node の実装では libuv を共有するため、別のスレッドプール処理への影響は [テストと性能調整](#テストと性能調整) の測定で確認する。静的ファイルの読み込みは起動時に済ませる。非同期版の `randomBytes` などを要求の処理で採用する場合は、その待ち時間も測る

## テストと性能調整

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
| セマフォ | 同時数を超えた呼び出しがタイムアウトで `PasswordBusyError` になる。中断済みの `signal` で計算を開始しない。Argon2id の計算中は枠を保持し、終了後に解放する |
| ベンチマーク | `hash`（既定のパラメータ）、`hash saturated`（既定のパラメータで同時ハッシュ数いっぱいに並列実行したときの 1 回あたりの所要時間）、`hash candidates`（下記の候補）。`vitest bench` で計測 |
| イベントループ遅延 | 既定のパラメータで同時ハッシュ数いっぱいに並列実行している間、`node:perf_hooks` の `monitorEventLoopDelay` でイベントループの遅延を測る。遅延の最大値が 1 回のハッシュの所要時間より十分に小さく（目安は 50ms 未満）、計算中も他の処理が止まらないことを確かめる |
| スレッドプール待ち | 非同期版の `randomBytes` など、要求の処理で Argon2id 以外の libuv スレッドプール処理を採用する場合だけ、同時ハッシュ数いっぱいの状態で、その処理の開始から完了までの時間を測る。対象となる処理が無ければ測定は不要とする。`monitorEventLoopDelay` とは別に測り、スレッドプールのキュー待ちによる遅延を確かめる |

- 単体テストは小さい計算パラメータを使う。セマフォのテストはテスト側で枠を占有し、Vitest の偽タイマーで待機時間を進めて、重い計算の実行時間に依存させない
- コマンドの現在の参照先と移行時の変更は [開発ガイド](../development.md#コマンド)に従う。ベンチマークは WSL の Node 26 で `npm run bench`（`vitest bench --run src/providers/password`）を 3 回実行し、各回の平均の中央値を使う
- TS 実装ではまず既定値（128 MiB・反復 9・並列 2）の `hash` を測り、中央値が 200〜500ms に入るか確認する。入れば既定パラメータは変更しない
- 目標から外れた場合は、64 MiB と 128 MiB の反復 2〜10 を候補として測る。候補に入る設定が無ければ、速すぎる場合は 128→256 MiB、遅すぎる場合は 32→19 MiB の順に評価する。最初に目標に入るメモリ設定で、中央値が 300ms に最も近い反復数を採用する。同差なら反復数が多い方を採用する
- 採用値を本書へ、測定結果を [性能測定と調査記録](../password-benchmarks.md)へ記録してから `defaultParams()` を変更する。候補内で目標を達成できなければ、未達を報告し、次段階へ進む前に調整方針を確認する
