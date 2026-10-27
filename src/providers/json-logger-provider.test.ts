import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EncodedHash, Password } from "../models/index.ts";
import { JsonLoggerProvider } from "./json-logger-provider.ts";
import type { LoggerProvider } from "./index.ts";

const time = "2026-10-28T03:04:05.000Z";

function capture(): { logger: LoggerProvider; lines: string[] } {
  const lines: string[] = [];
  const logger = JsonLoggerProvider.create({
    write(line: string) {
      lines.push(line);
    },
  });
  return { logger, lines };
}

function entry(lines: string[]): unknown {
  expect(lines).toHaveLength(1);
  const line = lines[0];
  if (line === undefined) {
    throw new Error("Expected a log line.");
  }
  expect(line.endsWith("\n")).toBe(true);
  expect(line.split("\n")).toHaveLength(2);
  const parsed: unknown = JSON.parse(line);
  return parsed;
}

describe("JsonLoggerProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(time));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["info", "warn", "error"])(
    "writes one structured %s event",
    (level) => {
      const { logger, lines } = capture();
      switch (level) {
        case "info":
          logger.info("event\nmessage", { requestId: "request-1", count: 3 });
          break;
        case "warn":
          logger.warn("event\nmessage", { requestId: "request-1", count: 3 });
          break;
        case "error":
          logger.error("event\nmessage", { requestId: "request-1", count: 3 });
          break;
        default:
          throw new Error("Unexpected level.");
      }
      expect(entry(lines)).toEqual({
        time,
        level,
        msg: "event\nmessage",
        requestId: "request-1",
        count: 3,
      });
    },
  );

  it("supports a Node Writable output without using global stdout", () => {
    const lines: string[] = [];
    const output = new Writable({
      decodeStrings: false,
      write(chunk: unknown, _encoding, callback) {
        if (typeof chunk !== "string") {
          callback(new Error("Expected a string chunk."));
          return;
        }
        lines.push(chunk);
        callback();
      },
    });
    JsonLoggerProvider.create(output).info("ready");
    expect(entry(lines)).toEqual({ time, level: "info", msg: "ready" });
    output.destroy();
  });

  it("keeps metadata authoritative and does not read reserved attributes", () => {
    const { logger, lines } = capture();
    logger.info("ready", {
      time: "forged",
      level: "forged",
      get msg() {
        throw new Error("Reserved metadata must not be read.");
      },
      retained: true,
    });
    expect(entry(lines)).toEqual({
      time,
      level: "info",
      msg: "ready",
      retained: true,
    });
  });

  it("serializes nested Error causes consistently without stacks or extra fields", () => {
    const { logger, lines } = capture();
    const cause = new TypeError("invalid state");
    const failure = new Error("operation failed", { cause });
    Object.assign(failure, { sensitiveExtra: "must not be serialized" });
    logger.error("failure", { failure, nested: [{ failure }] });
    const serialized = {
      name: "Error",
      message: "operation failed",
      cause: { name: "TypeError", message: "invalid state" },
    };
    expect(entry(lines)).toEqual({
      time,
      level: "error",
      msg: "failure",
      failure: serialized,
      nested: [{ failure: serialized }],
    });
    expect(lines[0]).not.toContain("stack");
    expect(lines[0]).not.toContain("must not be serialized");
  });

  it("replaces object, array, and Error cause cycles while retaining repeated siblings", () => {
    const { logger, lines } = capture();
    const object: Record<string, unknown> = {};
    object.self = object;
    const array: unknown[] = [];
    array.push(array);
    const failure = new Error("cycle");
    failure.cause = failure;
    const shared = { value: 1 };
    const attributes: Record<string, unknown> = {
      object,
      array,
      failure,
      shared,
      again: shared,
    };
    attributes.self = attributes;
    logger.warn("cycles", attributes);
    expect(entry(lines)).toEqual({
      time,
      level: "warn",
      msg: "cycles",
      object: { self: "[Circular]" },
      array: ["[Circular]"],
      failure: { name: "Error", message: "cycle", cause: "[Circular]" },
      shared: { value: 1 },
      again: { value: 1 },
      self: "[Circular]",
    });
  });

  it("replaces unsupported values at every nesting level", () => {
    const { logger, lines } = capture();
    logger.info("values", {
      value: 1n,
      nested: [
        undefined,
        Symbol("hidden"),
        () => "hidden",
        NaN,
        Infinity,
        -Infinity,
      ],
      json: [null, true, false, 2, "text"],
    });
    expect(entry(lines)).toEqual({
      time,
      level: "info",
      msg: "values",
      value: "[Unserializable]",
      nested: Array.from({ length: 6 }, () => "[Unserializable]"),
      json: [null, true, false, 2, "text"],
    });
  });

  it("preserves secret model redaction at any depth", () => {
    const { logger, lines } = capture();
    const password = Password.parse("correct horse battery staple");
    const encoded = EncodedHash.parse(
      "$argon2id$v=19$m=64,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    logger.info("models", {
      password,
      nested: { encoded, values: [password, encoded] },
    });
    expect(entry(lines)).toEqual({
      time,
      level: "info",
      msg: "models",
      password: "[REDACTED]",
      nested: { encoded: "[REDACTED]", values: ["[REDACTED]", "[REDACTED]"] },
    });
    expect(lines[0]).not.toContain("correct horse battery staple");
    expect(lines[0]).not.toContain(encoded.phc());
  });

  it("does not invoke own or inherited toJSON functions", () => {
    const { logger, lines } = capture();
    class Hostile {
      value = 1;
      toJSON(): never {
        throw new Error("Do not invoke this method.");
      }
    }
    logger.info("custom JSON", {
      inherited: new Hostile(),
      own: {
        toJSON: () => {
          throw new Error("Do not invoke this function.");
        },
        value: 2,
      },
    });
    expect(entry(lines)).toEqual({
      time,
      level: "info",
      msg: "custom JSON",
      inherited: { value: 1 },
      own: { toJSON: "[Unserializable]", value: 2 },
    });
  });

  it("handles throwing getters and proxies without losing other attributes", () => {
    const { logger, lines } = capture();
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("Unreadable object.");
        },
      },
    );
    logger.error("unreadable", {
      proxy,
      get value() {
        throw new Error("Unreadable property.");
      },
      retained: "ok",
    });
    expect(entry(lines)).toEqual({
      time,
      level: "error",
      msg: "unreadable",
      proxy: "[Unserializable]",
      value: "[Unserializable]",
      retained: "ok",
    });
  });

  it("emits a marker for an unreadable attributes record", () => {
    const { logger, lines } = capture();
    const attributes = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("Unreadable attributes.");
        },
      },
    );
    expect(() => {
      logger.info("attributes", attributes);
    }).not.toThrow();
    expect(entry(lines)).toEqual({
      time,
      level: "info",
      msg: "attributes",
      attributes: "[Unserializable]",
    });
  });

  it("preserves prototype-named fields as own JSON attributes", () => {
    const { logger, lines } = capture();
    const attributes = Object.fromEntries<unknown>([
      ["__proto__", { polluted: true }],
      ["constructor", "value"],
    ]);
    logger.info("safe keys", attributes);
    expect(entry(lines)).toEqual(
      JSON.parse(
        '{"time":"2026-10-28T03:04:05.000Z","level":"info","msg":"safe keys","__proto__":{"polluted":true},"constructor":"value"}',
      ),
    );
    expect(Object.hasOwn({}, "polluted")).toBe(false);
  });

  it("serializes dates and marks invalid dates and excessive nesting safely", () => {
    const { logger, lines } = capture();
    let nested: unknown = "end";
    for (let depth = 0; depth < 1000; depth++) {
      nested = { nested };
    }
    expect(() => {
      logger.info("deep", {
        date: new Date(time),
        invalid: new Date(NaN),
        nested,
      });
    }).not.toThrow();
    expect(lines[0]).toContain('"date":"2026-10-28T03:04:05.000Z"');
    expect(lines[0]).toContain('"invalid":"[Unserializable]"');
    expect(lines[0]).toContain("[Unserializable]");
    expect(entry(lines)).toBeDefined();
  });

  it("keeps synchronous output failures from replacing application errors", () => {
    const logger = JsonLoggerProvider.create({
      write() {
        throw new Error("Output failed.");
      },
    });
    expect(() => {
      logger.error("original failure");
    }).not.toThrow();
  });
});
