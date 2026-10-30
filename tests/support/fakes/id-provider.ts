import type { IdProvider } from "../../../src/providers/index.ts";

export class RecordingFixedIdProvider implements IdProvider {
  userId: string;
  dummyPassword: string;
  newUserIdCalls = 0;
  newDummyPasswordCalls = 0;
  onNewUserId = (): string => this.userId;
  onNewDummyPassword = (): string => this.dummyPassword;

  constructor(userId: string, dummyPassword: string) {
    this.userId = userId;
    this.dummyPassword = dummyPassword;
  }

  newUserId(): string {
    this.newUserIdCalls++;
    return this.onNewUserId();
  }

  newDummyPassword(): string {
    this.newDummyPasswordCalls++;
    return this.onNewDummyPassword();
  }
}

export class SequentialIdProvider implements IdProvider {
  #counter = 0;
  readonly #format: (value: number) => string;
  readonly #dummyPassword: string;

  constructor(format: (value: number) => string, dummyPassword: string) {
    this.#format = format;
    this.#dummyPassword = dummyPassword;
  }

  newUserId(): string {
    this.#counter++;
    return this.#format(this.#counter);
  }

  newDummyPassword(): string {
    return this.#dummyPassword;
  }
}
