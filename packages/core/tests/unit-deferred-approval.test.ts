import { readText, type VFS, writeText } from '@nimbus-sh/core/vfs/vfs.js';
// Deferred approval: a gated command in an unattended run parks durably. A queued action is
// never reported as a success, and an approval is never reported as an effect.
import { describe, test, expect } from 'bun:test';
import { Effect } from 'effect';
import { Database } from 'bun:sqlite';
import { createMemoryVfs, fakeCommandMember, fakeMossaic, toolExecute, createRecordingLogger, NO_JOBS } from '@kinu.run/test-utils';
import { sessionFilesOver, type SessionBox } from '@kinu.run/test-utils/vfs';
import { DeferredApprovalQueue, DeferredApprovalStore, initDeferredApprovalsTable, DEFERRED_APPROVAL_SIGNAL, DENIAL_STANDING_MS, withApprovalGatedShell, buildBuiltinTools, reviewCommand, actorReferenceOf, type DeferredApprovalChannel, formatApprovalGrant, createShellSession, hostedToolFiles, performBoundWrite, withMountTable, sharedDriveMount, mossaicVfs, ParkedWriteFiles, type DeferredApproval, type ExecutionContext, type ParkedWrites, type ShellApprovalPolicy, type ShellApprovalOutcome, type ShellApprovalRequest, type AgentRuntime, type AgentSignal, type FilesOwner, type Shell, WORKSPACE_ROOT, createNimbusWorkspaceExecutor, nimbusSessionFiles, nimbusSessionShell } from '../src/index';
import type { BoundFileWrite } from '../src/safety/bound-write';
import { RESUMED_SURFACE, type InvocationSurface } from '../src/types/jobs';
import { CHUNK_SIZE } from '@nimbus-sh/core/constants.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { buildPendingActions } from '../src/read-models/pending-actions';
import { gateProviderExec } from '../src/execution/approval';
import { commandResultAt, formatExecResult, type CommandResult } from '../src/execution/exec-result';
import { setDiagnosticsSink, KinuError, refusalOf } from '../src/obs/index';
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
  approve?: (req: ShellApprovalRequest, signal: AbortSignal) => Promise<ShellApprovalOutcome | null>;
  /** Omit the queue: the no-queue path must behave as if deferral did not exist. */
  noQueue?: boolean;
  /** Whose files the gated shell holds. */
  filesOwner?: FilesOwner;
  /** Where parked writes' bytes live; none by default. */
  writes?: ParkedWrites;
  /** The surface of the turn each call is made in, as the root agent's channel reads it; none by default. */
  surface?: () => InvocationSurface;
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
  const audited: Array<{ approvalId: string; actor: string; command: string; executor: string }> = [];

  const queue = new DeferredApprovalQueue({
    writes: opts.writes ?? null,
    store,
    wake: (_actor, signal) => Effect.sync(() => { delivered.push(signal); }),
    remember: (grants) => { for (const g of grants) granted.push(formatApprovalGrant(g)); },
    newId: () => `defer-${++seq}`,
    now: () => 1_000 + seq + elapsed,
    audit: (record) => { audited.push(record); },
  });

  const executed: string[] = [];
  /** How many grants the owner held as each command ran. */
  const grantsAtRun: number[] = [];
  /** Each command as it ran, with the directory and named shell its call asked for. */
  const ranWith: Array<{ readonly command: string; readonly cwd?: string; readonly name?: string }> = [];
  const ran = Promise.withResolvers<void>();

  const rawShell: Shell = {
    exec: async (command: string, options) => {
      executed.push(String(command));
      ranWith.push({ command, ...(typeof options === 'object' && { cwd: options.cwd, name: options.name }) });
      grantsAtRun.push(granted.length);
      ran.resolve();

      return { stdout: 'ran', stderr: '', exitCode: 0 };
    },
  };

  const policy: ShellApprovalPolicy = {
    mode: () => opts.mode ?? 'strict',
    granted: (grant) => granted.includes(formatApprovalGrant(grant)),
  };

  if (opts.approve) policy.requestApproval = opts.approve;

  if (!opts.noQueue) policy.deferrals = opts.surface === undefined ? queue.channel : queue.channelFor(store.actorId, opts.surface);
  const shell = withApprovalGatedShell(rawShell, { ...AGENTS_OWN, filesOwner }, policy);
  const { rt } = createTestRuntime();
  const runtime: AgentRuntime = { ...rt, shell };
  const tools = buildBuiltinTools({ rt: runtime, conversations: conversationsFor(runtime) });

  const shellTool: ShellTool = {
    execute: toolExecute<{ command: string; runtime?: string }, string>(tools.shell),
  };

  return {
    queue, store, sql, shell, executed, ranWith, grantsAtRun, ran: ran.promise, delivered, granted, audited, shellTool,
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
      wake: () => Effect.void, remember: () => {},
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
    await expect(shellTool.execute({ command: GATED })).rejects.toMatchObject({ message: expect.stringContaining('the owner refused this') });
    expect(queue.list()).toEqual([]);
  });

  test('a channel that declines to decide falls through to the queue', async () => {
    // Attached but nobody answering (`null`) parks instead of refusing.
    const { shellTool, queue } = setup({ approve: async () => null });
    await expect(shellTool.execute({ command: GATED })).rejects.toMatchObject({ message: expect.stringContaining('NOT RUN') });
    expect(queue.list()).toHaveLength(1);
  });

  /** A live prompt the test answers: each shows the ask's row, and its signal says another surface decided it. */
  function livePrompts(shown: number) {
    const prompts: Array<{
      readonly id: string | undefined; readonly context: ExecutionContext; readonly signal: AbortSignal; answer(outcome: ShellApprovalOutcome | null): void;
    }> = [];

    const all = Promise.withResolvers<void>();

    const approve = (req: ShellApprovalRequest, signal: AbortSignal) => new Promise<ShellApprovalOutcome | null>((resolve) => {
      prompts.push({ id: req.approvalId, context: req.context, signal, answer: resolve });

      if (prompts.length === shown) all.resolve();
    });

    return { prompts, approve, shown: all.promise };
  }

  test('two live asks of one command are one row: a prompt that goes away parks it, the other\'s answer runs it once', async () => {
    const live = livePrompts(2);
    const { shellTool, executed, queue, delivered } = setup({ approve: live.approve });
    const first = shellTool.execute({ command: GATED });
    const second = shellTool.execute({ command: GATED });

    await live.shown;
    expect(live.prompts.map((prompt) => prompt.id)).toEqual(['defer-1', 'defer-1']);
    expect(queue.list()).toHaveLength(1);

    // The chat unmounts under the first prompt: that ask is NOT RUN, and the row waits on the queue.
    live.prompts[0]?.answer(null);
    await expect(first).rejects.toMatchObject({ message: expect.stringContaining('NOT RUN') });
    expect(queue.list()).toHaveLength(1);

    // The owner approves on the other prompt: the row is decided once and its ask runs on it, spent.
    live.prompts[1]?.answer('allow');
    expect(await second).toBe('ran');
    expect(executed).toEqual([GATED]);
    expect(queue.list()).toEqual([]);
    // The asker heard the answer where it waited; nothing is left to wake it with.
    expect(delivered).toEqual([]);
  });

  test('the same words in two directories are two asks: approving one runs it there and nowhere else', async () => {
    const live = livePrompts(2);
    const { shell, ranWith, queue } = setup({ approve: live.approve });
    const inA = shell.exec(GATED, { cwd: '/repo-a' });
    const inB = shell.exec(GATED, { cwd: '/repo-b', name: 'release' });

    await live.shown;
    // Each prompt shows its own row, and says where it runs.
    expect(new Set(live.prompts.map((prompt) => prompt.id)).size).toBe(2);
    expect(queue.list()).toHaveLength(2);
    const [atA, atB] = ['/repo-a', '/repo-b'].map((dir) => live.prompts.find((prompt) => prompt.context.cwd === dir));
    expect(atB?.context.shell).toBe('release');

    atA?.answer('allow');
    expect((await inA).exitCode).toBe(0);
    expect(ranWith).toEqual([{ command: GATED, cwd: '/repo-a', name: undefined }]);
    // The other place is still the owner's to decide.
    expect(atB?.signal.aborted).toBe(false);
    expect(queue.list()).toHaveLength(1);

    atB?.answer('deny');
    expect((await inB).exitCode).not.toBe(0);
    expect(ranWith).toHaveLength(1);
  });

  test('two asks waiting on one row: a once-answer runs one of them, the other hears it was used, and no row is added', async () => {
    const live = livePrompts(2);
    const { shellTool, executed, queue, delivered } = setup({ approve: live.approve });
    const first = shellTool.execute({ command: GATED });
    const second = shellTool.execute({ command: GATED });

    await live.shown;
    live.prompts[0]?.answer('allow');
    const answers = await Promise.allSettled([first, second]);

    expect(answers.filter((answer) => answer.status === 'fulfilled')).toHaveLength(1);
    expect(answers.find((answer) => answer.status === 'rejected')).toMatchObject({ reason: { message: expect.stringContaining('approved this once') } });
    expect(executed).toEqual([GATED]);
    expect(queue.list()).toEqual([]);
    expect(delivered).toEqual([]);
  });

  test('a decision another surface records as the live prompt goes away stands for the ask', async () => {
    const live = livePrompts(1);
    const { shellTool, executed, delivered, queue } = setup({ approve: live.approve });
    const asking = shellTool.execute({ command: GATED });

    await live.shown;
    // Both in one tick: the web's approval, then the chat unmounting under the prompt.
    const deciding = queue.decide(['defer-1'], 'approved');
    live.prompts[0]?.answer(null);

    expect(await asking).toBe('ran');
    await deciding;
    expect({ executed, delivered }).toEqual({ executed: [GATED], delivered: [] });
  });

  test('an always-answer from another surface is kept before the ask waiting on it runs, cleanup held or not', async () => {
    // A write denial that has expired: deciding sweeps it and deletes its parked bytes, which this test holds.
    const deleting = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();

    const writes: ParkedWrites = {
      content: {
        retain: async () => {},
        read: async () => null,
        delete: async () => {
          deleting.resolve();
          await cleanup.promise;
        },
      },
      perform: async () => 'written',
    };

    const live = livePrompts(1);
    const { shellTool, grantsAtRun, granted, ran, queue, store, advance } = setup({ approve: live.approve, writes });
    const asking = shellTool.execute({ command: GATED });

    await live.shown;
    store.create({ id: 'old-write', command: `file write /home/main/notes.md sha256:${'a'.repeat(64)} over sha256:${'b'.repeat(64)}`, executor: 'workspace', context: {}, reason: 'overwrite', requestedAt: 0 }, []);
    store.decide('old-write', 'denied', 0);
    advance(DENIAL_STANDING_MS + 1);

    const deciding = queue.decide(['defer-1'], 'always');

    // The command runs while the cleanup is held, with the owner's grant already kept.
    await Promise.all([deleting.promise, ran]);
    expect(grantsAtRun).toHaveLength(1);
    expect(grantsAtRun[0]).toBeGreaterThan(0);

    cleanup.resolve();
    await deciding;
    expect(await asking).toBe('ran');
    // Kept once, and not lost when the run settled its row.
    expect(granted.length).toBe(grantsAtRun[0]);
  });

  test('a row decided on another surface retires its live prompt, and a late answer there changes nothing', async () => {
    const live = livePrompts(1);
    const { shellTool, executed, queue } = setup({ approve: live.approve });
    const asking = shellTool.execute({ command: GATED });

    await live.shown;
    // The web's card answers first.
    await queue.decide(['defer-1'], 'denied');
    expect(live.prompts[0]?.signal.aborted).toBe(true);
    await expect(asking).rejects.toMatchObject({ message: expect.stringContaining('the owner refused this') });

    live.prompts[0]?.answer('allow');
    await expect(shellTool.execute({ command: GATED })).rejects.toMatchObject({ message: expect.stringContaining('the owner refused this') });
    expect(executed).toEqual([]);
  });

  test('with no queue wired at all, strict keeps its old explanatory refusal', async () => {
    const { shellTool, executed } = setup({ noQueue: true });
    await expect(shellTool.execute({ command: GATED })).rejects.toMatchObject({ message: expect.stringContaining('needs owner approval, nobody to ask') });
    expect(executed).toEqual([]);
  });
});

