/**
 * THE COMPLEXITY GATE: storage and hot-path cost, counted, never timed.
 *
 * A clock flakes under load; a row count does not. Each subject drives production code through a
 * scripted workload at two or three sizes inside workerd, on a Durable Object's own SQLite, and
 * `complexity-probe.ts` counts what one operation at each size cost: the rows each table's
 * statements read and wrote (the SQL cursors' own `rowsRead` and `rowsWritten`) and read beyond the
 * rows they returned (a scan's surplus), each table's stored rows and payload bytes, and the model
 * request's bytes where the operation prepares one.
 * Each subject declares how each count may grow with its size, and a count that grows one class
 * faster than declared fails, naming the table, the counter and both measurements. The O(n²)
 * render copies the session store once made per turn are the defect this exists to keep out.
 */
import { env } from 'cloudflare:workers';
import { afterAll, expect, test } from 'vitest';
import type { ComplexityProbeDO, OperationCost } from './complexity-probe';
import { judge, steepest, type GrowthClass, type GrowthCounter, type GrowthFinding } from './growth';
import { crossingTotal } from '../crossings';
import type { MeteredTurn } from '../sql-meter';

type Probe = DurableObjectStub<ComplexityProbeDO>;

type Counted = 'rowsRead' | 'rowsWritten' | 'statements' | 'rowsScanned';

interface Subject {
  readonly name: string;
  /** What the size counts. */
  readonly unit: string;
  readonly sizes: readonly number[];
  readonly run: (probe: Probe, size: number) => Promise<OperationCost>;
  /** The class every table's counts may not outgrow, unless `tables` names that table and count: an
   *  exception is the one read or write the operation cannot avoid, and says so in `why`. A table's
   *  stored rows and payload bytes grow as its writes may. */
  readonly rows: Readonly<Record<Counted, GrowthClass>>;
  readonly tables?: Readonly<Record<string, Partial<Readonly<Record<Counted, GrowthClass>>>>>;
  readonly requestBytes?: GrowthClass;
  /** Why the declared classes are the right ones. */
  readonly why: string;
}

/** The Diffs read and the Changes poll at each size, measured on one fresh object seeded once for both. */
const diffs = new Map<number, Promise<{ readonly read: OperationCost; readonly poll: OperationCost }>>();

function diffsAt(size: number): Promise<{ readonly read: OperationCost; readonly poll: OperationCost }> {
  const measured = diffs.get(size) ?? env.COMPLEXITY_PROBE.get(env.COMPLEXITY_PROBE.idFromName(`diffs/${String(size)}/${crypto.randomUUID()}`)).diffReadAndPoll(size);

  diffs.set(size, measured);

  return measured;
}

/** The orchestrator's measured turn at each size, counted in the workspace's SQLite and in main's isolate's, run once
 *  for both subjects. */
const longTurns = new Map<number, Promise<{ readonly workspace: OperationCost; readonly main: OperationCost; readonly historyReads: number }>>();

function longTurnAt(size: number): Promise<{ readonly workspace: OperationCost; readonly main: OperationCost; readonly historyReads: number }> {
  const measured = longTurns.get(size) ?? env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName(`long-cost-${String(size)}`)).longTurnCost(size);

  longTurns.set(size, measured);

  return measured;
}

