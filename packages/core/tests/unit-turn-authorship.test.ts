// Who wrote the words in a turn, decided once at the WRITE and read everywhere.
//
// The rule this replaces was an allowlist of four event names living in the
// chat pane, and it had drifted from the writers by four kinds. Measured on the
// owner's live production workspaces on 2026-08-20, over the same
// `cf_agent_chat_messages` frame the browser renders from:
//
//   sunlit-stone-4a20            3 rows  metadata.kinuEvent = fork_interrupted
//   stone-ash-71f2               1 row   metadata.kinuEvent = fork_interrupted
//   principal-machine-f1296946   1 row   metadata.kinuEvent = fork_interrupted
//
// each reading "23 head(s) across 6 fork run(s) were still marked running from
// an activation that has ended…" and each drawn in the owner's own bubble,
// because `fork_interrupted` was not one of the four names. `completion_gate`,
// `take_pick` and `overflow_retry` are the same hole.
//
// So the default is inverted: a turn written through the programmatic seam is
// the harness speaking unless its producer says otherwise. These tests hold the
// two halves of that — the stamp the seam applies, and the reading of rows that
// predate it — and the legacy cases are the real production shapes above, not
// invented ones.
import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import {
  PROGRAMMATIC_MESSAGE_ID_PREFIX, TURN_AUTHOR_METADATA_KEY,
  stampTurnAuthor, transcriptRole, turnAuthor, uiMessageRow, type StoredRowProjection,
} from '../src/utils/ui-message';
import { SignalDelivery } from '../src/orchestrator/signals';
import { FORK_INTERRUPTED_SIGNAL } from '../src/heads/reconcile';
import { COMPLETION_GATE_EVENT } from '../src/orchestrator/completion-gate';
import { OVERFLOW_RETRY_EVENT } from '../src/turn-failure';
import type { BackendHost } from '../src/types/backend-host';
import { JsonObjectSchema, type JsonObject } from '../src/utils/json';

/** A host that records what the seam wrote, on both rails: the durable turn and
 *  the live card broadcast beside it. The two must agree, because the chat
 *  renders a queued signal and a spliced one through the same classifier. */
function recordingHost() {
  const turns: StoredRowProjection[] = [];
  const cards: JsonObject[] = [];
  const CardFrameSchema = v.looseObject({
    type: v.optional(v.string()),
    metadata: v.optional(JsonObjectSchema),
  });
  const host: BackendHost = {
    broadcast: (event) => {
      const frame = v.safeParse(CardFrameSchema, event);
      if (!frame.success) return;
      if (frame.output.type === 'signal_card' && frame.output.metadata) cards.push(frame.output.metadata);
    },
    enqueueTurn: async ({ text, metadata }) => {
      turns.push(metadata === undefined ? { text } : { text, metadata });
      return { status: 'queued' };
    },
    turnInFlight: () => false,
    setTimer: () => {},
  };
  return { host, turns, cards };
}

describe('the seam stamps who wrote the turn', () => {
  test('every signal-queued turn is the harness unless its producer says otherwise', async () => {
    const { host, turns } = recordingHost();
    const signals = new SignalDelivery(host);
    for (const kind of [
      'background_job', 'event_drain', 'workspace_created', 'deferred_approval',
      FORK_INTERRUPTED_SIGNAL, COMPLETION_GATE_EVENT, OVERFLOW_RETRY_EVENT, 'take_pick',
      'a_kind_invented_tomorrow',
    ]) {
      await signals.deliver({ kind, text: `${kind} happened` });
    }
    expect(turns).toHaveLength(9);
    for (const turn of turns) {
      expect(turn.metadata?.[TURN_AUTHOR_METADATA_KEY]).toBe('harness');
      expect(turnAuthor({ metadata: turn.metadata })).toBe('harness');
    }
  });

  test('a producer carrying the operator\'s words keeps them', async () => {
    // The MCP bridge (cf-backend runTaskFromMcp) is the one signal whose text
    // a person typed. It says so, and the seam does not overwrite it.
    const { host, turns } = recordingHost();
    await new SignalDelivery(host).deliver({
      kind: 'mcp', text: 'ship the coupon fix',
      metadata: { [TURN_AUTHOR_METADATA_KEY]: 'operator' },
    });
    expect(turns[0]!.metadata?.[TURN_AUTHOR_METADATA_KEY]).toBe('operator');
    expect(turnAuthor({ metadata: turns[0]!.metadata })).toBe('operator');
  });

  test('the live card and the durable turn carry the same authorship', async () => {
    // A mid-turn splice is never persisted, so its card is the only record of
    // it. The card and the row disagreeing is a signal that renders one way
    // while it is live and the other way after a reload.
    const { host, turns, cards } = recordingHost();
    await new SignalDelivery(host).deliver({ kind: FORK_INTERRUPTED_SIGNAL, text: '23 head(s)…' });
    expect(cards).toHaveLength(1);
    expect(cards[0]![TURN_AUTHOR_METADATA_KEY]).toBe('harness');
    expect(turns[0]!.metadata?.[TURN_AUTHOR_METADATA_KEY]).toBe('harness');
  });

  test('the stamp survives the metadata a producer brings with it', () => {
    // jobs/runner.ts sends kinuMode/jobId/kind/status; signals.ts merges the
    // producer's object over its own. The author is applied after that merge,
    // so a producer key named the same thing cannot land underneath the seam.
    const stamped = stampTurnAuthor({ kinuEvent: 'background_job', jobId: 'bgjob-1', status: 'completed' });
    expect(stamped).toEqual({
      kinuEvent: 'background_job', jobId: 'bgjob-1', status: 'completed',
      [TURN_AUTHOR_METADATA_KEY]: 'harness',
    });
    // Idempotent: passing through a second funnel does not relabel it.
    expect(stampTurnAuthor(stamped)).toEqual(stamped);
    expect(stampTurnAuthor(stampTurnAuthor({ [TURN_AUTHOR_METADATA_KEY]: 'operator' })))
      .toEqual({ [TURN_AUTHOR_METADATA_KEY]: 'operator' });
    // A turn that reaches the seam saying nothing at all is still the harness.
    expect(stampTurnAuthor()).toEqual({ [TURN_AUTHOR_METADATA_KEY]: 'harness' });
  });
});

