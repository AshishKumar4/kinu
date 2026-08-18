/**
 * The literature citation gate: docs -> external source, the last boundary in this
 * repository that nothing checked.
 *
 * WHY IT EXISTS, and why it is not a digit checker. `lean-citations.ts` closed
 * TypeScript -> Lean and caught three stale citations on introduction, two of them
 * theorems that had never existed in any module. The generalisation is the point:
 * this tree's citations are in unusually good shape wherever a checker exists —
 * ~40 repo `file:line` references audited, every one resolving — and drifted
 * wherever a boundary was crossed that nothing measures. A seven-number audit of
 * `docs/EXPLORATION-SPEC.md` found six of seven DIGITS correct and four QUALIFIERS
 * wrong. A gate that compared digits would have passed all seven.
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
 */

import { CLAIMS, NO_LOCATOR, WORKS, type Claim, type Work } from './literature';
import { isParseable, isTextSource, readMatching } from './sources';

/**
 * The three files whose CONTENT is example citations: this program, its register, and
 * its test. Skipped for the same reason a secret scanner does not scan its own
 * fixtures.
 *
 * It is not an allowlist and the difference matters. An allowlist exempts files that
 * carry real citations; these three carry none — a citation here would be a fixture,
 * and every fixture is deliberately about a paper the register already holds.
 * `LeanModel` removed the equivalent skip from `lean-citations.ts` by rewriting that
 * gate's account of the three stale citations it caught WITHOUT re-spelling them as
 * citations, which is strictly better and not available here: a register of external
 * numbers cannot be written without writing them down. So it stays, and it is named
 * in the blind-spot list rather than left implicit.
 */
