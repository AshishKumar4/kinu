import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';

import {
  decodeRestoreProbeRows,
  parseOptions,
  readArmArtifact,
  readRestoreProbe,
  writeArmArtifact,
} from './bench-devbox-strategies';
import type { Fixture, RestoreProbeRow } from './bench-devbox-strategies';

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
  ): Promise<Response> => answer(String(input));
  globalThis.fetch = Object.assign(stub, { preconnect: real.preconnect });
  return () => {
    globalThis.fetch = real;
  };
}

describe('the restore poll', () => {
  test('a present probe parses to its wall time', async () => {
    const restore = stubFetch(() => new Response(JSON.stringify({
      ok: true, strategy: 'snapshot-chain', box: 'ab-snapshot-chain-probe',
      probe: { wallMs: 2347, at: 1_786_000_000_000 }, ms: 4,
    })));
    try {
      const row = await readRestoreProbe(PROBE_FIXTURE, 'ab-snapshot-chain-probe', 'post-ladder-wake', 4_259_840, []);
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
      const row = await readRestoreProbe(PROBE_FIXTURE, 'ab-snapshot-chain-probe', 'cold-attach', 0, []);
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
      const row = await readRestoreProbe(PROBE_FIXTURE, 'ab-snapshot-chain-probe', 'cold-attach', 0, notes);
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

  test('an absent probe is an absent row, not a zero', async () => {
    const restore = stubFetch(() => new Response(JSON.stringify({
      ok: false, strategy: 'snapshot-chain', box: 'ab-snapshot-chain-probe', ms: 3,
    })));
    const notes: string[] = [];
    try {
      const row = await readRestoreProbe(PROBE_FIXTURE, 'ab-snapshot-chain-probe', 'cold-attach', 0, notes);
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
      const row = await readRestoreProbe(PROBE_FIXTURE, 'ab-snapshot-chain-probe', 'complexity-restore', 65_536, notes);
      expect(row.wallMs).toBeNull();
      expect(row.outcome).toContain('error:');
      expect(notes).toHaveLength(1);
    } finally {
      globalThis.fetch = real;
    }
  });

  test('old artifacts without the field read as unmeasured', () => {
    expect(decodeRestoreProbeRows(undefined)).toEqual([]);
    // BYTES, because bytes are what the driver decodes: a hand-edited file
    // can hold a row no typed literal can spell, and the decoder must drop
    // that row rather than trust it.
    const mixed = JSON.parse(
      '[{"kind":"post-ladder-wake","treeBytes":100,"wallMs":200,"probeAt":300,"outcome":"ok"},'
      + '{"kind":"post-ladder-wake","treeBytes":"huge","wallMs":null,"probeAt":null,"outcome":"ok"}]',
    );
    expect(decodeRestoreProbeRows(mixed)).toEqual([
      { kind: 'post-ladder-wake', treeBytes: 100, wallMs: 200, probeAt: 300, outcome: 'ok' },
    ]);
  });

  test('polled rows survive the durable arm artifact', () => {
    const rows: RestoreProbeRow[] = [
      { kind: 'cold-attach', treeBytes: 0, wallMs: 2347, probeAt: 1_786_000_000_000, outcome: 'ok' },
      { kind: 'post-ladder-wake', treeBytes: 4_259_840, wallMs: null, probeAt: null, outcome: 'absent: the box wrote no probe row for its last start' },
      {
        kind: 'post-ladder-wake', treeBytes: 4_259_840, wallMs: 4542, probeAt: 1_786_000_004_000, outcome: 'ok',
        phases: { containerStart: 900, storeMount: 2100, baseAttach: 3300, attached: 4100, bootId: 4500 },
      },
    ];
    const root = mkdtempSync(`${tmpdir()}/kinu-restore-probe-`);
    try {
      writeArmArtifact(root, 'probe-artifact', 'snapshot-chain', { restoreProbes: rows });
      const read = readArmArtifact(root, 'probe-artifact', 'snapshot-chain');
      expect(read.error).toBeNull();
      expect(decodeRestoreProbeRows(read.artifact?.row.restoreProbes)).toEqual(rows);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── the unarmed decisive launch ─────────────────────────────────────────────
//
// G3 judges a publication the rendezvous holds, and the rendezvous is armed
// only at Worker boot by --fault-cuts. Every decisive run on record before
// 2026-09-10 launched unarmed and learned it at judgment time, after the paid
// ladder. The refusal moves to argv parse, before anything is provisioned.

describe('an unarmed decisive launch', () => {
  test('refuses at parse time and names G3 and the flag', () => {
    expect(() => parseOptions(['--decisive'])).toThrow(/G3/);
    expect(() => parseOptions(['--decisive'])).toThrow(/--fault-cuts/);
  });

  test('an armed decisive parse succeeds, and the flag stays optional elsewhere', () => {
    expect(parseOptions(['--decisive', '--fault-cuts']).decisive).toBe(true);
    expect(parseOptions([]).faultCuts).toBe(false);
    expect(parseOptions(['--verify-only']).decisive).toBe(false);
    // Verify-only wins over decisive, so the combination is a probe and
    // measures no gate: no refusal.
    expect(parseOptions(['--decisive', '--verify-only']).decisive).toBe(false);
  });
});
