// The long-horizon family's generator and scorer. Everything here is pure, so
// the whole instrument is checkable without a model, a sandbox, or a provider.
import { describe, test, expect } from 'bun:test';
import {
  LONGHORIZON_ANSWER_FILE, LONGHORIZON_CORPUS_DIR,
  assertLongHorizonSpec, buildLongHorizonAsks, buildLongHorizonQuestions,
  decodeLongHorizonSpec, encodeLongHorizonSpec, generateLongHorizonEntries,
  generateLongHorizonFiles, longHorizonAnswerMatches, longHorizonAsksLeakAnswer,
  longHorizonCorpusChars, longHorizonPartDir, parseLongHorizonAnswerFile,
  renderLongHorizonAnswerFile, scoreLongHorizonAnswers,
  type LongHorizonSpec,
} from '../src/index.js';

const digest: LongHorizonSpec = { shape: 'digest', seed: 11, entries: 120, filler: 60, markers: 5, parts: 1 };
const continuation: LongHorizonSpec = { shape: 'continuation', seed: 12, entries: 200, filler: 40, markers: 6, parts: 4 };

describe('the corpus is a pure function of the spec', () => {
  test('the same spec generates byte-identical files', () => {
    expect(generateLongHorizonFiles(digest)).toEqual(generateLongHorizonFiles(digest));
  });

  test('a different seed generates a different corpus and different answers', () => {
    const other = { ...digest, seed: digest.seed + 1 };
    expect(generateLongHorizonFiles(other)).not.toEqual(generateLongHorizonFiles(digest));
    expect(buildLongHorizonQuestions(other)).not.toEqual(buildLongHorizonQuestions(digest));
  });

  test('entry count, marker count and part assignment follow the spec', () => {
    const entries = generateLongHorizonEntries(continuation);
    expect(entries).toHaveLength(continuation.entries);
    expect(entries.filter((e) => e.marker)).toHaveLength(continuation.markers);
    expect(new Set(entries.map((e) => e.part))).toEqual(new Set([1, 2, 3, 4]));
  });

  test('every part plants at least one marker, so the final ask depends on every episode', () => {
    const parts = new Set(generateLongHorizonEntries(continuation).filter((e) => e.marker).map((e) => e.part));
    expect(parts).toEqual(new Set([1, 2, 3, 4]));
  });

  test('marker tokens are unique — a planted fact has one home', () => {
    const markers = generateLongHorizonEntries(continuation).flatMap((e) => (e.marker ? [e.marker.token] : []));
    expect(new Set(markers).size).toBe(markers.length);
  });

  test('the length bucket scales with entries and filler', () => {
    const small = longHorizonCorpusChars(digest);
    const long = longHorizonCorpusChars({ ...digest, filler: digest.filler * 4 });
    const many = longHorizonCorpusChars({ ...digest, entries: digest.entries * 4 });
    expect(long).toBeGreaterThan(small * 2);
    expect(many).toBeGreaterThan(small * 3);
  });

  test('digest keeps one flat directory; continuation splits into parts', () => {
    expect(longHorizonPartDir(digest, 1)).toBe(LONGHORIZON_CORPUS_DIR);
    expect(longHorizonPartDir(continuation, 3)).toBe(`${LONGHORIZON_CORPUS_DIR}/part-3`);
    for (const f of generateLongHorizonFiles(continuation)) {
      expect(f.path.startsWith(`${LONGHORIZON_CORPUS_DIR}/part-${f.part}/`)).toBe(true);
    }
  });

  test('every entry is materialized exactly once across the files', () => {
    const text = generateLongHorizonFiles(continuation).map((f) => f.text).join('\n');
    for (const entry of generateLongHorizonEntries(continuation)) {
      expect(text.split(`### ${entry.id}\n`)).toHaveLength(2);
    }
  });
});

