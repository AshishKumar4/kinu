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
 *  for any module: `MCTS/Foo.lean`, `lean/Kinu/MCTS/Foo.lean`, bare `Foo.lean`,
 *  or the brace form `Execution/{Capabilities,ToolSystem}.lean`. */
const LEAN_PATH = /(?:[A-Za-z0-9_./-]|\{[A-Za-z0-9_,]+\})+\.lean/g;

/** A citation naming a LINE rather than a theorem. For example `Foo.lean:470`, or a
 *  range `Foo.lean:470-478` — `Foo` is a placeholder again. BOTH endpoints are
 *  captured and both are checked: a range whose start is in the file and whose end
 *  is past it is a live citation that reads as verified, and checking only the start
 *  made any in-range number satisfy any range. */
const CITED_LINE =
  /((?:[A-Za-z0-9_./-]|\{[A-Za-z0-9_,]+\})+\.lean):([1-9][0-9]*)(?:-([1-9][0-9]*))?/g;

/**
 * A citation with theorem names attached, PATH FIRST, in the two spellings the tree
 * uses. For example `Foo.lean:name` and `Foo.lean — name, name`, with `Foo` a
 * placeholder.
 *
 * A name must be snake_case, and that is load-bearing rather than cosmetic: the
 * colon form runs into prose, so `StorageIsolation.lean: branch storage disjoint`
 * (`cf-backend/src/runtime.ts`) would otherwise report `branch` as a missing
 * theorem. The cost is one blind spot — an underscore-free theorem that gets
 * renamed — and `CITATION_OPAQUE` below is the ratchet that stops it growing.
 */
