/**
 * `publishHeadStream` — the transient frame's one wire, and what it may cost.
 *
 * A hosted head or node runs in its own facet, so the frames it produces reach
 * the socket only by calling back to the workspace root. That call is on the
 * critical path of the root's own turn (one Durable Object, one input gate), so
 * this RPC is the only head channel that is allowed to do nothing but fan out.
 *
 * The durable twin, `recordHeadStep`, is the contrast the tests are written
 * against: it WRITES, and its announcement rides that write. This one must not
 * touch storage at all — a frame is superseded by the step that contains it, and
 * a channel that persisted them would be keeping a second, weaker copy of the
 * trace the journal already holds.
 */

import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import { orchestratorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

/** The client's own contract, restated: a frame the validator would keep. */
const FrameSchema = v.object({
  type: v.literal('head_stream'),
  headId: v.string(),
  kind: v.picklist(['text', 'reasoning']),
  delta: v.string(),
});

function captureFrames(agent: HarnessOrchestratorAgent): string[] {
  const sent: string[] = [];
  Object.defineProperty(agent, 'broadcast', {
    configurable: true,
    value: (payload: string) => { sent.push(payload); },
  });
  return sent;
}

describe('publishHeadStreamFrame', () => {
  test('both kinds go out as frames the client validator accepts', () => {
    const harness = orchestratorHarness();
    const sent = captureFrames(harness.agent);

    harness.agent.observePublishHeadStreamFrame({ headId: 'head-7', kind: 'reasoning', delta: 'weighing the two lexers' });
    harness.agent.observePublishHeadStreamFrame({ headId: 'head-7', kind: 'text', delta: 'the lexer handles UTF-8' });

    expect(sent.map((payload) => v.parse(FrameSchema, JSON.parse(payload)))).toEqual([
      { type: 'head_stream', headId: 'head-7', kind: 'reasoning', delta: 'weighing the two lexers' },
      { type: 'head_stream', headId: 'head-7', kind: 'text', delta: 'the lexer handles UTF-8' },
    ]);
  });

  test('it writes nothing — the frame is not a second copy of the trace', () => {
    const harness = orchestratorHarness();
    captureFrames(harness.agent);

    const rows = (): number => {
      // Parsed with the same validator the frames are, rather than cast: a count
      // read back off SQLite is untyped input like any other.
      const counted = v.parse(
        v.object({ n: v.number() }),
        harness.db.prepare('SELECT COUNT(*) AS n FROM head_steps').get(),
      );
      return counted.n;
    };
    const before = rows();
    harness.agent.observePublishHeadStreamFrame({ headId: 'head-7', kind: 'text', delta: 'a partial answer' });
    // The durable channel is `recordHeadStep`, and it is the ONLY writer of this
    // table. A frame that had landed here would be a row no attempt produced.
    expect(rows()).toBe(before);
  });
});
