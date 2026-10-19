// A tables release as the deploy sees it. Before the upload, the plan: which tables changed (from the two genesis
// locks, never a list), what each class's repair does to each, and what refuses. After it, the walk: every account the
// roots and the builtin directory name, each one's workspaces and every object Cloudflare lists, each asked once under
// a pass this run wrote and then deleted, waiting out an edge still serving the build before; and what it found.
import { expect, test } from 'bun:test';
import { sha256Hex, type Repair, type TablesAnswer } from '@kinu.run/core';
import { censusLines, changedTables, confirmation, planLines, regenerableIn, verdictOf, walk, walkLines, type OpsBody, type Reached, type TablesTarget } from './tables-reset';

const FROM = {
  'device_joins@packages/core/src/state/user-schema.ts': ['device_id TEXT PRIMARY KEY', 'expires_at INTEGER NOT NULL'],
  'device_consent_requests@packages/core/src/safety/device-consent.ts': ['consent_id TEXT PRIMARY KEY'],
  'device_connect_tickets@packages/core/src/state/user-schema.ts': ['ticket_hash TEXT PRIMARY KEY', 'expires_at INTEGER NOT NULL', 'used_at INTEGER'],
  'driver_lease@packages/core/src/execution/driver-lease.ts': ['id TEXT PRIMARY KEY', 'pid INTEGER NOT NULL'],
  'user_profile@packages/core/src/state/user-schema.ts': ['id INTEGER PRIMARY KEY', 'email TEXT NOT NULL'],
  'workspace_overviews@packages/core/src/state/user-schema.ts': ['name TEXT PRIMARY KEY'],
  'heads@packages/core/src/heads.ts': ['id TEXT PRIMARY KEY'],
  'cp_feedback@packages/core/src/control-plane/store.ts': ['id TEXT PRIMARY KEY', 'object_key TEXT'],
  'webhook_secrets@packages/core/src/events/ingress/secrets.ts': ['secret_id TEXT PRIMARY KEY', 'created_at INTEGER NOT NULL'],
  'cp_audit@packages/core/src/control-plane/store.ts': ['id TEXT PRIMARY KEY'],
  'tails@packages/core/src/heads.ts': ['id TEXT PRIMARY KEY'],
  'head_scores@packages/core/src/heads.ts': ['SELECT * FROM heads'],
};

const TO = {
  ...FROM,
  'device_joins@packages/core/src/state/user-schema.ts': ['device_id TEXT PRIMARY KEY', 'ticket_hash TEXT UNIQUE', 'workspace TEXT', 'expires_at INTEGER NOT NULL'],
  'driver_lease@packages/core/src/execution/driver-lease.ts': ['id TEXT PRIMARY KEY', 'pid INTEGER NOT NULL', 'generation TEXT NOT NULL'],
  'device_consent_asks@packages/core/src/safety/device-consent.ts': ['consent_id TEXT PRIMARY KEY'],
  'device_connect_tickets@packages/core/src/state/user-schema.ts': ['ticket_hash TEXT PRIMARY KEY', 'expires_at INTEGER NOT NULL'],
  'workspace_overviews@packages/core/src/state/user-schema.ts': ['name TEXT PRIMARY KEY', 'overview TEXT NOT NULL'],
  'heads@packages/core/src/heads.ts': ['id TEXT PRIMARY KEY', 'seq INTEGER NOT NULL'],
  'cp_feedback@packages/core/src/control-plane/store.ts': ['id TEXT PRIMARY KEY'],
  'webhook_secrets@packages/core/src/events/ingress/secrets.ts': ['secret_id TEXT PRIMARY KEY'],
  'cp_audit@packages/core/src/control-plane/store.ts': ['id TEXT PRIMARY KEY', 'note TEXT'],
  'tails@packages/core/src/heads.ts': ['id TEXT PRIMARY KEY', 'seq INTEGER NOT NULL DEFAULT NULL'],
  'head_scores@packages/core/src/heads.ts': ['SELECT id, seq FROM heads'],
};

