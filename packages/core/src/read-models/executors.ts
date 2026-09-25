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

