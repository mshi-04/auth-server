import { createServer, request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { AuthController, WebController } from "../controllers/index.ts";
import {
  BusyError,
  EmailTakenError,
  InvalidHashError,
  PasswordBusyError,
  PolicyViolationError,
  UserNotFoundError,
} from "../errors/index.ts";
import {
  createRequestContext,
  handleError,
  setSecurityHeaders,
} from "../middlewares/index.ts";
import { EncodedHash } from "../models/index.ts";
import type { Credential, NewUser } from "../models/index.ts";
import type {
  IdProvider,
  LoggerProvider,
  PasswordProvider,
} from "../providers/index.ts";
import type { UserRepository } from "../repositories/index.ts";
import { AuthService } from "../services/index.ts";
import { createRoutes } from "./index.ts";

const storedPhc = "$argon2id$v=19$m=8,t=1,p=1$MDEyMzQ1Njc$uzjqtw";
const validInput = {
  email: "Person@EXAMPLE.COM",
  password: "correct horse battery staple",
};
const csp =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

class MemoryRepository implements UserRepository {
  users: NewUser[] = [];
  findCalls: string[] = [];
  updateCalls: { userId: string; passwordHash: string }[] = [];
  onCreate = (): Promise<void> => Promise.resolve();
  onFind = (): Promise<void> => Promise.resolve();
  onUpdate = (): Promise<void> => Promise.resolve();

  async createUser(user: NewUser): Promise<void> {
    await this.onCreate();
    if (
      this.users.some((entry) => entry.emailNormalized === user.emailNormalized)
    ) {
      throw new EmailTakenError();
    }
    this.users.push(user);
  }

  async findCredentialByEmail(emailNormalized: string): Promise<Credential> {
    this.findCalls.push(emailNormalized);
    await this.onFind();
    const user = this.users.find(
      (entry) => entry.emailNormalized === emailNormalized,
    );
    if (user === undefined) {
      throw new UserNotFoundError();
    }
    return { userId: user.id, passwordHash: user.passwordHash };
  }

  async updatePasswordHash(
    userId: string,
    passwordHash: string,
  ): Promise<void> {
    this.updateCalls.push({ userId, passwordHash });
    await this.onUpdate();
  }
}

class TestPasswordProvider implements PasswordProvider {
  hashCalls = 0;
  verifyCalls = 0;
  rehashCalls = 0;
  verifyResult = true;
  rehashRequired = false;
  onHash = (): Promise<EncodedHash> =>
    Promise.resolve(EncodedHash.parse(storedPhc));
  onVerify = (): Promise<boolean> => Promise.resolve(this.verifyResult);
  onRehash = (): Promise<EncodedHash> =>
    Promise.resolve(EncodedHash.parse(storedPhc));

  hash(): Promise<EncodedHash> {
    this.hashCalls++;
    return this.onHash();
  }

  verify(): Promise<boolean> {
    this.verifyCalls++;
    return this.onVerify();
  }

  rehash(): Promise<EncodedHash> {
    this.rehashCalls++;
    return this.onRehash();
  }

  needsRehash(): boolean {
    return this.rehashRequired;
  }
}

class FixedIds implements IdProvider {
  #next = 0;

  newUserId(): string {
    this.#next++;
    return `test-user-${String(this.#next)}`;
  }

  newDummyPassword(): string {
    return "dummy password for HTTP tests";
  }
}

class MemoryLogger implements LoggerProvider {
  warnings: {
    message: string;
    attributes: Record<string, unknown> | undefined;
  }[] = [];
  errors: {
    message: string;
    attributes: Record<string, unknown> | undefined;
  }[] = [];

  info(): void {}

  warn(message: string, attributes?: Record<string, unknown>): void {
    this.warnings.push({ message, attributes });
  }

  error(message: string, attributes?: Record<string, unknown>): void {
    this.errors.push({ message, attributes });
  }
}

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
  const repository = new MemoryRepository();
  const passwords = new TestPasswordProvider();
  const logger = new MemoryLogger();
  const service = await AuthService.create(
    repository,
    passwords,
    new FixedIds(),
    logger,
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind to TCP.");
  }
  const port = address.port;
  const url = `http://127.0.0.1:${String(port)}`;

  const send = async (
    path: string,
    options: RequestInit = {},
  ): Promise<WireResponse> => {
    const response = await fetch(`${url}${path}`, options);
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    };
  };
  const post = (path: string, value: unknown): Promise<WireResponse> =>
    send(path, { method: "POST", body: JSON.stringify(value) });
  const raw = (
    path: string,
    method = "GET",
    body?: Buffer,
    headers?: Record<string, string>,
  ): Promise<WireResponse> =>
    new Promise((resolve, reject) => {
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
  return { repository, passwords, logger, assets, send, post, raw };
}

function expectSecurity(response: WireResponse): void {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["content-security-policy"]).toBe(csp);
}

