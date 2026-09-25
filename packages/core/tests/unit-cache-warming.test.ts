/** The prompt-cache warm, asserted through the lane a backend calls. The vendor's numbers are literals on
 *  purpose (docs/research/harness/anthropic-sources.md §2), so changing one in the source fails here. */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  CacheWarmStore, CacheWarmingLane, initCacheWarmTable, warmUsage,
  type CacheWarmSeams, type JsonObject, type ModelCallReport, type ModelSpec, type Usage,
} from '../src/index';
import { KinuError } from '../src/obs/index';
import { testActorHandle } from '@kinu.run/test-utils';
import { makeSql, makeExecRaw } from './helpers';

const ANTHROPIC: ModelSpec = { provider: 'anthropic', modelId: 'claude-opus-4-7' };

const SENT_AT = 1_700_000_000_000;

/** Five minutes minus the fifteen-second lead, from the REQUEST's send instant. */
const DUE_AT = SENT_AT + 5 * 60_000 - 15_000;

const REFRESH_LIMIT = 3;

interface LaneProbe {
  readonly sent: Array<{ modelSpec: ModelSpec; body: JsonObject }>;
  readonly spend: ModelCallReport[];
  readonly wakes: number[];
  clock: number;
  usage: Usage;
}

function laneProbe(): LaneProbe & { readonly lane: CacheWarmingLane } {
  const db = new Database(':memory:');
  initCacheWarmTable(makeExecRaw(db));
  const sql = makeSql(db);
  const store = new CacheWarmStore(sql, testActorHandle(sql));

  const probe: LaneProbe = {
    sent: [], spend: [], wakes: [],
    clock: SENT_AT + 1_000,
    usage: { input: 40_004, cacheRead: 40_000, cacheWrite: 0, output: 0 },
  };

  const seams: CacheWarmSeams = {
    store,
    wake: (at) => { probe.wakes.push(at); },
    send: async ({ modelSpec, body }) => {
      probe.sent.push({ modelSpec, body });

      return { usage: probe.usage };
    },
    spend: (report) => { probe.spend.push(report); },
    now: () => probe.clock,
  };

  // One object: the seams close over `probe`, so a test that moves the clock moves this one.
  return Object.assign(probe, { lane: new CacheWarmingLane(seams) });
}

