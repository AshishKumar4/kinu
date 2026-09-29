/**
 * Error-model gate: how many of each legacy failure mechanism a product file may still hold, one
 * number per file and mechanism that only goes down.
 *
 * The target (docs/OBSERVABILITY.md) is one failure type, `KinuError`, in the Effect channel, with
 * `settle` in `packages/core/src/obs/effect.ts` as the boundary. The migration slices
 * remove what this counts, so each slice's commit shows its numbers falling and nothing grows while
 * they run:
 *
 *   throw              a `throw` statement
 *   catch              a `catch` clause
 *   promise-rejection  `.catch(…)`, `.then(onValue, onRejection)`, `Promise.reject(…)`
 *   result-literal     `ok: true|false` or `success: true|false` in an object literal
 *   result-type        `ok: true|false` or `success: true|false` in a type
 *   error-class        a class extending `Error`, directly or through another such class
 *
 * `scripts/error-model.lock.json` is keyed `path#mechanism`. A key above its number is red, and a
 * key the lock never held has a number of zero, so a new file starts clean. A key below its number
 * is green and printed stale; `--lock` then writes the lower number through `shrinkOnly`, which
 * never raises one. `DECLARED` names the boundary files and the mechanisms that are their job.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as v from 'valibot';

import { assertMeasured, finding, refuseLock, shrinkOnly, type LockRefusal, type LockedNumber } from './gate-ratchet';
import { readSources } from './sources';
import {
  declaredName, functionOwner, isFunctionLike, literalString, memberCalleeName, parse, superClassName, walk, type SyntaxNode,
} from './syntax';

const root = new URL('..', import.meta.url).pathname;

const LOCK = `${root}scripts/error-model.lock.json`;

export const MECHANISMS = ['throw', 'catch', 'promise-rejection', 'result-literal', 'result-type', 'error-class'] as const;

export type Mechanism = (typeof MECHANISMS)[number];

interface Declaration {
  readonly mechanisms: readonly Mechanism[];
  readonly reason: string;
}

/** Files whose mechanisms are the target model's boundary, not a legacy site. */
export const DECLARED = new Map<string, Declaration>([
  ['packages/core/src/obs/effect.ts', {
    mechanisms: MECHANISMS,
    reason: 'the one runner: `settle` rethrows the typed failure or the defect',
  }],
  ['packages/core/src/slates/content.ts', {
    mechanisms: ['throw'],
    reason: 'a vendored `ContentStore`: its failures are the vendored package\'s `AgentCoreError` codes, its contract',
  }],
  ['packages/core/src/slates/store.ts', {
    mechanisms: ['throw'],
    reason: 'a vendored `SlateStore`: its failures are the vendored package\'s `AgentCoreError` codes, its contract',
  }],
  ['packages/core/src/tools/outcome.ts', {
    mechanisms: ['result-literal', 'result-type'],
    reason: '`ToolOutcome`, the recorded outcome of a native tool invocation; `success` is its stored field',
  }],
]);

/** Where an effect is run for a host that owns the call, permanently: not a bridge. */
export const HOST_BOUNDARIES = new Map<string, string>([
  ['packages/core/src/execution/parent.ts', '`answerParentRpc` answers a fork over DO RPC and in the CLI: a platform-owned call'],
]);

const RUNNERS: readonly string[] = ['settle', 'settleSync'];

/** A module an `obs` runner is imported from: the adapter itself, its barrel, or the package roots re-exporting it. */
const isObsModule = (specifier: string): boolean =>
  /(^|\/)obs(\/(effect|index))?$/.test(specifier) || specifier === '@kinu.run/core' || specifier === '@kinu.run/core/obs';

/**
 * Bridges: a migrated function run at its own edge so its callers keep their signature, spelled
 * `return settle(…)` or `return settleSync(…)` with the runner imported from `obs`, inside an exported
 * function or a public class member. Each is removed when its callers' wave arrives; the migration
 * ends at zero. A runner returned anywhere else is a finding: a private helper must return the Effect.
 * One more edge is platform-owned: a `transactionSync(() => …)` callback, where only a synchronous throw
 * rolls the transaction back, so `settleSync(…)` as that callback's whole return is a bridge too.
 */
