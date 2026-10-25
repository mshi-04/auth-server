import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BusyError } from "../../auth/index.ts";
import { prepareDatabaseFile, requirePrivateOwnership } from "./permissions.ts";

const runFile = promisify(execFile);
const suffixes = ["", "-wal", "-shm", "-journal"];
const signal = new AbortController().signal;

async function currentUmask(): Promise<number> {
  const status = await readFile("/proc/self/status", "utf8");
  const value = /^Umask:\s+([0-7]+)$/m.exec(status)?.[1];
  if (value === undefined) {
    throw new Error("Linux process status did not report its umask.");
  }
  return Number.parseInt(value, 8);
}

describe("sqlite database filesystem preparation", () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "auth-server-permissions-"));
    path = join(directory, "auth.db");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("creates an empty owner-only database without changing the umask", async () => {
    const originalUmask = await currentUmask();
    await prepareDatabaseFile(path, signal);
    const info = await lstat(path);
    expect(info.isFile()).toBe(true);
    expect(info.mode & 0o777).toBe(0o600 & ~originalUmask);
    expect(info.uid).toBe(process.geteuid?.());
    expect(info.size).toBe(0);
    expect(await currentUmask()).toBe(originalUmask);
  });

  it("rechecks a database that another preparation created concurrently", async () => {
    await Promise.all([
      prepareDatabaseFile(path, signal),
      prepareDatabaseFile(path, signal),
    ]);
    expect((await lstat(path)).mode & 0o077).toBe(0);
  });

  it("preserves an existing private database and all sidecars", async () => {
    for (const suffix of suffixes) {
      await writeFile(path + suffix, "existing contents", { mode: 0o600 });
    }
    await prepareDatabaseFile(path, signal);
    for (const suffix of suffixes) {
      expect(await readFile(path + suffix, "utf8")).toBe("existing contents");
      expect((await lstat(path + suffix)).mode & 0o777).toBe(0o600);
    }
  });

  it.each([0o750, 0o704, 0o701])(
    "rejects parent permissions %s without repairing them or creating a database",
    async (mode) => {
      await chmod(directory, mode);
      await expect(prepareDatabaseFile(path, signal)).rejects.toThrow(
        "permissions must be disabled",
      );
      expect((await lstat(directory)).mode & 0o777).toBe(mode);
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(suffixes)(
    "rejects accessible database%s without changing its data or permissions",
    async (suffix) => {
      await writeFile(path + suffix, "must remain unchanged", { mode: 0o600 });
      await chmod(path + suffix, 0o644);
      await expect(prepareDatabaseFile(path, signal)).rejects.toThrow(
        "permissions must be disabled",
      );
      expect(await readFile(path + suffix, "utf8")).toBe(
        "must remain unchanged",
      );
      expect((await lstat(path + suffix)).mode & 0o777).toBe(0o644);
      if (suffix !== "") {
        await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it.each(suffixes)("rejects a database%s symlink", async (suffix) => {
    const target = join(directory, "target");
    await writeFile(target, "must remain unchanged", { mode: 0o600 });
    await symlink(target, path + suffix);
    await expect(prepareDatabaseFile(path, signal)).rejects.toThrow(
      "must be regular files",
    );
    expect(await readFile(target, "utf8")).toBe("must remain unchanged");
  });

  it.each(suffixes)("rejects a directory at database%s", async (suffix) => {
    await mkdir(path + suffix, { mode: 0o700 });
    await expect(prepareDatabaseFile(path, signal)).rejects.toThrow(
      "must be regular files",
    );
  });

  it.each(suffixes)("rejects a FIFO at database%s", async (suffix) => {
    await runFile("mkfifo", ["-m", "600", path + suffix]);
    await expect(prepareDatabaseFile(path, signal)).rejects.toThrow(
      "must be regular files",
    );
  });

  it("rejects a symlink used as the immediate parent", async () => {
    const target = join(directory, "target");
    const linked = join(directory, "linked");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linked);
    await expect(
      prepareDatabaseFile(join(linked, "auth.db"), signal),
    ).rejects.toThrow("parent must be a real directory");
    await expect(lstat(join(target, "auth.db"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a regular file used as the immediate parent", async () => {
    const parent = join(directory, "parent");
    await writeFile(parent, "unchanged", { mode: 0o600 });
    await expect(
      prepareDatabaseFile(join(parent, "auth.db"), signal),
    ).rejects.toThrow("parent must be a real directory");
    expect(await readFile(parent, "utf8")).toBe("unchanged");
  });

  it("does not create a missing parent", async () => {
    const missing = join(directory, "missing");
    await expect(
      prepareDatabaseFile(join(missing, "auth.db"), signal),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("adds context to a failed file inspection", async () => {
    await chmod(directory, 0o600);
    try {
      await expect(prepareDatabaseFile(path, signal)).rejects.toMatchObject({
        message: "Inspect sqlite database file failed.",
        cause: { code: "EACCES" },
      });
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it("adds context when exclusive creation fails", async () => {
    await chmod(directory, 0o500);
    try {
      await expect(prepareDatabaseFile(path, signal)).rejects.toMatchObject({
        message: "Create private sqlite database failed.",
        cause: { code: "EACCES" },
      });
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it("does not create a database for an already aborted signal", async () => {
    const reason = new Error("client disconnected");
    const aborted = AbortSignal.abort(reason);
    await expect(prepareDatabaseFile(path, aborted)).rejects.toBeInstanceOf(
      BusyError,
    );
    await expect(prepareDatabaseFile(path, aborted)).rejects.toMatchObject({
      cause: reason,
    });
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create a database when aborted during filesystem preparation", async () => {
    const controller = new AbortController();
    const reason = new Error("deadline exceeded");
    const pending = prepareDatabaseFile(path, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toMatchObject({
      name: "BusyError",
      cause: reason,
    });
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects another owner's private metadata", async () => {
    const info = await lstat(directory);
    expect(() => {
      requirePrivateOwnership({ uid: info.uid + 1, mode: info.mode });
    }).toThrow("owner must match the effective user");
  });
});
