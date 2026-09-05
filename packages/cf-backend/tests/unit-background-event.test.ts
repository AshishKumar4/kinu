// A turn the reactor enqueued is not the operator speaking. The classifier
// decides which messages lose the user bubble, and the parser recovers the
// events from the prompt the drain wrapped around them.
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADVISOR_SEVERITIES, ADVISOR_SEVERITY_METADATA_KEY, ADVISOR_SIGNAL_KIND, buildDrainBatch,
  COMPLETION_GATE_EVENT, FORK_INTERRUPTED_SIGNAL, OVERFLOW_RETRY_EVENT,
  JsonObjectSchema, WORKSPACE_CREATED_EVENT, workspaceGenesisSignal,
} from '@kinu.run/core';
import type { AdvisorSeverity, JsonObject, JsonValue, KinuEvent } from '@kinu.run/core';
import * as v from 'valibot';
import {
  applySignalCard, classifyProgrammaticTurn, eventSourceLabel, eventVariantLabel,
  messageSignalId, parseDrainedEvents, parseSignalCardEvent, type SignalCard,
} from '../src/components/background-event';
import { parse, walk, type SyntaxNode } from '../../../scripts/syntax';

describe('programmatic turn provenance', () => {
  test('reactor drains and background-job wakes are not the user talking', () => {
    expect(classifyProgrammaticTurn({ kinuEvent: 'event_drain', drainTurnId: 't1' }))
      .toEqual({ kind: 'event_drain' });
    expect(classifyProgrammaticTurn({ kinuEvent: 'background_job', kind: 'research', status: 'failed' }))
      .toEqual({ kind: 'background_job', jobKind: 'research', status: 'failed' });
  });

  test('a background-job wake without its kind/status still classifies', () => {
    expect(classifyProgrammaticTurn({ kinuEvent: 'background_job' }))
      .toEqual({ kind: 'background_job', jobKind: 'task', status: 'completed' });
  });

  test('the operator\'s own words keep the user bubble', () => {
    // `mcp` is the operator driving an MCP client, and its producer stamps that
    // (cf-backend/src/orchestrator.ts runTaskFromMcp).
    expect(classifyProgrammaticTurn({ kinuEvent: 'mcp', kinuAuthor: 'operator' })).toBeNull();
    // No markers at all, whatever the id: the operator typed it.
    expect(classifyProgrammaticTurn(undefined)).toBeNull();
    expect(classifyProgrammaticTurn({})).toBeNull();
    expect(classifyProgrammaticTurn('event_drain')).toBeNull();
    expect(classifyProgrammaticTurn({ kinuMode: 'build' }, 'XV4blLw0hI10XYRG')).toBeNull();
    // A steer re-run as its own turn goes through the programmatic funnel and
    // gets its id prefix, so the stamp is the only thing keeping it a bubble.
    expect(classifyProgrammaticTurn({ kinuAuthor: 'operator' }, 'programmatic:abc')).toBeNull();
  });

  test('a harness event with no card of its own is still not the owner', () => {
    // THE REGRESSION. This used to be an allowlist of four event names and
    // everything else fell through to the owner's bubble. Measured 2026-08-20
    // on the owner's live workspaces: `fork_interrupted` rows reading "23
    // head(s) across 6 fork run(s) were still marked running…" in
    // sunlit-stone-4a20, stone-ash-71f2 and principal-machine-f1296946.
    expect(classifyProgrammaticTurn({ kinuEvent: FORK_INTERRUPTED_SIGNAL, heads: 23 }))
      .toEqual({ kind: 'system_event', event: 'fork_interrupted' });
    // The other three the allowlist missed. `take_pick` and `overflow_retry`
    // were called the operator's own words here and are not: the take
    // continuation speaks ABOUT the user in the third person
    // (mcts/takes.ts buildTakeContinuationPrompt) and the overflow retry is
    // harness prose about a compaction (turn-failure.ts OVERFLOW_RETRY_TEXT).
    expect(classifyProgrammaticTurn({ kinuEvent: COMPLETION_GATE_EVENT }))
      .toEqual({ kind: 'system_event', event: 'completion_gate' });
    expect(classifyProgrammaticTurn({ kinuEvent: 'take_pick' }))
      .toEqual({ kind: 'system_event', event: 'take_pick' });
    expect(classifyProgrammaticTurn({ kinuEvent: OVERFLOW_RETRY_EVENT }))
      .toEqual({ kind: 'system_event', event: 'overflow_retry' });
    // An event name nobody has written yet is covered the day it is added —
    // that is the whole reason the default is inverted.
    expect(classifyProgrammaticTurn({ kinuEvent: 'a_kind_invented_tomorrow' }))
      .toEqual({ kind: 'system_event', event: 'a_kind_invented_tomorrow' });
    // Stamped harness with no event name at all still loses the bubble.
    expect(classifyProgrammaticTurn({ kinuAuthor: 'harness' }))
      .toEqual({ kind: 'system_event', event: 'system' });
  });

  // Genesis: the card and the signal that produces it must agree on ONE string.
  // The signal is built in core (identity/soul.ts) and classified here; if they
  // ever drift, the workspace's first turn silently renders as a message the
  // owner never typed. So the assertion uses the core constant, not a literal.
  test('the workspace\'s own first turn is not the owner speaking', () => {
    const genesis = workspaceGenesisSignal('Audit the OAuth callback flow.');
    expect(genesis).not.toBeNull();
    expect(classifyProgrammaticTurn({ kinuEvent: genesis!.kind, signalId: 'sig-1' }))
      .toEqual({ kind: 'workspace_created' });
    expect(genesis!.kind).toBe(WORKSPACE_CREATED_EVENT);
  });
});

