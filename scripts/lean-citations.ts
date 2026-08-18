/**
 * The Lean citation gate: a source header naming a Lean theorem must name one that
 * exists, in the module it says.
 *
 * WHY IT EXISTS. `lean/check-traceability.mjs` proves Lean -> TypeScript — every
 * claimed theorem is declared, every `tsRef` resolves to a real line. Nothing
 * proved TypeScript -> Lean, so `mcts/engine.ts`'s header reading
 * `Formal spec: MCTS/StorageIsolation.lean — init_isolated,
 * transition_preserves_isolation` was unchecked prose: delete the theorem and the
 * header still claims it, and `PR-MCTS-003`'s own `tsRefs` point at three other
 * files entirely. A citation with no checker is a comment that reads like a
 * guarantee.
 *
 * It was not hypothetical. On introduction this gate found three stale citations
 * that every other gate in the repository had passed: `mcts/schemas.ts` and
 * `types/mcts.ts` both cited `MCTS/Backpropagation.lean:initial_valid`, a theorem
 * the Float-to-scaled-integer rewrite had renamed to `initial_in_range`, and
 * `unit-consolidation.test.ts` cited `CraftStore.lean — all_below_gives_empty,
 * consolidation_requires_nonempty_guard`, two names that have never existed in
 * any module.
 *
 * WHY IT IS A SEPARATE PROGRAM. It needs two things that cannot meet in one file.
 * The corpus must come from `sources.ts`, the repository's single enumeration, and
 * the declarations must come from the scanner `check-traceability.mjs` already
 * owns. That `.mjs` cannot import `sources.ts`: the anti-slop `RAW_NODE_MODULE`
 * boundary is measured over the plugin's own entrypoints, and widening it for a
 * Lean gate would be exactly the "gate measured one set and governed another"
 * defect `sources.ts` documents. So the declarations cross as that program's
 * stdout under `--list-declarations`. One scanner, two consumers, and no second
 * spelling of either the file enumeration or the Lean parser.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isTextSource, readMatching } from './sources';

const repoRoot = new URL('..', import.meta.url).pathname;
const leanRoot = join(repoRoot, 'lean');

/** A cited path: `MCTS/Foo.lean`, `lean/Proteus/MCTS/Foo.lean`, bare `Foo.lean`,
 *  or the brace form `Execution/{Capabilities,ToolSystem}.lean`. */
const LEAN_PATH = /(?:[A-Za-z0-9_./-]|\{[A-Za-z0-9_,]+\})+\.lean/g;

/**
 * A citation with theorem names attached, in the two spellings the tree uses:
 * `Foo.lean:name` and `Foo.lean — name, name`.
 *
 * A name must be snake_case, and that is load-bearing rather than cosmetic: the
 * colon form runs into prose, so `StorageIsolation.lean: branch storage disjoint`
 * (`cf-backend/src/runtime.ts`) would otherwise report `branch` as a missing
 * theorem. The cost is one blind spot — an underscore-free theorem that gets
 * renamed — and `CITATION_OPAQUE` below is the ratchet that stops it growing.
 */
/** A citation naming a LINE rather than a theorem: `Foo.lean:470` or a range
 *  `Foo.lean:470-478`. Only the first number is checked, because a range whose start
 *  is in the file and whose end is not is the same finding. */
const CITED_LINE = /((?:[A-Za-z0-9_./-]|\{[A-Za-z0-9_,]+\})+\.lean):([1-9][0-9]*)/g;

