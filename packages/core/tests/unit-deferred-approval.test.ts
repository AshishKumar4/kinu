import { readText, type VFS, writeText } from '@nimbus-sh/core/vfs/vfs.js';
// Deferred approval: a gated command in an unattended run parks durably. A queued action is
// never reported as a success, and an approval is never reported as an effect.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createMemoryVfs, fakeMossaic, toolExecute } from '@kinu.run/test-utils';
import { DeferredApprovalQueue, DeferredApprovalStore, initDeferredApprovalsTable, DEFERRED_APPROVAL_SIGNAL, DENIAL_STANDING_MS, withApprovalGatedShell, buildBuiltinTools, formatApprovalGrant, createShellSession, withApprovalGatedFiles, performBoundWrite, withMountTable, sharedDriveMount, mossaicVfs, ParkedWriteFiles, type DeferredApproval, type ShellApprovalPolicy, type ShellApprovalOutcome, type AgentRuntime, type AgentSignal, type FilesOwner, type Shell, WORKSPACE_ROOT } from '../src/index';
import type { BoundFileWrite } from '../src/safety/bound-write';
import { CHUNK_SIZE } from '@nimbus-sh/core/constants.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { buildPendingActions } from '../src/read-models/pending-actions';
import { gateProviderExec } from '../src/execution/approval';
import { commandResult, formatExecResult, type CommandResult } from '../src/execution/exec-result';
import { createRecordingLogger, setDiagnosticsSink, KinuError, refusalOf } from '../src/obs/index';
import type { ExecutorProvider } from '../src/execution/types';
import { createTestRuntime, createTestWorkspace, createWorkspaceBundle, conversationsFor } from './helpers';
import { makeSql, makeExecRaw } from './helpers';
import { createTestActors } from '@kinu.run/test-utils';
import type { ActorHandle } from '../src/identity/actor-handle';
import type { SqlExecutor } from '../src/types/primitives';
import { cloudPlanes } from '../src/vfs/resolve';

/** Approvals db + actor. `deferred_approvals` is keyed `(actor_id, id)`, so a re-opened store must name the same actor. */
function approvalsDb() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initDeferredApprovalsTable(execRaw);

  return { db, sql, actor: createTestActors(sql, execRaw).main } satisfies {
    db: Database; sql: SqlExecutor; actor: ActorHandle;
  };
}

/** A workspace shell over the agent's own files, with no mount of the user's. */
const AGENTS_OWN = { filesOwner: 'agent' } as const;

/** Gated on every executor, workspace included: a force-push harms a remote beyond this machine. */
const GATED = 'git push --force origin main';

type ShellTool = { execute: (args: { command: string; runtime?: string }) => Promise<string> };

