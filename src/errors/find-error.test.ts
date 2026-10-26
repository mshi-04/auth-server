import { describe, expect, expectTypeOf, it } from "vitest";
import { findError } from "./find-error.ts";

class ExpectedError extends Error {
  override name = "ExpectedError";
  readonly code = "EXPECTED";
}

describe("findError", () => {
  it("returns the original matching error with its subclass type", () => {
    const error = new ExpectedError("expected");
    const found = findError(error, ExpectedError);

    expect(found).toBe(error);
    expectTypeOf(found).toEqualTypeOf<ExpectedError | undefined>();
  });

  it("finds a matching error through nested causes", () => {
    const cause = new ExpectedError("expected");
    const error = new Error("outer", {
      cause: new Error("inner", { cause }),
    });

    expect(findError(error, ExpectedError)).toBe(cause);
  });

  it("finds native Error subclasses", () => {
    const cause = new TypeError("invalid type");

    expect(findError(new Error("outer", { cause }), TypeError)).toBe(cause);
  });

  it("returns the nearest match when multiple causes match", () => {
    const error = new ExpectedError("outer", {
      cause: new ExpectedError("inner"),
    });

    expect(findError(error, ExpectedError)).toBe(error);
  });

  it("returns undefined when the cause chain has no matching class", () => {
    const error = new Error("outer", { cause: new TypeError("inner") });

    expect(findError(error, ExpectedError)).toBeUndefined();
  });

  it("does not match an unrelated error with the same name", () => {
    const error = new Error("unrelated");
    error.name = "ExpectedError";

    expect(findError(error, ExpectedError)).toBeUndefined();
  });

  const nonErrors = [
    { name: "undefined", value: undefined },
    { name: "null", value: null },
    { name: "string", value: "failure" },
    { name: "number", value: 42 },
    { name: "boolean", value: false },
    { name: "object", value: { cause: new ExpectedError("hidden") } },
  ];

  it.each(nonErrors)("ignores a non-Error root: $name", ({ value }) => {
    expect(findError(value, ExpectedError)).toBeUndefined();
  });

  it.each(nonErrors)("stops at a non-Error cause: $name", ({ value }) => {
    const error = new Error("outer", { cause: value });

    expect(findError(error, ExpectedError)).toBeUndefined();
  });

  it("terminates when an error is its own cause", () => {
    const error = new Error("cycle");
    error.cause = error;

    expect(findError(error, ExpectedError)).toBeUndefined();
  });

  it("terminates when multiple errors form a cycle", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    first.cause = second;

    expect(findError(first, ExpectedError)).toBeUndefined();
  });

  it("finds a matching error before a cycle repeats", () => {
    const error = new Error("outer");
    const cause = new ExpectedError("expected", { cause: error });
    error.cause = cause;

    expect(findError(error, ExpectedError)).toBe(cause);
  });
});