const SUBJECTS: readonly Subject[] = [{
  name: 'activation, the open-turn lookup',
  unit: 'finished turns',
  sizes: [50, 1_000],
  run: async (probe, size) => await probe.openTurnLookup(size),
  rows: { rowsRead: 'O(1)', rowsWritten: 'O(1)', statements: 'O(1)', rowsScanned: 'O(1)' },
  why: 'an activation asks it before any request (kinu-logs/onstart/DESIGN.md, S2): a pointer written with the '
    + 'turn\'s start and removed with its end answers it, whatever number of turns finished before',
}, {
  name: 'terminal recovery, the owed-response check',
  unit: 'settled responses',
  sizes: [50, 1_000],
  run: async (probe, size) => await probe.terminalRecoveryCheck(size),
  rows: { rowsRead: 'O(1)', rowsWritten: 'O(1)', statements: 'O(1)', rowsScanned: 'O(1)' },
  why: 'every wake tick asks it (`owedUntimedArms`): it reads the claims that never settled, never the settled claim '
    + 'each response leaves behind',
}, {
  name: "a turn's end, its agent's figures",
  unit: 'turns before it',
  sizes: [50, 300],
  run: async (probe, size) => await probe.turnEndFigures(size),
  rows: { rowsRead: 'O(1)', rowsWritten: 'O(1)', statements: 'O(1)', rowsScanned: 'O(1)' },
  why: 'every turn\'s end reports its agent\'s tokens, dollars, active time and cache EMA (main\'s isolate at each of its '
    + 'own): the totals the last read stored and the events since, never a join over every turn before it (2,999 rows at turn 300)',
}, {
  name: 'session store, one turn',
  unit: 'turns of history',
  sizes: [50, 300],
  run: async (probe, size) => await probe.sessionTurn(size),
  rows: { rowsRead: 'O(1)', rowsWritten: 'O(1)', statements: 'O(1)', rowsScanned: 'O(1)' },
  requestBytes: 'O(n)',
  why: 'a turn writes what it adds (its input, one call and result, its answer, its claim and its two '
    + 'requests) in a fixed number of statements, whatever came before it, and reads none of the memberships '
    + 'before it: a context keeps the head it last read or wrote. Only the request bytes grow with the '
    + 'history, since each request carries it',
}, {
  // Replaces transcript-cost's wall-clock ratio (2026-09-26): the deploy's 6.8x there was machine load, not growth.
  name: 'session store, a long turn after twenty long answers',
  unit: 'deltas in each earlier answer',
  sizes: [20, 2_000],
  run: async (probe, size) => await probe.turnAfterLongAnswers(size),
  rows: { rowsRead: 'O(1)', rowsWritten: 'O(1)', statements: 'O(1)', rowsScanned: 'O(1)' },
  why: 'an answer is sealed into its message once; a later turn reads that message, never the deltas it was '
    + 'streamed as (D23: re-joining every delta row of past answers made a 500-delta turn 6x slower)',
}, {
  name: 'orchestrator, a long turn after twenty long answers',
  unit: 'deltas in each earlier answer',
  sizes: [20, 2_000],
  run: async (_probe, size) => {
    const measured = await longTurnAt(size);

    transportReads.set(size, measured.historyReads);
    turnStatements.set(size, { workspace: measured.workspace.tables, main: measured.main.tables });

    return measured.workspace;
  },
  rows: { rowsRead: 'O(1)', rowsWritten: 'O(1)', statements: 'O(1)', rowsScanned: 'O(1)' },
  why: 'the production turn path, chat transport included: the store subject above drives the pipeline directly, so '
    + 'per-delta work in the transport (a transcript read, a broadcast) shows only here',
}, {
  name: "main's isolate, the same turn",
  unit: 'deltas in each earlier answer',
  sizes: [20, 2_000],
  run: async (_probe, size) => (await longTurnAt(size)).main,
  rows: { rowsRead: 'O(1)', rowsWritten: 'O(1)', statements: 'O(1)', rowsScanned: 'O(1)' },
  why: 'main keeps its model loop, transcript, turn claims and runs in its own isolate\'s SQLite (D9), so the turn\'s '
    + 'session writes and its read of the earlier answers land there: sealed messages, never their deltas',
}, {
  name: 'workspace Diffs, one read',
  unit: 'files in the workspace',
  sizes: [10, 1_000, 10_000],
  run: async (_probe, size) => (await diffsAt(size)).read,
  rows: { rowsRead: 'O(1)', rowsWritten: 'O(1)', statements: 'O(1)', rowsScanned: 'O(1)' },
  why: 'the baseline is a Nimbus snapshot of the store, and a read pages its diff, which visits only the paths '
    + 'written since the review; it reads the two sides of each of those and writes nothing',
}, {
  name: 'workspace Diffs, a poll with nothing changed',
  unit: 'files in the workspace',
  sizes: [1_000, 10_000],
  run: async (_probe, size) => (await diffsAt(size)).poll,
  rows: { rowsRead: 'O(1)', rowsWritten: 'O(1)', statements: 'O(1)', rowsScanned: 'O(1)' },
  why: 'the change-set is held until a file event on a reviewed path or a review moves it, so a poll with '
    + 'nothing changed reads nothing of the store',
}, {
  name: 'slate, eight new versions in a row',
  unit: 'versions already taken',
  // Both well past Nimbus's content maintenance page (50 content ids a write): below it the page
  // fills with the store, above it the scan is the same bounded page at every size.
  sizes: [256, 1_536],
  run: async (probe, size) => await probe.slateVersion(size),
  rows: { rowsRead: 'O(1)', rowsWritten: 'O(1)', statements: 'O(1)', rowsScanned: 'O(1)' },
  why: 'a version walks the slate\'s own files and stores the changed blob and one manifest; the versions '
    + 'before it are content-addressed blobs it never reads',
}, {
  name: 'slate, one fork',
  unit: 'files in the slate',
  sizes: [10, 100, 1_000],
  run: async (probe, size) => await probe.slateFork(size),
  rows: { rowsRead: 'O(n)', rowsWritten: 'O(n)', statements: 'O(n)', rowsScanned: 'O(n)' },
  why: 'a fork writes every file of the version into the new slate once',
}];

