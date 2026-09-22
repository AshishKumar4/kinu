/** Text helpers shared by the GEPA mutate and merge operators. */
import * as v from 'valibot';

/** Truncate to `n` chars with a visible marker. Used in prompt rendering to
 *  bound context size. */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;

  return s.slice(0, n) + '... [truncated]';
}

/** Render a generic evaluation input for a reflection prompt. */
export function renderInput(instance: { input: unknown }): string {
  const text = v.safeParse(v.string(), instance.input);

  if (text.success) return text.output;

  return JSON.stringify(instance.input) ?? String(instance.input);
}
