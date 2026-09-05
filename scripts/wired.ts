/**
 * Wired gate — built, tested, and connected to nothing.
 *
 * ## What `gate:dead-code` cannot see, measured rather than assumed
 *
 * `dead-code.ts` asks knip twice and takes the set difference, so its whole
 * notion of "referenced" is knip's. Knip's unit for a re-exported symbol is the
 * TERMINUS of the re-export chain: when that terminus is an entry file, every
 * name reachable from it by `export * from` is used, and the symbol is dropped
 * from BOTH runs — so the set difference that classifies `test-only` against
 * `unreferenced` is computed over a population the symbol already left.
 *
 * Measured 2026-08-19 on a four-file probe repository, `main` field
 * `src/index.ts`, knip 6.32.2, the repository's own `knip` block copied verbatim:
 *
 *   src/index.ts        export * from './deep/leaf'; export * from './deep/lonely'
 *   src/deep/leaf.ts    export function neverCalled()      — called by nothing
 *   src/deep/lonely.ts  export function alsoNeverCalled()  — called by nothing
 *   src/orphan.ts       export function orphanExport()     — no import edge at all
 *
 * knip reported ONE issue: `src/orphan.ts` as an unused FILE, `exports: []`.
 * `neverCalled` and `alsoNeverCalled` were clean in the default run and clean in
 * `--production`. Adding a test that imports `neverCalled` THROUGH the barrel
 * changed nothing in either run; a second leaf imported by the same test
 * DIRECTLY was reported, and reported as an unused file rather than as a symbol.
 *
 * Both halves of the claim therefore hold, and they hold for different reasons:
 *   - a barrel re-export counts as a reference, because the chain ends at an
 *     entry and an entry's exports are the package's published surface;
 *   - `ignoreExportsUsedInFile: true` (this repository's setting) drops any
 *     export referenced anywhere inside its own file, which is `FORK_STRATEGY_ID`
 *     exactly: declared at `strategy/heads.ts:36` and read at `:40`.
 *
 * On this tree `packages/core/src/index.ts` is core's `main` and does
 * `export * from './strategy/index'`, which does `export * from './node-workspace'`.
 * So `agentHomeNodeProvisioner` — 7 passing tests, no production caller — is
 * invisible to `gate:dead-code` by construction, and its lock does not name it.
 *
 * ## What this gate measures instead
 *
 * PRODUCTION REACHABILITY. An exported symbol is REACHED when some file that is
 * itself reachable from an entrypoint REFERENCES it, where the file is not a
 * test and the reference is not a re-export. Three properties follow, and they
 * are the three that matter:
 *
 *   - a barrel is TRAVERSED but never CONFERS. `export … from` moves a name; it
 *     does not use it. An import is resolved back through however many barrels
 *     stand in the way, so a symbol a production module genuinely imports
 *     through `index.ts` is reached — that is the false positive that would get
 *     this gate switched off, and `wired.test.ts` pins it;
 *   - a test is never a reacher and never a root, so "wire it or delete it with
 *     its test" is sayable;
 *   - a file the entrypoint closure never touches confers nothing, so a live
 *     symbol inside a dead subtree does not launder its neighbours.
 *
 * ENTRYPOINTS ARE DISCOVERED, never listed. Six kinds, each the code's own
 * declaration that something outside this repository enters here — the model,
 * the platform, the user's shell, or the OS. `--entrypoints` prints them.
 *
 * A SECOND FINDING, from the same definition. `SwarmRunDeps.mission` is not an
 * export: it is an optional field that production READS and that no production
 * construction site of that interface SUPPLIES. Reachability over exports cannot
 * see it, because the export it hangs off is reached. So field supply is measured
 * against the interface's visible construction sites, using the local type
 * annotations rather than a type checker — see {@link findUnsupplied}.
 *
 * RATCHETED, and the count of remaining entries is printed on the GREEN path.
 * Today's population cannot be fixed by this commit, and a warning nobody has to
 * clear is how the population got here. Debt on the green path is debt somebody
 * reads.
 *
 * ## The one rule this gate and `test-census.ts` share
 *
 * Stated in both headers in the same words. A constant a test needs is EITHER a
 * public contract — exported from the module that owns it AND read by
 * production, which is exactly what this gate accepts as reachable — OR it is
 * unnecessary, because the test can observe the behaviour instead. There is no
 * third option, and the two shapes that pretend to be one are a TEST-ONLY
 * EXPORT and a TEST-SIDE MIRROR: the first makes the module's surface bigger
 * for no production reader, which this gate reports as
 * reached-by-tests-only; the second restates the value beside the module, which
 * the census reports as a mirror. They are the same defect seen from two sides,
 * and neither is the fix for the other. The fix is to assert what the code
 * DOES: a value the module hands out, a path it names in a command, a count it
 * puts in its own message.
 *
 * So an export added to satisfy a test is this gate's finding, not its remedy.
 * `test-census.ts --ratchet` holds the other side of the same boundary, which is
 * why the sentence above is duplicated rather than cross-referenced: a reader
 * arriving at either tool with a red line has to be told the whole rule, and a
 * pointer to the other file is the thing nobody follows.
 */

import * as v from 'valibot';

import { assertMeasured, reconcile, report, writeLock } from './gate-ratchet';
import { exportedDeclarations, inScope } from './dead-code';
import { declaredRpcs, invokedNames } from './reachability';
import {
  isParseable, isTestFile, isTestScaffold, readMatching, readRepositoryFile, readTests,
  trackedFiles,
} from './sources';
import {
  classMembers, collapsePath, declarationOf, declaredName, identifierText, importBindings,
  importedNames, IMPORT_CANDIDATES, isFunctionLike, isOptionalMember, isReExport, literalText,
  methodKind, moduleSpecifiers,
  NAMESPACE, parse, type Parsed, reExportBindings, referencedNames, returnTypeOf, superClassName,
  type SyntaxNode, walk,
} from './syntax';

const root = new URL('..', import.meta.url).pathname;
const LOCK = `${root}scripts/wired.lock.json`;

/**
 * One parse per file, because parsing IS the cost and this analysis asks five
 * separate questions of every file: the module graph, the entrypoints, the type
 * annotations, the field supply, the declaration lines.
 *
 * Measured on this tree, 768 files: 7.0 s parsing each five times, 2.0 s
 * parsing each once. That difference decides the ladder tier, so it is not an
 * optimisation for its own sake. Keyed on the TEXT as well as the path — the
 * suite drives the same fixture paths with different contents, and a cache that
 * ignored that would hand it the previous case's tree.
 */
const parsed = new Map<string, { readonly text: string; readonly tree: Parsed }>();

function parseOnce(file: string, text: string): Parsed {
  const cached = parsed.get(file);
  if (cached !== undefined && cached.text === text) return cached.tree;
  const tree = parse(file, text);
  parsed.set(file, { text, tree });
  return tree;
}

/** The corpus that can REACH a symbol: every tracked, parseable file that is
 *  neither a test nor test scaffolding. Wider than the governed set on purpose —
 *  `packages/cli/bin/cli.ts` is the CLI binary and consumes six symbols from
 *  `packages/cli/src`, so a governed-set-only reader would report all six as
 *  unwired. That is precisely the false positive this gate cannot afford. */
