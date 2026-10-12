/**
 * A Stop of a workspace command, on the hosted workspace's own shell, is confirmed only once nothing of the command can
 * still run. Gated at the box's start seams as a cold workspace holds them: its readiness, and the command's admission
 * once sent; and at the start's answer, lost after the command started.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { exists } from '@nimbus-sh/core/vfs/vfs.js';
import { nimbusSessionShell, WORKSPACE_ROOT, type NimbusSandboxHandle } from '@kinu.run/core';
import { createHostedWorkspace, type HostedBox } from '../src/workspace-host';
import {
  actorObjectState, durableObjectStorage, durableSqlStorage, durableStorage, HELD_NIMBUS_TASKS, SCRIPT_EXPORTS,
} from './helpers/programmatic-host';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/** One agent's box on a hosted workspace; nothing here spawns a facet, so the loader and the host namespace refuse. */
function hostedBox(): HostedBox {
  const database = new Database(':memory:');
  databases.push(database);
  const refused = (): never => { throw new Error('a shell command reached a facet'); };

  const workspace = createHostedWorkspace({
    tasks: HELD_NIMBUS_TASKS,
    ctx: actorObjectState({
      id: { toString: () => 'stop-actor', equals: () => false, name: 'stop-actor' },
      storage: durableObjectStorage({
        ...durableStorage(new Map()),
        sql: durableSqlStorage(database),
        transactionSync: <T,>(closure: () => T): T => database.transaction(closure)(),
      }),
      waitUntil: () => {},
      getWebSockets: () => [],
      exports: SCRIPT_EXPORTS,
    }),
    env: {
      NIMBUS_RUNTIME_CACHE: undefined,
      ASSETS: undefined,
      LOADER: Object.assign({ get: refused }, { load: refused }),
      OrchestratorAgent: { get: refused, idFromName: refused, idFromString: refused },
    },
    previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
  });

  return workspace.box('agent:main');
}

/** The box's own stream, its start and exit written to `seen` as the box answers. */
function streamOf(box: HostedBox, seen: string[]): NonNullable<NimbusSandboxHandle['execStream']> {
  const { execStream } = box;

  if (execStream === undefined) throw new Error('the hosted box streams no command');

  return async (command, options) => {
    const stream = await execStream(command, options);

    seen.push('started');
    void stream.exit.then(() => { seen.push('exited'); }, () => { seen.push('exited'); });

    return stream;
  };
}