/** The chat transport's whole-transcript reads during the orchestrator subject's measured turn, by size. */
const transportReads = new Map<number, number>();

/** The orchestrator subject's measured turn, its statements by the tables they name in each isolate, by size. */
const turnStatements = new Map<number, { readonly workspace: OperationCost['tables']; readonly main: OperationCost['tables'] }>();

/**
 * Statements one production turn runs, measured 2026-09-27 on this subject: 5,087 at 7dd73e1ac9, 2,035 of them
 * asking `sqlite_master` whether the actor tables exist and 2,041 re-reading the actor and identity rows before every
 * statement; 1,514 once `WorkspaceActorDirectory` checked a handle once a synchronous run, in one statement; 1,024
 * once the directory remembered the actors it retired instead of re-reading their rows (1,515 before, at 41ffcb57b7);
 * 775 once the transcript frame read its ancestry and its messages in one statement each, not one or two an entry;
 * 760 on the list transcript (c7d177a6d8); 681 once the sleep-time window read its entries' messages in one statement;
 * 663 once the workspace capability token was read once, not per hub call; 615 once the tile's fold skipped the
 * owed-work probes while a turn works, the only time it cannot show them; 600 once a sequence's terminal effects were
 * claimed in one statement and the plan review was read only for an operator Build turn; 608 once the context gate
 * recorded its measure (context-one-2); 593 once a step's partial lived in the stream buffer alone (no step_partial
 * rows) and a flush checked the claim inside its own append; 593 again once an actor that reviews no turns owed no
 * advisor_review row (187ce4182e); 699 on agents 0.24. Its Streams chunk log costs 165 statements a turn where 0.22's
 * chunk table cost 54: a state read, a block-tail read and a block write per flush, 52 flushes, the SDK's own floor
 * (CHUNK_BUFFER_SIZE 10, no option). Its job queue costs 33 where the schedule table cost 24: three alarm-deriving reads
 * after every push or cancel. Rows written drop: replay 159 -> 59, wakes 6 -> 5. 534 once the tab's replay is the
 * relay's own chunks for the turn in progress, held in memory: the SDK chunk log (165) goes, `stream_parts` is the
 * answer's one durable copy; and once the fiber sweep, which asked `sqlite_master` for its table and ran on every
 * tick, runs once an activation over the table the SDK's constructor made. 395 once the tile's slow sections (changelog,
 * approvals, shares, pictures, consents, plan review, scaffold settings) were held until their stores wrote (-80),
 * the opened history was reused for the request (-24), a request resolved its model spec once (-17), a step sealed
 * from the parts it held (-11), a synchronous terminal effect wrote its attempt with its outcome (-2), and no
 * terminal-retry wake was armed into a sequence this process runs (-5). Nimbus core 0.13.1 adds three vfs_inodes path
 * lookups because its tree lives in SQL instead of an in-memory inode map: 398. 397 as measured in every run since
 * eec3dad1e8 (CI at eec3dad1e8, drained and release, same tables): one statement left the turn after c82a2a0e15 set
 * 398. Parking owner-fixable refusals rides the claim's one statement and loads an actor's notices once (T1-T3).
 * agents 0.26 records a fiber's outcome on its `cf_agents_runs` row before deleting it (+1 a fiber), and the MCP warm,
 * whose recovery only drops it, left its fiber for `keepAliveWhile` (-4): 396, measured at d240dd3b8 against 400.
 * 393 once an absent SOUL.md is one lookup on the namespace, not three on the bundle plane, and a missing skills
 * root one, not the namespace's two (-3; the bun harness turn 314 -> 311, the same vfs tables CI counted).
 * 381 once a pump going quiet while its close is held rests the actor once, at the close's end (-14), with the root's
 * model_operation start and end as the CLI records them (+2); the agent_wakes read every owed-work check made (+3) and
 * the second read of the root's four pins (+4) came and went with one assembly (402 at b787ee9e3).
 * 382 once a turn's steps name the slates that do not build, read once per activation (+1). 384 once a turn records
 * whether a reset would cut it in a provider wait or in its step's own work (D12): its cut row at admission and the
 * phase each step enters (+2, measured at fd56c4de5).
 * Since D9 main keeps its model loop, transcript, claims and runs in its own isolate, whose SQLite this count did not
 * read: at 2ac877244 the workspace ran 376, green, while main's isolate ran 450 more, one of them asking
 * `sqlite_master` for `run_events` at every turn's end. Both are counted since, at both sizes over 3 runs: 825, the
 * workspace's 376 and main's 449 once its figures ask nothing. Most of main's re-read what the workspace reads too:
 * its actor and identity rows (workspace_actors 133, workspace_identity 10) and its config (actor_config 56); then
 * its claims and stream parts (65) and run events (31).
 * 836 once main's isolate asks the workspace what it alone holds, at both sizes over 3 runs (194a6f8b8 against
 * f1ee92551): the open tasks and running jobs its task reminder reads as the turn settles (agent_tasks +1,
 * background_jobs +2; main's own agent_tasks -1), the warming lane each request and turn end tells (cache_warm +3),
 * and the fleet row its handoff owes as an effect (terminal_effects +2). Each of those four calls resolves the agent's
 * roster row twice on entry (workspace_actors +8); the activity log writes 4 fewer. The workspace's 388, main's 448.
 * 835 once a stream part opens with its first window in the row it inserts (main's isolate -1, at both sizes).
 * 801 once a turn's close neither reads its answer back to announce it to no extension (b65abe3ff) nor reads its
 * narration for no slate and no failed task (8f78f86e9): the workspace's 380, main's 421, at both sizes over 3 runs
 * on 380d7148e.
 * 814 with the turn surface's durable facts (design v2 §2, v3 B), at both sizes over 3 runs on 9d7fb8edb, accepted on
 * 2026-10-10 as a temporary cost of the fences and report sequence: this bound is back below 801 by the end of the
 * design's step 7, when the root's accumulator and mirrored writes go, and is not raised again without the root's say. The
 * workspace's 386: each of the turn's four reports checked against the newest taken (+4), the opening's key (+1), the
 * turn's fence (+2), and its branches' rows where main_turn_facts kept three statements (-1). Main's 428: its four
 * reports numbered (+4), its facts frozen and read back for the handoff (+2), its claim read for the opening's epoch (+1).
 * 807 once an agent with no hirer asks the workspace for no report (ActorPolicy), at both sizes over 3 runs on
 * ceb97fb8e: main's 419 (-9, the report's ledger reads), the workspace's 388 (+2, the policy's row reads).
 * 809 with the review's durability fixes, within the accepted 814, at both sizes over 3 runs on 9c6e5ba52: the
 * workspace's 390 (+2, the facts it first offered the turn's preparation, kept for an agent that dies before it froze
 * them, and the ended tombstone the turn's handoff writes on its fence).
 * 810 with the review's third round, over 2 runs at both sizes on 5323f5588: the workspace's 391 (+1, an opening first
 * queues the obligations of openings cut before their claim; the fence, one row an agent ordered by its sequence, opens
 * in one statement where it took two, and ends a run in one).
 */
