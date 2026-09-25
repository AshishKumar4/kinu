import {
  AGENTS_TOOL_ACTIONS,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_NAMES,
  type AgentsToolAction,
  type BuiltinToolName,
} from '../tools/registry';
import { isMcpToolKey } from '../tools/mcp-naming';
import type { ExecutorInfo } from '../execution/types';
import {
  resolvePromptModelProfile,
  type PromptModelContext,
  type PromptModelProfile,
} from './model-profile';
import * as v from 'valibot';
import type { TurnReason, WorkMode } from '../types/turn';
import type { JsonObject } from '../utils/json';

export type PromptBackend = 'cf' | 'cli-local' | 'cli-cloud';

const TurnMetadataSchema = v.object({
  kinuMode: v.optional(v.unknown()),
  kinuEvent: v.optional(v.unknown()),
});

const KinuEventSchema = v.object({ kinuEvent: v.pipe(v.string(), v.nonEmpty()) });

/** A background job's wake (jobs/runner.ts). */
const JobWakeSchema = v.object({ jobId: v.string(), kind: v.string(), status: v.string() });

const ExternalToolSchema = v.object({
  name: v.string(),
  source: v.optional(v.picklist(['mcp', 'crafted', 'external'])),
  description: v.optional(v.string()),
});


/** From `kinuEvent` metadata alone: the `kinuMode` stamped beside it (never null for jobs) must not win. */
export function turnReasonForMetadata(metadata: JsonObject | null | undefined): TurnReason {
  const stamped = v.safeParse(KinuEventSchema, metadata);

  if (!stamped.success) return { provenance: 'chat' };

  if (stamped.output.kinuEvent !== 'background_job') return { provenance: 'signal', event: stamped.output.kinuEvent };
  const job = v.safeParse(JobWakeSchema, metadata);

  return { provenance: 'background_resume', job: job.success ? `job ${job.output.jobId}, ${job.output.kind}, ${job.output.status}` : null };
}

/** Only an explicit, recognized `kinuMode` raises the Plan bar; delegated children inherit it. */
export function workModeForTurnMetadata(metadata: JsonObject | null | undefined): WorkMode {
  const parsed = v.safeParse(TurnMetadataSchema, metadata);

  if (!parsed.success) return 'build';

  return parsed.output.kinuMode === 'plan' ? 'plan' : 'build';
}

/** The router's ExecutorInfo, loosened: the prompt also builds rows from bare names. */
export type PromptExecutorInfo =
  & Partial<Pick<ExecutorInfo, 'kind' | 'capabilities' | 'available' | 'configured' | 'active'>>
  & Omit<ExecutorInfo, 'kind' | 'capabilities' | 'available' | 'configured' | 'active' | 'status'>
  & { status?: string };

export interface PromptExternalToolInfo {
  name: string;
  source?: 'mcp' | 'crafted' | 'external';
  description?: string;
}

/**
 * Titles, never slugs: a slug is an address (URL, DO name, directory).
 * Either may be absent: a workspace is untitled until its first prompt, and a
 * workspace's own chat has no subagent name.
 */
export interface PromptIdentity {
  readonly workspace?: string | null;
  readonly agent?: string | null;
}

type ResolvedPromptIdentity = {
  readonly [Name in keyof PromptIdentity]-?: string | null;
};

export interface PromptSurfaceOptions {
  registeredExecutors?: string[];
  executors?: readonly PromptExecutorInfo[];
  availableTools?: readonly BuiltinToolName[];
  /** Wired `agents` actions (see agentsActionsFor). Defaults to all when the `agents` tool is on, else none. */
  agentsActions?: readonly AgentsToolAction[];
  /** Whether `ask` can target a role (temporary rung); gates decomposition guidance so it is never advertised where refused. */
  temporaryAsk?: boolean;
  externalTools?: readonly (PromptExternalToolInfo | string)[];
  backend?: PromptBackend;
  /** Absent renders nothing. */
  roleSection?: { id: string; label: string; instructions: string };
  identity?: PromptIdentity;
  model?: PromptModelContext;
}

export interface PromptSurface {
  builtinTools: BuiltinToolName[];
  agentsActions: AgentsToolAction[];
  temporaryAsk: boolean;
  externalTools: PromptExternalToolInfo[];
  executors: PromptExecutorInfo[];
  selectableExecutors: PromptExecutorInfo[];
  model: PromptModelProfile;
  backend?: PromptBackend;
  roleSection: { id: string; label: string; instructions: string } | null;
  identity: ResolvedPromptIdentity;
}

const EXECUTOR_PROMPT_ORDER = ['device', 'sandbox', 'workspace'];

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

function uniqueBuiltinTools(tools: readonly BuiltinToolName[] | undefined): BuiltinToolName[] {
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

  if (toolName.success) {
    const name = toolName.output.trim();

    if (!name || BUILTIN_TOOL_NAMES.has(name)) return null;

    return { name, source: isMcpToolKey(name) ? 'mcp' : 'external' };
  }

  const parsed = v.safeParse(ExternalToolSchema, tool);

  if (!parsed.success) return null;
  const raw = parsed.output;
  const name = raw.name.trim();

  if (!name || BUILTIN_TOOL_NAMES.has(name)) return null;

  const normalized: PromptExternalToolInfo = {
    name,
    source: raw.source ?? (isMcpToolKey(name) ? 'mcp' : 'external'),
  };

  if (raw.description) normalized.description = raw.description.trim();

  return normalized;
}

function uniqueExternalTools(tools: readonly (PromptExternalToolInfo | string)[] | undefined): PromptExternalToolInfo[] {
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
  const workspaceTitle = opts.identity?.workspace?.trim() ?? '';
  const agentTitle = opts.identity?.agent?.trim() ?? '';

  return {
    builtinTools,
    temporaryAsk: opts.temporaryAsk ?? false,
    agentsActions: uniqueAgentsActions(opts.agentsActions, builtinTools),
    externalTools: uniqueExternalTools(opts.externalTools),
    executors,
    selectableExecutors: executors.filter(executorIsSelectable),
    model: resolvePromptModelProfile(opts.model),
    roleSection: opts.roleSection ?? null,
    backend: opts.backend,
    // Compared against '' after trim, not `??`: a fresh workspace's title is '' until its first prompt.
    identity: {
      workspace: workspaceTitle === '' ? null : workspaceTitle,
      agent: agentTitle === '' ? null : agentTitle,
    },
  };
}
