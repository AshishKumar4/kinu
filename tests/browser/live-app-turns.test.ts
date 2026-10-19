import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRATCH_ROOT_PREFIX } from '../../packages/test-utils/src/scratch';
import { DROPPED_FILE_ARRIVED, PACED_SILENCE_MS, RECONNECT_STEPS, STOPPED_ASK } from '../../scripts/live-app-scripts';
import { liveRows, STOP_SEND_ATTEMPTS } from '../../scripts/live-app-rows';

const { observed, verdictOf, boot } = liveRows('live-app-turns', [
  'live-indicator', 'opened-mid-turn', 'reconnect', 'answered', 'unsent-answer', 'dropped-file', 'cleared', 'stop-then-send', 'new-chat-stop',
  'state',
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

// Issue #33: dropped on the chat, a file goes out with the next message and the agent's turn reads it.
describe('a file dropped on the chat reaches the agent', () => {
  test('the turn it went out with read the file\'s contents', () => {
    expect(verdictOf(observed.droppedFile, 'dropped-file').answer).toContain(DROPPED_FILE_ARRIVED);
  });
});

// Release-1 review F4: the page cleared Main without the server's word, so a refused clear came back on reload.
describe('Main clears only once the server has', () => {
  test('a clear while a turn runs shows the server\'s refusal in its dialog and keeps every message, on reload too', () => {
    const cleared = verdictOf(observed.cleared, 'cleared');

    expect(cleared.refusal).not.toBeNull();
    expect({ kept: cleared.keptAfterRefusal, reloaded: cleared.keptAfterReload }).toEqual({ kept: true, reloaded: true });
  });

  test('a clear once the turn has ended closes its dialog and empties Main, and a reload finds it empty', () => {
    const cleared = verdictOf(observed.cleared, 'cleared');

    expect([cleared.closedWhenIdle, cleared.emptiedWhenIdle, cleared.emptyAfterReload]).toEqual([true, true, true]);
  });
});

// A Stop pressed as a turn opens, then a send as it leaves (staging titled-chat, 2026-10-18): the follow-up's stream was
// closed by the stopped turn's late end, the stopped turn read as failed, and words handed back ran on the next send.
describe('a Stop then a send at once', () => {
  test('every follow-up is answered, and the stopped ask never is', () => {
    const { attempts, stoppedAnswered } = verdictOf(observed.stopThenSend, 'stop-then-send');

    expect({ attempts: attempts.length, stoppedAnswered }).toEqual({ attempts: STOP_SEND_ATTEMPTS, stoppedAnswered: false });
  });

  test('a Stop is no failure: words it handed back return to the draft with one info notice, and no other notice shows', () => {
    const { attempts } = verdictOf(observed.stopThenSend, 'stop-then-send');

    expect(attempts).toEqual(attempts.map(({ draft }, index) => (draft === ''
      ? { draft, notices: [] }
      : { draft: `${STOPPED_ASK} ${String(index + 1)}`, notices: ['info'] })));
  });
});

describe("a new chat's opening offers Stop while its first call waits", () => {
  test('Stop stands while the opening waits on the model, and the opening is answered once it is let go', () => {
    expect(verdictOf(observed.newChatStop, 'new-chat-stop')).toEqual({ stopOffered: true, answered: true });
  });
});
