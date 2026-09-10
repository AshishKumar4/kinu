/**
 * The undeclared-import gate: a package may not import what its own manifest
 * never declares.
 *
 * THE OTHER DIRECTION. `gate:dead-code` runs a dependency census and catches a
 * MANIFEST DECLARATION nothing imports — it deleted thirteen such declarations
 * across four manifests on 2026-09-01. The mirror defect is structurally
 * invisible to it, because the census walks declarations and an undeclared edge
 * is not one: a package imports a name, `bunfig.toml`'s `linker = "hoisted"`
 * resolves it against the root `node_modules`, every suite passes, and no
 * manifest ever learns. Measured at 8af794001: `packages/cli-backend` imported
 * `@kinu.run/test-utils` from thirty-two test files — the
 * `workspace-resolution.test.ts` AGENTS.md mandates among them — behind a
 * manifest with no `devDependencies` at all. Nothing in the tree said so. The
 * lock had recorded the edge before any manifest declared it, and a human
 * reading a lock diff is what found it.
 *
 * WHY IT IS NOT TIDINESS. Three consequences, none of which show up as a red
 * suite on the tree that introduced them:
 *   - The edge resolves by hoisting, so it survives exactly as long as the hoist
 *     does. Whoever changes a root pin, drops a root declaration or flips the
 *     linker breaks a package that never asked for anything.
 *   - `scripts/deploy.sh` installs with `--frozen-lockfile`. What ships is
 *     whatever the lock happens to carry for reasons no manifest states.
 *   - The declaration is the only machine-readable record of the edge. A
 *     package with an empty `devDependencies` reads as a package with no test
 *     dependencies, and every tool that believes it — a publish, a prune, a
 *     per-package install — is wrong about a package it was told the truth
 *     about nowhere.
 *
 * WHAT COUNTS AS DECLARED, and the one subtlety in it. A specifier is declared
 * when the manifest that OWNS the importing file names it in `dependencies`,
 * `devDependencies`, `peerDependencies` or `optionalDependencies` — that
 * manifest and no other. The root manifest is deliberately not a fallback: "the
 * root declares it" is the precise statement of the defect, not a defence
 * against it, and admitting it would make this gate blind to the case it was
 * written for. The root gets one thing the others do not: its `workspaces`
 * globs declare the members they match, which is how a root-served file under
 * `scripts/` or `tests/` may import `@kinu.run/core` without a second
 * declaration saying the same thing.
 *
 * NOT FINDINGS, because none of them is a package: a Node builtin, a
 * scheme-qualified runtime module (`bun:test`, `cloudflare:workers`), a
 * relative path, a `#private` subpath import, the importing package's own name,
 * and a specifier claimed by a path alias the package's own tsconfig declares
 * (`@/…` in cf-backend, which resolves to its own `src/`).
 *
 * KEYED PER EDGE, not per import site. `packages/core` imports `valibot` from
 * 246 files and that is ONE missing manifest line; keying by file would put 246
 * rows in the lock and call a moved file a new violation.
 *
 * A RATCHET, for the reason `gate-ratchet.ts` states: this finds real
 * violations on today's tree that its own commit cannot fix. Every locked row
 * is an edge that resolves only through hoisting today; the lock's only legal
 * direction is smaller, and a row that stops reproducing FAILS, so a repair
 * cannot be quietly retained as budget for the next one.
 */

import { isBuiltin } from 'node:module';
import * as v from 'valibot';
import { assertMeasured, reconcile, report, writeLock } from './gate-ratchet';
import { parseJsonc } from './jsonc';
import { isManifest, isParseable, isTypescriptConfig, readMatching } from './sources';
import { moduleSpecifiers, parse } from './syntax';

const root = new URL('..', import.meta.url).pathname;
const LOCK = `${root}scripts/undeclared-imports.lock.json`;

export const GATE = 'undeclared-imports';

