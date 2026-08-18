// The long-horizon bench family: an OOLONG-style corpus the agent must digest,
// in two modes, scored by exact match with no LLM anywhere in the path.
//
// Why a second family at all. The 176-task defect corpus scores a repo fix and
// is blind to everything context-shaped: it cannot tell whether a turn drowned
// in tool bulk, whether a fact survived compaction, or whether peak prompt
// tokens moved. This family is the instrument for those questions, and it is
// deliberately the ONLY thing here that is new — the split, the seal, the
// pairing, the statistics and the report are the existing ones.
//
// Two modes, from the two things worth measuring:
//
//   digest        materials on disk, one ask, answers written to a file. What a
//                 single heavy turn does with a corpus far larger than its
//                 window — the egress/ingress question.
//
//   continuation  the same corpus delivered across K sequential asks, each part
//                 DELETED once its ask is answered, the final ask answerable
//                 only from what survived. The published RLM results have no
//                 instrument of this kind: every one of them is single-query
//                 over an inert corpus. Deleting the parts is what makes the
//                 mode honest — an agent that re-reads the corpus at the end
//                 is not demonstrating continuation, and "please don't re-read"
//                 is a rubric, not a measurement. An agent that wrote its own
//                 notes to a file DOES keep them, and should: that is the
//                 lossless-archive discipline, done by hand.
//
// Everything here is a pure function of the spec. The corpus the solver reads
// and the answer key the checker compares against are generated from the same
// seed by the same code, so there is no key on disk to find, and the spec never
// enters the sandbox.

import { fnv1a64 } from '../prompting/volatile-context';
import { parseJsonValue } from '../utils/json';
import { unitHash } from './stats';

/** Sandbox-relative root the corpus is materialized under. */
export const LONGHORIZON_CORPUS_DIR = 'bench-corpus';
/** Sandbox-relative file the solver writes its answers to. */
export const LONGHORIZON_ANSWER_FILE = 'bench-answer.txt';
/** Entries per corpus file. Small enough that reading one file is a partial
 *  read, large enough that a corpus is not thousands of files. */
export const LONGHORIZON_ENTRIES_PER_FILE = 25;

export type LongHorizonMode = 'digest' | 'continuation';

/** A corpus and its questions, in full. Every field moves the length bucket,
 *  the planted-fact count, or the aggregation arity — the three axes OOLONG
 *  parameterizes — and nothing else. */
export interface LongHorizonSpec {
  mode: LongHorizonMode;
  seed: number;
  /** Log entries in the corpus. With `filler`, this sets the length bucket. */
  entries: number;
  /** Filler characters per entry. */
  filler: number;
  /** Entries carrying a unique `marker:`/`value:` pair — the planted facts. */
  markers: number;
  /** Material parts. `digest` is always 1; `continuation` uses one ask per
   *  part plus a final ask. */
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

/** Fraction of entries that fail. Well away from 0 and 1 so the count question
 *  is neither trivially zero nor trivially the corpus size. */
const FAIL_RATE = 0.35;

export interface LongHorizonEntry {
  /** 1-based. Rendered as `entry-00042`. */
  index: number;
  id: string;
  actor: string;
  component: string;
  region: string;
  status: 'ok' | 'fail';
  code: number;
  /** 1-based part this entry belongs to. */
  part: number;
  /** Present on exactly `spec.markers` entries. */
  marker?: { token: string; value: string };
}

function pick<T>(pool: readonly T[], draw: number): T {
  return pool[Math.min(pool.length - 1, Math.floor(draw * pool.length))]!;
}

export function longHorizonEntryId(index: number): string {
  return `entry-${String(index).padStart(5, '0')}`;
}

/** Which entries carry a planted marker: the lowest draws WITHIN each part, in
 *  a quota spread as evenly as the count allows. Ranking per part rather than
 *  globally is what guarantees every part plants at least one fact — a part
 *  that plants none is an episode the final ask does not actually depend on,
 *  and the continuation mode would then be measuring nothing across it. */
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
  /** Sandbox-relative path. */
  path: string;
  text: string;
  part: number;
}

