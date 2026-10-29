import { STATUS_CODES } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  BadRequestError,
  BusyError,
  causeChain,
  EmailTakenError,
  InvalidCredentialsError,
  InvalidEmailError,
  MethodNotAllowedError,
  NotFoundError,
  PayloadTooLargeError,
  WeakPasswordError,
} from "../errors/index.ts";
import type { RequestContext } from "../models/index.ts";
import type { LoggerProvider } from "../providers/index.ts";

interface Problem {
  status: number;
  detail: string;
  allowedMethods?: readonly string[];
  closeConnection?: boolean;
}

function classify(error: unknown): Problem | undefined {
  for (const current of causeChain(error)) {
    if (current instanceof BadRequestError) {
      return {
        status: 400,
        detail:
          current.kind === "read-failed"
            ? "リクエストボディを読み取れませんでした"
            : "リクエストのJSONが正しくありません",
      };
    }
    if (current instanceof InvalidCredentialsError) {
      return {
        status: 401,
        detail: "メールアドレスまたはパスワードが正しくありません",
      };
    }
    if (current instanceof NotFoundError) {
      return { status: 404, detail: "指定されたリソースが見つかりません" };
    }
    if (current instanceof MethodNotAllowedError) {
      return {
        status: 405,
        detail: "指定されたHTTPメソッドは使用できません",
        allowedMethods: current.allowedMethods,
      };
    }
    if (current instanceof EmailTakenError) {
      return { status: 409, detail: "メールアドレスは既に登録されています" };
    }
    if (current instanceof PayloadTooLargeError) {
      return {
        status: 413,
        detail: "リクエストボディが上限を超えています",
        closeConnection: true,
      };
    }
    if (current instanceof InvalidEmailError) {
      return {
        status: 422,
        detail: "メールアドレスの形式が正しくありません",
      };
    }
    if (current instanceof WeakPasswordError) {
      return {
        status: 422,
        detail: "パスワードがポリシーを満たしていません",
      };
    }
    if (current instanceof BusyError) {
      return { status: 503, detail: "一時的に処理を受け付けられません" };
    }
  }
  return undefined;
}

export function handleError(
  error: unknown,
  req: IncomingMessage,
  res: ServerResponse,
  context: RequestContext,
  logger: LoggerProvider,
): void {
  if (!context.canRespond()) {
    return;
  }
  if (res.headersSent) {
    logger.error("request failed after response headers", { error });
    res.destroy();
    return;
  }
  const classified = classify(error);
  const problem = classified ?? {
    status: 500,
    detail: "サーバー内部でエラーが発生しました",
  };
  if (classified === undefined) {
    logger.error("request failed", { error });
  }
  if (!context.canRespond()) {
    return;
  }
  res.setHeader("Content-Type", "application/problem+json");
  if (problem.allowedMethods !== undefined) {
    res.setHeader("Allow", problem.allowedMethods.join(", "));
  }
  if (problem.closeConnection === true) {
    res.setHeader("Connection", "close");
  }
  res.statusCode = problem.status;
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(
    JSON.stringify({
      type: "about:blank",
      title: STATUS_CODES[problem.status],
      status: problem.status,
      detail: problem.detail,
    }),
  );
}
