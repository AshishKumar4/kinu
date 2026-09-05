/**
 * The literature citation gate: docs -> external source, the last boundary in this
 * repository that nothing checked.
 *
 * WHY IT EXISTS, and why it is not a digit checker. `lean-citations.ts` closed
 * TypeScript -> Lean and caught three stale citations on introduction, two of them
 * theorems that had never existed in any module. The generalisation is the point:
 * this tree's citations are in unusually good shape wherever a checker exists —
 * ~40 repo `file:line` references audited, every one resolving — and drifted
 * wherever a boundary was crossed that nothing measures. A removed internal audit of
 * seven numbers found six of seven DIGITS correct and four QUALIFIERS wrong. A gate
 * that compared digits would have passed all seven.
 *
 * So this aims at the qualifier:
 *
 *   - a number standing where a source is cited must resolve to a register entry,
 *     and therefore to a locator;
 *   - a claim whose ARGUMENT depends on a compute condition carries the condition
 *     as a statement of what was held fixed and where the source declares it, and
 *     a bare parity adjective beside such a number is REFUSED — `"at matched
 *     compute"` is the exact string that hid the Koh defect, over a subtraction
 *     spanning a no-search row the same paper prices at 20x the LM calls;
 *   - a hedge the source states (`"up to 11.33%"`) may not be dropped;
 *   - a unit with a confusable twin must be named — `+25.4` is points of
 *     DISCRIMINATION accuracy, and read as task accuracy it argues the opposite;
 *   - a paper-side locator named in prose must be the register's locator;
 *   - a WITHDRAWN number may appear only where its paragraph says it is withdrawn;
 *   - the full set is ENUMERABLE (`--list-claims`), with provenance DEPTH, so a
 *     re-verification pass has a worklist instead of a re-read.
 *
 * ATTRIBUTION, which is the whole of the corpus decision. A number is governed when
 * a source is cited in author-or-arXiv form within its reach, or when the same
 * reach already quotes one of that source's registered numbers distinctively enough
 * to be its fingerprint — prose arguing from a paper's figures is arguing from that
 * paper, so its other figures need locators too. A product NAME alone does not
 * attribute: `GEPA`, `LATS` and `CL-Bench` are components of this system as often
 * as they are citations, and governing every integer beside them would demand a
 * paper locator for an auto-GEPA cadence. Qualifier checks, by contrast, run
 * wherever a REGISTERED number appears within a citation's reach by any spelling,
 * product names included: those cannot false-positive, because the register already
 * knows the number.
 *
 * WHAT IT REFUSES TO PRETEND. It never opens a paper. It cannot verify a digit and
 * it cannot verify that a locator supports the claim — only that prose and register
 * agree, that the condition is stated rather than asserted, and that second-hand
 * numbers are visibly second-hand. Every run prints those limits, because a checker
 * that launders an unchecked number by giving it a green tick is worse than no
 * checker.
 *
 * WHY THE REGISTER IS A SEPARATE FILE. Same boundary decision as
 * `lean-citations.ts` taking declarations from the one Lean scanner over stdout
 * rather than re-parsing Lean: one spelling per fact. `literature.ts` is the ONE
 * place an external number is written down, this program never re-derives one, and
 * the corpus comes from `sources.ts` — so "which files did you read" and "which
 * files do you govern" stay the same expression.
 *
 * WHERE THE REST OF IT LIVES. Three modules, split along what each one KNOWS.
 * This file owns the register comparison: which numbers a citation governs, and
 * what a work licenses. `literature-quotations.ts` owns declared quotations —
 * ``Verbatim from `Name` `` and whether the copy still is one — a subsystem with
 * its own vocabulary and nothing to say about external numbers. `prose.ts` owns
 * the splitter both audits read through, which belongs to neither. The generic
 * half of the AST work went to `syntax.ts`, beside the rest of the substrate every
 * gate here shares.
 */

import { CLAIMS, NO_LOCATOR, WORKS, type Claim, type Work } from './literature';
import { auditQuotations, renderedProse, type Quotation } from './literature-quotations';
import { PARAGRAPH_BREAK, REACH, pieces, sentences } from './prose';
import { isParseable, isTextSource, readMatching } from './sources';

/**
 * The files whose CONTENT is example citations: this program's own modules, its
 * register, and its test. Skipped for the same reason a secret scanner does not
 * scan its own fixtures.
 *
 * It is not an allowlist and the difference matters. An allowlist exempts files
 * that carry real citations; these carry none — a citation here would be a
 * fixture, and every fixture is deliberately about a paper the register already
 * holds. `LeanModel` removed the equivalent skip from `lean-citations.ts` by
 * rewriting that gate's account of the three stale citations it caught WITHOUT
 * re-spelling them as citations, which is strictly better and not available here:
 * a register of external numbers cannot be written without writing them down. So
 * it stays, and it is named in the blind-spot list rather than left implicit.
 *
 * The rule is "this program", not "this file", and `literature-quotations.ts` is
 * why the distinction is written down: the declared-quotation subsystem moved out
 * of here carrying the fixtures that explain it — an arXiv id beside the
 * magnitudes a quote had dropped — so a skip keyed on one filename would have
 * turned a refactor into a set of findings against the gate's own prose.
 * `prose.ts` and `syntax.ts` hold no citation and are deliberately NOT listed:
 * membership is content, not neighbourhood.
 */
