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
 * that every other gate in the repository had passed. `mcts/schemas.ts` and
 * `types/mcts.ts` both named `initial_valid`, a theorem the
 * Float-to-scaled-integer rewrite had renamed to `initial_in_range`; and
 * `unit-consolidation.test.ts` named two `CraftStore.lean` theorems,
 * `all_below_gives_empty` and `consolidation_requires_nonempty_guard`, which have
 * never existed in any module.
 *
 * Those three defects are described HERE without being re-spelled as citations,
 * which is deliberate: a gate's own account of what it caught must not be a thing
 * it catches. Where an illustration genuinely needs the citation SHAPE, it is
 * enrolled in `CITATION_ILLUSTRATIVE` below rather than skipped.
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

/** A cited path, in the three spellings the tree uses. `Foo` here is a placeholder
 *  for any module: `MCTS/Foo.lean`, `lean/Proteus/MCTS/Foo.lean`, bare `Foo.lean`,
 *  or the brace form `Execution/{Capabilities,ToolSystem}.lean`. */
const LEAN_PATH = /(?:[A-Za-z0-9_./-]|\{[A-Za-z0-9_,]+\})+\.lean/g;

/**
 * A citation with theorem names attached, in the two spellings the tree uses. For
 * example `Foo.lean:name` and `Foo.lean — name, name`, with `Foo` a placeholder.
 *
 * A name must be snake_case, and that is load-bearing rather than cosmetic: the
 * colon form runs into prose, so `StorageIsolation.lean: branch storage disjoint`
 * (`cf-backend/src/runtime.ts`) would otherwise report `branch` as a missing
 * theorem. The cost is one blind spot — an underscore-free theorem that gets
 * renamed — and `CITATION_OPAQUE` below is the ratchet that stops it growing.
 */
/** A citation naming a LINE rather than a theorem. For example `Foo.lean:470`, or a
 *  range `Foo.lean:470-478` — `Foo` is a placeholder again. Only the first number is
 *  checked, because a range whose start is in the file and whose end is not is the
 *  same finding. */
const CITED_LINE = /((?:[A-Za-z0-9_./-]|\{[A-Za-z0-9_,]+\})+\.lean):([1-9][0-9]*)/g;

