/**
 * A shipped `agents.swarm` call reaches `facetHomeProvisioner`: each node gets a private home keyed on its actor's
 * storage key, never the node id. Five settled nodes and a no-provisioner control arm are the denominator.
 *
 * Specified by docs/EXPLORATION.md — "Isolation".
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import {
  AGENT_UID_FLOOR,
  facetHomeProvisioner,
  agentIdentity,
  headAgentName,
  createAgentsTool,
  initWorkspaceSchema,
  explorationActorKey,
  type AgentsSwarmDeps,
  type AgentsToolInput,
  type JsonValue,
  type LLMProviderConfig,
} from '@kinu.run/core';
import { scriptedTurnModel, scratchPath, toolExecute } from '@kinu.run/test-utils';
import { createCLIRuntime, makeWorkspaceSchemaSql, type CLIRuntime } from '../src/runtime';
import { openLocalActor, registerLocalNode } from '../src/actor-identity';
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

/** The production runtime with no host plane, after `initWorkspaceSchema` (as `openWorkspaceCLI` runs it):
 *  nodes are actors whose first turn needs the workspace tables. */
function cliRuntime(label: string): CLIRuntime {
  const database = new Database(scratchPath(label, 'agent.db'));
  databases.push(database);
  initWorkspaceSchema(makeWorkspaceSchemaSql(database));

  return createCLIRuntime(database, {
    dbPath: database.filename,
    llm: DUMMY_LLM,
  });
}

/** This backend's node-home wiring as `local-session.ts` builds it. A missing host throws: passing nothing
 *  would report the shared plane and assert it. */
function nodeHomeWiring(rt: CLIRuntime) {
  const nodeHome = rt.nodeHome;

  if (!nodeHome) throw new Error('createCLIRuntime must supply a node home host');

  return {
    nodeHome,
    provisionNodeHome: () => async (node: { readonly nodeId: string; readonly rootId: string; readonly depth: number }) => {
      const actor = registerLocalNode(rt.actor, node);

      return facetHomeProvisioner(nodeHome())(headAgentName(actor.storageKey));
    },
  };
}

/** The home directory name a settled node's actor owns, read back via the directory's `resolve`, never derived. */
function nodeHomeName(rt: CLIRuntime, nodeId: string): string {
  return headAgentName(openLocalActor(rt.actor, explorationActorKey(nodeId)).storageKey);
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
  const tool = createAgentsTool({ mode: 'build', swarm });
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

describe('a node in a shipped agents.swarm run reports private-home', () => {
  test('a local node keeps its home and private scratch through runtime reset', async () => {
    const database = new Database(scratchPath('node-reset', 'agent.db'));
    databases.push(database);
    const config = { dbPath: database.filename, llm: DUMMY_LLM };
    const first = createCLIRuntime(database, config);
    const provision = nodeHomeWiring(first).provisionNodeHome();
    const home = await provision({ nodeId: 'reset', rootId: 'reset', depth: 1 });

    if (home.isolation !== 'private-home' || !first.nodeRuntime) throw new Error('node plane missing');
    const before = await first.nodeRuntime(home, registerLocalNode(first.actor, { nodeId: 'reset', rootId: 'reset', depth: 1 }), first);

    if (!before.shell) throw new Error('node shell missing');
    expect(await before.shell.exec('echo private > /tmp/note; echo answer > "$HOME/answer"')).toMatchObject({ exitCode: 0 });
    await first.storage.vfs.writeFile('/home/user/shared', 'shared');
    const second = createCLIRuntime(database, config);

    if (!second.nodeRuntime) throw new Error('reset node plane missing');
    const after = await second.nodeRuntime(home, registerLocalNode(second.actor, { nodeId: 'reset', rootId: 'reset', depth: 1 }), second);

    if (!after.shell) throw new Error('reset node shell missing');
    expect(await after.shell.exec('echo $HOME $TMPDIR; cat /tmp/note; cat "$HOME/answer"; cat /home/user/shared'))
      .toMatchObject({ exitCode: 0, stdout: `${home.home} ${home.tmp}\nprivate\nanswer\nshared` });
    expect(await second.storage.vfs.exists('/tmp/note')).toBe(false);
    await expect(second.storage.vfs.writeFile(`${home.home}/answer`, 'stolen')).rejects.toThrow();
  });
  test('every node of the run, and the count the preset fans', async () => {
    const rt = cliRuntime('swarm-node-home-private');
    const { provisionNodeHome } = nodeHomeWiring(rt);

    const settled = await runShippedSwarm({ rt, model: answeringModel(), hostNode: nodeSeatFactory(rt), reportModelCall: () => undefined, provisionNodeHome });

    expect(settled).toHaveLength(IDEATE_BRANCHES);
    expect(settled.map((node) => node.isolation))
      .toEqual(Array.from({ length: IDEATE_BRANCHES }, () => 'private-home'));
  });

  test('the homes are real directories in the ORIGIN\u2019s own filesystem', async () => {
    const rt = cliRuntime('swarm-node-home-inodes');
    const { nodeHome, provisionNodeHome } = nodeHomeWiring(rt);

    const settled = await runShippedSwarm({ rt, model: answeringModel(), hostNode: nodeSeatFactory(rt), reportModelCall: () => undefined, provisionNodeHome });

    expect(settled).toHaveLength(IDEATE_BRANCHES);
    // Through `rt.storage.vfs`, the origin's own view: a home the origin could not see would be a second tree.
    const homes = await rt.storage.vfs.readdir('/home');
    const owned = settled.map(({ node }) => nodeHomeName(rt, node));

    for (const home of owned) {
      expect(homes).toContain(home);
      expect(await rt.storage.vfs.stat(`/home/${home}`)).toMatchObject({ isDir: true });
    }

    for (const { node } of settled) expect(homes).not.toContain(headAgentName(node));

    const { sql } = await nodeHome();
    const uids = new Set(owned.map((home) => agentIdentity(sql, home).uid));

    for (const uid of uids) expect(uid).toBeGreaterThanOrEqual(AGENT_UID_FLOOR);
    expect(uids.size).toBe(IDEATE_BRANCHES);
  });

  test('the same call with no home host reports the shared plane instead', async () => {
    const rt = cliRuntime('swarm-node-home-absent');

    const settled = await runShippedSwarm({ rt, model: answeringModel(), hostNode: nodeSeatFactory(rt), reportModelCall: () => undefined });

    expect(settled).toHaveLength(IDEATE_BRANCHES);
    expect(settled.map((node) => node.isolation))
      .toEqual(Array.from({ length: IDEATE_BRANCHES }, () => 'shared-origin-plane'));
  });
});

describe('a node seat shares the origin plane on its own head row', () => {
  test('the seat runs the origin shell until its home is provisioned, keyed by its own actor', async () => {
    const rt = cliRuntime('swarm-node-home-seat');
    expect(rt.shell).toBeDefined();
    const seat = await nodeSeatFactory(rt)({ nodeId: 'seat-probe', rootId: 'seat-probe', depth: 1 });
    // A former-node actor's seat runs on the origin plane; the home comes later through provisionNodeHome.
    expect(seat.actor.record.kind).toBe('head');
    expect(seat.actor.handle.actorId).not.toBe(rt.actor.actorId);
    expect(seat.actor.runtime.shell).toBe(rt.shell);
    expect(nodeHomeName(rt, 'seat-probe')).toBe(headAgentName(seat.actor.handle.storageKey));
  });
});
