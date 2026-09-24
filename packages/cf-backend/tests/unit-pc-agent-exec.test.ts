/**
 * The PC daemon's `exec` RPC (`packages/pc-agent/src/index.js`), the far end of the device tunnel.
 * Defends: the device copy of the shell contract drifting from the local host shell. Driven through `handle`.
 */

import { scratchDir } from '../../test-utils/src/scratch';
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { join } from 'node:path';
import * as v from 'valibot';
import {
  DEVICE_CANCEL_METHOD, DEVICE_CANCEL_PROTOCOL, DEVICE_CANCEL_VERSION_REFUSAL, DEVICE_EXEC_ACK_METHOD,
  DEVICE_PTY_CLOSE, DEVICE_PTY_EXIT, DEVICE_PTY_INPUT, DEVICE_PTY_OPEN_METHOD, DEVICE_PTY_OUTPUT, DEVICE_PTY_RESIZE,
  DEVICE_UNKNOWN_METHOD, DeviceCancelResultSchema, DeviceTunnel, JsonValueSchema, createDeviceTunnelExecutor,
  type DeviceStatus, type DeviceTransport, type TunnelSocket,
} from '@kinu.run/core';

const require_ = createRequire(import.meta.url);

const WatchableFileSystemSchema = v.object({ watch: v.function() });

interface DaemonMessage {
  readonly id: string;
  readonly method: string;
  readonly params: readonly (string | number)[];
}

interface ReplySocket { send(data: string): void }

const DaemonFrameSchema = v.object({
  id: v.string(),
  method: v.string(),
  params: v.array(v.union([v.string(), v.number()])),
});

/** A dropped socket calls into `inFlight` directly, so disconnect is exercised without a real WebSocket. */
/** `terminated` stays unparsed until awaited: a pending promise has no shape to check. */
const SweepSchema = v.array(v.object({ requestId: v.string(), terminated: v.unknown() }));

const ConfirmedCancellationSchema = v.object({ requestId: v.string(), cancelled: v.string() });

const PcAgentModuleSchema = v.object({
  handle: v.function(),
  inFlight: v.object({
    size: v.function(),
    terminateUnanswered: v.function(),
  }),
  createInFlight: v.function(),
  INFLIGHT_ROOT: v.string(),
  CANCEL_METHOD: v.string(),
  CANCEL_PROTOCOL: v.number(),
  EXEC_ACK_METHOD: v.string(),
  PTY_OPEN_METHOD: v.string(),
  PTY_INPUT_FRAME: v.string(),
  PTY_RESIZE_FRAME: v.string(),
  PTY_CLOSE_FRAME: v.string(),
  PTY_OUTPUT_FRAME: v.string(),
  PTY_EXIT_FRAME: v.string(),
  requestDirectory: v.function(),
  supervisionSupported: v.function(),
  waitForFile: v.function(),
  waitForSupervisorState: v.function(),
});

const SupervisorRegistrySchema2 = v.object({
  terminateUnanswered: v.function(),
});

const SupervisorRegistrySchema = v.object({
  reconcile: v.function(),
  cancel: v.function(),
  acknowledge: v.function(),
});

const pcAgent = v.parse(PcAgentModuleSchema, require_(join(import.meta.dir, '../../pc-agent/src/index.js')));

/** As the hub sends it: with the owner's Sandbox switch, here off. */
function handle(message: DaemonMessage, socket: ReplySocket): void {
  pcAgent.handle({ ...message, sandbox: { tier: 'raw', agentHome: '', roots: [] } }, socket);
}

const ExecResultSchema = v.object({ stdout: v.string(), stderr: v.string(), exitCode: v.number() });

const ExecReplySchema = v.object({
  id: v.string(),
  result: v.optional(ExecResultSchema),
  error: v.optional(v.string()),
});

type ExecReply = v.InferOutput<typeof ExecReplySchema>;

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

/** Run `command` as the hub does: answered, then ACKed, so its supervisor exits with the test. */
async function exec(command: string): Promise<ExecReply> {
  const ws = recorder();
  const id = rpcId(++execSequence);

  handle({ id, method: 'exec', params: [command] }, ws.socket);
  const reply = v.parse(ExecReplySchema, await ws.answerTo(id));
  const ackId = rpcId(++execSequence);

  acknowledge(ackId, id, ws.socket);
  await ws.answerTo(ackId);

  return reply;
}

