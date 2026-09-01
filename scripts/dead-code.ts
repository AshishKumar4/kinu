/**
 * Dead-code gate — "correct, wired, dead", the signature defect of this repo.
 *
 * The recorded instances all typecheck and all read as finished work:
 * `runCraftedToolGepa` exported with no caller, `ensureActorSchema` written to
 * deduplicate table setup and referenced only from its own test, `skills invoke`
 * a no-op, six workspace settings with readers and no writers. A plain
 * unused-export check reports the second one CLEAN, because a test does
 * reference it — and that is the one that mattered, since it was written
 * precisely to be used by production and never was.
 *
 * So this gate reports four classes and keeps them apart:
 *   test-only         — production never reaches it; only a test does. The
 *                       `ensureActorSchema` case. Wire it, or delete it and its
 *                       test.
 *   unreferenced      — nothing anywhere reaches it. The `runCraftedToolGepa`
 *                       case.
 *   unreachable-file  — no entry point reaches the FILE, so none of its exports
 *                       is reported individually. Found by seeding a probe the
 *                       first two classes both missed.
 *   unused-dependency — a MANIFEST declaration no file that manifest serves
 *                       imports. The class the other three structurally cannot
 *                       see, because a package nobody imports is not in the
 *                       module graph they reason about — and the one that
 *                       reaches production hardest: every declaration is
 *                       installed, resolved and AUDITED. `shell-quote` was
 *                       carried here for a quadratic `parse()` no tracked
 *                       source calls, behind a live advisory the security
 *                       scanner had to accept by name.
 *
 * knip answers the first three, and is used rather than hand-rolled
 * reachability: its `--production` mode drops test files from the entry set, so
 * a symbol reported in production mode but NOT in the default mode is reached
 * only by tests. That set difference IS the classification. Two knip runs, no
 * reference resolver of our own.
 *
 * The FOURTH is derived here instead, and the reason is measured rather than
 * stylistic. knip's dependency pass reported `vitest-evals` unused on this tree
 * — `tests/evals-artifact-contract.ts` imports it, but knip's root `entry` is
 * `scripts/*.ts!`, top level only, so the eval suites are outside its globs and
 * their imports do not count. Deleting on that answer would have broken the
 * eval tier. The census below reads the manifests and the tracked corpus
 * directly, and `dead-code.test.ts` joins the two answers so the difference
 * stays a stated, single, explained row rather than a silent divergence.
 *
 * The deletion this class bought on 2026-09-01: thirteen declarations across
 * four manifests, and one advisory row that had to be REWRITTEN rather than
 * removed — `shell-quote` stayed in the graph underneath, through
 * `@opentui/react -> react-devtools-core`, which is the fact the old reason
 * ("removing the unused declaration would remove this entry") got wrong.
 *
 * Scope, and why each exclusion is a scope statement rather than an allowlist:
 *   - `packages/*​/src` only. `scripts/` and `tools/` are entry-point programs
 *     whose helpers legitimately have one caller or a test; `packages/*​/tests`
 *     and all of `packages/test-utils` exist to serve tests, so production
 *     reaching none of it is the design, not a defect.
 *   - Declarations only, never `export … from …`. Measured on this tree: 51 of
 *     64 raw symbol findings were barrel re-export lines whose underlying symbol
 *     is live and used through a deeper import. Reporting those as dead code is
 *     a 4:1 noise ratio over the defect this gate exists to catch, and an unused
 *     barrel entry is surface bloat, not dead logic.
 *
 * Two entry points are declared in the `knip` config because no tool can see
 * them: `cf-backend/src/gallery.tsx` is a second vite build, and
 * `cli-backend/src/branch-worker.ts` is spawned by path via `child_process.fork`
 * from `branch-process.ts`. Those are entry points, not exemptions.
 *
 * The cf-backend test glob is declared there too, for a different and
 * sharper reason: that workspace has TWO test runners. knip auto-detects
 * `vitest.config.ts` and adopts its `include` — `tests/workerd` only — as the
 * whole test entry set, which drops the 113 bun suites from the dev-mode run.
 * Every export whose sole reference is one of those suites then moves from
 * `test-only` to `unreferenced`. Measured: adding the vitest config and nothing
 * else turned this gate red on `isSealedCredential` and `setWorkspaceTier`,
 * while ALSO reporting the recorded `(test-only)` entries for the same two
 * symbols as no longer reproducing — a classification flip, not a real finding.
 *
 * The blind spot, worth knowing before trusting a green run: reachability is a
 * whole-repo union, so a symbol still referenced by ONE backend reads as live
 * even when the other backend dropped the wire. That is the "X never worked on
 * Y backend" class, and it has a confirmed live instance: `execute_tools` passed
 * no description at all to `@cloudflare/codemode` on cf-backend, so the model
 * received the vendor's generic "Execute code to achieve a goal." instead of
 * `BUILTIN_TOOL_SPECS.execute_tools` — while the CLI kept
 * `BUILTIN_TOOL_DESCRIPTIONS.execute_tools` referenced, which is exactly what
 * kept this gate quiet. Closing it needs per-backend reachability (one
 * production entry set per backend, then a diff), not a wider scope here.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as v from 'valibot';

import { assertMeasured, finding, reconcile, report, writeLock } from './gate-ratchet';
import { parseJsonc } from './jsonc';
import {
  isDocument, isLockfile, isManifest, isParseable, isProductSource, isStylesheet,
  isTestScaffold, isTextSource, trackedFiles,
} from './sources';
import {
  declarationOf, declaredBindings, declaredName, exportedLocalNames, importedNames,
  isReExport, parse,
} from './syntax';

const root = new URL('..', import.meta.url).pathname;
const LOCK = `${root}scripts/dead-code.lock.json`;

/** knip's candidates, narrowed to what this gate governs. Both halves are named
 *  imports: this file carried a byte-identical second copy of `PRODUCT_SOURCE`
 *  and its own `packages/test-utils/` prefix, so its scope could drift from
 *  every other gate's without anything going red. */
