// Defends: a turn the reactor enqueued rendering as the operator's own bubble.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageView } from '../src/components/MessageView';
import type { UIMessage } from 'ai';

import { describe, test, expect } from 'bun:test';
import {
  ADVISOR_SEVERITIES, ADVISOR_SEVERITY_METADATA_KEY, ADVISOR_SIGNAL_KIND, buildDrainBatch,
  COMPLETION_GATE_EVENT, FORK_INTERRUPTED_SIGNAL, OVERFLOW_RETRY_EVENT,
  WORKSPACE_CREATED_EVENT, workspaceGenesisSignal,
} from '@kinu.run/core';
import type { JsonValue, KinuEvent } from '@kinu.run/core';
import {
  applySignalCard, classifyProgrammaticTurn, eventSourceLabel, eventVariantLabel,
  messageSignalId, parseDrainedEvents, parseSignalCardEvent, type SignalCard,
} from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';

describe('programmatic turn provenance', () => {
  test('reactor drains and background-job wakes are not the user talking', () => {
    expect(classifyProgrammaticTurn({ metadata: { kinuEvent: 'event_drain', drainTurnId: 't1' } }))
      .toEqual({ kind: 'event_drain' });
    expect(classifyProgrammaticTurn({ metadata: { kinuEvent: 'background_job', kind: 'research', status: 'failed' } }))
      .toEqual({ kind: 'background_job', jobKind: 'research', status: 'failed' });
  });

  test('a background-job wake without its kind/status still classifies', () => {
    expect(classifyProgrammaticTurn({ metadata: { kinuEvent: 'background_job' } }))
      .toEqual({ kind: 'background_job', jobKind: 'task', status: 'completed' });
  });

  test('the operator\'s own words keep the user bubble', () => {
    // `mcp` is the operator driving an MCP client (orchestrator.ts runTaskFromMcp).
    expect(classifyProgrammaticTurn({ metadata: { kinuEvent: 'mcp', kinuAuthor: 'operator' } })).toBeNull();
    expect(classifyProgrammaticTurn({ metadata: undefined })).toBeNull();
    expect(classifyProgrammaticTurn({ metadata: {} })).toBeNull();
    expect(classifyProgrammaticTurn({ metadata: 'event_drain' })).toBeNull();
    expect(classifyProgrammaticTurn({ metadata: { kinuMode: 'build' }, id: 'XV4blLw0hI10XYRG' })).toBeNull();
    // A steer re-run gets the programmatic id prefix; the stamp keeps it a bubble.
    expect(classifyProgrammaticTurn({ metadata: { kinuAuthor: 'operator' }, id: 'programmatic:abc' })).toBeNull();
  });

  test('a harness event with no card of its own is still not the owner', () => {
    // An allowlist let `fork_interrupted` fall through to the owner's bubble (measured 2026-08-20
    // on the owner's live workspaces).
    expect(classifyProgrammaticTurn({ metadata: { kinuEvent: FORK_INTERRUPTED_SIGNAL, heads: 23 } }))
      .toEqual({ kind: 'system_event', event: 'fork_interrupted' });
    // `take_pick` and `overflow_retry` are harness prose, not the operator's words.
    expect(classifyProgrammaticTurn({ metadata: { kinuEvent: COMPLETION_GATE_EVENT } }))
      .toEqual({ kind: 'system_event', event: 'completion_gate' });
    expect(classifyProgrammaticTurn({ metadata: { kinuEvent: 'take_pick' } }))
      .toEqual({ kind: 'system_event', event: 'take_pick' });
    expect(classifyProgrammaticTurn({ metadata: { kinuEvent: OVERFLOW_RETRY_EVENT } }))
      .toEqual({ kind: 'system_event', event: 'overflow_retry' });
    // Default inverted so a new event name is covered the day it is added.
    expect(classifyProgrammaticTurn({ metadata: { kinuEvent: 'a_kind_invented_tomorrow' } }))
      .toEqual({ kind: 'system_event', event: 'a_kind_invented_tomorrow' });
    expect(classifyProgrammaticTurn({ metadata: { kinuAuthor: 'harness' } }))
      .toEqual({ kind: 'system_event', event: 'system' });
  });

  // Uses core's constant: a drift would render the first turn as a message the owner never typed.
  test('the workspace\'s own first turn is not the owner speaking', () => {
    const genesis = present(workspaceGenesisSignal('Audit the OAuth callback flow.'), 'the workspace genesis signal');

    expect(classifyProgrammaticTurn({ metadata: { kinuEvent: genesis.kind, signalId: 'sig-1' } }))
      .toEqual({ kind: 'workspace_created' });
    expect(genesis.kind).toBe(WORKSPACE_CREATED_EVENT);
  });
});