const SELF = {
  'scripts/literature.ts': true,
  'scripts/literature-citations.ts': true,
  'scripts/literature-quotations.ts': true,
  'scripts/literature-citations.test.ts': true,
} as const;

/**
 * A locator DESIGNATOR: the source's own coordinate system. Deliberately not a
 * free-text field — "the ablation in section 5 somewhere" is how a citation stops
 * being checkable by anyone, including a human with the PDF open.
 *
 * `App.` is deliberately absent where `Appendix` is present: it matches
 * `src/App.tsx`, and `gate-set-equality` decides whether a regex is a filename
 * predicate by RUNNING it on filenames rather than reading it — correctly, since a
 * pattern that matches a source path is one refactor away from selecting a corpus.
 */
const LOCATOR = /(?:Table|Tab\.|Figure|Fig\.|Appendix|Algorithm|Alg\.|Equation|Eq\.|Theorem|Listing|Section|Sec\.|Abstract|Limitations|§)/;

/**
 * A locator on the SOURCE's side, as written in prose. `§` is excluded on purpose:
 * in this repository `§` means OUR OWN section, so comparing it would fail every
 * sentence that cross-references the spec. The cost is one blind spot — a drifted
 * `§` locator naming a paper section — and it is stated in the output.
 */
const PAPER_LOCATOR = /(?:Table|Tab\.|Figure|Fig\.|Appendix|App\.|Algorithm|Alg\.|Equation|Eq\.)\s*\(?\s*[A-Z]?\.?\s*\d+(?:\.\d+)?\s*\)?/g;

/**
 * A compute-parity ADJECTIVE where a condition belongs. This is the load-bearing
 * refusal: both drifts that changed an argument rather than a footnote were a
 * correct number under a condition the source does not state, and in both cases an
 * adjective is what stood in for the condition.
 */
const BARE_PARITY =
  /\b(?:at|under|with|for|and)\s+(?:the\s+)?(?:same|equal|identical|matched|matching|comparable|constant|equivalent)\s+(?:inference\s+|test-?time\s+|total\s+|overall\s+)?(?:compute|budget|cost|spend|price|FLOPs)\b|\b(?:compute|budget|cost)-matched\b|\bmatched-(?:compute|budget|cost)\b|\biso-compute\b|\bat parity\b/i;

/**
 * Citation shapes: an author-year or arXiv form, which is an author saying "this
 * came from a source". Two roles, deliberately one set — it decides both when a
 * number is attributed and when an unregistered WORK has arrived, so the register's
 * completeness ratchet and the number's governance cannot disagree.
 */
const CITATION_FORM = [
  /\b[A-Z][A-Za-z\u00C0-\u024F'\u2019-]+ et al\./,
  /\b[A-Z][A-Za-z\u00C0-\u024F'\u2019-]+ & [A-Z][A-Za-z\u00C0-\u024F'\u2019-]+\b/,
  /\barXiv[: ]/i,
  /(?<![\w.])\d{4}\.\d{4,5}(?![\w])/,
];

/**
 * A paragraph marking a number as retracted. Read over the PARAGRAPH, because a
 * retraction is a paragraph-level act: the correction that set this rule headed one
 * sentence and quoted the withdrawn claim in the next.
 *
 * Stems are open (`withdraw\w*`), not enumerated suffixes: `LeanModel` hit exactly this
 * writing the sibling category — `\b(?:illustrat)\b` never matched "illustrations", the
 * word a documenting author actually writes, and only the negative test found it.
 *
 * It matches ordinary retraction prose rather than a marker token, and that is the
 * design rather than a convenience. A token costs an author nothing, so it gets
 * pasted, and then nobody can tell a retraction from a silencing. This rides on
 * documentation the reader wanted anyway.
 */
const RETRACTION =
  /\bnot be cited\b|\bwithdraw\w*\b|\bretract\w*\b|\bfabricat\w*\b|\bmislabel\w*\b|\brelabel\w*\b|\bwrong the (?:first|second) time\b|\b(?:was|were) wrong\b|\ban earlier (?:draft|revision|version)\b/i;

/**
 * Numbers that LABEL something of ours rather than measuring anything of theirs: a
 * criterion, a rule, a gate, an axis. `criteria 2-5` is not two results.
 */
const LABELLED =
  /(?:§|Section|Sec\.|Chapter|Theorem|Lemma|Listing|lines?|criteri(?:on|a)|rules?|steps?|properties|property|points?|items?|tiers?|phases?|ax(?:is|es)|arms?|columns?|clauses?|gates?|rows?|PR-[A-Z]+-)\s*\d+(?:\.\d+)*(?:\s*[\u2013\u2014-]\s*\d+)?/gi;

/**
 * A number distinctive enough to ATTRIBUTE prose to a source by itself: it carries
 * a decimal, a percent, a multiplier or a sign. A bare small integer is not a
 * fingerprint — `ToT at 3 and at 8 is one technique` shares its `3` with a
 * registered depth and means branches, and governing the `8` beside it would demand
 * a paper locator for one of our own examples.
 */
const FINGERPRINT = /[.%×+\u2212]/;

/* ── Reading prose ─────────────────────────────────────────────────────── */

/**
 * The comment stream of a source file, with each comment BLOCK kept separate.
 *
 * WHY THE SEPARATOR IS A BLANK LINE. `PARAGRAPH_BREAK` (prose.ts) needs `\n{2,}`,
 * so joining comments with a single newline made a file's whole comment stream ONE
 * paragraph, and a citation then reached across the code between two comments.
 * Worse than a paragraph: the sentence splitter cannot break before a digit, so a
 * comment OPENING on
 * one — `// 1 BY CONSTRUCTION`, a few lines under a docblock citing Rainbow Teaming
 * in `strategy/swarm.ts` — landed inside the citing sentence itself, where no
 * window could reach it, and two interface members' separate docblocks read as one
 * sentence the same way. Both shapes are pinned in this gate's own test rather than
 * against a live path: the sites that provoked them were reworded to get a push
 * through, and a reworded site stops being evidence.
 *
 * WHY NOT A BLANK LINE BETWEEN EVERY COMMENT, which is the one-character fix. A run
 * of `//` lines is N separate matches, so that shatters all 10,344 multi-line
 * line-comment blocks in this tree into one-line paragraphs, and it LOSES real
 * coverage: measured, `curriculum/proposer.ts` stops citing either `absolute-zero`
 * number and both register entries turn into `cited nowhere` findings.
 *
 * So a unit ends where the AUTHOR said it ends. A block comment's closing delimiter
 * is that statement; a run of line comments has only contiguity, so only line
 * comments with neither a blank line nor code between them are one block. Measured
 * against `--list-claims`, that leaves the governed set byte-identical and every
 * register entry's homes unchanged, at 75 claim sites rather than 77 — the two it
 * drops are sentences spliced from two different comments, which no author wrote.
 */
function comments(text: string): string {
  let joined = '';
  let end = 0;
  let previousLine = false;
  for (const match of text.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)) {
    const line = match[0].startsWith('//');
    // Whitespace spanning at most one newline: the next comment is the next line.
    const contiguous = /^[^\S\n]*\n?[^\S\n]*$/.test(text.slice(end, match.index));
    if (end > 0) joined += contiguous && line && previousLine ? '\n' : '\n\n';
    joined += match[0];
    end = match.index + match[0].length;
    previousLine = line;
  }
  return joined;
}

