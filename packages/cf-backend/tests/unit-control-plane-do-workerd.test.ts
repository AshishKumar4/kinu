/**
 * `ControlPlaneDO` booted in real workerd by the adjacent fixture, which prints one JSON object asserted here.
 * `bun`, not `node`: the fixture reads `wrangler.jsonc` through `scripts/jsonc.ts`, like the deploy gates.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

const runner = new URL('./fixtures/control-plane-do-workerd.mjs', import.meta.url).pathname;

const repoRoot = new URL('../../..', import.meta.url).pathname;

/** Parsed: the fixture is a separate process, and an absent field would otherwise compare `undefined === undefined`. */
const ResultSchema = v.object({
  ok: v.literal(true),
  platform: v.object({
    rejectionName: v.string(),
    rejectionConstructor: v.string(),
    classSurvivesRpc: v.boolean(),
    nameCarriedInMessage: v.boolean(),
    workerdVersion: v.pipe(v.string(), v.nonEmpty()),
    compatibilityDate: v.pipe(v.string(), v.nonEmpty()),
    compatibilityFlags: v.array(v.string()),
    storage: v.literal('sqlite'),
    migrationTag: v.pipe(v.string(), v.nonEmpty()),
    bindingName: v.literal('ControlPlaneDO'),
    className: v.literal('ControlPlaneDO'),
    doGraphModules: v.number(),
  }),
  refusals: v.array(v.object({
    label: v.string(),
    settled: v.string(),
    name: v.string(),
    constructorName: v.string(),
    message: v.string(),
  })),
  writes: v.object({
    users: v.number(), workspaces: v.number(), auditEntries: v.number(), auditId: v.string(),
  }),
  persistence: v.object({
    users: v.number(),
    workspaces: v.number(),
    auditEntries: v.number(),
    auditId: v.string(),
    actorEmail: v.string(),
    refusedAfterRestart: v.boolean(),
    /** Unsettled attempts the second process found; writing the intent first is why this is not zero. */
    pendingSurvived: v.number(),
    settledAfterRestart: v.string(),
    pendingAfterSettlement: v.number(),
    resettleRefused: v.boolean(),
  }),
  isolate: v.object({
    sinkInstalls: v.number(),
    operationMarkers: v.number(),
    actorPublishedAsDigest: v.boolean(),
    addressLeaks: v.number(),
    lines: v.number(),
  }),
});

/** One run shared by every assertion below. */
const settled = (async () => {
  // `process.execPath`, not a bare `'bun'` resolved against the inherited PATH.
  const spawned = Bun.spawn([process.execPath, runner], {
    cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    spawned.exited,
    new Response(spawned.stdout).text(),
    new Response(spawned.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
})();

/** The parsed result, or the fixture's stderr as the failure, so tests name the real cause. */
const reported = (async () => {
  const { exitCode, stdout, stderr } = await settled;

  if (exitCode !== 0 || stdout.trim() === '') {
    throw new Error(
      `the workerd fixture exited ${exitCode} without a result.\n${stderr.trim()}`,
    );
  }

  return v.parse(ResultSchema, JSON.parse(stdout.trim()));
})();

describe('ControlPlaneDO in workerd', () => {
  test('the fixture runs clean and reports one structured result', async () => {
    const { exitCode, stdout, stderr } = await settled;
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout.trim().split('\n')).toHaveLength(1);
  });

  test('a caller without the capability is REJECTED across the RPC boundary', async () => {
    const result = await reported;

    // Absent, foreign, empty, forged, and the genuine ingest token asking an admin question.
    expect(result.refusals).toHaveLength(6);

    for (const refusal of result.refusals) {
      expect(refusal.settled, refusal.label).toBe('rejected');
      expect(refusal.message, refusal.label).toContain('ControlDeniedError');
      expect(refusal.message, refusal.label)
        .toContain("requires the control plane's admin capability");
    }

    // Under-graded arms name the grade held, distinguishing attenuation from forgery.
    const undergraded = result.refusals.filter((entry) => entry.message.includes('holds only'));
    expect(undergraded).toHaveLength(2);
    expect(undergraded.map((entry) => entry.message.split(' requires ')[0]).sort())
      .toEqual(['ControlDeniedError: audit.write', 'ControlDeniedError: overview.read']);
  });

  test('the error class does not survive RPC, so the message is the contract', async () => {
    const { platform } = await reported;

    // Pinned for `capability.ts`: RPC serialization drops the Error subclass; only workerd's message prefix survives.
    expect(platform.classSurvivesRpc).toBe(false);
    expect(platform.rejectionName).toBe('Error');
    expect(platform.rejectionConstructor).toBe('Error');
    expect(platform.nameCarriedInMessage).toBe(true);
  });

  test('the index and the audit log outlive the object', async () => {
    const result = await reported;

    expect(result.writes.users).toBe(1);
    expect(result.writes.workspaces).toBe(1);
    expect(result.writes.auditEntries).toBe(2);
    // The object mints the id: a caller cannot choose the primary key of an append-only log.
    expect(result.writes.auditId)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Read from a second workerd process on the same storage.
    expect(result.persistence.users).toBe(result.writes.users);
    expect(result.persistence.workspaces).toBe(result.writes.workspaces);
    expect(result.persistence.auditEntries).toBe(result.writes.auditEntries);
    expect(result.persistence.auditId).toBe(result.writes.auditId);
    expect(result.persistence.actorEmail).toBe('operator@example.test');
    expect(result.persistence.refusedAfterRestart).toBe(true);
    // Re-constructed: `initControlPlaneSchema` ran again against existing tables.
    expect(result.isolate.sinkInstalls).toBe(2);
  });

  test('an attempt whose outcome was never recorded survives, and can be finished', async () => {
    // The two-phase write: an intent appended before an eviction must survive into the next process.
    const { persistence } = await reported;

    expect(persistence.pendingSurvived).toBe(1);
    expect(persistence.settledAfterRestart).toBe('ok');
    expect(persistence.pendingAfterSettlement).toBe(0);
    expect(persistence.resettleRefused).toBe(true);
  });

  test('the audit marker is emitted inside the object, and carries no address', async () => {
    const { isolate } = await reported;

    // A DO is a different isolate from the routing Worker, so its constructor must install its own sink.
    // Two markers for three writes: the pending intent produces no operations row.
    expect(isolate.operationMarkers).toBe(2);
    expect(isolate.actorPublishedAsDigest).toBe(true);
    // The event carries a digest, never the address: this dataset is retained and rendered in an admin UI.
    expect(isolate.addressLeaks).toBe(0);
  });

  test('the object exercises the binding shape production declares', async () => {
    const { platform } = await reported;

    // Read from `wrangler.jsonc`: losing `nodejs_compat` or leaving `new_sqlite_classes` fails here.
    expect(platform.className).toBe('ControlPlaneDO');
    expect(platform.bindingName).toBe('ControlPlaneDO');
    expect(platform.storage).toBe('sqlite');
    expect(platform.compatibilityFlags).toContain('nodejs_compat');
    expect(platform.compatibilityDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(platform.workerdVersion).toMatch(/^1\.\d{8}\.\d+$/);
  });
});
