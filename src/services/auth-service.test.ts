import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  BusyError,
  EmailTakenError,
  InvalidCredentialsError,
  InvalidEmailError,
  InvalidHashError,
  InvalidParamsError,
  PasswordBusyError,
  PolicyViolationError,
  UserNotFoundError,
  WeakPasswordError,
  findError,
} from "../errors/index.ts";
import { EncodedHash, Password } from "../models/index.ts";
import type { Credential, NewUser } from "../models/index.ts";
import type {
  IdProvider,
  LoggerProvider,
  PasswordProvider,
} from "../providers/index.ts";
import type { UserRepository } from "../repositories/index.ts";
import { AuthService } from "./index.ts";

const dummyPhc =
  "$argon2id$v=19$m=64,t=1,p=1$MDEyMzQ1Njc4OWFiY2RlZg$AfH5MiapgBYnwv5hDfJ1tdBqyka5OpAKBAJoWXSzxiA";
const storedPhc = "$argon2id$v=19$m=8,t=1,p=1$MDEyMzQ1Njc$uzjqtw";
const rehashedPhc =
  "$argon2id$v=19$m=16,t=1,p=2$AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+Pw$H2hhzIpYf2BIF3S7ngpyWg2vNLH42OshViTR1heWycAPZCGOmE3pG4qTRCmKbP+HUDcbz+o9Ntm8ahHL3lmzOQ";
const validPassword = "correct horse battery staple";
const input = { email: "user@example.com", rawPassword: validPassword };
const createSignal = new AbortController().signal;
const signal = new AbortController().signal;

type LogEntry = {
  message: string;
  attributes: Record<string, unknown> | undefined;
};

class FakeUserRepository implements UserRepository {
  createUserCalls: { user: NewUser; signal: AbortSignal }[] = [];
  findCredentialCalls: { emailNormalized: string; signal: AbortSignal }[] = [];
  updatePasswordHashCalls: {
    userId: string;
    passwordHash: string;
    signal: AbortSignal;
  }[] = [];
  credential: Credential = { userId: "user-1", passwordHash: storedPhc };
  onCreateUser = (): Promise<void> => Promise.resolve();
  onFindCredentialByEmail = (): Promise<Credential> =>
    Promise.resolve(this.credential);
  onUpdatePasswordHash = (): Promise<void> => Promise.resolve();

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

class FakePasswordProvider implements PasswordProvider {
  hashCalls: { password: Password; signal: AbortSignal }[] = [];
  rehashCalls: { password: Password; signal: AbortSignal }[] = [];
  verifyCalls: {
    password: Password;
    encoded: EncodedHash;
    signal: AbortSignal;
  }[] = [];
  needsRehashCalls: EncodedHash[] = [];
  dummyHash = EncodedHash.parse(dummyPhc);
  hashedResult = EncodedHash.parse(storedPhc);
  rehashedResult = EncodedHash.parse(rehashedPhc);
  verifyResult = true;
  needsRehashResult = false;
  onHash = (): Promise<EncodedHash> =>
    Promise.resolve(
      this.hashCalls.length === 1 ? this.dummyHash : this.hashedResult,
    );
  onRehash = (): Promise<EncodedHash> => Promise.resolve(this.rehashedResult);
  onVerify = (): Promise<boolean> => Promise.resolve(this.verifyResult);

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

class FakeIdProvider implements IdProvider {
  userId = "00000000-0000-4000-8000-000000000001";
  dummyPassword = "dummy-password-123456";
  newUserIdCalls = 0;
  newDummyPasswordCalls = 0;
  onNewUserId = (): string => this.userId;
  onNewDummyPassword = (): string => this.dummyPassword;

  newUserId(): string {
    this.newUserIdCalls++;
    return this.onNewUserId();
  }

  newDummyPassword(): string {
    this.newDummyPasswordCalls++;
    return this.onNewDummyPassword();
  }
}

class FakeLoggerProvider implements LoggerProvider {
  infoCalls: LogEntry[] = [];
  warnCalls: LogEntry[] = [];
  errorCalls: LogEntry[] = [];

  info(message: string, attributes?: Record<string, unknown>): void {
    this.infoCalls.push({ message, attributes });
  }

  warn(message: string, attributes?: Record<string, unknown>): void {
    this.warnCalls.push({ message, attributes });
  }

