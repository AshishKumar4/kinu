/**
 * `scripts/comment-only.ts` is the zero-behaviour-change proof for comment
 * edits, so a green verdict on a code change is the failure that matters. Each
 * red row below is a change a plausible canonical form would miss: a field that
 * is not a child node, a value JSON cannot hold, a null child, JSX text
 * normalised away, a directive compared as a bag rather than by position.
 */

import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { git, initRepo, scratchDir } from '@kinu.run/test-utils';

import { compareSource, proveCommentOnly } from './comment-only';

const BASE = `/** The sum. */
export function add(a: number, b: number): number {
  // exported and summed here; a line comment is never an eslint directive
  return a + b;
}
const big = 10n;
const holes = [big, , add];
const view = (
  <div>
    {/* a note */}
    hello there
    <span />
  </div>
);
// @ts-expect-error: a string is not a number
const bad: number = 'x';
`;

const DIRECTIVE = '// @ts-expect-error: a string is not a number\n';

function edit(from: string, to: string): string {
  if (!BASE.includes(from)) throw new Error(`the fixture does not contain ${from}`);

  return BASE.replace(from, to);
}

test('a comment-only edit is proven, a removed JSX comment child and `// exported …` prose included', () => {
  const text = edit('/** The sum. */\n', '').replace(/ {2}\/\/ exported[^\n]*\n/, '').replace('{/* a note */}', '');

  expect(compareSource('view.tsx', BASE, text)).toMatchObject({ kind: 'comment-only' });
});

describe('a code change is refused, at the line it happens', () => {
  test.each([
    ['an operator, which is a field and not a child node', 'a + b', 'a - b', 4],
    ['a BigInt literal, which JSON.stringify cannot hold', '10n', '11n', 6],
    ['an array hole, which is a null child', '[big, , add]', '[big, add]', 7],
    ['JSX text', 'hello there', 'hello world', 11],
  ])('%s', (_, from, to, line) => {
    expect(compareSource('view.tsx', BASE, edit(from, to)))
      .toMatchObject({ kind: 'code', difference: { baseLine: line, headLine: line } });
  });
});

describe('a directive stays in front of the same code', () => {
  test.each([
    ['removed', edit(DIRECTIVE, '')],
    ['moved to other code', edit(DIRECTIVE, '').replace('const big', `${DIRECTIVE}const big`)],
    ['separated from its line by a blank line', edit(DIRECTIVE, `${DIRECTIVE}\n`)],
  ])('%s', (_, text) => {
    expect(compareSource('view.tsx', BASE, text)).toMatchObject({ kind: 'directive' });
  });
});

test('both sides come from git: the working tree, a commit range, and an untracked file', () => {
  const repo = scratchDir('comment-only');
  const file = join(repo, 'a.ts');

  const kinds = (head?: string): string[] =>
    proveCommentOnly(repo, head === undefined ? 'HEAD' : 'HEAD~1', head, []).map(({ verdict }) => verdict.kind);

  initRepo(repo);
  writeFileSync(file, 'export const a = 1; // one\n');
  git(repo, 'add', 'a.ts');
  git(repo, 'commit', '-qm', 'base');

  writeFileSync(file, 'export const a = 1;\n');
  expect(kinds()).toEqual(['comment-only']);

  writeFileSync(file, 'export const a = 2; // one\n');
  expect(kinds()).toEqual(['code']);

  git(repo, 'commit', '-qam', 'code');
  expect(kinds('HEAD')).toEqual(['code']);

  writeFileSync(join(repo, 'b.ts'), 'export const b = 1;\n');
  expect(kinds()).toEqual(['added']);
});
