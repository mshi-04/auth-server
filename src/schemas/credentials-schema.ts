import { BadRequestError } from "../errors/index.ts";

export interface CredentialsRequest {
  readonly email: string;
  readonly password: string;
}

export function parseCredentials(value: unknown): CredentialsRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("email" in value) ||
    !("password" in value) ||
    typeof value.email !== "string" ||
    typeof value.password !== "string" ||
    Object.keys(value).some((key) => key !== "email" && key !== "password")
  ) {
    throw new BadRequestError("invalid-input");
  }
  return { email: value.email, password: value.password };
}
