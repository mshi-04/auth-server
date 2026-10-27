import { EncodedHash, Password } from "../models/index.ts";
import type { LoggerProvider } from "./index.ts";

type LogOutput = {
  write(line: string): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
};
type Level = "info" | "warn" | "error";
type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Budget = { ancestors: WeakSet<object>; remaining: number };

const unsupported = "[Unserializable]";
const circular = "[Circular]";
const redacted = "[REDACTED]";
const maxDepth = 64;
const maxValuesPerAttribute = 1000;
const reservedKeys = ["time", "level", "msg"];
const secretKeys = ["password", "rawPassword", "passwordHash", "encodedHash"];

function readProperty(value: object, key: string): unknown {
  try {
    const property: unknown = Reflect.get(value, key);
    return property;
  } catch {
    return unsupported;
  }
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBinary(value: object): boolean {
  return (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof SharedArrayBuffer
  );
}

function serializeProperty(
  value: object,
  key: string,
  budget: Budget,
  depth: number,
): JsonValue {
  if (secretKeys.includes(key)) {
    return redacted;
  }
  return serialize(readProperty(value, key), budget, depth);
}

function serialize(value: unknown, budget: Budget, depth: number): JsonValue {
  try {
    if (budget.remaining <= 0) {
      return unsupported;
    }
    budget.remaining--;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : unsupported;
    }
    if (typeof value !== "object") {
      return unsupported;
    }
    if (value instanceof Password || value instanceof EncodedHash) {
      return redacted;
    }
    if (budget.ancestors.has(value)) {
      return circular;
    }
    if (depth >= maxDepth || isBinary(value)) {
      return unsupported;
    }

    budget.ancestors.add(value);
    try {
      if (value instanceof Error) {
        const entries: [string, JsonValue][] = [
          ["name", serialize(readProperty(value, "name"), budget, depth + 1)],
          [
            "message",
            serialize(readProperty(value, "message"), budget, depth + 1),
          ],
        ];
        const cause = readProperty(value, "cause");
        if (cause !== undefined) {
          entries.push(["cause", serialize(cause, budget, depth + 1)]);
        }
        return Object.fromEntries(entries);
      }
      if (value instanceof Date) {
        return Number.isFinite(Date.prototype.getTime.call(value))
          ? Date.prototype.toISOString.call(value)
          : unsupported;
      }
      if (Array.isArray(value)) {
        if (value.length > budget.remaining) {
          return unsupported;
        }
        return Array.from({ length: value.length }, (_, index) =>
          serialize(readProperty(value, String(index)), budget, depth + 1),
        );
      }
      const keys = Object.keys(value);
      if (keys.length > budget.remaining) {
        return unsupported;
      }
      if (keys.length === 0 && !isPlainObject(value)) {
        return unsupported;
      }
      return Object.fromEntries(
        keys.map((key): [string, JsonValue] => [
          key,
          serializeProperty(value, key, budget, depth + 1),
        ]),
      );
    } finally {
      budget.ancestors.delete(value);
    }
  } catch {
    return unsupported;
  }
}

function attributeEntries(
  attributes: Record<string, unknown> | undefined,
): [string, JsonValue][] {
  if (attributes === undefined) {
    return [];
  }
  try {
    return Object.keys(attributes)
      .filter((key) => !reservedKeys.includes(key))
      .map((key): [string, JsonValue] => [
        key,
        serializeProperty(
          attributes,
          key,
          {
            ancestors: new WeakSet<object>([attributes]),
            remaining: maxValuesPerAttribute,
          },
          0,
        ),
      ]);
  } catch {
    return [["attributes", unsupported]];
  }
}

export class JsonLoggerProvider implements LoggerProvider {
  #output: LogOutput;

  private constructor(output: LogOutput) {
    this.#output = output;
  }

  static create(output: LogOutput): JsonLoggerProvider {
    // EPIPE などの書き込み失敗は "error" イベントで届き、listener が無いと
    // プロセスが落ちる。ログが欠けてもサーバーを止めないため、意図して捨てる。
    output.on("error", () => undefined);
    return new JsonLoggerProvider(output);
  }

  info(message: string, attributes?: Record<string, unknown>): void {
    this.#write("info", message, attributes);
  }

  warn(message: string, attributes?: Record<string, unknown>): void {
    this.#write("warn", message, attributes);
  }

  error(message: string, attributes?: Record<string, unknown>): void {
    this.#write("error", message, attributes);
  }

  #write(
    level: Level,
    message: string,
    attributes: Record<string, unknown> | undefined,
  ): void {
    try {
      const entry = Object.fromEntries([
        ["time", new Date().toISOString()],
        ["level", level],
        ["msg", message],
        ...attributeEntries(attributes),
      ]);
      this.#output.write(`${JSON.stringify(entry)}\n`);
    } catch {
      return;
    }
  }
}
