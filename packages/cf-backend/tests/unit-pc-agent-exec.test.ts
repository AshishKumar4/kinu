/**
 * The PC daemon's `exec` RPC — the cf backend's `laptop` runtime.
 *
 * `packages/pc-agent/src/index.js` is the other end of the device tunnel: when
 * a cloud agent calls `run laptop`, this is the process that actually runs the
 * command on the user's machine. It ships as one dependency-free file the user
 * downloads, it had no suite at all, and it carried the same two defects as the
 * local host shell — which is the point. The bug was never "a mistake in one
 * function", it was one contract implemented three times with nobody checking
 * that the copies agreed.
 *
 * Tested through the exported RPC entry point (`handle`) with a fake socket,
 * so these assert what the cloud agent receives, not how the daemon is built.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  DEVICE_CANCEL_METHOD, DEVICE_CANCEL_PROTOCOL, DEVICE_CANCEL_VERSION_REFUSAL,
  DeviceCancelResultSchema, DeviceTunnel, JsonValueSchema, createDeviceTunnelExecutor,
  type DeviceStatus, type DeviceTransport, type TunnelSocket,
} from '@kinu.run/core';

const TEST_INFLIGHT_ROOT = mkdtempSync(join(tmpdir(), 'pc-agent-inflight-'));
process.env.KINU_INFLIGHT_ROOT = TEST_INFLIGHT_ROOT;
const require_ = createRequire(import.meta.url);


const WatchableFileSystemSchema = v.object({ watch: v.function() });
interface DaemonMessage {
  readonly id: string;
  readonly method: string;
  readonly params: readonly (string | number)[];
}
interface ReplySocket { send(data: string): void }

/** One frame as the tunnel writes it onto the device socket — the shape the
 *  daemon's dispatch reads back off the wire. */
const DaemonFrameSchema = v.object({
  id: v.string(),
  method: v.string(),
  params: v.array(v.union([v.string(), v.number()])),
});

/** The daemon members these tests drive. `inFlight` is the command registry a
 *  cancellation resolves ids against; a dropped socket calls into it directly,
 *  which is how the disconnect case is exercised without a real WebSocket. */
/** One sweep's terminations, parsed where they arrive: each names its request
 *  and carries the promise that settles when that command's kill is confirmed.
 *  `terminated` stays unparsed here and is parsed once awaited, because a
 *  pending promise carries no shape to check yet. */
const SweepSchema = v.array(v.object({ requestId: v.string(), terminated: v.unknown() }));
const ConfirmedCancellationSchema = v.object({ requestId: v.string(), cancelled: v.string() });

const PcAgentModuleSchema = v.object({
  handle: v.function(),
  inFlight: v.object({
    size: v.function(),
    /** Returns one promise per command it terminated; each resolves with the
     *  confirmed outcome and rejects when the kill is unproven. */
    terminateUnanswered: v.function(),
  }),
  createInFlight: v.function(),
  INFLIGHT_ROOT: v.string(),
  CANCEL_METHOD: v.string(),
  CANCEL_PROTOCOL: v.number(),
  EXEC_ACK_METHOD: v.string(),
  requestDirectory: v.function(),
  supervisionSupported: v.function(),
  waitForFile: v.function(),
  waitForSupervisorState: v.function(),
});
/** The registry surface the unregistered-window test drives, which is the
 *  same `createInFlight` the daemon builds its own from. */
const SupervisorRegistrySchema2 = v.object({
  terminateUnanswered: v.function(),
});
const SupervisorRegistrySchema = v.object({
  reconcile: v.function(),
  cancel: v.function(),
  acknowledge: v.function(),
});
const pcAgent = v.parse(PcAgentModuleSchema, require_(join(import.meta.dir, '../../pc-agent/src/index.js')));

afterAll(() => rmSync(TEST_INFLIGHT_ROOT, { recursive: true, force: true }));

function handle(message: DaemonMessage, socket: ReplySocket): void {
  pcAgent.handle(message, socket);
}

