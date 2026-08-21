/**
 * THE WIRING, OBSERVED ON A SHIPPED CALL: a swarm node in a real `agents.swarm`
 * run gets a private home.
 *
 * `agentHomeNodeProvisioner` was proved against the real substrate long before
 * anything called it (`cf-backend/tests/unit-node-home-wiring.test.ts`), and that
 * is exactly the shape of defect this file exists to close: a seam with a proof
 * and no caller. So nothing here asserts what the provisioner DOES — it asserts
 * that a shipped dispatch reaches it, which is a different claim and was the
 * false one.
 *
 * It is driven from `createCLIRuntime`, not a fixture, because the thing under
 * test is a backend's ability to hand over three host-owned members. The local
 * backend's filesystem is an in-isolate `NimbusWorkspace`, so it has a uid-0 view
 * and a principal registry to give; the hosted backend reaches its workspace by
 * RPC and has neither. A stub host would assert the plumbing and leave the only
 * interesting question — whether this backend can actually supply one — untested.
 *
 * THE DENOMINATOR IS ASSERTED, TWICE. `ideate` fans five nodes at depth one, so
 * five `swarm.node_settled` lines is the count a passing run must show; an arm
 * that scanned for one `private-home` line would also pass on a run that emitted
 * exactly one node, or on a filtered list that happened to be empty. And the same
 * call with `nodeHome` withheld is run beside it: if that arm did not report
 * `shared-origin-plane`, the positive arm would be measuring nothing.
 *
 * Specified by docs/EXPLORATION.md — "Isolation".
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import {
  AGENT_UID_FLOOR,
  agentIdentity,
  nodeAgentName,
  createAgentsTool,
  type AgentsForkDeps,
  type AgentsToolInput,
  type JsonValue,
  type LLMProviderConfig,
} from '@kinu.run/core';
import { scriptedTurnModel, scratchPath, toolExecute } from '@kinu.run/test-utils';
import { createCLIRuntime, type CLIRuntime } from '../src/runtime';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

/** `ideate`'s branching factor — see SWARM_PRESET_POINTS. Five nodes, depth one,
 *  no selection step, so five is the exact number of settled lines a run emits. */
const IDEATE_BRANCHES = 5;

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/** A node that answers once and stops — the smallest run that still provisions a
 *  home, because the home is provisioned before the node's first step. */
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

/** The production runtime, with no host plane: a search must never be able to
 *  write into the developer's own repository. */
function cliRuntime(label: string): CLIRuntime {
  const database = new Database(':memory:');
  databases.push(database);
  return createCLIRuntime(database, {
    dbPath: scratchPath(label, 'agent.db'),
    llm: DUMMY_LLM,
    hostRoot: null,
  });
}

/** `diagnostics` writes one JSON line per event to console.error and has no
 *  injection seam this far inside core, so the line is read where it lands —
 *  the same reassignment `unit-agents-tool.test.ts` uses. */
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

/** Every node the run settled, as the engine itself reported it.
 *
 *  Selected by prefix before parsing rather than parsed-and-tolerated: the AI SDK
 *  writes plain-prose warnings to the same stream, and a JSON parse of those
 *  would throw with nothing worth swallowing. */
function settledNodes(lines: string[]): SettledNode[] {
  const prefix = `{"event":"${SETTLED_EVENT}"`;
  return lines
    .filter((line) => line.startsWith(prefix))
    .map((line) => v.parse(SettledLine, JSON.parse(line)).fields);
}

/** One shipped `agents.swarm` call, through the tool the model calls. */
async function runShippedSwarm(fork: AgentsForkDeps): Promise<SettledNode[]> {
  const tool = createAgentsTool({ mode: 'build', fork });
  const execute = toolExecute<AgentsToolInput, JsonValue>(tool);
  let outcome: JsonValue = null;
  const lines = await captureEvents(async () => {
    outcome = await execute({
      action: 'swarm', preset: 'ideate', task: 'name three ways to speed up the parser',
    });
  });
  // A refusal comes back as a normal result, so an unnoticed one would look like
  // a run that settled no nodes. Named here, where the reason is still readable.
  const refused = v.safeParse(SwarmRefusal, outcome);
  if (refused.success) {
    throw new Error(`the swarm refused: ${refused.output.reason} — ${refused.output.error}`);
  }
  return settledNodes(lines);
}

describe('a node in a shipped agents.swarm run reports private-home', () => {
  test('every node of the run, and the count the preset fans', async () => {
    const rt = cliRuntime('swarm-node-home-private');

    const settled = await runShippedSwarm({ rt, model: answeringModel(), nodeHome: rt.nodeHome });

    expect(settled).toHaveLength(IDEATE_BRANCHES);
    expect(settled.map((node) => node.isolation))
      .toEqual(Array.from({ length: IDEATE_BRANCHES }, () => 'private-home'));
  }, 120_000);

  test('the homes are real directories in the ORIGIN\u2019s own filesystem', async () => {
    const rt = cliRuntime('swarm-node-home-inodes');
    const nodeHome = rt.nodeHome;
    if (!nodeHome) throw new Error('createCLIRuntime must supply a node home host');

    const settled = await runShippedSwarm({ rt, model: answeringModel(), nodeHome });

    expect(settled).toHaveLength(IDEATE_BRANCHES);
    // Read through `rt.storage.vfs` — the ORIGIN's own view, the one the `file`
    // tool and the workspace shell address. That the homes are visible HERE is the
    // property, not an implementation detail: one filesystem with per-node
    // ownership is what keeps a node's read window open, and a home the origin
    // could not see would be the second tree this design exists to refuse.
    const homes = await rt.storage.vfs.readdir('/home');
    for (const { node } of settled) {
      expect(homes).toContain(nodeAgentName(node));
      expect(await rt.storage.vfs.stat(`/home/${nodeAgentName(node)}`))
        .toMatchObject({ isDir: true });
    }

    // The uid each home was chown'ed to, read back through the production
    // accessor: it is idempotent by design, so reading it here is also what
    // proves the allocation is a durable row rather than closure state.
    const { sql } = await nodeHome();
    const uids = new Set(settled.map(({ node }) => agentIdentity(sql, nodeAgentName(node)).uid));
    for (const uid of uids) expect(uid).toBeGreaterThanOrEqual(AGENT_UID_FLOOR);
    // One uid each: two nodes sharing a uid is two nodes sharing a home.
    expect(uids.size).toBe(IDEATE_BRANCHES);
  }, 120_000);

  test('the same call with no home host reports the shared plane instead', async () => {
    // The denominator for the arms above. Without this, `private-home` could be
    // what this engine always says rather than what the wiring made it say.
    const rt = cliRuntime('swarm-node-home-absent');

    const settled = await runShippedSwarm({ rt, model: answeringModel() });

    expect(settled).toHaveLength(IDEATE_BRANCHES);
    expect(settled.map((node) => node.isolation))
      .toEqual(Array.from({ length: IDEATE_BRANCHES }, () => 'shared-origin-plane'));
  }, 120_000);
});
