export type AuthInput = {
  readonly email: string;
  readonly rawPassword: string;
};

export type AuthResult = {
  readonly userId: string;
};
