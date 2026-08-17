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
import { toolExecute } from '@proteus/test-utils';
import {
  DeferredApprovalQueue, DeferredApprovalStore, initDeferredApprovalsTable,
  DEFERRED_APPROVAL_SIGNAL, withApprovalGatedShell, buildBuiltinTools,
  formatApprovalGrant,
  type DeferredApproval, type ShellApprovalPolicy, type ShellApprovalOutcome,
  type AgentRuntime, type AgentSignal, type Shell,
} from '../src/index.js';
import { buildPendingActions } from '../src/read-models/pending-actions.js';
import { createTestRuntime } from './helpers.js';
import { makeSql, makeExecRaw } from './helpers.js';

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
  initDeferredApprovalsTable(makeExecRaw(db));
  const store = new DeferredApprovalStore(makeSql(db));

  const delivered: AgentSignal[] = [];
  /** Everything the owner's 'always' answers have bought, as the config store
   *  would hold it. */
  const granted: string[] = [];
  let seq = 0;
  const queue = new DeferredApprovalQueue({
    store,
    signals: { deliver: async (signal) => { delivered.push(signal); return 'queued'; } },
    remember: (grants) => { for (const g of grants) granted.push(formatApprovalGrant(g)); },
    newId: () => `defer-${++seq}`,
    now: () => 1_000 + seq,
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
  return { queue, store, shell, executed, delivered, granted, run };
}

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
    initDeferredApprovalsTable(makeExecRaw(db));
    const first = new DeferredApprovalStore(makeSql(db));
    first.create({ id: 'defer-9', command: GATED, executor: 'workspace', reason: 'gate', requestedAt: 5 });

    const reopened = new DeferredApprovalStore(makeSql(db));
    const parked = reopened.listQueued();

    expect(parked.map((a: DeferredApproval) => a.id)).toEqual(['defer-9']);
    expect(reopened.standing(GATED, 'workspace')?.status).toBe('queued');
  });

  test('the decision is durable before the wake is attempted', async () => {
    // An undeliverable wake must not lose the owner's answer: the row is the
    // record, the signal is only the notification.
    const db = new Database(':memory:');
    initDeferredApprovalsTable(makeExecRaw(db));
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
