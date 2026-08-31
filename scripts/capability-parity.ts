/**
 * Capability-parity gate — a capability one backend has and the other silently
 * lacks. Two detectors, because the defect has two shapes and the second one is
 * the cause of the first.
 *
 * This is the hole `gate:duplication` writes down about itself in ladder.ts:
 * *"blind: duplication refactored enough to differ structurally, and duplicated
 * policy expressed in different code."* That gate compares implementations that
 * both exist. It cannot see the defect the owner has objected to by name —
 * *"I dont like these kinds of 'X never worked in Y backend' problems!"* —
 * because the absent half has no body to fingerprint.
 *
 * `asymmetry` is the effect: a core contract wired on one backend and not the
 * other. `movable` is the cause: a module that would compile in a shared
 * package, sitting in one adapter, so no contract for the other backend to
 * under-wire was ever written. The two are one gate with one lock because they
 * are one question asked at two stages of the same mistake, and because the
 * remedy is the same sentence: share it, or say where it says why not.
 *
 * Constant DRIFT is a separate gate (`gate:policy-drift`) and deliberately so.
 * Its denominator is numeric literals; this one's is contracts, construction
 * sites and modules. `assertMeasured` dies on any zero, and a merged lock would
 * let one scan's healthy count mask the other's collapse — which is exactly the
 * vacuous-gate shape both of them exist to refuse.
 *
 * ## What makes the absence mechanically visible
 *
 * Core's capability contracts are presence-typed on purpose. `AgentsToolDeps`
 * says so in its own comments: the tool "is registered when ANY group is wired;
 * actions gate per group". So an OPTIONAL field of such a contract IS a
 * capability switch, and the two backends are two implementations of the same
 * switchboard. A required field cannot differ — `tsc` demands it on both. An
 * optional one supplied on Cloudflare and nowhere in the CLI closure is exactly
 * a feature that exists in the product on one backend only, and nothing in the
 * toolchain has an opinion about it: it type-checks, it lints, both suites pass,
 * and the CLI's tool schema just quietly omits the actions.
 *
 * ## Closures, separately — the whole reason this reads anything
 *
 * The scan runs over the `cf` and `cli` closures as two sets, not one union.
 * Over the union every field is "supplied somewhere" and the gate has nothing to
 * say; that is why liveness over the union produced thousands of findings nobody
 * could act on while this defect class stayed invisible. Core is in neither
 * closure: a field supplied inside core is supplied for both backends by
 * construction.
 *
 * ## Why a mentioned name is not a supplied field
 *
 * `team`, `facts`, `engine` and `mode` are ordinary words that appear as keys in
 * unrelated object literals all over both trees, so "the name occurs in this
 * package" would mark almost everything as supplied and the gate would report
 * nothing. A construction site is therefore recognised by SHAPE: an object
 * literal whose keys overlap one contract's member set by at least two. That is
 * a claim about the literal being that contract, not about a word appearing.
 * Attribution goes to the contract with the largest overlap, so a small contract
 * whose members are a subset of a larger one does not steal the larger one's
 * literals.
 *
 * A construction site containing a spread makes the field set unknowable without
 * types, and a gate that guesses there would report a capability missing when it
 * is merely inherited. Those contracts are skipped, and the count of skipped
 * contracts is printed with the verdict rather than swallowed — an unreadable
 * contract is a gap in coverage, not a pass.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import * as v from 'valibot';

import { assertMeasured, finding, reconcile, report, writeLock } from './gate-ratchet';
import { isParseable, readSources, workspaceScope } from './sources';
import {
  declarationOf, declaredName, identifierText, isOptionalMember, moduleSpecifiers, parse,
  type SyntaxNode, walk,
} from './syntax';

const root = new URL('..', import.meta.url).pathname;
const LOCK = `${root}scripts/capability-parity.lock.json`;

/** The two adapter closures, and the shared packages that belong to neither. A
 *  file outside all three (test-utils, pc-agent) is not an adapter. */
