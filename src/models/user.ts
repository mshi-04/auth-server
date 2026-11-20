export type NewUser = {
  readonly id: string;
  readonly email: string;
  readonly emailNormalized: string;
  readonly passwordHash: string;
};
