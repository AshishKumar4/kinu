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
  DELEGATION_RUNGS,
  modelSupportsTools,
  promptModeForTurnEvent,
} from '../src/index.ts';
import { createTestRuntime } from '@proteus/test-utils';

describe('buildSystemPromptSync', () => {
  test('uses fallback SOUL.md when SOUL.md is missing', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toMatch(/Proteus/);                 // identity self-id
    expect(prompt).toMatch(/self-evolving/i);          // general-purpose, not code-centric
  });

  test('renders ONE delegation ladder keyed on lifetime — one tool, exactly two rungs', () => {
    // The duplicate-sounding-tools gap: think/team/peers were three delegation
    // surfaces, so the model saw `team` and never considered forking. ONE tool
    // (`agents`) now asks one question — how long does the helper need to live
    // — with both rung triggers rendered from the registry's DELEGATION_RUNGS
    // (single source).
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toMatch(/## Delegation/);
    expect(prompt).toMatch(/one tool — `agents`/);
    expect(prompt).toMatch(/how long does the helper need to live/);
    // The two rungs, plus "do it yourself" as the zero rung.
    expect(prompt).toMatch(/- Do it yourself — a single short coherent change\./);
    expect(prompt).toMatch(/- Ephemeral fork — Fork \(action=fork\)/);
    expect(prompt).toMatch(/- Persistent subordinate — Staff a subordinate \(action=staff\)/);
    // The old split surface is gone entirely.
    expect(prompt).not.toContain('`think`');
    expect(prompt).not.toContain('`team`');
    expect(prompt).not.toContain('`peers`');
    // The live-info loop and the forks' durable artifact trail survive.
    expect(prompt).toMatch(/loop web_search then web_fetch/);
    expect(prompt).toMatch(/split depth 3/);
    expect(prompt).toContain('shared/findings/');
    expect(prompt).toMatch(/NOT stateless between turns/);
  });

  test('mcts is a settle policy inside the fork rung, never a third rung', () => {
    // Preservation contract: mcts stays fully named and reachable in the
    // doctrine the model reads — but as how forks are SETTLED, not as a
    // co-equal delegation choice.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toMatch(/set settle=mcts/);
    expect(prompt).toMatch(/scored against each other by execution/);
    // It is never introduced as a ladder rung of its own.
    expect(prompt).not.toMatch(/^- .*\bmcts\b.*\) — /m);
    // The mcts settle text lives inside the fork bullet, after it starts.
    const forkRung = prompt.indexOf('- Ephemeral fork — ');
    expect(forkRung).toBeGreaterThan(-1);
    expect(prompt.indexOf('set settle=mcts')).toBeGreaterThan(forkRung);
  });

  test('each rung renders only for the agents actions the backend wires', () => {
    const { rt } = createTestRuntime();
    const both = buildSystemPromptSync(rt, {
      availableTools: ['agents'],
      registeredExecutors: [],
    });
    expect(both).toContain('## Delegation');
    expect(both).toMatch(/- Ephemeral fork — /);
    expect(both).toMatch(/- Persistent subordinate — /);
    expect(both).toMatch(/staff the needed roles.*ask each an independent workstream.*integrate/i);
    expect(both.indexOf('delegation ladder')).toBeLessThan(both.indexOf('## Tools available this turn'));

    // A subordinate / CLI session gets fork but never staff: one rung, no
    // staffing loop, no peer converse.
    const forkOnly = buildSystemPromptSync(rt, {
      availableTools: ['agents'],
      agentsActions: ['fork'],
      registeredExecutors: [],
    });
    expect(forkOnly).toContain('## Delegation');
    expect(forkOnly).toMatch(/- Ephemeral fork — /);
    expect(forkOnly).not.toMatch(/- Persistent subordinate/);
    expect(forkOnly).not.toContain('staff the needed roles');
    expect(forkOnly).not.toContain('OTHER workspace agents');
    // The ladder pointer is not staff-gated — one rung is still a ladder.
    expect(forkOnly).toContain('delegation ladder');
  });

  test('the in-sandbox rungs are advertised only where both halves exist', () => {
    // `agents.*` is built from the same deps that produce agentsActions, so
    // the line renders exactly when an actor can both delegate and run code.
    const { rt } = createTestRuntime();
    const both = buildSystemPromptSync(rt, {
      availableTools: ['agents', 'execute_tools'],
      agentsActions: ['fork'],
      registeredExecutors: [],
    });
    expect(both).toContain('callable inside execute_tools as `agents.<action>`');
    // The honest cost of forking from inside the sandbox, stated once.
    expect(both).toContain('does not resume after an eviction');

    // No sandbox → no namespace to advertise.
    const noSandbox = buildSystemPromptSync(rt, {
      availableTools: ['agents'],
      agentsActions: ['fork'],
      registeredExecutors: [],
    });
    expect(noSandbox).not.toContain('agents.<action>');

    // No delegation deps → the section is not rendered at all.
    const noDelegation = buildSystemPromptSync(rt, {
      availableTools: ['execute_tools'],
      registeredExecutors: [],
    });
    expect(noDelegation).not.toContain('agents.<action>');
  });

  test('the agents schema description leads with positive delegation triggers', () => {
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).toMatch(
      /Use when: One delegation ladder keyed on how long the helper needs to live/,
    );
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents.indexOf('one subordinate per independent workstream'))
      .toBeLessThan(BUILTIN_TOOL_DESCRIPTIONS.agents.indexOf('full turn'));
  });

  test('the ladder is single-sourced: both rungs render the registry constants verbatim', () => {
    // The prompt renders DELEGATION_RUNGS verbatim for BOTH rungs — no
    // parallel hardcoded delegation doctrine. Editing registry.ts is the only
    // place that changes what the model is told about forks vs subordinates.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toContain(DELEGATION_RUNGS.fork);
    expect(prompt).toContain(DELEGATION_RUNGS.staff);
    // And the schema description carries the same doctrine (also single-sourced).
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).toContain(DELEGATION_RUNGS.fork);
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).toContain(DELEGATION_RUNGS.staff);
  });

  test('completion never evicts: the staff rung teaches that finished subordinates STAY', () => {
    // The eviction bug: the old doctrine said "retire it when done", so the
    // orchestrator dismissed subordinates the moment they reported completed —
    // wiping their context. Persistence is now the doctrine in both surfaces.
    expect(DELEGATION_RUNGS.staff).toMatch(/reports and STAYS/);
    expect(DELEGATION_RUNGS.staff).toMatch(/dismiss only a subordinate whose role is permanently over/);
    expect(DELEGATION_RUNGS.staff).not.toMatch(/retire it when done/);
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toContain('A finished subordinate stays in your roster with its context');
    expect(prompt).not.toContain('cheap to create and dismiss');
  });

  test('teaches the honest settle doctrine: mcts branches do not run the tool loop, code runs at scoring', () => {
    // The honest framing (mcts branches score text/code, they don't run your
    // tool loop; proposed code IS executed at scoring) lives in the single
    // registry agents spec.
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).toMatch(/do NOT run your tool loop/);
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).toMatch(/code is executed when scored/);
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
      // Prompt prose carries ONLY the summary — no duplicated doctrine. The
      // SOLE exception is the delegation tool, `agents`: its whenToUse IS the
      // ladder the prompt deliberately renders from the same registry
      // constants (single source), so those triggers appear in both surfaces
      // by design — and must, since a bare tool-name index (kimi family)
      // would otherwise leave the model with no ladder at all.
      if (name !== 'agents') expect(prompt).not.toContain(spec.whenToUse);
      expect(prompt).not.toContain(spec.whenNotToUse);
    }
    // The `Use when:` / `Avoid when:` schema prefixes never leak into prose.
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

  test('advertises llm.query only where the provider is wired (rlmAvailable), on any backend', () => {
    const { rt } = createTestRuntime();
    const withRlm = buildSystemPromptSync(rt, { backend: 'cf', rlmAvailable: true });
    expect(withRlm).toMatch(/Code execution and learned capabilities/);
    expect(withRlm).toMatch(/llm\.query/);
    // The recipe names the fork rung for deeper decomposition (depth via
    // agents, not nested sub-calls).
    expect(withRlm).toContain('action=fork');
    // Regression: we previously had `splitLargeText(input, 4000)` which
    // doesn't exist anywhere in the runtime surface.
    expect(withRlm).not.toContain('splitLargeText');

    // A static-model CLI session has no resolver, so llm.query would throw —
    // never advertise it there. The scaffold self-provider ships on BOTH
    // backends since the shared-spine parity, so it is always advertised.
    const withoutRlm = buildSystemPromptSync(rt, { backend: 'cli-local' });
    expect(withoutRlm).toMatch(/Code execution and learned capabilities/);
    expect(withoutRlm).not.toMatch(/llm\.query/);
    expect(withoutRlm).toContain('agent.proposeScaffold');
    const cliWithRlm = buildSystemPromptSync(rt, { backend: 'cli-local', rlmAvailable: true });
    expect(cliWithRlm).toMatch(/llm\.query/);
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

  test('names the workspace mount table (/local + per-environment mounts) and keeps exec target-native', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [
        { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
        { name: 'sandbox', kind: 'sandbox', available: true, configured: true, active: true, status: 'active' },
        { name: 'nimbus', kind: 'nimbus', available: true, configured: true, active: false, status: 'idle' },
        { name: 'laptop', kind: 'laptop', available: true, configured: true, active: true, status: 'active' },
      ],
    });
    expect(prompt).toContain('mount table');
    expect(prompt).toContain('/local is the durable base');
    expect(prompt).toContain('/sandbox');
    expect(prompt).toContain('/nimbus');
    expect(prompt).toContain('/pc');
    expect(prompt).toContain('target-native');
  });

  test('the CLI-local VFS mounts its one remote plane, /pc, and says so', () => {
    // The local backend used to mount /local alone, so the doctrine was gated
    // off for cli-local entirely. It now mounts the host filesystem at the same
    // /pc prefix the cloud backend reaches the user's machine through, so the
    // doctrine follows the executor list on both backends.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cli-local',
      executors: [
        { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
        { name: 'laptop', kind: 'laptop', available: true, configured: true, active: true, status: 'active' },
      ],
    });
    expect(prompt).toContain('mount table');
    expect(prompt).toContain('/local is the durable base, and /pc is a live window');
    expect(prompt).not.toContain('/sandbox');
    expect(prompt).not.toContain('/nimbus');
  });

  test('a workspace with no execution devices renders no mount doctrine', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cli-local',
      executors: [
        { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
      ],
    });
    expect(prompt).not.toContain('mount table');
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
    // No delegation tool wired → no ladder at all.
    expect(prompt).not.toContain('## Delegation');
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

  test('turn-mode classification is one shared rule for both backends', () => {
    // Both backends stamp `metadata.proteusEvent` on programmatic turns and
    // must derive the SAME prompt mode from it — the cf backend used to pass
    // no mode at all, so a hosted agent woken to collect a background job
    // never saw the background-resume guidance the CLI agent got.
    expect(promptModeForTurnEvent('background_job')).toBe('background_resume');
    expect(promptModeForTurnEvent('timer_cron')).toBe('cron');
    expect(promptModeForTurnEvent('event_drain')).toBe('chat');
    expect(promptModeForTurnEvent(null)).toBe('chat');
    expect(promptModeForTurnEvent(undefined)).toBe('chat');

    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf', mode: promptModeForTurnEvent('background_job'),
    });
    expect(prompt).toContain('Background-resume mode');
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
      // Static pointer to the load-bearing delegation ladder (2026-07).
      'Operating guidance': 640,
      // +2 summary lines for the team/peers split + the subordinate report
      // tool (2026-07, Subordinates A2). Real actors advertise a
      // deps-filtered subset; this representative surface carries all three.
      // 2026-08: think/team summaries now name the lifetime rung they are.
      'Tools available this turn': 1800,
      // +2 lines of workspace mount-table doctrine (/local + /sandbox,/nimbus,
      // /pc file plane; exec stays target-native) — deliberate (2026-07).
      'Execution environments': 2450,
      'Persistence': 700,
      'Memory and facts': 560,
      // 2026-08: +1 clause on the schedule line for the mission budget. The
      // opt-in cap is only reachable if the model knows the argument exists,
      // and the detail (transitivity, nesting, refusal shape) stays in the
      // `agent.*` types block the sandbox reads rather than here.
      'Code execution and learned capabilities': 1640,
      // 2026-08: the old Research (1049) + Team (1435) sections collapsed into
      // ONE lifetime-keyed ladder. It carries both rung triggers verbatim from
      // the registry, so a bare tool-name index (kimi) still gets the whole
      // decision — deliberate, and the load-bearing fix for "the agent never
      // reached for think".
      // 2026-08: +1 line naming the turn-cumulative tool-output budget — the
      // clamp tightens mechanically, and a model told WHY reaches for a rung
      // instead of re-running the command (core/src/context-budget.ts).
      // 2026-08: +1 line for `agents.*` in codemode — the rung ladder is also
      // a sandbox namespace, which is what makes a crafted tool a workflow,
      // and it carries the in-sandbox fork's non-resumable cost.
      'Delegation': 3250,
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
    // Regression: the old think tool description once claimed support for
    // strategies that don't exist. The prompt names only `mcts`, the one
    // settle id a caller ever has to type — merging is the default, so the
    // ladder does not make the model pick a settle policy to delegate at all.
    // single-shot stays registered for eval harnesses but is pure overhead for
    // a chat model, so it is never advertised.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toMatch(/settle=mcts/);
    expect(prompt).not.toMatch(/single-shot/);
  });

  test('the ladder renders identically for BOTH a Kimi and a non-Kimi agent', () => {
    // Kimi gets a bare tool-name index with no per-tool prose, so anything
    // carried only by the schema is invisible to it. The Delegation section is
    // workflow doctrine in the agent-state block, not the per-tool index, so
    // both rungs and the mcts scoring policy reach every family.
    const { rt } = createTestRuntime();
    for (const id of ['@cf/moonshotai/kimi-k2.6', 'anthropic/claude-sonnet-4.5']) {
      const prompt = buildSystemPromptSync(rt, { model: { id } });
      expect(prompt).toMatch(/## Delegation/);
      expect(prompt).toMatch(/- Ephemeral fork — Fork \(action=fork\)/);
      expect(prompt).toMatch(/- Persistent subordinate — Staff a subordinate \(action=staff\)/);
      expect(prompt).toMatch(/set settle=mcts/);
      expect(prompt).toMatch(/loop web_search then web_fetch/);
    }
  });
});
