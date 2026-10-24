export function findError<T extends Error>(
  error: unknown,
  errorType: abstract new (...args: never[]) => T,
): T | undefined {
  const seen = new Set<Error>();
  let current = error;

  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof errorType) {
      return current;
    }
    seen.add(current);
    current = current.cause;
  }

  return undefined;
}
