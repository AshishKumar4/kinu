/**
 * What `bun scripts/ast-duplication.ts` reports, and what `--lock` may write.
 *
 * Detection is driven over small in-memory sources. The lock half treats the
 * lock as a ledger of duplication that already exists, and the direction it is
 * allowed to move. A lock a red run can re-record is an ignore list with an
 * extra step, so every lock case is driven with two small in-memory lists — the
 * old lock and the candidate census — and the red ones assert the refusal
 * itself rather than anything printed.
 *
 * There is no ceiling and no budget line to test beside them: this lock records
 * group identities and no tree-wide number at all, which is why the copy count
 * a group is weighed by is read back out of its key.
 */

import { describe, expect, test } from 'bun:test';

import { scratchPath } from '@kinu.run/test-utils';

import { findDuplicateGroups, shrinkGroups } from './ast-duplication';
import { readLock, writeLock } from './gate-ratchet';

/** A body large enough to clear a real threshold, written twice with every
 *  identifier renamed. A text- or token-similarity tool matches on the names;
 *  this gate must not need them. */
const ORIGINAL = `
export function summarise(input: string): string {
  const trimmed = input.trim();
  const parts = trimmed.split(',');
  const kept: string[] = [];
  for (const part of parts) {
    if (part.length > 0) kept.push(part.toUpperCase());
  }
  return kept.join('|');
}
`;

const RENAMED = `
export function condense(raw: string): string {
  const clean = raw.trim();
  const chunks = clean.split(',');
  const keep: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length > 0) keep.push(chunk.toUpperCase());
  }
  return keep.join('|');
}
`;

