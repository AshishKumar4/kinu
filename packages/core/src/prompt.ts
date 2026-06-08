/**
 * Canonical system-prompt builder. Both CF and CLI surfaces call this so the
 * model sees one backend-agnostic Proteus contract, with backend/model/mode
 * details layered in only when they are actually true for the current turn.
 */

import type { AgentRuntime } from './types/agent-runtime.js';
import {
  BUILTIN_TOOL_SPECS,
  type BuiltinToolName,
} from './tools/registry.js';
import { renderActiveSkillsSection } from './skills/render.js';
import type { ActiveSkillSet } from './skills/types.js';
import {
  compilePromptSurface,
  type PromptExecutorInfo,
  type PromptExternalToolInfo,
  type PromptSurface,
  type PromptSurfaceOptions,
} from './prompting/surface.js';

export type {
  PromptBackend,
  PromptExecutorInfo,
  PromptExternalToolInfo,
  PromptMode,
} from './prompting/surface.js';
export type {
  PromptModelCapability,
  PromptModelContext,
  PromptModelFamily,
  PromptModelProfile,
} from './prompting/model-profile.js';

export interface SystemPromptOptions extends PromptSurfaceOptions {
  /** Extra knowledge to append — CLI pastes a bounded memory/MEMORY.md tail. */
  extraKnowledge?: string;
  /** Override the soul/purpose lookup. If omitted, reads from agent_soul. */
  purposeOverride?: string;
  /** Active skills for this turn, resolved by the backend at turn start. */
  activeSkills?: ActiveSkillSet;
  /** Optional working directory hint for local/cloud execution surfaces. */
  cwd?: string;
  /** Optional date string. Kept opt-in so prompt cache prefixes remain stable. */
  currentDate?: string;
}

export interface SystemPromptParts {
  stable: string;
  context: string;
  volatile: string;
}

export const FALLBACK_PURPOSE = 'You are Proteus, a self-evolving agent runtime. ' +
  'You help the user by reading real context, using available tools, coordinating parallel heads when useful, ' +
  'saving durable facts and memory, and improving your reusable capabilities over time.';

function renderRuntimeContext(opts: SystemPromptOptions): string {
  const lines: string[] = [];
  if (opts.backend) lines.push(`- Backend: ${opts.backend}`);
  if (opts.mode && opts.mode !== 'chat') lines.push(`- Turn mode: ${opts.mode}`);
  if (opts.model?.id) lines.push(`- Model: ${opts.model.provider ? `${opts.model.provider}/` : ''}${opts.model.id}`);
  if (opts.cwd) lines.push(`- Working directory: ${opts.cwd}`);
  if (opts.currentDate) lines.push(`- Current date: ${opts.currentDate}`);
  return lines.length ? `## Runtime context\n${lines.join('\n')}` : '';
}

function renderOperatingGuidance(surface: PromptSurface): string {
  const mode = surface.mode;
  const family = surface.model.family;
  const lines = [
    '- Treat ambiguous "do this" requests as work to perform, not as invitations to only describe a plan.',
    '- Inspect current code, state, logs, or tool results before making claims about them.',
    '- Keep changes scoped to the user request and the existing architecture.',
    '- Verify meaningful changes with the narrowest reliable checks available, then report what passed or failed.',
    '- If a required fact is unavailable, say exactly what is missing and stop rather than inventing it.',
  ];

  if (family === 'kimi') {
    lines.push(
      '- Kimi K2.6 works best when tool use is concrete and continuous: preserve tool/result context, continue from observations, and avoid re-planning after every tool result.',
      '- For long-horizon coding, write down durable decisions with fact/memory instead of relying on hidden reasoning.',
    );
  } else if (family === 'gpt') {
    lines.push(
      '- GPT/Codex-style reasoning models do best with direct success criteria: state assumptions briefly, use tools for current facts, and keep final answers outcome-focused.',
      '- Prefer schema-backed outputs for machine-readable tasks; do not rely on prose-only JSON instructions when a schema/tool is available.',
    );
  }

  if (mode === 'plan') {
    lines.push('- Planning mode: do not edit, deploy, or mutate state. Produce a concrete plan with affected files and verification.');
  } else if (mode === 'product_change') {
    lines.push('- Product-change mode: use product_change to track plan, checks, preview, owner approval, deployment, and rollback metadata.');
    lines.push('- Never deploy Proteus product changes without an explicit approval record.');
  } else if (mode === 'cron') {
    lines.push('- Scheduled wake mode: identify why you were woken, do only the scheduled work, persist any durable outcome, then stop.');
  } else if (mode === 'background_resume') {
    lines.push('- Background-resume mode: fetch the referenced job result first, synthesize it, then continue or close the original work.');
  }

  return `## Operating guidance\n${lines.join('\n')}`;
}

