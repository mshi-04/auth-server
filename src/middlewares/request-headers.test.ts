import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import { BadRequestError, ForbiddenError } from "../errors/index.ts";
import { validateHost, validateSameOrigin } from "./request-headers.ts";

function makeRequest(headers: IncomingHttpHeaders): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.headers = headers;
  req.destroy();
  return req;
}

describe("validateHost", () => {
  it.each([
    "127.0.0.1",
    "127.0.0.1:8080",
    "0.0.0.0:1",
    "255.255.255.255:65535",
    "localhost",
    "LOCALHOST:8080",
  ])("accepts valid Host header %s", (host) => {
    expect(() => {
      validateHost(makeRequest({ host }));
    }).not.toThrow();
  });

  it.each([
    undefined,
    "",
    "example.com",
    "localhost.localdomain",
    "127.0.0.1:0",
    "127.0.0.1:08080",
    "127.0.0.1:65536",
    "127.0.0.1:",
    "127.0.0.1:80:80",
    "127.0.1",
    "127.0.0.1.1",
    "256.0.0.1",
    "01.0.0.1",
    "[::1]:8080",
  ])(
    "rejects invalid Host header %s with BadRequestError(invalid-host)",
    (host) => {
      expect(() => {
        validateHost(makeRequest({ host }));
      }).toThrow(
        expect.objectContaining({
          name: "BadRequestError",
          kind: "invalid-host",
        }),
      );
      expect(() => {
        validateHost(makeRequest({ host }));
      }).toThrow(BadRequestError);
    },
  );
});

describe("validateSameOrigin", () => {
  it.each([
    { host: "127.0.0.1:8080" },
    { host: "127.0.0.1:8080", "sec-fetch-site": "same-origin" },
    { host: "127.0.0.1:8080", "sec-fetch-site": " none " },
    { host: "127.0.0.1:8080", "sec-fetch-site": "SAME-ORIGIN" },
    {
      host: "127.0.0.1:8080",
      origin: "http://127.0.0.1:8080",
      "sec-fetch-site": "same-origin",
    },
    {
      host: "LocalHost:8080",
      origin: "HTTP://localhost:8080",
    },
    {
      host: "127.0.0.1",
      origin: "http://127.0.0.1:80",
    },
    {
      host: "127.0.0.1:80",
      origin: "http://127.0.0.1",
    },
  ])("accepts non-browser or same-origin headers %j", (headers) => {
    expect(() => {
      validateSameOrigin(makeRequest(headers));
    }).not.toThrow();
  });

  it.each([
    { host: "127.0.0.1:8080", "sec-fetch-site": "cross-site" },
    { host: "127.0.0.1:8080", "sec-fetch-site": "same-site" },
    { host: "127.0.0.1:8080", "sec-fetch-site": "same-origin, cross-site" },
    { host: "127.0.0.1:8080", origin: "null" },
    { host: "127.0.0.1:8080", origin: "https://127.0.0.1:8080" },
    { host: "127.0.0.1:8080", origin: "http://127.0.0.1:3000" },
    { host: "127.0.0.1:8080", origin: "http://localhost:8080" },
    { host: "127.0.0.1:8080", origin: "http://example.com" },
    { host: "127.0.0.1:8080", origin: "http://127.0.0.1:8080/" },
    { host: undefined, origin: "http://127.0.0.1:8080" },
  ])("rejects cross-site headers %j with ForbiddenError", (headers) => {
    expect(() => {
      validateSameOrigin(makeRequest(headers));
    }).toThrow(ForbiddenError);
  });
});
