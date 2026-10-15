// This release's lossless reshapes, as its object repairs a database the build before left at first contact: each
// table is rebuilt in the shape this build declares, keeping its rows, and every row reads back through the product
// path as it did before. The old shapes below are the statements the build before declared, verbatim but for spacing.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { readTranscriptRows, seedTranscriptEntry } from '@kinu.run/test-utils';
import { pragmaStamps, repairSchema, type TableWrites } from '../src/index';
import { sqlStorageOver } from '../src/identity/inline-primitives';
import { initWorkspaceSchema } from '../src/state/workspace-schema';
import { initPendingSendTables, PendingSendStore } from '../src/orchestrator/inbox';
import { claimFences } from '../src/orchestrator/actor-claims';
import { SessionHistory } from '../src/session/history';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import { readSearchTree } from '../src/read-models/search-tree';
import { insertSearchNode } from '../src/mcts/record-node';
import { TaskListStore } from '../src/tools/task-store';
import { HeadJournal } from '../src/heads/journal';
import { bestAggregate, loadGepaCandidates, startGepaRun } from '../src/evolution/gepa/index';
import { agentArtifactDirectory } from '../src/vfs/agent-home';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';
import { createTestActor, createTestWorkspace, makeSqlExec, type TestWorkspace } from './helpers';
import type { ActorHandle } from '../src/identity/actor-handle';

/** A workspace database as this build makes it, its main actor, and the step's view of it. */
function workspace() {
  const ws = createTestWorkspace();
  const exec = makeSqlExec(ws.db);
  const transactionSync = <A>(write: () => A): A => ws.db.transaction(write)();

  // The workspace class's own init, as its object runs it; the step reads the candidate's shapes off it.
  const init = () => {
    initWorkspaceSchema({ execRaw: ws.execRaw, sql: ws.sql, exec, transactionSync });
    initPendingSendTables(ws.execRaw);
  };

  init();
  const actor = createTestActor(ws.sql, ws.execRaw, 'w1', 'scout');
  const stamps = pragmaStamps(sqlStorageOver(ws.db));

  return { ws, actor, writes: { schema: 'workspace' as const, stamps, transactionSync, init } };
}

/** `table` as the build before declared it, holding the rows it holds now; `derived` names each column only that
 *  shape had, by the SQL that computes what the build before wrote there. */