export const inScope = (file: string): boolean =>
  isProductSource(file) && !isTestScaffold(file);

export type DeadClass = 'test-only' | 'unreferenced';

export interface DeadExport {
  readonly file: string;
  readonly name: string;
  readonly line: number;
  readonly kind: DeadClass;
}

/** knip's report is external tool output, so it is parsed rather than asserted. */
const KnipExportSchema = v.object({ name: v.string(), line: v.number() });
const KnipReportSchema = v.object({
  issues: v.optional(v.array(v.object({
    file: v.string(),
    exports: v.optional(v.array(KnipExportSchema), []),
    types: v.optional(v.array(KnipExportSchema), []),
    nsExports: v.optional(v.array(KnipExportSchema), []),
    nsTypes: v.optional(v.array(KnipExportSchema), []),
    files: v.optional(v.array(v.object({ name: v.string() })), []),
  })), []),
});

type KnipExport = v.InferOutput<typeof KnipExportSchema>;

export interface KnipFindings {
  readonly symbols: ReadonlyMap<string, readonly KnipExport[]>;
  readonly files: readonly string[];
}

/** Names DECLARED in this file and exported from it, whether the `export` sits
 *  on the declaration or in a later `export { … }`. A specifier naming an
 *  imported symbol is a re-export and is not included — that rule is what took
 *  this gate from 64 raw findings to 13, because 51 were barrel re-export lines
 *  whose symbol is live somewhere else. */
export function exportedDeclarations(file: string, text: string): Set<string> {
  const declared = new Set<string>();
  const imported = new Set<string>();
  const exportedHere = new Set<string>();
  const specifiers = new Set<string>();

  for (const statement of parse(file, text).root.children) {
    for (const name of importedNames(statement)) imported.add(name);
    if (statement.type === 'ImportDeclaration') continue;
    // `export … from '…'` never declares anything here.
    if (isReExport(statement)) continue;
    for (const name of exportedLocalNames(statement)) specifiers.add(name);

    const { node, exported } = declarationOf(statement);
    if (node.type === 'VariableDeclaration') {
      for (const name of declaredBindings(node, false)) declared.add(name);
      if (exported) for (const name of declaredBindings(node, true)) exportedHere.add(name);
      continue;
    }
    const name = declaredName(node);
    if (name !== undefined) {
      declared.add(name);
      if (exported) exportedHere.add(name);
    }
  }

  for (const name of specifiers) {
    if (declared.has(name) && !imported.has(name)) exportedHere.add(name);
  }
  return exportedHere;
}

