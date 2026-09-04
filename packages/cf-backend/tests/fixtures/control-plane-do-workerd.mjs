/**
 * The control plane's Durable Object, under real workerd.
 *
 * WHAT ONLY THIS CAN PROVE. `unit-control-plane.test.ts` drives the store against
 * `bun:sqlite` and `unit-control-plane-routes.test.ts` drives the HTTP boundary
 * against a fake object. Between them they cover every row, cursor and denial
 * decision — and neither can state either of the two facts below, because both
 * are facts about the platform rather than about our logic:
 *
 *   1. REFUSAL SURVIVES RPC. `requireControl` throwing is a fact about a
 *      function. That the throw reaches a caller in another isolate as a REJECTED
 *      promise, rather than as a resolved value carrying `undefined`, is a fact
 *      about workerd's `DurableObjectStub`. Against a fake, `stub.overview()` is a
 *      direct call and the distinction does not exist to get wrong.
 *   2. ROWS OUTLIVE THE OBJECT. `ctx.storage.sql` against a fake is a map in the
 *      test process. Against a Durable Object listed in `new_sqlite_classes` it is
 *      a file that outlives the isolate — and that manifest line is the only thing
 *      making it one, which is why this fixture reads the line rather than
 *      restating it.
 *
 * WHY THE CONFIG IS READ, NOT WRITTEN. Every value below that production also
 * declares is taken from `packages/cf-backend/wrangler.jsonc` at run time: the
 * compatibility date, the compatibility flags, the class and binding names, and
 * the migration tag that makes the class SQLite-backed. A fixture that spelled
 * them itself would keep passing after production changed one of them, which is
 * this repository's named failure shape — the set a gate measures must be the set
 * it governs, and the only way to keep them equal is to measure the governing
 * declaration.
 *
 * STRUCTURED RESULT. The last line of stdout is one JSON object. The Bun test
 * beside this file parses it and asserts over the fields, so a failure names which
 * property broke instead of a diffed transcript.
 *
 * Run with `bun`, not `node`: it imports `scripts/jsonc.ts` so that the config
 * this asserts against is read by the same parser the deploy gates use.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, NoOpLog } from 'miniflare';
import * as v from 'valibot';
import { parseJsonc } from '../../../../scripts/jsonc';

const repoRoot = new URL('../../../../', import.meta.url).pathname;
const workerEntry = new URL('./control-plane-do-worker.ts', import.meta.url).pathname;

/* ── 1. What production declares ─────────────────────────────────────────── */

const CLASS_NAME = 'ControlPlaneDO';

/** Only the fields this fixture consumes. A narrow schema on purpose: a wider one
 *  would fail on parts of the manifest that have nothing to do with this object,
 *  and a gate that breaks for unrelated reasons gets disabled. */
const WranglerSchema = v.object({
  compatibility_date: v.pipe(v.string(), v.nonEmpty()),
  compatibility_flags: v.array(v.string()),
  durable_objects: v.object({
    bindings: v.array(v.object({ class_name: v.string(), name: v.string() })),
  }),
  migrations: v.array(v.object({
    tag: v.string(),
    new_sqlite_classes: v.optional(v.array(v.string())),
    new_classes: v.optional(v.array(v.string())),
  })),
});

const wrangler = parseJsonc(
  await Bun.file(join(repoRoot, 'packages/cf-backend/wrangler.jsonc')).text(),
  WranglerSchema,
  'packages/cf-backend/wrangler.jsonc',
);

const binding = wrangler.durable_objects.bindings.find((entry) => entry.class_name === CLASS_NAME);
assert.ok(binding, `wrangler.jsonc binds no Durable Object of class ${CLASS_NAME}`);

const sqliteMigration = wrangler.migrations
  .find((entry) => (entry.new_sqlite_classes ?? []).includes(CLASS_NAME));
assert.ok(
  sqliteMigration,
  `${CLASS_NAME} is in no migration's new_sqlite_classes, so it is not SQLite-backed and `
  + '`ctx.storage.sql` would not exist on it',
);
// The two arms are mutually exclusive in wrangler, and a class in `new_classes`
// gets key-value storage instead. Stated because the whole persistence half of
// this fixture rests on which list the class is in.
assert.ok(
  !wrangler.migrations.some((entry) => (entry.new_classes ?? []).includes(CLASS_NAME)),
  `${CLASS_NAME} appears in new_classes as well as new_sqlite_classes`,
);

