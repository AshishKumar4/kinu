/**
 * Declared quotations: a string that says it was copied from somewhere else, and
 * whether it still is.
 *
 * The claim is a docblock saying ``Verbatim from `Name` `` above a string
 * expression, and the check is against the prose that `Name` names. It rides the
 * same corpus walk the register audit needs — the string prose a MODEL is handed —
 * because both come out of one parse of one file, and that is why
 * {@link renderedProse} returns all three of its answers together rather than
 * being called three times.
 *
 * Its own module because it is a whole subsystem with its own vocabulary: what a
 * claim is, what resolves a target, what a quote is allowed to omit, and how a
 * divergence is reported. None of that is the register's business — the register
 * compares prose against a table of external numbers — and holding both in one
 * file is what made that file 1.2k lines with two unrelated halves.
 */

import { sentences } from './prose';
import { declaredName, docComment, literalText, ownerName, parse, walk } from './syntax';

/**
 * A docblock DECLARING that the string beneath it is quoted from somewhere else.
 *
 * DECLARED, because `verbatim` is ordinary prose in this tree — 164 files say a value
 * is "passed through verbatim" or "shared verbatim" — so the word cannot be the
 * marker. The marker is the phrase plus a BACKTICKED TARGET, an author naming what
 * they copied, and it is the shape `RECORDING` and `hand: 'withdrawn'` already use:
 * declared by the writer at the moment of writing, changing which check applies and
 * never disabling one.
 *
 * The target is captured LOOSELY on purpose, and this was the second draft. Matching
 * only identifier-shaped targets silently dropped `` `git add -A --ignore-errors` ``
 * from the count, so the gate printed zero uncompared quotations while one sat in
 * `unit-checkpoint-format.test.ts` — a blind spot that under-reports itself is worse
 * than the hole it describes. Every claim is counted; RESOLUTION, not shape, decides
 * which are compared, and a target this tree does not declare is named on the green
 * path instead of guessed at.
 */
