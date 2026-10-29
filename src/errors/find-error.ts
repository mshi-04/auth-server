export function* causeChain(error: unknown): Generator {
  const seen = new Set<unknown>();
  let current = error;

  while (current !== undefined && !seen.has(current)) {
    yield current;
    seen.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }
}

export function findError<T extends Error>(
  error: unknown,
  errorType: abstract new (...args: never[]) => T,
): T | undefined {
  for (const current of causeChain(error)) {
    if (current instanceof errorType) {
      return current;
    }
  }

  return undefined;
}

export function isCausedBy(error: unknown, reason: unknown): boolean {
  for (const current of causeChain(error)) {
    if (Object.is(current, reason)) {
      return true;
    }
  }

  return false;
}
