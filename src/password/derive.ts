import { argon2 } from "node:crypto";
import type { Argon2Parameters } from "node:crypto";

export type DeriveKey = (parameters: Argon2Parameters) => Promise<Buffer>;

function nativeDerive(parameters: Argon2Parameters): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2("argon2id", parameters, (error, key) => {
      if (error !== null) {
        reject(new Error("Derive password key.", { cause: error }));
        return;
      }
      resolve(key);
    });
  });
}

let derive: DeriveKey = nativeDerive;

export function deriveKey(parameters: Argon2Parameters): Promise<Buffer> {
  return derive(parameters);
}

export function replaceDerivationForTesting(
  replacement: DeriveKey,
): () => void {
  const previous = derive;
  derive = replacement;
  return () => {
    derive = previous;
  };
}
