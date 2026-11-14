import type { IncomingMessage } from "node:http";
import { isIPv4 } from "node:net";
import { BadRequestError, ForbiddenError } from "../errors/index.ts";

export type RequestHost = {
  readonly hostname: string;
  readonly port: string;
};

function parseHost(value: string | undefined): RequestHost | undefined {
  if (value === undefined) {
    return undefined;
  }
  const colonIndex = value.indexOf(":");
  if (colonIndex !== -1 && colonIndex !== value.lastIndexOf(":")) {
    return undefined;
  }
  const hostname = colonIndex === -1 ? value : value.slice(0, colonIndex);
  const port = colonIndex === -1 ? "80" : value.slice(colonIndex + 1);
  if (
    colonIndex !== -1 &&
    (!/^[1-9][0-9]{0,4}$/u.test(port) || Number(port) > 65535)
  ) {
    return undefined;
  }
  const normalizedHost = hostname.toLowerCase();
  if (normalizedHost !== "localhost" && !isIPv4(normalizedHost)) {
    return undefined;
  }
  return { hostname: normalizedHost, port };
}

function targetAuthority(target: string | undefined): string | undefined {
  return target?.split("?", 1)[0]?.match(/^https?:\/\/([^/]*)/iu)?.[1];
}

export function validateHost(req: IncomingMessage): RequestHost {
  const headerHost = parseHost(req.headers.host);
  if (headerHost === undefined) {
    throw new BadRequestError("invalid-host");
  }
  const authority = targetAuthority(req.url);
  if (authority === undefined) {
    return headerHost;
  }
  const targetHost = parseHost(authority);
  if (targetHost === undefined) {
    throw new BadRequestError("invalid-host");
  }
  return targetHost;
}

export function validateSameOrigin(
  req: IncomingMessage,
  requestHost: RequestHost,
): void {
  const secFetchSite = req.headers["sec-fetch-site"];
  if (secFetchSite !== undefined) {
    const normalizedSite = secFetchSite.trim().toLowerCase();
    if (normalizedSite !== "same-origin" && normalizedSite !== "none") {
      throw new ForbiddenError();
    }
  }

  const origin = req.headers.origin;
  if (origin !== undefined) {
    const originHost = parseHost(
      /^http:\/\/([^/?#@\s]+)$/iu.exec(origin.trim())?.[1],
    );
    if (
      originHost === undefined ||
      originHost.hostname !== requestHost.hostname ||
      originHost.port !== requestHost.port
    ) {
      throw new ForbiddenError();
    }
  }
}
