/**
 * An invocation that holds its programs counts every program its own work launches, now or after its body returned,
 * and waits for them; a program another invocation's work launched is not its to wait for. The alarm holds its
 * programs this way: on staging a launcher run was declared hung within a second of the alarm its work started under
 * returning (research HUNG-RPC: launcher runs that outlived their parent).
 */
import { expect, test } from 'bun:test';
import { ProgramsInFlight } from '@kinu.run/core';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();

// Dynamic: a static import hoists above mockAgentsSdk(), which installs the in-process launcher it reaches.
const { codemodeLauncher } = await import('../src/codemode-sandbox');

/** A program that runs until it is released, and the moment it starts waiting. */
function heldProgram() {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<string>();

  const providers = [{ name: 'held', fns: { wait: async () => {
    started.resolve();

    return await release.promise;
  } } }];

  return {
    started: started.promise,
    release: (answer: string) => { release.resolve(answer); },
    run: () => codemodeLauncher({ kinuNode: false, egress: null }).run('async () => await held.wait()', providers),
  };
}

test('the programs its work launches are waited for, and one another invocation launched is not', async () => {
  const programs = new ProgramsInFlight();
  const own = heldProgram();
  const other = heldProgram();
  let ownRun: Promise<unknown> | undefined;

  await programs.run(async () => { ownRun = own.run(); });
  const otherRun = other.run();

  await Promise.all([own.started, other.started]);
  expect(programs.size).toBe(1);

  own.release('own');
  // Only its own: the wait ends while the other program still runs.
  expect(await programs.settled(new Promise<void>(() => {}))).toBe(0);
  expect(await ownRun).toMatchObject({ result: 'own' });

  other.release('other');
  expect(await otherRun).toMatchObject({ result: 'other' });
});

test('work its body started runs on after the body returned, and the programs it launches then are counted', async () => {
  const programs = new ProgramsInFlight();
  const later = heldProgram();
  const go = Promise.withResolvers<void>();
  let detached: Promise<unknown> | undefined;

  await programs.run(async () => { detached = go.promise.then(() => later.run()); });
  expect(programs.size).toBe(0);

  go.resolve();
  await later.started;
  expect(programs.size).toBe(1);

  later.release('later');
  expect(await programs.settled(new Promise<void>(() => {}))).toBe(0);
  expect(await detached).toMatchObject({ result: 'later' });
});

test('a wait that runs out answers how many programs still run, and leaves them running', async () => {
  const programs = new ProgramsInFlight();
  const held = heldProgram();
  let run: Promise<unknown> | undefined;

  await programs.run(async () => { run = held.run(); });
  await held.started;

  const until = Promise.withResolvers<void>();
  const waiting = programs.settled(until.promise);

  until.resolve();
  expect(await waiting).toBe(1);

  held.release('held');
  expect(await run).toMatchObject({ result: 'held' });
  expect(programs.size).toBe(0);
});
