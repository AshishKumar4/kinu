import {
  AGENTS_TOOL_ACTIONS,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_NAMES,
  type AgentsToolAction,
  type BuiltinToolName,
} from '../tools/registry.js';
import { isMcpToolKey } from '../tools/mcp-naming.js';
import type { ExecutorLifecycleStatus, ResourceLimits } from '../execution/types.js';
import {
  resolvePromptModelProfile,
  type PromptModelContext,
  type PromptModelProfile,
} from './model-profile.js';
import * as v from 'valibot';

export type PromptBackend = 'cf' | 'cli-local' | 'cli-cloud';
export type WorkMode = 'plan' | 'build';
export type PromptMode = 'chat' | WorkMode | 'background_resume' | 'release' | 'cron';

const WorkModeSchema = v.picklist(['plan', 'build']);
const TurnMetadataSchema = v.object({
  proteusMode: v.optional(v.unknown()),
  proteusEvent: v.optional(v.unknown()),
});
const ExternalToolSchema = v.object({
  name: v.string(),
  source: v.optional(v.picklist(['mcp', 'crafted', 'external'])),
  description: v.optional(v.string()),
});

export function isWorkMode<Value>(value: Value): value is Value & WorkMode {
  return v.is(WorkModeSchema, value);
}

/** Delegated work is either part of a read-only Plan turn or ordinary Build
 * work. Autonomous/chat overlays do not weaken the child: only an explicit
 * Plan parent propagates the mutation bar. */
export function workModeForPromptMode(mode: PromptMode): WorkMode {
  return mode === 'plan' ? 'plan' : 'build';
}

/**
 * The turn's prompt mode from the `proteusEvent` metadata a programmatic turn
 * carries (BackendHost.enqueueTurn stamps it; a real chat turn carries none).
 *
 * Shared by BOTH backends: the guidance that tells the agent it was woken by a
 * timer, or resumed to collect a background job's result, has to reach the
 * model identically whether the turn ran in a Durable Object or a local
 * process.
 */
export function promptModeForTurnEvent(proteusEvent: string | null | undefined): PromptMode {
  const event = proteusEvent ?? '';
  if (event === 'background_job') return 'background_resume';
  if (event.includes('timer') || event.includes('cron')) return 'cron';
  return 'chat';
}

/** Explicit user-selected Plan/Build mode wins over event provenance. Unknown
 * values are ignored so old or foreign clients cannot suppress the established
 * background/cron overlays. */
export function promptModeForTurnMetadata<Metadata>(metadata: Metadata): PromptMode {
  const parsed = v.safeParse(TurnMetadataSchema, metadata);
  if (!parsed.success) return 'chat';
  if (isWorkMode(parsed.output.proteusMode)) return parsed.output.proteusMode;
  const event = v.safeParse(v.string(), parsed.output.proteusEvent);
  return promptModeForTurnEvent(event.success ? event.output : null);
}

export interface PromptExecutorInfo {
  name: string;
  kind?: string;
  capabilities?: readonly string[];
  available?: boolean;
  configured?: boolean;
  active?: boolean;
  status?: ExecutorLifecycleStatus | string;
  reason?: string;
  /** Measured limits of the environment this executor's processes run in,
   *  when its environment declares any. Rendered as a live status suffix. */
  resourceLimits?: ResourceLimits;
}

export interface PromptExternalToolInfo {
  name: string;
  source?: 'mcp' | 'crafted' | 'external';
  description?: string;
}

export interface PromptSurfaceOptions {
  registeredExecutors?: string[];
  executors?: readonly PromptExecutorInfo[];
  availableTools?: readonly BuiltinToolName[];
  /** Which `agents` actions this actor's deps actually wire (see
   *  agentsActionsFor). Defaults to ALL actions when the `agents` tool is on
   *  the surface — the representative full surface — and to none otherwise. */
  agentsActions?: readonly AgentsToolAction[];
  /** Whether the llm.query (RLM) codemode provider is wired for this actor —
   *  cf always; cli only when a model resolver exists. Gates the prompt's
   *  decomposition guidance so it is never advertised where it would throw. */
  rlmAvailable?: boolean;
  externalTools?: readonly (PromptExternalToolInfo | string)[];
  backend?: PromptBackend;
  mode?: PromptMode;
  /** Whether this Plan actor owns the submit_plan completion boundary. Heads
   * and subordinates report research back to their parent instead. */
  planSubmissionAvailable?: boolean;
  model?: PromptModelContext;
}