const CLOSURES = {
  cf: ['packages/cf-backend/src/'],
  cli: ['packages/cli-backend/src/', 'packages/cli/src/'],
} as const;
const SHARED = ['packages/core/src/', 'packages/agent-utils/src/', 'packages/compaction/src/'];

export type Closure = keyof typeof CLOSURES;
/* SAFETY: `CLOSURES` is an `as const` object literal declared immediately above,
   so its runtime own-enumerable keys are exactly the literal union `Closure`.
   `Object.keys` is typed `string[]` because a wider object could reach it at
   runtime; none can reach this one. */
const CLOSURE_NAMES = Object.keys(CLOSURES) as readonly Closure[];

/** A core-owned contract with at least one optional member: one capability
 *  switchboard, and the switches on it. */
export interface Contract {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  /** Every declared member, optional or not — the overlap alphabet a
   *  construction site is recognised by. */
  readonly members: ReadonlySet<string>;
  /** The subset that can silently differ between two implementations. */
  readonly optional: readonly string[];
  /** Interfaces this one `extends`, by name. Resolved in `findAsymmetries`:
   *  a derived contract's construction site sets inherited keys too, and a
   *  member set that stops at the interface BODY makes that literal match no
   *  contract at all — excess-property attribution rejects it — so every switch
   *  the base declares goes unmeasured the moment anyone writes `extends`. */
  readonly heritage: readonly string[];
}

/** Where one closure builds one contract, and which of its fields that site set. */
export interface Site {
  readonly file: string;
  readonly line: number;
  readonly supplied: ReadonlySet<string>;
  /** A spread makes `supplied` a lower bound rather than the field set. */
  readonly opaque: boolean;
}

export interface Asymmetry {
  readonly contract: Contract;
  readonly field: string;
  /** The closure that wires it. */
  readonly present: Closure;
  /** The closure that builds the same contract and leaves it unset. */
  readonly absent: Closure;
  readonly presentAt: readonly Site[];
  readonly absentAt: readonly Site[];
}

/**
 * A module sitting in one adapter closure that nothing stops from living in a
 * shared package — so the other closure cannot have it, and never will until
 * someone notices.
 *
 * This is the CAUSE of which an `Asymmetry` is the effect. An asymmetry needs a
 * core contract to exist before the absence is sayable; when the capability was
 * written straight into a backend there is no contract, no optional field, and
 * nothing at all to compare — the other backend simply does without. Measured
 * instance: `components/tool-call-summary.ts`, 453 lines of tool-call argument
 * vocabulary (`Edited b.ts — 3 replacements`, `Ran the tests`), against which
 * the CLI's `printToolCall` joins raw argument VALUES and clips the line at 70
 * characters. Nothing in the file touches Cloudflare; it imports `@kinu.run/core`
 * and `valibot`.
 */
export interface Movable {
  readonly file: string;
  readonly closure: Closure;
  readonly lines: number;
  /** Intra-package modules it pulls in, all of them equally movable — the
   *  reason it is reported as one file rather than a graph. */
  readonly through: readonly string[];
}

/** What the movable-module scan found, and what it looked at while finding it. */
export interface Shareable {
  readonly movable: readonly Movable[];
  /** Bare specifiers a shared package already imports, so importing one cannot
   *  stop a module from living there. Derived, never listed. */
  readonly importable: ReadonlySet<string>;
  readonly closureFiles: number;
  /** Intra-package imports the resolver turned into a file. Zero means the
   *  resolver broke, and a broken resolver reports every file as movable. */
  readonly edges: number;
}

export interface Parity extends Shareable {
  readonly contracts: readonly Contract[];
  /** Contracts built by both closures — the only ones a comparison is defined
   *  for, and the denominator that matters. */
  readonly compared: readonly Contract[];
  /** Contracts dropped because a construction site spreads. */
  readonly skipped: readonly string[];
  readonly sitesPerClosure: ReadonlyMap<Closure, number>;
  readonly asymmetries: readonly Asymmetry[];
}

const closureOf = (file: string): Closure | undefined =>
  CLOSURE_NAMES.find((name) => CLOSURES[name].some((prefix) => file.startsWith(prefix)));

