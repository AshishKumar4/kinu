/**
 * Proof that a change touched comments and whitespace only.
 *
 * `bun scripts/comment-only.ts <base> [<head>] [-- <path>...]` compares every
 * file that differs between `base` and `head` (default: the working tree plus
 * untracked files). A file is proven when its oxc AST equals the base AST with
 * positions dropped, and every comment a tool reads (a directive) is still
 * there, in front of the same code. Exit 0 only when at least one file changed
 * and every changed file is proven.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Comment, type Node, parseSync } from 'oxc-parser';

import { gitEnv } from '../packages/test-utils/src/git';
import { isParseable } from './sources';
import { parse, type Parsed, type SyntaxNode } from './syntax';

/** Keys that locate a node rather than describe it. */
const POSITION: ReadonlySet<string> = new Set(['start', 'end', 'range', 'loc', 'parent']);

/**
 * What a JSX text child renders as, by the JSX transform's rule: tabs become
 * spaces, whitespace touching a line break goes, blank lines go, and the
 * remaining lines join with one space. Layout-only edits then compare equal.
 */
export function jsxText(text: string): string {
  const lines = text.split(/\r\n|\n|\r/);
  let last = 0;

  for (const [index, line] of lines.entries()) {
    if (/[^ \t]/.test(line)) last = index;
  }

  let rendered = '';

  for (const [index, line] of lines.entries()) {
    let kept = line.replaceAll('\t', ' ');

    if (index > 0) kept = kept.replace(/^ +/, '');

    if (index < lines.length - 1) kept = kept.replace(/ +$/, '');

    if (kept.length > 0) rendered += index === last ? kept : `${kept} `;
  }

  return rendered;
}

/** A JSX child the transform drops: `{/* comment *\/}` and layout-only text. */
export function rendersNothing(raw: Node): boolean {
  if (raw.type === 'JSXExpressionContainer') return raw.expression.type === 'JSXEmptyExpression';

  return raw.type === 'JSXText' && jsxText(raw.value).length === 0;
}

/**
 * The subtree as JSON with positions dropped. A literal is kept by its source
 * spelling, which also serialises BigInt and RegExp values; JSX children are
 * kept as rendered, so removing a `{/* … *\/}` child is not a code change.
 */
export function canonical(raw: Node): string {
  return JSON.stringify(raw, (key, value) => {
    if (POSITION.has(key)) return undefined;

    if (value?.type === 'Literal') return { type: 'Literal', raw: value.raw };

    if (value?.type === 'JSXText') return { type: 'JSXText', value: jsxText(value.value) };

    if (key === 'children' && Array.isArray(value)) return value.filter((child) => !rendersNothing(child));

    return value;
  });
}

/** Characters inside comments, delimiters included and whitespace excluded. */
export function commentCharacters(text: string, comments: readonly Comment[]): number {
  return comments.reduce((total, comment) =>
    total + text.slice(comment.start, comment.end).replace(/\s/g, '').length, 0);
}

/**
 * Comments a tool reads. `byLine` marks the ones whose reach is counted in
 * lines from the comment, so the line gap to the code they precede is compared
 * too; the rest are compared by the code they precede. `block` marks the ones
 * eslint reads only from a block comment, so a `//` line of prose starting
 * "exported" is not one.
 */
