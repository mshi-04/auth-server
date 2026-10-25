import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "node:sqlite";
import { EmailTakenError, UserNotFoundError } from "../../auth/index.ts";
import type { Credential, NewUser, UserStore } from "../../auth/index.ts";
import { operationError, sqliteCode, throwIfAborted } from "./errors.ts";
import { openDatabase } from "./initialization.ts";
import { prepareDatabaseFile } from "./permissions.ts";

export class SqliteStore implements UserStore {
  #db: Database;

  private constructor(db: Database) {
    this.#db = db;
  }

  static async open(path: string, signal: AbortSignal): Promise<SqliteStore> {
    let db: Database | undefined;
    try {
      throwIfAborted(signal);
      if (path === "") {
        throw new Error("Empty SQLite database path.");
      }
      const absolutePath = resolve(path);
      await prepareDatabaseFile(absolutePath, signal);
      const schema = await readFile(
        new URL("./init.sql", import.meta.url),
        "utf8",
      );
      throwIfAborted(signal);
      db = await openDatabase(absolutePath, signal);
      throwIfAborted(signal);
      db.exec(schema);
      return new SqliteStore(db);
    } catch (error) {
      db?.close();
      throw operationError(error, "Open SQLite database failed.", signal);
    }
  }

  close(): void {
    this.#db.close();
  }

  createUser(user: NewUser, signal: AbortSignal): Promise<void> {
    try {
      throwIfAborted(signal);
      this.#db.exec("BEGIN IMMEDIATE");
      let committed = false;
      try {
        try {
          this.#db
            .prepare(
              "INSERT INTO users (id, email, email_normalized) VALUES (?, ?, ?)",
            )
            .run(user.id, user.email, user.emailNormalized);
        } catch (error) {
          if (sqliteCode(error) === 2067) {
            throw new EmailTakenError(undefined, { cause: error });
          }
          throw error;
        }
        this.#db
          .prepare(
            "INSERT INTO password_credentials (user_id, hash) VALUES (?, ?)",
          )
          .run(user.id, user.passwordHash);
        this.#db.exec("COMMIT");
        committed = true;
      } finally {
        if (!committed && this.#db.isTransaction) {
          this.#db.exec("ROLLBACK");
        }
      }
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(
        operationError(error, "Create SQLite user failed.", signal),
      );
    }
  }

  findCredentialByEmail(
    emailNormalized: string,
    signal: AbortSignal,
  ): Promise<Credential> {
    try {
      throwIfAborted(signal);
      const row = this.#db
        .prepare(
          `
        SELECT c.user_id, c.hash
        FROM users AS u JOIN password_credentials AS c ON c.user_id = u.id
        WHERE u.email_normalized = ?
      `,
        )
        .get(emailNormalized);
      if (row === undefined) {
        throw new UserNotFoundError();
      }
      if (typeof row.user_id !== "string" || typeof row.hash !== "string") {
        throw new Error("Invalid SQLite credential row.");
      }
      return Promise.resolve({ userId: row.user_id, passwordHash: row.hash });
    } catch (error) {
      return Promise.reject(
        operationError(error, "Find SQLite credential failed.", signal),
      );
    }
  }

  updatePasswordHash(
    userId: string,
    passwordHash: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      throwIfAborted(signal);
      const result = this.#db
        .prepare(
          `
        UPDATE password_credentials
        SET hash = ?, changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE user_id = ?
      `,
        )
        .run(passwordHash, userId);
      if (result.changes === 0) {
        throw new UserNotFoundError();
      }
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(
        operationError(error, "Update SQLite password hash failed.", signal),
      );
    }
  }
}
