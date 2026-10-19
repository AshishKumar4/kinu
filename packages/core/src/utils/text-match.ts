/**
 * Text matched in SQL as a Durable Object's SQLite runs it: by `instr` over `lower()`, never a LIKE or GLOB pattern, which
 * that SQLite refuses whole past a few dozen bytes (`PLATFORM_CATALOG['do.sqlite.like_pattern_bytes']`), so a search
 * worded longer than that answered an error instead of its matches. ASCII letters match in either case, as LIKE's did, and every other
 * character is itself, never a wildcard. The fragment binds the text once, as its one `?`; a tagged `sql` query spells
 * the same expression with the text as its value (`= 1` for a prefix).
 */

/** `column` holds the bound text anywhere. */
export function textContains(column: string): string {
  return `instr(lower(${column}), lower(?)) > 0`;
}
