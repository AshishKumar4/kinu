import { describe, test, expect } from 'bun:test';
import { jsonSchema, tool, type ModelMessage, type ToolSet } from 'ai';
import {
  assertToolsSupportedByModel,
  buildSystemPromptSync,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_DESCRIPTIONS,
  BUILTIN_TOOL_SPECS,
  compilePromptSurface,
  currentDateForPrompt,
  DELEGATION_INHERITANCE,
  DELEGATION_RUNGS,
  modelSupportsTools,
  BUILTIN_ROLE_DEFINITIONS,
  deriveRoleLabel,
  turnProvenanceForMetadata,
  workModeForTurnMetadata,
  turnLocalContextMessage,
  renderDynamicContextBlock,
  DynamicContextLedger, collectDynamicContext, createAgentStores, initWorkspaceSchema,
  buildBuiltinTools, runChat, permitInPlan, toolsInWorkMode, resolveTurnProfile, profileCatalogDigest,
  splitPromptSections,
  AGENTS_TOOL_ACTIONS,
  BUILTIN_SKILLS,
  SWARM_PRESET_DOCTRINE,
  skillIndexLine, skillViewPath,
  type SkillHeader,
  type PromptExecutorInfo,
} from '../src/index';
import { AGENTS_ACTION_FIELDS } from '../src/delegation/agents-tool';
import { DELEGATION_SECTION, OPERATING_GUIDANCE } from '../src/prompting/section-templates';
import type { SystemPromptOptions } from '../src/prompt';
import {
  NAMED_SWARM_PRESETS, SWARM_PRESETS, SWARM_PRESET_POINTS, resolveSwarm,
  type SwarmInput,
} from '../src/strategy/swarm';
import { createTestRuntime, createTestActors, present, scriptedTurnModel, type ScriptedTurnResult } from '@kinu.run/test-utils';
import { makeSqlExec, storesFor } from './helpers';
import { createAgentSelfProvider, type AgentSelfHost } from '../src/tools/agent-self';

/** Type block of the `agent.*` codemode namespace as it ships; the host is never called. */
function agentSelfTypes(): string {
  const host: AgentSelfHost = new Proxy(Object.create(null), {
    get: () => async () => null,
  });

  return createAgentSelfProvider(host).types ?? '';
}

function expectDefaultPromptToMatch(...patterns: readonly RegExp[]): void {
  const { rt } = createTestRuntime();
  const prompt = buildSystemPromptSync(rt);

  for (const pattern of patterns) expect(prompt).toMatch(pattern);
}