describe('the questions are answerable only from the corpus', () => {
  test('the count answer equals what the entries actually contain', () => {
    const q = buildLongHorizonQuestions(digest).find((x) => x.id === 'q-count')!;
    const component = /component: (\w[\w-]*)/.exec(q.text)![1];
    const expected = generateLongHorizonEntries(digest)
      .filter((e) => e.component === component && e.status === 'fail').length;
    expect(q.answer).toBe(String(expected));
    expect(expected).toBeGreaterThan(0);
  });

  test('the list answer enumerates every planted marker entry', () => {
    const q = buildLongHorizonQuestions(continuation).find((x) => x.id === 'q-list')!;
    expect(q.answer.split(', ')).toHaveLength(continuation.markers);
  });

  test('the verbatim target is planted in part 1 — the most-compacted part', () => {
    const q = buildLongHorizonQuestions(continuation).find((x) => x.id === 'q-verbatim')!;
    const token = /marker: (MARKER-[A-Z0-9]+)/.exec(q.text)![1];
    const target = generateLongHorizonEntries(continuation).find((e) => e.marker?.token === token)!;
    expect(target.part).toBe(1);
    expect(q.answer).toBe(target.marker!.value);
  });

  test('no ask leaks an answer', () => {
    for (const spec of [digest, continuation]) {
      const { asks } = buildLongHorizonAsks(spec);
      expect(longHorizonAsksLeakAnswer(asks, buildLongHorizonQuestions(spec))).toBeNull();
    }
  });

  test('a leaked answer is caught rather than shipped', () => {
    const questions = buildLongHorizonQuestions(digest);
    const verbatim = questions.find((q) => q.id === 'q-verbatim')!;
    expect(longHorizonAsksLeakAnswer([`the value is ${verbatim.answer}`], questions)).toBe(verbatim.answer);
  });
});

describe('the ask sequence', () => {
  test('digest is one ask that deletes nothing', () => {
    const { asks, removeAfterAsk } = buildLongHorizonAsks(digest);
    expect(asks).toHaveLength(1);
    expect(removeAfterAsk).toEqual([null]);
    expect(asks[0]).toContain(LONGHORIZON_ANSWER_FILE);
  });

  test('continuation is one ask per part plus a final ask, each part deleted after its ask', () => {
    const { asks, removeAfterAsk } = buildLongHorizonAsks(continuation);
    expect(asks).toHaveLength(continuation.parts + 1);
    expect(removeAfterAsk).toEqual([
      `${LONGHORIZON_CORPUS_DIR}/part-1`, `${LONGHORIZON_CORPUS_DIR}/part-2`,
      `${LONGHORIZON_CORPUS_DIR}/part-3`, `${LONGHORIZON_CORPUS_DIR}/part-4`, null,
    ]);
    // Only the last ask asks for the answer file; the earlier ones establish
    // the facts that ask depends on.
    expect(asks.filter((a) => a.includes(LONGHORIZON_ANSWER_FILE))).toHaveLength(1);
    expect(asks.at(-1)).toContain(LONGHORIZON_ANSWER_FILE);
  });
});

