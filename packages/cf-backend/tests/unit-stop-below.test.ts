/**
 * The owner's Stop on the cloud, through Main's own Stop: a task agent that rests while its hirer still counts it working
 * is retired as a stopped dismissal that keeps its history, its own hires dismissed and retired with it, as on the CLI.
 * Before core's `stopAgentsBelow` the directory retired the hire with its hirer, but the hirer's roster still counted it
 * working: a retired agent listed as at work.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { catalogTurn, driveUntil, gatewayWorkspace, rosterOver } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';

const LEAD = { name: 'lead-a1', task: 'Hire ledger-a1 for the ledger part.' } as const;

const LEDGER = { name: 'ledger-a1', task: 'Move the ledger to integer cents.' } as const;

const WireSchema = v.object({ messages: v.array(v.looseObject({ role: v.string(), content: v.optional(v.unknown()) })) });

type WireMessage = v.InferOutput<typeof WireSchema>['messages'][number];

const words = (message: WireMessage | undefined): string => (typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? ''));

/** The words an agent was first asked, and whether it has said anything yet. */
function asked(run: RecordedGatewayRun) {
  const { messages } = v.parse(WireSchema, run.query);
  const users = messages.filter((message) => message.role === 'user' && !words(message).includes('Kinu runtime state'));

  return { first: words(users[0]), fresh: !messages.some((message) => message.role === 'assistant'), answered: requestOf(run).messages.at(-1)?.role === 'tool' };
}

/** Main hires the lead for a task; the lead hires the ledger's agent and rests on it; the ledger's own call is held. */
function stoppedScene() {
  const ledgerCalled = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Response>();

  const gateway = stubAiBinding((run) => {
    const { first, fresh, answered } = asked(run);

    if (answered || !fresh) return chatCompletion(run, 'Waiting on my hire.');

    if (first.includes('Hire lead-a1')) {
      return toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', name: LEAD.name, role: 'task', lifetime: 'task', message: LEAD.task } }, 'hire-lead');
    }

    if (first.includes(LEAD.task)) return toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', name: LEDGER.name, role: 'task', message: LEDGER.task } }, 'hire-ledger');

    if (first.includes(LEDGER.task)) {
      ledgerCalled.resolve();

      return release.promise;
    }

    return chatCompletion(run, 'Done.');
  });

  return { gateway, ledgerCalled: ledgerCalled.promise, release: (run: () => Response) => { release.resolve(run()); } };
}

describe("the owner's Stop below Main", () => {
  test('retires a resting task agent with its own hire, both kept as history, the hire dismissed on its roster', async () => {
    const scene = stoppedScene();
    const workspace = gatewayWorkspace(scene.gateway);

    const row = (name: string) => workspace.db.query<{ actor_id: string; deleted_at: number | null }, [string]>(
      'SELECT actor_id, deleted_at FROM workspace_actors WHERE name = ?',
    ).get(name);

    let held = false;

    const heard = scene.ledgerCalled.then(() => { held = true; });

    await catalogTurn(workspace.agent, `Hire ${LEAD.name} for the migration.`);
    await driveUntil(workspace, "the ledger's agent never started", () => held && rosterOver(workspace.db).get(LEAD.name)?.status === 'working');

    await heard;
    await workspace.agent.cancelCurrentWork();
    scene.release(() => Response.json({ ok: true }));
    await driveUntil(workspace, 'the Stop never retired the lead', () => row(LEAD.name)?.deleted_at !== null);

    const rosters = workspace.db.query<{ name: string; status: string }, []>('SELECT name, status FROM actor_subagents ORDER BY name').all();

    expect({ lead: row(LEAD.name)?.deleted_at !== null, ledger: row(LEDGER.name)?.deleted_at !== null }).toEqual({ lead: true, ledger: true });
    expect(rosters).toEqual([{ name: LEAD.name, status: 'dismissed' }, { name: LEDGER.name, status: 'dismissed' }]);
  });
});
