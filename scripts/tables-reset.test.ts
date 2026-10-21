// A tables release as the deploy sees it. Before the upload, the plan: which tables changed (from the two genesis
// locks, never a list), what each class's reset does to each (drop and make anew empty, with what refers to it), and
// what refuses. After it, the walk: every account the
// roots and the builtin directory name, each one's workspaces and every object Cloudflare lists, each asked once under
// a pass this run wrote and then deleted, waiting out an edge still serving the build before; and what it found.
import { Database as SqliteDatabase } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { censusOf, initActivationTable, recordActivation, sha256Hex, type Repair, type TablesAnswer } from '@kinu.run/core';
import { makeSql, makeSqlExec } from '../packages/core/tests/helpers';
import { censusDiff, censusLines, changedTables, confirmation, derivedIn, planLines, referrersOf, verdictOf, walk, walkLines, type OpsBody, type Reached, type TablesTarget } from './tables-reset';

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
  'head_marks@packages/core/src/heads.ts': ['id TEXT PRIMARY KEY', 'head TEXT NOT NULL REFERENCES heads(id) ON DELETE CASCADE'],
  'mark_notes@packages/core/src/heads.ts': ['id TEXT PRIMARY KEY', 'mark TEXT REFERENCES head_marks(id)'],
  'head_folds@packages/core/src/heads.ts': ['actor_id TEXT PRIMARY KEY', 'through INTEGER NOT NULL'],
};

/** heads.ts as the candidate declares it: the fold over the heads' rowids says so beside its DDL. */
const HEADS_SOURCE = `
  execRaw(\`CREATE TABLE IF NOT EXISTS head_folds ( /* derived from tails: through is a rowid of its */
    actor_id TEXT PRIMARY KEY,
    through  INTEGER NOT NULL
  )\`);`;

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
  agent: ['heads', 'tails', 'head_scores', 'head_marks'],
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

test('the plan says what each reset does: drop and make anew, with what refers to it, retire, leave as it is, or refuse', () => {
  const { changed, added } = changedTables(FROM, CANDIDATE);
  const direct = changed.map((table) => verdictOf(table, { to: CANDIDATE, classes: CLASSES }));
  const verdicts = [...direct, ...referrersOf(direct, { to: CANDIDATE, classes: CLASSES, derived: derivedIn(HEADS_SOURCE) })];

  expect(planLines(verdicts, added)).toEqual([
    'REFUSED (the deploy stops here):',
    '  cp_audit [no class]: no class in scripts/schema-classes.json makes it, so no object resets it',
    '  cp_feedback [no class]: no class in scripts/schema-classes.json makes it, so no object resets it',
    '  webhook_secrets [no class]: no class in scripts/schema-classes.json makes it, so no object resets it',
    'LOSES DATA, dropped where held and made anew empty by its init:',
    '  device_connect_tickets [account]',
    '  device_joins [account]',
    '  head_scores [agent]: a view, made again by its init',
    '  heads [agent]',
    '  tails [agent]',
    '  workspace_overviews [account]',
    '  head_folds [no class]: dropped with tails, which it is derived from',
    '  head_marks [agent]: dropped with heads, which it refers to',
    '  mark_notes [no class]: dropped with head_marks, which it refers to',
    'LOSES DATA, dropped where held (no build reads it):',
    '  device_consent_requests [no class]',
    'CLI-local, outside this deploy:',
    '  driver_lease [local]',
    'added, made by each database\'s init: device_consent_asks',
  ]);
  // Production confirms every table it drops, by name, the referrers with the tables they refer to.
  expect(confirmation(verdicts)).toBe('drop tables device_connect_tickets,device_joins,head_folds,head_marks,head_scores,heads,mark_notes,tails,workspace_overviews retire device_consent_requests');
  // Undeclared, the fold would be left over rowids that are gone: the declaration is what closes the plan over it.
  expect(referrersOf(direct, { to: CANDIDATE, classes: CLASSES, derived: new Map() }).map(({ table }) => table)).not.toContain('head_folds');
  expect(confirmation(verdicts.filter((verdict) => verdict.does === 'local'))).toBeNull();
});

