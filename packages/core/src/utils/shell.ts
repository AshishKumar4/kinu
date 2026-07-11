/** POSIX single-quote one shell argument ('…' with embedded quotes escaped). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