const QUOTE_CLAIM = /\bVerbatim from `([^`\n]+)`/i;

/** JSDoc and line-comment leaders, so a docblock reads as the prose it renders to. */
const DOC_LEADER = /^[ \t]*(?:\/\*\*+|\*\/|\*|\/\/)[ \t]?/gm;

/** A string a docblock declares to be a copy of another declaration's prose. */
export interface Quotation {
  readonly file: string;
  /** The declaration doing the quoting, for the finding to name. */
  readonly name: string;
  /** The dotted name it claims to copy. */
  readonly target: string;
  /** The quote as the reader receives it. */
  readonly text: string;
}

/** A parseable file's string prose, all of it from ONE parse. */
export interface Rendered {
  /** Every string expression, as the reader receives it. */
  readonly units: readonly string[];
  /** `Name` and `Owner.member` to the docblock above them, so a quote's target
   *  resolves wherever in the corpus it was declared. */
  readonly docs: readonly (readonly [string, string])[];
  /** Declarations claiming to quote another. */
  readonly quotes: readonly Quotation[];
}

/**
 * A string expression, as the READER receives it: every literal chunk of one
 * concatenation or template, joined in source order — plus the two things only this
 * parse can see, which is why one function returns all three.
 *
 * WHY THE UNIT IS THE EXPRESSION AND NOT THE LITERAL. The defect this closes was
 * written across four `+`-joined lines, and `65.7 vs 59.1` and the `2502.00674`
 * attributing it sat in different quotes. A per-quote corpus governs neither: the
 * citation is in one fragment and the numbers in the next. So the fragments of one
 * expression are one text, which is also what the model is handed.
 *
 * A template HOLE is a space, not a join. `${x}` is a value this program cannot
 * read, and closing the gap would manufacture numbers that no author wrote —
 * `` `${a}.${b}` `` is not the decimal it would look like. A space is the honest
 * spelling of "something unknown was here", and it costs only the ability to read a
 * claim split across an interpolation, which is named in the blind spots.
 *
 * Newlines inside a unit are FLATTENED. A rendered description's line breaks are
 * formatting an author chose for a model's eye; they are not evidence that the text
 * below one came from somewhere else. Treating them as paragraph boundaries would
 * split a tool docstring into thirty units and let a citation in the summary govern
 * none of the numbers in the body.
 */
export function renderedProse(file: string, text: string): Rendered {
  const { root } = parse(file, text);
  const rooted = new Map<number, { at: number; end: number; body: string }[]>();
  const docs: [string, string][] = [];
  const claims: { name: string; target: string; at: number; end: number }[] = [];
  walk(root, (node) => {
    const declared = declaredName(node);
    if (declared !== undefined) {
      // `docComment` owns both halves of "which comment is this declaration's":
      // the wrapper walk up to the statement a docblock sits above, and the
      // positional read of what stands there.
      const doc = docComment(text, node);
      if (doc !== undefined) {
        const owner = ownerName(node);
        docs.push([declared, doc]);
        if (owner !== undefined) docs.push([`${owner}.${declared}`, doc]);
        const claim = QUOTE_CLAIM.exec(doc);
        // The text it quotes is the expression this declaration is initialised with,
        // resolved after the walk because that is when its fragments are all in.
        if (claim?.[1] !== undefined) {
          claims.push({ name: declared, target: claim[1], at: node.start, end: node.end });
        }
      }
    }
    const body = literalText(node);
    if (body === undefined) return;
    // `literalText` is total over every reader-visible literal, numbers and regexes
    // included, and a numeric literal arrives as its own source text. Only a QUOTED
    // one is prose; the rest are governed where they are written, in code.
    if (node.type === 'Literal' && !/["'`]/.test(text.charAt(node.start))) return;
    let top = node;
    while (top.parent !== undefined
      && (top.parent.type === 'TemplateLiteral' || top.parent.type === 'BinaryExpression')) {
      top = top.parent;
    }
    rooted.set(top.start, [...(rooted.get(top.start) ?? []), { at: node.start, end: node.end, body }]);
  });
  const byStart = new Map<number, string>();
  for (const [start, pieces] of rooted) {
    const ordered = [...pieces].sort((a, b) => a.at - b.at);
    let body = '';
    for (const [index, piece] of ordered.entries()) {
      const before = ordered[index - 1];
      // Pure concatenation punctuation between two chunks means they are one word;
      // anything else between them is an interpolation, and unknown.
      if (before !== undefined) {
        body += /^["'`)\s+]*$/.test(text.slice(before.end, piece.at)) ? '' : ' ';
      }
      body += piece.body;
    }
    byStart.set(start, body.replace(/[\r\n]+/g, ' '));
  }
  return {
    units: [...byStart.values()],
    docs,
    // A claim on a declaration that holds no string expression quotes nothing, and is
    // dropped rather than reported: the marker is then prose about something else.
    quotes: claims.flatMap(({ name, target, at, end }) => {
      const starts = [...byStart.keys()].filter((start) => start >= at && start < end);
      const held = starts.length === 0 ? undefined : byStart.get(Math.min(...starts));
      return held === undefined ? [] : [{ file, name, target, text: held }];
    }),
  };
}

/**
 * Prose reduced to the words a reader receives, so two spellings of one sentence
 * compare equal. Backticks, dashes, brackets and quotes are separators; a sentence's
 * closing period is not part of its last word; a `{@link X}` is dropped, because a
 * link has no rendered text and every renderer spells it differently.
 *
 * Number shapes survive: `65.7`, `2502.00674` and `3.2x` are one token each, which is
 * the whole point — a dropped magnitude is what this check exists to catch.
 */
function words(prose: string): readonly string[] {
  return prose
    .replace(/\{@link\s+[^}]*\}/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9.%]+/)
    .map((word) => word.replace(/^\.+|\.+$/g, ''))
    .filter((word) => word.length > 0);
}

