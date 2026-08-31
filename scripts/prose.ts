/**
 * Prose split into the UNITS a citation can reach across.
 *
 * Two audits need the same splitter and neither owns it. The register audit reads
 * a paragraph, then the sentences inside it, to decide which numbers stand beside
 * a citation; the declared-quotation audit reads the sentences of a docblock to
 * decide which of them a quote still carries. Both depend on the same three
 * properties, and all three are easy to get subtly wrong:
 *
 *   - abbreviations are PROTECTED, so `Koh et al. Table 4 holds` is one sentence
 *     rather than two with the number orphaned from its citation;
 *   - offsets SURVIVE the split, because reach is a distance and a normalised
 *     sentence is shorter than the bytes it came from;
 *   - no unit is wider than {@link REACH}, which is what stops a machine-written
 *     document with no punctuation from being read as one enormous sentence.
 *
 * Extracted so the two audits share one implementation rather than one of them
 * importing the other: a quotation check that had to reach into the register
 * program for its sentence splitter would make the two files mutually dependent,
 * and the splitter belongs to neither.
 */

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
 * sites: the longest carry measured in this tree was a passage in a removed internal
 * audit that opened with a citation and then argued for four paragraphs naming no
 * author. At 4000 the corpus governs the same 75 claim sites and 21 register
 * entries as unbounded paragraphs (measured 2026-08-31). Beyond that distance it
 * is a real blind spot,
 * and it is printed as one.
 *
 * It is not, on its own, enough for a recorded corpus, and the measurement says so:
 * on `runs/` the bound takes 369 findings down to 175, not to zero, because that file
 * quotes the same citation 17 times and machine-written JSON is dense with integers at
 * every distance. Reach fixes the CLASS — a citation reaching an unrelated part of a
 * file — and `RECORDING` below is what answers the corpus question.
 */
export const REACH = 4000;

/** Where the structure breaks: a blank line, a table row, a heading, a list item.
 *  Each is its own unit, or one citation pools across a whole table. */
export const PARAGRAPH_BREAK = /\n{2,}|\n(?=[|#]|\s*[-*+] )/g;

/** Where a sentence breaks. The lookbehind admits trailing emphasis and brackets,
 *  because `… 0.60.** Landis & Koch …` is two sentences and reading it as one
 *  attributed our own confidence bound to them. */
const SENTENCE_BREAK =
  /(?<=[.!?][*_)"'\u201d]{0,2})[ \n]+(?=[A-Z*_(\u201c"\u00a7[\u2014-])|\n{2,}|\n(?=[|#])/g;

/** A piece of text and where it starts in the text that holds it. */
export interface Piece {
  readonly raw: string;
  readonly at: number;
}

/** A sentence, normalised for reading, keeping its offset and the RAW width it
 *  occupies — normalisation shortens the text, and the window around it is cut from
 *  the original. */
export interface Sentence {
  readonly text: string;
  readonly at: number;
  readonly width: number;
}

/** Split on a global pattern, keeping each piece's offset. */
export function pieces(text: string, breaks: RegExp): Piece[] {
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
export function sentences(text: string): Sentence[] {
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
