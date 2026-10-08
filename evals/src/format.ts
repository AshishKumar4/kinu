// How the eval reports write a number: one spelling for every table that shows it.

/** A typographic minus for a fall, a plus for a rise, nothing for no change. */
export function sign(value: number): string {
  if (value === 0) return '';

  return value > 0 ? '+' : '\u2212';
}

export function signed(value: number, digits: number, unit = ''): string {
  return `${sign(value)}${Math.abs(value).toFixed(digits)}${unit}`;
}

export function tokens(count: number): string {
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`;

  return count >= 1e3 ? `${(count / 1e3).toFixed(0)}k` : count.toFixed(0);
}

export function usd(cost: number | null): string {
  return cost === null ? '\u2014' : `$${cost.toFixed(4)}`;
}

export function rate(hit: number | null): string {
  return hit === null ? '\u2014' : `${(hit * 100).toFixed(1)}%`;
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
