/**
 * The canonical executor metadata module — the ONE place that names, orders,
 * and filters execution devices. Every surface that renders an executor
 * (Environment mounts, Output diff chips, terminals) reads labels/order from
 * here so the vocabulary never drifts across tabs.
 */
import { EXECUTOR_MOUNT_PREFIX } from "@proteus/core";

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

export const EXECUTOR_LABELS: Record<string, string> = {
  laptop:    "Your PC",
  nimbus:    "Nimbus",
  sandbox:   "Sandbox",
  workspace: "Agent state",
};

export function executorLabel(name: string): string {
  return EXECUTOR_LABELS[name] ?? name;
}

export const EXECUTOR_ORDER = ["laptop", "nimbus", "sandbox", "workspace"];

export function executorSortKey(name: string): number {
  const idx = EXECUTOR_ORDER.indexOf(name);
  return idx === -1 ? 99 : idx;
}

/** CompositeVFS mount name → the executor that runs commands there (inverse
 *  of core's EXECUTOR_MOUNT_PREFIX; /local is the workspace VFS itself). The
 *  mount is the file plane; the executor is the exec plane of the same
 *  environment. */
export function executorForMount(mountName: string): string {
  if (mountName === "local") return "workspace";
  for (const [executor, prefix] of Object.entries(EXECUTOR_MOUNT_PREFIX)) {
    if (prefix === `/${mountName}`) return executor;
  }
  return mountName;
}

export function isExecutorActive(exec: ExecutorInfo): boolean {
  return exec.active === true || exec.status === "active";
}

/** Devices worth offering as an explicit target (diff selector): the user's
 *  PC whenever it is connected, remote runtimes only once actually active,
 *  and never the internal state VFS (callers append it deliberately). */
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