// A device consent's answer resumed its parked call on the surface the call was made on; a parked action's wake carried
// none, so an interactive shell call approved after its turn had ended ran in a one-shot turn: inline, never detached.
describe('the re-issue a decision wakes for runs under the surface its call was parked from', () => {
  test("the wake opens its turn on the surface the call was made on, which the queue's list does not show", async () => {
    let surface: InvocationSurface = 'interactive';
    const { shellTool, queue, delivered } = setup({ surface: () => surface });

    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);
    expect(queue.list()[0]).not.toHaveProperty('surface');
    await queue.decide(['defer-1'], 'approved');
    surface = 'one-shot';
    await expect(shellTool.execute({ command: 'npm publish a' })).rejects.toBeInstanceOf(KinuError);
    await queue.decide(['defer-2'], 'approved');

    expect(delivered.map((signal) => signal.metadata?.[RESUMED_SURFACE])).toEqual(['interactive', 'one-shot']);
  });

  test('calls parked from both surfaces are re-issued as interactive; a denial names none', async () => {
    let surface: InvocationSurface = 'one-shot';
    const { shellTool, queue, delivered } = setup({ surface: () => surface });

    await expect(shellTool.execute({ command: 'npm publish a' })).rejects.toBeInstanceOf(KinuError);
    surface = 'interactive';
    await expect(shellTool.execute({ command: 'npm publish b' })).rejects.toBeInstanceOf(KinuError);
    await queue.decide(['defer-1', 'defer-2'], 'approved');
    await expect(shellTool.execute({ command: 'npm publish c' })).rejects.toBeInstanceOf(KinuError);
    await queue.decide(['defer-3'], 'denied');

    expect(delivered.map((signal) => [signal.metadata?.ids, signal.metadata?.[RESUMED_SURFACE] ?? null]))
      .toEqual([[['defer-1', 'defer-2'], 'interactive'], [['defer-3'], null]]);
  });

  test('a call made in no turn names none', async () => {
    const { shellTool, queue, delivered } = setup();

    await expect(shellTool.execute({ command: GATED })).rejects.toBeInstanceOf(KinuError);
    await queue.decide(['defer-1'], 'approved');

    expect(delivered[0]?.metadata).not.toHaveProperty(RESUMED_SURFACE);
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
      { approvalId: 'defer-1', actor: store.actorId, command: GATED, executor: 'workspace' },
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
    store.create({ id: 'defer-s', command: GATED, executor: 'workspace', context: {}, reason: 'gate', requestedAt: 1 }, []);
    expect(store.decide('defer-s', 'approved', 2)?.status).toBe('approved');

    const spent = store.spend('defer-s');
    expect(spent?.action.id).toBe('defer-s');
    expect(store.spend('defer-s')).toBeNull();
    expect(store.standing({ command: GATED, executor: 'workspace', context: {} }, 3)).toBeNull();

    if (!spent) throw new Error('an approved grant must be spendable');

    expect(store.settle(spent.spend, 'spent')).toBe(true);
    expect(store.get('defer-s')).toBeNull();
    expect(store.settle(spent.spend, 'did-not-run')).toBe(false);
    expect(store.standing({ command: GATED, executor: 'workspace', context: {} }, 3)).toBeNull();
  });

  test('re-opening the workspace keeps parked and approved rows intact', () => {
    const { db, sql, actor } = approvalsDb();
    const store = new DeferredApprovalStore(sql, actor);
    store.create({ id: 'defer-parked', command: GATED, executor: 'workspace', context: {}, reason: 'gate', requestedAt: 1 }, []);
    store.create({ id: 'defer-blessed', command: `${GATED} --twice`, executor: 'workspace', context: {}, reason: 'gate', requestedAt: 2 }, []);
    expect(store.decide('defer-blessed', 'approved', 3)?.status).toBe('approved');

    initDeferredApprovalsTable(makeExecRaw(db));
    const reopened = new DeferredApprovalStore(sql, actor);
    expect(reopened.get('defer-parked')?.status).toBe('queued');
    expect(reopened.get('defer-blessed')?.status).toBe('approved');
    expect(reopened.standing({ command: GATED, executor: 'workspace', context: {} }, 6)?.id).toBe('defer-parked');
  });
});

