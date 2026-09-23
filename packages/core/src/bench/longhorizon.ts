// The long-horizon bench family: an OOLONG-style corpus scored by exact match,
// no LLM in the path. `digest`: one ask over the whole corpus. `continuation`: K
// asks, each part deleted once answered, so the final ask tests what survived.
// Corpus and answer key derive from the same seed; no key exists on disk.

import { fnv1a64 } from '../utils/fnv1a';
import { parseJsonValue } from '../utils/json';
import { unitHash } from './stats';
import * as v from 'valibot';

const FiniteInteger = v.pipe(v.number(), v.finite(), v.integer());

export const LONGHORIZON_CORPUS_DIR = 'bench-corpus';

export const LONGHORIZON_ANSWER_FILE = 'bench-answer.txt';

export const LONGHORIZON_ENTRIES_PER_FILE = 25;

export type LongHorizonMode = 'digest' | 'continuation';

/** Fields set the three axes OOLONG parameterizes: length, planted facts, arity. */
export interface LongHorizonSpec {
  mode: LongHorizonMode;
  seed: number;
  entries: number;
  filler: number;
  /** Entries carrying a unique `marker:`/`value:` pair. */
  markers: number;
  /** `digest` is always 1. */
  parts: number;
}

const ACTORS = ['rhea', 'tycho', 'ilex', 'morrow', 'sable', 'vesper'] as const;

const COMPONENTS = ['ingest', 'router', 'planner', 'ledger', 'vault'] as const;

const REGIONS = ['eu-west', 'us-east', 'ap-south', 'sa-east'] as const;

const FILLER_WORDS = [
  'retry', 'backoff', 'quorum', 'lease', 'digest', 'shard', 'replica', 'cursor',
  'window', 'drain', 'flush', 'handoff', 'anchor', 'segment', 'probe', 'lag',
  'checkpoint', 'batch', 'stall', 'commit', 'rebalance', 'sweep', 'fence', 'gap',
] as const;

const VALUE_WORDS = [
  'bramble', 'quartz', 'lantern', 'harbor', 'cinder', 'meridian', 'thistle',
  'obsidian', 'wren', 'saffron', 'gantry', 'kelp',
] as const;

const FAIL_RATE = 0.35;

export interface LongHorizonEntry {
  index: number;
  id: string;
  actor: string;
  component: string;
  region: string;
  status: 'ok' | 'fail';
  code: number;
  part: number;
  /** Present on exactly `spec.markers` entries. */
  marker?: { token: string; value: string };
}

function pick<T>(pool: readonly T[], draw: number): T {
  return pool[Math.min(pool.length - 1, Math.floor(draw * pool.length))];
}

export function longHorizonEntryId(index: number): string {
  return `entry-${String(index).padStart(5, '0')}`;
}

/** Lowest draws within each part, so every part plants at least one fact. */
function markerIndices(spec: LongHorizonSpec): Set<number> {
  const base = Math.floor(spec.markers / spec.parts);
  const remainder = spec.markers % spec.parts;
  const byPart = new Map<number, Array<{ index: number; draw: number }>>();

  for (let i = 1; i <= spec.entries; i++) {
    const part = partOf(spec, i);
    const bucket = byPart.get(part) ?? [];
    bucket.push({ index: i, draw: unitHash(`${spec.seed}:${i}:marker-rank`) });
    byPart.set(part, bucket);
  }

  const chosen = new Set<number>();

  for (const [part, bucket] of byPart) {
    const quota = base + (part <= remainder ? 1 : 0);
    bucket.sort((a, b) => (a.draw - b.draw) || (a.index - b.index));

    for (const entry of bucket.slice(0, quota)) chosen.add(entry.index);
  }

  return chosen;
}

function partOf(spec: LongHorizonSpec, index: number): number {
  return Math.min(spec.parts, Math.floor(((index - 1) * spec.parts) / spec.entries) + 1);
}