/* ── 2. The bundle, and the layering it must not carry ───────────────────── */

/** `node:*` stays external because production runs with `nodejs_compat` — see the
 *  flag asserted below — so the runtime supplies these, and inlining a shim would
 *  test a module graph this Worker never has. */
const bundle = await build({
  entryPoints: [workerEntry],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  metafile: true,
  loader: { '.wasm': 'binary' },
  external: ['cloudflare:workers', 'cloudflare:sockets', 'node:*'],
});
const workerScript = bundle.outputFiles[0].text;
const graph = Object.keys(bundle.metafile.inputs);

/**
 * The layering invariant, now mechanical.
 *
 * `capability.ts` and `admin-caller.ts` both state in their headers that the
 * Durable Object needs the capability half and MUST NOT import the admin half —
 * the admin half reaches `auth/session`, and through it the browser-session store,
 * `lib/kv` and the user plane's own capability module. Bundling this fixture is
 * what caught the object importing the wrong one: `admin-caller` re-exports the
 * gate, so the violation compiled, passed every existing test, and put the whole
 * user-plane auth graph in a Durable Object's isolate.
 *
 * Asserted here because this is the only place in the repository that has the
 * object's real module graph in hand. Two headers agreeing was not enough.
 */
const FORBIDDEN_IN_DO_GRAPH = [
  'src/control-plane/admin-caller.ts',
  'src/auth/session.ts',
  'src/auth/store.ts',
  'src/lib/kv.ts',
  'src/user/workspace-capability.ts',
];
const leaked = FORBIDDEN_IN_DO_GRAPH.filter(
  (suffix) => graph.some((input) => input.endsWith(suffix)),
);
assert.deepEqual(
  leaked, [],
  `the ControlPlaneDO module graph reaches the admin/user-plane half: ${leaked.join(', ')}. `
  + 'Take the gate from ./capability, not ./admin-caller.',
);

/* ── 3. The runtime, shaped the way production declares ──────────────────── */

const SECRET = 'control-plane-workerd-fixture-root-secret';
const persistencePath = mkdtempSync(join(tmpdir(), 'kinu-control-plane-'));

/**
 * Everything the DURABLE OBJECT'S OWN ISOLATE wrote to `console`.
 *
 * Collected rather than let through to stdout, for two reasons. The structured
 * result has to be the only thing on stdout so the test can parse it; and these
 * lines are themselves evidence for a claim nothing else checks. `install.ts`
 * states that a Durable Object is a different isolate from the Worker that routes
 * to it, so the sink installed at the Worker's `fetch` is NOT installed inside the
 * object — which is why the object's constructor installs its own. Whether that
 * line ran, in the object, is only observable from the object's own output.
 */
const isolateDiagnostics = [];

/**
 * One runtime, configured from the manifest read above.
 *
 * `resourcePersistencePath` is the whole persistence half: the same path across
 * two `Miniflare` instances is the same SQLite file, so disposing the first and
 * booting the second destroys the object's isolate and re-activates it from disk.
 * That is a strictly harder restart than an eviction — the process is gone, not
 * just the object — and it is the one this repository can drive deterministically.
 */
const runtime = () => new Miniflare({
  log: new NoOpLog(),
  handleStructuredLogs: ({ message }) => { isolateDiagnostics.push(message); },
  resourcePersistencePath: persistencePath,
  workers: [{
    config: {
      name: 'control-plane',
      type: 'worker',
      compatibilityDate: wrangler.compatibility_date,
      compatibilityFlags: wrangler.compatibility_flags,
      manifest: {
        mainModule: 'index.mjs',
        modulesRoot: '/',
        modules: { 'index.mjs': { type: 'esm', contents: workerScript } },
      },
      // `storage: 'sqlite'` IS `new_sqlite_classes` — the assertion above is what
      // ties this line to the manifest rather than to a preference.
      exports: { [CLASS_NAME]: { type: 'durable-object', storage: 'sqlite' } },
      env: {
        [binding.name]: {
          type: 'durable-object', worker: 'control-plane', exportName: CLASS_NAME,
        },
        CREDENTIAL_ENCRYPTION_KEY: { type: 'text', value: SECRET },
        // Production binds the operations dataset, and the object's constructor
        // installs the analytics sink that writes to it. Bound so the constructor
        // takes the path it takes in production instead of the absent-binding one.
        CONTROL_PLANE_OPS: { type: 'analytics-engine-dataset', name: 'kinu_control_plane_ops' },
      },
    },
  }],
});