export interface BridgeCensus {
  readonly bridges: string[];
  /** A runner returned from a private helper or a local function: not a bridge, a mistake. */
  readonly findings: string[];
}

export function bridgeSites(sources: ReadonlyMap<string, string>): BridgeCensus {
  const bridges: string[] = [];
  const findings: string[] = [];

  for (const [file, text] of sources) {
    if (file === 'packages/core/src/obs/effect.ts' || HOST_BOUNDARIES.has(file)) continue;
    const parsed = parse(file, text);
    const runners = new Set<string>();
    const syncRunners = new Set<string>();

    walk(parsed.root, (node) => {
      const { raw } = node;

      if (raw.type !== 'ImportDeclaration' || !isObsModule(raw.source.value)) return;

      for (const specifier of raw.specifiers) {
        if (specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' && RUNNERS.includes(specifier.imported.name)) {
          runners.add(specifier.local.name);

          if (specifier.imported.name === 'settleSync') syncRunners.add(specifier.local.name);
        }
      }
    });

    if (runners.size === 0) continue;

    walk(parsed.root, (node) => {
      const { raw } = node;

      if (raw.type !== 'CallExpression' || raw.callee.type !== 'Identifier' || !runners.has(raw.callee.name)) return;
      const site = `${file}:${String(parsed.lineAt(node.start))}`;
      // `return settle(…)`, `return await settle(…)`, or an arrow whose whole body is the call: the edge, spelled short.
      const awaited = node.parent?.raw.type === 'AwaitExpression' ? node.parent : node;
      const holder = awaited.parent;
      const returned = holder !== undefined && (holder.raw.type === 'ReturnStatement' || arrowBody(holder.raw) === awaited.raw);

      if (!returned) {
        findings.push(`${site}: a runner called mid-body; the effect is run once, at the edge, as its return`);

        return;
      }

      if (syncRunners.has(raw.callee.name) && isTransactionCallback(holder.raw.type === 'ReturnStatement' ? holder : { parent: holder })) {
        bridges.push(site);

        return;
      }

      const owner = bridgeOwner(holder.raw.type === 'ReturnStatement' ? holder : { parent: holder });

      if (owner === null) findings.push(`${site}: a runner returned outside an exported function or public member`);
      else bridges.push(site);
    });
  }

  return { bridges: bridges.sort(), findings: findings.sort() };
}

/**
 * The exported function or public member a return statement belongs to; null for any other owner. A
 * callback or an object method written inside an exported function's body is that function's code, so
 * a runner returned there (a seam method on the object it builds) counts; one inside a private helper
 * or a local function does not.
 */
function bridgeOwner(statement: Pick<SyntaxNode, 'parent'>): SyntaxNode | null {
  let node: SyntaxNode | undefined = statement.parent;

  while (node !== undefined && !isFunctionLike(node)) node = node.parent;

  if (node === undefined) return null;
  const owner = functionOwner(node);
  const { raw } = owner;

  if (raw.type === 'MethodDefinition') return isPublicMember(raw) ? owner : null;

  if (raw.type === 'FunctionDeclaration') return owner.parent?.raw.type === 'ExportNamedDeclaration' ? owner : null;

  // An object held by a class field (a seam table) is that field's surface.
  const field = owner.parent?.raw.type === 'Property' ? owner.parent.parent?.parent : owner.parent?.parent;

  if (field?.raw.type === 'PropertyDefinition') return isPublicMember(field.raw) ? owner : null;

  // A variable-bound function is exported with its declaration; anything else (a callback, an object
  // method, a function expression) belongs to the function that encloses it.
  const declaration = owner.parent?.parent;

  if (raw.type === 'ArrowFunctionExpression' && declaration?.raw.type === 'VariableDeclaration') {
    return declaration.parent?.raw.type === 'ExportNamedDeclaration' ? owner : null;
  }

  return owner.parent === undefined ? null : bridgeOwner(owner);
}

