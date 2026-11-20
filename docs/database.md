# データベース

機能仕様の正本とする。目的・スコープと文書の入口は [README](../README.md)、配置と依存は [architecture.md](architecture.md)を参照する。

## ドライバ

Node 標準の `node:sqlite` の `Database` クラス（v26.11.0 で `DatabaseSync` から改名。`DatabaseSync` は非推奨の別名として残る）。外部パッケージやネイティブのビルドは不要。26.11.0 未満の Node は対象外とし（[言語・実行環境](tech-stack.md#言語実行環境)）、`DatabaseSync` との互換処理は持たない。

- `node:sqlite` の安定度は 1.2（Release candidate）である
- `Database` の API はすべて同期で実行され、SQL の実行中とロックの待機中はイベントループが止まる

## スキーマ

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
- `email` は [メールアドレスの検証](api.md#メールアドレスの検証) の規則で解析したアドレス（大文字小文字は入力のまま）。山括弧や前後の空白は含めない
- `email_normalized` はメールアドレスを小文字化した値。重複判定に使う
- 時刻は UTC の ISO 8601 文字列
- ユーザー ID は `IdProvider.newUserId()` を通して `node:crypto` の `randomUUID()`（UUID v4）を使って生成する（SQLite には UUID 生成関数が無いため）

## 初期化と接続設定

- `src/repositories/sqlite/init.sql` を `open` のたびに読み込んで実行する（`IF NOT EXISTS` なので何度実行しても安全）。マイグレーションツールは使わない
- `SqliteUserRepository.open(path, signal)` が接続を 1 つだけ所有する `SqliteUserRepository` を返す（`Promise`）。接続確認、WAL の確認、スキーマ初期化のどれかに失敗した場合は接続を閉じる。利用後は `close()` で閉じる
- `SqliteUserRepository` のコンストラクタは公開せず、`open` が返した値だけを使う
- 空のパスは拒否し、親ディレクトリは自動作成しない
- 接続前に、直上の親ディレクトリと既存の DB・`-wal`・`-shm`・`-journal` ファイルが実効 UID（`process.geteuid()`）の所有であり、グループと他ユーザーへの権限がない（`mode & 0o077` が 0）ことを `fs.lstat` で検査する。親は実ディレクトリ、既存ファイルは通常ファイルに限り、これらのパス自体がシンボリックリンクの場合も拒否する。所有者以外に権限がある場合は、権限を自動変更せず起動エラーにする。パスの祖先は信頼でき、実行中に外部から置き換えられないことを前提とする
- 新規 DB は SQLite の接続前に、排他的なファイル作成（`fs.open` のフラグ `'wx'`、モード `0o600`）で用意する。WAL・SHM・ジャーナルも DB の権限を引き継ぐ。プロセス全体の umask は変更しない。中断済みの `signal` ではファイル作成を開始しない
- パスは Linux（WSL）の形式を前提とし、Windows のドライブ文字付きのパスは扱わない
- パスは `path.resolve` で絶対パスにしてから `Database` に渡す。`/` で始まる絶対パスに限ることで、`file:` で始まる URI として解釈させない
- 接続は 1 つだけなので、接続ごとの設定は開いた直後に一度だけ行う。外部キー制約と busy timeout はコンストラクタのオプションで、WAL は `PRAGMA journal_mode = WAL` で設定する
- SQLite は `journal_mode` を変更できない保存先（共有メモリを使えない VFS など）でエラーにせず元のモードのまま続けるため、`open` は `PRAGMA journal_mode = WAL` の結果を読み、`wal` でなければエラーにする
- WAL への切り替えが `SQLITE_BUSY` になった場合（他のプロセスが DB を使っている場合）は、接続を閉じ、残り時間を上限として最大 10ms 待ってから、新しい接続による切り替えを再試行する。再試行の開始は最初の試行から 5 秒以内に限り、`signal` の中断でも終了する。5 秒経過時は直近の DB エラーを投げ、`signal` が中断された場合はその理由も `cause` に含める。再試行は `open` の WAL 切り替えだけに限定し、スキーマ初期化・通常の読み書き・`SQLITE_BUSY` 以外のエラーには適用しない
- 10ms は `SQLITE_BUSY` が返った後の再試行までの待機時間であり、SQLite 内部のロック待ちを含む試行間隔ではない。busy timeout は WAL 切り替え中も `5000` のままとする。最初の試行で 5 秒以上を使った場合は再試行を開始せず、そのエラーを返す。5 秒は再試行の開始期限であり、`open` 全体の完了期限でも、一定回数の再試行を保証する時間でもない。同期の PRAGMA 実行中のロック待ちは中断できず、期限前に開始した試行は期限を超えて続く場合がある（[既知の制限](../README.md#既知の制限)）

| 設定 | 指定方法 | 値 | 理由 |
|---|---|---|---|
| 外部キー制約 | オプション `enableForeignKeyConstraints` | `true` | 既定値も `true` だが、依存する設定として明示する |
| busy timeout | オプション `timeout` | `5000` | 他のプロセスとの書き込み競合時に即エラーにせず待つ |
| `journal_mode` | `PRAGMA journal_mode = WAL` | `WAL` | 他のプロセスの読み込みと、このプロセスの書き込みを並行できる |
| トランザクションの開始 | `BEGIN IMMEDIATE` | — | 開始時に書き込みロックを取り、読み込み→書き込みへの昇格時に busy timeout が効かず即 `SQLITE_BUSY` になる問題を防ぐ |

## 書き込み

- 登録時は `users` と `password_credentials` を 1 トランザクション（`BEGIN IMMEDIATE` … `COMMIT`。失敗時は `ROLLBACK`）で挿入する
- `node:sqlite` が SQLite のエラーを投げると、`code` が `'ERR_SQLITE_ERROR'` になり、拡張結果コードが数値の `errcode` に入る。`errcode` は Node のドキュメントに記載が無いため、対象の Node 26 系（26.11.0 以上）での形を [テスト](#テスト)で固定する。Node の更新で形が変わった場合は、このテストが失敗して気づける
- 下の UNIQUE 違反と `SQLITE_BUSY` の判定は、`code` が `'ERR_SQLITE_ERROR'` で、かつ `errcode` が数値の場合に限って行う。どちらかを満たさないエラーは、メール重複にも `BusyError` にも変換せず、予期しないエラーとして文脈を付けて投げる（エラーハンドリング Middleware で 500）。メッセージの文字列での判定はしない。説明の `errstr` やメッセージは判定にもログにも使わない。SQLite のエラーを `cause` に置くときは、元のエラーの代わりに `code`・`errcode` と、`errcode` だけから作るメッセージ（例：`SQLite error 2067.`）を持つエラーを置き、元のメッセージを上位へ伝えない
- メールアドレスの重複は `users` 挿入時の UNIQUE 制約違反（`errcode` が `SQLITE_CONSTRAINT_UNIQUE`＝2067）で検出し、`EmailTakenError` に変換する。API 層がこれを 409 に変換する。ID の PRIMARY KEY 制約違反（`SQLITE_CONSTRAINT_PRIMARYKEY`＝1555）など、ほかの制約違反はメール重複として扱わない
- ハッシュ更新では `hash` と `changed_at` を同時に更新する。時刻はスキーマと同じ UTC の ISO 8601 文字列とする。更新対象の資格情報が存在しなければ `UserNotFoundError` を投げる
- 保存層は受け取った正規化済みメールアドレスと PHC 文字列をそのまま扱い、正規化やハッシュの解析を繰り返さない
- 接続は 1 つで API は同期のため、このプロセス内の書き込みは常に 1 つずつ実行され、互いに競合しない。`SQLITE_BUSY` になるのは、他のプロセス（`sqlite3` コマンドなど）が DB のロックを持っている場合に限られる
- busy timeout を超えてもロックを取れない場合（`errcode & 0xff` が `SQLITE_BUSY`＝5）は、業務の `BusyError` を `cause` 付きで投げ、API 層がこれを 503 に変換する
- 同期の呼び出しは `signal` で中断できない。呼び出しの前に `signal` が中断されていれば実行せず、失敗したときに `signal` が中断されていれば、SQLite のエラーにかかわらず `signal.reason` を `cause` に含めた `BusyError` を投げる
- 登録の流量は Argon2id のセマフォ（[同時実行制限](password.md#同時実行制限)）で絞られる

## テスト

- Vitest の各テストで一時ディレクトリ（`fs.mkdtemp`）に SQLite ファイルを作り、毎回まっさらな DB で実行する（skip しない）
- 接続後の `PRAGMA busy_timeout` が `5000` であること、WAL 切り替えの失敗後の待機と 5 秒の再試行開始期限、スキーマ初期化は再試行しないことを検証する
