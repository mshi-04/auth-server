import type { EncodedHash, Password } from "../../../src/models/index.ts";
import type { PasswordProvider } from "../../../src/providers/index.ts";

export class RecordingPasswordProvider implements PasswordProvider {
  hashCalls: { password: Password; signal: AbortSignal }[] = [];
  rehashCalls: { password: Password; signal: AbortSignal }[] = [];
  verifyCalls: {
    password: Password;
    encoded: EncodedHash;
    signal: AbortSignal;
  }[] = [];
  needsRehashCalls: EncodedHash[] = [];
  dummyHash: EncodedHash;
  hashedResult: EncodedHash;
  rehashedResult: EncodedHash;
  verifyResult = true;
  needsRehashResult = false;
  onHash = (): Promise<EncodedHash> =>
    Promise.resolve(
      this.hashCalls.length === 1 ? this.dummyHash : this.hashedResult,
    );
  onRehash = (): Promise<EncodedHash> => Promise.resolve(this.rehashedResult);
  onVerify = (): Promise<boolean> => Promise.resolve(this.verifyResult);

  constructor(values: {
    dummyHash: EncodedHash;
    hashedResult: EncodedHash;
    rehashedResult: EncodedHash;
  }) {
    this.dummyHash = values.dummyHash;
    this.hashedResult = values.hashedResult;
    this.rehashedResult = values.rehashedResult;
  }

  hash(password: Password, signal: AbortSignal): Promise<EncodedHash> {
    this.hashCalls.push({ password, signal });
    return this.onHash();
  }

  rehash(password: Password, signal: AbortSignal): Promise<EncodedHash> {
    this.rehashCalls.push({ password, signal });
    return this.onRehash();
  }

  verify(
    password: Password,
    encoded: EncodedHash,
    signal: AbortSignal,
  ): Promise<boolean> {
    this.verifyCalls.push({ password, encoded, signal });
    return this.onVerify();
  }

  needsRehash(encoded: EncodedHash): boolean {
    this.needsRehashCalls.push(encoded);
    return this.needsRehashResult;
  }
}
