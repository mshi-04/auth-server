export function validateRequest<T>(
  value: unknown,
  parse: (value: unknown) => T,
): T {
  return parse(value);
}