const CITED_NAMES =
  /((?:[A-Za-z0-9_./-]|\{[A-Za-z0-9_,]+\})+\.lean)(?::([a-z][A-Za-z0-9_']*)|[ \t]*(?:—|–|--)[ \t]*((?:[a-z][A-Za-z0-9_']*)(?:[ \t]*,\s*[a-z][A-Za-z0-9_']*)*))/g;

/** Theorem names this scanner cannot see, because they carry no underscore. The
 *  set is asserted against the declarations, so a NEW one fails the gate naming
 *  itself instead of quietly joining the blind spot. */
const CITATION_OPAQUE = { 'Proteus.Execution.Capabilities.chain': true } as const;

const findings: string[] = [];
const fail = (message: string): void => { findings.push(message); };

/** `{A,B}/x.lean` names two modules. Expanded rather than skipped: it is how
 *  `Execution/{Capabilities,ToolSystem}.lean` is spelled, and skipping it would
 *  leave a real citation unchecked. */
function expandBraces(path: string): string[] {
  const match = path.match(/\{([A-Za-z0-9_,]+)\}/);
  if (match === null) return [path];
  return match[1].split(',').flatMap((alt) => expandBraces(path.replace(match[0], alt)));
}

/** `qualified name -> the module that declares it`, from the one Lean scanner. */
function readDeclarations(): Map<string, string> {
  const listed = spawnSync('node', [join(leanRoot, 'check-traceability.mjs'), '--list-declarations'], {
    cwd: leanRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (listed.error !== undefined) {
    throw new Error(`lean-citations: could not run the declaration scanner: ${listed.error.message}`);
  }
  if (listed.status !== 0) {
    throw new Error(
      `lean-citations: the declaration scanner failed (exit ${String(listed.status)}): ${listed.stderr}`,
    );
  }
  const declarations = new Map<string, string>();
  for (const line of listed.stdout.split('\n')) {
    if (line.length === 0) continue;
    const [name, module] = line.split('\t');
    if (name === undefined || module === undefined) {
      throw new Error(`lean-citations: unreadable declaration line: ${line}`);
    }
    declarations.set(name, module);
  }
  // An empty corpus reports a clean tree, which is the one failure a gate must not
  // have — the same reason `sources.ts` throws on an empty enumeration.
  if (declarations.size === 0) throw new Error('lean-citations: the scanner listed no theorem');
  return declarations;
}

const declarations = readDeclarations();

/** Modules by basename, because `docs/MCTS.md` and the exploration spec cite bare
 *  `StorageIsolation.lean`. An ambiguous basename fails rather than guessing: two
 *  modules of one name make every bare citation of it unresolvable in principle,
 *  and picking the first is how a check starts governing a set it did not
 *  measure. */
const byBasename = new Map<string, string[]>();
for (const module of new Set(declarations.values())) {
  const base = module.slice(module.lastIndexOf('/') + 1);
  byBasename.set(base, [...(byBasename.get(base) ?? []), module]);
}

/** Repo-relative module path for a cited path, or `null` when nothing matches. */
function resolveCitation(path: string): string | null {
  for (const prefix of ['', 'lean/', 'lean/Proteus/']) {
    const candidate = `${prefix}${path}`;
    if (candidate.startsWith('lean/')
      && resolve(repoRoot, candidate).startsWith(`${leanRoot}/`)
      && existsSync(join(repoRoot, candidate))) return candidate;
  }
  const base = byBasename.get(path.slice(path.lastIndexOf('/') + 1));
  if (base === undefined) return null;
  if (base.length > 1) {
    fail(`ambiguous Lean module basename cited as ${path}: ${base.join(', ')}`);
    return null;
  }
  return base[0];
}

for (const name of declarations.keys()) {
  if (!name.includes('_') && !Object.hasOwn(CITATION_OPAQUE, name)) {
    fail(
      `theorem name without an underscore is invisible to the citation scanner: ${name}`
      + ' — rename it in snake_case, or enrol it in CITATION_OPAQUE and accept that a'
      + ' rename of it will not be caught',
    );
  }
}
for (const name of Object.keys(CITATION_OPAQUE)) {
  if (!declarations.has(name)) fail(`CITATION_OPAQUE names a theorem that no longer exists: ${name}`);
}

const corpus = readMatching(isTextSource);
let modulesCited = 0;
let namesCited = 0;
let linesCited = 0;
for (const [file, text] of corpus) {
  // `lean/` is the other side of the citation and is checked by the traceability
  // gate. This file is excluded because its own docstring quotes the citations it
  // exists to catch — the same reason a secret scanner does not scan its fixtures.
  // It carries no real citation and must not acquire one.
  if (file.startsWith('lean/') || file === 'scripts/lean-citations.ts') continue;
  // Strip JSDoc continuation leaders, so a citation wrapped across lines reads as
  // one string. `consolidation_never_empties,\n * consolidation_nonincreasing` is
  // the live case.
  const flat = text.replace(/^[ \t]*\*[ \t]?/gm, '');

  for (const match of flat.matchAll(LEAN_PATH)) {
    for (const path of expandBraces(match[0])) {
      modulesCited += 1;
      if (resolveCitation(path) === null) {
        fail(`${file}: cites a Lean module that does not exist: ${path}`);
      }
    }
  }

  // A `Foo.lean:470` citation is the other way a Lean reference rots, and it rots
  // FASTER than a name: a theorem keeps its name across edits and loses its line
  // number on the next insertion above it. §10.1's S7 row cites three theorems by
  // line, and `check-traceability.mjs` already range-checks its own `tsRef`s this
  // way, so the Lean side gets the same treatment rather than a weaker one.
  for (const match of flat.matchAll(CITED_LINE)) {
    const module = resolveCitation(match[1]);
    if (module === null) continue;   // already reported by the module scan above
    linesCited += 1;
    const lineCount = readFileSync(join(repoRoot, module), 'utf8').split('\n').length;
    if (Number(match[2]) > lineCount) {
      fail(
        `${file}: cites ${match[1]}:${match[2]}, but ${module} has ${String(lineCount)} lines`
        + ' — the citation outlived the line it names',
      );
    }
  }

  for (const match of flat.matchAll(CITED_NAMES)) {
    const modules = expandBraces(match[1]).map(resolveCitation).filter((m) => m !== null);
    const names = (match[2] ?? match[3] ?? '').split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0 && name.includes('_'));
    for (const name of names) {
      namesCited += 1;
      const declaring = [...declarations].filter(([qualified]) => qualified.endsWith(`.${name}`));
      if (declaring.length === 0) {
        fail(
          `${file}: cites Lean theorem \`${name}\` (${match[1]}), which no Lean source declares`
          + ' — a header naming a theorem nobody proves is worse than no header',
        );
        continue;
      }
      if (modules.length > 0 && !declaring.some(([, module]) => modules.includes(module))) {
        fail(
          `${file}: cites \`${match[1]} — ${name}\`, but ${name} is declared in`
          + ` ${declaring.map(([, module]) => module).join(', ')} — the theorem moved and the`
          + ' citation did not',
        );
      }
    }
  }
}

if (modulesCited === 0 || namesCited === 0) {
  fail(
    `citation scan found ${modulesCited} module and ${namesCited} theorem references,`
    + ' so it cannot fail — a gate with an empty corpus certifies nothing',
  );
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`✗ ${finding}`);
  console.error(`lean-citations: ${String(findings.length)} finding(s)`);
  process.exit(1);
}
console.log(
  `lean-citations: OK — ${String(declarations.size)} theorems, ${String(modulesCited)} module,`
  + ` ${String(namesCited)} theorem and ${String(linesCited)} line citations across`
  + ` ${String(corpus.size)} files`,
);
