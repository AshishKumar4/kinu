/**
 * Reachability gate — a declared surface with no caller.
 *
 * `@callable()` is the only thing that makes a Durable Object method reachable
 * from a browser or the CLI, so the decorator IS the product surface: adding it
 * ships a public endpoint, and removing it withdraws one. Nothing else in the
 * toolchain has an opinion about whether that endpoint is ever invoked. The
 * dispatch is by STRING — `agent.call(method, args)` in the SDK, a `{type:'rpc'}`
 * frame on the websocket — so the method name never appears in a typed position
 * that `tsc` could check, `oxlint` could flag, or `knip` could trace: knip
 * reasons about exports, and a class method is not one.
 *
 * The result is the codebase's signature defect wearing a network address. On
 * the tree this gate was written against it found seven of them, including
 * `listDeferredApprovals` — whose own docstring says "also callable on its own
 * so a surface can render just this", and no surface does — and
 * `revokeShellApprovalGrants`, the withdraw half of the persistent-approval
 * feature, which the owner asked for by name.
 *
 * ## Why a mention is not a caller
 *
 * All seven look reachable to `git grep`, because the repo mentions them in
 * places that are declarations ABOUT the surface rather than uses OF it: the
 * `AGENT_RPC_ACCESS` scope table in `cli/rpc-gate.ts` names every RPC and calls
 * none, `rpc-surface.ts` holds allowlists of names, `lib/protocol.ts` types the
 * results, and comments discuss methods that were deleted years of commits ago
 * (`EnvironmentSurface.tsx` still explains why it stopped loading
 * `getWorkspaceAgents`). A grep-based gate drowns in those; a gate with an
 * exclusion list for them is a hardcoded list, which is the thing that drifts.
 *
 * So reachability is decided syntactically instead, and the rule is the same
 * one a reader uses: something INVOKED it.
 *
 *   - a string literal in ARGUMENT position of a call — `rpc('getMctsTree')`,
 *     `act("retryBackgroundJob")`;
 *   - a property-access call — `facet.initHead(input)` on a DO stub.
 *
 * A property KEY (`{ listTurnFeedback: 'interactive' }`), an array element
 * (`['missionGuard']`), an import specifier, a type reference and a comment are
 * none of those, and drop out by construction rather than by being listed.
 * That is why this parses instead of matching text.
 */


import { assertMeasured, reconcile, report, writeLock } from './gate-ratchet';
import { readSources, readTests } from './sources';
import {
  classMembers, declaredName, decoratorNames, memberCalleeName, parse, stringArguments, walk,
} from './syntax';

const root = new URL('..', import.meta.url).pathname;
const LOCK = `${root}scripts/reachability.lock.json`;

export interface Rpc {
  readonly file: string;
  readonly line: number;
  readonly owner: string;
  readonly method: string;
}

export interface Unreachable {
  readonly rpc: Rpc;
  /** Test files that invoke it — an RPC only its own test can reach is the
   *  `ensureActorSchema` shape, and reads differently from one nothing calls. */
  readonly testCallers: readonly string[];
}

/** Every `@callable()` method in one file, with the class that declares it. The
 *  owner is what makes a lock key `file#Class.method`, so the walk goes through
 *  the class rather than flat over methods. */
export function declaredRpcs(file: string, text: string): Rpc[] {
  const parsed = parse(file, text);
  const found: Rpc[] = [];
  walk(parsed.root, (node) => {
    if (node.type !== 'ClassDeclaration') return;
    const owner = declaredName(node) ?? '(anonymous class)';
    for (const member of classMembers(node)) {
      if (member.type !== 'MethodDefinition') continue;
      if (!decoratorNames(member).includes('callable')) continue;
      const method = declaredName(member);
      if (method === undefined) continue;
      found.push({ file, line: parsed.lineAt(member.start), owner, method });
    }
  });
  return found;
}

/**
 * Names this file INVOKES: string literals passed as call arguments, plus
 * property-access callees, static and computed. Both are "someone runs this", and
 * neither a policy table, an allowlist, a type, an import nor a comment can
 * produce one. A bare identifier callee is excluded on purpose — `rpc('x')`
 * contributes `x`, not `rpc`, so a same-named core function cannot stand in as a
 * caller of the method.
 */
export function invokedNames(file: string, text: string): Set<string> {
  const names = new Set<string>();
  walk(parse(file, text).root, (node) => {
    if (node.type !== 'CallExpression') return;
    for (const argument of stringArguments(node)) names.add(argument);
    const member = memberCalleeName(node);
    if (member !== undefined) names.add(member);
  });
  return names;
}

/** The gate's verdict AND its denominator. `unreachable: []` means nothing is
 *  dead only if `declared` is non-empty — otherwise the decorator matcher has
 *  stopped matching and the gate is passing because it looked at nothing. That
 *  is how `unit-layergate.test.ts` came to check an empty set, and how
 *  `tool-construction` reports `0/0` inside a 100% headline. */