const SELF = {
  'scripts/literature.ts': true,
  'scripts/literature-citations.ts': true,
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

/** Sentence-splitting hazards: an abbreviation ending in a period. Protected
 *  rather than tolerated, because `Koh et al. Table 4 holds` is one sentence and
 *  splitting it there would orphan every number from its citation. */
const ABBREVIATIONS = [
  'et al.', 'Fig.', 'Figs.', 'Tab.', 'Tabs.', 'Sec.', 'App.', 'Eq.', 'Alg.', 'cf.',
  'e.g.', 'i.e.', 'vs.', 'approx.', 'No.', 'al.', 'resp.', 'ca.',
];

/** What an abbreviation's period is replaced by while sentences are being split. One
 *  character, so the mask is LENGTH-PRESERVING: a sentence's offset in the paragraph
 *  that holds it is what makes reach a distance, and a placeholder of a different
 *  width would move every offset after it. */
const MASK = '\u0000';

/** The same abbreviations as one pattern, so their periods can be masked in place. */
const ABBREVIATION = new RegExp(
  ABBREVIATIONS.map((abbreviation) => abbreviation.replace(/\./g, '\\.')).join('|'), 'g',
);

/**
 * A paragraph marking a number as retracted. Read over the PARAGRAPH, because a
 * retraction is a paragraph-level act: §6.5's correction heads one sentence and
 * quotes the withdrawn claim in the next.
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
 * The text a literature citation can live in. A paper is cited in prose, and in
 * source that means a COMMENT — never a string literal, which is why
 * `unit-web.test.ts`'s `'First & Best'` fixture and every numeric literal beside
 * it are out of scope by construction rather than by exception list.
 */
export function citable(file: string, text: string): string {
  const stripped = isParseable(file)
    ? [...text.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)].map((match) => match[0]).join('\n')
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
 * How far a citation REACHES past the sentence that carries it, in characters, and
 * why the structure alone was not enough.
 *
 * The structural unit — paragraph, table row, list item — is still the primary
 * reach, and no distance replaces it: a table row must not inherit the row above
 * it, and that boundary is not a number. But a unit is only evidence of PROXIMITY
 * in a file that has units, and a machine-written one has none.
 * `scripts/axis-ergonomics/runs/axis-zoo3.json` is 206KB of recorded replies
 * carrying no blank line, so it was ONE paragraph: a single `Self-MoA` on line 176
 * reached line 3800, and every integer between them — array indices, an ISO
 * timestamp's `-08` — arrived as an unlocated claim about a paper.
 *
 * The value is measured, not chosen. Below 3,700 the corpus starts losing real claim
 * sites: `docs/EXPLORATION-SPEC.md` §6.5 opens with a citation and then argues for
 * four paragraphs naming no author, which is the longest carry this tree actually
 * uses. At 4000 the corpus governs the same 133 claim sites and the same 54 register
 * entries as unbounded paragraphs did. Beyond that distance it is a real blind spot,
 * and it is printed as one.
 *
 * It is not, on its own, enough for a recorded corpus, and the measurement says so:
 * on `runs/` the bound takes 369 findings down to 175, not to zero, because that file
 * quotes the same citation 17 times and machine-written JSON is dense with integers at
 * every distance. Reach fixes the CLASS — a citation reaching an unrelated part of a
 * file — and `RECORDING` below is what answers the corpus question.
 */
const REACH = 4000;

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

/** Where the structure breaks: a blank line, a table row, a heading, a list item.
 *  Each is its own unit, or one citation pools across a whole table. */
const PARAGRAPH_BREAK = /\n{2,}|\n(?=[|#]|\s*[-*+] )/g;

/** Where a sentence breaks. The lookbehind admits trailing emphasis and brackets,
 *  because `… 0.60.** Landis & Koch …` is two sentences and reading it as one
 *  attributed our own confidence bound to them. */
const SENTENCE_BREAK =
  /(?<=[.!?][*_)"'\u201d]{0,2})[ \n]+(?=[A-Z*_(\u201c"\u00a7[\u2014-])|\n{2,}|\n(?=[|#])/g;

/** A piece of text and where it starts in the text that holds it. */
interface Piece {
  readonly raw: string;
  readonly at: number;
}

/** A sentence, normalised for reading, keeping its offset and the RAW width it
 *  occupies — normalisation shortens the text, and the window around it is cut from
 *  the original. */
interface Sentence {
  readonly text: string;
  readonly at: number;
  readonly width: number;
}

/** Split on a global pattern, keeping each piece's offset. */
function pieces(text: string, breaks: RegExp): Piece[] {
  const found: Piece[] = [];
  let at = 0;
  for (const match of text.matchAll(breaks)) {
    found.push({ raw: text.slice(at, match.index), at });
    at = match.index + match[0].length;
  }
  found.push({ raw: text.slice(at), at });
  return found;
}

/**
 * A unit longer than the reach is not a sentence.
 *
 * Punctuation is what the splitter has to work with, and machine-written text has
 * none: a MINIFIED JSON is one line, one paragraph and one "sentence", and every
 * number in it would then stand beside any citation in it whatever the window said —
 * the window bounds where a citation may be FOUND, not which numbers share a unit
 * with it. So an oversized piece is cut to the reach, at whitespace, which keeps the
 * invariant the reach depends on: no unit is wider than REACH, therefore no citation
 * governs a number it is not near.
 */
function cut(piece: Piece): Piece[] {
  if (piece.raw.length <= REACH) return [piece];
  const found: Piece[] = [];
  let at = 0;
  while (piece.raw.length - at > REACH) {
    // The last line or word break inside the reach; a hard cut only where the text
    // offers neither, which is a single token longer than the reach.
    const gap = Math.max(piece.raw.lastIndexOf('\n', at + REACH), piece.raw.lastIndexOf(' ', at + REACH));
    const end = gap > at ? gap : at + REACH;
    found.push({ raw: piece.raw.slice(at, end), at: piece.at + at });
    at = end;
  }
  found.push({ raw: piece.raw.slice(at), at: piece.at + at });
  return found;
}

/** Prose split into sentences, with abbreviations protected — `Koh et al. Table 4
 *  holds` is one sentence, and splitting it there would orphan every number from its
 *  citation. */
function sentences(text: string): Sentence[] {
  const held = text.replace(ABBREVIATION, (found) => found.split('.').join(MASK));
  return pieces(held, SENTENCE_BREAK)
    .flatMap(cut)
    .map(({ raw, at }) => ({
      text: raw.split(MASK).join('.').replace(/\s+/g, ' ').trim(),
      at,
      width: raw.length,
    }))
    .filter((sentence) => sentence.text.length > 0);
}

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
}

export function coverage(): Coverage {
  return {
    works: new Set(), files: new Map(), recorded: new Map(), recordings: new Set(), sites: 0,
  };
}

/**
 * One file, audited. Exported so the red directions are provable against synthetic
 * prose instead of by mutating the tree the gate governs.
 */
export function auditProse(file: string, text: string, seen: Coverage): string[] {
  const findings: string[] = [];
  // A doc comment is not paragraph-structured prose: it is a dense block where one
  // `Self-MoA` mention would pool a module's constants, so there a citation reaches
  // its own sentence only. In Markdown it reaches forward through the section —
  // §6.5 opens `Koh et al. 2407.01476 Table 4 (§5.1) holds node expansions fixed …`
  // and then argues for four paragraphs that name no author at all. Carry-forward is
  // reset by a heading, replaced by the next citation, and expires at REACH, so the
  // reach is exactly "the work currently under discussion" and never the whole file.
  const narrow = isParseable(file);
  // A recording is still READ, and judged by a different obligation: its quotations
  // are collected so `auditCoverage` can refuse a register entry that lives only
  // there, and no finding is raised against it either way.
  const recording = RECORDING.test(text);
  if (recording) seen.recordings.add(file);
  const blame = !recording;
  const ledger = recording ? seen.recorded : seen.files;
  const source = citable(file, text);
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
    findings.push(...auditProse(file, text, seen));
  }
  findings.push(...auditCoverage(seen));

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
  console.log(
    `literature-citations: OK — ${String(CLAIMS.length)} external numbers across`
    + ` ${String(WORKS.length)} works, cited at ${String(seen.sites)} claim sites.`
    + ` Provenance: ${depth('primary')} primary, ${depth('artifact')} second-hand through an`
    + ` internal artifact, ${depth('unverified')} read by nobody, ${depth('withdrawn')} withdrawn.`,
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
    + ' This gate, its register and its test are skipped entirely, because their content IS'
    + ' example citations.'
    + `\n  5. REACH is ${String(REACH)} characters AND the structure holding the citation. A`
    + ' claim standing further than that from the citation it belongs to, or in the paragraph,'
    + ' row or list item beside it with no citation of its own, is NOT governed. The bound is'
    + ' what stops a machine-written document, which has no paragraphs, from being read as one.'
    + `\n  6. ${String(seen.recordings.size)} file(s) were read as RECORDINGS, and none of the`
    + ' prose checks ran on them, because captured output asserts nothing and cannot be'
    + ' corrected without being falsified: '
    + `${[...seen.recordings].join(', ')}. They earn no credit either — a register entry whose`
    + ' only home is a recording is a finding, so the category cannot green anything.'
    + '\n  7. It cannot detect a compressed or paraphrased QUOTATION. That failure sank a model'
    + ' quotation in this very audit and needs the recorded source, not a register.'
    + `\n  8. ${String(worklist.length)} of ${String(CLAIMS.length)} numbers are second-hand or`
    + ' unlocated. `--list-claims` prints the worklist; being on it is not an error, it is the'
    + ' point.'
    + '\n  9. A citation inside a STRING LITERAL is not read: `citable` keeps comments only.'
    + " That blind spot is load-bearing — this repository's user-facing tool messages quote the"
    + ' literature, and `scripts/axis-ergonomics/{corpus,surface,validate}.ts` carried the'
    + ' bare-parity defect in exactly that position, found only because a recording echoed one'
    + ' of them into a file this gate does read.',
  );
}
