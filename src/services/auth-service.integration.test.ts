import { describe, expect, it } from "vitest";
import { rejected } from "../../tests/support/errors.ts";
import { SequentialIdProvider } from "../../tests/support/fakes/id-provider.ts";
import { RecordingLogger } from "../../tests/support/fakes/logger.ts";
import { InMemoryUserRepository } from "../../tests/support/fakes/user-repository.ts";
import {
  BusyError,
  EmailTakenError,
  InvalidCredentialsError,
  PasswordBusyError,
  WeakPasswordError,
  findError,
} from "../errors/index.ts";
import { EncodedHash, Password } from "../models/index.ts";
import type { Params } from "../models/index.ts";
import type { PasswordProvider } from "../providers/index.ts";
import {
  Argon2PasswordProvider,
  defaultParams,
} from "../providers/password/index.ts";
import { AuthService } from "./index.ts";

function smallParams(): Params {
  return { ...defaultParams(), memoryKiB: 64, iterations: 1, parallelism: 1 };
}

function createIntegrationIds() {
  return new SequentialIdProvider(
    (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`,
    "dummy-password-for-integration-test",
  );
}

async function createIntegrationSetup(
  passwordProvider: PasswordProvider = Argon2PasswordProvider.create(
    smallParams(),
  ),
) {
  const repository = new InMemoryUserRepository();
  const idProvider = createIntegrationIds();
  const logger = new RecordingLogger();
  const signal = new AbortController().signal;
  const service = await AuthService.create(
    repository,
    passwordProvider,
    idProvider,
    logger,
    signal,
  );
  return { repository, passwordProvider, idProvider, logger, signal, service };
}

describe("AuthService integration with Argon2PasswordProvider", () => {
  it.each([
    ["minimum 12 ASCII chars", "a".repeat(12), "a".repeat(12)],
    ["maximum 128 ASCII chars", "b".repeat(128), "b".repeat(128)],
    ["12 emoji code points", "😀".repeat(12), "😀".repeat(12)],
    ["NFKC fullwidth to ASCII", "ａｂｃｄｅｆｇｈｉｊｋｌ", "abcdefghijkl"],
    ["NFKC expansion 3x ㍿ to 12 chars", "㍿".repeat(3), "株式会社".repeat(3)],
    [
      "combining characters to precomposed",
      "e\u0301".repeat(12),
      "é".repeat(12),
    ],
  ])(
    "registers and logs in with %s",
    async (_, registerPassword, loginPassword) => {
      const { repository, passwordProvider, signal, service } =
        await createIntegrationSetup();

      const registered = await service.register(
        {
          email: "  <User.Name@Example.COM> ",
          rawPassword: registerPassword,
        },
        signal,
      );

      const stored = repository.usersById.get(registered.userId);
      expect(stored?.email).toBe("User.Name@Example.COM");
      expect(stored?.emailNormalized).toBe("user.name@example.com");
      expect(
        passwordProvider.needsRehash(
          EncodedHash.parse(stored?.passwordHash ?? ""),
        ),
      ).toBe(false);

      const loggedIn = await service.login(
        {
          email: "user.name@example.com",
          rawPassword: loginPassword,
        },
        signal,
      );
      expect(loggedIn).toEqual({ userId: registered.userId });

      await expect(
        service.login(
          {
            email: "user.name@example.com",
            rawPassword: "wrong-password-123",
          },
          signal,
        ),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    },
  );

  it("rejects a second registration of the same normalized email and keeps the first user", async () => {
    const { repository, signal, service } = await createIntegrationSetup();
    const first = await service.register(
      { email: "dup@example.com", rawPassword: "correct horse battery staple" },
      signal,
    );
    const firstPhc = repository.usersById.get(first.userId)?.passwordHash;

    const caught = await rejected(
      service.register(
        {
          email: "<DUP@Example.com>",
          rawPassword: "another password entirely",
        },
        signal,
      ),
    );

    expect(findError(caught, EmailTakenError)).toBeInstanceOf(EmailTakenError);
    expect(repository.usersById.size).toBe(1);
    expect(repository.usersById.get(first.userId)?.passwordHash).toBe(firstPhc);
    await expect(
      service.login(
        {
          email: "dup@example.com",
          rawPassword: "correct horse battery staple",
        },
        signal,
      ),
    ).resolves.toEqual(first);
  });

  it.each(["", "a".repeat(11), "😀".repeat(11), "㍿".repeat(2)])(
    "rejects password shorter than 12 normalized code points in register: %j",
    async (shortPassword) => {
      const { repository, signal, service } = await createIntegrationSetup();

      await expect(
        service.register(
          { email: "user@example.com", rawPassword: shortPassword },
          signal,
        ),
      ).rejects.toBeInstanceOf(WeakPasswordError);
      expect(repository.usersById.size).toBe(0);
    },
  );

  it.each(["short", ""])(
    "verifies and rehashes legacy credential with short password %j on login",
    async (legacyRawPassword) => {
      const legacyProvider = Argon2PasswordProvider.create({
        ...smallParams(),
        memoryKiB: 32,
      });
      const currentProvider = Argon2PasswordProvider.create(smallParams());
      const { repository, logger, signal, service } =
        await createIntegrationSetup(currentProvider);

      const legacyEncoded = await legacyProvider.rehash(
        Password.parse(legacyRawPassword),
        signal,
      );
      await repository.createUser(
        {
          id: "legacy-user",
          email: "legacy@example.com",
          emailNormalized: "legacy@example.com",
          passwordHash: legacyEncoded.phc(),
        },
        signal,
      );

      const result = await service.login(
        { email: "legacy@example.com", rawPassword: legacyRawPassword },
        signal,
      );
      expect(result).toEqual({ userId: "legacy-user" });

      const updatedPhc =
        repository.usersById.get("legacy-user")?.passwordHash ?? "";
      expect(updatedPhc).not.toBe(legacyEncoded.phc());
      expect(currentProvider.needsRehash(EncodedHash.parse(updatedPhc))).toBe(
        false,
      );
      expect(logger.warnCalls).toHaveLength(0);
      expect(logger.errorCalls).toHaveLength(0);
    },
  );

  it("rehashes non-canonical PHC order to canonical PHC on login and does not rehash when password is wrong", async () => {
    const currentProvider = Argon2PasswordProvider.create(smallParams());
    const { repository, signal, service } =
      await createIntegrationSetup(currentProvider);
    const rawPassword = "correct horse battery staple";
    const canonicalPhc = (
      await currentProvider.hash(Password.parse(rawPassword), signal)
    ).phc();
    const nonCanonicalPhc = canonicalPhc.replace(
      "m=64,t=1,p=1",
      "p=1,m=64,t=1",
    );

    await repository.createUser(
      {
        id: "user-noncanonical",
        email: "canon@example.com",
        emailNormalized: "canon@example.com",
        passwordHash: nonCanonicalPhc,
      },
      signal,
    );

    await expect(
      service.login(
        { email: "canon@example.com", rawPassword: "wrong-password-123" },
        signal,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(repository.usersById.get("user-noncanonical")?.passwordHash).toBe(
      nonCanonicalPhc,
    );

    const result = await service.login(
      { email: "canon@example.com", rawPassword },
      signal,
    );
    expect(result).toEqual({ userId: "user-noncanonical" });

    const updatedPhc =
      repository.usersById.get("user-noncanonical")?.passwordHash ?? "";
    expect(updatedPhc).toContain("$argon2id$v=19$m=64,t=1,p=1$");
    expect(currentProvider.needsRehash(EncodedHash.parse(updatedPhc))).toBe(
      false,
    );
  });

  it("propagates BusyError with signal.reason when AbortSignal is already aborted in create, register, and login", async () => {
    const provider = Argon2PasswordProvider.create(smallParams());
    const repository = new InMemoryUserRepository();
    const idProvider = createIntegrationIds();
    const logger = new RecordingLogger();

    const abortReason = new Error("request cancelled");
    const abortedController = new AbortController();
    abortedController.abort(abortReason);

    const createError = await rejected(
      AuthService.create(
        repository,
        provider,
        idProvider,
        logger,
        abortedController.signal,
      ),
    );
    expect(createError).toBeInstanceOf(BusyError);
    expect(findError(createError, PasswordBusyError)?.cause).toBe(abortReason);

    const { service } = await createIntegrationSetup(provider);

    const registerError = await rejected(
      service.register(
        {
          email: "user@example.com",
          rawPassword: "correct horse battery staple",
        },
        abortedController.signal,
      ),
    );
    expect(registerError).toBeInstanceOf(BusyError);
    expect(findError(registerError, PasswordBusyError)?.cause).toBe(
      abortReason,
    );

    const loginDummyError = await rejected(
      service.login(
        {
          email: "not-an-email",
          rawPassword: "correct horse battery staple",
        },
        abortedController.signal,
      ),
    );
    expect(loginDummyError).toBeInstanceOf(BusyError);
    expect(findError(loginDummyError, PasswordBusyError)?.cause).toBe(
      abortReason,
    );
  });
});