const ExecResultSchema = v.object({ stdout: v.string(), stderr: v.string(), exitCode: v.number() });
const ExecReplySchema = v.object({
  id: v.string(),
  result: v.optional(ExecResultSchema),
  error: v.optional(v.string()),
});
type ExecReply = v.InferOutput<typeof ExecReplySchema>;

/** Any frame the daemon writes back, narrowed by the caller that knows which
 *  answer it asked for. One recorder serves exec and cancellation both, and a
 *  schema that only fit exec would fail the moment it saw a cancellation. */
const DaemonReplySchema = v.object({
  id: v.string(),
  result: v.optional(JsonValueSchema),
  error: v.optional(v.string()),
});
type DaemonReply = v.InferOutput<typeof DaemonReplySchema>;

let execSequence = 0;

function rpcId(sequence: number): string {
  return `rpc-testepoch0-${sequence}`;
}

/** Issue one `exec` RPC and resolve with the daemon's reply. */
function exec(command: string): Promise<{ reply: ExecReply; elapsed: number }> {
  const { promise, resolve } = Promise.withResolvers<{ reply: ExecReply; elapsed: number }>();
  const started = Date.now();
  const ws = {
    send(data: string) {
      resolve({ reply: v.parse(ExecReplySchema, JSON.parse(data)), elapsed: Date.now() - started });
    },
  };
  handle({ id: rpcId(++execSequence), method: 'exec', params: [command] }, ws);
  return promise;
}

