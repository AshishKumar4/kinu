import { statementText } from './sql';

/** The table a statement writes, and how: the first write keyword names it (SQLite writes one table a statement). */
export const WRITE = /\b(INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?(\w+)/i;

const TABLES = new WeakMap<TemplateStringsArray, string | null>();

function writtenTable(query: string): string | null {
  return WRITE.exec(query)?.[2]?.toLowerCase() ?? null;
}

function tableOf(strings: TemplateStringsArray): string | null {
  const known = TABLES.get(strings);

  if (known !== undefined) return known;
  const table = writtenTable(statementText(strings));

  TABLES.set(strings, table);

  return table;
}

/** How a store reads what it may hold: through a Durable Object's {@link HeldReads}, or {@link ASKED}. */
export interface Holds {
  hold<T>(tables: readonly string[], read: () => T): () => T;
  holdEach<K, T>(tables: readonly string[], read: (key: K) => T): (key: K) => T;
}

/** A database other processes also write (the CLI's file): every read asks. */
export const ASKED: Holds = {
  hold: (_tables, read) => read,
  holdEach: (_tables, read) => read,
};

/**
 * Reads a Durable Object holds between its own statements. The object is its database's one writer and passes every
 * statement to {@link written} before it runs, so a held read is dropped by the statement that writes a table it reads,
 * whichever store wrote it. A read taken inside a transaction that then rolls back would be held past the rollback:
 * nothing holds a read inside a transaction.
 */
export class HeldReads implements Holds {
  private readonly drops = new Map<string, Array<() => void>>();

  /** `read` once, and again only after a statement writes one of `tables`, every table `read` selects from. */
  hold<T>(tables: readonly string[], read: () => T): () => T {
    let held: { readonly value: T } | null = null;

    this.dropOn(tables, () => { held = null; });

    return () => (held ??= { value: read() }).value;
  }

  /** {@link hold}, one value per key. */
  holdEach<K, T>(tables: readonly string[], read: (key: K) => T): (key: K) => T {
    const held = new Map<K, { readonly value: T }>();

    this.dropOn(tables, () => { held.clear(); });

    return (key) => {
      const known = held.get(key);

      if (known !== undefined) return known.value;
      const value = read(key);

      held.set(key, { value });

      return value;
    };
  }

  /** Before `query` runs: a statement that throws may still have written. A tagged statement's text is parsed once. */
  written(query: string | TemplateStringsArray): void {
    const table = typeof query === 'string' ? writtenTable(query) : tableOf(query);

    if (table === null) return;

    for (const drop of this.drops.get(table) ?? []) drop();
  }

  private dropOn(tables: readonly string[], drop: () => void): void {
    for (const table of tables) this.drops.set(table, [...this.drops.get(table) ?? [], drop]);
  }
}
