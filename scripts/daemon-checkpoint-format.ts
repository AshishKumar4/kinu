/**
 * The device daemon and the CLI write and read the same checkpoint stores, so they spell the store format
 * with one module: core's `checkpoints/format.ts`. The daemon is dependency-free JavaScript, and its
 * updater lands only the files the RUNNING daemon names (`landDaemonFiles` in `pc-agent/src/update.js`),
 * so a new sibling file would leave every updated daemon unable to start. The module is therefore copied
 * into the daemon's own source, between the two markers below, with its type-only syntax removed and its
 * lines, blank lines and comments kept, so the copy reads and lints as the source does.
 *
 * Running this script regenerates the block; `checkpoint-parity.test.ts` refuses a daemon whose block
 * differs from a fresh copy.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync, Visitor } from 'oxc-parser';

const REPO_ROOT = join(import.meta.dir, '..');

export const FORMAT_SOURCE = 'packages/core/src/checkpoints/format.ts';

export const DAEMON_SOURCE = 'packages/pc-agent/src/index.js';

const BEGIN = `// BEGIN GENERATED from ${FORMAT_SOURCE} by \`bun scripts/daemon-checkpoint-format.ts\`. Do not edit.`;

const END = '// END GENERATED';

/** `source` with its type-only spans cut out; the line breaks inside a cut span stay. */
function withoutTypes(source: string): string {
  const parsed = parseSync(FORMAT_SOURCE, source);

  if (parsed.errors.length > 0) throw new Error(`${FORMAT_SOURCE} does not parse: ${parsed.errors.map((error) => error.message).join('; ')}`);
  const cuts: Array<readonly [number, number]> = [];
  const whole = (node: { readonly start: number; readonly end: number }) => { cuts.push([node.start, node.end]); };

  new Visitor({
    TSTypeAnnotation: whole,
    TSTypeParameterInstantiation: whole,
    TSTypeParameterDeclaration: whole,
    TSInterfaceDeclaration: whole,
    TSTypeAliasDeclaration: whole,
    ImportDeclaration: (node) => { if (node.importKind === 'type') whole(node); },
    TSAsExpression: (node) => { cuts.push([node.expression.end, node.end]); },
    TSSatisfiesExpression: (node) => { cuts.push([node.expression.end, node.end]); },
  }).visit(parsed.program);

  // Cuts nest (an interface holds its members' annotations), so each character is judged once.
  const cut = new Uint8Array(source.length);

  for (const [start, end] of cuts) cut.fill(1, start, end);

  return source.split('').filter((char, at) => cut[at] === 0 || char === '\n').join('');
}

/** `daemon` with its generated block holding a fresh copy of `format`. */
export function withGeneratedFormat(daemon: string, format: string): string {
  const begin = daemon.indexOf(BEGIN);
  const end = daemon.indexOf(END, begin);

  if (begin < 0 || end < 0) throw new Error(`${DAEMON_SOURCE} has no generated checkpoint-format block`);

  // The module's declarations become the daemon's own: it is CommonJS and exports none of them. A cut leaves
  // trailing space and runs of blank lines, which fold to one.
  const body = withoutTypes(format).split('\n')
    .map((line) => (line.startsWith('export ') ? line.slice('export '.length) : line).trimEnd())
    .filter((line, at, all) => line !== '' || (at > 0 && all[at - 1] !== ''))
    .join('\n').trim();

  return `${daemon.slice(0, begin)}${BEGIN}\n\n${body}\n\n${daemon.slice(end)}`;
}

/** The daemon source as committed, and as a fresh generation would write it. */
export function daemonSources(root: string = REPO_ROOT) {
  const committed = readFileSync(join(root, DAEMON_SOURCE), 'utf8');

  return { committed, fresh: withGeneratedFormat(committed, readFileSync(join(root, FORMAT_SOURCE), 'utf8')) };
}

if (import.meta.main) {
  const { committed, fresh } = daemonSources();

  if (fresh !== committed) writeFileSync(join(REPO_ROOT, DAEMON_SOURCE), fresh);
  console.log(`${DAEMON_SOURCE}: checkpoint format ${fresh === committed ? 'already current' : 'regenerated'} from ${FORMAT_SOURCE}`);
}
