/**
 * `runSwarmAction` is the only production constructor of `SwarmRunDeps`, so a fork parent past the
 * compaction threshold must arrive compacted through it. The compactor is a spy: this pins wiring only.
 */
import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { scriptedTurnModel, toolExecute } from '@kinu.run/test-utils';
import type { Database } from 'bun:sqlite';
import { createTestRuntime } from './helpers';
import { hostedSeatsOver } from './helpers-actor-host';
import {
  createAgentsTool,
  type AgentRuntime,
  type AgentsSwarmDeps, type AgentsToolDeps, type AgentsToolInput,
} from '../src/index';
import { SOLUTION_FILE } from '../src/strategy/exec-ratio';

const MARKER = 'COMPACTED-PREFIX-MARKER';

/** The bulk rides a comment inside the measured code block: over the threshold yet still scoreable. */
const BULK = 'x'.repeat(455_000);

const REFERENCE = `export function solve(input, oracle) {
  let seen = 0;
  for (let i = 0; i < input.n; i += 1) seen = oracle.step(seen);
  return seen;
}
`;

const BODY = `
const oracle = { step: meter((seen) => seen + 1) };
const decode = (out) => (out === undefined || out === null ? null : out);
emitTrials([trial({ n: P.n }, oracle, decode, P.n)]);
`;

const VERIFY_SPEC = {
  params: { n: 3 },
  reference: REFERENCE,
  body: BODY,
  targetOps: 3,
  lowerBoundOps: 1,
};

/** Derived from the factory's contract, as turn-model.ts pins. */
type TurnPrompt = Parameters<Parameters<typeof scriptedTurnModel>[0]['doGenerate']>[0]['prompt'];

