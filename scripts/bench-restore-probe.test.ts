
import { describe, expect, test } from 'bun:test';

import { readRestoreProbe, type Fixture } from './bench-devbox-fixture';
import { stopContainer } from '../packages/devbox/bench/container-stop';

// ── the restore poll ────────────────────────────────────────────────
//
// The 2026-09-09 onStart probe run reported its timing table from a lane
// report and retained no rows, so the table cannot be re-read. The driver
// now polls GET /restore-probe after every wake it settles and keeps the
// rows on the arm artifact. Three behaviors carry that guarantee: a present
// probe parses to its wall time, an absent probe is an absent row rather
// than a zero, and a dead route is a named error row rather than a failed
// arm. The stub answers BYTES, because bytes are what the driver decodes.

const PROBE_FIXTURE: Fixture = { origin: 'https://bench.invalid', token: 'bench-token' };

function stubFetch(answer: (url: string) => Response | Promise<Response>): () => void {
  const real = globalThis.fetch;

  const stub = async (
    input: Parameters<typeof globalThis.fetch>[0],
    _init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => answer(input instanceof Request ? input.url : String(input));

  globalThis.fetch = Object.assign(stub, { preconnect: real.preconnect });

  return () => {
    globalThis.fetch = real;
  };
}

describe('the restore poll', () => {
  test('a stop acknowledgement does not admit a fresh start while the old container runs', async () => {
    let running = true;
    let acknowledgeStopped: (() => void) | undefined;
    const stoppedSignal = new Promise<void>((resolve) => { acknowledgeStopped = resolve; });
    let settled = false;

    const stopping = stopContainer({
      stop: async () => {},
      running: () => running,
      wait: async () => await stoppedSignal,
    }).then(() => { settled = true; });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    running = false;
    acknowledgeStopped?.();
    await stopping;
    expect(settled).toBe(true);
  });

  test('a present probe parses to its wall time', async () => {
    const restore = stubFetch(() => new Response(JSON.stringify({
      ok: true, strategy: 'snapshot-chain', box: 'ab-snapshot-chain-probe',
      probe: { wallMs: 2347, at: 1_786_000_000_000 }, ms: 4,
    })));

    try {
      const row = await readRestoreProbe({
        fixture: PROBE_FIXTURE,
        box: 'ab-snapshot-chain-probe',
        kind: 'post-ladder-wake',
        treeBytes: 4_259_840,
        notes: [],
        notBefore: 0,
      });

      expect(row).toEqual({
        kind: 'post-ladder-wake', treeBytes: 4_259_840,
        wallMs: 2347, probeAt: 1_786_000_000_000, outcome: 'ok',
      });
    } finally {
      restore();
    }
  });

  test('a settled probe carries the phases the restore reached, absent ones absent', async () => {
    const restore = stubFetch(() => new Response(JSON.stringify({
      ok: true, strategy: 'snapshot-chain', box: 'ab-snapshot-chain-probe',
      probe: { wallMs: 4542, at: 1_786_000_000_000, phases: { containerStart: 1210, attached: 3980, bootId: 4530 } }, ms: 4,
    })));

    try {
      const row = await readRestoreProbe({
        fixture: PROBE_FIXTURE,
        box: 'ab-snapshot-chain-probe',
        kind: 'cold-attach',
        treeBytes: 0,
        notes: [],
        notBefore: 0,
      });

      expect(row.outcome).toBe('ok');
      expect(row.phases).toEqual({ containerStart: 1210, attached: 3980, bootId: 4530 });
      // A fresh box mounts no store and no base: those phases are not there,
      // and nothing reads them as zero.
      expect(row.phases).not.toHaveProperty('storeMount');
      expect(row.phases).not.toHaveProperty('baseAttach');
    } finally {
      restore();
    }
  });

  test('an attempt the platform reset is an unsettled row naming its last phase', async () => {
    const restore = stubFetch(() => new Response(JSON.stringify({
      ok: true, strategy: 'snapshot-chain', box: 'ab-snapshot-chain-probe',
      probe: { wallMs: null, at: 1_786_000_000_000, phases: { containerStart: 28_400 } }, ms: 4,
    })));

    const notes: string[] = [];

    try {
      const row = await readRestoreProbe({
        fixture: PROBE_FIXTURE,
        box: 'ab-snapshot-chain-probe',
        kind: 'cold-attach',
        treeBytes: 0,
        notes,
        notBefore: 0,
      });

      expect(row.wallMs).toBeNull();
      expect(row.probeAt).toBe(1_786_000_000_000);
      expect(row.phases).toEqual({ containerStart: 28_400 });
      expect(row.outcome).toContain('unsettled');
      expect(row.outcome).toContain('containerStart');
      expect(notes).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test('a row opened before the startup was kicked is absent, not that startup\'s timing', async () => {
    // A start that adopted the instance it held ran no restore, and the box's
    // row still names the one before it. Reported under this kind it would
    // time the wrong restore.
    const restore = stubFetch(() => new Response(JSON.stringify({
      ok: true, strategy: 'snapshot-chain', box: 'ab-snapshot-chain-probe',
      probe: { wallMs: 4542, at: 1_786_000_000_000, phases: { containerStart: 1210 } }, ms: 4,
    })));

    const notes: string[] = [];

    try {
      const row = await readRestoreProbe({
        fixture: PROBE_FIXTURE,
        box: 'ab-snapshot-chain-probe',
        kind: 'post-ladder-wake',
        treeBytes: 0,
        notes,
        notBefore: 1_786_000_000_001,
      });

      expect(row.wallMs).toBeNull();
      expect(row.probeAt).toBeNull();
      expect(row.outcome).toContain('adopted the instance it held');
      expect(notes).toEqual([expect.stringContaining('predates this startup')]);
    } finally {
      restore();
    }
  });

  test('an absent probe is an absent row, not a zero', async () => {
    const restore = stubFetch(() => new Response(JSON.stringify({
      ok: false, strategy: 'snapshot-chain', box: 'ab-snapshot-chain-probe', ms: 3,
    })));

    const notes: string[] = [];

    try {
      const row = await readRestoreProbe({
        fixture: PROBE_FIXTURE,
        box: 'ab-snapshot-chain-probe',
        kind: 'cold-attach',
        treeBytes: 0,
        notes,
        notBefore: 0,
      });

      expect(row.wallMs).toBeNull();
      expect(row.probeAt).toBeNull();
      expect(row.outcome).toContain('absent');
      expect(notes).toEqual([]);
    } finally {
      restore();
    }
  });

  test('a dead route is a named error row, never a failed arm', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => {
      throw new Error('fetch failed: connection refused');
    }, { preconnect: real.preconnect });
    const notes: string[] = [];

    try {
      const row = await readRestoreProbe({
        fixture: PROBE_FIXTURE,
        box: 'ab-snapshot-chain-probe',
        kind: 'complexity-restore',
        treeBytes: 65_536,
        notes,
        notBefore: 0,
      });

      expect(row.wallMs).toBeNull();
      expect(row.outcome).toContain('error:');
      expect(notes).toHaveLength(1);
    } finally {
      globalThis.fetch = real;
    }
  });
});

