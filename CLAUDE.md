# CLAUDE.md

Claude Code がこのリポジトリで作業するときの指示書。

## プロジェクト

パスワード保存の仕組み（Argon2id、ソルト、PHC 形式、定数時間比較、再ハッシュ）を学ぶための、最小構成の認証 API。Go 製。

## 参照する文書

| 文書 | 内容 |
|---|---|
| [docs/design.md](docs/design.md) | 仕様の正本。実装前に必ず読む |
| [docs/architecture.md](docs/architecture.md) | パッケージ構成、責務、依存の向き、テスト方法の正本。実装前に必ず読む |
| [docs/tech-stack.md](docs/tech-stack.md) | 採用技術と、使わない技術 |
| [docs/development.md](docs/development.md) | 開発環境（WSL）、コマンド、Git の運用 |

## 進め方

- 実装は、利用者から明示的に指示されたときだけ行う。設計の相談中にコードやファイルを作り始めない
- スコープは design.md の「実装するもの」に限る。スコープ外の機能は、頼まれても先に design.md を更新してから着手する
- 仕様を変えるときは、コードより先に design.md を更新する（版数と変更履歴も更新する）
- 仕様が曖昧な点や design.md と矛盾する点は、推測で進めずに質問する
- 実装は design.md の「作業手順」の順に進め、各段階でテストが通ってから次へ進む

## 実行環境の注意

- Go は WSL にだけ入っている。Windows から Go のコマンドを実行するときは `wsl -d Ubuntu-24.04 --exec bash -lc '...'` を使う（詳細は development.md）
- SQLite の DB ファイルは `/mnt/c` 配下に置かない

## 禁止事項

- 暗号処理を自前で実装しない。Argon2id は `golang.org/x/crypto/argon2` を使う
- 乱数は `crypto/rand` だけを使う。`math/rand` は使わない
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
