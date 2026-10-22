/**
 * `agents.list` on the cloud, through each agent's own `agents` tool: the caller's subtree, read from the read model the
 * person's sidebar draws, then its peers. Main sees the whole three-level tree; the hire in the middle sees itself and
 * its own hire, then Main as a peer, without what Main started. And a search counts as starting agents: at the depth cap the tool offers no `swarm`, as it offers no hire.
 * The CLI's twin is cli-backend/tests/agents-tree.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { DELEGATION_MAX_DEPTH } from '@kinu.run/core';
import { catalogTurn, gatewayWorkspace, rosterOver, runDelegatedTask, type StartedHarness } from './helpers/actor-harness';
import { chatCompletion, offeredTools, requestOf, stubAiBinding, toolCallCompletion, type GatewayRequest, type RecordedGatewayRun } from './helpers/platform-gateway';

/** Main hires the lead, whose first turn hires the ledger's agent. */
const LEAD = { name: 'lead-a1', task: 'Hire ledger-a1 for the ledger part.' } as const;

const LEDGER = { name: 'ledger-a1', task: 'Move the ledger to integer cents.' } as const;

/** Main, then each hire one level further down to the cap; the deepest is asked to search. */
const CHAIN = ['CHAIN-0 Start the chain.', 'CHAIN-1 Keep going down.', 'CHAIN-2 Keep going down.', 'CHAIN-3 Keep going down.', 'CHAIN-4 Search now.'] as const;

const WireSchema = v.object({
  messages: v.array(v.looseObject({ role: v.string(), content: v.optional(v.unknown()) })),
});

const RowSchema = v.looseObject({ name: v.string(), depth: v.number(), kind: v.string(), status: v.string(), you: v.optional(v.literal(true)) });

const ListedSchema = v.looseObject({ tree: v.array(RowSchema), counts: v.optional(v.looseObject({ retired: v.number() })) });

const words = (message: { readonly content?: GatewayRequest['messages'][number]['content'] } | undefined): string =>
  (typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? ''));

/** Runtime state the harness sends as a user message: never what the agent was asked. */
const stateBlock = (said: string): boolean => said.includes('Kinu runtime state');

/** The actor's newest words it was asked, whether a tool has answered since, and whether it has said anything yet. */
function asked(run: RecordedGatewayRun) {
  const { messages } = requestOf(run);
  const asks = messages.flatMap((message, at) => (message.role === 'user' && !stateBlock(words(message)) ? [at] : []));
  const last = asks.at(-1) ?? -1;

  return {
    words: words(messages[last]),
    answered: messages.slice(last).some((message) => message.role === 'tool'),
    first: !messages.some((message) => message.role === 'assistant'),
  };
}

/** A model that hires, lists and searches when its words say so, and is otherwise done. */
function delegatingGateway() {
  return stubAiBinding((run) => {
    const { words: said, answered, first } = asked(run);

    if (answered) return chatCompletion(run, 'Done.');

    if (said.includes('List your tree')) return toolCallCompletion(run, { tool: 'agents', args: { op: 'list' } }, 'list');

    if (said.includes('List the retired too')) return toolCallCompletion(run, { tool: 'agents', args: { op: 'list', retired: true } }, 'list-retired');

    // Only on an agent's first turn: a report it is handed later quotes the task that asked for a hire.
    if (first && said.includes('Hire lead-a1')) return toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', name: LEAD.name, role: 'task', message: LEAD.task } }, 'hire-lead');

    if (first && said.includes('Hire ledger-a1')) return toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', name: LEDGER.name, role: 'task', message: LEDGER.task } }, 'hire-ledger');

    const level = first ? CHAIN.findIndex((step) => said.includes(step.slice(0, 7))) : -1;

    if (level === CHAIN.length - 1) return toolCallCompletion(run, { tool: 'agents', args: { op: 'swarm', preset: 'ideate', task: 'Three ways to cut the queue' } }, 'swarm-deep');

    if (level >= 0) {
      const next = CHAIN[level + 1] ?? '';

      return toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', name: `level-${String(level + 1)}`, role: 'task', message: next } }, `hire-${String(level + 1)}`);
    }

    return chatCompletion(run, 'Done.');
  });
}

/** The newest tree `agents.list` answered the agent named `you`, as its model read it next. */
function listed(runs: readonly RecordedGatewayRun[], you: string) {
  const trees = runs.flatMap((run) => v.parse(WireSchema, run.query).messages.flatMap((message) => {
    const answer = message.role === 'tool' ? v.safeParse(ListedSchema, JSON.parse(words(message))) : null;

    return answer?.success === true && answer.output.tree.some((row) => row.you === true && row.name === you) ? [answer.output] : [];
  }));

  const newest = trees.at(-1);

  if (newest === undefined) throw new Error(`no request carried ${you}'s tree`);

  return newest;
}

const positions = (tree: ReadonlyArray<v.InferOutput<typeof RowSchema>>) => tree.map((row) => [row.name, row.depth, row.you === true]);

/** Main's turn on `text`, and every turn the hires it started run in their own isolates, to rest. */
async function mainTurn(workspace: StartedHarness, text: string): Promise<void> {
  await catalogTurn(workspace.agent, text);

  for (let pass = 0; pass < 6; pass += 1) {
    await workspace.agent.harnessJoinDetachedFibers();
    await workspace.agent.harnessAgentsIdle();
  }
}