export const isReacher = (file: string): boolean =>
  isParseable(file) && !isTestFile(file) && !isTestScaffold(file);

/* ── Module facts ─────────────────────────────────────────────────────── */

/** Where a local binding came from. */
interface Origin {
  readonly file: string;
  /** The name in `file`, or {@link NAMESPACE} for `import * as`. */
  readonly imported: string;
}

/** A name this module republishes without using. */
interface Forward extends Origin {
  /** The name it is published under here. */
  readonly exported: string;
}

export interface Module {
  readonly file: string;
  /** Names DECLARED here and exported, by `dead-code`'s own rule. */
  readonly exports: ReadonlySet<string>;
  /** Of those, the ones that declare a VALUE — a function, a class, a binding,
   *  an enum. An `interface` or a `type` alias executes nothing, so "wired" does
   *  not apply to it: an unused one is surface bloat, which is a different and
   *  much cheaper problem than a capability nothing calls. Measured on this tree
   *  the split is what separates a census from a list: 1,660 unreached exports
   *  against 195 unreached values. */
  readonly values: ReadonlySet<string>;
  /** The name of `export default function Foo`, when the default declaration
   *  carries one. An importer writes `import Foo from './x'` and binds the
   *  DEFAULT, so without this the name `Foo` has no consumer and every
   *  default-exported React page in the tree reads as unwired. */
  readonly defaultName: string | undefined;
  readonly imports: ReadonlyMap<string, Origin>;
  readonly forwards: readonly Forward[];
  readonly referenced: ReadonlySet<string>;
  /** Modules this file names, resolved into the reacher corpus. */
  readonly edges: readonly string[];
}

/** Declarations that introduce a type and no value. */
const TYPE_ONLY: ReadonlySet<string> = new Set([
  'TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSModuleDeclaration',
]);

/** The exported names of `file` that declare a value. */
function exportedValues(tree: SyntaxNode, exported: ReadonlySet<string>): Set<string> {
  const types = new Set<string>();
  for (const statement of tree.children) {
    if (isReExport(statement)) continue;
    const { node } = declarationOf(statement);
    const name = declaredName(node);
    if (name !== undefined && TYPE_ONLY.has(node.type)) types.add(name);
  }
  return new Set([...exported].filter((name) => !types.has(name)));
}

/** The name `export default` gives its declaration, when it gives one. */
function defaultExportName(tree: SyntaxNode): string | undefined {
  for (const statement of tree.children) {
    if (statement.raw.type !== 'ExportDefaultDeclaration') continue;
    const name = declaredName(declarationOf(statement).node);
    if (name !== undefined) return name;
  }
  return undefined;
}

/** This workspace's own packages. */
const WORKSPACE_SCOPE = '@kinu.run/';

/** A vite import query — `./x.js?raw` addresses the same file as `./x.js`. */
const QUERY = '?';

/** A package's declared subpaths. Parsed rather than guessed: `@kinu.run/core`
 *  publishes `./workspace` as `src/vfs/nimbus-workspace.ts`, so the directory
 *  shape a rename would produce is simply wrong, and a wrong resolution is a
 *  dropped edge. */
const SubpathSchema = v.object({ exports: v.optional(v.record(v.string(), v.string()), {}) });

/** A package's declared path aliases. `packages/cf-backend` declares
 *  `"@/*": ["./src/*"]`, and the whole frontend imports through it: 33 of
 *  `WorkspacePage.tsx`'s specifiers, of which a resolver that knew only
 *  relative paths and `@kinu.run/*` resolved 3. Measured before this rule
 *  existed, that one gap produced 95 phantom findings — every React component in
 *  the tree, reported as unreached. */
const AliasSchema = v.object({
  compilerOptions: v.optional(v.object({
    paths: v.optional(v.record(v.string(), v.array(v.string())), {}),
  }), {}),
});

export interface Resolution {
  /** The file this specifier names, when the corpus holds one. */
  readonly file: string | undefined;
  /** True when the specifier addresses THIS repository — relative, a workspace
   *  package, or a declared alias. Local with no file is a dropped edge, and a
   *  dropped edge shrinks reachability in silence, so the caller makes it
   *  fatal. */
  readonly local: boolean;
}

const EXTERNAL: Resolution = { file: undefined, local: false };

/**
 * The file a specifier names.
 *
 * Four rules, each read from the code's own declaration rather than guessed: a
 * package's `exports` subpath, a tsconfig path alias, a relative path, a
 * workspace package root. `corpus` decides every one — a candidate the tree does
 * not hold is not a resolution, which is what stops a rename from inventing an
 * edge. Both manifests are read on demand, by paths the specifier and the
 * importing file name between them, so nothing here enumerates anything.
 */
export function createResolver(
  corpus: ReadonlySet<string>,
  tracked: ReadonlySet<string>,
): (from: string, specifier: string) => Resolution {
  const manifests = new Map<string, Readonly<Record<string, string>>>();
  const aliasRules = new Map<string, readonly (readonly [string, string])[]>();

  const subpaths = (pkg: string): Readonly<Record<string, string>> => {
    const cached = manifests.get(pkg);
    if (cached !== undefined) return cached;
    const manifest = `packages/${pkg}/package.json`;
    const parsed = tracked.has(manifest)
      ? v.parse(SubpathSchema, JSON.parse(readRepositoryFile(root, manifest))).exports
      : {};
    manifests.set(pkg, parsed);
    return parsed;
  };

  /** `['@/', 'packages/cf-backend/src/']` for the package `from` lives in. */
  const aliases = (from: string): readonly (readonly [string, string])[] => {
    const dir = from.split('/').slice(0, 2).join('/');
    const cached = aliasRules.get(dir);
    if (cached !== undefined) return cached;
    const config = `${dir}/tsconfig.json`;
    const paths = tracked.has(config)
      ? v.parse(AliasSchema, JSON.parse(readRepositoryFile(root, config))).compilerOptions.paths
      : {};
    const rules = Object.entries(paths).flatMap(([pattern, targets]) => {
      const target = targets[0];
      if (target === undefined || !pattern.endsWith('*') || !target.endsWith('*')) return [];
      return [[pattern.slice(0, -1), collapsePath(`${dir}/${target.slice(0, -1)}`)] as const];
    });
    aliasRules.set(dir, rules);
    return rules;
  };

  return (from, raw) => {
    const specifier = raw.includes(QUERY) ? raw.slice(0, raw.indexOf(QUERY)) : raw;
    const found = (base: string): Resolution => ({
      file: IMPORT_CANDIDATES.map((suffix) => base + suffix).find((path) => corpus.has(path)),
      local: true,
    });

    if (specifier.startsWith('.')) {
      const base = collapsePath(`${from.slice(0, from.lastIndexOf('/'))}/${specifier}`);
      // A relative path into node_modules is a DEPENDENCY reached through the
      // filesystem — @nimbus-sh/worker exports no subpath for its dist session
      // modules, and nimbus-programmatic.ts documents the one live instance.
      // External like any package specifier, never a dangling local edge.
      if (base.split('/').includes('node_modules')) return EXTERNAL;
      return found(base);
    }
    if (specifier.startsWith(WORKSPACE_SCOPE)) {
      const [pkg, ...rest] = specifier.slice(WORKSPACE_SCOPE.length).split('/');
      if (pkg === undefined || pkg.length === 0) return EXTERNAL;
      const entry = subpaths(pkg)[rest.length === 0 ? '.' : `./${rest.join('/')}`];
      const named = entry === undefined ? undefined : collapsePath(`packages/${pkg}/${entry}`);
      if (named !== undefined && corpus.has(named)) return { file: named, local: true };
      return found(collapsePath(`packages/${pkg}/src/${rest.join('/')}`));
    }
    for (const [prefix, target] of aliases(from)) {
      if (!specifier.startsWith(prefix)) continue;
      return found(collapsePath(`${target}/${specifier.slice(prefix.length)}`));
    }
    return EXTERNAL;
  };
}

