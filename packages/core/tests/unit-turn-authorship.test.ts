// Turn authorship is decided at the write: a programmatic-seam turn is the harness unless its
// producer says otherwise. Unstamped cases are real production row shapes (2026-08-20).
import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import {
  PROGRAMMATIC_MESSAGE_ID_PREFIX, TURN_AUTHOR_METADATA_KEY,
  stampTurnAuthor, transcriptRole, turnAuthor,
} from '../src/utils/ui-message';
import { Inbox } from '../src/orchestrator/inbox';
import { FORK_INTERRUPTED_SIGNAL } from '../src/heads/reconcile';
import { COMPLETION_GATE_EVENT } from '../src/orchestrator/completion-gate';
import { OVERFLOW_RETRY_EVENT } from '../src/turn-failure';
import type { BackendHost } from '../src/types/backend-host';
import { JsonObjectSchema, type JsonObject } from '../src/utils/json';

/** Records both the durable turn and the live card; both render through one classifier. */
function recordingHost() {
  const turns: Array<{ text: string; metadata?: JsonObject }> = [];
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
    const inbox = new Inbox(host);

    for (const kind of [
      'background_job', 'event_drain', 'workspace_created', 'deferred_approval',
      FORK_INTERRUPTED_SIGNAL, COMPLETION_GATE_EVENT, OVERFLOW_RETRY_EVENT, 'take_pick',
      'a_kind_invented_tomorrow',
    ]) {
      await inbox.send({ kind, text: `${kind} happened` });
    }

    expect(turns).toHaveLength(9);

    for (const turn of turns) {
      expect(turn.metadata?.[TURN_AUTHOR_METADATA_KEY]).toBe('harness');
      expect(turnAuthor({ metadata: turn.metadata })).toBe('harness');
    }
  });

  test('a producer carrying the operator\'s words keeps them', async () => {
    // The MCP bridge (cf-backend runTaskFromMcp) is the one signal a person typed.
    const { host, turns } = recordingHost();
    await new Inbox(host).send({
      kind: 'mcp', text: 'ship the coupon fix',
      metadata: { [TURN_AUTHOR_METADATA_KEY]: 'operator' },
    });
    expect(turns[0].metadata?.[TURN_AUTHOR_METADATA_KEY]).toBe('operator');
    expect(turnAuthor({ metadata: turns[0].metadata })).toBe('operator');
  });

  test('the live card and the durable turn carry the same authorship', async () => {
    // A mid-turn splice is never persisted; its card is the only record.
    const { host, turns, cards } = recordingHost();
    await new Inbox(host).send({ kind: FORK_INTERRUPTED_SIGNAL, text: '23 head(s)…' });
    expect(cards).toHaveLength(1);
    expect(cards[0][TURN_AUTHOR_METADATA_KEY]).toBe('harness');
    expect(turns[0].metadata?.[TURN_AUTHOR_METADATA_KEY]).toBe('harness');
  });

  test('the stamp survives the metadata a producer brings with it', () => {
    // The author is applied after the producer metadata merge, so a same-named key cannot override it.
    const stamped = stampTurnAuthor({ kinuEvent: 'background_job', jobId: 'bgjob-1', status: 'completed' });
    expect(stamped).toEqual({
      kinuEvent: 'background_job', jobId: 'bgjob-1', status: 'completed',
      [TURN_AUTHOR_METADATA_KEY]: 'harness',
    });
    expect(stampTurnAuthor(stamped)).toEqual(stamped);
    expect(stampTurnAuthor(stampTurnAuthor({ [TURN_AUTHOR_METADATA_KEY]: 'operator' })))
      .toEqual({ [TURN_AUTHOR_METADATA_KEY]: 'operator' });
    expect(stampTurnAuthor()).toEqual({ [TURN_AUTHOR_METADATA_KEY]: 'harness' });
  });
});

describe('a row that carries no stamp is read from what it does carry', () => {
  test('an unstamped fork_interrupted row is the harness, by its event name', () => {
    expect(turnAuthor({
      id: 'f8798675-5e9a-4d13-aac2-293f4557f1c1',
      metadata: { kinuEvent: 'fork_interrupted', runs: ['67t522lz3213jla9vylyd'], heads: 4 },
    })).toBe('harness');
  });

  test('an unstamped background-job wake is the harness, with or without the id prefix', () => {
    const metadata = { kinuEvent: 'background_job', kinuMode: 'build', status: 'completed' };
    expect(turnAuthor({ id: '21957535-fe0f-4929-a454-e5e9f53fe804', metadata })).toBe('harness');
    expect(turnAuthor({ id: `${PROGRAMMATIC_MESSAGE_ID_PREFIX}background-job-wake:bgjob-1`, metadata }))
      .toBe('harness');
  });

  test('the owner\'s own messages stay the owner\'s', () => {
    // A typed message carries only a work mode; reading it as provenance would hide real user rows.
    expect(turnAuthor({ id: 'oeqkRs2rHNekyDPv', metadata: { kinuMode: 'build' } })).toBe('operator');
    expect(turnAuthor({ id: 'ZGkXEnDwCrv7VFTn' })).toBe('operator');
    expect(turnAuthor({ id: 'steer-ozev3bmdd9tv', metadata: { kinuSteer: true } })).toBe('operator');
  });

  test('an unparseable metadata row still answers from its id prefix', () => {
    // Corrupt metadata: the id prefix decides, resolving ambiguity to the harness.
    expect(turnAuthor({ id: `${PROGRAMMATIC_MESSAGE_ID_PREFIX}x`, metadata: 123 })).toBe('harness');
    expect(turnAuthor({ id: 'ZGkXEnDwCrv7VFTn', metadata: 123 })).toBe('operator');
  });

  test('the transcript read model reaches the same answer as the chat pane', () => {
    expect(transcriptRole({
      id: 'f8798675-5e9a-4d13-aac2-293f4557f1c1', role: 'user', metadata: { kinuEvent: 'fork_interrupted' },
    })).toBe('system');
    expect(transcriptRole({ id: 'oeqkRs2rHNekyDPv', role: 'user', metadata: { kinuMode: 'build' } })).toBe('user');
    expect(transcriptRole({ id: `${PROGRAMMATIC_MESSAGE_ID_PREFIX}x`, role: 'user' })).toBe('system');
    expect(transcriptRole({ id: `${PROGRAMMATIC_MESSAGE_ID_PREFIX}x`, role: 'assistant' })).toBe('assistant');
  });
});