describe('a Stop of a hosted workspace command', () => {
  test('while the workspace readies, nothing is sent, and the command never runs', async () => {
    const box = hostedBox();
    const seen: string[] = [];
    const streamed = streamOf(box, seen);
    const asked = Promise.withResolvers<'ready' | 'sent'>();
    const readying = Promise.withResolvers<void>();
    let readied: Promise<void> | undefined;

    const gated: NimbusSandboxHandle = {
      ...box,
      ready: () => {
        asked.resolve('ready');
        readied = readying.promise.then(() => box.ready());

        return readied;
      },
      execStream: (command, options) => {
        asked.resolve('sent');

        return streamed(command, options);
      },
    };

    const controller = new AbortController();
    const pending = nimbusSessionShell(gated, { home: WORKSPACE_ROOT }).exec('printf changed > after-stop.txt', { signal: controller.signal });

    // Red: the command went out without the box being readied first.
    expect(await asked.promise).toBe('ready');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'workspace exec cancelled before it started' });

    // The shell's own wait on readiness resumes before this one, so a command it sent would be in `seen`.
    readying.resolve();
    await readied;
    expect(seen).toEqual([]);
    expect(await exists(box.store({ home: WORKSPACE_ROOT }), 'after-stop.txt')).toBe(false);
  });

  test('while the command is admitted, the answer waits for it to start and for the exit its cancel causes', async () => {
    const box = hostedBox();
    const seen: string[] = [];
    const streamed = streamOf(box, seen);
    const asked = Promise.withResolvers<void>();
    const admitted = Promise.withResolvers<void>();

    const gated: NimbusSandboxHandle = {
      ...box,
      execStream: async (command, options) => {
        asked.resolve();
        await admitted.promise;

        return await streamed(command, options);
      },
    };

    const controller = new AbortController();
    const pending = nimbusSessionShell(gated, { home: WORKSPACE_ROOT }).exec('printf changed > after-stop.txt', { signal: controller.signal });

    void pending.catch(() => { seen.push('answered'); });
    await asked.promise;
    controller.abort();
    admitted.resolve();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'workspace exec cancelled: the command was stopped' });
    // Red: answered while the command waited for admission, which then ran it after the answer.
    expect(seen).toEqual(['started', 'exited', 'answered']);
  });

  test('a running command is cancelled, and the answer waits for its exit', async () => {
    const box = hostedBox();
    const seen: string[] = [];
    const streamed = streamOf(box, seen);
    const running = Promise.withResolvers<void>();

    const gated: NimbusSandboxHandle = {
      ...box,
      execStream: async (command, options) => {
        const stream = await streamed(command, options);

        running.resolve();

        return stream;
      },
    };

    const controller = new AbortController();
    const pending = nimbusSessionShell(gated, { home: WORKSPACE_ROOT }).exec('sleep 3600', { signal: controller.signal });

    void pending.catch(() => { seen.push('answered'); });
    await running.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'workspace exec cancelled: the command was stopped' });
    expect(seen).toEqual(['started', 'exited', 'answered']);
  });

  test('whose start answer is lost, finds the command by its exec id and kills it before answering', async () => {
    const box = hostedBox();
    const start = lostAnswer(box);
    const controller = new AbortController();

    const pending = nimbusSessionShell({ ...box, execStream: start.execStream }, { home: WORKSPACE_ROOT })
      .exec('echo started; sleep 3600', { signal: controller.signal });

    try {
      await start.running;
      controller.abort();
      start.drop();
      // Red: answered as never started, and the command ran on.
      await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'workspace exec cancelled: the command was stopped' });
      // The command's own stream ends: what the Stop killed is the command it started.
      await start.ended();
    } finally {
      await start.release();
    }
  });

  test('whose start answer is lost, on a box that cannot be asked for its processes, says the stop is unconfirmed', async () => {
    const box = hostedBox();
    const start = lostAnswer(box);
    const controller = new AbortController();

    const pending = nimbusSessionShell({
      ready: async () => { await box.ready(); },
      exec: async (command, options) => await box.exec(command, options),
      execStream: start.execStream,
    }, { home: WORKSPACE_ROOT })
      .exec('echo started; sleep 3600', { signal: controller.signal });

    try {
      await start.running;
      controller.abort();
      start.drop();
      // Red: answered as never started, while the command runs.
      await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: expect.stringMatching(/^workspace exec stop unconfirmed: .* exec \S+/) });
    } finally {
      await start.release();
    }
  });
});

/**
 * The box's own stream behind a start answer that is lost: the command starts and is heard from, then `drop` loses the
 * answer. `ended` settles once the command's own stream ends; `release` cancels it, so no command outlives the test.
 */
function lostAnswer(box: HostedBox) {
  const { execStream } = box;

  if (execStream === undefined) throw new Error('the hosted box streams no command');
  const running = Promise.withResolvers<void>();
  const lost = Promise.withResolvers<void>();
  const kept: { readonly reader: ReadableStreamDefaultReader<unknown>; readonly exit: Promise<unknown> }[] = [];

  const lose: NonNullable<NimbusSandboxHandle['execStream']> = async (command, options) => {
    const stream = await execStream(command, options);
    const reader = stream.output.getReader();

    kept.push({ reader, exit: stream.exit });
    await reader.read();
    running.resolve();
    await lost.promise;
    throw new Error('the start answer was lost on its way back');
  };

  return {
    execStream: lose,
    running: running.promise,
    drop: () => { lost.resolve(); },
    ended: async () => { await Promise.allSettled(kept.map((stream) => stream.exit)); },
    release: async () => { await Promise.all(kept.map((stream) => stream.reader.cancel())); },
  };
}