const DIRECTIVES: readonly { readonly pattern: RegExp; readonly byLine: boolean; readonly block?: true }[] = [
  { pattern: /@ts-(?:expect-error|ignore)\b/g, byLine: true },
  { pattern: /@ts-(?:nocheck|check)\b/g, byLine: false },
  { pattern: /\b(?:eslint|oxlint)-disable-(?:next-)?line\b[^\n]*?(?=[ \t]+--[ \t]|$)/gm, byLine: true },
  { pattern: /\b(?:eslint|oxlint)-(?:disable|enable)(?![-\w])[^\n]*?(?=[ \t]+--[ \t]|$)/gm, byLine: false },
  { pattern: /^[\s*]*(?:eslint|globals?|exported)[ \t][^\n]*/g, byLine: false, block: true },
  { pattern: /\bbiome-ignore(?:-all|-start|-end)?\b[^:\n]*/g, byLine: true },
  { pattern: /\bprettier-ignore\b/g, byLine: true },
  { pattern: /\b(?:istanbul|c8|v8)[ \t]+ignore\b(?:[ \t]+\w+)*/g, byLine: true },
  // Bundler annotations: `@__PURE__`, `#__NO_SIDE_EFFECTS__`, `@vite-ignore`, webpack magic.
  { pattern: /[@#]__[A-Z][A-Z_]*__/g, byLine: false },
  { pattern: /@vite-ignore\b/g, byLine: false },
  { pattern: /\bwebpack[A-Z]\w*[ \t]*:[^,\n*]*/g, byLine: false },
  { pattern: /@jsx(?:ImportSource|Runtime|Frag)?[ \t]+\S+/g, byLine: false },
  { pattern: /[#@][ \t]*source(?:Mapping)?URL=\S+/g, byLine: false },
  { pattern: /@(?:vitest|jest)-environment[ \t]+\S+/g, byLine: false },
  { pattern: /@refresh[ \t]+reset\b/g, byLine: false },
  { pattern: /^[ \t]*@bun\b/g, byLine: false },
  // knip reads these JSDoc tags when it decides what `gate:dead-code` reports.
  { pattern: /@(?:public|internal|beta|alias)\b/g, byLine: false },
  // A `///` directive's comment value starts with the third slash.
  { pattern: /^\/[ \t]*<(?:reference|amd-module|amd-dependency)\b[^\n]*/g, byLine: false },
  { pattern: /@(?:license|preserve)\b/g, byLine: false },
];

interface Directive {
  readonly token: string;
  /** Preorder index of the first rendered node after the comment. Equal code
   *  numbers its nodes identically, so equal anchors mean the same code. */
  readonly anchor: number;
  readonly gap: number | undefined;
  readonly line: number;
}

interface Side {
  readonly text: string;
  readonly parsed: Parsed;
  readonly comments: readonly Comment[];
}

function sideOf(file: string, text: string): Side {
  // `parse` refuses a file with syntax errors, so `parseSync` here only reads comments.
  return { text, parsed: parse(file, text), comments: parseSync(file, text).comments };
}

function renderedPreorder(root: SyntaxNode): SyntaxNode[] {
  const order: SyntaxNode[] = [];

  const visit = (node: SyntaxNode): void => {
    if (rendersNothing(node.raw)) return;
    order.push(node);

    for (const child of node.children) visit(child);
  };

  visit(root);

  return order;
}

function directivesOf(side: Side): Directive[] {
  const found: Directive[] = [];
  let order: SyntaxNode[] | undefined;

  for (const comment of side.comments) {
    const tokens = DIRECTIVES.filter(({ block }) => block === undefined || comment.type === 'Block')
      .flatMap(({ pattern, byLine }) => [...comment.value.matchAll(pattern)]
        .map((match) => ({ token: match[0].replace(/\s+/g, ' ').trim(), byLine })));

    if (tokens.length === 0 && !comment.value.startsWith('!')) continue;
    order ??= renderedPreorder(side.parsed.root);
    const anchor = order.findIndex((node) => node.start >= comment.end);
    const next = order[anchor];
    const line = side.parsed.lineAt(comment.start);
    const gap = next === undefined ? undefined : side.parsed.lineAt(next.start) - side.parsed.lineAt(comment.end);

    // A license comment is copied into the bundle verbatim, so all of its text is read.
    if (comment.value.startsWith('!') || tokens.some(({ token }) => token === '@license' || token === '@preserve')) {
      found.push({ token: `license ${comment.value.replace(/\s+/g, ' ').trim()}`, anchor, gap: undefined, line });
      continue;
    }

    for (const { token, byLine } of tokens) found.push({ token, anchor, gap: byLine ? gap : undefined, line });
  }

  return found;
}

export interface Difference {
  readonly baseLine: number | undefined;
  readonly headLine: number | undefined;
  readonly what: string;
}

export type SourceVerdict =
  | { readonly kind: 'comment-only'; readonly baseCommentChars: number; readonly headCommentChars: number }
  | { readonly kind: 'code'; readonly difference: Difference }
  | { readonly kind: 'directive'; readonly difference: Difference };

/** The first place the two trees differ, descending while one child explains it. */
function firstDifference(base: SyntaxNode, head: SyntaxNode): readonly [SyntaxNode, SyntaxNode] {
  if (base.type !== head.type) return [base, head];
  const left = base.children.filter((child) => !rendersNothing(child.raw));
  const right = head.children.filter((child) => !rendersNothing(child.raw));

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const was = left.at(index);
    const now = right.at(index);

    if (was === undefined || now === undefined) return [was ?? base, now ?? head];

    if (canonical(was.raw) !== canonical(now.raw)) return firstDifference(was, now);
  }

  return [base, head];
}

const snippet = (side: Side, node: SyntaxNode): string =>
  `${node.type} \`${side.text.slice(node.start, node.end).replace(/\s+/g, ' ').slice(0, 80)}\``;

/** The line of a node's first visible character: a JSX text node starts on the line break before its text. */
function lineOf(side: Side, node: SyntaxNode): number {
  const body = side.text.slice(node.start, node.end);

  return side.parsed.lineAt(node.start + body.length - body.trimStart().length);
}

function directiveDifference(base: Side, head: Side): Difference | undefined {
  const was = directivesOf(base);
  const now = directivesOf(head);

  for (let index = 0; index < Math.max(was.length, now.length); index += 1) {
    const before = was.at(index);
    const after = now.at(index);

    if (before?.token === after?.token && before?.anchor === after?.anchor && before?.gap === after?.gap) continue;

    const what = before === undefined || after === undefined || before.token !== after.token
      ? `${before?.token ?? '(none)'} -> ${after?.token ?? '(none)'}`
      : `${before.token} moved relative to the code after it`;

    return { baseLine: before?.line, headLine: after?.line, what };
  }

  return undefined;
}

/** Whether `head` differs from `base` in comments and whitespace only. */
export function compareSource(file: string, base: string, head: string): SourceVerdict {
  const before = sideOf(file, base);
  const after = sideOf(file, head);

  if (canonical(before.parsed.root.raw) !== canonical(after.parsed.root.raw)) {
    const [was, now] = firstDifference(before.parsed.root, after.parsed.root);

    return {
      kind: 'code',
      difference: {
        baseLine: lineOf(before, was),
        headLine: lineOf(after, now),
        what: `${snippet(before, was)} -> ${snippet(after, now)}`,
      },
    };
  }

  const moved = directiveDifference(before, after);

  if (moved !== undefined) return { kind: 'directive', difference: moved };

  return {
    kind: 'comment-only',
    baseCommentChars: commentCharacters(base, before.comments),
    headCommentChars: commentCharacters(head, after.comments),
  };
}

export type FileVerdict = SourceVerdict | { readonly kind: 'added' | 'deleted' | 'unprovable'; readonly status: string };

export interface FileProof {
  readonly file: string;
  readonly verdict: FileVerdict;
}

/**
 * Every file that differs between `base` and `head` under `paths`, judged.
 * Without `head` the working tree is compared, untracked files included,
 * because a new file is never a comment edit.
 */
export function proveCommentOnly(
  repo: string,
  base: string,
  head: string | undefined,
  paths: readonly string[],
): FileProof[] {
  const git = (...args: readonly string[]): string => execFileSync('git', ['-C', repo, ...args], {
    env: gitEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });

  const commit = (ref: string): string => git('rev-parse', '--verify', `${ref}^{commit}`).trim();
  const from = commit(base);
  const to = head === undefined ? undefined : commit(head);

  const fields = git('diff', '--name-status', '-z', '--no-renames', from, ...(to === undefined ? [] : [to]), '--', ...paths)
    .split('\0').filter((field) => field.length > 0);

  const changes: { readonly status: string; readonly file: string }[] = [];

  for (let index = 0; index + 1 < fields.length; index += 2) {
    changes.push({ status: fields[index], file: fields[index + 1] });
  }

  if (to === undefined) {
    const untracked = git('status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', ...paths)
      .split('\0').filter((entry) => entry.startsWith('?? '));

    for (const entry of untracked) changes.push({ status: '??', file: entry.slice(3) });
  }

  const read = (file: string): string => (to === undefined
    ? readFileSync(join(git('rev-parse', '--show-toplevel').trim(), file), 'utf8')
    : git('cat-file', 'blob', `${to}:${file}`));

  return changes.map(({ status, file }): FileProof => {
    if (status === 'A' || status === '??') return { file, verdict: { kind: 'added', status } };

    if (status === 'D') return { file, verdict: { kind: 'deleted', status } };

    if ((status !== 'M' && status !== 'T') || !isParseable(file)) return { file, verdict: { kind: 'unprovable', status } };

    return { file, verdict: compareSource(file, git('cat-file', 'blob', `${from}:${file}`), read(file)) };
  }).sort((a, b) => a.file.localeCompare(b.file));
}

/** What this proof cannot see, printed on the green path. */
export const BLIND_SPOTS: readonly string[] = [
  'A DIRECTIVE THIS LIST DOES NOT NAME. Directives are recognised by pattern (TypeScript, '
  + 'eslint/oxlint, biome, prettier, coverage, bundler annotations, JSX pragmas, `///`, source maps, '
  + 'knip tags, licenses); a comment some other tool reads is treated as prose.',
  'JSX TEXT SPLIT BY A REMOVED `{/* … */}`. The transform keeps the two halves as two children, '
  + 'so the proof reports a code change even though the rendered text is identical.',
  'A FILE THE PARSER CANNOT READ is not provable, and neither is an added, deleted or renamed file.',
];

function describe({ file, verdict }: FileProof): string {
  if (verdict.kind === 'comment-only') {
    return `  ok         ${file}  comment chars ${String(verdict.baseCommentChars)} -> ${String(verdict.headCommentChars)}`;
  }

  if (verdict.kind === 'code' || verdict.kind === 'directive') {
    const { baseLine, headLine, what } = verdict.difference;
    const where = `${file}:${String(headLine ?? '-')} (base :${String(baseLine ?? '-')})`;

    return `  ${verdict.kind === 'code' ? 'CODE      ' : 'DIRECTIVE '} ${where} ${what}`;
  }

  return `  ${verdict.kind.toUpperCase().padEnd(10)} ${file} (git status ${verdict.status})`;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dash = argv.indexOf('--');
  const refs = dash === -1 ? argv : argv.slice(0, dash);
  const paths = dash === -1 ? [] : argv.slice(dash + 1);
  const [base, head] = refs;

  if (base === undefined || refs.length > 2) {
    console.error('usage: bun scripts/comment-only.ts <base> [<head>] [-- <path>...]');
    process.exit(2);
  }

  const proofs = proveCommentOnly(process.cwd(), base, head, paths);
  const failed = proofs.filter(({ verdict }) => verdict.kind !== 'comment-only');

  for (const proof of proofs) console.log(describe(proof));

  if (proofs.length === 0) {
    console.error(`comment-only: nothing differs from ${base}; an empty diff proves nothing (wrong base?)`);
    process.exit(1);
  }

  console.log(`comment-only: ${String(proofs.length - failed.length)} of ${String(proofs.length)} changed `
    + `file(s) differ from ${base} in comments and whitespace only`);

  if (failed.length > 0) process.exit(1);

  for (const spot of BLIND_SPOTS) console.log(`  blind: ${spot}`);
}