/**
 * How far a citation REACHES around the sentence carrying it, and therefore which
 * numbers stand beside it. Two shapes of prose, because this tree holds two and one
 * rule over both is wrong in two directions at once.
 *
 *   - `sentence` — code-like prose: a doc comment, or a string expression handed to
 *     a model. A dense block where a single `Self-MoA` mention would pool a whole
 *     module's constants, so a citation reaches its own sentence and no further.
 *   - `section` — Markdown. A citation opens a section and the argument then runs
 *     for paragraphs naming no author; the passage that set REACH did exactly that
 *     for four. So it carries forward, is reset by a heading, and expires at REACH.
 *
 * A RENDERED LITERAL IS NOT A THIRD CASE, and the first draft's mistake is worth
 * recording: it read the whole expression as one window, on the argument that a
 * model receives all of it at once. That confuses two things. Where the unit ENDS is
 * the literal's own contribution and `auditFile` enforces it — eleven unrelated
 * strings in a `messages` array are eleven units and pool nothing. How far a
 * citation reaches INSIDE a unit is a different question, and there a rendered
 * description is a dense block of sentences exactly like a docblock. Whole-unit
 * reach measured as noise on the first run: `ladder.ts` describes this very gate in
 * one 900-character expression, so `arXiv` in its account of citation forms
 * attributed the `4000` of its account of REACH, and `unit-web.test.ts`'s
 * `'1. First & Best'` fixture read as an author pair beside an ordinal.
 */
export type Window = 'sentence' | 'section';

/**
 * The COMMENT text a literature citation can live in. Prose a human wrote for
 * another human: Markdown, and in source a comment.
 *
 * It is half the corpus. `renderedProse`
 * (literature-quotations.ts) is the
 * other half, and blind spot 9 named its absence for exactly as long as it took to
 * measure: `scripts/axis-ergonomics/{corpus,surface,validate}.ts` carried the
 * bare-parity defect inside string literals, and it was found only because a
 * recording echoed one of them into a file this function does read.
 */