describe('the parked action stays visible until it is decided', () => {
  test('every step of the turn re-states that it has not happened', () => {
    // The per-step dynamic-context block carries the missing effect until the owner answers.
    const { queue, store } = setup();
    store.create({ id: 'defer-x', command: GATED, executor: 'workspace', context: {}, reason: 'gate', requestedAt: 10 }, []);

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
      pendingPlans: [],
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
    first.create({ id: 'defer-9', command: GATED, executor: 'workspace', context: {}, reason: 'gate', requestedAt: 5 }, []);

    const reopened = new DeferredApprovalStore(sql, actor);
    const parked = reopened.listQueued();

    expect(parked.map((a: DeferredApproval) => a.id)).toEqual(['defer-9']);
    expect(reopened.standing({ command: GATED, executor: 'workspace', context: {} }, 6)?.status).toBe('queued');
  });

  test('the decision is durable before the wake is attempted', async () => {
    // The row is the record; the signal is only the notification.
    const { sql, actor } = approvalsDb();
    const store = new DeferredApprovalStore(sql, actor);
    store.create({ id: 'defer-7', command: GATED, executor: 'workspace', context: {}, reason: 'gate', requestedAt: 5 }, []);

    const queue = new DeferredApprovalQueue({
      writes: null,
      store,
      wake: () => Effect.fail(new KinuError('unavailable', 'no host')),
      remember: () => { throw new Error('not an always answer'); },
    });

    await expect(queue.decide(['defer-7'], 'approved')).rejects.toThrow('no host');
    expect(store.get('defer-7')?.status).toBe('approved');
  });
});

