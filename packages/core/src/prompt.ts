/**
 * Canonical system-prompt builder. Both CF and CLI surfaces call this so the
 * model sees one backend-agnostic Kinu contract, with backend/model/mode
 * details layered in only when they are actually true for the current turn.
 *
 * The prose is not here. Every section's wording lives in
 * `prompting/section-templates.ts` as an addressable template; this file decides
 * which branch each section takes and what its slots are worth. That split is
 * what makes a section evolvable (`evolution/gepa/section-bridge.ts`) without
 * making the branch conditions evolvable with it.
 */
import type { AgentRuntime } from './types/agent-runtime';
import {
  BUILTIN_TOOL_SPECS,
  type BuiltinToolName,
} from './tools/registry';
import { renderActiveSkillsSection, renderSkillsIndexSection } from './skills/render';
import type { ActiveSkillSet, ParsedSkill } from './skills/types';
import {
  compilePromptSurface,
  executorIsSelectable,
  type PromptBackend,
  type PromptExecutorInfo,
  type PromptExternalToolInfo,
  type PromptSurface,
  type PromptSurfaceOptions,
} from './prompting/surface';
import { DEFAULT_SOUL_MD } from './identity/soul';
import { renderAgentsMdSection, type AgentsMdFile } from './prompting/agents-md';
import {
  BACKGROUND_WORK_SECTION,
  BUILTIN_TOOL_LINE,
  CODE_EXECUTION_SECTION,
  DELEGATION_SECTION,
  EXECUTORS_SECTION,
  EXTERNAL_TOOL_LINE,
  GENERIC_EXECUTOR_LINE,
  LAPTOP_EXECUTOR_LINE,
  OFFLINE_LAPTOP_LINE,
  OPERATING_GUIDANCE,
  ROLE_SECTION,
  OUTPUT_FORMAT_SECTION,
  PERSISTENCE_SECTION,
  SANDBOX_EXECUTOR_LINE,
  TOOLS_SECTION,
  VERIFICATION_SECTION,
  WORKSPACE_EXECUTOR_LINE,
  sectionRenderer,
  type PromptSectionOverrides,
  type RenderSection,
} from './prompting/section-templates';
import { WORKSPACE_ROOT } from './vfs/workspace-path';
import { PLATFORM_CATALOG } from './platform-catalog';

export type {
  PromptBackend,
  PromptExecutorInfo,
  PromptExternalToolInfo,
  TurnProvenance,
  WorkMode,
} from './prompting/surface';
export type {
  PromptModelCapability,
  PromptModelContext,
  PromptModelFamily,
  PromptModelProfile,
} from './prompting/model-profile';

export interface SystemPromptOptions extends PromptSurfaceOptions {
  /** Override the SOUL.md lookup. Tests and head runtimes use this for isolated prompt construction. */
  soulOverride?: string;
  /** Every available skill (built-ins + VFS) — renders as an ambient
   *  name+description index every turn, resolved by the backend from
   *  resolveTurnSkills. */
  availableSkills?: ReadonlyArray<ParsedSkill>;
  /** Active skills for this turn, resolved by the backend at turn start. */
  activeSkills?: ActiveSkillSet;
  /** Optional working directory hint for local/cloud execution surfaces. */
  cwd?: string;
  /** Discovered AGENTS.md files, ordered root-most first, nearest last.
   *  CLI: walk-up from cwd; CF: agent VFS root + active sandbox workspace. */
  agentsMd?: ReadonlyArray<AgentsMdFile>;
  /** Date-only string (YYYY-MM-DD, see currentDateForPrompt). Date-only is
   *  byte-stable for a full day, so prompt cache prefixes survive the turn. */
  currentDate?: string;
  /** Promoted replacements for named prompt sections, read by the backend from
   *  `prompting/section-store.ts` once per activation. Passed in rather than
   *  read here for the same reason `soulOverride` is: this builder is the
   *  byte-stable cacheable prefix and does no I/O. Absent — the default, and
   *  what the layergate prefix digest is locked against — renders every section
   *  from its built-in source. */
  sectionOverrides?: PromptSectionOverrides;
}