function setup(opts: {
  mode?: 'strict' | 'allow_all' | 'deny_all';
  approve?: () => Promise<ShellApprovalOutcome | null>;
  /** Omit the queue: the no-queue path must behave as if deferral did not exist. */
  noQueue?: boolean;
  /** Whose files the gated shell holds. */
  filesOwner?: FilesOwner;
} = {}) {
  const filesOwner = opts.filesOwner ?? 'agent';
  const { sql, actor } = approvalsDb();
  const store = new DeferredApprovalStore(sql, actor);

  const delivered: AgentSignal[] = [];
  const granted: string[] = [];
  let seq = 0;
  /** Wall-clock offset a test moves to let a denial age. */
  let elapsed = 0;
  /** Durable audit trail a consumed grant leaves behind. */
  const audited: Array<{ approvalId: string; command: string; executor: string }> = [];

  const queue = new DeferredApprovalQueue({
    writes: null,
    store,
    inbox: { send: async (signal) => {
      delivered.push(signal);

      return 'queued';
    } },
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
  const shell = withApprovalGatedShell(rawShell, { ...AGENTS_OWN, filesOwner }, policy);
  const { rt } = createTestRuntime();
  const runtime: AgentRuntime = { ...rt, shell };
  const tools = buildBuiltinTools({ rt: runtime, conversations: conversationsFor(runtime) });

  const shellTool: ShellTool = {
    execute: toolExecute<{ command: string; runtime?: string }, string>(tools.shell),
  };

  return {
    queue, store, sql, shell, executed, delivered, granted, audited, shellTool,
    advance: (ms: number) => { elapsed += ms; },
  };
}


describe('a gated action nobody is there to approve', () => {
  test('a failed consumption audit is reported without changing an executed command into a refusal', async () => {
    const { sql, actor } = approvalsDb();
    const log = createRecordingLogger();
    const restore = setDiagnosticsSink(log);

    const queue = new DeferredApprovalQueue({
      writes: null,
      store: new DeferredApprovalStore(sql, actor),
      inbox: { send: async () => 'queued' }, remember: () => {},
      audit: () => { throw new Error('audit unavailable'); },
    });

    const shell = withApprovalGatedShell({
      exec: async () => ({ stdout: 'executed', stderr: '', exitCode: 0 }),
    }, AGENTS_OWN, { mode: () => 'strict', requestApproval: null, deferrals: queue.channel });

    try {
      await shell.exec(GATED);
      await queue.decide(queue.list().map((action) => action.id), 'approved');
      expect(await shell.exec(GATED)).toEqual({ stdout: 'executed', stderr: '', exitCode: 0 });
      expect(log.emitted[0]?.event).toBe('approval.audit_emit_failed');
      expect(queue.list()).toEqual([]);
    } finally {
      restore();
    }
  });

  test('is parked, and the model is told it did NOT run — in one line', async () => {
    const { shellTool, executed, queue } = setup();

    const out = shellTool.execute({ command: GATED });
    await expect(out).rejects.toMatchObject({ message: expect.stringContaining('NOT RUN: queued for owner approval (defer-1): git-force-push on workspace. A decision will wake you.') });
    expect(executed).toEqual([]);
    expect(queue.list().map((a) => a.command)).toEqual([GATED]);
  });

  test('NEVER reads as a success — same failure shape a refusal takes', async () => {
    // A queued action must be indistinguishable from a command that did not run: no success-shaped path.
    const queued = await setup().shell.exec(GATED);
    const refusedByPolicy = await setup({ mode: 'deny_all' }).shell.exec(GATED);
    const ran = await setup({ mode: 'allow_all' }).shell.exec(GATED);

    expect(queued.exitCode).toBe(refusedByPolicy.exitCode);
    expect(queued.stdout).toBe(refusedByPolicy.stdout);
    expect(queued.exitCode).not.toBe(ran.exitCode);
    expect(queued.stdout).toBe('');
    expect(queued.stderr).toBe(
      'NOT RUN: queued for owner approval (defer-1): git-force-push on workspace. A decision will wake you.',
    );
  });

  test('re-issuing the same command returns the SAME parked row, not a second one', async () => {
    // An identical answer lets the turn's repeat detector see the loop.
    const { shellTool, queue } = setup();

    const first = shellTool.execute({ command: GATED });
    await expect(first).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('defer-1') });
    const second = shellTool.execute({ command: GATED });
    await expect(second).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('defer-1') });
    expect(queue.list()).toHaveLength(1);
  });

  test('a different gated command is its own row', async () => {
    const { shellTool, queue } = setup();
    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);
    await expect(shellTool.execute({ command: 'npm publish' })).rejects.toBeInstanceOf(KinuError);
    expect(queue.list().map((a) => a.id)).toEqual(['defer-1', 'defer-2']);
  });

  test('an ungated command is untouched by any of this', async () => {
    const { shellTool, executed, queue } = setup();
    expect(await shellTool.execute({ command: 'ls -la' })).toBe('ran');
    expect(executed).toEqual(['ls -la']);
    expect(queue.list()).toEqual([]);
  });
});

describe('the standing modes still decide first', () => {
  test('allow_all runs a gated command and parks nothing', async () => {
    const { shellTool, executed, queue } = setup({ mode: 'allow_all' });
    expect(await shellTool.execute({ command: GATED })).toBe('ran');
    expect(executed).toEqual([GATED]);
    expect(queue.list()).toEqual([]);
  });

  test('deny_all refuses without parking — the owner already answered', async () => {
    const { shellTool, executed, queue } = setup({ mode: 'deny_all' });
    const out = shellTool.execute({ command: GATED })
    await expect(out).rejects.toMatchObject({ message: expect.stringContaining('refused by standing policy (deny_all)') });
    expect(executed).toEqual([]);
    expect(queue.list()).toEqual([]);
  });

  test('a live channel that answers is never overridden by the queue', async () => {
    const { shellTool, executed, queue } = setup({ approve: async () => 'allow' });
    expect(await shellTool.execute({ command: GATED })).toBe('ran');
    expect(executed).toEqual([GATED]);
    expect(queue.list()).toEqual([]);
  });

  test('a channel that says deny is a decision, not an absence', async () => {
    const { shellTool, queue } = setup({ approve: async () => 'deny' });
    await expect(shellTool.execute({ command: GATED })).rejects.toMatchObject({ message: expect.stringContaining('Denied by the owner') });
    expect(queue.list()).toEqual([]);
  });

  test('a channel that declines to decide falls through to the queue', async () => {
    // Attached but nobody answering (`null`) parks instead of refusing.
    const { shellTool, queue } = setup({ approve: async () => null });
    await expect(shellTool.execute({ command: GATED })).rejects.toMatchObject({ message: expect.stringContaining('NOT RUN') });
    expect(queue.list()).toHaveLength(1);
  });

  test('with no queue wired at all, strict keeps its old explanatory refusal', async () => {
    const { shellTool, executed } = setup({ noQueue: true });
    await expect(shellTool.execute({ command: GATED })).rejects.toMatchObject({ message: expect.stringContaining('needs owner approval, nobody to ask') });
    expect(executed).toEqual([]);
  });
});