function asBuiltBefore(db: Database, table: string, ddl: string, derived: Record<string, string> = {}): void {
  const columns = db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`).all().map(({ name }) => name);
  const extra = Object.keys(derived);

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`CREATE TABLE "${table}__now" AS SELECT * FROM "${table}"`);
  db.exec(`DROP TABLE "${table}"`);
  db.exec(ddl);
  db.exec(`INSERT INTO "${table}" (${[...columns, ...extra].join(', ')})
    SELECT ${[...columns, ...extra.map((column) => derived[column])].join(', ')} FROM "${table}__now"`);
  db.exec(`DROP TABLE "${table}__now"`);
  db.exec('PRAGMA foreign_keys = ON');
}

/** The object's first contact with a database a release left behind, over `tables`, which must each keep their rows. */
function rebuild(world: ReturnType<typeof workspace>, tables: readonly string[]) {
  const sql = sqlStorageOver(world.ws.db);

  sql.exec('PRAGMA user_version = 1');
  const writes: TableWrites = { ...world.writes, tables };
  const repair = repairSchema(sql, writes, 'reshaped-tables');

  expect({ rebuilt: repair?.rebuilt, refused: repair?.refused }).toEqual({ rebuilt: expect.arrayContaining([...tables]), refused: null });
  expect(repair?.tables.filter(({ table }) => tables.includes(table)).every(({ before, after }) => before === after)).toBe(true);
}

// A spilled payload's file is `<directory>/<sha256 hex>.json`: the build before stored that digest beside the path.
const PATH_DIGEST = (path: string) => `substr(${path}, -69, 64)`;

const SESSION_MESSAGES_BEFORE = `CREATE TABLE IF NOT EXISTS session_messages (
  actor_id TEXT NOT NULL REFERENCES workspace_actors(actor_id), message_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
  native_content_kind TEXT NOT NULL CHECK(native_content_kind IN ('string','parts')),
  origin TEXT NOT NULL CHECK(origin IN ('input','output','edit','context_transform','render')),
  request_id TEXT, output_slot INTEGER, ingress_id TEXT,
  envelope_json TEXT NOT NULL,
  sealed_at INTEGER, content_json TEXT, content_path TEXT, content_digest TEXT,
  PRIMARY KEY(actor_id,message_id), UNIQUE(actor_id,request_id,output_slot),
  FOREIGN KEY(actor_id,request_id) REFERENCES actor_requests(actor_id,request_id),
  CHECK(output_slot IS NULL OR output_slot >= 0),
  CHECK((request_id IS NULL) = (output_slot IS NULL)),
  CHECK((sealed_at IS NULL AND content_json IS NULL AND content_path IS NULL AND content_digest IS NULL)
    OR (sealed_at IS NOT NULL AND ((content_json IS NOT NULL AND content_path IS NULL AND content_digest IS NULL)
      OR (content_json IS NULL AND content_path IS NOT NULL AND content_digest IS NOT NULL)))))`;

const STREAM_PARTS_BEFORE = `CREATE TABLE IF NOT EXISTS stream_parts (
  actor_id TEXT NOT NULL, message_id TEXT NOT NULL, part_no INTEGER NOT NULL, segment INTEGER NOT NULL,
  stream_order INTEGER NOT NULL,
  descriptor_json TEXT, descriptor_path TEXT, descriptor_digest TEXT,
  text TEXT NOT NULL DEFAULT '', ended INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(actor_id,message_id,part_no,segment),
  FOREIGN KEY(actor_id,message_id) REFERENCES session_messages(actor_id,message_id),
  CHECK(part_no >= 0), CHECK(segment >= 0), CHECK(stream_order >= 0), CHECK(ended IN (0,1)),
  CHECK((segment > 0 AND descriptor_json IS NULL AND descriptor_path IS NULL AND descriptor_digest IS NULL)
    OR (segment = 0 AND ((descriptor_json IS NOT NULL AND descriptor_path IS NULL AND descriptor_digest IS NULL)
      OR (descriptor_json IS NULL AND descriptor_path IS NOT NULL AND descriptor_digest IS NOT NULL)))))`;

const ACTOR_REQUESTS_BEFORE = `CREATE TABLE IF NOT EXISTS actor_requests (
  actor_id TEXT NOT NULL REFERENCES workspace_actors(actor_id), request_id TEXT NOT NULL, turn_id TEXT NOT NULL, run_id TEXT NOT NULL,
  epoch INTEGER NOT NULL, step_index INTEGER, revision INTEGER NOT NULL,
  context_id TEXT NOT NULL, context_revision INTEGER NOT NULL,
  metadata_json TEXT, metadata_path TEXT, metadata_digest TEXT, recorded_at INTEGER NOT NULL,
  PRIMARY KEY(actor_id,request_id), UNIQUE(actor_id,turn_id,epoch,revision),
  FOREIGN KEY(actor_id,context_id,context_revision) REFERENCES context_revisions(actor_id,context_id,revision),
  CHECK((metadata_json IS NOT NULL AND metadata_path IS NULL AND metadata_digest IS NULL)
    OR (metadata_json IS NULL AND metadata_path IS NOT NULL AND metadata_digest IS NOT NULL)))`;

const CONVERSATION_ENTRIES_BEFORE = `CREATE TABLE IF NOT EXISTS conversation_entries (
  actor_id TEXT NOT NULL, session_id TEXT NOT NULL, id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  turn_id TEXT, run_id TEXT, metadata_json TEXT, metadata_path TEXT, metadata_digest TEXT,
  recorded_at INTEGER NOT NULL, context_id TEXT, context_revision INTEGER,
  PRIMARY KEY(actor_id,session_id,id),
  UNIQUE(actor_id,session_id,position),
  FOREIGN KEY(actor_id) REFERENCES workspace_actors(actor_id),
  FOREIGN KEY(actor_id,context_id,context_revision) REFERENCES context_revisions(actor_id,context_id,revision),
  CHECK((context_id IS NULL) = (context_revision IS NULL)),
  CHECK((metadata_json IS NULL AND metadata_path IS NULL AND metadata_digest IS NULL)
    OR (metadata_json IS NOT NULL AND metadata_path IS NULL AND metadata_digest IS NULL)
    OR (metadata_json IS NULL AND metadata_path IS NOT NULL AND metadata_digest IS NOT NULL)))`;

const QUEUED_TURNS_BEFORE = `CREATE TABLE IF NOT EXISTS queued_turns (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL,
  metadata_json TEXT, yields INTEGER NOT NULL DEFAULT 0,
  run_end_json TEXT, run_end_path TEXT, run_end_digest TEXT,
  UNIQUE (actor_id, id),
  CHECK((run_end_json IS NULL AND run_end_path IS NULL AND run_end_digest IS NULL)
    OR (run_end_json IS NOT NULL AND run_end_path IS NULL AND run_end_digest IS NULL)
    OR (run_end_json IS NULL AND run_end_path IS NOT NULL AND run_end_digest IS NOT NULL)))`;

// Past the inline half of a platform row, so each is spilled to a file.
const LARGE = 'a large payload '.repeat(70_000);

function historyOver(ws: TestWorkspace, actor: ActorHandle): SessionHistory {
  return new SessionHistory({
    sql: ws.sql, actor, transactionSync: (write) => ws.db.transaction(write)(),
    files: async () => ({ vfs: ws.vfs, artifactDirectory: agentArtifactDirectory(WORKSPACE_ROOT) }),
    claims: claimFences(ws.sql, actor),
  });
}

/** Every payload the five tables hold, read as the product reads it. */
async function sessionReads(ws: TestWorkspace, actor: ActorHandle) {
  const history = historyOver(ws, actor);
  const transcript = history.transcript(CHAT_SESSION_ID);
  const metadata = [];

  for (const entry of transcript.entries()) metadata.push(entry.metadata === null ? null : await transcript.payload(entry.metadata));
  const requests = [];

  for (const request of history.requests.forTurn('turn-1')) requests.push(await history.messages.payloads.read(request.metadata));
  const ends = [];

  for (const { id, end } of new PendingSendStore(ws.sql, actor.actorId).runEnds()) ends.push({ id, end: await history.messages.payloads.read(end) });

  return {
    transcript: await readTranscriptRows(ws.sql, actor, ws.vfs),
    metadata,
    open: await history.messages.openParts('m-open'),
    requests,
    ends,
  };
}

test('spilled session payloads keep their files and read back whole once their digest columns are rebuilt away', async () => {
  const world = workspace();
  const { ws, actor } = world;
  const history = historyOver(ws, actor);

  // Each table holds one payload inline and one spilled to a file.
  await seedTranscriptEntry(history, CHAT_SESSION_ID, { id: 'm-inline', origin: 'input', message: { role: 'user', content: 'short' }, metadata: { kind: 'small' } });
  await seedTranscriptEntry(history, CHAT_SESSION_ID, { id: 'm-spilled', origin: 'input', message: { role: 'user', content: LARGE }, metadata: { kind: 'large', body: LARGE } });
  const source = history.atomic(() => history.context.record('requests', [{ messageId: 'm-inline' }]));

  for (const [revision, metadata] of [{ step: 'small' }, { step: LARGE }].entries()) {
    const request = await history.requests.prepare({ id: `r-${revision}`, turnId: 'turn-1', runId: 'run-1', epoch: 0, revision, step: null, source, metadata });
    history.atomic(() => { history.requests.record(request); });
  }

  history.atomic(() => history.messages.open('assistant', 'm-open', 'output'));
  history.messages.streamOpenPart('m-open', { partNo: 0, streamOrder: 0, descriptor: await history.messages.prepareDescriptor({ type: 'text' }), text: 'streaming' });
  history.messages.streamOpenPart('m-open', { partNo: 1, streamOrder: 1, descriptor: await history.messages.prepareDescriptor({ type: 'reasoning', note: LARGE }), text: 'thinking' });
  const pending = new PendingSendStore(ws.sql, actor.actorId);

  for (const [index, end] of ['kept whole', LARGE].entries()) {
    pending.reserveTurn({ id: `held-${index}`, text: 'Run it.' });
    pending.recordRunEnd(`held-${index}`, await history.messages.payloads.prepare({ ended: end }));
  }

  const before = await sessionReads(ws, actor);

  expect(ws.sql<{ n: number }>`SELECT COUNT(*) AS n FROM session_messages WHERE content_path IS NOT NULL`[0]?.n).toBe(1);
  asBuiltBefore(ws.db, 'session_messages', SESSION_MESSAGES_BEFORE, { content_digest: PATH_DIGEST('content_path') });
  asBuiltBefore(ws.db, 'stream_parts', STREAM_PARTS_BEFORE, { descriptor_digest: PATH_DIGEST('descriptor_path') });
  asBuiltBefore(ws.db, 'actor_requests', ACTOR_REQUESTS_BEFORE, { metadata_digest: PATH_DIGEST('metadata_path') });
  asBuiltBefore(ws.db, 'conversation_entries', CONVERSATION_ENTRIES_BEFORE, { metadata_digest: PATH_DIGEST('metadata_path') });
  asBuiltBefore(ws.db, 'queued_turns', QUEUED_TURNS_BEFORE, { run_end_digest: PATH_DIGEST('run_end_path') });

  rebuild(world, ['session_messages', 'stream_parts', 'actor_requests', 'conversation_entries', 'queued_turns']);

  expect(await sessionReads(ws, actor)).toEqual(before);
  expect(before.ends.map(({ end }) => end)).toEqual([{ ended: 'kept whole' }, { ended: LARGE }]);
});

const SEARCH_NODES_BEFORE = `CREATE TABLE IF NOT EXISTS search_nodes (
  actor_id TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, root_id TEXT NOT NULL,
  task TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT '', observation TEXT NOT NULL DEFAULT '',
  visits INTEGER NOT NULL DEFAULT 0, value REAL NOT NULL DEFAULT 0, depth INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','terminal','failed','pruned')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (actor_id, id))`;

const SEARCH_NODE_SCORES_BEFORE = `CREATE VIEW IF NOT EXISTS search_node_scores AS
  SELECT n.*, CASE
    WHEN n.parent_id IS NULL THEN n.value
    WHEN r.record_json IS NOT NULL THEN json_extract(r.record_json, '$.outcome.score')
    ELSE 0 END AS own_score
  FROM search_nodes n
  LEFT JOIN swarm_node_records r ON r.actor_id = n.actor_id AND r.node_id = n.id`;

test("a search's nodes keep their task copies through the rebuild, and every node reads its root's task", () => {
  const world = workspace();
  const { ws, actor } = world;
  const task = 'Make the parser accept trailing commas.';

  ws.db.exec('DROP VIEW search_node_scores');
  asBuiltBefore(ws.db, 'search_nodes', SEARCH_NODES_BEFORE);
  ws.db.exec(SEARCH_NODE_SCORES_BEFORE);

  // As the build before wrote a search: its task copied onto every node.
  for (const [at, [id, parent, depth, value]] of ([['root', null, 0, 0.5], ['a', 'root', 1, 0.75], ['b', 'root', 1, 0.25], ['c', 'a', 2, 1]] as const).entries()) {
    void ws.sql`INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, observation, visits, value, depth, created_at)
      VALUES (${actor.actorId}, ${id}, ${parent}, 'root', ${task}, ${`output of ${id}`}, 1, ${value}, ${depth}, ${at})`;
  }

  const before = readSearchTree(ws.sql, actor, 'root');

  rebuild(world, ['search_nodes']);

  expect(readSearchTree(ws.sql, actor, 'root')).toEqual(before);
  expect(before.map((node) => [node.id, node.task])).toEqual([['root', task], ['a', task], ['b', task], ['c', task]]);

  // A node this build writes holds no copy, and reads its root's task all the same.
  insertSearchNode(ws.sql, actor, { nodeId: 'd', parentNodeId: 'c', rootId: 'root', action: '', observation: 'output of d', depth: 3 });
  void ws.sql`UPDATE search_nodes SET created_at = 4 WHERE id = 'd'`;
  expect(ws.sql<{ task: string | null }>`SELECT task FROM search_nodes WHERE id = 'd'`[0]?.task).toBeNull();
  expect(readSearchTree(ws.sql, actor, 'root').find((node) => node.id === 'd')?.task).toBe(task);
});

const AGENT_TASKS_BEFORE = `CREATE TABLE IF NOT EXISTS agent_tasks (
  actor_id TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, parent_id TEXT, title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','active','done','dropped')),
  updated_at INTEGER NOT NULL, note TEXT, plan_id TEXT, revision INTEGER, session_id TEXT,
  PRIMARY KEY (actor_id, id))`;

const HEAD_STEPS_BEFORE = `CREATE TABLE IF NOT EXISTS head_steps (
  actor_id TEXT NOT NULL, id TEXT NOT NULL, head_id TEXT NOT NULL, seq INTEGER NOT NULL,
  parts_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (actor_id, id))`;

test('tasks and head steps re-keyed by their seq keep the ids the build before wrote, and go on from them', () => {
  const world = workspace();
  const { ws, actor } = world;

  asBuiltBefore(ws.db, 'agent_tasks', AGENT_TASKS_BEFORE);
  ws.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_seq ON agent_tasks(actor_id, seq)');
  asBuiltBefore(ws.db, 'head_steps', HEAD_STEPS_BEFORE);
  ws.db.exec('CREATE INDEX IF NOT EXISTS idx_head_steps_head ON head_steps(actor_id, head_id, seq)');

  // As the build before wrote them: each id beside the seq it was made from.
  for (const [seq, parent, title, status] of [[1, null, 'Plan', 'done'], [2, null, 'Build', 'active'], [3, 't2', 'Wire the parser', 'open']] as const) {
    void ws.sql`INSERT INTO agent_tasks (actor_id, id, seq, parent_id, title, status, updated_at)
      VALUES (${actor.actorId}, ${`t${seq}`}, ${seq}, ${parent}, ${title}, ${status}, ${seq})`;
  }

  for (const seq of [0, 1, 2]) {
    void ws.sql`INSERT INTO head_steps (actor_id, id, head_id, seq, parts_json, created_at)
      VALUES (${actor.actorId}, ${`h1-s${seq}`}, 'h1', ${seq}, ${JSON.stringify([{ type: 'text', text: `step ${seq}` }])}, ${seq})`;
  }

  const tasks = new TaskListStore(ws.sql, actor, (write) => ws.db.transaction(write)());
  const journal = new HeadJournal(ws.sql, actor);
  const page = journal.readStepsPage('h1', { limit: 1 });
  const cursor = page.status === 'more' ? page.next : undefined;
  const reads = () => ({ list: tasks.list(), steps: journal.readSteps('h1'), page: journal.readStepsPage('h1', { limit: 1 }), older: journal.readStepsPage('h1', { limit: 1, cursor }) });
  const before = reads();

  rebuild(world, ['agent_tasks', 'head_steps']);

  const after = reads();

  expect(after).toEqual(before);
  expect([before.page.items, before.older.items]).toEqual([[{ parts: [{ type: 'text', text: 'step 2' }] }], [{ parts: [{ type: 'text', text: 'step 1' }] }]]);
  expect(tasks.get('t3')).toMatchObject({ parentId: 't2', title: 'Wire the parser' });
  expect(tasks.update('t3', { status: 'done' }, 4)).toMatchObject({ id: 't3', status: 'done' });
  expect(tasks.add(['Ship'], null, 5).added.map(({ id }) => id)).toEqual(['t4']);
  journal.appendStep('h1', 3, { parts: [{ type: 'text', text: 'step 3' }] });
  expect(journal.readSteps('h1').map(({ parts }) => parts)).toEqual([0, 1, 2, 3].map((seq) => [{ type: 'text', text: `step ${seq}` }]));
});

const GEPA_CANDIDATES_BEFORE = `CREATE TABLE IF NOT EXISTS gepa_candidates (
  actor_id TEXT NOT NULL, id TEXT NOT NULL, run_id TEXT NOT NULL, parent_id TEXT, source TEXT NOT NULL,
  scores_json TEXT NOT NULL, feedback_json TEXT NOT NULL, aggregate REAL NOT NULL,
  created_at INTEGER NOT NULL, iteration INTEGER NOT NULL,
  PRIMARY KEY (actor_id, id))`;

test("a search's candidates lose their stored aggregate and still rank by the mean of their scores", () => {
  const world = workspace();
  const { ws, actor } = world;
  const runId = startGepaRun(ws.sql, actor, { target: 'scaffold' });

  asBuiltBefore(ws.db, 'gepa_candidates', GEPA_CANDIDATES_BEFORE);
  ws.db.exec('CREATE INDEX IF NOT EXISTS idx_gepa_candidates_run_aggregate ON gepa_candidates(actor_id, run_id, aggregate DESC)');

  // As the build before wrote them: each aggregate stored beside the scores it is the mean of.
  for (const [iteration, [id, scores, aggregate]] of ([['seed', { a: 0.5, b: 0.25 }, 0.375], ['child', { a: 1, b: 0.5 }, 0.75]] as const).entries()) {
    void ws.sql`INSERT INTO gepa_candidates (actor_id, id, run_id, parent_id, source, scores_json, feedback_json, aggregate, created_at, iteration)
      VALUES (${actor.actorId}, ${id}, ${runId}, ${iteration === 0 ? null : 'seed'}, ${`source of ${id}`}, ${JSON.stringify(scores)}, '{}', ${aggregate}, ${iteration}, ${iteration})`;
  }

  const before = loadGepaCandidates(ws.sql, actor, runId);

  rebuild(world, ['gepa_candidates']);

  expect(loadGepaCandidates(ws.sql, actor, runId)).toEqual(before);
  expect(bestAggregate(loadGepaCandidates(ws.sql, actor, runId)).id).toBe('child');
});