/** Every field of a manifest that DECLARES a runtime or build-time edge.
 *  `optionalDependencies` is here with the three obvious ones because it is a
 *  declaration site npm and Bun both honour: leaving it out would manufacture a
 *  finding against a package that had declared its dependency correctly. */
const DECLARATION_FIELDS = [
  'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies',
] as const;

const DependencyMap = v.optional(v.record(v.string(), v.string()), {});

/** A manifest, in the two dimensions this gate reads: what it declares, and —
 *  for the workspace root alone — which member directories it claims. */
const ManifestSchema = v.object({
  name: v.optional(v.string()),
  workspaces: v.optional(v.array(v.string()), []),
  dependencies: DependencyMap,
  devDependencies: DependencyMap,
  peerDependencies: DependencyMap,
  optionalDependencies: DependencyMap,
});

/** tsconfig is JSONC — `tsc` accepts comments and this tree writes them. Bun's
 *  own JSONC grammar reads it, so a documented `paths` block is not a crash. */
const TsconfigSchema = v.object({
  compilerOptions: v.optional(v.object({
    paths: v.optional(v.record(v.string(), v.array(v.string())), {}),
  }), {}),
});

/** One workspace package, as the two questions this gate asks of it. */
export interface OwningPackage {
  /** Repo-relative manifest path. */
  readonly manifest: string;
  /** Its directory with a trailing slash; `''` for the workspace root, which
   *  therefore owns every file no nearer manifest claims. */
  readonly directory: string;
  /** Its own name, which it may always import. */
  readonly name: string | undefined;
  /** Every package name this manifest declares, by any of the four fields or by
   *  a `workspaces` glob. */
  readonly declared: ReadonlySet<string>;
  /** Specifier prefixes its own tsconfig `paths` claims, longest first. */
  readonly aliases: readonly string[];
}

/** Whether a `workspaces` glob claims a directory. Bun's patterns are
 *  path-segment globs (`packages/*`), so `*` spans one segment and `**` spans
 *  the rest — matched segment-wise rather than by building a regex, because a
 *  regex over paths is the shape `gate:set-equality` exists to refuse. */
export function workspaceGlobMatches(pattern: string, directory: string): boolean {
  const wanted = pattern.split('/');
  const actual = directory.split('/');
  for (let i = 0; i < wanted.length; i += 1) {
    if (wanted[i] === '**') return true;
    if (i >= actual.length) return false;
    if (wanted[i] !== '*' && wanted[i] !== actual[i]) return false;
  }
  return wanted.length === actual.length;
}

/** The specifier prefixes a tsconfig `paths` block claims. A `paths` key is a
 *  pattern (`@/*`), and everything before its `*` is the prefix a specifier
 *  must carry to be resolved by it rather than by `node_modules`. */
export function aliasPrefixes(tsconfig: string): string[] {
  const { compilerOptions } = parseJsonc(tsconfig, TsconfigSchema, 'tsconfig.json');
  return Object.keys(compilerOptions.paths)
    .map((pattern) => (pattern.includes('*') ? pattern.slice(0, pattern.indexOf('*')) : pattern))
    .sort((a, b) => b.length - a.length);
}

/**
 * Whether a specifier names a PACKAGE — something resolution looks for in
 * `node_modules` and a manifest therefore has to declare.
 *
 * Everything excluded here is excluded because it resolves somewhere else: a
 * relative or absolute path against the filesystem, a `#name` against the
 * manifest's own `imports` map, and a scheme-qualified specifier against the
 * runtime (`node:fs`, `bun:test`, `cloudflare:workers`). A bare builtin
 * (`fs`, `path`) is the same module without the scheme.
 */
export function isPackageSpecifier(specifier: string): boolean {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return false;
  const scheme = specifier.indexOf(':');
  const subpath = specifier.indexOf('/');
  if (scheme >= 0 && (subpath < 0 || scheme < subpath)) return false;
  return !isBuiltin(specifier);
}