export function citable(file: string, text: string): string {
  const stripped = isParseable(file)
    ? comments(text)
    : text.replace(/```[\s\S]*?```/g, ' ');
  return stripped
    // JSDoc continuation leaders, so a citation wrapped across lines reads as one
    // string — the same normalisation `lean-citations.ts` needs.
    .replace(/^[ \t]*(?:\/\/|\*|#)[ \t]?/gm, '')
    // Inline code is a REPO reference, governed by the repo's own citation sweep:
    // `config.ts:100`, `judgeSamples: 3`, `c=20`. Leaving it in makes every
    // implementation constant read as a literature claim.
    .replace(/`[^`\n]*`/g, ' ');
}

/**
 * A RECORDING: machine-written captured output, recognised by the timestamp its
 * writer stamped on the document as its opening field.
 *
 * WHY IT IS A CATEGORY AND NOT A PATH GLOB. A glob over `runs/` would make this gate
 * blind to any future DOCUMENT placed there, which is the failure a skip always has.
 * The property is of the CONTENT: this document was written by a program, in one
 * pass, as the record of a run. `lean-citations.ts`'s `CITATION_ILLUSTRATIVE` and
 * this register's own `hand: 'withdrawn'` are the shape being followed, and the
 * shape rather than the name is what is shared:
 *
 * 1. DECLARED — and declared by the writer at the moment of writing, not by an author
 *    later reaching for an exemption. There is no marker token to paste.
 * 2. It CHANGES which check applies and never disables one. A recording asserts
 *    nothing: no reader takes a number out of a transcript as this repository's claim
 *    about a paper, and nobody can correct a transcript without falsifying it. So it
 *    carries no obligation to hold a locator. What it does carry is the obligation
 *    not to be LOAD-BEARING: its quotations go to a separate ledger, and
 *    `auditCoverage` refuses any register entry whose only home is that ledger.
 * 3. That residual is what makes the category self-policing, because credit is
 *    withheld along with blame. A recording cannot green a stale register entry,
 *    cannot enrol a work as cited, and contributes no claim site. Relabelling real
 *    prose as a recording is therefore INEFFECTIVE rather than exculpatory: every
 *    number it was carrying turns into a coverage finding instead.
 *
 * The recordings are named in the blind-spot list on the GREEN path, with their
 * count, because an exclusion nobody prints is how coverage disappears.
 */
const RECORDING = /^\{\s*"ranAt":\s*"\d{4}-\d{2}-\d{2}T[\d:.]+Z"/;

/**
 * The numbers in a sentence that could be a claim from a source.
 *
 * Everything masked here is a number that is demonstrably NOT an external result:
 * a locator's own ordinal, one of our own subsection references (`2.4(b)`), a label
 * on one of our own criteria, a publication year, an arXiv id, a `file.ts:line`
 * reference, a volume:page pair, a single-letter hyperparameter written `c=20`, a
 * model name's version (`GPT-4.1`), and an acronym's parenthesised count such as
 * `SC(20)`. Each mask is a blind spot in exchange for a gate that fires on claims
 * instead of on arithmetic. The parameter mask is deliberately single-letter only:
 * widening it to any `x=n` hid `τ=0.6`, which is a cited threshold.
 */
function claimNumbers(sentence: string): string[] {
  const masked = sentence
    .replace(/(?<![\w.])(?:arXiv:)?\d{4}\.\d{4,5}(?:v\d+)?(?![\w])/g, ' ')
    .replace(/[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|lean|py|sh|md|json|toml|ya?ml):\d+(?:-\d+)?/g, ' ')
    .replace(/\b\d+:\d+\b/g, ' ')
    .replace(PAPER_LOCATOR, ' ')
    .replace(LABELLED, ' ')
    // `GPT-4.1-Mini`, `Qwen1.5-110B`: a version inside a hyphenated name.
    .replace(/[A-Za-z]\w*-\d+(?:\.\d+)?/g, ' ')
    .replace(/\b[A-Z]{2,}\(\d+\)/g, ' ')
    .replace(/\b\d+\.\d+\([a-z]\)/g, ' ')
    .replace(/\b[a-z]\s*=\s*\d+(?:\.\d+)?/gi, ' ')
    .replace(/(?<![\w.])(?:19|20)\d{2}(?![\w])(?!\.\d)/g, ' ');
  // The trailing guard rejects a word character and a further `.digit`, but NOT a
  // sentence-ending period: `(?![\w.])` silently dropped every number that ended a
  // sentence, which is where a citation most often puts one.
  return [...masked.matchAll(/(?<![\w.$])[+\u2212-]?\d+(?:\.\d+)?(?:%|×)?(?![\w])(?!\.\d)/g)]
    .map((match) => match[0]);
}

/** One spelling per number on both sides of the comparison. `24.5%` and `24.5` are
 *  the same number; `+2` and `2` are not, because a signed delta and a level are
 *  different claims and conflating them is how `+12.5` became a level. */
function normalise(value: string): string {
  return value.replace(/\u2212/g, '-').replace(/[%×]$/, '');
}

/** `Tab. 4`, `Table 4` and `Table4` are one locator. */
function canonical(locator: string): string {
  return locator
    .replace(/Tab\./g, 'Table').replace(/Fig\./g, 'Figure').replace(/App\./g, 'Appendix')
    .replace(/Alg\./g, 'Algorithm').replace(/Eq\./g, 'Equation')
    .replace(/[\s()]+/g, '');
}

/** `work \u0000 value`, the register's identity — one spelling, because it keys the
 *  cited set, the site index and the duplicate check. */
function claimKey(claim: Claim): string {
  return `${claim.work}\u0000${normalise(claim.value)}`;
}

/* ── The register, checked before it is trusted ─────────────────────────── */

/** Every number a work licenses in prose: its claims, plus the source's own
 *  experimental parameters, plus the numbers inside its locators and conditions —
 *  a compute condition prose is allowed to restate. */
const licensed = new Map<string, Set<string>>();
for (const work of WORKS) licensed.set(work.id, new Set(work.parameters?.map(normalise) ?? []));
const byWork = new Map<string, Claim[]>();
for (const claim of CLAIMS) {
  byWork.set(claim.work, [...(byWork.get(claim.work) ?? []), claim]);
  const set = licensed.get(claim.work);
  if (set === undefined) continue;
  set.add(normalise(claim.value));
  for (const number of claimNumbers(`${claim.where} ${claim.condition ?? ''}`)) {
    set.add(normalise(number));
  }
}

/**
 * The register's own obligations. Checked first and separately, because a register
 * that is itself incoherent cannot judge prose — and because these are the fields
 * the whole instrument exists to require: a locator, a unit, an attributed hand,
 * and a compute condition that is a statement rather than an adjective.
 */
export function auditRegister(): string[] {
  const findings: string[] = [];
  const works = new Map(WORKS.map((work) => [work.id, work]));
  if (works.size !== WORKS.length) findings.push('two works share an id in the register');

  const seen = new Set<string>();
  for (const claim of CLAIMS) {
    if (seen.has(claimKey(claim))) {
      findings.push(`two register entries claim ${claim.value} for ${claim.work}`);
    }
    seen.add(claimKey(claim));
    if (!works.has(claim.work)) {
      findings.push(`register entry ${claim.work} ${claim.value} names a work that is not registered`);
    }
    if (claim.hand === 'artifact' && claim.via === undefined) {
      findings.push(
        `${claim.work} ${claim.value}: hand is 'artifact' with no \`via\` — a second-hand`
        + ' number whose hand is not named is indistinguishable from a first-hand one',
      );
    }
    if ((claim.hand === 'unverified' || claim.hand === 'withdrawn') && claim.note === undefined) {
      findings.push(
        `${claim.work} ${claim.value}: hand is '${claim.hand}' with no note — say what a`
        + ' verifier should do, or what replaced it',
      );
    }
    if (claim.where === NO_LOCATOR) {
      if (claim.note === undefined) {
        findings.push(
          `${claim.work} ${claim.value}: no locator and no note — an entry that says neither`
          + ' where the number is nor that nobody knows is the defect this register replaces',
        );
      }
      if (claim.hand === 'primary') {
        findings.push(`${claim.work} ${claim.value}: read first-hand but no locator recorded`);
      }
    } else if (!LOCATOR.test(claim.where)) {
      findings.push(
        `${claim.work} ${claim.value}: \`where\` is "${claim.where}", which is not a locator`
        + ` — use a Table/Figure/Appendix/§ designator, or "${NO_LOCATOR}"`,
      );
    }
    if (claim.computeDependent !== true) {
      if (claim.condition !== undefined) {
        findings.push(
          `${claim.work} ${claim.value}: carries a compute condition but is not marked`
          + ' computeDependent',
        );
      }
      continue;
    }
    // Ordered weakest-first: a condition that says nothing cannot also be judged on
    // whether what it says is a claim of ours or the source's.
    const condition = claim.condition ?? '';
    if (condition.length === 0) {
      findings.push(
        `${claim.work} ${claim.value}: the argument depends on a compute condition and none is`
        + ' stated',
      );
    } else if (!/\bheld\b|\bfixed\b|\bidentical to\b/.test(condition) || condition.length < 40) {
      findings.push(
        `${claim.work} ${claim.value}: the compute condition does not say what was held fixed`
        + ` — "${condition}". An adjective is not a condition.`,
      );
    } else if (!LOCATOR.test(condition)) {
      findings.push(
        `${claim.work} ${claim.value}: the compute condition names no locator, so it is our`
        + ` claim rather than the source's — "${condition}"`,
      );
    }
  }
  return findings;
}