export interface PromptSurface {
  builtinTools: BuiltinToolName[];
  agentsActions: AgentsToolAction[];
  rlmAvailable: boolean;
  externalTools: PromptExternalToolInfo[];
  executors: PromptExecutorInfo[];
  selectableExecutors: PromptExecutorInfo[];
  model: PromptModelProfile;
  backend?: PromptBackend;
  mode: PromptMode;
  planSubmissionAvailable: boolean;
}

const EXECUTOR_PROMPT_ORDER = ['laptop', 'sandbox', 'workspace'];

function executorSortKey(name: string): number {
  const idx = EXECUTOR_PROMPT_ORDER.indexOf(name);
  return idx === -1 ? 99 : idx;
}

function sortExecutors(executors: PromptExecutorInfo[]): PromptExecutorInfo[] {
  return executors.sort((a, b) =>
    executorSortKey(a.name) - executorSortKey(b.name) || a.name.localeCompare(b.name));
}

function uniqueExecutors(names: readonly string[] = []): PromptExecutorInfo[] {
  const out = new Map<string, PromptExecutorInfo>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    out.set(name, {
      name,
      available: true,
      configured: true,
      active: true,
      status: 'active',
    });
  }
  return sortExecutors([...out.values()]);
}

export function uniquePromptExecutors(opts: Pick<PromptSurfaceOptions, 'executors' | 'registeredExecutors'>): PromptExecutorInfo[] {
  const source = opts.executors ?? uniqueExecutors(opts.registeredExecutors);
  const out = new Map<string, PromptExecutorInfo>();
  for (const exec of source) {
    const name = exec.name.trim();
    if (!name) continue;
    out.set(name, { ...exec, name });
  }
  return sortExecutors([...out.values()]);
}

export function executorIsSelectable(exec: PromptExecutorInfo): boolean {
  if (exec.name === 'workspace') return exec.available !== false;
  if (exec.available === false) return false;
  if (exec.status === 'not_configured' || exec.status === 'disconnected' || exec.status === 'error') return false;
  return exec.available === true || exec.configured === true || exec.active === true;
}

export function uniqueBuiltinTools(tools: readonly BuiltinToolName[] | undefined): BuiltinToolName[] {
  const source = tools ?? BUILTIN_TOOLS;
  const out: BuiltinToolName[] = [];
  const seen = new Set<string>();
  for (const toolName of source) {
    if (!BUILTIN_TOOL_NAMES.has(toolName) || seen.has(toolName)) continue;
    seen.add(toolName);
    out.push(toolName);
  }
  return out;
}

function normalizeExternalTool(tool: PromptExternalToolInfo | string): PromptExternalToolInfo | null {
  const toolName = v.safeParse(v.string(), tool);
  const raw = toolName.success ? { name: toolName.output } : v.parse(ExternalToolSchema, tool);
  const name = raw.name.trim();
  if (!name || BUILTIN_TOOL_NAMES.has(name)) return null;
  const normalized: PromptExternalToolInfo = {
    name,
    source: raw.source ?? (isMcpToolKey(name) ? 'mcp' : 'external'),
  };
  if (raw.description) normalized.description = raw.description.trim();
  return normalized;
}

export function uniqueExternalTools(tools: readonly (PromptExternalToolInfo | string)[] | undefined): PromptExternalToolInfo[] {
  const out = new Map<string, PromptExternalToolInfo>();
  for (const raw of tools ?? []) {
    const tool = normalizeExternalTool(raw);
    if (tool) out.set(tool.name, tool);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function uniqueAgentsActions(
  actions: readonly AgentsToolAction[] | undefined,
  builtinTools: readonly BuiltinToolName[],
): AgentsToolAction[] {
  if (!builtinTools.includes('agents')) return [];
  const source = actions ?? AGENTS_TOOL_ACTIONS;
  return AGENTS_TOOL_ACTIONS.filter((action) => source.includes(action));
}

export function compilePromptSurface(opts: PromptSurfaceOptions): PromptSurface {
  const executors = uniquePromptExecutors(opts);
  const builtinTools = uniqueBuiltinTools(opts.availableTools);
  return {
    builtinTools,
    agentsActions: uniqueAgentsActions(opts.agentsActions, builtinTools),
    rlmAvailable: opts.rlmAvailable ?? false,
    externalTools: uniqueExternalTools(opts.externalTools),
    executors,
    selectableExecutors: executors.filter(executorIsSelectable),
    model: resolvePromptModelProfile(opts.model),
    backend: opts.backend,
    mode: opts.mode ?? 'chat',
    planSubmissionAvailable: opts.planSubmissionAvailable ?? false,
  };
}
