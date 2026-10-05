/**
 * chess dqf52o, staging 85a438698, 2026-10-02: a helper's foreground `node server.js` held the helper for the
 * sandbox command's whole 385 s, since only the root's tools detached. A hired agent's long command now outruns its
 * window into a job of the hire's own: the hire is told the handle, its view lists the job and hears its output, the
 * owner's cancel ends it, and the settle wakes the hire.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { actorConnectionTag, JOB_OUTPUT_EVENT, JOB_STAMP_ENV, JobOutputFrameSchema } from '@kinu.run/core';
import { execRecords } from '@kinu.run/devbox';
import { handClock, present, type HandClock } from '@kinu.run/test-utils';
import { catalogTurn, driveUntil, gatewayWorkspace, wakeForDelegatedTask } from './helpers/actor-harness';
import { socketConnection } from './helpers/bindings';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

const START = 'Start the server and leave it running.';

const SERVING = 'serving on :3000\n';

/** How long `node server.js` serves before it exits, on the job clock: past the 30 s window. */
const SERVES_MS = 60_000;

/** The box's exposed port while `node server.js` serves, held by the command the job's stamp names. */
const SERVED_PORT = 3000;

/** A command's options as the lane hands them to the box: the job's stamp rides in its environment. */
interface BoxExec {
  readonly execId: string;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The box: `node server.js` prints its line at once and exits SERVES_MS on, or at the kill that ends it first. While it
 * runs it listens on SERVED_PORT, which the box exposes and names its listener by the stamp the command ran under.
 */
function serverBox(clock: HandClock, killed: string[] = []) {
  const running = new Map<string, (exitCode: number) => void>();
  const stamps = new Map<string, string | null>();

  const serve = ({ execId, env }: BoxExec, exit: (exitCode: number) => void): void => {
    const once = (exitCode: number): void => {
      stamps.delete(execId);

      if (running.delete(execId)) exit(exitCode);
    };

    running.set(execId, once);
    stamps.set(execId, env?.[JOB_STAMP_ENV] ?? null);
    clock.after(SERVES_MS, () => { once(0); });
  };

  return {
    resolveReadiness: async () => ({ kind: 'restored' as const }),
    configureEgress: async () => {},
    restoreStatus: async () => ({ restoring: false, refused: undefined }),
    getExposedPorts: async (hostname: string) => (stamps.size === 0 ? [] : [{ port: SERVED_PORT, name: undefined, url: `https://${String(SERVED_PORT)}-box-token.${hostname}` }]),
    portListeners: async () => [...stamps.values()].map((stamp) => ({ port: SERVED_PORT, pid: 1, stamp, command: 'node server.js' })),
    // Whole, as the runtime answers a call that streams nothing.
    execUntimed: (_command: string, exec: BoxExec) => new Promise((resolve) => {
      serve(exec, (exitCode) => { resolve({ stdout: SERVING, stderr: '', exitCode }); });
    }),
    execUntimedStream: async (_command: string, exec: BoxExec) => {
      const exitCode = Promise.withResolvers<number>();

      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(SERVING));
          serve(exec, (code) => {
            controller.close();
            exitCode.resolve(code);
          });
        },
      });

      return execRecords({ stdout, stderr: null, exitCode: exitCode.promise }, { exited: () => {}, cancelled: async () => {} });
    },
    releaseUntimed: async () => {},
    // The process tree ends as the runtime ends it: the command exits on the signal.
    killUntimed: async (execId: string) => {
      const end = running.get(execId);
      killed.push(execId);
      end?.(137);

      return end !== undefined;
    },
  };
}

/** What a model call was asked, without the runtime state blocks the turn adds. */
const asked = (run: RecordedGatewayRun): string[] => requestOf(run).messages
  .filter((message) => message.role === 'user' && !JSON.stringify(message.content).includes('<dynamic_context'))
  .map((message) => JSON.stringify(message.content));

