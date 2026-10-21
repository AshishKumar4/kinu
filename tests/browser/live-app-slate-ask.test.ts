/**
 * A slate's `agent.ask` through the real dev stack: called from the agent's own program in its turn, it would wait on
 * that turn, which waits on the program (rc22's chat-app trials held it to the 30 s and 300 s windows); it is refused at
 * once, and the slate answers on its own. From the person's page, with no turn running, the agent answers it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { liveRows } from '../../scripts/live-app-rows';
import { SLATE_ASK_FALLBACK, SLATE_ASK_REPLY } from '../../scripts/live-app-scripts';

const { observed, verdictOf, boot } = liveRows('live-app-slate-ask', ['slate-ask']);

beforeAll(boot);

afterAll(() => {
  if (observed.bootFailure !== null) throw new Error(observed.bootFailure);
});

test("a slate's ask from the agent's own program is refused at once, and from the person's page is answered", () => {
  const { program, programMs, page } = verdictOf(observed.slateAsk, 'slate-ask');

  expect({ program, page }).toMatchObject({
    // The program's answer, as its tool returns it: the slate's own fallback, with the refusal in our words; and the
    // ask refused before the slate's own 3 s timer, so nothing waited on it.
    program: { result: {
      asked: { reply: SLATE_ASK_FALLBACK, refused: expect.stringContaining('agent.ask came from a program the agent is running') },
      timed: { won: 'ask' },
    } },
    page: { reply: SLATE_ASK_REPLY },
  });
  // Both asks and the slate's own work, well inside the 30 s a person-watched turn waits on a call.
  expect(programMs).toBeLessThan(10_000);
});
