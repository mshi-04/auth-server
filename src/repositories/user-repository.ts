import type { Credential, NewUser } from "../models/index.ts";

export interface UserRepository {
  createUser(user: NewUser, signal: AbortSignal): Promise<void>;
  findCredentialByEmail(
    emailNormalized: string,
    signal: AbortSignal,
  ): Promise<Credential>;
  updatePasswordHash(
    userId: string,
    passwordHash: string,
    signal: AbortSignal,
  ): Promise<void>;
}
