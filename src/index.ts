import { readFile } from "node:fs/promises";
import { createServer, ServerResponse } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { Socket } from "node:net";
import { loadConfig } from "./config/index.ts";
import type { Config } from "./config/index.ts";
import { AuthController, WebController } from "./controllers/index.ts";
import type { WebAssets } from "./controllers/index.ts";
import { isCausedBy } from "./errors/index.ts";
import {
  createRequestContext,
  handleError,
  setSecurityHeaders,
} from "./middlewares/index.ts";
import type { LoggerProvider } from "./providers/index.ts";
import { CryptoIdProvider } from "./providers/crypto-id-provider.ts";
import { JsonLoggerProvider } from "./providers/json-logger-provider.ts";
import {
  Argon2PasswordProvider,
  defaultParams,
} from "./providers/password/index.ts";
import { SqliteUserRepository } from "./repositories/sqlite/index.ts";
import { createRoutes } from "./routes/index.ts";
import { AuthService } from "./services/index.ts";

const responseDeadlineMs = 30_000;
const headersTimeoutMs = 5_000;
const requestTimeoutMs = 10_000;
const keepAliveTimeoutMs = 60_000;
const connectionsCheckingIntervalMs = 1_000;
const idleSweepIntervalMs = 100;
const shutdownTimeoutMs = 30_000;

export async function loadWebAssets(): Promise<WebAssets> {
  const [html, css, js] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url)),
    readFile(new URL("../public/app.css", import.meta.url)),
    readFile(new URL("../public/app.js", import.meta.url)),
  ]);
  return { html, css, js };
}

export function createHttpServer(
  service: AuthService,
  assets: WebAssets,
  logger: LoggerProvider,
): Server {
  const route = createRoutes(
    AuthController.create(service),
    WebController.create(assets),
  );

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    const deadline = performance.now() + responseDeadlineMs;
    setSecurityHeaders(res);
    const context = createRequestContext(res, deadline);

    async function dispatch(): Promise<void> {
      try {
        await route(req, res, context);
      } catch (error) {
        handleError(error, req, res, context, logger);
      } finally {
        context.dispose();
      }
    }

    dispatch().catch((error: unknown) => {
      if (!context.signal.aborted) {
        logger.error("request failed", { error });
      }
      res.destroy();
    });
  }

  const server = createServer(
    {
      headersTimeout: headersTimeoutMs,
      requestTimeout: requestTimeoutMs,
      keepAliveTimeout: keepAliveTimeoutMs,
      connectionsCheckingInterval: connectionsCheckingIntervalMs,
    },
    onRequest,
  );
  // CONNECT は通常の request イベントを通らないため、同じ HTTP 境界へ渡す。
  server.on("connect", (req, socket) => {
    if (!(socket instanceof Socket)) {
      socket.destroy();
      return;
    }
    // Node は CONNECT のソケットから error リスナーを外すため、切断で未捕捉例外にならないよう付け直す。
    socket.on("error", () => {
      socket.destroy();
    });
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    res.setHeader("Connection", "close");
    res.once("finish", () => {
      socket.destroySoon();
    });
    onRequest(req, res);
  });
  return server;
}

export function shutdownServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    // close() は呼んだ時点の待機中の接続しか閉じないため、処理中だった接続も応答後に閉じる。
    const idleSweeper = setInterval(() => {
      server.closeIdleConnections();
    }, idleSweepIntervalMs);
    const timer = setTimeout(() => {
      clearInterval(idleSweeper);
      server.closeAllConnections();
      resolve();
    }, shutdownTimeoutMs);
    server.close((error?: Error) => {
      clearInterval(idleSweeper);
      clearTimeout(timer);
      if (
        error !== undefined &&
        !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")
      ) {
        reject(new Error("Shut down HTTP server failed.", { cause: error }));
        return;
      }
      resolve();
    });
  });
}

export async function serve(
  server: Server,
  port: number,
  logger: LoggerProvider,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const {
    promise: stopped,
    resolve,
    reject: fail,
  } = Promise.withResolvers<undefined>();
  const stop = (): void => {
    resolve(undefined);
  };
  const onAbort = (): void => {
    if (server.listening) {
      stop();
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  server.on("error", fail);
  server.once("close", stop);
  try {
    server.listen(port, "0.0.0.0", () => {
      if (signal.aborted) {
        stop();
        return;
      }
      logger.info("auth server listening", { address: server.address() });
    });
    await stopped;
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      await shutdownServer(server);
    } finally {
      server.removeListener("error", fail);
      server.removeListener("close", stop);
    }
  }
}

async function start(
  config: Config,
  logger: LoggerProvider,
  signal: AbortSignal,
): Promise<void> {
  const repository = await SqliteUserRepository.open(
    config.databasePath,
    signal,
  );
  try {
    const passwordProvider = Argon2PasswordProvider.create(defaultParams());
    const idProvider = CryptoIdProvider.create();
    const service = await AuthService.create(
      repository,
      passwordProvider,
      idProvider,
      logger,
      signal,
    );
    const assets = await loadWebAssets();
    signal.throwIfAborted();
    await serve(
      createHttpServer(service, assets, logger),
      config.port,
      logger,
      signal,
    );
  } finally {
    repository.close();
  }
}

export async function run(
  env: NodeJS.ProcessEnv,
  logger: LoggerProvider,
  signal: AbortSignal,
): Promise<void> {
  const config = loadConfig(env);
  try {
    await start(config, logger, signal);
  } catch (error) {
    if (signal.aborted && isCausedBy(error, signal.reason)) {
      return;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const logger = JsonLoggerProvider.create(process.stdout);
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort(new Error("Server shutting down."));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await run(process.env, logger, controller.signal);
  } catch (error) {
    logger.error("auth server failed", { error });
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (import.meta.main) {
  await main();
}
