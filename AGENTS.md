# AGENTS.md

AI エージェントがこのリポジトリで作業するときの指示書。

## プロジェクト

パスワード保存の仕組み（Argon2id、ソルト、PHC 形式、定数時間比較、再ハッシュ）を学ぶための、最小構成の認証 API。TypeScript（Node.js 26）製。

## 参照する文書

| 文書 | 内容 |
|---|---|
| [docs/design.md](docs/design.md) | 目的・スコープ・既知の制限・完了条件と文書の入口。実装前に必ず読む |
| [docs/architecture.md](docs/architecture.md) | モジュール構成、責務、依存の向き、テスト方法の正本。実装前に必ず読む |
| [docs/typescript-coding-guidelines.md](docs/typescript-coding-guidelines.md) | TypeScript のコーディング方針。実装前に必ず読む。仕様と構成は各仕様書・architecture.md を優先する |
| [docs/migration.md](docs/migration.md) | 残りの移行手順と段階別ブランチ。実装前に必ず読む |
| [docs/specs/password.md](docs/specs/password.md) | パスワード仕様の正本。担当領域と関連契約を読む |
| [docs/specs/database.md](docs/specs/database.md) | DB 仕様の正本。担当領域と関連契約を読む |
| [docs/specs/api.md](docs/specs/api.md) | API・認証・サーバー仕様の正本。担当領域と関連契約を読む |
| [docs/password-benchmarks.md](docs/password-benchmarks.md) | 性能測定と実行経路の根拠。性能・既定値・並行性に触れる作業で読む |
| [docs/tech-stack.md](docs/tech-stack.md) | 採用技術と、使わない技術 |
| [docs/development.md](docs/development.md) | 開発環境（WSL）、コマンド、Git の運用 |

## 進め方

- 実装は、利用者から明示的に指示されたときだけ行う。設計の相談中にコードやファイルを作り始めない
- スコープは design.md の「実装するもの」に限る。スコープ外の機能は、頼まれても先に design.md を更新してから着手する
- 仕様を変えるときは、コードより先に担当仕様書を更新し、design.md の版数も更新する。スコープ変更は design.md に反映する。読む範囲は design.md の「文書の正本と読む順序」に従う
- 仕様が曖昧な点や仕様書と矛盾する点は、推測で進めずに質問する
- 実装は [移行手順](docs/migration.md)の順に進め、各段階でテストが通ってから次へ進む

## 実行環境の注意

- このプロジェクトの Node は WSL の中のものを使う。Windows 側にもほかの用途の Node と npm が入っており、WSL の `PATH` からも見えるが、このプロジェクトでは使わない
- Windows から Node・npm のコマンドを実行するときは `wsl -d Ubuntu-24.04 --exec bash -lc '...'` を使う（詳細は development.md）
- Node・npm のコマンドは、その中で先に `. "$HOME/.nvm/nvm.sh" && nvm use --silent` を実行する。読み込まないと Windows 側の `npm` が選ばれる。`.nvmrc` が無い間は `nvm use --silent 26` とする。nvm が入っていない場合、または Node 26 が未インストールで `nvm use` が失敗する場合は、development.md の「nvm と Node の初回の準備」を利用者に依頼する
- npm は WSL からだけ実行する。Windows 側の Node や npm で `node_modules/` を作り直さない
- SQLite の DB ファイルは `/mnt/c` 配下に置かない

## 禁止事項

- 暗号処理を自前で実装しない。Argon2id は Node 標準の `node:crypto` の `argon2` を使う
- 乱数は `node:crypto` の `randomBytes`・`randomUUID` だけを使う。`Math.random` は使わない
- パスワード、ハッシュ、リクエストボディをログに出さない
- テストを通すために、テストや仕様の側を書き換えない
- tech-stack.md の「使わないもの」にある技術を、相談なしに導入しない
- architecture.md で決めた依存の向きに反する import をしない

## コメント

本番コードと設定ファイルでは、コードの字面から読み取れる説明を書かない。字面から読み取れない事情（並行性の制約、意図的に見えにくい挙動、外部都合の回避策など）に限って書く。テストコードは対象外。

## Git

- コミット・push・PR 作成は、利用者に頼まれたときだけ行う
- `user.email` を変更しない。個人のメールアドレスが入ったコミットを push しない（リポジトリは public）
- ブランチ運用とコミットメッセージの書き方は development.md に従う