/** Whether the return belongs directly to a function passed as `transactionSync`'s argument. */
function isTransactionCallback(statement: Pick<SyntaxNode, 'parent'>): boolean {
  let node: SyntaxNode | undefined = statement.parent;

  while (node !== undefined && !isFunctionLike(node)) node = node.parent;
  const call = node?.parent;

  if (node === undefined || call?.raw.type !== 'CallExpression' || !call.raw.arguments.some((argument) => argument === node.raw)) return false;
  const { callee } = call.raw;

  if (callee.type === 'Identifier') return callee.name === 'transactionSync';

  return callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'transactionSync';
}

const arrowBody = (raw: SyntaxNode['raw']): SyntaxNode['raw'] | null =>
  raw.type === 'ArrowFunctionExpression' && raw.body.type !== 'BlockStatement' ? raw.body : null;

const isPublicMember = (member: { accessibility?: string | null; key: { type: string } }): boolean =>
  member.accessibility !== 'private' && member.accessibility !== 'protected' && member.key.type !== 'PrivateIdentifier';

/** Built-in error constructors a class can extend; `KinuError` extends `Data.TaggedError(...)`. */
const ERROR_BASES: readonly string[] = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AggregateError', 'DOMException', 'KinuError'];

const RESULT_KEYS: readonly string[] = ['ok', 'success'];

const isResultKey = (node: SyntaxNode): boolean => RESULT_KEYS.includes(declaredName(node) ?? literalKey(node) ?? '');

function literalKey(node: SyntaxNode): string | undefined {
  const { raw } = node;

  return raw.type === 'Property' || raw.type === 'TSPropertySignature' ? literalString(raw.key) : undefined;
}

function mechanismOf(node: SyntaxNode): Mechanism | undefined {
  const { raw } = node;

  if (raw.type === 'ThrowStatement') return 'throw';

  if (raw.type === 'CatchClause') return 'catch';

  if (raw.type === 'CallExpression' && raw.callee.type === 'MemberExpression') {
    const { object } = raw.callee;
    const name = memberCalleeName(node);
    // `Effect.catch(…)` is the target model's own handler, not a promise rejection.
    const onEffect = object.type === 'Identifier' && object.name === 'Effect';
    const onPromise = object.type === 'Identifier' && object.name === 'Promise';

    if (!onEffect && (name === 'catch' || (name === 'then' && raw.arguments.length === 2))) return 'promise-rejection';

    return onPromise && name === 'reject' ? 'promise-rejection' : undefined;
  }

  if (raw.type === 'Property' && node.parent?.raw.type === 'ObjectExpression' && isResultKey(node)) {
    return raw.value.type === 'Literal' && (raw.value.value === true || raw.value.value === false) ? 'result-literal' : undefined;
  }

  if (raw.type === 'TSPropertySignature' && isResultKey(node)) {
    const annotation = raw.typeAnnotation?.typeAnnotation;

    if (annotation?.type !== 'TSLiteralType' || annotation.literal.type !== 'Literal') return undefined;

    return annotation.literal.value === true || annotation.literal.value === false ? 'result-type' : undefined;
  }

  return undefined;
}

/** Sites per `path#mechanism`, declared boundary mechanisms left out. */
export function measure(sources: ReadonlyMap<string, string>): LockedNumber[] {
  const counts = new Map<string, number>();
  const classes: { readonly file: string; readonly name: string | undefined; readonly base: string }[] = [];

  const count = (file: string, mechanism: Mechanism): void => {
    if (DECLARED.get(file)?.mechanisms.includes(mechanism) === true) return;
    const key = `${file}#${mechanism}`;

    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  for (const [file, text] of sources) {
    walk(parse(file, text).root, (node) => {
      const base = superClassName(node);

      if (base !== undefined) classes.push({ file, name: declaredName(node), base });
      const mechanism = mechanismOf(node);

      if (mechanism !== undefined) count(file, mechanism);
    });
  }

  const errorish = new Set(ERROR_BASES);

  for (let grew = true; grew;) {
    grew = false;

    for (const { name, base } of classes) {
      if (name === undefined || errorish.has(name) || !errorish.has(base)) continue;
      errorish.add(name);
      grew = true;
    }
  }

  for (const { file, base } of classes) if (errorish.has(base)) count(file, 'error-class');

  return [...counts].map(([key, value]) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key));
}

