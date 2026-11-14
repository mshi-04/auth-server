import type { IncomingMessage } from "node:http";
import { BadRequestError, ForbiddenError } from "../errors/index.ts";

function isIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every(
    (part) => /^(?:0|[1-9][0-9]{0,2})$/u.test(part) && Number(part) <= 255,
  );
}

function parseHost(
  value: string | undefined,
): { readonly hostname: string; readonly port: string } | null {
  if (value === undefined) {
    return null;
  }
  const colonIndex = value.indexOf(":");
  if (colonIndex !== -1 && colonIndex !== value.lastIndexOf(":")) {
    return null;
  }
  const hostname = colonIndex === -1 ? value : value.slice(0, colonIndex);
  const port = colonIndex === -1 ? "80" : value.slice(colonIndex + 1);
  if (
    colonIndex !== -1 &&
    (!/^[1-9][0-9]{0,4}$/u.test(port) || Number(port) > 65535)
  ) {
    return null;
  }
  const normalizedHost = hostname.toLowerCase();
  if (normalizedHost !== "localhost" && !isIpv4(normalizedHost)) {
    return null;
  }
  return { hostname: normalizedHost, port };
}

export function validateHost(req: IncomingMessage): void {
  if (parseHost(req.headers.host) === null) {
    throw new BadRequestError("invalid-host");
  }
}

export function validateSameOrigin(req: IncomingMessage): void {
  const secFetchSite = req.headers["sec-fetch-site"];
  if (secFetchSite !== undefined) {
    const normalizedSite = secFetchSite.trim().toLowerCase();
    if (normalizedSite !== "same-origin" && normalizedSite !== "none") {
      throw new ForbiddenError();
    }
  }

  const origin = req.headers.origin;
  if (origin !== undefined) {
    const requestHost = parseHost(req.headers.host);
    const match = /^http:\/\/([^/?#@\s]+)$/iu.exec(origin.trim());
    const originHost = match?.[1] === undefined ? null : parseHost(match[1]);
    if (
      requestHost === null ||
      originHost === null ||
      originHost.hostname !== requestHost.hostname ||
      originHost.port !== requestHost.port
    ) {
      throw new ForbiddenError();
    }
  }
}