const { 'device_consent_requests@packages/core/src/safety/device-consent.ts': _removed, ...CANDIDATE } = TO;

const CLASSES = {
  account: ['device_joins', 'device_connect_tickets', 'user_profile', 'workspace_overviews'],
  agent: ['heads', 'tails', 'head_scores'],
  local: ['driver_lease'],
};

test('the changed tables come from the two locks: removed, reshaped, and added', () => {
  const { changed, added } = changedTables(FROM, CANDIDATE);

  expect(changed.map(({ table, change }) => `${table} ${change}`)).toEqual([
    'cp_audit reshaped', 'cp_feedback reshaped', 'device_connect_tickets reshaped', 'device_consent_requests removed', 'device_joins reshaped',
    'driver_lease reshaped', 'head_scores reshaped', 'heads reshaped', 'tails reshaped', 'webhook_secrets reshaped', 'workspace_overviews reshaped',
  ]);
  expect(added).toEqual(['device_consent_asks']);
});

const OVERVIEWS_SOURCE = `
  sql.exec(\`
    CREATE TABLE IF NOT EXISTS workspace_overviews ( /* regenerable cache, refilled by each workspace's overview push */
      name TEXT PRIMARY KEY,
      overview TEXT NOT NULL
    )\`);`;

test('the plan says what each repair does: rebuild, refill a cache, retire, leave as it is, or refuse, and why', () => {
  const { changed, added } = changedTables(FROM, CANDIDATE);

  const verdicts = changed.map((table) => verdictOf(table, {
    from: FROM, to: CANDIDATE, classes: CLASSES, regenerable: regenerableIn(table.table === 'workspace_overviews' ? OVERVIEWS_SOURCE : '', table.table),
  }));

  expect(planLines(verdicts, added)).toEqual([
    'REFUSED (the deploy stops here):',
    '  cp_audit [no class]: no class\'s init makes it, so no repair reaches it, and as the build before left it it lacks this build\'s new column(s) note',
    '  heads [agent]: its new column(s) seq have no default, so its rows cannot be kept, and its DDL does not declare it a regenerable cache',
    '  tails [agent]: its new column(s) seq have no default, so its rows cannot be kept, and its DDL does not declare it a regenerable cache',
    '  webhook_secrets [no class]: no class\'s init makes it, so no repair reaches it, and as the build before left it its old column(s) created_at refuse this build\'s rows',
    'LOSES DATA, a regenerable cache made anew empty where its rows cannot be copied, then refilled by:',
    '  workspace_overviews [account]: each workspace\'s overview push',
    'LOSES DATA, dropped where held (no build reads it):',
    '  device_consent_requests [no class]',
    'rebuilt where held, every row kept:',
    '  device_connect_tickets [account]',
    '  device_joins [account]',
    '  head_scores [agent]: a view, made again by its init',
    'left as the build before made it, which takes this build\'s writes (no class makes it):',
    '  cp_feedback [no class]',
    'CLI-local, outside this deploy:',
    '  driver_lease [local]',
    'added, made by each database\'s init: device_consent_asks',
  ]);
  expect(confirmation(verdicts)).toBe('repair tables refill workspace_overviews retire device_consent_requests');
  expect(confirmation(verdicts.filter((verdict) => verdict.does === 'rebuild'))).toBeNull();
});

const REPAIR: Repair = {
  schema: 'account', rebuilt: ['device_joins'], refilled: [], retired: ['user_peer_grants'], unchecked: [],
  tables: [{ table: 'device_joins', before: 2, after: 2 }, { table: 'user_peer_grants', before: 1, after: null }], refused: null,
};

const answer = (over: Partial<TablesAnswer>): TablesAnswer => ({ name: null, census: [], repair: null, refused: null, workspaces: [], accounts: [], agents: [], ...over });

const ACCOUNT: Reached = { className: 'UserDO', id: 'a'.repeat(64), name: 'u1', answer: answer({ census: [{ table: 'user_profile', rows: 1 }, { table: 'device_joins', rows: 2 }], repair: REPAIR }) };

