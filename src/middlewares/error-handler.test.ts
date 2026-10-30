import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { RecordingLogger } from "../../tests/support/fakes/logger.ts";
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
import { handleError } from "./error-handler.ts";
import { setSecurityHeaders } from "./security-headers.ts";

class RecordingResponse extends ServerResponse {
  body: unknown;

  override end(
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): this {
    this.body = chunk;
    if (typeof encodingOrCallback === "string") {
      return super.end(chunk, encodingOrCallback, callback);
    }
    return super.end(chunk, encodingOrCallback);
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

function runError(error: unknown, method = "GET") {
  const logger = new RecordingLogger();
  const req = new IncomingMessage(new Socket());
  req.method = method;
  const response = new RecordingResponse(req);
  setSecurityHeaders(response);
  try {
    handleError(error, req, response, context(), logger);
    expect(response.getHeader("cache-control")).toBe("no-store");
    expect(response.getHeader("x-content-type-options")).toBe("nosniff");
    expect(response.getHeader("content-security-policy")).toContain(
      "form-action 'none'",
    );
    if (response.body !== undefined && typeof response.body !== "string") {
      throw new Error("Expected a string response body.");
    }
    return { response, body: response.body ?? "", logger };
  } finally {
    req.destroy();
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
    ({ error, status, detail }) => {
      const { response, body, logger } = runError(
        new Error("wrapper", { cause: error }),
      );
      expect(response.statusCode).toBe(status);
      expect(response.getHeader("content-type")).toBe(
        "application/problem+json",
      );
      const problem: unknown = JSON.parse(body);
      expect(problem).toEqual({
        type: "about:blank",
        title: response.statusMessage,
        status,
        detail,
      });
      expect(logger.errorCalls).toEqual([]);
    },
  );

  it("sets only the supported methods on a 405", () => {
    const { response } = runError(new MethodNotAllowedError(["GET", "HEAD"]));
    expect(response.getHeader("allow")).toBe("GET, HEAD");
  });

  it("keeps authentication error semantics ahead of inner failures", () => {
    const { response, logger } = runError(
      new InvalidCredentialsError("login failed", {
        cause: new InvalidEmailError("invalid", {
          cause: new InvalidHashError(),
        }),
      }),
    );
    expect(response.statusCode).toBe(401);
    expect(response.hasHeader("www-authenticate")).toBe(false);
    expect(logger.errorCalls).toEqual([]);
  });

  it.each([
    new Error("private internal cause"),
    new InvalidParamsError(),
    "unexpected value",
  ])(
    "logs unexpected errors once without disclosing their causes (%j)",
    (error) => {
      const { response, body, logger } = runError(error);
      expect(response.statusCode).toBe(500);
      expect(body).not.toContain("private internal cause");
      expect(logger.errorCalls).toEqual([
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

  it("stops a cyclic cause chain", () => {
    const error = new Error("cycle");
    error.cause = error;
    const { response, logger } = runError(error);
    expect(response.statusCode).toBe(500);
    expect(logger.errorCalls).toHaveLength(1);
  });

  it("sends headers without a body for HEAD errors", () => {
    const { response, body } = runError(new NotFoundError(), "HEAD");
    expect(response.statusCode).toBe(404);
    expect(response.getHeader("content-type")).toBe("application/problem+json");
    expect(body).toBe("");
    expect(response.body).toBeUndefined();
    expect(response.writableEnded).toBe(true);
  });

  it("records and drops the connection when headers were already sent", () => {
    const req = new IncomingMessage(new Socket());
    const res = new ServerResponse(req);
    const logger = new RecordingLogger();
    const error = new NotFoundError();
    res.writeHead(200);
    handleError(error, req, res, context(), logger);
    expect(logger.errorCalls).toEqual([
      {
        message: "request failed after response headers",
        attributes: { error },
      },
    ]);
    expect(res.destroyed).toBe(true);
    expect(res.statusCode).toBe(200);
    req.destroy();
  });

  it("requests connection closure after a 413 response", () => {
    const { response } = runError(new PayloadTooLargeError());
    expect(response.statusCode).toBe(413);
    expect(response.getHeader("connection")).toBe("close");
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
      expect(logger.errorCalls).toEqual([]);
      req.destroy();
    },
  );
});
