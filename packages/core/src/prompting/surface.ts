import {
  AGENTS_TOOL_ACTIONS,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_NAMES,
  type AgentsToolAction,
  type BuiltinToolName,
} from '../tools/registry';
import { isMcpToolKey } from '../tools/mcp-naming';
import type { ExecutorLifecycleStatus, ResourceLimits } from '../execution/types';
import type { DeviceSandboxStatus } from '../execution/device-status';
import {
  resolvePromptModelProfile,
  type PromptModelContext,
  type PromptModelProfile,
} from './model-profile';
import * as v from 'valibot';

export type PromptBackend = 'cf' | 'cli-local' | 'cli-cloud';

// ── The axes of a turn ──────────────────────────────────────────────────────
// These are independent facts, and forcing them through one variable is what
// made two of them unreachable. A background-job wake IS a resume AND it IS
// build work; a Plan turn woken by a timer is BOTH. So:
//
//   WorkMode      — what the turn may do. 'plan' is read-only and structural;
//                   'build' is the absence of constraint, shown as "Auto".
//   TurnProvenance— why the turn is running. Adds an overlay, never a bar.
//   Role          — the resolved profile's one prompt section (prompt.ts).

export type WorkMode = 'plan' | 'build';

/**
 * Why this turn is running. Orthogonal to WorkMode.
 *
 * Two values, because two are all that exist. `cron` and `release` were here
 * and neither had a producer: a timer fire is published as an EVENT
 * (`ingress: 'timer_alarm'`, events/ingress/triggers.ts) and reaches the agent
 * through the reactor drain as `kinuEvent: 'event_drain'`, never under a
 * timer- or cron-named event; and nothing anywhere stamps a release mode. The
 * guidance written for both of them had therefore never reached a model.
 */
export type TurnProvenance = 'chat' | 'background_resume';

const WorkModeSchema = v.picklist(['plan', 'build']);
const TurnMetadataSchema = v.object({
  kinuMode: v.optional(v.unknown()),
  kinuEvent: v.optional(v.unknown()),
});
const ExternalToolSchema = v.object({
  name: v.string(),
  source: v.optional(v.picklist(['mcp', 'crafted', 'external'])),
  description: v.optional(v.string()),
});

export function isWorkMode<Value>(value: Value): value is Value & WorkMode {
  return v.is(WorkModeSchema, value);
}

/**
 * Why the turn is running, from the `kinuEvent` metadata a programmatic
 * turn carries (BackendHost.enqueueTurn stamps it; a chat turn carries none).
 *
 * Read from the EVENT alone. The work mode stamped beside it answers a
 * different question, and letting that win here is what hid every wake:
 * jobs/runner.ts stamps `kinuEvent: 'background_job'` AND
 * `kinuMode: job.workMode` on the same message, and `work_mode` is never
 * null, so the resume overlay could not render in production.
 *
 * Shared by BOTH backends: the guidance that tells the agent to collect a
 * background job's result rather than start the work again has to reach the
 * model identically in a Durable Object and in a local process.
 */
export function turnProvenanceForMetadata<Metadata>(metadata: Metadata): TurnProvenance {
  const parsed = v.safeParse(TurnMetadataSchema, metadata);
  if (!parsed.success) return 'chat';
  return parsed.output.kinuEvent === 'background_job' ? 'background_resume' : 'chat';
}

/** What the turn may do. Only an explicit, recognized `kinuMode` can raise
 *  the Plan bar; everything else is ordinary unconstrained work. Delegated
 *  children inherit this same value, so a Plan parent propagates its bar and
 *  an autonomous wake never weakens one. */
export function workModeForTurnMetadata<Metadata>(metadata: Metadata): WorkMode {
  const parsed = v.safeParse(TurnMetadataSchema, metadata);
  if (!parsed.success) return 'build';
  return parsed.output.kinuMode === 'plan' ? 'plan' : 'build';
}

export interface PromptExecutorInfo {
  name: string;
  kind?: string;
  capabilities?: readonly string[];
  /** Capabilities the environment can neither claim nor rule out. Rendered
   *  separately from the declared set: a model that reads an omission as an
   *  absence never tries the one thing the machine may have been attached for. */
  unmeasuredCapabilities?: readonly string[];
  available?: boolean;
  configured?: boolean;
  active?: boolean;
  status?: ExecutorLifecycleStatus | string;
  reason?: string;
  /** Measured limits of the environment this executor's processes run in,
   *  when its environment declares any. Rendered as a live status suffix. */
  resourceLimits?: ResourceLimits;
  /** The machine's own user-chosen name, when the environment has one. */
  label?: string;
  /** Whether this agent holds the environment's access grant already — what
   *  tells the model whether its first call runs or raises a consent card. */
  granted?: boolean;
  /** How the machine behind this row runs a command, when it is a device with
   *  a Sandbox switch: the owner's setting, what the machine proved, this
   *  workspace's own home on it, and the directories it may write. */
  sandbox?: DeviceSandboxStatus;
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
  /** Whether this actor's `ask` can target a ROLE — the temporary rung, wired
   *  wherever a backend has a child substrate. Gates the prompt's
   *  decomposition guidance so a rung is never advertised where the action
   *  would refuse it. */
  temporaryAsk?: boolean;
  externalTools?: readonly (PromptExternalToolInfo | string)[];
  backend?: PromptBackend;
  /** What the turn may do. Defaults to `build` — Auto, the absence of
   *  constraint — which renders no guidance at all. */
  workMode?: WorkMode;
  /** Why the turn is running. Defaults to `chat`, which renders nothing. */
  provenance?: TurnProvenance;
  /** The one Role section this turn renders, from the resolved turn profile.
   *  Absent renders nothing — an actor resolved without a profile authority
   *  keeps its plain surface. */
  roleSection?: { id: string; label: string; instructions: string };
  /** Whether this Plan actor owns the submit_plan completion boundary. A
   * delegated turn reports to its parent; an owner chat can own an independent
   * review even when the actor is an additional agent. */
  planSubmissionAvailable?: boolean;
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
  workMode: WorkMode;
  provenance: TurnProvenance;
  planSubmissionAvailable: boolean;
  roleSection: { id: string; label: string; instructions: string } | null;
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
    temporaryAsk: opts.temporaryAsk ?? false,
    agentsActions: uniqueAgentsActions(opts.agentsActions, builtinTools),
    externalTools: uniqueExternalTools(opts.externalTools),
    executors,
    selectableExecutors: executors.filter(executorIsSelectable),
    model: resolvePromptModelProfile(opts.model),
    roleSection: opts.roleSection ?? null,
    backend: opts.backend,
    workMode: opts.workMode ?? 'build',
    provenance: opts.provenance ?? 'chat',
    planSubmissionAvailable: opts.planSubmissionAvailable ?? false,
  };
}
