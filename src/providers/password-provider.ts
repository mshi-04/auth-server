import type { EncodedHash, Password } from "../models/index.ts";

export interface PasswordProvider {
  hash(password: Password, signal: AbortSignal): Promise<EncodedHash>;
  rehash(password: Password, signal: AbortSignal): Promise<EncodedHash>;
  verify(
    password: Password,
    encoded: EncodedHash,
    signal: AbortSignal,
  ): Promise<boolean>;
  needsRehash(encoded: EncodedHash): boolean;
}
