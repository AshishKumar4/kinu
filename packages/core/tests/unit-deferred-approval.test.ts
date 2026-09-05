// Deferred approval — the unattended run that reaches a gated command at 3am
// and neither stalls on it nor is lied to about it.
//
// The behaviour under test is the whole round trip through the real seams: the
// execution-seam gate (withApprovalGatedShell → gateExec) as a backend wires
// it, the durable queue, the needs-you rows the owner decides from, and the
// wake through the ONE signal-delivery seam every asynchronous producer uses.
// The tests that matter most are the honesty ones — a queued action is never
// reported as a success, and an approval is never reported as an effect.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { toolExecute } from '@kinu.run/test-utils';
import {
  DeferredApprovalQueue, DeferredApprovalStore, initDeferredApprovalsTable,
  DEFERRED_APPROVAL_SIGNAL, DENIAL_STANDING_MS, withApprovalGatedShell, buildBuiltinTools,
  formatApprovalGrant,
  type DeferredApproval, type ShellApprovalPolicy, type ShellApprovalOutcome,
  type AgentRuntime, type AgentSignal, type Shell,
} from '../src/index';
import { buildPendingActions } from '../src/read-models/pending-actions';
import { gateProviderExec } from '../src/execution/approval';
import { formatExecResult, parseRefusal, refusalText } from '../src/execution/exec-result';
import { KinuError } from '../src/obs/index';
import type { ExecutorProvider } from '../src/execution/types';
import { createTestRuntime } from './helpers';
import { makeSql, makeExecRaw } from './helpers';

/** Gated on EVERY executor, including the agent's own workspace, because a
 *  force-push rewrites history on a remote nobody here owns — the harm leaves
 *  the machine. `sudo` would not do: on the workspace that is the agent's own
 *  box and no longer the owner's decision. */
const GATED = 'git push --force origin main';

type RunTool = { execute: (args: { command: string; runtime?: string }) => Promise<string> };

function setup(opts: {
  mode?: 'strict' | 'allow_all' | 'deny_all';
  approve?: () => Promise<ShellApprovalOutcome | null>;
  /** Omit the queue entirely — the pre-deferral world, which must be unchanged. */
  noQueue?: boolean;
} = {}) {
  const db = new Database(':memory:');
  initDeferredApprovalsTable(makeExecRaw(db), makeSql(db));
  const store = new DeferredApprovalStore(makeSql(db));

  const delivered: AgentSignal[] = [];
  /** Everything the owner's 'always' answers have bought, as the config store
   *  would hold it. */
  const granted: string[] = [];
  let seq = 0;
  /** Wall-clock offset a test moves to let a denial age. */
  let elapsed = 0;
  /** The durable audit trail a consumed grant must leave behind — what proves
   *  an approval was spent once the row that held it is gone. */
  const audited: Array<{ approvalId: string; command: string; executor: string }> = [];
  const queue = new DeferredApprovalQueue({
    store,
    signals: { deliver: async (signal) => { delivered.push(signal); return 'queued'; } },
    remember: (grants) => { for (const g of grants) granted.push(formatApprovalGrant(g)); },
    newId: () => `defer-${++seq}`,
    now: () => 1_000 + seq + elapsed,
    audit: (record) => { audited.push(record); },
  });

  const executed: string[] = [];
  const rawShell: Shell = {
    exec: async (command: string) => {
      executed.push(String(command));
      return { stdout: 'ran', stderr: '', exitCode: 0 };
    },
  };
  const policy: ShellApprovalPolicy = {
    mode: () => opts.mode ?? 'strict',
    granted: (grant) => granted.includes(formatApprovalGrant(grant)),
  };
  if (opts.approve) policy.requestApproval = opts.approve;
  if (!opts.noQueue) policy.deferrals = queue.channel;
  const shell = withApprovalGatedShell(rawShell, policy);
  const { rt } = createTestRuntime();
  const runtime: AgentRuntime = { ...rt, shell };
  const tools = buildBuiltinTools({ rt: runtime });
  const run: RunTool = {
    execute: toolExecute<{ command: string; runtime?: string }, string>(tools.run),
  };
  return {
    queue, store, shell, executed, delivered, granted, audited, run,
    advance: (ms: number) => { elapsed += ms; },
  };
}

