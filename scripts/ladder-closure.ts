/**
 * A gate's input closure: every file, environment name and tool whose change
 * could change the gate's verdict — DERIVED from the command, never listed.
 *
 * The closure is what the ladder's cache hashes (`scripts/ladder-cache.ts`).
 * A gate is skipped only when the hash of this closure matches a recorded
 * green run, so the closure erring narrow is a stale green shipped, and
 * erring wide is a gate re-run. Every rule below errs wide.
 *
 * What a command's closure holds:
 *   - `bun test …`: the files bun would execute (resolved by the same
 *     `claims()` the tier is measured with), the preload `bunfig.toml` names,
 *     and the transitive module graph from all of them through
 *     `scripts/import-graph.ts` — value, type and text edges alike, a data
 *     asset as a hashed leaf, a workspace package the walker cannot enter as
 *     every tracked file under it.
 *   - `bun scripts/<gate>.ts`, `node <file>`: that file's graph.
 *   - `bun run <name>`: the script body from `package.json`, one word form at
 *     a time; `tsc --noEmit -p` and `oxlint` read the whole corpus.
 *   - `vitest run --root R dir/`: the selected suites' graphs plus every
 *     tracked file under `R/`, because the workers pool loads the Worker the
 *     wrangler config names, which no import edge carries.
 *   - Any graph that reaches `scripts/sources.ts` reads the corpus, so the
 *     closure is every tracked file. A corpus gate re-runs on any change.
 *   - Every `package.json`, `tsconfig.json` and `bunfig.toml` on the path of a
 *     closure file; `bun.lock` and `patches/` standing in for `node_modules`.
 *   - The row's declared `reads`, expanded against the tracked corpus, and
 *     the row's declared `env` names beside every literal `process.env.NAME`
 *     the graph carries.
 *
 * What makes a closure UNCOMPUTABLE, and therefore the gate never cached:
 *   - a shell gate or a word form this resolver does not understand;
 *   - a computed `import(expr)` or `require(expr)` anywhere in the graph;
 *   - a local import that resolves to no file;
 *   - a file in the graph that reads by path (`node:fs`, `child_process`,
 *     `Bun.file`, `Bun.spawn`, …) while the row declares no `reads`. The
 *     declaration may be empty — that is the author saying "the walker sees
 *     everything I open" — and `--audit-closure` is how that claim is checked
 *     against what the gate really opens.
 *   - a declared read matching no tracked file: a stale declaration.
 *
 * A row declared `live` never reaches this module's derivation at all: its
 * closure is the network, a deployed build, a clock or a credential, none of
 * which a hash over the tree can stand for.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { moduleEdges, readAliases, readWorkspace, resolveSpecifier, walkModules } from './import-graph';
import type { Alias, PackageDir } from './import-graph';
import { enumerateRepository, isManifest, isParseable, isTypescriptConfig, readRepositoryFile } from './sources';
import type { Node } from 'oxc-parser';
import { literalString, parse, walk } from './syntax';
import type { SyntaxNode } from './syntax';

/** What a ladder row says about its inputs. Every row declares one. */
export type Inputs =
  | {
    readonly kind: 'derived';
    /** Tracked paths (a file, or a directory with a trailing slash) the gate
     *  opens by path at runtime, beyond what the module graph carries. An
     *  empty list is a declaration too: nothing beyond the graph. */
    readonly reads?: readonly string[];
    /** Environment names whose values change the verdict, beyond the literal
     *  `process.env.NAME` reads the graph carries. */
    readonly env?: readonly string[];
    /** Tracked paths a computed `import()` or `require()` in the graph can
     *  load. A graph with such a site and no declaration is never cached; a
     *  declaration on a graph with no such site is stale and refused. The
     *  walker cannot follow the string, so `--audit-closure` is what checks
     *  the declaration against the file the process really loaded. */
    readonly imports?: readonly string[];
    /** The gate reads the tree: every tracked file is an input, as for a
     *  graph that reaches `scripts/sources.ts`. Declared when the audit shows
     *  a suite scanning sources by path, where a `reads` list would be a
     *  hand-kept allowlist over the corpus. */
    readonly corpus?: true;
  }
  | {
    /** Never cached: the gate touches a network, a deployed build, a live
     *  platform, a clock-dependent measurement or a credential. */
    readonly kind: 'live';
    readonly why: string;
  };