const CITED_NAMES_TRAILING =
  /((?:[A-Za-z0-9_./-]|\{[A-Za-z0-9_,]+\})+\.lean)(?::([a-z][A-Za-z0-9_']*)|[ \t]*(?:—|–|--)[ \t]*((?:[a-z][A-Za-z0-9_']*)(?:[ \t]*,\s*[a-z][A-Za-z0-9_']*)*))/g;

/**
 * The same citation with the two halves the other way round: NAME FIRST, the module
 * following as a parenthesised locator. This is how the specification prose citing
 * this corpus wrote every one of its citations, and requiring the path to come
 * first made all of them invisible — a rename of a theorem they name passed clean.
 *
 * ORDER-INDEPENDENCE IS NOT BOUGHT WITH FALSE POSITIVES. Three conditions, all
 * required, and together they describe an authored citation rather than a sentence
 * that happens to contain both halves:
 *
 * 1. The name is a CODE SPAN. An author writing prose about a theorem writes its
 *    name as prose; an author citing one marks it as an identifier.
 * 2. The name is SNAKE_CASE, enforced here rather than filtered afterwards. Without
 *    the path-first anchor a bare lowercase word is far likelier to be an English
 *    word, so the underscore does the work the anchor used to.
 * 3. The locator is ADJACENT: nothing but whitespace may sit between the name's
 *    closing backtick and the opening parenthesis. This is the condition that
 *    separates a citation from prose, because prose puts WORDS in that gap — see
 *    the negative case in `scripts/lean-citations.test.ts`.
 */
const CITED_NAMES_LEADING =
  /`([a-z][A-Za-z0-9_']*_[A-Za-z0-9_']*)`\s*\(`?((?:[A-Za-z0-9_./-]|\{[A-Za-z0-9_,]+\})+\.lean)/g;

/** Theorem names this scanner cannot see, because they carry no underscore. The
 *  set is asserted against the declarations, so a NEW one fails the gate naming
 *  itself instead of quietly joining the blind spot. */
const CITATION_OPAQUE = { 'Kinu.Execution.Capabilities.chain': true } as const;

/**
 * Citations presented as ILLUSTRATIONS rather than as references — the declared
 * category, and the reason it is a category and not a skip.
 *
 * The defect it answers: a specification section documented THIS GATE's own
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
    file: 'packages/cf-backend/src/gallery.tsx',
    cites: 'lean/Checkout/Coupon.lean',
    reason: 'Sample data for the design gallery, not a reference. The frame shows a'
      + ' search whose task is "Prove that applyCoupon terminates for every coupon'
      + ' row", so the observation names a module the fixture invents along with the'
      + ' coupon table it proves over. A gallery frame that cited a REAL module would'
      + ' be worse: the fixture would then break whenever that module was renamed,'
      + ' and a designer reading the frame would take invented sorry counts for'
      + ' measured ones.',
  },
  {
    file: 'scripts/lean-citations.ts',
    cites: 'lean/Checkout/Coupon.lean',
    reason: 'This register quoting the entry above it. Enrolling a path here makes'
      + ' this file cite that path, which is why every entry naming a spelling needs'
      + ' a twin naming this file.',
  },
  {
    file: 'scripts/lean-citations.ts',
    cites: 'MCTS/Foo.lean',
    reason: 'A placeholder in the docstring naming the three path spellings accepted.',
  },
  {
    file: 'scripts/lean-citations.ts',
    cites: 'lean/Kinu/MCTS/Foo.lean',
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

/** A brace form names two modules — for example the placeholder `{A,B}/x.lean`.
 *  Expanded rather than skipped: it is how `Execution/{Capabilities,ToolSystem}.lean`
 *  is spelled, and skipping it would leave a real citation unchecked. */
function expandBraces(path: string): string[] {
  const match = path.match(/\{([A-Za-z0-9_,]+)\}/);
  if (match === null) return [path];
  return match[1].split(',').flatMap((alt) => expandBraces(path.replace(match[0], alt)));
}

/** What the scan reads and what it counted, built once and carried across the corpus.
 *  A factory rather than module state, so the red directions are provable against
 *  synthetic text instead of by mutating the tree the gate governs — the shape
 *  `scripts/literature-citations.ts` adopted for the same reason. */
export interface Citations {
  /** `qualified name -> the module that declares it`. */
  readonly declarations: Map<string, string>;
  /** `basename -> the modules carrying it`, for the bare-basename spelling. */
  readonly byBasename: Map<string, string[]>;
  /** `file -> the illustrations declared in it`, populated by `auditRegister` and
   *  therefore empty until the register has been validated: an entry that failed
   *  validation must exempt nothing. */
  readonly illustrative: Map<string, Illustrative[]>;
  modules: number;
  names: number;
  lines: number;
  illustrativeSites: number;
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

export function citations(): Citations {
  const declarations = readDeclarations();
  // Modules by basename, because `docs/MCTS.md` and the exploration spec cite bare
  // `StorageIsolation.lean`. An ambiguous basename fails rather than guessing: two
  // modules of one name make every bare citation of it unresolvable in principle, and
  // picking the first is how a check starts governing a set it did not measure.
  const byBasename = new Map<string, string[]>();
  for (const module of new Set(declarations.values())) {
    const base = module.slice(module.lastIndexOf('/') + 1);
    byBasename.set(base, [...(byBasename.get(base) ?? []), module]);
  }
  return {
    declarations, byBasename, illustrative: new Map(),
    modules: 0, names: 0, lines: 0, illustrativeSites: 0,
  };
}

/** Repo-relative module path for a cited path, or `null` when nothing matches. */
function resolveCitation(path: string, seen: Citations, findings: string[]): string | null {
  for (const prefix of ['', 'lean/', 'lean/Kinu/']) {
    const candidate = `${prefix}${path}`;
    if (candidate.startsWith('lean/')
      && resolve(repoRoot, candidate).startsWith(`${leanRoot}/`)
      && existsSync(join(repoRoot, candidate))) return candidate;
  }
  const base = seen.byBasename.get(path.slice(path.lastIndexOf('/') + 1));
  if (base === undefined) return null;
  if (base.length > 1) {
    findings.push(`ambiguous Lean module basename cited as ${path}: ${base.join(', ')}`);
    return null;
  }
  return base[0];
}

/**
 * The declaration set and the illustration register, judged before either is trusted.
 *
 * Two of the register's three properties live here. PRESENT: the declared string must
 * actually occur in its file, so a register entry cannot outlive the prose it
 * describes. SELF-POLICING: the citation must not resolve to a real module, which is
 * what makes declaring a live reference as an illustration INEFFECTIVE rather than
 * exculpatory. Only entries that pass reach `seen.illustrative`.
 */
export function auditRegister(seen: Citations): string[] {
  const findings: string[] = [];
  for (const name of seen.declarations.keys()) {
    if (!name.includes('_') && !Object.hasOwn(CITATION_OPAQUE, name)) {
      findings.push(
        `theorem name without an underscore is invisible to the citation scanner: ${name}`
        + ' — rename it in snake_case, or enrol it in CITATION_OPAQUE and accept that a'
        + ' rename of it will not be caught',
      );
    }
  }
  for (const name of Object.keys(CITATION_OPAQUE)) {
    if (!seen.declarations.has(name)) {
      findings.push(`CITATION_OPAQUE names a theorem that no longer exists: ${name}`);
    }
  }

  const corpus = readMatching(isTextSource);
  for (const entry of CITATION_ILLUSTRATIVE) {
    const module = resolveCitation(entry.cites.replace(/:.*$/, ''), seen, findings);
    if (module !== null) {
      findings.push(
        `CITATION_ILLUSTRATIVE declares \`${entry.cites}\` (${entry.file}) an illustration,`
        + ` but it names the real module ${module} — an illustration may not name a module`
        + ' that exists, because that is how the category would launder a stale citation.'
        + ' The citation is still checked live.',
      );
      continue;
    }
    if (entry.reason.length === 0) {
      findings.push(`CITATION_ILLUSTRATIVE entry for \`${entry.cites}\` states no reason`);
      continue;
    }
    const host = corpus.get(entry.file);
    if (host === undefined) {
      findings.push(`CITATION_ILLUSTRATIVE names a file outside the corpus: ${entry.file}`);
      continue;
    }
    if (!host.includes(entry.cites)) {
      findings.push(
        `CITATION_ILLUSTRATIVE declares \`${entry.cites}\` in ${entry.file}, which no longer`
        + ' contains it — a declaration that outlived its prose exempts nothing and hides'
        + ' the next one that matters',
      );
      continue;
    }
    seen.illustrative.set(entry.file, [...(seen.illustrative.get(entry.file) ?? []), entry]);
  }
  return findings;
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
function isIllustrative(
  file: string, cites: string, text: string, index: number, seen: Citations,
): boolean {
  const declared = seen.illustrative.get(file)?.some((entry) => entry.cites === cites);
  if (declared !== true) return false;
  return DOCUMENTING_PROSE.test(paragraphAround(text, index));
}

/**
 * One file, audited. Exported so every direction this gate claims to govern is
 * provable against synthetic text rather than by mutating the tree it governs.
 */
export function auditCitations(file: string, text: string, seen: Citations): string[] {
  const findings: string[] = [];
  // Strip JSDoc continuation leaders, so a citation wrapped across lines reads as
  // one string. `consolidation_never_empties,\n * consolidation_nonincreasing` is
  // the live case.
  const flat = text.replace(/^[ \t]*\*[ \t]?/gm, '');

  for (const match of flat.matchAll(LEAN_PATH)) {
    if (isIllustrative(file, citedToken(flat, match), flat, match.index, seen)) {
      seen.illustrativeSites += 1;
      continue;
    }
    for (const path of expandBraces(match[0])) {
      seen.modules += 1;
      if (resolveCitation(path, seen, findings) === null) {
        findings.push(`${file}: cites a Lean module that does not exist: ${path}`);
      }
    }
  }

  // A line citation — for example the placeholder `Foo.lean:470` — is the other way
  // a Lean reference rots, and it rots FASTER than a name: a theorem keeps its name
  // across edits and loses its line number on the next insertion above it. Three
  // theorems were cited by line in the specification prose, and
  // `check-traceability.mjs` already range-checks its own `tsRef`s this way, so the
  // Lean side gets the same treatment rather than a weaker one.
  for (const match of flat.matchAll(CITED_LINE)) {
    if (isIllustrative(file, citedToken(flat, match), flat, match.index, seen)) continue;
    const module = resolveCitation(match[1], seen, findings);
    if (module === null) continue;   // already reported by the module scan above
    seen.lines += 1;
    const lineCount = readFileSync(join(repoRoot, module), 'utf8').split('\n').length;
    // BOTH endpoints, and one finding per citation rather than one per endpoint: a
    // range is a single claim, so a reader fixing it wants the whole claim named.
    const gone = [match[2], match[3]]
      .filter((endpoint) => endpoint !== undefined && Number(endpoint) > lineCount);
    if (gone.length > 0) {
      const cited = `${match[1]}:${match[2]}${match[3] === undefined ? '' : `-${match[3]}`}`;
      findings.push(
        `${file}: cites ${cited}, but ${module} has ${String(lineCount)} lines`
        + ` — line ${gone.join(' and ')} does not exist and the citation outlived it`,
      );
    }
  }

  // Either order. The path-first spellings are the tree's TypeScript-header habit;
  // the name-first spelling is its documentation habit, and governing only the first
  // meant a rename of a theorem the docs name passed clean.
  const cited: { readonly path: string; readonly names: readonly string[] }[] = [];
  for (const match of flat.matchAll(CITED_NAMES_TRAILING)) {
    cited.push({ path: match[1], names: (match[2] ?? match[3] ?? '').split(',') });
  }
  for (const match of flat.matchAll(CITED_NAMES_LEADING)) {
    cited.push({ path: match[2], names: [match[1]] });
  }

  for (const { path, names } of cited) {
    const modules = expandBraces(path)
      .map((one) => resolveCitation(one, seen, findings)).filter((m) => m !== null);
    for (const name of names.map((one) => one.trim()).filter((one) => one.includes('_'))) {
      seen.names += 1;
      const declaring = [...seen.declarations]
        .filter(([qualified]) => qualified.endsWith(`.${name}`));
      if (declaring.length === 0) {
        findings.push(
          `${file}: cites Lean theorem \`${name}\` (${path}), which no Lean source declares`
          + ' — a header naming a theorem nobody proves is worse than no header',
        );
        continue;
      }
      if (modules.length > 0 && !declaring.some(([, module]) => modules.includes(module))) {
        findings.push(
          `${file}: cites \`${path} — ${name}\`, but ${name} is declared in`
          + ` ${declaring.map(([, module]) => module).join(', ')} — the theorem moved and the`
          + ' citation did not',
        );
      }
    }
  }
  return findings;
}

/** The corpus-wide check: a scan that found nothing certifies nothing. */
export function auditCoverage(seen: Citations): string[] {
  if (seen.modules > 0 && seen.names > 0) return [];
  return [
    `citation scan found ${String(seen.modules)} module and ${String(seen.names)} theorem`
    + ' references, so it cannot fail — a gate with an empty corpus certifies nothing',
  ];
}

/* ── The verdict ───────────────────────────────────────────────────────── */

if (import.meta.main) {
  const seen = citations();
  const findings = auditRegister(seen);
  const corpus = readMatching(isTextSource);
  for (const [file, text] of corpus) {
    // `lean/` is the other side of the citation and is checked by the traceability
    // gate. There is no per-file skip beyond that: this gate's own docstring is
    // scanned like any other file, and the placeholders in it are enrolled in
    // `CITATION_ILLUSTRATIVE` rather than excluded.
    if (file.startsWith('lean/')) continue;
    findings.push(...auditCitations(file, text, seen));
  }
  findings.push(...auditCoverage(seen));

  if (findings.length > 0) {
    for (const finding of findings) console.error(`✗ ${finding}`);
    console.error(`lean-citations: ${String(findings.length)} finding(s)`);
    process.exit(1);
  }
  console.log(
    `lean-citations: OK — ${String(seen.declarations.size)} theorems, ${String(seen.modules)} module,`
    + ` ${String(seen.names)} theorem and ${String(seen.lines)} line citations across`
    + ` ${String(corpus.size)} files`,
  );
  // Printed on the SUCCESS path, not only on failure: a blind spot that appears only
  // in red output is invisible exactly when the tree is green, which is when it
  // matters. Wording shared verbatim with `scripts/literature.ts`'s blind-spot block
  // so a reader of either instrument learns the same thing in the same words.
  console.log(
    `lean-citations: BLIND SPOTS — ${String(seen.illustrativeSites)} citations carry an`
    + ' author-declared category (CITATION_ILLUSTRATIVE): the declaration is TRUSTED, not'
    + ' verified — this gate checks only that the site behaves like one, never that the'
    + ' author was right to declare it.'
    + ` ${String(Object.keys(CITATION_OPAQUE).length)} theorem name(s) carry no underscore`
    + ' and are invisible to the name scanner, so a rename of one is not caught.'
    + ` All ${String(seen.lines)} line citations are checked for EXISTENCE ONLY: both`
    + ' endpoints of a range must be within the module, and nothing verifies that those'
    + ' lines still contain the claimed content — an insertion above a cited range slides'
    + ' it onto different code and stays green. A theorem NAME is the citation shape this'
    + ' gate can actually verify; a line number is the shape it can only bound.',
  );
}