const TURN_STATEMENTS = 810;

/** Every count the subject's declarations govern, one value per size. */
function countersOf(subject: Subject, measured: readonly OperationCost[]): GrowthCounter[] {
  const tables = new Set(measured.flatMap((cost) => Object.keys(cost.tables)));
  const counters: GrowthCounter[] = [];

  for (const table of [...tables].sort()) {
    for (const counted of ['rowsRead', 'rowsWritten', 'statements', 'rowsScanned'] as const) {
      counters.push({
        name: `${table}.${counted}`,
        declared: subject.tables?.[table]?.[counted] ?? subject.rows[counted],
        values: measured.map((cost) => cost.tables[table]?.[counted] ?? 0),
      });
    }
  }

  const stored = new Set(measured.flatMap((cost) => [...Object.keys(cost.storedRows), ...Object.keys(cost.storedBytes)]));

  for (const table of [...stored].sort()) {
    const declared = subject.tables?.[table]?.rowsWritten ?? subject.rows.rowsWritten;

    counters.push({ name: `${table}.storedRows`, declared, values: measured.map((cost) => Math.max(0, cost.storedRows[table] ?? 0)) });
    counters.push({ name: `${table}.storedBytes`, declared, values: measured.map((cost) => Math.max(0, cost.storedBytes[table] ?? 0)) });
  }

  if (subject.requestBytes !== undefined) {
    counters.push({ name: 'request.bytes', declared: subject.requestBytes, values: measured.map((cost) => cost.requestBytes ?? 0) });
  }

  return counters;
}

