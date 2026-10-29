# auth-server

パスワード保存の仕組みを学ぶための、TypeScript（Node.js 26）製の小さな認証 API と Web 画面です。Argon2id、ランダムなソルト、PHC 形式での保存、定数時間比較、ログイン成功時の再ハッシュを扱います。

**学習用であり、本番利用には適しません。** ログインは資格情報を照合して `user_id` を返すだけで、トークンや認証済みセッションは発行しません。

## 必要な環境

- Windows と WSL2（Ubuntu 24.04）
- WSL 側の Node.js 26（26.11.0 以上。nvm でインストールします。メジャーバージョンは [.nvmrc](.nvmrc)、対象範囲は [package.json](package.json) の `engines.node` を参照）
- Git、WSL 側の curl
- Windows 側のブラウザー（JavaScript を有効にする）

ソースを Windows 側のフォルダに取得し、リポジトリのルートで WSL Bash を開いてください。以下のシェルコマンドは、特記がなければ **WSL Bash** で実行します。Windows 側に別の Node.js が入っていてもこのプロジェクトでは使わず、`npm` も WSL からだけ実行します。nvm と Node の初回準備や Windows から WSL のコマンドを呼ぶ方法は [開発ガイド](docs/development.md) を参照してください。

ソースと `node_modules/` は `/mnt/c` 配下に置きますが、SQLite の DB は WSL 側のファイルシステムに置きます。Docker や別の DB サーバーは不要です。

## 起動する

### 1. DB の保存先を用意する

```bash
mkdir -p -m 700 "$HOME/.local/share/auth-server"
chmod 700 "$HOME/.local/share/auth-server"
export DATABASE_PATH="$HOME/.local/share/auth-server/auth.db"
```

`mkdir -m` は既存ディレクトリの権限を変えないため、`chmod` も実行します。既存の DB を使う場合は、サーバーを停止してから DB と存在する `-wal`・`-shm`・`-journal` ファイルの権限を確認し、必要なファイルだけ `chmod 600` で制限してください。

直上の親ディレクトリと DB・関連ファイルは実行ユーザーの所有で、所有者以外のアクセス権がないことが必要です。親は実ディレクトリ、ファイルは通常ファイルに限り、これらのパス自体にシンボリックリンクは使えません。アプリは親ディレクトリの作成や権限の自動修正を行いません。

`DATABASE_PATH` は Linux 形式のパスです。`"~/..."` は展開されないので、上の例のように `"$HOME/..."` を使ってください。`/mnt/c` 配下はリンク経由も含めて起動時に拒否されます。

### 2. 依存パッケージを入れて起動する

同じターミナルで実行します。Node.js の型除去で `.ts` を直接実行するため、ビルドの工程はありません。初回や `package-lock.json` の更新時は `npm ci` を実行します。

```bash
. "$HOME/.nvm/nvm.sh" &&
nvm use &&
npm ci &&
npm start
```

JSON ログに `auth server listening` が出たら準備完了です。既定のポートは `8080` です。サーバーは IPv4 の全インターフェース（`0.0.0.0`）で待ち受けるので、接続できる範囲はホストのネットワーク・ファイアウォール設定にも依存します。

| 環境変数 | 必須 | 既定値 | 内容 |
|---|---|---|---|
| `DATABASE_PATH` | 必須 | なし | SQLite ファイルのパス。未設定・空は起動エラー |
| `PORT` | 任意 | `8080` | 十進数字の `1`〜`65535`。未設定・空なら既定値 |

別のポートにする場合は、起動前に `export PORT=8081` などを設定し、以降の接続先も合わせます。ポートの符号や空白は受け付けません。

### 3. 停止する

起動したターミナルで `Ctrl+C` を押します。SIGINT・SIGTERM を受けると処理中のリクエストを最大30秒待ち、残る接続と DB を閉じます。終了待ちの間に最初と同じシグナルをもう一度送ると、通常のシグナル動作で即時終了します。DB は残るため、再起動後も登録したユーザーを使えます。

## API を試す

サーバーを動かしたまま、**別の WSL Bash** で実行します。例のパスワードは動作確認専用です。

| メソッド | パス | 成功応答 |
|---|---|---|
| GET | `/healthz` | `200`、本文なし |
| POST | `/v1/users` | `201`、`{"user_id":"…"}` |
| POST | `/v1/sessions` | `200`、`{"user_id":"…"}` |

### ヘルスチェック

```bash
curl -i http://127.0.0.1:8080/healthz
```

`200` が返れば HTTP サーバーは動作しています。DB の健全性を検査するエンドポイントではありません。

### ユーザー登録

```bash
curl -i -X POST http://127.0.0.1:8080/v1/users \
  -H 'Content-Type: application/json' \
  --data '{"email":"learner@example.com","password":"learning-password-123"}'
```

`201` と生成された UUID の `user_id` が返ります。

### ログイン

