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
 * So this gate reports three classes and keeps them apart:
 *   test-only         — production never reaches it; only a test does. The
 *                       `ensureActorSchema` case. Wire it, or delete it and its
 *                       test.
 *   unreferenced      — nothing anywhere reaches it. The `runCraftedToolGepa`
 *                       case.
 *   unreachable-file  — no entry point reaches the FILE, so none of its exports
 *                       is reported individually. Found by seeding a probe the
 *                       first two classes both missed.
 *
 * knip answers all three, and is used rather than hand-rolled reachability: its
 * `--production` mode drops test files from the entry set, so a symbol reported
 * in production mode but NOT in the default mode is reached only by tests. That
 * set difference IS the classification. Two knip runs, no reference resolver of
 * our own.
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

import { assertMeasured, reconcile, report, writeLock } from './gate-ratchet.ts';
import { isProductSource, isTestScaffold } from './sources.ts';
import {
  declarationOf, declaredBindings, declaredName, exportedLocalNames, importedNames,
  isReExport, parse,
} from './syntax.ts';

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

if (import.meta.main) {
  const production = knip(true);
  const everywhere = knip(false);
  const read = (file: string): string => readFileSync(root + file, 'utf8');
  const symbols = classify(production.symbols, everywhere.symbols, read);
  const files = production.files.filter(inScope).sort();

  // Both knip runs and the declaration parser have to have done work. A knip
  // misconfiguration that analyses nothing, or a parser that returns no
  // declarations, would filter every candidate away and report a clean tree.
  const declarations = [...production.symbols.keys()].filter(inScope)
    .reduce((n, file) => n + exportedDeclarations(file, read(file)).size, 0);
  const measured = assertMeasured('dead-code', [
    ['candidate files from knip', production.symbols.size],
    ['references seen in dev mode', everywhere.symbols.size],
    ['exported declarations parsed', declarations],
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
  const keys = [...detail.keys()];

  if (process.argv.includes('--lock')) {
    console.log(`dead-code: locked ${writeLock(keys, LOCK)} finding(s) over ${measured}`);
  } else {
    process.exit(report(
      'dead-code', reconcile(keys, LOCK), detail, 'bun scripts/dead-code.ts --lock', measured,
    ));
  }
}