describe('pc-agent exec RPC', () => {
  test('answers with stdout, stderr and the exit code', async () => {
    const reply = await exec('echo out; echo err 1>&2; exit 4');

    expect(reply.id).toStartWith('rpc-testepoch0-');
    expect(reply.error).toBeUndefined();
    expect(reply.result?.stdout).toContain('out');
    expect(reply.result?.stderr).toContain('err');
    expect(reply.result?.exitCode).toBe(4);
  });

  test('answers when the COMMAND finishes, not when a backgrounded server does', async () => {
    const pidFile = join(scratchDir('pc-agent-background'), 'server.pid');
    const reply = await exec(`sleep 20 & echo $! > ${pidFile}; echo started`);
    const server = Number(readFileSync(pidFile, 'utf8').trim());
    // Still running: an answer that waited for the server would have come after it ended.
    const running = alive(server);

    if (running) process.kill(server, 'SIGKILL');

    expect(reply.result?.stdout).toContain('started');
    expect(reply.result?.exitCode).toBe(0);
    expect(running).toBe(true);
  });

  test('output the command wrote is complete, not cut short by the early answer', async () => {
    const reply = await exec('seq 1 20000');

    expect(reply.result?.exitCode).toBe(0);
    expect(reply.result?.stdout.trimEnd().split('\n')).toHaveLength(20_000);
  });

  test('answers exactly once', async () => {
    const ws = recorder();
    const id = rpcId(100);
    handle({ id, method: 'exec', params: ['echo hi'] }, ws.socket);
    await ws.answerTo(id);
    acknowledge(rpcId(101), id, ws.socket);
    await ws.answerTo(rpcId(101));

    expect(ws.of(id)).toHaveLength(1);
  });
});

/**
 * Cancellation proven against real processes: a cancelled command means a killed process, not a
 * cancelled wait. The `alive before` assertion is the negative control.
 */

function recorder() {
  const replies: DaemonReply[] = [];
  const awaited = new Map<string, (reply: DaemonReply) => void>();

  return {
    replies,
    socket: {
      send: (data: string) => {
        const reply = v.parse(DaemonReplySchema, JSON.parse(data));
        replies.push(reply);
        awaited.get(reply.id)?.(reply);
      },
    },
    of(id: string): DaemonReply[] { return replies.filter((reply) => reply.id === id); },
    /** Awaitable before arrival, so a wait on command output can race the answer. */
    answerTo(id: string): Promise<DaemonReply> {
      const arrived = replies.find((reply) => reply.id === id);

      if (arrived) return Promise.resolve(arrived);
      const { promise, resolve } = Promise.withResolvers<DaemonReply>();
      awaited.set(id, resolve);

      return promise;
    },
  };
}

/** ESRCH = gone, EPERM = exists but not ours; anything else is test breakage. */
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

