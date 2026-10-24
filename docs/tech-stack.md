# テックスタック

採用技術と、その理由をまとめる。仕様の詳細は [design.md](design.md) を参照。依存パッケージのバージョンは、実装後は `package.json` と `package-lock.json` を正本とする。Node のメジャーバージョンは `.nvmrc` を正本とし、`package.json` の `engines.node`（`>=26.11.0 <27`）は対象外の版で動かしていないかの検査に使う。

移行の完了（design.md 10 章の手順 7）までは、Go 実装と Go 用の CI が並存する。Go 実装で使っていた技術は、この文書の末尾の「Go 実装で使っていたもの」にまとめる。

## 言語・実行環境

| 項目 | 採用 | 理由 |
|---|---|---|
| 言語 | TypeScript | 型で値オブジェクトとエラーの契約を表せる。Web 画面の JavaScript と言語をそろえられる |
| 実行環境 | Node.js 26 系の 26.11.0 以上（2026-10-23 時点では Current。2026-10-28 から LTS の予定。LTS への移行後にこの表記を更新する） | 標準モジュールだけで HTTP サーバー、Argon2id、SQLite、乱数、正規化がそろう。26.11.0 は `node:sqlite` の `Database` クラスが入った版。26 系のサポート期限は 2029-04-30 |
| TS の実行 | Node の型除去（type stripping）で `.ts` を直接実行する | ビルドの工程と出力ファイルを持たない。型除去は Node 25.2 で安定版になった |
| 型検査 | `tsc --noEmit` | 型の検査だけを行い、JavaScript は出力しない |
| 静的検査 | ESLint と typescript-eslint（`strictTypeChecked`） | `tsc` の型情報を使って、`Promise` の誤用、`any`・型アサーション、依存の向きの違反、`Math.random` などを検出する |
| 整形 | Prettier（既定の設定） | 書式を手で揃えず、差分を意味のある変更だけにする |
| tsconfig | `erasableSyntaxOnly`、`verbatimModuleSyntax`、`rewriteRelativeImportExtensions`、`module: nodenext`、`target: esnext`、`noEmit`、`strict`。`include` は `src/**/*.ts` と `vitest.config.ts` | Node の型除去が扱えない構文（`enum`、実行時コードを持つ `namespace`、パラメータプロパティ）を型検査で拒否する。import には `.ts` の拡張子を書く |
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
| HTTP | 標準 `node:http` の `createServer` と、メソッド・パスの対応表 | ルートが 6 つだけなのでフレームワークは要らない。フレームワークの挙動を覚える必要がない |
| Web 画面 | HTML・CSS・JavaScript を起動時にメモリへ読み込んで配信 | 画面と API を同じオリジンから配信し、別のビルドツールやフロントエンドの依存を増やさない |
| パスワードハッシュ | 標準 `node:crypto` の `argon2`（Argon2id） | RFC 9106 と OWASP が推奨。暗号処理は自前で実装しない。外部パッケージやネイティブのビルドが要らない |
| ソルト生成 | 標準 `node:crypto` の `randomBytes` | 暗号論的に安全な乱数 |
| ハッシュ比較 | 標準 `node:crypto` の `timingSafeEqual` | 比較時間から一致箇所を推測されないようにする |
| Unicode 正規化 | 標準 `String.prototype.normalize('NFKC')` | 全角と半角などの表記ゆれで、登録とログインのパスワードが食い違わないようにする |
| DB アクセス | 標準 `node:sqlite` の `Database` | ORM を挟まず SQL をそのまま書く。外部パッケージやネイティブのビルドが要らない |
| UUID | 標準 `node:crypto` の `randomUUID`（v4） | SQLite に UUID 生成関数が無いため、アプリ側で生成する |
| ログ | 1 行 1 件の JSON を `process.stdout` に書く小さな自前のロガー | Node に構造化ログの標準 API が無い。出力する項目が少ないので外部パッケージは要らない |
| エラー形式 | RFC 9457（Problem Details） | HTTP API のエラー表現の標準 |

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
| スキーマ管理 | `src/store/sqlite/init.sql` を `open` で読み込んで実行 | テーブルが 2 つだけなのでマイグレーションツールは不要 |
| 接続設定 | 接続を 1 つだけ持ち、コンストラクタのオプションで外部キー制約と busy timeout を、`PRAGMA` で WAL を設定する。書き込みは `BEGIN IMMEDIATE` で始める | `node:sqlite` は同期 API のため、接続を増やしても同じプロセス内で並行して実行されない |

## テスト

| 対象 | 方法 |
|---|---|
| password モジュール | Vitest。ベンチマークは `vitest bench` |
| DB | 一時ディレクトリに SQLite ファイルを作り、毎回まっさらな DB で実行する |
| HTTP ハンドラ | ポート 0 で起動した `http.Server` と `fetch`、メモリ上の偽 `UserStore` |

## 使わないもの

| 対象 | 理由 |
|---|---|
| Next.js、Express、Fastify、Hono などのフレームワーク | 標準 `node:http` で足りる。学習の対象をパスワード保存に絞る |
| Vite（画面のビルド・開発サーバー） | 画面はビルドせず、サーバーから配信する。Vitest が内部で依存するのは構わない |
| ORM、クエリビルダー | SQL を直接書いて、何が実行されるかを見えるようにする |
| マイグレーションツール | `init.sql` 1 つで足りる |
| 外部の Argon2 パッケージ（`argon2`、`@node-rs/argon2` など） | Node 標準の `crypto.argon2` で足りる |
| 外部の SQLite ドライバ（`better-sqlite3` など） | Node 標準の `node:sqlite` で足りる |
| Biome | ESLint と Prettier を使う。型情報を使う規則（`Promise` の誤用など）を `tsc` の型で判定でき、一般的な構成を学べるため |
| `eslint-config-prettier` | 採用する規則（`@eslint/js` の推奨、typescript-eslint の `strictTypeChecked`）に書式の規則が無く、Prettier と衝突しない |
| husky などの Git フック | Windows 側の Git から実行されると Windows の Node を探すが、Node は WSL にだけ入れる |
| tsx、ts-node、esbuild などのトランスパイラ | Node の型除去で直接実行できる |
| Docker、testcontainers | SQLite で DB サーバーが不要になった |
| JWT ライブラリ | トークン発行はスコープ外 |

## Go 実装で使っていたもの

移行の完了（design.md 10 章の手順 7）で削除する。

| 用途 | 採用 |
|---|---|
| 言語 | Go 1.27.2（バージョンは `go.mod` が正本） |
| HTTP | 標準 `net/http` |
| パスワードハッシュ・正規化 | `golang.org/x/crypto/argon2`、`golang.org/x/text/unicode/norm` |
| DB | 標準 `database/sql` と `modernc.org/sqlite` |
| UUID | `github.com/google/uuid` |
| ログ | 標準 `log/slog` |
| CI | Lint（`gofmt`・`go mod tidy -diff`・`go vet`）、Test、Coverage、Race と、Go の CodeQL 解析 |