export function generateLongHorizonEntries(spec: LongHorizonSpec): LongHorizonEntry[] {
  assertLongHorizonSpec(spec);
  const marked = markerIndices(spec);
  const entries: LongHorizonEntry[] = [];

  for (let i = 1; i <= spec.entries; i++) {
    const draw = (salt: string) => unitHash(`${spec.seed}:${i}:${salt}`);

    const entry: LongHorizonEntry = {
      index: i,
      id: longHorizonEntryId(i),
      actor: pick(ACTORS, draw('actor')),
      component: pick(COMPONENTS, draw('component')),
      region: pick(REGIONS, draw('region')),
      status: draw('status') < FAIL_RATE ? 'fail' : 'ok',
      code: 100 + Math.floor(draw('code') * 900),
      part: partOf(spec, i),
    };

    if (marked.has(i)) {
      entry.marker = {
        token: `MARKER-${fnv1a64(`${spec.seed}:${i}:marker-token`).slice(0, 6).toUpperCase()}`,
        value: [
          pick(VALUE_WORDS, draw('value-a')),
          pick(VALUE_WORDS, draw('value-b')),
          String(10 + Math.floor(draw('value-n') * 90)),
        ].join('-'),
      };
    }

    entries.push(entry);
  }

  return entries;
}

function fillerText(spec: LongHorizonSpec, index: number): string {
  if (spec.filler <= 0) return '';
  const words: string[] = [];
  let length = 0;

  for (let w = 0; length < spec.filler; w++) {
    const word = pick(FILLER_WORDS, unitHash(`${spec.seed}:${index}:filler:${w}`));
    words.push(word);
    length += word.length + 1;
  }

  return words.join(' ');
}

export function renderLongHorizonEntry(spec: LongHorizonSpec, entry: LongHorizonEntry): string {
  const lines = [
    `### ${entry.id}`,
    `actor: ${entry.actor}`,
    `component: ${entry.component}`,
    `region: ${entry.region}`,
    `status: ${entry.status}`,
    `code: ${entry.code}`,
  ];

  if (entry.marker) {
    lines.push(`marker: ${entry.marker.token}`, `value: ${entry.marker.value}`);
  }

  lines.push(`notes: ${fillerText(spec, entry.index)}`, '');

  return lines.join('\n');
}

export interface LongHorizonFile {
  path: string;
  text: string;
  part: number;
}

/** `digest` keeps its single part flat. */
export function longHorizonPartDir(spec: LongHorizonSpec, part: number): string {
  return spec.mode === 'digest' ? LONGHORIZON_CORPUS_DIR : `${LONGHORIZON_CORPUS_DIR}/part-${part}`;
}

export function generateLongHorizonFiles(spec: LongHorizonSpec): LongHorizonFile[] {
  const byPart = new Map<number, LongHorizonEntry[]>();

  for (const entry of generateLongHorizonEntries(spec)) {
    const bucket = byPart.get(entry.part) ?? [];
    bucket.push(entry);
    byPart.set(entry.part, bucket);
  }

  const files: LongHorizonFile[] = [];

  for (const [part, partEntries] of [...byPart].sort(([a], [b]) => a - b)) {
    for (let start = 0, n = 0; start < partEntries.length; start += LONGHORIZON_ENTRIES_PER_FILE, n++) {
      const chunk = partEntries.slice(start, start + LONGHORIZON_ENTRIES_PER_FILE);
      files.push({
        path: `${longHorizonPartDir(spec, part)}/log-${String(n + 1).padStart(4, '0')}.md`,
        text: chunk.map((e) => renderLongHorizonEntry(spec, e)).join('\n'),
        part,
      });
    }
  }

  return files;
}

type MarkedEntry = LongHorizonEntry & { marker: NonNullable<LongHorizonEntry['marker']> };

export type LongHorizonQuestionKind = 'count' | 'list' | 'verbatim';

export interface LongHorizonQuestion {
  id: string;
  kind: LongHorizonQuestionKind;
  /** Never contains the answer. */
  text: string;
  answer: string;
}

/** OOLONG-Synthetic's three arities: count, enumeration, verbatim recall. */
export function buildLongHorizonQuestions(spec: LongHorizonSpec): LongHorizonQuestion[] {
  const entries = generateLongHorizonEntries(spec);
  const component = pick(COMPONENTS, unitHash(`${spec.seed}:question:component`));

  const failures = entries.filter((e) => e.component === component && e.status === 'fail');
  const marked = entries.filter((e): e is MarkedEntry => e.marker !== undefined);
  // Part 1 has been through the most compaction by the final ask.
  const verbatimTarget = marked.find((e) => e.part === 1);

  if (verbatimTarget === undefined) {
    throw new Error('long-horizon corpus planted no marker in part 1 — the verbatim ask has no target');
  }

  return [
    {
      id: 'q-count',
      kind: 'count',
      text: `How many entries in the whole log have \`status: fail\` and \`component: ${component}\`? Answer with the number alone.`,
      answer: String(failures.length),
    },
    {
      id: 'q-list',
      kind: 'list',
      text: 'List the id of every entry in the whole log that carries a `marker:` field, in ascending order, comma-separated.',
      answer: marked.map((e) => e.id).join(', '),
    },
    {
      id: 'q-verbatim',
      kind: 'verbatim',
      text: `One entry is tagged \`marker: ${verbatimTarget.marker.token}\`. What is the \`value:\` recorded on that same entry?`,
      answer: verbatimTarget.marker.value,
    },
  ];
}

