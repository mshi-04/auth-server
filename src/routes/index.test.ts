import { createServer, request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { SequentialIdProvider } from "../../tests/support/fakes/id-provider.ts";
import { RecordingLogger } from "../../tests/support/fakes/logger.ts";
import { RecordingPasswordProvider } from "../../tests/support/fakes/password-provider.ts";
import { RouteUserRepository } from "../../tests/support/fakes/user-repository.ts";
import { listenOnLoopback } from "../../tests/support/http.ts";
import { AuthController, WebController } from "../controllers/index.ts";
import { BusyError } from "../errors/index.ts";
import {
  createRequestContext,
  handleError,
  setSecurityHeaders,
} from "../middlewares/index.ts";
import { EncodedHash } from "../models/index.ts";
import { AuthService } from "../services/index.ts";
import { createRoutes } from "./index.ts";

const storedPhc = "$argon2id$v=19$m=8,t=1,p=1$MDEyMzQ1Njc$uzjqtw";
const validInput = {
  email: "Person@EXAMPLE.COM",
  password: "correct horse battery staple",
};
const csp =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

interface WireResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    server.closeAllConnections();
    await closed;
  }
});

async function createFixture() {
  const repository = new RouteUserRepository();
  const passwords = new RecordingPasswordProvider({
    dummyHash: EncodedHash.parse(storedPhc),
    hashedResult: EncodedHash.parse(storedPhc),
    rehashedResult: EncodedHash.parse(storedPhc),
  });
  // サービス内部のログは auth-service.test.ts の担当なので、HTTP 層のログだけを別に記録する。
  const logger = new RecordingLogger();
  const service = await AuthService.create(
    repository,
    passwords,
    new SequentialIdProvider(
      (number) => `test-user-${String(number)}`,
      "dummy password for HTTP tests",
    ),
    new RecordingLogger(),
    new AbortController().signal,
  );
  const assets = {
    html: await readFile(new URL("../../public/index.html", import.meta.url)),
    css: await readFile(new URL("../../public/app.css", import.meta.url)),
    js: await readFile(new URL("../../public/app.js", import.meta.url)),
  };
  const routes = createRoutes(
    AuthController.create(service),
    WebController.create(assets),
  );
  const server = createServer((req, res) => {
    const deadline = performance.now() + 30000;
    setSecurityHeaders(res);
    const context = createRequestContext(res, deadline);
    const run = async (): Promise<void> => {
      try {
        await routes(req, res, context);
      } catch (error) {
        handleError(error, req, res, context, logger);
      } finally {
        context.dispose();
      }
    };
    run().catch((error: unknown) => {
      logger.error("test request failed", { error });
      res.destroy();
    });
  });
  const port = await listenOnLoopback(server);
  servers.push(server);
  const url = `http://127.0.0.1:${String(port)}`;

  const send = async (
    path: string,
    options: RequestInit = {},
  ): Promise<WireResponse> => {
    const response = await fetch(`${url}${path}`, options);
    return checkedResponse({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  };
  const post = (path: string, value: unknown): Promise<WireResponse> =>
    send(path, { method: "POST", body: JSON.stringify(value) });
  const raw = async (
    path: string,
    method = "GET",
    body?: Buffer,
    headers?: Record<string, string>,
  ): Promise<WireResponse> => {
    const response = await new Promise<WireResponse>((resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port, path, method, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.once("error", reject);
          res.once("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.once("error", reject);
      req.end(body);
    });
    return checkedResponse(response);
  };
  return { repository, passwords, logger, assets, send, post, raw };
}

function checkedResponse(response: WireResponse): WireResponse {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["content-security-policy"]).toBe(csp);
  return response;
}

function expectProblemStatus(response: WireResponse, status: number): void {
  expect(response.status).toBe(status);
  expect(response.headers["content-type"]).toBe("application/problem+json");
  const problem: unknown = JSON.parse(response.body);
  expect(problem).toMatchObject({ status });
}

function expectProblemDetail(response: WireResponse, detail: string): void {
  const problem: unknown = JSON.parse(response.body);
  expect(problem).toMatchObject({ detail });
}

function expectProblem(
  response: WireResponse,
  status: number,
  title: string,
  detail: string,
): void {
  expectProblemStatus(response, status);
  expect(JSON.parse(response.body)).toEqual({
    type: "about:blank",
    title,
    status,
    detail,
  });
}

describe("HTTP routes", () => {
  it("registers and logs in through the real AuthService with DTO conversion", async () => {
    const fixture = await createFixture();
    const registered = await fixture.post("/v1/users", validInput);
    expect(registered.status).toBe(201);
    expect(registered.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(registered.body)).toEqual({ user_id: "test-user-1" });
    expect(fixture.repository.users).toEqual([
      {
        id: "test-user-1",
        email: "Person@EXAMPLE.COM",
        emailNormalized: "person@example.com",
        passwordHash: storedPhc,
      },
    ]);
    const login = await fixture.post("/v1/sessions", {
      ...validInput,
      email: "person@example.com",
    });
    expect(login.status).toBe(200);
    expect(JSON.parse(login.body)).toEqual({ user_id: "test-user-1" });
    expect(login.headers["set-cookie"]).toBeUndefined();
    expect(fixture.logger.errorCalls).toEqual([]);
  });

  it("returns 409 for a normalized duplicate", async () => {
    const fixture = await createFixture();
    await fixture.post("/v1/users", validInput);
    const duplicate = await fixture.post("/v1/users", {
      ...validInput,
      email: "person@example.com",
    });
    expectProblem(
      duplicate,
      409,
      "Conflict",
      "メールアドレスは既に登録されています",
    );
    expect(fixture.logger.errorCalls).toEqual([]);
  });

  it.each([
    ["/", "html", "text/html; charset=utf-8"],
    ["/assets/app.css", "css", "text/css; charset=utf-8"],
    ["/assets/app.js", "js", "text/javascript; charset=utf-8"],
  ])(
    "serves the copied asset %s with UTF-8 metadata and HEAD",
    async (path, asset, contentType) => {
      const fixture = await createFixture();
      const bytes =
        asset === "html"
          ? fixture.assets.html
          : asset === "css"
            ? fixture.assets.css
            : fixture.assets.js;
      const response = await fixture.send(path);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe(contentType);
      expect(response.headers["content-length"]).toBe(String(bytes.length));
      expect(response.body).toBe(bytes.toString("utf8"));
      const head = await fixture.send(path, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.body).toBe("");
      expect(head.headers["content-type"]).toBe(contentType);
      expect(head.headers["content-length"]).toBe(
        response.headers["content-length"],
      );

      const original = bytes.toString("utf8");
      bytes.fill(0x78);
      const afterMutation = await fixture.send(path);
      expect(afterMutation.body).toBe(original);
    },
  );

  it.each(["GET", "HEAD"])(
    "serves an empty health response for %s without database access",
    async (method) => {
      const fixture = await createFixture();
      fixture.repository.onFind = () =>
        Promise.reject(new Error("DB must not be queried"));
      const response = await fixture.send("/healthz", { method });
      expect(response.status).toBe(200);
      expect(response.body).toBe("");
      expect(fixture.repository.findCalls).toEqual([]);
    },
  );

  it("ignores query strings without changing the path", async () => {
    const fixture = await createFixture();
    expect((await fixture.send("/healthz?check=1")).status).toBe(200);
    expect(
      (await fixture.post("/v1/users?source=test", validInput)).status,
    ).toBe(201);
  });

  it.each([
    "/missing",
    "/assets/",
    "/index.html",
    "/app.js",
    "/healthz/",
    "/HEALTHZ",
    "//healthz",
    "/x/../healthz",
    "/%68ealthz",
    "*",
    "http://example.com/missing",
  ])("returns 404 without normalizing %s", async (path) => {
    const fixture = await createFixture();
    const response = await fixture.raw(path);
    expectProblemStatus(response, 404);
  });

  it.each([
    ["http://127.0.0.1/healthz", 200],
    ["HTTP://example.com/healthz?check=1", 200],
    ["http://example.com", 200],
    ["http://example.com/", 200],
    ["http://example.com/HEALTHZ", 404],
  ])(
    "matches the path of an absolute-form target %s",
    async (target, status) => {
      const fixture = await createFixture();
      const response = await fixture.raw(target);
      expect(response.status).toBe(status);
    },
  );

  it.each([
    ["/v1/users", "GET", "POST"],
    ["/v1/sessions", "PATCH", "POST"],
    ["/healthz", "POST", "GET, HEAD"],
    ["/", "POST", "GET, HEAD"],
    ["/assets/app.css", "PUT", "GET, HEAD"],
    ["/assets/app.js", "OPTIONS", "GET, HEAD"],
  ])("returns 405 and Allow for %s %s", async (path, method, allow) => {
    const fixture = await createFixture();
    const response = await fixture.send(path, { method });
    expectProblemStatus(response, 405);
    expect(response.headers.allow).toBe(allow);
  });

  it("omits Problem Details bodies on HEAD while preserving the status and headers", async () => {
    const fixture = await createFixture();
    for (const [path, status] of [
      ["/v1/users", 405],
      ["/missing", 404],
    ]) {
      if (typeof path !== "string" || typeof status !== "number") {
        throw new Error("Invalid test case.");
      }
      const response = await fixture.send(path, { method: "HEAD" });
      expect(response.status).toBe(status);
      expect(response.body).toBe("");
      expect(response.headers["content-type"]).toBe("application/problem+json");
    }
  });

  it.each([
    "{",
    '{"email":"user@example.com","password":"password","extra":1}',
  ])(
    "rejects invalid JSON/input %s before calling the service",
    async (body) => {
      const fixture = await createFixture();
      const response = await fixture.send("/v1/users", {
        method: "POST",
        body,
      });
      expectProblemStatus(response, 400);
      expectProblemDetail(response, "リクエストのJSONが正しくありません");
      expect(fixture.passwords.hashCalls).toHaveLength(1);
      expect(fixture.repository.users).toEqual([]);
      expect(fixture.logger.errorCalls).toEqual([]);
    },
  );

  it.each([false, true])(
    "rejects bodies larger than 16 KiB (chunked=%s)",
    async (chunked) => {
      const fixture = await createFixture();
      const json = JSON.stringify(validInput);
      const body = Buffer.from(
        json + " ".repeat(16385 - Buffer.byteLength(json)),
      );
      const response = await fixture.raw(
        "/v1/users",
        "POST",
        body,
        chunked
          ? { "Transfer-Encoding": "chunked" }
          : { "Content-Length": String(body.length) },
      );
      expectProblemStatus(response, 413);
      expect(response.headers.connection).toBe("close");
      expect(fixture.passwords.hashCalls).toHaveLength(1);
    },
  );

  it.each(["", "\ud800"])(
    "passes semantic email/password values to the service (%j)",
    async (value) => {
      const fixture = await createFixture();
      const registration = await fixture.post("/v1/users", {
        email: value,
        password: value,
      });
      expect(registration.status).toBe(422);
      const login = await fixture.post("/v1/sessions", {
        email: value,
        password: value,
      });
      expectProblemStatus(login, 401);
      expect(login.headers["www-authenticate"]).toBeUndefined();
      expect(fixture.logger.errorCalls).toEqual([]);
    },
  );

  it.each(["unknown", "invalid", "mismatch", "invalid-hash"])(
    "unifies %s login failure as 401 without HTTP error logging",
    async (failure) => {
      const fixture = await createFixture();
      if (failure === "mismatch" || failure === "invalid-hash") {
        await fixture.post("/v1/users", validInput);
      }
      if (failure === "mismatch") {
        fixture.passwords.verifyResult = false;
      }
      if (failure === "invalid-hash") {
        const stored = fixture.repository.users[0];
        if (stored === undefined) {
          throw new Error("Expected registered user.");
        }
        fixture.repository.users[0] = {
          ...stored,
          passwordHash: "invalid-phc",
        };
      }
      const response = await fixture.post("/v1/sessions", {
        ...validInput,
        email: failure === "invalid" ? "invalid email" : validInput.email,
      });
      expectProblemStatus(response, 401);
      expect(response.headers["www-authenticate"]).toBeUndefined();
      expect(fixture.logger.errorCalls).toEqual([]);
    },
  );

  it("maps a wrapped busy failure to 503 without HTTP error logging", async () => {
    const fixture = await createFixture();
    fixture.repository.onCreate = () =>
      Promise.reject(new Error("wrapped", { cause: new BusyError() }));
    const response = await fixture.post("/v1/users", validInput);
    expectProblemStatus(response, 503);
    expect(fixture.logger.errorCalls).toEqual([]);
  });

  it("returns a fixed 500 and logs the failure once", async () => {
    const fixture = await createFixture();
    const failure = new Error("internal database detail");
    fixture.repository.onCreate = () => Promise.reject(failure);
    const response = await fixture.post("/v1/users", validInput);
    expectProblem(
      response,
      500,
      "Internal Server Error",
      "サーバー内部でエラーが発生しました",
    );
    expect(response.body).not.toContain(failure.message);
    expect(fixture.logger.errorCalls).toHaveLength(1);
  });

  it("keeps login successful when the service tolerates a rehash failure", async () => {
    const fixture = await createFixture();
    await fixture.post("/v1/users", validInput);
    fixture.passwords.needsRehashResult = true;
    fixture.repository.onUpdate = () =>
      Promise.reject(new Error("rehash failed"));
    const response = await fixture.post("/v1/sessions", validInput);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ user_id: "test-user-1" });
    expect(fixture.logger.errorCalls).toEqual([]);
  });
});
