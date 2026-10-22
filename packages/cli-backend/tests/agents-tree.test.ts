/**
 * `agents.list` on the CLI, through each agent's own `agents` tool: the caller's subtree, read from the read model the
 * cloud's sidebar draws, over the tree's one database, then its peers. Main sees the whole three-level tree; the hire in
 * the middle sees itself and its own hire, then Main as a peer, without what Main started. And a search counts as starting agents: at the depth cap the tool offers no
 * `swarm`, as it offers no hire. The cloud's twin is cf-backend/tests/unit-agents-tree.test.ts.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { scratchDir, scriptedTurnModel, workspaceDatabase } from '@kinu.run/test-utils';
import { DELEGATION_MAX_DEPTH, initWorkspaceSchema, type JsonObject, type LLMProviderConfig } from '@kinu.run/core';
import { createWorkspace } from '@kinu.run/core/workspace-birth';
import { makeWorkspaceSchemaSql, workspaceHome } from '../src/runtime';
import { LocalAgentHost } from '../src/agent-host/host';
import { openWorkspaceCLI } from '../src/open';
import { staticModelPlane } from '../src/profile-authority';
import { swarmsOn } from './helpers/local-session';

const DUMMY_LLM: LLMProviderConfig = { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' };

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

/** Main hires the lead, whose first turn hires the ledger's agent. */
const LEAD = { name: 'lead-a1', task: 'Hire ledger-a1 for the ledger part.' } as const;

const LEDGER = { name: 'ledger-a1', task: 'Move the ledger to integer cents.' } as const;

/** Main, then each hire one level further down to the cap; the deepest is asked to search. */
const CHAIN = ['CHAIN-0 Start the chain.', 'CHAIN-1 Keep going down.', 'CHAIN-2 Keep going down.', 'CHAIN-3 Keep going down.', 'CHAIN-4 Search now.'] as const;

const RowSchema = v.looseObject({ name: v.string(), depth: v.number(), kind: v.string(), you: v.optional(v.literal(true)) });

const ListedSchema = v.looseObject({ tree: v.array(RowSchema) });

const PartsSchema = v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()), toolName: v.optional(v.string()), output: v.optional(v.looseObject({ value: v.optional(v.unknown()) })) }));

const OpsSchema = v.looseObject({ properties: v.looseObject({ op: v.looseObject({ enum: v.array(v.string()) }) }) });

type Prompt = ReadonlyArray<{ readonly role: string; readonly content: unknown }>;

const textOf = (message: Prompt[number] | undefined): string => {
  if (typeof message?.content === 'string') return message.content;
  const parts = v.safeParse(PartsSchema, message?.content);

  return parts.success ? parts.output.map((part) => part.text ?? '').join('') : '';
};

/** Runtime state sent as a user message: never what the agent was asked. */
const stateBlock = (said: string): boolean => said.includes('Kinu runtime state');

/** What the agent asked in `prompt` should do next: a tool call, or `null` to say it is done. */
function nextCall(prompt: Prompt): { readonly input: JsonObject; readonly id: string } | null {
  const asks = prompt.flatMap((message, at) => (message.role === 'user' && !stateBlock(textOf(message)) ? [at] : []));
  const last = asks.at(-1) ?? -1;
  const words = textOf(prompt[last]);

  if (prompt.slice(last).some((message) => message.role === 'tool')) return null;

  if (words.includes('List your tree')) return { input: { op: 'list' }, id: 'list' };

  // Only on an agent's first turn: a report it is handed later quotes the task that asked for a hire.
  if (prompt.some((message) => message.role === 'assistant')) return null;

  if (words.includes('Hire lead-a1')) return { input: { op: 'hire', name: LEAD.name, role: 'task', message: LEAD.task }, id: 'hire-lead' };

  if (words.includes('Hire ledger-a1')) return { input: { op: 'hire', name: LEDGER.name, role: 'task', message: LEDGER.task }, id: 'hire-ledger' };

  const level = CHAIN.findIndex((step) => words.includes(step.slice(0, 7)));

  if (level === CHAIN.length - 1) return { input: { op: 'swarm', preset: 'ideate', task: 'Three ways to cut the queue' }, id: 'swarm-deep' };

  return level < 0 ? null : { input: { op: 'hire', name: `level-${String(level + 1)}`, role: 'task', message: CHAIN[level + 1] ?? '' }, id: `hire-${String(level + 1)}` };
}

/** Every tree `agents.list` showed in `prompt`, by the agent it was shown to. */
function shownTrees(prompt: Prompt): Array<v.InferOutput<typeof ListedSchema>> {
  return prompt.flatMap((message) => (message.role === 'tool' ? v.parse(PartsSchema, message.content) : []))
    .flatMap((part) => {
      const tree = part.toolName === 'agents' ? v.safeParse(ListedSchema, part.output?.value) : null;

      return tree?.success === true ? [tree.output] : [];
    });
}