describe('the owner decides, in bulk, and the agent is woken', () => {
  test('approval wakes the agent through the one signal seam — and says nothing has run', async () => {
    const { shellTool, queue, delivered, executed } = setup();
    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);

    const decided = await queue.decide(['defer-1'], 'approved');

    expect(decided.map((a) => a.status)).toEqual(['approved']);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].kind).toBe(DEFERRED_APPROVAL_SIGNAL);
    expect(delivered[0].text).toContain('APPROVED, still not run');
    expect(delivered[0].text).toContain(GATED);
    expect(executed).toEqual([]);
    expect(queue.list()).toEqual([]);
  });

  test('denial wakes the agent too, and says so in the owner\'s terms', async () => {
    const { shellTool, queue, delivered } = setup();
    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);

    await queue.decide(['defer-1'], 'denied');

    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain('DENIED: do not re-issue');
  });

  test('a night of parked actions is ONE decision and ONE wake', async () => {
    // Bulk decisions produce one wake, not one per command.
    const { shellTool, queue, delivered } = setup();

    for (const command of ['npm publish a', 'npm publish b', 'npm publish c', 'npm publish d', 'npm publish e']) {
      await expect(shellTool.execute({ command })).rejects.toBeInstanceOf(KinuError);
    }

    expect(queue.list()).toHaveLength(5);

    const decided = await queue.decide(queue.list().map((a) => a.id), 'approved');

    expect(decided).toHaveLength(5);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].metadata).toMatchObject({ decision: 'approved', count: 5 });

    for (const command of ['npm publish a', 'npm publish e']) expect(delivered[0].text).toContain(command);
    expect(queue.list()).toEqual([]);
  });

  test('a mixed batch names which are which', async () => {
    const { shellTool, queue, delivered } = setup();
    await expect(shellTool.execute({ command: 'npm publish a' })).rejects.toBeInstanceOf(KinuError);
    await expect(shellTool.execute({ command: 'npm publish b' })).rejects.toBeInstanceOf(KinuError);

    await queue.decide(['defer-1'], 'approved');
    await queue.decide(['defer-2'], 'denied');

    expect(delivered[0].text).toContain('APPROVED');
    expect(delivered[0].text).not.toContain('DENIED');
    expect(delivered[1].text).toContain('DENIED');
    expect(delivered[1].text).not.toContain('APPROVED');
  });

  test('deciding an already-decided action changes nothing and wakes nobody', async () => {
    const { shellTool, queue, delivered } = setup();
    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);
    await queue.decide(['defer-1'], 'approved');

    expect(await queue.decide(['defer-1'], 'denied')).toEqual([]);
    expect(await queue.decide(['defer-nonexistent'], 'approved')).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  test('one id sent twice is one decision, not two', async () => {
    const { shellTool, queue, delivered } = setup();
    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);

    const decided = await queue.decide(['defer-1', 'defer-1'], 'approved');

    expect(decided.map((a) => a.id)).toEqual(['defer-1']);
    expect(delivered[0].metadata).toMatchObject({ count: 1 });
  });
});

