import {
  EmailTakenError,
  UserNotFoundError,
} from "../../../src/errors/index.ts";
import type { Credential, NewUser } from "../../../src/models/index.ts";
import type { UserRepository } from "../../../src/repositories/index.ts";

export class RecordingUserRepository implements UserRepository {
  createUserCalls: { user: NewUser; signal: AbortSignal }[] = [];
  findCredentialCalls: { emailNormalized: string; signal: AbortSignal }[] = [];
  updatePasswordHashCalls: {
    userId: string;
    passwordHash: string;
    signal: AbortSignal;
  }[] = [];
  credential: Credential;
  onCreateUser = (): Promise<void> => Promise.resolve();
  onFindCredentialByEmail = (): Promise<Credential> =>
    Promise.resolve(this.credential);
  onUpdatePasswordHash = (): Promise<void> => Promise.resolve();

  constructor(credential: Credential) {
    this.credential = credential;
  }

  createUser(user: NewUser, signal: AbortSignal): Promise<void> {
    this.createUserCalls.push({ user, signal });
    return this.onCreateUser();
  }

  findCredentialByEmail(
    emailNormalized: string,
    signal: AbortSignal,
  ): Promise<Credential> {
    this.findCredentialCalls.push({ emailNormalized, signal });
    return this.onFindCredentialByEmail();
  }

  updatePasswordHash(
    userId: string,
    passwordHash: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.updatePasswordHashCalls.push({ userId, passwordHash, signal });
    return this.onUpdatePasswordHash();
  }
}

export class RouteUserRepository implements UserRepository {
  users: NewUser[] = [];
  findCalls: string[] = [];
  updateCalls: { userId: string; passwordHash: string }[] = [];
  onCreate = (): Promise<void> => Promise.resolve();
  onFind = (): Promise<void> => Promise.resolve();
  onUpdate = (): Promise<void> => Promise.resolve();

  async createUser(user: NewUser): Promise<void> {
    await this.onCreate();
    if (
      this.users.some((entry) => entry.emailNormalized === user.emailNormalized)
    ) {
      throw new EmailTakenError();
    }
    this.users.push(user);
  }

  async findCredentialByEmail(emailNormalized: string): Promise<Credential> {
    this.findCalls.push(emailNormalized);
    await this.onFind();
    const user = this.users.find(
      (entry) => entry.emailNormalized === emailNormalized,
    );
    if (user === undefined) {
      throw new UserNotFoundError();
    }
    return { userId: user.id, passwordHash: user.passwordHash };
  }

  async updatePasswordHash(
    userId: string,
    passwordHash: string,
  ): Promise<void> {
    this.updateCalls.push({ userId, passwordHash });
    await this.onUpdate();
  }
}

export class InMemoryUserRepository implements UserRepository {
  usersById = new Map<string, NewUser>();
  userIdByEmail = new Map<string, string>();

  createUser(user: NewUser, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(new Error("aborted", { cause: signal.reason }));
    }
    if (this.userIdByEmail.has(user.emailNormalized)) {
      return Promise.reject(new EmailTakenError());
    }
    this.usersById.set(user.id, { ...user });
    this.userIdByEmail.set(user.emailNormalized, user.id);
    return Promise.resolve();
  }

  findCredentialByEmail(
    emailNormalized: string,
    signal: AbortSignal,
  ): Promise<Credential> {
    if (signal.aborted) {
      return Promise.reject(new Error("aborted", { cause: signal.reason }));
    }
    const userId = this.userIdByEmail.get(emailNormalized);
    const user = userId !== undefined ? this.usersById.get(userId) : undefined;
    if (user === undefined) {
      return Promise.reject(new UserNotFoundError());
    }
    return Promise.resolve({
      userId: user.id,
      passwordHash: user.passwordHash,
    });
  }

  updatePasswordHash(
    userId: string,
    passwordHash: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(new Error("aborted", { cause: signal.reason }));
    }
    const user = this.usersById.get(userId);
    if (user === undefined) {
      return Promise.reject(new UserNotFoundError());
    }
    this.usersById.set(userId, { ...user, passwordHash });
    return Promise.resolve();
  }
}