function capturingModel(prompts: TurnPrompt[]) {
  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-shared-prefix',
    doGenerate: (options) => {
      prompts.push(options.prompt);

      return {
        content: [{ type: 'text', text: `\`\`\`javascript\n// ${BULK}\n${REFERENCE}\`\`\`` }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 3, text: 3, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

type CapturingModel = ReturnType<typeof capturingModel>;

/** Takes the caller's database: `unit:'answer'` makes every child an agent node with its own actor. */
function swarmDeps(
  world: { rt: AgentRuntime; db: Database },
  model: CapturingModel,
  overrides: Partial<AgentsSwarmDeps> = {},
): AgentsSwarmDeps {
  return { rt: world.rt, hostNode: hostedSeatsOver(world).hostNode, model, ...overrides };
}

function agentsTool(deps: AgentsToolDeps) {
  const entry = createAgentsTool(deps);

  if (!entry) throw new Error('Expected agents tool to be created');

  return { ...entry, execute: toolExecute<AgentsToolInput, object>(entry) };
}

/** `best-first` takes each node once, so root -> child -> grandchild is the one legal depth-2 chain; `uct` re-widens the root. */
function forkCall(branches: number) {
  return {
    action: 'swarm' as const,
    preset: 'custom' as const,
    label: 'shared-prefix',
    task: 'find the cheapest correct implementation',
    objective: {
      kind: 'scalar' as const, metric: 'ms', unit: 'ms', direction: 'minimise' as const,
      scale: 'linear' as const, target: 1, verify: { kind: 'exec-ratio' as const, spec: VERIFY_SPEC },
    },
    depth: 2,
    branches,
    config: {
      unit: { kind: 'answer' as const },
      context: 'inherit' as const,
      expand: 'sample' as const,
      score: { kind: 'verify' as const },
      advance: { kind: 'best-first' as const },
      carry: { kind: 'none' as const },
    },
  };
}

describe('compactShared wiring through runSwarmAction', () => {
  test('context:inherit carries the caller conversation through the agents tool bridge', async () => {
    const { rt, db } = createTestRuntime();
    await rt.storage.vfs.writeFile(SOLUTION_FILE, REFERENCE);
    const prompts: TurnPrompt[] = [];
    const origin = [{ role: 'user' as const, content: 'ORIGIN-CONTEXT-MARKER' }];

    const tool = agentsTool({
      mode: 'build',
      // Without the barrier's compactor the grandchild request is refused at admission.
      swarm: swarmDeps({ rt, db }, capturingModel(prompts), {
        originContext: () => origin,
        compactShared: async () => [{ role: 'user' as const, content: MARKER }],
      }),
    });

    await tool.execute(forkCall(1));

    expect(prompts.length).toBeGreaterThan(0);
    expect(JSON.stringify(prompts[0])).toContain('ORIGIN-CONTEXT-MARKER');
  });

  test('an inheriting parent past the threshold reaches its child compacted, not verbatim', async () => {
    const { rt, db } = createTestRuntime();
    await rt.storage.vfs.writeFile(SOLUTION_FILE, REFERENCE);
    const prompts: TurnPrompt[] = [];
    const compacted: ReadonlyArray<ModelMessage>[] = [];

    const compactShared = async (messages: readonly ModelMessage[]) => {
      compacted.push(messages);

      return [{ role: 'user' as const, content: MARKER }];
    };

    const tool = agentsTool({
      mode: 'build',
      swarm: swarmDeps({ rt, db }, capturingModel(prompts), { compactShared }),
    });

    await tool.execute(forkCall(1));

    expect(compacted.length).toBe(1);
    expect(JSON.stringify(compacted[0])).toContain(BULK.slice(0, 64));

    // The bulk still reaches the grandchild via briefs the barrier does not own; the contract is the prefix.
    expect(prompts.length).toBe(2);
    const grandchild: Readonly<TurnPrompt> = prompts[1];
    expect(grandchild.some((m) => m.role === 'user' && JSON.stringify(m.content).includes(MARKER))).toBe(true);
    expect(grandchild.some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes(BULK.slice(0, 64)))).toBe(false);
    expect(JSON.stringify(prompts[0])).not.toContain(MARKER);
    expect(JSON.stringify(prompts[0])).not.toContain(BULK.slice(0, 64));
  });

  test('siblings of one branch point share the one compacted prefix, byte-identical', async () => {
    const { rt, db } = createTestRuntime();
    await rt.storage.vfs.writeFile(SOLUTION_FILE, REFERENCE);
    const prompts: TurnPrompt[] = [];
    let compactions = 0;

    const compactShared = async () => {
      compactions += 1;

      return [{ role: 'user' as const, content: MARKER }];
    };

    const tool = agentsTool({
      mode: 'build',
      swarm: swarmDeps({ rt, db }, capturingModel(prompts), { compactShared }),
    });

    await tool.execute(forkCall(2));

    // Sibling requests differ by design (expand:'sample'), so identity is asserted on the inherited prefix.
    expect(compactions).toBe(1);
    expect(prompts.length).toBe(4);

    const inheritedPrefix = (prompt: TurnPrompt) =>
      JSON.stringify([...prompt].filter((m) => m.role === 'user' && JSON.stringify(m.content).includes(MARKER)));

    expect(inheritedPrefix(prompts[2]).length).toBeGreaterThan(0);
    expect(inheritedPrefix(prompts[2])).toBe(inheritedPrefix(prompts[3]));
    const siblings = [prompts[2], prompts[3]];

    for (const sibling of siblings) {
      expect([...sibling].some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes(BULK.slice(0, 64)))).toBe(false);
    }
  });

  // KINU-048: admission measures the request as sent, so it sees the compacted prefix.
  test('a child over the estimate gate on the verbatim prefix is admitted on the compacted one', async () => {
    const { rt, db } = createTestRuntime();
    await rt.storage.vfs.writeFile(SOLUTION_FILE, REFERENCE);
    const prompts: TurnPrompt[] = [];
    let sawMassInBarrier = 0;

    const compactShared = async (messages: readonly ModelMessage[]) => {
      if (JSON.stringify(messages).includes(BULK.slice(0, 64))) sawMassInBarrier += 1;

      return [{ role: 'user' as const, content: MARKER }];
    };

    const tool = agentsTool({
      mode: 'build',
      swarm: swarmDeps({ rt, db }, capturingModel(prompts), { compactShared }),
    });

    await tool.execute(forkCall(1));

    expect(sawMassInBarrier).toBe(1);
    expect(prompts.length).toBe(2);
  });
});