/** Real time on purpose: only the kernel can say whether a SIGKILL landed. Ends on the condition, never an interval. */
async function settled<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;

  for (;;) {
    const value = read();

    if (value !== undefined) return value;

    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The corpse stays visible to `kill(pid, 0)` until init reaps it. */
function gone(pid: number): Promise<true> {
  return settled(() => (alive(pid) ? undefined : true), `process ${pid} to leave the process table`);
}

const PidSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

const SupervisorStateSchema = v.object({ pid: PidSchema, group: PidSchema });

/** Read from the supervisor's published state, where the daemon reads it too. */
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

/** The pid file is published by rename, so its appearance is the readiness signal. */
function commandWithDescendant(dir: string, name: string) {
  const pidFile = join(dir, `${name}.pid`);

  return {
    command: `(sleep 30 & echo $! > ${pidFile}.part && mv ${pidFile}.part ${pidFile}); sleep 30`,
    /**
     * Races `answer`: a command the daemon refused never writes the pid file, so the daemon's error frame
     * must win the race instead of the wait timing out.
     */
    pidOf: async (answer: Promise<unknown>): Promise<number> => {
      const watching = new AbortController();

      const refused = async (): Promise<never> => {
        let answered: unknown;

        try {
          answered = await answer;
        } catch (err) {
          throw new Error(`the daemon refused the command: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }

        throw new Error(`the daemon answered ${JSON.stringify(answered)} instead of running the command`);
      };

      try {
        const published: Promise<unknown> = Promise.resolve(pcAgent.waitForFile(pidFile, watching.signal));
        await Promise.race([published, refused()]);
      } finally {
        // A lost race otherwise leaks an inotify instance from the per-user kernel cap.
        watching.abort();
      }

      return v.parse(PidSchema, Number(readFileSync(pidFile, 'utf8').trim()));
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
    expect(pcAgent.EXEC_ACK_METHOD).toBe(DEVICE_EXEC_ACK_METHOD);
  });

  // The daemon is dependency-free and cannot import these; this test is the only drift check.
  test('the daemon and core name the same terminal protocol', () => {
    expect(pcAgent.PTY_OPEN_METHOD).toBe(DEVICE_PTY_OPEN_METHOD);
    expect(pcAgent.PTY_INPUT_FRAME).toBe(DEVICE_PTY_INPUT);
    expect(pcAgent.PTY_RESIZE_FRAME).toBe(DEVICE_PTY_RESIZE);
    expect(pcAgent.PTY_CLOSE_FRAME).toBe(DEVICE_PTY_CLOSE);
    expect(pcAgent.PTY_OUTPUT_FRAME).toBe(DEVICE_PTY_OUTPUT);
    expect(pcAgent.PTY_EXIT_FRAME).toBe(DEVICE_PTY_EXIT);
  });

  test('cancellation waits for the owned command group to die', async () => {
    const dir = scratchDir('pc-agent-cancel');
    const { command, pidOf } = commandWithDescendant(dir, 'child');
    const ws = recorder();
    const runId = rpcId(201);
    const cancelId = rpcId(202);

    handle({ id: runId, method: 'exec', params: [command] }, ws.socket);
    const descendant = await pidOf(ws.answerTo(runId));
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
  });

  test('normal result remains replayable until the cloud ACK cleans it up', async () => {
    const dir = scratchDir('pc-agent-normal-ack');
    const pidFile = join(dir, 'server.pid');
    const ws = recorder();
    const runId = rpcId(210);
    const requestDir = join(pcAgent.INFLIGHT_ROOT, runId);
    const sizeBefore = v.parse(v.number(), pcAgent.inFlight.size());

    handle({ id: runId, method: 'exec', params: [`sleep 30 & echo $! > ${pidFile}; echo started`] }, ws.socket);
    const answer = await settled(() => ws.of(runId)[0], 'the exec answer');
    const { pid: supervisor } = await supervisorState(runId);
    expect(v.parse(ExecResultSchema, answer.result).stdout).toContain('started');
    expect(existsSync(join(requestDir, 'result'))).toBe(true);
    expect(pcAgent.inFlight.size()).toBe(sizeBefore + 1);

    const ackId = rpcId(211);
    acknowledge(ackId, runId, ws.socket);
    expect((await settled(() => ws.of(ackId)[0], 'the cloud ACK')).result)
      .toEqual({ requestId: runId, acknowledged: true });
    expect(await settled(() => (!existsSync(requestDir) ? true : undefined), 'supervisor cleanup')).toBe(true);
    expect(pcAgent.inFlight.size()).toBe(sizeBefore);
    // The command's group leader has exited; the ACK must still reach the supervisor, which then ends.
    expect(await gone(supervisor)).toBe(true);

    const server = Number(readFileSync(pidFile, 'utf8').trim());

    if (alive(server)) process.kill(server, 'SIGKILL');
  });

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
  });

  test('a cancellation frame from a version this daemon does not speak is refused', async () => {
    const dir = scratchDir('pc-agent-cancel-version');
    const { command, pidOf } = commandWithDescendant(dir, 'kept');
    const ws = recorder();
    const runId = rpcId(230);
    handle({ id: runId, method: 'exec', params: [command] }, ws.socket);
    const descendant = await pidOf(ws.answerTo(runId));

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
  });

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
    const dir = scratchDir('pc-agent-unregistered');
    const waiting = commandWithDescendant(dir, 'unregistered');
    // Built over the empty root: the live window where the supervisor published but `register` hasn't run.
    const detached = v.parse(SupervisorRegistrySchema2, pcAgent.createInFlight(pcAgent.INFLIGHT_ROOT));
    const ws = recorder();
    handle({ id: rpcId(260), method: 'exec', params: [waiting.command] }, ws.socket);
    const abandoned = await waiting.pidOf(ws.answerTo(rpcId(260)));
    expect(alive(abandoned)).toBe(true);
    await supervisorState(rpcId(260));

    const swept = v.parse(SweepSchema, detached.terminateUnanswered());
    const mine = swept.find((entry) => entry.requestId === rpcId(260));
    expect(mine).toBeDefined();
    expect(v.parse(ConfirmedCancellationSchema, await mine?.terminated))
      .toEqual({ requestId: rpcId(260), cancelled: 'terminated' });
  });

  test('a dropped socket terminates a command that still has no terminal result', async () => {
    const dir = scratchDir('pc-agent-disconnect');
    const waiting = commandWithDescendant(dir, 'waiting');
    const ws = recorder();
    handle({ id: rpcId(250), method: 'exec', params: [waiting.command] }, ws.socket);
    const abandoned = await waiting.pidOf(ws.answerTo(rpcId(250)));
    expect(alive(abandoned)).toBe(true);
    await supervisorState(rpcId(250));

    // Settles only once the kill is confirmed and rejects when unproven; polling `kill(pid, 0)` cannot tell
    // "not yet" from "never". Selected by request id: the sweep terminates every abandoned command at once.
    const swept = v.parse(SweepSchema, pcAgent.inFlight.terminateUnanswered());
    const mine = swept.find((entry) => entry.requestId === rpcId(250));
    expect(mine).toBeDefined();
    expect(v.parse(ConfirmedCancellationSchema, await mine?.terminated))
      .toEqual({ requestId: rpcId(250), cancelled: 'terminated' });
  });
});

describe('pc-agent durable supervisor', () => {
  test('bounds captured output, keeps its head and tail, and saves the whole of it', async () => {
    const ws = recorder();
    const id = rpcId(300);
    const requestDir = join(pcAgent.INFLIGHT_ROOT, id);
    const spill = join(tmpdir(), 'kinu-tool-output', `device-${id}.stdout.log`);
    handle({ id, method: 'exec', params: [`${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(600000) + 'END')"`] }, ws.socket);
    const answer = await settled(() => ws.of(id)[0], 'the bounded output result');
    const result = v.parse(ExecResultSchema, answer.result);

    try {
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`END\n[stdout: 600003 bytes, `);
      expect(result.stdout).toContain(`the full stdout is at ${spill}]`);
      expect(statSync(join(requestDir, 'stdout')).size).toBeLessThan(530_000);
      expect(statSync(spill).size).toBe(600_003);
    } finally {
      rmSync(spill, { force: true });
    }

    acknowledge(rpcId(301), id, ws.socket);
    await settled(() => ws.of(rpcId(301))[0], 'the bounded output ACK');
  });

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
  });
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
  });

  test('refuses a stale supervisor pid identity without signaling that pid', async () => {
    const root = scratchDir('pc-agent-pid-reuse');
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
  });
});