  error(message: string, attributes?: Record<string, unknown>): void {
    this.errorCalls.push({ message, attributes });
  }
}

function createFakes() {
  return {
    repository: new FakeUserRepository(),
    passwordProvider: new FakePasswordProvider(),
    idProvider: new FakeIdProvider(),
    logger: new FakeLoggerProvider(),
  };
}

function createService(
  fakes: ReturnType<typeof createFakes>,
): Promise<AuthService> {
  return AuthService.create(
    fakes.repository,
    fakes.passwordProvider,
    fakes.idProvider,
    fakes.logger,
    createSignal,
  );
}

async function createTestContext() {
  const fakes = createFakes();
  return { ...fakes, service: await createService(fakes) };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}

function causeOf(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined;
}

describe("AuthService.create", () => {
  it("generates and hashes the dummy password at startup without touching repository or logger", async () => {
    const { repository, passwordProvider, idProvider, logger } =
      await createTestContext();

    expect(idProvider.newDummyPasswordCalls).toBe(1);
    expect(idProvider.newUserIdCalls).toBe(0);
    expect(passwordProvider.hashCalls).toHaveLength(1);
    expect(passwordProvider.hashCalls[0]?.password).toBeInstanceOf(Password);
    expect(passwordProvider.hashCalls[0]?.signal).toBe(createSignal);
    expect(repository.createUserCalls).toHaveLength(0);
    expect(repository.findCredentialCalls).toHaveLength(0);
    expect(repository.updatePasswordHashCalls).toHaveLength(0);
    expect(logger.infoCalls).toHaveLength(0);
    expect(logger.warnCalls).toHaveLength(0);
    expect(logger.errorCalls).toHaveLength(0);
  });

  it("wraps error when newDummyPassword throws", async () => {
    const fakes = createFakes();
    const cause = new Error("rng failure");
    fakes.idProvider.onNewDummyPassword = () => {
      throw cause;
    };

    const caught = await rejected(createService(fakes));

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(BusyError);
    expect(caught).toHaveProperty("message", "Create dummy password failed.");
    expect(causeOf(caught)).toBe(cause);
    expect(fakes.passwordProvider.hashCalls).toHaveLength(0);
  });

  it.each(["a".repeat(129), "\uD800"])(
    "wraps PolicyViolationError when newDummyPassword returns invalid password %j",
    async (invalidDummy) => {
      const fakes = createFakes();
      fakes.idProvider.dummyPassword = invalidDummy;

      const caught = await rejected(createService(fakes));

      expect(caught).toBeInstanceOf(Error);
      expect(findError(caught, PolicyViolationError)).toBeInstanceOf(
        PolicyViolationError,
      );
      expect(fakes.passwordProvider.hashCalls).toHaveLength(0);
    },
  );

  it("maps PasswordBusyError during dummy hash generation to BusyError", async () => {
    const fakes = createFakes();
    const busyCause = new PasswordBusyError("semaphore timeout");
    fakes.passwordProvider.onHash = () => Promise.reject(busyCause);

    const caught = await rejected(createService(fakes));

    expect(caught).toBeInstanceOf(BusyError);
    expect(findError(caught, PasswordBusyError)).toBe(busyCause);
  });

  it("wraps non-busy error during dummy hash generation in Error without BusyError", async () => {
    const fakes = createFakes();
    const paramsCause = new InvalidParamsError("bad params");
    fakes.passwordProvider.onHash = () => Promise.reject(paramsCause);

    const caught = await rejected(createService(fakes));

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(BusyError);
    expect(findError(caught, InvalidParamsError)).toBe(paramsCause);
  });
});

describe("AuthService.register", () => {
  it("parses password and email, hashes password, creates user with normalized email and PHC, and returns userId", async () => {
    const { repository, passwordProvider, idProvider, logger, service } =
      await createTestContext();

    const result = await service.register(
      { email: "  <Alice.Example@Example.COM>  ", rawPassword: validPassword },
      signal,
    );

    expect(result).toEqual({ userId: idProvider.userId });
    expect(passwordProvider.hashCalls).toHaveLength(2);
    expect(passwordProvider.hashCalls[1]?.password).toBeInstanceOf(Password);
    expect(passwordProvider.hashCalls[1]?.signal).toBe(signal);
    expect(idProvider.newUserIdCalls).toBe(1);
    expect(repository.createUserCalls).toEqual([
      {
        user: {
          id: idProvider.userId,
          email: "Alice.Example@Example.COM",
          emailNormalized: "alice.example@example.com",
          passwordHash: passwordProvider.hashedResult.phc(),
        },
        signal,
      },
    ]);
    expect(logger.infoCalls).toHaveLength(0);
    expect(logger.warnCalls).toHaveLength(0);
    expect(logger.errorCalls).toHaveLength(0);
  });

  it.each([
    ["lone surrogate", "abcdefghijkl\uD800"],
    ["over 128 code points", "a".repeat(129)],
    ["over 128 code points after NFKC expansion", "㍿".repeat(33)],
  ])(
    "rejects invalid password at Password.parse (%s) with WeakPasswordError before hashing or touching repository",
    async (_, rawPassword) => {
      const { repository, passwordProvider, idProvider, service } =
        await createTestContext();

      const caught = await rejected(
        service.register({ ...input, rawPassword }, signal),
      );

      expect(caught).toBeInstanceOf(WeakPasswordError);
      expect(findError(caught, PolicyViolationError)).toBeInstanceOf(
        PolicyViolationError,
      );
      expect(passwordProvider.hashCalls).toHaveLength(1);
      expect(idProvider.newUserIdCalls).toBe(0);
      expect(repository.createUserCalls).toHaveLength(0);
    },
  );

  it.each([
    "",
    "plainaddress",
    "@example.com",
    "user@",
    "user..name@example.com",
    "User <user@example.com>",
    "user@exämple.com",
  ])(
    "rejects invalid email %j with InvalidEmailError before hashing or touching repository",
    async (email) => {
      const { repository, passwordProvider, idProvider, service } =
        await createTestContext();

      const caught = await rejected(
        service.register({ ...input, email }, signal),
      );

      expect(caught).toBeInstanceOf(InvalidEmailError);
      expect(passwordProvider.hashCalls).toHaveLength(1);
      expect(idProvider.newUserIdCalls).toBe(0);
      expect(repository.createUserCalls).toHaveLength(0);
    },
  );

  it("maps PolicyViolationError from passwordProvider.hash to WeakPasswordError without calling repository", async () => {
    const { repository, passwordProvider, idProvider, service } =
      await createTestContext();
    const policyCause = new PolicyViolationError("too short");
    passwordProvider.onHash = () => Promise.reject(policyCause);

    const caught = await rejected(
      service.register({ ...input, rawPassword: "short" }, signal),
    );

    expect(caught).toBeInstanceOf(WeakPasswordError);
    expect(findError(caught, PolicyViolationError)).toBe(policyCause);
    expect(idProvider.newUserIdCalls).toBe(0);
    expect(repository.createUserCalls).toHaveLength(0);
  });

  it("maps PasswordBusyError from passwordProvider.hash to BusyError without calling repository", async () => {
    const { repository, passwordProvider, idProvider, service } =
      await createTestContext();
    const busyCause = new PasswordBusyError("busy");
    passwordProvider.onHash = () => Promise.reject(busyCause);

    const caught = await rejected(service.register(input, signal));

    expect(caught).toBeInstanceOf(BusyError);
    expect(findError(caught, PasswordBusyError)).toBe(busyCause);
    expect(idProvider.newUserIdCalls).toBe(0);
    expect(repository.createUserCalls).toHaveLength(0);
  });

  it("wraps unexpected error from passwordProvider.hash without WeakPasswordError or BusyError", async () => {
    const { repository, passwordProvider, idProvider, service } =
      await createTestContext();
    const paramsCause = new InvalidParamsError("invalid params");
    passwordProvider.onHash = () => Promise.reject(paramsCause);

    const caught = await rejected(service.register(input, signal));

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(WeakPasswordError);
    expect(caught).not.toBeInstanceOf(BusyError);
    expect(findError(caught, InvalidParamsError)).toBe(paramsCause);
    expect(idProvider.newUserIdCalls).toBe(0);
    expect(repository.createUserCalls).toHaveLength(0);
  });

  it("wraps error when idProvider.newUserId throws", async () => {
    const { repository, idProvider, service } = await createTestContext();
    const idError = new Error("uuid failure");
    idProvider.onNewUserId = () => {
      throw idError;
    };

    const caught = await rejected(service.register(input, signal));

    expect(caught).toBeInstanceOf(Error);
    expect(causeOf(caught)).toBe(idError);
    expect(repository.createUserCalls).toHaveLength(0);
  });

  it.each([
    ["EmailTakenError", new EmailTakenError()],
    ["BusyError", new BusyError()],
    ["unexpected Error", new Error("sqlite io error")],
  ])(
    "wraps %s from repository.createUser preserving cause",
    async (_, repoError) => {
      const { repository, service } = await createTestContext();
      repository.onCreateUser = () => Promise.reject(repoError);

      const caught = await rejected(service.register(input, signal));

      expect(caught).toBeInstanceOf(Error);
      expect(causeOf(caught)).toBe(repoError);
      if (repoError instanceof EmailTakenError) {
        expect(findError(caught, EmailTakenError)).toBe(repoError);
      }
      if (repoError instanceof BusyError) {
        expect(findError(caught, BusyError)).toBe(repoError);
      }
    },
  );
});

describe("AuthService.login", () => {
  it.each([
    ["lone surrogate", "abcdefghijkl\uD800"],
    ["over 128 code points", "a".repeat(129)],
    ["over 128 code points after NFKC expansion", "㍿".repeat(33)],
  ])(
    "throws InvalidCredentialsError immediately on Password.parse failure (%s) without querying repository or verifying",
    async (_, rawPassword) => {
      const { repository, passwordProvider, logger, service } =
        await createTestContext();

      const caught = await rejected(
        service.login({ ...input, rawPassword }, signal),
      );

      expect(caught).toBeInstanceOf(InvalidCredentialsError);
      expect(findError(caught, PolicyViolationError)).toBeInstanceOf(
        PolicyViolationError,
      );
      expect(repository.findCredentialCalls).toHaveLength(0);
      expect(passwordProvider.verifyCalls).toHaveLength(0);
      expect(logger.errorCalls).toHaveLength(0);
      expect(logger.warnCalls).toHaveLength(0);
    },
  );

  it("runs dummy verification and throws InvalidCredentialsError when email is invalid without querying repository", async () => {
    const { repository, passwordProvider, logger, service } =
      await createTestContext();

    const caught = await rejected(
      service.login({ ...input, email: "not-an-email" }, signal),
    );

    expect(caught).toBeInstanceOf(InvalidCredentialsError);
    expect(findError(caught, InvalidEmailError)).toBeInstanceOf(
      InvalidEmailError,
    );
    expect(repository.findCredentialCalls).toHaveLength(0);
    expect(passwordProvider.verifyCalls).toHaveLength(1);
    expect(passwordProvider.verifyCalls[0]?.password).toBeInstanceOf(Password);
    expect(passwordProvider.verifyCalls[0]?.encoded).toBe(
      passwordProvider.dummyHash,
    );
    expect(passwordProvider.verifyCalls[0]?.signal).toBe(signal);
    expect(logger.errorCalls).toHaveLength(0);
  });

  it("runs dummy verification and throws InvalidCredentialsError when user is not found", async () => {
    const { repository, passwordProvider, logger, service } =
      await createTestContext();
    const notFound = new UserNotFoundError();
    repository.onFindCredentialByEmail = () => Promise.reject(notFound);

    const caught = await rejected(
      service.login({ ...input, email: "  <Missing@Example.COM> " }, signal),
    );

    expect(caught).toBeInstanceOf(InvalidCredentialsError);
    expect(findError(caught, UserNotFoundError)).toBe(notFound);
    expect(repository.findCredentialCalls).toEqual([
      { emailNormalized: "missing@example.com", signal },
    ]);
    expect(passwordProvider.verifyCalls).toHaveLength(1);
    expect(passwordProvider.verifyCalls[0]?.encoded).toBe(
      passwordProvider.dummyHash,
    );
    expect(passwordProvider.verifyCalls[0]?.signal).toBe(signal);
    expect(logger.errorCalls).toHaveLength(0);
  });

  it.each([
    ["BusyError", new BusyError("sqlite busy")],
    ["unexpected Error", new Error("sqlite corrupt")],
  ])(
    "rethrows wrapped %s from findCredentialByEmail without running dummy verification",
    async (_, repoError) => {
      const { repository, passwordProvider, logger, service } =
        await createTestContext();
      repository.onFindCredentialByEmail = () => Promise.reject(repoError);

      const caught = await rejected(service.login(input, signal));

      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(InvalidCredentialsError);
      expect(causeOf(caught)).toBe(repoError);
      expect(passwordProvider.verifyCalls).toHaveLength(0);
      expect(logger.errorCalls).toHaveLength(0);
    },
  );

  it("logs error once without secret values, runs dummy verification, and throws InvalidCredentialsError when stored PHC is invalid", async () => {
    const { repository, passwordProvider, logger, service } =
      await createTestContext();
    const brokenHash = "not-a-valid-phc-secret";
    repository.credential = { userId: "user-broken", passwordHash: brokenHash };

    const caught = await rejected(service.login(input, signal));

    expect(caught).toBeInstanceOf(InvalidCredentialsError);
    const hashError = findError(caught, InvalidHashError);
    expect(hashError).toBeInstanceOf(InvalidHashError);
    expect(passwordProvider.verifyCalls).toHaveLength(1);
    expect(passwordProvider.verifyCalls[0]?.encoded).toBe(
      passwordProvider.dummyHash,
    );
    expect(passwordProvider.verifyCalls[0]?.signal).toBe(signal);
    expect(logger.errorCalls).toEqual([
      {
        message: "invalid stored password hash",
        attributes: { userId: "user-broken", error: hashError },
      },
    ]);
    const logged = inspect(logger.errorCalls, { depth: null });
    expect(logged).toContain("InvalidHashError");
    expect(logged).not.toContain(brokenHash);
    expect(logged).not.toContain(validPassword);
  });

  it.each(["invalid-email", "missing-user", "broken-phc"])(
    "maps PasswordBusyError during dummy verification (%s) to BusyError",
    async (scenario) => {
      const { repository, passwordProvider, logger, service } =
        await createTestContext();
      const busyCause = new PasswordBusyError("semaphore busy", {
        cause: new Error("request timed out"),
      });
      passwordProvider.onVerify = () => Promise.reject(busyCause);
      if (scenario === "missing-user") {
        repository.onFindCredentialByEmail = () =>
          Promise.reject(new UserNotFoundError());
      } else if (scenario === "broken-phc") {
        repository.credential = {
          userId: "user-broken",
          passwordHash: "corrupted-phc",
        };
      }
      const email =
        scenario === "invalid-email" ? "bad-email" : "user@example.com";

      const caught = await rejected(service.login({ ...input, email }, signal));

      expect(caught).toBeInstanceOf(BusyError);
      expect(caught).not.toBeInstanceOf(InvalidCredentialsError);
      expect(findError(caught, PasswordBusyError)).toBe(busyCause);
      expect(logger.errorCalls).toHaveLength(scenario === "broken-phc" ? 1 : 0);
    },
  );

  it("wraps non-busy error during dummy verification in Error without InvalidCredentialsError or BusyError", async () => {
    const { passwordProvider, service } = await createTestContext();
    const unexpected = new InvalidParamsError("unexpected verify error");
    passwordProvider.onVerify = () => Promise.reject(unexpected);

    const caught = await rejected(
      service.login({ ...input, email: "bad-email" }, signal),
    );

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(InvalidCredentialsError);
    expect(caught).not.toBeInstanceOf(BusyError);
    expect(findError(caught, InvalidParamsError)).toBe(unexpected);
  });

  it("maps PasswordBusyError from credential verify to BusyError", async () => {
    const { passwordProvider, service } = await createTestContext();
    const busyCause = new PasswordBusyError("verify timeout");
    passwordProvider.onVerify = () => Promise.reject(busyCause);

    const caught = await rejected(service.login(input, signal));

    expect(caught).toBeInstanceOf(BusyError);
    expect(findError(caught, PasswordBusyError)).toBe(busyCause);
  });

  it("wraps non-busy error from credential verify in Error", async () => {
    const { passwordProvider, service } = await createTestContext();
    const unexpected = new Error("crypto failure");
    passwordProvider.onVerify = () => Promise.reject(unexpected);

    const caught = await rejected(service.login(input, signal));

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(BusyError);
    expect(caught).not.toBeInstanceOf(InvalidCredentialsError);
    expect(causeOf(caught)).toBe(unexpected);
  });

  it("throws InvalidCredentialsError when verify returns false without checking needsRehash or rehashing", async () => {
    const { repository, passwordProvider, service } = await createTestContext();
    passwordProvider.verifyResult = false;
    passwordProvider.needsRehashResult = true;

    await expect(service.login(input, signal)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );

    expect(passwordProvider.verifyCalls).toHaveLength(1);
    expect(passwordProvider.needsRehashCalls).toHaveLength(0);
    expect(passwordProvider.rehashCalls).toHaveLength(0);
    expect(repository.updatePasswordHashCalls).toHaveLength(0);
  });

  it("returns userId without rehashing when verify returns true and needsRehash is false", async () => {
    const { repository, passwordProvider, logger, service } =
      await createTestContext();

    const result = await service.login(
      { ...input, email: "  <User@Example.COM> " },
      signal,
    );

    expect(result).toEqual({ userId: "user-1" });
    expect(repository.findCredentialCalls).toEqual([
      { emailNormalized: "user@example.com", signal },
    ]);
    expect(passwordProvider.verifyCalls).toHaveLength(1);
    expect(passwordProvider.needsRehashCalls).toHaveLength(1);
    const verifiedEncoded = passwordProvider.verifyCalls[0]?.encoded;
    expect(verifiedEncoded).toBeInstanceOf(EncodedHash);
    expect(verifiedEncoded?.phc()).toBe(storedPhc);
    expect(passwordProvider.needsRehashCalls[0]).toBe(verifiedEncoded);
    expect(passwordProvider.rehashCalls).toHaveLength(0);
    expect(repository.updatePasswordHashCalls).toHaveLength(0);
    expect(logger.warnCalls).toHaveLength(0);
    expect(logger.errorCalls).toHaveLength(0);
  });

  it.each([
    "  <Alice.Example@Example.COM>  ",
    "ALICE.EXAMPLE@EXAMPLE.COM",
    "alice.example@example.com",
  ])(
    "looks up the same normalized email that register stores for %j",
    async (email) => {
      const { repository, service } = await createTestContext();

      await service.register({ ...input, email }, signal);
      await service.login({ ...input, email }, signal);

      expect(repository.createUserCalls[0]?.user.emailNormalized).toBe(
        "alice.example@example.com",
      );
      expect(repository.findCredentialCalls[0]?.emailNormalized).toBe(
        repository.createUserCalls[0]?.user.emailNormalized,
      );
    },
  );

  it("rehashes with the same Password instance and updates stored hash when needsRehash is true", async () => {
    const { repository, passwordProvider, logger, service } =
      await createTestContext();
    passwordProvider.needsRehashResult = true;

    const result = await service.login(input, signal);

    expect(result).toEqual({ userId: "user-1" });
    expect(passwordProvider.verifyCalls).toHaveLength(1);
    expect(passwordProvider.needsRehashCalls).toHaveLength(1);
    expect(passwordProvider.rehashCalls).toHaveLength(1);
    const verified = passwordProvider.verifyCalls[0];
    expect(passwordProvider.needsRehashCalls[0]).toBe(verified?.encoded);
    expect(passwordProvider.rehashCalls[0]?.password).toBe(verified?.password);
    expect(passwordProvider.rehashCalls[0]?.signal).toBe(signal);
    expect(repository.updatePasswordHashCalls).toEqual([
      { userId: "user-1", passwordHash: rehashedPhc, signal },
    ]);
    expect(logger.warnCalls).toHaveLength(0);
    expect(logger.errorCalls).toHaveLength(0);
  });

  it.each([
    ["PasswordBusyError", new PasswordBusyError("rehash semaphore timeout")],
    ["unexpected Error", new Error("rehash failed")],
  ])(
    "logs warning and still returns userId when rehash fails with %s and signal is not aborted",
    async (_, rehashError) => {
      const { repository, passwordProvider, logger, service } =
        await createTestContext();
      passwordProvider.needsRehashResult = true;
      passwordProvider.onRehash = () => Promise.reject(rehashError);

      const result = await service.login(input, signal);

      expect(result).toEqual({ userId: "user-1" });
      expect(repository.updatePasswordHashCalls).toHaveLength(0);
      expect(logger.warnCalls).toEqual([
        {
          message: "rehash password failed",
          attributes: { userId: "user-1", error: rehashError },
        },
      ]);
    },
  );

  it.each([
    ["BusyError", new BusyError("db busy")],
    ["UserNotFoundError", new UserNotFoundError()],
    ["unexpected Error", new Error("disk full")],
  ])(
    "logs warning and still returns userId when updatePasswordHash fails with %s and signal is not aborted",
    async (_, updateError) => {
      const { repository, passwordProvider, logger, service } =
        await createTestContext();
      passwordProvider.needsRehashResult = true;
      repository.onUpdatePasswordHash = () => Promise.reject(updateError);

      const result = await service.login(input, signal);

      expect(result).toEqual({ userId: "user-1" });
      expect(repository.updatePasswordHashCalls).toHaveLength(1);
      expect(logger.warnCalls).toEqual([
        {
          message: "save rehashed password failed",
          attributes: { userId: "user-1", error: updateError },
        },
      ]);
    },
  );

  it.each([
    ["Error", new PasswordBusyError("semaphore wait timeout")],
    ["non-Error cause", new Error("outer", { cause: "non-error cause" })],
  ])(
    "logs warning when signal is aborted with a different reason than the rehash %s",
    async (_, unrelatedError) => {
      const { passwordProvider, logger, service } = await createTestContext();
      const controller = new AbortController();
      passwordProvider.needsRehashResult = true;
      passwordProvider.onRehash = () => {
        controller.abort(new Error("later abort"));
        return Promise.reject(unrelatedError);
      };

      const result = await service.login(input, controller.signal);

      expect(result).toEqual({ userId: "user-1" });
      expect(logger.warnCalls).toEqual([
        {
          message: "rehash password failed",
          attributes: { userId: "user-1", error: unrelatedError },
        },
      ]);
    },
  );

  it("logs warning when rehash error has a cyclic cause chain not containing signal.reason", async () => {
    const { passwordProvider, logger, service } = await createTestContext();
    const controller = new AbortController();
    const first = new Error("first");
    first.cause = new Error("second", { cause: first });
    passwordProvider.needsRehashResult = true;
    passwordProvider.onRehash = () => {
      controller.abort(new Error("abort reason"));
      return Promise.reject(first);
    };

    const result = await service.login(input, controller.signal);

    expect(result).toEqual({ userId: "user-1" });
    expect(logger.warnCalls).toHaveLength(1);
  });

  it.each(["direct-reason", "nested-cause", "aggregate-cause"])(
    "suppresses warning when rehash fails due to signal abort (%s)",
    async (mode) => {
      const { repository, passwordProvider, logger, service } =
        await createTestContext();
      const controller = new AbortController();
      const abortReason = new Error("client disconnected");
      passwordProvider.needsRehashResult = true;
      passwordProvider.onRehash = () => {
        controller.abort(abortReason);
        if (mode === "direct-reason") {
          return Promise.reject(abortReason);
        }
        if (mode === "nested-cause") {
          return Promise.reject(
            new PasswordBusyError("aborted", { cause: abortReason }),
          );
        }
        return Promise.reject(
          new BusyError("Update SQLite password hash failed.", {
            cause: new AggregateError(
              [new Error("SQLite error 5.")],
              "SQLite operation interrupted.",
              { cause: abortReason },
            ),
          }),
        );
      };

      const result = await service.login(input, controller.signal);

      expect(result).toEqual({ userId: "user-1" });
      expect(repository.updatePasswordHashCalls).toHaveLength(0);
      expect(logger.warnCalls).toHaveLength(0);
      expect(logger.errorCalls).toHaveLength(0);
    },
  );

  it("suppresses warning when updatePasswordHash fails due to signal abort", async () => {
    const { repository, passwordProvider, logger, service } =
      await createTestContext();
    const controller = new AbortController();
    const abortReason = new Error("deadline exceeded");
    passwordProvider.needsRehashResult = true;
    repository.onUpdatePasswordHash = () => {
      controller.abort(abortReason);
      return Promise.reject(
        new Error("update aborted", { cause: abortReason }),
      );
    };

    const result = await service.login(input, controller.signal);

    expect(result).toEqual({ userId: "user-1" });
    expect(repository.updatePasswordHashCalls).toHaveLength(1);
    expect(logger.warnCalls).toHaveLength(0);
    expect(logger.errorCalls).toHaveLength(0);
  });
});
