export function clipText(value: string, max: number): string {
  if (max <= 0) return '';
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}