const CITED_NAMES =
  /((?:[A-Za-z0-9_./-]|\{[A-Za-z0-9_,]+\})+\.lean)(?::([a-z][A-Za-z0-9_']*)|[ \t]*(?:—|–|--)[ \t]*((?:[a-z][A-Za-z0-9_']*)(?:[ \t]*,\s*[a-z][A-Za-z0-9_']*)*))/g;

/** Theorem names this scanner cannot see, because they carry no underscore. The
 *  set is asserted against the declarations, so a NEW one fails the gate naming
 *  itself instead of quietly joining the blind spot. */
const CITATION_OPAQUE = { 'Proteus.Execution.Capabilities.chain': true } as const;

/**
 * Citations presented as ILLUSTRATIONS rather than as references — the declared
 * category, and the reason it is a category and not a skip.
 *
 * The defect it answers: `docs/EXPLORATION-SPEC.md` §10.1 documents THIS GATE's own
 * red-proof, and writing down how the instrument catches a bad citation made the
 * gate fire on the documentation. The only way to green the tree was to delete the
 * account of the check, which would make this an instrument for undocumented gates.
 * `LiteratureGate` hit the mirror image — a withdrawn number quoted inside the
 * paragraph that withdraws it, where a naive rule forces the CORRECTION to be
 * deleted — and its answer is the shape adopted here.
 *
 * THREE PROPERTIES, shared with `hand: 'withdrawn'` in `scripts/literature.ts`, and
 * the shape rather than the name is what is shared:
 *
 * 1. ENROLLED, so adding one is a reviewable edit rather than a regex tweak. Same
 *    ratchet as `CITATION_OPAQUE`.
 * 2. It CHANGES which check applies and never disables one. A reference must
 *    RESOLVE; an illustration must NOT — see `checkIllustrative`.
 * 3. The residual check makes the category self-policing. An illustration may not
 *    name a module that exists, so declaring a real reference as an illustration is
 *    INEFFECTIVE rather than exculpatory: the declaration is refused and the
 *    citation is still checked live. That is what stops the marker laundering a
 *    genuinely stale citation, which is the only thing a category like this could
 *    get wrong.
 *
 * There is deliberately NO marker token at the site. A token is a suppression
 * handle: it costs an author nothing, so it gets pasted, and later nobody can tell
 * an illustration from a silencing. The site is recognised instead by the ordinary
 * language a documenting author already writes — see `DOCUMENTING_PROSE` — so the
 * gate rides on documentation the reader wanted anyway.
 */
interface Illustrative {
  /** The file whose prose presents this as an example. */
  readonly file: string;
  /** The citation exactly as written. NOT a pattern — a pattern is an allowlist. */
  readonly cites: string;
  /** Why it is an illustration. Required: a declared category with no stated reason
   *  is a skip wearing a costume. */
  readonly reason: string;
}

const CITATION_ILLUSTRATIVE: readonly Illustrative[] = [
  {
    file: 'scripts/lean-citations.ts',
    cites: 'Foo.lean:<line>',
    reason: "`citedToken`'s docstring explaining why `Foo.lean:<line>` and"
      + ' `Foo.lean:470` are separate entries rather than one pattern, and this'
      + ' register quoting that spelling to say so.',
  },
  {
    file: 'scripts/lean-citations.ts',
    cites: 'MCTS/Foo.lean',
    reason: 'A placeholder in the docstring naming the three path spellings accepted.',
  },
  {
    file: 'scripts/lean-citations.ts',
    cites: 'lean/Proteus/MCTS/Foo.lean',
    reason: 'The same placeholder in its prefixed spelling.',
  },
  {
    file: 'scripts/lean-citations.ts',
    cites: 'Foo.lean',
    reason: 'The same placeholder in its bare spelling, which is the case basename'
      + ' resolution exists for.',
  },
  {
    file: 'scripts/lean-citations.ts',
    cites: 'Foo.lean:name',
    reason: "The docstring's example of the colon spelling of a NAME citation.",
  },
  {
    file: 'scripts/lean-citations.ts',
    cites: 'Foo.lean:470',
    reason: "This gate's own explanation of the line-citation shape it checks.",
  },
  {
    file: 'scripts/lean-citations.ts',
    cites: 'Foo.lean:470-478',
    reason: 'The range spelling of the same illustration.',
  },
  {
    file: 'scripts/lean-citations.ts',
    cites: '{A,B}/x.lean',
    reason: 'The brace-expansion example in `expandBraces`.',
  },
];

/**
 * The language a documenting author writes around an illustration. Matched over the
 * enclosing PARAGRAPH and never one sentence: the spec's own case heads a sentence
 * with the explanation and carries the example in the next, so a sentence-scoped
 * check would fail the very paragraph it exists to permit — `LiteratureGate` paid
 * for that lesson and this borrows it.
 */
const DOCUMENTING_PROSE =
  /\b(?:red-green|red->green|would fail|now fails|fails when|placeholder\w*|illustrat\w*|for example|example|past the module|does not exist|proven against|spelling\w*)\b/i;

const findings: string[] = [];
const fail = (message: string): void => { findings.push(message); };

/** A brace form names two modules — for example the placeholder `{A,B}/x.lean`.
 *  Expanded rather than skipped: it is how `Execution/{Capabilities,ToolSystem}.lean`
 *  is spelled, and skipping it would leave a real citation unchecked. */
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
const corpus = readMatching(isTextSource);

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

/**
 * Validate the register itself, before it is trusted to exempt anything.
 *
 * Two of the three properties live here. PRESENT: the declared string must actually
 * occur in its file, so a register entry cannot outlive the prose it describes.
 * SELF-POLICING: the citation must not resolve to a real module, which is what makes
 * declaring a live reference as an illustration INEFFECTIVE rather than exculpatory.
 */
const illustrativeByFile = new Map<string, Illustrative[]>();
for (const entry of CITATION_ILLUSTRATIVE) {
  const module = resolveCitation(entry.cites.replace(/:.*$/, ''));
  if (module !== null) {
    fail(
      `CITATION_ILLUSTRATIVE declares \`${entry.cites}\` (${entry.file}) an illustration,`
      + ` but it names the real module ${module} — an illustration may not name a module`
      + ' that exists, because that is how the category would launder a stale citation.'
      + ' The citation is still checked live.',
    );
    continue;
  }
  if (entry.reason.length === 0) {
    fail(`CITATION_ILLUSTRATIVE entry for \`${entry.cites}\` states no reason`);
    continue;
  }
  const host = corpus.get(entry.file);
  if (host === undefined) {
    fail(`CITATION_ILLUSTRATIVE names a file outside the corpus: ${entry.file}`);
    continue;
  }
  if (!host.includes(entry.cites)) {
    fail(
      `CITATION_ILLUSTRATIVE declares \`${entry.cites}\` in ${entry.file}, which no longer`
      + ' contains it — a declaration that outlived its prose exempts nothing and hides'
      + ' the next one that matters',
    );
    continue;
  }
  illustrativeByFile.set(entry.file, [...(illustrativeByFile.get(entry.file) ?? []), entry]);
}

/**
 * The citation exactly as written at a site: the module path plus whatever `:suffix`
 * follows it. Register entries are keyed on this rather than on the bare path, so an
 * entry names the string an author actually typed — `Foo.lean:<line>` and
 * `Foo.lean:470` are different illustrations and get different entries. A bare path
 * would be a pattern, and a pattern is an allowlist.
 */
function citedToken(text: string, match: RegExpExecArray | RegExpMatchArray): string {
  const start = match.index ?? 0;
  const rest = text.slice(start + match[0].length);
  const suffix = rest.match(/^:[^\s`,)\]'"]+/);
  return `${match[0]}${suffix === null ? '' : suffix[0]}`;
}

/** The paragraph a citation sits in, for the documenting-prose check. */
function paragraphAround(text: string, index: number): string {
  const before = text.lastIndexOf('\n\n', index);
  const after = text.indexOf('\n\n', index);
  return text.slice(before === -1 ? 0 : before, after === -1 ? text.length : after);
}

/** Is this exact citation, at this site, a declared illustration whose paragraph
 *  reads like documentation? Both halves are required: the declaration alone is a
 *  skip, and the prose alone would let any unenrolled placeholder through. */
function isIllustrative(file: string, cites: string, text: string, index: number): boolean {
  const declared = illustrativeByFile.get(file)?.some((entry) => entry.cites === cites);
  if (declared !== true) return false;
  return DOCUMENTING_PROSE.test(paragraphAround(text, index));
}

let illustrativeSites = 0;
let modulesCited = 0;
let namesCited = 0;
let linesCited = 0;
for (const [file, text] of corpus) {
  // `lean/` is the other side of the citation and is checked by the traceability
  // gate. There is no per-file skip beyond that: this gate's own docstring is
  // scanned like any other file, and the placeholders in it are enrolled in
  // `CITATION_ILLUSTRATIVE` rather than excluded.
  if (file.startsWith('lean/')) continue;
  // Strip JSDoc continuation leaders, so a citation wrapped across lines reads as
  // one string. `consolidation_never_empties,\n * consolidation_nonincreasing` is
  // the live case.
  const flat = text.replace(/^[ \t]*\*[ \t]?/gm, '');

  for (const match of flat.matchAll(LEAN_PATH)) {
    if (isIllustrative(file, citedToken(flat, match), flat, match.index)) {
      illustrativeSites += 1;
      continue;
    }
    for (const path of expandBraces(match[0])) {
      modulesCited += 1;
      if (resolveCitation(path) === null) {
        fail(`${file}: cites a Lean module that does not exist: ${path}`);
      }
    }
  }

  // A line citation — for example the placeholder `Foo.lean:470` — is the other way
  // a Lean reference rots, and it rots FASTER than a name: a theorem keeps its name
  // across edits and loses its line number on the next insertion above it. §10.1's
  // S7 row cites three theorems by line, and `check-traceability.mjs` already
  // range-checks its own `tsRef`s this way, so the Lean side gets the same
  // treatment rather than a weaker one.
  for (const match of flat.matchAll(CITED_LINE)) {
    if (isIllustrative(file, citedToken(flat, match), flat, match.index)) continue;
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
// Printed on the SUCCESS path, not only on failure: a blind spot that appears only
// in red output is invisible exactly when the tree is green, which is when it
// matters. Wording shared verbatim with `scripts/literature.ts`'s blind-spot block
// so a reader of either instrument learns the same thing in the same words.
console.log(
  `lean-citations: BLIND SPOTS — ${String(illustrativeSites)} citations carry an`
  + ' author-declared category (CITATION_ILLUSTRATIVE): the declaration is TRUSTED, not'
  + ' verified — this gate checks only that the site behaves like one, never that the'
  + ' author was right to declare it.'
  + ` ${String(Object.keys(CITATION_OPAQUE).length)} theorem name(s) carry no underscore`
  + ' and are invisible to the name scanner, so a rename of one is not caught.',
);
