// Behavior tests for buildSystemPromptSync — the canonical system prompt.
// Catches drift: stale tool references, missing capability sections, execution
// guidance, and that registered-executors render correctly.
import { describe, test, expect } from 'bun:test';
import {
  assertToolsSupportedByModel,
  buildSystemPromptSync,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_DESCRIPTIONS,
  BUILTIN_TOOL_SPECS,
  compilePromptSurface,
  currentDateForPrompt,
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
    // The doctrine lives in the think tool's JSON-schema description (what
    // providers weight for tool selection) — not in prompt prose.
    expect(BUILTIN_TOOL_DESCRIPTIONS.think).toMatch(/cannot run tools/);
    expect(BUILTIN_TOOL_DESCRIPTIONS.think).toMatch(/code is executed when scored/);
  });

  test('tool when-to-use doctrine is schema-only: descriptions carry it, prompt prose does not', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    for (const name of BUILTIN_TOOLS) {
      const spec = BUILTIN_TOOL_SPECS[name];
      // Schema description = summary + Use when / Avoid when / Returns.
      const description = BUILTIN_TOOL_DESCRIPTIONS[name];
      expect(description.startsWith(spec.summary)).toBe(true);
      expect(description).toContain(`Use when: ${spec.whenToUse}`);
      expect(description).toContain(`Avoid when: ${spec.whenNotToUse}`);
      expect(description).toContain(`Returns: ${spec.result}`);
      // Prompt prose carries ONLY the summary — no duplicated doctrine.
      expect(prompt).not.toContain(spec.whenToUse);
      expect(prompt).not.toContain(spec.whenNotToUse);
    }
    expect(prompt).not.toContain('Use when:');
    expect(prompt).not.toContain('Avoid when:');
  });

  test('kimi-family models get a bare tool name index; other families get summaries', () => {
    const { rt } = createTestRuntime();
    const opts = {
      availableTools: ['run', 'memory'] as const,
      externalTools: [{ name: 'tool_docs_search', source: 'mcp' as const, description: 'Search docs.' }],
      registeredExecutors: [] as string[],
    };
    const kimi = buildSystemPromptSync(rt, { ...opts, model: { id: '@cf/moonshotai/kimi-k2.6' } });
    const anthropic = buildSystemPromptSync(rt, { ...opts, model: { id: 'anthropic/claude-sonnet-4.5' } });

    // Kimi (Moonshot guidance): names only — no per-tool prose, schema carries it.
    expect(kimi).toContain('\n- run\n');
    expect(kimi).toContain('\n- memory');
    expect(kimi).toContain('\n- tool_docs_search');
    expect(kimi).not.toContain('**run**');
    expect(kimi).not.toContain(BUILTIN_TOOL_SPECS.run.summary);
    expect(kimi).not.toContain('Search docs.');
    // The guard line is family-independent.
    expect(kimi).toContain('Only call tools listed here');

    // Anthropic/OpenAI families: one summary line per tool.
    expect(anthropic).toContain(`- **run** — ${BUILTIN_TOOL_SPECS.run.summary}`);
    expect(anthropic).toContain(`- **memory** — ${BUILTIN_TOOL_SPECS.memory.summary}`);
    expect(anthropic).toContain('**tool_docs_search** (MCP) — Search docs.');
  });

  test('memory sessions scroll contract is schema-only', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    // The mode contract (query searches, around_message_id scrolls, neither
    // browses) lives in the memory tool's input-schema property descriptions.
    expect(prompt).not.toContain('around_message_id');
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

  test('teaches transcript recall: search past sessions before re-deriving context', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toContain('action="sessions"');
    expect(prompt).toMatch(/past session transcripts before re-deriving/);
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

  test('includes output-format guidance', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toMatch(/Output format/);
    expect(prompt).toMatch(/plain markdown|markdown/);
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

  test('renders the date-only current date in runtime context', () => {
    const { rt } = createTestRuntime();
    expect(currentDateForPrompt(new Date('2026-06-11T17:42:03Z'))).toBe('2026-06-11');
    const prompt = buildSystemPromptSync(rt, { backend: 'cf', currentDate: currentDateForPrompt() });
    expect(prompt).toContain(`- Current date: ${currentDateForPrompt()}`);
    // Date-only keeps the prompt byte-stable within a day (cache-safe).
    expect(prompt).not.toMatch(/Current date: .*\d:\d/);
  });

  test('persistence is stated plainly and teaches compaction awareness', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    // Gating is structural — no hedging about backend support.
    expect(prompt).not.toContain('when the backend supports them');
    // The model must not wrap up early because of token-budget fears.
    expect(prompt).toContain('Your context window is automatically compacted as it approaches its limit');
    expect(prompt).toContain('do not stop or wrap up tasks early due to token-budget concerns');
  });

  test('per-section char budgets stay pinned (additions must be deliberate)', () => {
    // Budget regression gate: each builder-owned section of the representative
    // CF surface stays within its pinned ceiling, so prompt growth is a
    // reviewed decision, not drift. Ceilings are ~10% over 2026-06 measured
    // sizes — raise one ONLY alongside an intentional content change.
    const BUDGETS: Record<string, number> = {
      'Runtime context': 160,
      'Operating guidance': 560,
      'Tools available this turn': 1050,
      'Execution environments': 2000,
      'Persistence': 700,
      'Memory and facts': 560,
      'Code execution and learned capabilities': 1530,
      'Parallel sub-agents': 380,
      'Background work': 260,
      'Proteus product changes': 290,
      'Output format': 180,
    };
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      registeredExecutors: ['workspace', 'nimbus', 'sandbox', 'laptop'],
      currentDate: '2026-06-11',
      model: { id: 'anthropic/claude-sonnet-4.5' },
    });
    const sections = new Map<string, number>();
    for (const block of prompt.split(/\n(?=## )/)) {
      const title = block.split('\n', 1)[0].replace(/^## /, '');
      sections.set(title, block.length);
    }
    const problems: string[] = [];
    for (const [title, budget] of Object.entries(BUDGETS)) {
      const size = sections.get(title);
      if (size === undefined) problems.push(`section "${title}" missing from the prompt`);
      else if (size > budget) problems.push(`section "${title}" is ${size} chars — over its ${budget}-char budget`);
    }
    expect(problems).toEqual([]);
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
