/**
 * `publishHeadStream` sits on the root turn's critical path (one DO, one input gate), so it may only fan out and
 * must never touch storage; `recordHeadStep` is the durable, writing twin.
 */

import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import { orchestratorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

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
      // A count read back off SQLite is untyped input: parse, don't cast.
      const counted = v.parse(
        v.object({ n: v.number() }),
        harness.db.prepare('SELECT COUNT(*) AS n FROM head_steps').get(),
      );

      return counted.n;
    };

    const before = rows();
    harness.agent.observePublishHeadStreamFrame({ headId: 'head-7', kind: 'text', delta: 'a partial answer' });
    // `recordHeadStep` is the only writer of this table.
    expect(rows()).toBe(before);
  });
});
