/**
 * The set-equality gate: a gate may not select repository files by a criterion
 * of its own.
 *
 * WHY THERE IS A WHOLE GATE FOR THIS. On 2026-08-17 the same defect was found
 * fifteen times across six subsystems in one evening, and thirteen of the fifteen
 * were one mechanical shape: A GATE MEASURED ONE SET AND GOVERNED ANOTHER. Not a
 * competence problem — four of them were committed BY the change written to close
 * the previous one, and two were inside the advice about the others:
 *
 *   1. `capability-parity`'s live assertion scanned `packages` while `bun run
 *      lint` scanned the repo. The gap held three real sites in `scripts/`.
 *   2. `no-ambient-git-in-tests` matched `.test.` while the incoming eval tier
 *      is `.eval.`. Fixed by widening the rule, and then
 *   3. the gate's OWN denominator counted test files with a private copy of the
 *      pattern it had just widened: it would have certified 463 files while the
 *      rule governed 646.
 *   4. `bench-artifacts/` was absent from `SANDBOX_EXCLUDES`, so retention leaked
 *      sealed outcomes into every solver sandbox.
 *   5. `validation-diagnostics.json` — the only record of WHY a task is bad — was
 *      written into the swept run root.
 *   6. `computeGain` reported a neutral-looking gain over a denominator of two
 *      differing pairs whose significance floor was p = 0.5.
 *   7. `preflight`'s `SCRATCH_PREFIXES` listed three prefixes while seven leaked.
 *   8. `secret-scan` enumerated tracked files only, so a brand-new file's
 *      credential was invisible until it was already in history.
 *
 * And three more this gate's own premise found while it was being written, each
 * live at HEAD and each now fixed:
 *
 *   9. `schema-drift` enumerated `git ls-files 'packages/*'` + `/src/**` + `/*.ts`.
 *      Git's `**` needs an intervening directory, so it matched 454 of 616
 *      product files and every file sitting DIRECTLY in a `src/` was invisible —
 *      `actor-agent.ts` among them, the largest DDL surface in the repo, in a
 *      gate that reported drift-free over it for months.
 *  10. `typecheck-coverage` walked the filesystem matching `.test.ts` only, so
 *      `packages/pc-agent/tests` (`daemon.test.js`) was never required to be
 *      typechecked by anything.
 *  11. `ladder`'s denominator was a third spelling, `/\.test\.(ts|tsx|js)$/`, over
 *      a `Bun.spawnSync` whose exit code it never read: 474 files where the lint
 *      rule governs 661, and an empty corpus on any git failure.
 *
 * WHAT THIS ASSERTS. Outside `scripts/sources.ts`, a gate program may not
 *   (a) spawn `git ls-files`, nor
 *   (b) select files by a path-matching criterion of its own — a regex carrying a
 *       path separator or a source-extension anchor, or an `endsWith`/`startsWith`
 *       test against a source extension or a repository path prefix.
 * A gate needing a narrower set imports a NAMED PREDICATE from `sources.ts`
 * (`isProductSource`, `isRunnableSuite`, `isTestFile`, `isTestScaffold`,
 * `isTextSource`, `isParseable`) — so its measurement cannot drift narrower than
 * what it enforces, because there is only one set and one place to narrow it.
 *
 * It also asserts the third property, the one guarding every lock in this repo:
 *   (c) A CHECK THAT FAILS MUST NOT PUBLISH A NUMBER, and the measurement must sit
 *       UPSTREAM of every write path rather than among them. Mechanically: every
 *       `writeLock` and every `report` call must be preceded, in the same
 *       function, by `assertMeasured` — which throws on a zero denominator. A
 *       ratchet written before anything proved the corpus was non-empty is a
 *       published claim about a population nobody looked at, and it looks
 *       HEALTHIER when it is wrong: an empty scan locks zero findings.
 *
 * WHAT IT DOES NOT REACH, stated rather than implied, because a gate whose
 * governed set exceeds what it can mechanically see is this defect once more:
 *   - Sets that are not repository files. `SCRATCH_PREFIXES` (temp-directory
 *     names), `SANDBOX_EXCLUDES` (what not to copy into a solver sandbox) and
 *     artifact retention paths are the same defect in a domain no repository
 *     enumerator covers. Instances 4, 5 and 7 are out of reach here.
 *   - Statistical denominators. Instance 6 lives in `packages/core/src/bench/`,
 *     which owns and unit-tests that admissibility rule itself.
 *   - Grounding failures. Two of the fifteen were a claim relayed instead of
 *     read, with the file on disk the whole time. Nothing was measured too
 *     narrowly; no set-equality assertion reaches them.
 *   - Shell gate programs. Counted and reported below, never parsed.
 *
 * THE DENOMINATOR IS TAKEN FROM BOTH SIDES. `LADDER` and `deploy.sh` disagree by
 * design — `bun run verify:lean` is declared only by deploy.sh — so resolving
 * "every gate" from `LADDER` alone would certify 34 while governing 35 and commit
 * instance twelve inside the gate written to prevent one through eleven. This
 * reads the union and prints both counts.
 */

