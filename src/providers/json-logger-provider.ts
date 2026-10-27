import { EncodedHash, Password } from "../models/index.ts";
import type { LoggerProvider } from "./index.ts";

type LogOutput = { write(line: string): unknown };
type Level = "info" | "warn" | "error";
type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const unsupported = "[Unserializable]";
const circular = "[Circular]";

function readProperty(value: object, key: string): unknown {
  try {
    const property: unknown = Reflect.get(value, key);
    return property;
  } catch {
    return unsupported;
  }
}

function serialize(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): JsonValue {
  try {
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
      return "[REDACTED]";
    }
    if (ancestors.has(value)) {
      return circular;
    }
    if (depth >= 64) {
      return unsupported;
    }

    ancestors.add(value);
    try {
      if (value instanceof Error) {
        const entries: [string, JsonValue][] = [
          [
            "name",
            serialize(readProperty(value, "name"), ancestors, depth + 1),
          ],
          [
            "message",
            serialize(readProperty(value, "message"), ancestors, depth + 1),
          ],
        ];
        if ("cause" in value) {
          entries.push([
            "cause",
            serialize(readProperty(value, "cause"), ancestors, depth + 1),
          ]);
        }
        return Object.fromEntries(entries);
      }
      if (value instanceof Date) {
        return Number.isFinite(Date.prototype.getTime.call(value))
          ? Date.prototype.toISOString.call(value)
          : unsupported;
      }
      if (Array.isArray(value)) {
        return Array.from(value, (item: unknown) =>
          serialize(item, ancestors, depth + 1),
        );
      }
      const entries: [string, JsonValue][] = Object.keys(value).map(
        (key): [string, JsonValue] => [
          key,
          serialize(readProperty(value, key), ancestors, depth + 1),
        ],
      );
      return Object.fromEntries(entries);
    } finally {
      ancestors.delete(value);
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
    const ancestors = new WeakSet<object>([attributes]);
    return Object.keys(attributes)
      .filter((key) => !["time", "level", "msg"].includes(key))
      .map((key): [string, JsonValue] => [
        key,
        serialize(readProperty(attributes, key), ancestors, 0),
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
        ...attributeEntries(attributes),
        ["time", new Date().toISOString()],
        ["level", level],
        ["msg", message],
      ]);
      this.#output.write(`${JSON.stringify(entry)}\n`);
    } catch {
      return;
    }
  }
}
