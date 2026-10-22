/**
 * A hosted workspace's background process, read back (`processes.logs`): what `workspace.logs(pid)` answers a program.
 * Staging, rc29 (GLM-5.3): every read of a process that had ended failed `nimbus logs 1000002: Invalid JSON value:
 * Received Object`, as Nimbus records an exit with no reason as `reason: undefined`, which no JSON value holds.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { NimbusSandboxHandle } from '@kinu.run/core';
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
      id: { toString: () => 'logs-actor', equals: () => false, name: 'logs-actor' },
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

/** The box's process verbs, which a hosted box always has. */
function processVerbs(box: HostedBox) {
  const processes: NonNullable<NimbusSandboxHandle['processes']> = present(box.processes, "the hosted box's processes");
  const absent = (verb: string) => new Error(`the hosted box has no process ${verb}`);

  return {
    start: async (command: string) => (box.startProcess === undefined ? Promise.reject(absent('start')) : box.startProcess(command)),
    list: async () => (processes.list === undefined ? Promise.reject(absent('list')) : processes.list()),
    logs: async (pid: number) => (processes.logs === undefined ? Promise.reject(absent('logs')) : processes.logs(pid)),
    kill: async (pid: number) => (processes.kill === undefined ? Promise.reject(absent('kill')) : processes.kill(pid)),
    whenEnded: async (pid: number) => (processes.whenEnded === undefined ? Promise.reject(absent('end')) : processes.whenEnded(pid)),
  };
}

describe("a hosted workspace's background process, read back", () => {
  test('one that has ended answers what it wrote and how it ended', async () => {
    const box = processVerbs(hostedBox());
    const started = await box.start('echo built; exit 3');

    await box.whenEnded(started.pid);

    expect(await box.logs(started.pid)).toMatchObject({
      pid: started.pid, text: 'built\n', truncated: false, exit: { code: 3, at: expect.any(Number) },
    });
  });

  test('one that has ended is listed with how it ended', async () => {
    const box = processVerbs(hostedBox());
    const started = await box.start('echo built; exit 3');

    await box.whenEnded(started.pid);

    // Beside the session's own shell.
    expect(await box.list()).toEqual(expect.arrayContaining([expect.objectContaining({ pid: started.pid, state: 'exited', exitCode: 3 })]));
  });

  test('one still running answers no exit', async () => {
    const box = processVerbs(hostedBox());
    const started = await box.start('sleep 30');

    expect(await box.logs(started.pid)).toMatchObject({ pid: started.pid, exit: null });
    await box.kill(started.pid);
  });
});