/** The turn's last request as the accumulator carries it out: body sent, send time, reported usage. */
function lastRequest(usage: Usage = { input: 40_004, cacheRead: 40_000, cacheWrite: 0 }) {
  return {
    body: {
      model: 'claude-opus-4-7', max_tokens: 64_000, stream: true,
      system: [{ type: 'text', text: 'you are', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
      output_config: { effort: 'high' },
    },
    sentAt: SENT_AT,
    usage,
  };
}

describe('what earns a warm', () => {
  test('an Anthropic Messages turn that read the cache and wrote nothing arms at TTL minus the lead', () => {
    const probe = laneProbe();

    expect(probe.lane.armAfterTurn({ modelSpec: ANTHROPIC, retention: 'short', lastRequest: lastRequest() }))
      .toBe(DUE_AT);
    expect(probe.wakes).toEqual([DUE_AT]);
    expect(probe.lane.nextWarmAt()).toBe(DUE_AT);
  });

  test('the same evidence through any other provider arms nothing', () => {
    for (const provider of ['ai-gateway', 'my-gateway', 'openrouter', 'openai-compat:claude', 'workers-ai']) {
      const probe = laneProbe();

      expect(probe.lane.armAfterTurn({
        modelSpec: { provider, modelId: 'claude-opus-4-7' }, retention: 'short', lastRequest: lastRequest(),
      })).toBeNull();
      expect(probe.lane.nextWarmAt()).toBeNull();
    }
  });

  test('only the five-minute entry is refreshed', () => {
    for (const retention of ['long', 'none'] as const) {
      const probe = laneProbe();

      expect(probe.lane.armAfterTurn({ modelSpec: ANTHROPIC, retention, lastRequest: lastRequest() })).toBeNull();
    }
  });

  test('a write means the prefix moved, and an unreported read is no evidence at all', () => {
    const wrote = laneProbe();

    expect(wrote.lane.armAfterTurn({
      modelSpec: ANTHROPIC, retention: 'short',
      lastRequest: lastRequest({ input: 40_004, cacheRead: 0, cacheWrite: 40_000 }),
    })).toBeNull();

    const cold = laneProbe();

    expect(cold.lane.armAfterTurn({
      modelSpec: ANTHROPIC, retention: 'short', lastRequest: lastRequest({ input: 100, cacheRead: 0, cacheWrite: 0 }),
    })).toBeNull();

    const silent = laneProbe();

    expect(silent.lane.armAfterTurn({
      modelSpec: ANTHROPIC, retention: 'short', lastRequest: lastRequest({ input: 100 }),
    })).toBeNull();
  });

  test('a turn that left no replayable request arms nothing', () => {
    const probe = laneProbe();

    expect(probe.lane.armAfterTurn({ modelSpec: ANTHROPIC, retention: 'short', lastRequest: undefined })).toBeNull();
    expect(probe.lane.armAfterTurn({
      modelSpec: ANTHROPIC, retention: 'short',
      lastRequest: { body: 'not a json object', sentAt: SENT_AT, usage: { cacheRead: 40_000, cacheWrite: 0 } },
    })).toBeNull();
    expect(probe.lane.nextWarmAt()).toBeNull();
  });

  test('an ineligible turn retires whatever the previous one armed', () => {
    const probe = laneProbe();
    probe.lane.armAfterTurn({ modelSpec: ANTHROPIC, retention: 'short', lastRequest: lastRequest() });
    probe.lane.armAfterTurn({ modelSpec: ANTHROPIC, retention: 'long', lastRequest: lastRequest() });

    expect(probe.lane.nextWarmAt()).toBeNull();
  });
});

describe('what a warm sends', () => {
  test('the last body verbatim, with no completion and no stream', async () => {
    const probe = laneProbe();
    probe.lane.armAfterTurn({ modelSpec: ANTHROPIC, retention: 'short', lastRequest: lastRequest() });
    probe.clock = DUE_AT;

    expect(await probe.lane.runDue(DUE_AT)).toEqual({ usage: probe.usage });
    expect(probe.sent).toHaveLength(1);
    const body = probe.sent[0]?.body ?? {};
    const original = lastRequest().body;

    expect(body.max_tokens).toBe(0);
    expect(body.stream).toBeUndefined();
    // The prefix byte for byte, including effort: the vendor keys the entry on those rendered values.
    expect(body.system).toEqual(original.system);
    expect(body.messages).toEqual(original.messages);
    expect(body.output_config).toEqual(original.output_config);
    expect(body.model).toBe(original.model);
  });

  test('its spend is its own producer, priced against the model that served it', async () => {
    const probe = laneProbe();
    probe.lane.armAfterTurn({ modelSpec: ANTHROPIC, retention: 'short', lastRequest: lastRequest() });
    probe.clock = DUE_AT;
    await probe.lane.runDue(DUE_AT);

    expect(probe.spend).toEqual([{
      source: 'warming', usage: probe.usage, spec: 'anthropic/claude-opus-4-7', modelId: 'claude-opus-4-7',
    }]);
  });

  test('a thinking budget cannot be replayed at zero output, so the chain retires', async () => {
    const probe = laneProbe();
    const request = lastRequest();
    probe.lane.armAfterTurn({
      modelSpec: ANTHROPIC, retention: 'short',
      lastRequest: { ...request, body: { ...request.body, thinking: { type: 'enabled', budget_tokens: 4_000 } } },
    });
    probe.clock = DUE_AT;

    expect(await probe.lane.runDue(DUE_AT)).toBeNull();
    expect(probe.sent).toHaveLength(0);
    expect(probe.lane.nextWarmAt()).toBeNull();
  });
});

describe('when the chain stops', () => {
  test('a warm ahead of its TTL waits, and the row still says it is owed', async () => {
    const probe = laneProbe();
    probe.lane.armAfterTurn({ modelSpec: ANTHROPIC, retention: 'short', lastRequest: lastRequest() });

    expect(await probe.lane.runDue(SENT_AT + 1_000)).toBeNull();
    expect(probe.sent).toHaveLength(0);
    expect(probe.lane.nextWarmAt()).toBe(DUE_AT);
  });

  test('a real request since the arm suppresses the warm and voids the obligation', async () => {
    const probe = laneProbe();
    probe.lane.armAfterTurn({ modelSpec: ANTHROPIC, retention: 'short', lastRequest: lastRequest() });
    probe.lane.noteRequest();

    expect(await probe.lane.runDue(DUE_AT)).toBeNull();
    expect(probe.sent).toHaveLength(0);
    // The fold asks the fire's question, so a suppressed warm stops arming instead of re-arming every tick.
    expect(probe.lane.nextWarmAt()).toBeNull();
  });

  test('three refreshes per idle stretch, then nothing', async () => {
    const probe = laneProbe();
    let at = probe.lane.armAfterTurn({ modelSpec: ANTHROPIC, retention: 'short', lastRequest: lastRequest() }) ?? 0;

    for (let fired = 0; fired < REFRESH_LIMIT; fired++) {
      probe.clock = at;

      expect(await probe.lane.runDue(at)).not.toBeNull();
      const next = probe.lane.nextWarmAt();

      if (fired < REFRESH_LIMIT - 1) {
        expect(next).toBe(at + 5 * 60_000 - 15_000);
        at = next ?? 0;
      } else expect(next).toBeNull();
    }

    expect(probe.sent).toHaveLength(REFRESH_LIMIT);
  });

  test('the warms keep the entry alive until a TTL past the last one, and no longer once a real request voids them', async () => {
    const probe = laneProbe();
    expect(probe.lane.keptAliveUntil(SENT_AT)).toBeNull();

    let at = probe.lane.armAfterTurn({ modelSpec: ANTHROPIC, retention: 'short', lastRequest: lastRequest() }) ?? 0;
    // Owed a warm: alive until that warm's due time plus the lead, which is the request's own five minutes.
    expect(probe.lane.keptAliveUntil(SENT_AT)).toBe(SENT_AT + 5 * 60_000);

    for (let fired = 0; fired < REFRESH_LIMIT; fired++) {
      probe.clock = at;
      await probe.lane.runDue(at);
      at = probe.lane.nextWarmAt() ?? 0;
    }

    // The chain has stopped: its third warm went out at SENT_AT + 3 x 4:45, and that entry lives five minutes more.
    expect(probe.lane.keptAliveUntil(SENT_AT)).toBe(SENT_AT + 3 * (5 * 60_000 - 15_000) + 5 * 60_000);
    probe.lane.noteRequest();
    expect(probe.lane.keptAliveUntil(SENT_AT)).toBeNull();
  });

  test('a refresh that had to write the prefix ends the chain', async () => {
    const probe = laneProbe();
    const at = probe.lane.armAfterTurn({ modelSpec: ANTHROPIC, retention: 'short', lastRequest: lastRequest() }) ?? 0;
    probe.usage = { input: 40_004, cacheRead: 0, cacheWrite: 40_000 };
    probe.clock = at;

    expect(await probe.lane.runDue(at)).not.toBeNull();
    expect(probe.lane.nextWarmAt()).toBeNull();
  });

  test('a warm whose request FAILED retires the row instead of leaving a past-due wake', async () => {
    const db = new Database(':memory:');
    initCacheWarmTable(makeExecRaw(db));
    const sql = makeSql(db);
    const store = new CacheWarmStore(sql, testActorHandle(sql));
    let sends = 0;

    const lane = new CacheWarmingLane({
      store,
      wake: () => {},
      send: async () => {
        sends += 1;

        throw new KinuError('unavailable', 'the cache warm answered 401: {"type":"error"}');
      },
      spend: () => {},
      now: () => SENT_AT + 1_000,
    });

    lane.armAfterTurn({ modelSpec: ANTHROPIC, retention: 'short', lastRequest: lastRequest() });

    // The failure reaches the caller ONCE, wrapped, so the tick diagnoses it.
    await expect(lane.runDue(DUE_AT)).rejects.toThrow(KinuError);
    // A row left armed with a past due_at would fire a request every tick at a provider that just refused one.
    expect(lane.nextWarmAt()).toBeNull();
    expect(await lane.runDue(DUE_AT)).toBeNull();
    expect(sends).toBe(1);
  });

  test('a provider that cannot warm ends the chain rather than retrying forever', async () => {
    const db = new Database(':memory:');
    initCacheWarmTable(makeExecRaw(db));
    const sql = makeSql(db);
    const store = new CacheWarmStore(sql, testActorHandle(sql));
    let sends = 0;

    const lane = new CacheWarmingLane({
      store,
      wake: () => {},
      send: async () => {
        sends += 1;

        return null;
      },
      spend: () => {},
      now: () => SENT_AT + 1_000,
    });

    lane.armAfterTurn({ modelSpec: ANTHROPIC, retention: 'short', lastRequest: lastRequest() });

    expect(await lane.runDue(DUE_AT)).toBeNull();
    expect(sends).toBe(1);
    expect(lane.nextWarmAt()).toBeNull();
  });
});

describe('the warm answer', () => {
  test('reads the cache-inclusive input and keeps absence', () => {
    expect(warmUsage({ input_tokens: 4, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0, output_tokens: 0 }))
      .toEqual({ input: 40_004, cacheRead: 40_000, cacheWrite: 0, output: 0 });
    expect(warmUsage({})).toEqual({});
  });
});
