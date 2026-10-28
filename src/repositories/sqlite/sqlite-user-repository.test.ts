import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  BusyError,
  EmailTakenError,
  UserNotFoundError,
  findError,
} from "../../errors/index.ts";
import type { NewUser } from "../../models/index.ts";
import type { UserRepository } from "../index.ts";
import { SqliteUserRepository } from "./index.ts";

const signal = new AbortController().signal;
const stores = new Set<SqliteUserRepository>();
const observers = new Set<Database>();
const directories: string[] = [];
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

afterEach(async () => {
  for (const observer of observers) {
    observer.close();
  }
  observers.clear();
  for (const store of stores) {
    store.close();
  }
  stores.clear();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function openTestStore() {
  const directory = await mkdtemp(join(tmpdir(), "auth-store-"));
  directories.push(directory);
  const path = join(directory, "auth.db");
  const store = await SqliteUserRepository.open(path, signal);
  stores.add(store);
  const observer = new Database(path);
  observers.add(observer);
  return { store, observer, path };
}

function testUser(): NewUser {
  return {
    id: "a48c1eb0-6c1b-4780-993d-208ed5e1212a",
    email: "Person@Example.test",
    emailNormalized: "ExactCase@Example.test",
    passwordHash: "$argon2id$v=19$p=2,t=3,m=65536$c2FsdA$aGFzaA",
  };
}

function rowCount(observer: Database, table: "users" | "password_credentials") {
  return observer.prepare(`SELECT count(*) AS count FROM ${table}`).get()
    ?.count;
}

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}

function requireTimestamp(value: unknown, before: number, after: number) {
  expect(value).toEqual(expect.stringMatching(timestampPattern));
  if (typeof value !== "string") {
    throw new Error("expected a timestamp string");
  }
  expect(Date.parse(value)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(value)).toBeLessThanOrEqual(after);
}

describe("SqliteUserRepository", () => {
  it("initializes empty strict tables in WAL mode and preserves data after reopening", async () => {
    const { store, observer, path } = await openTestStore();
    expect(rowCount(observer, "users")).toBe(0);
    expect(rowCount(observer, "password_credentials")).toBe(0);
    expect(observer.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(
      observer
        .prepare(
          "SELECT name, strict FROM pragma_table_list WHERE name IN ('users', 'password_credentials') ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "password_credentials", strict: 1 },
      { name: "users", strict: 1 },
    ]);
    const user = testUser();
    const contract: UserRepository = store;
    await contract.createUser(user, signal);
    store.close();
    stores.delete(store);
    const reopened = await SqliteUserRepository.open(path, signal);
    stores.add(reopened);
    await expect(
      reopened.findCredentialByEmail(user.emailNormalized, signal),
    ).resolves.toEqual({ userId: user.id, passwordHash: user.passwordHash });
    expect(rowCount(observer, "users")).toBe(1);
    expect(rowCount(observer, "password_credentials")).toBe(1);
  });

  it("stores exact email and PHC text and initializes UTC timestamps", async () => {
    const { store, observer } = await openTestStore();
    const user = testUser();
    const before = Date.now();
    await store.createUser(user, signal);
    const after = Date.now();
    const row = observer
      .prepare(
        `SELECT u.email, u.email_normalized, u.created_at, c.hash, c.changed_at
         FROM users u JOIN password_credentials c ON c.user_id = u.id WHERE u.id = ?`,
      )
      .get(user.id);
    expect(row).toMatchObject({
      email: user.email,
      email_normalized: user.emailNormalized,
      hash: user.passwordHash,
    });
    requireTimestamp(row?.created_at, before, after);
    requireTimestamp(row?.changed_at, before, after);
    await expect(
      store.findCredentialByEmail(user.emailNormalized, signal),
    ).resolves.toEqual({ userId: user.id, passwordHash: user.passwordHash });
    for (const email of [
      "missing@example.test",
      user.emailNormalized.toLowerCase(),
      user.email,
    ]) {
      expect(
        findError(
          await rejected(store.findCredentialByEmail(email, signal)),
          UserNotFoundError,
        ),
      ).toBeInstanceOf(UserNotFoundError);
    }
  });

  it("preserves SQL metacharacters through bound parameters", async () => {
    const { store, observer } = await openTestStore();
    const user = {
      id: "id'; DROP TABLE users; --",
      email: "original'@Example.test",
      emailNormalized: "normalized'@Example.test",
      passwordHash: "unparsed ' hash; DROP TABLE users; --",
    };
    await store.createUser(user, signal);
    await expect(
      store.findCredentialByEmail(user.emailNormalized, signal),
    ).resolves.toEqual({ userId: user.id, passwordHash: user.passwordHash });
    expect(rowCount(observer, "users")).toBe(1);
  });

  it.each([
    {
      name: "email",
      id: "another-user",
      email: "ExactCase@Example.test",
      taken: true,
      errcode: 2067,
    },
    {
      name: "id",
      id: "a48c1eb0-6c1b-4780-993d-208ed5e1212a",
      email: "another@example.test",
      taken: false,
      errcode: 1555,
    },
  ])(
    "distinguishes duplicate $name constraints",
    async ({ id, email, taken, errcode }) => {
      const { store, observer } = await openTestStore();
      const original = testUser();
      await store.createUser(original, signal);
      const duplicate = { ...original, id, emailNormalized: email };
      let failure: unknown;
      try {
        await store.createUser(duplicate, signal);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(findError(failure, EmailTakenError) !== undefined).toBe(taken);
      expect(findSqliteError(failure)).toMatchObject({
        code: "ERR_SQLITE_ERROR",
        errcode,
      });
      if (failure instanceof Error) {
        for (const value of Object.values(duplicate)) {
          expect(failure.message).not.toContain(value);
        }
      }
      expect(rowCount(observer, "users")).toBe(1);
      expect(rowCount(observer, "password_credentials")).toBe(1);
    },
  );

  it("rolls back both inserts when credential insertion fails and remains usable", async () => {
    const { store, observer } = await openTestStore();
    observer.exec(`CREATE TRIGGER reject_credentials BEFORE INSERT ON password_credentials
      BEGIN SELECT RAISE(ABORT, 'credential insertion rejected'); END`);
    const user = testUser();
    const failure = await rejected(store.createUser(user, signal));
    expect(failure).toBeInstanceOf(Error);
    expect(findError(failure, EmailTakenError)).toBeUndefined();
    expect(findSqliteError(failure)?.message).toMatch(/^SQLite error \d+\.$/);
    expect(causeMessages(failure).join("\n")).not.toContain(
      "credential insertion rejected",
    );
    expect(rowCount(observer, "users")).toBe(0);
    expect(rowCount(observer, "password_credentials")).toBe(0);
    observer.exec("DROP TRIGGER reject_credentials");
    await expect(store.createUser(user, signal)).resolves.toBeUndefined();
  });

  it("does not classify a UNIQUE violation during credential insertion as an email conflict", async () => {
    const { store, observer } = await openTestStore();
    const user = testUser();
    await store.createUser(user, signal);
    observer.exec(
      "CREATE UNIQUE INDEX credential_hash ON password_credentials (hash)",
    );
    const failure = await rejected(
      store.createUser(
        {
          ...user,
          id: "another-user",
          emailNormalized: "another@example.test",
        },
        signal,
      ),
    );
    expect(findSqliteError(failure)).toMatchObject({
      code: "ERR_SQLITE_ERROR",
      errcode: 2067,
    });
    expect(findError(failure, EmailTakenError)).toBeUndefined();
    expect(rowCount(observer, "users")).toBe(1);
    expect(rowCount(observer, "password_credentials")).toBe(1);
  });

  it("enforces foreign keys on the store connection and rolls back failures", async () => {
    const { store, observer } = await openTestStore();
    observer.exec(`CREATE TABLE references_users (id TEXT REFERENCES users(id)) STRICT;
      CREATE TRIGGER require_existing_user AFTER INSERT ON password_credentials
      BEGIN INSERT INTO references_users (id) VALUES ('missing-user'); END`);
    await expect(store.createUser(testUser(), signal)).rejects.toBeInstanceOf(
      Error,
    );
    expect(rowCount(observer, "users")).toBe(0);
    expect(rowCount(observer, "password_credentials")).toBe(0);
  });

  it("rejects values with incompatible SQLite types and cascades user deletion", async () => {
    const { store, observer } = await openTestStore();
    const user = testUser();
    await store.createUser(user, signal);
    expect(() =>
      observer
        .prepare(
          "INSERT INTO users (id, email, email_normalized) VALUES (?, ?, ?)",
        )
        .run(
          new Uint8Array([1]),
          "another@example.test",
          "another@example.test",
        ),
    ).toThrow();
    observer.prepare("DELETE FROM users WHERE id = ?").run(user.id);
    expect(rowCount(observer, "password_credentials")).toBe(0);
    expect(
      findError(
        await rejected(
          store.findCredentialByEmail(user.emailNormalized, signal),
        ),
        UserNotFoundError,
      ),
    ).toBeInstanceOf(UserNotFoundError);
  });

  it("updates hash and changed_at together without modifying created_at", async () => {
    const { store, observer } = await openTestStore();
    const user = testUser();
    await store.createUser(user, signal);
    const createdAt = observer
      .prepare("SELECT created_at FROM users WHERE id = ?")
      .get(user.id)?.created_at;
    observer
      .prepare(
        "UPDATE password_credentials SET changed_at = ? WHERE user_id = ?",
      )
      .run("2000-01-01T00:00:00.000Z", user.id);
    const nextHash = "replacement ' PHC left unparsed";
    const before = Date.now();
    await store.updatePasswordHash(user.id, nextHash, signal);
    const after = Date.now();
    const updated = observer
      .prepare(
        "SELECT hash, changed_at FROM password_credentials WHERE user_id = ?",
      )
      .get(user.id);
    expect(updated?.hash).toBe(nextHash);
    requireTimestamp(updated?.changed_at, before, after);
    expect(
      observer.prepare("SELECT created_at FROM users WHERE id = ?").get(user.id)
        ?.created_at,
    ).toBe(createdAt);
    await expect(
      store.findCredentialByEmail(user.emailNormalized, signal),
    ).resolves.toEqual({ userId: user.id, passwordHash: nextHash });
  });

  it("reports missing credentials for both lookup and update", async () => {
    const { store } = await openTestStore();
    for (const operation of [
      store.findCredentialByEmail("missing@example.test", signal),
      store.updatePasswordHash("missing", "new hash", signal),
    ]) {
      expect(
        findError(await rejected(operation), UserNotFoundError),
      ).toBeInstanceOf(UserNotFoundError);
    }
  });

  it("does not overwrite credentials when an update fails", async () => {
    const { store, observer } = await openTestStore();
    const user = testUser();
    await store.createUser(user, signal);
    const previous = observer
      .prepare(
        "SELECT hash, changed_at FROM password_credentials WHERE user_id = ?",
      )
      .get(user.id);
    observer.exec(`CREATE TRIGGER reject_update BEFORE UPDATE ON password_credentials
      BEGIN SELECT RAISE(ABORT, 'credential update rejected'); END`);
    await expect(
      store.updatePasswordHash(user.id, "replacement", signal),
    ).rejects.toBeInstanceOf(Error);
    expect(
      observer
        .prepare(
          "SELECT hash, changed_at FROM password_credentials WHERE user_id = ?",
        )
        .get(user.id),
    ).toEqual(previous);
  });

  it("checks an aborted signal before reading or changing data and keeps its reason", async () => {
    const { store, observer } = await openTestStore();
    const user = testUser();
    await store.createUser(user, signal);
    const reason = new DOMException("request cancelled", "AbortError");
    const aborted = AbortSignal.abort(reason);
    const calls = [
      () =>
        store.createUser(
          { ...user, id: "another", emailNormalized: "another@example.test" },
          aborted,
        ),
      () => store.findCredentialByEmail(user.emailNormalized, aborted),
      () => store.updatePasswordHash(user.id, "changed", aborted),
    ];
    for (const call of calls) {
      let promise: Promise<unknown> | undefined;
      expect(() => {
        promise = call();
      }).not.toThrow();
      if (promise === undefined) {
        throw new Error("expected a Promise result");
      }
      const failure = await rejected(promise);
      expect(findError(failure, BusyError)).toBeInstanceOf(BusyError);
      expect(findError(failure, DOMException)).toBe(reason);
    }
    expect(rowCount(observer, "users")).toBe(1);
    await expect(
      store.findCredentialByEmail(user.emailNormalized, signal),
    ).resolves.toEqual({ userId: user.id, passwordHash: user.passwordHash });
  });

  it.each(["create", "find", "update"])(
    "rejects rather than throws synchronously for %s on a closed store",
    async (operation) => {
      const { store } = await openTestStore();
      store.close();
      stores.delete(store);
      let promise: Promise<unknown> | undefined;
      expect(() => {
        switch (operation) {
          case "create":
            promise = store.createUser(testUser(), signal);
            return;
          case "find":
            promise = store.findCredentialByEmail(
              "missing@example.test",
              signal,
            );
            return;
          case "update":
            promise = store.updatePasswordHash("missing", "new hash", signal);
            return;
        }
      }).not.toThrow();
      await expect(promise).rejects.toBeInstanceOf(Error);
    },
  );

  it.each(["create", "update"])(
    "maps write-lock timeout in %s to BusyError with the original SQLite code",
    async (operation) => {
      const { store, observer } = await openTestStore();
      const user = testUser();
      await store.createUser(user, signal);
      observer.exec("BEGIN IMMEDIATE");
      try {
        let failure: unknown;
        try {
          if (operation === "create") {
            await store.createUser(
              {
                ...user,
                id: "another",
                emailNormalized: "another@example.test",
              },
              signal,
            );
          } else {
            await store.updatePasswordHash(user.id, "replacement", signal);
          }
        } catch (error) {
          failure = error;
        }
        expect(findError(failure, BusyError)).toBeInstanceOf(BusyError);
        expect(findSqliteError(failure)).toMatchObject({
          code: "ERR_SQLITE_ERROR",
          errcode: 5,
        });
      } finally {
        observer.exec("ROLLBACK");
      }
      expect(rowCount(observer, "users")).toBe(1);
      await expect(
        store.findCredentialByEmail(user.emailNormalized, signal),
      ).resolves.toEqual({ userId: user.id, passwordHash: user.passwordHash });
    },
    15000,
  );
});

function causeMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error && messages.length < 32) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages;
}

function findSqliteError(error: unknown): Error | undefined {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if ("code" in current && current.code === "ERR_SQLITE_ERROR") {
      return current;
    }
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

describe("node:sqlite error contract", () => {
  it("exposes numeric extended UNIQUE and PRIMARY KEY error codes", async () => {
    const { observer } = await openTestStore();
    observer
      .prepare(
        "INSERT INTO users (id, email, email_normalized) VALUES (?, ?, ?)",
      )
      .run("one", "one@example.test", "one@example.test");
    const insert = observer.prepare(
      "INSERT INTO users (id, email, email_normalized) VALUES (?, ?, ?)",
    );
    expect(
      caught(() => insert.run("two", "one@example.test", "one@example.test")),
    ).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 2067 });
    expect(
      caught(() => insert.run("one", "two@example.test", "two@example.test")),
    ).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 1555 });
  });

  it("exposes numeric SQLITE_BUSY rather than a constraint error", async () => {
    const { observer, path } = await openTestStore();
    const waiter = new Database(path, { timeout: 0 });
    observers.add(waiter);
    observer.exec("BEGIN IMMEDIATE");
    try {
      expect(
        caught(() => {
          waiter.exec("BEGIN IMMEDIATE");
        }),
      ).toMatchObject({
        code: "ERR_SQLITE_ERROR",
        errcode: 5,
      });
    } finally {
      observer.exec("ROLLBACK");
    }
  });
});
