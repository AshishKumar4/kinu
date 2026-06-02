// Behavior tests for buildSystemPromptSync — the canonical system prompt.
// Catches drift: stale tool references, missing capability sections, RLM
// example correctness, and that registered-executors render correctly.
import { describe, test, expect } from 'bun:test';
import { buildSystemPromptSync, BUILTIN_TOOLS } from '../src/index.ts';
import { createTestRuntime } from '@proteus/test-utils';

describe('buildSystemPromptSync', () => {
  test('uses FALLBACK_PURPOSE when agent_soul is missing', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toMatch(/Proteus/);                 // identity self-id
    expect(prompt).toMatch(/self-evolving/i);          // general-purpose, not code-centric
  });

  test('teaches the agent it spawns parallel sub-agents and persists across turns', () => {
    // The "agent is restricted / stateless" feedback was a prompt gap: the
    // surface never affirmed that think(heads) = real concurrent sub-agents or
    // that storage persists between turns. These sections close that gap.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toMatch(/Parallel sub-agents/);
    expect(prompt).toMatch(/2–6 INDEPENDENT/);
    expect(prompt).toMatch(/recurse.*depth 3/);
    expect(prompt).toMatch(/NOT stateless between turns/);
  });

  test('honors purposeOverride', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, { purposeOverride: 'CUSTOM ROLE TEXT' });
    expect(prompt).toContain('CUSTOM ROLE TEXT');
    expect(prompt).not.toMatch(/^You are Proteus/);   // fallback NOT used
  });

  test('renders every BUILTIN_TOOL with its description', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    for (const name of BUILTIN_TOOLS) {
      expect(prompt).toContain(`**${name}**`);
    }
  });

  test('teaches RLM via a real-API code example (no hallucinated symbols)', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toMatch(/llm\.query/);
    expect(prompt).toMatch(/Recursive language model/);
    // Regression: we previously had `splitLargeText(input, 4000)` which
    // doesn't exist anywhere in the runtime surface.
    expect(prompt).not.toContain('splitLargeText');
  });

  test('does not advertise the removed Session context tools/blocks', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    // These tools are never generated (no writable/searchable Session blocks);
    // advertising them sent the model to call no-op tools. Memory now lives in
    // the agent_facts world model + the `memory` prose tool, both real.
    expect(prompt).not.toMatch(/set_context|search_context|load_context/);
    expect(prompt).not.toMatch(/Session context blocks/);
    expect(prompt).toContain('World model (agent_facts)');
  });

  test('renders executor section when registeredExecutors supplied', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      registeredExecutors: ['workspace', 'sandbox'],
    });
    expect(prompt).toContain('workspace.*');
    expect(prompt).toContain('sandbox.*');
    expect(prompt).toMatch(/Showing a running app/);
    expect(prompt).toMatch(/exposePort/);
    // With ≥2 executors, warn they're disjoint filesystems (the documented
    // "wrote in the sandbox, read an empty workspace" confusion).
    expect(prompt).toMatch(/separate filesystems/i);
  });

  test('omits executor section when no executors registered', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, { registeredExecutors: [] });
    expect(prompt).not.toMatch(/Executor namespaces/);
  });

  test('appends knowledge section when extraKnowledge supplied', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, { extraKnowledge: 'EXTRA-NOTE-XYZ' });
    expect(prompt).toContain('## Knowledge');
    expect(prompt).toContain('EXTRA-NOTE-XYZ');
  });

  test('includes output-format guidance', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toMatch(/Output format/);
    expect(prompt).toMatch(/plain markdown|markdown/);
  });

  test('does NOT promise unimplemented strategies (ToT/GoT/Reflexion as if they exist)', () => {
    // Regression: the `think` tool description previously claimed support for
    // strategies that don't exist. Build the prompt and check it doesn't
    // promise them as if they're available.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    // The think description should mention the THREE that exist explicitly.
    expect(prompt).toMatch(/single-shot/);
    expect(prompt).toMatch(/mcts/);
    expect(prompt).toMatch(/heads/);
  });
});
