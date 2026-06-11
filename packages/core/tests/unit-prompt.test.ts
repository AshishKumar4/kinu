// Behavior tests for buildSystemPromptSync — the canonical system prompt.
// Catches drift: stale tool references, missing capability sections, execution
// guidance, and that registered-executors render correctly.
import { describe, test, expect } from 'bun:test';
import {
  assertToolsSupportedByModel,
  buildSystemPromptSync,
  BUILTIN_TOOLS,
  compilePromptSurface,
  modelSupportsTools,
} from '../src/index.ts';
import { createTestRuntime } from '@proteus/test-utils';

describe('buildSystemPromptSync', () => {
  test('uses fallback SOUL.md when SOUL.md is missing', () => {
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
    expect(prompt).toMatch(/2-6 real concurrent sub-agents/);
    expect(prompt).toMatch(/depth of 3/);
    expect(prompt).toMatch(/NOT stateless between turns/);
    // Heads leave a readable artifact trail the model should know about.
    expect(prompt).toContain('shared/findings/');
  });

  test('teaches the honest strategy doctrine: mcts branches cannot run tools, code runs at scoring', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toMatch(/cannot run tools/);
    expect(prompt).toMatch(/code is executed when scored/);
  });

  test('teaches craft-on-repeat, search-before-solve, and the lessons loop', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toContain('workspace.createTool');
    expect(prompt).toContain('workspace.listTools()');
    expect(prompt).toMatch(/next execute_tools call/);            // freshness, not "when injected"
    expect(prompt).toMatch(/failures are recorded as lessons/i);  // close the lesson loop
    expect(prompt).toContain('agent.proposeCurriculum');
  });

  test('honors soulOverride', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, { soulOverride: 'CUSTOM ROLE TEXT' });
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

  test('advertises llm.query and proposeScaffold only on the CF backend (where they exist)', () => {
    const { rt } = createTestRuntime();
    const cf = buildSystemPromptSync(rt, { backend: 'cf' });
    expect(cf).toMatch(/Code execution and learned capabilities/);
    expect(cf).toMatch(/llm\.query/);
    expect(cf).toContain('agent.proposeScaffold');
    // Regression: we previously had `splitLargeText(input, 4000)` which
    // doesn't exist anywhere in the runtime surface.
    expect(cf).not.toContain('splitLargeText');

    // The RLM provider and the scaffold are CF-only — advertising them on the
    // CLI sent the model to call namespaces that throw.
    const cli = buildSystemPromptSync(rt, { backend: 'cli-local' });
    expect(cli).toMatch(/Code execution and learned capabilities/);
    expect(cli).not.toMatch(/llm\.query/);
    expect(cli).not.toContain('agent.proposeScaffold');
  });

  test('does not advertise the removed Session context tools/blocks', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    // These tools are never generated (no writable/searchable Session blocks);
    // advertising them sent the model to call no-op tools. Memory now lives in
    // the agent_facts world model + the `memory` prose tool, both real.
    expect(prompt).not.toMatch(/set_context|search_context|load_context/);
    expect(prompt).not.toMatch(/Session context blocks/);
    expect(prompt).toContain('Memory and facts');
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

  test('renders only selectable executors when lifecycle facts are supplied', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      executors: [
        { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
        { name: 'laptop', kind: 'laptop', available: false, configured: false, active: false, status: 'not_configured' },
        { name: 'nimbus', kind: 'nimbus', available: true, configured: true, active: false, status: 'idle' },
        { name: 'sandbox', kind: 'sandbox', available: false, configured: false, active: false, status: 'not_configured' },
      ],
    });

    expect(prompt).toContain('nimbus.*');
    expect(prompt).toContain('ready on demand');
    expect(prompt).toContain('workspace.*');
    expect(prompt).toContain('internal Proteus state');
    expect(prompt).not.toContain('laptop');
    expect(prompt).not.toContain('sandbox.*');
    expect(prompt).not.toMatch(/Showing a running app/);
  });

  test('a registered-but-offline laptop stays visible with the reconnect instruction', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [
        { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
        { name: 'laptop', kind: 'laptop', available: false, configured: true, active: false, status: 'disconnected' },
      ],
    });

    expect(prompt).toContain('currently OFFLINE');
    expect(prompt).toContain('proteus connect');
    expect(prompt).toContain('Do not call it');
    // Offline ≠ selectable: no laptop.* namespace advertised for calls.
    expect(prompt).not.toContain('laptop.***');
  });

  test('a connected laptop teaches that first use asks for consent (tunnel backends)', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [
        { name: 'laptop', kind: 'laptop', available: true, configured: true, active: true, status: 'active' },
      ],
    });

    expect(prompt).toContain('laptop.*');
    expect(prompt).toContain('(connected)');
    expect(prompt).toContain("the user's OWN PC");
    expect(prompt).toContain('consent');
    expect(prompt).toContain('expected, not an error');
    // The live-state framing replaces "assume absent forever".
    expect(prompt).toContain('live state at the start of THIS turn');
  });

  test('the cli-local laptop is the CLI host machine — direct, no consent prompt', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cli-local',
      executors: [
        { name: 'laptop', kind: 'laptop', available: true, configured: true, active: true, status: 'active' },
      ],
    });

    expect(prompt).toContain('laptop.*');
    expect(prompt).toContain('the local machine the Proteus CLI is running on');
    expect(prompt).toContain('no tunnel or consent prompt');
    expect(prompt).not.toContain('device tunnel');
  });

  test('omits executor section when no executors registered', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, { registeredExecutors: [] });
    expect(prompt).not.toMatch(/Execution environments/);
    expect(prompt).not.toMatch(/exposePort/);
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

  test('orders core guidance before the volatile knowledge tail', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, { extraKnowledge: 'VOLATILE-NOTE' });
    expect(prompt).toContain('Operating guidance');
    expect(prompt).toContain('Tools available this turn');
    expect(prompt.indexOf('Operating guidance')).toBeLessThan(prompt.indexOf('VOLATILE-NOTE'));
  });

  test('renders only the available built-in tools for a gated turn', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      availableTools: ['memory', 'fact'],
      registeredExecutors: [],
    });
    expect(prompt).toContain('**memory**');
    expect(prompt).toContain('**fact**');
    expect(prompt).not.toContain('**execute_tools**');
    expect(prompt).not.toContain('agent.schedule');
    expect(prompt).not.toContain('Parallel sub-agents');
  });

  test('renders external tools separately from built-in tools', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      availableTools: ['memory'],
      externalTools: [
        { name: 'tool_docs_search', source: 'mcp', description: 'Search project documentation.' },
        'custom_export',
      ],
      registeredExecutors: [],
    });

    expect(prompt).toContain('**memory**');
    expect(prompt).not.toContain('**fact**');
    expect(prompt).toContain('External tools');
    expect(prompt).toContain('**tool_docs_search** (MCP) — Search project documentation.');
    expect(prompt).toContain('**custom_export** (external)');
  });

  test('prompt surface hides unavailable executors from selectable runtimes', () => {
    const surface = compilePromptSurface({
      executors: [
        { name: 'workspace', available: true, configured: true, active: true, status: 'active' },
        { name: 'laptop', available: false, configured: true, active: false, status: 'disconnected' },
      ],
    });
    expect(surface.executors.map((exec) => exec.name)).toEqual(['laptop', 'workspace']);
    expect(surface.selectableExecutors.map((exec) => exec.name)).toEqual(['workspace']);
  });

  test('model profile blocks tool mode on known non-tool models', () => {
    expect(modelSupportsTools({ id: 'o4-mini' })).toBe(false);
    expect(modelSupportsTools({ id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b' })).toBe(false);
    expect(modelSupportsTools({ id: '@cf/moonshotai/kimi-k2.6' })).toBe(true);
    expect(() => assertToolsSupportedByModel({ id: 'o4-mini' }, ['run']))
      .toThrow(/does not support tool calling/);
  });

  test('adds model-specific guidance for Kimi K2.6', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, { model: { id: '@cf/moonshotai/kimi-k2.6' } });
    expect(prompt).toContain('Kimi K2.6');
    expect(prompt).toContain('tool/result context');
  });

  test('adds model-specific guidance for GPT and Codex models', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, { model: { id: 'codex/gpt-5.5' } });
    expect(prompt).toContain('GPT/Codex-style');
    expect(prompt).toContain('success criteria');
  });

  test('adds mode overlays only when requested', () => {
    const { rt } = createTestRuntime();
    expect(buildSystemPromptSync(rt)).not.toContain('Background-resume mode');
    expect(buildSystemPromptSync(rt, { mode: 'background_resume' })).toContain('Background-resume mode');
    expect(buildSystemPromptSync(rt, { mode: 'cron' })).toContain('Scheduled wake mode');
    expect(buildSystemPromptSync(rt, { mode: 'product_change' })).toContain('Never deploy Proteus product changes');
  });

  test('does NOT promise unimplemented or redundant strategies', () => {
    // Regression: the `think` tool description previously claimed support for
    // strategies that don't exist. Build the prompt and check it advertises
    // exactly the two USEFUL ones — single-shot stays registered for eval
    // harnesses but is pure overhead for a chat model, so it's not advertised.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toMatch(/mcts/);
    expect(prompt).toMatch(/heads/);
    expect(prompt).not.toMatch(/single-shot/);
  });
});