/** Drive a step list through the Worker and get the settlements back. */
async function settle(miniflare, steps) {
  const response = await miniflare.dispatchFetch('https://control-plane.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(steps),
  });
  const body = await response.text();
  assert.equal(response.status, 200, `fixture worker answered ${response.status}: ${body}`);
  return JSON.parse(body);
}

/* ── 4. The refusals ─────────────────────────────────────────────────────── */

const AT = 1_770_000_000_000;
const USER = { userId: 'user-alpha', email: 'alpha@example.test', displayName: 'Alpha', at: AT };
const WORKSPACE = {
  userId: 'user-alpha', name: 'research', displayName: 'Research', createdAt: AT - 1000, at: AT,
};
const AUDIT = {
  actorEmail: 'operator@example.test', actorUserId: 'user-operator',
  operation: 'workspace.remove', targetKind: 'workspace', target: 'user-alpha/research',
  outcome: 'ok', detail: 'affected=1',
  actorDigest: 'deadbeefdeadbeefdeadbeefdeadbeef',
};

/**
 * An attempt whose outcome is written by a DIFFERENT PROCESS.
 *
 * The two-phase audit write exists so a mutation cannot run unrecorded: the
 * intent lands before the action and the outcome lands after. This row is
 * appended by the first runtime and never settled by it, which is exactly the
 * shape a Durable Object eviction between the two phases produces. The second
 * runtime has to find it still pending and be able to finish it.
 */
const INTENT = {
  actorEmail: 'operator@example.test', actorUserId: 'user-operator',
  operation: 'job.cancel', targetKind: 'job', target: 'user-alpha/research/job-7',
  outcome: 'pending', detail: 'in flight: the outcome has not been recorded',
  actorDigest: 'deadbeefdeadbeefdeadbeefdeadbeef',
};

/**
 * Every refusal this boundary has to make, and why each one is here.
 *
 * The first four are `overview`, an ADMIN read, reached with a caller that holds
 * no admin grade. The fifth is the attenuation itself: a caller holding the real
 * INGEST token — the grade the feedback endpoint and the registration feed hold,
 * reachable by any signed-in user — asking an admin question. If that one ever
 * resolves, the grade column is a comment.
 *
 * The sixth is the opposite direction and is the reason the set is not just
 * denials: an ingest-graded caller writing an ingest-graded row MUST resolve, so
 * a gate that refused everything cannot pass this suite either.
 */
const REFUSALS = [
  { label: 'no caller at all', step: { method: 'overview', caller: 'absent' } },
  { label: 'caller of a foreign shape', step: { method: 'overview', caller: 'foreign' } },
  { label: 'empty token', step: { method: 'overview', caller: 'empty' } },
  { label: 'forged token of the right shape', step: { method: 'overview', caller: 'forged' } },
  { label: 'real ingest token on an admin read', step: { method: 'overview', caller: 'ingest' } },
  {
    label: 'real ingest token on an admin write',
    step: { method: 'recordAudit', caller: 'ingest', entry: AUDIT },
  },
];

const first = runtime();
const findings = { platform: {}, refusals: [], writes: {}, persistence: {} };

/** The ids and the clock the OBJECT minted, carried across the process boundary
 *  by this driver rather than chosen by it. `AuditDraft` has no `id` and no `at`
 *  — the store owns both — so the only way the second runtime can name a row the
 *  first one wrote is to be told what came back. */
let auditId = '';
let intentId = '';
let intentAt = 0;