```bash
curl -i -X POST http://127.0.0.1:8080/v1/sessions \
  -H 'Content-Type: application/json' \
  --data '{"email":"learner@example.com","password":"learning-password-123"}'
```

`200` と登録時と同じ `user_id` が返ります。メールアドレスの大文字小文字は区別しません。

### 重複登録と誤パスワード

同じアドレスを再登録すると `409` です。

```bash
curl -i -X POST http://127.0.0.1:8080/v1/users \
  -H 'Content-Type: application/json' \
  --data '{"email":"learner@example.com","password":"learning-password-123"}'
```

パスワードを間違えると `401` です。未登録ユーザーでも同じ認証失敗を返します。

```bash
curl -i -X POST http://127.0.0.1:8080/v1/sessions \
  -H 'Content-Type: application/json' \
  --data '{"email":"learner@example.com","password":"wrong-password"}'
```

エラーは `Content-Type: application/problem+json` の Problem Details です。たとえば認証失敗では次の本文を返します。

```json
{"type":"about:blank","title":"Unauthorized","status":401,"detail":"メールアドレスまたはパスワードが正しくありません"}
```

### 入力の条件

- 本文全体は末尾の空白も含めて **16 KiB 以下**。JSON オブジェクト1つに、文字列の `email` と `password` を指定します。未知項目、欠落、null、型違い、後続データは `400`、上限超過は `413` です。
- メールアドレスは ASCII に限り、通常のアドレスか、それを山括弧で囲んだ形式を受け付けます。表示名・グループ・コメント・引用符付きローカル部は拒否します。
- 登録パスワードは NFKC 正規化後の Unicode コードポイント数で **12〜128文字**。文字種の組み合わせは強制しません。登録の入力違反は `422`、ログイン失敗は `401` です。既存の短い・空のパスワードは照合と再ハッシュが可能です。
- Content-Type は必須ではありません。項目名は大文字小文字を区別して完全一致で照合し、重複項目は `JSON.parse` の動作どおり後勝ちとします。本文の不正な UTF-8 は U+FFFD に置き換わり、JSON エスケープの孤立サロゲートはパスワードポリシーおよびメールアドレスの ASCII 制限で拒否します。

## Web 画面を使う