function renderBuiltinToolLine(name: BuiltinToolName): string {
  const spec = BUILTIN_TOOL_SPECS[name];
  return [
    `- **${name}** — ${spec.summary}`,
    `  Use: ${spec.whenToUse}`,
    `  Avoid: ${spec.whenNotToUse}`,
  ].join('\n');
}

function renderExternalToolLine(tool: PromptExternalToolInfo): string {
  const source = tool.source === 'mcp' ? 'MCP' : tool.source ?? 'external';
  const description = tool.description ? ` — ${tool.description}` : '';
  return `- **${tool.name}** (${source})${description}`;
}

function renderToolsSection(surface: PromptSurface): string {
  const builtins = surface.builtinTools.length === 0
    ? '(none)'
    : surface.builtinTools.map(renderBuiltinToolLine).join('\n');
  const external = surface.externalTools.length === 0
    ? ''
    : [
        '',
        '### External tools',
        'These tools are exposed by connected external providers for this turn. Use them when their names/descriptions match the task.',
        surface.externalTools.map(renderExternalToolLine).join('\n'),
      ].join('\n');
  return [
    '## Tools available this turn',
    'Only call tools listed here or present in the model tool schema for this turn. If a tool/runtime is absent, do not assume it exists.',
    '',
    '### Built-in tools',
    builtins,
    external,
  ].join('\n');
}

function executorAvailabilityLabel(exec: PromptExecutorInfo): string {
  if (exec.name === 'laptop') return exec.active || exec.status === 'active' ? 'connected' : 'available';
  if (exec.active || exec.status === 'active') return 'active';
  if (exec.status === 'idle' || exec.configured) return 'ready on demand';
  return 'available';
}

function renderExecutorLine(exec: PromptExecutorInfo): string {
  const suffix = ` (${executorAvailabilityLabel(exec)})`;
  switch (exec.name) {
      case 'workspace':
        return '- **workspace.*** / `runtime: "workspace"`: internal Proteus state VFS and lightweight shell. Use it for durable notes, small generated files, and crafted-tool state; do not treat it as the user\'s PC or a full Linux sandbox.';
      case 'nimbus':
        return `- **nimbus.*** / \`runtime: "nimbus"\`${suffix}: lightweight cloud Linux workspace for quick commands, scripts, package installs, and file work.`;
      case 'sandbox':
        return `- **sandbox.*** / \`runtime: "sandbox"\`${suffix}: full Linux sandbox for heavier installs, longer-running processes, and user-visible port-listening apps.`;
      case 'laptop':
        return `- **laptop.*** / \`runtime: "laptop"\`${suffix}: the user's connected local machine through the Proteus device tunnel. Use it when the task targets local files, local commands, or the user's desktop environment.`;
      default:
        return `- **${exec.name}.***${suffix}: available executor namespace.`;
  }
}

function renderExecutorSection(executors: readonly PromptExecutorInfo[], tools: readonly BuiltinToolName[]): string {
  if (!hasTool(tools, 'execute_tools') && !hasTool(tools, 'run')) return '';

  if (executors.length === 0) return '';

  const workspace = executors.find((exec) => exec.name === 'workspace');
  const devices = executors.filter((exec) => exec.name !== 'workspace');
  const lines = [...devices, ...(workspace ? [workspace] : [])].map(renderExecutorLine);

  const parts = [
    '## Execution environments',
    'Only the environments listed here are selectable in this turn. If a namespace is absent, do not mention it, call it, or assume it can be used.',
    'Choose the runtime that matches the task; keep reads/writes in the same runtime unless you intentionally copy data between runtimes.',
    '',
    ...lines,
  ];
  if (executors.length > 1) {
    parts.push('', 'These runtimes have separate filesystems. Use the same runtime to read back files you wrote.');
  }
  if (devices.length > 1) {
    parts.push('When more than one execution device is available, decide explicitly: laptop for the user machine, Nimbus for quick cloud execution, Sandbox for heavyweight/server work.');
  }
  if (devices.some((exec) => exec.name === 'sandbox')) {
    parts.push(
      '',
      '### Showing a running app',
      'For a user-visible web app, write files in the sandbox, start a server bound to 0.0.0.0 in the background, wait for it to bind, then call sandbox.exposePort(port). If exposePort fails, inspect the server log and retry after the server is actually listening.',
    );
  }
  return parts.join('\n');
}

function hasTool(tools: readonly BuiltinToolName[], name: BuiltinToolName): boolean {
  return tools.includes(name);
}