/** The answers a model call read back from its tool calls. */
const toolAnswers = (run: RecordedGatewayRun): string[] => requestOf(run).messages
  .filter((message) => message.role === 'tool').map((message) => JSON.stringify(message.content));

/**
 * An agent the owner added, asked to start the server, its call run up to the moment its model reads the answer back.
 * The clock's first wait is the call's window, armed ahead of the box reaching the command, and its second the server's
 * life on the box; fired once the server runs, the window lets the call outrun it.
 */
async function hiredServer() {
  const clock = handClock(Date.now());

  // The hire starts the server and, read back its answer, says so; woken by the settle, it notes it.
  const gateway = stubAiBinding((run) => {
    if (asked(run).at(-1)?.includes(START) !== true) return chatCompletion(run, 'Noted.');

    return toolAnswers(run).length === 0
      ? toolCallCompletion(run, { tool: 'shell', args: { command: 'node server.js', runtime: 'sandbox' } }, 'call_server')
      : chatCompletion(run, 'The server is running in the background.');
  });

  // One box, whichever agent's runtime asks for it, as one workspace has; its preview host named from the start.
  const box = serverBox(clock);
  const workspace = gatewayWorkspace(gateway, { container: true, box: () => box, jobClock: clock, previewHostSuffix: 'preview.test' });
  // The owner's egress vault is read before a sandbox command runs.
  workspace.agent.harnessDeclareEnv({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
  // An agent added takes the workspace's purpose, so the workspace has one first.
  await workspace.agent.setSoul('# Purpose\n\nRun the dev server.');
  const { name } = await workspace.agent.createSubordinateAgent();
  const route = await workspace.agent.resolveHostedActorRoute(name);

  if ('reason' in route) throw new Error(route.error);

  // The workspace's window and the hire's, and what each hears of a job's output.
  const windows = [socketConnection({ id: 'workspace', tags: [] }), socketConnection({ id: 'hire', tags: [actorConnectionTag(route.actorId)] })];
  const heard = new Map<string, string[]>([['workspace', []], ['hire', []]]);

  Object.defineProperty(workspace.agent, 'getConnections', { configurable: true, value: () => windows });
  Object.defineProperty(workspace.agent, 'broadcast', {
    configurable: true,
    value: (message: string, without: readonly string[] = []) => {
      const frame = v.safeParse(JobOutputFrameSchema, JSON.parse(message));

      if (!frame.success || frame.output.type !== JOB_OUTPUT_EVENT) return;

      for (const window of windows) {
        if (!without.includes(window.id)) heard.get(window.id)?.push(frame.output.chunks.map((chunk) => chunk.text).join(''));
      }
    },
  });

  expect(clock.armed()).toBe(0);
  await wakeForDelegatedTask(workspace, route.actorId, START);
  await clock.whenArmed(2);
  clock.tick();

  const answered = () => gateway.runs.find((run) => toolAnswers(run).length > 0);
  await driveUntil(workspace, "the hire's model never read its shell's answer", () => answered() !== undefined);
  const [job] = await workspace.agent.listBackgroundJobs(20, name);

  /** The hire's model call that was woken about `jobId`. */
  const woken = (jobId: string) => gateway.runs.find((run) => asked(run).at(-1)?.includes(jobId) === true);

  return { clock, workspace, name, heard, woken, job, told: toolAnswers(present(answered(), 'the answered run')).join('') };
}

test("a hired agent's command that outruns its window becomes the hire's own job, streamed to its view", async () => {
  const { clock, workspace, name, heard, woken, job, told } = await hiredServer();

  expect(told).toContain('backgrounded');
  // Its server holds the box's port, though the workspace's own chat never touched the box (review of 4028013fc).
  expect(job).toMatchObject({ kind: 'shell', status: 'serving' });
  const jobId = present(job, "the hire's job").id;
  expect(told).toContain(jobId);
  // The hire's, not the workspace's.
  expect(await workspace.agent.listBackgroundJobs(20)).toEqual([]);

  // The job runs the command on the box; the server exits once it has served, and the settle is the hire's next turn.
  await clock.whenArmed(2);
  clock.advance(SERVES_MS);
  await driveUntil(workspace, 'the settle never woke the hire', () => woken(jobId) !== undefined);

  expect((await workspace.agent.listBackgroundJobs(20, name))[0]).toMatchObject({ id: jobId, status: 'completed' });
  // What the server printed reached the hire's view, and only it.
  expect(heard.get('hire')?.join('')).toBe(SERVING);
  expect(heard.get('workspace')).toEqual([]);
});

test("the owner's cancel ends a hired agent's job and its command, and wakes the hire", async () => {
  const { clock, workspace, name, woken, job, told } = await hiredServer();

  expect(told).toContain('backgrounded');
  const jobId = present(job, "the hire's job").id;

  // Cancelled while the server runs: the box's process is what ends.
  await clock.whenArmed(2);
  expect(await workspace.agent.cancelBackgroundJob(jobId)).toEqual({ ok: true });
  await driveUntil(workspace, 'the cancel never woke the hire', () => woken(jobId) !== undefined);

  expect((await workspace.agent.listBackgroundJobs(20, name))[0]).toMatchObject({ id: jobId, status: 'cancelled' });
});

test("the owner's retry runs a hired agent's settled job again as the hire, and its settle wakes the hire", async () => {
  const { clock, workspace, name, heard, woken, job } = await hiredServer();
  const jobId = present(job, "the hire's job").id;

  await clock.whenArmed(2);
  clock.advance(SERVES_MS);
  await driveUntil(workspace, 'the settle never woke the hire', () => woken(jobId) !== undefined);

  const retried = await workspace.agent.retryBackgroundJob(jobId, name);
  const retryId = present(retried.jobId, `the retry's job, answered ${JSON.stringify(retried)}`);
  expect((await workspace.agent.listBackgroundJobs(20, name))[0]).toMatchObject({ id: retryId, kind: 'shell' });
  expect(await workspace.agent.listBackgroundJobs(20)).toEqual([]);

  // The same command runs on the box again, its output in the hire's view, and its settle is the hire's next turn.
  // The first call armed its window, its server's life and an output flush; the retry arms its server's and a flush.
  await clock.whenArmed(5);
  clock.advance(SERVES_MS);
  await driveUntil(workspace, "the retry's settle never woke the hire", () => woken(retryId) !== undefined);

  expect(await workspace.agent.listBackgroundJobs(20, name)).toMatchObject([
    { id: retryId, status: 'completed' }, { id: jobId, status: 'completed', retriedBy: retryId },
  ]);
  expect(heard.get('hire')?.join('')).toBe(SERVING + SERVING);
  expect(heard.get('workspace')).toEqual([]);
});

test("the owner's Stop ends a call still in its foreground, on the box too", async () => {
  const clock = handClock(Date.now());
  const killed: string[] = [];

  const gateway = stubAiBinding((run) => (toolAnswers(run).length === 0
    ? toolCallCompletion(run, { tool: 'shell', args: { command: 'node server.js', runtime: 'sandbox' } }, 'call_server')
    : chatCompletion(run, 'Stopped.')));

  const workspace = gatewayWorkspace(gateway, { container: true, box: () => serverBox(clock, killed), jobClock: clock, previewHostSuffix: 'preview.test' });
  workspace.agent.harnessDeclareEnv({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
  const turn = catalogTurn(workspace.agent, START);

  // The call's window, then the box's server: the command runs, in the foreground.
  await clock.whenArmed(2);
  expect(await workspace.agent.cancelCurrentWork()).toMatchObject({ abortedTools: 1 });
  await turn;

  expect(killed).toHaveLength(1);
  expect(await workspace.agent.listBackgroundJobs(20)).toEqual([]);
});
