import { describe, expect, test } from 'bun:test';
import {
  changeBlocks, changeBody, changeTotals, changeTree, inReadingOrder, keepUnchanged, sideBySide,
  type ChangeBlock, type ChangeRow,
} from '../src/read-models/change-view';
import { diffLines, fileDiff, MAX_LINES_PER_FILE, parseGitDiff, type FileDiff } from '../src/vfs/diff';

const numbered = (count: number, from = 1): string[] => Array.from({ length: count }, (_, index) => `line ${String(from + index)}`);

function changedFile(before: readonly string[], after: readonly string[], path = 'src/a.ts'): FileDiff {
  return fileDiff(path, 'changed', diffLines(before.join('\n'), after.join('\n')));
}

/** Each block as a reader sees it: a fold's count, or the rows' new line numbers ("-" for a removed row). */
function outline(blocks: readonly ChangeBlock[]): string[] {
  return blocks.map((block) => {
    if (block.kind === 'gap') return `fold ${String(block.count)}`;

    if (block.kind === 'rest') return `rest ${String(block.count)}${block.deleted ? ' deleted' : ''}`;

    return block.rows.map((row) => (row.kind === 'del' ? '-' : String(row.newNo))).join(' ');
  });
}

function rowsIn(blocks: readonly ChangeBlock[]): ChangeRow[] {
  return blocks.flatMap((block) => (block.kind === 'rows' ? [...block.rows] : []));
}

function marked(row: ChangeRow | undefined): string[] {
  return (row?.marks ?? []).map(([start, end]) => row?.text.slice(start, end) ?? '');
}