function describeFinding(subject: Subject, finding: GrowthFinding): string {
  return `${subject.name}: ${finding.counter} grew as n^${finding.exponent.toFixed(2)} from ${String(finding.from.size)} to `
    + `${String(finding.to.size)} ${subject.unit} (${String(finding.from.value)} -> ${String(finding.to.value)}); declared ${finding.declared}`;
}

/** Each subject's figures, printed after the file with what the gate is blind to. Under a coding agent vitest
 *  picks its agent reporter, which shows a file's console only when the file fails; `--reporter=default` shows it always. */
const reports: string[] = [];

afterAll(() => {
  console.log([
    ...reports,
    'complexity: blind to',
    '  CPU, memory and wall time: a path that re-parses or copies in memory while its SQL stays flat is invisible;',
    '  storage outside the measured SQLite (KV, R2, D1, another object\'s database or a hired agent\'s isolate, the',
    '    model provider): the orchestrator subjects count the workspace\'s and main\'s isolate\'s;',
    '  growth past the largest size measured, and growth hidden inside the exponent slack of a class;',
    '  which of the tables a statement names its rows came from: it is charged to all of them jointly, and a',
    '    trigger\'s rows to the statement that fired it;',
    '  bytes rewritten in place: a row replaced by one of the same size is one row written and no stored growth;',
    '  the database\'s page count, printed but not judged: it moves 4 KiB at a time;',
    '  a step that prunes: the session subject\'s messages are too small to prune, so the render rows a pruned copy',
    '    stores are not driven (the digest-named rows reverted on their own stay green);',
    '  operations no subject drives: the list above is the whole of what is judged.',
  ].join('\n'));
});

