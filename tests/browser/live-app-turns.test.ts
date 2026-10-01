import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRATCH_ROOT_PREFIX } from '../../packages/test-utils/src/scratch';
import { PACED_SILENCE_MS, RECONNECT_STEPS } from '../../scripts/scripted-model';
import { liveRows } from '../../scripts/live-app-rows';

const { observed, verdictOf, boot } = liveRows('live-app-turns', [
  'live-indicator', 'opened-mid-turn', 'reconnect', 'answered', 'unsent-answer', 'state',
]);

/** An answer keeps each step's text where it streamed: its steps drawn while it waits, the same blocks and then the
 *  answer once it ends and after a reload. */
function keepsEachStep({ live, ended, reloaded }: { live: readonly string[]; ended: readonly string[]; reloaded: readonly string[] }): void {
  expect(live.filter((block) => block.startsWith('P:Step'))).toHaveLength(RECONNECT_STEPS);
  expect({ ended, reloaded }).toEqual({ ended: [...live, 'P:Done.'], reloaded: [...live, 'P:Done.'] });
}

beforeAll(boot);

afterAll(() => {
  if (observed.bootFailure !== null) throw new Error(observed.bootFailure);
});

describe('a running turn draws exactly one live state', () => {
  test("the pane was sampled through the paced turn's four silences", () => {
    expect(verdictOf(observed.liveIndicator, 'live-indicator').runningMs).toBeGreaterThanOrEqual(4 * PACED_SILENCE_MS);
  });

  test('Stop never stands over a pane that draws nothing happening', () => {
    expect(verdictOf(observed.liveIndicator, 'live-indicator').blank).toBe(0);
  });

  test('Thinking never stands beside a part that draws itself live', () => {
    expect(verdictOf(observed.liveIndicator, 'live-indicator').doubled).toBe(0);
  });
});

describe('a page opened during a turn stops showing it once the turn ends', () => {
  test('while the turn runs, the composer offers Stop and the header says working', () => {
    expect(verdictOf(observed.openedMidTurn, 'opened-mid-turn').held).toEqual({ stop: true, task: 'working' });
  });

  test('the composer offers no Stop and the thread draws no live state', () => {
    const ended = verdictOf(observed.openedMidTurn, 'opened-mid-turn');

    expect({ stop: ended.stop, states: ended.states }).toEqual({ stop: false, states: 0 });
  });

  test('every sample reads the header, and the header never disagrees with the composer', () => {
    const verdict = verdictOf(observed.openedMidTurn, 'opened-mid-turn');

    expect({ headerless: verdict.headerless, disagreed: verdict.disagreed }).toEqual({ headerless: 0, disagreed: 0 });
  });
});

describe('a page whose socket drops mid-turn keeps its answer in order', () => {
  test("the turn's steps were drawn before the drop", () => {
    expect(verdictOf(observed.reconnect, 'reconnect').before.filter((block) => block.startsWith('T:'))).toHaveLength(RECONNECT_STEPS);
  });

  test('the replay after the reconnect draws the answer as it stood', () => {
    const { before, after } = verdictOf(observed.reconnect, 'reconnect');

    expect(after).toEqual(before);
  });

  test('an answer keeps each step\'s text where it streamed, once the turn ends and after a reload', () => {
    keepsEachStep(verdictOf(observed.answered, 'answered'));
  });

  test('so does the answer of a turn another tab sent, on the page that watched it', () => {
    keepsEachStep(verdictOf(observed.answered, 'answered').watched);
  });

  test('and the answer of a turn no page sent, the workspace\'s own first turn', () => {
    keepsEachStep(verdictOf(observed.unsentAnswer, 'unsent-answer'));
  });

  test('the model\'s next request carries each step\'s text and the answer', () => {
    const { told } = verdictOf(observed.answered, 'answered');

    expect(told.filter((text) => text.startsWith('Step ') || text === 'Done.')).toEqual([
      'Step 1: listing the workspace.', 'Step 2: listing scaffold.', 'Step 3: listing the workspace.', 'Done.',
    ]);
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