/** The package a specifier resolves to: the scope and name for a scoped
 *  package, the first segment otherwise. `ai/mcp-stdio` is `ai`. */
export function packageOf(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0] ?? specifier;
}

/** The manifest that owns a file: the nearest one above it, which is the root
 *  for anything outside a package. Nearest rather than "any that could serve
 *  it" — a declaration in a manifest two levels up is precisely the hoisting
 *  this gate reports. */
export function ownerOf(file: string, packages: readonly OwningPackage[]): OwningPackage | undefined {
  let owner: OwningPackage | undefined;
  for (const candidate of packages) {
    if (!file.startsWith(candidate.directory)) continue;
    if (owner === undefined || candidate.directory.length > owner.directory.length) owner = candidate;
  }
  return owner;
}

/** One package importing one name its own manifest does not declare. */
export interface UndeclaredImport {
  readonly manifest: string;
  readonly name: string;
  /** Every file of that package that imports it, sorted. */
  readonly importers: readonly string[];
}

export const keyOf = (edge: UndeclaredImport): string => `${edge.manifest} imports ${edge.name}`;

/** How many importers a finding names before it stops listing them. Enough to
 *  see whether an edge is one stray import or the package's whole test suite,
 *  short enough that 246 files do not become 246 lines of failure output. */
const NAMED_IMPORTERS = 3;

export function describe(edge: UndeclaredImport): string {
  const shown = edge.importers.slice(0, NAMED_IMPORTERS);
  const rest = edge.importers.length - shown.length;
  return `  ${edge.manifest} does not declare ${edge.name}, and ${String(edge.importers.length)} `
    + `of its file(s) import it\n    ${shown.join('\n    ')}`
    + `${rest > 0 ? `\n    …and ${String(rest)} more` : ''}`;
}

/** What the whole gate measures, so a caller can count it before publishing. */
export interface Census {
  readonly edges: readonly UndeclaredImport[];
  /** Module specifiers seen, of any shape. */
  readonly specifiers: number;
  /** Of those, the ones that name a package and were judged. */
  readonly examined: number;
}

/**
 * Every undeclared edge in a tree, over the packages and the sources given.
 *
 * `sources` is `file -> text`, materialised by the caller from the one
 * enumeration; nothing here discovers a path.
 */
export function census(
  packages: readonly OwningPackage[],
  sources: ReadonlyMap<string, string>,
): Census {
  const importers = new Map<string, { readonly edge: UndeclaredImport; readonly files: Set<string> }>();
  let specifiers = 0;
  let examined = 0;

  for (const [file, text] of sources) {
    const owner = ownerOf(file, packages);
    if (owner === undefined) continue;
    for (const specifier of moduleSpecifiers(parse(file, text).root)) {
      specifiers += 1;
      if (!isPackageSpecifier(specifier)) continue;
      if (owner.aliases.some((prefix) => specifier.startsWith(prefix))) continue;
      examined += 1;
      const name = packageOf(specifier);
      if (name === owner.name || owner.declared.has(name)) continue;
      const edge: UndeclaredImport = { manifest: owner.manifest, name, importers: [] };
      const key = keyOf(edge);
      let row = importers.get(key);
      if (row === undefined) {
        row = { edge, files: new Set<string>() };
        importers.set(key, row);
      }
      row.files.add(file);
    }
  }

  return {
    edges: [...importers.values()]
      .map(({ edge, files }) => ({ ...edge, importers: [...files].sort() }))
      .sort((a, b) => keyOf(a).localeCompare(keyOf(b))),
    specifiers,
    examined,
  };
}

/**
 * Read the workspace from its manifests: what each declares, what the root's
 * `workspaces` globs claim, and the path aliases each package's own tsconfig
 * carries.
 */
