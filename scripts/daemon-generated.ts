/**
 * The device daemon speaks two protocols with core: the checkpoint store format the CLI's engine reads, and
 * Sign in with ChatGPT's token protocol a deployment's sign-in speaks. Each is one dependency-free core module.
 * The daemon is dependency-free JavaScript, and its updater lands only the files the RUNNING daemon names
 * (`landDaemonFiles` in `pc-agent/src/update.js`), so a new sibling file would leave every updated daemon
 * unable to start. Each module is therefore copied into a daemon file, between two markers, with its type-only
 * syntax removed and its lines and comments kept, so the copy reads and lints as the source does.
 *
 * Running this script regenerates every block; the parity tests refuse a daemon whose block differs from a
 * fresh copy.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync, Visitor } from 'oxc-parser';

const REPO_ROOT = join(import.meta.dir, '..');

/** Each core module and the daemon file that carries it. */
export const GENERATED = {
  checkpointFormat: { source: 'packages/core/src/checkpoints/format.ts', daemon: 'packages/pc-agent/src/index.js' },
  chatgptProtocol: { source: 'packages/core/src/providers/chatgpt-protocol.ts', daemon: 'packages/pc-agent/src/chatgpt.js' },
} as const;

type Generated = (typeof GENERATED)[keyof typeof GENERATED];

const begin = (source: string) => `// BEGIN GENERATED from ${source} by \`bun scripts/daemon-generated.ts\`. Do not edit.`;

const END = '// END GENERATED';

/** `source` with its type-only spans cut out; the line breaks inside a cut span stay. */
function withoutTypes(name: string, source: string): string {
  const parsed = parseSync(name, source);

  if (parsed.errors.length > 0) throw new Error(`${name} does not parse: ${parsed.errors.map((error) => error.message).join('; ')}`);
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

/** `daemon` with its generated block holding a fresh copy of `module`, which `generated` names. */
function withGenerated(generated: Generated, daemon: string, module: string): string {
  const marker = begin(generated.source);
  const from = daemon.indexOf(marker);
  const to = daemon.indexOf(END, from);

  if (from < 0 || to < 0) throw new Error(`${generated.daemon} has no block generated from ${generated.source}`);

  // The module's declarations become the daemon's own: it is CommonJS and exports none of them. A cut leaves
  // trailing space and runs of blank lines, which fold to one.
  const body = withoutTypes(generated.source, module).split('\n')
    .map((line) => (line.startsWith('export ') ? line.slice('export '.length) : line).trimEnd())
    .filter((line, at, all) => line !== '' || (at > 0 && all[at - 1] !== ''))
    .join('\n').trim();

  return `${daemon.slice(0, from)}${marker}\n\n${body}\n\n${daemon.slice(to)}`;
}

/** A daemon file as committed, and as a fresh generation would write it. */
export function daemonSource(generated: Generated, root: string = REPO_ROOT) {
  const committed = readFileSync(join(root, generated.daemon), 'utf8');

  return { committed, fresh: withGenerated(generated, committed, readFileSync(join(root, generated.source), 'utf8')) };
}

if (import.meta.main) {
  for (const generated of Object.values(GENERATED)) {
    const { committed, fresh } = daemonSource(generated);

    if (fresh !== committed) writeFileSync(join(REPO_ROOT, generated.daemon), fresh);
    console.log(`${generated.daemon}: ${fresh === committed ? 'already current' : 'regenerated'} from ${generated.source}`);
  }
}
