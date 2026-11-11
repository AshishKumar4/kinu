/**
 * A document imported into the account's memory (owner, 2026-11-11): kept whole as account notes, and read by the one
 * extractor every workspace's background pass runs (`runSleepTimeCompute`) into short facts, which reach the owner as
 * one batch they accept in one act. Pieces are read one at a time, each by its own call, so an activation that ends
 * mid-import resumes at the piece it was reading.
 */
import * as v from 'valibot';
import type { RoutedLLM } from '../types/primitives';
import { EVIDENCE_BUDGETS } from '../utils/evidence-window';
import { JsonValueSchema, type JsonValue } from '../utils/json';
import { diagnostics } from '../obs/index';
import { FactKeySchema, renderFactValue } from './facts';
import { runSleepTimeCompute } from './sleep-time-compute';

/** The model an import's pieces are read on: the account's fast tier, its chain walked on a failure. */
export type ImportJudge = Pick<RoutedLLM, 'object'>;

/** One fact an import proposes, as the account keeps it. */
export const ImportedFactSchema = v.strictObject({
  key: FactKeySchema, value: JsonValueSchema, importance: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
});

/** The owner's edit of a batch as they accept it: the facts it keeps, each as they left it. */
export const ImportedFactsSchema = v.array(ImportedFactSchema);

export type ImportedFact = Readonly<v.InferOutput<typeof ImportedFactSchema>>;

/** The owner's words the extractor reads of one turn, whole: a longer piece would be clipped (`renderTurn`). */
const PIECE_CHARS = EVIDENCE_BUDGETS.outcomeUserMessage;

/** `text` cut where it breaks, the widest break first: paragraphs, then lines, then anywhere. */
function cutAt(text: string, breaks: readonly string[]): string[] {
  if (text.length <= PIECE_CHARS) return [text];
  const [mark, ...finer] = breaks;

  if (mark === undefined) return Array.from({ length: Math.ceil(text.length / PIECE_CHARS) }, (_, at) => text.slice(at * PIECE_CHARS, (at + 1) * PIECE_CHARS));
  const pieces: string[] = [];
  let current = '';

  for (const part of text.split(mark).flatMap((each) => cutAt(each, finer))) {
    if (current !== '' && current.length + mark.length + part.length > PIECE_CHARS) {
      pieces.push(current);
      current = part;
    } else {
      current = current === '' ? part : `${current}${mark}${part}`;
    }
  }

  return current === '' ? pieces : [...pieces, current];
}

/** The document as the notes it is kept as, each one piece the extractor reads whole. */
export function importPieces(document: string): string[] {
  return cutAt(document.replace(/\r\n?/gu, '\n').trim(), ['\n\n', '\n']).map((piece) => piece.trim()).filter((piece) => piece !== '');
}

/** A value as prose: a string as written, an object's fields one per line, so the notes read as the document did. */
function valueText(value: JsonValue): string {
  if (typeof value === 'string') return value;

  if (Array.isArray(value)) return value.map((each) => valueText(each)).join('\n');

  if (value !== null && typeof value === 'object') return Object.entries(value).map(([field, each]) => `${field}: ${valueText(each)}`).join('\n');

  return renderFactValue(value);
}

/** Facts an owner imports again, as one document: each under its key. */
export function factsAsDocument(facts: readonly { readonly key: string; readonly value: JsonValue }[]): string {
  return facts.map((fact) => `${fact.key}\n${valueText(fact.value)}`).join('\n\n');
}

/**
 * The facts one piece states about the owner. `known` is what the account will hold besides this import and what its
 * earlier pieces proposed: the extractor reuses those keys, so pieces run in order, never at once. Both of its lists
 * are taken: a document the owner imports is about them, whichever list the extractor files a fact under.
 */
export async function extractImportPiece(
  judge: ImportJudge, piece: { readonly text: string; readonly index: number; readonly total: number },
  known: readonly ImportedFact[],
): Promise<ImportedFact[]> {
  const update = await runSleepTimeCompute(judge, {
    turns: [{
      task: `The owner imported what they wrote into their account memory: part ${String(piece.index + 1)} of ${String(piece.total)}, `
        + 'read oldest first. A line that begins with a date says when they said it.',
      output: '', ownerWords: piece.text,
    }],
    currentFacts: [],
    accountFacts: known.map(({ key, value }) => ({ key, value })),
  });

  const found = new Map<string, ImportedFact>();

  for (const { key, value, importance } of [...update.upserts, ...update.account ?? []]) {
    const kept = v.safeParse(ImportedFactSchema, { key, value, ...(importance !== undefined && { importance }) });

    // A key the account cannot keep (empty once normalized, or past 200 characters) is the model's, never the owner's.
    if (kept.success) found.set(kept.output.key, kept.output);
    else diagnostics.event('memory.import_fact_refused', { keyChars: key.length });
  }

  return [...found.values()];
}

/** `earlier` with `later` merged in by key, a later value winning. */
export function mergeImported(earlier: readonly ImportedFact[], later: readonly ImportedFact[]): ImportedFact[] {
  const merged = new Map(earlier.map((fact) => [fact.key, fact]));

  for (const fact of later) merged.set(fact.key, fact);

  return [...merged.values()];
}
