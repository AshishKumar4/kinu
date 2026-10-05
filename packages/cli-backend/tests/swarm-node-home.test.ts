/**
 * A shipped `agents.swarm` call on the CLI: every node works in its workspace's folder and own space, beside the
 * origin, so each reports the shared plane. Five settled nodes are the denominator. Private node homes were the
 * in-SQLite plane's, removed with it on 2026-10-04.
 *
 * Specified by docs/EXPLORATION.md — "Isolation".
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import {
  createAgentsTool,
  initWorkspaceSchema,
  type AgentsSwarmDeps,
  type AgentsToolInput,
  type JsonValue,
  type LLMProviderConfig } from '@kinu.run/core';
import { scriptedTurnModel, scratchDir, scratchPath, toolExecute, unobservedSearchSeams } from '@kinu.run/test-utils';
import { createCLIRuntime, makeWorkspaceSchemaSql, type CLIRuntime } from '../src/runtime';
import { nodeSeatFactory } from './actor-fixture';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

/** `ideate`'s branching factor (SWARM_PRESET_POINTS): five nodes, depth one, so five settled lines per run. */
const IDEATE_BRANCHES = 5;

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function answeringModel() {
  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-swarm-node',
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'one approach' }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 3, text: 3, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

/** The production runtime after `initWorkspaceSchema` (as `openWorkspaceCLI` runs it): nodes are actors whose
 *  first turn needs the workspace tables. */
function cliRuntime(label: string): CLIRuntime {
  const database = new Database(scratchPath(label, 'agent.db'));
  databases.push(database);
  initWorkspaceSchema(makeWorkspaceSchemaSql(database));

  return createCLIRuntime(database, { llm: DUMMY_LLM, cwd: scratchDir(`${label}-folder`) });
}

/** `diagnostics` writes JSON lines to console.error with no injection seam, so the line is read where it lands. */
async function captureEvents(run: () => Promise<void>): Promise<string[]> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(String(args[0])); };

  try {
    await run();
  } finally {
    console.error = original;
  }

  return lines;
}

const SETTLED_EVENT = 'swarm.node_settled';

const SettledLine = v.object({
  event: v.literal(SETTLED_EVENT),
  fields: v.object({ node: v.string(), isolation: v.string() }),
});

const SwarmRefusal = v.object({ reason: v.string(), error: v.string() });

interface SettledNode {
  readonly node: string;
  readonly isolation: string;
}

/** Every node the run settled; selected by prefix before parsing because the AI SDK writes prose warnings to the same stream. */
function settledNodes(lines: string[]): SettledNode[] {
  const prefix = `{"event":"${SETTLED_EVENT}"`;

  return lines
    .filter((line) => line.startsWith(prefix))
    .map((line) => v.parse(SettledLine, JSON.parse(line)).fields);
}

async function runShippedSwarm(swarm: AgentsSwarmDeps): Promise<SettledNode[]> {
  const tool = createAgentsTool({ mode: 'build', swarms: true, swarm });
  const execute = toolExecute<AgentsToolInput, JsonValue>(tool);
  let outcome: JsonValue = null;

  const lines = await captureEvents(async () => {
    outcome = await execute({
      action: 'swarm', preset: 'ideate', task: 'name three ways to speed up the parser',
    });
  });

  const refused = v.safeParse(SwarmRefusal, outcome);

  if (refused.success) {
    throw new Error(`the swarm refused: ${refused.output.reason} — ${refused.output.error}`);
  }

  return settledNodes(lines);
}

describe('a node in a shipped agents.swarm run shares the origin plane', () => {
  test('every node of the run reports the shared plane', async () => {
    const rt = cliRuntime('swarm-node-home-shared');

    const settled = await runShippedSwarm({ rt, model: answeringModel(), hostNode: nodeSeatFactory(rt), ...unobservedSearchSeams() });

    expect(settled).toHaveLength(IDEATE_BRANCHES);
    expect(settled.map((node) => node.isolation))
      .toEqual(Array.from({ length: IDEATE_BRANCHES }, () => 'shared-origin-plane'));
  });
});

describe('a node seat shares the origin plane on its own head row', () => {
  test('the seat runs the origin shell, keyed by its own actor', async () => {
    const rt = cliRuntime('swarm-node-home-seat');
    expect(rt.shell).toBeDefined();
    const seat = await nodeSeatFactory(rt)({ nodeId: 'seat-probe', rootId: 'seat-probe', depth: 1 });
    expect(seat.actor.record.origin).toBe('swarm');
    expect(seat.actor.handle.actorId).not.toBe(rt.actor.actorId);
    expect(seat.actor.runtime.shell).toBe(rt.shell);
  });
});