const isShared = (file: string): boolean => SHARED.some((prefix) => file.startsWith(prefix));

/**
 * The type a collaborator annotation names, for the shapes one arrives in: `X`,
 * `A.X`, `import('./x').X` and `X | undefined`. The name is always the LAST
 * identifier of the type's own head, so a qualified name yields its tail; type
 * ARGUMENTS are skipped, because `ReadonlyMap<string, VectorStore>` is a map and
 * not a vector store.
 */
function referencedTypeName(type: SyntaxNode | undefined): string | undefined {
  if (type === undefined) return undefined;
  const { raw } = type;
  if (raw.type === 'TSUnionType') {
    return type.children.map((child) => referencedTypeName(child)).find((name) => name !== undefined);
  }
  if (raw.type !== 'TSTypeReference' && raw.type !== 'TSImportType') return undefined;
  let name: string | undefined;
  for (const child of type.children) {
    if (child.raw.type === 'TSTypeParameterInstantiation') continue;
    walk(child, (node) => {
      const text = identifierText(node);
      if (text !== undefined) name = text;
    });
  }
  return name;
}

/**
 * Types a backend can only satisfy by supplying BEHAVIOUR: functions, and the
 * interfaces and classes core declares for its collaborators. Every exported
 * one in the shared packages, so nothing is listed by hand.
 *
 * This is what separates a capability switchboard from a data shape, and it is
 * the difference between 77 findings and a signal. `BroadcastEvent.text?: string`
 * and `DirEntry.size?: number` are optional because not every row has them —
 * a literal that omits one is not a backend missing a feature. `AgentsToolDeps
 * .team?: TeamToolDeps` is optional because wiring it is what makes subordinates
 * exist, and a backend that omits it has no subordinates.
 */
export function behaviourTypes(sources: ReadonlyMap<string, string>): ReadonlySet<string> {
  const names = new Set<string>();
  for (const [file, text] of sources) {
    if (!isShared(file)) continue;
    const { root: tree } = parse(file, text);
    for (const statement of tree.children) {
      const { node: declaration, exported } = declarationOf(statement);
      if (!exported) continue;
      const name = declaredName(declaration);
      if (name === undefined) continue;
      const { raw } = declaration;
      if (raw.type === 'TSInterfaceDeclaration' || raw.type === 'ClassDeclaration') {
        names.add(name);
        continue;
      }
      // A `type X = (…) => …` alias is a collaborator too — that is how
      // `CraftedToolExecute` and `CreateExecuteToolFactory` are declared.
      if (raw.type === 'TSTypeAliasDeclaration'
        && declaration.children.some((child) => child.raw.type === 'TSFunctionType')) {
        names.add(name);
      }
    }
  }
  return names;
}

/**
 * Every exported interface in `text`, as its declared member set, the subset of
 * BEHAVIOUR-typed optional members, and what it `extends`.
 *
 * Exported because a contract a backend cannot import is not one it implements.
 * Interfaces with NO optional behaviour member are returned too, and dropped by
 * `findAsymmetries` after heritage is resolved: a base can be a plain record and
 * still own the members a derived switchboard's construction site sets.
 */
export function declaredContracts(
  file: string,
  text: string,
  behaviours: ReadonlySet<string>,
): Contract[] {
  const { root: tree, lineAt } = parse(file, text);
  const out: Contract[] = [];
  for (const statement of tree.children) {
    const { node: declaration, exported } = declarationOf(statement);
    if (!exported || declaration.raw.type !== 'TSInterfaceDeclaration') continue;
    const name = declaredName(declaration);
    if (name === undefined) continue;
    const members = new Set<string>();
    const optional: string[] = [];
    const heritage: string[] = [];
    walk(declaration, (node) => {
      if (node.raw.type === 'TSInterfaceHeritage') {
        const base = identifierText(node.children[0]);
        if (base !== undefined) heritage.push(base);
        return;
      }
      if (node.parent?.raw.type !== 'TSInterfaceBody') return;
      const member = declaredName(node);
      if (member === undefined) return;
      members.add(member);
      if (!isOptionalMember(node)) return;
      const type = node.children.find((child) => child.raw.type === 'TSTypeAnnotation')?.children[0];
      const behaviour = node.raw.type === 'TSMethodSignature'
        || type?.raw.type === 'TSFunctionType'
        || behaviours.has(referencedTypeName(type) ?? '');
      if (behaviour) optional.push(member);
    });
    out.push({ name, file, line: lineAt(declaration.start), members, optional, heritage });
  }
  return out;
}