/* ── The corpus ────────────────────────────────────────────────────────── */

/** What prose was found to cite, accumulated across the corpus so a stale register
 *  entry is a finding rather than a comment. */
export interface Coverage {
  readonly works: Set<string>;
  /** `claimKey -> the files whose prose cites it`. The cited set and the site index
   *  are ONE structure on purpose: a second mirror of the same keys is how a recorded
   *  quotation would end up greening a stale entry in one of them. */
  readonly files: Map<string, Set<string>>;
  /** The same, for quotations found inside a RECORDING — a separate ledger, because
   *  evidence may not stand in for an assertion. */
  readonly recorded: Map<string, Set<string>>;
  /** Which files were read as recordings, so the exclusion is printable. */
  readonly recordings: Set<string>;
  sites: number;
  /** String expressions read as model-facing prose. A count, not a set, because the
   *  point of printing it is that the corpus this gate governs is a MEASUREMENT
   *  rather than an assertion — the surface was invisible for as long as nobody had
   *  a number for it. */
  literals: number;
  /** `Name` and `Owner.member` to the docblock above them, accumulated across the
   *  whole corpus because a quote and the prose it copies are rarely in one file. */
  readonly docs: Map<string, string>;
  /** Every declared quote claim, compared after the corpus is read for the same
   *  reason: the target may be declared in a file read later. */
  readonly quotes: Quotation[];
}

export function coverage(): Coverage {
  return {
    works: new Set(),
    files: new Map(),
    recorded: new Map(),
    recordings: new Set(),
    sites: 0,
    literals: 0,
    docs: new Map(),
    quotes: [],
  };
}

/**
 * The window a file's own prose is read under. Derived from the file, never passed
 * in, so "which shape is this text" is answered once and in one place.
 */
export const windowOf = (file: string): Window => (isParseable(file) ? 'sentence' : 'section');

/**
 * One text, audited under one window. Exported so the red directions are provable
 * against synthetic prose instead of by mutating the tree the gate governs.
 *
 * `source` is already the citable text: `citable` for a comment or a document,
 * `rendered` for a string expression. The split matters because the two disagree
 * about what a paragraph is, and the window is what carries that disagreement.
 */