export interface Reachability {
  readonly declared: readonly Rpc[];
  readonly unreachable: readonly Unreachable[];
}

export function findUnreachable(
  sources: ReadonlyMap<string, string>,
  tests: ReadonlyMap<string, string> = new Map(),
): Reachability {
  const rpcs: Rpc[] = [];
  for (const [file, text] of sources) {
    if (!text.includes('@callable')) continue;
    rpcs.push(...declaredRpcs(file, text));
  }

  // A method's own declaring file is not a caller of it: `this.foo()` inside
  // the class, and the recursive shape where the RPC forwards to a core
  // function of the same name, are both self-reference.
  const declaredIn = new Map<string, Set<string>>();
  for (const rpc of rpcs) {
    const seen = declaredIn.get(rpc.method) ?? new Set<string>();
    seen.add(rpc.file);
    declaredIn.set(rpc.method, seen);
  }

  const callersOf = new Map<string, string[]>();
  const record = (file: string, text: string): void => {
    for (const name of invokedNames(file, text)) {
      const declarers = declaredIn.get(name);
      if (declarers === undefined || declarers.has(file)) continue;
      const list = callersOf.get(name) ?? [];
      list.push(file);
      callersOf.set(name, list);
    }
  };
  for (const [file, text] of sources) record(file, text);

  const testCallersOf = new Map<string, string[]>();
  for (const [file, text] of tests) {
    for (const name of invokedNames(file, text)) {
      if (!declaredIn.has(name)) continue;
      const list = testCallersOf.get(name) ?? [];
      list.push(file);
      testCallersOf.set(name, list);
    }
  }

  const unreachable = rpcs
    .filter((rpc) => (callersOf.get(rpc.method)?.length ?? 0) === 0)
    .map((rpc) => ({ rpc, testCallers: (testCallersOf.get(rpc.method) ?? []).sort() }))
    .sort((a, b) => a.rpc.method.localeCompare(b.rpc.method));
  return { declared: rpcs, unreachable };
}

export function keyOf(entry: Unreachable): string {
  return `${entry.rpc.file}#${entry.rpc.owner}.${entry.rpc.method}`;
}

export function describe(entry: Unreachable): string {
  const { rpc, testCallers } = entry;
  const reach = testCallers.length === 0
    ? 'no caller anywhere'
    : `reachable only from ${testCallers.length} test file(s): ${testCallers.join(', ')}`;
  return `  ${rpc.file}:${rpc.line} ${rpc.owner}.${rpc.method}() — ${reach}`;
}

/**
 * What this gate cannot see, printed on the GREEN path. A limitation visible
 * only in red output is invisible exactly when the tree is clean, which is
 * when somebody decides how far to trust the signal.
 */
export const BLIND_SPOTS: readonly string[] = [
  'A REACHABLE RPC WHOSE RESULT NOBODY READS — NOT DETECTED. This gate proves a '
  + 'call path exists. It has no opinion on whether any caller reads the result.',
  'AN INVOCATION THAT IS NEITHER A STRING ARGUMENT NOR A MEMBER CALL — NOT '
  + 'DETECTED. Dispatch through a registry table, a route map, or a string built '
  + 'at runtime names the method where no literal argument or member callee '
  + 'carries it.',
  'A CALLER IN A FILE THAT IS NEITHER PRODUCT SOURCE NOR A TEST — OUT OF SCOPE. '
  + 'Docs, shell, and workflow files are never searched, so an RPC driven only '
  + 'from prose or a script reads as unreachable, loudly rather than quietly.',
];

if (import.meta.main) {
  const sources = readSources();
  const tests = readTests();
  const { declared, unreachable } = findUnreachable(sources, tests);

  // UPSTREAM OF BOTH WRITE PATHS, and covering all three denominators rather than
  // one. This was a bespoke `declared.length === 0` check sitting between the two
  // publications: it caught a broken decorator matcher and nothing else, so an
  // empty test corpus — which turns every RPC into "no caller anywhere" — and an
  // empty source corpus past the matcher were both invisible. The ratchet hides it
  // particularly well, because a lock of zero findings reads as a clean tree.
  const measured = assertMeasured('reachability', [
    ['product source files', sources.size],
    ['test files searched for callers', tests.size],
    ['@callable RPCs declared', declared.length],
  ]);

  if (process.argv.includes('--lock')) {
    const count = writeLock(unreachable.map(keyOf), LOCK);
    console.log(`reachability: locked ${count} unreachable over ${measured}`);
  } else {
    const detail = new Map(unreachable.map((e) => [keyOf(e), describe(e)]));
    const code = report(
      'reachability',
      reconcile(unreachable.map(keyOf), LOCK),
      detail,
      'bun scripts/reachability.ts --lock',
      measured,
    );
    if (code === 0) {
      for (const spot of BLIND_SPOTS) console.log(`  blind: ${spot}`);
    }
    process.exit(code);
  }
}
