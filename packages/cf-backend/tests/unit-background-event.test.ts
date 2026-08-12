// A turn the reactor enqueued is not the operator speaking. The classifier
// decides which messages lose the user bubble, and the parser recovers the
// events from the prompt the drain wrapped around them.
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDrainBatch } from '@proteus/core';
import type { ProteusEvent } from '@proteus/core';
import {
  applySignalCard, classifyProgrammaticTurn, eventVariantLabel, messageSignalId,
  parseDrainedEvents, parseSignalCardEvent, type SignalCard,
} from '../src/components/background-event.ts';

describe('programmatic turn provenance', () => {
  test('reactor drains and background-job wakes are not the user talking', () => {
    expect(classifyProgrammaticTurn({ proteusEvent: 'event_drain', drainTurnId: 't1' }))
      .toEqual({ kind: 'event_drain' });
    expect(classifyProgrammaticTurn({ proteusEvent: 'background_job', kind: 'research', status: 'failed' }))
      .toEqual({ kind: 'background_job', jobKind: 'research', status: 'failed' });
  });

  test('a background-job wake without its kind/status still classifies', () => {
    expect(classifyProgrammaticTurn({ proteusEvent: 'background_job' }))
      .toEqual({ kind: 'background_job', jobKind: 'task', status: 'completed' });
  });

  test('the operator\'s own words keep the user bubble', () => {
    // `mcp` is the operator through an MCP client; `take_pick` and
    // `overflow_retry` are mechanical re-sends of what they already said.
    expect(classifyProgrammaticTurn({ proteusEvent: 'mcp' })).toBeNull();
    expect(classifyProgrammaticTurn({ proteusEvent: 'take_pick' })).toBeNull();
    expect(classifyProgrammaticTurn({ proteusEvent: 'overflow_retry' })).toBeNull();
    expect(classifyProgrammaticTurn(undefined)).toBeNull();
    expect(classifyProgrammaticTurn({})).toBeNull();
    expect(classifyProgrammaticTurn('event_drain')).toBeNull();
  });
});

/* The drain text the UI parses is composed by core's buildDrainBatch — these
   cases feed real events through it so the parser cannot drift from it. */
function event(over: Partial<ProteusEvent>): ProteusEvent {
  return {
    id: over.id ?? 'ev-1',
    ts: 0,
    ingress: 'webhook_hmac',
    variant: 'webhook',
    payload: { http_method: 'POST', body: { ok: true } },
    payload_visibility: 'full',
    trust: 'untrusted',
    consumed_by_turn: null,
    ...over,
  } as unknown as ProteusEvent;
}

describe('drained event parsing', () => {
  test('a subordinate report is recovered as variant / source / brief', () => {
    const batch = buildDrainBatch([event({
      ingress: 'subordinate',
      variant: 'subordinate_report',
      payload: { from_subordinate: 'surface-auditor', status: 'progress', task: 'Audit the CLI', content: 'Found 3 gaps' },
    })])!;
    expect(parseDrainedEvents(batch.text)).toEqual([{
      variant: 'subordinate_report',
      source: 'subordinate (surface-auditor)',
      brief: 'progress [re: Audit the CLI]: Found 3 gaps',
      replyExpected: false,
    }]);
  });

  test('the instruction line is dropped, and every event in a batch is kept', () => {
    const batch = buildDrainBatch([
      event({ id: 'a' }),
      event({
        id: 'b', ingress: 'email_inbound', variant: 'email',
        payload: {
          from: 'ops@example.com', to: 'agent@example.com', subject: 'Deploy failed',
          body_text: 'exit 1', message_id: null, in_reply_to: null, references: null, attachments: [],
        },
      }),
    ])!;
    const parsed = parseDrainedEvents(batch.text);
    expect(batch.text.startsWith('2 events arrived while you were idle')).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((e) => e.variant)).toEqual(['webhook', 'email']);
    expect(parsed[1]!.source).toBe('email (ops@example.com)');
    expect(parsed[1]!.brief).toBe('"Deploy failed": exit 1');
  });

  test('a peer ask is flagged as awaiting a reply, and the hint stays out of the brief', () => {
    const batch = buildDrainBatch([event({
      id: 'p1', ingress: 'peer_async', variant: 'peer_agent',
      payload: {
        from_agent_name: 'atlas', from_user_id: 'u1', topic: 'schema', body: 'which shape?',
        sender_event_id: 'out-1', reply_expected: true,
      },
    })])!;
    const [parsed] = parseDrainedEvents(batch.text);
    expect(parsed!.replyExpected).toBe(true);
    expect(parsed!.source).toBe('peer agent (atlas)');
    expect(parsed!.brief).toBe('schema: "which shape?"');
    expect(parsed!.brief).not.toContain('peers(');
  });

  test('a colon inside the source label does not swallow the brief', () => {
    const batch = buildDrainBatch([event({
      id: 't1', ingress: 'timer_alarm', variant: 'timer',
      payload: { label: 'background-job-wake:job-7', trigger_id: 'x', scheduled_fire_at: 0 },
    })])!;
    expect(parseDrainedEvents(batch.text)).toEqual([{
      variant: 'timer',
      source: 'schedule (background-job-wake:job-7)',
      brief: 'background-job-wake:job-7',
      replyExpected: false,
    }]);
  });

  test('a multi-line brief keeps its continuation lines', () => {
    const batch = buildDrainBatch([event({
      id: 's1', ingress: 'subordinate', variant: 'subordinate_task' as const,
      payload: {
        from_workspace: 'atlas', kind: 'task' as const, body: 'check the CLI',
        inherited_context: 'Context line one.\nContext line two.',
      },
    })])!;
    const [parsed] = parseDrainedEvents(batch.text);
    expect(parsed!.brief).toBe('Context line one.\nContext line two.\n\ntask: check the CLI');
  });

  test('text that is not a drain listing yields nothing to fabricate a card from', () => {
    expect(parseDrainedEvents('')).toEqual([]);
    expect(parseDrainedEvents('just a sentence')).toEqual([]);
    expect(parseDrainedEvents('- a plain bullet')).toEqual([]);
  });
});

