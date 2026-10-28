import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHttpServer,
  loadWebAssets,
  run,
  serve,
  shutdownServer,
} from "./index.ts";
import { EncodedHash } from "./models/index.ts";
import type { Credential, Password } from "./models/index.ts";
import type {
  IdProvider,
  LoggerProvider,
  PasswordProvider,
} from "./providers/index.ts";
import type { UserRepository } from "./repositories/index.ts";
import { AuthService } from "./services/index.ts";

class MemoryLogger implements LoggerProvider {
  errors: unknown[] = [];
  listening = Promise.withResolvers<undefined>();
  info(): void {
    this.listening.resolve(undefined);
  }
  warn(): void {}
  error(_message: string, attributes?: Record<string, unknown>): void {
    this.errors.push(attributes);
  }
}

class TestRepository implements UserRepository {
  createUser(): Promise<void> {
    return Promise.resolve();
  }
  findCredentialByEmail(): Promise<Credential> {
    return Promise.resolve({ userId: "user-1", passwordHash: hash.phc() });
  }
  updatePasswordHash(): Promise<void> {
    return Promise.resolve();
  }
}

const hash = EncodedHash.parse(
  "$argon2id$v=19$m=32,t=1,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaA",
);

class TestPasswords implements PasswordProvider {
  entered = Promise.withResolvers<AbortSignal>();
  result = Promise.withResolvers<boolean>();
  hash(): Promise<EncodedHash> {
    return Promise.resolve(hash);
  }
  rehash(): Promise<EncodedHash> {
    return Promise.resolve(hash);
  }
  verify(
    _password: Password,
    _encoded: EncodedHash,
    signal: AbortSignal,
  ): Promise<boolean> {
    this.entered.resolve(signal);
    return this.result.promise;
  }
  needsRehash(): boolean {
    return false;
  }
}

const ids: IdProvider = {
  newUserId: () => "user-1",
  newDummyPassword: () => "dummy-test-password",
};

async function httpFixture() {
  const logger = new MemoryLogger();
  const passwords = new TestPasswords();
  const service = await AuthService.create(
    new TestRepository(),
    passwords,
    ids,
    logger,
    new AbortController().signal,
  );
  const assets = await loadWebAssets();
  const server = createHttpServer(service, assets, logger);
  return { server, logger, passwords };
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected an IP listener.");
  }
  return address.port;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HTTP server composition", () => {
  it("loads exactly the unchanged Go web assets", async () => {
    const assets = await loadWebAssets();
    for (const [key, filename] of [
      ["html", "index.html"],
      ["css", "app.css"],
      ["js", "app.js"],
    ] satisfies [keyof typeof assets, string][]) {
      const original = await readFile(
        new URL(`../internal/httpapi/web/${filename}`, import.meta.url),
      );
      expect(assets[key]).toEqual(original);
    }
  });

  it("configures the specified HTTP timeouts and serves the composed routes", async () => {
    const { server, logger } = await httpFixture();
    expect(server.headersTimeout).toBe(5_000);
    expect(server.requestTimeout).toBe(10_000);
    expect(server.keepAliveTimeout).toBe(60_000);
    const checkingInterval: unknown = Reflect.get(
      server,
      "connectionsCheckingInterval",
    );
    expect(checkingInterval).toBe(1_000);
    const port = await listen(server);
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
      expect(logger.errors).toEqual([]);
    } finally {
      await shutdownServer(server);
    }
  });

  it("returns a common 404 Problem Details response to an authority-form CONNECT", async () => {
    const { server } = await httpFixture();
    const port = await listen(server);
    const socket = connect(port, "127.0.0.1");
    try {
      const received: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => received.push(chunk));
      const ended = once(socket, "end");
      socket.write(
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n",
      );
      await ended;
      const response = Buffer.concat(received).toString("utf8");
      expect(response).toMatch(/^HTTP\/1\.1 404 Not Found/u);
      expect(response).toContain("application/problem+json");
      expect(response).toContain("Cache-Control: no-store");
      expect(response).toContain('"status":404');
    } finally {
      socket.destroy();
      await shutdownServer(server);
    }
  });

  it("keeps the original response deadline across body reception and service work", async () => {
    const { server, passwords, logger } = await httpFixture();
    const port = await listen(server);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const entered = new Promise<ServerResponse>((resolve) => {
      server.once("request", (_req, res) => {
        resolve(res);
      });
    });
    const client = request({
      port,
      host: "127.0.0.1",
      path: "/v1/sessions",
      method: "POST",
    });
    let responded = false;
    client.on("response", () => {
      responded = true;
    });
    const failed = once(client, "error");
    try {
      client.write('{"email":"a@example.com","password":');
      await entered;
      await vi.advanceTimersByTimeAsync(9_000);
      client.end('"test-password"}');
      const signal = await passwords.entered.promise;
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(21_000);
      expect(signal.aborted).toBe(true);
      passwords.result.resolve(true);
      await failed;
      expect(responded).toBe(false);
      expect(logger.errors).toEqual([]);
    } finally {
      passwords.result.resolve(true);
      client.destroy();
      vi.useRealTimers();
      await shutdownServer(server);
    }
  });
});

