import { describe, expect, expectTypeOf, it } from "vitest";
import {
  causeChain,
  findError,
  hasCode,
  isAbortedBy,
  isCausedBy,
} from "./find-error.ts";

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

describe("isCausedBy", () => {
  it("matches the root value itself", () => {
    const reason = new Error("aborted");

    expect(isCausedBy(reason, reason)).toBe(true);
  });

  it("matches a reason through nested causes", () => {
    const reason = new Error("aborted");
    const error = new Error("outer", {
      cause: new Error("inner", { cause: reason }),
    });

    expect(isCausedBy(error, reason)).toBe(true);
  });

  it.each([
    { name: "string", value: "client disconnected" },
    { name: "number", value: 0 },
    { name: "null", value: null },
    { name: "plain object", value: { reason: "timeout" } },
  ])(
    "matches a non-Error reason at the end of the chain: $name",
    ({ value }) => {
      expect(isCausedBy(new Error("outer", { cause: value }), value)).toBe(
        true,
      );
    },
  );

  it("matches NaN by identity", () => {
    expect(
      isCausedBy(new Error("outer", { cause: Number.NaN }), Number.NaN),
    ).toBe(true);
  });

  it("does not match an equal but different error", () => {
    const reason = new Error("aborted");
    const error = new Error("outer", { cause: new Error("aborted") });

    expect(isCausedBy(error, reason)).toBe(false);
  });

  it("does not look inside non-Error causes", () => {
    const reason = new Error("aborted");
    const error = new Error("outer", { cause: { cause: reason } });

    expect(isCausedBy(error, reason)).toBe(false);
  });

  it("does not look inside AggregateError members", () => {
    const reason = new Error("aborted");
    const error = new AggregateError([reason], "many");

    expect(isCausedBy(error, reason)).toBe(false);
  });

  it("never matches undefined", () => {
    expect(isCausedBy(new Error("outer"), undefined)).toBe(false);
    expect(isCausedBy(undefined, undefined)).toBe(false);
  });

  it("terminates on a cycle that does not contain the reason", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    first.cause = second;

    expect(isCausedBy(first, new Error("reason"))).toBe(false);
  });
});

describe("isAbortedBy", () => {
  it("matches the abort reason itself when the signal is aborted", () => {
    const reason = new Error("aborted");
    const signal = AbortSignal.abort(reason);

    expect(isAbortedBy(reason, signal)).toBe(true);
  });

  it("matches the abort reason through nested causes", () => {
    const reason = new Error("aborted");
    const signal = AbortSignal.abort(reason);
    const error = new Error("outer", {
      cause: new Error("inner", { cause: reason }),
    });

    expect(isAbortedBy(error, signal)).toBe(true);
  });

  it("returns false when the signal is not aborted", () => {
    const controller = new AbortController();

    expect(isAbortedBy(controller.signal.reason, controller.signal)).toBe(
      false,
    );
    expect(isAbortedBy(new Error("failure"), controller.signal)).toBe(false);
  });

  it("returns false when the signal was aborted with a different reason", () => {
    const signal = AbortSignal.abort(new Error("aborted"));
    const error = new Error("outer", { cause: new Error("aborted") });

    expect(isAbortedBy(error, signal)).toBe(false);
  });
});

describe("causeChain", () => {
  it("yields each error from the outermost and stops at a cycle", () => {
    const inner = new Error("inner");
    const middle = new Error("middle", { cause: inner });
    const outer = new Error("outer", { cause: middle });
    inner.cause = middle;
    expect([...causeChain(outer)]).toEqual([outer, middle, inner]);
  });

  it("yields a non-Error value once without following it", () => {
    expect([...causeChain("reason")]).toEqual(["reason"]);
    expect([...causeChain(undefined)]).toEqual([]);
  });
});

describe("hasCode", () => {
  it("matches an Error with the expected code", () => {
    expect(hasCode(new ExpectedError("expected"), "EXPECTED")).toBe(true);
  });

  it("rejects an Error without code or with a different code", () => {
    expect(hasCode(new Error("plain"), "EXPECTED")).toBe(false);
    expect(hasCode(new ExpectedError("expected"), "OTHER")).toBe(false);
  });

  it("rejects non-Error values even when they have a code property", () => {
    expect(hasCode({ code: "EXPECTED" }, "EXPECTED")).toBe(false);
    expect(hasCode(undefined, "EXPECTED")).toBe(false);
  });
});
