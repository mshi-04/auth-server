import { randomBytes, randomUUID } from "node:crypto";
import type { IdProvider } from "./index.ts";

const dummyPasswordBytes = 32;

export class CryptoIdProvider implements IdProvider {
  private constructor() {}

  static create(): CryptoIdProvider {
    return new CryptoIdProvider();
  }

  newUserId(): string {
    return randomUUID();
  }

  newDummyPassword(): string {
    return randomBytes(dummyPasswordBytes).toString("hex");
  }
}