try {
  const denials = await settle(first, REFUSALS.map((entry) => entry.step));
  assert.equal(denials.length, REFUSALS.length);

  REFUSALS.forEach((entry, index) => {
    const outcome = denials[index];
    // THE assertion. `settled === 'rejected'` is what fails when `requireControl`
    // returns a grade instead of throwing: the call resolves, `overview` hands
    // back a real fleet summary, and a caller holding nothing reads it.
    assert.equal(
      outcome.settled, 'rejected',
      `${entry.label}: the call SETTLED as ${outcome.settled}. `
      + `A caller with no adequate capability received ${JSON.stringify(outcome.value)}.`,
    );
    assert.ok(
      outcome.isError,
      `${entry.label}: the rejection value is not an Error (${outcome.name})`,
    );
    // The gate's own wording, so a rejection from anywhere else in the stack —
    // a missing method, a serialization failure, a thrown schema issue — cannot
    // be mistaken for a refusal.
    assert.match(
      outcome.message, /ControlDeniedError/,
      `${entry.label}: rejected, but not by the capability gate: ${outcome.message}`,
    );
    assert.match(
      outcome.message, /requires the control plane's admin capability/,
      `${entry.label}: the refusal does not name the required grade: ${outcome.message}`,
    );
    findings.refusals.push({
      label: entry.label,
      settled: outcome.settled,
      name: outcome.name,
      constructorName: outcome.constructorName,
      message: outcome.message,
    });
  });

  // What the platform did to the error class, measured rather than assumed. The
  // gate's own header says the error "crosses the Worker→DO RPC boundary as its
  // message", and this is where that claim is checked: the subclass does not
  // survive, and the name survives only because workerd prefixes it into the
  // message. Recorded in the result so the test can pin it.
  const sample = denials[3];
  findings.platform.rejectionName = sample.name;
  findings.platform.rejectionConstructor = sample.constructorName;
  findings.platform.classSurvivesRpc = sample.name === 'ControlDeniedError';
  findings.platform.nameCarriedInMessage = sample.message.startsWith('ControlDeniedError:');

  /* ── 5. The writes ────────────────────────────────────────────────────── */

  const written = await settle(first, [
    { method: 'observeUser', caller: 'ingest', observation: USER },
    { method: 'observeWorkspace', caller: 'ingest', observation: WORKSPACE },
    { method: 'recordAudit', caller: 'admin', entry: AUDIT },
    // Appended and deliberately NOT settled by this process.
    { method: 'recordAudit', caller: 'admin', entry: INTENT },
    { method: 'overview', caller: 'admin' },
  ]);
  written.forEach((outcome, index) => {
    assert.equal(
      outcome.settled, 'resolved',
      `authorized step ${index} was refused: ${outcome.message}`,
    );
  });

  const auditRow = written[2].value;
  auditId = auditRow.id;
  assert.match(
    auditId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    `the object did not mint a row id: ${JSON.stringify(auditId)}`,
  );
  assert.equal(auditRow.operation, 'workspace.remove');
  assert.equal(auditRow.outcome, 'ok');

  const intentRow = written[3].value;
  intentId = intentRow.id;
  intentAt = intentRow.at;
  assert.notEqual(intentId, auditId, 'two appends were given one id');
  assert.equal(
    intentRow.outcome, 'pending',
    'the intent row settled itself; a pending append must stay pending until a settlement',
  );

  const overview = written[4].value;
  assert.equal(overview.users, 1, 'the ingest-graded user observation did not land');
  assert.equal(overview.workspaces, 1, 'the ingest-graded workspace observation did not land');
  assert.equal(overview.auditEntries, 2, 'the admin-graded audit appends did not land');
  findings.writes = {
    users: overview.users,
    workspaces: overview.workspaces,
    auditEntries: overview.auditEntries,
    auditId: auditRow.id,
  };
} finally {
  await first.dispose();
}

/* ── 6. Survival ─────────────────────────────────────────────────────────── */