const WORKSPACE: Reached = {
  className: 'OrchestratorAgent', id: 'b'.repeat(64),
  answer: answer({
    name: 'jarvis', census: [{ table: 'trial_turns', rows: 3 }], refused: 'trial_turns: NOT NULL constraint failed: trial_turns.segment_id',
    agents: [{ name: 'main', census: [{ table: 'session_messages', rows: 9 }], repair: null, refused: null }],
  }),
};

const LOST: Reached = { className: 'OrchestratorAgent', id: 'c'.repeat(64), name: 'gone', error: 'the object failed to start' };

test('a census is one sorted line per database and table, an unreachable object one line of its own', () => {
  expect(censusLines([WORKSPACE, LOST, ACCOUNT])).toEqual([
    'OrchestratorAgent\tgone\t!unreachable\tthe object failed to start',
    'OrchestratorAgent\tjarvis\ttrial_turns\t3',
    'UserDO\tu1\tdevice_joins\t2',
    'UserDO\tu1\tuser_profile\t1',
    'agent\tjarvis/main\tsession_messages\t9',
  ]);
});

test('the walk names what each repair did, fails on a refused or a row-moving database, and names a gap in its census', () => {
  const { lines, failed } = walkLines({ reached: [ACCOUNT, WORKSPACE, LOST], unnamed: ['d'.repeat(64)] });

  expect(lines).toEqual([
    '3 database(s) in 3 object(s) opened by name; 1 repaired by this walk (the rest were already at this build, or repaired by a request first)',
    '  UserDO u1: rebuilt device_joins; retired user_peer_grants',
    'REFUSED (kept as they are, refusing every call with why):',
    '  OrchestratorAgent jarvis: trial_turns: NOT NULL constraint failed: trial_turns.segment_id',
    'UNREACHED, a gap in this census (each repairs at its first request on this build):',
    '  OrchestratorAgent gone: the object failed to start',
    `1 object(s) Cloudflare lists that no root names, not opened (each repairs at its first request): ${'d'.repeat(64)}`,
  ]);
  expect(failed).toEqual(['OrchestratorAgent jarvis: trial_turns: NOT NULL constraint failed: trial_turns.segment_id']);

  const moved: Reached = { ...ACCOUNT, answer: answer({ repair: { ...REPAIR, tables: [{ table: 'device_joins', before: 2, after: 1 }] } }) };

  expect(walkLines({ reached: [moved], unnamed: [] }).failed).toEqual(['UserDO u1: device_joins 2 → 1']);
});

/** What the walk is led to from `name`: the directory names a builtin account, an account its workspace. */
function leadsOf(className: OpsBody['class'], name: string): Partial<TablesAnswer> {
  if (name === 'directory') return { accounts: ['u-builtin'] };

  return className === 'UserDO' ? { workspaces: [`${name}-ws`] } : { name };
}

/** A deployment as the walk meets it: its roots, its accounts' workspaces and directory, Cloudflare's lists, an edge
 *  that answers `stale` times as the build before (which has no `/ops`) and once with the pass not yet seen, and a
 *  workspace that starts `onBuildBefore` times on the build before. */