describe('agents.list is the caller\'s own subtree', () => {
  test('main lists all three levels; the hire in the middle lists itself and its hire, then main alone as a peer', async () => {
    const gateway = delegatingGateway();
    const workspace = gatewayWorkspace(gateway);

    await mainTurn(workspace, `Hire ${LEAD.name} to run the migration.`);
    const leadId = rosterOver(workspace.db).get(LEAD.name)?.actorReference?.actorId ?? '';

    await runDelegatedTask(workspace, leadId, 'List your tree.');
    await mainTurn(workspace, 'List your tree.');

    expect(positions(listed(gateway.runs, LEAD.name).tree)).toEqual([[LEAD.name, 1, true], [LEDGER.name, 2, false], ['main', 0, false]]);
    expect(listed(gateway.runs, LEAD.name).tree[2]).toMatchObject({ peer: true });
    expect(positions(listed(gateway.runs, 'main').tree)).toEqual([['main', 0, true], [LEAD.name, 1, false], [LEDGER.name, 2, false]]);
    expect(listed(gateway.runs, 'main').tree[2]).toMatchObject({ kind: 'hired' });
  });

  test('a hire dismissed with its history kept is listed, dismissed, only when retired agents are asked for', async () => {
    const gateway = delegatingGateway();
    const workspace = gatewayWorkspace(gateway);

    await mainTurn(workspace, `Hire ${LEAD.name} to run the migration.`);
    await workspace.agent.dismissSubagent(LEAD.name);
    await mainTurn(workspace, 'List your tree.');
    expect(listed(gateway.runs, 'main')).toMatchObject({ tree: [{ name: 'main' }], counts: { retired: 2 } });

    await mainTurn(workspace, 'List the retired too.');
    expect(listed(gateway.runs, 'main').tree.map((row) => [row.name, row.status])).toEqual([['main', 'running'], [LEAD.name, 'dismissed'], [LEDGER.name, 'dismissed']]);
  });
});

/** The `agents` ops the actor whose first words were `first` was offered, or null when it had no `agents` tool. */
function agentsOpsOf(runs: readonly RecordedGatewayRun[], first: string): readonly string[] | null {
  const own = runs.filter((run) => words(requestOf(run).messages.find((message) => message.role === 'user' && !stateBlock(words(message)))).includes(first));

  if (own.length === 0) throw new Error(`no request came from the agent asked "${first}"`);
  const agents = offeredTools(own).get('agents');

  if (agents === undefined) return null;
  const schema = v.parse(v.looseObject({ properties: v.looseObject({ op: v.looseObject({ enum: v.array(v.string()) }) }) }), agents.inputSchema);

  return schema.properties.op.enum;
}

/** The `agents` ops offered on the requests whose newest asked words were `words`, or null when none had `agents`. */
function agentsOpsAsked(runs: readonly RecordedGatewayRun[], text: string): readonly string[] | null {
  const own = runs.filter((run) => asked(run).words.includes(text));

  if (own.length === 0) throw new Error(`no request asked "${text}"`);
  const agents = offeredTools(own).get('agents');

  return agents === undefined ? null : v.parse(v.looseObject({ properties: v.looseObject({ op: v.looseObject({ enum: v.array(v.string()) }) }) }), agents.inputSchema).properties.op.enum;
}

// BD-011: a line of hirers that cannot be walked to Main leaves the depth unknown. The cloud fails closed before the
// agent's tool is built: such an agent is handed no work, so it starts nothing below it.
describe('a hire whose hirers cannot be walked to main', () => {
  test('is handed no work once its hirer\'s own hirer is no longer recorded, so it hires nothing', async () => {
    const gateway = delegatingGateway();
    const workspace = gatewayWorkspace(gateway);

    await mainTurn(workspace, `Hire ${LEAD.name} to run the migration.`);
    const lead = rosterOver(workspace.db).get(LEAD.name)?.actorReference?.actorId ?? '';
    const ledger = (await workspace.agent.listWorkspaceAgents()).find((agent) => agent.parent === lead)?.actorId ?? '';

    await runDelegatedTask(workspace, ledger, 'Look below you before the import.');
    expect(agentsOpsAsked(gateway.runs, 'Look below you before the import.')).toEqual(expect.arrayContaining(['hire', 'swarm']));
    const before = (await workspace.agent.listWorkspaceAgents()).length;

    // As an import that dropped the lead's own hirer would leave it: a row the directory never wrote.
    workspace.db.exec('PRAGMA foreign_keys = OFF');
    workspace.db.query('UPDATE workspace_actors SET parent_actor_id = ? WHERE actor_id = ?').run('actor-gone', lead);
    await runDelegatedTask(workspace, ledger, 'Hire level-9 after the import.');

    expect(gateway.runs.some((run) => asked(run).words.includes('after the import'))).toBe(false);
    expect((await workspace.agent.listWorkspaceAgents()).length).toBeLessThanOrEqual(before);
  });
});

describe('a search counts as starting agents', () => {
  test(`at depth ${String(DELEGATION_MAX_DEPTH)} an agent is offered no search, one level up it is`, async () => {
    const gateway = delegatingGateway();
    const workspace = gatewayWorkspace(gateway);

    await mainTurn(workspace, CHAIN[0]);

    expect(agentsOpsOf(gateway.runs, 'CHAIN-3')).toContain('swarm');
    expect(agentsOpsOf(gateway.runs, 'CHAIN-4')).toBeNull();
  });
});
