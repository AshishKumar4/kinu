/**
 * The value a test expects to exist, narrowed, or a failure naming what was absent.
 *
 * `rows[0]` and `map.get(id)` type as possibly absent, and a test that then reads
 * `.field` needs the narrowing. A non-null assertion supplies it silently and turns
 * an absent value into a `TypeError` somewhere below; this names the absence at
 * the point the test asserted it.
 */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`${what} is absent`);

  return value;
}
