import * as v from 'valibot';

/** Truncate to `n` chars with a visible marker. */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;

  return s.slice(0, n) + '... [truncated]';
}

export function renderInput(instance: { input: unknown }): string {
  const text = v.safeParse(v.string(), instance.input);

  if (text.success) return text.output;

  return JSON.stringify(instance.input) ?? String(instance.input);
}