import { readFileSync } from 'node:fs';
import { LADDER, deployGates, packageScripts } from './ladder.ts';
import { assertMeasured, finding } from './gate-ratchet.ts';
import { isParseable, trackedFiles } from './sources.ts';
import {
  identifierCalleeName, identifierText, importedNames, memberCalleeName, moduleSpecifiers, parse,
  regexPattern, type SyntaxNode, walk,
} from './syntax.ts';

const root = new URL('..', import.meta.url).pathname;

/** The one enumerator, and therefore the one file allowed to discover paths. */
export const ENUMERATOR = 'scripts/sources.ts';

/** Where gate programs live. */
const GATE_DIRECTORIES = ['scripts/', 'tools/'];

/**
 * Calls that DISCOVER paths. This is the whole of the first assertion: a gate
 * program may filter the shared list however it likes — a `.startsWith` scope on
 * one package is a filter and can never be wider than the enumeration — but it
 * may not go and find files itself, because a second enumeration is a second
 * answer to "which files exist" and nothing compares the two.
 */
const DISCOVERY: ReadonlySet<string> = new Set([
  'readdirSync', 'readdir', 'opendirSync', 'opendir', 'globSync', 'glob',
]);

/**
 * Gate programs that enumerate something which is NOT this repository, each with
 * the reason. Declared rather than detected, because no repository enumerator can
 * serve them and pretending otherwise would be the defect in a new direction.
 * Pinned by equality: a stale entry fails this gate, so the list only shrinks.
 */
export const NON_REPOSITORY_SCANS = new Map<string, string>([
  [
    'scripts/preflight.ts',
    'reads the OS temp directory for leaked test scratch. Not a repository path, and the whole '
    + 'point is to see what git never will.',
  ],
  [
    'scripts/bench-sandbox.ts',
    'copies the tree into a solver sandbox and re-points `node_modules/@proteus/*` symlinks. '
    + '`git ls-files` does not list `node_modules`, so the set it needs is exactly the set no '
    + 'enumerator here can produce.',
  ],
]);

export type Kind = 'private-enumeration' | 'private-pattern' | 'unmeasured-publication'
  | 'stale-declaration';

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly kind: Kind;
  readonly detail: string;
}

/* ── The denominator ───────────────────────────────────────────────────── */

/**
 * Every gate command, from BOTH declarations, resolved through `bun run`.
 *
 * `bun run <key>` bodies are followed and split on `&&`, because a gate that is
 * one npm script naming six programs must contribute six, not one.
 */
export function gateCommands(): readonly string[] {
  const scripts = packageScripts();
  const resolve = (command: string, depth: number): string[] => {
    const words = command.trim().split(/\s+/).filter((w) => w.length > 0);
    const key = words[0] === 'bun' && words[1] === 'run' ? words[2] : undefined;
    const body = key === undefined ? undefined : scripts[key];
    if (body === undefined || depth >= 8) return [command.trim()];
    return body.split('&&').flatMap((part) => resolve(part, depth + 1));
  };
  const declared = [...LADDER.map((gate) => gate.run), ...deployGates()];
  return [...new Set(declared.flatMap((command) => resolve(command, 0)))];
}