サーバーを起動したまま、Windows のブラウザーで **[http://127.0.0.1:8080/](http://127.0.0.1:8080/)** を開きます。Web 画面（`public/`）も同じ Node.js サーバーが配信するため、フロントエンド用の別の開発サーバーやビルドは不要です。

1. 右上に「サーバーに接続済み」と表示されることを確認します。これは HTTP の疎通確認で、DB の健全性は検査しません。
2. 「ユーザー登録」に切り替え、メールアドレスと12〜128文字のパスワードを入力して登録します。成功するとユーザー ID が表示されます。
3. 「ログイン」に切り替え、同じ情報を入力します。登録時と同じユーザー ID が表示されれば成功です。
4. 同じメールアドレスでの再登録や誤ったパスワードで、エラーの表示も試せます。

送信の終了後、パスワード欄は空になります。画面はパスワードを URL や Web Storage に保存しません。ブラウザー自身のパスワード保存機能は別途設定してください。ログインは照合だけを行い、ログイン状態を保持しません。実際に利用中のパスワードは使わないでください。

### 接続できない場合

このサーバーは IPv4 で待ち受けます。`localhost` の名前解決に依存せず、`127.0.0.1` を使って順に確認します。`PORT` を変更した場合は、以下も同じ値にします。

1. WSL 内で `curl -i http://127.0.0.1:8080/healthz` が `200` になるか確認します。失敗する場合は、起動ログとポートを確認します。
2. 通常の **Windows PowerShell** で次を実行します。起動直後の WSL の転送待ちに備え、接続失敗を最大5回再試行します。

   ```powershell
   curl.exe -i --noproxy "*" --connect-timeout 2 --max-time 5 --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:8080/healthz
   ```

3. WSL 内だけ成功する場合は、PowerShell の `wsl -d Ubuntu-24.04 --exec hostname -I` で現在の WSL の IPv4 アドレスを取得し、`http://<WSL の IPv4>:8080/healthz` でも確認します。IP 直指定だけが成功するなら、WSL の localhost 転送を調べます。NAT モードでは `%UserProfile%\.wslconfig` の `localhostForwarding` の既定値は `true` です。
4. Windows の curl が成功するのに画面が開かない場合は、ブラウザーの URL、HTTP/HTTPS の違い、プロキシ設定を確認します。エージェントのサンドボックス内だけで接続に失敗しても、Windows 自体の接続不良とは限りません。

この開発環境（WSL 2.4.11.0）では、IPv6 の待ち受けは Windows の `::1` にだけ転送され、`127.0.0.1` が失敗する現象を確認しました。そのためサーバーは IPv4 の `0.0.0.0` で待ち受けます。ファイアウォールの無効化やポート転送ルールの追加は不要でした。

WSL のネットワークモードや設定の説明は、[Microsoft のネットワーク資料](https://learn.microsoft.com/en-us/windows/wsl/networking)と[設定資料](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#main-wsl-settings)を参照してください。

## テストと関連文書

WSL のリポジトリルートで実行します。

```bash
. "$HOME/.nvm/nvm.sh" &&
nvm use &&
npm run typecheck &&
npm run lint &&
npm run format:check &&
npm test &&
npm run coverage
```

CI では型検査・静的検査・整形確認、全テスト、カバレッジを実行し、別ワークフローで CodeQL を実行します。Markdown だけの PR では CodeQL は省略されます。Dependabot の対象、実行条件、カバレッジの確認方法は [開発ガイド](docs/development.md) を参照してください。

| 文書 | 内容 |
|---|---|
| [設計書](docs/design.md) | 設計全体の入口、スコープ、既知の制限、完了条件 |
| [パスワード仕様](docs/specs/password.md) | PHC、ポリシー、ハッシュ・検証・再ハッシュ |
| [DB 仕様](docs/specs/database.md) | スキーマ、初期化、権限、保存契約 |
| [API・認証・サーバー仕様](docs/specs/api.md) | HTTP 入出力、認証手順、設定、タイムアウト、Web 画面 |
| [アーキテクチャ](docs/architecture.md) | 責務、依存の向き、テスト方法 |
| [開発ガイド](docs/development.md) | Windows/WSL のコマンド、CI、Git 運用 |
| [テックスタック](docs/tech-stack.md) | 採用技術と採用しない技術 |
| [TypeScript のコーディング方針](docs/typescript-coding-guidelines.md) | 実装・エラー処理・テストの方針 |

性能測定のコマンドと結果は [性能測定と調査記録](docs/password-benchmarks.md)にあります。2026-10-28 の Provider 移行後の測定では、既定設定のハッシュ1回の中央値は **430.791 ms**（WSL 再起動後の再確認では **372.509 ms**）でした。これは記載された環境での過去の測定値です。

## 既知の制限

- 登録の `409` 応答から、第三者がメールアドレスの登録有無を確認できます。
- ペッパー・レート制限・トークン発行がなく、本番利用には適しません。
- ハッシュ設定を強化した後、再ハッシュ前の既存ユーザーは現行設定のダミー検証より速く応答するため、応答時間から登録有無を推測される可能性があります。
- `node:sqlite` の API は同期のため、SQLite が他のプロセスのロックを待っている間（busy timeout の最大5秒）は、イベントループが止まり、すべての要求の処理が止まります。この間は要求の `signal` の中断も効きません。
- `open` の接続初期化でも、PRAGMA がロックを待っている間はイベントループが止まり、`signal` の中断も効きません。再試行の開始期限は5秒ですが、期限直前に始めた1回の接続処理がロックを待つと、`open` 全体はその待機時間だけ長くなります。
- 他のプロセスの書き込みが続いて、ロック待ちが5秒を超えた登録は `503` になります。ログイン成功後の再ハッシュや保存の失敗は警告を記録し、ログイン自体は成功の `200` を返します。
- 未割り当ての Unicode 文字を含むパスワードは、Node.js が同梱する ICU の Unicode 表の更新で NFKC の結果が変わり、ログインできなくなる可能性があります。
- 未認証の要求で Argon2id の同時計算枠4つを埋められます。他の要求は待機切れで `503` になることがあり、ログイン試行回数にも上限はありません。
- DB 保存先の起動時検査が拒否するのは `/mnt/c` 配下だけです。他ドライブ、WSL の automount root 変更、Windows 側のパスへのバインドマウントは検出しません。
- 応答期限は、ヘッダー受信後・本文読み込み前にアプリへ要求が渡ってから30秒で、本文の受信時間も含みます。本文受信に約10秒、再ハッシュを伴う処理に約22秒かかる条件では合計が約32秒となり、成功応答や `503` を返す前に接続を破棄する場合があります。詳細は [サーバータイムアウト](docs/specs/api.md#サーバータイムアウト)を参照してください。
- 30秒の終了期限を超えて残った処理（Argon2id の計算完了待ちなど）は、接続を閉じた後も動き続ける場合があります。DB を閉じた後のアクセスは失敗してログが出ますが、書き込みは SQLite のトランザクションで守られます。
- 不正な要求の行・ヘッダーと、`headersTimeout`・`requestTimeout` の超過には Node.js が `400`・`408` を返すため、Problem Details の形になりません。
- サーバーは IPv4 の全インターフェースで待ち受けるため、WSL の仮想ネットワーク（mirrored モードでは LAN）からも API と Web 画面に届きます。
- API は Content-Type を必須にせず、Origin・Host も検査しません。サーバーの起動中に開いた別のサイトから、`text/plain` の POST で登録やログインの要求を送られる可能性があります。DNS リバインドを使えば応答も読めます。