export function readPackages(
  manifests: ReadonlyMap<string, string>,
  tsconfigOf: (directory: string) => string | undefined,
): OwningPackage[] {
  const parsed = [...manifests].map(([manifest, text]) => ({
    manifest,
    directory: manifest.slice(0, -'package.json'.length),
    parsed: v.parse(ManifestSchema, JSON.parse(text)),
  }));

  return parsed.map(({ manifest, directory, parsed: own }) => {
    const declared = new Set(DECLARATION_FIELDS.flatMap((field) => Object.keys(own[field])));
    for (const member of parsed) {
      // `directory` carries a trailing slash and the root's is empty, so the
      // root never claims itself as one of its own members.
      const at = member.directory.slice(0, -1);
      if (member.parsed.name === undefined || at.length === 0) continue;
      if (own.workspaces.some((pattern) => workspaceGlobMatches(pattern, at))) {
        declared.add(member.parsed.name);
      }
    }
    const tsconfig = tsconfigOf(directory);
    return {
      manifest,
      directory,
      name: own.name,
      declared,
      aliases: tsconfig === undefined ? [] : aliasPrefixes(tsconfig),
    };
  });
}

/**
 * What this gate cannot see, printed on the GREEN path. A limitation visible
 * only in red output is invisible exactly when the tree is clean, which is when
 * somebody decides how far to trust the signal.
 */
export const BLIND_SPOTS: readonly string[] = [
  'COMPUTED SPECIFIERS — NOT DETECTED. It reads import FORMS, so `await import(name)` '
  + 'over a variable, and a `require()` in the CommonJS daemon, name no package here. '
  + 'The same residual `gate:dead-code` states from the other direction.',
  'VERSION RANGES — NOT COMPARED. A declaration is judged present, never correct: a '
  + 'package declared at a range the lock does not satisfy reads as declared, and '
  + '`bun install --frozen-lockfile` at deploy is what would report it.',
  'NON-IMPORT REFERENCE FORMS — OUT OF SCOPE. A CSS `@import`, a binary a manifest '
  + 'script spawns, and an ambient `@types/…` the compiler loads by `types` rather than '
  + 'by a specifier are all real edges this gate never reads.',
  'THE OPPOSITE DIRECTION — OWNED ELSEWHERE. A declaration nothing imports is '
  + '`gate:dead-code`\'s dependency census, and neither gate reports the other\'s class.',
];

if (import.meta.main) {
  const manifests = readMatching(isManifest);
  const sources = readMatching(isParseable);
  const tsconfigs = readMatching(isTypescriptConfig);
  const packages = readPackages(manifests, (directory) => tsconfigs.get(`${directory}tsconfig.json`));
  const found = census(packages, sources);

  // Every count that could be silently zero. An enumeration that listed no
  // manifest, a corpus that read no source, or a parser returning no specifiers
  // would each report a clean tree over a population nobody looked at — and the
  // ratchet hides that particularly well, because an empty scan locks nothing.
  const declarations = packages.reduce((n, pkg) => n + pkg.declared.size, 0);
  const measured = assertMeasured(GATE, [
    ['manifests read', manifests.size],
    ['source files parsed', sources.size],
    ['module specifiers seen', found.specifiers],
    ['package specifiers examined', found.examined],
    ['declarations read', declarations],
  ]);

  const detail = new Map(found.edges.map((edge) => [keyOf(edge), describe(edge)]));
  const keys = [...detail.keys()];

  if (process.argv.includes('--lock')) {
    console.log(`${GATE}: locked ${String(writeLock(keys, LOCK))} edge(s) over ${measured}`);
    process.exit(0);
  }

  const code = report(
    GATE, reconcile(keys, LOCK), detail, 'bun scripts/undeclared-imports.ts --lock', measured,
  );
  if (code === 0) {
    console.log(`  ${String(keys.length)} locked edge(s) still resolve only through hoisting`);
    for (const spot of BLIND_SPOTS) console.log(`  blind: ${spot}`);
  }
  process.exit(code);
}