/**
 * Contracts with their `extends` chains folded in, then narrowed to the ones
 * that actually carry a capability switch.
 *
 * Both halves matter. Members must be inherited or a derived contract's literal
 * matches nothing (attribution demands EVERY supplied key be declared), and the
 * base's own switches then go unmeasured wherever the derived form is the one
 * built — which is how `ActorToolsetDeps extends BuiltinToolDeps` silently
 * retired three recorded asymmetries. Optional members are inherited for the
 * same reason: an inherited switch is still a switch the two closures can
 * disagree about.
 */
function resolveHeritage(declared: readonly Contract[]): Contract[] {
  const byName = new Map(declared.map((contract) => [contract.name, contract]));
  const closeOver = (contract: Contract, seen: Set<string>): Contract => {
    const members = new Set(contract.members);
    const optional = new Set(contract.optional);
    for (const base of contract.heritage) {
      if (seen.has(base)) continue;
      seen.add(base);
      const resolved = byName.get(base);
      if (resolved === undefined) continue;
      const full = closeOver(resolved, seen);
      for (const member of full.members) members.add(member);
      for (const member of full.optional) optional.add(member);
    }
    return { ...contract, members, optional: [...optional] };
  };
  return declared
    .map((contract) => closeOver(contract, new Set([contract.name])))
    .filter((contract) => contract.optional.length > 0);
}

/** Object literals in `text`, each as the key set it sets plus whether it
 *  spreads. Attribution to a contract happens in `findAsymmetries`, which is the
 *  only place that knows every contract's alphabet. */
function objectLiterals(file: string, text: string): Site[] {
  const { root: tree, lineAt } = parse(file, text);
  const out: Site[] = [];
  walk(tree, (node) => {
    if (node.raw.type !== 'ObjectExpression') return;
    const supplied = new Set<string>();
    let opaque = false;
    for (const child of node.children) {
      if (child.raw.type === 'SpreadElement') { opaque = true; continue; }
      const key = declaredName(child);
      if (key !== undefined) supplied.add(key);
    }
    if (supplied.size > 0) out.push({ file, line: lineAt(node.start), supplied, opaque });
  });
  return out;
}

/**
 * The contract a literal CONSTRUCTS, decided by TypeScript's own rule rather
 * than by resemblance: a fresh object literal assigned to a contract type cannot
 * carry a key the contract does not declare — excess-property checking rejects
 * it. So a literal is a construction site only when EVERY key it sets is a
 * member of the contract, and it names at least two of them (one shared key
 * between unrelated shapes is a coincidence).
 *
 * Overlap alone was not enough and the failure was concrete: the
 * `applyOverflowRecovery({ error, lastPromptTokens, contextWindow,
 * turnWasOverflowRetry, state, sessionKey, signals })` call in the CLI shares
 * exactly `contextWindow` and `sessionKey` with `TurnContextInput`, and got read
 * as the CLI building a turn context that omits `extensions` — i.e. as the CLI
 * having no compaction. Five of `contextWindow`'s siblings are not
 * `TurnContextInput` members, so the excess-property rule drops it.
 *
 * Among the contracts that survive, the tightest fit wins: the one the literal
 * covers the largest fraction of, so a wide contract cannot absorb a small
 * literal that exactly is a narrow one.
 */
const MIN_OVERLAP = 2;