describe('what an approval actually buys', () => {
  test('the approved command runs when the AGENT re-issues it — and only then', async () => {
    const { shellTool, queue, executed } = setup();
    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);
    await queue.decide(['defer-1'], 'approved');
    expect(executed).toEqual([]);

    expect(await shellTool.execute({ command: GATED })).toBe('ran');
    expect(executed).toEqual([GATED]);
  });

  test('one approval authorises exactly one run', async () => {
    const { shellTool, queue, executed } = setup();
    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);
    await queue.decide(['defer-1'], 'approved');

    expect(await shellTool.execute({ command: GATED })).toBe('ran');
    const second = shellTool.execute({ command: GATED })

    await expect(second).rejects.toMatchObject({ message: expect.stringContaining('NOT RUN') });
    expect(executed).toEqual([GATED]);
    expect(queue.list().map((a) => a.id)).toEqual(['defer-2']);
  });

  test('an approval never travels to a different command', async () => {
    const { shellTool, queue, executed } = setup();
    await expect(shellTool.execute({ command: 'npm publish a' })).rejects.toBeInstanceOf(KinuError);
    await queue.decide(['defer-1'], 'approved');

    await expect(shellTool.execute({ command: 'npm publish b' })).rejects.toMatchObject({ message: expect.stringContaining('NOT RUN') });
    expect(executed).toEqual([]);
  });

  test('a refused command reports the refusal on re-issue instead of re-asking', async () => {
    const { shellTool, queue, executed } = setup();
    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);
    await queue.decide(['defer-1'], 'denied');

    const out = shellTool.execute({ command: GATED })

    await expect(out).rejects.toMatchObject({ message: expect.stringContaining('NOT RUN: the owner refused this (defer-1). Not a timeout; find another way.') });
    expect(executed).toEqual([]);
    expect(queue.list()).toEqual([]);
  });

  test('a refusal stands for a bounded time, then the row is gone and the queue asks again', async () => {
    // A denial answers this ask only: the row expires rather than standing forever.
    const { shellTool, queue, store, executed, advance } = setup();
    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);
    await queue.decide(['defer-1'], 'denied');
    await expect(shellTool.execute({ command: GATED })).rejects.toMatchObject({ message: expect.stringContaining('the owner refused this (defer-1)') });

    advance(DENIAL_STANDING_MS + 1);
    const out = shellTool.execute({ command: GATED })

    await expect(out).rejects.toMatchObject({ message: expect.stringContaining('NOT RUN: queued for owner approval (defer-2)') });
    expect(executed).toEqual([]);
    expect(queue.list().map((a) => a.id)).toEqual(['defer-2']);
    expect(store.get('defer-1')).toBeNull();
  });

  test('an expired refusal is swept even when nothing re-issues its command', async () => {
    const { shellTool, queue, store, advance } = setup();
    await expect(shellTool.execute({ command: 'npm publish a' })).rejects.toBeInstanceOf(KinuError);
    await queue.decide(['defer-1'], 'denied');
    advance(DENIAL_STANDING_MS + 1);

    // Any write to the queue is a sweep: here, the owner deciding something else.
    await expect(shellTool.execute({ command: 'npm publish b' })).rejects.toBeInstanceOf(KinuError);
    await queue.decide(['defer-2'], 'approved');

    expect(store.get('defer-1')).toBeNull();
    expect(store.hits('defer-1')).toEqual([]);
    expect(store.get('defer-2')?.status).toBe('approved');
    expect(store.hits('defer-2')).toEqual([{ rule: 'package-publish', decision: 'gate' }]);
  });

  test('"always" runs this command AND stops the queue asking about that rule again', async () => {
    // A grant covers similar commands, not only this exact string.
    const { shellTool, queue, executed, granted, delivered } = setup();
    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);

    await queue.decide(['defer-1'], 'always');

    expect(granted).toEqual(['git-force-push@workspace']);
    expect(executed).toEqual([]);
    expect(await shellTool.execute({ command: GATED })).toBe('ran');

    const different = 'git push --force origin release';
    expect(await shellTool.execute({ command: different })).toBe('ran');
    expect(executed).toEqual([GATED, different]);
    expect(queue.list()).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  test('"always" on a command that harms the user\'s files grants that rule, so the next one runs', async () => {
    const { shellTool, queue, executed, granted } = setup({ filesOwner: 'user' });
    await expect(shellTool.execute({ command: 'rm -rf build' })).rejects.toMatchObject({ message: expect.stringContaining('NOT RUN') });

    await queue.decide(['defer-1'], 'always');

    expect(granted).toEqual(['rm-recursive@workspace']);
    expect(await shellTool.execute({ command: 'rm -rf dist' })).toBe('ran');
    expect(executed).toEqual(['rm -rf dist']);
  });

  test('the reason text is display only: rewording it keeps what "always" grants and what the agent is told', async () => {
    // A row parked under older reason wording.
    const { shellTool, queue, store, granted, sql } = setup();
    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);
    void sql`UPDATE deferred_approvals SET reason = ${'Needs approval: force-pushing rewrites the remote.'}`;

    expect(store.get('defer-1')?.reason).toBe('Needs approval: force-pushing rewrites the remote.');
    await expect(shellTool.execute({ command: GATED })).rejects.toMatchObject({ message: expect.stringContaining('git-force-push') });

    await queue.decide(['defer-1'], 'always');

    expect(granted).toEqual(['git-force-push@workspace']);
  });

  test('an "always" grant does not travel to another rule', async () => {
    const { shellTool, queue, executed, granted } = setup();
    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);
    await queue.decide(['defer-1'], 'always');

    expect(granted).toEqual(['git-force-push@workspace']);
    await expect(shellTool.execute({ command: 'npm publish' })).rejects.toMatchObject({ message: expect.stringContaining('NOT RUN') });
    expect(executed).toEqual([]);
  });
});

describe('the spent grant leaves an audit, and no row the gate did not close', () => {
  test('consuming a grant records the approval once and deletes its row', async () => {
    const { shellTool, queue, store, audited } = setup();
    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);
    await queue.decide(['defer-1'], 'approved');

    expect(await shellTool.execute({ command: GATED })).toBe('ran');
    expect(audited).toEqual([
      { approvalId: 'defer-1', command: GATED, executor: 'workspace' },
    ]);
    // The row is deleted, not flipped to a terminal status.
    expect(store.get('defer-1')).toBeNull();
    expect(store.hits('defer-1')).toEqual([]);
  });

  test('one grant is one audit and one run — a re-issue parks, never replays', async () => {
    const { shellTool, queue, executed, audited } = setup();
    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);
    await queue.decide(['defer-1'], 'approved');

    await expect(shellTool.execute({ command: GATED })).resolves.toBe('ran');
    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);

    expect(executed).toEqual([GATED]);
    expect(audited).toHaveLength(1);
  });

  test('store.spend hands the grant out once, and a settle finishes it', () => {
    // While spent, the row is invisible to `standing()` and a second spend gets nothing.
    const { sql, actor } = approvalsDb();
    const store = new DeferredApprovalStore(sql, actor);
    store.create({ id: 'defer-s', command: GATED, executor: 'workspace', reason: 'gate', requestedAt: 1 }, []);
    expect(store.decide('defer-s', 'approved', 2)?.status).toBe('approved');

    const spent = store.spend('defer-s');
    expect(spent?.action.id).toBe('defer-s');
    expect(store.spend('defer-s')).toBeNull();
    expect(store.standing(GATED, 'workspace', 3)).toBeNull();

    if (!spent) throw new Error('an approved grant must be spendable');

    expect(store.settle(spent.spend, 'spent')).toBe(true);
    expect(store.get('defer-s')).toBeNull();
    expect(store.settle(spent.spend, 'did-not-run')).toBe(false);
    expect(store.standing(GATED, 'workspace', 3)).toBeNull();
  });

  test('re-opening the workspace keeps parked and approved rows intact', () => {
    const { db, sql, actor } = approvalsDb();
    const store = new DeferredApprovalStore(sql, actor);
    store.create({ id: 'defer-parked', command: GATED, executor: 'workspace', reason: 'gate', requestedAt: 1 }, []);
    store.create({ id: 'defer-blessed', command: `${GATED} --twice`, executor: 'workspace', reason: 'gate', requestedAt: 2 }, []);
    expect(store.decide('defer-blessed', 'approved', 3)?.status).toBe('approved');

    initDeferredApprovalsTable(makeExecRaw(db));
    const reopened = new DeferredApprovalStore(sql, actor);
    expect(reopened.get('defer-parked')?.status).toBe('queued');
    expect(reopened.get('defer-blessed')?.status).toBe('approved');
    expect(reopened.standing(GATED, 'workspace', 6)?.id).toBe('defer-parked');
  });
});

