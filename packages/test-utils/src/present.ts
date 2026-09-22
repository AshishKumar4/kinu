/** The value a test expects to exist, narrowed, or a failure naming what was absent. */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`${what} is absent`);

  return value;
}