describe('change view', () => {
  test('a change keeps three lines of context on each side, and each longer unchanged run folds into one counted row', () => {
    const before = numbered(40);
    const after = before.map((line, index) => (index === 19 ? 'line 20 changed' : line));

    expect(outline(changeBlocks(changedFile(before, after)))).toEqual([
      'fold 16', '17 18 19 - 20 21 22 23', 'fold 17',
    ]);
  });

  test('an unchanged run between two changes folds only when it would hide four lines or more', () => {
    const edit = (lines: string[], at: number): string[] => lines.map((line, index) => (index === at ? `${line} changed` : line));
    // Nine unchanged lines between the changes: three stay after the first, three before the second, three would hide.
    const nine = changeBlocks(changedFile(numbered(11), edit(edit(numbered(11), 0), 10)));
    const ten = changeBlocks(changedFile(numbered(12), edit(edit(numbered(12), 0), 11)));

    expect(outline(nine).some((block) => block.startsWith('fold'))).toBe(false);
    expect(outline(ten)).toContain('fold 4');
  });

  test('a paired line marks only the words that changed; a line mostly rewritten is left unmarked', () => {
    const blocks = changeBlocks(changedFile(
      ['const rule = rules[coupon.kind];', 'return a + b;'],
      ['const rule = rules[kindOf(coupon)];', 'throw new Error("unreachable");'],
    ));

    const [firstOld, secondOld, firstNew, secondNew] = rowsIn(blocks);

    expect(marked(firstOld)).toEqual(['.kind']);
    expect(marked(firstNew)).toEqual(['kindOf(', ')']);
    expect(secondOld?.marks).toBeUndefined();
    expect(secondNew?.marks).toBeUndefined();
  });

  test('a git diff numbers its rows from each hunk and folds the lines between hunks, naming the function git gives', () => {
    const [file] = parseGitDiff([
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -40,3 +40,3 @@ function apply(cart) {',
      ' keep 40',
      '-old 41',
      '+new 41',
      ' keep 42',
      '@@ -90,2 +90,2 @@ function total() {',
      '-old 90',
      '+new 90',
      ' keep 91',
    ].join('\n'));

    const blocks = changeBlocks(file);

    expect(outline(blocks)).toEqual(['fold 39', '40 - 41 42', 'fold 47', '- 90 91']);
    expect(blocks[0]).toMatchObject({ kind: 'gap', rows: [], context: 'function apply(cart) {' });
    expect(blocks[2]).toMatchObject({ kind: 'gap', rows: [], context: 'function total() {' });
  });

  test('a context line that reads like a hunk header is a line of the file, numbered in its place', () => {
    const [file] = parseGitDiff([
      'diff --git a/fix.patch b/fix.patch',
      '--- a/fix.patch',
      '+++ b/fix.patch',
      '@@ -10,3 +10,4 @@',
      ' line 10',
      ' @@ -40,6 +40,8 @@ function f() {',
      '+line 12',
      ' line 13',
    ].join('\n'));

    const blocks = changeBlocks(file);

    expect(outline(blocks)).toEqual(['fold 9', '10 11 12 13']);
    expect(rowsIn(blocks)[1]?.text).toBe('@@ -40,6 +40,8 @@ function f() {');
  });

  test('a long diff shows its first rows and counts the rest; in a stack a deleted file starts folded', () => {
    const before = numbered(400);
    const after = before.map((line, index) => (index % 2 === 0 ? `${line} changed` : line));
    const alone = changeBlocks(changedFile(before, after));
    const stacked = changeBlocks(changedFile(before, after), true);
    const removed = fileDiff('src/old.ts', 'removed', diffLines(numbered(22).join('\n'), ''));

    expect(rowsIn(alone)).toHaveLength(120);
    // 200 changed lines, each a removed and an added row, between 200 unchanged ones.
    expect(alone.at(-1)).toMatchObject({ kind: 'rest', count: 600 - 120 });
    expect(rowsIn(stacked)).toHaveLength(60);
    expect(outline(changeBlocks(removed, true))).toEqual(['rest 22 deleted']);
    expect(outline(changeBlocks(removed))).toHaveLength(1);
  });

  test('split view sets each removed row beside the row that replaced it, and an unchanged row beside itself', () => {
    const blocks = changeBlocks(changedFile(['a', 'b', 'c', 'keep'], ['A', 'keep', 'new']));
    const pairs = sideBySide(rowsIn(blocks)).map(({ left, right }) => `${left?.text ?? '·'} | ${right?.text ?? '·'}`);

    expect(pairs).toEqual(['a | A', 'b | ·', 'c | ·', 'keep | keep', '· | new']);
  });

  test('the tree lists folders before files, joins a folder that holds only a folder, and sets the reading order', () => {
    const files = ['README.md', 'packages/checkout/src/rules.ts', 'packages/checkout/src/apply.ts', 'packages/checkout/tests/kind.test.ts', 'packages/checkout/migrations/0042.sql']
      .map((path) => fileDiff(path, 'changed', diffLines('a', 'b')));

    expect(changeTree(files).map((row) => `${String(row.depth)} ${row.kind === 'folder' ? `${row.name}/` : row.file.path}`)).toEqual([
      '0 packages/checkout/',
      '1 migrations/',
      '2 packages/checkout/migrations/0042.sql',
      '1 src/',
      '2 packages/checkout/src/apply.ts',
      '2 packages/checkout/src/rules.ts',
      '1 tests/',
      '2 packages/checkout/tests/kind.test.ts',
      '0 README.md',
    ]);
    expect(inReadingOrder(files).map((file) => file.path.split('/').at(-1))).toEqual(['0042.sql', 'apply.ts', 'rules.ts', 'kind.test.ts', 'README.md']);
    expect(changeTotals(files)).toEqual({ added: 5, removed: 5 });
  });

  test('each folder row names its whole path, so folders with one name at one depth stay apart', () => {
    const files = ['packages/core/src/a.ts', 'packages/core/tests/a.test.ts', 'packages/cli/src/b.ts', 'packages/cli/tests/b.test.ts']
      .map((path) => fileDiff(path, 'changed', diffLines('a', 'b')));

    expect(changeTree(files).flatMap((row) => (row.kind === 'folder' ? [row.path] : []))).toEqual([
      'packages', 'packages/cli', 'packages/cli/src', 'packages/cli/tests', 'packages/core', 'packages/core/src', 'packages/core/tests',
    ]);
  });

  test('a poll keeps the object of each file whose content did not change, so nothing worked out from it is redone', () => {
    const before = [changedFile(['a'], ['b'], 'src/a.ts'), changedFile(['c'], ['d'], 'src/c.ts')];

    const [same, edited, added] = keepUnchanged(before, [
      changedFile(['a'], ['b'], 'src/a.ts'), changedFile(['c'], ['e'], 'src/c.ts'), changedFile([], ['n'], 'src/n.ts'),
    ]);

    expect(same).toBe(before[0]);
    expect(edited).not.toBe(before[1]);
    expect(edited?.lines.at(-1)?.text).toBe('e');
    expect(added?.path).toBe('src/n.ts');
  });

  test('a file with no rows says why: binary, not compared, too many lines, stopped at the row limit, or empty', () => {
    const [binary] = parseGitDiff(['diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ'].join('\n'));
    const rewritten = numbered(1500);
    const counted = changedFile(rewritten, rewritten.map((line) => `${line}!`));

    const [capped] = parseGitDiff([
      'diff --git a/data.csv b/data.csv', '--- a/data.csv', '+++ b/data.csv', '@@ -1,0 +1,1200 @@',
      ...numbered(MAX_LINES_PER_FILE + 200).map((line) => `+${line}`),
    ].join('\n'));

    expect(changeBody(binary)).toEqual({ kind: 'binary' });
    expect(changeBody({ path: 'dump.json', status: 'changed', added: 0, removed: 0, lines: [], omitted: 'large' })).toEqual({ kind: 'uncompared' });
    expect(changeBody(counted)).toEqual({ kind: 'counted' });
    expect(counted).toMatchObject({ added: 1500, removed: 1500 });
    expect(changeBody(capped)).toEqual({ kind: 'capped', hidden: 201 });
    expect(changeBody(fileDiff('empty.txt', 'added', diffLines('', '')))).toEqual({ kind: 'empty' });
    expect(changeBody(changedFile(['a'], ['b']))).toEqual({ kind: 'rows' });
  });
});
