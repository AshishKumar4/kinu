import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { present, scratchDir } from '@kinu.run/test-utils';
import { C3_WORKLOAD, C3_OVERWRITE_SHA256 } from '../packages/devbox/bench/witness-files';
import { evaluateLiveC3, type LiveC3Observation } from '../packages/devbox/bench/c3-result';
import { measureLiveC3 } from './bench-devbox-fixture';
import type { PublicationWindow } from '../packages/devbox/bench/publication-meter';
import * as v from 'valibot';
import type { StartupCompletion } from '../packages/devbox/bench/observation-schema';

function startup(bootId: string, startedAt: number, kind: string): StartupCompletion {
  return {
    ms: 4, startedAt, redrives: 1,
    attach: { kind, detail: kind === 'empty' ? 'empty' : 'chain generation 67108864B base+delta absorbed into the upper' },
    state: { storePrefix: 'boxes/test/', state: { running: true, restoration: 'attached', bootId } },
  };
}

export function c3Fixture(): LiveC3Observation {
  return {
    event: 'matched.chain.C3.observations', case: 'snapshot-chain/C3', runId: 'test-run', box: 'test-box',
    identity: { commit: 'c'.repeat(40), dirtyDigest: 'clean', workerVersion: 'worker-version', image: `image@sha256:${'a'.repeat(64)}` },
    workload: C3_WORKLOAD, prefix: 'boxes/test/', preparation: { cleanup: null, destroy: null },
    initial: startup('before', 1, 'empty'), initialObservations: [],
    baselineCommand: { ok: true, exitCode: 0 }, baselineCheckpoint: { ok: true, outcome: { kind: 'committed' } },
    overwriteCommand: { ok: true, exitCode: 0 },
    rounds: [{
      round: 1, checkpoint: { ok: true, outcome: { kind: 'committed' } },
      published: { transport: { puts: 1, putUploadBytes: 65_536 } },
      accounting: {
        beforeOps: { calls: { put: 0 } }, afterOps: { calls: { put: 1 } },
        window: {
          schema: 'devbox-publication-window/1', token: 'test-run-C3-window', prefix: 'boxes/test/', openedAt: 10, closedAt: 20,
          attempts: [{ id: 'put-1', operation: 'put', key: 'boxes/test/delta.sqsh', uploadId: null, startedAt: 11, finishedAt: 12,
            bytes: 65_536, observedBytes: 65_536, outcome: 'returned', error: null, bodyError: null }],
        },
      },
    }],
    beforeDestroy: startup('before', 1, 'empty').state, destroyReceipt: { ok: true, destroyed: true },
    restoration: startup('after', 30, 'attached'), restorationObservations: [],
    restoreProbe: { kind: 'destroy-cold-restore', treeBytes: 67_108_864, wallMs: 3, probeAt: 31, outcome: 'ok' },
    file: { path: '/workspace/vol/dense.bin', reply: { ok: true, exitCode: 0 }, error: null,
      evidence: { kind: 'file', size: 67_108_864, sha256: C3_OVERWRITE_SHA256 } },
    correctness: 'passed', errors: [], cleanup: null,
  };
}

function check(record: LiveC3Observation, encoded = JSON.stringify(record)) {
  const path = join(scratchDir('c3-checker'), 'stdout.ndjson');
  writeFileSync(path, `${encoded}\n${JSON.stringify({ event: 'matched.chain.complete', case: record.case, runId: record.runId, correctness: record.correctness })}\n`);

  return Bun.spawnSync(['bun', new URL('./bench-c3-overwrite-cell.ts', import.meta.url).pathname, path]);
}

test('the C3 checker refuses an object-count increase even within the byte bound', () => {
  const record = c3Fixture();
  const round = record.rounds[0];
  const window = present(round.accounting.window, 'the publication window');

  round.published.transport = { puts: 2, putUploadBytes: 131_072 };
  round.accounting.afterOps = { calls: { put: 2 } };
  window.attempts.push({ ...window.attempts[0], id: 'put-2', startedAt: 14, finishedAt: 15 });
  expect(check(record).exitCode).toBe(1);
});

test('the C3 byte bound is strict, not inclusive', () => {
  const record = c3Fixture();
  const round = record.rounds[0];
  const attempt = present(round.accounting.window, 'the publication window').attempts[0];

  round.published.transport.putUploadBytes = 196_608;
  attempt.bytes = 196_608;
  attempt.observedBytes = 196_608;
  expect(check(record).exitCode).toBe(1);
});

