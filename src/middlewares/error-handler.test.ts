import { createServer, IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
  BadRequestError,
  BusyError,
  EmailTakenError,
  InvalidCredentialsError,
  InvalidEmailError,
  InvalidHashError,
  InvalidParamsError,
  MethodNotAllowedError,
  NotFoundError,
  PayloadTooLargeError,
  WeakPasswordError,
} from "../errors/index.ts";
import type { RequestContext } from "../models/index.ts";
import type { LoggerProvider } from "../providers/index.ts";
import { handleError } from "./error-handler.ts";
import { setSecurityHeaders } from "./security-headers.ts";

class RecordingLogger implements LoggerProvider {
  errors: { message: string; attributes?: Record<string, unknown> }[] = [];
  info(): void {}
  warn(): void {}
  error(message: string, attributes?: Record<string, unknown>): void {
    this.errors.push({
      message,
      ...(attributes === undefined ? {} : { attributes }),
    });
  }
}

function context(canRespond = true): RequestContext {
  const signal = new AbortController().signal;
  return {
    signal,
    disconnectedSignal: signal,
    deadlineSignal: signal,
    deadline: Infinity,
    canRespond: () => canRespond,
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Expected TCP listener."));
        return;
      }
      resolve(address.port);
    });
  });
}

async function runError(error: unknown, method = "GET") {
  const logger = new RecordingLogger();
  const server = createServer((req, res) => {
    setSecurityHeaders(res);
    handleError(error, req, res, context(), logger);
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
      method,
    });
    const body = await response.text();
    return { response, body, logger };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

describe("handleError", () => {
  it.each([
    {
      error: new BadRequestError("invalid-input"),
      status: 400,
      detail: "リクエストのJSONが正しくありません",
    },
    {
      error: new BadRequestError("read-failed"),
      status: 400,
      detail: "リクエストボディを読み取れませんでした",
    },
    {
      error: new InvalidCredentialsError(),
      status: 401,
      detail: "メールアドレスまたはパスワードが正しくありません",
    },
    {
      error: new NotFoundError(),
      status: 404,
      detail: "指定されたリソースが見つかりません",
    },
    {
      error: new MethodNotAllowedError(["GET", "HEAD"]),
      status: 405,
      detail: "指定されたHTTPメソッドは使用できません",
    },
    {
      error: new EmailTakenError(),
      status: 409,
      detail: "メールアドレスは既に登録されています",
    },
    {
      error: new PayloadTooLargeError(),
      status: 413,
      detail: "リクエストボディが上限を超えています",
    },
    {
      error: new InvalidEmailError(),
      status: 422,
      detail: "メールアドレスの形式が正しくありません",
    },
    {
      error: new WeakPasswordError(),
      status: 422,
      detail: "パスワードがポリシーを満たしていません",
    },
    {
      error: new BusyError(),
      status: 503,
      detail: "一時的に処理を受け付けられません",
    },
  ])(
    "returns a fixed problem for $error.name ($status)",
    async ({ error, status, detail }) => {
      const { response, body, logger } = await runError(
        new Error("wrapper", { cause: error }),
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
      const problem: unknown = JSON.parse(body);
      expect(problem).toEqual({
        type: "about:blank",
        title: response.statusText,
        status,
        detail,
      });
      expect(logger.errors).toEqual([]);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toContain(
        "form-action 'none'",
      );
    },
  );

  it("sets only the supported methods on a 405", async () => {
    const { response } = await runError(
      new MethodNotAllowedError(["GET", "HEAD"]),
    );
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("keeps authentication error semantics ahead of inner failures", async () => {
    const { response, logger } = await runError(
      new InvalidCredentialsError("login failed", {
        cause: new InvalidEmailError("invalid", {
          cause: new InvalidHashError(),
        }),
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.has("www-authenticate")).toBe(false);
    expect(logger.errors).toEqual([]);
  });

  it.each([
    new Error("private internal cause"),
    new InvalidParamsError(),
    "unexpected value",
  ])(
    "logs unexpected errors once without disclosing their causes (%j)",
    async (error) => {
      const { response, body, logger } = await runError(error);
      expect(response.status).toBe(500);
      expect(body).not.toContain("private internal cause");
      expect(logger.errors).toEqual([
        { message: "request failed", attributes: { error } },
      ]);
      const problem: unknown = JSON.parse(body);
      expect(problem).toEqual({
        type: "about:blank",
        title: "Internal Server Error",
        status: 500,
        detail: "サーバー内部でエラーが発生しました",
      });
    },
  );

  it("stops a cyclic cause chain", async () => {
    const error = new Error("cycle");
    error.cause = error;
    const { response, logger } = await runError(error);
    expect(response.status).toBe(500);
    expect(logger.errors).toHaveLength(1);
  });

  it("sends headers without a body for HEAD errors", async () => {
    const { response, body } = await runError(new NotFoundError(), "HEAD");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(body).toBe("");
  });

  it.each([new BusyError(), new Error("aborted operation")])(
    "suppresses both logging and response when the context cannot respond",
    (error) => {
      const req = new IncomingMessage(new Socket());
      const res = new ServerResponse(req);
      const logger = new RecordingLogger();
      handleError(error, req, res, context(false), logger);
      expect(res.headersSent).toBe(false);
      expect(res.writableEnded).toBe(false);
      expect(logger.errors).toEqual([]);
      req.destroy();
    },
  );
});