/*
 * The gallery's advisor frame is a THIRD PARTY to the contract above, and it
 * broke first. `AdvisorFrame` photographs the severity ladder off its own
 * metadata literal, and that literal stamped the event under the pre-rename
 * spelling of `kinuEvent` — a key nothing has ever read. `turnAuthor`
 * therefore found no marker at all on an id like `adv-nit`, the classifier
 * answered null, and all three notes rendered in the owner's own bubble: the
 * one frame that exists to prove the advisor card was photographing its
 * absence instead.
 *
 * A fixture cannot be held to this contract by re-reading the constants the
 * product reads — spelling them again is precisely what it got wrong. So the
 * fixture's OWN expression is read out of gallery.tsx and evaluated with the
 * constants it names: the object classified below is the object the frame
 * builds.
 */
const GALLERY = join(import.meta.dir, '..', 'src', 'gallery.tsx');

/** The `metadata` expression a named gallery fixture builds, verbatim. */
function fixtureMetadataSource(file: string, fixture: string): string {
  const text = readFileSync(file, 'utf8');
  let source: string | null = null;
  walk(parse(file, text).root, (node: SyntaxNode) => {
    const raw = node.raw;
    if (source !== null || raw.type !== 'VariableDeclarator') return;
    if (raw.id.type !== 'Identifier' || raw.id.name !== fixture) return;
    walk(node, (inner: SyntaxNode) => {
      if (source !== null || inner.raw.type !== 'ObjectExpression') return;
      const owner = inner.parent?.raw;
      if (owner === undefined || owner.type !== 'Property') return;
      if (owner.key.type !== 'Identifier' || owner.key.name !== 'metadata') return;
      source = text.slice(inner.start, inner.end);
    });
  });
  if (source === null) {
    throw new Error(`${file}'s ${fixture} no longer builds its metadata from an object literal`);
  }
  return source;
}