/** Sandbox-relative directory holding one part's files. `digest` keeps its
 *  single part flat, because a prompt that says "part 1 of 1" is noise. */
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
  for (const part of [...byPart.keys()].sort((a, b) => a - b)) {
    const partEntries = byPart.get(part)!;
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

export function longHorizonCorpusChars(spec: LongHorizonSpec): number {
  return generateLongHorizonFiles(spec).reduce((sum, f) => sum + f.text.length, 0);
}

type MarkedEntry = LongHorizonEntry & { marker: NonNullable<LongHorizonEntry['marker']> };

export type LongHorizonQuestionKind = 'count' | 'list' | 'verbatim';

export interface LongHorizonQuestion {
  id: string;
  kind: LongHorizonQuestionKind;
  /** As put to the solver. Never contains the answer. */
  text: string;
  /** The exact answer, computed from the generated entries. */
  answer: string;
}

/**
 * The three aggregation arities OOLONG-Synthetic uses, over one corpus:
 * a whole-corpus count, an exact enumeration, and verbatim recall of one
 * planted fact. In `continuation` mode all three span every part, and the
 * verbatim target is planted in part 1 — the part that has been through the
 * most compaction by the time the final ask lands.
 */
export function buildLongHorizonQuestions(spec: LongHorizonSpec): LongHorizonQuestion[] {
  const entries = generateLongHorizonEntries(spec);
  const component = pick(COMPONENTS, unitHash(`${spec.seed}:question:component`));

  const failures = entries.filter((e) => e.component === component && e.status === 'fail');
  const marked = entries.filter((e): e is MarkedEntry => e.marker !== undefined);
  // Part 1 by construction (markerIndices gives every part a quota): the first
  // part is the one that has been through the most compaction by the time the
  // final ask lands, so it is the hardest place to recall a value from.
  const verbatimTarget = marked.find((e) => e.part === 1)!;

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

/** What the harness sends the solver, and what it removes between sends. */
export interface LongHorizonAsks {
  /** Sent in order, on ONE session. */
  asks: string[];
  /** Parallel to `asks`: a sandbox-relative directory to delete once that ask
   *  has been answered, or null. This is what makes the continuation mode
   *  measure continuation rather than re-reading. */
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

/** Lines the solver's answer file is read as: `<question-id>: <answer>`, first
 *  occurrence wins, everything else ignored. Forgiving about surrounding prose,
 *  unforgiving about the answer itself. */
export function parseLongHorizonAnswerFile(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^\s*[-*]?\s*(q-[a-z]+)\s*[:=]\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, id, value] = match;
    if (!found.has(id!)) found.set(id!, value!.trim());
  }
  return found;
}

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
}

function entryIds(text: string): string[] {
  return [...new Set(tokens(text).filter((t) => /^entry-\d+$/.test(t)))].sort();
}

/** Exact match, per arity. No partial credit and no judge: a count is right or
 *  it is not, an enumeration is the right set or it is not, and a planted value
 *  is the right token or it is not. The only latitude is formatting — an answer
 *  is read for its content, not its punctuation, because punctuation is not
 *  what this measures, and neither is the order a complete list came out in. */
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
  /** All-or-nothing: every question must be right. */
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

/** The answer file a perfect solver would write. The oracle control writes
 *  exactly this, which is what proves the checker can be passed at all. */
export function renderLongHorizonAnswerFile(questions: readonly LongHorizonQuestion[]): string {
  return `${questions.map((q) => `${q.id}: ${q.answer}`).join('\n')}\n`;
}

/** An ask that contains an answer is not an ask. Counts are exempt: a small
 *  integer occurs in ordinary prose and flagging it would be noise, not a leak.
 *  Returns the offending answer, or null when the asks are clean. */
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

/** Canonical field order — this string lands in the check argv, so it lands in
 *  the task hash, so it must not depend on object-literal order. */
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
  if (mode !== 'digest' && mode !== 'continuation') throw new Error(`unknown long-horizon mode: ${String(mode)}`);
  const spec: LongHorizonSpec = {
    mode,
    seed: Number(seed), entries: Number(entries), filler: Number(filler),
    markers: Number(markers), parts: Number(parts),
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