function attribute(site: Site, contracts: readonly Contract[]): Contract | undefined {
  if (site.supplied.size < MIN_OVERLAP) return undefined;
  let best: Contract | undefined;
  let bestFit = 0;
  for (const contract of contracts) {
    let every = true;
    for (const key of site.supplied) if (!contract.members.has(key)) { every = false; break; }
    if (!every) continue;
    const fit = site.supplied.size / contract.members.size;
    if (fit > bestFit || (fit === bestFit && best !== undefined && contract.name < best.name)) {
      best = contract;
      bestFit = fit;
    }
  }
  return best;
}

/* ── Detector 2: a module a backend cannot share ─────────────────────────

   The question is not "does this file mention Cloudflare" but "would it
   compile in core", and the answer is decided by its imports, transitively.
   The allowlist of bare specifiers is DERIVED: whatever `packages/core`,
   `agent-utils` and `compaction` already import is by construction importable
   from there, so `valibot` and `ai` cannot pin a module to a backend while
   `agents` and `react` do. Nothing is listed by hand, and adding a dependency
   to core widens the allowlist automatically — which is correct, because it
   really does make more modules movable.

   NOT checked: platform GLOBALS. A file reaching `caches` or `Bun` with no
   import would be reported movable. That was measured rather than assumed —
   over the 46 modules this detector currently reports, every apparent hit
   (`DurableObject`, `Bun`, `process`, `window`, `document`) is a word inside a
   comment or a substring of another identifier, and zero are real references.
   The cost of the miss is also bounded to one second: the remedy is to move the
   file and `tsc -p packages/core` says so immediately. A hand-maintained list of
   two runtimes' globals, kept current forever, to pre-empt a failure the next
   command already produces, is the wrong trade. */

/** The shared packages either backend may import, derived from the live
 *  workspace scope so a scope rename cannot quietly widen this to nothing —
 *  a regex that matches no specifier reports every shared import as a blocker,
 *  which reads as "no module is movable" rather than as a broken gate. */
const SHARED_PACKAGE = new RegExp(
  `^${workspaceScope()}/(core|agent-utils|compaction)(/|$)`,
);

const TsconfigSchema = v.object({
  compilerOptions: v.optional(v.object({
    paths: v.optional(v.record(v.string(), v.array(v.string()))),
  })),
});

/** JSONC to JSON: `//` and block comments removed, string literals left alone.
 *  Character-wise rather than by regex, because a regex either eats the `//` in
 *  `"https://…"` or needs a lookbehind that misses an escaped quote. */
export function withoutComments(text: string): string {
  let out = '';
  let mode: 'code' | 'string' | 'line' | 'block' = 'code';
  for (let i = 0; i < text.length; i += 1) {
    const pair = text.slice(i, i + 2);
    if (mode === 'code') {
      if (pair === '//') { mode = 'line'; i += 1; continue; }
      if (pair === '/*') { mode = 'block'; i += 1; continue; }
      if (text[i] === '"') mode = 'string';
      out += text[i];
      continue;
    }
    if (mode === 'string') {
      out += text[i];
      if (text[i] === '\\') { out += text[i + 1] ?? ''; i += 1; continue; }
      if (text[i] === '"') mode = 'code';
      continue;
    }
    if (mode === 'line') {
      if (text[i] === '\n') { mode = 'code'; out += '\n'; }
      continue;
    }
    if (pair === '*/') { mode = 'code'; i += 1; }
  }
  return out;
}

/**
 * A package's own path aliases, read from its tsconfig rather than pinned here.
 * An alias this gate did not know about would resolve to nothing, and an
 * unresolvable intra-package import is fatal below — so a stale copy fails
 * loudly instead of quietly reporting fewer files.
 *
 * tsconfig is JSONC, not JSON: `tsc` accepts comments and this repo's own
 * `wrangler.jsonc` shows the habit is present. `JSON.parse` on a documented
 * tsconfig throws `Unrecognized token '/'`, and it happened — a peer added one
 * `//` line explaining an `exclude` and took eight tests down, none of whose
 * names mentioned tsconfig. Comments are stripped first, string-aware so a `//`
 * inside a path is not mistaken for one.
 */