function knip(production: boolean): KnipFindings {
  const args = [
    '--no-progress',
    '--include', 'exports,types,nsExports,nsTypes,files',
    '--reporter', 'json',
    ...(production ? ['--production'] : []),
  ];
  const run = spawnSync(`${root}node_modules/.bin/knip`, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // knip exits 1 when it has findings, which is the normal case here.
  if (run.error !== undefined) throw run.error;
  if (run.stdout.length === 0) {
    throw new Error(`knip produced no report (exit ${String(run.status)}): ${run.stderr}`);
  }
  const parsed = v.parse(KnipReportSchema, JSON.parse(run.stdout));
  const symbols = new Map<string, KnipExport[]>();
  const files: string[] = [];
  for (const entry of parsed.issues) {
    const all = [...entry.exports, ...entry.types, ...entry.nsExports, ...entry.nsTypes];
    if (all.length > 0) symbols.set(entry.file, all);
    for (const f of entry.files) files.push(f.name);
  }
  return { symbols, files };
}

export function classify(
  productionOnly: ReadonlyMap<string, readonly KnipExport[]>,
  everywhere: ReadonlyMap<string, readonly KnipExport[]>,
  read: (file: string) => string,
): DeadExport[] {
  const unreferenced = new Set<string>();
  for (const [file, names] of everywhere) {
    for (const e of names) unreferenced.add(`${file}#${e.name}`);
  }
  const found: DeadExport[] = [];
  for (const [file, names] of productionOnly) {
    if (!inScope(file)) continue;
    const declarations = exportedDeclarations(file, read(file));
    for (const e of names) {
      if (!declarations.has(e.name)) continue;
      found.push({
        file,
        name: e.name,
        line: e.line,
        kind: unreferenced.has(`${file}#${e.name}`) ? 'unreferenced' : 'test-only',
      });
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

export const keyOf = (d: DeadExport): string => `${d.file}#${d.name} (${d.kind})`;

/* ── Declared and imported by nothing ─────────────────────────────────── */

/**
 * A manifest declaration no file that manifest serves ever imports.
 *
 * THE THIRD DEAD THING, and the one the other two structurally cannot see:
 * knip's export and file analysis reasons about the module graph, and a
 * dependency nobody imports is not IN the module graph. It reaches production
 * anyway — every declaration is installed, audited, and for a Worker bundle,
 * resolvable — so `shell-quote` sat in this tree behind a live advisory that
 * `scripts/security-scanner.ts` had to accept, for a quadratic `parse()` no
 * tracked source calls.
 *
 * DERIVED HERE RATHER THAN TAKEN FROM knip, for the reason the whole suite
 * exists: a tool's answer is a candidate, and this one is checkable against the
 * tree directly. `dead-code.test.ts` runs knip's own `dependencies` pass over
 * the same manifests and joins the two, so the derivation stays measured
 * against a second implementation rather than trusted. The join is not an
 * equality: on this tree knip additionally reports `vitest-evals`, which
 * `tests/evals-artifact-contract.test.ts:62` imports — knip's root `entry` is
 * `scripts/*.ts!`, top level only, so the eval suites are outside its entry
 * globs. A census that had simply adopted knip's answer would have deleted a
 * declaration the eval tier needs.
 */
export interface DeadDependency {
  readonly manifest: string;
  readonly name: string;
  readonly kind: 'dependency' | 'devDependency';
}

const ManifestSchema = v.object({
  dependencies: v.optional(v.record(v.string(), v.string()), {}),
  devDependencies: v.optional(v.record(v.string(), v.string()), {}),
});

/**
 * The files one manifest's declaration can serve.
 *
 * The ROOT manifest serves the whole tree, and that is a fact about this
 * repository rather than a convenience: `bunfig.toml` sets `linker = "hoisted"`,
 * so an undeclared import in any package resolves against the root's own
 * `node_modules`. `packages/core/src/providers/anthropic.ts:10` imports
 * `@ai-sdk/anthropic` while `packages/core/package.json` declares nothing of
 * the sort, and it is the ROOT pin that makes that work. A workspace manifest
 * serves its own directory only, so "unused here" stays a statement about that
 * package instead of about the tree.
 */
export const servedBy = (manifest: string): ((file: string) => boolean) => {
  if (manifest === 'package.json') return () => true;
  const directory = manifest.slice(0, -'package.json'.length);
  return (file) => file.startsWith(directory);
};

/** `@types/node` and `@ai-sdk/openai` carry characters a regex reads. */
const escaped = (name: string): string => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Every spelling one declaration can be referenced by. */
export interface ReferenceForms {
  /** Module specifiers that resolve to it. */
  readonly specifiers: readonly string[];
  /** Words a shell line or a manifest script can invoke it as. */
  readonly commands: readonly string[];
}

/**
 * The runtime package a `@types/…` declaration types.
 *
 * NOTHING EVER IMPORTS AN AMBIENT TYPE PACKAGE. `@types/node` is loaded by the
 * compiler, not by a specifier, so a census counting import forms reports every
 * one of them as unused — which is both wrong and unfixable by the reader. What
 * makes such a declaration load-bearing is that the runtime it describes is
 * used, so that is what gets searched. The rule keeps its teeth in the case
 * that matters: `@types/minimist` was dead here precisely BECAUSE `minimist`
 * was, and both rows reported.
 *
 * `@types/foo__bar` is DefinitelyTyped's spelling of `@foo/bar`.
 */
export function typedRuntime(name: string): string | undefined {
  if (!name.startsWith('@types/')) return undefined;
  const rest = name.slice('@types/'.length);
  const [scope, scoped] = rest.split('__');
  return scoped === undefined ? rest : `@${scope}/${scoped}`;
}

/**
 * Whether `text` REFERENCES a package, by the form its own file type can carry
 * — not whether it mentions the words.
 *
 * The distinction is the census's whole accuracy. `packages/core/src/usage.ts:126`
 * says `workers-ai-provider` is installed and NOT used for chat inference; a
 * name-mention sweep reads that sentence as a use and the declaration survives
 * forever behind its own documentation. So a `.ts` counts an import form —
 * including one that names the installed path, which is how cf-backend's suites
 * reach `node_modules/@nimbus-sh/worker/dist/session/rpc.js`, a package that
 * publishes no subpath for it — or a SPAWN of the package's installed binary,
 * which is the only reference `knip` has: `scripts/dead-code.ts` runs
 * `node_modules/.bin/knip` and imports nothing. A `.json` counts a quoted value
 * (a plugin named in `.oxlintrc.json`, a binding in `wrangler.jsonc`), a `.sh`
 * or a workflow counts a command word (`bunx puppeteer browsers install chrome`
 * is the only reference `puppeteer` has, and `tsc` is the only one `typescript`
 * has), and a `.css` counts an at-rule (`@import "@cloudflare/kumo/styles/…"`).
 * A `.md` counts nothing: prose about a package is not a use of it.
 */
export function referencesPackage(file: string, text: string, forms: ReferenceForms): boolean {
  // `node:fs` is a reference to `node`, so the separator admits a colon.
  const subpath = `(?:[:/][^'"\`\\s]*)?`;
  const specifiers = forms.specifiers.map(escaped);
  const commands = forms.commands.map(escaped);
  const spawnsBinary = commands.some((c) => new RegExp(`node_modules/\\.bin/${c}\\b`).test(text));
  if (isParseable(file)) {
    return spawnsBinary || specifiers.some((n) => new RegExp(
      `(?:from|import|require)\\s*\\(?\\s*['"\`](?:[^'"\`]*node_modules/)?${n}${subpath}['"\`]`,
    ).test(text));
  }
  if (isStylesheet(file)) {
    return specifiers.some((n) => new RegExp(`@[a-z]+\\s+['"]${n}${subpath}['"]`).test(text));
  }
  // Configuration: a text source that is neither code nor prose.
  if (isTextSource(file) && !isDocument(file)) {
    return spawnsBinary
      || specifiers.some((n) => new RegExp(`['"]${n}${subpath}['"]`).test(text))
      || commands.some((c) => new RegExp(`(?:^|[\\s;&|("'])${c}(?:[\\s;&|)"']|$)`, 'm').test(text));
  }
  return false;
}

/**
 * What the resolved graph says about each installed package: the command words
 * it installs, and the packages it PEER-REQUIRES.
 *
 * READ FROM `bun.lock`, which is a tracked file, rather than by walking
 * `node_modules`. Three consequences, and the first is the one that made the
 * gate's own meta-check fail before: a walk is a second enumeration, and this
 * repository allows exactly one. It also means the census answers the same way
 * in a fresh clone with nothing installed, and that it reads the graph the
 * installer RESOLVED rather than whatever a shared, symlinked `node_modules`
 * happens to hold — this branch runs in a worktree whose modules are the main
 * checkout's.
 */
export interface Installed {
  /** Command names, from the package's own `bin` map. */
  readonly binaries: ReadonlyMap<string, readonly string[]>;
  /** `package -> the installed packages that peer-require it`. */
  readonly peerRequirers: ReadonlyMap<string, readonly string[]>;
}

/** One `bun.lock` package row: `[specifier, registry, metadata, integrity]`.
 *  A workspace link is a one-element row and carries no metadata. */
const LockMeta = v.looseObject({
  bin: v.optional(v.union([v.string(), v.record(v.string(), v.string())])),
  peerDependencies: v.optional(v.record(v.string(), v.string()), {}),
});
const LockSchema = v.looseObject({
  packages: v.optional(v.record(v.string(), v.array(v.unknown())), {}),
});

export function readInstalled(lockText: string): Installed {
  const lock = parseJsonc(lockText, LockSchema, 'bun.lock');
  const binaries = new Map<string, readonly string[]>();
  const peerRequirers = new Map<string, string[]>();
  for (const [name, row] of Object.entries(lock.packages)) {
    const parsed = v.safeParse(LockMeta, row[2]);
    if (!parsed.success) continue;
    const named = v.safeParse(v.record(v.string(), v.string()), parsed.output.bin);
    const single = v.safeParse(v.string(), parsed.output.bin);
    if (named.success) binaries.set(name, Object.keys(named.output));
    else if (single.success) binaries.set(name, [name.split('/').at(-1) ?? name]);
    for (const peer of Object.keys(parsed.output.peerDependencies)) {
      peerRequirers.set(peer, [...(peerRequirers.get(peer) ?? []), name]);
    }
  }
  return { binaries, peerRequirers };
}

/**
 * The part of a manifest that can REFERENCE a package: the commands in its
 * `scripts`.
 *
 * A manifest is both the declaration under question and a genuine reference
 * site — `"lint": "oxlint ."` is the only mention `oxlint` has in this
 * repository, and dropping manifests from the corpus would report the whole
 * toolchain as dead. Reading them WHOLE is the opposite failure: a package
 * declared in two manifests then finds itself in the other one and neither row
 * is ever reported, which was exactly `workers-ai-provider`'s shape here (root
 * and `packages/cf-backend`, both unused, both now deleted).
 *
 * `scripts` rather than "everything except the declaration blocks", because
 * that is what the eleven manifests in this tree actually hold: their only
 * non-standard fields are the root's `knip` block (entry GLOBS), `overrides`
 * and `patchedDependencies` (declarations, and an override is not a use), and
 * two `bin` maps naming local paths. A manifest field that named a package some
 * other way would make this census OVER-report, which surfaces as a finding a
 * reader triages rather than as a deletion nobody noticed.
 */
export function manifestCommands(text: string): string {
  const parsed = v.safeParse(
    v.object({ scripts: v.optional(v.record(v.string(), v.string()), {}) }),
    JSON.parse(text),
  );
  return parsed.success ? Object.values(parsed.output.scripts).join('\n') : '';
}

/** Every declaration in every manifest, against every file that manifest
 *  serves. `files` is the enumeration; `read` supplies text; `binaries` names
 *  the command words a package installs; `peers` names the installed packages
 *  that peer-require a given name. */
export function unusedDependencies(
  manifests: readonly string[],
  files: readonly string[],
  read: (file: string) => string,
  binaries: (name: string) => readonly string[],
  peers: (name: string) => readonly string[],
): DeadDependency[] {
  const corpus = files.filter((file) => (isTextSource(file) || isStylesheet(file))
    && !isLockfile(file));
  const found: DeadDependency[] = [];
  for (const manifest of manifests) {
    const declared = v.parse(ManifestSchema, JSON.parse(read(manifest)));
    const here = new Set([
      ...Object.keys(declared.dependencies), ...Object.keys(declared.devDependencies),
    ]);
    const serves = servedBy(manifest);
    // A manifest is read WITHOUT its declaration blocks, and as a `.json`
    // whatever its path: the file name carries the format, and every manifest
    // in the corpus is one.
    const reachable = corpus.filter(serves).map((file) => ({
      file: isManifest(file) ? 'manifest.json' : file,
      text: isManifest(file) ? manifestCommands(read(file)) : read(file),
    }));
    for (const [kind, block] of [
      ['dependency', declared.dependencies], ['devDependency', declared.devDependencies],
    ] as const) {
      for (const name of Object.keys(block)) {
        // A peer contract this manifest opted into is a reference: it declared
        // the requirer, and the requirer will not resolve without this line.
        if (peers(name).some((requirer) => here.has(requirer))) continue;
        const runtime = typedRuntime(name);
        const forms: ReferenceForms = {
          specifiers: runtime === undefined ? [name] : [name, runtime],
          commands: [name, ...binaries(name)],
        };
        const used = reachable.some((entry) => referencesPackage(entry.file, entry.text, forms));
        if (!used) found.push({ manifest, name, kind });
      }
    }
  }
  return found.sort((a, b) => a.manifest.localeCompare(b.manifest) || a.name.localeCompare(b.name));
}

export const dependencyKeyOf = (d: DeadDependency): string =>
  `${d.manifest}#${d.name} (unused-${d.kind})`;

/**
 * Why a locked dependency row is not deleted, one reason per key.
 *
 * A dependency finding is unlike an export finding: the export can be deleted
 * by whoever reads the gate, and a declaration often cannot, because the reason
 * it survives lives OUTSIDE the manifest that declares it. Every row here is a
 * phantom-resolution fact — hoisting, or a type-only import from a package that
 * declares nothing — and a bare lock entry would record the finding while
 * losing the only thing that makes it acceptable.
 *
 * Enforced in BOTH directions below: a locked dependency row with no reason
 * fails the gate, and a reason naming a row that no longer reproduces fails it
 * too. That is what stops this table becoming the allowlist every other gate
 * here exists to avoid.
 */
export const DEPENDENCY_REASONS = {
  'packages/cf-backend/package.json#@ai-sdk/anthropic (unused-dependency)':
    'a REDUNDANT DUPLICATE of the root pin, not dead. The importers are '
    + 'packages/core (providers/anthropic.ts:10, llm.ts:10) and they declare nothing — '
    + 'bunfig.toml\'s hoisted linker resolves them against the root manifest, so it is '
    + 'the root pin that is load-bearing. No cf-backend file imports it. Deleting this '
    + 'line is a version-pin decision, not a dead-code one.',
  'packages/cf-backend/package.json#@ai-sdk/openai (unused-dependency)':
    'the same redundant duplicate: packages/core/src/providers/openai.ts:8 and '
    + 'packages/cli-backend/src/opencode-provider.ts:17 import it through the root pin, '
    + 'and no cf-backend file imports it.',
  'packages/devbox/package.json#@cloudflare/containers (unused-dependency)':
    'declared HERE and imported from cf-backend — packages/cf-backend/src/egress/'
    + 'outbound.ts:53 type-imports it while cf-backend declares nothing, so this '
    + 'declaration is what hoisting resolves that import against. devbox itself never '
    + 'imports it (its chain is KinuSandbox -> Devbox -> Sandbox from @cloudflare/sandbox), '
    + 'and the root override pinning 0.3.7 hangs off @cloudflare/sandbox\'s own ^0.3.5 '
    + 'edge, enforced by scripts/nested-container-resolution.test.ts:573.',
} satisfies Record<string, string>;

/** The recorded reason for one dependency row, or `undefined` when the row is
 *  unreasoned. A lookup rather than an index because the table keeps its literal
 *  key type: a key that is not in it is a fact this gate reports, never a
 *  widening of the table's own contract. */
export function dependencyReason(key: string): string | undefined {
  return Object.entries(DEPENDENCY_REASONS).find(([recorded]) => recorded === key)?.[1];
}

if (import.meta.main) {
  const production = knip(true);
  const everywhere = knip(false);
  const read = (file: string): string => readFileSync(root + file, 'utf8');
  const symbols = classify(production.symbols, everywhere.symbols, read);
  const files = production.files.filter(inScope).sort();

  const tracked = trackedFiles();
  const manifests = tracked.filter(isManifest);
  const installed = readInstalled(read(tracked.filter(isLockfile)[0] ?? 'bun.lock'));
  const dependencies = unusedDependencies(
    manifests, tracked, read,
    (name) => installed.binaries.get(name) ?? [],
    (name) => installed.peerRequirers.get(name) ?? [],
  );

  // Both knip runs, the declaration parser and the dependency census have to
  // have done work. A knip misconfiguration that analyses nothing, a parser
  // that returns no declarations, or an enumeration listing no manifest would
  // each filter every candidate away and report a clean tree.
  const declarations = [...production.symbols.keys()].filter(inScope)
    .reduce((n, file) => n + exportedDeclarations(file, read(file)).size, 0);
  const declaredPackages = manifests.reduce((n, manifest) => {
    const parsed = v.parse(ManifestSchema, JSON.parse(read(manifest)));
    return n + Object.keys(parsed.dependencies).length + Object.keys(parsed.devDependencies).length;
  }, 0);
  const measured = assertMeasured('dead-code', [
    ['candidate files from knip', production.symbols.size],
    ['references seen in dev mode', everywhere.symbols.size],
    ['exported declarations parsed', declarations],
    ['manifests read', manifests.length],
    ['package declarations examined', declaredPackages],
  ]);

  const detail = new Map<string, string>();
  for (const d of symbols) {
    detail.set(keyOf(d), `  ${d.file}:${d.line} ${d.name} — ${d.kind === 'test-only'
      ? 'exported and referenced only by tests; wire it or delete it with its test'
      : 'exported and referenced nowhere'}`);
  }
  for (const f of files) {
    detail.set(`${f} (unreachable-file)`, `  ${f} — no entry point reaches this file at all`);
  }
  for (const d of dependencies) {
    const key = dependencyKeyOf(d);
    const reason = dependencyReason(key);
    detail.set(key, `  ${d.manifest} declares ${d.name} and no file it serves imports it`
      + `${reason === undefined ? '' : `\n    kept because: ${reason}`}`);
  }
  const keys = [...detail.keys()];

  if (process.argv.includes('--lock')) {
    console.log(`dead-code: locked ${writeLock(keys, LOCK)} finding(s) over ${measured}`);
    process.exit(0);
  }

  // A locked dependency row states that a declaration nothing imports may stay,
  // which is a claim about resolution somewhere else in the tree. Unreasoned it
  // is an allowlist entry; reasoned in one direction only it is an allowlist
  // entry that outlives its row. Both directions, so neither can rot.
  const ratchet = reconcile(keys, LOCK);
  const isNew = new Set(ratchet.added);
  const unreasoned = dependencies.map(dependencyKeyOf)
    .filter((key) => !isNew.has(key) && dependencyReason(key) === undefined);
  const orphaned = Object.keys(DEPENDENCY_REASONS).filter((key) => !detail.has(key));
  const faults = [
    ...unreasoned.map((key) => finding({
      at: key,
      invariant: 'a locked dependency row carries the resolution fact that keeps it',
      found: 'the row is locked and DEPENDENCY_REASONS says nothing about it',
      silently: 'the row becomes an allowlist entry nobody can re-decide, and the next '
        + 'reader cannot tell an accepted phantom resolution from forgotten debt',
      fix: 'add the fact to DEPENDENCY_REASONS in scripts/dead-code.ts, or delete the '
        + 'declaration',
    })),
    ...orphaned.map((key) => finding({
      at: key,
      invariant: 'every DEPENDENCY_REASONS entry names a row that still reproduces',
      found: 'the declaration was deleted, or something now imports it',
      silently: 'the reason describes a tree that no longer exists, and the next unused '
        + 'declaration of that name inherits an argument written for a different one',
      fix: 'delete the entry from DEPENDENCY_REASONS in scripts/dead-code.ts',
    })),
  ];
  if (faults.length > 0) {
    console.error(`dead-code: ${faults.length} reason fault(s)\n`);
    for (const fault of faults) console.error(fault);
  }

  const verdict = report(
    'dead-code', ratchet, detail, 'bun scripts/dead-code.ts --lock', measured,
  );
  process.exit(faults.length > 0 ? 1 : verdict);
}