describe('deferred approval schema repair', () => {
  test('adds executor to queues created before approvals were executor-scoped', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE deferred_approvals (
      id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      requested_at INTEGER NOT NULL,
      decided_at INTEGER
    )`);
    db.run(`INSERT INTO deferred_approvals
      (id, command, reason, status, requested_at, decided_at)
      VALUES (?, ?, ?, 'queued', ?, NULL)`, ['legacy', GATED, 'gate', 1]);

    initDeferredApprovalsTable(makeExecRaw(db), makeSql(db));

    expect(db.query<{ executor: string }, []>(
      `SELECT executor FROM deferred_approvals WHERE id = 'legacy'`,
    ).get()).toEqual({ executor: '' });
    db.close();
  });
});

describe('a gated action nobody is there to approve', () => {
  test('is parked, and the model is told it did NOT run — in one line', async () => {
    const { run, executed, queue } = setup();

    const out = await run.execute({ command: GATED });

    expect(executed).toEqual([]);
    // What only this call site knows: nothing ran, which rule, which machine,
    // the id, and that a decision is coming. The doctrine around it — carry on
    // or stop, re-issuing returns the same answer — is true of every parked
    // action on every turn, so it lives in the system prompt, not here.
    // `run` renders a failing exec as `Error (exit 1)` + stderr, so the one
    // line the model reads is the whole of what the gate contributed.
    expect(out).toContain(
      'NOT RUN — queued for owner approval (defer-1): git-force-push on workspace. A decision will wake you.',
    );
    expect(queue.list().map((a) => a.command)).toEqual([GATED]);
  });

  test('NEVER reads as a success — same failure shape a refusal takes', async () => {
    // The requirement this whole mechanism exists to satisfy. Cloudflare's
    // gatekeeper fakes success here; ours must be structurally
    // indistinguishable from a command that did not run, because that is what
    // it is. Both branches return through `denyResult`, so a queued action and
    // a refused one differ in their words and in NOTHING else — there is no
    // success-shaped path for an action that never reached a shell.
    const queued = await setup().shell.exec(GATED);
    const refusedByPolicy = await setup({ mode: 'deny_all' }).shell.exec(GATED);
    const ran = await setup({ mode: 'allow_all' }).shell.exec(GATED);

    expect(queued.exitCode).toBe(refusedByPolicy.exitCode);
    expect(queued.stdout).toBe(refusedByPolicy.stdout);
    expect(queued.exitCode).not.toBe(ran.exitCode);
    expect(queued.stdout).toBe('');
    // …and it leads with what did not happen, before anything else.
    expect(queued.stderr).toBe(
      'NOT RUN — queued for owner approval (defer-1): git-force-push on workspace. A decision will wake you.',
    );
  });

  test('re-issuing the same command returns the SAME parked row, not a second one', async () => {
    // One decision, one row. An identical answer is also what lets the turn's
    // own repeat detector see the loop instead of the queue filling up.
    const { run, queue } = setup();

    const first = await run.execute({ command: GATED });
    const second = await run.execute({ command: GATED });

    expect(second).toBe(first);
    expect(queue.list()).toHaveLength(1);
  });

  test('a different gated command is its own row', async () => {
    const { run, queue } = setup();
    await run.execute({ command: GATED });
    await run.execute({ command: 'npm publish' });
    expect(queue.list().map((a) => a.id)).toEqual(['defer-1', 'defer-2']);
  });

  test('an ungated command is untouched by any of this', async () => {
    const { run, executed, queue } = setup();
    expect(await run.execute({ command: 'ls -la' })).toBe('ran');
    expect(executed).toEqual(['ls -la']);
    expect(queue.list()).toEqual([]);
  });
});

describe('the standing modes still decide first', () => {
  test('allow_all runs a gated command and parks nothing', async () => {
    const { run, executed, queue } = setup({ mode: 'allow_all' });
    expect(await run.execute({ command: GATED })).toBe('ran');
    expect(executed).toEqual([GATED]);
    expect(queue.list()).toEqual([]);
  });

  test('deny_all refuses without parking — the owner already answered', async () => {
    // Parking here would put a question to the owner they have standing
    // instructions about.
    const { run, executed, queue } = setup({ mode: 'deny_all' });
    const out = await run.execute({ command: GATED });
    expect(out).toContain('refused by standing policy (deny_all)');
    expect(executed).toEqual([]);
    expect(queue.list()).toEqual([]);
  });

  test('a live channel that answers is never overridden by the queue', async () => {
    const { run, executed, queue } = setup({ approve: async () => 'allow' });
    expect(await run.execute({ command: GATED })).toBe('ran');
    expect(executed).toEqual([GATED]);
    expect(queue.list()).toEqual([]);
  });

  test('a channel that says deny is a decision, not an absence', async () => {
    const { run, queue } = setup({ approve: async () => 'deny' });
    expect(await run.execute({ command: GATED })).toContain('Denied by the owner');
    expect(queue.list()).toEqual([]);
  });

  test('a channel that declines to decide falls through to the queue', async () => {
    // The unattended case as an ACP surface produces it: attached, but nobody
    // answering. `null` has always meant "nobody is listening"; it now parks
    // instead of manufacturing a refusal.
    const { run, queue } = setup({ approve: async () => null });
    expect(await run.execute({ command: GATED })).toContain('NOT RUN');
    expect(queue.list()).toHaveLength(1);
  });

  test('with no queue wired at all, strict keeps its old explanatory refusal', async () => {
    const { run, executed } = setup({ noQueue: true });
    expect(await run.execute({ command: GATED })).toContain('needs owner approval, nobody to ask');
    expect(executed).toEqual([]);
  });
});

describe('the owner decides, in bulk, and the agent is woken', () => {
  test('approval wakes the agent through the one signal seam — and says nothing has run', async () => {
    const { run, queue, delivered, executed } = setup();
    await run.execute({ command: GATED });

    const decided = await queue.decide(['defer-1'], 'approved');

    expect(decided.map((a) => a.status)).toEqual(['approved']);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.kind).toBe(DEFERRED_APPROVAL_SIGNAL);
    expect(delivered[0]!.text).toContain('APPROVED, still not run');
    expect(delivered[0]!.text).toContain(GATED);
    // The approval is a grant, not an execution: nothing ran on the owner's
    // click, and the needs-you queue has stopped asking.
    expect(executed).toEqual([]);
    expect(queue.list()).toEqual([]);
  });

  test('denial wakes the agent too, and says so in the owner\'s terms', async () => {
    const { run, queue, delivered } = setup();
    await run.execute({ command: GATED });

    await queue.decide(['defer-1'], 'denied');

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain('DENIED — do not re-issue');
  });

  test('a night of parked actions is ONE decision and ONE wake', async () => {
    // The point of bulk: five queued commands decided in one sitting must not
    // cost the agent five separate turns of being told about them.
    const { run, queue, delivered } = setup();
    for (const command of ['npm publish a', 'npm publish b', 'npm publish c', 'npm publish d', 'npm publish e']) {
      await run.execute({ command });
    }
    expect(queue.list()).toHaveLength(5);

    const decided = await queue.decide(queue.list().map((a) => a.id), 'approved');

    expect(decided).toHaveLength(5);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.metadata).toMatchObject({ decision: 'approved', count: 5 });
    for (const command of ['npm publish a', 'npm publish e']) expect(delivered[0]!.text).toContain(command);
    expect(queue.list()).toEqual([]);
  });

  test('a mixed batch names which are which', async () => {
    const { run, queue, delivered } = setup();
    await run.execute({ command: 'npm publish a' });
    await run.execute({ command: 'npm publish b' });

    await queue.decide(['defer-1'], 'approved');
    await queue.decide(['defer-2'], 'denied');

    expect(delivered[0]!.text).toContain('APPROVED');
    expect(delivered[0]!.text).not.toContain('DENIED');
    expect(delivered[1]!.text).toContain('DENIED');
    expect(delivered[1]!.text).not.toContain('APPROVED');
  });

  test('deciding an already-decided action changes nothing and wakes nobody', async () => {
    const { run, queue, delivered } = setup();
    await run.execute({ command: GATED });
    await queue.decide(['defer-1'], 'approved');

    expect(await queue.decide(['defer-1'], 'denied')).toEqual([]);
    expect(await queue.decide(['defer-nonexistent'], 'approved')).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  test('one id sent twice is one decision, not two', async () => {
    // A double-click, or a bulk selection overlapping a single row: the wake
    // must not name one command as two decisions.
    const { run, queue, delivered } = setup();
    await run.execute({ command: GATED });

    const decided = await queue.decide(['defer-1', 'defer-1'], 'approved');

    expect(decided.map((a) => a.id)).toEqual(['defer-1']);
    expect(delivered[0]!.metadata).toMatchObject({ count: 1 });
  });
});

describe('what an approval actually buys', () => {
  test('the approved command runs when the AGENT re-issues it — and only then', async () => {
    const { run, queue, executed } = setup();
    await run.execute({ command: GATED });
    await queue.decide(['defer-1'], 'approved');
    expect(executed).toEqual([]);

    expect(await run.execute({ command: GATED })).toBe('ran');
    expect(executed).toEqual([GATED]);
  });

  test('one approval authorises exactly one run', async () => {
    // A grant that could be replayed would let a single click authorise an
    // unbounded number of executions of a command the gate stopped.
    const { run, queue, executed } = setup();
    await run.execute({ command: GATED });
    await queue.decide(['defer-1'], 'approved');

    expect(await run.execute({ command: GATED })).toBe('ran');
    const second = await run.execute({ command: GATED });

    expect(executed).toEqual([GATED]);
    expect(second).toContain('NOT RUN');
    expect(queue.list().map((a) => a.id)).toEqual(['defer-2']);
  });

  test('an approval never travels to a different command', async () => {
    const { run, queue, executed } = setup();
    await run.execute({ command: 'npm publish a' });
    await queue.decide(['defer-1'], 'approved');

    expect(await run.execute({ command: 'npm publish b' })).toContain('NOT RUN');
    expect(executed).toEqual([]);
  });

  test('a refused command reports the refusal on re-issue instead of re-asking', async () => {
    // Device consent's doctrine: the owner said no, and asking again
    // immediately is noise. The escape is named in the message, not hidden.
    const { run, queue, executed } = setup();
    await run.execute({ command: GATED });
    await queue.decide(['defer-1'], 'denied');

    const out = await run.execute({ command: GATED });

    expect(executed).toEqual([]);
    expect(out).toContain('NOT RUN — the owner refused this (defer-1). Not a timeout; find another way.');
    expect(queue.list()).toEqual([]);
  });

  test('a refusal stands for a bounded time, then the row is gone and the queue asks again', async () => {
    // A denial is the owner's answer to THIS ask, and the re-issue an agent
    // makes minutes later is the noise it exists to absorb. It is not a
    // standing policy: `deny_all` and the rule grants are. So the row expires
    // rather than answering for the life of the workspace, and rather than
    // accumulating one denied row per refused command forever.
    const { run, queue, store, executed, advance } = setup();
    await run.execute({ command: GATED });
    await queue.decide(['defer-1'], 'denied');
    expect(await run.execute({ command: GATED })).toContain('the owner refused this (defer-1)');

    advance(DENIAL_STANDING_MS + 1);
    const out = await run.execute({ command: GATED });

    expect(executed).toEqual([]);
    expect(out).toContain('NOT RUN — queued for owner approval (defer-2)');
    expect(queue.list().map((a) => a.id)).toEqual(['defer-2']);
    // The expired refusal did not merely stop answering: its row is gone.
    expect(store.get('defer-1')).toBeNull();
  });

  test('an expired refusal is swept even when nothing re-issues its command', async () => {
    const { run, queue, store, advance } = setup();
    await run.execute({ command: 'npm publish a' });
    await queue.decide(['defer-1'], 'denied');
    advance(DENIAL_STANDING_MS + 1);

    // Any write to the queue is a sweep: here, the owner deciding something else.
    await run.execute({ command: 'npm publish b' });
    await queue.decide(['defer-2'], 'approved');

    expect(store.get('defer-1')).toBeNull();
    expect(store.get('defer-2')?.status).toBe('approved');
  });

  test('"always" runs this command AND stops the queue asking about that rule again', async () => {
    // The owner's ask: mark auto-approval for similar commands, not this exact
    // string. A second, DIFFERENT command of the same kind never reaches the
    // queue — which is the whole difference between a grant and an approval.
    const { run, queue, executed, granted, delivered } = setup();
    await run.execute({ command: GATED });

    await queue.decide(['defer-1'], 'always');

    expect(granted).toEqual(['git-force-push@workspace']);
    // Still permission, not an effect: the agent re-issues, and it runs.
    expect(executed).toEqual([]);
    expect(await run.execute({ command: GATED })).toBe('ran');

    const different = 'git push --force origin release';
    expect(await run.execute({ command: different })).toBe('ran');
    expect(executed).toEqual([GATED, different]);
    expect(queue.list()).toEqual([]);
    // One decision, one wake — the grant did not manufacture a second.
    expect(delivered).toHaveLength(1);
  });

  test('an "always" grant does not travel to another rule', async () => {
    const { run, queue, executed, granted } = setup();
    await run.execute({ command: GATED });
    await queue.decide(['defer-1'], 'always');

    expect(granted).toEqual(['git-force-push@workspace']);
    expect(await run.execute({ command: 'npm publish' })).toContain('NOT RUN');
    expect(executed).toEqual([]);
  });
});

describe('the spent grant leaves an audit, and no row the gate did not close', () => {
  test('consuming a grant records the approval once and deletes its row', async () => {
    const { run, queue, store, audited } = setup();
    await run.execute({ command: GATED });
    await queue.decide(['defer-1'], 'approved');

    expect(await run.execute({ command: GATED })).toBe('ran');
    expect(audited).toEqual([
      { approvalId: 'defer-1', command: GATED, executor: 'workspace' },
    ]);
    // The row is GONE, not flipped to a terminal status: a second run needs a
    // second approval because there is nothing left to spend.
    expect(store.get('defer-1')).toBeNull();
  });

  test('one grant is one audit and one run — a re-issue parks, never replays', async () => {
    const { run, queue, executed, audited } = setup();
    await run.execute({ command: GATED });
    await queue.decide(['defer-1'], 'approved');

    await run.execute({ command: GATED });   // spends defer-1, runs
    await run.execute({ command: GATED });   // no grant left: parks defer-2

    expect(executed).toEqual([GATED]);
    expect(audited).toHaveLength(1);
  });

  test('store.spend hands the grant out once, and a settle finishes it', () => {
    // The row outlives the spend only so the gate can close it. While it is
    // out it answers for nobody: `standing()` cannot see it and a second
    // spend gets nothing.
    const db = new Database(':memory:');
    initDeferredApprovalsTable(makeExecRaw(db), makeSql(db));
    const store = new DeferredApprovalStore(makeSql(db));
    store.create({ id: 'defer-s', command: GATED, executor: 'workspace', reason: 'gate', requestedAt: 1 });
    expect(store.decide('defer-s', 'approved', 2)?.status).toBe('approved');

    const spent = store.spend('defer-s');
    expect(spent?.action.id).toBe('defer-s');
    expect(store.spend('defer-s')).toBeNull();
    expect(store.standing(GATED, 'workspace', 3)).toBeNull();
    if (!spent) throw new Error('an approved grant must be spendable');

    expect(store.settle(spent.spend, 'spent')).toBe(true);
    expect(store.get('defer-s')).toBeNull();
    // Closed once. A replay finds nothing and cannot bring the grant back.
    expect(store.settle(spent.spend, 'did-not-run')).toBe(false);
    expect(store.standing(GATED, 'workspace', 3)).toBeNull();
  });

  test('re-opening the workspace keeps parked and approved rows intact', () => {
    // Table init is idempotent and touches no data: a night's parked actions
    // survive every eviction and re-open between the ask and the answer.
    const db = new Database(':memory:');
    initDeferredApprovalsTable(makeExecRaw(db), makeSql(db));
    const store = new DeferredApprovalStore(makeSql(db));
    store.create({ id: 'defer-parked', command: GATED, executor: 'workspace', reason: 'gate', requestedAt: 1 });
    store.create({ id: 'defer-blessed', command: `${GATED} --twice`, executor: 'workspace', reason: 'gate', requestedAt: 2 });
    expect(store.decide('defer-blessed', 'approved', 3)?.status).toBe('approved');

    initDeferredApprovalsTable(makeExecRaw(db), makeSql(db));
    const reopened = new DeferredApprovalStore(makeSql(db));
    expect(reopened.get('defer-parked')?.status).toBe('queued');
    expect(reopened.get('defer-blessed')?.status).toBe('approved');
    expect(reopened.standing(GATED, 'workspace', 6)?.id).toBe('defer-parked');
  });
});

describe('the parked action stays visible until it is decided', () => {
  test('every step of the turn re-states that it has not happened', () => {
    // The structural half of the honesty invariant: the model cannot forget
    // that the effect is missing, because the per-step dynamic-context block
    // carries it until the owner answers.
    const { queue, store } = setup();
    store.create({ id: 'defer-x', command: GATED, executor: 'workspace', reason: 'gate', requestedAt: 10 });

    expect(queue.approvals()).toEqual([
      { id: 'defer-x', kind: 'queued command (NOT run)', detail: GATED },
    ]);
  });

  test('and stops the moment it is decided', async () => {
    const { run, queue } = setup();
    await run.execute({ command: GATED });
    expect(queue.approvals()).toHaveLength(1);

    await queue.decide(['defer-1'], 'approved');

    expect(queue.approvals()).toEqual([]);
  });

  test('it is a needs-you row the owner can act on', async () => {
    const { run, queue } = setup();
    await run.execute({ command: GATED });

    const rows = buildPendingActions({
      approvals: [], changes: [], scaffoldVersions: [], jobs: [], curriculum: [],
      unseenChanges: { count: 0, revertable: 0, latestAt: 0 },
      deferredActions: queue.list(),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'defer-1', kind: 'deferred_action', detail: GATED });
  });
});

describe('durability — the wait is a night, not a prompt window', () => {
  test('the queue survives the process that parked the action', async () => {
    // A Durable Object is evicted many times between the ask and the answer;
    // a parked action that lived in a promise map would be lost with it.
    const db = new Database(':memory:');
    initDeferredApprovalsTable(makeExecRaw(db), makeSql(db));
    const first = new DeferredApprovalStore(makeSql(db));
    first.create({ id: 'defer-9', command: GATED, executor: 'workspace', reason: 'gate', requestedAt: 5 });

    const reopened = new DeferredApprovalStore(makeSql(db));
    const parked = reopened.listQueued();

    expect(parked.map((a: DeferredApproval) => a.id)).toEqual(['defer-9']);
    expect(reopened.standing(GATED, 'workspace', 6)?.status).toBe('queued');
  });

  test('the decision is durable before the wake is attempted', async () => {
    // An undeliverable wake must not lose the owner's answer: the row is the
    // record, the signal is only the notification.
    const db = new Database(':memory:');
    initDeferredApprovalsTable(makeExecRaw(db), makeSql(db));
    const store = new DeferredApprovalStore(makeSql(db));
    store.create({ id: 'defer-7', command: GATED, executor: 'workspace', reason: 'gate', requestedAt: 5 });
    const queue = new DeferredApprovalQueue({
      store,
      signals: { deliver: () => Promise.reject(new Error('no host')) },
      remember: () => { throw new Error('not an always answer'); },
    });

    await expect(queue.decide(['defer-7'], 'approved')).rejects.toThrow('no host');
    expect(store.get('defer-7')?.status).toBe('approved');
  });
});

/**
 * The defect the live first-run tier found on staging 2026-09-03: the owner
 * approves a command, and is asked for it a second time.
 *
 * One approval has two consumers. `decide()` writes 'approved' AND wakes the
 * agent so it re-issues the command; `park()` spends the grant by taking the
 * row out of `standing()`'s reach BEFORE the command runs. On a first run the
 * woken re-issue reaches a device transport that is not ready yet, so the
 * grant is spent on an attempt that ran nothing, and the next attempt finds no
 * standing grant and parks a NEW row — the owner's complaint verbatim.
 *
 * The gate keeps spend-before-run: a crash between the spend and the run must
 * cost an approval rather than grant one twice. What it adds is a CLASSIFIED
 * refund — when the wrapped execute answers a code that establishes the
 * command never reached its machine, the same grant becomes spendable again.
 */
describe('an approval outlives an attempt that never reached the machine', () => {
  /** The laptop seam as a router wires it: an ExecutorProvider whose `exec`
   *  answers whatever this run of the test needs, gated by `gateProviderExec`
   *  with the real deferral queue behind it. */
  function deviceSetup() {
    const db = new Database(':memory:');
    initDeferredApprovalsTable(makeExecRaw(db), makeSql(db));
    const store = new DeferredApprovalStore(makeSql(db));
    let seq = 0;
    const audited: Array<{ approvalId: string; command: string; executor: string }> = [];
    const queue = new DeferredApprovalQueue({
      store,
      signals: { deliver: async () => 'queued' },
      remember: () => { throw new Error('not an always answer'); },
      newId: () => `defer-${++seq}`,
      now: () => 1_000 + seq,
      audit: (record) => { audited.push(record); },
    });

    const executed: string[] = [];
    /** What the machine answers. Swapped per phase: not connected, then
     *  connected. */
    let answer: () => string = () => 'ran';
    const provider: ExecutorProvider = {
      name: 'laptop',
      kind: 'laptop',
      capabilities: new Set(['shell']),
      homeDir: async () => '/home/owner',
      isAvailable: () => true,
      connect: async () => {},
      disconnect: async () => {},
      tools: {
        exec: {
          description: 'Run a shell command on the owner\'s machine',
          execute: async (...args: unknown[]) => {
            executed.push(String(args[0]));
            return answer();
          },
        },
      },
    };
    const gated = gateProviderExec(provider, {
      mode: () => 'strict',
      deferrals: queue.channel,
    });
    const exec = async (command: string): Promise<string> =>
      String(await gated.tools.exec!.execute(command));
    return {
      queue, store, exec, executed, audited,
      answerWith: (next: () => string) => { answer = next; },
    };
  }

  /** The device transport's own refusal, classified: `unavailable` is the code
   *  the laptop path already produces when no machine is attached
   *  (execution/device-tunnel-executor.ts NOT_CONNECTED_REFUSAL). The test
   *  reads the CODE, never the prose. */
  const notConnected = () => refusalText(new KinuError('unavailable', 'No device connected.'));

  test('a definitive did-not-run leaves the grant spendable and asks nobody again', async () => {
    const { queue, store, exec, executed, answerWith } = deviceSetup();
    answerWith(notConnected);

    expect(await exec(GATED)).toContain('NOT RUN — queued for owner approval (defer-1)');
    await queue.decide(['defer-1'], 'approved');

    // The woken re-issue. The command reaches an executor that is not there,
    // so nothing ran on any machine.
    expect(parseRefusal(await exec(GATED))?.reason).toBe('unavailable');
    expect(executed).toEqual([GATED]);

    // The owner approved a RUN, and no run happened: the grant they gave is
    // still theirs to spend, and they are not asked a second time.
    expect(store.standing(GATED, 'laptop', 1_010)?.status).toBe('approved');
    expect(store.standing(GATED, 'laptop', 1_010)?.id).toBe('defer-1');
    expect(queue.list()).toEqual([]);
  });

  test('the next attempt that DOES reach the machine spends it for good', async () => {
    const { queue, store, exec, executed, audited, answerWith } = deviceSetup();
    answerWith(notConnected);
    await exec(GATED);
    await queue.decide(['defer-1'], 'approved');
    await exec(GATED);

    answerWith(() => 'ran');
    expect(await exec(GATED)).toBe('ran');

    expect(executed).toEqual([GATED, GATED]);
    expect(store.standing(GATED, 'laptop', 1_010)).toBeNull();
    expect(store.get('defer-1')).toBeNull();
    // One approval, one execution — and one audit for the spend that stuck.
    expect(audited).toEqual([{ approvalId: 'defer-1', command: GATED, executor: 'laptop' }]);
    // A fourth attempt has no grant left and parks a fresh row.
    expect(await exec(GATED)).toContain('NOT RUN — queued for owner approval (defer-2)');
  });

  test('a command that reached the machine and FAILED there does not refund', async () => {
    // The negative control that keeps the refund narrow: a non-zero exit is a
    // command that ran. The approval is spent, exactly as it always was.
    const { queue, store, exec, answerWith } = deviceSetup();
    answerWith(notConnected);
    await exec(GATED);
    await queue.decide(['defer-1'], 'approved');

    answerWith(() => formatExecResult({ stdout: '', stderr: 'rejected', exitCode: 1 }));
    expect(await exec(GATED)).toContain('Error (exit 1)');

    expect(store.standing(GATED, 'laptop', 1_010)).toBeNull();
    expect(store.get('defer-1')).toBeNull();
  });

  test('an UNCLASSIFIABLE failure does not refund', async () => {
    // `io` is what this seam answers for a cause its classifier does not
    // recognise, and an unknown outcome must keep the safe behaviour: the
    // frame may have reached the machine and run.
    const { queue, store, exec, answerWith } = deviceSetup();
    answerWith(notConnected);
    await exec(GATED);
    await queue.decide(['defer-1'], 'approved');

    answerWith(() => refusalText(new KinuError('io', 'the tunnel closed mid-call')));
    expect(parseRefusal(await exec(GATED))?.reason).toBe('io');

    expect(store.standing(GATED, 'laptop', 1_010)).toBeNull();
  });

  test('a throw out of the executor does not refund', async () => {
    // Nothing classified anything, so nothing is known. Same rule.
    const { queue, store, exec, answerWith } = deviceSetup();
    answerWith(notConnected);
    await exec(GATED);
    await queue.decide(['defer-1'], 'approved');

    answerWith(() => { throw new Error('socket died'); });
    await expect(exec(GATED)).rejects.toThrow('socket died');

    expect(store.standing(GATED, 'laptop', 1_010)).toBeNull();
  });

  test('two refunds of one spend change nothing', async () => {
    // The refund must be a state transition on the SAME row, not a second way
    // to grant: replaying it must not resurrect a grant a later attempt spent.
    const { queue, store, exec, answerWith } = deviceSetup();
    answerWith(notConnected);
    await exec(GATED);
    await queue.decide(['defer-1'], 'approved');

    const spend = store.spend('defer-1');
    expect(spend).not.toBeNull();
    if (!spend) throw new Error('the approved grant must be spendable');

    queue.channel.settle(spend.spend, 'did-not-run');
    expect(store.standing(GATED, 'laptop', 1_010)?.id).toBe('defer-1');

    queue.channel.settle(spend.spend, 'did-not-run');
    expect(store.standing(GATED, 'laptop', 1_010)?.id).toBe('defer-1');

    // …and a replay that arrives after a LATER spend cannot undo it.
    const second = store.spend('defer-1');
    expect(second).not.toBeNull();
    if (!second) throw new Error('the refunded grant must be spendable again');
    queue.channel.settle(second.spend, 'spent');
    queue.channel.settle(spend.spend, 'did-not-run');
    expect(store.standing(GATED, 'laptop', 1_010)).toBeNull();
    expect(store.get('defer-1')).toBeNull();
  });

  test('a refund beside a second re-issue answers the grant, not the fresh ask', async () => {
    // The two-consumer shape the whole defect comes from: `decide()` wakes the
    // agent AND leaves the grant for anyone, so a second re-issue can park a
    // NEW row in the window between the first one's spend and its refund. Once
    // the refund lands, one key holds both. Answering the newer QUEUED row
    // there would ask the owner for the very thing they already approved.
    const { queue, store, exec, executed, answerWith } = deviceSetup();
    answerWith(notConnected);
    await exec(GATED);
    await queue.decide(['defer-1'], 'approved');

    // Consumer A takes the grant and has not come back yet.
    const spend = store.spend('defer-1');
    if (!spend) throw new Error('the approved grant must be spendable');
    // Consumer B finds nothing standing and parks its own row.
    expect(await exec(GATED)).toContain('NOT RUN — queued for owner approval (defer-2)');
    // A never reached the machine, so the grant comes back beside defer-2.
    queue.channel.settle(spend.spend, 'did-not-run');

    answerWith(() => 'ran');
    expect(await exec(GATED)).toBe('ran');
    expect(executed).toEqual([GATED]);
    // defer-2 is still the owner's to answer; the grant is gone for good.
    expect(store.get('defer-1')).toBeNull();
    expect(queue.list().map((a) => a.id)).toEqual(['defer-2']);
  });
});