export interface Graph {
  readonly modules: ReadonlyMap<string, Module>;
  /** Local specifiers that named nothing in the tree. Each is a dropped edge,
   *  and a dropped edge silently shrinks reachability — so these are fatal
   *  rather than reported. */
  readonly dangling: readonly string[];
}

export function buildGraph(reachers: ReadonlyMap<string, string>): Graph {
  const inCorpus = new Set(reachers.keys());
  const tracked = new Set(trackedFiles());
  const resolve = createResolver(inCorpus, tracked);
  const anywhere = createResolver(tracked, tracked);
  const modules = new Map<string, Module>();
  const dangling: string[] = [];

  for (const [file, text] of reachers) {
    const { root: tree } = parseOnce(file, text);
    const imports = new Map<string, Origin>();
    const forwards: Forward[] = [];
    const edges = new Set<string>();

    for (const statement of tree.children) {
      const [specifier] = moduleSpecifiers(statement);
      if (specifier === undefined) continue;
      const { file: target, local } = resolve(file, specifier);
      if (target === undefined) {
        // A specifier resolving OUTSIDE the reacher corpus but inside the tree is
        // a legitimate non-edge: a `.json` payload, a fixture, test scaffolding.
        // A LOCAL specifier resolving to nothing at all is a broken import.
        if (local && anywhere(file, specifier).file === undefined) {
          dangling.push(`${file} -> ${specifier}`);
        }
        continue;
      }
      edges.add(target);
      for (const bound of importBindings(statement)) {
        imports.set(bound.local, { file: target, imported: bound.imported });
      }
      for (const bound of reExportBindings(statement)) {
        forwards.push({ file: target, imported: bound.imported, exported: bound.local });
      }
    }
    // A dynamic `import('./x')` is an edge and binds nothing.
    for (const specifier of moduleSpecifiers(tree)) {
      const { file: target } = resolve(file, specifier);
      if (target !== undefined) edges.add(target);
    }

    const exports = exportedDeclarations(file, text, tree);
    modules.set(file, {
      file,
      exports,
      values: exportedValues(tree, exports),
      defaultName: defaultExportName(tree),
      imports,
      forwards,
      referenced: referencedNames(tree),
      edges: [...edges],
    });
  }
  return { modules, dangling };
}

/* ── Entrypoints ──────────────────────────────────────────────────────── */

export type EntrypointKind =
  /** A handler bound under a name the model can call. Dispatch is by string. */
  | 'builtin-tool'
  /** `@callable()`. The only thing that makes a DO method reachable off-box. */
  | 'callable-rpc'
  /** A registered CLI verb. Dispatch is by argv. */
  | 'cli-command'
  /** A method the platform calls and nothing here does: a Think turn hook,
   *  `alarm()`, a websocket callback, a Durable Object `fetch`. */
  | 'platform-hook'
  /** A property of a module's `export default` object. On `cf-backend/src/server.ts`
   *  that object is the Workers module contract — `fetch`, `email`, `scheduled` —
   *  and every HTTP route on this backend is dispatched inside `fetch`, so this
   *  is the kind that covers routes: they are reached through the module graph
   *  from the handler rather than registered in a table a detector could read. */
  | 'module-default'
  /** A `createRoot(…)` or `hydrateRoot(…)` mount: a browser bundle's entry, and
   *  the whole frontend hangs off one. The knip config has to DECLARE
   *  `src/gallery.tsx` as an entry because no tool can see it; this detector
   *  finds both of this repository's bundles from the mount call itself. */
  | 'browser-bundle'
  /** A shebang or `import.meta.main`: the OS/runtime executes this file
   *  directly. Both are process roots; requiring a shebang missed Bun scripts
   *  such as the devbox candidate runner, whose imports are shipped runtime
   *  calls rather than test-only references. */
  | 'process-entry';

export interface Entrypoint {
  readonly file: string;
  readonly line: number;
  readonly kind: EntrypointKind;
  /** What the outside world names to get here. */
  readonly at: string;
  /** The exported declaration this entrypoint IS, when it is one. Reached by
   *  definition: nothing in this repository has to call it. */
  readonly symbol: string | undefined;
}

/**
 * The model's callable surface, read from the registry's reach table so the set
 * the gate roots on is the set the model is handed.
 *
 * It used to read the `BUILTIN_TOOLS` array literal. That literal is gone: the
 * eight names are now DERIVED from `TOOL_REACH`'s `native: true` rows, because a
 * hand list beside the table was membership-checked and not exhaustiveness-
 * checked. So this reads the same rows the derivation does, one AST level up. A
 * gate reading a spelling the source no longer has would measure nothing, which
 * `assertMeasured` turns into a failure rather than a pass.
 */
export function builtinToolNames(modules: ReadonlyMap<string, Module>,
  read: (file: string) => string): Set<string> {
  const names = new Set<string>();
  for (const [file, module] of modules) {
    if (!module.exports.has('TOOL_REACH')) continue;
    walk(parseOnce(file, read(file)).root, (node) => {
      if (node.raw.type !== 'VariableDeclarator') return;
      const [id, init] = node.children;
      if (id === undefined || identifierText(id) !== 'TOOL_REACH' || init === undefined) return;
      walk(init, (row) => {
        if (row.raw.type !== 'Property') return;
        const [key, value] = row.children;
        if (key === undefined || value === undefined || value.raw.type !== 'ObjectExpression') return;
        const name = identifierText(key) ?? literalText(key);
        if (name === undefined) return;
        // `native: true` is the membership rule; a row that reaches only codemode
        // is not handed to the model and must not root reachability.
        let native = false;
        walk(value, (field) => {
          if (field.raw.type !== 'Property') return;
          const [fieldKey, fieldValue] = field.children;
          if (fieldKey === undefined || fieldValue === undefined) return;
          if (identifierText(fieldKey) !== 'native') return;
          if (literalText(fieldValue) === 'true') native = true;
        });
        if (native) names.add(name);
      });
    });
  }
  return names;
}

/**
 * True when a value is a BUILT TOOL rather than anything else that happens to
 * sit under the same key: a call to the AI SDK's `tool(…)`, a call to a
 * `create…Tool` factory, or an object literal carrying an `execute` member.
 *
 * The name alone is not enough, and the measurement says how far off it is:
 * `run`, `file` and `web` are ordinary property names, so keying on the name
 * reported 164 builtin-tool entrypoints over a surface of 8. Every one of those
 * rooted a file that nothing enters, which makes reachability more permissive
 * and hides findings.
 */