describe('pc-agent exec RPC', () => {
  test('answers with stdout, stderr and the exit code', async () => {
    const { reply } = await exec('echo out; echo err 1>&2; exit 4');

    expect(reply.id).toStartWith('rpc-testepoch0-');
    expect(reply.error).toBeUndefined();
    expect(reply.result?.stdout).toContain('out');
    expect(reply.result?.stderr).toContain('err');
    expect(reply.result?.exitCode).toBe(4);
  });

  test('answers when the COMMAND finishes, not when a backgrounded server does', async () => {
    const { reply, elapsed } = await exec('sleep 20 & echo started');

    expect(reply.result?.stdout).toContain('started');
    expect(reply.result?.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(3_000);
  }, 40_000);

  test('output the command wrote is complete, not cut short by the early answer', async () => {
    const { reply } = await exec('seq 1 20000');

    expect(reply.result?.exitCode).toBe(0);
    expect(reply.result?.stdout.trimEnd().split('\n')).toHaveLength(20_000);
  }, 40_000);

  test('answers exactly once', async () => {
    const sends: string[] = [];
    const id = rpcId(100);
    handle({ id, method: 'exec', params: ['echo hi'] }, { send: (d) => sends.push(d) });
    await settled(() => (sends.length === 1 ? true : undefined), 'the sole exec reply');

    expect(sends).toHaveLength(1);
  }, 20_000);
});

/**
 * Cancellation, at the only layer that can prove it: real processes.
 *
 * A cancelled command used to mean a cancelled WAIT. The daemon had no method
 * to stop anything, kept no record of what it had started, and answered a
 * command's own exit by unref'ing the child — so a `sleep &` inside the command
 * kept running on the user's machine after Kinu reported the turn stopped.
 *
 * So each test below reads a real descendant's pid out of the command itself and
 * asks the kernel about it. The `alive before` assertion in the first test is
 * the negative control: without it, a test that cannot spawn a descendant at all
 * would pass for the wrong reason.
 */

/** A recording socket plus the frames the daemon has written to it. */
function recorder() {
  const replies: DaemonReply[] = [];
  return {
    replies,
    socket: { send: (data: string) => { replies.push(v.parse(DaemonReplySchema, JSON.parse(data))); } },
    of(id: string): DaemonReply[] { return replies.filter((reply) => reply.id === id); },
  };
}

/**
 * Whether the kernel still knows `pid`. Every answer is accounted for: ESRCH is
 * the process being gone, EPERM is a process that exists and is not ours to
 * signal, and anything else is this test's own breakage rather than a reading
 * about the process.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String(err.code) : '';
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw err;
  }
}

/**
 * Poll until `read` answers, and name what was being waited for when it never
 * does — so a failure reads as "the descendant is still alive" rather than as a
 * bare timeout.
 *
 * Real time, deliberately: the subject here is a process group on this machine,
 * and whether a SIGKILL landed is a question only the kernel can answer. A fake
 * clock cannot advance a `kill(2)`, and a fixed sleep would either guess or
 * hide the condition. Every wait ends on the condition, never on the interval.
 */
async function settled<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Wait until `pid` is no longer in the process table.
 *
 * SIGKILL is definitive the moment the kernel accepts it, but the corpse stays
 * visible to `kill(pid, 0)` until whoever inherited it reaps it, and that
 * happens on init's schedule rather than the killer's. Nothing else was going
 * to end a `sleep 30` inside this window, so disappearing here means killed.
 */
function gone(pid: number): Promise<true> {
  return settled(() => (alive(pid) ? undefined : true), `process ${pid} to leave the process table`);
}

const PidSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const SupervisorStateSchema = v.object({ pid: PidSchema, group: PidSchema });

/**
 * The two processes one command actually has: the supervisor the daemon
 * signals, and the group the command itself runs in.
 *
 * Read from the supervisor's own published state, which is where the daemon
 * reads it too. A test that stopped at the RPC surface could not name either
 * process, and every claim here is about what the kernel knows.
 */
function supervisorState(requestId: string): Promise<v.InferOutput<typeof SupervisorStateSchema>> {
  const file = join(pcAgent.INFLIGHT_ROOT, requestId, 'state');
  return settled(() => {
    if (!existsSync(file)) return undefined;
    const fields: Record<string, string> = Object.fromEntries(
      readFileSync(file, 'utf8').trimEnd().split('\n').map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
    );
    const parsed = v.safeParse(SupervisorStateSchema, {
      pid: Number(fields.pid), group: Number(fields.group),
    });
    return parsed.success ? parsed.output : undefined;
  }, `the published supervisor state for ${requestId}`);
}

/** A command that leaves a descendant of its own behind, plus the file that
 *  descendant's pid is written to — the process a group kill has to reach. */
function commandWithDescendant(dir: string, name: string) {
  const pidFile = join(dir, `${name}.pid`);
  return {
    command: `(sleep 30 & echo $! > ${pidFile}); sleep 30`,
    async pidOf() {
      // The command writes this file itself, so its absence means "not yet",
      // not a read failure to be swallowed.
      return settled(() => {
        if (!existsSync(pidFile)) return undefined;
        const pid = Number(readFileSync(pidFile, 'utf8').trim());
        return Number.isInteger(pid) && pid > 0 ? pid : undefined;
      }, `the descendant pid in ${pidFile}`);
    },
  };
}

function cancel(id: string, target: string, socket: ReplySocket, protocol = DEVICE_CANCEL_PROTOCOL): void {
  handle({ id, method: DEVICE_CANCEL_METHOD, params: [target, protocol] }, socket);
}

function acknowledge(id: string, target: string, socket: ReplySocket): void {
  handle({ id, method: pcAgent.EXEC_ACK_METHOD, params: [target, DEVICE_CANCEL_PROTOCOL] }, socket);
}

describe('pc-agent command cancellation', () => {
  test('the daemon and core name the same cancellation protocol', () => {
    expect(pcAgent.CANCEL_METHOD).toBe(DEVICE_CANCEL_METHOD);
    expect(pcAgent.CANCEL_PROTOCOL).toBe(DEVICE_CANCEL_PROTOCOL);
  });

  test('cancellation waits for the owned command group to die', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-agent-cancel-'));
    const { command, pidOf } = commandWithDescendant(dir, 'child');
    const ws = recorder();
    const runId = rpcId(201);
    const cancelId = rpcId(202);

    handle({ id: runId, method: 'exec', params: [command] }, ws.socket);
    const descendant = await pidOf();
    expect(alive(descendant)).toBe(true);
    cancel(cancelId, runId, ws.socket);

    const answer = await settled(() => ws.of(cancelId)[0], 'the cancellation answer');
    expect(v.parse(DeviceCancelResultSchema, answer.result)).toEqual({ requestId: runId, cancelled: 'terminated' });
    expect(await gone(descendant)).toBe(true);
    const finished = await settled(() => ws.of(runId)[0], 'the exec answer');
    expect(v.parse(ExecResultSchema, finished.result).exitCode).toBe(137);

    const ackId = rpcId(203);
    acknowledge(ackId, runId, ws.socket);
    expect((await settled(() => ws.of(ackId)[0], 'the cancellation ACK')).result)
      .toEqual({ requestId: runId, acknowledged: true });
  }, 30_000);

  test('normal result remains replayable until the cloud ACK cleans it up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-agent-normal-ack-'));
    const pidFile = join(dir, 'server.pid');
    const ws = recorder();
    const runId = rpcId(210);
    const requestDir = join(pcAgent.INFLIGHT_ROOT, runId);
    const sizeBefore = v.parse(v.number(), pcAgent.inFlight.size());

    handle({ id: runId, method: 'exec', params: [`sleep 30 & echo $! > ${pidFile}; echo started`] }, ws.socket);
    const answer = await settled(() => ws.of(runId)[0], 'the exec answer');
    expect(v.parse(ExecResultSchema, answer.result).stdout).toContain('started');
    expect(existsSync(join(requestDir, 'result'))).toBe(true);
    expect(pcAgent.inFlight.size()).toBe(sizeBefore + 1);

    const ackId = rpcId(211);
    acknowledge(ackId, runId, ws.socket);
    expect((await settled(() => ws.of(ackId)[0], 'the cloud ACK')).result)
      .toEqual({ requestId: runId, acknowledged: true });
    expect(await settled(() => (!existsSync(requestDir) ? true : undefined), 'supervisor cleanup')).toBe(true);
    expect(pcAgent.inFlight.size()).toBe(sizeBefore);

    const server = Number(readFileSync(pidFile, 'utf8').trim());
    if (alive(server)) process.kill(server, 'SIGKILL');
  }, 30_000);

  test('completed, duplicate and unknown cancellation targets answer honestly', async () => {
    const ws = recorder();
    const runId = rpcId(220);
    handle({ id: runId, method: 'exec', params: ['echo done'] }, ws.socket);
    await settled(() => ws.of(runId)[0], 'the exec answer');

    const cancellations = [rpcId(221), rpcId(222), rpcId(223)];
    cancel(cancellations[0], runId, ws.socket);
    cancel(cancellations[1], runId, ws.socket);
    cancel(cancellations[2], rpcId(999), ws.socket);
    for (const id of cancellations) {
      const answer = await settled(() => ws.of(id)[0], `the answer to ${id}`);
      expect(v.parse(DeviceCancelResultSchema, answer.result).cancelled).toBe('unknown');
    }

    acknowledge(rpcId(224), runId, ws.socket);
    await settled(() => ws.of(rpcId(224))[0], 'the normal-result ACK');
  }, 30_000);

  test('a cancellation frame from a version this daemon does not speak is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-agent-cancel-version-'));
    const { command, pidOf } = commandWithDescendant(dir, 'kept');
    const ws = recorder();
    const runId = rpcId(230);
    handle({ id: runId, method: 'exec', params: [command] }, ws.socket);
    const descendant = await pidOf();

    const refusalId = rpcId(231);
    cancel(refusalId, runId, ws.socket, DEVICE_CANCEL_PROTOCOL + 1);
    const refusal = await settled(() => ws.of(refusalId)[0], 'the version refusal');
    expect(refusal.result).toBeUndefined();
    expect(refusal.error).toContain(DEVICE_CANCEL_VERSION_REFUSAL);
    expect(alive(descendant)).toBe(true);

    const cancelId = rpcId(232);
    cancel(cancelId, runId, ws.socket);
    await settled(() => ws.of(cancelId)[0], 'the cancellation answer');
    expect(await gone(descendant)).toBe(true);
    await settled(() => ws.of(runId)[0], 'the cancelled exec result');
    acknowledge(rpcId(233), runId, ws.socket);
    await settled(() => ws.of(rpcId(233))[0], 'the cancellation ACK');
  }, 30_000);

  test('rejects noncanonical request IDs before selecting a control directory', () => {
    for (const id of ['.', '..', 'rpc-short-1', 'rpc-testepoch0-0', 'rpc-testepoch0-1/child']) {
      expect(() => pcAgent.requestDirectory(pcAgent.INFLIGHT_ROOT, id)).toThrow('request id');
    }
    const ws = recorder();
    cancel(rpcId(240), '..', ws.socket);
    expect(ws.of(rpcId(240))[0].error).toContain('request id');
    handle({ id: '..', method: 'exec', params: ['echo must-not-spawn'] }, ws.socket);
    expect(ws.of('..')[0].error).toContain('request id');
  });


  test('a sweep reaches a command the registry has not registered yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-agent-unregistered-'));
    const waiting = commandWithDescendant(dir, 'unregistered');
    // Built over the root while it is still empty, so it holds no entry for
    // the request below. That is the live window: the supervisor publishes
    // its state before `register` runs, and a socket dropping in between
    // used to leave the command running with nothing left to name it.
    const detached = v.parse(SupervisorRegistrySchema2, pcAgent.createInFlight(pcAgent.INFLIGHT_ROOT));
    const ws = recorder();
    handle({ id: rpcId(260), method: 'exec', params: [waiting.command] }, ws.socket);
    const abandoned = await waiting.pidOf();
    expect(alive(abandoned)).toBe(true);
    await supervisorState(rpcId(260));

    const swept = v.parse(SweepSchema, detached.terminateUnanswered());
    const mine = swept.find((entry) => entry.requestId === rpcId(260));
    expect(mine).toBeDefined();
    expect(v.parse(ConfirmedCancellationSchema, await mine?.terminated))
      .toEqual({ requestId: rpcId(260), cancelled: 'terminated' });
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  test('a dropped socket terminates a command that still has no terminal result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-agent-disconnect-'));
    const waiting = commandWithDescendant(dir, 'waiting');
    const ws = recorder();
    handle({ id: rpcId(250), method: 'exec', params: [waiting.command] }, ws.socket);
    const abandoned = await waiting.pidOf();
    expect(alive(abandoned)).toBe(true);
    // The supervisor has published its state, which is the fact the daemon
    // reconciles from: a socket that drops before this names no command yet.
    await supervisorState(rpcId(250));

    // Asserted at the moment the daemon GUARANTEES the fact, not on a
    // deadline. `terminateUnanswered` returns its terminations; each resolves
    // only once the supervisor has published a terminal result AND the daemon
    // has confirmed the owned process group holds no live process, and it
    // REJECTS when either is unproven. So this settles exactly when the kill
    // has landed.
    //
    // Polling `kill(pid, 0)` could not assert the same thing twice over: it
    // reads "not yet" and "never" as the same value, and it stays true for a
    // corpse nobody has reaped, which is a state the daemon's own confirmation
    // deliberately ignores.
    // Selected by request id: a sweep terminates every abandoned command at
    // once, and this suite shares one in-flight root, so a positional pick
    // would assert about whichever command happened to be first.
    const swept = v.parse(SweepSchema, pcAgent.inFlight.terminateUnanswered());
    const mine = swept.find((entry) => entry.requestId === rpcId(250));
    expect(mine).toBeDefined();
    expect(v.parse(ConfirmedCancellationSchema, await mine?.terminated))
      .toEqual({ requestId: rpcId(250), cancelled: 'terminated' });
  }, 30_000);
});