function expectProblem(
  response: WireResponse,
  status: number,
  title: string,
  detail: string,
): void {
  expect(response.status).toBe(status);
  expect(response.headers["content-type"]).toBe("application/problem+json");
  expectSecurity(response);
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
    expectSecurity(registered);
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
    expectSecurity(login);
    expect(fixture.repository.findCalls).toEqual(["person@example.com"]);
    expect(fixture.passwords.verifyCalls).toBe(1);
    expect(fixture.logger.errors).toEqual([]);
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
    expect(fixture.logger.errors).toEqual([]);
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
      expectSecurity(response);
      const head = await fixture.send(path, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.body).toBe("");
      expect(head.headers["content-type"]).toBe(contentType);
      expect(head.headers["content-length"]).toBe(
        response.headers["content-length"],
      );
      expectSecurity(head);

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
      expectSecurity(response);
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
    expectProblem(
      response,
      404,
      "Not Found",
      "指定されたリソースが見つかりません",
    );
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
      expectSecurity(response);
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
    expectProblem(
      response,
      405,
      "Method Not Allowed",
      "指定されたHTTPメソッドは使用できません",
    );
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
      expectSecurity(response);
    }
  });

  it.each([
    "",
    "{",
    "null",
    "[]",
    "123",
    "true",
    '"text"',
    "{}",
    '{"email":"user@example.com"}',
    '{"password":"password"}',
    '{"email":null,"password":"password"}',
    '{"email":"user@example.com","password":null}',
    '{"email":1,"password":"password"}',
    '{"email":"user@example.com","password":[]}',
    '{"Email":"user@example.com","password":"password"}',
    '{"email":"user@example.com","Password":"password"}',
    '{"email":"user@example.com","password":"password","extra":1}',
    '{"email":"user@example.com","password":"password"}{}',
    '{"email":"user@example.com","password":"password"}garbage',
  ])(
    "rejects invalid JSON/input %s before calling the service",
    async (body) => {
      const fixture = await createFixture();
      const response = await fixture.send("/v1/users", {
        method: "POST",
        body,
      });
      expectProblem(
        response,
        400,
        "Bad Request",
        "リクエストのJSONが正しくありません",
      );
      expect(fixture.passwords.hashCalls).toBe(1);
      expect(fixture.repository.users).toEqual([]);
      expect(fixture.logger.errors).toEqual([]);
    },
  );

  it("accepts duplicate keys with the last value and trailing whitespace", async () => {
    const fixture = await createFixture();
    const response = await fixture.send("/v1/users", {
      method: "POST",
      body: '{"email":false,"email":"last@example.com","password":null,"password":"abcdefghijkl"} \r\n\t',
    });
    expect(response.status).toBe(201);
    expect(fixture.repository.users[0]?.email).toBe("last@example.com");
  });

  it("does not require Content-Type", async () => {
    const fixture = await createFixture();
    const response = await fixture.raw(
      "/v1/users",
      "POST",
      Buffer.from(JSON.stringify(validInput)),
    );
    expect(response.status).toBe(201);
  });

  it("allows exactly 16 KiB including trailing whitespace", async () => {
    const fixture = await createFixture();
    const json = JSON.stringify(validInput);
    const body = json + " ".repeat(16384 - Buffer.byteLength(json));
    const response = await fixture.send("/v1/users", { method: "POST", body });
    expect(response.status).toBe(201);
  });

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
      expectProblem(
        response,
        413,
        "Payload Too Large",
        "リクエストボディが上限を超えています",
      );
      expect(response.headers.connection).toBe("close");
      expect(fixture.passwords.hashCalls).toBe(1);
    },
  );

  it("counts multibyte input as bytes", async () => {
    const fixture = await createFixture();
    const body = JSON.stringify({
      email: "あ".repeat(5500),
      password: validInput.password,
    });
    expect(body.length).toBeLessThan(16384);
    expect(Buffer.byteLength(body)).toBeGreaterThan(16384);
    const response = await fixture.raw("/v1/users", "POST", Buffer.from(body), {
      "Transfer-Encoding": "chunked",
    });
    expectProblem(
      response,
      413,
      "Payload Too Large",
      "リクエストボディが上限を超えています",
    );
  });

  it("replaces malformed UTF-8 before JSON parsing", async () => {
    const fixture = await createFixture();
    const body = Buffer.concat([
      Buffer.from('{"email":"'),
      Buffer.from([0xff]),
      Buffer.from('@example.com","password":"abcdefghijkl"}'),
    ]);
    const response = await fixture.raw("/v1/users", "POST", body);
    expectProblem(
      response,
      422,
      "Unprocessable Entity",
      "メールアドレスの形式が正しくありません",
    );
  });

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
      expectProblem(
        login,
        401,
        "Unauthorized",
        "メールアドレスまたはパスワードが正しくありません",
      );
      expect(login.headers["www-authenticate"]).toBeUndefined();
      expect(fixture.logger.errors).toEqual([]);
    },
  );

  it("maps the provider minimum-length failure to 422", async () => {
    const fixture = await createFixture();
    fixture.passwords.onHash = () => Promise.reject(new PolicyViolationError());
    const response = await fixture.post("/v1/users", {
      ...validInput,
      password: "short",
    });
    expectProblem(
      response,
      422,
      "Unprocessable Entity",
      "パスワードがポリシーを満たしていません",
    );
    expect(fixture.logger.errors).toEqual([]);
  });

  it.each(["unknown", "invalid", "mismatch", "invalid-hash"])(
    "unifies %s login failure without HTTP error logging",
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
      expectProblem(
        response,
        401,
        "Unauthorized",
        "メールアドレスまたはパスワードが正しくありません",
      );
      expect(response.headers["www-authenticate"]).toBeUndefined();
      expect(fixture.passwords.verifyCalls).toBe(1);
      expect(fixture.logger.errors).toHaveLength(
        failure === "invalid-hash" ? 1 : 0,
      );
      if (failure === "invalid-hash") {
        expect(fixture.logger.errors[0]?.message).toBe(
          "invalid stored password hash",
        );
        expect(fixture.logger.errors[0]?.attributes?.error).toBeInstanceOf(
          InvalidHashError,
        );
      }
    },
  );

  it.each(["password", "database"])(
    "maps a wrapped %s wait failure to 503",
    async (source) => {
      const fixture = await createFixture();
      if (source === "password") {
        fixture.passwords.onHash = () =>
          Promise.reject(
            new Error("wrapped", { cause: new PasswordBusyError() }),
          );
      } else {
        fixture.repository.onCreate = () =>
          Promise.reject(new Error("wrapped", { cause: new BusyError() }));
      }
      const response = await fixture.post("/v1/users", validInput);
      expectProblem(
        response,
        503,
        "Service Unavailable",
        "一時的に処理を受け付けられません",
      );
      expect(fixture.logger.errors).toEqual([]);
    },
  );

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
    expect(fixture.logger.errors).toHaveLength(1);
  });

  it.each(["generate", "save"])(
    "keeps login successful after rehash %s failure with one service warning",
    async (stage) => {
      const fixture = await createFixture();
      await fixture.post("/v1/users", validInput);
      fixture.passwords.rehashRequired = true;
      const failure = new Error("rehash failed");
      if (stage === "generate") {
        fixture.passwords.onRehash = () => Promise.reject(failure);
      } else {
        fixture.repository.onUpdate = () => Promise.reject(failure);
      }
      const response = await fixture.post("/v1/sessions", validInput);
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ user_id: "test-user-1" });
      expect(fixture.logger.warnings).toHaveLength(1);
      expect(fixture.logger.errors).toEqual([]);
    },
  );
});