const invalidC3: Array<{ name: string; change: (row: LiveC3Observation) => void }> = [
  { name: 'missing build identity', change: (row) => { row.identity = null; } },
  { name: 'unacknowledged baseline', change: (row) => { row.baselineCheckpoint = { ok: true, outcome: { kind: 'failed' } }; } },
  { name: 'uncommitted overwrite', change: (row) => { row.rounds[0].checkpoint = { ok: true, outcome: { kind: 'failed' } }; } },
  { name: 'missing publication window', change: (row) => { row.rounds[0].accounting.window = null; } },
  { name: 'missing accounting bracket', change: (row) => { row.rounds[0].accounting.afterOps = null; } },
  { name: 'missing restore probe', change: (row) => { row.restoreProbe = null; } },
  { name: 'warm boot reuse', change: (row) => {
    const restored = present(row.restoration, 'the cold restoration');

    present(restored.state.state, 'the restored box state').bootId = 'before';
  } },
  { name: 'unconfirmed destruction', change: (row) => { row.destroyReceipt = { ok: true, destroyed: false }; } },
  { name: 'refused file observer', change: (row) => { row.file = { path: '/workspace/vol/dense.bin', reply: { ok: false, error: 'pending' }, error: 'pending', evidence: null }; } },
];

for (const invalid of invalidC3) {
  test(`the C3 checker refuses ${invalid.name}`, () => {
    const row = c3Fixture();
    invalid.change(row);
    expect(check(row).exitCode).toBe(1);
  });
}

test('a complete cold C3 observation passes the checker', () => {
  expect(check(c3Fixture()).exitCode).toBe(0);
});

for (const field of ['preparation', 'cleanup', 'initialObservations', 'restorationObservations'] as const) {
  test(`the C3 checker validates the concrete ${field} receipt`, () => {
    const row = c3Fixture();
    const invalid = field.endsWith('Observations') ? '[7]' : '7';
    const encoded = JSON.stringify(row).replace(`"${field}":${JSON.stringify(row[field])}`, `"${field}":${invalid}`);
    expect(check(row, encoded).exitCode).toBe(1);
  });
}