describe('pc-agent durable supervisor', () => {
  test('bounds captured output and includes the truncation marker', async () => {
    const ws = recorder();
    const id = rpcId(300);
    const requestDir = join(pcAgent.INFLIGHT_ROOT, id);
    handle({ id, method: 'exec', params: [`${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(600000))"`] }, ws.socket);
    const answer = await settled(() => ws.of(id)[0], 'the bounded output result');
    const result = v.parse(ExecResultSchema, answer.result);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[output truncated at 524288 bytes]');
    expect(statSync(join(requestDir, 'stdout')).size).toBeLessThan(525_000);
    acknowledge(rpcId(301), id, ws.socket);
    await settled(() => ws.of(rpcId(301))[0], 'the bounded output ACK');
  }, 30_000);

  test('reconciles a surviving supervisor and cleans a cancelled replay after ACK', async () => {
    const id = rpcId(310);
    const requestDir = join(pcAgent.INFLIGHT_ROOT, id);
    const ws = recorder();
    handle({ id, method: 'exec', params: ['sleep 30'] }, ws.socket);
    await settled(() => (existsSync(join(requestDir, 'state')) ? true : undefined), 'supervisor state');

    const restarted = v.parse(SupervisorRegistrySchema, pcAgent.createInFlight(pcAgent.INFLIGHT_ROOT));
    expect(restarted.reconcile()).toContainEqual({ requestId: id, terminal: false });
    await expect(restarted.cancel(id)).resolves.toEqual({ requestId: id, cancelled: 'terminated' });
    await settled(() => ws.of(id)[0], 'reconciled exec result');
    await expect(restarted.acknowledge(id)).resolves.toEqual({ requestId: id, acknowledged: true });
    expect(existsSync(requestDir)).toBe(false);
  }, 30_000);
  test('reconciles a completed result and releases it only after its ACK', async () => {
    const id = rpcId(311);
    const requestDir = join(pcAgent.INFLIGHT_ROOT, id);
    const ws = recorder();
    handle({ id, method: 'exec', params: ['echo recovered'] }, ws.socket);
    await settled(() => ws.of(id)[0], 'the completed exec result');
    expect(existsSync(join(requestDir, 'result'))).toBe(true);

    const restarted = v.parse(SupervisorRegistrySchema, pcAgent.createInFlight(pcAgent.INFLIGHT_ROOT));
    expect(restarted.reconcile()).toContainEqual({ requestId: id, terminal: true });
    await expect(restarted.acknowledge(id)).resolves.toEqual({ requestId: id, acknowledged: true });
    expect(existsSync(requestDir)).toBe(false);
  }, 30_000);

  test('refuses a stale supervisor pid identity without signaling that pid', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-agent-pid-reuse-'));
    const registry = v.parse(SupervisorRegistrySchema, pcAgent.createInFlight(root));
    const id = rpcId(320);
    const requestDir = join(root, id);
    mkdirSync(requestDir, { mode: 0o700 });
    writeFileSync(
      join(requestDir, 'state'),
      `pid=${process.pid}\nstart=not-the-current-process\ngroup=${process.pid}\ngroupStart=not-the-current-process\n`,
      { mode: 0o600 },
    );

    await expect(registry.cancel(id)).rejects.toThrow('identity no longer matches');
    expect(alive(process.pid)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('pc-agent supervisor guards', () => {
  test('accepts a filename-less watch event and rejects a watch error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-agent-watch-'));
    const target = join(root, 'state');
    const rawAgentFs: unknown = require_('node:fs');
    if (!v.is(WatchableFileSystemSchema, rawAgentFs)) throw new Error('node:fs must provide watch');
    const agentFs = rawAgentFs;
    const originalWatch = agentFs.watch;
    try {
      agentFs.watch = (...args) => {
        const [, listener] = v.parse(v.tuple([v.string(), v.function()]), args);
        const watcher = Object.assign(new EventEmitter(), { close() {} });
        queueMicrotask(() => {
          writeFileSync(target, 'ready');
          listener('rename', null);
        });
        return watcher;
      };
      await pcAgent.waitForFile(target);

      agentFs.watch = () => {
        const watcher = Object.assign(new EventEmitter(), { close() {} });
        queueMicrotask(() => watcher.emit('error', new Error('watch failed')));
        return watcher;
      };
      await expect(pcAgent.waitForFile(join(root, 'result'))).rejects.toThrow('watch failed');
    } finally {
      agentFs.watch = originalWatch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects supervisor startup when the child exits before state publication', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-agent-startup-'));
    const child = new EventEmitter();
    const pending = pcAgent.waitForSupervisorState(root, child);
    child.emit('exit', 125, null);
    await expect(pending).rejects.toThrow('exited before publishing state');
    rmSync(root, { recursive: true, force: true });
  });

  test('refuses unsupported hosts before creating a command directory', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!originalPlatform) throw new Error('missing process platform descriptor');
    const id = rpcId(330);
    const requestDir = join(pcAgent.INFLIGHT_ROOT, id);
    try {
      Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
      const ws = recorder();
      handle({ id, method: 'exec', params: ['echo must-not-spawn'] }, ws.socket);
      expect(ws.of(id)[0].error).toContain('requires POSIX Linux or macOS');
      expect(existsSync(requestDir)).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });
});