for (const subject of SUBJECTS) {
  test(`${subject.name} grows no faster than declared`, async () => {
    const measured: OperationCost[] = [];

    // One fresh object per size, so each measurement starts from an empty database.
    for (const size of subject.sizes) {
      const probe = env.COMPLEXITY_PROBE.get(env.COMPLEXITY_PROBE.idFromName(`${subject.name}/${String(size)}/${crypto.randomUUID()}`));

      measured.push(await subject.run(probe, size));
    }

    const counters = countersOf(subject, measured);
    const report = [`complexity: ${subject.name}, by ${subject.unit} (${subject.sizes.join(', ')}); the exponent is the steepest between consecutive sizes`];

    for (const counter of counters) {
      const { exponent } = steepest(subject.sizes, counter.values);

      report.push(`  ${counter.name.padEnd(60)} ${counter.values.map((value) => String(value).padStart(10)).join('')}   n^${exponent.toFixed(2)}  declared ${counter.declared}`);
    }

    report.push(`  ${'database pages, in bytes (not judged)'.padEnd(60)} ${measured.map((cost) => String(cost.dbBytes).padStart(10)).join('')}`);
    reports.push(report.join('\n'));

    expect(judge(subject.sizes, counters).map((finding) => describeFinding(subject, finding)), subject.why).toEqual([]);
  });
}

// Runs after the subjects: the orchestrator subject fills `turnStatements`. Main's isolate is counted with the
// workspace: moving a statement from one to the other does not make a turn cheaper.
test('a production turn runs no more statements than it was measured at, and asks sqlite_master nothing', () => {
  const totals = [...turnStatements].map(([size, isolates]) => {
    const [workspace = 0, main = 0] = [isolates.workspace, isolates.main]
      .map((tables) => Object.values(tables).reduce((sum, table) => sum + table.statements, 0));

    return { size, workspace, main, schema: (isolates.workspace.sqlite_master?.statements ?? 0) + (isolates.main.sqlite_master?.statements ?? 0) };
  });

  reports.push(`complexity: a production turn's statements, by size: ${totals.map((total) => `${String(total.size)}: `
    + `${String(total.workspace)} in the workspace + ${String(total.main)} in main's isolate = ${String(total.workspace + total.main)}`).join('; ')}`
    + `; at most ${String(TURN_STATEMENTS)} together`);
  expect(totals).toHaveLength(2);

  for (const total of totals) {
    expect(total.schema).toBe(0);
    expect(total.workspace + total.main, `${String(total.workspace)} in the workspace, ${String(total.main)} in main's isolate`).toBeLessThanOrEqual(TURN_STATEMENTS);
  }
});

/**
 * A task turn's calls across an isolate or object boundary, counted where each lands: the relay main's isolate calls
 * into, the workspace host each relay call opens and calls, the RPC targets either answers with (a memory, a Nimbus
 * session, a context tree), the account, and main's isolate the workspace calls into (D9). Each side splits into its
 * open, a phase a model step (from the step's pace), and the last step with the turn's close. A planted call at each
 * boundary must show as one more crossing there, so the same call in a turn fails these bounds.
 * Measured 2026-10-10 at 40db812715 (lane e881f2a3c), three runs alike: a four-step task turn opens in 39, steps in
 * 19, 16, 14 and 14, and closes in 56 (158 in all; a one-step turn 112). A steady tool step is 14: its pace (relay,
 * host, the facet's grant), its auth (relay, host, account), its tool (relay, host), its activity (relay, host) and
 * four host openings. Before the isolate (d05ff368d) a steady step crossed once; design v2 §8 targets 3.
 * Counted again at f0fd1ee06 by entry alone, a receiver's calls on itself and a target's instances that never left
 * the workspace not counted: the same figures, so no turn crossing was a helper. The planted session read was three
 * crossings before (its `client()` and `cred()` counted, scratch 335c923de) and is one.
 * The close is 55 once it no longer reads main's answer back to announce it to no extension (`facet.answer`,
 * b65abe3ff), over 3 runs on 380d7148e; 52 once main, which has no hirer, asks for no report (`relay.owedReport`,
 * `host.owedReport` and the host it opened), over 3 runs on ceb97fb8e.
 */
const CROSSINGS = { open: 39, step: 19, close: 52 } as const;