export interface LongHorizonAsks {
  /** Sent in order on one session. */
  asks: string[];
  /** Parallel to `asks`: a directory to delete after that ask, or null. */
  removeAfterAsk: Array<string | null>;
}

function answerInstruction(questions: readonly LongHorizonQuestion[]): string {
  return [
    'Answer each question below.',
    ...questions.map((q) => `  ${q.id}: ${q.text}`),
    '',
    `Write the answers to \`${LONGHORIZON_ANSWER_FILE}\` in the working directory, one per line,`,
    'each line exactly `<question-id>: <answer>`. Nothing else in that file is read.',
  ].join('\n');
}

export function buildLongHorizonAsks(spec: LongHorizonSpec): LongHorizonAsks {
  const questions = buildLongHorizonQuestions(spec);
  const files = generateLongHorizonFiles(spec);
  const chars = files.reduce((sum, f) => sum + f.text.length, 0);

  if (spec.mode === 'digest') {
    return {
      asks: [[
        `\`${LONGHORIZON_CORPUS_DIR}/\` holds ${spec.entries} log entries across ${files.length} files`,
        `(${chars} characters in total — far more than fits in one request).`,
        '',
        answerInstruction(questions),
      ].join('\n')],
      removeAfterAsk: [null],
    };
  }

  const asks: string[] = [];
  const removeAfterAsk: Array<string | null> = [];

  for (let part = 1; part <= spec.parts; part++) {
    const partFiles = files.filter((f) => f.part === part);
    const dir = longHorizonPartDir(spec, part);
    asks.push([
      `Part ${part} of ${spec.parts} of the log is in \`${dir}/\` — ${partFiles.length} file(s),`,
      `${partFiles.reduce((s, f) => s + f.text.length, 0)} characters.`,
      '',
      'Read it and keep whatever you will need to answer these later, once it is gone:',
      ...questions.map((q) => `  ${q.id}: ${q.text}`),
      '',
      `\`${dir}/\` is DELETED as soon as you finish this message — nothing in it is readable again.`,
      'Reply `noted` when you are done.',
    ].join('\n'));
    removeAfterAsk.push(dir);
  }

  asks.push([
    `All ${spec.parts} parts of the log have been deleted. Answer from what you established while reading them.`,
    '',
    answerInstruction(questions),
  ].join('\n'));
  removeAfterAsk.push(null);

  return { asks, removeAfterAsk };
}

/** Reads `<question-id>: <answer>` lines; first occurrence wins. */
export function parseLongHorizonAnswerFile(text: string): Map<string, string> {
  const found = new Map<string, string>();

  for (const line of text.split('\n')) {
    const match = /^\s*[-*]?\s*(q-[a-z]+)\s*[:=]\s*(.*)$/.exec(line);

    if (!match) continue;
    const [, id, value] = match;

    if (!found.has(id)) found.set(id, value.trim());
  }

  return found;
}

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
}

function entryIds(text: string): string[] {
  return [...new Set(tokens(text).filter((t) => /^entry-\d+$/.test(t)))].sort();
}

/** Exact match per arity; only formatting and list order are forgiven. */
export function longHorizonAnswerMatches(question: LongHorizonQuestion, submitted: string): boolean {
  switch (question.kind) {
    case 'count': {
      const found = /-?\d+/.exec(submitted.replace(/,/g, ''));

      return found !== null && found[0] === question.answer;
    }

    case 'list': {
      const expected = entryIds(question.answer);
      const actual = entryIds(submitted);

      return actual.length === expected.length && actual.every((id, i) => id === expected[i]);
    }

    case 'verbatim':
      return tokens(submitted).includes(question.answer.toLowerCase());
  }
}

export interface LongHorizonQuestionResult {
  id: string;
  expected: string;
  submitted: string | null;
  ok: boolean;
}

