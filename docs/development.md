# 開発ガイド

開発環境、コマンド、Git の運用をまとめる。

TypeScript 実装の手順を正本とする。

構成と現在の配置は [アーキテクチャ](architecture.md#現状と移行先)を正本とする。

## 開発環境

- このプロジェクトの Node.js 26 は、WSL（ディストリビューション名 `Ubuntu-24.04`）に nvm で入れる。Windows 側にほかの用途の Node（winget で入れた Node 24 など）が入っていても、このプロジェクトでは使わない
- Node のメジャーバージョンはリポジトリのルートの `.nvmrc`（`26`）を正本とする。`nvm install` と `nvm use` で 26 系の最新版を使う
- 対象の下限は 26.11.0 で、`package.json` の `engines.node`（`>=26.11.0 <27`）に書く。リポジトリのルートの `.npmrc` に `engine-strict=true` を置き、対象外の版の Node（Windows 側の Node 24 や古い 26 系）で `npm ci` を実行したら、警告で済ませずに失敗させる。失敗したら nvm を読み込んでから実行し直すか、`nvm install` で 26 系を更新する
- ソースは Windows 側のフォルダ（例：`C:\Users\<ユーザー名>\repos\auth-server`）に置く。WSL からは `/mnt/c/Users/<ユーザー名>/repos/auth-server` で見える
- `npm ci` で作る `node_modules/` も Windows 側のフォルダに置かれる。`/mnt/c` 経由のファイルアクセスは遅いため、インストールとテストに時間がかかる
- npm は WSL からだけ実行する。Windows 側の Node や npm で `node_modules/` を作り直さない
- エディターの補完は、エディターに同梱の TypeScript と、WSL で作った `node_modules/@types/node` で動く。Windows 側に Node は要らない

### nvm と Node の初回の準備

WSL のシェルで 1 回だけ行う。

1. nvm を[公式の手順](https://github.com/nvm-sh/nvm#install--update-script)で入れる。入れる先は既定の `~/.nvm` とする。`XDG_CONFIG_HOME` を設定した状態でインストーラーを実行すると `~/.config/nvm` に入り、下のコマンドの `$HOME/.nvm` と食い違うため、設定していない状態で実行する
2. `. "$HOME/.nvm/nvm.sh" && nvm install 26` で 26 系の最新版を入れる。リポジトリのルートで `nvm install` を実行すれば `.nvmrc` の版が入る
3. `command -v node npm` が `~/.nvm/` 配下を指し、`node --version` が 26.11.0 以上であることを確かめる

Node の起動時に `libatomic.so.1` が見つからないと表示された場合は、WSL で `sudo apt-get update && sudo apt-get install --no-install-recommends libatomic1` を実行してから、起動を確かめる。

### Windows から Node のコマンドを実行する

Windows 側のリポジトリのルートで実行する。wsl.exe は呼び出し元のフォルダを WSL のパスに変換して作業ディレクトリにするため、`cd` は要らない。

```powershell
wsl -d Ubuntu-24.04 --exec bash -lc '. "$HOME/.nvm/nvm.sh" && nvm use --silent && npm test'
```

- `--exec` は、既定の Linux シェルを介さず、指定した `bash` を直接実行するために付ける。Windows 側のシェルによる変数展開を防ぐオプションではない（[WSL の説明](https://learn.microsoft.com/en-us/windows/wsl/release-notes#build-18305)）
- この例は PowerShell 用。`bash -lc` へ渡す文字列をシングルクォートで囲むことで、`$HOME` などを PowerShell では展開せず bash へ渡す（[PowerShell の引用符の規則](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules#single-quoted-strings)）。Command Prompt（`cmd.exe`）ではシングルクォートは引数をまとめる引用符にならず、引用符や変数の規則も異なるため、この例をそのまま使わない
- コマンドの中で `nvm.sh` を読み込み、`nvm use` で `.nvmrc` の版を選ぶ。nvm のインストーラーは初期化の処理を `~/.bashrc` の末尾に追加するが、Ubuntu 標準の `~/.bashrc` は非対話のシェルでは冒頭で終了するため、`bash -lc` だけでは nvm が読み込まれない
- 引数のない `nvm use` は `.nvmrc` を読む。`.nvmrc` が無い場合は `nvm use --silent 26` と版を指定する。nvm を入れていない場合は `nvm.sh` の読み込みが、nvm はあっても Node 26 が未インストールの場合は `nvm use` が失敗し、`&&` により `npm` は実行されない。いずれの場合も「nvm と Node の初回の準備」を行う
- nvm を読み込まないと、WSL の `PATH` に含まれる Windows 側の `npm`（`/mnt/c/...`）が選ばれることがある。Windows の npm で `node_modules/` が作られないよう、`npm` の前に必ず nvm を読み込む。どちらが選ばれるかは `command -v node npm` で確かめ、`~/.nvm/` 配下を指していることを確認する
- 込み入った処理はスクリプトファイルにして `wsl -d Ubuntu-24.04 --exec bash <スクリプトのパス>` で実行する。`bash <スクリプト>` も非対話シェルで nvm は読み込まれないため、Node や npm を使うスクリプトは、先頭で `. "$HOME/.nvm/nvm.sh" && nvm use --silent` を実行してから呼ぶ

### SQLite の DB ファイル

SQLite はファイル 1 つで動作し、別途 DB サーバーを起動する必要はない。

- `@types/node` 26.6.5 には Node 26.11 の `Database` への改名がまだ反映されていないため、`src/repositories/sqlite/node-sqlite.d.ts` で型宣言だけを補っている。実行時は `Database` を直接使い、型定義が対応したら補助宣言を削除する
- DB ファイルは `/mnt/c` 配下に置かない。WSL 側（例：`~/.local/share/auth-server/auth.db`）に置く
- 親ディレクトリは自動で作られないため、初回は `mkdir -p -m 700 ~/.local/share/auth-server` で所有者専用に作っておく
- 既存の親ディレクトリは `chmod 700 ~/.local/share/auth-server` で権限を制限する。DB と既存の `-wal`・`-shm`・`-journal` ファイルにも所有者以外の権限があれば、該当ファイルを `chmod 600` にしてから起動する。親とファイルの所有者は実行ユーザーと一致させる。シンボリックリンクは使わない
- `/mnt/c` ではファイルロックや WAL の共有メモリが正しく動かないことがある
- 置き場所は環境変数 `DATABASE_PATH` で指定する（未設定なら起動エラー）

`*.db`、`*.db-wal`、`*.db-shm`、`*.db-journal`、`node_modules/`、`coverage/`、`bench-results/` は `.gitignore` に入れる。

## コマンド

WSL 上のリポジトリのルートで実行する。`npm run` の名前は `package.json` の `scripts` に定義する。Windows のブラウザーからの実接続は [README](../README.md#web-画面を使う) に従って確認する。

| 目的 | コマンド | 中身 |
|---|---|---|
| 依存のインストール | `npm ci` | `package-lock.json` のとおりに入れる |
| 型検査 | `npm run typecheck` | `tsc --noEmit` |
| 静的検査 | `npm run lint` | `eslint .` |
| 整形 | `npm run format` | `prettier --write .` |
| 整形確認 | `npm run format:check` | `prettier --check .`（ファイルは書き換えない） |
| テスト | `npm test` | `vitest run` |
| カバレッジ | `npm run coverage` | `vitest run --coverage` |
| ベンチマーク（ハッシュ 1 回の所要時間） | `npm run bench` | `vitest bench --run src/providers/password` |
| 起動 | `DATABASE_PATH=~/.local/share/auth-server/auth.db npm start` | `node src/index.ts` |

- Vitest の `passWithNoTests` は使わない。テストの移動や `include` の指定の誤りでテストが 0 件になったときに、`npm test` と CI を失敗させるため
- `npm run bench` は既定パラメータの `hash`・`hash saturated` と飽和時のイベントループ遅延を測る。`AUTH_PASSWORD_BENCH_RUN=1 npm run bench` の番号を 1・2・3 と変えて 3 回実行すると、各回の JSON を `bench-results/password/` に残せる（`coverage/` はカバレッジの実行時に削除されるため使わない）。番号を省略した場合は `latest` として上書きする。既定値が [テストと性能調整](password.md#テストと性能調整) の目標から外れた場合は、`AUTH_PASSWORD_BENCH_CANDIDATES=1 npm run bench` で候補も比較する。Vitest 5 では `*.bench.ts` 内のテストコンテキストの `bench` を使い、通常の `npm test` ではベンチマークを実行しない
- ESLint の設定は `eslint.config.js` に置き、`src/` の TS ファイル、CI のスクリプト（`.github/scripts/`）、ルートの設定ファイル（`eslint.config.js`・`vitest.config.ts`）を対象にする。型情報を使う規則のため、typescript-eslint の `projectService` で `tsconfig.json` を読む。`tsconfig.json` の `include` は `src/**/*.ts`、`.github/scripts/**/*.ts`、`vitest.config.ts` とし、`tsconfig.json` に含めない `eslint.config.js` には typescript-eslint の `disableTypeChecked` を適用する。`actions/github-script` から `require` する `.github/scripts/*.cjs` は、`@eslint/js` の推奨規則で検査し、テスト（`*.test.ts`）から読み込んで振る舞いを確かめる。ブラウザーで動く静的ファイルは移行後の `public/` も対象から外す
- `tsconfig.json` の `skipLibCheck` で依存パッケージの型定義は型検査しない。依存の更新で型定義どうしが食い違っても、このプロジェクトのコードと無関係に型検査が失敗しないようにするため
- Prettier は既定の設定で使い、設定ファイルは置かない。Markdown、GitHub Actions の YAML と静的ファイル（`public/`）は `.prettierignore` で対象から外す

コーディング規約の必須条件・適用範囲・例外と、現在有効な検査・導入予定の一覧は、[コーディング方針](coding-guidelines.md#現在の検査と導入予定)を正本とする。今回の文書更新では、検査設定・既存コード・公開契約は変更していない。追加規約は今後の新規・変更コードに適用し、未導入の検査で確認できない事項はレビューで確認する。既存コードの一括改修と検査設定の追加は別作業とする。

追加規則の導入時は、上記の対象と例外に合わせて設定し、ESLint の重大度は `error` とする。同じ変更で一覧の検査状態も更新する。現在の検査コマンドが成功しても、未導入の規則や、自動検査できない値オブジェクトの条件・参照の所有権などまで確認できたとは扱わない。

### レイヤー分離時の設定と検証

- 層ごとの依存規則は [アーキテクチャ](architecture.md#import-の検査)に従う。
- `.github/scripts/eslint-config.test.ts` は、上の依存規則に合わせて、許可する import と拒否する import の両方を検証する。旧 `src/password/`・`src/store/sqlite/` の経路と暫定規則は撤去済みである
- パスワード Provider・セマフォ・鍵導出のテストとベンチマークは `providers/password/` に置く。Service のテストでは、手書きの偽 `UserRepository`・`PasswordProvider`・`IdProvider`・`LoggerProvider` を注入し、低コスト設定の本物の `Argon2PasswordProvider` と組み合わせる検証も残す
- `src/repositories/sqlite/` のテストは、実 DB で SQL とトランザクション、再試行・中断・権限・エラー分類を検証する
- `public/` は ESLint・Prettier の対象から外す。Vitest のカバレッジ対象は `src/**/*.ts` のため、`public/` は対象に入らない
- コードや設定を変更する各段階で `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm test`、`npm run coverage` を確認し、CI・CodeQL も通ってから次へ進む。文書だけの変更では、文書間の構成・パス・手順・見出し参照の整合性、記載した検査状態と実設定の対応を確認し、`git diff --check` と最終差分で変更範囲を確認する。アプリのテスト・カバレッジは実行しない。Markdown は Prettier の対象外なので、`format:check` の成功を文書の検証の代わりにしない

## CI

CI の実行条件と出力はこの節を正本とする。GitHub Actions の `.github/workflows/ci.yml` で、`develop`・`main` 向けの PR と両ブランチへの push 時に、次の 3 ジョブを独立して並行実行する。ジョブ間の依存は設けず、それぞれの結果を PR のチェックとして表示する。CodeQL の解析は別の `.github/workflows/codeql.yml` で独立して実行する。

| ジョブ | 内容 |
|---|---|
| Lint | `npm ci`（`package.json` と `package-lock.json` が食い違うと失敗する）、`npm run typecheck`、`npm run lint`、`npm run format:check` |
| Test | `npm ci` の後に `npm test` |
| Coverage | `npm ci` の後に `npm run coverage` と、カバレッジレポートの生成・保存 |

Test と Coverage はそれぞれ別に、`src/` と `.github/scripts/` のテストを実行する。Coverage は `src/` 配下の TS ファイル（テストとベンチマークを除く）を計測対象にし、テストから読み込まれないファイルも集計に含める。ブラウザーで動く静的ファイルは計測せず、移行後の `public/` も対象に入らない。

- 合計カバレッジは GitHub Actions の実行サマリーに表示する
- 同じリポジトリのブランチから作った PR には、合計・ファイル別カバレッジ、計測したコミット、実行ログと artifact へのリンクをコメントする。初回だけ作成し、Coverage ジョブの再実行時は同じコメントを更新する。テストやレポート生成に失敗したときも、以前の数値を残さず失敗表示へ更新する。取り消された実行、現在の PR と異なるコミットの実行、すでにコメントした実行より古い実行は更新しない
- コメント投稿用の `pull-requests: write` 権限は Coverage ジョブだけに付与する。push、外部フォークの PR、トークンが読み取り専用になる Dependabot の実行ではコメントせず、従来どおり実行サマリーと artifact を出力する
- Coverage ジョブのテスト成功時に `coverage-report` artifact を 14 日間保存する。`index.html` はブラウザでソース行ごとの実行状況を確認でき、`coverage-summary.json` はファイル別の集計、`coverage-final.json` は V8 の計測データ。再実行時は同名の artifact を上書きする
- カバレッジの出力先と形式は `vitest.config.ts` に定義する。生成先の `coverage/` は Git の管理対象から外す
- 実行環境は Ubuntu 24.04。Node のバージョンは `.nvmrc` から読み込み、`check-latest` で 26 系の最新版を取得する。ランナーのキャッシュにある 26.11.0 未満の 26 系が選ばれると、`engine-strict=true` で `npm ci` が失敗するため
- Node のインストールと npm のキャッシュの復元は `.github/actions/setup-node` にまとめ、各ジョブから呼ぶ。キャッシュは `package-lock.json` が変わるまで再利用する。キャッシュは npm のダウンロード済みパッケージ用で `node_modules/` は共有しないため、Lint・Test・Coverage の各ジョブで `npm ci` を実行する
- 各ジョブの制限時間は 15 分。同じ PR で新しい実行が始まったら、古い実行を取り消す。`develop`・`main` への push では実行中の CI を取り消さないが、同じブランチの待機中の実行は新しい push によって置き換わることがある
- 性能測定は WSL で行い、ベンチマークは CI では実行しない
- レース検出（Race ジョブ）に相当する仕組みは Node に無いため、ジョブを設けない。並行性の振る舞いはテストで検証する

### CodeQL

- `develop`・`main` 向けの PR と両ブランチへの push 時に JavaScript/TypeScript を解析する。手動実行にも対応する。毎週月曜 03:17 UTC（日本時間 12:17）には既定ブランチの `main` を解析する。定期・手動実行はワークフローが `main` に入ってから利用できる。public リポジトリでは 60 日間活動がないと定期実行が自動で無効になるため、止まっていたら Actions 画面で有効にし直す
- Markdown ファイルだけを変える PR では実行しない（`paths-ignore`）。CodeQL を必須チェックにする場合は、この除外で PR がチェック待ちのまま止まらないか見直す
- 言語は `javascript-typescript`、`build-mode: none` で解析する。ビルドの工程は無い。クエリは `security-extended` を使う。テストコード（`*.test.ts`・`*.bench.ts`）は CodeQL の設定ファイルの `paths-ignore` で解析対象から外す
- 解析結果は GitHub code scanning にアップロードし、PR のチェックとリポジトリのセキュリティ画面で確認する。結果のアップロード用に `security-events: write` を CodeQL ジョブだけに付与し、リポジトリの内容は `contents: read` で読み取る。fork からの PR はトークンが読み取り専用になるため、解析だけ行い結果はアップロードしない
- 制限時間は 20 分。同じ PR の古い実行は取り消し、push・定期・手動の実行中ジョブは取り消さない。Lint・Test・Coverage との依存は設けない

## 依存関係の更新

- `.github/dependabot.yml` で npm パッケージ（`npm`）と GitHub Actions（`github-actions`）を毎週月曜 09:00（`Asia/Tokyo`）に確認する。すべての設定に `target-branch: develop` を指定し、`develop` 上の依存情報を調べ、更新 PR のマージ先も `develop` に固定する
- 更新はエコシステムごとに 1 件の PR にまとめる（`groups`）
- npm パッケージはルートの `package.json`・`package-lock.json`、GitHub Actions は `.github/workflows/` と `.github/actions/setup-node/action.yml` を対象にする。共通アクション内の依存も更新できるよう、GitHub Actions の確認先に `/` と `/.github/actions/setup-node` を指定する
- Node のメジャーバージョン（`.nvmrc`）は Dependabot の対象外とし、手で更新する
- Dependabot は既定ブランチの設定ファイルを読むため、定期更新はこの設定が `main` に入ってから有効になる。設定ファイルの配置先と、更新 PR のマージ先の `develop` は異なる
- GitHub の自動セキュリティ更新 PR は `target-branch` に従わず既定ブランチの `main` 向けになるため、リポジトリ設定で無効にする。Dependabot alerts（脆弱性の通知）は有効のまま残す。[GitHub の target-branch 仕様](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#target-branch)を参照
- 通知された脆弱性は、修正 PR を手で `develop` 向けに作るか、週次の更新 PR で直す。通知は `main` の依存関係から計算されるため、修正が `main` に入るまで通知は残り、`main` には脆弱な版が残る。急ぐ場合は、修正後すぐに `develop` を `main` へマージする
- 設定の確認：自動セキュリティ更新が無効で通知が有効であることを、`gh api repos/mshi-04/auth-server/automated-security-fixes`（`"enabled":false`）と `gh api -i repos/mshi-04/auth-server/vulnerability-alerts`（`204`）で確かめる。この設定と `dependabot.yml` が `main` に入った後、最初の週次更新で `develop` 向けの PR が作られることを確認する

## 環境変数

| 名前 | 必須 | 既定値 | 内容 |
|---|---|---|---|
| `DATABASE_PATH` | 必須 | なし | SQLite ファイルのパス |
| `PORT` | 任意 | `8080` | 待ち受けポート |

`DATABASE_PATH` が空、または絶対パス化・リンク解決の前後で `/mnt/c` 配下なら起動エラーになる。親ディレクトリは先に用意する。`PORT` は未設定・空なら 8080、それ以外は十進数字の 1〜65535 に限る。サーバーは IPv4 の全インターフェースで待ち受け、SIGINT・SIGTERM で最大 30 秒の正常終了を待つ。

## Web 画面と Windows からの接続

- Node サーバーの起動後、Windows のブラウザーで `http://127.0.0.1:8080/` を開く。画面と API は同じサーバーが配信するため、フロントエンド用の起動コマンドや依存のインストールは不要
- `src/index.ts` の組み立て時に `public/` の 3 ファイルをメモリへ読み込み、Web Controller へ渡す。読み込みに失敗したら起動しない。配信するのは `/`・`/assets/app.css`・`/assets/app.js` の明示パスだけとし、ディレクトリ全体は公開しない。配信の振る舞いは [API 仕様](api.md#web-画面)を参照する。変更後はサーバーを再起動する
- WSL 2.4.11.0 のこの開発環境では、IPv6 の全アドレスで待ち受けると Windows 側に IPv6 のループバックだけが転送され、IPv4 の `127.0.0.1` が失敗した。サーバーは `0.0.0.0` で待ち受け、この差を避ける。IPv6 の接続は対象外
- 接続確認は通常の Windows PowerShell またはブラウザーで行う。エージェントの実行サンドボックスからの失敗だけでは、Windows ホストから到達できないとは判断しない
- 起動直後の転送待ちと、WSL 内・Windows 側の切り分け手順は [README](../README.md#接続できない場合) を参照
- Windows のブラウザーから WSL 上のサーバーへ接続し、Web 画面で登録・ログイン・重複登録・誤パスワードの応答を確認する。操作は [README](../README.md#web-画面を使う)に従う

## Git

### ブランチ

| ブランチ | 用途 |
|---|---|
| `main` | 安定版。デフォルトブランチ |
| `develop` | 統合先 |
| `feature/*` | 作業用。`develop` から作り、`develop` へ PR を出す |

- 文書の変更にアプリの実装や設定変更を混ぜない。利用者から指示されていないコミット・push・PR 作成は行わない

### コミット

- メッセージは日本語。1 行目に要約を書き、必要なら空行の後に箇条書きで内容を書く
- このリポジトリの `user.email` は GitHub の noreply アドレス（`94366044+mshi-04@users.noreply.github.com`）に設定済み。リポジトリは public なので、個人のメールアドレスが入ったコミットを push しない
- 改行コードは LF。`.gitattributes` で固定している

### 並行するブランチの統合

- 並行するブランチが同じファイル（`.gitignore` など）を変えている場合は、先にマージするブランチを決める。後のブランチは `develop` を取り込んで衝突を解消し、必要な変更を両方残す

### リモート

- `origin`：https://github.com/mshi-04/auth-server（public）
