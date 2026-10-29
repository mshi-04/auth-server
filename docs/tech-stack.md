# テックスタック

採用技術と、その理由をまとめる。機能仕様の一覧は [design.md](design.md#文書の正本と読む順序) を参照。プロジェクトのフォルダ名と npm のパッケージ名は `auth-server` とする。依存パッケージのバージョンは、実装後は `package.json` と `package-lock.json` を正本とする。Node のメジャーバージョンは `.nvmrc` を正本とし、`package.json` の `engines.node`（`>=26.11.0 <27`）は対象外の版で動かしていないかの検査に使う。

本書は現在の採用方針を示す。構成と責務は [アーキテクチャ](architecture.md#現状と移行先)、起動・ベンチマークの実行方法は [開発ガイド](development.md#コマンド) を参照する。

## 言語・実行環境

| 項目 | 採用 | 理由 |
|---|---|---|
| 言語 | TypeScript | 型で値オブジェクトとエラーの契約を表せる。Web 画面の JavaScript と言語をそろえられる |
| 実行環境 | Node.js 26 系の 26.11.0 以上（2026-10-23 時点では Current。2026-10-28 から LTS の予定。LTS への移行後にこの表記を更新する） | 標準モジュールだけで HTTP サーバー、Argon2id、SQLite、乱数、正規化がそろう。26.11.0 は `node:sqlite` の `Database` クラスが入った版。26 系のサポート期限は 2029-04-30 |
| TS の実行 | Node の型除去（type stripping）で `.ts` を直接実行する。移行後の起動は `node src/index.ts` | ビルドの工程と出力ファイルを持たない。型除去は Node 25.2 で安定版になった |
| 型検査 | `tsc --noEmit` | 型の検査だけを行い、JavaScript は出力しない |
| 静的検査 | ESLint と typescript-eslint（`strictTypeChecked`） | `tsc` の型情報を使って、`Promise` の誤用、`any`・型アサーション、union 型の `switch` の分岐漏れ、デコレーター、依存の向きの違反、`Math.random` などを検出する |
| 整形 | Prettier（既定の設定） | 書式を手で揃えず、差分を意味のある変更だけにする |
| tsconfig | `erasableSyntaxOnly`、`verbatimModuleSyntax`、`rewriteRelativeImportExtensions`、`module: nodenext`、`target: esnext`、`noEmit`、`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`skipLibCheck`、`allowJs`。`include` は `src/**/*.ts`、`.github/scripts/**/*.ts`、`vitest.config.ts` | Node の型除去が扱えない構文（`enum`、実行時コードを持つ `namespace`、パラメータプロパティ）を型検査で拒否する（デコレーターは ESLint で拒否する）。添字アクセスの結果に `undefined` を含め、PHC 形式などの分割結果の要素数の検査漏れを防ぐ。省略可能な項目への `undefined` の代入を拒否する。import には `.ts` の拡張子を書く |
| モジュール形式 | ES Modules（`package.json` の `"type": "module"`） | Node の型除去と `import.meta.url` をそのまま使う |
| npm の設定 | `.npmrc` の `engine-strict=true` | `engines.node` の範囲外の Node（WSL の `PATH` に含まれる Windows 側の Node など）で `npm ci` を実行したら失敗させ、別のプラットフォーム向けの依存が入るのを防ぐ |
| 開発環境 | WSL2（Ubuntu 24.04） | Node は WSL にだけ入れる。ソースは Windows 側のフォルダに置く |
| CI | GitHub Actions（実行条件は development.md の「CI」） | PR と統合後の変更に対し、型検査・テスト・カバレッジレポートを同じ Node のバージョンで実行するため |
| セキュリティ解析 | GitHub CodeQL（実行条件は development.md の「CodeQL」） | JavaScript/TypeScript の脆弱性を検査し、GitHub code scanning に結果を集約するため |
| 依存更新 | Dependabot（設定は development.md の「依存関係の更新」） | 依存の更新を PR で検証してから取り込むため |

## ライブラリ

実行時の依存パッケージはゼロにし、すべて Node の標準モジュールを使う。

| 用途 | 採用 | 理由 |
|---|---|---|
| HTTP | 標準 `node:http` の `createServer` と、`routes` のメソッド・パスの対応表。HTTP の入出力は `controllers`、横断的な処理は `middlewares` に置く | ルートが 6 つだけなのでフレームワークは要らない。責務を分けても標準モジュールだけで実現できる |
| Web 画面 | `public/` の HTML・CSS・JavaScript を起動時にメモリへ読み込んで配信 | 画面と API を同じオリジンから配信し、別のビルドツールやフロントエンドの依存を増やさない |
| パスワードハッシュ | `PasswordProvider` を実装する `Argon2PasswordProvider` が、標準 `node:crypto` の `argon2`（Argon2id）を呼ぶ | RFC 9106 と OWASP が推奨。暗号処理は自前で実装しない。外部パッケージやネイティブのビルドが要らず、サービスを暗号 API から分離できる |
| ソルト生成 | 標準 `node:crypto` の `randomBytes` | 暗号論的に安全な乱数 |
| ハッシュ比較 | 標準 `node:crypto` の `timingSafeEqual` | 比較時間から一致箇所を推測されないようにする |
| Unicode 正規化 | `models` の `Password` が標準 `String.prototype.normalize('NFKC')` を使う | 全角と半角などの表記ゆれで、登録とログインのパスワードが食い違わないようにする |
| DB アクセス | `UserRepository` を実装する `SqliteUserRepository` が、標準 `node:sqlite` の `Database` を使う | ORM を挟まず SQL をそのまま書く。DB API と行の型を `repositories` に閉じ込め、サービスから分離できる |
| UUID・ダミーパスワード | `IdProvider` の `newUserId`・`newDummyPassword` が、標準 `node:crypto` の `randomUUID`（v4）・`randomBytes` を使う | SQLite に UUID 生成関数が無いため、アプリ側で生成する。サービスは暗号・乱数 API を直接呼ばず、テストでは固定値へ置き換える |
| ログ | `LoggerProvider` を実装する、1 行 1 件の JSON を `process.stdout` に書く小さな自前のロガー | Node に構造化ログの標準 API が無い。出力する項目が少ないので外部パッケージは要らない |
| 入力スキーマ | `schemas` の手書きの解析関数と HTTP DTO。`unknown` を検査し、`middlewares` で実行する | 入力は `{ email, password }` だけなので、外部ライブラリを追加せず厳密な型検査と形式の検証を行える |
| エラー形式 | `errors` のカスタムエラーを、最上位のエラーハンドリング Middleware で RFC 9457（Problem Details）へ変換 | HTTP のステータスコードをサービスへ持ち込まず、エラー応答を一元化できる |

## 構成と依存の注入

`routes` → `controllers` → `services` → `repositories` / `providers` の依存方向とし、`models` にドメインモデルとサービスの入出力型、`errors` にカスタムエラー、`config` に環境変数の読み込みと検証を置く。詳細な責務と許可する依存は [architecture.md](architecture.md) に従う。

`UserRepository` と各 Provider のインターフェースはそれぞれの層で定義し、`src/index.ts` で具体的な実装を生成して `AuthService` へ注入する。サービスの処理順序を外部 API の型から分離し、テストで手書きの偽物へ置き換えるために採用する。DI コンテナーやデコレーターは使わず、依存の組み立ては明示的な引数で行う。

`Password` と `EncodedHash` は `models` に置き、NFKC・PHC の検証と秘密値の伏字を維持する。PHC の構文解析は暗号計算を含まないモデル内部の処理とし、Argon2id・ソルト生成・定数時間比較・セマフォは `providers/password` に置く。UUID とダミーパスワード用の乱数は `providers/crypto-id-provider.ts` が担当する。モデルから Provider へ依存させず、秘密値の内部アクセスは具体的な `Argon2PasswordProvider` だけに許可する。

## 開発用の依存

devDependency は次の 8 つに限る。

| パッケージ | 用途 |
|---|---|
| `typescript` | `tsc --noEmit` による型検査 |
| `eslint` | 静的検査 |
| `@eslint/js` | ESLint の推奨規則 |
| `typescript-eslint` | 型情報を使う TypeScript の規則 |
| `prettier` | 整形 |
| `@types/node` | Node の標準モジュールの型 |
| `vitest` | テストとベンチマーク（`vitest bench`） |
| `@vitest/coverage-v8` | V8 のカバレッジ計測と HTML・サマリーのレポート |

## データベース

| 項目 | 採用 | 理由 |
|---|---|---|
| DB | SQLite（ファイル 1 つ） | 別途サーバーや Docker を起動せずに済む |
| スキーマ管理 | `src/repositories/sqlite/init.sql` を `open` で読み込んで実行 | テーブルが 2 つだけなのでマイグレーションツールは不要 |
| 接続設定 | 接続を 1 つだけ持ち、コンストラクタのオプションで外部キー制約と busy timeout を、`PRAGMA` で WAL を設定する。書き込みは `BEGIN IMMEDIATE` で始める | `node:sqlite` は同期 API のため、接続を増やしても同じプロセス内で並行して実行されない |

`@types/node` 26.6.5 には Node 26.11 の `Database` への改名がまだ反映されていないため、`src/repositories/sqlite/node-sqlite.d.ts` で型宣言だけを補っている。型定義が対応したら削除する。実行時は `Database` を直接使う。

## テスト

| 対象 | 方法 |
|---|---|
| `models`・パスワード Provider | Vitest。値の解析・伏字と本物の `Argon2PasswordProvider` を小さいパラメータで検証する。ベンチマークは `vitest bench --run src/providers/password` |
| `services` | 手書きの偽 `UserRepository`・各 Provider で分岐とエラー変換を検証する。小さいパラメータの本物のパスワード Provider を使う結合テストも残す |
| DB Repository | 一時ディレクトリに毎回まっさらな SQLite ファイルを作って検証する |
| HTTP | ポート 0 で起動した `http.Server` と `fetch`、本物の `AuthService`（メモリ上の偽 `UserRepository`）。ルート、Middleware、コントローラーをつないだ入力・応答と静的ファイルを検証する |

## 使わないもの

| 対象 | 理由 |
|---|---|
| Next.js、Express、Fastify、Hono などのフレームワーク | 標準 `node:http` で足りる。学習の対象をパスワード保存に絞る |
| Vite（画面のビルド・開発サーバー） | 画面はビルドせず、サーバーから配信する。Vitest が内部で依存するのは構わない |
| ORM、クエリビルダー | SQL を直接書いて、何が実行されるかを見えるようにする |
| マイグレーションツール | `init.sql` 1 つで足りる |
| 外部の Argon2 パッケージ（`argon2`、`@node-rs/argon2` など） | Node 標準の `crypto.argon2` で足りる |
| 外部の SQLite ドライバ（`better-sqlite3` など） | Node 標準の `node:sqlite` で足りる |
| Zod などのバリデーションライブラリ | 入力が少なく、`unknown` から型を絞る手書きの解析関数で足りる |
| DI コンテナー、Service Locator | 依存が少なく、`src/index.ts` の明示的な引数による注入で生成と寿命を追える |
| Biome | ESLint と Prettier を使う。型情報を使う規則（`Promise` の誤用など）を `tsc` の型で判定でき、一般的な構成を学べるため |
| `eslint-config-prettier` | 採用する規則（`@eslint/js` の推奨、typescript-eslint の `strictTypeChecked`）に書式の規則が無く、Prettier と衝突しない |
| husky などの Git フック | Windows 側の Git から実行されると Windows の Node を探すが、Node は WSL にだけ入れる |
| tsx、ts-node、esbuild などのトランスパイラ | Node の型除去で直接実行できる |
| Docker、testcontainers | SQLite で DB サーバーが不要になった |
| JWT ライブラリ | トークン発行はスコープ外 |
