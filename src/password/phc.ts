import { InvalidHashError } from "./errors.ts";
import { inRange, validCost } from "./params.ts";
import type { Cost } from "./params.ts";

export type DecodedHash = { cost: Cost; salt: Buffer; key: Buffer };

export function encodeBase64(bytes: Buffer): string {
  return bytes.toString("base64").replace(/=+$/, "");
}

export function encodeHash(decoded: DecodedHash): string {
  const { cost, salt, key } = decoded;
  return `$argon2id$v=19$m=${cost.memoryKiB.toString()},t=${cost.iterations.toString()},p=${cost.parallelism.toString()}$${encodeBase64(salt)}$${encodeBase64(key)}`;
}

function decodePart(encoded: string, minimum: number, maximum: number): Buffer {
  if (
    encoded.length < Math.ceil((minimum * 8) / 6) ||
    encoded.length > Math.ceil((maximum * 8) / 6) ||
    /[^A-Za-z0-9+/]/.test(encoded)
  ) {
    throw new InvalidHashError();
  }
  const decoded = Buffer.from(encoded, "base64");
  if (
    !inRange(decoded.length, minimum, maximum) ||
    encodeBase64(decoded) !== encoded
  ) {
    throw new InvalidHashError();
  }
  return decoded;
}

function parseCost(encoded: string): Cost {
  const fields = encoded.split(",");
  const values = new Map<string, number>();
  if (fields.length !== 3) {
    throw new InvalidHashError();
  }
  for (const field of fields) {
    const [name, raw, extra] = field.split("=");
    if (
      name === undefined ||
      !["m", "t", "p"].includes(name) ||
      raw === undefined ||
      !/^(0|[1-9][0-9]*)$/.test(raw) ||
      extra !== undefined ||
      values.has(name)
    ) {
      throw new InvalidHashError();
    }
    values.set(name, Number(raw));
  }
  const memoryKiB = values.get("m");
  const iterations = values.get("t");
  const parallelism = values.get("p");
  if (
    memoryKiB === undefined ||
    iterations === undefined ||
    parallelism === undefined
  ) {
    throw new InvalidHashError();
  }
  const cost = { memoryKiB, iterations, parallelism };
  if (!validCost(cost)) {
    throw new InvalidHashError();
  }
  return cost;
}

export function parseHash(encoded: string): DecodedHash {
  const [prefix, algorithm, version, cost, salt, key, extra] =
    encoded.split("$");
  if (
    prefix !== "" ||
    algorithm !== "argon2id" ||
    version !== "v=19" ||
    cost === undefined ||
    salt === undefined ||
    key === undefined ||
    extra !== undefined
  ) {
    throw new InvalidHashError();
  }
  return {
    cost: parseCost(cost),
    salt: decodePart(salt, 8, 64),
    key: decodePart(key, 4, 64),
  };
}