/** The canonical `currentDate` value: date-only, never time. Both backends
 *  pass this so cron wakes, agent.schedule, and dated facts reason from the
 *  real date without busting the prompt-cache prefix within a day. */
export function currentDateForPrompt(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export const FALLBACK_PURPOSE = DEFAULT_SOUL_MD;

// No `- Turn mode:` line. It announced a mode the guidance below already names
// wherever it constrains anything, and for the default (`build`, shown to the
// user as Auto) it announced a mode with no branch at all — a 19-byte
// insertion ~350 bytes into the CACHEABLE prefix that split the prompt cache
// between a chat turn and an identical Auto turn for no behavioural gain.
//
// Not a template: this is four key-value pairs over runtime facts, none of
// which is prose anybody would rewrite.
function renderRuntimeContext(opts: SystemPromptOptions): string {
  const lines: string[] = [];
  if (opts.backend) lines.push(`- Backend: ${opts.backend}`);
  if (opts.model?.id) lines.push(`- Model: ${opts.model.provider ? `${opts.model.provider}/` : ''}${opts.model.id}`);
  if (opts.cwd) lines.push(`- Working directory: ${opts.cwd}`);
  if (opts.currentDate) lines.push(`- Current date: ${opts.currentDate}`);
  return lines.length ? `## Runtime context\n${lines.join('\n')}` : '';
}

function renderOperatingGuidance(surface: PromptSurface, render: RenderSection): string {
  const family = surface.model.family;
  return render(OPERATING_GUIDANCE, {
    kimi: family === 'kimi',
    gpt: family === 'gpt',
    backgroundResume: surface.provenance === 'background_resume',
    planMode: surface.workMode === 'plan',
    planSubmission: surface.planSubmissionAvailable,
  });
}

/** The ONE Role section, from the resolved turn profile. Nothing else in the
 *  prompt or the tool docs repeats role prose — the section is the single
 *  place a role's instructions reach the model. */
function renderRoleSection(surface: PromptSurface, render: RenderSection): string {
  if (!surface.roleSection || surface.roleSection.instructions.trim() === '') return '';
  return render(ROLE_SECTION, {
    id: surface.roleSection.id,
    label: surface.roleSection.label,
    instructions: surface.roleSection.instructions.trim(),
  }).trim();
}

function renderBuiltinToolLine(name: BuiltinToolName, render: RenderSection): string {
  const spec = BUILTIN_TOOL_SPECS[name];
  // No `summary`: it is line 1 of this tool's own schema description, which
  // rides the same request (BUILTIN_TOOL_LINE says why). The index renders the
  // name and the one real call, which nothing else carries.
  return render(BUILTIN_TOOL_LINE, { name, example: spec.example });
}

function renderExternalToolLine(tool: PromptExternalToolInfo, render: RenderSection): string {
  const source = tool.source === 'mcp' ? 'MCP' : tool.source ?? 'external';
  const description = tool.description ? ` — ${tool.description}` : '';
  return render(EXTERNAL_TOOL_LINE, { name: tool.name, source, description });
}

function renderToolsSection(surface: PromptSurface, render: RenderSection): string {
  return render(TOOLS_SECTION, {
    builtins: surface.builtinTools.length === 0
      ? '(none)'
      : surface.builtinTools.map((name) => renderBuiltinToolLine(name, render)).join('\n'),
    hasExternal: surface.externalTools.length > 0,
    externalLines: surface.externalTools.map((tool) => renderExternalToolLine(tool, render)).join('\n'),
  });
}

/** The number the workspace sentence tells the model, from `worker.isolate.memory`.
 *  Derived rather than typed: this used to read "~128 MB" as prose, which is the
 *  drift the catalog exists to stop. */
const WORKSPACE_MEMORY_MB = PLATFORM_CATALOG['worker.isolate.memory'].limit.value / (1000 * 1000);

/** How the device row names the machine. The user's own name for it when they
 *  gave one; otherwise the neutral phrase, because a row that says "laptop"
 *  names an API namespace and not a computer anyone owns. */
function deviceDisplayName(exec: PromptExecutorInfo): string {
  return exec.label?.trim() || "your user's PC";
}

/** Which namespace's prose a selectable executor gets. The switch is here rather
 *  than in the template because the arms are four different sections, not four
 *  values of one. */
function renderExecutorLine(
  exec: PromptExecutorInfo,
  render: RenderSection,
  backend?: PromptBackend,
): string {
  const cliLocal = backend === 'cli-local';
  switch (exec.name) {
      case 'workspace':
        return render(WORKSPACE_EXECUTOR_LINE, { cliLocal, memoryMb: String(WORKSPACE_MEMORY_MB) });
      case 'sandbox':
        return render(SANDBOX_EXECUTOR_LINE, {});
      case 'laptop':
        return render(LAPTOP_EXECUTOR_LINE, {
          cliLocal,
          deviceName: deviceDisplayName(exec),
          granted: exec.granted === true,
        });
      default:
        return render(GENERIC_EXECUTOR_LINE, { name: exec.name });
  }
}

function offlineLaptop(executors: readonly PromptExecutorInfo[]): PromptExecutorInfo | undefined {
  return executors.find((exec) =>
    exec.name === 'laptop' && exec.configured === true && !executorIsSelectable(exec));
}

function renderExecutorSection(surface: PromptSurface, render: RenderSection): string {
  const tools = surface.builtinTools;
  if (!hasTool(tools, 'execute_tools') && !hasTool(tools, 'run')) return '';

  const executors = surface.selectableExecutors;
  const laptopOffline = offlineLaptop(surface.executors);
  if (executors.length === 0 && !laptopOffline) return '';

  const workspace = executors.find((exec) => exec.name === 'workspace');
  const devices = executors.filter((exec) => exec.name !== 'workspace');
  const lines = [
    ...devices.map((exec) => renderExecutorLine(exec, render, surface.backend)),
    ...(laptopOffline ? [render(OFFLINE_LAPTOP_LINE, { deviceName: deviceDisplayName(laptopOffline) })] : []),
    ...(workspace ? [renderExecutorLine(workspace, render, surface.backend)] : []),
  ];
  const previewExecutors = executors.filter((exec) => exec.capabilities?.includes('net_inbound'));

  return render(EXECUTORS_SECTION, {
    executorLines: lines.join('\n'),
    workspaceRoot: WORKSPACE_ROOT,
    hasDevices: devices.length > 0,
    deviceNamespaces: devices.map((exec) => `\`${exec.name}.*\``).join(', '),
    hasPreview: previewExecutors.length > 0,
    exposeCalls: previewExecutors.map((exec) => `${exec.name}.exposePort(port)`).join(' or '),
  });
}

function hasTool(tools: readonly BuiltinToolName[], name: BuiltinToolName): boolean {
  return tools.includes(name);
}

function renderAgentStateSection(surface: PromptSurface, render: RenderSection): string {
  const tools = surface.builtinTools;
  const parts: string[] = [render(PERSISTENCE_SECTION, {})];

  if (hasTool(tools, 'execute_tools')) {
    parts.push(render(CODE_EXECUTION_SECTION, { rlmAvailable: surface.rlmAvailable }));
  }

  if (hasTool(tools, 'agents') || hasTool(tools, 'report')) {
    // The rungs gate on the actions this actor's deps actually wire
    // (surface.agentsActions), exactly like the tool's enum.
    const actions = surface.agentsActions;
    const has = (action: (typeof actions)[number]) => actions.includes(action);
    parts.push(render(DELEGATION_SECTION, {
      hasActions: actions.length > 0,
      rlmAvailable: surface.rlmAvailable,
      hasSwarm: has('swarm'),
      hasHire: has('hire'),
      // Both backends build the `agents.*` codemode provider from the deps that
      // produced surface.agentsActions, so the namespace exists exactly when
      // they do and execute_tools is on the surface.
      rungsInCode: actions.length > 0 && hasTool(tools, 'execute_tools'),
      hasReport: hasTool(tools, 'report'),
    }));
  }

  if (hasTool(tools, 'run') || hasTool(tools, 'execute_tools') || hasTool(tools, 'agents')) {
    parts.push(render(BACKGROUND_WORK_SECTION, {}));
  }

  parts.push(render(VERIFICATION_SECTION, {
    hasShell: hasTool(tools, 'run') || hasTool(tools, 'execute_tools'),
  }));
  parts.push(render(OUTPUT_FORMAT_SECTION, {}));

  return parts.join('\n\n');
}

/**
 * The soul this prompt speaks with.
 *
 * Passed in, never read here: the soul is a FILE now, and this builder is the
 * byte-stable cacheable prefix — synchronous by contract, and no place to do
 * I/O. Callers that hold a runtime read it once and hand it over (the cf actor
 * caches it per activation); a caller that does not gets the default.
 */
function readSoulForPrompt(override?: string): string {
  return override?.trim() || FALLBACK_PURPOSE;
}

/** Skill BODIES belong in the stable prefix (an activation-set change is a
 *  deliberate cache bust), but the per-turn activation REASONS do not — the
 *  same active set must render byte-identically regardless of which keyword
 *  matched. Reasons render in the volatile turn context instead. Activation
 *  precedence order is PRESERVED here: the renderer spends its char budget in
 *  that order (earlier-activated skills are never crowded out by a later
 *  giant one) while pinning the rendered block order by name for byte
 *  equality. */
function stableActiveSkills(activeSkills: ActiveSkillSet): ActiveSkillSet {
  return { active: activeSkills.active, reasons: [] };
}

/**
 * Synchronous because every consumer is: CF's Think.getSystemPrompt returns a
 * string synchronously and the runtime's sql executor is synchronous.
 */
export function buildSystemPromptSync(
  rt: AgentRuntime,
  opts: SystemPromptOptions = {},
): string {
  const surface = compilePromptSurface(opts);
  const render = sectionRenderer(opts.sectionOverrides);
  return [
    // Identity, then the hard rules, then the doctrine that bounds every tool
    // call — in that order, at the front, where the model reads them first.
    readSoulForPrompt(opts.soulOverride),
    renderRoleSection(surface, render),
    renderOperatingGuidance(surface, render),
    // Execution doctrine BEFORE the tool index: it is the constraint on every
    // call the index then lists, and a rule read after the menu is a rule
    // applied late. OpenAI's own ordering for a developer message is Identity
    // → Instructions → Examples → Context
    // (developers.openai.com/api/docs/guides/prompt-engineering, § Message
    // formatting with Markdown and XML); the index is the Examples block (one
    // real call per tool), so it follows the instructions rather than leading
    // them.
    renderExecutorSection(surface, render),
    renderToolsSection(surface, render),
    renderAgentStateSection(surface, render),
    opts.agentsMd?.length ? renderAgentsMdSection(opts.agentsMd) : '',
    opts.availableSkills?.length ? renderSkillsIndexSection(opts.availableSkills).trim() : '',
    opts.activeSkills ? renderActiveSkillsSection(stableActiveSkills(opts.activeSkills)).trim() : '',
    // LAST, and this is the placement that matters most for cost. These four
    // key-value pairs are the only VOLATILE bytes in an otherwise stable
    // prefix: `Current date` turns over daily, `Model` per turn profile, `cwd`
    // per session. Rendered third, as it was, a date rollover invalidated
    // every byte after position ~350 — about 11.5 KB of prefix on a full cloud
    // surface — because prefix caching matches a common PREFIX and stops at
    // the first difference. Rendered last it invalidates only itself. Same
    // reasoning the Turn-mode line was deleted for (see the note above
    // `renderRuntimeContext`), applied to the section that note did not cover,
    // and the same advice OpenAI gives directly: "keep content that you expect
    // to use over and over in your API requests at the beginning of your
    // prompt" and put Context "near the end".
    renderRuntimeContext(opts),
  ].filter(Boolean).join('\n\n');
}