/** A model that hires, lists and searches when its words say so, and is otherwise done; it keeps every tree it was
 *  shown, by the agent it was shown to, and the `agents` ops each agent was offered, by its first words. */
function delegatingModel() {
  const trees = new Map<string, v.InferOutput<typeof ListedSchema>>();
  const offered = new Map<string, readonly string[] | null>();

  const model = scriptedTurnModel({ doGenerate: async (options) => {
    const prompt: Prompt = options.prompt;
    const finish = (unified: 'stop' | 'tool-calls') => ({ unified, raw: undefined });

    if ((options.tools ?? []).length === 0) return { content: [{ type: 'text' as const, text: '-' }], finishReason: finish('stop'), usage: USAGE, warnings: [] };
    const first = prompt.find((message) => message.role === 'user' && !stateBlock(textOf(message)));
    const agents = (options.tools ?? []).find((tool) => tool.name === 'agents');
    const ops = agents?.type === 'function' ? v.safeParse(OpsSchema, agents.inputSchema) : null;
    offered.set(textOf(first), ops?.success === true ? ops.output.properties.op.enum : null);

    for (const tree of shownTrees(prompt)) {
      const you = tree.tree.find((row) => row.you === true);

      if (you !== undefined) trees.set(you.name, tree);
    }

    const call = nextCall(prompt);

    return call === null
      ? { content: [{ type: 'text' as const, text: 'Done.' }], finishReason: finish('stop'), usage: USAGE, warnings: [] }
      : { content: [{ type: 'tool-call' as const, toolCallId: call.id, toolName: 'agents', input: JSON.stringify(call.input) }], finishReason: finish('tool-calls'), usage: USAGE, warnings: [] };
  } });

  return { model, trees, offered };
}

async function hosted(model: ReturnType<typeof delegatingModel>['model']): Promise<LocalAgentHost> {
  const state = scratchDir('agents-tree-state');
  const project = scratchDir('agents-tree-project');
  const dbPath = join(state, 'root', 'agent.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const seed = workspaceDatabase(dbPath);

  try {
    await createWorkspace(seed, { name: 'root', purpose: 'Run the migration.', home: workspaceHome(seed) });
    initWorkspaceSchema(makeWorkspaceSchemaSql(seed));
  } finally {
    seed.close();
  }

  return new LocalAgentHost({
    roster: () => [{ name: 'root', cwd: project, workspaceId: 'tree' }],
    dbPath: () => dbPath,
    open: async (_ref, db, path) => {
      const openConfig = { llm: DUMMY_LLM, cwd: project };
      const { rt } = await openWorkspaceCLI(db, path, openConfig);
      rt.actor.config.setLearning(false);

      return { rt, openConfig, staticModel: model, profileAuthority: swarmsOn(rt, staticModelPlane()) };
    },
  });
}

const positions = (tree: ReadonlyArray<v.InferOutput<typeof RowSchema>>) => tree.map((row) => [row.name, row.depth, row.you === true]);

describe('agents.list is the caller\'s own subtree', () => {
  test('main lists all three levels; the hire in the middle lists itself and its hire, then main alone as a peer', async () => {
    const { model, trees } = delegatingModel();
    const host = await hosted(model);

    try {
      await (await host.acquire('root')).send(`Hire ${LEAD.name} to run the migration.`, { id: crypto.randomUUID() });
      await host.settle();
      await (await host.acquire(`root/${LEAD.name}`)).send('List your tree.', { id: crypto.randomUUID() });
      await host.settle();
      await (await host.acquire('root')).send('List your tree.', { id: crypto.randomUUID() });
      await host.settle();

      expect(positions(trees.get(LEAD.name)?.tree ?? [])).toEqual([[LEAD.name, 1, true], [LEDGER.name, 2, false], ['main', 0, false]]);
      expect(positions(trees.get('main')?.tree ?? [])).toEqual([['main', 0, true], [LEAD.name, 1, false], [LEDGER.name, 2, false]]);
      expect(trees.get('main')?.tree[2]).toMatchObject({ kind: 'hired' });
    } finally {
      await host.close();
    }
  });
});

describe('a search counts as starting agents', () => {
  test(`at depth ${String(DELEGATION_MAX_DEPTH)} an agent is offered no search, one level up it is`, async () => {
    const { model, offered } = delegatingModel();
    const host = await hosted(model);

    try {
      await (await host.acquire('root')).send(CHAIN[0], { id: crypto.randomUUID() });
      await host.settle();

      expect(offered.get(CHAIN[3])).toContain('swarm');
      expect(offered.get(CHAIN[4])).toBeNull();
    } finally {
      await host.close();
    }
  });
});