describe('the parked action stays visible until it is decided', () => {
  test('every step of the turn re-states that it has not happened', () => {
    // The per-step dynamic-context block carries the missing effect until the owner answers.
    const { queue, store } = setup();
    store.create({ id: 'defer-x', command: GATED, executor: 'workspace', reason: 'gate', requestedAt: 10 }, []);

    expect(queue.approvals()).toEqual([
      { id: 'defer-x', kind: 'queued command (NOT run)', detail: GATED },
    ]);
  });

  test('and stops the moment it is decided', async () => {
    const { shellTool, queue } = setup();
    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);
    expect(queue.approvals()).toHaveLength(1);

    await queue.decide(['defer-1'], 'approved');

    expect(queue.approvals()).toEqual([]);
  });

  test('it is a needs-you row the owner can act on', async () => {
    const { shellTool, queue } = setup();
    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);

    const rows = buildPendingActions({
      scaffoldVersions: [], curriculum: [], pendingPlans: [],
      unseenChanges: { count: 0, revertable: 0, latestAt: 0 },
      deferredActions: queue.list(),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'defer-1', kind: 'deferred_action', detail: GATED });
  });
});

describe('durability — the wait is a night, not a prompt window', () => {
  test('the queue survives the process that parked the action', async () => {
    // A parked action must survive DO eviction; a promise map would lose it.
    const { sql, actor } = approvalsDb();
    const first = new DeferredApprovalStore(sql, actor);
    first.create({ id: 'defer-9', command: GATED, executor: 'workspace', reason: 'gate', requestedAt: 5 }, []);

    const reopened = new DeferredApprovalStore(sql, actor);
    const parked = reopened.listQueued();

    expect(parked.map((a: DeferredApproval) => a.id)).toEqual(['defer-9']);
    expect(reopened.standing(GATED, 'workspace', 6)?.status).toBe('queued');
  });

  test('the decision is durable before the wake is attempted', async () => {
    // The row is the record; the signal is only the notification.
    const { sql, actor } = approvalsDb();
    const store = new DeferredApprovalStore(sql, actor);
    store.create({ id: 'defer-7', command: GATED, executor: 'workspace', reason: 'gate', requestedAt: 5 }, []);

    const queue = new DeferredApprovalQueue({
      writes: null,
      store,
      inbox: { send: () => Promise.reject(new Error('no host')) },
      remember: () => { throw new Error('not an always answer'); },
    });

    await expect(queue.decide(['defer-7'], 'approved')).rejects.toThrow('no host');
    expect(store.get('defer-7')?.status).toBe('approved');
  });
});

describe('"always" grants the rules the owner was shown', () => {
  /** A workspace over the user's device and Drive, gated over the real deferral queue with nobody attending. */
  function workspaceSetup() {
    const { sql, actor } = approvalsDb();
    let seq = 0;
    const granted: string[] = [];

    const queue = new DeferredApprovalQueue({
      writes: null,
      store: new DeferredApprovalStore(sql, actor),
      inbox: { send: async () => 'queued' },
      remember: (grants) => { for (const g of grants) granted.push(formatApprovalGrant(g)); },
      newId: () => `defer-${++seq}`,
      now: () => 1_000 + seq,
    });

    const ran: string[] = [];

    const record = (member: string) => async (...args: unknown[]) => {
      ran.push(`${member} ${String(args[0])}`);

      return 'ran';
    };

    const provider: ExecutorProvider = {
      name: 'workspace',
      kind: 'workspace',
      capabilities: new Set(['shell']),
      filesOwner: 'agent',
      shellSession: createShellSession({ home: WORKSPACE_ROOT, userRoots: () => ['/pc', '/shared'] }),
      homeDir: async () => WORKSPACE_ROOT,
      isAvailable: () => true,
      connect: async () => {},
      disconnect: async () => {},
      tools: {
        runCode: { description: 'Run a program', execute: record('code') },
        startProcess: { description: 'Start a background process', execute: record('start') },
      },
    };

    const { tools } = gateProviderExec(provider, {
      mode: () => 'strict',
      granted: (grant) => granted.includes(formatApprovalGrant(grant)),
      deferrals: queue.channel,
    });

    return { queue, tools, ran, granted };
  }

  test('"always" for a program over the user\'s files lets the next identical program run', async () => {
    const { queue, tools, ran, granted } = workspaceSetup();
    const program = "import shutil; shutil.rmtree('/shared/notes')";
    const run = () => tools.runCode?.execute(program, { language: 'python' });

    expect(await run()).toMatchObject({ error: expect.stringContaining('defer-1') });
    await queue.decide(['defer-1'], 'always');

    expect(granted).toEqual(['program-on-user-files@workspace']);
    expect(await run()).toBe('ran');
    expect(ran).toEqual([`code ${program}`]);
  });

  test('"always" for a process started in the user\'s files lets the next one started there run', async () => {
    const { queue, tools, ran, granted } = workspaceSetup();
    const start = () => tools.startProcess?.execute('rm -rf build', { cwd: '/pc/laptop/proj' });

    expect(await start()).toMatchObject({ error: expect.stringContaining('defer-1') });
    await queue.decide(['defer-1'], 'always');

    expect(granted).toEqual(['rm-recursive@workspace']);
    expect(await start()).toBe('ran');
    expect(ran).toEqual(['start rm -rf build']);
  });
});

