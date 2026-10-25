export interface UserStore {
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

export type NewUser = {
  id: string;
  email: string;
  emailNormalized: string;
  passwordHash: string;
};

export type Credential = {
  userId: string;
  passwordHash: string;
};
