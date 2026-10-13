/**
 * A Stop of a workspace command, on the hosted workspace's own shell, is confirmed only once nothing of the command can
 * still run. Gated at the box's start seams as a cold workspace holds them: its readiness, and the command's admission
 * once sent; and at the start's answer, lost after the command started.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { exists, writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { nimbusSessionShell, WORKSPACE_ROOT, type NimbusSandboxHandle } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';
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

/** A command that waits for `gate` to be written, then writes `marker`: what it does after a Stop shows whether it ran on. */
const gated = (marker: string) => `until test -e gate; do sleep 0.1; done; printf ran > ${marker}`;

describe('a Stop of a hosted workspace command', () => {
  test('while the workspace readies, nothing is sent, and the command never runs', async () => {
    const box = hostedBox();
    const asked = Promise.withResolvers<void>();
    const readying = Promise.withResolvers<void>();
    let readied: Promise<void> | undefined;
    const sent: string[] = [];

    const readiedLate: NimbusSandboxHandle = {
      ...box,
      ready: () => {
        asked.resolve();
        readied = readying.promise.then(() => box.ready());

        return readied;
      },
      // What reaches the box: a command sent there would run.
      execStream: async (command, options) => {
        sent.push(command);

        return await present(box.execStream, 'the hosted box\'s stream')(command, options);
      },
    };

    const controller = new AbortController();
    const pending = nimbusSessionShell(readiedLate, { home: WORKSPACE_ROOT }).exec('printf changed > after-stop.txt', { signal: controller.signal });

    await asked.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    // Readiness arrives after the Stop: nothing is sent, and no file is written.
    readying.resolve();
    await readied;
    expect(sent).toEqual([]);
    expect(await exists(box.store({ home: WORKSPACE_ROOT }), 'after-stop.txt')).toBe(false);
  });

  test('while the command is admitted, the answer waits until the command it admits has ended', async () => {
    const box = hostedBox();
    const { execStream } = box;

    if (execStream === undefined) throw new Error('the hosted box streams no command');
    const asked = Promise.withResolvers<void>();
    const admitted = Promise.withResolvers<void>();
    const started: Promise<unknown>[] = [];

    const admittedLate: NimbusSandboxHandle = {
      ...box,
      execStream: async (command, options) => {
        asked.resolve();
        await admitted.promise;
        const stream = await execStream(command, options);

        started.push(stream.exit);

        return stream;
      },
    };

    const controller = new AbortController();
    const pending = nimbusSessionShell(admittedLate, { home: WORKSPACE_ROOT }).exec(gated('after-stop.txt'), { signal: controller.signal });

    await asked.promise;
    controller.abort();
    admitted.resolve();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    // Red: answered while the command waited for admission, which then ran it after the answer.
    await writeText(box.store({ home: WORKSPACE_ROOT }), 'gate', '');
    await Promise.allSettled(started);
    expect(await exists(box.store({ home: WORKSPACE_ROOT }), 'after-stop.txt')).toBe(false);
  });

  test('whose start answer is lost, finds the command by its exec id and kills it before answering', async () => {
    const box = hostedBox();
    const start = lostAnswer(box);
    const controller = new AbortController();

    const pending = nimbusSessionShell({ ...box, execStream: start.execStream }, { home: WORKSPACE_ROOT })
      .exec(`echo started; ${gated('after-stop.txt')}`, { signal: controller.signal });

    try {
      await start.running;
      controller.abort();
      start.drop();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

      // Red: answered as never started, and the command ran on to write its file once let.
      await writeText(box.store({ home: WORKSPACE_ROOT }), 'gate', '');
      await start.ended();
      expect(await exists(box.store({ home: WORKSPACE_ROOT }), 'after-stop.txt')).toBe(false);
    } finally {
      await start.release();
    }
  });

  test('whose start answer is lost, on a box that cannot be asked for its processes, leaves the command it cannot find', async () => {
    const box = hostedBox();
    const start = lostAnswer(box);
    const controller = new AbortController();

    const pending = nimbusSessionShell({
      ready: async () => { await box.ready(); },
      exec: async (command, options) => await box.exec(command, options),
      execStream: start.execStream,
    }, { home: WORKSPACE_ROOT })
      .exec(`echo started; ${gated('ran-on.txt')}`, { signal: controller.signal });

    try {
      await start.running;
      controller.abort();
      start.drop();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

      // Nothing could find the command to stop it, and the answer claimed no stop: it runs on.
      await writeText(box.store({ home: WORKSPACE_ROOT }), 'gate', '');
      await start.ended();
      expect(await exists(box.store({ home: WORKSPACE_ROOT }), 'ran-on.txt')).toBe(true);
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
