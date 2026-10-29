import { describe, expect, it } from "vitest";
import {
  BadRequestError,
  MethodNotAllowedError,
  NotFoundError,
  PayloadTooLargeError,
} from "./index.ts";

describe("request errors", () => {
  it("retains request failure categories and causes", () => {
    const cause = new Error("transport failure");
    const error = new BadRequestError("read-failed", { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BadRequestError");
    expect(error.kind).toBe("read-failed");
    expect(error.cause).toBe(cause);
    expect(new BadRequestError().kind).toBe("invalid-input");
  });
  it("copies the allow list instead of retaining mutable input", () => {
    const methods = ["GET", "HEAD"];
    const cause = new Error("route mismatch");
    const error = new MethodNotAllowedError(methods, { cause });
    methods.push("POST");
    expect(error.allowedMethods).toEqual(["GET", "HEAD"]);
    expect(error.cause).toBe(cause);
    expect(error.name).toBe("MethodNotAllowedError");
  });
  it.each([new NotFoundError(), new PayloadTooLargeError()])(
    "does not attach HTTP status to $name",
    (error) => {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty("status");
    },
  );
});