/**
 * The planted calls (`ObservedOrchestrator.plantCrossings`), each counted once where it lands, and nothing else: the
 * workspace into the account and into main's isolate; main's isolate into the relay, which opens the workspace's host
 * and calls it, a real call nested in another; and into a memory and a Nimbus session the host answers with. The
 * session's read calls `client()` and `cred()` on itself: helpers of the one call, never crossings of their own.
 */
const PLANTED = {
  workspace: {
    'account.getCredentialsRevision': 1, 'AgentMemory.tail': 1, 'HostedSession._rpcReadFile': 1,
    'host.logActivity': 1, 'host.memory': 1, 'host.session': 1,
    'relay.logActivity': 1, 'relay.memory': 1, 'relay.session': 1,
    'workspace.agentWorkspace': 3,
  },
  main: { 'facet.newestFirst': 1 },
} as const;

/** A turn's crossings by place, both sides summed: its open, each model step's, and its last step's with its close. */
interface TurnPhases {
  readonly open: number;
  readonly steps: readonly number[];
  readonly close: number;
}

function phasesOf(turn: MeteredTurn): TurnPhases {
  const sides = [turn.crossings.workspace.phases, turn.crossings.main.phases];
  const length = Math.max(...sides.map((phases) => phases.length));
  const at = (index: number) => sides.reduce((sum, phases) => sum + crossingTotal(phases[index] ?? {}), 0);
  const all = Array.from({ length }, (_, index) => at(index));

  return { open: all[0] ?? 0, steps: all.slice(1, -1), close: all.at(-1) ?? 0 };
}

test("a task turn crosses between the workspace and main's isolate no more than it was measured to, at each place", async () => {
  // One after the other: the worker counts the calls landing in it, whichever workspace they are for.
  const crossingsOf = async (steps: number) => await env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName(`crossings-${String(steps)}`)).turnCrossings(steps);
  const one = await crossingsOf(1);
  const four = await crossingsOf(4);
  const phases = phasesOf(four.turn);
  const total = (turn: MeteredTurn) => crossingTotal(turn.crossings.workspace.total) + crossingTotal(turn.crossings.main.total);

  reports.push([
    `complexity: a task turn's crossings, four tool steps: open ${String(phases.open)} (at most ${String(CROSSINGS.open)}), `
      + `steps ${phases.steps.join(', ')} (each at most ${String(CROSSINGS.step)}), close ${String(phases.close)} `
      + `(at most ${String(CROSSINGS.close)}); ${String(total(four.turn))} in all, one step ${String(total(one.turn))}`,
    ...four.turn.crossings.workspace.phases.map((phase, index) => `  into the workspace, phase ${String(index)}: ${JSON.stringify(phase)}`),
    ...four.turn.crossings.main.phases.map((phase, index) => `  into main's isolate, phase ${String(index)}: ${JSON.stringify(phase)}`),
    `  planted: ${JSON.stringify(four.planted)}`,
  ].join('\n'));
  // Both turns of each workspace ran their steps: each tool step's call and the answer's.
  expect([one.modelCalls, four.modelCalls]).toEqual([2 * 2, 2 * 5]);
  // A phase a step on each side: the open, four tool steps, and the answer's step with the close.
  expect([four.turn.crossings.workspace.phases.length, four.turn.crossings.main.phases.length]).toEqual([6, 6]);

  expect({ workspace: four.planted.workspace.total, main: four.planted.main.total }).toEqual(PLANTED);

  expect(phases.open).toBeLessThanOrEqual(CROSSINGS.open);
  expect(Math.max(...phases.steps)).toBeLessThanOrEqual(CROSSINGS.step);
  expect(phases.close).toBeLessThanOrEqual(CROSSINGS.close);
});

// Runs after the subjects: the orchestrator subject fills `transportReads`.
test('the chat transport reads the transcript a fixed number of times a turn, never once a delta', () => {
  // A queued task opens no user turn, so its one read is the transcript frame at its close; 500 deltas stream before it.
  expect([...transportReads.values()]).toEqual([1, 1]);
});
