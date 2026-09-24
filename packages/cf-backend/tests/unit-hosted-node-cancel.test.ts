/**
 * Operator cancellation reaches a hosted swarm node: the search's abort is bridged onto the node actor's own
 * session abort, the claim settles `aborted` and the journal records it. Driven as production drives it: the
 * owner's turn starts the search through the main actor's `agents` tool, every model call the platform gateway's,
 * and the owner cancels the search's job.
 */
import { describe, expect, test } from 'bun:test';
import { catalogTurn, gatewayWorkspace } from './helpers/actor-harness';
import {
  chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun,
} from './helpers/platform-gateway';

const ASK = 'Find a way to speed up the parser.';

function fromTheOwner(run: RecordedGatewayRun): boolean {
  const opening = requestOf(run).messages.find((message) => message.role === 'user');

  return JSON.stringify(opening?.content ?? '').includes(ASK);
}

/** The main actor starts a one-node search, then says so; `node` answers the node. */
function searching(node: (run: RecordedGatewayRun) => Response | Promise<Response>) {
  return stubAiBinding((run) => {
    if (!fromTheOwner(run)) return node(run);

    return requestOf(run).messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'Searching.')
      : toolCallCompletion(run, {
        tool: 'agents', args: { action: 'swarm', task: 'Name one way to tokenize faster.', preset: 'ideate', branches: 1, depth: 1 },
      }, 'swarm_0');
  });
}

interface ActorRow { readonly actor_id: string; readonly parent_actor_id: string | null; readonly kind: string; readonly creation_id: string }

describe('cancelling a search reaches its hosted nodes', () => {
  test('a node runs as its own hosted actor under the workspace loop', async () => {
    const { agent, db } = gatewayWorkspace(searching((run) => chatCompletion(run, 'Cache the token table.')));

    await catalogTurn(agent, ASK);
    await agent.harnessJoinDetachedFibers();

    const actors = db.query<ActorRow, []>('SELECT actor_id, parent_actor_id, kind, creation_id FROM workspace_actors').all();
    const main = actors.find((actor) => actor.kind === 'main');
    const node = db.query<{ id: string }, []>('SELECT id FROM head_journal').get();
    const seat = actors.find((actor) => actor.creation_id === node?.id);
    const claims = db.query<{ actor_id: string; outcome: string }, []>('SELECT actor_id, outcome FROM actor_turn_claims').all();

    // The run is bridged onto this actor's session, so the seating (kind, parent, own claim) is load-bearing.
    expect(seat).toMatchObject({ kind: 'head', parent_actor_id: main?.actor_id });
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

    const claims = db.query<{ outcome: string }, [string]>('SELECT outcome FROM actor_turn_claims WHERE actor_id = ?')
      .all(seat?.actor_id ?? '');

    expect(node?.status).toBe('aborted');
    expect(claims.map((claim) => claim.outcome)).toEqual(['aborted']);
  });
});