function buildsATool(value: SyntaxNode | undefined): boolean {
  if (value === undefined) return false;
  const { raw } = value;
  if (raw.type === 'ObjectExpression') {
    return value.children.some((property) => property.raw.type === 'Property'
      && !property.raw.computed && property.raw.key.type === 'Identifier'
      && property.raw.key.name === 'execute');
  }
  if (raw.type === 'TSSatisfiesExpression' || raw.type === 'TSAsExpression'
    || raw.type === 'AwaitExpression') {
    return buildsATool(value.children[0]);
  }
  if (raw.type !== 'CallExpression') return false;
  const callee = identifierText(value.children[0] ?? value);
  return callee === 'tool' || (callee !== undefined && TOOL_FACTORY.test(callee));
}

/** A factory whose product is a tool. `createExecuteToolsTool`,
 *  `withClampedToolResult` and the like — named by convention here, and the
 *  convention is what the assembly in `tools/builtins.ts` uses throughout. */
const TOOL_FACTORY = /Tool(s)?(\b|$)|^with[A-Z]/;

/** The React DOM calls that mount a tree into a page. Both of this
 *  repository's browser bundles use one. */
const MOUNTS: ReadonlySet<string> = new Set(['createRoot', 'hydrateRoot']);

/** The exported declaration a node sits inside, so an entrypoint written inline
 *  is attributed to the symbol that owns it. */
function enclosingExport(node: SyntaxNode, module: Module): string | undefined {
  let top = node;
  while (top.parent?.parent !== undefined) top = top.parent;
  const name = declaredName(declarationOf(top).node);
  return name !== undefined && module.exports.has(name) ? name : undefined;
}

/**
 * Classes whose `extends` chain leaves this repository. A method on one of those
 * may be called by the framework that owns the base, and `OrchestratorAgent
 * extends ActorAgent extends AIChatAgent` means the chain has to be followed
 * rather than tested one link deep.
 */
function foreignRooted(
  files: ReadonlyMap<string, string>,
): Map<string, { file: string; node: SyntaxNode }> {
  const declared = new Map<string, { file: string; node: SyntaxNode; base: string | undefined }>();
  for (const [file, text] of files) {
    walk(parseOnce(file, text).root, (node) => {
      if (node.type !== 'ClassDeclaration') return;
      const name = declaredName(node);
      if (name !== undefined) declared.set(name, { file, node, base: superClassName(node) });
    });
  }
  const rooted = new Map<string, { file: string; node: SyntaxNode }>();
  for (const [name, entry] of declared) {
    let base = entry.base;
    for (let hop = 0; base !== undefined && hop < 16; hop += 1) {
      const parent = declared.get(base);
      if (parent === undefined) {
        rooted.set(name, { file: entry.file, node: entry.node });
        break;
      }
      base = parent.base;
    }
  }
  return rooted;
}

/**
 * Every entrypoint this tree declares.
 *
 * `invoked` is every name anything in the reacher corpus calls. A method on a
 * framework-rooted class that nothing here invokes is one the framework invokes:
 * that is what makes `beforeTurn`, `alarm` and `webSocketMessage` fall out
 * without a list of hook names, which would be the hand-kept thing this gate
 * exists to refuse.
 */
function importMetaMainNode(tree: SyntaxNode): SyntaxNode | undefined {
  let found: SyntaxNode | undefined;
  walk(tree, (node) => {
    const { raw } = node;
    if (raw.type === 'MemberExpression' && !raw.computed
      && raw.object.type === 'MetaProperty' && raw.object.meta.name === 'import'
      && raw.object.property.name === 'meta' && raw.property.type === 'Identifier'
      && raw.property.name === 'main') found = node;
  });
  return found;
}