/** Whether `run` appears in `stream` as a CONTIGUOUS block. Contiguity is the check:
 *  a subsequence would let a quote drop every second word and pass. */
function holds(stream: readonly string[], run: readonly string[]): boolean {
  for (let at = 0; at + run.length <= stream.length; at += 1) {
    if (run.every((word, index) => stream[at + index] === word)) return true;
  }
  return false;
}

/** The first word of `run` the quote stops carrying — the longest prefix that still
 *  holds, plus one. What a reader needs to see the divergence without a diff. */
function divergence(stream: readonly string[], run: readonly string[]): string {
  let kept = 0;
  while (kept < run.length && holds(stream, run.slice(0, kept + 1))) kept += 1;
  return run.slice(kept, kept + 8).join(' ');
}

/** A sentence long enough to be a claim. Below this a fragment matches almost any
 *  prose — `Default false.` is not a quotation anyone can drift. */
const CLAIM_WORDS = 3;

/** The corpus halves a quotation check reads: every claim found, and every
 *  docblock the corpus declared, by the name prose cites it under.
 *
 *  Narrower than the register audit's `Coverage` on purpose — this check has no
 *  business with works, claim sites or recordings — and structurally satisfied by
 *  it, so the one caller passes its accumulator straight in with no adapter. */
export interface QuotationCorpus {
  readonly docs: ReadonlyMap<string, string>;
  readonly quotes: readonly Quotation[];
}

/**
 * A declared quotation against the prose it claims to copy.
 *
 * WHAT IS CHECKABLE, and it is not "the two texts are equal". A quote is allowed to
 * be an EXCERPT: `MODELS_FIELD_DESCRIPTION` renders the first two paragraphs of
 * `SwarmConfig.models` for a model and stops before the three that discuss the
 * refusal, which is editorial judgement and not drift. What is not allowed is a
 * silent drop from the MIDDLE of what it does quote.
 *
 * So the span is the unit: find the first and last source sentence the quote still
 * carries, and every source sentence between them must be carried too. Outside that
 * span the source is simply not quoted. Inside it, an omission is a finding — which
 * is exactly the shape of the drift this caught on its first run, where the study
 * harness had dropped `Available on EVERY preset.` and, more seriously, the clause
 * carrying a paper's own magnitude, while still presenting itself as verbatim.
 *
 * A target that resolves to nothing is NOT a finding. `Verbatim from \`git add -A\``
 * quotes another program, and a quote from outside this repository cannot be
 * compared against it — those are counted and named on the green path instead.
 */
export function auditQuotations(seen: QuotationCorpus): string[] {
  const findings: string[] = [];
  for (const quote of seen.quotes) {
    const source = seen.docs.get(quote.target);
    if (source === undefined) continue;
    const stream = words(quote.text);
    const claims = sentences(source.replace(DOC_LEADER, ''))
      .map((sentence) => ({ text: sentence.text, run: words(sentence.text) }))
      .filter((claim) => claim.run.length >= CLAIM_WORDS);
    const carried = claims.map((claim) => holds(stream, claim.run));
    const first = carried.indexOf(true);
    if (first < 0) {
      findings.push(
        `${quote.file}: ${quote.name} declares itself verbatim from ${quote.target} and`
        + ' shares not one sentence with it — either the name is wrong or the copy is a'
        + ' paraphrase, and a paraphrase must not claim to be a quotation.',
      );
      continue;
    }
    for (const [index, claim] of claims.entries()) {
      if (carried[index] === true || index < first || index > carried.lastIndexOf(true)) continue;
      findings.push(
        `${quote.file}: ${quote.name} claims to quote ${quote.target} verbatim but drops`
        + ` "${claim.text.slice(0, 150)}" — the quote diverges at`
        + ` "${divergence(stream, claim.run)}". Restore it or stop claiming verbatim.`,
      );
    }
  }
  return findings;
}
