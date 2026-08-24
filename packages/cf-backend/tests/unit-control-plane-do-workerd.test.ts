/**
 * The control plane's Durable Object, asserted from its workerd run.
 *
 * The fixture beside this file does the driving: it bundles the real
 * `ControlPlaneDO`, boots it in real workerd through Miniflare using the shape
 * `wrangler.jsonc` declares, and writes ONE JSON object to stdout. This file
 * parses that object and asserts over its fields, so a regression names the
 * property that broke — `refusals[3].settled` rather than a diffed transcript.
 *
 * `bun`, not `node`: the fixture reads `wrangler.jsonc` through `scripts/jsonc.ts`,
 * the same parser the deploy gates use, so the config this proof runs against and
 * the config the deploy checks are read by one implementation.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

const runner = new URL('./fixtures/control-plane-do-workerd.mjs', import.meta.url).pathname;
const repoRoot = new URL('../../..', import.meta.url).pathname;

/** What the fixture reports. Parsed rather than indexed: the fixture is a separate
 *  process, so its output is outside-controlled data, and a `toBe` against an
 *  absent field reads `undefined === undefined` on the arms that expect nothing. */
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
  }),
  isolate: v.object({
    sinkInstalls: v.number(),
    operationMarkers: v.number(),
    actorPublishedAsDigest: v.boolean(),
    addressLeaks: v.number(),
    lines: v.number(),
  }),
});

/** One run, shared by every assertion below: booting workerd twice and bundling
 *  the object costs about half a second, and six spawns of it would buy nothing. */
const settled = (async () => {
  // `process.execPath` rather than `'bun'`: this test is itself running under bun,
  // so the interpreter that must drive the fixture is already identified, and a
  // bare name would resolve against whatever PATH the runner happened to inherit.
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

/**
 * The parsed result, or the fixture's own failure.
 *
 * A failing fixture writes its assertion message to stderr and nothing to stdout,
 * so the tests below would otherwise each report a JSON parse error and bury the
 * one message that says what broke. Raised here so every test names the real
 * cause.
 */
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
    // The fixture's assertions are the proof; a non-zero exit means one of them
    // failed and its message is the finding, so it is surfaced rather than reduced
    // to a boolean.
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout.trim().split('\n')).toHaveLength(1);
  }, 120_000);

  test('a caller without the capability is REJECTED across the RPC boundary', async () => {
    const result = await reported;

    // The property the whole fixture exists for. Every one of these is a real
    // reachable caller shape: absent, foreign, empty, forged, and — the
    // attenuation itself — the genuine ingest token that the feedback endpoint and
    // the registration feed hold, asking an admin question.
    expect(result.refusals).toHaveLength(6);
    for (const refusal of result.refusals) {
      expect(refusal.settled, refusal.label).toBe('rejected');
      expect(refusal.message, refusal.label).toContain('ControlDeniedError');
      expect(refusal.message, refusal.label)
        .toContain("requires the control plane's admin capability");
    }

    // The under-graded arms name the grade the caller DOES hold, which is what
    // makes an attenuation failure legible rather than indistinguishable from a
    // forgery.
    const undergraded = result.refusals.filter((entry) => entry.message.includes('holds only'));
    expect(undergraded).toHaveLength(2);
    expect(undergraded.map((entry) => entry.message.split(' requires ')[0]).sort())
      .toEqual(['ControlDeniedError: audit.write', 'ControlDeniedError: overview.read']);
  }, 120_000);

  test('the error class does not survive RPC, so the message is the contract', async () => {
    const { platform } = await reported;

    // Measured, not assumed, and pinned because `capability.ts` builds on it:
    // `ControlDeniedError` "crosses the Worker→DO RPC boundary as its message".
    // Structured serialization does not carry the subclass — the caller receives a
    // plain `Error` — and the class name survives only because workerd prefixes it
    // into the message. So any caller that discriminated on `instanceof` or on
    // `error.name` would be reading a boundary that erased the answer.
    expect(platform.classSurvivesRpc).toBe(false);
    expect(platform.rejectionName).toBe('Error');
    expect(platform.rejectionConstructor).toBe('Error');
    expect(platform.nameCarriedInMessage).toBe(true);
  }, 120_000);

  test('the index and the audit log outlive the object', async () => {
    const result = await reported;

    expect(result.writes).toEqual({
      users: 1, workspaces: 1, auditEntries: 1, auditId: 'audit-fixture-1',
    });
    // Same numbers, read from a second workerd process on the same storage. The
    // first runtime — its isolate, its object and its process — is gone.
    expect(result.persistence.users).toBe(result.writes.users);
    expect(result.persistence.workspaces).toBe(result.writes.workspaces);
    expect(result.persistence.auditEntries).toBe(result.writes.auditEntries);
    expect(result.persistence.auditId).toBe(result.writes.auditId);
    // The row keeps the address. An audit trail that cannot name who acted is not
    // one, and this is the read that proves the column came back.
    expect(result.persistence.actorEmail).toBe('operator@example.test');
    expect(result.persistence.refusedAfterRestart).toBe(true);
    // Two activations, one per runtime: the object really was re-constructed, so
    // `initControlPlaneSchema` ran a second time against tables that existed.
    expect(result.isolate.sinkInstalls).toBe(2);
  }, 120_000);

  test('the audit marker is emitted inside the object, and carries no address', async () => {
    const { isolate } = await reported;

    // A Durable Object is a different isolate from the Worker that routes to it,
    // so the sink installed at `fetch` is not installed here — the constructor
    // installs its own. If that stopped happening, every audit marker would go to
    // Workers Logs, the operations dataset would stay empty, and every test would
    // still be green.
    expect(isolate.operationMarkers).toBe(1);
    expect(isolate.actorPublishedAsDigest).toBe(true);
    // The row carries the address, the event carries a digest. Checked over every
    // line the isolate emitted, because this dataset is retained on the platform's
    // clock and rendered in an admin UI.
    expect(isolate.addressLeaks).toBe(0);
  }, 120_000);

  test('the object exercises the binding shape production declares', async () => {
    const { platform } = await reported;

    // Read from `wrangler.jsonc` by the fixture, so these assert that the manifest
    // still declares what this proof depends on rather than restating it. Losing
    // `nodejs_compat` or moving the class out of `new_sqlite_classes` fails here.
    expect(platform.className).toBe('ControlPlaneDO');
    expect(platform.bindingName).toBe('ControlPlaneDO');
    expect(platform.storage).toBe('sqlite');
    expect(platform.compatibilityFlags).toContain('nodejs_compat');
    expect(platform.compatibilityDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(platform.workerdVersion).toMatch(/^1\.\d{8}\.\d+$/);
  }, 120_000);
});