// The runtime that wrote those rows is gone: its isolate, its object and its
// process. A second runtime on the same persistence path re-activates the object
// from disk, which runs the constructor — and therefore `initControlPlaneSchema`
// — against tables that already exist.
const second = runtime();
try {
  const survived = await settle(second, [
    { method: 'overview', caller: 'admin' },
    { method: 'listUsers', caller: 'admin' },
    { method: 'listWorkspaces', caller: 'admin' },
    { method: 'listAudit', caller: 'admin' },
    // The attempt the first process never finished. It has to be findable here,
    // because that is the whole reason it is written before the mutation runs.
    { method: 'listPendingAudit', caller: 'admin' },
    {
      method: 'settleAudit', caller: 'admin',
      settlement: {
        id: intentId, outcome: 'ok', detail: 'cancelled job-7',
        actorDigest: INTENT.actorDigest, reason: 'ok',
      },
    },
    { method: 'listPendingAudit', caller: 'admin' },
    // A settlement of an already-settled row is refused rather than allowed to
    // rewrite it: a replayed finish must not become a way to edit history.
    {
      method: 'settleAudit', caller: 'admin',
      settlement: { id: intentId, outcome: 'failed', detail: 'rewritten', reason: 'threw' },
    },
    // The refusal has to survive a restart too: the gate derives its tokens in
    // module scope, so a re-activated isolate deriving them again is the path a
    // long-lived deployment actually takes.
    { method: 'overview', caller: 'forged' },
  ]);

  const [
    overview, users, workspaces, audit,
    pendingBefore, settled, pendingAfter, replayed, refusedAfterRestart,
  ] = survived;
  assert.equal(overview.settled, 'resolved', `overview after restart: ${overview.message}`);
  assert.equal(
    overview.value.users, 1,
    'the index did not survive the restart: user rows are gone, so storage was not durable',
  );
  assert.equal(
    overview.value.auditEntries, 2,
    'the audit log did not survive the restart: an audit log that a process restart '
    + 'empties is not an audit log',
  );

  assert.equal(users.value.items.length, 1);
  assert.equal(users.value.items[0].userId, USER.userId);
  assert.equal(users.value.items[0].email, USER.email);
  // Counted per row by the read rather than stored, so this also proves the
  // workspace row and the user row came back as one joined fact.
  assert.equal(users.value.items[0].workspaces, 1);

  assert.equal(workspaces.value.items.length, 1);
  assert.equal(workspaces.value.items[0].name, WORKSPACE.name);
  assert.equal(workspaces.value.items[0].removedAt, null);

  const settledRow = audit.value.items.find((row) => row.id === auditId);
  assert.ok(settledRow, 'the settled audit row did not come back');
  assert.equal(settledRow.actorEmail, AUDIT.actorEmail);
  assert.equal(
    settledRow.target, AUDIT.target,
    'the audit row came back without the address it exists to record',
  );

  assert.equal(pendingBefore.settled, 'resolved', `listPendingAudit: ${pendingBefore.message}`);
  assert.equal(
    pendingBefore.value.length, 1,
    'the unsettled attempt did not survive the process that wrote it, so an action taken '
    + 'across an eviction would leave no evidence at all',
  );
  assert.equal(pendingBefore.value[0].id, intentId);
  assert.equal(pendingBefore.value[0].target, INTENT.target);

  assert.equal(settled.settled, 'resolved', `settleAudit: ${settled.message}`);
  assert.equal(settled.value.outcome, 'ok');
  assert.equal(settled.value.detail, 'cancelled job-7');
  // The attempt's own columns are untouched by the settlement.
  assert.equal(settled.value.at, intentAt);
  assert.equal(settled.value.actorEmail, INTENT.actorEmail);
  assert.equal(settled.value.target, INTENT.target);
  assert.equal(pendingAfter.value.length, 0, 'a settled attempt is still listed as pending');
  assert.equal(
    replayed.settled, 'rejected',
    'an already-settled audit row was settled a SECOND time, which is a way to edit history',
  );

  assert.equal(
    refusedAfterRestart.settled, 'rejected',
    'a forged caller was ACCEPTED by the re-activated object',
  );

  findings.persistence = {
    users: overview.value.users,
    workspaces: overview.value.workspaces,
    auditEntries: overview.value.auditEntries,
    auditId: settledRow.id,
    actorEmail: settledRow.actorEmail,
    refusedAfterRestart: refusedAfterRestart.settled === 'rejected',
    pendingSurvived: pendingBefore.value.length,
    settledAfterRestart: settled.value.outcome,
    pendingAfterSettlement: pendingAfter.value.length,
    resettleRefused: replayed.settled === 'rejected',
  };
} finally {
  await second.dispose();
  rmSync(persistencePath, { recursive: true, force: true });
}

