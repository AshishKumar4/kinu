/**
 * Canonical system-prompt builder. Both CF and CLI surfaces call this so the
 * model sees one backend-agnostic Proteus contract, with backend/model/mode
 * details layered in only when they are actually true for the current turn.
 */

import type { AgentRuntime } from './types/agent-runtime.js';
import {
  BUILTIN_TOOL_SPECS,
  DELEGATION_RUNGS,
  type BuiltinToolName,
} from './tools/registry.js';
import { renderActiveSkillsSection } from './skills/render.js';
import type { ActiveSkillSet } from './skills/types.js';
import {
  compilePromptSurface,
  executorIsSelectable,
  type PromptBackend,
  type PromptExecutorInfo,
  type PromptExternalToolInfo,
  type PromptSurface,
  type PromptSurfaceOptions,
} from './prompting/surface.js';
import { DEFAULT_SOUL_MD, readSoul } from './identity/soul.js';
import { renderAgentsMdSection, type AgentsMdFile } from './prompting/agents-md.js';
import { EXECUTOR_MOUNT_PREFIX } from './vfs/composite.js';

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
  /** Override the SOUL.md lookup. Tests and head runtimes use this for isolated prompt construction. */
  soulOverride?: string;
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
}

/** The canonical `currentDate` value: date-only, never time. Both backends
 *  pass this so cron wakes, agent.schedule, and dated facts reason from the
 *  real date without busting the prompt-cache prefix within a day. */