export interface LongHorizonScore {
  passed: boolean;
  results: LongHorizonQuestionResult[];
}

export function scoreLongHorizonAnswers(
  questions: readonly LongHorizonQuestion[],
  answerFileText: string,
): LongHorizonScore {
  const parsed = parseLongHorizonAnswerFile(answerFileText);

  const results = questions.map((q) => {
    const submitted = parsed.get(q.id) ?? null;

    return {
      id: q.id,
      expected: q.answer,
      submitted,
      ok: submitted !== null && longHorizonAnswerMatches(q, submitted),
    };
  });

  return { passed: results.length > 0 && results.every((r) => r.ok), results };
}

/** What the oracle control writes, proving the checker is passable. */
export function renderLongHorizonAnswerFile(questions: readonly LongHorizonQuestion[]): string {
  return `${questions.map((q) => `${q.id}: ${q.answer}`).join('\n')}\n`;
}

/** Returns a leaked answer, or null. Short answers (counts) are exempt as noise. */
export function longHorizonAsksLeakAnswer(
  asks: readonly string[],
  questions: readonly LongHorizonQuestion[],
): string | null {
  const joined = asks.join('\n');

  for (const q of questions) {
    if (q.answer.length < 6) continue;

    if (joined.includes(q.answer)) return q.answer;
  }

  return null;
}

/** Canonical order: the string lands in the check argv and so in the task hash. */
export function encodeLongHorizonSpec(spec: LongHorizonSpec): string {
  assertLongHorizonSpec(spec);

  return JSON.stringify([spec.mode, spec.seed, spec.entries, spec.filler, spec.markers, spec.parts]);
}

export function decodeLongHorizonSpec(encoded: string): LongHorizonSpec {
  let raw;

  try {
    raw = parseJsonValue(encoded);
  } catch (error) {
    throw new Error('long-horizon spec is not valid JSON', { cause: error });
  }

  if (!Array.isArray(raw) || raw.length !== 6) {
    throw new Error('long-horizon spec must be [mode, seed, entries, filler, markers, parts]');
  }

  const [mode, seed, entries, filler, markers, parts] = raw;

  if (mode !== 'digest' && mode !== 'continuation') throw new Error(`unknown long-horizon mode: ${JSON.stringify(mode)}`);

  if (!v.is(FiniteInteger, seed)) throw new Error(`long-horizon spec.seed must be a finite integer, got ${JSON.stringify(seed)}`);

  if (!v.is(FiniteInteger, entries)) throw new Error(`long-horizon spec.entries must be a finite integer, got ${JSON.stringify(entries)}`);

  if (!v.is(FiniteInteger, filler)) throw new Error(`long-horizon spec.filler must be a finite integer, got ${JSON.stringify(filler)}`);

  if (!v.is(FiniteInteger, markers)) throw new Error(`long-horizon spec.markers must be a finite integer, got ${JSON.stringify(markers)}`);

  if (!v.is(FiniteInteger, parts)) throw new Error(`long-horizon spec.parts must be a finite integer, got ${JSON.stringify(parts)}`);

  const spec: LongHorizonSpec = {
    mode,
    seed, entries, filler, markers, parts,
  };

  assertLongHorizonSpec(spec);

  return spec;
}

export function assertLongHorizonSpec(spec: LongHorizonSpec): void {
  const positiveInt = (name: string, value: number, min: number) => {
    if (!Number.isInteger(value) || value < min) {
      throw new Error(`long-horizon spec.${name} must be an integer ≥ ${min}, got ${value}`);
    }
  };

  positiveInt('seed', spec.seed, 0);
  positiveInt('entries', spec.entries, 1);
  positiveInt('filler', spec.filler, 0);
  positiveInt('markers', spec.markers, 1);
  positiveInt('parts', spec.parts, 1);

  if (spec.markers > spec.entries) throw new Error(`long-horizon spec plants ${spec.markers} markers in ${spec.entries} entries`);

  if (spec.parts > spec.entries) throw new Error(`long-horizon spec splits ${spec.entries} entries over ${spec.parts} parts`);

  if (spec.mode === 'digest' && spec.parts !== 1) throw new Error('long-horizon digest mode has exactly one part');

  if (spec.markers < spec.parts) {
    throw new Error(`long-horizon spec plants ${spec.markers} markers over ${spec.parts} parts — every part must plant at least one, or the final ask does not depend on it`);
  }
}
