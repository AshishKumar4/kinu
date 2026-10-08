/**
 * Operator cancellation reaches a hosted swarm node: the search's abort is bridged onto the node actor's own
 * session abort, the claim settles `aborted` and the journal records it. Driven as production drives it: the
 * owner's turn starts the search through the main actor's `agents` tool, every model call the platform gateway's,
 * and the owner cancels the search's job.
 */
import { describe, expect, test } from 'bun:test';
import { agentSql, catalogTurn, gatewayWorkspace } from './helpers/actor-harness';
import {
  chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun,
} from './helpers/platform-gateway';

const ASK = 'Find a way to speed up the parser.';

function fromTheOwner(run: RecordedGatewayRun): boolean {
  return openingOf(run).includes(ASK);
}

/** The main actor starts a search of `branches` nodes, then says so; `node` answers every node. */
function searching(node: (run: RecordedGatewayRun) => Response | Promise<Response>, branches = 1) {
  return stubAiBinding((run) => {
    if (!fromTheOwner(run)) return node(run);

    return requestOf(run).messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'Searching.')
      : toolCallCompletion(run, {
        tool: 'agents', args: { op: 'swarm', task: 'Name one way to tokenize faster.', preset: 'ideate', branches, depth: 1 },
      }, 'swarm_0');
  });
}

interface ActorRow { readonly actor_id: string; readonly parent_actor_id: string | null; readonly origin: string; readonly creation_id: string }

describe('cancelling a search reaches its hosted nodes', () => {
  test('a node keeps its turn in its own facet under the workspace loop', async () => {
    const { agent, db } = gatewayWorkspace(searching((run) => chatCompletion(run, 'Cache the token table.')));

    await catalogTurn(agent, ASK);
    await agent.harnessJoinDetachedFibers();

    const actors = db.query<ActorRow, []>('SELECT actor_id, parent_actor_id, origin, creation_id FROM workspace_actors').all();
    const main = actors.find((actor) => actor.origin === 'system');
    const node = db.query<{ id: string }, []>('SELECT id FROM head_journal').get();
    const seat = actors.find((actor) => actor.creation_id === node?.id);

    if (seat === undefined) throw new Error('the search registered no node actor');
    const claims = agentSql(seat.actor_id)<{ actor_id: string; outcome: string }>`SELECT actor_id, outcome FROM actor_turn_claims`;
    expect(db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM actor_turn_claims WHERE actor_id = ?').get(seat.actor_id)?.n).toBe(0);

    // The run is bridged onto this actor's session, so the seating (origin, parent, own claim) is load-bearing.
    expect(seat).toMatchObject({ origin: 'swarm', parent_actor_id: main?.actor_id });
    expect(claims.filter((claim) => claim.actor_id === seat?.actor_id)).toEqual([
      { actor_id: seat?.actor_id ?? '', outcome: 'completed' },
    ]);
  });

  test('the owner cancelling the search mid-call settles the node aborted', async () => {
    const held = Promise.withResolvers<RecordedGatewayRun>();
    const answer = Promise.withResolvers<Response>();

    // The node's call rejects when its signal fires, as the platform's fetch does; otherwise it answers once released.
    const gateway = searching((run) => {
      run.signal?.addEventListener('abort', () => { answer.reject(run.signal?.reason); });
      held.resolve(run);

      return answer.promise;
    });

    const { agent, db } = gatewayWorkspace(gateway);

    await catalogTurn(agent, ASK);
    const call = await held.promise;
    const job = db.query<{ id: string }, []>("SELECT id FROM background_jobs WHERE kind = 'agents'").get();

    if (job === null) throw new Error('the search left no job row');
    expect(await agent.cancelBackgroundJob(job.id)).toEqual({ ok: true });
    // A cancel that never reached the node lets this answer land, and the node completes.
    answer.resolve(chatCompletion(call, 'Cache the token table.'));
    await agent.harnessJoinDetachedFibers();

    const node = db.query<{ id: string; status: string }, []>('SELECT id, status FROM head_journal').get();

    const seat = db.query<{ actor_id: string }, [string]>('SELECT actor_id FROM workspace_actors WHERE creation_id = ?')
      .get(node?.id ?? '');

    if (seat === null) throw new Error('the cancelled node has no registered actor');
    const claims = agentSql(seat.actor_id)<{ outcome: string }>`SELECT outcome FROM actor_turn_claims`;

    expect(node?.status).toBe('aborted');
    expect(claims.map((claim) => claim.outcome)).toEqual(['aborted']);
    // Cancelled with its search, not stopped by its owner: the panel keeps it a fault.
    expect((await agent.listWorkspaceAgents()).find((listed) => listed.category === 'swarm')?.activity).toBe('failed');
  });

  test('the owner stopping one worker settles it aborted while its sibling completes', async () => {
    const calls: Array<{ readonly run: RecordedGatewayRun; readonly answer: ReturnType<typeof Promise.withResolvers<Response>> }> = [];
    const bothHeld = Promise.withResolvers<void>();

    const gateway = searching((run) => {
      const answer = Promise.withResolvers<Response>();

      run.signal?.addEventListener('abort', () => { answer.reject(run.signal?.reason); });
      calls.push({ run, answer });

      if (calls.length === 2) bothHeld.resolve();

      return answer.promise;
    }, 2);

    const { agent, db } = gatewayWorkspace(gateway);

    await catalogTurn(agent, ASK);
    await bothHeld.promise;
    const [stopped, sibling] = db.query<{ id: string }, []>('SELECT id FROM head_journal ORDER BY id').all();

    if (stopped === undefined || sibling === undefined) throw new Error('the search did not journal two workers');
    await agent.stopSwarmWorker(stopped.id);
    await agent.stopSwarmWorker('no-such-worker');

    // A Stop that never reached its worker lets this answer land, and that worker completes.
    for (const call of calls) call.answer.resolve(chatCompletion(call.run, 'Cache the token table.'));
    await agent.harnessJoinDetachedFibers();

    const job = db.query<{ status: string }, []>("SELECT status FROM background_jobs WHERE kind = 'agents'").get();
    const workers = (await agent.listWorkspaceAgents()).filter((listed) => listed.category === 'swarm');
    const activity = (id: string) => workers.find((listed) => listed.open.kind === 'node' && listed.open.nodeId === id)?.activity;

    // Only the Stop reads as stopped: its reason is recorded, and the sibling it never reached completes.
    expect(activity(stopped.id)).toBe('stopped');
    expect(activity(sibling.id)).toBe('done');
    expect(job?.status).not.toBe('cancelled');
  });
});