/**
 * Approving once must not cause a second ask: a grant spent on an attempt that never reached its
 * machine (classified refusal) is refunded. Spend-before-run otherwise holds.
 */
describe('an approval outlives an attempt that never reached the machine', () => {
  /** Device seam: an ExecutorProvider gated by `gateProviderExec` over the real deferral queue. */
  function deviceSetup() {
    const { sql, actor } = approvalsDb();
    const store = new DeferredApprovalStore(sql, actor);
    let seq = 0;
    const audited: Array<{ approvalId: string; command: string; executor: string }> = [];

    const queue = new DeferredApprovalQueue({
      writes: null,
      store,
      inbox: { send: async () => 'queued' },
      remember: () => { throw new Error('not an always answer'); },
      newId: () => `defer-${++seq}`,
      now: () => 1_000 + seq,
      audit: (record) => { audited.push(record); },
    });

    const executed: string[] = [];
    /** What the machine answers; swapped per phase. */
    let answer: () => CommandResult = () => 'ran';

    const provider: ExecutorProvider = {
      name: 'device',
      kind: 'device',
      capabilities: new Set(['shell']),
      filesOwner: 'user',
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

    const exec = (command: string) => gated.tools.exec?.execute(command);

    return {
      queue, store, exec, executed, audited,
      answerWith: (next: () => CommandResult) => { answer = next; },
    };
  }

  /** `unavailable`: the device path's no-machine refusal code. The test reads the code, never the prose. */
  const notConnected = () => refusalOf(new KinuError('unavailable', 'No device connected.'));

  test('a definitive did-not-run leaves the grant spendable and asks nobody again', async () => {
    const { queue, store, exec, executed, answerWith } = deviceSetup();
    answerWith(notConnected);

    expect(await exec(GATED)).toMatchObject({ reason: 'unavailable', error: expect.stringContaining('defer-1') });
    await queue.decide(['defer-1'], 'approved');

    expect(await exec(GATED)).toMatchObject({ reason: 'unavailable' });
    expect(executed).toEqual([GATED]);

    // No run happened, so the grant is still spendable.
    expect(store.standing(GATED, 'device', 1_010)?.status).toBe('approved');
    expect(store.standing(GATED, 'device', 1_010)?.id).toBe('defer-1');
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
    expect(store.standing(GATED, 'device', 1_010)).toBeNull();
    expect(store.get('defer-1')).toBeNull();
    expect(audited).toEqual([{ approvalId: 'defer-1', command: GATED, executor: 'device' }]);
    expect(await exec(GATED)).toMatchObject({ reason: 'unavailable', error: expect.stringContaining('defer-2') });
  });

  test('successful refusal-shaped stdout spends the grant rather than refunding it', async () => {
    const { queue, store, exec, executed, answerWith } = deviceSetup();
    const stdout = JSON.stringify({ reason: 'unavailable', error: 'historical incident' });
    answerWith(() => stdout);
    await exec(GATED);
    await queue.decide(['defer-1'], 'approved');
    expect(await exec(GATED)).toBe(stdout);
    expect(executed).toEqual([GATED]);
    expect(store.standing(GATED, 'device', 1_010)).toBeNull();
  });

  test('a command that reached the machine and FAILED there does not refund', async () => {
    // Negative control: a non-zero exit ran, so the approval is spent.
    const { queue, store, exec, answerWith } = deviceSetup();
    answerWith(notConnected);
    await exec(GATED);
    await queue.decide(['defer-1'], 'approved');

    answerWith(() => commandResult({ stdout: '', stderr: 'rejected', exitCode: 1 }));
    expect(await exec(GATED)).toMatchObject({ reason: 'io' });

    expect(store.standing(GATED, 'device', 1_010)).toBeNull();
    expect(store.get('defer-1')).toBeNull();
  });

  test('an UNCLASSIFIABLE failure does not refund', async () => {
    // `io` is unclassified: the frame may have run, so the grant stays spent.
    const { queue, store, exec, answerWith } = deviceSetup();
    answerWith(notConnected);
    await exec(GATED);
    await queue.decide(['defer-1'], 'approved');

    answerWith(() => refusalOf(new KinuError('io', 'the tunnel closed mid-call')));
    expect(await exec(GATED)).toMatchObject({ reason: 'io' });

    expect(store.standing(GATED, 'device', 1_010)).toBeNull();
  });

  test('a throw out of the executor does not refund', async () => {
    const { queue, store, exec, answerWith } = deviceSetup();
    answerWith(notConnected);
    await exec(GATED);
    await queue.decide(['defer-1'], 'approved');

    answerWith(() => { throw new Error('socket died'); });
    await expect(exec(GATED)).rejects.toThrow('socket died');

    expect(store.standing(GATED, 'device', 1_010)).toBeNull();
  });

  test('two refunds of one spend change nothing', async () => {
    // The refund is a transition on the same row; a replay must not resurrect a later-spent grant.
    const { queue, store, exec, answerWith } = deviceSetup();
    answerWith(notConnected);
    await exec(GATED);
    await queue.decide(['defer-1'], 'approved');

    const spend = store.spend('defer-1');
    expect(spend).not.toBeNull();

    if (!spend) throw new Error('the approved grant must be spendable');

    await queue.channel.settle(spend.spend, 'did-not-run');
    expect(store.standing(GATED, 'device', 1_010)?.id).toBe('defer-1');

    await queue.channel.settle(spend.spend, 'did-not-run');
    expect(store.standing(GATED, 'device', 1_010)?.id).toBe('defer-1');

    const second = store.spend('defer-1');
    expect(second).not.toBeNull();

    if (!second) throw new Error('the refunded grant must be spendable again');
    await queue.channel.settle(second.spend, 'spent');
    await queue.channel.settle(spend.spend, 'did-not-run');
    expect(store.standing(GATED, 'device', 1_010)).toBeNull();
    expect(store.get('defer-1')).toBeNull();
  });

  test('a refund beside a second re-issue answers the grant, not the fresh ask', async () => {
    // A second re-issue can park a new row between the first spend and its refund; that row must stay queued.
    const { queue, store, exec, executed, answerWith } = deviceSetup();
    answerWith(notConnected);
    await exec(GATED);
    await queue.decide(['defer-1'], 'approved');

    // Consumer A takes the grant.
    const spend = store.spend('defer-1');

    if (!spend) throw new Error('the approved grant must be spendable');
    // Consumer B parks its own row.
    expect(await exec(GATED)).toMatchObject({ error: expect.stringContaining('NOT RUN: queued for owner approval (defer-2)') });
    // A never reached the machine, so the grant comes back beside defer-2.
    await queue.channel.settle(spend.spend, 'did-not-run');

    answerWith(() => 'ran');
    expect(await exec(GATED)).toBe('ran');
    expect(executed).toEqual([GATED]);
    // defer-2 is still the owner's to answer; the grant is gone for good.
    expect(store.get('defer-1')).toBeNull();
    expect(queue.list().map((a) => a.id)).toEqual(['defer-2']);
  });
});

test('no-execution refusals retain their class before native run and executor text formatting', async () => {
  const denied = setup({ mode: 'deny_all' });
  await expect(denied.shellTool.execute({ command: GATED })).rejects.toMatchObject({ code: 'denied' });
  expect(denied.executed).toEqual([]);
  const parked = setup();
  const result = await parked.shell.exec(GATED);
  expect(result.refusal).toMatchObject({ reason: 'unavailable' });
  expect(parked.executed).toEqual([]);
  expect(parked.queue.list()).toMatchObject([{ status: 'queued', command: GATED }]);
  await parked.queue.decide(['defer-1'], 'denied');
  await expect(parked.shellTool.execute({ command: GATED })).rejects.toMatchObject({ code: 'denied' });
  expect(parked.executed).toEqual([]);
});

test('an executed exit-one command remains a command failure even if stdout looks like a refusal', async () => {
  const stdout = JSON.stringify({ reason: 'denied', error: 'ordinary command data' });
  const shell = withApprovalGatedShell({ exec: async () => ({ stdout, stderr: 'process failure', exitCode: 1 }) }, AGENTS_OWN);
  const result = await shell.exec('false');
  const rendered = formatExecResult(result);
  expect(result.exitCode).toBe(1);
  expect(result.refusal).toBeUndefined();
  expect(commandResult(result)).toMatchObject({ reason: 'io', execution: { exitCode: 1 } });
  expect(rendered).toContain(stdout);
  expect(rendered).toContain('process failure');
});

/** The kernel's view of the workspace file plane, where parked bytes live. */
async function kernelFiles() {
  const session = await createWorkspaceBundle(createTestWorkspace().db).session();

  return session.vfs.as(CRED_KERNEL);
}

/** Found under the kernel's /etc by digest, not restated from the store's constant. */
function parkedFile(kernel: Awaited<ReturnType<typeof kernelFiles>>, digest: string): string | null {
  for (const { name } of kernel.readdir('/etc')) {
    if (kernel.exists(`/etc/${name}/${digest}`)) return `/etc/${name}/${digest}`;
  }

  return null;
}

const sha256 = (text: string | Uint8Array): string => new Bun.CryptoHasher('sha256').update(text).digest('hex');

/** The owner's Drive at /shared, over the agent's own files, with a queue nobody has answered yet; parked bytes live
 *  on a real workspace file plane. */
async function driveWithQueue(perform: (plane: VFS, write: BoundFileWrite, bytes: Uint8Array) => Promise<'written' | 'changed'> = performBoundWrite) {
  const { sql, actor } = approvalsDb();
  const store = new DeferredApprovalStore(sql, actor);
  const drive = mossaicVfs(fakeMossaic().tenant('owner'));
  const plane = withMountTable(createMemoryVfs().vfs, [sharedDriveMount(() => drive, () => 'no Drive')]);
  const kernel = await kernelFiles();
  const woken: string[] = [];
  let seq = 0;

  const queue = new DeferredApprovalQueue({
    store, remember: () => {}, newId: () => `defer-${String(++seq)}`,
    inbox: { send: async (signal) => {
      woken.push(signal.text);

      return 'queued';
    } },
    writes: {
      content: new ParkedWriteFiles(async () => kernel),
      perform: (write, bytes) => perform(plane, write, bytes),
    },
  });

  const policy: ShellApprovalPolicy = { mode: () => 'strict', deferrals: queue.channel };
  const files = withApprovalGatedFiles(plane, 'workspace', { planes: cloudPlanes(WORKSPACE_ROOT), userRoots: () => plane.userRoots(), locate: null, parksWrites: true }, policy);

  return { drive, files, queue, store, woken, kernel };
}

test('a new file on the Drive is free; an overwrite parks, and a write that fails on approval waits for the same bytes', async () => {
  let outage = true;

  const { drive, files, queue, store, woken } = await driveWithQueue(async (plane, write, bytes) => {
    if (outage) throw new KinuError('unavailable', 'the Drive is not answering');

    return await performBoundWrite(plane, write, bytes);
  });

  await writeText(files, '/shared/new.md', 'created\n');
  await writeText(drive, '/notes.md', 'the owner\u2019s\n');
  await expect(writeText(files, '/shared/notes.md', 'rewritten\n')).rejects.toMatchObject({ code: 'unavailable' });
  expect(queue.list().map((row) => row.command)).toEqual([expect.stringMatching(/^file write \/shared\/notes\.md sha256:[0-9a-f]{64} over sha256:[0-9a-f]{64}$/u)]);

  await queue.decide(['defer-1'], 'approved');
  expect(await readText(drive, '/notes.md')).toBe('the owner\u2019s\n');
  expect(store.get('defer-1')?.status).toBe('approved');
  expect(woken.at(-1)).toContain('APPROVED, still not run: re-issue once');

  outage = false;
  await writeText(files, '/shared/notes.md', 'rewritten\n');
  expect(await readText(drive, '/notes.md')).toBe('rewritten\n');
  expect(await readText(drive, '/new.md')).toBe('created\n');
  expect(store.get('defer-1')).toBeNull();
});

test('a parked write that is denied leaves no bytes behind', async () => {
  const { drive, files, queue, kernel } = await driveWithQueue();

  await writeText(drive, '/notes.md', 'the owner\u2019s\n');
  await expect(writeText(files, '/shared/notes.md', 'rewritten\n')).rejects.toMatchObject({ code: 'unavailable' });
  expect(parkedFile(kernel, sha256('rewritten\n'))).not.toBeNull();

  await queue.decide(['defer-1'], 'denied');
  expect(parkedFile(kernel, sha256('rewritten\n'))).toBeNull();
  expect(await readText(drive, '/notes.md')).toBe('the owner\u2019s\n');
});

test('two parked writes of the same bytes keep them until both close', async () => {
  const { drive, files, queue, kernel } = await driveWithQueue();
  const same = sha256('one template\n');

  await writeText(drive, '/a.md', 'a\n');
  await writeText(drive, '/b.md', 'b\n');
  await expect(writeText(files, '/shared/a.md', 'one template\n')).rejects.toMatchObject({ code: 'unavailable' });
  await expect(writeText(files, '/shared/b.md', 'one template\n')).rejects.toMatchObject({ code: 'unavailable' });
  expect(queue.list()).toHaveLength(2);

  await queue.decide(['defer-1'], 'denied');
  expect(parkedFile(kernel, same)).not.toBeNull();

  await queue.decide(['defer-2'], 'approved');
  expect(await readText(drive, '/b.md')).toBe('one template\n');
  expect(await readText(drive, '/a.md')).toBe('a\n');
  expect(parkedFile(kernel, same)).toBeNull();
});

test('a write larger than one storage chunk parks and lands byte for byte', async () => {
  const { drive, files, queue, kernel } = await driveWithQueue();
  const big = Uint8Array.from({ length: 3 * CHUNK_SIZE + 17 }, (_, index) => (index * 31) % 251 || 1);

  await writeText(drive, '/big.bin', 'small\n');
  await expect(files.writeFile('/shared/big.bin', big)).rejects.toMatchObject({ code: 'unavailable' });

  await queue.decide(['defer-1'], 'approved');
  const landed = await drive.readFile('/big.bin');

  expect(landed instanceof Uint8Array ? landed : new TextEncoder().encode(landed)).toEqual(big);
  expect(parkedFile(kernel, sha256(big))).toBeNull();
});