describe("server startup and shutdown", () => {
  it("listens on IPv4 all interfaces and stops accepting connections on abort", async () => {
    const logger = new MemoryLogger();
    const controller = new AbortController();
    const server = createServer((_req, res) => res.end());
    const serving = serve(server, 0, logger, controller.signal);
    await logger.listening.promise;
    const address = server.address();
    expect(address).toMatchObject({ address: "0.0.0.0", family: "IPv4" });
    controller.abort();
    await serving;
    expect(server.listening).toBe(false);
  });

  it("waits for an active response before completing shutdown", async () => {
    const server = createServer();
    const port = await listen(server);
    const entered = new Promise<ServerResponse>((resolve) => {
      server.once("request", (_req, res) => {
        resolve(res);
      });
    });
    const response = fetch(`http://127.0.0.1:${String(port)}/`);
    const res = await entered;
    let stopped = false;
    const shuttingDown = (async () => {
      await shutdownServer(server);
      stopped = true;
    })();
    try {
      await Promise.resolve();
      expect(stopped).toBe(false);
      res.end("completed");
      expect(await (await response).text()).toBe("completed");
      await shuttingDown;
      expect(stopped).toBe(true);
    } finally {
      server.closeAllConnections();
      await shuttingDown;
    }
  });

  it("finishes serving when the listener closes independently", async () => {
    const server = createServer();
    const logger = new MemoryLogger();
    const serving = serve(server, 0, logger, new AbortController().signal);
    await logger.listening.promise;
    server.close();
    await serving;
    expect(server.listening).toBe(false);
  });

  it("forcibly closes remaining connections after 30 seconds", async () => {
    const server = createServer();
    const port = await listen(server);
    const entered = once(server, "request");
    const response = fetch(`http://127.0.0.1:${String(port)}/`).catch(
      (error: unknown) => error,
    );
    await entered;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const shuttingDown = shutdownServer(server);
      await vi.advanceTimersByTimeAsync(30_000);
      await shuttingDown;
      expect(await response).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
      server.closeAllConnections();
      await shutdownServer(server);
    }
  });

  it("does not listen when the startup signal is already aborted", async () => {
    const server = createServer();
    await expect(
      serve(
        server,
        0,
        new MemoryLogger(),
        AbortSignal.abort(new Error("stop")),
      ),
    ).rejects.toThrow("stop");
    expect(server.listening).toBe(false);
  });

  it("propagates listen failures and releases the server", async () => {
    const occupied = createServer();
    const port = await listen(occupied);
    const server = createServer();
    try {
      await expect(
        serve(server, port, new MemoryLogger(), new AbortController().signal),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(server.listening).toBe(false);
    } finally {
      await shutdownServer(occupied);
    }
  });

  it("rejects invalid configuration before opening a database", async () => {
    await expect(
      run({}, new MemoryLogger(), new AbortController().signal),
    ).rejects.toThrow("DATABASE_PATH is required");
  });

  it.each(["SIGINT", "SIGTERM"] satisfies NodeJS.Signals[])(
    "starts the actual entry point and shuts down on %s",
    async (signal) => {
      const directory = await mkdtemp(join(tmpdir(), "auth-server-entry-"));
      const reservation = createServer();
      const port = await listen(reservation);
      await shutdownServer(reservation);
      const child = spawn(
        process.execPath,
        [new URL("./index.ts", import.meta.url).pathname],
        {
          env: {
            ...process.env,
            DATABASE_PATH: join(directory, "auth.db"),
            PORT: String(port),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const closed = once(child, "close");
      try {
        const ready = new Promise<void>((resolve, reject) => {
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString("utf8");
            if (output.includes('"msg":"auth server listening"')) resolve();
          });
          child.once("error", reject);
          child.once("exit", (code) => {
            reject(new Error(`Exited before ready: ${String(code)}`));
          });
        });
        await ready;
        const response = await fetch(
          `http://127.0.0.1:${String(port)}/healthz`,
        );
        expect(response.status).toBe(200);
        await response.text();
        child.kill(signal);
        expect(await closed).toEqual([0, null]);
      } finally {
        child.kill("SIGKILL");
        await closed;
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
