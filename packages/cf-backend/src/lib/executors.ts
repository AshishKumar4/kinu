/**
 * The canonical executor metadata module — the ONE place that names, orders,
 * and filters execution devices. Every surface that renders an executor
 * (Environment mounts, Output diff chips, terminals) reads labels/order from
 * here so the vocabulary never drifts across tabs.
 */

/** Live executor row as reported by the orchestrator's getExecutors RPC. */
export interface ExecutorInfo {
  name: string;
  kind: string;
  capabilities: string[];
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
 * Two of these are load-bearing since Nimbus became the workspace itself
 * (core/src/vfs/nimbus-workspace.ts). `workspace` is no longer a state store to
 * inspect: it is the agent's filesystem AND its shell, the durable one, so
 * "Agent state" undersold it into looking like a debug pane. And `nimbus` had
 * to stop being called Nimbus, because Nimbus is what runs the workspace now —
 * the executor is a SEPARATE Nimbus session in its own NimbusSession Durable
 * Object (cf-backend/src/runtime.ts createAgentNimbusHandle), a different
 * machine with its own bytes, its own shell and real native binaries. Two rows
 * both reading "Nimbus" said they were one thing twice.
 */
export const EXECUTOR_LABELS: Record<string, string> = {
  laptop:    "Your PC",
  nimbus:    "Linux session",
  sandbox:   "Sandbox",
  workspace: "Workspace",
  // Forks only: the workspace this one branched from, reached over DO RPC.
  parent:    "Parent workspace",
};

export function executorLabel(name: string): string {
  return EXECUTOR_LABELS[name] ?? name;
}

export const EXECUTOR_ORDER = ["laptop", "nimbus", "sandbox", "workspace", "parent"];

export function executorSortKey(name: string): number {
  const idx = EXECUTOR_ORDER.indexOf(name);
  return idx === -1 ? 99 : idx;
}

/** An environment row's name IS its executor's name: one environment, one
 *  filesystem, one exec plane. Kept as a function because the file browser
 *  calls it per row and used to need a real translation. */
export function executorForMount(mountName: string): string {
  return mountName;
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

const STATIC_PRIORITY = ["laptop", "nimbus", "sandbox"];

export function pickDefaultExecutor(executors: ExecutorAvailability[], lastActive?: string | null): string {
  const isActive = (name: string) => executors.some((e) =>
    e.name === name && e.available && (e.active || e.status === "active"));
  if (lastActive && isActive(lastActive)) return lastActive;
  for (const name of STATIC_PRIORITY) {
    if (isActive(name)) return name;
  }
  return "workspace";
}