describe('a hired agent parks on its workspace\'s one queue, as itself', () => {
  function workspaceQueue() {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    const execRaw = makeExecRaw(db);
    initDeferredApprovalsTable(execRaw);
    const actors = createTestActors(sql, execRaw);
    const hire = actors.sibling('courier');
    const woken: Array<[string, string]> = [];
    let seq = 0;

    const store = new DeferredApprovalStore(sql, actors.main);

    const queue = new DeferredApprovalQueue({
      writes: null, store, remember: () => {},
      wake: (actorId, signal) => Effect.sync(() => { woken.push([actorId, signal.text]); }),
      newId: () => `defer-${String(++seq)}`,
      now: () => 1_000 + seq,
    });

    const ask = (channel: DeferredApprovalChannel, command: string) => channel.park({
      command, executor: 'workspace', context: {}, review: reviewCommand(command, 'agent'),
    });

    return { queue, store, root: actors.main, hire, woken, ask, directory: actors.directory };
  }

  test('both asks wait in the one list, each with its asker; deciding them wakes each asker with its own', async () => {
    const { queue, root, hire, woken, ask } = workspaceQueue();

    await ask(queue.channel, 'git push --force origin main');
    await ask(queue.channelFor(hire.actorId), 'git push --force origin release');

    expect(queue.list().map((action) => [action.id, action.actor])).toEqual([['defer-1', root.actorId], ['defer-2', hire.actorId]]);
    expect([queue.approvals().map((row) => row.id), queue.approvals(hire.actorId).map((row) => row.id)]).toEqual([['defer-1'], ['defer-2']]);

    await queue.decide(['defer-1', 'defer-2'], 'approved');

    expect(woken.map(([actorId, text]) => [actorId, text.split('\n')[1]])).toEqual([
      [root.actorId, '  defer-1: git push --force origin main'],
      [hire.actorId, '  defer-2: git push --force origin release'],
    ]);
  });

  test('one asker that cannot be told does not leave the others untold; the answer reports it after', async () => {
    const { queue, store, root, hire, ask } = workspaceQueue();
    const told: string[] = [];

    await ask(queue.channelFor(hire.actorId), 'git push --force origin release');
    await ask(queue.channel, 'git push --force origin main');

    const failing = new DeferredApprovalQueue({
      writes: null, store, remember: () => {},
      wake: (actorId) => (actorId === hire.actorId
        ? Effect.fail(new KinuError('missing', 'the hire was retired'))
        : Effect.sync(() => { told.push(actorId); })),
    });

    await expect(failing.decide(['defer-1', 'defer-2'], 'approved')).rejects.toThrow('the hire was retired');
    expect(told).toEqual([root.actorId]);
    expect(queue.list()).toEqual([]);
  });

  test('an id two actors share answers neither; a minted id is one no actor has', async () => {
    const { queue, store, root, hire, ask } = workspaceQueue();
    const shared = { id: 'defer-1', command: GATED, executor: 'workspace', context: {}, reason: 'gate', requestedAt: 1 };

    store.create(shared, []);
    store.forActor(hire.actorId).create(shared, []);

    expect(await queue.decide(['defer-1'], 'approved')).toEqual([]);
    // Seeded at one instant, so in either order.
    expect(queue.list().map((action) => action.actor).sort()).toEqual([root.actorId, hire.actorId].sort());
    await ask(queue.channelFor(hire.actorId), 'git push --force origin release');
    expect(queue.list().map((action) => action.id)).toEqual(['defer-1', 'defer-1', 'defer-2']);
  });

  test('a retired agent\'s ask leaves the owner\'s list: it could neither be told nor re-issue', async () => {
    const { queue, hire, ask, directory, root } = workspaceQueue();

    await ask(queue.channelFor(hire.actorId), 'git push --force origin release');
    directory.apply(root, [], { action: 'retire', name: 'courier', reference: actorReferenceOf(directory.describe(hire)) });

    expect(queue.list()).toEqual([]);
  });

  test('the hire\'s approval runs its own re-issue once, and stands for no one else', async () => {
    const { queue, hire, ask } = workspaceQueue();

    await ask(queue.channelFor(hire.actorId), GATED);
    await queue.decide(['defer-1'], 'approved');

    // The root asking the same command is a new ask: the hire's approval is the hire's.
    expect(await ask(queue.channel, GATED)).toMatchObject({ run: false, reason: 'unavailable' });
    expect(await ask(queue.channelFor(hire.actorId), GATED)).toMatchObject({ run: true });
    expect(await ask(queue.channelFor(hire.actorId), GATED)).toMatchObject({ run: false, reason: 'unavailable' });
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
      wake: () => Effect.void,
      remember: (grants) => { for (const g of grants) granted.push(formatApprovalGrant(g)); },
      newId: () => `defer-${++seq}`,
      now: () => 1_000 + seq,
    });

    const ran: string[] = [];

    const record = (member: string) => async (command: string) => {
      ran.push(`${member} ${command}`);

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
        startProcess: fakeCommandMember('Start a background process', record('start')),
      },
    };

    const { tools } = gateProviderExec(provider, {
      mode: () => 'strict',
      granted: (grant) => granted.includes(formatApprovalGrant(grant)),
      deferrals: queue.channel,
    });

    return { queue, tools, ran, granted };
  }

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
    const audited: Array<{ approvalId: string; actor: string; command: string; executor: string }> = [];

    const queue = new DeferredApprovalQueue({
      writes: null,
      store,
      wake: () => Effect.void,
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
        exec: fakeCommandMember('Run a shell command on the owner\'s machine', async (command) => {
          executed.push(command);

          return answer();
        }),
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
    expect(store.standing({ command: GATED, executor: 'device', context: { member: 'exec' } }, 1_010)?.status).toBe('approved');
    expect(store.standing({ command: GATED, executor: 'device', context: { member: 'exec' } }, 1_010)?.id).toBe('defer-1');
    expect(queue.list()).toEqual([]);
  });

  test('a machine that throws a failure proving nothing started leaves the grant spendable too', async () => {
    const { queue, store, exec, executed, answerWith } = deviceSetup();
    answerWith(notConnected);
    await exec(GATED);
    await queue.decide(['defer-1'], 'approved');

    answerWith(() => { throw new KinuError('unavailable', 'No device connected.'); });
    await Promise.allSettled([exec(GATED)]);

    expect(executed).toEqual([GATED]);
    expect(store.standing({ command: GATED, executor: 'device', context: { member: 'exec' } }, 1_010)?.id).toBe('defer-1');
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
    expect(store.standing({ command: GATED, executor: 'device', context: { member: 'exec' } }, 1_010)).toBeNull();
    expect(store.get('defer-1')).toBeNull();
    expect(audited).toEqual([{ approvalId: 'defer-1', actor: store.actorId, command: GATED, executor: 'device' }]);
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
    expect(store.standing({ command: GATED, executor: 'device', context: { member: 'exec' } }, 1_010)).toBeNull();
  });

  test('a command that reached the machine and FAILED there does not refund', async () => {
    // Negative control: a non-zero exit ran, so the approval is spent.
    const { queue, store, exec, answerWith } = deviceSetup();
    answerWith(notConnected);
    await exec(GATED);
    await queue.decide(['defer-1'], 'approved');

    answerWith(() => commandResultAt({ stdout: '', stderr: 'rejected', exitCode: 1 }, false));
    expect(await exec(GATED)).toMatchObject({ reason: 'io' });

    expect(store.standing({ command: GATED, executor: 'device', context: { member: 'exec' } }, 1_010)).toBeNull();
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

    expect(store.standing({ command: GATED, executor: 'device', context: { member: 'exec' } }, 1_010)).toBeNull();
  });

  test('a throw out of the executor does not refund', async () => {
    const { queue, store, exec, answerWith } = deviceSetup();
    answerWith(notConnected);
    await exec(GATED);
    await queue.decide(['defer-1'], 'approved');

    answerWith(() => { throw new Error('socket died'); });
    await expect(exec(GATED)).rejects.toThrow('socket died');

    expect(store.standing({ command: GATED, executor: 'device', context: { member: 'exec' } }, 1_010)).toBeNull();
  });

  // A workspace process starts before its job is asked for; one no job took was stopped, but it ran (review of
  // fix/process-job, 2026-10-20: refused `unavailable`, it returned the grant, and the same call ran again unasked).
  test('a process that started and was stopped because no job took it spends the grant', async () => {
    const { sql, actor } = approvalsDb();
    const store = new DeferredApprovalStore(sql, actor);
    let seq = 0;

    const queue = new DeferredApprovalQueue({
      writes: null, store, wake: () => Effect.void, remember: () => { throw new Error('not an always answer'); },
      newId: () => `defer-${++seq}`, now: () => 1_000 + seq, audit: () => {},
    });

    const started: string[] = [];
    const killed: number[] = [];

    const box: SessionBox = {
      ready: async () => {},
      exec: async (command: string) => ({ command, success: true, stdout: '', stderr: '', exitCode: 0, duration: 0, timestamp: 0 }),
      startProcess: async (command) => {
        started.push(command);

        return {
          command, pid: 7, ports: [], startedAt: 1,
          process: { pid: 7, command, argv: [command], cwd: WORKSPACE_ROOT, state: 'running', exitCode: null, startTime: 1, endTime: null, longRunning: true, attachedTty: false },
        };
      },
      processes: {
        kill: async (pid) => {
          killed.push(pid);

          return { ok: true, pid };
        },
        whenEnded: () => new Promise<number>(() => undefined),
      },
      files: sessionFilesOver(),
    };

    const { rt } = createTestRuntime();

    const workspace = gateProviderExec(createNimbusWorkspaceExecutor({
      box, jobs: NO_JOBS,
      inline: { vfs: nimbusSessionFiles(box.files, { home: WORKSPACE_ROOT }), shell: nimbusSessionShell(box, { home: WORKSPACE_ROOT }), craftStore: rt.craftStore },
    }), { mode: () => 'strict', deferrals: queue.channel });

    const start = () => workspace.tools.startProcess?.execute(GATED);

    expect(await start()).toMatchObject({ error: expect.stringContaining('defer-1') });
    await queue.decide(['defer-1'], 'approved');

    expect(await start()).toMatchObject({ reason: 'cancelled', error: expect.stringContaining('so the process was stopped') });
    expect({ started, killed }).toEqual({ started: [GATED], killed: [7] });
    expect(store.get('defer-1')).toBeNull();
    expect(await start()).toMatchObject({ error: expect.stringContaining('defer-2') });
    expect(started).toEqual([GATED]);
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
    expect(store.standing({ command: GATED, executor: 'device', context: { member: 'exec' } }, 1_010)?.id).toBe('defer-1');

    await queue.channel.settle(spend.spend, 'did-not-run');
    expect(store.standing({ command: GATED, executor: 'device', context: { member: 'exec' } }, 1_010)?.id).toBe('defer-1');

    const second = store.spend('defer-1');
    expect(second).not.toBeNull();

    if (!second) throw new Error('the refunded grant must be spendable again');
    await queue.channel.settle(second.spend, 'spent');
    await queue.channel.settle(spend.spend, 'did-not-run');
    expect(store.standing({ command: GATED, executor: 'device', context: { member: 'exec' } }, 1_010)).toBeNull();
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
  expect(commandResultAt(result, false)).toMatchObject({ reason: 'io', execution: { exitCode: 1 } });
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
    wake: (_actor, signal) => Effect.sync(() => { woken.push(signal.text); }),
    writes: {
      content: new ParkedWriteFiles(async () => kernel),
      perform: (write, bytes) => perform(plane, write, bytes),
    },
  });

  const policy: ShellApprovalPolicy = { mode: () => 'strict', deferrals: queue.channel };
  const files = hostedToolFiles(plane, cloudPlanes(WORKSPACE_ROOT), policy);

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

test('an approved write over a file changed after its compare is refused, and the change stands', async () => {
  let raced = false;

  const { drive, files, queue, woken } = await driveWithQueue(async (plane, write, bytes) => {
    // The owner saves on the Drive just after the approval read the file it was asked about.
    const racing: VFS = {
      ...plane,
      readFile: async (path) => {
        const held = await plane.readFile(path);

        if (!raced) {
          raced = true;
          await writeText(drive, '/notes.md', 'the owner\u2019s later edit\n');
        }

        return held;
      },
    };

    return await performBoundWrite(racing, write, bytes);
  });

  await writeText(drive, '/notes.md', 'the owner\u2019s\n');
  await expect(writeText(files, '/shared/notes.md', 'rewritten\n')).rejects.toMatchObject({ code: 'unavailable' });

  await queue.decide(['defer-1'], 'approved');
  expect(await readText(drive, '/notes.md')).toBe('the owner\u2019s later edit\n');
  expect(woken.at(-1)).toContain('APPROVED, not written: the file changed since the ask');
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
