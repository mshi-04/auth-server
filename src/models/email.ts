import { InvalidEmailError } from "../errors/index.ts";

const atextAtomPattern = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;

function isDotAtom(part: string): boolean {
  if (part === "") {
    return false;
  }
  return part.split(".").every((atom) => atextAtomPattern.test(atom));
}

export function parseEmail(email: string): string {
  const trimmed = email.trim();
  const address =
    trimmed.startsWith("<") && trimmed.endsWith(">")
      ? trimmed.slice(1, -1)
      : trimmed;
  const atIndex = address.indexOf("@");
  if (atIndex <= 0 || address.indexOf("@", atIndex + 1) !== -1) {
    throw new InvalidEmailError();
  }
  const local = address.slice(0, atIndex);
  const domain = address.slice(atIndex + 1);
  if (!isDotAtom(local) || !isDotAtom(domain)) {
    throw new InvalidEmailError();
  }
  return address;
}

export function normalizeEmail(email: string): string {
  return parseEmail(email).toLowerCase();
}