/**
 * The whole chain, once, with a real process on the end of it.
 *
 * Every layer above is exercised in its own file, and each of those could pass
 * while the chain stayed broken — the executor mints an identity, the tunnel
 * issues the frame under it, the daemon registers a process group under it, and
 * a cancellation has to travel all of that to reach a `sleep`. So this wires the
 * real executor to the real tunnel to the real daemon and aborts the tool the
 * way a stopped turn does.
 */
describe('stopping a turn reaches the process on the user\'s machine', () => {
  /** Executor → tunnel → daemon dispatch → supervisor, with nothing stubbed in
   *  between. The socket the tunnel writes onto IS the daemon's dispatch, and
   *  the daemon's replies go straight back into the tunnel's correlation. The
   *  binding is declared before the socket because the two own each other: the
   *  socket cannot be built after the tunnel that takes it, and nothing reads
   *  it until the first frame, which is after the assignment below. */
  function deviceChain() {
    let tunnel: DeviceTunnel;
    const socket: TunnelSocket = {
      readyState: 1,
      send: (data: string) => {
        handle(v.parse(DaemonFrameSchema, JSON.parse(data)), {
          send: (reply: string) => { tunnel.handleMessage(reply); },
        });
      },
    };
    tunnel = new DeviceTunnel(socket);
    const connected: DeviceStatus = { connected: true, registered: true, toolchain: null };
    const transport: DeviceTransport = {
      rpc: (method, params, opts) => tunnel.rpc(method, params, opts),
      status: () => connected,
      refreshStatus: async () => connected,
    };
    return { provider: createDeviceTunnelExecutor(transport), tunnel };
  }

  test('the tool\'s abort kills the command and its child, and says it did', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-agent-e2e-'));
    const { command, pidOf } = commandWithDescendant(dir, 'e2e');
    const { provider, tunnel } = deviceChain();
    const controller = new AbortController();

    const pending = provider.tools.exec.execute(command, { signal: controller.signal });
    const descendant = await pidOf();
    expect(alive(descendant)).toBe(true);

    // The Stop button, `kinu stop`, a cancelled background job and the turn's
    // own abort all arrive here as this one signal.
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'laptop exec stopped — the device confirmed its owned command process group terminated; separately sessioned processes may still run',
    });
    expect(await gone(descendant)).toBe(true);
    tunnel.dispose();
  }, 30_000);

  /**
   * The same chain when the far end genuinely cannot kill the command.
   *
   * The daemon's authority over a running command is its supervisor: that
   * process holds the command's group and is the only thing that can signal it.
   * Kill the supervisor and the group is beyond the daemon's reach — the case
   * where "terminated" would be a lie about the user's own machine, and the
   * processes are there to prove it.
   */
  test('a stop the device cannot perform is reported as unconfirmed, with the command still running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-agent-orphan-'));
    const { command, pidOf } = commandWithDescendant(dir, 'orphan');
    const { provider, tunnel } = deviceChain();
    const controller = new AbortController();
    const issued: string[] = [];

    const pending = provider.tools.exec.execute(command, {
      signal: controller.signal,
      onDeviceRequest: (requestId: string) => { issued.push(requestId); },
    });
    const descendant = await pidOf();
    const supervisor = await supervisorState(issued[0]);

    process.kill(supervisor.pid, 'SIGKILL');
    // Not "signalled" — GONE from the process table. A supervisor still visible
    // as a corpse would be signalled by the daemon and never answer, which is a
    // different failure from the one under test.
    expect(await gone(supervisor.pid)).toBe(true);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pending).rejects.toThrow(/could not stop the command, which may still be running/);
    await expect(pending).rejects.toThrow(/supervisor identity no longer matches/);
    // And that report is true, which is the whole point: the command's own
    // child is still on this machine after the turn said it could not be stopped.
    expect(alive(descendant)).toBe(true);

    tunnel.dispose();
    process.kill(-supervisor.group, 'SIGKILL');
    expect(await gone(descendant)).toBe(true);
  }, 30_000);
});