describe('event variant labels', () => {
  test('known variants read as prose, unknown ones are de-snaked not relabelled', () => {
    expect(eventVariantLabel('subordinate_report')).toBe('Subordinate report');
    expect(eventVariantLabel('timer')).toBe('Scheduled trigger');
    expect(eventVariantLabel('some_future_variant')).toBe('some future variant');
  });
});

describe('the card lifecycle', () => {
  const opened = (id: string, over: Record<string, unknown> = {}) => ({
    type: 'signal_card', id, state: 'pending',
    metadata: { proteusEvent: 'event_drain' }, text: '1 event arrived', ...over,
  });
  const apply = (events: unknown[]): readonly SignalCard[] =>
    events.reduce<readonly SignalCard[]>((cards, event) => {
      const parsed = parseSignalCardEvent(event);
      return parsed ? applySignalCard(cards, parsed) : cards;
    }, []);

  test('delivery opens the card; consumption moves the SAME one', () => {
    const cards = apply([opened('s1'), { type: 'signal_card', id: 's1', state: 'shown' }]);
    expect(cards).toEqual([{
      id: 's1', metadata: { proteusEvent: 'event_drain' }, text: '1 event arrived', state: 'shown',
    }]);
  });

  test('a delivery that never landed takes its card away', () => {
    expect(apply([opened('s1'), { type: 'signal_card', id: 's1', state: 'undelivered' }]))
      .toEqual([]);
  });

  test('a re-delivered signal returns to pending on the card it already had', () => {
    const cards = apply([
      opened('s1'),
      { type: 'signal_card', id: 's1', state: 'shown' },
      opened('s1', { text: 're-delivered' }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: 's1', state: 'pending', text: 're-delivered' });
  });

  test('a transition for a card this client never saw open is ignored', () => {
    // A reload mid-flight: the history it loaded already shows the message.
    expect(apply([{ type: 'signal_card', id: 'gone', state: 'shown' }])).toEqual([]);
  });

  test('cards keep arrival order and are bounded', () => {
    const many = apply(Array.from({ length: 60 }, (_, i) => opened(`s${i}`)));
    expect(many).toHaveLength(50);
    expect(many[0]!.id).toBe('s10');
    expect(many.at(-1)!.id).toBe('s59');
  });

  test('a frame that is not a well-formed card event is not one', () => {
    expect(parseSignalCardEvent({ type: 'branch_status', id: 'b1' })).toBeNull();
    expect(parseSignalCardEvent({ type: 'signal_card', state: 'pending' })).toBeNull();
    // 'pending' is the card's creation — without its payload there is no card.
    expect(parseSignalCardEvent({ type: 'signal_card', id: 's1', state: 'pending' })).toBeNull();
    expect(parseSignalCardEvent({ type: 'signal_card', id: 's1', state: 'elsewhere' })).toBeNull();
    expect(parseSignalCardEvent(null)).toBeNull();
  });

  test('the message a queued signal became names the card it belongs to', () => {
    expect(messageSignalId({ proteusEvent: 'event_drain', signalId: 's1' })).toBe('s1');
    // A turn the operator typed belongs to no card.
    expect(messageSignalId({})).toBeNull();
    expect(messageSignalId(undefined)).toBeNull();
  });
});

/**
 * The background threshold is a property of the TURN on this backend.
 *
 * One agent serves both a chat turn a human is watching stream and an
 * email/webhook/timer/peer/MCP drain nobody is waiting on, and the DO's job
 * runner is a per-agent singleton — so the surface has to be resolved at read
 * time, not captured at construction. This regressed silently for the whole
 * life of the one-shot policy: cf passed no policy at all, every turn got the
 * interactive 30s detach, and the measured pathology of that configuration
 * (151 of 202 sandbox scripts becoming `agent.jobResult` polls) is the reason
 * the one-shot policy exists. Nothing observable fails when it goes back to a
 * fixed policy, so it is pinned here against the source.
 */
describe('the cloud backend selects its background policy per turn', () => {
  const actor = readFileSync(join(import.meta.dir, '..', 'src', 'actor-agent.ts'), 'utf8');

  test('the job runner reads the policy through a thunk, not a captured value', () => {
    expect(actor).toContain('policy: () => BACKGROUND_POLICY[this.turnSurface()]');
  });

  test('both unwatched populations are one-shot; only real chat is interactive', () => {
    const surface = /protected turnSurface\(\): SessionSurface \{([\s\S]*?)\n  \}/.exec(actor);
    expect(surface).not.toBeNull();
    // A CLI one-shot invocation AND a signal-driven autonomous turn both have
    // nobody watching a stream. Continuity alone misses the whole autonomous
    // population — the population the one-shot policy was measured on — and
    // the event metadata alone misses `proteus exec` against a cloud
    // workspace. The discriminators are the ones every other decision already
    // reads; there is no third notion of "autonomous".
    expect(surface![1]).toContain('turnUserMessageEvent');
    expect(surface![1]).toContain("_turnContinuity === 'independent_task'");
    expect(surface![1]).toContain("'interactive'");
    expect(surface![1]).toContain("'one-shot'");
  });
});