/** A repo-relative file path token inside a resolved command. */
const FILE_TOKEN = /^(?:\.\/)?((?:scripts|tools|packages|tests)\/[\w./*-]+\.(?:tsx?|jsx?|mjs|cjs|sh))$/;

export interface Programs {
  /** Parseable gate programs, the set this gate governs. */
  readonly governed: readonly string[];
  /** Shell gate programs: counted, never parsed. */
  readonly shell: readonly string[];
  /** Suites a gate command runs with `bun test`. Not programs — a suite's corpus
   *  is the fixtures it builds — but the non-test `scripts/` modules they import
   *  ARE governed, which is how `ladder.ts` is reached. */
  readonly suites: readonly string[];
}

/**
 * The programs a gate command executes, expanded against the enumerated tree.
 *
 * A glob resolving to nothing is NOT silently dropped: it throws, because that is
 * exactly how the ci-tier bench gate came to fail in 0.1s while the same line
 * passed at deploy — one ran through a shell that expanded it and one did not.
 */
export function gatePrograms(commands: readonly string[], tracked: readonly string[]): Programs {
  const governed = new Set<string>();
  const shell = new Set<string>();
  const suites = new Set<string>();

  for (const command of commands) {
    const words = command.split(/\s+/).filter((w) => w.length > 0);
    const runner = words[0] === 'bun' && words[1] === 'test' ? 'suite' : 'program';
    for (const word of words.slice(1)) {
      const match = FILE_TOKEN.exec(word);
      if (match?.[1] === undefined) continue;
      const token = match[1];
      const matched = token.includes('*')
        ? tracked.filter((path) => globMatches(token, path))
        : tracked.filter((path) => path === token);
      if (matched.length === 0) {
        throw new Error(
          `gate-set-equality: \`${command}\` names \`${token}\`, which matches no enumerated file.`
          + ' A gate whose target resolves to nothing runs nothing and reports success.',
        );
      }
      for (const path of matched) {
        // `node --check packages/pc-agent/src/index.js` is a gate command naming a
        // PRODUCT file. Product code is what gates measure, never a gate, so the
        // governed set is bounded by where gate programs live.
        if (path.endsWith('.sh')) shell.add(path);
        else if (runner === 'suite') suites.add(path);
        else if (GATE_DIRECTORIES.some((dir) => path.startsWith(dir))) governed.add(path);
      }
    }
  }

  // The live-tree rule gates: `*.gate.test.ts` under tools/ assert over the whole
  // repository rather than over fixtures, so they carry a denominator and are
  // governed. `upstream.json` already names them `proteusRuleGates`.
  for (const path of suites) if (path.endsWith('.gate.test.ts')) governed.add(path);

  // A gate's enumeration may live in a module it imports, which is where
  // `ladder.ts`'s private pattern sat: reached from `ladder.test.ts`, a suite.
  // The closure is over non-test `scripts/` and `tools/` modules only.
  const frontier = [...governed, ...suites];
  const seen = new Set(frontier);
  while (frontier.length > 0) {
    const from = frontier.pop();
    if (from === undefined || !isParseable(from)) continue;
    for (const specifier of localImports(from)) {
      if (!GATE_DIRECTORIES.some((dir) => specifier.startsWith(dir))) continue;
      if (!tracked.includes(specifier)) continue;
      governed.add(specifier);
      if (seen.has(specifier)) continue;
      seen.add(specifier);
      frontier.push(specifier);
    }
  }

  // A suite's corpus is the fixtures it builds, so a suite is not a gate program.
  // The exception is the live-tree rule gates, which assert over the whole
  // repository and carry a denominator — `upstream.json` already names them
  // `proteusRuleGates`.
  for (const path of suites) governed.delete(path);
  for (const path of suites) if (path.endsWith('.gate.test.ts')) governed.add(path);
  return { governed: [...governed].sort(), shell: [...shell].sort(), suites: [...suites].sort() };
}

/** `bun test` accepts `*` within one path segment. */
function globMatches(token: string, path: string): boolean {
  const pattern = new RegExp(`^${token.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}$`);
  return pattern.test(path);
}

/** Repo-relative specifiers a file imports, `.js` rewritten to the `.ts` that
 *  exists — `bun` resolves both and two gates spell it each way. */
function localImports(file: string): string[] {
  const text = readFileSync(root + file, 'utf8');
  const dir = file.slice(0, file.lastIndexOf('/') + 1);
  const resolved: string[] = [];
  for (const specifier of moduleSpecifiers(parse(file, text).root)) {
    if (!specifier.startsWith('.')) continue;
    const parts = (dir + specifier).split('/');
    const stack: string[] = [];
    for (const part of parts) {
      if (part === '.' || part === '') continue;
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    resolved.push(stack.join('/').replace(/\.js$/, '.ts'));
  }
  return resolved;
}

/* ── The assertion ────────────────────────────────────────────────────── */

/**
 * Whether a regex is a FILENAME predicate — decided by running it on filenames
 * rather than by inspecting its source.
 *
 * Reading the source was the wrong instinct and it produced a noisy gate on the
 * first run: `\\/` called every URL route in `bench-inference-proxy.ts` a corpus
 * criterion, and an unanchored `.js` called `capability-parity`'s `./x.js -> .ts`
 * specifier rewrite one. A pattern that matches a source filename and matches no
 * ordinary string has exactly one meaning, and asking it is cheaper and more
 * honest than guessing from its bytes.
 */
const SELECTS = [
  'packages/core/src/index.ts', 'scripts/ladder.test.ts', 'packages/cf-backend/src/App.tsx',
  'packages/pc-agent/tests/daemon.test.js', 'tests/evals/delegation.eval.ts', 'tools/x.mjs',
];
const REJECTS = [
  'plain', 'PROTEUS_HOME', 'https://example.com/v1/models', '@cf/deepseek-ai/deepseek-v4-pro',
  'CREATE TABLE IF NOT EXISTS traces (', 'run_required_gate "Secret scan" bun scripts/x', '42',
];

function selectsFilenames(pattern: string): boolean {
  // No `try`. Every pattern here came from a regex literal oxc already parsed, so
  // a compile failure means this runtime disagrees with the parser about the
  // language — which must be loud, not a quiet `false` that reads as "not a
  // filename predicate" and passes the file.
  const probe = new RegExp(pattern);
  return SELECTS.some((path) => probe.test(path)) && !REJECTS.some((text) => probe.test(text));
}

/** Where a regex is USED as a single-path predicate. `.replace()` is specifier
 *  rewriting — `capability-parity` resolves `./x.js` to `./x.ts` that way and
 *  selects nothing by it — and `.matchAll()` scans CONTENT, which is how
 *  `platform-catalog` finds file mentions inside prose. Neither picks a corpus. */
const PREDICATE_METHODS: ReadonlySet<string> = new Set(['test', 'match']);

/** Enumeration methods on a `Glob`. Constructing one is not discovery —
 *  `ladder.ts` applies bunfig's own `pathIgnorePatterns` with `.match()`, which
 *  answers a question about ONE path and finds nothing. */
const GLOB_SCANS: ReadonlySet<string> = new Set(['scan', 'scanSync']);

/**
 * Every way a gate program can find or select repository files on its own
 * authority.
 *
 * Callers pass text rather than a path so the red demonstration can seed a gate
 * with a private enumeration without writing one into the tree.
 */
export function auditGateProgram(file: string, text: string): Violation[] {
  if (file === ENUMERATOR) return [];
  const declared = NON_REPOSITORY_SCANS.get(file);
  const found: Violation[] = [];
  const { root: tree, lineAt } = parse(file, text);
  const add = (node: SyntaxNode, kind: Kind, detail: string): void => {
    found.push({ file, line: lineAt(node.start), kind, detail });
  };
  let discoveries = 0;

  walk(tree, (node) => {
    const raw = node.raw;

    if (raw.type === 'Literal' && raw.value === 'ls-files' && isCallArgument(node)) {
      discoveries += 1;
      if (declared === undefined) {
        add(node, 'private-enumeration',
          'spawns `git ls-files` of its own. Import `trackedFiles` from sources.ts — this is the '
          + 'call that was tracked-only in secret-scan and exit-code-blind in ladder');
      }
      return;
    }

    if (raw.type === 'CallExpression') {
      const name = identifierCalleeName(node) ?? memberCalleeName(node);
      if (name !== undefined && DISCOVERY.has(name)) {
        discoveries += 1;
        if (declared === undefined) {
          add(node, 'private-enumeration',
            `walks the tree with \`${name}\` of its own. \`trackedFiles()\` is the enumeration; `
            + 'filter it — a filter can never be wider than the enumeration, a second walk can');
        }
        return;
      }
      if (name !== undefined && GLOB_SCANS.has(name) && receiverIsGlob(node)) {
        discoveries += 1;
        if (declared === undefined) {
          add(node, 'private-enumeration',
            'scans the tree with its own glob. `trackedFiles()` sees what git sees, which is what '
            + 'every other gate is measured against');
        }
        return;
      }
      const regex = name !== undefined && PREDICATE_METHODS.has(name)
        ? regexOperand(node)
        : undefined;
      if (regex !== undefined && selectsFilenames(regex)) {
        add(node, 'private-pattern',
          `selects files with its own \`/${regex}/\`. Import a named predicate from sources.ts: `
          + 'this is the shape that certified 463 files while the rule governed 646, and that '
          + 'counted 474 where the lint covers 661');
      }
    }
  });

  if (declared !== undefined && discoveries === 0) {
    found.push({
      file,
      line: 1,
      kind: 'stale-declaration',
      detail: 'is declared in NON_REPOSITORY_SCANS and no longer enumerates anything. Remove the '
        + 'entry — a stale exemption reads as a considered decision and silently excuses the next '
        + 'gate that happens to be spelled the same way',
    });
  }

  found.push(...unmeasuredPublications(file, tree, lineAt));
  return found.sort((a, b) => a.line - b.line);
}

/**
 * Whether `node` sits in the ARGUMENTS of a call, directly or inside an array
 * literal handed to one — `spawn('git', ['ls-files'])` in both spellings.
 *
 * This gate is itself a registered gate program, so the moment it was wired into
 * the ladder it reported its own detector: the string `'ls-files'` appears here as
 * the right operand of `===`. Position is the honest discriminator rather than an
 * exemption for this file — enumerating is something you CALL, and a comparison
 * against the name of a subcommand enumerates nothing. Exempting the gate from
 * its own rule would have been the defect one more time.
 */
function isCallArgument(node: SyntaxNode): boolean {
  let child = node;
  let parent = node.parent;
  while (parent !== undefined) {
    if (parent.raw.type === 'CallExpression' || parent.raw.type === 'NewExpression') {
      return parent.children[0] !== child;
    }
    if (parent.raw.type !== 'ArrayExpression') return false;
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/** The regex literal a predicate call reads: either its receiver (`RE.test(x)`)
 *  or its argument (`x.match(RE)`). */
function regexOperand(call: SyntaxNode): string | undefined {
  const callee = call.children[0];
  const receiver = callee?.raw.type === 'MemberExpression' ? callee.children[0] : undefined;
  for (const candidate of [receiver, call.children[1]]) {
    if (candidate === undefined) continue;
    const inline = regexPattern(candidate);
    if (inline !== undefined) return inline;
    const named = identifierText(candidate);
    if (named === undefined) continue;
    const bound = boundRegex(call, named);
    if (bound !== undefined) return bound;
  }
  return undefined;
}

/** The regex a name is bound to at module scope, so `RE.test(file)` is read the
 *  same as an inline literal — a constant is how every one of these was spelled. */
function boundRegex(from: SyntaxNode, name: string): string | undefined {
  let top: SyntaxNode = from;
  while (top.parent !== undefined) top = top.parent;
  let source: string | undefined;
  walk(top, (node) => {
    if (node.raw.type !== 'VariableDeclarator') return;
    const [id, init] = node.children;
    if (id === undefined || identifierText(id) !== name || init === undefined) return;
    source = regexPattern(init) ?? source;
  });
  return source;
}

/** `new Bun.Glob(…).scan()` and `new Glob(…).scan()`, distinguished from any
 *  other `.scan` in the tree. */
function receiverIsGlob(call: SyntaxNode): boolean {
  const callee = call.children[0];
  const receiver = callee?.raw.type === 'MemberExpression' ? callee.children[0] : undefined;
  if (receiver?.raw.type !== 'NewExpression') return false;
  const constructed = receiver.children[0];
  return constructed !== undefined && sourceName(constructed) === 'Glob';
}

/** `Bun.Glob` and `Glob` both read as `Glob` here. */
function sourceName(callee: SyntaxNode): string | undefined {
  const raw = callee.raw;
  if (raw.type === 'Identifier') return raw.name;
  if (raw.type === 'MemberExpression' && raw.property.type === 'Identifier') return raw.property.name;
  return undefined;
}

/** The ratchet module, and the publication calls it exports. */
const RATCHET = /\.\/gate-ratchet\.(?:ts|js)$/;
const PUBLISHERS: ReadonlySet<string> = new Set(['writeLock', 'report']);

/**
 * `assertMeasured` must precede every `writeLock` and every `report`.
 *
 * A ratchet written before anything proved the corpus non-empty publishes a number
 * about a population nobody looked at — and it publishes the HEALTHIEST possible
 * number, because an empty scan locks zero findings and a lock of zero reads as a
 * clean tree. `reachability.ts` had exactly this: `reconcile`, `report` and
 * `writeLock`, and a bespoke zero-check covering one of its three denominators.
 *
 * Only BARE calls to names this file imported FROM gate-ratchet count. The first
 * version matched by name alone and reported 38 findings that were all
 * `context.report(...)` — an oxlint rule emitting a diagnostic — plus
 * `platform-catalog`'s own local `report()` that renders markdown. A gate whose
 * first run is mostly noise trains people to ignore it, which is the one failure
 * mode worse than not having it.
 */
function unmeasuredPublications(
  file: string,
  tree: SyntaxNode,
  lineAt: (offset: number) => number,
): Violation[] {
  const fromRatchet = new Set(
    tree.children
      .filter((statement) => statement.raw.type === 'ImportDeclaration'
        && moduleSpecifiers(statement).some((spec) => RATCHET.test(spec)))
      .flatMap((statement) => importedNames(statement)),
  );
  if (fromRatchet.size === 0) return [];

  const measurements: number[] = [];
  const publications: { node: SyntaxNode; name: string }[] = [];
  walk(tree, (node) => {
    if (node.raw.type !== 'CallExpression') return;
    const name = identifierCalleeName(node);
    if (name === undefined || !fromRatchet.has(name)) return;
    if (name === 'assertMeasured') measurements.push(node.start);
    else if (PUBLISHERS.has(name)) publications.push({ node, name });
  });
  const earliest = measurements.length === 0 ? undefined : Math.min(...measurements);
  return publications
    .filter(({ node }) => earliest === undefined || node.start < earliest)
    .map(({ node, name }) => ({
      file,
      line: lineAt(node.start),
      kind: 'unmeasured-publication' as const,
      detail: `calls \`${name}\` with no \`assertMeasured\` upstream of it. A verdict or a lock `
        + 'written before the corpus was proved non-empty publishes the healthiest possible '
        + 'number about a population nobody looked at',
    }));
}

/* ── The verdict ──────────────────────────────────────────────────────── */

if (import.meta.main) {
  const tracked = trackedFiles();
  const commands = gateCommands();
  const programs = gatePrograms(commands, tracked);

  const violations = programs.governed
    .filter((file) => file !== ENUMERATOR)
    .flatMap((file) => auditGateProgram(file, readFileSync(root + file, 'utf8')));

  // Every count that could be silently zero. A resolver that matched no command,
  // a program set that came back empty, or a tree that enumerated nothing would
  // each make this gate report a clean sweep over nothing at all — which is the
  // defect it exists to refuse, one level up.
  const measured = assertMeasured('gate-set-equality', [
    ['LADDER entries', LADDER.length],
    ['deploy.sh required gates', deployGates().length],
    ['resolved gate commands', commands.length],
    ['gate programs governed', programs.governed.length],
    ['enumerated files', tracked.length],
  ]);

  const offending = new Set(violations.map((violation) => violation.file)).size;
  const clean = programs.governed.length - offending;

  for (const violation of violations) {
    console.error(finding({
      invariant: 'the set a gate measures is the set it governs: one enumeration, narrowed only '
        + `by a named predicate exported from ${ENUMERATOR}`,
      at: `${violation.file}:${String(violation.line)}`,
      found: violation.detail,
      silently: 'the gate reports green over a population narrower than the one it claims. Every '
        + 'file outside its private criterion is ungoverned and nothing says so — which is how '
        + 'three git spawns hid in scripts/, how 162 product files including actor-agent.ts were '
        + 'never examined for schema drift, and how a denominator certified 463 files while the '
        + 'rule governed 646',
      fix: `import the enumeration and a named predicate from ${ENUMERATOR}. If the narrower set `
        + 'is legitimate, ADD the predicate there and import it, so the one place that narrows is '
        + 'the one place anyone has to read',
    }));
  }

  console.log(
    `gate-set-equality: ${violations.length === 0 ? 'ok' : `${String(violations.length)} finding(s)`}`
    + ` — ${measured}, ${String(clean)} of ${String(programs.governed.length)} clean`
    + `, ${String(programs.shell.length)} shell program(s) out of reach`,
  );
  if (violations.length > 0) {
    console.error(
      `\n${String(offending)} gate program(s) select repository files on their own authority.`,
    );
  }
  process.exit(violations.length === 0 ? 0 : 1);
}