export function auditProse(
  file: string, source: string, seen: Coverage, window: Window,
): string[] {
  const findings: string[] = [];
  // Whether a citation reaches only its own sentence, and equivalently whether it
  // dies with it. Code-like prose is a dense block where one `Self-MoA` mention
  // would pool a module's constants; Markdown carries the work under discussion
  // forward — the passage that set this bound opened with `Koh et al. 2407.01476
  // Table 4 (§5.1) holds node expansions fixed …` and then argued for four
  // paragraphs naming no author at all.
  const narrow = window === 'sentence';
  // A recording is still READ, and judged by a different obligation: its quotations
  // are collected so `auditCoverage` can refuse a register entry that lives only
  // there, and no finding is raised against it either way.
  const recording = RECORDING.test(source);
  if (recording) seen.recordings.add(file);
  const blame = !recording;
  const ledger = recording ? seen.recorded : seen.files;
  let carried: readonly Work[] = [];
  let carriedAt = -Infinity;

  for (const paragraph of pieces(source, PARAGRAPH_BREAK)) {
    if (!narrow && paragraph.raw.startsWith('#')) carried = [];
    for (const sentence of sentences(paragraph.raw)) {
      const at = paragraph.at + sentence.at;
      // The window a citation reaches over: the structural unit, cut to REACH
      // characters either side of the sentence. Paragraph-shaped prose is shorter
      // than that, so the window IS the paragraph and nothing changes; a
      // machine-written document has no paragraphs, and the window is the whole of
      // what stops one citation in it from reaching every number in the file.
      const nearby = paragraph.raw.slice(
        Math.max(0, sentence.at - REACH),
        sentence.at + sentence.width + REACH,
      );
      const reach = narrow ? sentence.text : nearby;
      const here = WORKS.filter((work) => work.cites.some((cite) => reach.includes(cite)));
      if (!narrow) {
        if (here.length > 0) {
          carried = here;
          carriedAt = at;
        } else if (at - carriedAt > REACH) carried = [];
      }
      const numbers = claimNumbers(sentence.text);
      if (numbers.length === 0) continue;
      const mentioned = here.length > 0 || narrow ? here : carried;
      const allowed = new Set(mentioned.flatMap((work) => [...(licensed.get(work.id) ?? [])]));
      const cited = CITATION_FORM.some((pattern) => pattern.test(reach));

      if (mentioned.length === 0) {
        if (cited && blame) {
          findings.push(
            `${file}: cites an external work with numbers and no register entry`
            + ` — "${sentence.text.slice(0, 180)}"`,
          );
        }
        continue;
      }
      if (blame) {
        seen.sites += 1;
        for (const work of mentioned) seen.works.add(work.id);
      }

      // Attribution: an author-or-arXiv citation, or prose already quoting one of
      // this source's registered numbers distinctively enough to be its fingerprint.
      const attributed = cited
        || numbers.some((number) => allowed.has(normalise(number)) && FINGERPRINT.test(number));
      const matched: Claim[] = [];
      for (const number of numbers) {
        if (!allowed.has(normalise(number))) {
          if (attributed && blame) {
            findings.push(
              `${file}: cites ${number} beside ${mentioned.map((work) => work.id).join(', ')} with`
              + ' no register entry, so it carries no locator'
              + ` — "${sentence.text.slice(0, 180)}"`,
            );
          }
          continue;
        }
        for (const work of mentioned) {
          for (const claim of byWork.get(work.id) ?? []) {
            if (normalise(claim.value) !== normalise(number)) continue;
            ledger.set(claimKey(claim), (ledger.get(claimKey(claim)) ?? new Set()).add(file));
            matched.push(claim);
          }
        }
      }
      if (matched.length === 0 || recording) continue;

      // A withdrawn number inside the paragraph that withdraws it is a QUOTATION of
      // a retracted claim, not an assertion of it, so the qualifier checks are off
      // for this sentence — they would demand the correction be reworded into a
      // claim.
      const withdrawn = matched.filter((claim) => claim.hand === 'withdrawn');
      if (withdrawn.length > 0) {
        if (!RETRACTION.test(nearby)) {
          findings.push(
            `${file}: re-asserts ${withdrawn.map((claim) => claim.value).join(', ')}, which the`
            + ' register records as WITHDRAWN, in a paragraph that does not say so'
            + ` — ${withdrawn[0]?.says.slice(0, 120) ?? ''}.`
            + ` Sentence: "${sentence.text.slice(0, 180)}"`,
          );
        }
        continue;
      }

      const parity = BARE_PARITY.exec(sentence.text);
      const dependent = matched.find((claim) => claim.computeDependent === true);
      if (parity !== null && dependent !== undefined) {
        findings.push(
          `${file}: "${parity[0]}" is an adjective where a compute condition belongs, beside a`
          + ' number whose argument depends on one. The register says:'
          + ` ${dependent.condition ?? ''} — state what was held fixed.`
          + ` Sentence: "${sentence.text.slice(0, 180)}"`,
        );
      }
      // Compared only when the sentence names exactly ONE paper locator. Two means
      // it is discussing two, and which number belongs to which is not readable from
      // the text — `32.0% (Fig. 2) against re-ranking (Appendix A.2, Fig. 6)` is one
      // legitimate sentence with three.
      const locators = [...sentence.text.matchAll(PAPER_LOCATOR)].map((m) => canonical(m[0]));
      for (const claim of matched) {
        if (claim.hedge !== undefined
          && !sentence.text.toLowerCase().includes(claim.hedge.toLowerCase())) {
          findings.push(
            `${file}: cites ${claim.value} without the source's own "${claim.hedge}" — the`
            + ` register records it as: ${claim.says.slice(0, 120)}.`
            + ` Sentence: "${sentence.text.slice(0, 180)}"`,
          );
        }
        // Read over the window, not the sentence: an author names a unit once and
        // then argues. The unit WORD is exact for the same reason — the drift said
        // "discriminator", the thing, where the unit is "discrimination", and a stem
        // would have passed it.
        if (claim.unitWords !== undefined
          && !claim.unitWords.some((word) => nearby.toLowerCase().includes(word))) {
          findings.push(
            `${file}: cites ${claim.value} without naming its unit (${claim.unit}) — the number`
            + ' has a confusable twin and this paragraph does not say which.'
            + ` Sentence: "${sentence.text.slice(0, 180)}"`,
          );
        }
        if (locators.length === 1 && claim.where !== NO_LOCATOR
          && !canonical(claim.where).includes(locators[0] ?? '')) {
          findings.push(
            `${file}: names ${locators[0] ?? ''} for ${claim.value}, which the register locates`
            + ` at ${claim.where} — a locator that does not hold the number is a citation nobody`
            + ` can check. Sentence: "${sentence.text.slice(0, 180)}"`,
          );
        }
      }
    }
  }
  return findings;
}