function aliasesOf(pkg: string): readonly (readonly [string, string])[] {
  const path = `${root}${pkg}/tsconfig.json`;
  if (!existsSync(path)) return [];
  const { compilerOptions } = v.parse(TsconfigSchema, JSON.parse(withoutComments(readFileSync(path, 'utf8'))));
  return Object.entries(compilerOptions?.paths ?? {}).flatMap(([pattern, targets]) => {
    const target = targets[0];
    if (!pattern.endsWith('/*') || target === undefined || !target.endsWith('/*')) return [];
    return [[pattern.slice(0, -1), `${pkg}/${target.replace(/^\.\//, '').slice(0, -1)}`] as const];
  });
}

/** What a specifier written inside a package resolves to. `external` covers
 *  everything outside the package, which the caller judges by name instead. */
type Local =
  | { readonly kind: 'file'; readonly file: string }
  /** A stylesheet, image or data file — real, and not something a shared
   *  package can import, so it pins its importer where it is. */
  | { readonly kind: 'asset' }
  /** A relative path that leaves the tree for `node_modules/` — a dependency
   *  reached through the filesystem because the package exports no subpath for
   *  it (`nimbus-programmatic.ts` documents the one live instance). A
   *  DEPENDENCY, never a dependency-free module, and package-relative, so it
   *  pins its importer exactly as an asset does. */
  | { readonly kind: 'installed' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'external' };

