/**
 * Where an `eval` program runs, decided once from what it imports. One that imports from the workspace (a relative
 * path, or a package from node_modules), or writes a static `import` at all, runs as a Node program in the workspace
 * (Nimbus's node), where those resolve; every other program runs in the codemode isolate, as it always has.
 */
import * as acorn from 'acorn';
import { Effect } from 'effect';
import { renderThrownChain, settleSync } from '../obs/index';

/** The module a program imports Kinu's namespaces from, on Node: `import { web } from 'kinu'`. */
export const KINU_PROGRAM_MODULE = 'kinu';

/** Node's own modules, bare as a program may name them; `node:`-prefixed ones are always Node's. */
const NODE_BUILTINS: ReadonlySet<string> = new Set([
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'diagnostics_channel', 'dns', 'dns/promises', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'readline/promises', 'repl', 'stream', 'stream/consumers',
  'stream/promises', 'stream/web', 'string_decoder', 'sys', 'timers', 'timers/promises', 'tls', 'trace_events', 'tty',
  'url', 'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

/** One static `import` declaration of the program: its text, and the module it names. */
export interface ProgramImport {
  readonly specifier: string;
  readonly start: number;
  readonly end: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

export type ProgramPlace =
  | { readonly kind: 'isolate' }
  | { readonly kind: 'node'; readonly imports: readonly ProgramImport[] };

/** A specifier Node resolves from the workspace's files: a path, or a package other than Node's own and Kinu's. */
function fromWorkspace(specifier: string): boolean {
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) return true;

  return !specifier.startsWith('node:') && !NODE_BUILTINS.has(specifier) && specifier !== KINU_PROGRAM_MODULE;
}

const PARSE: acorn.Options = {
  ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true,
};

/** Every node of `root`, depth first. */
function* nodesOf(root: acorn.Node): Generator<acorn.Node> {
  const stack: acorn.Node[] = [root];

  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    yield node;

    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child instanceof acorn.Node) stack.push(child);
      }
    }
  }
}

/** The literal a `require(…)` or `import(…)` names, or null for any other node. */
function namedModule(node: acorn.Node): string | null {
  if (node.type === 'ImportExpression' && 'source' in node && node.source instanceof acorn.Node && node.source.type === 'Literal' && 'value' in node.source) {
    return typeof node.source.value === 'string' ? node.source.value : null;
  }

  if (node.type !== 'CallExpression' || !('callee' in node) || !('arguments' in node)) return null;
  const { callee } = node;
  const [first] = Array.isArray(node.arguments) ? node.arguments : [];

  if (!(callee instanceof acorn.Node) || callee.type !== 'Identifier' || !('name' in callee) || callee.name !== 'require') return null;

  return first instanceof acorn.Node && first.type === 'Literal' && 'value' in first && typeof first.value === 'string' ? first.value : null;
}

/** Where `code` runs; one that does not parse stays in the isolate, which reports its syntax error as it always has. */
export function programPlace(code: string): ProgramPlace {
  const parsed = settleSync(Effect.try({ try: (): acorn.Program | { readonly unparsed: string } => acorn.parse(code, PARSE), catch: (cause) => ({ cause }) }).pipe(
    Effect.catch((failed) => Effect.succeed({ unparsed: renderThrownChain(failed) })),
  ));

  if ('unparsed' in parsed) return { kind: 'isolate' };
  const imports: ProgramImport[] = [];

  for (const statement of parsed.body) {
    if (statement.type !== 'ImportDeclaration' || typeof statement.source.value !== 'string') continue;
    imports.push({
      specifier: statement.source.value, start: statement.start, end: statement.end, sourceStart: statement.source.start, sourceEnd: statement.source.end,
    });
  }

  if (imports.length > 0) return { kind: 'node', imports };

  for (const node of nodesOf(parsed)) {
    const named = namedModule(node);

    if (named !== null && fromWorkspace(named)) return { kind: 'node', imports };
  }

  return { kind: 'isolate' };
}