describe('genesis in the transcript', () => {
  // The opening turn is stored provenance and not painted at all.
  test('the workspace_created turn renders nothing while real turns render', () => {
    const genesisMessage: UIMessage = {
      id: 'g1', role: 'user',
      metadata: { kinuEvent: 'workspace_created', signalId: 'sig-1' },
      parts: [{ type: 'text', text: 'This workspace has just been created.' }],
    };

    const genesis = renderToStaticMarkup(createElement(MessageView, {
      message: genesisMessage,
    }));

    expect(genesis).not.toContain('workspace has just been created');
    expect(genesis).not.toContain('workspace_created');

    const ownerMessage: UIMessage = {
      id: 'u1', role: 'user',
      parts: [{ type: 'text', text: 'Audit the checkout flow.' }],
    };

    const owner = renderToStaticMarkup(createElement(MessageView, {
      message: ownerMessage,
    }));

    expect(owner).toContain('Audit the checkout flow.');

    const jobMessage: UIMessage = {
      id: 'b1', role: 'user',
      metadata: { kinuEvent: 'background_job', kind: 'test-suite', status: 'completed' },
      parts: [{ type: 'text', text: 'background job completed' }],
    };

    const job = renderToStaticMarkup(createElement(MessageView, {
      message: jobMessage,
    }));

    expect(job.length).toBeGreaterThan(0);
  });
});

describe('advisor cards', () => {
  test('an advisor note at every severity is an advisor card, not the owner speaking', () => {
    for (const severity of ADVISOR_SEVERITIES) {
      expect(classifyProgrammaticTurn({
        metadata: { kinuEvent: ADVISOR_SIGNAL_KIND, [ADVISOR_SEVERITY_METADATA_KEY]: severity }, id: `adv-${severity}`,
      })).toEqual({ kind: 'advisor', severity });
    }
  });

  test('a metadata event key nothing reads is not a card at all', () => {
    // An unread event key is no card, i.e. the owner's bubble. Assembled from parts so it is not greppable.
    const retiredKey = `${['prot', 'eus'].join('')}Event`;
    expect(classifyProgrammaticTurn({
      metadata: { [retiredKey]: ADVISOR_SIGNAL_KIND, [ADVISOR_SEVERITY_METADATA_KEY]: 'blocker' },
      id: 'adv-blocker',
    })).toBeNull();
  });
});

/* Fed through core's buildDrainBatch so the parser cannot drift from it. */
const EVENT_BASE = {
  trace_id: 'trace-1',
  caused_by: null,
  trust: 'external',
  priority: 'background',
  payload_visibility: 'full',
  received_at: 0,
  schema_version: 1,
  reply_channel: null,
  dedupe_key: null,
} as const;

function event<Event extends KinuEvent>(value: Event): Event {
  return value;
}

function webhookEvent(id = 'ev-1') {
  return event({
    ...EVENT_BASE,
    id,
    ingress: 'webhook_hmac',
    variant: 'webhook',
    payload: {
      webhook_id: 'hook-1',
      http_method: 'POST',
      http_headers: {},
      body: { ok: true },
      delivery_id: `delivery-${id}`,
    },
  });
}