function resolveLocal(
  from: string,
  spec: string,
  known: ReadonlySet<string>,
  aliases: readonly (readonly [string, string])[],
): Local {
  const alias = aliases.find(([prefix]) => spec.startsWith(prefix));
  const base = spec.startsWith('.')
    ? normalize(join(dirname(from), spec))
    : alias === undefined ? undefined : `${alias[1]}${spec.slice(alias[0].length)}`;
  if (base === undefined) return { kind: 'external' };
  if (base.split('/').includes('node_modules')) return { kind: 'installed' };
  // One spelling per regime: no extension under a bundler or Bun, an explicit
  // `.ts` inside the raw-Node closure. `base` covers the second and the genuine
  // assets (`.css`, `.json`, `packages/pc-agent/src/index.js`); the rest is the
  // extensionless form resolving to a module or a barrel.
  for (const candidate of [
    base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`,
  ]) {
    if (known.has(candidate)) return { kind: 'file', file: candidate };
  }
  const extension = base.slice(base.lastIndexOf('/') + 1).includes('.');
  return extension && !isParseable(base) ? { kind: 'asset' } : { kind: 'missing' };
}

interface Graph {
  /** Bare specifiers that would not compile in a shared package. */
  readonly blockers: ReadonlyMap<string, readonly string[]>;
  /** Intra-package files each file imports. */
  readonly deps: ReadonlyMap<string, readonly string[]>;
  readonly importable: ReadonlySet<string>;
  readonly edges: number;
}

function buildGraph(sources: ReadonlyMap<string, string>): Graph {
  const known = new Set(sources.keys());
  const specifiers = new Map<string, readonly string[]>();
  for (const [file, text] of sources) {
    specifiers.set(file, moduleSpecifiers(parse(file, text).root));
  }

  const importable = new Set<string>();
  for (const [file, list] of specifiers) {
    if (!isShared(file)) continue;
    for (const spec of list) if (!spec.startsWith('.')) importable.add(spec);
  }

  const aliases = new Map<string, readonly (readonly [string, string])[]>();
  const blockers = new Map<string, readonly string[]>();
  const deps = new Map<string, readonly string[]>();
  let edges = 0;
  for (const [file, list] of specifiers) {
    const pkg = file.split('/').slice(0, 2).join('/');
    let packageAliases = aliases.get(pkg);
    if (packageAliases === undefined) {
      packageAliases = aliasesOf(pkg);
      aliases.set(pkg, packageAliases);
    }
    const blocked: string[] = [];
    const local: string[] = [];
    for (const spec of list) {
      const resolved = resolveLocal(file, spec, known, packageAliases);
      if (resolved.kind === 'missing') {
        throw new Error(
          `capability-parity: ${file} imports '${spec}', which resolves to no tracked`
          + ` source file. An unresolvable local import would otherwise be read as a`
          + ` dependency-free module, which reports the file as movable when it is not.`,
        );
      }
      if (resolved.kind === 'file') {
        local.push(resolved.file);
        edges += 1;
        continue;
      }
      if (resolved.kind === 'asset' || resolved.kind === 'installed') { blocked.push(spec); continue; }
      if (SHARED_PACKAGE.test(spec) || importable.has(spec)) continue;
      blocked.push(spec);
    }
    blockers.set(file, blocked);
    deps.set(file, local);
  }
  return { blockers, deps, importable, edges };
}

/** True when neither this file nor anything it reaches inside its own package
 *  imports something a shared package could not. A cycle is neutral: two files
 *  that only need each other are movable together. */
function movableIn(file: string, graph: Graph, memo: Map<string, boolean>, open: Set<string>): boolean {
  const cached = memo.get(file);
  if (cached !== undefined) return cached;
  if (open.has(file)) return true;
  open.add(file);
  let ok = (graph.blockers.get(file) ?? []).length === 0;
  if (ok) {
    for (const dep of graph.deps.get(file) ?? []) {
      if (!movableIn(dep, graph, memo, open)) { ok = false; break; }
    }
  }
  open.delete(file);
  memo.set(file, ok);
  return ok;
}

export function findMovable(sources: ReadonlyMap<string, string>): Shareable {
  const graph = buildGraph(sources);
  const memo = new Map<string, boolean>();
  const movable: Movable[] = [];
  let closureFiles = 0;
  for (const [file, text] of sources) {
    const closure = closureOf(file);
    if (closure === undefined) continue;
    closureFiles += 1;
    if (!movableIn(file, graph, memo, new Set())) continue;
    movable.push({
      file,
      closure,
      lines: text.split('\n').length,
      through: [...(graph.deps.get(file) ?? [])].sort(),
    });
  }
  movable.sort((a, b) => a.file.localeCompare(b.file));
  return { movable, importable: graph.importable, closureFiles, edges: graph.edges };
}

export function findAsymmetries(sources: ReadonlyMap<string, string>): Parity {
  const behaviours = behaviourTypes(sources);
  const declared: Contract[] = [];
  for (const [file, text] of sources) {
    if (!isShared(file)) continue;
    declared.push(...declaredContracts(file, text, behaviours));
  }
  const contracts = resolveHeritage(declared);

  const sites = new Map<string, Map<Closure, Site[]>>();
  const opaque = new Set<string>();
  const sitesPerClosure = new Map<Closure, number>(CLOSURE_NAMES.map((name) => [name, 0]));
  for (const [file, text] of sources) {
    const closure = closureOf(file);
    if (closure === undefined) continue;
    for (const site of objectLiterals(file, text)) {
      const contract = attribute(site, contracts);
      if (contract === undefined) continue;
      if (site.opaque) opaque.add(contract.name);
      const byClosure = sites.get(contract.name) ?? new Map<Closure, Site[]>();
      const list = byClosure.get(closure) ?? [];
      list.push(site);
      byClosure.set(closure, list);
      sites.set(contract.name, byClosure);
      sitesPerClosure.set(closure, (sitesPerClosure.get(closure) ?? 0) + 1);
    }
  }

  const compared: Contract[] = [];
  const asymmetries: Asymmetry[] = [];
  for (const contract of contracts) {
    const byClosure = sites.get(contract.name);
    if (byClosure === undefined || opaque.has(contract.name)) continue;
    if (!CLOSURE_NAMES.every((name) => (byClosure.get(name)?.length ?? 0) > 0)) continue;
    compared.push(contract);
    const suppliedIn = new Map<Closure, Set<string>>(CLOSURE_NAMES.map((name) => [
      name,
      new Set((byClosure.get(name) ?? []).flatMap((site) => [...site.supplied])),
    ]));
    for (const field of contract.optional) {
      const wiring = CLOSURE_NAMES.filter((name) => suppliedIn.get(name)?.has(field) === true);
      if (wiring.length !== 1) continue;
      const [present] = wiring;
      const absent = CLOSURE_NAMES.find((name) => name !== present);
      if (present === undefined || absent === undefined) continue;
      asymmetries.push({
        contract,
        field,
        present,
        absent,
        presentAt: byClosure.get(present) ?? [],
        absentAt: byClosure.get(absent) ?? [],
      });
    }
  }

  asymmetries.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const shareable = findMovable(sources);
  return {
    contracts,
    compared,
    skipped: [...opaque].sort(),
    sitesPerClosure,
    asymmetries,
    ...shareable,
  };
}

export function keyOf(entry: Asymmetry): string {
  return `asymmetry ${entry.contract.name}.${entry.field}#absent-in-${entry.absent}`;
}

export const movableKeyOf = (entry: Movable): string => `movable ${entry.file}`;

export function describe(entry: Asymmetry): string {
  const where = (sites: readonly Site[]): string =>
    [...new Set(sites.map((site) => `${site.file}:${String(site.line)}`))].sort().join(', ');
  return finding({
    at: `${entry.contract.name}.${entry.field} — ${entry.contract.file}:${String(entry.contract.line)}`,
    invariant: `both adapter closures wire it, or neither does`,
    found: `wired in ${entry.present} at ${where(entry.presentAt)}; `
      + `${entry.absent} builds the same contract at ${where(entry.absentAt)} and leaves it unset`,
    silently: `the capability exists on ${entry.present} and not on ${entry.absent}: it type-checks, `
      + `both suites pass, and the ${entry.absent} surface omits the actions the field gates`,
    fix: `wire ${entry.field} in the ${entry.absent} closure against the same core implementation, `
      + `or, if it is genuinely platform-only, say so where the contract declares it`,
  });
}

export function describeMovable(entry: Movable): string {
  const other = CLOSURE_NAMES.find((name) => name !== entry.closure) ?? entry.closure;
  return finding({
    at: `${entry.file}:1 — ${String(entry.lines)} lines`,
    invariant: 'a module that would compile in a shared package lives in one',
    found: `it sits in the ${entry.closure} closure and imports nothing a shared package could not`
      + (entry.through.length === 0 ? '' : `, through ${entry.through.join(', ')}`),
    silently: `whatever it does is a ${entry.closure} capability only. ${other} cannot import it, so`
      + ` ${other} either reimplements it, or — far more often — silently does without, and no`
      + ` contract exists for a parity check to compare`,
    fix: `move it to packages/core and import it from both closures, or, if it is genuinely`
      + ` ${entry.closure}-only despite compiling anywhere, record it in the lock`,
  });
}

if (import.meta.main) {
  const parity = findAsymmetries(readSources());
  const measured = assertMeasured('capability-parity', [
    ['core contracts with optional members', parity.contracts.length],
    ['built by both closures', parity.compared.length],
    ...CLOSURE_NAMES.map((name) => [
      `${name} construction sites`, parity.sitesPerClosure.get(name) ?? 0,
    ] as const),
    ['adapter source files', parity.closureFiles],
    ['resolved local imports', parity.edges],
    ['specifiers a shared package already imports', parity.importable.size],
  ]);
  const coverage = parity.skipped.length === 0
    ? measured
    : `${measured}, ${String(parity.skipped.length)} skipped as spread: ${parity.skipped.join(', ')}`;
  const keys = [...parity.asymmetries.map(keyOf), ...parity.movable.map(movableKeyOf)];
  if (process.argv.includes('--lock')) {
    const count = writeLock(keys, LOCK);
    console.log(`capability-parity: locked ${String(count)} divergence(s) — ${coverage}`);
  } else {
    const detail = new Map<string, string>([
      ...parity.asymmetries.map((entry) => [keyOf(entry), describe(entry)] as const),
      ...parity.movable.map((entry) => [movableKeyOf(entry), describeMovable(entry)] as const),
    ]);
    process.exit(report(
      'capability-parity',
      reconcile(keys, LOCK),
      detail,
      'bun scripts/capability-parity.ts --lock',
      coverage,
    ));
  }
}