describe('pc-agent supervisor guards', () => {
  test('accepts a filename-less watch event and rejects a watch error', async () => {
    const root = scratchDir('pc-agent-watch');
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
    }
  });

  test('rejects supervisor startup when the child exits before state publication', async () => {
    const root = scratchDir('pc-agent-startup');
    const child = new EventEmitter();
    const pending = pcAgent.waitForSupervisorState(root, child);
    child.emit('exit', 125, null);
    await expect(pending).rejects.toThrow('exited before publishing state');
  });

  // The hammer's red (2026-09-24, run 4 of 6): the exit reached the daemon before the state watch did, so a
  // supervisor that had published its state was reported as never started and the stop test's exec resolved.
  test('accepts a supervisor that published its state even when its exit is dispatched first', async () => {
    const root = scratchDir('pc-agent-startup-published');
    const child = new EventEmitter();
    const pending = pcAgent.waitForSupervisorState(root, child);
    writeFileSync(join(root, 'state'), 'pid=1\n');
    child.emit('exit', null, 'SIGKILL');
    await expect(pending).resolves.toBeUndefined();
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

/** Executor → tunnel → daemon, as the hub wires them. The binding is declared before the socket: the two reference
 *  each other, and nothing reads it before the first frame. */
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

describe('the daemon answers in the words the hub reads', () => {
  test('a method this daemon does not know reaches the hub as unknown, the way a newer frame meets an older daemon', async () => {
    const { tunnel } = deviceChain();

    await expect(tunnel.rpc('methodFromALaterHub', [])).rejects.toThrow(DEVICE_UNKNOWN_METHOD);
    tunnel.dispose();
  });
});

/** The whole chain, executor → tunnel → daemon → real process, aborted the way a stopped turn does. */
describe('stopping a turn reaches the process on the user\'s machine', () => {
  test('the tool\'s abort kills the command and its child, and says it did', async () => {
    const dir = scratchDir('pc-agent-e2e');
    const { command, pidOf } = commandWithDescendant(dir, 'e2e');
    const { provider, tunnel } = deviceChain();
    const controller = new AbortController();

    const pending = provider.tools.exec.execute(command, { signal: controller.signal });
    const descendant = await pidOf(pending);
    expect(alive(descendant)).toBe(true);

    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'device exec stopped — the device confirmed its owned command process group terminated; separately sessioned processes may still run',
    });
    expect(await gone(descendant)).toBe(true);
    tunnel.dispose();
  });

  /** The far end genuinely cannot kill: with the supervisor gone, the group is beyond the daemon's reach. */
  test('a stop the device cannot perform is reported as unconfirmed, with the command still running', async () => {
    const dir = scratchDir('pc-agent-orphan');
    const { command, pidOf } = commandWithDescendant(dir, 'orphan');
    const { provider, tunnel } = deviceChain();
    const controller = new AbortController();
    const issued: string[] = [];

    const pending = provider.tools.exec.execute(command, {
      signal: controller.signal,
      onDeviceRequest: (requestId: string) => { issued.push(requestId); },
    });

    const descendant = await pidOf(pending);
    const supervisor = await supervisorState(issued[0]);

    process.kill(supervisor.pid, 'SIGKILL');
    // Gone, not just signalled: a supervisor corpse would never answer, a different failure.
    expect(await gone(supervisor.pid)).toBe(true);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pending).rejects.toThrow(/could not stop the command, which may still be running/);
    await expect(pending).rejects.toThrow(/supervisor identity no longer matches/);
    expect(alive(descendant)).toBe(true);

    tunnel.dispose();
    process.kill(-supervisor.group, 'SIGKILL');
    expect(await gone(descendant)).toBe(true);
  });
});