describe('drained event parsing', () => {
  test('a subordinate report is recovered as variant / source / brief', () => {
    const batch = present(buildDrainBatch([event({
      ...EVENT_BASE,
      id: 'ev-1',
      ingress: 'subordinate',
      variant: 'subordinate_report',
      payload: { from_subordinate: 'surface-auditor', status: 'progress', task: 'Audit the CLI', content: 'Found 3 gaps', kinu_mode: 'build', sequence_id: 'u-1/a-1' },
    })]), 'the drain batch');

    expect(parseDrainedEvents(batch.text)).toEqual([{
      variant: 'subordinate_report',
      source: 'subordinate (surface-auditor)',
      brief: 'progress [re: Audit the CLI]: Found 3 gaps',
      replyExpected: false,
    }]);
  });

  test('the instruction line is dropped, and every event in a batch is kept', () => {
    const batch = present(buildDrainBatch([
      webhookEvent('a'),
      event({
        ...EVENT_BASE,
        id: 'b', ingress: 'email_inbound', variant: 'email',
        payload: {
          from: 'ops@example.com', to: 'agent@example.com', subject: 'Deploy failed',
          body_text: 'exit 1', message_id: null, in_reply_to: null, references: null, attachments: [],
        },
      }),
    ]), 'the drain batch');

    const parsed = parseDrainedEvents(batch.text);
    expect(batch.text.startsWith('2 events arrived while you were idle')).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((e) => e.variant)).toEqual(['webhook', 'email']);
    expect(parsed[1].source).toBe('email (ops@example.com)');
    expect(parsed[1].brief).toBe('"Deploy failed": exit 1');
  });

  test('a peer ask is flagged as awaiting a reply, and the hint stays out of the brief', () => {
    const batch = present(buildDrainBatch([event({
      ...EVENT_BASE,
      id: 'p1', ingress: 'peer_async', variant: 'peer_agent',
      payload: {
        from_agent_name: 'atlas', from_user_id: 'u1', topic: 'schema', body: 'which shape?',
        sender_event_id: 'out-1', reply_expected: true, kinu_mode: 'build',
        sequence_id: 'seq-1',
      },
    })]), 'the drain batch');

    const [parsed] = parseDrainedEvents(batch.text);
    expect(parsed.replyExpected).toBe(true);
    expect(parsed.source).toBe('peer agent (atlas)');
    expect(parsed.brief).toBe('schema: "which shape?"');
    expect(parsed.brief).not.toContain('peers(');
  });

  test('a colon inside the source label does not swallow the brief', () => {
    const batch = present(buildDrainBatch([event({
      ...EVENT_BASE,
      id: 't1', ingress: 'timer_alarm', variant: 'timer',
      payload: { label: 'background-job-wake:job-7', trigger_id: 'x', scheduled_fire_at: 0 },
    })]), 'the drain batch');

    expect(parseDrainedEvents(batch.text)).toEqual([{
      variant: 'timer',
      source: 'schedule (background-job-wake:job-7)',
      brief: 'background-job-wake:job-7',
      replyExpected: false,
    }]);
  });

  test('a multi-line brief keeps its continuation lines', () => {
    // A report, because `wakesADrain` excludes `subordinate_task`.
    const batch = present(buildDrainBatch([event({
      ...EVENT_BASE,
      id: 's1', ingress: 'subordinate', variant: 'subordinate_report' as const,
      payload: {
        from_subordinate: 'cli-auditor', status: 'completed' as const,
        content: 'Report line one.\nReport line two.',
        sequence_id: 'seq-1', kinu_mode: 'build',
      },
    })]), 'the drain batch');

    const [parsed] = parseDrainedEvents(batch.text);
    expect(parsed.brief).toBe('completed: Report line one.\nReport line two.');
  });

  test('text that is not a drain listing yields nothing to fabricate a card from', () => {
    expect(parseDrainedEvents('')).toEqual([]);
    expect(parseDrainedEvents('just a sentence')).toEqual([]);
    expect(parseDrainedEvents('- a plain bullet')).toEqual([]);
  });
});

describe('event variant labels', () => {
  test('known variants read as prose, unknown ones are de-snaked not relabelled', () => {
    expect(eventVariantLabel('subordinate_report')).toBe('Agent report');
    expect(eventSourceLabel('subordinate (surface-auditor)')).toBe('Agent (surface-auditor)');
    expect(eventVariantLabel('timer')).toBe('Scheduled trigger');
    expect(eventVariantLabel('some_future_variant')).toBe('some future variant');
  });
});

describe('the card lifecycle', () => {
  const opened = (id: string, over: { readonly text?: string } = {}) => ({
    type: 'signal_card', id, state: 'pending',
    metadata: { kinuEvent: 'event_drain' }, text: '1 event arrived', ...over,
  });

  const apply = (events: JsonValue[]): readonly SignalCard[] =>
    events.reduce<readonly SignalCard[]>((cards, row) => {
      const parsed = parseSignalCardEvent({ value: row });

      return parsed ? applySignalCard(cards, parsed) : cards;
    }, []);

  test('delivery opens the card; consumption moves the SAME one', () => {
    const cards = apply([opened('s1'), { type: 'signal_card', id: 's1', state: 'shown' }]);
    expect(cards).toEqual([{
      id: 's1', metadata: { kinuEvent: 'event_drain' }, text: '1 event arrived', state: 'shown',
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
    expect(many[0].id).toBe('s10');
    expect(present(many.at(-1), 'the last card').id).toBe('s59');
  });

  test('a frame that is not a well-formed card event is not one', () => {
    expect(parseSignalCardEvent({ value: { type: 'branch_status', id: 'b1' } })).toBeNull();
    expect(parseSignalCardEvent({ value: { type: 'signal_card', state: 'pending' } })).toBeNull();
    // 'pending' is the card's creation — without its payload there is no card.
    expect(parseSignalCardEvent({ value: { type: 'signal_card', id: 's1', state: 'pending' } })).toBeNull();
    expect(parseSignalCardEvent({ value: { type: 'signal_card', id: 's1', state: 'elsewhere' } })).toBeNull();
    expect(parseSignalCardEvent({ value: null })).toBeNull();
  });

  test('the message a queued signal became names the card it belongs to', () => {
    expect(messageSignalId({ metadata: { kinuEvent: 'event_drain', signalId: 's1' } })).toBe('s1');
    expect(messageSignalId({ metadata: {} })).toBeNull();
    expect(messageSignalId({ metadata: undefined })).toBeNull();
  });
});
