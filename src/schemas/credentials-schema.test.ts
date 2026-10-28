import { describe, expect, it } from "vitest";
import { BadRequestError } from "../errors/index.ts";
import { parseCredentials } from "./index.ts";

describe("parseCredentials", () => {
  it.each([
    undefined,
    null,
    true,
    123,
    "credentials",
    [],
    ["email", "password"],
    {},
    { email: "user@example.com" },
    { password: "password" },
    { email: null, password: "password" },
    { email: "user@example.com", password: null },
    { email: 123, password: "password" },
    { email: "user@example.com", password: false },
    { Email: "user@example.com", password: "password" },
    { email: "user@example.com", Password: "password" },
    { email: "user@example.com", password: "password", extra: true },
  ])("rejects invalid structure %j", (value) => {
    expect(() => parseCredentials(value)).toThrow(BadRequestError);
  });

  it.each([
    { email: "user@example.com", password: "correct horse battery staple" },
    { email: "", password: "" },
    { email: "not an email", password: "short" },
    { email: "\ud800", password: "\ud800" },
  ])("leaves semantic validation to the service for %j", (value) => {
    expect(parseCredentials(value)).toEqual(value);
  });

  it("copies only the request fields", () => {
    const input = { email: "user@example.com", password: "password" };
    const result = parseCredentials(input);
    expect(result).not.toBe(input);
    input.password = "changed";
    expect(result.password).toBe("password");
  });
});