describe("the gallery's advisor fixture", () => {
  const metadataSource = fixtureMetadataSource(GALLERY, 'ADVISOR_MESSAGES');

  /** The fixture's metadata for one rung, with the two core constants it
   *  closes over bound to what the frame binds them to. Parsed on the way out,
   *  because a fixture whose metadata is not a JSON object is not a row any
   *  client could carry; a fixture naming some other constant fails here
   *  rather than passing on a shape nobody renders. */
  const fixtureMetadata = (severity: AdvisorSeverity): JsonObject => {
    const build = new Function(
      'ADVISOR_SIGNAL_KIND', 'ADVISOR_SEVERITY_METADATA_KEY', 'severity',
      `return (${metadataSource});`,
    );
    return v.parse(
      JsonObjectSchema,
      build(ADVISOR_SIGNAL_KIND, ADVISOR_SEVERITY_METADATA_KEY, severity),
    );
  };

  test('every rung the frame photographs classifies as an advisor card', () => {
    for (const severity of ADVISOR_SEVERITIES) {
      // The id is the frame's own and carries no `programmatic:` prefix, so the
      // event stamp in the metadata is the only thing between an advisor card
      // and the owner's bubble — and the severity has to survive the trip, or
      // the ladder photographs as three copies of one rung.
      expect(classifyProgrammaticTurn(fixtureMetadata(severity), `adv-${severity}`))
        .toEqual({ kind: 'advisor', severity });
    }
  });

  test('the key the fixture used to stamp is not a card at all', () => {
    // Why the drift was invisible for as long as it was: an unread event key is
    // not a wrong card, it is NO card, and no card is the owner's own bubble.
    // The key is assembled from parts: the pre-rename spelling survives as a
    // regression case without surviving as a literal anyone can grep for.
    const retiredKey = `${['prot', 'eus'].join('')}Event`;
    expect(classifyProgrammaticTurn(
      { [retiredKey]: ADVISOR_SIGNAL_KIND, [ADVISOR_SEVERITY_METADATA_KEY]: 'blocker' },
      'adv-blocker',
    )).toBeNull();
  });
});

/* The drain text the UI parses is composed by core's buildDrainBatch — these
   cases feed real events through it so the parser cannot drift from it. */
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
    const batch = buildDrainBatch([event({
      ...EVENT_BASE,
      id: 'ev-1',
      ingress: 'subordinate',
      variant: 'subordinate_report',
      payload: { from_subordinate: 'surface-auditor', status: 'progress', task: 'Audit the CLI', content: 'Found 3 gaps', kinu_mode: 'build', sequence_id: 'u-1/a-1' },
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
      webhookEvent('a'),
      event({
        ...EVENT_BASE,
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
      ...EVENT_BASE,
      id: 'p1', ingress: 'peer_async', variant: 'peer_agent',
      payload: {
        from_agent_name: 'atlas', from_user_id: 'u1', topic: 'schema', body: 'which shape?',
        sender_event_id: 'out-1', reply_expected: true, kinu_mode: 'build',
        sequence_id: 'seq-1',
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
      ...EVENT_BASE,
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
      ...EVENT_BASE,
      id: 's1', ingress: 'subordinate', variant: 'subordinate_task' as const,
      payload: {
        from_workspace: 'atlas', kind: 'task' as const, body: 'check the CLI',
        inherited_context: 'Context line one.\nContext line two.',
        kinu_mode: 'build',
        sequence_id: 'seq-1',
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
    events.reduce<readonly SignalCard[]>((cards, event) => {
      const parsed = parseSignalCardEvent(event);
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
    expect(messageSignalId({ kinuEvent: 'event_drain', signalId: 's1' })).toBe('s1');
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
    // Still a per-turn read (the runner is cached across turns), and now the
    // canonical composition: the surface picks the thresholds, this host's
    // durability answers the wake question once for every surface.
    expect(actor).toContain('policy: () => invocationBackgroundPolicy(this.turnSurface(), true)');
    expect(actor).not.toContain('BACKGROUND_POLICY[this.turnSurface()]');
  });

  test('both unwatched populations are one-shot; only real chat is interactive', () => {
    const surface = /protected turnSurface\(\): InvocationSurface \{([\s\S]*?)\n  \}/.exec(actor);
    expect(surface).not.toBeNull();
    // A CLI one-shot invocation AND a signal-driven autonomous turn both have
    // nobody watching a stream. Continuity alone misses the whole autonomous
    // population — the population the one-shot policy was measured on — and
    // the event metadata alone misses `kinu exec` against a cloud
    // workspace. The discriminators are the ones every other decision already
    // reads; there is no third notion of "autonomous".
    expect(surface![1]).toContain('turnUserMessageEvent');
    expect(surface![1]).toContain("_turnContinuity === 'independent_task'");
    expect(surface![1]).toContain("'interactive'");
    expect(surface![1]).toContain("'one-shot'");
  });
});