async function driverC3Proof(publishDuringOverwrite: boolean) {
  const real = globalThis.fetch;
  const events: string[] = [];
  const installed: string[] = [];
  const Body = v.looseObject({ command: v.optional(v.string()), path: v.optional(v.string()) });
  let boot = 0;
  let probeAt = 0;
  let kind = 'empty';
  let puts = 0;
  let window: PublicationWindow | null = null;

  const publish = (): void => {
    puts++;

    if (window !== null && window.closedAt === null) window.attempts.push({
      id: `put-${puts}`, key: 'boxes/test/delta.sqsh', operation: 'put', uploadId: null,
      startedAt: Date.now(), finishedAt: Date.now(), bytes: 65_536, observedBytes: 65_536, outcome: 'returned', error: null, bodyError: null,
    });
  };

  const answer = async (input: Parameters<typeof real>[0], init?: Parameters<typeof real>[1]) => {
    const url = new URL(v.parse(v.string(), input));
    const body = v.parse(Body, JSON.parse(v.parse(v.string(), init?.body ?? '{}')));

    if (url.pathname === '/destroy') { events.push('destroy');

 return Response.json({ ok: true, destroyed: true }); }

    if (url.pathname === '/create' || url.pathname === '/wake') {
      boot++;
      kind = url.pathname === '/create' ? 'empty' : 'attached';
      probeAt = Date.now();
      events.push(kind === 'empty' ? 'create' : 'wake');

      return Response.json({ ok: true });
    }

    if (url.pathname === '/state') return Response.json({ ok: true, storePrefix: 'boxes/test/', state: {
      running: true, restoration: 'attached', bootId: `boot-${boot}`,
      lastAttach: { kind, detail: kind === 'empty' ? 'empty' : 'chain base 67108864B base+delta absorbed into the upper' },
    } });

    if (url.pathname === '/write') { installed.push(body.path ?? '');

 return Response.json({ ok: true }); }

    if (url.pathname === '/exec') {
      const command = body.command ?? '';

      if (command === 'cat /var/tmp/devbox/block-lower-stats.json') {
        events.push('block-stats');

        return Response.json({ ok: true, exitCode: 0, stdout: JSON.stringify({ generation: `chain:delta:boot-${boot}`, payloadBytes: 0, indexPages: 0, readRequests: 0 }) });
      }

      if (command.includes(' baseline /workspace')) events.push('baseline-write');

      if (command.includes(' overwrite /workspace')) {
        events.push('overwrite-write');

        if (publishDuringOverwrite) publish();
      }

      if (command.includes(' read ')) {
        events.push('file-read');

        return Response.json({ ok: true, exitCode: 0, stdout: JSON.stringify({ kind: 'file', size: 67_108_864, sha256: C3_OVERWRITE_SHA256 }) });
      }

      return Response.json({ ok: true, exitCode: 0, stdout: '' });
    }

    if (url.pathname === '/checkpoint') {
      publish();
      events.push('checkpoint');

      return Response.json({ ok: true, token: `cp-${puts}`, state: 'pending' });
    }

    if (url.pathname === '/operation') return Response.json({ ok: true, state: 'done', ms: 1, outcome: { kind: 'committed', movedBytes: 999_999 } });

    if (url.pathname === '/ops') return Response.json({ calls: { put: puts }, total: puts, classA: puts, classB: 0, classFree: 0 });

    if (url.pathname === '/publication-window/open') {
      events.push('open');
      window = { schema: 'devbox-publication-window/1', token: url.searchParams.get('token') ?? '', prefix: 'boxes/test/', openedAt: Date.now(), closedAt: null, attempts: [] };

      return Response.json({ ok: true, window });
    }

    if (url.pathname === '/publication-window/close') {
      events.push('close');

      if (window === null) throw new Error('no open window');
      window.closedAt = Date.now();

      return Response.json({ ok: true, window });
    }

    if (url.pathname === '/restore-probe') return Response.json({ ok: true, probe: { at: probeAt, wallMs: 1, phases: { containerStart: 0, attached: 1, bootId: 1 } } });

    // The ledger a startup edge always reads, attached or refused — an empty
    // one here, since the fake box files nothing.
    if (url.pathname === '/incidents') return Response.json({ ok: true, incidents: [] });

    throw new Error(`unexpected route ${url.pathname}`);
  };

  globalThis.fetch = Object.assign(answer, { preconnect: real.preconnect });

  try {
    const identity = c3Fixture().identity;

    if (identity === null) throw new Error('fixture identity is missing');

    const row = await measureLiveC3({
      fixture: { origin: 'https://bench.invalid', token: 'test', identity },
      box: 'box',
      runId: 'test-run',
      preparation: null,
    });

    return { row, events, installed };
  } finally {
    globalThis.fetch = real;
  }
}

test('the live producer brackets the isolated edit and checkpoint, then verifies cold', async () => {
  const { row, events, installed } = await driverC3Proof(false);
  expect(evaluateLiveC3(row)).toMatchObject({ admitted: true, correctness: 'passed', objectsPut: 1, bytesPut: 65_536 });
  expect(events).toEqual(['destroy', 'create', 'baseline-write', 'checkpoint', 'open', 'overwrite-write', 'checkpoint', 'close', 'destroy', 'wake', 'block-stats', 'file-read']);
  expect(row.blockReads).toMatchObject({ payloadBytes: 0, indexPages: 0 });
  expect(installed.every((path) => path.startsWith('/tmp/kinu-c3-'))).toBe(true);
  expect(row.rounds[0]?.checkpoint?.outcome?.movedBytes).toBe(999_999);
  expect(row.rounds[0]?.published.transport.putUploadBytes).toBe(65_536);
});

test('a publication during the C3 overwrite is counted and refuses the one-object claim', async () => {
  const { row } = await driverC3Proof(true);
  expect(row.rounds[0]?.accounting.window?.attempts).toHaveLength(2);
  expect(row.rounds[0]?.published.transport).toEqual({ puts: 2, putUploadBytes: 131_072 });
  const verdict = evaluateLiveC3(row);
  expect(verdict).toMatchObject({ admitted: false, correctness: 'passed', objectsPut: 2, bytesPut: 131_072 });
  expect(verdict.errors).toContain('C3 must publish exactly 1 object attempt');
});
