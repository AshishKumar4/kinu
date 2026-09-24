/**
 * A hosted head reports the files it changed, and only those. The capture's observer must reach the plane
 * the head writes to before `host.run` builds the runtime (`CFRuntimeHooks.workspaceObserver`). Two heads
 * write concurrently and each must name only its own file (`heads/file-changes.ts` states the rule). Driven as
 * production drives it: two steer branches of a live turn, every model call the platform gateway's.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { agentHome, headAgentName, parseActorKey } from '@kinu.run/core';
import { chatSessionTurns, gatewayWorkspace } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';

const TASKS = ['write your own note as alpha', 'write your own note as beta'] as const;

/** A rendezvous for `count` arrivals: neither write is issued until both heads hold one. */
function barrier(count: number): () => Promise<void> {
  let arrived = 0;
  const open = Promise.withResolvers<void>();

  return async () => {
    arrived += 1;

    if (arrived >= count) open.resolve();
    await open.promise;
  };
}

const FileChangesSchema = v.array(v.object({ path: v.string(), status: v.string(), added: v.number(), removed: v.number() }));

test('two heads writing at the same time each report only their own file', async () => {
  const arrive = barrier(TASKS.length);
  /** Each head's home, keyed by its task: a head writes inside its own home, which its actor row names. */
  const homes = new Map<string, string>();

  const gateway = stubAiBinding(async (run: RecordedGatewayRun) => {
    const request = requestOf(run);
    const task = TASKS.find((candidate) => JSON.stringify(request.messages[0]?.content ?? '').includes(candidate));

    if (task === undefined) return chatCompletion(run, 'the live turn');

    if (request.messages.some((message) => message.role === 'tool')) return chatCompletion(run, 'wrote it');
    await arrive();

    return toolCallCompletion(run, {
      tool: 'file', args: { action: 'write', path: `${homes.get(task) ?? ''}/notes.md`, content: `${task}\n` },
    }, 'write_0');
  });

  const { agent, db } = gatewayWorkspace(gateway);
  const turns = chatSessionTurns(agent);

  await turns.openInFlight('u-live', 'a-live');

  const branches = await Promise.all(TASKS.map(async (task) => {
    const branch = await agent.branchTurn(task);

    if (branch.branchId === undefined) throw new Error(`the branch was refused: ${branch.reason ?? 'no reason'}`);

    const seat = db.query<{ storage_key: string }, [string]>('SELECT storage_key FROM workspace_actors WHERE creation_id = ?')
      .get(`${branch.branchId}-head`);

    if (seat === null) throw new Error(`branch ${branch.branchId} seated no head`);
    homes.set(task, agentHome(headAgentName(parseActorKey(seat.storage_key).id)));

    return { task, head: `${branch.branchId}-head` };
  }));

  await turns.settle({ messageId: 'a-live', text: 'the answer' });
  await agent.harnessJoinDetachedFibers();

  const reported = (head: string) => v.parse(FileChangesSchema, JSON.parse(
    db.query<{ file_changes_json: string }, [string]>('SELECT file_changes_json FROM head_journal WHERE id = ?').get(head)?.file_changes_json ?? 'null',
  ));

  for (const { task, head } of branches) {
    // And not the sibling's, which no end-of-split diff can recover.
    expect(reported(head)).toEqual([{ path: `${homes.get(task) ?? ''}/notes.md`, status: 'added', added: 1, removed: 0 }]);
  }
});
