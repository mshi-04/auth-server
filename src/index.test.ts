import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Agent, createServer, request } from "node:http";
import type { ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rejected } from "../tests/support/errors.ts";
import { RecordingUserRepository } from "../tests/support/fakes/user-repository.ts";
import { listenOnLoopback } from "../tests/support/http.ts";
import {
  createHttpServer,
  loadWebAssets,
  run,
  serve,
  shutdownServer,
} from "./index.ts";
import { EncodedHash } from "./models/index.ts";
import type { Password } from "./models/index.ts";
import type {
  IdProvider,
  LoggerProvider,
  PasswordProvider,
} from "./providers/index.ts";
import { AuthService } from "./services/index.ts";

class MemoryLogger implements LoggerProvider {
  errors: unknown[] = [];
  failures = 0;
  listening = Promise.withResolvers<undefined>();
  info(): void {
    this.listening.resolve(undefined);
  }
  warn(): void {}
  error(_message: string, attributes?: Record<string, unknown>): void {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("logger failed");
    }
    this.errors.push(attributes);
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
  const repository = new RecordingUserRepository({
    userId: "user-1",
    passwordHash: hash.phc(),
  });
  const service = await AuthService.create(
    repository,
    passwords,
    ids,
    logger,
    new AbortController().signal,
  );
  const assets = await loadWebAssets();
  const server = createHttpServer(service, assets, logger);
  return { server, logger, passwords, repository };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HTTP server composition", () => {
  it("loads the web assets from public", async () => {
    const assets = await loadWebAssets();
    for (const [key, filename] of [
      ["html", "index.html"],
      ["css", "app.css"],
      ["js", "app.js"],
    ] satisfies [keyof typeof assets, string][]) {
      const original = await readFile(
        new URL(`../public/${filename}`, import.meta.url),
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
    const port = await listenOnLoopback(server);
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
    const port = await listenOnLoopback(server);
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

  it("survives clients that reset the connection right after CONNECT", async () => {
    const { server, logger } = await httpFixture();
    const port = await listenOnLoopback(server);
    const accepted = Promise.withResolvers<undefined>();
    server.once("connect", () => {
      accepted.resolve(undefined);
    });
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => undefined);
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => {
        resolve();
      });
    });
    try {
      await once(socket, "connect");
      socket.write(
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n",
      );
      await accepted.promise;
      socket.resetAndDestroy();
      await closed;
      const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
      expect(response.status).toBe(200);
      await response.text();
      expect(logger.errors).toEqual([]);
    } finally {
      socket.destroy();
      server.closeAllConnections();
      await shutdownServer(server);
    }
  });

  it("handles an error from an accepted CONNECT socket without an unhandled error", async () => {
    const { server, logger } = await httpFixture();
    const port = await listenOnLoopback(server);
    const handled = Promise.withResolvers<undefined>();
    const closed = Promise.withResolvers<undefined>();
    server.once("connect", (_req, acceptedSocket) => {
      acceptedSocket.once("close", () => {
        closed.resolve(undefined);
      });
      acceptedSocket.emit("error", new Error("client reset"));
      handled.resolve(undefined);
    });
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => undefined);
    try {
      await once(socket, "connect");
      socket.write(
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n",
      );
      await handled.promise;
      await closed.promise;
      const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
      expect(response.status).toBe(200);
      await response.text();
      expect(logger.errors).toEqual([]);
    } finally {
      socket.destroy();
      server.closeAllConnections();
      await shutdownServer(server);
    }
  });

  it("records a failure of the error handler itself and drops the connection", async () => {
    const { server, logger, repository } = await httpFixture();
    repository.onCreateUser = () =>
      Promise.reject(new Error("database failed"));
    logger.failures = 1;
    const port = await listenOnLoopback(server);
    try {
      await expect(
        fetch(`http://127.0.0.1:${String(port)}/v1/users`, {
          method: "POST",
          body: JSON.stringify({
            email: "a@example.com",
            password: "correct horse battery staple",
          }),
        }),
      ).rejects.toThrow();
      expect(logger.errors).toHaveLength(1);
      expect(logger.errors[0]).toMatchObject({
        error: { message: "logger failed" },
      });
    } finally {
      server.closeAllConnections();
      await shutdownServer(server);
    }
  });

  it("keeps the original response deadline across body reception and service work", async () => {
    const { server, passwords, logger } = await httpFixture();
    const port = await listenOnLoopback(server);
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

  it("waits for an active response and then closes its keep-alive connection", async () => {
    const server = createServer({ keepAliveTimeout: 60_000 });
    const port = await listenOnLoopback(server);
    const connected = new Promise<Socket>((resolve) => {
      server.once("connection", resolve);
    });
    const entered = new Promise<ServerResponse>((resolve) => {
      server.once("request", (_req, res) => {
        resolve(res);
      });
    });
    const agent = new Agent({ keepAlive: true });
    const started = Promise.withResolvers<undefined>();
    const response = Promise.withResolvers<string>();
    const client = request(
      { host: "127.0.0.1", port, path: "/", agent },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.once("error", response.reject);
        incoming.once("end", () => {
          response.resolve(Buffer.concat(chunks).toString("utf8"));
        });
        started.resolve(undefined);
      },
    );
    client.once("error", response.reject);
    client.end();
    const res = await entered;
    res.writeHead(200, { Connection: "keep-alive" });
    res.flushHeaders();
    await started.promise;
    const socket = await connected;
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => {
        resolve();
      });
    });
    const finished = once(res, "finish");
    const idle = new Promise<void>((resolve) => {
      agent.once("free", () => {
        resolve();
      });
    });
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    let stopped = false;
    const shuttingDown = (async () => {
      await shutdownServer(server);
      stopped = true;
    })();
    try {
      await vi.advanceTimersByTimeAsync(300);
      expect(stopped).toBe(false);
      res.end("completed");
      await finished;
      expect(await response.promise).toBe("completed");
      await idle;
      await vi.advanceTimersByTimeAsync(999);
      await closed;
      await shuttingDown;
      expect(stopped).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      res.destroy();
      client.destroy();
      agent.destroy();
      socket.destroy();
      server.closeAllConnections();
      vi.useRealTimers();
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
    const port = await listenOnLoopback(server);
    const entered = once(server, "request");
    const response = rejected(fetch(`http://127.0.0.1:${String(port)}/`));
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
    const port = await listenOnLoopback(occupied);
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

  it("finishes without an error when stopped during startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "auth-server-run-"));
    const logger = new MemoryLogger();
    try {
      await expect(
        run(
          { DATABASE_PATH: join(directory, "auth.db") },
          logger,
          AbortSignal.abort(new Error("Server shutting down.")),
        ),
      ).resolves.toBeUndefined();
      expect(logger.errors).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("still reports startup failures that the stop signal did not cause", async () => {
    const directory = await mkdtemp(join(tmpdir(), "auth-server-run-"));
    const controller = new AbortController();
    try {
      const running = run(
        { DATABASE_PATH: join(directory, "missing", "auth.db") },
        new MemoryLogger(),
        controller.signal,
      );
      controller.abort(new Error("Server shutting down."));
      await expect(running).rejects.toBeInstanceOf(Error);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["SIGINT", "SIGTERM"] satisfies NodeJS.Signals[])(
    "starts the actual entry point and shuts down on %s",
    async (signal) => {
      const directory = await mkdtemp(join(tmpdir(), "auth-server-entry-"));
      const reservation = createServer();
      const port = await listenOnLoopback(reservation);
      await shutdownServer(reservation);
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./index.ts", import.meta.url))],
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
