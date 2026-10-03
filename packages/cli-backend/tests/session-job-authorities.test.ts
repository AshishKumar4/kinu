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
