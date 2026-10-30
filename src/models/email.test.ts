import { describe, expect, it } from "vitest";
import { caught } from "../../tests/support/errors.ts";
import { InvalidEmailError } from "../errors/index.ts";
import { normalizeEmail, parseEmail } from "./index.ts";

interface ValidEmailCase {
  name: string;
  input: string;
  parsed: string;
  normalized: string;
}

const validEmailCases: ValidEmailCase[] = [
  {
    name: "simple address",
    input: "a@example.com",
    parsed: "a@example.com",
    normalized: "a@example.com",
  },
  {
    name: "preserves case in parseEmail and lowercases in normalizeEmail",
    input: "Person@EXAMPLE.COM",
    parsed: "Person@EXAMPLE.COM",
    normalized: "person@example.com",
  },
  {
    name: "angle-bracketed address",
    input: "<Person@EXAMPLE.COM>",
    parsed: "Person@EXAMPLE.COM",
    normalized: "person@example.com",
  },
  {
    name: "leading and trailing spaces",
    input: "  Person@EXAMPLE.COM  ",
    parsed: "Person@EXAMPLE.COM",
    normalized: "person@example.com",
  },
  {
    name: "whitespace around angle brackets",
    input: " \t\n<Person@EXAMPLE.COM>\r\n ",
    parsed: "Person@EXAMPLE.COM",
    normalized: "person@example.com",
  },
  {
    name: "multi-label local part and domain",
    input: "first.middle.last@sub.domain.example.com",
    parsed: "first.middle.last@sub.domain.example.com",
    normalized: "first.middle.last@sub.domain.example.com",
  },
  {
    name: "single-label domain",
    input: "user@localhost",
    parsed: "user@localhost",
    normalized: "user@localhost",
  },
  {
    name: "all RFC 5322 atext characters",
    input:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&'*+-/=?^_`{|}~@A-Z.a-z.0-9.!#$%&'*+-/=?^_`{|}~",
    parsed:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&'*+-/=?^_`{|}~@A-Z.a-z.0-9.!#$%&'*+-/=?^_`{|}~",
    normalized:
      "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz0123456789!#$%&'*+-/=?^_`{|}~@a-z.a-z.0-9.!#$%&'*+-/=?^_`{|}~",
  },
];

interface InvalidEmailCase {
  name: string;
  input: string;
}

const invalidEmailCases: InvalidEmailCase[] = [
  { name: "empty string", input: "" },
  { name: "whitespace only", input: "   " },
  { name: "empty angle brackets", input: "<>" },
  {
    name: "leading whitespace inside angle brackets",
    input: "< a@example.com>",
  },
  {
    name: "trailing whitespace inside angle brackets",
    input: "<a@example.com >",
  },
  { name: "unclosed opening angle bracket", input: "<a@example.com" },
  { name: "unmatched closing angle bracket", input: "a@example.com>" },
  { name: "double angle brackets", input: "<<a@example.com>>" },
  { name: "missing @", input: "a.example.com" },
  { name: "missing local part", input: "@example.com" },
  { name: "missing domain", input: "a@" },
  { name: "multiple @ characters", input: "a@b@example.com" },
  { name: "leading dot in local part", input: ".a@example.com" },
  { name: "trailing dot in local part", input: "a.@example.com" },
  { name: "consecutive dots in local part", input: "a..b@example.com" },
  { name: "leading dot in domain", input: "a@.example.com" },
  { name: "trailing dot in domain", input: "a@example.com." },
  { name: "consecutive dots in domain", input: "a@ex..ample.com" },
  { name: "unquoted display name", input: "Person <person@example.com>" },
  { name: "quoted display name", input: '"Name" <a@example.com>' },
  { name: "address list", input: "a@example.com,b@example.com" },
  { name: "group syntax", input: "Group: a@example.com;" },
  { name: "trailing comment", input: "a@example.com ()" },
  { name: "leading comment", input: "(comment)a@example.com" },
  { name: "quoted local part", input: '"a b"@example.com' },
  { name: "domain literal", input: "a@[192.0.2.1]" },
  { name: "trailing text", input: "a@example.com extra" },
  { name: "non-ASCII in local part", input: "üser@example.com" },
  { name: "non-ASCII in domain", input: "a@例え.テスト" },
  { name: "fullwidth ASCII character", input: "ａ@example.com" },
  { name: "Kelvin sign (U+212A)", input: "\u212a@example.com" },
  { name: "lone surrogate", input: "\ud800@example.com" },
];

function expectInvalidEmail(fn: () => string, rawInput: string): void {
  const error = caught(fn);
  expect(error).toBeInstanceOf(InvalidEmailError);
  if (error instanceof InvalidEmailError) {
    expect(error.message).toBe("Invalid email address.");
    const trimmed = rawInput.trim();
    if (trimmed !== "") {
      expect(error.message).not.toContain(trimmed);
    }
  }
}

describe("parseEmail and normalizeEmail", () => {
  describe("valid email addresses", () => {
    it.each(validEmailCases)(
      "accepts $name",
      ({ input, parsed, normalized }) => {
        expect(parseEmail(input)).toBe(parsed);
        expect(normalizeEmail(input)).toBe(normalized);
      },
    );
  });

  describe("invalid email addresses", () => {
    it.each(invalidEmailCases)("rejects $name", ({ input }) => {
      expectInvalidEmail(() => parseEmail(input), input);
      expectInvalidEmail(() => normalizeEmail(input), input);
    });
  });
});