/**
 * One file, both of its prose corpora: what a human wrote in comments, and what the
 * MODEL is handed in string expressions.
 *
 * The second is the surface that survived the whole audit, and its size is the
 * finding: 189,675 string expressions over 2,022 parseable files, 4.1MB of literal
 * text, of which 920KB across 1,346 files carries a digit and can therefore produce
 * a citation or a finding (measured 2026-09-05). Nothing before this read a byte of it.
 *
 * THE TWO CORPORA DO NOT MEET, and that is a property of this function rather than a
 * rule stated anywhere: each `auditProse` call gets its own `source` string, so a
 * citation in a comment cannot reach a number inside a literal and a citation inside
 * a literal cannot reach the code's comments. It is the right default — a docstring
 * and the string beneath it are written for different readers — and it is a real
 * blind spot, printed as one, because a figure whose only citation sits in the
 * docstring ABOVE its literal is governed by neither corpus.
 */
export function auditFile(file: string, text: string, seen: Coverage): string[] {
  const findings = auditProse(file, citable(file, text), seen, windowOf(file));
  if (!isParseable(file)) return findings;
  const prose = renderedProse(file, text);
  for (const [name, doc] of prose.docs) seen.docs.set(name, doc);
  seen.quotes.push(...prose.quotes);
  for (const unit of prose.units) {
    seen.literals += 1;
    // A unit with no digit cannot produce a finding or a citation: every path below
    // `claimNumbers` requires a number, and `claimNumbers` requires a digit. Stated
    // as the reason rather than as a fast path, because a filter that skipped a
    // governed unit would be indistinguishable from a gate that found nothing.
    if (!/\d/.test(unit)) continue;
    findings.push(...auditProse(file, unit, seen, 'sentence'));
  }
  return findings;
}

/** Register entries prose no longer cites, and the empty-corpus failure a gate must
 *  not have. A withdrawn entry is exempt: it records a number this repository no
 *  longer asserts, so the ideal number of citations for it is zero, and enrolling it
 *  is the ratchet — the same shape as `lean-citations.ts`'s `CITATION_OPAQUE`, where
 *  the blind spot is a declared set rather than a silent one. */
export function auditCoverage(seen: Coverage): string[] {
  const findings: string[] = [];
  for (const work of WORKS) {
    if (!seen.works.has(work.id)) {
      findings.push(
        `register work ${work.id} is cited nowhere with a number — a stale entry is how a`
        + ' register starts describing a document that has moved on',
      );
    }
  }
  for (const claim of CLAIMS) {
    if (claim.hand === 'withdrawn') continue;
    const key = claimKey(claim);
    if (seen.files.has(key)) continue;
    const quoted = seen.recorded.get(key);
    if (quoted !== undefined) {
      findings.push(
        `register entry ${claim.work} ${claim.value} is quoted only inside recorded output`
        + ` (${[...quoted].join(' ')}) — a recording is evidence, not an assertion, so it`
        + ' cannot be the only place this repository stands behind a number. Cite it in prose'
        + ' or delete the entry.',
      );
      continue;
    }
    findings.push(
      `register entry ${claim.work} ${claim.value} is cited nowhere — delete it or cite it`,
    );
  }
  if (seen.sites === 0) {
    findings.push(
      'no claim site found at all, so this gate cannot fail — an empty corpus certifies nothing',
    );
  }
  return findings;
}

/* ── The verdict ───────────────────────────────────────────────────────── */

