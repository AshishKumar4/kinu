/** Names, orders, and describes executors for user surfaces, in user terms only. */

import type { ExecutorInfo } from '../execution/types';

export type { ExecutorInfo };

/** The executor kind's human name, not a copy of the namespace (the namespace is the API). */
const EXECUTOR_LABELS = {
  device:    "Your PC",
  sandbox:   "Sandbox",
  workspace: "Workspace",
  // Forks only: the workspace this one branched from, reached over DO RPC.
  parent:    "Parent workspace",
};

export function executorLabel(name: string): string {
  return Object.entries(EXECUTOR_LABELS).find(([key]) => key === name)?.[1] ?? name;
}

const EXECUTOR_ORDER = ["device", "sandbox", "workspace", "parent"];

export function executorSortKey(name: string): number {
  const idx = EXECUTOR_ORDER.indexOf(name);

  return idx === -1 ? 99 : idx;
}

export function isExecutorActive(exec: ExecutorInfo): boolean {
  return exec.active || exec.status === "active";
}

/** Explicit-target devices: the PC when connected, remote runtimes once active, never the workspace
 * (callers append it). */
export function isActiveExecutionDevice(exec: ExecutorInfo): boolean {
  if (exec.name === "workspace" || !exec.available) return false;

  if (exec.name === "device") return true;

  return isExecutorActive(exec);
}

/** Default executor: the sticky `last_active_executor` when still available, else a static priority
 * favoring a real shell, falling back to the VFS. */
export interface ExecutorAvailability {
  name: string;
  available: boolean;
  active?: boolean;
  status?: "not_configured" | "idle" | "active" | "disconnected" | "error";
}

/** The release engine runs in the sandbox container, so the sandbox row is the substrate verdict:
 * absent means changes can be drafted and approved, never applied. `unknown` until executors load. */
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

const STATIC_PRIORITY = ["device", "sandbox"];

export function pickDefaultExecutor(executors: ExecutorAvailability[], lastActive?: string | null): string {
  const isActive = (name: string) => executors.some((e) =>
    e.name === name && e.available && (e.active === true || e.status === "active"));

  if (lastActive && isActive(lastActive)) return lastActive;

  for (const name of STATIC_PRIORITY) {
    if (isActive(name)) return name;
  }

  return "workspace";
}