// Review of the consolidation (2026-10-21): a contentless FTS index keyed by a dropped table's rowids outlived it, and
// the new rows took the old rowids' tokens. No lock holds a virtual table, so its mark is what names it.
test('a virtual table derived from a dropped one is named by its mark, in the classes of the table it goes with', () => {
  const { changed } = changedTables(FROM, CANDIDATE);
  const direct = changed.map((table) => verdictOf(table, { to: CANDIDATE, classes: CLASSES }));

  const source = `
    sql.exec(\`
      CREATE VIRTUAL TABLE IF NOT EXISTS tails_fts USING fts5 ( /* derived from tails: its rowids are theirs */
        body, content = ''
      )
    \`);`;

  expect(derivedIn(source)).toEqual(new Map([['tails_fts', ['tails']]]));
  expect(referrersOf(direct, { to: CANDIDATE, classes: CLASSES, derived: derivedIn(source) }).filter(({ table }) => table === 'tails_fts'))
    .toEqual([{ table: 'tails_fts', classes: ['agent'], does: 'drop', why: 'dropped with tails, which it is derived from' }]);
});

const REPAIR: Repair = {
  schema: 'account', dropped: ['device_joins'], retired: ['user_peer_grants'], unchecked: [],
  tables: [{ table: 'device_joins', before: 2, after: 0 }, { table: 'user_peer_grants', before: 1, after: null }], refused: null,
};

const answer = (over: Partial<TablesAnswer>): TablesAnswer => ({ name: null, census: [], repair: null, refused: null, workspaces: [], accounts: [], agents: [], ...over });

const ACCOUNT: Reached = {
  className: 'UserDO', id: 'a'.repeat(64), name: 'u1',
  answer: answer({ census: [{ table: 'user_profile', rows: 1, digest: 'd1' }, { table: 'device_joins', rows: 0, digest: 'd2' }], repair: REPAIR }),
};

const WORKSPACE: Reached = {
  className: 'OrchestratorAgent', id: 'b'.repeat(64),
  answer: answer({
    name: 'jarvis', census: [{ table: 'trial_turns', rows: 3, digest: 'd3' }], refused: 'trial_turns: no such column: segment',
    agents: [{ name: 'main', census: [{ table: 'session_messages', rows: 9, digest: 'd4' }], repair: null, refused: null }],
  }),
};

const LOST: Reached = { className: 'OrchestratorAgent', id: 'c'.repeat(64), name: 'gone', error: 'the object failed to start' };

test('a census is one sorted line per database and table with its digest, an unreachable object one line of its own', () => {
  expect(censusLines([WORKSPACE, LOST, ACCOUNT])).toEqual([
    'OrchestratorAgent\tgone\t!unreachable\tthe object failed to start',
    'OrchestratorAgent\tjarvis\ttrial_turns\t3\td3',
    'UserDO\tu1\tdevice_joins\t0\td2',
    'UserDO\tu1\tuser_profile\t1\td1',
    'agent\tjarvis/main\tsession_messages\t9\td4',
  ]);
});

