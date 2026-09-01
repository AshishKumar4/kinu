import { describe, test, expect } from 'bun:test';
import {
  workersAIEffortOption, effortFor, reasoningEffortOptions,
  mergeProviderOptions, REASONING_EFFORT_FOR_STAGE,
} from '../src/index';
import { REASONING_EFFORTS } from '../src/strategy/effort';
import type { ReasoningEffort } from '../src/strategy/effort';

describe('reasoning_effort plumbing', () => {
  test('REASONING_EFFORT_FOR_STAGE has all stages', () => {
    expect(REASONING_EFFORT_FOR_STAGE.chat).toBe('medium');
    expect(REASONING_EFFORT_FOR_STAGE.mcts_rollout).toBe('low');
    expect(REASONING_EFFORT_FOR_STAGE.scaffold_mutation).toBe('high');
  });

  test('workersAIEffortOption returns empty when no effort', () => {
    expect(workersAIEffortOption()).toEqual({});
    expect(workersAIEffortOption(undefined)).toEqual({});
  });

  test('workersAIEffortOption returns providerOptions shape', () => {
    const opt = workersAIEffortOption('high');
    expect(opt.providerOptions?.['workers-ai'].reasoning_effort).toBe('high');
  });

  test('effortFor(stage) shortcut', () => {
    const opt = effortFor('scaffold_mutation');
    expect(opt.providerOptions?.['workers-ai'].reasoning_effort).toBe('high');
  });

  test('maps user effort to each provider family exactly', () => {
    expect(reasoningEffortOptions('low', 'workers-ai')).toEqual({
      'workers-ai': { reasoning_effort: 'low' },
    });
    for (const provider of ['openai', 'opencode', 'codex', 'openai-compat', 'openai-compat:groq'] as const) {
      expect(reasoningEffortOptions('medium', provider)).toEqual({
        openai: { reasoningEffort: 'medium' },
      });
    }
    expect(reasoningEffortOptions('low', 'openrouter')).toEqual({
      openrouter: { reasoningEffort: 'low' },
    });
    expect(reasoningEffortOptions('high', 'anthropic')).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 32_000 } },
    });
  });

  test('maps Anthropic effort levels to their token budgets', () => {
    expect(reasoningEffortOptions('low', 'anthropic')).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 4_000 } },
    });
    expect(reasoningEffortOptions('medium', 'anthropic')).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 16_000 } },
    });
  });

  test('returns no options for an unsupported provider or missing effort', () => {
    expect(reasoningEffortOptions(undefined, 'openai')).toBeUndefined();
    expect(reasoningEffortOptions('high', 'unknown')).toBeUndefined();
  });

  test('merges effort into an existing provider namespace without clobbering it', () => {
    expect(mergeProviderOptions(
      { openai: { promptCacheKey: 'session-1' } },
      reasoningEffortOptions('high', 'openai'),
    )).toEqual({
      openai: { promptCacheKey: 'session-1', reasoningEffort: 'high' },
    });
  });
});

/**
 * THE RUNG TABLE IS A POLICY, AND A POLICY IS AN ORDERING.
 *
 * `REASONING_EFFORT_FOR_STAGE` was asserted stage by stage — chat, mcts_rollout,
 * scaffold_mutation — which is a second copy of some of its rows and says nothing
 * about the rest. `judge` was one of the five, and lowering it changes
 * no type, throws nothing, and leaves every suite green while every judged comparison in
 * the tree is decided by a model reasoning as cheaply as the branches it is ranking.
 *
 * What the table's own docstring claims is a relation, not a set of magnitudes: cheap on
 * fan-out, medium for user-visible work, high for the rare turn that rewrites the agent's
 * own controller. So the relation is what is asserted, and the relation is named by real
 * call sites rather than by the stage names — see the test body.
 */
describe('the reasoning rung a stage gets is a policy, not a list of magnitudes', () => {
  test('a scorer never reasons less than the sampling it is ranking', () => {
    // THE CALL SITES THAT MAKE THIS A RELATION AND NOT A PREFERENCE. In
    // `cf-backend/src/runtime.ts` ONE runtime samples branches through
    // `effortFor('mcts_rollout')` and scores those same branches through the `judgeModel`
    // whose `complete` carries `effortFor('judge')` — the same object, and the same call
    // `sampleJudgeScore` makes for every judged swarm candidate. `mcts_judge` is the
    // second scorer over the same samples. A judge level with the sampling it grades
    // cannot separate one branch from another, and a judged search whose scorer cannot
    // separate its candidates is best-of-n wearing a tree.
    const rung = (effort: ReasoningEffort) => REASONING_EFFORTS.indexOf(effort);

    expect(rung(REASONING_EFFORT_FOR_STAGE.judge))
      .toBeGreaterThan(rung(REASONING_EFFORT_FOR_STAGE.mcts_rollout));
    expect(rung(REASONING_EFFORT_FOR_STAGE.mcts_judge))
      .toBeGreaterThan(rung(REASONING_EFFORT_FOR_STAGE.mcts_rollout));

    // THE HIGH END, also as a relation: the rare self-modifying turn is the STRICT
    // maximum over every other stage, so no stage can be raised to meet it — and the
    // ladder is walked rather than sampled, so a stage added tomorrow is covered.
    for (const [stage, effort] of Object.entries(REASONING_EFFORT_FOR_STAGE)) {
      if (stage === 'scaffold_mutation') continue;
      expect(rung(REASONING_EFFORT_FOR_STAGE.scaffold_mutation)).toBeGreaterThan(rung(effort));
    }

    // AND THE RUNG A JUDGE IS GIVEN IS THE RUNG THAT REACHES THE PROVIDER, which is the
    // only place the policy has any effect. A projection of the table rather than a
    // restatement of it: both sides move together, so this cannot pin the value — it pins
    // that the seam does not drop it.
    expect(effortFor('judge').providerOptions?.['workers-ai'].reasoning_effort)
      .toBe(REASONING_EFFORT_FOR_STAGE.judge);
  });

  test('inside one provider namespace the override beats the base it is layered over', () => {
    // THE PRECEDENCE, WHICH THE DISJOINT CASE ABOVE CANNOT SEE. Both production callers
    // layer the same way round — `chat.ts` merges the caller's request options over the
    // cache plan's, and `actor-agent.ts` merges the resolved reasoning options over the
    // cache options — so the second argument is the request and the first is the plan it
    // is layered onto. Read the other way a caller cannot override a plan default at all
    // on any key the plan also sets, and `providerOptions` becomes a parameter that is
    // accepted and ignored on exactly the keys where it matters most.
    //
    // A SHARED KEY AND A UNIQUE ONE IN ONE ASSERTION: the override must win where they
    // collide AND the base must survive where it does not, because a merge that took the
    // override wholesale would satisfy the first half and lose the cache key.
    expect(mergeProviderOptions(
      { openai: { promptCacheKey: 'session-1', reasoningEffort: 'low' } },
      reasoningEffortOptions('high', 'openai'),
    )).toEqual({
      openai: { promptCacheKey: 'session-1', reasoningEffort: 'high' },
    });

    // And a namespace the request says nothing about is carried through untouched, so the
    // merge is per-namespace rather than a whole-object replacement.
    expect(mergeProviderOptions(
      { anthropic: { cacheControl: { type: 'ephemeral' } }, openai: { reasoningEffort: 'low' } },
      reasoningEffortOptions('high', 'openai'),
    )).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
      openai: { reasoningEffort: 'high' },
    });
  });
});
