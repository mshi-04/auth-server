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
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../errors/index.ts";
import { loadConfig } from "./index.ts";

describe("loadConfig", () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "auth-server-config-"));
    path = join(directory, "auth.db");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("loads only the supplied environment without creating a database", async () => {
    const env = { DATABASE_PATH: path, PORT: "9000" };
    expect(loadConfig(env)).toEqual({ databasePath: path, port: 9000 });
    expect(env).toEqual({ DATABASE_PATH: path, PORT: "9000" });
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([undefined, ""])("defaults an absent or empty PORT (%s)", (port) => {
    const env: NodeJS.ProcessEnv = { DATABASE_PATH: path };
    if (port !== undefined) {
      env.PORT = port;
    }
    expect(loadConfig(env).port).toBe(8080);
  });

  it.each([
    { raw: "1", expected: 1 },
    { raw: "65535", expected: 65535 },
    { raw: "08080", expected: 8080 },
  ])("parses decimal PORT $raw", ({ raw, expected }) => {
    expect(loadConfig({ DATABASE_PATH: path, PORT: raw }).port).toBe(expected);
  });

  it.each([
    "0",
    "65536",
    "-1",
    "+80",
    " 80",
    "80 ",
    "80\n",
    "80\r\n",
    "1.5",
    "0x50",
    "8e1",
    "http",
    "８０",
    "Infinity",
    "9".repeat(100),
  ])("rejects invalid PORT %j before creating a database", async (port) => {
    expect(() => loadConfig({ DATABASE_PATH: path, PORT: port })).toThrow(
      ConfigError,
    );
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([undefined, ""])(
    "rejects missing DATABASE_PATH (%s)",
    (databasePath) => {
      const env: NodeJS.ProcessEnv = {};
      if (databasePath !== undefined) {
        env.DATABASE_PATH = databasePath;
      }
      expect(() => loadConfig(env)).toThrow(ConfigError);
      expect(() => loadConfig(env)).toThrow("DATABASE_PATH is required");
    },
  );

  it("makes relative paths absolute", () => {
    const raw = relative(process.cwd(), path);
    expect(loadConfig({ DATABASE_PATH: raw }).databasePath).toBe(path);
  });

  it.each(["/mnt/c", "/mnt/c/auth.db", "/mnt/c/../c/auth.db"])(
    "rejects Windows-drive path %s before filesystem access",
    (databasePath) => {
      expect(() => loadConfig({ DATABASE_PATH: databasePath })).toThrow(
        "DATABASE_PATH must not be under /mnt/c",
      );
    },
  );

  it("accepts an existing file without changing its contents or permissions", async () => {
    await writeFile(path, "existing database contents", { mode: 0o600 });
    await chmod(path, 0o644);
    expect(loadConfig({ DATABASE_PATH: path }).databasePath).toBe(path);
    expect(await readFile(path, "utf8")).toBe("existing database contents");
    expect((await lstat(path)).mode & 0o777).toBe(0o644);
  });

  it("leaves filesystem type checks to the repository", () => {
    expect(loadConfig({ DATABASE_PATH: directory }).databasePath).toBe(
      directory,
    );
  });

  it("does not create a missing parent directory", async () => {
    const parent = join(directory, "missing");
    expect(() =>
      loadConfig({ DATABASE_PATH: join(parent, "auth.db") }),
    ).toThrow(ConfigError);
    await expect(lstat(parent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not expand a tilde", () => {
    expect(() => loadConfig({ DATABASE_PATH: "~/auth.db" })).toThrow(
      ConfigError,
    );
  });

  it("retains the cause of filesystem failures", () => {
    try {
      loadConfig({ DATABASE_PATH: join(directory, "missing", "auth.db") });
      expect.fail("missing parent accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      if (!(error instanceof ConfigError)) {
        throw error;
      }
      expect(error.cause).toMatchObject({ code: "ENOENT" });
    }
  });

  it.each(["", "auth.db"])(
    "rejects a Windows-drive symlink after resolving links (%s)",
    async (file) => {
      const link = join(directory, "windows");
      await symlink("/mnt/c", link);
      expect(() => loadConfig({ DATABASE_PATH: join(link, file) })).toThrow(
        "DATABASE_PATH must not resolve under /mnt/c",
      );
    },
  );

  it("rejects a dangling final symlink instead of treating it as a new database", async () => {
    await symlink(join(directory, "nonexistent.db"), path);
    expect(() => loadConfig({ DATABASE_PATH: path })).toThrow(
      "Resolve DATABASE_PATH links failed",
    );
  });

  it("preserves safe parent symlinks for the repository to inspect", async () => {
    const target = join(directory, "target");
    const link = join(directory, "link");
    await mkdir(target);
    await symlink(target, link);
    const unresolvedPath = join(link, "auth.db");
    expect(loadConfig({ DATABASE_PATH: unresolvedPath }).databasePath).toBe(
      unresolvedPath,
    );
    await expect(lstat(join(target, "auth.db"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves existing safe file symlinks for the repository to reject", async () => {
    const target = join(directory, "existing.db");
    await writeFile(target, "existing database contents", { mode: 0o600 });
    await symlink(target, path);
    expect(loadConfig({ DATABASE_PATH: path }).databasePath).toBe(path);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });
});