describe('scoring is exact, deterministic, and all-or-nothing', () => {
  const questions = buildLongHorizonQuestions(digest);

  test('the oracle answer file passes', () => {
    expect(scoreLongHorizonAnswers(questions, renderLongHorizonAnswerFile(questions)).passed).toBe(true);
  });

  test('an empty answer file fails', () => {
    expect(scoreLongHorizonAnswers(questions, '').passed).toBe(false);
  });

  test('one wrong answer fails the whole task', () => {
    const lines = renderLongHorizonAnswerFile(questions).split('\n');
    const broken = lines.map((l) => (l.startsWith('q-count:') ? 'q-count: 999999' : l)).join('\n');
    const score = scoreLongHorizonAnswers(questions, broken);
    expect(score.passed).toBe(false);
    expect(score.results.filter((r) => r.ok)).toHaveLength(2);
  });

  test('a missing answer is a fail, not a skip', () => {
    const partial = renderLongHorizonAnswerFile(questions.filter((q) => q.id !== 'q-verbatim'));
    const score = scoreLongHorizonAnswers(questions, partial);
    expect(score.passed).toBe(false);
    expect(score.results.find((r) => r.id === 'q-verbatim')!.submitted).toBeNull();
  });

  test('prose around the answer is tolerated; a wrong answer inside prose is not', () => {
    const count = questions.find((q) => q.id === 'q-count')!;
    expect(longHorizonAnswerMatches(count, `there are ${count.answer} of them`)).toBe(true);
    expect(longHorizonAnswerMatches(count, `there are ${Number(count.answer) + 1} of them`)).toBe(false);
  });

  test('a complete list in any order passes; a short or padded list does not', () => {
    const list = questions.find((q) => q.id === 'q-list')!;
    const ids = list.answer.split(', ');
    expect(longHorizonAnswerMatches(list, [...ids].reverse().join(' '))).toBe(true);
    expect(longHorizonAnswerMatches(list, ids.slice(1).join(', '))).toBe(false);
    expect(longHorizonAnswerMatches(list, `${list.answer}, entry-99999`)).toBe(false);
  });

  test('verbatim recall is the planted token, not a near miss', () => {
    const verbatim = questions.find((q) => q.id === 'q-verbatim')!;
    expect(longHorizonAnswerMatches(verbatim, `the value was \`${verbatim.answer}\`.`)).toBe(true);
    expect(longHorizonAnswerMatches(verbatim, verbatim.answer.replace(/\d+$/, '99'))).toBe(false);
  });

  test('the answer file parser takes the first occurrence and ignores everything else', () => {
    const parsed = parseLongHorizonAnswerFile('preamble\n- q-count: 7\nq-count: 9\nq-list = entry-1\n');
    expect(parsed.get('q-count')).toBe('7');
    expect(parsed.get('q-list')).toBe('entry-1');
    expect(parsed.has('preamble')).toBe(false);
  });
});

describe('the spec round-trips into the check argv', () => {
  test('encode/decode is lossless and order-stable', () => {
    for (const spec of [digest, continuation]) {
      expect(decodeLongHorizonSpec(encodeLongHorizonSpec(spec))).toEqual(spec);
    }
    // Field order in the encoding must not follow object-literal order — the
    // encoded string lands in the check argv, so it lands in the task hash.
    const reordered = { parts: 1, markers: 5, filler: 60, entries: 120, seed: 11, shape: 'digest' } as LongHorizonSpec;
    expect(encodeLongHorizonSpec(reordered)).toBe(encodeLongHorizonSpec(digest));
  });

  test('a malformed spec is an error, not a silently different corpus', () => {
    expect(() => decodeLongHorizonSpec('{')).toThrow(/not valid JSON/);
    expect(() => decodeLongHorizonSpec('[1,2,3]')).toThrow(/\[shape, seed, entries, filler, markers, parts\]/);
    expect(() => decodeLongHorizonSpec('["nope",1,1,1,1,1]')).toThrow(/unknown long-horizon shape/);
  });

  test('specs that cannot produce a task are rejected at the source', () => {
    expect(() => assertLongHorizonSpec({ ...digest, markers: 0 })).toThrow(/markers must be an integer/);
    expect(() => assertLongHorizonSpec({ ...digest, markers: 999 })).toThrow(/plants 999 markers/);
    expect(() => assertLongHorizonSpec({ ...digest, parts: 3 })).toThrow(/digest shape has exactly one part/);
    expect(() => assertLongHorizonSpec({ ...continuation, parts: 9999 })).toThrow(/over 9999 parts/);
    expect(() => assertLongHorizonSpec({ ...continuation, markers: 3, parts: 4 })).toThrow(/every part must plant at least one/);
  });
});
