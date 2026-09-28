import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRATCH_ROOT_PREFIX } from '../packages/test-utils/src/scratch';
import { RECONNECT_STEPS } from './scripted-model';
import { liveRows } from './live-app-rows';

const { observed, verdictOf, boot } = liveRows('live-app-sleep', ['observed-reconnect', 'slept', 'watched-slept', 'mid-thought', 'state']);

beforeAll(boot);

afterAll(() => {
  if (observed.bootFailure !== null) throw new Error(observed.bootFailure);
});

describe('a page that joins a reasoning turn part-way reads it whole', () => {
  test('after its socket drops mid-thought', () => {
    expect(verdictOf(observed.midThought, 'mid-thought').reconnectedErrors).toEqual([]);
  });

  test('when it opens on a slow link mid-thought', () => {
    expect(verdictOf(observed.midThought, 'mid-thought').joinedErrors).toEqual([]);
  });

  test('a stream-error report the page posts is accepted, not refused in silence', () => {
    const thought = verdictOf(observed.midThought, 'mid-thought');

    expect(thought.probe).toMatch(/^202 /u);
    expect(thought.reports.filter((report) => report.status >= 300)).toEqual([]);
  });
});

describe('a page whose socket drops mid-turn keeps its answer in order', () => {
  test('so does a page that only watched the turn another tab sent', () => {
    const { before, after } = verdictOf(observed.observedReconnect, 'observed-reconnect');

    expect(before.filter((block) => block.startsWith('T:'))).toHaveLength(RECONNECT_STEPS);
    expect(after).toEqual(before);
  });

  test('a page asleep while its turn ends wakes to the finished answer, with nothing left running', () => {
    const { truth, after, stopAfter } = verdictOf(observed.slept, 'slept');

    expect(truth.at(-1)).toBe('P:Done.');
    expect({ after, stopAfter }).toEqual({ after: truth, stopAfter: false });
  });

  test('so does a page that only watched the turn, asleep from part-way through its final text', () => {
    const { truth, after, stopAfter } = verdictOf(observed.watchedSlept, 'watched-slept');

    expect(truth.at(-1)).toBe('P:Done.');
    expect({ after, stopAfter }).toEqual({ after: truth, stopAfter: false });
  });
});

describe('the live app boots on its own Durable Object state', () => {
  test("the dev server persisted under this run's scratch, never the checkout", () => {
    const state = verdictOf(observed.state, 'state');

    expect(state.root).toStartWith(join(tmpdir(), SCRATCH_ROOT_PREFIX));
    // The plugin's own tree there, not just a directory the harness named:
    // UserDO is the namespace every row's roster and credential goes through.
    expect(state.namespaces).toContain('kinu-UserDO');
  });

  test('nothing but this run stood in that state', () => {
    expect(verdictOf(observed.state, 'state').foreign).toEqual([]);
  });
});