const LockSchema = v.object({
  measuredAt: v.pipe(v.string(), v.minLength(1)),
  counts: v.record(v.string(), v.pipe(v.number(), v.integer(), v.minValue(1))),
});

export type ErrorModelLock = v.InferOutput<typeof LockSchema>;

export interface Verdict {
  /** Keys above their locked number; `was` is absent for a key the lock never held. */
  readonly over: readonly LockRefusal[];
  /** Keys below their locked number; `now` is 0 for a key that is gone. */
  readonly stale: readonly { readonly key: string; readonly was: number; readonly now: number }[];
}

export function judge(measured: readonly LockedNumber[], lock: ErrorModelLock): Verdict {
  const held = new Map(Object.entries(lock.counts));
  const present = new Map(measured.map(({ key, value }) => [key, value]));

  return {
    over: measured.flatMap(({ key, value }) => {
      const was = held.get(key);

      return value > (was ?? 0) ? [{ key, was, now: value }] : [];
    }),
    stale: [...held].flatMap(([key, was]) => {
      const now = present.get(key) ?? 0;

      return now < was ? [{ key, was, now }] : [];
    }),
  };
}

/** What `--lock` may write, or the keys that refused it. */
export interface Lowered {
  readonly lock: ErrorModelLock | undefined;
  readonly refusals: readonly LockRefusal[];
}

/** What `--lock` may write over `previous`: every key at the lower of its two numbers, none raised. */
export function lower(previous: ErrorModelLock, measured: readonly LockedNumber[], measuredAt: string): Lowered {
  const held = Object.entries(previous.counts).map(([key, value]) => ({ key, value }));
  const { merged, refusals } = shrinkOnly(held, measured);

  return {
    refusals,
    lock: refusals.length > 0 ? undefined : { measuredAt, counts: Object.fromEntries(merged.map(({ key, value }) => [key, value])) },
  };
}

/** What this gate cannot see, printed on the green path. */
export const BLIND_SPOTS: readonly string[] = [
  'A FAILURE SPELLED AS A STRING STATUS — NOT COUNTED. `status: \'failed\'` and `kind: \'error\'` are also '
  + 'real domain states, so a union discriminated by a word is left to review.',
  'A RETURNED `{ error }` WITH NO `ok` FIELD — NOT COUNTED. It is a failure value by convention only.',
  'TESTS, SCRIPTS AND TOOLS — OUT OF SCOPE. The corpus is product source (`readSources`).',
  'A MECHANISM MOVED INTO A DECLARED FILE — NOT DETECTED. `DECLARED` is read by review, one reason per file.',
  'A BRIDGE SPELLED ANOTHER WAY — NOT COUNTED. A runner result stored and returned later, or a runner '
  + 'called outside a `return`, is not the bridge shape; review keeps bridges to the one spelling.',
  'A DELETED LOCK — REFUSED. With no lock on disk the gate is red; the first lock is written with '
  + '`--init`, which only a reviewer should see in a diff.',
];

function readLockFile(): ErrorModelLock | undefined {
  return existsSync(LOCK) ? v.parse(LockSchema, JSON.parse(readFileSync(LOCK, 'utf8'))) : undefined;
}

function writeLockFile(lock: ErrorModelLock): void {
  writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
}