export function findEntrypoints(
  reachers: ReadonlyMap<string, string>,
  modules: ReadonlyMap<string, Module>,
  builtins: ReadonlySet<string>,
): Entrypoint[] {
  const invoked = new Set<string>();
  for (const [file, text] of reachers) for (const name of invokedNames(file, text)) invoked.add(name);
  const rooted = foreignRooted(reachers);
  const found: Entrypoint[] = [];

  for (const [file, text] of reachers) {
    const module = modules.get(file);
    if (module === undefined) continue;
    const { root: tree, lineAt } = parseOnce(file, text);
    const add = (node: SyntaxNode, kind: EntrypointKind, at: string): void => {
      found.push({ file, line: lineAt(node.start), kind, at, symbol: enclosingExport(node, module) });
    };

    if (text.startsWith('#!')) {
      found.push({ file, line: 1, kind: 'process-entry', at: 'shebang', symbol: undefined });
    }

    const directProcessRoot = importMetaMainNode(tree);
    if (directProcessRoot !== undefined) {
      add(directProcessRoot, 'process-entry', 'import.meta.main');
    }

    for (const rpc of declaredRpcs(file, text)) {
      found.push({
        file, line: rpc.line, kind: 'callable-rpc', at: `${rpc.owner}.${rpc.method}`,
        symbol: module.exports.has(rpc.owner) ? rpc.owner : undefined,
      });
    }

    walk(tree, (node) => {
      const { raw } = node;

      // Bun's direct-execution guard. These files need no shebang when the
      // caller invokes `bun path/to/file.ts`, and their imports are production
      // reachability. Without this root, candidate-runner.ts imported
      // isHoleExtent while the gate reported that export as test-only.
      // `createRoot(document.getElementById('root')!).render(<App />)` — the one
      // call that puts a component tree on a page.
      if (raw.type === 'CallExpression' && raw.callee.type === 'Identifier'
        && MOUNTS.has(raw.callee.name)) {
        add(node, 'browser-bundle', raw.callee.name);
        return;
      }
      // `tools.run = tool({…})` and `{ run: tool({…}) }` — a handler bound under
      // a name the model sends. The VALUE has to be a built tool: `run` and
      // `file` are ordinary property names, and keying on the name alone found
      // 164 entrypoints where 8 tools exist, rooting files at random.
      if (raw.type === 'AssignmentExpression' && raw.left.type === 'MemberExpression'
        && !raw.left.computed && raw.left.property.type === 'Identifier'
        && builtins.has(raw.left.property.name) && buildsATool(node.children[1])) {
        add(node, 'builtin-tool', raw.left.property.name);
        return;
      }
      if (raw.type === 'Property' && !raw.computed && raw.key.type === 'Identifier'
        && builtins.has(raw.key.name) && buildsATool(node.children[1])) {
        add(node, 'builtin-tool', raw.key.name);
        return;
      }

      // `.command('chat')` — commander's registration, which is the only place a
      // CLI verb comes into being.
      if (raw.type === 'CallExpression' && raw.callee.type === 'MemberExpression'
        && !raw.callee.computed && raw.callee.property.type === 'Identifier'
        && raw.callee.property.name === 'command') {
        const [first] = raw.arguments;
        const verb = node.children.find((child) => child.raw === first);
        const name = verb === undefined ? undefined : literalText(verb);
        if (name !== undefined) add(node, 'cli-command', name);
        return;
      }

      // `export default { fetch, email, scheduled }` — the Workers module
      // contract. Every HTTP route on this backend is dispatched inside `fetch`.
      if (raw.type === 'ExportDefaultDeclaration') {
        const literal = node.children.find((child) => child.raw.type === 'ObjectExpression')
          ?? node.children[0]?.children.find((child) => child.raw.type === 'ObjectExpression');
        for (const property of literal?.children ?? []) {
          const key = property.children[0];
          const name = key === undefined ? undefined : identifierText(key);
          if (name !== undefined) {
            found.push({
              file, line: lineAt(property.start), kind: 'module-default', at: name,
              symbol: undefined,
            });
          }
        }
        return;
      }

      if (node.type !== 'ClassDeclaration') return;
      const owner = declaredName(node);
      if (owner === undefined || !rooted.has(owner)) return;
      for (const member of classMembers(node)) {
        if (member.type !== 'MethodDefinition' || methodKind(member) !== 'method') continue;
        if (member.raw.type === 'MethodDefinition'
          && (member.raw.computed || member.raw.accessibility === 'private'
            || member.raw.key.type === 'PrivateIdentifier')) continue;
        const method = declaredName(member);
        if (method === undefined || invoked.has(method)) continue;
        found.push({
          file, line: lineAt(member.start), kind: 'platform-hook', at: `${owner}.${method}`,
          symbol: module.exports.has(owner) ? owner : undefined,
        });
      }
    });
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/* ── Reachability ─────────────────────────────────────────────────────── */

/** The declaration site an exported name resolves to, chasing however many
 *  `export … from` hops stand between. This is the whole reason a barrel does
 *  not hide a symbol: the import is resolved to where the symbol is DECLARED. */
function declarationSite(
  file: string,
  name: string,
  modules: ReadonlyMap<string, Module>,
  seen: Set<string>,
): string | undefined {
  const key = `${file}#${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const module = modules.get(file);
  if (module === undefined) return undefined;
  if (name === 'default') {
    return module.defaultName === undefined ? undefined : `${file}#${module.defaultName}`;
  }
  if (module.exports.has(name)) return key;
  for (const forward of module.forwards) {
    if (forward.exported === name && forward.imported !== NAMESPACE) {
      const found = declarationSite(forward.file, forward.imported, modules, seen);
      if (found !== undefined) return found;
    }
    if (forward.imported === NAMESPACE && forward.exported === NAMESPACE) {
      const found = declarationSite(forward.file, name, modules, seen);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Every declaration site a module publishes, for `import * as ns` — which
 *  reaches all of them and says which nowhere a parser can read. */
function everySite(
  file: string,
  modules: ReadonlyMap<string, Module>,
  into: Set<string>,
  seen: Set<string>,
): void {
  if (seen.has(file)) return;
  seen.add(file);
  const module = modules.get(file);
  if (module === undefined) return;
  for (const name of module.exports) into.add(`${file}#${name}`);
  for (const forward of module.forwards) {
    if (forward.imported === NAMESPACE) everySite(forward.file, modules, into, seen);
    else {
      const site = declarationSite(forward.file, forward.imported, modules, new Set());
      if (site !== undefined) into.add(site);
    }
  }
}

export interface Reach {
  /** Files the entrypoint closure touches. */
  readonly live: ReadonlySet<string>;
  /** `file#name` a live file references. */
  readonly reached: ReadonlySet<string>;
}

export function measureReach(
  graph: Graph,
  entrypoints: readonly Entrypoint[],
): Reach {
  const live = new Set<string>();
  const frontier = [...new Set(entrypoints.map((entry) => entry.file))];
  for (const file of frontier) live.add(file);
  while (frontier.length > 0) {
    const file = frontier.pop();
    if (file === undefined) continue;
    for (const edge of graph.modules.get(file)?.edges ?? []) {
      if (live.has(edge)) continue;
      live.add(edge);
      frontier.push(edge);
    }
  }

  const reached = new Set<string>();
  for (const entry of entrypoints) {
    if (entry.symbol !== undefined) reached.add(`${entry.file}#${entry.symbol}`);
  }
  for (const file of live) {
    const module = graph.modules.get(file);
    if (module === undefined) continue;
    for (const [local, origin] of module.imports) {
      if (!module.referenced.has(local)) continue;
      if (origin.imported === NAMESPACE) {
        everySite(origin.file, graph.modules, reached, new Set());
        continue;
      }
      const site = declarationSite(origin.file, origin.imported, graph.modules, new Set());
      if (site !== undefined) reached.add(site);
    }
  }
  return { live, reached };
}

/* ── The two findings ─────────────────────────────────────────────────── */

export type WiredClass = 'unreached-export' | 'unsupplied-field';

export interface Unwired {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly kind: WiredClass;
  /** Why it is here, in the lock and in the output. */
  readonly reason: string;
}

export function findUnreached(
  graph: Graph,
  reach: Reach,
  tests: ReadonlyMap<string, string>,
  read: (file: string) => string,
): Unwired[] {
  // Imports COUNT here, unlike everywhere else in this gate: a suite that names
  // a symbol in its import list is touching it whatever it then does with it,
  // and "wire it or delete it with its test" needs the test named. In
  // production an import is only a binding, which is the whole reason a barrel
  // confers nothing — see `measureReach`.
  const testReferences = new Map<string, string[]>();
  for (const [file, text] of tests) {
    const { root: tree } = parseOnce(file, text);
    const touched = new Set(referencedNames(tree));
    for (const statement of tree.children) for (const name of importedNames(statement)) {
      touched.add(name);
    }
    for (const name of touched) {
      const list = testReferences.get(name) ?? [];
      list.push(file);
      testReferences.set(name, list);
    }
  }

  const found: Unwired[] = [];
  for (const [file, module] of graph.modules) {
    if (!inScope(file)) continue;
    const { lineAt, root: tree } = parseOnce(file, read(file));
    const lines = new Map<string, number>();
    for (const statement of tree.children) {
      if (isReExport(statement)) continue;
      const name = declaredName(declarationOf(statement).node);
      if (name !== undefined) lines.set(name, lineAt(statement.start));
    }
    for (const name of module.values) {
      if (reach.reached.has(`${file}#${name}`)) continue;
      const callers = testReferences.get(name) ?? [];
      const reason = !reach.live.has(file)
        ? 'no entrypoint reaches the file that declares it'
        : callers.length > 0
          ? `referenced only by ${String(callers.length)} test file(s): ${callers.slice(0, 3).join(', ')}`
          : 'no production reference anywhere; a barrel re-export is not one';
      found.push({ file, line: lines.get(name) ?? 1, name, kind: 'unreached-export', reason });
    }
  }
  return found;
}

/* ── Interface fields nothing supplies ────────────────────────────────── */

/** A written type, over the source range the name carrying it is visible on.
 *  Local annotations are the whole type information this gate has, and they are
 *  enough for the shape it asks about: `deps.mission` inside a function whose
 *  `deps` parameter is written `SwarmRunDeps`. Keyed BY NAME by the caller. */
interface Typed {
  readonly type: string;
  readonly from: number;
  readonly to: number;
}

/**
 * The OUTERMOST type names an annotation writes. `readonly X`, `X | undefined`
 * and `X[]` all yield `X`; `Record<string, X>` yields `Record` and NOT `X`,
 * because the annotated thing is the record and not the value inside it.
 *
 * Descending into type arguments was the first version and it produced false
 * positives immediately: `const labels: Record<ProviderId, string> = {…}` read
 * as a construction site of every type named anywhere in that annotation, so two
 * fields of `OAuthProviderConfig` were reported unsupplied by a literal that was
 * never one of its instances.
 */
function annotatedTypes(annotation: SyntaxNode | undefined): readonly string[] {
  if (annotation === undefined) return [];
  const names: string[] = [];
  const descend = (node: SyntaxNode): void => {
    if (node.raw.type === 'TSTypeReference') {
      const name = identifierText(node.children[0] ?? node);
      if (name === undefined) return;
      if (INSTANCE_UTILITIES.has(name)) {
        // `Omit<T, 'id'>` is still an instance of T's shape, minus a key — the
        // draft an `id`-minting seam takes is the case that made this visible:
        // every field the interface declares was supplied through such drafts
        // and the census read them as supplied by nothing. Only the FIRST
        // argument is the shape; `Record<K, V>` stays opaque above for the
        // reason its comment gives, and `Pick`/`Partial` are NOT here: a
        // `Pick<T, K>` literal cannot carry the keys outside K, so counting it
        // as a construction of T reported every other field of
        // `OAuthProviderConfig` as unsupplied on the first run of this rule.
        const arguments_ = node.children.find((child) => child.raw.type === 'TSTypeParameterInstantiation');
        const first = arguments_?.children[0];
        if (first !== undefined) descend(first);
        return;
      }
      names.push(name);
      return;
    }
    if (node.raw.type === 'TSTypeLiteral' || node.raw.type === 'TSFunctionType') return;
    for (const child of node.children) descend(child);
  };
  descend(annotation);
  return names;
}

/** The mapped utilities whose instances carry the annotated shape whole (less
 *  the named keys, for `Omit`). `Pick` and `Partial` are deliberately absent. */
const INSTANCE_UTILITIES: ReadonlySet<string> = new Set(['Omit', 'Required', 'Readonly']);

const annotationOf = (node: SyntaxNode): SyntaxNode | undefined =>
  node.children.find((child) => child.raw.type === 'TSTypeAnnotation');

/**
 * Expressions a value passes THROUGH on its way out of a `return`.
 *
 * A literal returned through one of these is still returned, and a detector
 * that read only a ReturnStatement's direct children could not see it.
 * `AgentOrchestrator.scopeTurn` returns
 * `labels.length === 0 ? turn : { ...turn, missionLabels: [...labels] }`, so
 * `CompletedTurn.missionLabels` was reported as read at one end and connected
 * at neither while being genuinely wired at both. That is the finding class
 * that gets a gate switched off, so the blind spot is the defect, not the code.
 */
const PASS_THROUGH: ReadonlySet<string> = new Set([
  'ConditionalExpression', 'LogicalExpression', 'ParenthesizedExpression',
  'SequenceExpression', 'TSAsExpression', 'TSSatisfiesExpression',
  'TSNonNullExpression',
]);

/** Every object literal a `return` can yield, through however many
 *  pass-through expressions stand between. */
function returnedLiterals(statement: SyntaxNode): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  const frontier = [...statement.children];
  while (frontier.length > 0) {
    const node = frontier.pop();
    if (node === undefined) continue;
    if (node.raw.type === 'ObjectExpression') found.push(node);
    else if (PASS_THROUGH.has(node.raw.type)) frontier.push(...node.children);
  }
  return found;
}

/** What one construction site says about supply. */
interface Supplied {
  readonly keys: readonly string[];
  /** A spread, a computed key or a method carries names this gate cannot read,
   *  so the site supplies everything as far as it is concerned. */
  readonly opaque: boolean;
}

/** The keys an object literal supplies, and whether it is opaque. */
function suppliedKeys(literal: SyntaxNode): Supplied {
  const keys: string[] = [];
  let opaque = false;
  for (const property of literal.children) {
    if (property.raw.type === 'SpreadElement') { opaque = true; continue; }
    if (property.raw.type !== 'Property' || property.raw.computed) { opaque = true; continue; }
    const key = property.children[0];
    const name = key === undefined ? undefined : identifierText(key) ?? literalText(key);
    if (name === undefined) opaque = true;
    else keys.push(name);
  }
  return { keys, opaque };
}

export interface FieldFacts {
  /** `Interface#field` production reads through a typed binding. */
  readonly reads: ReadonlySet<string>;
  /** `Interface#field` some visible construction site supplies. */
  readonly supplies: ReadonlySet<string>;
  /** Interfaces with at least one visible construction site. */
  readonly constructed: ReadonlySet<string>;
}

/**
 * Where production builds each interface, and which of its fields it reads.
 *
 * A construction site is one this gate can SEE syntactically: an annotated
 * declarator, a `satisfies` or `as`, a literal returned from a function whose
 * return type names the interface, or an object literal handed to a locally
 * declared function at a parameter position that names it. Anything else — a
 * literal passed to a dependency, a cast through `unknown` — makes the interface
 * unconstructed here, and an unconstructed interface produces no finding at all.
 */
export function measureFields(reachers: ReadonlyMap<string, string>): FieldFacts {
  const reads = new Set<string>();
  const supplies = new Set<string>();
  const constructed = new Set<string>();

  // `interface ActorToolsetDeps extends BuiltinToolDeps` — a literal annotated
  // with the SUBTYPE supplies the base's fields too. Without this, 11 fields of
  // `BuiltinToolDeps` were reported unsupplied while the object that fills them
  // is written one interface down.
  const bases = new Map<string, readonly string[]>();
  // `name -> parameter type names, by position`, keyed by function name only.
  // A collision merges both signatures, which widens supply and can only remove
  // findings.
  const parameters = new Map<string, string[][]>();
  for (const [file, text] of reachers) {
    walk(parseOnce(file, text).root, (node) => {
      if (node.type === 'TSInterfaceDeclaration') {
        const name = declaredName(node);
        const extended = node.children
          .filter((child) => child.raw.type === 'TSInterfaceHeritage')
          .map((child) => identifierText(child.children[0] ?? child))
          .filter((base): base is string => base !== undefined);
        if (name !== undefined && extended.length > 0) bases.set(name, extended);
        return;
      }
      // `type CFRuntime = AgentRuntime & { … }` is `extends` spelled as an
      // intersection: a literal annotated with the alias supplies every named
      // member's fields. Without this, AgentRuntime.deviceTransport read as
      // unsupplied while the one production runtime literal that fills it was
      // annotated `CFRuntime` — an alias this walk never resolved.
      if (node.type === 'TSTypeAliasDeclaration') {
        const name = declaredName(node);
        const body = node.children.find((child) => child.raw.type === 'TSIntersectionType');
        if (name === undefined || body === undefined) return;
        const members = body.children
          .map((child) => (child.raw.type === 'TSTypeReference' ? identifierText(child.children[0] ?? child) : undefined))
          .filter((member): member is string => member !== undefined);
        if (members.length > 0) bases.set(name, members);
        return;
      }
      if (!isFunctionLike(node)) return;
      const name = declaredName(node) ?? declaredName(node.parent ?? node);
      if (name === undefined) return;
      // By IDENTITY against `raw.params`, never by node type: a
      // `FunctionDeclaration`'s own `id` is an `Identifier` child too, so
      // filtering on the type shifted every parameter one place right and
      // `buildActorTools`'s only argument was read as position 1.
      const declared = 'params' in node.raw ? node.raw.params : [];
      const positions = node.children
        .filter((child) => declared.some((param) => param === child.raw))
        .map((child) => [...annotatedTypes(annotationOf(child))]);
      const seen = parameters.get(name) ?? [];
      positions.forEach((types, index) => {
        seen[index] = [...(seen[index] ?? []), ...types];
      });
      parameters.set(name, seen);
    });
  }

  /** A type and everything it inherits from, so a subtype's supply counts. */
  const withBases = (types: readonly string[]): readonly string[] => {
    const all = new Set<string>();
    const frontier = [...types];
    while (frontier.length > 0) {
      const type = frontier.pop();
      if (type === undefined || all.has(type)) continue;
      all.add(type);
      frontier.push(...(bases.get(type) ?? []));
    }
    return [...all];
  };

  const site = (types: readonly string[], literal: SyntaxNode): void => {
    const { keys, opaque } = suppliedKeys(literal);
    for (const type of withBases(types)) {
      constructed.add(type);
      if (opaque) supplies.add(`${type}#${NAMESPACE}`);
      for (const key of keys) supplies.add(`${type}#${key}`);
    }
  };

  for (const [file, text] of reachers) {
    const { root: tree } = parseOnce(file, text);
    // BY NAME, not a flat list: every member access was compared against every
    // annotated binding in the file, which is quadratic in the largest files and
    // was most of a 3.6 s run.
    const typed = new Map<string, Typed[]>();
    /** `const x = { … }` — the literal a name is bound to, so an argument
     *  passed as a NAME is still a construction site. `actor-agent.ts` writes
     *  its whole toolset deps as `const builtinDeps: Parameters<typeof
     *  buildActorTools>[0] = { … }` and passes the name: an annotation no
     *  parser here can resolve, and the literal that fills eleven fields of
     *  `BuiltinToolDeps`. Following the name is what makes those eleven not a
     *  false positive. */
    const literals = new Map<string, SyntaxNode>();
    walk(tree, (node) => {
      if (node.raw.type === 'VariableDeclarator') {
        const bound = identifierText(node.children[0] ?? node);
        const init = node.children.find((child) => child.raw.type === 'ObjectExpression');
        if (bound !== undefined && init !== undefined) literals.set(bound, init);
      }
      const annotation = annotationOf(node);
      const scope = owningScope(node);
      const bound = identifierText(node.children[0] ?? node) ?? identifierText(node);
      if (annotation === undefined || bound === undefined) return;
      for (const type of annotatedTypes(annotation)) {
        typed.set(bound, [...(typed.get(bound) ?? []), { type, from: scope.from, to: scope.to }]);
      }
    });

    walk(tree, (node) => {
      const { raw } = node;

      if (raw.type === 'MemberExpression' && !raw.computed && raw.property.type === 'Identifier') {
        const receiver = identifierText(node.children[0] ?? node);
        if (receiver !== undefined) {
          for (const binding of typed.get(receiver) ?? []) {
            if (node.start < binding.from || node.end > binding.to) continue;
            reads.add(`${binding.type}#${raw.property.name}`);
          }
        }
        // `deps.field = …` supplies it.
        if (node.parent?.raw.type === 'AssignmentExpression'
          && node.parent.raw.left === raw && receiver !== undefined) {
          for (const binding of typed.get(receiver) ?? []) {
            supplies.add(`${binding.type}#${raw.property.name}`);
          }
        }
        return;
      }

      if (raw.type === 'VariableDeclarator') {
        const init = node.children.find((child) => child.raw.type === 'ObjectExpression');
        if (init !== undefined) site(annotatedTypes(annotationOf(node.children[0] ?? node)), init);
        return;
      }
      if (raw.type === 'TSSatisfiesExpression' || raw.type === 'TSAsExpression') {
        const literal = node.children.find((child) => child.raw.type === 'ObjectExpression');
        if (literal !== undefined) {
          site(annotatedTypes(node.children[1] ?? node), literal);
        }
        return;
      }
      if (isFunctionLike(node)) {
        const returned = annotatedTypes(returnTypeOf(node));
        if (returned.length === 0) return;
        walk(node, (inner) => {
          if (inner.raw.type !== 'ReturnStatement') return;
          for (const literal of returnedLiterals(inner)) site(returned, literal);
        });
        return;
      }

      // `Object.assign(runDeps, { signal })` — a supply that no annotation
      // carries. Two fields of `SwarmRunDeps` are wired exactly this way and
      // were false positives until this arm existed.
      if (raw.type === 'CallExpression' && raw.callee.type === 'MemberExpression'
        && !raw.callee.computed && raw.callee.property.type === 'Identifier'
        && raw.callee.property.name === 'assign') {
        const [into, ...rest] = node.children.slice(1);
        const target = into === undefined ? undefined : identifierText(into);
        const types = target === undefined
          ? []
          : (typed.get(target) ?? []).map((binding) => binding.type);
        for (const argument of rest) {
          if (argument.raw.type === 'ObjectExpression') site(types, argument);
          else for (const type of types) supplies.add(`${type}#${NAMESPACE}`);
        }
        return;
      }
      if (raw.type !== 'CallExpression') return;
      const callee = identifierText(node.children[0] ?? node);
      const positions = callee === undefined ? undefined : parameters.get(callee);
      if (positions === undefined) return;
      node.children.slice(1).forEach((argument, index) => {
        const literal = argument.raw.type === 'ObjectExpression'
          ? argument
          : literals.get(identifierText(argument) ?? '');
        if (literal !== undefined) site(positions[index] ?? [], literal);
      });
    });
  }
  return { reads, supplies, constructed };
}

/** A source range, in byte offsets. */
interface Span {
  readonly from: number;
  readonly to: number;
}

/** The range a binding's name is visible over: the function that encloses it,
 *  or the whole module. */
function owningScope(node: SyntaxNode): Span {
  let up: SyntaxNode | undefined = node;
  let last: SyntaxNode = node;
  while (up !== undefined) {
    if (isFunctionLike(up)) return { from: up.start, to: up.end };
    last = up;
    up = up.parent;
  }
  return { from: last.start, to: last.end };
}

/**
 * Optional fields production reads and no production construction site supplies.
 *
 * The interface must be CONSTRUCTED somewhere visible: an interface this gate
 * cannot see built is one whose supply it cannot judge, and guessing there is
 * how a gate earns a false positive and then a disabled line in a config.
 */
export function findUnsupplied(
  graph: Graph,
  reach: Reach,
  facts: FieldFacts,
  read: (file: string) => string,
): Unwired[] {
  const found: Unwired[] = [];
  for (const [file, module] of graph.modules) {
    if (!inScope(file) || !reach.live.has(file)) continue;
    const { root: tree, lineAt } = parseOnce(file, read(file));
    walk(tree, (node) => {
      if (node.type !== 'TSInterfaceDeclaration') return;
      const owner = declaredName(node);
      if (owner === undefined || !module.exports.has(owner)) return;
      if (!facts.constructed.has(owner)) return;
      if (facts.supplies.has(`${owner}#${NAMESPACE}`)) return;
      walk(node, (member) => {
        if (!isOptionalMember(member)) return;
        const field = declaredName(member);
        if (field === undefined) return;
        if (!facts.reads.has(`${owner}#${field}`)) return;
        if (facts.supplies.has(`${owner}#${field}`)) return;
        found.push({
          file,
          line: lineAt(member.start),
          name: `${owner}.${field}`,
          kind: 'unsupplied-field',
          reason: 'production reads this field and no production construction site of the '
            + 'interface supplies it, so the wire is read at one end and connected at neither',
        });
      });
    });
  }
  return found;
}

/* ── Verdict ──────────────────────────────────────────────────────────── */

export const keyOf = (entry: Unwired): string => `${entry.file}#${entry.name} (${entry.kind})`;

export const describe = (entry: Unwired): string =>
  `  ${entry.file}:${String(entry.line)} ${entry.name} — ${entry.reason}`;

/**
 * What this gate cannot see, printed on the GREEN path.
 *
 * A limitation visible only in red output is invisible exactly when the tree is
 * clean, which is when somebody is deciding how much to trust the signal.
 */
export const BLIND_SPOTS: readonly string[] = [
  'DYNAMIC DISPATCH THROUGH A REGISTRY OR A STRING KEY — NOT DETECTED. A handler registered '
  + 'as `registry.register(x)` and selected later by an id read off the wire is reached '
  + 'through a VALUE, not through a name, so reachability over identifiers says nothing about '
  + 'it. Confirmed live instance: `strategy/heads.ts` and `strategy/mcts.ts` both read as '
  + 'reached here, because `fork-deps.ts` names their factories and `actor-agent.ts` calls '
  + 'that; whether anything ever SELECTS either strategy is a fact about the registry, and '
  + 'this gate cannot see it. `gate:reachability` closes the one case where the string is the '
  + 'whole surface (`@callable`); every other registry here is open.',
  'A SYMBOL REACHED ONLY FROM A CONFIG FILE — NOT DETECTED, and it fails in the FALSE '
  + 'POSITIVE direction rather than the quiet one. `wrangler.jsonc` binds five Durable Object '
  + 'classes by string, and no config is in this corpus; the classes are rooted on their '
  + 'framework-rooted methods instead, so a class named only in config and carrying no such '
  + 'method would be reported unwired.',
  'A FIELD ASSIGNED AND NEVER READ — NOT DETECTED. The supply detector answers the other '
  + 'direction only: read in production, supplied by no visible construction site. Confirmed '
  + 'live instance: `StrategyResult.cost.selfMetered` (`strategy/types.ts:131`) is written at '
  + '`heads.ts:119` and `mcts.ts:118` and read by nothing anywhere, and this gate is silent on '
  + 'it in both of its halves — the writer sits on a path only the registry can enter, which '
  + 'is the blind spot above.',
  'A SYMBOL WIRED FOR ONE ARM OF A UNION AND UNWIRED FOR ANOTHER — NOT DETECTED. This gate '
  + 'stops at "some production path reaches it", so a per-step debit that runs for a '
  + 'tool-using node and never for a toolless one reads as green: the toolless arm builds no '
  + 'node deps, so the step path is never entered and every such search would have been free. '
  + 'Measured 2026-08-19 while `SwarmRunDeps.mission` was being wired. Per-arm reach needs one '
  + 'entrypoint set per arm, which is the same shape as the per-backend residual below.',
  'PER-BACKEND REACH — NOT DETECTED. Reachability is one whole-tree union, so a symbol still '
  + 'wired on cf-backend reads as live after cli-backend drops the wire. The same residual '
  + '`gate:dead-code` states; closing it needs one entrypoint set per backend and a diff.',
  'A DEFAULT EXPORT — OUT OF SCOPE as a finding, though it is resolved as a CONSUMER. '
  + '`export default` publishes no name, so the census cannot key it; nine product files use '
  + 'it, all React page components, and `import Page from` is followed to the name the '
  + 'declaration carries so those pages are not phantom findings.',
  'WHETHER A REACHED SYMBOL DOES ANYTHING. This gate proves a path exists from an entrypoint. '
  + 'It has no opinion on whether the call site reads the result, so a reached function whose '
  + 'return value is discarded passes. `gate:reachability` states the same residual for an '
  + 'RPC whose result nobody reads.',
  'AN OVER-EXPORTED SYMBOL WHOSE LOGIC RUNS. A `const` used inside its own file and exported '
  + 'for a test is reported, because the EXPORT has no production consumer — but the logic is '
  + 'live, so the fix is to unexport it rather than to wire it. The census does not separate '
  + 'the two; the reason line says which files reference it, which is what tells them apart.',
];

if (import.meta.main) {
  const reachers = readMatching(isReacher);
  const tests = readTests();
  const read = (file: string): string => reachers.get(file) ?? '';

  const graph = buildGraph(reachers);
  if (graph.dangling.length > 0) {
    throw new Error(
      `wired: ${String(graph.dangling.length)} local import(s) resolve to no file in the tree. `
      + 'Each is a dropped edge, and a dropped edge shrinks reachability silently:\n  '
      + graph.dangling.join('\n  '),
    );
  }

  const builtins = builtinToolNames(graph.modules, read);
  const entrypoints = findEntrypoints(reachers, graph.modules, builtins);
  const reach = measureReach(graph, entrypoints);
  const facts = measureFields(reachers);

  const governed = [...graph.modules.keys()].filter(inScope);
  const exports = governed.reduce(
    (total, file) => total + (graph.modules.get(file)?.exports.size ?? 0), 0,
  );

  // Upstream of both write paths, over every count that could be silently zero.
  // An empty corpus, a resolver that matched nothing, an entrypoint detector that
  // stopped matching, or a reach set of zero would each make this gate report a
  // clean tree over a population nobody looked at — and the ratchet hides that
  // best of all, because an empty scan locks no findings.
  const measured = assertMeasured('wired', [
    ['files that can reach', reachers.size],
    ['governed files', governed.length],
    ['exported declarations', exports],
    ['tests searched for callers', tests.size],
    ['builtin tool names', builtins.size],
    ['entrypoints discovered', entrypoints.length],
    ['live files', reach.live.size],
    ['symbols reached', reach.reached.size],
    ['interfaces built somewhere visible', facts.constructed.size],
  ]);

  if (process.argv.includes('--entrypoints')) {
    for (const entry of entrypoints) {
      console.log(`${entry.kind}\t${entry.file}:${String(entry.line)}\t${entry.at}`
        + `\t${entry.symbol ?? '-'}`);
    }
    console.log(`wired: ${String(entrypoints.length)} entrypoint(s) over ${measured}`);
    process.exit(0);
  }

  const findings = [
    ...findUnreached(graph, reach, tests, read),
    ...findUnsupplied(graph, reach, facts, read),
  ].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));

  const detail = new Map(findings.map((entry) => [keyOf(entry), describe(entry)]));
  const keys = [...detail.keys()];

  if (process.argv.includes('--lock')) {
    console.log(`wired: locked ${String(writeLock(keys, LOCK))} finding(s) over ${measured}`);
    process.exit(0);
  }

  const ratchet = reconcile(keys, LOCK);
  const code = report('wired', ratchet, detail, 'bun scripts/wired.ts --lock', measured);
  if (code === 0) {
    console.log(`wired: ${String(keys.length)} recorded unwired export(s)/field(s) remain — `
      + 'visible work, not a clean tree. `bun scripts/wired.ts` names them.');
    for (const spot of BLIND_SPOTS) console.log(`  blind: ${spot}`);
  }
  process.exit(code);
}