if (import.meta.main) {
  const seen = coverage();
  const findings = [...auditRegister()];
  for (const [file, text] of readMatching(isTextSource)) {
    if (Object.hasOwn(SELF, file)) continue;
    findings.push(...auditFile(file, text, seen));
  }
  findings.push(...auditCoverage(seen), ...auditQuotations(seen));

  if (process.argv.includes('--list-claims')) {
    for (const claim of CLAIMS) {
      console.log([
        claim.work, claim.value, claim.where, claim.hand, claim.via ?? '-',
        claim.computeDependent === true ? 'compute-dependent' : '-',
        [...(seen.files.get(claimKey(claim)) ?? [])].join(' '),
      ].join('\t'));
    }
    process.exit(findings.length > 0 ? 1 : 0);
  }

  if (findings.length > 0) {
    for (const finding of findings) console.error(`✗ ${finding}`);
    console.error(`literature-citations: ${String(findings.length)} finding(s)`);
    process.exit(1);
  }

  const depth = (hand: Claim['hand']): string =>
    String(CLAIMS.filter((claim) => claim.hand === hand).length);
  const worklist = CLAIMS.filter((claim) => claim.hand !== 'primary' || claim.where === NO_LOCATOR);
  const compared = seen.quotes.filter((quote) => seen.docs.has(quote.target));
  const outside = seen.quotes.filter((quote) => !seen.docs.has(quote.target));
  console.log(
    `literature-citations: OK — ${String(CLAIMS.length)} external numbers across`
    + ` ${String(WORKS.length)} works, cited at ${String(seen.sites)} claim sites.`
    + ` Provenance: ${depth('primary')} primary, ${depth('artifact')} second-hand through an`
    + ` internal artifact, ${depth('unverified')} read by nobody, ${depth('withdrawn')} withdrawn.`
    + ` Corpora: comments, plus ${String(seen.literals)} string expressions read as`
    + ` model-facing prose, of which ${String(compared.length)} declare a quotation compared`
    + ` against its source.`,
  );
  console.log(
    'literature-citations: BLIND SPOTS, so this pass is not mistaken for verification.'
    + '\n  1. It never opens a paper. No digit here is verified, and a register entry that'
    + ' agrees with prose can be wrong in both places.'
    + '\n  2. It cannot verify that a locator SUPPORTS the claim — only that prose and register'
    + ' name the same one, and only where the sentence names exactly one. `§` locators are'
    + ' never compared, because in this repository `§` means our own section.'
    + `\n  3. ${String(CLAIMS.filter((claim) => claim.hand === 'withdrawn').length)} citations`
    + ' carry an author-declared category (`withdrawn`): the declaration is TRUSTED, not'
    + ' verified — this gate checks only that the site behaves like one, never that the author'
    + ' was right to declare it.'
    + '\n  4. It governs a number only where a source is cited: an author-or-arXiv form, or'
    + " prose already quoting one of that source's registered numbers. A number beside a bare"
    + ' product name is NOT governed, nor a masked number — years, `k=v` parameters, `SC(n)`'
    + ' counts, `file.ts:line`, volume:page, locator ordinals, our own `2.4(b)` references.'
    + ` This gate's ${String(Object.keys(SELF).length)} own files — its two program modules, its`
    + ' register and its test — are skipped entirely, because their content IS example'
    + ' citations.'
    + `\n  5. REACH is ${String(REACH)} characters AND the structure holding the citation. A`
    + ' claim standing further than that from the citation it belongs to, or in the paragraph,'
    + ' row or list item beside it with no citation of its own, is NOT governed. The bound is'
    + ' what stops a machine-written document, which has no paragraphs, from being read as one.'
    + `\n  6. ${String(seen.recordings.size)} file(s) were read as RECORDINGS, and none of the`
    + ' prose checks ran on them, because captured output asserts nothing and cannot be'
    + ' corrected without being falsified: '
    + `${[...seen.recordings].join(', ')}. They earn no credit either — a register entry whose`
    + ' only home is a recording is a finding, so the category cannot green anything.'
    + '\n  7. It cannot detect a paraphrase that claims nothing. A quotation is compared only'
    + ' where a docblock DECLARES it with ``Verbatim from `Name` `` — a copy that says nothing'
    + ' about where it came from is governed by no comparison, and neither is a compressed'
    + ' quotation of a PAPER, which needs the recorded source rather than a register.'
    + `\n  8. ${String(worklist.length)} of ${String(CLAIMS.length)} numbers are second-hand or`
    + ' unlocated. `--list-claims` prints the worklist; being on it is not an error, it is the'
    + ' point.'
    + `\n  9. THE TWO CORPORA DO NOT MEET. A file's comments and each of its string expressions`
    + ' are audited as separate texts, so a citation in a docstring does NOT reach a number in'
    + ' the literal beneath it, and a citation inside a literal does not reach the code around'
    + ' it. That is deliberate — a docstring and the string below it are written for different'
    + ' readers, and pooling them would let one arXiv id govern every constant in a module —'
    + ' but it is a genuine hole: a figure whose only citation stands in the docstring above'
    + ' its literal is governed by neither corpus. Measured, not assumed: proven in both'
    + " directions in this gate's test."
    + `\n  10. ${String(outside.length)} declared quotation(s) name a target this repository does`
    + ' not declare and are NOT compared'
    + `${outside.length > 0 ? ` (${outside.map((q) => `${q.file} → ${q.target}`).join(', ')})` : ''}`
    + ' — a quote from another program, a paper or a person cannot be checked against this'
    + ' tree. Only the span a quote shares with its source is governed: an EXCERPT is allowed'
    + ' to stop early, and only a drop from the middle of what it does quote is a finding.',
  );
}
