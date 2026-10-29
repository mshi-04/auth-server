export interface IdProvider {
  newUserId(): string;
  newDummyPassword(): string;
}