/**
 * The completion boundary, from the machine's side.
 *
 * A command finishes on its own, and the supervisor spends a drain window
 * before publishing the result. A cancellation landing anywhere in there has
 * nothing left to kill, and the answer it gets is one of two refusals: inside
 * the window the command's own process group leader is already gone, so the
 * daemon will not signal a pid it can no longer identify; after it, no control
 * entry remains. Neither is "terminated", and the command's own result must
 * still arrive, once, exactly as it happened.
 */
describe('pc-agent cancellation racing a command\'s own completion', () => {
  test('claims no kill, and the command\'s real result still lands exactly once', async () => {
    const ws = recorder();
    const runId = rpcId(270);
    handle({ id: runId, method: 'exec', params: ['echo finished'] }, ws.socket);
    const supervisor = await supervisorState(runId);

    // The command's shell has left the process table, so the command is over
    // and the supervisor is at or inside its drain window.
    expect(await gone(supervisor.group)).toBe(true);
    cancel(rpcId(271), runId, ws.socket);

    const answer = await settled(() => ws.of(rpcId(271))[0], 'the cancellation answer');
    const claim = v.safeParse(DeviceCancelResultSchema, answer.result);
    // Never a claimed kill — this cancellation stopped nothing, because there
    // was nothing left to stop.
    if (claim.success) expect(claim.output).toEqual({ requestId: runId, cancelled: 'unknown' });
    else expect(answer.error).toContain(`cannot terminate ${runId}`);

    const finished = await settled(() => ws.of(runId)[0], 'the exec answer');
    const result = v.parse(ExecResultSchema, finished.result);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('finished');

    acknowledge(rpcId(272), runId, ws.socket);
    await settled(() => ws.of(rpcId(272))[0], 'the completion ACK');
    // One result frame for this command, before the cancellation and after it:
    // a settled request publishes nothing further.
    expect(ws.of(runId)).toHaveLength(1);
  }, 30_000);
});

describe('pc-agent readRange RPC', () => {
  test('reads only the requested binary range, never a whole-file fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-agent-range-'));
    const file = join(dir, 'large.bin');
    const window = 512 * 1024;
    const sentinel = Buffer.from('SENTINEL-PAST-WINDOW');
    writeFileSync(file, Buffer.concat([Buffer.alloc(window, 0x41), sentinel]));
    const ws = recorder();

    handle({
      id: 'rpc-range', method: 'readRange', params: [file, 0, window],
    }, ws.socket);

    const reply = ws.of('rpc-range')[0];
    const result = v.parse(v.object({ encoding: v.literal('base64'), content: v.string() }), reply.result);
    const bytes = Buffer.from(result.content, 'base64');
    expect(bytes).toHaveLength(window);
    expect(bytes.includes(sentinel)).toBe(false);
  });

  test('refuses an invalid range before filesystem access', () => {
    const ws = recorder();
    handle({
      id: 'rpc-invalid-range', method: 'readRange', params: ['/does/not/exist', -1, 0],
    }, ws.socket);
    expect(ws.of('rpc-invalid-range')[0].error).toContain('positive safe offset and length');
  });
});
