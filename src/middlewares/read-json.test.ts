import {
  createServer,
  IncomingMessage,
  request as httpRequest,
} from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { rejected } from "../../tests/support/errors.ts";
import { listenOnLoopback } from "../../tests/support/http.ts";
import { BadRequestError, PayloadTooLargeError } from "../errors/index.ts";
import type { RequestContext } from "../models/index.ts";
import { readJson } from "./read-json.ts";

function context(signal = new AbortController().signal): RequestContext {
  return {
    signal,
    disconnectedSignal: signal,
    deadlineSignal: signal,
    deadline: Infinity,
    canRespond: () => !signal.aborted,
  };
}

function request(chunks: readonly Buffer[]): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  for (const chunk of chunks) {
    req.push(chunk);
  }
  req.complete = true;
  req.push(null);
  return req;
}

describe("readJson", () => {
  it("reads chunked UTF-8 without requiring a content type", async () => {
    const body = Buffer.from('{"email":"日本語","password":""}');
    const req = request([body.subarray(0, 12), body.subarray(12)]);
    await expect(readJson(req, context())).resolves.toEqual({
      email: "日本語",
      password: "",
    });
    expect(req.listenerCount("data")).toBe(0);
    expect(req.listenerCount("error")).toBe(0);
  });

  it("accepts the entire 16 KiB body including trailing whitespace", async () => {
    const body = Buffer.from("{}" + " ".repeat(16 * 1024 - 2));
    const req = request([body]);
    req.headers["content-length"] = String(body.length);
    await expect(readJson(req, context())).resolves.toEqual({});
  });

  it("rejects an excessive declared length before reading the body", async () => {
    const req = new IncomingMessage(new Socket());
    req.headers["content-length"] = String(16 * 1024 + 1);
    await expect(readJson(req, context())).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
    expect(req.destroyed).toBe(false);
    expect(req.listenerCount("data")).toBe(0);
    req.push(null);
  });

  it.each([undefined, "1"])(
    "counts actual bytes even when content length is %s",
    async (length) => {
      const req = request([
        Buffer.from("{}"),
        Buffer.alloc(16 * 1024 - 2, " "),
        Buffer.from(" "),
      ]);
      if (length !== undefined) {
        req.headers["content-length"] = length;
      }
      await expect(readJson(req, context())).rejects.toBeInstanceOf(
        PayloadTooLargeError,
      );
      expect(req.socket.destroyed).toBe(false);
      expect(req.listenerCount("data")).toBe(0);
    },
  );

  it.each(["", "{", "{} {}", "{} trailing", '"secret-password" junk'])(
    "rejects malformed JSON without preserving parser content %j",
    async (body) => {
      const req = request([Buffer.from(body)]);
      const error = await rejected(readJson(req, context()));
      expect(error).toMatchObject({
        name: "BadRequestError",
        kind: "invalid-input",
        message: "Invalid request.",
      });
      expect(error).not.toHaveProperty("cause");
    },
  );

  it.each([null, [], 0, true, "value"])(
    "leaves structure validation of %j to schemas",
    async (value) => {
      await expect(
        readJson(request([Buffer.from(JSON.stringify(value))]), context()),
      ).resolves.toEqual(value);
    },
  );

  it("replaces invalid UTF-8 and retains lone escaped surrogates", async () => {
    const body = Buffer.concat([
      Buffer.from('{"email":"'),
      Buffer.from([0xff]),
      Buffer.from('","password":"\\ud800"}'),
    ]);
    await expect(readJson(request([body]), context())).resolves.toEqual({
      email: "\ufffd",
      password: "\ud800",
    });
  });

  it("retains the last duplicate key and exact key casing", async () => {
    const body = '{"email":"first","email":"last","Email":"uppercase"}';
    await expect(
      readJson(request([Buffer.from(body)]), context()),
    ).resolves.toEqual({ email: "last", Email: "uppercase" });
  });

  it.each(["error", "aborted"])(
    "classifies a body %s separately without retaining transport secrets",
    async (event) => {
      const req = new IncomingMessage(new Socket());
      const promise = readJson(req, context());
      req.emit(event, new Error("secret request payload"));
      const error = await rejected(promise);
      expect(error).toMatchObject({
        kind: "read-failed",
        name: "BadRequestError",
      });
      expect(error).not.toHaveProperty("cause");
      req.push(null);
    },
  );

  it("rejects promptly and removes its listeners when aborted mid-body", async () => {
    const controller = new AbortController();
    const req = new IncomingMessage(new Socket());
    const promise = readJson(req, context(controller.signal));
    const reason = new Error("deadline");
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
    expect(req.listenerCount("data")).toBe(0);
    expect(req.listenerCount("aborted")).toBe(0);
    req.push(null);
  });

  it("does not read an already aborted request", async () => {
    const reason = new Error("disconnected");
    const req = request([Buffer.from("{}")]);
    await expect(
      readJson(req, context(AbortSignal.abort(reason))),
    ).rejects.toBe(reason);
    expect(req.listenerCount("data")).toBe(0);
    req.destroy();
  });

  it("classifies an already destroyed body as unreadable", async () => {
    const req = new IncomingMessage(new Socket());
    req.destroy();
    await expect(readJson(req, context())).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it("handles a real client disconnect in the middle of a body without an unhandled stream error", async () => {
    let markStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markClosed = (): void => undefined;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    let readResult: Promise<unknown> | undefined;
    const server = createServer((req) => {
      readResult = rejected(readJson(req, context()));
      req.once("data", markStarted);
      req.once("close", markClosed);
    });
    const port = await listenOnLoopback(server);
    const client = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      headers: { "Content-Length": "100" },
    });
    client.on("error", () => undefined);
    try {
      client.write("{");
      await started;
      client.destroy();
      await closed;
      expect(readResult).toBeDefined();
      expect(await readResult).toMatchObject({
        name: "BadRequestError",
        kind: "read-failed",
      });
    } finally {
      client.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});
