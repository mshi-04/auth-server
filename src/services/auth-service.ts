import {
  BusyError,
  InvalidCredentialsError,
  InvalidEmailError,
  PasswordBusyError,
  PolicyViolationError,
  UserNotFoundError,
  WeakPasswordError,
  findError,
  isCausedBy,
} from "../errors/index.ts";
import {
  EncodedHash,
  Password,
  normalizeEmail,
  parseEmail,
} from "../models/index.ts";
import type { AuthInput, AuthResult, Credential } from "../models/index.ts";
import type {
  IdProvider,
  LoggerProvider,
  PasswordProvider,
} from "../providers/index.ts";
import type { UserRepository } from "../repositories/index.ts";

function passwordError(message: string, error: unknown): Error {
  if (findError(error, PasswordBusyError) !== undefined) {
    return new BusyError(message, { cause: error });
  }
  return new Error(message, { cause: error });
}

function isAbortedBySignal(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && isCausedBy(error, signal.reason);
}

export class AuthService {
  #repository: UserRepository;
  #passwordProvider: PasswordProvider;
  #idProvider: IdProvider;
  #logger: LoggerProvider;
  #dummyHash: EncodedHash;

  private constructor(
    repository: UserRepository,
    passwordProvider: PasswordProvider,
    idProvider: IdProvider,
    logger: LoggerProvider,
    dummyHash: EncodedHash,
  ) {
    this.#repository = repository;
    this.#passwordProvider = passwordProvider;
    this.#idProvider = idProvider;
    this.#logger = logger;
    this.#dummyHash = dummyHash;
  }

  static async create(
    repository: UserRepository,
    passwordProvider: PasswordProvider,
    idProvider: IdProvider,
    logger: LoggerProvider,
    signal: AbortSignal,
  ): Promise<AuthService> {
    let dummyPassword: Password;
    try {
      dummyPassword = Password.parse(idProvider.newDummyPassword());
    } catch (error) {
      throw new Error("Create dummy password failed.", { cause: error });
    }
    let dummyHash: EncodedHash;
    try {
      dummyHash = await passwordProvider.hash(dummyPassword, signal);
    } catch (error) {
      throw passwordError("Create dummy password hash failed.", error);
    }
    return new AuthService(
      repository,
      passwordProvider,
      idProvider,
      logger,
      dummyHash,
    );
  }

  async register(input: AuthInput, signal: AbortSignal): Promise<AuthResult> {
    let parsedPassword: Password;
    try {
      parsedPassword = Password.parse(input.rawPassword);
    } catch (error) {
      throw new WeakPasswordError("Register user failed.", { cause: error });
    }

    let email: string;
    try {
      email = parseEmail(input.email);
    } catch (error) {
      throw new InvalidEmailError("Register user failed.", { cause: error });
    }

    let encoded: EncodedHash;
    try {
      encoded = await this.#passwordProvider.hash(parsedPassword, signal);
    } catch (error) {
      if (findError(error, PolicyViolationError) !== undefined) {
        throw new WeakPasswordError("Register user failed.", { cause: error });
      }
      throw passwordError("Hash registration password failed.", error);
    }

    const passwordHash = encoded.phc();
    try {
      const userId = this.#idProvider.newUserId();
      await this.#repository.createUser(
        {
          id: userId,
          email,
          emailNormalized: normalizeEmail(email),
          passwordHash,
        },
        signal,
      );
      return { userId };
    } catch (error) {
      throw new Error("Register user failed.", { cause: error });
    }
  }

  async login(input: AuthInput, signal: AbortSignal): Promise<AuthResult> {
    let parsedPassword: Password;
    try {
      parsedPassword = Password.parse(input.rawPassword);
    } catch (error) {
      throw new InvalidCredentialsError("Login failed.", { cause: error });
    }

    let emailNormalized: string;
    try {
      emailNormalized = normalizeEmail(input.email);
    } catch (error) {
      return this.#rejectWithDummy(parsedPassword, signal, error);
    }

    let credential: Credential;
    try {
      credential = await this.#repository.findCredentialByEmail(
        emailNormalized,
        signal,
      );
    } catch (error) {
      if (findError(error, UserNotFoundError) !== undefined) {
        return this.#rejectWithDummy(parsedPassword, signal, error);
      }
      throw new Error("Find login credential failed.", { cause: error });
    }

    let encoded: EncodedHash;
    try {
      encoded = EncodedHash.parse(credential.passwordHash);
    } catch (error) {
      this.#logger.error("invalid stored password hash", {
        userId: credential.userId,
        error,
      });
      return this.#rejectWithDummy(parsedPassword, signal, error);
    }

    let match: boolean;
    try {
      match = await this.#passwordProvider.verify(
        parsedPassword,
        encoded,
        signal,
      );
    } catch (error) {
      throw passwordError("Verify login password failed.", error);
    }

    if (!match) {
      throw new InvalidCredentialsError("Login failed.");
    }

    if (this.#passwordProvider.needsRehash(encoded)) {
      await this.#rehashCredential(credential.userId, parsedPassword, signal);
    }

    return { userId: credential.userId };
  }

  async #rejectWithDummy(
    parsedPassword: Password,
    signal: AbortSignal,
    cause: unknown,
  ): Promise<never> {
    try {
      await this.#passwordProvider.verify(
        parsedPassword,
        this.#dummyHash,
        signal,
      );
    } catch (error) {
      throw passwordError("Verify dummy password failed.", error);
    }
    throw new InvalidCredentialsError("Login failed.", { cause });
  }

  async #rehashCredential(
    userId: string,
    parsedPassword: Password,
    signal: AbortSignal,
  ): Promise<void> {
    let encoded: EncodedHash;
    try {
      encoded = await this.#passwordProvider.rehash(parsedPassword, signal);
    } catch (error) {
      if (!isAbortedBySignal(error, signal)) {
        this.#logger.warn("rehash password failed", { userId, error });
      }
      return;
    }

    const passwordHash = encoded.phc();
    try {
      await this.#repository.updatePasswordHash(userId, passwordHash, signal);
    } catch (error) {
      if (!isAbortedBySignal(error, signal)) {
        this.#logger.warn("save rehashed password failed", { userId, error });
      }
    }
  }
}