if (import.meta.main) {
  const sources = readSources();
  const measured = measure(sources);
  const total = measured.reduce((sum, { value }) => sum + value, 0);

  const summary = assertMeasured('error-model', [
    ['product source files', sources.size],
    ['path#mechanism keys', measured.length],
    ['legacy sites', total],
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const previous = readLockFile();

  if (process.argv.includes('--init')) {
    if (previous !== undefined) {
      console.error('error-model: a lock exists; `--init` records only the first one. Use `--lock`.');
      process.exit(1);
    }

    writeLockFile({ measuredAt: today, counts: Object.fromEntries(measured.map(({ key, value }) => [key, value])) });
    console.log(`error-model: recorded the first lock, ${String(total)} sites over ${summary}`);
    process.exit(0);
  }

  if (previous === undefined) {
    console.error('error-model: no lock is recorded; nothing can be held to a number.');
    process.exit(1);
  }

  if (process.argv.includes('--lock')) {
    const { lock, refusals } = lower(previous, measured, today);

    if (lock === undefined) process.exit(refuseLock('error-model', refusals, 'move the failure into the Effect channel'));
    writeLockFile(lock);
    console.log(`error-model: locked ${String(Object.keys(lock.counts).length)} key(s), ${String(total)} sites over ${summary}`);
    process.exit(0);
  }

  const verdict = judge(measured, previous);

  if (verdict.over.length > 0) {
    console.error(`error-model: ${String(verdict.over.length)} key(s) above their locked number\n`);

    for (const { key, was, now } of verdict.over) {
      console.error(finding({
        at: key,
        invariant: 'a product file holds no more of a legacy failure mechanism than the lock records',
        found: `${String(now)}, ${was === undefined ? 'and the lock holds none for this file' : `locked at ${String(was)}`}`,
        silently: 'a second failure convention grows beside the one being migrated to, and the migration '
          + 'never finishes because each slice lands on a larger tree than it measured',
        fix: 'fail with `KinuError` in an effect and cross the boundary with `settle` '
          + '(packages/core/src/obs/effect.ts); `--lock` never raises a number',
      }));
    }

    process.exit(1);
  }

  const misplaced = bridgeSites(sources).findings;

  if (misplaced.length > 0) {
    console.error(`error-model: ${String(misplaced.length)} runner(s) returned outside a bridge\n`);

    for (const site of misplaced) {
      console.error(finding({
        at: site,
        invariant: 'an effect is run only at an exported function or public member, the bridge its callers see',
        found: 'a runner returned from a private helper or a local function',
        silently: 'the helper reads as migrated while its callers still get a thrown failure, and the bridge count '
          + 'names a site no caller wave will remove',
        fix: 'return the Effect from the helper and run it once at the exported edge',
      }));
    }

    process.exit(1);
  }

  const byMechanism = MECHANISMS.map((mechanism) => {
    const sites = measured.filter(({ key }) => key.endsWith(`#${mechanism}`)).reduce((sum, { value }) => sum + value, 0);

    return `${mechanism} ${String(sites)}`;
  });

  console.log(`error-model: ok — ${String(total)} legacy sites (${byMechanism.join(', ')}), none above the lock `
    + `(locked ${previous.measuredAt}), over ${summary}`);

  for (const { key, was, now } of verdict.stale) {
    console.log(`  stale: ${key} locked at ${String(was)}, now ${String(now)}; \`bun scripts/error-model.ts --lock\` lowers it`);
  }

  for (const [file, { mechanisms, reason }] of DECLARED) {
    console.log(`  declared: ${file} (${mechanisms.join(', ')}): ${reason}`);
  }

  const { bridges, findings } = bridgeSites(sources);

  console.log(`  bridges: ${String(bridges.length)} (the migration ends at zero)`);

  for (const site of bridges) console.log(`    ${site}`);

  for (const wrong of findings) console.log(`  finding: ${wrong}`);

  for (const [file, reason] of HOST_BOUNDARIES) console.log(`  host boundary: ${file}: ${reason}`);

  for (const spot of BLIND_SPOTS) console.log(`  blind: ${spot}`);
}
