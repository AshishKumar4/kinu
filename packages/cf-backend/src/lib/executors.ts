/**
 * The canonical executor metadata module — the ONE place that names, orders,
 * and describes environments for the user surfaces.
 *
 * Capability doctrine (what runs where, in the provider's own ids) is
 * model-facing and lives in core's execution-status block; the user surfaces
 * describe environments in user terms only.
 */

/** Live executor row as reported by the orchestrator's getExecutors RPC. */
export interface ExecutorInfo {
  name: string;
  kind: string;
  capabilities: string[];
  /** Capabilities the environment could not answer for either way. Part of
   *  the wire payload; consumed by the agent's own execution-status block. */
  unmeasuredCapabilities?: string[];
  /** The user's own display name for the environment, where one exists —
   *  a registered device's chosen name on the laptop row. */
  label?: string;
  available: boolean;
  configured?: boolean;
  active?: boolean;
  status?: "not_configured" | "idle" | "active" | "disconnected" | "error";
  reason?: string;
}

/**
 * The human name beside each namespace. Not a copy of the namespace — `laptop.*`
 * has always read "Your PC" — because the namespace is the API and this is what
 * the environment IS.
 *
 * `workspace` is the agent's filesystem and its Nimbus shell, the durable one,
 * so "Agent state" would undersell it into looking like a debug pane.
 */
export const EXECUTOR_LABELS = {
  laptop:    "Your PC",
  sandbox:   "Sandbox",
  workspace: "Workspace",
  // Forks only: the workspace this one branched from, reached over DO RPC.
  parent:    "Parent workspace",
};

export function executorLabel(name: string): string {
  return Object.entries(EXECUTOR_LABELS).find(([key]) => key === name)?.[1] ?? name;
}

/**
 * What each environment IS, in one user-facing line — the card description on
 * the Environment tab. What it can RUN is the agent's business (the
 * execution-status block); what the user needs is what lives there and what
 * happens to files they put in it.
 */
export const EXECUTOR_DESCRIPTIONS = {
  workspace: "The agent's own files and shell — everything it makes lives here.",
  sandbox: "A full Linux container for builds, servers and heavy work, with live previews.",
  laptop: "Your own machine over the device tunnel — commands and files run there with your consent.",
  parent: "The workspace this fork branched from, reached read-mostly over RPC.",
};

/** The description beside a row's namespace, with the fallback the tab shows
 *  for an environment this build predates. Same contract as executorLabel. */
export function executorDescription(name: string): string {
  return Object.entries(EXECUTOR_DESCRIPTIONS).find(([key]) => key === name)?.[1]
    ?? "An execution environment with its own filesystem.";
}

export const EXECUTOR_ORDER = ["laptop", "sandbox", "workspace", "parent"];

export function executorSortKey(name: string): number {
  const idx = EXECUTOR_ORDER.indexOf(name);
  return idx === -1 ? 99 : idx;
}

export function isExecutorActive(exec: ExecutorInfo): boolean {
  return exec.active === true || exec.status === "active";
}

/** Devices worth offering as an explicit target (diff selector): the user's
 *  PC whenever it is connected, remote runtimes only once actually active,
 *  and never the workspace itself (callers append it deliberately — it is
 *  always there, so listing it beside the reachable ones says nothing). */
export function isActiveExecutionDevice(exec: ExecutorInfo): boolean {
  if (exec.name === "workspace" || !exec.available) return false;
  if (exec.name === "laptop") return true;
  return isExecutorActive(exec);
}

/**
 * Choose the executor the file-manager / diff should default to. Prefers where
 * the agent last actually worked (sticky, from agent_config.last_active_executor)
 * when that executor is still available; otherwise a static priority that favors
 * a real shell, falling back to the always-present VFS.
 */
export interface ExecutorAvailability {
  name: string;
  available: boolean;
  active?: boolean;
  status?: "not_configured" | "idle" | "active" | "disconnected" | "error";
}

/**
 * What the release lane can actually do here. The release engine executes in
 * the agent's sandbox container (core/src/release/engine.ts adapts its raw
 * handle), so the sandbox row IS the substrate verdict: absent or unavailable
 * means changes can be drafted and approved and never applied, checked,
 * previewed or deployed. `unknown` while the executor list has not loaded —
 * the surface says nothing rather than guessing either way. An available
 * sandbox may still carry a note (previews off until PREVIEW_HOST_SUFFIX is
 * set); the note rides the executor's own status reason.
 */
export type ReleaseSubstrate =
  | { state: "unknown" }
  | { state: "unavailable"; reason: string }
  | { state: "ready"; note: string | null };

export function releaseSubstrate(executors: ExecutorInfo[]): ReleaseSubstrate {
  if (executors.length === 0) return { state: "unknown" };
  const sandbox = executors.find((e) => e.name === "sandbox");
  if (!sandbox?.available) {
    return { state: "unavailable", reason: sandbox?.reason ?? "the sandbox executor is unavailable on this deployment" };
  }
  return { state: "ready", note: sandbox.reason ?? null };
}

const STATIC_PRIORITY = ["laptop", "sandbox"];

export function pickDefaultExecutor(executors: ExecutorAvailability[], lastActive?: string | null): string {
  const isActive = (name: string) => executors.some((e) =>
    e.name === name && e.available && (e.active || e.status === "active"));
  if (lastActive && isActive(lastActive)) return lastActive;
  for (const name of STATIC_PRIORITY) {
    if (isActive(name)) return name;
  }
  return "workspace";
}