export function currentDateForPrompt(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export const FALLBACK_PURPOSE = DEFAULT_SOUL_MD;

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

  if (hasTool(surface.builtinTools, 'agents')) {
    lines.push('- For multi-part or long-running work, pick a rung of the delegation ladder below instead of grinding through it inline.');
  }

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

// The when-to-use doctrine lives in the JSON-schema tool descriptions
// (registry.ts renderToolSchemaDescription) — the prompt only indexes names.
function renderBuiltinToolLine(name: BuiltinToolName): string {
  return `- **${name}** — ${BUILTIN_TOOL_SPECS[name].summary}`;
}

function renderExternalToolLine(tool: PromptExternalToolInfo): string {
  const source = tool.source === 'mcp' ? 'MCP' : tool.source ?? 'external';
  const description = tool.description ? ` — ${tool.description}` : '';
  return `- **${tool.name}** (${source})${description}`;
}

function renderToolsSection(surface: PromptSurface): string {
  // Single family gate (Moonshot guidance): kimi-family models self-select
  // tools best from the schema alone — prompt prose about tool usage
  // interferes — so they get a bare name index; other families keep one
  // summary line per tool.
  const bareIndex = surface.model.family === 'kimi';
  const builtins = surface.builtinTools.length === 0
    ? '(none)'
    : surface.builtinTools
        .map((name) => (bareIndex ? `- ${name}` : renderBuiltinToolLine(name)))
        .join('\n');
  const external = surface.externalTools.length === 0
    ? ''
    : [
        '',
        '### External tools',
        'These tools are exposed by connected external providers for this turn. Use them when their names/descriptions match the task.',
        surface.externalTools
          .map((tool) => (bareIndex ? `- ${tool.name}` : renderExternalToolLine(tool)))
          .join('\n'),
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

/** Doctrine only — live availability labels render in the per-turn volatile
 *  context message (prompting/volatile-context.ts), never in this cacheable
 *  prefix, so a sandbox waking up doesn't re-prefill the whole conversation. */
function renderExecutorLine(exec: PromptExecutorInfo, backend?: PromptBackend): string {
  switch (exec.name) {
      case 'workspace':
        return '- **workspace.*** / `runtime: "workspace"`: internal Proteus state VFS and lightweight shell. Use it for durable notes, small generated files, and crafted-tool state; do not treat it as the user\'s PC or a full Linux sandbox.';
      case 'nimbus':
        return '- **nimbus.*** / `runtime: "nimbus"`: lightweight cloud Linux workspace for quick commands, scripts, package installs, and file work.';
      case 'sandbox':
        return '- **sandbox.*** / `runtime: "sandbox"`: full Linux sandbox for heavier installs, longer-running processes, and user-visible port-listening apps.';
      case 'laptop':
        return backend === 'cli-local'
          ? '- **laptop.*** / `runtime: "laptop"`: the local machine the Proteus CLI is running on — direct access, no tunnel or consent prompt.'
          : "- **laptop.*** / `runtime: \"laptop\"`: the user's OWN PC, connected through the Proteus device tunnel. Use it when the task targets local files, local commands, or the user's desktop environment. Its first use asks the user for consent — that prompt is expected, not an error.";
      default:
        return `- **${exec.name}.***: available executor namespace.`;
  }
}

/** A registered-but-offline laptop is still listed (the user can bring it
 *  back), unlike other unavailable executors, which are omitted entirely. */
function renderOfflineLaptopLine(): string {
  return '- **laptop** / `runtime: "laptop"` (registered, currently OFFLINE): the user\'s own PC is registered but not connected right now. Do not call it; if the user wants it used, tell them to run `proteus connect` on their machine.';
}

function offlineLaptop(executors: readonly PromptExecutorInfo[]): PromptExecutorInfo | undefined {
  return executors.find((exec) =>
    exec.name === 'laptop' && exec.configured === true && !executorIsSelectable(exec));
}

function renderExecutorSection(surface: PromptSurface): string {
  const tools = surface.builtinTools;
  if (!hasTool(tools, 'execute_tools') && !hasTool(tools, 'run')) return '';

  const executors = surface.selectableExecutors;
  const laptopOffline = offlineLaptop(surface.executors);
  if (executors.length === 0 && !laptopOffline) return '';

  const workspace = executors.find((exec) => exec.name === 'workspace');
  const devices = executors.filter((exec) => exec.name !== 'workspace');
  const lines = [
    ...devices.map((exec) => renderExecutorLine(exec, surface.backend)),
    ...(laptopOffline ? [renderOfflineLaptopLine()] : []),
    ...(workspace ? [renderExecutorLine(workspace, surface.backend)] : []),
  ];

  const parts = [
    '## Execution environments',
    'Only the environments listed here are selectable in this turn. If a namespace is absent, do not mention it, call it, or assume it can be used.',
    'This list reflects live state at the start of THIS turn — trust it over assumptions or earlier turns; it can change when the user connects or disconnects a device.',
    'Choose the runtime that matches the task; keep reads/writes in the same runtime unless you intentionally copy data between runtimes.',
    '',
    ...lines,
  ];
  if (executors.length > 1) {
    parts.push('', 'These runtimes have separate filesystems. Use the same runtime to read back files you wrote.');
  }
  // Mount-table doctrine. Every backend's workspace VFS mounts the file plane
  // of the execution environments it actually has — /sandbox and /nimbus on cf,
  // /pc on both (the device tunnel there, node:fs here) — so the doctrine
  // follows the executor list rather than the backend.
  const mounts = devices.map((exec) => EXECUTOR_MOUNT_PREFIX[exec.name]).filter(Boolean);
  if (mounts.length > 0) {
    parts.push(
      '',
      `The workspace filesystem (workspace.* file ops) is a mount table: /local is the durable base, and ${mounts.join(', ')} ${mounts.length === 1 ? 'is a live window' : 'are live windows'} into those environments' real filesystems — the way to copy files ACROSS runtimes (readdir('/') lists what is mounted right now).`,
      'Mounts are the FILE plane only: command execution stays target-native — run commands via the environment\'s own namespace or the run tool, never against a mount path.',
    );
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

function renderAgentStateSection(surface: PromptSurface): string {
  const tools = surface.builtinTools;
  // llm.query gates on surface.rlmAvailable (wired by both backends); the
  // scaffold self-provider ships on both since the shared-spine parity.
  const parts: string[] = [];

  parts.push([
    '## Persistence',
    'You are NOT stateless between turns. Conversation history, durable memory, keyed facts, crafted tools, scaffold versions, background jobs, and event triggers persist in storage.',
    'Your context window is automatically compacted as it approaches its limit; do not stop or wrap up tasks early due to token-budget concerns. Save durable progress to facts/memory as you go.',
    'Your self-changes (crafted tools, learned facts, scaffold promotions) are recorded in an Evolution Changelog the user can review and revert line-by-line — evolve freely and report honestly; nothing you change about yourself is hidden or permanent.',
  ].join('\n'));

  if (hasTool(tools, 'memory') || hasTool(tools, 'fact')) {
    parts.push([
      '## Memory and facts',
      '- Use `fact` for keyed state the agent should recall by name: user preferences, project state, URLs, configuration, dates, and decisions.',
      '- Use `memory` for longer prose notes or lessons that are useful across turns.',
      '- Use `memory` action="sessions" to search your past session transcripts before re-deriving prior context.',
      '- Your failures are recorded as lessons in memory — search before retrying similar work.',
      '- Prefer updating stale facts over adding contradictory new ones.',
    ].join('\n'));
  }

  if (hasTool(tools, 'execute_tools')) {
    parts.push([
      '## Code execution and learned capabilities',
      '- `execute_tools` runs JavaScript against the active executor/codemode namespaces.',
      '- Before building from scratch, check `workspace.listTools()` and `memory` search for existing tools and prior lessons.',
      '- When you have built a reusable routine, save it with `workspace.createTool` — saved tools become callable as `codemode.<name>(args)` / `tools.<name>(args)` on your next execute_tools call.',
      ...(surface.rlmAvailable ? ['- `llm.query(text, { model?, reasoning_effort? })` is available inside execute_tools for one-level decomposition over large inputs: read the file, slice it, `llm.query` each slice (cheap at low reasoning_effort), aggregate in code. Handle either a string result or `{ error }`. For slices that themselves need decomposition, fork (`agents` action=fork) — forks run full tool loops with llm.query in scope.'] : []),
      '- `agent.proposeCurriculum(count?)` proposes self-improvement tasks; `agent.listCurriculum(status?)` / `agent.acceptCurriculumTask(id)` manage them.',
      '- `agent.proposeScaffold(rationale, code, baseVersion?)` proposes a new version of your own agentic-loop scaffold; it must pass the validation gates and win shadow evaluation before going live. `agent.scaffoldVersions(limit?)` lists your scaffold archive (lineage + shadow record) — you may branch from any archived version via `baseVersion`.',
      '- `agent.schedule({ cron | atMs, label?, payload? })` can create a future autonomous wake; use it only when the user or task genuinely calls for recurrence or a reminder.',
      '- `agent.jobResult(jobId)` and `agent.backgroundJobs(limit?)` read durable background work status and results.',
      '- `agent.compactNow()` folds the conversation at a phase boundary instead of waiting for the token trigger: the finished range is archived verbatim and stays listed in the checkpoint\'s Compaction Archive manifest, so you can still read it back.',
    ].join('\n'));
  }

  if (hasTool(tools, 'agents') || hasTool(tools, 'report')) {
    // ONE ladder, keyed on lifetime, behind ONE tool — the only axis the
    // model has to decide on. Both rung triggers render from the registry's
    // DELEGATION_RUNGS (single source); the frame, the fork artifact trail
    // and the coordination loop are the prompt-only operational doctrine no
    // tool schema can carry. Rungs gate on the actions this actor's deps
    // actually wire (surface.agentsActions), exactly like the tool's enum.
    const actions = surface.agentsActions;
    const has = (action: (typeof actions)[number]) => actions.includes(action);
    const lines = ['## Delegation'];
    if (actions.length > 0) {
      lines.push(
        'Delegation is one tool — `agents` — and one question: how long does the helper need to live? Do not grind multi-part work through inline — pick a rung.'
        // The zeroth rung is not an agent at all: flat map-reduce sub-calls.
        // Weight-ordered, it sits between doing it yourself and forking, and
        // it renders only where the llm provider is actually wired.
        + (surface.rlmAvailable
          ? ' The cheapest helper is not an agent: for bulk text that needs no tools, slice it and `llm.query` each slice inside execute_tools — reach for the ladder only when the work needs tool loops.'
          : ''),
        // The turn-cumulative clamp is mechanical, so say so: a model that
        // knows WHY the ninth heavy read came back short reaches for a rung
        // instead of re-running the command (context-budget.ts).
        'Tool output is budgeted per turn, not just per call: the first heavy reads come back whole, and once a turn has pulled in a lot of output the rest arrive as a head plus a workspace path — read that as the signal to hand the bulk to a helper instead of pulling more of it into this turn.',
        '- Do it yourself — a single short coherent change.',
      );
    }
    if (has('fork')) {
      lines.push(`- Ephemeral fork — ${DELEGATION_RUNGS.fork}`);
    }
    if (has('staff')) {
      lines.push(`- Persistent subordinate — ${DELEGATION_RUNGS.staff}`);
    }
    if (has('fork')) {
      lines.push('Forks recurse up to split depth 3 and leave durable findings under `shared/findings/` — read them after the merge for detail beyond the summary. For live information, loop web_search then web_fetch.');
    }
    // The rungs are also a codemode namespace, so a multi-step plan is code
    // rather than a tool-call-at-a-time grind. Gated on the same actions the
    // tool exposes: both backends build the `agents.*` provider from the deps
    // that produced surface.agentsActions, so it exists exactly when they do.
    if (actions.length > 0 && hasTool(tools, 'execute_tools')) {
      lines.push(
        'The same rungs are callable inside execute_tools as `agents.<action>`, so a multi-step plan can be one script — loop, branch, Promise.all — and `workspace.createTool` saves it as a reusable, schedulable workflow. A fork started there rides that call, which does not resume after an eviction.',
      );
    }
    if (has('staff')) {
      lines.push(
        'Run the coordination loop: staff the needed roles → ask each an independent workstream → integrate their reports as they arrive as events that wake you. A finished subordinate stays in your roster with its context — re-engage it with ask/send; dismiss only when its role is permanently over.',
        "Subordinates share this workspace's files and sandbox.",
      );
    }
    if (has('reply')) {
      lines.push("The same ask/send reach the owner's OTHER workspace agents by name (a peer ask waits for the reply, send does not); staff scope=workspace creates a specialist workspace; reply answers an agent message event via its event_id.");
    }
    if (hasTool(tools, 'report')) {
      lines.push('You are a subordinate agent of this workspace: the workspace is your world, the orchestrator assigns your work, and `report` sends it progress/completed/blocked updates at meaningful milestones. Your turn-end answer to an assigned task is relayed automatically.');
    }
    parts.push(lines.join('\n'));
  }

  if (hasTool(tools, 'run') || hasTool(tools, 'execute_tools') || hasTool(tools, 'agents')) {
    parts.push([
      '## Background work',
      'Long fork, `execute_tools`, or `run` calls may detach after the background threshold and return `{ background: true, jobId }`. When that happens, stop the turn; the backend will wake you when the job settles.',
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

function readSoulForPrompt(rt: AgentRuntime, override?: string): string {
  if (override) return override;
  return readSoul(rt.storage.sql) ?? FALLBACK_PURPOSE;
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
  return [
    readSoulForPrompt(rt, opts.soulOverride),
    renderRuntimeContext(opts),
    renderOperatingGuidance(surface),
    renderToolsSection(surface),
    renderExecutorSection(surface),
    renderAgentStateSection(surface),
    opts.agentsMd?.length ? renderAgentsMdSection(opts.agentsMd) : '',
    opts.activeSkills ? renderActiveSkillsSection(stableActiveSkills(opts.activeSkills)).trim() : '',
  ].filter(Boolean).join('\n\n');
}
