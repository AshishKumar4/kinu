/**
 * A session's jobs are the actors': every operation reaches the runner over the job's rows, the root's or a node's.
 * Review of 4028013fc, 2026-10-03: only the root's runner swept orphans, so a node's job the process died under stayed
 * running for good, holding a slot of the detach cap.
 */
import { expect, test } from 'bun:test';
import { explorationActorKey, registerLocalActor } from '@kinu.run/core';
import { jobColumn, setup } from './helpers/local-session';

test("recoverBackgroundJobs settles a swarm node's job its ended loop left running, and wakes no one for it", async () => {
  const { db, rt, session, events } = setup();
  const node = registerLocalActor(rt.actor, { name: explorationActorKey('dead-node'), creationId: 'dead-node', origin: 'swarm', lifetime: 'task' });

  // No fiber row: the node's loop held it in this process, and the process is gone.
  db.exec(`INSERT INTO background_jobs (actor_id, id, kind, work_mode, status, created_at) VALUES ('${node.reference.actorId}', 'bgjob-node', 'shell', 'build', 'running', 1)`);

  await session.recoverBackgroundJobs();
  await session.settleBackgroundWork();

  expect(jobColumn(db, 'bgjob-node', 'status')).toBe('failed');
  expect(jobColumn(db, 'bgjob-node', 'error')).toContain('interrupted');
  expect(events.items.some((e) => e.type === 'turn-start' && e.kind === 'programmatic')).toBe(false);
});

// Main's queue (b), 2026-10-03: the CLI listed the workspace's jobs alone; the cloud lists any hosted actor's.
test("an agent's jobs are listed by its name, apart from the workspace's own", async () => {
  const { db, rt, session } = setup();
  const hire = registerLocalActor(rt.actor, { name: 'builder', creationId: 'builder', origin: 'agent', lifetime: 'durable' });

  db.exec(`INSERT INTO background_jobs (actor_id, id, kind, work_mode, status, created_at) VALUES ('${hire.reference.actorId}', 'bgjob-hire', 'shell', 'build', 'running', 1)`);

  expect((await session.listBackgroundJobs(20, 'builder')).map((job) => job.id)).toEqual(['bgjob-hire']);
  expect(await session.listBackgroundJobs(20)).toEqual([]);
  await expect(session.listBackgroundJobs(20, 'nobody')).rejects.toThrow('No agent named nobody');
});