describe('ast duplication gate', () => {
  test('a copy with every identifier renamed is still one group', () => {
    const groups = findDuplicateGroups(new Map([
      ['packages/core/src/a.ts', ORIGINAL],
      ['packages/core/src/b.ts', RENAMED],
    ]), 25);

    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => `${m.file}#${m.name}`)).toEqual([
      'packages/core/src/a.ts#summarise',
      'packages/core/src/b.ts#condense',
    ]);
  });

  test('a copy whose units, numbers and messages were also edited is still one group', () => {
    // The pair that went unseen while literal text was part of the identity:
    // one size formatter in the web UI, one in the CLI, over different units.
    const size = (name: string, base: number, units: readonly string[]): string => `
      export function ${name}(n: number): string {
        if (n < ${base}) return \`\${n} ${units[0]}\`;
        if (n < ${base} * ${base}) return \`\${(n / ${base}).toFixed(1)} ${units[1]}\`;
        return \`\${(n / (${base} * ${base})).toFixed(1)} ${units[2]}\`;
      }
    `;

    const groups = findDuplicateGroups(new Map([
      ['packages/cf-backend/src/files.tsx', size('fmtSize', 1024, ['B', 'KB', 'MB'])],
      ['packages/cli/src/display.ts', size('formatBytes', 1000, ['bytes', 'kB', 'megabytes'])],
    ]), 20);

    expect(groups.map((g) => g.members.map((m) => m.name))).toEqual([['fmtSize', 'formatBytes']]);
  });

  test('two getters over different SQL are not a copy, through either SQL port', () => {
    const tagged = (table: string): string => `
      export function read(sql: SqlExecutor, id: string): Row | undefined {
        const row = sql<Row>\`SELECT id, name, created_at FROM ${table} WHERE id = \${id}\`[0];
        if (row === undefined) return undefined;
        return { id: row.id, name: row.name, createdAt: row.created_at };
      }
    `;

    const positional = (table: string): string => `
      export function read(db: SqlExec, id: string): Row | undefined {
        const row = db.exec('SELECT id, name, created_at FROM ${table} WHERE id = ?', id).toArray()[0];
        if (row === undefined) return undefined;
        return { id: row.id, name: row.name, createdAt: row.created_at };
      }
    `;

    for (const getter of [tagged, positional]) {
      const over = (a: string, b: string) => findDuplicateGroups(new Map([
        ['packages/core/src/a.ts', getter(a)],
        ['packages/core/src/b.ts', getter(b)],
      ]), 20);

      expect(over('crafted_tools', 'memory_chunks')).toEqual([]);
      // The same query twice is a copy, so the silence above is the query's doing.
      expect(over('crafted_tools', 'crafted_tools')).toHaveLength(1);
    }
  });

  test('two wrappers over different intrinsic JSX tags are not a copy', () => {
    const wrapper = (outer: string, head: string, body: string): string => `
      function Frame({ label, children }: { label: string; children: ReactNode }) {
        return (
          <${outer} className="frame">
            <${head} className="frame-head">{label}</${head}>
            <${body} className="frame-body">{children}</${body}>
          </${outer}>
        );
      }
    `;

    const over = (b: string) => findDuplicateGroups(new Map([
      ['packages/cf-backend/src/a.tsx', wrapper('div', 'dt', 'dd')],
      ['packages/cf-backend/src/b.tsx', b],
    ]), 20);

    expect(over(wrapper('section', 'h2', 'div'))).toEqual([]);
    expect(over(wrapper('div', 'dt', 'dd'))).toHaveLength(1);
  });

  test('a duplicate below the threshold is not reported', () => {
    const groups = findDuplicateGroups(new Map([
      ['packages/core/src/a.ts', ORIGINAL],
      ['packages/core/src/b.ts', RENAMED],
    ]), 500);

    expect(groups).toEqual([]);
  });

  test('a copy across two packages is ranked as cross-package', () => {
    const groups = findDuplicateGroups(new Map([
      ['packages/core/src/a.ts', ORIGINAL],
      ['packages/cf-backend/src/b.ts', RENAMED],
      ['packages/cli/src/c.ts', ORIGINAL],
    ]), 25);

    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('cross-package');
    expect(groups[0].members).toHaveLength(3);
  });

  test('a duplicate nested inside a duplicate is reported once, outermost', () => {
    const groups = findDuplicateGroups(new Map([
      ['packages/core/src/a.ts', ORIGINAL],
      ['packages/core/src/b.ts', RENAMED],
    ]), 5);

    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.name)).toEqual(['summarise', 'condense']);
  });

  test('an anonymous callback is reported under its owner and its call', () => {
    const component = (tail: string): string => `
      export function Panel(): unknown {
        const grow = useCallback(() => {
          const el = ref.current;
          if (!el) return;
          el.style.height = 'auto';
          el.style.height = \`\${el.scrollHeight}px\`;
          el.dataset.grown = 'yes';
        }, [value]);
        ${tail}
        return grow;
      }
    `;

    const groups = findDuplicateGroups(new Map([
      ['packages/cf-backend/src/a.tsx', component('log("a");')],
      ['packages/cf-backend/src/b.tsx', component('warn("b", 2);')],
    ]), 20);

    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.name)).toEqual([
      'grow > useCallback',
      'grow > useCallback',
    ]);
  });
});

/** Two copies, the shape the live lock is mostly made of. */
const PAIR = 'cross-file packages/core/src/file-edit.ts#lineSpan '
  + '| packages/core/src/file-ledger.ts#lineCount';

/** The same pair after one of the two moved: a different key, the same debt. */
const MOVED = 'cross-file packages/core/src/file-edit.ts#lineSpan '
  + '| packages/core/src/lines/ledger.ts#lineCount';

/** Three copies of one body — the same debt as PAIR plus one more copy. */
const TRIO = 'cross-package packages/core/src/parse.ts#parsePositiveInt '
  + '| packages/cli/src/parse.ts#parsePositiveInt '
  + '| packages/cli-backend/src/parse.ts#parsePositiveInt';

/** A second pair, unrelated to the first. */
const OTHER = 'same-file packages/cf-backend/src/user/mcp.ts#parseAllowedTools '
  + '| packages/cf-backend/src/user/mcp.ts#parseMcpHeaders';