test('the walk names what each reset did and every table it dropped, fails on a refused database, and names a gap in its census', () => {
  const { lines, failed } = walkLines({ reached: [ACCOUNT, WORKSPACE, LOST], unnamed: ['d'.repeat(64)] });

  expect(lines).toEqual([
    '3 database(s) in 3 object(s) opened by name; 1 repaired by this walk (the rest were already at this build, or repaired by a request first)',
    '  UserDO u1: dropped device_joins; retired user_peer_grants',
    'REFUSED (kept as they are, refusing every call with why):',
    '  OrchestratorAgent jarvis: trial_turns: no such column: segment',
    'DROPPED and made anew (rows before → after, as each init seeds):',
    '  UserDO u1: device_joins 2 → 0',
    'UNREACHED, a gap in this census (each repairs at its first request on this build):',
    '  OrchestratorAgent gone: the object failed to start',
    `1 object(s) Cloudflare lists that no root names, not opened (each repairs at its first request): ${'d'.repeat(64)}`,
  ]);
  expect(failed).toEqual(['OrchestratorAgent jarvis: trial_turns: no such column: segment']);
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

// The walk's census after a tables release against one taken before the upload (deploy.sh): the reset dropped what its
// plan named and nothing else. The rehearsal of 2026-10-21 proved it on staging's 266 databases by hand; this is the
// ladder's own check, so a row-copying reset, or one that lost a table or an activation, can never pass it.
describe('census-diff', () => {
  /** A census line: a database (`<class>\t<label>`), one of its tables, its rows and digest, and its ledger if any. */
  const line = (row: { readonly database: string; readonly table: string; readonly rows: number; readonly digest: string; readonly ledger?: readonly string[] }) =>
    [row.database, row.table, String(row.rows), row.digest, ...row.ledger === undefined ? [] : [row.ledger.join(',')]].join('\t');

  const W = 'OrchestratorAgent\tw1';

  const BEFORE = [
    line({ database: W, table: 'deferred_approvals', rows: 3, digest: 'd1' }),
    line({ database: W, table: 'notes', rows: 2, digest: 'n1' }),
    line({ database: W, table: 'workspace_activations', rows: 2, digest: 'a2', ledger: ['1:aaa', '2:bbb'] }),
    line({ database: W, table: 'kinu_workspace_generation', rows: 1, digest: 'g1' }),
    line({ database: 'UserDO\tu1', table: 'user_profile', rows: 1, digest: 'p1' }),
  ].join('\n');

  // What a reset of deferred_approvals leaves: it empty, one activation more, the generation moved, all else alike.
  const AFTER = [
    line({ database: W, table: 'deferred_approvals', rows: 0, digest: 'e' }),
    line({ database: W, table: 'notes', rows: 2, digest: 'n1' }),
    line({ database: W, table: 'workspace_activations', rows: 3, digest: 'a3', ledger: ['1:aaa', '2:bbb', '3:ccc'] }),
    line({ database: W, table: 'kinu_workspace_generation', rows: 1, digest: 'g2' }),
    line({ database: 'UserDO\tu1', table: 'user_profile', rows: 1, digest: 'p1' }),
  ];

  const PLANNED = new Set(['deferred_approvals']);
  const diffed = (after: readonly string[], frozen = true, before = BEFORE) => censusDiff(before, after.join('\n'), PLANNED, frozen);

  // A planned FTS index (a virtual table, named by its mark) is made anew with the tables it keeps itself in, whose
  // rows its creation writes: those are the index's, never a change outside the plan.
  test('an FTS index the plan drops is made anew with its own tables, which are not changes outside the plan', () => {
    const M = 'MailboxDO\tm1';
    const index = (rows: readonly [string, number, string][]) => rows.map(([table, count, digest]) => line({ database: M, table, rows: count, digest }));
    const before = [...BEFORE.split('\n'), ...index([['mail_messages', 3, 'm3'], ['mail_fts', 3, 'f3'], ['mail_fts_data', 7, 'x7'], ['mail_fts_idx', 2, 'i2'], ['mail_fts_docsize', 3, 's3'], ['mail_fts_config', 1, 'c1'], ['mail_box_config', 1, 'b1']])];
    const after = [...AFTER, ...index([['mail_messages', 0, 'e'], ['mail_fts', 0, 'e'], ['mail_fts_data', 2, 'x2'], ['mail_fts_idx', 0, 'e'], ['mail_fts_config', 1, 'c1'], ['mail_box_config', 1, 'b2']])];
    const diff = censusDiff(before.join('\n'), after.join('\n'), new Set([...PLANNED, 'mail_messages', 'mail_fts']), true);

    // A table that only looks like one of an index's, in a database without the index's own, is judged as any other.
    expect(diff.failed).toEqual([`${M}\tmail_box_config\t1 → 1`]);
    expect(diff.lines.filter((said) => said.includes('made anew with'))).toEqual(
      ['data', 'idx', 'docsize', 'config'].map((suffix) => `  ${M}\tmail_fts_${suffix}\tmade anew with mail_fts`),
    );
  });

  /** AFTER with `from`'s line replaced by `to`, or dropped. */
  const swap = (from: string, to: string | null) => AFTER.flatMap((row) => {
    if (!row.includes(`\t${from}\t`)) return [row];

    return to === null ? [] : [to];
  });

  const activations = (ledger: readonly string[]) => line({ database: W, table: 'workspace_activations', rows: ledger.length, digest: ledger.join(''), ledger });

  test('passes a reset that emptied its plan\'s table, and names the first open\'s writes as such', () => {
    const passed = diffed(AFTER);

    expect(passed.failed).toEqual([]);
    expect(passed.lines).toContain('  OrchestratorAgent\tw1\tworkspace_activations\t2 → 3');
    expect(passed.lines).toContain('  OrchestratorAgent\tw1\tkinu_workspace_generation\t1 → 1');
  });

  test('refuses a planned table that kept rows, as a row-copying reset would leave it', () => {
    expect(diffed(swap('deferred_approvals', line({ database: W, table: 'deferred_approvals', rows: 3, digest: 'd1' }))).failed)
      .toEqual(['OrchestratorAgent\tw1\tdeferred_approvals\t3 → 3: a planned table kept rows']);
  });

  test('refuses a table outside the plan that is gone, the generation and the activations among them, on every target', () => {
    for (const frozen of [true, false]) {
      expect(diffed(swap('notes', null), frozen).failed).toEqual(['OrchestratorAgent\tw1\tnotes\t2 → gone: a table outside the plan is gone']);
      expect(diffed(swap('workspace_activations', null), frozen).failed).toEqual(['OrchestratorAgent\tw1\tworkspace_activations\t2 → gone: a table outside the plan is gone']);
      expect(diffed(swap('kinu_workspace_generation', null), frozen).failed).toEqual(['OrchestratorAgent\tw1\tkinu_workspace_generation\t1 → gone: a table outside the plan is gone']);
    }
  });

  test('refuses an activation removed, rewritten or added out of order, and a generation that is not one row, on every target', () => {
    for (const frozen of [true, false]) {
      expect(diffed(swap('workspace_activations', activations(['2:bbb', '3:ccc'])), frozen).failed)
        .toEqual(['OrchestratorAgent\tw1\tworkspace_activations\t2 → 2: row(s) 1 lost']);
      expect(diffed(swap('workspace_activations', activations(['1:aaa', '2:xxx', '3:ccc'])), frozen).failed)
        .toEqual(['OrchestratorAgent\tw1\tworkspace_activations\t2 → 3: row(s) 2 rewritten']);
      expect(diffed(swap('workspace_activations', activations(['1:aaa'])), frozen).failed)
        .toEqual(['OrchestratorAgent\tw1\tworkspace_activations\t2 → 1: row(s) 2 lost']);
      expect(diffed(swap('kinu_workspace_generation', line({ database: W, table: 'kinu_workspace_generation', rows: 2, digest: 'g2' })), frozen).failed)
        .toEqual(['OrchestratorAgent\tw1\tkinu_workspace_generation\t1 → 2: a workspace\'s generation is one row']);
    }
  });

  test('refuses a database either census could not read, and activations with no row-by-row proof', () => {
    const unread = `${W}\t!unreachable\tthe object failed to start`;
    const noLedger = line({ database: W, table: 'workspace_activations', rows: 3, digest: 'a3' });

    expect(diffed([...AFTER, unread], false).failed).toEqual(['OrchestratorAgent\tw1: not read after the walk, so nothing of it is proven']);
    expect(diffed(AFTER, false, `${BEFORE}\n${unread}`).failed).toEqual(['OrchestratorAgent\tw1: not read before the upload, so nothing of it is proven']);
    expect(diffed(swap('workspace_activations', noLedger), false).failed)
      .toEqual(['OrchestratorAgent\tw1\tworkspace_activations\t2 → 3: no row-by-row proof: a census on either side came from a build before the ledger']);
  });

  // The first release with census-diff takes its census before from a build that kept no ledger (rc29 and earlier).
  test('across the release into the ledger, activations are counted: one added passes as counted only, fewer fail', () => {
    const before = BEFORE.replace('\t1:aaa,2:bbb', '');
    const counted = diffed(AFTER, true, before);

    expect(counted.failed).toEqual([]);
    expect(counted.lines).toContain(`  ${W}\tworkspace_activations\t2 → 3 (counted only: the census before came from a build before the ledger)`);
    expect(diffed(swap('workspace_activations', line({ database: W, table: 'workspace_activations', rows: 1, digest: 'a1', ledger: ['2:bbb'] })), false, before).failed)
      .toEqual([`${W}\tworkspace_activations\t2 → 1: row(s) lost or rewritten`]);
    expect(diffed(swap('workspace_activations', line({ database: W, table: 'workspace_activations', rows: 4, digest: 'a4', ledger: ['1:aaa', '2:bbb', '3:ccc', '4:ddd'] })), true, before).failed)
      .toEqual([`${W}\tworkspace_activations\t2 → 4: 2 rows added, where one walk opens it once`]);
  });

  test('on a frozen target refuses any other change, and two activations where the walk opened once; on production names them', () => {
    const written = swap('user_profile', line({ database: 'UserDO\tu1', table: 'user_profile', rows: 1, digest: 'p2' }));
    const twice = swap('workspace_activations', activations(['1:aaa', '2:bbb', '3:ccc', '4:ddd']));

    expect(diffed(written).failed).toEqual(['UserDO\tu1\tuser_profile\t1 → 1']);
    expect(diffed(twice).failed).toEqual(['OrchestratorAgent\tw1\tworkspace_activations\t2 → 4: 2 rows added, where one walk opens it once']);
    // People's own starts on production, any number of them: the earlier rows are still checked one by one.
    expect({ written: diffed(written, false).failed, twice: diffed(twice, false).failed }).toEqual({ written: [], twice: [] });
    expect(diffed(written, false).lines).toContain('  UserDO\tu1\tuser_profile\t1 → 1');
  });

  // The real writer: workspace_activations keeps 256 rows, the newest replacing the oldest's slot (identity/activations.ts).
  test('reads the activation ring as its writer keeps it, through the wrap: the oldest let go, every other row kept', () => {
    const db = new SqliteDatabase(':memory:');
    const census = () => censusOf(makeSqlExec(db)).map((row) => line({ database: W, ...row })).join('\n');

    const record = (count: number, from: number) => { for (let at = 0; at < count; at += 1) recordActivation(makeSql(db), from + at, 'v'); };

    initActivationTable((ddl) => { db.exec(ddl); });
    record(255, 1000);

    const before = census();

    record(3, 2000);

    const after = census();

    expect(censusDiff(before, after, new Set(), false).failed).toEqual([]);
    expect(censusDiff(before, after, new Set(), true).failed).toEqual([`${W}\tworkspace_activations\t255 → 256: 3 rows added, where one walk opens it once`]);
    db.exec('UPDATE workspace_activations SET started_at = 1 WHERE ordinal = 100');
    expect(censusDiff(before, census(), new Set(), false).failed).toEqual([`${W}\tworkspace_activations\t255 → 256: row(s) 100 rewritten`]);
    db.exec('DELETE FROM workspace_activations WHERE ordinal = 101');
    expect(censusDiff(before, census(), new Set(), false).failed).toEqual([`${W}\tworkspace_activations\t255 → 255: row(s) 100 rewritten`]);
  });
});