/**
 * The completion boundary: a cancel during or after the drain window gets a refusal, never "terminated",
 * and the command's own result still arrives exactly once.
 */
describe('pc-agent cancellation racing a command\'s own completion', () => {
  test('claims no kill, and the command\'s real result still lands exactly once', async () => {
    const ws = recorder();
    const runId = rpcId(270);
    handle({ id: runId, method: 'exec', params: ['echo finished'] }, ws.socket);
    const supervisor = await supervisorState(runId);

    expect(await gone(supervisor.group)).toBe(true);
    cancel(rpcId(271), runId, ws.socket);

    const answer = await settled(() => ws.of(rpcId(271))[0], 'the cancellation answer');
    const claim = v.safeParse(DeviceCancelResultSchema, answer.result);

    if (claim.success) expect(claim.output).toEqual({ requestId: runId, cancelled: 'unknown' });
    else expect(answer.error).toContain(`cannot terminate ${runId}`);

    const finished = await settled(() => ws.of(runId)[0], 'the exec answer');
    const result = v.parse(ExecResultSchema, finished.result);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('finished');

    acknowledge(rpcId(272), runId, ws.socket);
    await settled(() => ws.of(rpcId(272))[0], 'the completion ACK');
    expect(ws.of(runId)).toHaveLength(1);
  });
});

describe('pc-agent readRange RPC', () => {
  test('reads only the requested binary range, never a whole-file fallback', () => {
    const dir = scratchDir('pc-agent-range');
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