/** The repository a closure is derived over. Parameterised so the soundness
 *  gate can derive over a throwaway repository with the same code. */
export interface Repo {
  readonly root: string;
  /** Every tracked file plus untracked additions the ignore rules do not
   *  cover — `enumerateRepository`'s answer, so the corpus is the one every
   *  gate reads. */
  readonly files: readonly string[];
  /** The tracked subset of `files`: what a push ships. */
  readonly tracked: ReadonlySet<string>;
  readonly scripts: Readonly<Record<string, string>>;
  /** `bunfig.toml`'s `[test] preload`, repo-relative. */
  readonly preload: readonly string[];
  read(file: string): string;
  /** The files a `bun test …` command executes. */
  claims(run: string): readonly string[];
}

const ManifestScripts = v.object({ scripts: v.optional(v.record(v.string(), v.string()), {}) });

const Bunfig = v.object({
  test: v.optional(v.object({ preload: v.optional(v.array(v.string()), []) }), { preload: [] }),
});

/** A `Repo` over a root on disk. `claims` is injected because it lives in
 *  `scripts/ladder.ts`, which imports this module. */
export function repoAt(
  root: string,
  claims: (run: string, tracked: readonly string[], scripts: Readonly<Record<string, string>>) => readonly string[],
): Repo {
  const enumeration = enumerateRepository(root);
  const { files } = enumeration;
  const tracked = new Set(enumeration.tracked);
  const read = (file: string): string => readRepositoryFile(root, file);
  const manifest = join(root, 'package.json');
  const scripts = existsSync(manifest) ? v.parse(ManifestScripts, JSON.parse(readFileSync(manifest, 'utf8'))).scripts : {};
  const bunfig = join(root, 'bunfig.toml');

  const preload = existsSync(bunfig)
    ? v.parse(Bunfig, Bun.TOML.parse(readFileSync(bunfig, 'utf8'))).test.preload.map((path) => path.replace(/^\.\//, ''))
    : [];

  return {
    root, files, tracked, scripts, preload, read,
    claims: (run) => claims(run, files, scripts),
  };
}

export interface Derived {
  readonly kind: 'derived';
  /** Sorted, repo-relative. */
  readonly files: readonly string[];
  /** Sorted environment names whose values enter the key. */
  readonly env: readonly string[];
  /** Whether the closure is the whole corpus. */
  readonly corpus: boolean;
  /** What the walker could not see and how it was handled, for the green path. */
  readonly notes: readonly string[];
}

export interface Uncomputable {
  readonly kind: 'uncomputable';
  readonly why: string;
}

export type Closure = Derived | Uncomputable | { readonly kind: 'live'; readonly why: string };

/** The module that enumerates the repository for every corpus gate. */
export const CORPUS_MODULE = 'scripts/sources.ts';


/** Files standing in for `node_modules`: the lock and the patches applied over it. */
function dependencyInputs(repo: Repo): string[] {
  return repo.files.filter((file) => file === 'bun.lock' || file.startsWith('patches/'));
}

/** Specifiers whose import means the file can open the tree by path. */
const READS_BY_PATH = {
  'node:fs': true, fs: true, 'node:fs/promises': true, 'fs/promises': true,
  'node:child_process': true, child_process: true,
} satisfies Record<string, true>;

/** `Bun.<member>` accesses that open the tree by path or spawn a process. */
const BUN_READS_BY_PATH = {
  file: true, spawn: true, spawnSync: true, $: true, Glob: true, build: true, write: true,
} satisfies Record<string, true>;

interface Scan {
  readonly readsByPath: boolean;
  readonly env: readonly string[];
  /** The environment is read whole — spread, enumerated, or passed as a
   *  value — so no list of names bounds what the gate can see. */
  readonly envEnumerated: boolean;
  /** A name is read through a computed key. */
  readonly envComputed: boolean;
}

/** `const NAME = 'LITERAL'` at module scope, so `process.env[NAME]` in the
 *  same file is a read by literal. A binding from another file is not
 *  followed: the row declares it. */
function moduleStringConstants(root: SyntaxNode): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();

  for (const statement of root.children) {
    const declaration = statement.raw.type === 'ExportNamedDeclaration' ? statement.raw.declaration : statement.raw;

    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue;

    for (const declarator of declaration.declarations) {
      const value = declarator.init === null || declarator.init === undefined ? undefined : literalString(declarator.init);

      if (declarator.id.type === 'Identifier' && value !== undefined) constants.set(declarator.id.name, value);
    }
  }

  return constants;
}

/** Whether `raw` is `Bun.<member>` for a member that opens the tree by path. */
function isBunPathRead(raw: Node): boolean {
  return raw.type === 'MemberExpression' && !raw.computed
    && raw.object.type === 'Identifier' && raw.object.name === 'Bun'
    && raw.property.type === 'Identifier' && raw.property.name in BUN_READS_BY_PATH;
}

/** Whether `raw` is `process.env` or `Bun.env` itself. */
function isEnvObject(raw: Node): boolean {
  return raw.type === 'MemberExpression' && !raw.computed
    && raw.object.type === 'Identifier' && (raw.object.name === 'process' || raw.object.name === 'Bun')
    && raw.property.type === 'Identifier' && raw.property.name === 'env';
}

/** The names `const { A, B } = process.env` reads, or none when a rest
 *  element or a computed key reads the object whole. */
function destructuredNames(pattern: Node): readonly string[] {
  if (pattern.type !== 'ObjectPattern') return [];
  const names: string[] = [];

  for (const property of pattern.properties) {
    if (property.type !== 'Property' || property.computed || property.key.type !== 'Identifier') return [];
    names.push(property.key.name);
  }

  return names;
}

/** How one `process.env` occurrence is used, classified from its parents. */
type EnvUse =
  | { readonly kind: 'read'; readonly names: readonly string[] }
  | { readonly kind: 'write' }
  | { readonly kind: 'computed' }
  | { readonly kind: 'enumerated' };

function classifyEnvUse(node: SyntaxNode, constants: ReadonlyMap<string, string>): EnvUse {
  const { raw } = node;
  const parent = node.parent?.raw;

  if (parent?.type === 'VariableDeclarator' && parent.init === raw) {
    const names = destructuredNames(parent.id);

    if (names.length > 0) return { kind: 'read', names };
  }

  if (parent?.type !== 'MemberExpression' || parent.object !== raw) return { kind: 'enumerated' };
  const above = node.parent?.parent?.raw;

  // The target of an assignment or a `delete` is a write and reads nothing.
  if ((above?.type === 'AssignmentExpression' && above.left === parent)
    || (above?.type === 'UnaryExpression' && above.operator === 'delete')) return { kind: 'write' };

  if (!parent.computed && parent.property.type === 'Identifier') return { kind: 'read', names: [parent.property.name] };

  const literal = literalString(parent.property)
    ?? (parent.property.type === 'Identifier' ? constants.get(parent.property.name) : undefined);

  return literal === undefined ? { kind: 'computed' } : { kind: 'read', names: [literal] };
}

/** One file's runtime markers: whether it reads by path, and how it reads the
 *  environment. `process.env.NAME` is a literal read that enters the key;
 *  `process.env[expr]` is computed; `process.env` used as a value anywhere
 *  else — `{ ...process.env }`, `Object.entries(process.env)`, `f(process.env)`
 *  — is an enumeration the walker cannot bound. */
function scanMarkers(root: SyntaxNode, edges: readonly string[]): Scan {
  let readsByPath = edges.some((specifier) => specifier in READS_BY_PATH);
  let envComputed = false;
  let envEnumerated = false;
  const env: string[] = [];
  const constants = moduleStringConstants(root);

  walk(root, (node) => {
    if (isBunPathRead(node.raw)) {
      readsByPath = true;

      return;
    }

    if (!isEnvObject(node.raw)) return;
    const use = classifyEnvUse(node, constants);

    if (use.kind === 'read') env.push(...use.names);
    else if (use.kind === 'computed') envComputed = true;
    else if (use.kind === 'enumerated') envEnumerated = true;
  });

  return { readsByPath, env, envEnumerated, envComputed };
}

interface Walk {
  readonly files: Set<string>;
  readonly env: Set<string>;
  readonly readsByPath: string[];
  /** `file:line` of every computed `import()`/`require()`. */
  readonly computedImports: string[];
  readonly envEnumerated: string[];
  readonly envComputed: string[];
  readonly corpus: boolean;
  readonly failure: string | undefined;
}

/** The transitive graph from `entries` over the repository. */
function walkGraph(entries: readonly string[], repo: Repo): Walk {
  const universe = new Set(repo.files);
  const manifests = new Map(repo.files.filter(isManifest).map((file) => [file, repo.read(file)]));
  const workspace: ReadonlyMap<string, PackageDir> = readWorkspace(manifests);
  const aliases: readonly Alias[] = readAliases(new Map(repo.files.filter(isTypescriptConfig).map((file) => [file, repo.read(file)])));
  const files = new Set<string>();
  const env = new Set<string>();
  const readsByPath: string[] = [];
  const computedImports: string[] = [];
  const envEnumerated: string[] = [];
  const envComputed: string[] = [];
  let corpus = false;
  let failure: string | undefined;
  walkModules(entries, (file) => {
    const paths: { path: string; line: number }[] = [];

    if (failure !== undefined) return paths;

    if (!universe.has(file)) {
      failure = `${file} is not in the corpus`;

      return paths;
    }

    files.add(file);

    if (file === CORPUS_MODULE) corpus = true;

    if (!isParseable(file)) return paths;
    const parsed = parse(file, repo.read(file));
    const { edges, computed, resolvedByPath } = moduleEdges(parsed);

    for (const line of computed) computedImports.push(`${file}:${String(line)}`);

    const scan = scanMarkers(parsed.root, edges.map((edge) => edge.specifier));

    if (scan.readsByPath || resolvedByPath.length > 0) readsByPath.push(file);

    if (scan.envEnumerated) envEnumerated.push(file);

    if (scan.envComputed) envComputed.push(file);

    for (const name of scan.env) env.add(name);

    for (const edge of edges) {
      const next = resolveSpecifier(edge.specifier, file, universe, workspace, aliases, true);

      if (next.kind === 'leaf') continue;

      if (next.kind === 'unresolved') {
        failure = next.why;
        break;
      }

      if (next.kind === 'package') {
        for (const inside of repo.files) if (inside.startsWith(next.directory)) files.add(inside);
        continue;
      }

      if (next.kind === 'asset') files.add(next.path);
      else paths.push({ path: next.path, line: edge.line });
    }

    return paths;
  });

  return { files, env, readsByPath, computedImports, envEnumerated, envComputed, corpus, failure };
}

interface Form {
  readonly entries: readonly string[];
  /** Directory prefixes read whole, beyond the graph. */
  readonly reads: readonly string[];
  readonly corpus: boolean;
}

/** One command's entry files, or why it has none. Recurses through `bun run`. */
function resolveForm(run: string, repo: Repo, depth: number): Form | Uncomputable {
  if (depth > 4) return { kind: 'uncomputable', why: `${run}: package scripts nest deeper than four levels` };
  const words = run.split(/\s+/).filter((word) => word.length > 0 && !/^[A-Z_][A-Z0-9_]*=/.test(word));
  const [first, second] = words;

  if (first === 'bun' && second === 'run') {
    const name = words[2];

    // `bun run <file>` runs the file, as `bun <file>` does.
    if (name !== undefined && isParseable(name)) return { entries: [name], reads: [], corpus: false };
    const body = name === undefined ? undefined : repo.scripts[name];

    if (name === undefined || body === undefined || name.startsWith('-')) {
      return { kind: 'uncomputable', why: `${run}: no package script by that name` };
    }

    const entries: string[] = [];
    const reads: string[] = [];
    let corpus = false;

    for (const part of body.split('&&')) {
      const inner = resolveForm(part.trim(), repo, depth + 1);

      if ('kind' in inner) return inner;
      entries.push(...inner.entries);
      reads.push(...inner.reads);
      corpus ||= inner.corpus;
    }

    return { entries: [...entries, 'package.json'], reads, corpus };
  }

  if (first === 'bun' && second === 'test') {
    const suites = repo.claims(run);

    if (suites.length === 0) return { kind: 'uncomputable', why: `${run}: resolves to no entry file` };

    return { entries: [...suites, ...repo.preload], reads: [], corpus: false };
  }

  if ((first === 'bun' || first === 'node') && second !== undefined && isParseable(second) && !second.startsWith('-')) {
    return { entries: [second], reads: [], corpus: false };
  }

  if (first === 'node') {
    const file = words.slice(1).find((word) => !word.startsWith('-'));

    if (file !== undefined && isParseable(file)) return { entries: [file], reads: [], corpus: false };
  }

  if (first === 'tsc' || first === 'oxlint') return { entries: [], reads: [], corpus: true };

  if (first === 'vitest' && second === 'run') {
    const rootAt = words.indexOf('--root');
    const base = rootAt === -1 ? undefined : words[rootAt + 1];
    const target = words.slice(2).find((word, index) => !word.startsWith('-') && index + 2 !== rootAt + 1);

    if (base === undefined || target === undefined) return { kind: 'uncomputable', why: `${run}: vitest form without --root and a target` };
    const prefix = `${base}/${target}`;

    return {
      entries: repo.files.filter((file) => file.startsWith(prefix) && isParseable(file)),
      reads: [`${base}/`],
      corpus: false,
    };
  }

  if (first === 'bash' || first === 'sh') return { kind: 'uncomputable', why: `${run}: a shell gate has no computable closure` };

  return { kind: 'uncomputable', why: `${run}: the resolver does not understand this form` };
}

/** Every `package.json`, `tsconfig.json` and `bunfig.toml` on the path of a file. */
function configsOnPath(file: string, universe: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const segments = file.split('/');

  for (let depth = 0; depth < segments.length; depth += 1) {
    const directory = segments.slice(0, depth).join('/');
    const at = directory.length === 0 ? '' : `${directory}/`;

    for (const name of ['package.json', 'tsconfig.json', 'bunfig.toml']) {
      if (universe.has(`${at}${name}`)) out.push(`${at}${name}`);
    }
  }

  return out;
}

/** The declaration a derived row carries, with every list present. */
type Declared = Extract<Inputs, { kind: 'derived' }>;

/**
 * Why a walked graph cannot be cached under its declaration, or nothing.
 *
 * Each rule is fail-closed: the closure is a proof that nothing the gate can
 * read has changed, and a graph that reads the environment whole, imports by
 * a computed specifier, reads through a computed key, or opens the tree by an
 * undeclared path has inputs no hash over the module graph stands for. A path
 * read on a CORPUS gate is bounded by the corpus — every tracked file is
 * already in the closure, and what it opens outside the tree is the cache's
 * stated blind spot — so only a non-corpus gate must declare one.
 */
function refusal(run: string, walked: Walk, inputs: Declared, corpus: boolean): string | undefined {
  const [computedImport] = walked.computedImports;

  if (computedImport !== undefined && inputs.imports === undefined) {
    return `${run}: ${computedImport} imports by a computed specifier the walker cannot follow`;
  }

  if (computedImport === undefined && inputs.imports !== undefined) {
    return `${run}: the row declares \`imports\` and the graph has no computed import — a stale declaration`;
  }

  const [enumerated] = walked.envEnumerated;

  if (enumerated !== undefined) {
    return `${run}: ${enumerated} reads the environment whole (spread, enumerated or passed as a value), `
      + `so no list of names bounds what the gate can see (${String(walked.envEnumerated.length)} such file(s))`;
  }

  const [computedEnv] = walked.envComputed;

  if (computedEnv !== undefined && inputs.env === undefined) {
    return `${run}: ${computedEnv} reads the environment through a computed key and the row declares no \`env\``;
  }

  const [pathReader] = walked.readsByPath;

  if (pathReader !== undefined && inputs.reads === undefined && !corpus) {
    return `${run}: ${pathReader} reads by path or spawns and the row declares no \`reads\` `
      + `(${String(walked.readsByPath.length)} such file(s) in the graph)`;
  }

  return undefined;
}

/** The closure of one gate command under its row's declaration. */
export function deriveClosure(run: string, inputs: Inputs, repo: Repo): Closure {
  if (inputs.kind === 'live') return { kind: 'live', why: inputs.why };
  const form = resolveForm(run, repo, 0);

  if ('kind' in form) return form;

  if (form.entries.length === 0 && !form.corpus) {
    return { kind: 'uncomputable', why: `${run}: resolves to no entry file` };
  }

  const walked = walkGraph(form.entries, repo);

  if (walked.failure !== undefined) return { kind: 'uncomputable', why: `${run}: ${walked.failure}` };
  const corpus = form.corpus || walked.corpus || inputs.corpus === true;
  const refused = refusal(run, walked, inputs, corpus);

  if (refused !== undefined) return { kind: 'uncomputable', why: refused };
  const [computedImport] = walked.computedImports;
  const [computedEnv] = walked.envComputed;
  const [pathReader] = walked.readsByPath;
  const notes: string[] = [];
  const universe = new Set(repo.files);
  const files = new Set<string>(walked.files);

  if (corpus) {
    for (const file of repo.files) files.add(file);
    notes.push(walked.corpus
      ? `reads the corpus through ${CORPUS_MODULE}: every tracked file is an input`
      : inputs.corpus === true
        ? 'the row declares it reads the tree: every tracked file is an input'
        : 'reads the whole corpus: every tracked file is an input');
  }

  for (const prefix of [...form.reads, ...(inputs.reads ?? []), ...(inputs.imports ?? [])]) {
    const matched = repo.files.filter((file) => file === prefix || (prefix.endsWith('/') && file.startsWith(prefix)));

    if (matched.length === 0) return { kind: 'uncomputable', why: `${run}: declared read ${prefix} matches no tracked file` };

    for (const file of matched) files.add(file);
  }

  if (computedImport !== undefined) {
    notes.push(`${String(walked.computedImports.length)} computed import(s) at ${walked.computedImports.join(', ')}; the row `
      + `declares imports [${(inputs.imports ?? []).join(', ')}] — checked by --audit-closure, not by the walker`);
  }

  // An untracked file in the closure is bytes the tree cannot name: a built
  // bundle, a `.wrangler/` state directory, an addition the enumeration picked
  // up. Tracked-ness is the whole test — a tracked `dist/` (the vendored
  // runtime) is bytes git names, and a gitignored one is not.
  const generated = [...files].find((file) => !repo.tracked.has(file));

  if (generated !== undefined) {
    return { kind: 'uncomputable', why: `${run}: ${generated} is generated or untracked, so the tree cannot name its bytes` };
  }

  if (pathReader !== undefined) {
    notes.push(`${String(walked.readsByPath.length)} file(s) in the graph read by path or spawn; `
      + (corpus ? 'bounded by the corpus inside the tree' : `the row declares reads [${(inputs.reads ?? []).join(', ')}]`)
      + ' — checked by --audit-closure, not by the walker');
  }

  if (computedEnv !== undefined) {
    notes.push(`environment read through a computed key in ${walked.envComputed.join(', ')}; the row declares `
      + `env [${(inputs.env ?? []).join(', ')}] — only literal and declared names enter the key`);
  }

  for (const file of Array.from(files)) for (const config of configsOnPath(file, universe)) files.add(config);

  for (const file of dependencyInputs(repo)) files.add(file);
  const env = new Set<string>([...walked.env, ...(inputs.env ?? [])]);

  return {
    kind: 'derived',
    files: [...files].sort(),
    env: [...env].sort(),
    corpus,
    notes,
  };
}