/* ── 7. What the object's own isolate reported ───────────────────────────── */

// `installAnalyticsDiagnostics` is called by the CONSTRUCTOR, and its own header
// explains why: the Worker's sink does not exist in here. That line running, in
// the object, with the operations dataset in reach, is only observable from the
// object's output — and if it stops running the audit markers go to Workers Logs
// and the operations dataset stays empty, which is a green test and no data.
const installed = isolateDiagnostics
  .filter((line) => line.includes('"analytics.sink_installed"'));
assert.ok(
  installed.length > 0,
  'the Durable Object never installed the analytics sink in its own isolate',
);
assert.ok(
  installed.every((line) => line.includes('"controlPlaneOps":true')),
  `the sink installed without the operations dataset in reach: ${installed.join(' | ')}`,
);

// A marker per SETTLED attempt, and none for a pending one. Three audit writes
// happened across the two runtimes — one terminal append, one pending append,
// one settlement — and the pending append is an intent rather than an outcome,
// so it must not produce an ops row of its own. Two markers for three writes IS
// the property: one attempt, one marker, whichever way it goes.
const recorded = isolateDiagnostics
  .filter((line) => line.includes('"control_plane.operation_recorded"'));
assert.equal(
  recorded.length, 2,
  `expected one marker per settled attempt, got ${recorded.length}`,
);
assert.ok(
  recorded.every((line) => line.includes(`"actor":"${AUDIT.actorDigest}"`)),
  `a marker was published without the actor digest: ${recorded.join(' | ')}`,
);
assert.ok(
  !recorded.some((line) => line.includes('"outcome":"pending"')),
  'a pending intent produced an operations row; only a settled attempt may',
);
// The reason slot is a CLOSED classification, never the row's detail. The detail
// of a thrown failure is a rendered cause chain, and the sink's own rule is that
// a cause chain never reaches a dataset this deployment does not age out.
assert.ok(
  recorded.some((line) => line.includes('"reason":"ok"')),
  `the settlement published no closed reason: ${recorded.join(' | ')}`,
);
assert.ok(
  !recorded.some((line) => line.includes('cancelled job-7') || line.includes('affected=1')),
  `an audit row's detail text reached the operations dataset: ${recorded.join(' | ')}`,
);

// The split the audit path exists to keep: the ROW carries the address, the EVENT
// carries a digest. The row was checked above; this is the other half, and it is
// checked over every line the isolate emitted rather than over the marker alone,
// because a leak anywhere on this path reaches a three-month dataset an admin UI
// renders.
const leakedAddress = isolateDiagnostics.filter((line) => line.includes(AUDIT.actorEmail));
assert.deepEqual(
  leakedAddress, [],
  `the operator's address reached the diagnostics channel: ${leakedAddress.join(' | ')}`,
);

findings.isolate = {
  sinkInstalls: installed.length,
  operationMarkers: recorded.length,
  actorPublishedAsDigest: recorded.every((line) => line.includes(`"actor":"${AUDIT.actorDigest}"`)),
  addressLeaks: leakedAddress.length,
  lines: isolateDiagnostics.length,
};

findings.platform.workerdVersion = (await import('workerd/package.json', { with: { type: 'json' } }))
  .default.version;
findings.platform.compatibilityDate = wrangler.compatibility_date;
findings.platform.compatibilityFlags = wrangler.compatibility_flags;
findings.platform.storage = 'sqlite';
findings.platform.migrationTag = sqliteMigration.tag;
findings.platform.bindingName = binding.name;
findings.platform.className = CLASS_NAME;
findings.platform.doGraphModules = graph.length;
findings.ok = true;

process.stdout.write(`${JSON.stringify(findings)}\n`);