function renderAgentStateSection(tools: readonly BuiltinToolName[]): string {
  const parts: string[] = [];

  parts.push([
    '## Persistence',
    'You are NOT stateless between turns. Conversation history, durable memory, keyed facts, crafted tools, scaffold versions, background jobs, and event triggers persist in storage when the backend supports them.',
  ].join('\n'));

  if (hasTool(tools, 'memory') || hasTool(tools, 'fact')) {
    parts.push([
      '## Memory and facts',
      '- Use `fact` for keyed state the agent should recall by name: user preferences, project state, URLs, configuration, dates, and decisions.',
      '- Use `memory` for longer prose notes or lessons that are useful across turns.',
      '- Prefer updating stale facts over adding contradictory new ones.',
    ].join('\n'));
  }

  if (hasTool(tools, 'execute_tools')) {
    parts.push([
      '## Code execution and learned capabilities',
      '- `execute_tools` runs JavaScript against the active executor/codemode namespaces.',
      '- Crafted tools saved in the CraftStore become callable as `codemode.<name>(args)` / `tools.<name>(args)` when injected.',
      '- `llm.query(text, { model?, reasoning_effort? })` is available inside execute_tools for one-level decomposition over large inputs; handle either a string result or `{ error }`.',
      '- `agent.schedule({ cron | atMs, label?, payload? })` can create a future autonomous wake; use it only when the user or task genuinely calls for recurrence or a reminder.',
      '- `agent.jobResult(jobId)` and `agent.backgroundJobs(limit?)` read durable background work status and results.',
    ].join('\n'));
  }

  if (hasTool(tools, 'think')) {
    parts.push([
      '## Parallel sub-agents',
      '`think({ strategy: "heads", task, heads })` spawns 2-6 INDEPENDENT heads that run concurrently, each with its own multi-step loop and a bounded recursive split depth of 3.',
      '`think({ strategy: "mcts", task })` runs parallel tree-search rollouts over candidate approaches.',
      'Use parallel heads only when work splits into genuinely independent subproblems. Avoid concurrent writes to the same mutable resource.',
    ].join('\n'));
  }

  if (hasTool(tools, 'run') || hasTool(tools, 'execute_tools') || hasTool(tools, 'think')) {
    parts.push([
      '## Background work',
      'Long `think`, `execute_tools`, or `run` calls may detach after the background threshold and return `{ background: true, jobId }`. When that happens, stop the turn; the backend will wake you when the job settles.',
    ].join('\n'));
  }

  if (hasTool(tools, 'product_change')) {
    parts.push([
      '## Proteus product changes',
      'When the user asks Proteus to modify its own app, route the work through `product_change`: bind source, record the plan, run checks, create a preview, request approval, deploy only after approval, and keep rollback metadata.',
    ].join('\n'));
  }

  parts.push([
    '## Output format',
    'Final replies are plain markdown. Keep user-visible reasoning concise, name important files/checks, and do not dump raw JSON unless asked.',
  ].join('\n'));

  return parts.join('\n\n');
}

function renderKnowledgeSection(extraKnowledge?: string): string {
  const text = extraKnowledge?.trim();
  return text ? `## Knowledge\n${text}` : '';
}

function readPurpose(rt: AgentRuntime, override?: string): string {
  if (override) return override;
  try {
    const rows = rt.storage.sql<{ purpose: string }>`SELECT purpose FROM agent_soul LIMIT 1`;
    return rows[0]?.purpose ?? FALLBACK_PURPOSE;
  } catch {
    return FALLBACK_PURPOSE;
  }
}

export function buildSystemPromptPartsSync(
  rt: AgentRuntime,
  opts: SystemPromptOptions = {},
): SystemPromptParts {
  const surface = compilePromptSurface(opts);
  const stable = [
    readPurpose(rt, opts.purposeOverride),
    renderRuntimeContext(opts),
    renderOperatingGuidance(surface),
    renderToolsSection(surface),
    renderExecutorSection(surface.selectableExecutors, surface.builtinTools),
    renderAgentStateSection(surface.builtinTools),
  ].filter(Boolean).join('\n\n');

  const context = opts.activeSkills ? renderActiveSkillsSection(opts.activeSkills).trim() : '';
  const volatile = renderKnowledgeSection(opts.extraKnowledge);

  return { stable, context, volatile };
}

/**
 * Synchronous form. CF's Think.getSystemPrompt returns string synchronously
 * and this runtime's sql executor is also synchronous.
 */
export function buildSystemPromptSync(
  rt: AgentRuntime,
  opts: SystemPromptOptions = {},
): string {
  const parts = buildSystemPromptPartsSync(rt, opts);
  return [parts.stable, parts.context, parts.volatile].filter(Boolean).join('\n\n');
}

/** Async wrapper for symmetry with other core builders. */
export async function buildSystemPrompt(
  rt: AgentRuntime,
  opts: SystemPromptOptions = {},
): Promise<string> {
  return buildSystemPromptSync(rt, opts);
}