describe('rows written before the stamp existed', () => {
  // The four shapes actually present in the owner's production workspaces.
  test('a legacy fork_interrupted row is the harness, by its event name', () => {
    expect(turnAuthor({
      id: 'f8798675-5e9a-4d13-aac2-293f4557f1c1',
      metadata: { kinuEvent: 'fork_interrupted', runs: ['67t522lz3213jla9vylyd'], heads: 4 },
    })).toBe('harness');
  });

  test('a legacy background-job wake is the harness, with or without the id prefix', () => {
    // stone-ash-71f2 wrote these under a bare UUID; principal-machine-f1296946
    // wrote the same fact under the prefix once both backends derived it.
    const metadata = { kinuEvent: 'background_job', kinuMode: 'build', status: 'completed' };
    expect(turnAuthor({ id: '21957535-fe0f-4929-a454-e5e9f53fe804', metadata })).toBe('harness');
    expect(turnAuthor({ id: `${PROGRAMMATIC_MESSAGE_ID_PREFIX}background-job-wake:bgjob-1`, metadata }))
      .toBe('harness');
  });

  test('the owner\'s own messages stay the owner\'s', () => {
    // A real typed message carries a work mode and nothing else — 19 of them in
    // stone-ash-71f2 alone. Reading a work mode as provenance would put every
    // one of them behind a system card.
    expect(turnAuthor({ id: 'oeqkRs2rHNekyDPv', metadata: { kinuMode: 'build' } })).toBe('operator');
    expect(turnAuthor({ id: 'ZGkXEnDwCrv7VFTn' })).toBe('operator');
    // A mid-turn steer is the owner talking, and says so its own way.
    expect(turnAuthor({ id: 'steer-ozev3bmdd9tv', metadata: { kinuSteer: true } })).toBe('operator');
  });

  test('a legacy mcp row keeps its bubble on the event name alone', () => {
    // It has the programmatic id prefix like every other queued turn, so the
    // event name has to be consulted BEFORE the prefix or the operator's own
    // task would be filed as the harness's.
    expect(turnAuthor({
      id: `${PROGRAMMATIC_MESSAGE_ID_PREFIX}0f2c`, metadata: { kinuEvent: 'mcp' },
    })).toBe('operator');
  });

  test('an unparseable metadata row still answers from its id prefix', () => {
    // A corrupt metadata cell carries no stamp and no event name, so the id
    // prefix decides: the ambiguous shape resolves to the harness rather than
    // putting the harness's words in the owner's mouth.
    expect(turnAuthor({ id: `${PROGRAMMATIC_MESSAGE_ID_PREFIX}x`, metadata: 123 })).toBe('harness');
    expect(turnAuthor({ id: 'ZGkXEnDwCrv7VFTn', metadata: 123 })).toBe('operator');
  });

  test('the transcript read model reaches the same answer as the chat pane', () => {
    // getChatHistoryPage reported the fork_interrupted rows above as `user`,
    // because it read only the id prefix and those rows predate it. The rule is
    // one function now, so the two surfaces cannot disagree again.
    expect(transcriptRole('f8798675-5e9a-4d13-aac2-293f4557f1c1', 'user', {
      kinuEvent: 'fork_interrupted',
    })).toBe('system');
    expect(transcriptRole('oeqkRs2rHNekyDPv', 'user', { kinuMode: 'build' })).toBe('user');
    expect(transcriptRole(`${PROGRAMMATIC_MESSAGE_ID_PREFIX}x`, 'user')).toBe('system');
    // Assistant rows are never touched, whatever they carry.
    expect(transcriptRole(`${PROGRAMMATIC_MESSAGE_ID_PREFIX}x`, 'assistant')).toBe('assistant');
  });

  test('the projection reads text and provenance out of one stored row', () => {
    const content = JSON.stringify({
      id: 'programmatic:x', role: 'user',
      parts: [{ type: 'text', text: '23 head(s) across 6 fork run(s)…' }],
      metadata: { kinuEvent: 'fork_interrupted', [TURN_AUTHOR_METADATA_KEY]: 'harness' },
    });
    expect(uiMessageRow(content)).toEqual({
      text: '23 head(s) across 6 fork run(s)…',
      metadata: { kinuEvent: 'fork_interrupted', [TURN_AUTHOR_METADATA_KEY]: 'harness' },
    });
    // The plain mirror holds text, not JSON, and must survive being asked.
    expect(uiMessageRow('find me a domain')).toEqual({ text: 'find me a domain' });
  });
});