describe('buildSystemPromptSync', () => {
  test('uses fallback SOUL.md when SOUL.md is missing', () => {
    expectDefaultPromptToMatch(/Kinu/, /self-evolving/i);
  });

  test('renders a neutral delegation index — one tool, no advice on when to delegate', () => {
    // Which rung a task wants lives in the `agents` schema; advice here would drift from it.
    const { rt } = createTestRuntime();

    const prompt = buildSystemPromptSync(rt, {
      availableTools: ['agents'],
      agentsActions: ['swarm', 'hire', 'msg'],
      temporaryAsk: true,
      registeredExecutors: [],
    });

    expect(prompt).toMatch(/## Delegation/);
    expect(prompt).toMatch(/Helper agents are one tool: `agents`/);
    expect(prompt).toMatch(/Its schema says what each action does/);
    expect(prompt).toMatch(/`swarm` runs parallel nodes over this workspace/);
    expect(prompt).toMatch(/`hire` with `lifetime:"task"` runs one agent for one question and returns its answer here/);
    expect(prompt).toMatch(/`hire` creates a persistent subordinate in this workspace/);
    expect(prompt).toMatch(/Subordinates share this workspace's files and sandbox/);
    expect(prompt).not.toContain('Delegate once the shape of the work is settled');
    expect(prompt).not.toContain('goes to the ladder');
    expect(prompt).not.toContain('Reach for it when');
    expect(prompt).not.toContain('coordination loop');
    expect(prompt).not.toContain('competing candidates');
    expect(prompt).not.toContain('search depth 3');
    expect(prompt).not.toContain('shared/findings/');
    expect(prompt).not.toContain('action=swarm');
    expect(prompt).not.toContain('`think`');
    expect(prompt).not.toContain('`team`');
    expect(prompt).not.toContain('`peers`');
  });

  test('tree search is action=swarm, and it is a rung rather than a settlement', () => {
    const agents = BUILTIN_TOOL_DESCRIPTIONS.agents;
    expect(agents).not.toContain('settle=');
    expect(agents).toMatch(/Run a search \(action=swarm\)/);
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toMatch(/`swarm` runs parallel nodes over this workspace/);
    expect(prompt).not.toContain('action=swarm');
  });

  test('each index clause renders only for the agents actions the backend wires', () => {
    const { rt } = createTestRuntime();

    const both = buildSystemPromptSync(rt, {
      availableTools: ['agents'],
      registeredExecutors: [],
    });

    expect(both).toContain('## Delegation');
    expect(both).toMatch(/`swarm` runs parallel nodes over this workspace/);
    expect(both).toMatch(/`hire` creates a persistent subordinate in this workspace/);

    const searchOnly = buildSystemPromptSync(rt, {
      availableTools: ['agents'],
      agentsActions: ['swarm'],
      registeredExecutors: [],
    });

    expect(searchOnly).toContain('## Delegation');
    expect(searchOnly).toMatch(/`swarm` runs parallel nodes over this workspace/);
    expect(searchOnly).not.toContain('`hire` creates a persistent subordinate');
  });

  test('the in-sandbox actions are advertised only where both halves exist', () => {
    const { rt } = createTestRuntime();

    const both = buildSystemPromptSync(rt, {
      availableTools: ['agents', 'eval'],
      agentsActions: ['swarm'],
      registeredExecutors: [],
    });

    expect(both).toContain('callable inside eval as `agents.<action>`');

    const noSandbox = buildSystemPromptSync(rt, {
      availableTools: ['agents'],
      agentsActions: ['swarm'],
      registeredExecutors: [],
    });

    expect(noSandbox).not.toContain('agents.<action>');

    const noDelegation = buildSystemPromptSync(rt, {
      availableTools: ['eval'],
      registeredExecutors: [],
    });

    expect(noDelegation).not.toContain('agents.<action>');
  });

  test('the agents schema description leads with the one-sentence lifetime frame', () => {
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).toMatch(
      /Use when: One delegation ladder, two rungs: a search is ephemeral/,
    );
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).toMatch(
      /Candidates are scored by your verifier running in this workspace when you declare an `objective`, and ranked by a judge ensemble when you do not/,
    );
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents.indexOf('one subordinate per independent workstream'))
      .toBeLessThan(BUILTIN_TOOL_DESCRIPTIONS.agents.indexOf('full turn'));
  });

  test('the rungs are specified once, in the schema — the prompt only indexes them', () => {
    // Schema descriptions are family-neutral, so a prompt copy of the rungs is pure duplication.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).toContain(DELEGATION_RUNGS.swarm);
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).toContain(DELEGATION_RUNGS.hire);
    expect(prompt).not.toContain(DELEGATION_RUNGS.swarm);
    expect(prompt).not.toContain(DELEGATION_RUNGS.hire);
  });

  test('the two delegation bodies share no sentence, so neither can drift into the other', () => {
    // Template markers are stripped first: a `{{#if}}` between lines otherwise glues sentences and hides a copy.
    const sentences = (text: string): string[] =>
      text.replace(/\{\{[^}]*\}\}/g, ' ')
        .split(/(?<=[.!?])[\s\n]+/).map((s) => s.trim()).filter((s) => s.length > 25);

    const section = new Set(sentences(DELEGATION_SECTION.source));
    const shared = sentences(BUILTIN_TOOL_SPECS.agents.whenToUse).filter((s) => section.has(s));
    expect(shared).toEqual([]);
    expect(sentences(BUILTIN_TOOL_SPECS.agents.whenToUse).length).toBeGreaterThan(10);
    expect(section.size).toBeGreaterThan(4);
  });

  test('completion never evicts: the hire rung teaches that finished subordinates STAY', () => {
    // Dismissing a subordinate on completion wipes its context.
    expect(DELEGATION_RUNGS.hire).toMatch(/reports and STAYS/);
    expect(DELEGATION_RUNGS.hire).toMatch(/dismiss only one whose role is permanently over/);
    expect(DELEGATION_RUNGS.hire).not.toMatch(/retire it when done/);
    expect(DELEGATION_RUNGS.hire).not.toMatch(/cheap to create and dismiss/);
    const { rt } = createTestRuntime();
    expect(buildSystemPromptSync(rt)).not.toContain('A finished subordinate');
  });

  test('the search rung says who decides, stated as a mechanism and not a preference', () => {
    const agents = BUILTIN_TOOL_DESCRIPTIONS.agents;
    const scorers = /by your verifier running in this workspace when you declare an `objective`/g;
    expect(agents).toMatch(scorers);
    expect(agents.match(scorers)).toHaveLength(1);
    expect(agents).toMatch(/and ranked by a judge ensemble when you do not/);
    expect(agents.match(/and ranked by a judge ensemble when you do not/g)).toHaveLength(1);
    expect(agents).toMatch(/You name the shape with `preset`, and a verifier is CODE that runs here rather than a model's opinion of the answer/);
    expect(agents).toMatch(/a metric nothing can execute is not an objective/);
    expect(agents.indexOf('handing you back only what they found'))
      .toBeLessThan(agents.indexOf('It refuses rather than approximates'));
    expect(agents).not.toMatch(/genuinely unclear/);
  });

  test('the search rung carries no triggers — no breadth, doubt or payoff framing', () => {
    expect(DELEGATION_RUNGS.swarm).toMatch(/^Run a search \(action=swarm\): N nodes each running its own tool loop/);
    expect(DELEGATION_RUNGS.swarm).toMatch(/handing you back only what they found/);
    expect(DELEGATION_RUNGS.swarm).not.toContain('spend someone else\'s context instead of your own');
    expect(DELEGATION_RUNGS.swarm).not.toMatch(/Two triggers\./);
    expect(DELEGATION_RUNGS.swarm).not.toMatch(/Breadth:/);
    expect(DELEGATION_RUNGS.swarm).not.toMatch(/Doubt:/);
    expect(DELEGATION_RUNGS.swarm).not.toMatch(/being unsure is itself a reason to search/);
    expect(DELEGATION_RUNGS.swarm).not.toMatch(/you cannot check your own output/);
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).not.toContain('spend someone else\'s context');
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).not.toMatch(/being unsure is itself a reason to search/);
    expect(buildSystemPromptSync(createTestRuntime().rt)).not.toContain('spend someone else\'s context');
  });

  test('both rungs scale the count to the task and calibrate it on numbers this repo runs', () => {
    // Derived from the preset table: registry.ts is import-free, so prose there drifts from the rows.
    const widths = NAMED_SWARM_PRESETS.map((preset) => SWARM_PRESET_POINTS[preset].branches);
    const band = `from ${String(Math.min(...widths))} to ${String(Math.max(...widths))} per level`;
    expect(DELEGATION_RUNGS.swarm).toContain(band);
    expect(DELEGATION_RUNGS.swarm).toContain('`branches` is that count');

    // `agentsActionsFor` gates `swarm` separately, so the hire rung must stand alone without preset vocabulary.
    expect(DELEGATION_RUNGS.hire).toMatch(/how many independent workstreams the task holds/);
    expect(DELEGATION_RUNGS.hire).not.toContain('preset');
    expect(DELEGATION_RUNGS.hire).not.toContain('branches');

    expect(DELEGATION_RUNGS.swarm).toContain('token bill');
    expect(DELEGATION_RUNGS.hire).toContain('token bill');
  });

  test('the prompt index names the actions without teaching when to delegate', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).not.toMatch(/when the work already has 2\+ independent angles/);
    expect(prompt).not.toMatch(/uncertain enough to be worth two attempts at once/);
    expect(prompt).not.toMatch(/A search writes its own competing candidates/);
    expect(prompt).not.toMatch(/you supply what counts, not the angles/);
    expect(prompt).not.toContain(DELEGATION_RUNGS.swarm);
  });

  test('every surface that enumerates presets names all six, and every one of them resolves', () => {
    const doctrine = SWARM_PRESET_DOCTRINE.join(' ');

    for (const preset of SWARM_PRESETS) expect(doctrine).toContain(preset);
    expect(doctrine).not.toContain('UNCONSTRUCTIBLE');

    for (const preset of NAMED_SWARM_PRESETS) {
      expect(SWARM_PRESET_POINTS[preset].config).toBeDefined();
    }

    for (const preset of NAMED_SWARM_PRESETS) {
      // An absent key must be absent, not undefined: the resolver tells the two apart.
      const archive = SWARM_PRESET_POINTS[preset].config.advance.kind === 'archive';

      const call: SwarmInput = archive
        ? { preset, task: 'x', key: 'k' }
        : { preset, task: 'x' };

      expect(resolveSwarm(call)).not.toHaveProperty('reason');
    }
  });

  test('the preset list is rendered where `preset` is filled, and not a second time in the rung', () => {
    const doctrine = SWARM_PRESET_DOCTRINE.join(' ');
    expect(DELEGATION_RUNGS.swarm).not.toContain('preset=optimise');
    expect(DELEGATION_RUNGS.swarm).not.toContain('research/audit/redteam');
    expect(DELEGATION_RUNGS.swarm).not.toContain(doctrine);
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).not.toContain('research/audit/redteam');
    expect(DELEGATION_RUNGS.swarm).toContain('You name the shape with `preset`');
    expect(buildSystemPromptSync(createTestRuntime().rt)).not.toContain(doctrine);
  });

  test('no built-in skill body calls an action or a field the tool surface does not have', () => {
    // Nothing typechecks a template string, so a renamed action or field drifts silently.
    const liveActions: readonly string[] = AGENTS_TOOL_ACTIONS;
    const swarmFields: readonly string[] = AGENTS_ACTION_FIELDS.swarm;

    for (const skill of BUILTIN_SKILLS) {
      for (const [, action] of skill.body.matchAll(/action:\s*["'](\w+)["']/g)) {
        expect(liveActions).toContain(action);
      }

      for (const [, field] of skill.body.matchAll(/agents\(\{([^}]*)\}/g)) {
        for (const [, key] of field.matchAll(/(\w+):/g)) {
          if (key === 'action') continue;
          expect(swarmFields).toContain(key);
        }
      }
    }
  });

  test('what a node can lean on is stated where the task is written, and nowhere twice', () => {
    expect(DELEGATION_INHERITANCE.swarm.brief).toMatch(/the search's `context`/);
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).toContain(DELEGATION_INHERITANCE.swarm.rung);
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).not.toContain(DELEGATION_INHERITANCE.swarm.brief);
    expect(prompt).toMatch(/`swarm` runs parallel nodes over this workspace/);
    expect(prompt).not.toContain('shared/findings');
  });

  test('delegation never advertises unsupported per-node model routing', () => {
    const { rt } = createTestRuntime();

    const prompts = [
      buildSystemPromptSync(rt, {
        availableTools: ['agents'],
        registeredExecutors: [],
        model: { provider: 'anthropic', id: 'claude-sonnet-4-6', capabilities: ['tools', 'streaming'] },
      }),
      buildSystemPromptSync(rt, {
        availableTools: ['agents'],
        registeredExecutors: [],
        model: { provider: 'openai', id: 'o4-mini', capabilities: ['streaming', 'reasoning'] },
      }),
      buildSystemPromptSync(rt, {
        availableTools: ['agents'],
        registeredExecutors: [],
        model: { provider: 'future-provider', id: 'new-model' },
      }),
    ];

    for (const prompt of prompts) {
      expect(prompt).toMatch(/`swarm` runs parallel nodes over this workspace/);
      expect(prompt).toMatch(/`hire` creates a persistent subordinate in this workspace/);
      expect(prompt).not.toContain('`models` puts a different vendor');
      expect(prompt).not.toContain('a weaker model added for variety');
    }
  });

  test('the agents example is the cheapest COMPLETE call', () => {
    // `ideate` is the one preset that legally takes no `objective`, so the example is a complete call.
    const { rt } = createTestRuntime();
    const example = BUILTIN_TOOL_SPECS.agents.example;
    expect(example).toContain("action:'swarm'");
    expect(example).toContain("preset:'ideate'");
    expect(example).toContain('task:');
    expect(buildSystemPromptSync(rt)).toContain(example);
  });

  test('tool when-to-use doctrine is schema-only: descriptions carry it, prompt prose does not', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);

    for (const name of BUILTIN_TOOLS) {
      const spec = BUILTIN_TOOL_SPECS[name];
      const description = BUILTIN_TOOL_DESCRIPTIONS[name];
      expect(description.startsWith(spec.summary)).toBe(true);
      expect(description).toContain(`Use when: ${spec.whenToUse}`);
      expect(description).toContain(`Avoid when: ${spec.whenNotToUse}`);
      expect(description).toContain(`Returns: ${spec.result}`);
      expect(prompt).not.toContain(spec.whenToUse);
      expect(prompt).not.toContain(spec.whenNotToUse);

      if ('doctrine' in spec && spec.doctrine) expect(prompt).not.toContain(spec.doctrine);
    }

    expect(prompt).not.toContain('Use when:');
    expect(prompt).not.toContain('Avoid when:');
  });

  test('the tool index is one rendering for every model family', () => {
    const { rt } = createTestRuntime();
    const registeredExecutors: string[] = [];

    const opts = {
      availableTools: ['shell', 'memory'] as const,
      externalTools: [{ name: 'tool_docs_search', source: 'mcp' as const, description: 'Search docs.' }],
      registeredExecutors,
    };

    const section = (id: string) => {
      const prompt = buildSystemPromptSync(rt, { ...opts, model: { id } });
      const start = prompt.indexOf('## Tools available this turn');

      return prompt.slice(start, prompt.indexOf('\n## ', start + 1));
    };

    const kimi = section('@cf/moonshotai/kimi-k2.6');
    expect(kimi).toEqual(section('anthropic/claude-sonnet-4.5'));
    expect(kimi).toEqual(section('codex/gpt-5.5'));

    expect(kimi).toContain(`- **shell**: \`${BUILTIN_TOOL_SPECS.shell.example}\``);
    expect(kimi).toContain(`- **memory**: \`${BUILTIN_TOOL_SPECS.memory.example}\``);

    for (const name of BUILTIN_TOOLS) {
      expect(kimi).not.toContain(BUILTIN_TOOL_SPECS[name].summary);
    }

    expect(kimi).toContain('**tool_docs_search** (MCP) — Search docs.');
    expect(kimi).toContain('Call the tools listed here');
  });

  test('memory conversations scroll contract is schema-only', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).not.toContain('around_message_id');
  });

  test('teaches craft-on-repeat, search-before-solve, and the lessons loop', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toContain('workspace.createTool');
    expect(prompt).toContain('workspace.listTools()');
    expect(prompt).toMatch(/next eval call/);
    expect(prompt).toContain('`agent.*` namespace inside eval');
    expect(prompt).toMatch(/curriculum/);
    expect(prompt).not.toContain('agent.proposeCurriculum(');
    expect(agentSelfTypes()).toContain('proposeCurriculum');
    expect(BUILTIN_TOOL_DESCRIPTIONS.memory).toMatch(/failures are recorded as lessons/i);
  });

  test('honors soulOverride', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, { soulOverride: 'CUSTOM ROLE TEXT' });
    expect(prompt).toContain('CUSTOM ROLE TEXT');
    expect(prompt).not.toMatch(/^You are Kinu/);
  });

  test('renders every BUILTIN_TOOL with its description', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);

    for (const name of BUILTIN_TOOLS) {
      expect(prompt).toContain(`**${name}**`);
    }
  });

  test('advertises the temporary-agent channel only where the port is wired, on any backend', () => {
    const { rt } = createTestRuntime();
    const withTemporary = buildSystemPromptSync(rt, { backend: 'cf', temporaryAsk: true });
    expect(withTemporary).toMatch(/## Delegation/);
    expect(withTemporary).toContain('`hire` with `lifetime:"task"` runs one agent for one question');
    expect(withTemporary).toMatch(/Code execution and learned capabilities/);
    expect(withTemporary).not.toContain('agents.ask(');
    expect(withTemporary).not.toContain('context_ref');
    expect(withTemporary).not.toContain('rlm.query');

    const withoutTemporary = buildSystemPromptSync(rt, { backend: 'cli-local' });
    expect(withoutTemporary).toMatch(/Code execution and learned capabilities/);
    expect(withoutTemporary).not.toContain('`hire` with `lifetime:"task"` runs one agent for one question');
    expect(withoutTemporary).toContain('`agent.*` namespace inside eval');
    expect(withoutTemporary).toMatch(/scaffold proposals/);
    expect(withoutTemporary).not.toContain('agent.proposeScaffold(');
    expect(agentSelfTypes()).toContain('proposeScaffold');
    const cliWithTemporary = buildSystemPromptSync(rt, { backend: 'cli-local', temporaryAsk: true });
    expect(cliWithTemporary).toContain('`hire` with `lifetime:"task"` runs one agent for one question');
  });

  test('does not advertise removed context tools or blocks', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).not.toMatch(/set_context|search_context|load_context/);
    expect(prompt).not.toMatch(/context blocks/iu);
    expect(BUILTIN_TOOL_DESCRIPTIONS.memory).toContain('past conversations');
  });

  test('durable-state doctrine is schema-only: no `## Memory and facts` section', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).not.toContain('## Memory and facts');
    const memory = BUILTIN_TOOL_DESCRIPTIONS.memory;
    expect(memory).toMatch(/remember\/recall hold a small named value/);
    expect(memory).toMatch(/update a stale key rather than adding a contradictory second fact/);
    expect(memory).toMatch(/conversations reads what this agent said before/);
  });

  test('no release overlay renders: nothing could ever stamp it', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).not.toContain('## Kinu release changes');
    expect(prompt).not.toContain('Release mode:');
    expect(prompt).not.toContain('Never deploy Kinu release changes');
  });

  test('the ambient skills index renders name + description for every available skill, active or not', () => {
    const { rt } = createTestRuntime();

    const dormant: SkillHeader = {
      name: 'dormant-skill', description: 'Not active this turn, but the model should still know it exists.',
      allowed_tools: [], user_invocable: true, ext: {}, source: 'builtin',
    };

    const prompt = buildSystemPromptSync(rt, {
      availableSkills: { lines: [skillIndexLine(dormant)], omitted: 0, tokens: 0 },
    });

    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('**dormant-skill**');
    expect(prompt).toContain(skillViewPath('dormant-skill'));
    expect(prompt).toContain('Not active this turn');
    expect(prompt).not.toContain('DORMANT-BODY-MUST-NOT-APPEAR');
  });

  test('omitting availableSkills renders no Skills section (no regression for callers that do not pass it)', () => {
    const { rt } = createTestRuntime();
    expect(buildSystemPromptSync(rt)).not.toContain('## Skills');
  });

  test('renders executor section when registeredExecutors supplied', () => {
    const { rt } = createTestRuntime();

    const prompt = buildSystemPromptSync(rt, {
      executors: [
        { name: 'workspace', kind: 'workspace', capabilities: [], available: true, configured: true, active: true, status: 'active' },
        { name: 'sandbox', kind: 'sandbox', capabilities: ['net_inbound'], available: true, configured: true, active: true, status: 'active' },
      ],
    });

    expect(prompt).toContain('workspace.*');
    expect(prompt).toContain('sandbox.*');
    expect(prompt).toMatch(/Showing a running app/);
    expect(prompt).toMatch(/exposePort/);
    expect(prompt).toMatch(/separate machines/i);
    expect(prompt).toContain('/pc');
    expect(prompt).toContain('/sandbox');
  });

  test('teaches the preview workflow for the executor that actually exposes inbound ports', () => {
    const { rt } = createTestRuntime();

    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [
        { name: 'workspace', kind: 'workspace', capabilities: ['net_inbound'], available: true, configured: true, active: true, status: 'active' },
      ],
    });

    expect(prompt).toMatch(/Showing a running app/);
    expect(prompt).toContain('workspace.exposePort(port)');
    expect(prompt).not.toContain('sandbox.exposePort(port)');
  });

  test('an interface request is routed to a slate, and only where a slate can preview', () => {
    const { rt } = createTestRuntime();

    const workspacePreviews = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [
        { name: 'workspace', kind: 'workspace', capabilities: ['net_inbound'], available: true, configured: true, active: true, status: 'active' },
      ],
    });

    // The slate rule names the one load path of its skill, ahead of the standalone-server exception.
    expect(workspacePreviews).toContain(skillViewPath('slates'));
    expect(workspacePreviews.indexOf(skillViewPath('slates'))).toBeLessThan(workspacePreviews.indexOf('exposePort'));

    const containerPreviewsOnly = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [
        { name: 'workspace', kind: 'workspace', capabilities: [], available: true, configured: true, active: true, status: 'active' },
        { name: 'sandbox', kind: 'sandbox', capabilities: ['net_inbound'], available: true, configured: true, active: true, status: 'active' },
      ],
    });

    expect(containerPreviewsOnly).toMatch(/Showing a running app/);
    expect(containerPreviewsOnly).not.toContain(skillViewPath('slates'));
  });

  test('every runtime is its own machine, with mounts named', () => {
    const { rt } = createTestRuntime();

    const executors: PromptExecutorInfo[] = [
      { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
      { name: 'device', kind: 'device', available: true, configured: true, active: true, status: 'active' },
    ];

    const prompt = buildSystemPromptSync(rt, { backend: 'cf', executors });
    expect(prompt).toMatch(/separate machines/i);
    expect(prompt).not.toContain('the same machine and see the same files');
    expect(prompt).toContain('/pc');
  });

  test('renders only selectable executors when lifecycle facts are supplied', () => {
    const { rt } = createTestRuntime();

    const prompt = buildSystemPromptSync(rt, {
      executors: [
        { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
        { name: 'device', kind: 'device', available: false, configured: false, active: false, status: 'not_configured' },
        { name: 'sandbox', kind: 'sandbox', available: false, configured: false, active: false, status: 'not_configured' },
      ],
    });

    expect(prompt).not.toContain('nimbus.*');
    expect(prompt).toContain('workspace.*');
    expect(prompt).not.toContain('device.*');
    expect(prompt).not.toContain('**sandbox.***');
    expect(prompt).not.toMatch(/Showing a running app/);
  });

  test('the isolate ceiling is claimed only where it holds — never on cli-local', () => {
    const { rt } = createTestRuntime();

    const prompt = buildSystemPromptSync(rt, {
      backend: 'cli-local',
      executors: [
        { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
      ],
    });

    expect(prompt).toContain('workspace.*');
    expect(prompt).not.toContain('Worker isolate');
  });

  test('a registered-but-offline device stays visible, by name, with the way back', () => {
    const { rt } = createTestRuntime();

    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [
        { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
        {
          name: 'device', kind: 'device', available: false, configured: true, active: false,
          status: 'disconnected', label: 'ashish@studio',
        },
      ],
    });

    expect(prompt).toContain('currently offline');
    expect(prompt).toContain('ashish@studio');
    expect(prompt).toContain('asks the user to bring it back');
    expect(prompt).toContain('kinu connect');
    expect(prompt).not.toContain('device.***');
  });

  test('the online device line names no machine and no grant: the fleet is volatile', () => {
    const { rt } = createTestRuntime();

    for (const granted of [false, true]) {
      const prompt = buildSystemPromptSync(rt, {
        backend: 'cf',
        executors: [
          {
            name: 'device', kind: 'device', available: true, configured: true, active: true,
            status: 'active', label: 'ashish@studio', granted,
          },
        ],
      });

      expect(prompt).toContain('device.*');
      expect(prompt).not.toContain('ashish@studio');
      expect(prompt).not.toContain('NO grant yet');
      expect(prompt).not.toContain('holds its access grant already');
      expect(prompt).toContain('Grants are per machine');
      expect(prompt).toContain('the runtime asks the user once');
      expect(prompt).toContain('runtime: "<nickname>"');
      expect(prompt).toContain('The runtime refuses a call that names none');
      expect(prompt).toContain('live state at the start of this turn');
    }
  });

  test('the online device line renders the same bytes whatever the fleet looks like', () => {
    const { rt } = createTestRuntime();

    const render = (identity: { label?: string; granted?: boolean }) => buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [{
        name: 'device', kind: 'device', available: true, configured: true, active: true, status: 'active',
        ...identity,
      }],
    });

    expect(render({ label: 'ashish@studio', granted: false })).toBe(render({ label: 'mrwhite@rig', granted: true }));
    expect(render({})).toBe(render({ label: 'ashish@studio', granted: true }));
  });

  test('cli-local renders the workspace as the machine, rooted where the session started', () => {
    const { rt } = createTestRuntime();

    const prompt = buildSystemPromptSync(rt, {
      backend: 'cli-local',
      executors: [
        { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
      ],
    });

    expect(prompt).not.toContain('device.***');
    expect(prompt).not.toMatch(/separate machines/i);
    expect(prompt).toContain('the machine the CLI runs on');
    expect(prompt).toContain('rooted in the directory the session was started in');
  });

  test('omits executor section when no executors registered', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, { registeredExecutors: [] });
    expect(prompt).not.toMatch(/Execution environments/);
    expect(prompt).not.toMatch(/exposePort/);
  });

  test('names the workspace filesystem and each environment by its own namespace', () => {
    const { rt } = createTestRuntime();

    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [
        { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
        { name: 'sandbox', kind: 'sandbox', available: true, configured: true, active: true, status: 'active' },
        { name: 'device', kind: 'device', available: true, configured: true, active: true, status: 'active' },
      ],
    });

    expect(prompt).toContain('/home/main');
    expect(prompt).toContain('the same bytes the `file` tool and `workspace.*` file ops read');
    expect(prompt).toContain('`sandbox.*`');
    expect(prompt).not.toContain('`nimbus.*`');
    expect(prompt).toContain('`device.*`');
    expect(prompt).not.toContain('Nimbus for quick cloud execution');
    expect(prompt).toMatch(/paths native to each machine/);
    expect(prompt).toContain('/pc');
    expect(prompt).toContain('/sandbox');
  });

  test('the doctrine follows the executor list, not the backend', () => {
    const { rt } = createTestRuntime();

    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [
        { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' },
        { name: 'device', kind: 'device', available: true, configured: true, active: true, status: 'active' },
      ],
    });

    expect(prompt).toContain('`device.*`');
    expect(prompt).not.toContain('`sandbox.*`');
    expect(prompt).not.toContain('`nimbus.*`');
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

  test('verification is doctrine of its own, not a line buried in operating guidance', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    expect(prompt).toContain('## Verification');
    expect(prompt).not.toMatch(/The artifact is the evidence — read it/);
    expect(prompt).not.toMatch(/Before you call work done/);
    expect(prompt).not.toMatch(/Re-read/);
    expect(prompt).toMatch(/Check every deliverable the request names/);
    expect(prompt).toMatch(/column order, direction, units, filenames/);
    expect(prompt).toMatch(/Build to the interface the task states/);
    expect(prompt).toMatch(/A result is something you executed/);
    expect(prompt).not.toContain('narrowest reliable checks');
    expect(prompt.indexOf('## Verification')).toBeGreaterThan(prompt.indexOf('## Delegation'));
    expect(prompt.indexOf('## Verification')).toBeLessThan(prompt.indexOf('## Output format'));
  });

  test('the run-the-real-check line is gated on actually having an executor', () => {
    const { rt } = createTestRuntime();

    const noExec = buildSystemPromptSync(rt, {
      availableTools: ['memory'],
      registeredExecutors: [],
    });

    expect(noExec).toContain('## Verification');
    expect(noExec).toContain('Check every deliverable the request names');
    expect(noExec).not.toContain('Run the real check');

    const withRun = buildSystemPromptSync(rt, {
      availableTools: ['memory', 'shell'],
      registeredExecutors: [],
    });

    expect(withRun).toMatch(/Run the real check and report what passed or failed/);
    expect(withRun).toMatch(/A result is something you executed/);
  });

  test('includes output-format guidance', () => {
    expectDefaultPromptToMatch(/Output format/, /plain markdown|markdown/);
  });

  test('renders only the available built-in tools for a gated turn', () => {
    const { rt } = createTestRuntime();

    const prompt = buildSystemPromptSync(rt, {
      availableTools: ['memory', 'web'],
      registeredExecutors: [],
    });

    expect(prompt).toContain('**memory**');
    expect(prompt).toContain('**web**');
    expect(prompt).not.toContain('**eval**');
    expect(prompt).not.toContain('agent.schedule');
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
    expect(prompt).not.toContain('**web**');
    expect(prompt).toContain('External tools');
    expect(prompt).toContain('**tool_docs_search** (MCP) — Search project documentation.');
    expect(prompt).toContain('**custom_export** (external)');
  });

  test('prompt surface skips malformed external tool entries instead of throwing', () => {
    const externalTools = JSON.parse(
      '[{"name":"good_tool","source":"mcp"},{"bogus":true},{"name":"  "},"plain_tool"]',
    );

    const surface = compilePromptSurface({ externalTools });
    expect(surface.externalTools.map((external) => external.name)).toEqual(['good_tool', 'plain_tool']);
  });

  test('prompt surface hides unavailable executors from selectable runtimes', () => {
    const surface = compilePromptSurface({
      executors: [
        { name: 'workspace', available: true, configured: true, active: true, status: 'active' },
        { name: 'device', available: false, configured: true, active: false, status: 'disconnected' },
      ],
    });

    expect(surface.executors.map((exec) => exec.name)).toEqual(['device', 'workspace']);
    expect(surface.selectableExecutors.map((exec) => exec.name)).toEqual(['workspace']);
  });

  test('model profile blocks tool mode on known non-tool models', () => {
    expect(modelSupportsTools({ id: 'o4-mini' })).toBe(false);
    expect(modelSupportsTools({ id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b' })).toBe(false);
    expect(modelSupportsTools({ id: '@cf/moonshotai/kimi-k2.6' })).toBe(true);
    expect(() => assertToolsSupportedByModel({ id: 'o4-mini' }, ['shell']))
      .toThrow(/does not support tool calling/);
  });

  const MODEL_GUIDANCE = [
    { family: 'Kimi', id: '@cf/moonshotai/kimi-k2.6', says: ['Kimi models work best', 'tool/result context'] },
    { family: 'GPT and Codex models', id: 'codex/gpt-5.5', says: ['GPT/Codex-style', 'success criteria'] },
  ];

  for (const guidance of MODEL_GUIDANCE) {
    test(`adds model-specific guidance for ${guidance.family}`, () => {
      const { rt } = createTestRuntime();
      const prompt = buildSystemPromptSync(rt, { model: { id: guidance.id } });

      for (const phrase of guidance.says) expect(prompt).toContain(phrase);
    });
  }

  test('the live ledger carries both plan-submission variants', () => {
    const plan = renderDynamicContextBlock({ mode: { workMode: 'plan', planSubmission: true } });
    expect(plan).toContain('Mode: plan; submit_plan: available.');

    const delegatedPlan = renderDynamicContextBlock({ mode: { workMode: 'plan', planSubmission: false } });
    expect(delegatedPlan).toContain('Mode: plan; submit_plan: unavailable.');
    expect(delegatedPlan).not.toContain('investigate and report');
  });

  test('a background-job wake reaches the resume guidance even though it also carries a work mode', () => {
    // jobs/runner.ts stamps both kinuEvent and kinuMode on a wake; the mode must not mask the resume guidance.
    const wake = { kinuEvent: 'background_job', kinuMode: 'build' };
    expect(turnProvenanceForMetadata(wake)).toBe('background_resume');
    expect(workModeForTurnMetadata(wake)).toBe('build');

    const { rt } = createTestRuntime();

    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
    });

    expect(prompt).not.toContain('the referenced job result first');
    expect(present(turnLocalContextMessage({ provenance: turnProvenanceForMetadata(wake) }), 'the wake turn-local message').content)
      .toContain('the referenced job result first');

    const planWake = { kinuEvent: 'background_job', kinuMode: 'plan' };
    const planPrompt = renderDynamicContextBlock({ mode: { workMode: workModeForTurnMetadata(planWake), planSubmission: false } });
    expect(planPrompt).toContain('Mode: plan;');
    expect(prompt).toContain('In Plan, inspect and research only.');
    expect(present(turnLocalContextMessage({ provenance: turnProvenanceForMetadata(planWake) }), 'the Plan wake turn-local message').content)
      .toContain('the referenced job result first');
  });

  test('the two axes are read from different metadata keys and neither can suppress the other', () => {
    expect(turnProvenanceForMetadata({ kinuEvent: 'event_drain' })).toBe('chat');
    expect(turnProvenanceForMetadata(null)).toBe('chat');
    expect(turnProvenanceForMetadata({})).toBe('chat');
    expect(turnProvenanceForMetadata({ kinuEvent: 'timer_cron' })).toBe('chat');

    expect(workModeForTurnMetadata({ kinuMode: 'plan' })).toBe('plan');
    expect(workModeForTurnMetadata({ kinuMode: 'build' })).toBe('build');
    expect(workModeForTurnMetadata({ kinuMode: 'invalid' })).toBe('build');
    expect(workModeForTurnMetadata(null)).toBe('build');
  });

  test('the Build value belongs to the ledger, not the static prefix', () => {
    const { rt } = createTestRuntime();
    const base = { backend: 'cf' as const, model: { id: 'x' }, currentDate: '2026-01-01' };
    expect(renderDynamicContextBlock({ mode: { workMode: 'build', planSubmission: false } }))
      .toContain('Mode: build; submit_plan: unavailable.');
    expect(buildSystemPromptSync(rt, base)).not.toContain('Turn mode');
  });

  test('a resolved role renders exactly once in its own prompt section', () => {
    const { rt } = createTestRuntime();

    for (const [id, role] of Object.entries(BUILTIN_ROLE_DEFINITIONS)) {
      const prompt = buildSystemPromptSync(rt, {
        roleSection: {
          id,
          label: deriveRoleLabel(id),
          instructions: role.instructions,
        },
      });

      expect(prompt).toContain(`## Role: ${deriveRoleLabel(id)} (${id})`);
      expect(prompt.split(role.instructions)).toHaveLength(2);
    }
  });

  test('every built-in role states what it owns, what it never does, what it hands back, and what it does when blocked', () => {
    const sections = ['### Owns', '### Never', '### Hands back', '### When blocked'] as const;
    const { rt } = createTestRuntime();

    for (const [id, role] of Object.entries(BUILTIN_ROLE_DEFINITIONS)) {
      const prompt = buildSystemPromptSync(rt, {
        roleSection: { id, label: deriveRoleLabel(id), instructions: role.instructions },
      });

      const start = prompt.indexOf(`## Role: ${deriveRoleLabel(id)} (${id})`);
      const end = prompt.indexOf('\n## ', start + 1);
      const section = prompt.slice(start, end);

      const positions = sections.map((heading) => ({
        heading,
        first: section.indexOf(`\n${heading}\n`),
        last: section.lastIndexOf(`\n${heading}\n`),
      }));

      expect({ id, missing: positions.filter((p) => p.first < 0).map((p) => p.heading) })
        .toEqual({ id, missing: [] });
      expect({ id, repeated: positions.filter((p) => p.first !== p.last).map((p) => p.heading) })
        .toEqual({ id, repeated: [] });
      const order = positions.map((p) => p.first);
      expect({ id, ordered: order.every((at, i) => i === 0 || at > order[i - 1]) })
        .toEqual({ id, ordered: true });

      for (const body of section.split(/\n### [^\n]+\n/).slice(1)) {
        expect({ id, body: body.trim().slice(0, 2) }).toEqual({ id, body: '- ' });
      }
    }
  });

  test('root and child provider requests carry static Plan policy and live reach without widening execution', async () => {
    const { rt, testSql } = createTestRuntime();
    initWorkspaceSchema({
      sql: testSql.sql, execRaw: testSql.execRaw, exec: makeSqlExec(testSql.db), transactionSync: (write) => rt.storage.transactionSync(write),
    });
    const actors = createTestActors(testSql.sql, testSql.execRaw);
    const catalog = { roles: {}, tiers: { default: { model: 'test' } } };

    const runRolePhases = async (
      subject: typeof rt,
      roleId: string,
      stores: ReturnType<typeof createAgentStores>,
    ): Promise<void> => {
      const ledger = new DynamicContextLedger();
      const history: ModelMessage[] = [];
      let previousSystem: string | undefined;

      for (const phase of roleId === 'task' ? [0, 1, 2] : [0, 1]) {
        const mode = phase === 2 ? 'build' : 'plan';
        const path = `/mode-${subject.actor.name}-${roleId}-${phase}.txt`;
        await subject.storage.vfs.writeFile(path, 'original');
        const file = buildBuiltinTools({ rt: subject, history: storesFor(subject).history }).file;

        if (!file) throw new Error('missing file tool');
        const tools: ToolSet = { file };

        if (phase === 0) tools.submit_plan = permitInPlan(tool({
          description: 'Submit the plan for review', inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'submitted',
        }));

        const profile = resolveTurnProfile({
          envelope: { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog },
          provider: { revision: '1', availableModels: ['test'] }, roleId, workMode: mode,
          availableTools: Object.keys(tools), activeSkills: [],
        });

        const system = buildSystemPromptSync(subject, { availableTools: ['file'], roleSection: profile.role });

        if (previousSystem !== undefined) expect(system).toBe(previousSystem);
        previousSystem = system;
        let calls = 0;

        const model = scriptedTurnModel({ doGenerate: (): ScriptedTurnResult => {
          const step = calls++;

          return {
            content: step < 2
              ? [{ type: 'tool-call', toolName: 'file', toolCallId: `file-${phase}-${step}`,
                input: JSON.stringify(step === 0 ? { action: 'read', path } : { action: 'write', path, content: 'changed' }) }]
              : [{ type: 'text', text: 'done' }],
            finishReason: { unified: step < 2 ? 'tool-calls' : 'stop', raw: undefined },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
          };
        } });

        history.push({ role: 'user', content: 'Try the requested file operation.' });
        const callableTools = toolsInWorkMode(profile.workMode, tools);

        for await (const event of runChat({ model, system, history, tools: callableTools,
          dynamicContext: { ledger, snapshot: () => collectDynamicContext({ rt: subject, stores, profile, tools: callableTools, memoryTail: undefined, missingCapabilities: [] }) },
        })) {
          if (event.type === 'done') history.push(...event.responseMessages);
        }

        expect(model.doStreamCalls).toHaveLength(3);
        const request = model.doStreamCalls[0];
        const instructions = request?.prompt.find((message) => message.role === 'system');

        expect(instructions?.content).toContain('In Plan, inspect and research only.');
        expect(instructions?.content).toContain('Implementation waits for an approved Build turn.');
        const facts = request?.prompt.filter((message) => message.role === 'user').at(-1);
        expect(JSON.stringify(facts)).toContain(`Mode: ${mode}; submit_plan: ${phase === 0 ? 'available' : 'unavailable'}.`);
        expect(JSON.stringify(facts)).not.toContain('Do not change project files');
        expect(await subject.storage.vfs.readFile(path), JSON.stringify(model.doStreamCalls[2]?.prompt.filter((message) => message.role === 'tool')))
          .toBe(mode === 'build' ? 'changed' : 'original');
      }
    };

    try {
      for (const actor of [actors.main, actors.sibling('child')]) {
        const subject = { ...rt, actor };

        const stores = createAgentStores(() => testSql.sql, () => actor,
          <T>(write: () => T) => rt.storage.transactionSync(write),
          async () => ({ vfs: rt.storage.vfs, artifactDirectory: '/actor/.kinu/context' }));

        for (const roleId of Object.keys(BUILTIN_ROLE_DEFINITIONS)) {
          await runRolePhases(subject, roleId, stores);
        }
      }
    } finally {
      testSql.close();
    }
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
    expect(prompt).not.toContain('when the backend supports them');
    expect(prompt).toContain('The runtime automatically compacts your context window as it approaches its limit');
    expect(prompt).toContain('Work each task through to completion');
  });

  test('per-section char budgets stay pinned (additions must be deliberate)', () => {
    // Raise a ceiling only alongside an intentional content change.
    const BUDGETS = {
      'Runtime context': 160,
      'Operating guidance': 878,
      'Tools available this turn': 1100,
      'Execution environments': 3555,
      'Persistence': 700,
      'Code execution and learned capabilities': 830,
      'Delegation': 580,
      'Background work': 680,
      'Verification': 620,
      'Output format': 180,
    } satisfies Record<string, number>;

    const { rt } = createTestRuntime();

    const options = {
      backend: 'cf',
      registeredExecutors: ['workspace', 'nimbus', 'sandbox', 'device'],
      currentDate: '2026-06-11',
      model: { id: 'anthropic/claude-sonnet-4.5' },
    } satisfies SystemPromptOptions;

    const problems = (prompt: string): string[] => {
      const sections = new Map(splitPromptSections(prompt).map((section) => [section.title, section.chars]));

      return Object.entries(BUDGETS).flatMap(([title, budget]) => {
        const size = sections.get(title);

        if (size === undefined) return [`section "${title}" missing from the prompt`];

        return size > budget ? [`section "${title}" is ${size} chars — over its ${budget}-char budget`] : [];
      });
    };

    expect(problems(buildSystemPromptSync(rt, options))).toEqual([]);

    const grown = buildSystemPromptSync(rt, { ...options,
      sectionOverrides: { 'guidance/operating': OPERATING_GUIDANCE.source + '\nX' },
    });

    expect(problems(grown)).toEqual(['section "Operating guidance" is 880 chars — over its 878-char budget']);
  });

  test('does NOT promise unimplemented or redundant strategies', () => {
    const { rt } = createTestRuntime();
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).not.toMatch(/\bmcts\b/);
    expect(buildSystemPromptSync(rt)).not.toMatch(/\bmcts\b/);
    expect(BUILTIN_TOOL_DESCRIPTIONS.agents).not.toMatch(/single-shot/);
    expect(buildSystemPromptSync(rt)).not.toMatch(/single-shot/);
  });

  test('the index renders identically for BOTH a Kimi and a non-Kimi agent', () => {
    const { rt } = createTestRuntime();

    for (const id of ['@cf/moonshotai/kimi-k2.6', 'anthropic/claude-sonnet-4.5']) {
      const prompt = buildSystemPromptSync(rt, { model: { id } });
      expect(prompt).toMatch(/## Delegation/);
      expect(prompt).toMatch(/Helper agents are one tool: `agents`/);
      expect(prompt).toMatch(/`swarm` runs parallel nodes over this workspace/);
      expect(prompt).toMatch(/`hire` creates a persistent subordinate in this workspace/);
    }
  });
});
