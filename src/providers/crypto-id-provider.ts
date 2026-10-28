import { randomBytes, randomUUID } from "node:crypto";
import type { IdProvider } from "./index.ts";

export class CryptoIdProvider implements IdProvider {
  private constructor() {}

  static create(): CryptoIdProvider {
    return new CryptoIdProvider();
  }

  newUserId(): string {
    return randomUUID();
  }

  newDummyPassword(): string {
    return randomBytes(32).toString("hex");
  }
}
