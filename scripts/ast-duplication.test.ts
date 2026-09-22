/**
 * What `bun scripts/ast-duplication.ts --lock` may write.
 *
 * The gate's detection is proven in `gates.test.ts`, over sources. This file
 * takes the other half: the lock is a ledger of duplication that already
 * exists, and the direction it is allowed to move. A lock a red run can
 * re-record is an ignore list with an extra step, so every case here is driven
 * with two small in-memory lists — the old lock and the candidate census — and
 * the red ones assert the refusal itself rather than anything printed.
 *
 * There is no ceiling and no budget line to test beside them: this lock records
 * group identities and no tree-wide number at all, which is why the copy count
 * a group is weighed by is read back out of its key.
 */

import { describe, expect, test } from 'bun:test';

import { scratchPath } from '@kinu.run/test-utils';

import { findDuplicateGroups, shrinkGroups } from './ast-duplication';
import { readLock, writeLock } from './gate-ratchet';

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
