/**
 * The `compactShared` seam, wired through the one production constructor.
 *
 * `SwarmRunDeps.compactShared` is the *Inherited context* barrier: a parent whose transcript
 * crosses ~85% of the window must be compacted ONCE, and every fork child of that parent must
 * read the same compacted prefix — never the verbatim mass that the provider then refuses.
 * The engine side (threshold, memoisation, events) is swarm-run's; what this file pins is the
 * WIRING: `runSwarmAction` is the only production constructor of `SwarmRunDeps`, so a fork
 * parent past the threshold must arrive compacted through the deps the `agents` tool hands
 * the run, or the knob is dead exactly as the audit found it (#199 against #137/#140).
 *
 * The compactor here is a spy on purpose: this suite proves the plumbing (called once per
 * branch point, the spy's output is what the child reads). That the spy's job is done in
 * production by the real better-compact ladder is packages/compaction's own suite. The run
 * composition is a real measured tree (`uct` over an exec-ratio objective) because that is
 * the one legal depth-2 shape; a prose candidate simply measures as nothing, which is all
 * the tree needs to keep expanding.
 */
import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { scriptedTurnModel, toolExecute } from '@kinu.run/test-utils';
import { createTestRuntime } from './helpers';
import {
  createAgentsTool,
  type AgentRuntime,
  type AgentsForkDeps, type AgentsToolDeps, type AgentsToolInput,
} from '../src/index';
import { SOLUTION_FILE } from '../src/strategy/exec-ratio';

const MARKER = 'COMPACTED-PREFIX-MARKER';
/** The bulk rides a comment INSIDE the measured code block, so one scripted
 *  answer is simultaneously over the compaction threshold (a bare prose answer
 *  is not measurable, and an unmeasured node is taken out of selection) and
 *  scoreable by the exec-ratio verifier. */
const BULK = 'x'.repeat(455_000);

const REFERENCE = `export function solve(input, oracle) {
  let seen = 0;
  for (let i = 0; i < input.n; i += 1) seen = oracle.step(seen);
  return seen;
}
`;

/** One instance, one metered primitive — the reference's own answer as ground truth. */
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

/** The request prompt a scripted turn receives, derived from the factory's own
 *  contract rather than asserted — the same derivation turn-model.ts pins. */
type TurnPrompt = Parameters<Parameters<typeof scriptedTurnModel>[0]['doGenerate']>[0]['prompt'];

/** One text step and stop, capturing every request prompt the run issues. */
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

function forkDeps(rt: AgentRuntime, model: CapturingModel, overrides: Partial<AgentsForkDeps> = {}): AgentsForkDeps {
  return { rt, model, ...overrides };
}

function agentsTool(deps: AgentsToolDeps) {
  const entry = createAgentsTool(deps);
  if (!entry) throw new Error('Expected agents tool to be created');
  return { ...entry, execute: toolExecute<AgentsToolInput, object>(entry) };
}

/** A legal depth-2 measured tree under `best-first`: the policy takes each node
 *  once, so the one legal chain is root -> child -> grandchild, and the child —
 *  whose transcript carries the bulk answer — is the branch point the barrier
 *  fires at. `uct` re-widens the root instead of descending, which never builds
 *  the depth-2 shape this seam needs. */
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
      context: 'fork' as const,
      expand: 'sample' as const,
      score: { kind: 'verify' as const },
      advance: { kind: 'best-first' as const },
      carry: { kind: 'none' as const },
    },
  };
}

describe('compactShared wiring through runSwarmAction', () => {
  test('a fork parent past the threshold reaches its child compacted, not verbatim', async () => {
    const { rt } = createTestRuntime();
    await rt.storage.vfs.writeFile(SOLUTION_FILE, REFERENCE);
    const prompts: TurnPrompt[] = [];
    const compacted: ReadonlyArray<ModelMessage>[] = [];
    const compactShared = async (messages: readonly ModelMessage[]) => {
      compacted.push(messages);
      return [{ role: 'user' as const, content: MARKER }];
    };
    const tool = agentsTool({
      mode: 'build',
      fork: forkDeps(rt, capturingModel(prompts), { compactShared }),
    });

    const result = await tool.execute(forkCall(1));
    expect(result).toBeTruthy();

    // The barrier fired at the one branch point above the threshold, over that parent's
    // transcript.
    expect(compacted.length).toBe(1);
    expect(JSON.stringify(compacted[0])).toContain(BULK.slice(0, 64));

    // The depth-2 child read the compacted marker and NOT the verbatim mass. The bulk
    // still reaches a grandchild's seed through the parent-conclusion and inherited-
    // artifact briefs — channels the barrier does not own — so the seam's contract is
    // about the PREFIX: the inherited transcript arrives as the compacted marker
    // message, and the parent's assistant turn (the verbatim mass) is gone. The depth-1
    // child inherited the root's empty transcript, so its request carries neither.
    expect(prompts.length).toBe(2);
    const grandchild: Readonly<TurnPrompt> = prompts[1];
    expect(grandchild.some((m) => m.role === 'user' && JSON.stringify(m.content).includes(MARKER))).toBe(true);
    expect(grandchild.some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes(BULK.slice(0, 64)))).toBe(false);
    expect(JSON.stringify(prompts[0])).not.toContain(MARKER);
    expect(JSON.stringify(prompts[0])).not.toContain(BULK.slice(0, 64));
  }, 120_000);

  test('siblings of one branch point share the one compacted prefix, byte-identical', async () => {
    const { rt } = createTestRuntime();
    await rt.storage.vfs.writeFile(SOLUTION_FILE, REFERENCE);
    const prompts: TurnPrompt[] = [];
    let compactions = 0;
    const compactShared = async () => {
      compactions += 1;
      return [{ role: 'user' as const, content: MARKER }];
    };
    const tool = agentsTool({
      mode: 'build',
      fork: forkDeps(rt, capturingModel(prompts), { compactShared }),
    });

    await tool.execute(forkCall(2));

    // ONE compaction for the branch point; both grandchildren read its output. Sibling
    // REQUESTS differ by design — expand:'sample' gives each its own angle brief — so
    // byte-identity is asserted on what the seam owns: the inherited prefix, which is
    // the same compacted marker message in both, with the parent's verbatim assistant
    // turn present in neither.
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
  }, 120_000);
});