describe('the lock only shrinks or is re-keyed', () => {
  test('a group that gained a copy is refused, and nothing is written', () => {
    // The raise, in the only spelling this lock has: the key names the copies,
    // so a third one arrives as a three-copy group where a two-copy group left.
    const { keys, refusals } = shrinkGroups([PAIR], [TRIO]);
    expect(refusals).toEqual([{ key: TRIO, was: 2, now: 3 }]);
    expect(keys).toBeUndefined();
  });

  test('a group that lost a copy and a group that was fixed are accepted and written', () => {
    // The direction the lock exists to record, reaching a file: a merge that
    // refused everything would pass every red case here.
    const { keys, refusals } = shrinkGroups([TRIO, OTHER], [PAIR]);
    expect(refusals).toEqual([]);

    const path = scratchPath('ast-duplication-lock', 'lock.json');

    if (keys === undefined) throw new Error('an accepted merge has keys to write');
    expect(writeLock(keys, path)).toBe(1);
    expect(readLock(path)).toEqual([PAIR]);
  });

  test('a re-key is accepted: one group vanishes and one arrives with the same copies', () => {
    // A file move changes the key of a duplicate nobody made worse, and a lock
    // that cannot be re-keyed is a lock people route around.
    const { keys, refusals } = shrinkGroups([PAIR, OTHER], [MOVED, OTHER]);
    expect(refusals).toEqual([]);
    expect(keys).toEqual([MOVED, OTHER]);
  });

  test('a new group with nothing vanishing to pay for it is refused', () => {
    const { keys, refusals } = shrinkGroups([PAIR], [PAIR, OTHER]);
    expect(refusals).toEqual([{ key: OTHER, was: undefined, now: 2 }]);
    expect(keys).toBeUndefined();
  });

  test('two groups leaving at 3 and 2 copies pay for 3 and 2, and refuse 3 and 3', () => {
    // The whole reason the pairing is sorted. Matching arrivals to departures in
    // any other order lets the second trio through on the departed trio alone,
    // which is a pair becoming a trio with the group count unchanged.
    const leaving = [TRIO, OTHER];
    const trioMoved = TRIO.replaceAll('/parse.ts', '/numbers.ts');
    const trioRenamed = TRIO.replaceAll('parsePositiveInt', 'readPositiveInt');

    const refused = shrinkGroups(leaving, [trioMoved, trioRenamed]);
    expect(refused.refusals).toEqual([{ key: trioRenamed, was: 2, now: 3 }]);
    expect(refused.keys).toBeUndefined();

    const accepted = shrinkGroups(leaving, [trioMoved, MOVED]);
    expect(accepted.refusals).toEqual([]);
    expect(accepted.keys).toEqual([trioMoved, MOVED]);
  });

  test('an unchanged census re-locks to itself', () => {
    // The green a cleanup has to pass through on its way to the file.
    expect(shrinkGroups([TRIO, OTHER], [OTHER, TRIO])).toEqual({
      keys: [OTHER, TRIO],
      refusals: [],
    });
  });
});

describe('the copy count the merge weighs a group by', () => {
  test('is the one the gate itself put in the key', () => {
    // The merge reads the copies back out of the recorded identity rather than
    // recording them twice, so the arithmetic above is only as good as that
    // format. This is the gate's own key, not a hand-written one.
    const body = (name: string, unit: string): string => `
      export function ${name}(input: string): string {
        const rows = input.split('\\n');
        const kept: string[] = [];
        for (const row of rows) {
          if (row.length > 0) kept.push(\`\${row}${unit}\`);
        }
        return kept.join(',');
      }
    `;

    const groups = findDuplicateGroups(new Map([
      ['packages/core/src/a.ts', body('first', 'x')],
      ['packages/cli/src/b.ts', body('second', 'x')],
      ['packages/cli-backend/src/c.ts', body('third', 'x')],
    ]), 25);

    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(3);
    expect(groups[0].key.split(' | ')).toHaveLength(3);
  });
});