function deployment(stale: number, onBuildBefore = 0) {
  const admitted: string[] = [];
  const forgotten: string[] = [];
  const asked: OpsBody[] = [];
  let behind = stale;
  let unseen = 1;
  let starting = onBuildBefore;

  // `u-builtin-ws` starts on the build before while its machine has not the candidate yet, `onBuildBefore` asks long.
  const objectAnswer = (body: OpsBody) => body.names.map((name) => (name === 'u-builtin-ws' && starting-- > 0
      ? { id: sha256Hex(name), name, error: `reaching OrchestratorAgent ${name}: The RPC receiver does not implement the method "opsTables".` }
      : { id: sha256Hex(name), name, answer: answer(leadsOf(body.class, name)) }));

  const target: TablesTarget = {
    objects: async (className) => (className === 'UserDO' ? [sha256Hex('u-seen'), ...Array.from({ length: 60 }, (_, at) => at.toString(16).padStart(64, '0'))] : []),
    admit: (digest) => { admitted.push(digest); },
    forget: (digest) => { forgotten.push(digest); },
    ops: async (pass, path, body) => {
      expect(admitted).toEqual([sha256Hex(pass)]);

      if (behind-- > 0) return { status: 404, text: 'Not found', version: 'v-before' };

      if (unseen-- > 0) return { status: 401, text: 'not yet', version: 'v-candidate' };

      if (path === 'roots') return { status: 200, text: JSON.stringify({ accounts: ['directory', 'u-seen'], control: ['site'] }), version: 'v-candidate' };

      if (body !== null) asked.push(body);

      return { status: 200, text: JSON.stringify({ objects: body === null ? [] : objectAnswer(body) }), version: 'v-candidate' };
    },
    candidate: { version: 'v-candidate', propagationMs: 60_000 },
    pause: async () => {},
  };

  return { target, asked, admitted, forgotten };
}

test('the walk reaches every object by name, from the roots, and only reads Cloudflare\'s list beside them', async () => {
  const { target, asked, admitted, forgotten } = deployment(0);
  const { reached, unnamed } = await walk(target);

  // Staging rc12, 2026-10-16: an object asked by its listed id, which never recorded a name, threw as it constructed.
  expect(asked.map((body) => `${body.class} ${body.names.join(',')}`)).toEqual([
    'ControlPlaneDO site',
    'UserDO directory,u-seen',
    'UserDO u-builtin',
    'OrchestratorAgent u-seen-ws,u-builtin-ws',
  ]);
  expect(asked.every((body) => !('ids' in body))).toBe(true);
  // Listed by Cloudflare and named by no root: counted, never opened. `u-seen` was named, so it is not among them.
  expect({ reached: reached.length, unnamed: unnamed.length }).toEqual({ reached: 6, unnamed: 60 });
  expect(unnamed).not.toContain(sha256Hex('u-seen'));
  expect(forgotten).toEqual(admitted);
});

test('a batch answered by the build before is asked again until the candidate answers it', async () => {
  const { target, asked } = deployment(2);

  await walk(target);

  expect(asked.map((body) => body.names[0]).slice(0, 2)).toEqual(['site', 'directory']);
});

test('an edge that still serves the build before after the propagation bound fails the walk, and the pass is deleted', async () => {
  const { target, forgotten } = deployment(Number.POSITIVE_INFINITY);

  await expect(walk({ ...target, candidate: { version: 'v-candidate', propagationMs: 0 } })).rejects.toThrow('/ops/roots answered 404 from version v-before, not the candidate v-candidate');
  expect(forgotten).toHaveLength(1);
});

test('an object that starts on the build before is asked again until it starts on the candidate', async () => {
  const { target, asked } = deployment(0, 2);
  const { reached } = await walk(target);

  expect(asked.slice(-2).map((body) => body.names)).toEqual([['u-builtin-ws'], ['u-builtin-ws']]);
  expect(reached.find((object) => object.name === 'u-builtin-ws')?.answer?.name).toBe('u-builtin-ws');
});

test('one still on the build before past the propagation bound is a gap in the census, which fails nothing', async () => {
  const { target } = deployment(0, Number.POSITIVE_INFINITY);
  const { reached } = await walk({ ...target, candidate: { version: 'v-candidate', propagationMs: 4_000 } });
  const report = walkLines({ reached, unnamed: [] });

  expect(report.failed).toEqual([]);
  expect(report.lines.slice(-2)).toEqual([
    'UNREACHED, a gap in this census (each repairs at its first request on this build):',
    '  OrchestratorAgent u-builtin-ws: reaching OrchestratorAgent u-builtin-ws: The RPC receiver does not implement the method "opsTables".',
  ]);
});
