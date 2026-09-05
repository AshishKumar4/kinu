// Failure pathologies — the named cells a scaffold proposal targets.
//
// What these pin: identity is deterministic and model-free, the vocabularies
// are closed, the clustering is a pure function of the outcome text, and the
// optional LLM pass can only change a title. No test calls a live model.
import { describe, expect, test } from 'bun:test';
import {
  COMPLAINT_CLASSES, RESPONSE_MODES,
  clusterPathologies, complaintClass, describePathology, isPathologyId,
  labelPathologyClusters, parsePathologyTag, pathologyId, renderPathologyBlock,
  classifyResponseMode, buildPathologyLabelPrompt,
  type ComplaintClass,
  type PathologyInput,
} from '../src/evolution/pathology';
import type { LLM } from '../src/types/primitives';

function input(over: Partial<PathologyInput>): PathologyInput {
  return {
    turnId: 't1', outcome: 'corrected', userMessage: 'add retries to the uploader',
    assistantResponse: 'Done.', followup: 'ok thanks', scaffoldVersion: 1,
    ...over,
  };
}

/** A model that answers with a fixed string — no network, no live call. */
function stubLLM(reply: string | Error): LLM {
  return {
    async *stream() {
      if (reply instanceof Error) throw reply;
      yield reply;
    },
    async complete() {
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

describe('complaint classification — closed vocabulary, first match wins', () => {
  test('each lexical class is recognised from the follow-up', () => {
    const cases: ReadonlyArray<readonly [string, ComplaintClass]> = [
      ['it throws a TypeError on line 4', 'error'],
      ["that's not what I asked for", 'wrong_target'],
      ['you forgot the retry backoff', 'incomplete'],
      ['nothing happened when I ran it', 'no_action'],
      // Same opener as `incomplete`; the verb is what separates them.
      ['you did not actually run anything', 'no_action'],
      ["you didn't add the backoff", 'incomplete'],
      ["that's way more than I asked for, I didn't ask you to refactor", 'overreach'],
    ];
    for (const [followup, expected] of cases) {
      expect(complaintClass('add retries to the uploader', followup)).toBe(expected);
    }
  });

  test('explicit evidence outranks the inferred repeat', () => {
    // A follow-up that both re-states the request AND names an error is an
    // error report, not a bare repetition.
    expect(complaintClass(
      'add retries to the uploader',
      'add retries to the uploader — it failed again',
    )).toBe('error');
  });

  test('a re-stated request with no complaint words is a repeat', () => {
    expect(complaintClass(
      'add retries to the uploader please',
      'please add retries to the uploader',
    )).toBe('repeat');
  });

  test('too few topic words to judge repetition falls to other, never a guess', () => {
    expect(complaintClass('fix it', 'fix it')).toBe('other');
    expect(complaintClass('add retries to the uploader', null)).toBe('other');
    expect(complaintClass('add retries to the uploader', '   ')).toBe('other');
  });
});

describe('response mode', () => {
  test('fences win, then a trailing question, then length', () => {
    expect(classifyResponseMode('here you go\n```js\nx\n```\n')).toBe('code');
    expect(classifyResponseMode('which uploader did you mean?')).toBe('question');
    expect(classifyResponseMode('a'.repeat(601))).toBe('prose');
    expect(classifyResponseMode('Done.')).toBe('terse');
  });

  test('a fenced answer that also asks a question is still a code answer', () => {
    expect(classifyResponseMode('```js\nx\n```\nwant me to test it?')).toBe('code');
  });
});

describe('pathology identity is deterministic and model-free', () => {
  test('the id is the signature, and only well-formed signatures are ids', () => {
    expect(pathologyId('error', 'code')).toBe('error/code');
    expect(isPathologyId('error/code')).toBe(true);
    expect(isPathologyId('error/nope')).toBe(false);
    expect(isPathologyId('made_up/code')).toBe(false);
    expect(isPathologyId('error')).toBe(false);
    expect(isPathologyId('error/code/extra')).toBe(false);
  });

  test('every cell in the closed product describes itself from the id alone', () => {
    for (const complaint of COMPLAINT_CLASSES) {
      for (const responseMode of RESPONSE_MODES) {
        const described = describePathology(pathologyId(complaint, responseMode));
        expect(described).not.toBe(pathologyId(complaint, responseMode));
        expect(described.length).toBeGreaterThan(20);
      }
    }
  });

  test('an unrecognised id renders as itself rather than a fabricated sentence', () => {
    expect(describePathology('whatever')).toBe('whatever');
  });
});

describe('clustering', () => {
  const rows: PathologyInput[] = [
    input({ turnId: 'a', followup: 'it throws a TypeError', assistantResponse: '```js\nx\n```', scaffoldVersion: 2 }),
    input({ turnId: 'b', followup: 'still failing with an exception', assistantResponse: '```js\ny\n```', outcome: 'frustrated', scaffoldVersion: 3 }),
    input({ turnId: 'c', followup: 'you forgot the backoff', assistantResponse: 'Done.' }),
    input({ turnId: null, followup: 'it crashed', assistantResponse: '```js\nz\n```', scaffoldVersion: 2 }),
  ];

  test('cells are keyed by complaint × responseMode and ordered largest first', () => {
    const clusters = clusterPathologies(rows);
    expect(clusters.map((c) => [c.id, c.size])).toEqual([
      ['error/code', 3],
      ['incomplete/terse', 1],
    ]);
  });

  test('a cell carries its evidence: turns, severity, versions, examples', () => {
    const [errors] = clusterPathologies(rows);
    expect(errors!.turnIds).toEqual(['a', 'b']); // the null-id row contributes size, not an id
    expect(errors!.frustrated).toBe(1);
    expect(errors!.scaffoldVersions).toEqual([2, 3]);
    expect(errors!.examples).toHaveLength(2);
    expect(errors!.title).toBe(describePathology('error/code'));
  });

  test('it leaves the input untouched', () => {
    const snapshot = JSON.stringify(rows);
    clusterPathologies(rows);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });

  test('equal-sized cells break ties by id, so the order is total', () => {
    const clusters = clusterPathologies([
      input({ followup: 'you forgot the backoff' }),
      input({ followup: 'it throws a TypeError' }),
    ]);
    expect(clusters.map((c) => c.id)).toEqual(['error/terse', 'incomplete/terse']);
  });

  test('no negative outcomes means no cells', () => {
    expect(clusterPathologies([])).toEqual([]);
  });
});

describe('LLM labelling can only change a title', () => {
  const clusters = clusterPathologies([input({ followup: 'it throws a TypeError' })]);

  test('a good reply refines the title and nothing else', async () => {
    const [labelled] = await labelPathologyClusters(
      stubLLM('{"error/terse":"claims success without running anything"}'),
      clusters,
    );
    expect(labelled!.title).toBe('claims success without running anything');
    expect({ ...labelled, title: '' }).toEqual({ ...clusters[0]!, title: '' });
  });

  test('a thrown call, junk output, or unknown ids leave the deterministic titles', async () => {
    for (const reply of [new Error('offline'), 'not json at all', '{"made_up/code":"x"}', '{"error/terse":"  "}']) {
      const [labelled] = await labelPathologyClusters(stubLLM(reply), clusters);
      expect(labelled!.title).toBe(clusters[0]!.title);
    }
  });

  test('an empty cluster list makes no call at all', async () => {
    expect(await labelPathologyClusters(stubLLM(new Error('should not be called')), [])).toEqual([]);
  });

  test('the label prompt shows the ids it wants back as keys', () => {
    expect(buildPathologyLabelPrompt(clusters)).toContain('error/terse');
  });
});

describe('the proposal tag', () => {
  test('a valid tag anywhere in the code is the named cell', () => {
    expect(parsePathologyTag('// pathology: error/code\nasync function* run() {}')).toBe('error/code');
    expect(parsePathologyTag('async function* run() {}\n//pathology:repeat/prose')).toBe('repeat/prose');
  });

  test('a missing, malformed, or invented tag names nothing', () => {
    expect(parsePathologyTag('async function* run() {}')).toBeNull();
    expect(parsePathologyTag('// pathology: made_up/thing')).toBeNull();
    expect(parsePathologyTag('// pathology:')).toBeNull();
    // A tag inside prose on the same line as code is not a tag line.
    expect(parsePathologyTag('const x = 1; // pathology: error/code and more')).toBeNull();
  });
});

describe('the prompt block', () => {
  test('it names every cell with its id, title and evidence', () => {
    const clusters = clusterPathologies([
      input({ followup: 'it throws a TypeError', assistantResponse: '```js\nx\n```', outcome: 'frustrated', scaffoldVersion: 4 }),
    ]);
    const block = renderPathologyBlock(clusters);
    expect(block).toContain('error/code');
    expect(block).toContain(describePathology('error/code'));
    expect(block).toContain('1 turn, 1 frustrated');
    expect(block).toContain('seen on v4');
    expect(block).toContain('it throws a TypeError');
  });
});
