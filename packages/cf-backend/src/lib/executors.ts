/**
 * The canonical executor metadata module — the ONE place that names, orders,
 * and filters execution devices. Every surface that renders an executor
 * (Environment mounts, Output diff chips, terminals) reads labels/order from
 * here so the vocabulary never drifts across tabs.
 */

import { EXECUTOR_CAPABILITIES, type ExecutorCapability } from "@kinu/core";

/** Live executor row as reported by the orchestrator's getExecutors RPC. */
export interface ExecutorInfo {
  name: string;
  kind: string;
  capabilities: string[];
  /** Capabilities the environment could not answer for either way. Rendered
   *  apart from real absences: "Not here" is a measurement, and this is not. */
  unmeasuredCapabilities?: string[];
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
 * What each declared capability MEANS, for the one question this vocabulary
 * answers: can I do this job here, or do I need a different environment?
 *
 * The ids themselves are the contract — `ExecutorProvider.capabilities`, now
 * also rendered into the agent's own execution-status block — so this is
 * strictly the reading of them, and every id in EXECUTOR_CAPABILITIES has one.
 * A raw strip of `fs_shared net_inbound process_signal` is data the reader has
 * to already know to use; that is what made it look like decoration.
 */
export const CAPABILITY_LABELS = {
  javascript:     "Runs JavaScript",
  typescript:     "Runs TypeScript",
  python:         "Runs Python",
  native_binary:  "Runs compiled binaries",
  shell:          "Real POSIX shell",
  npm:            "Installs npm packages",
  git:            "git",
  docker:         "Docker",
  fs_shared:      "Files shared with the agent",
  fs_owned:       "Its own private files",
  net_outbound:   "Reaches the internet",
  net_inbound:    "Can serve a port you can open",
  process_spawn:  "Starts background processes",
  process_long:   "Keeps them running between turns",
  process_signal: "Can signal and stop them",
  gpu:            "GPU",
} satisfies Record<ExecutorCapability, string>;

/** Capability ids arrive over RPC as plain strings; only a declared one has a
 *  reading, and an unknown one is shown as it came rather than dropped. */
function isCapability(value: string): value is ExecutorCapability {
  return Object.hasOwn(CAPABILITY_LABELS, value);
}

export function capabilityLabel(capability: string): string {
  return isCapability(capability) ? CAPABILITY_LABELS[capability] : capability;
}

export const EXECUTOR_ORDER = ["laptop", "sandbox", "workspace", "parent"];

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

/** The two capabilities that say WHICH filesystem an environment has rather
 *  than whether it can do something. Never rendered as an absence: every
 *  environment has a filesystem, so "its own private files — Your PC" against
 *  the workspace reads as a deficiency when sharing the agent's files is the
 *  whole point of the workspace. */
const FILESYSTEM_TOPOLOGY = {
  fs_owned: true,
  fs_shared: true,
} satisfies Partial<Record<ExecutorCapability, true>>;

function isFilesystemTopology(capability: ExecutorCapability): boolean {
  return Object.hasOwn(FILESYSTEM_TOPOLOGY, capability);
}

/** One absence, and the reachable environments that cover it. */
export interface CapabilityAbsence {
  capability: ExecutorCapability;
  where: string[];
}

/** One environment's capability row, in the three readings a user gets. */
export interface CapabilityRow {
  /** Declared present. */
  has: ExecutorCapability[];
  /** Measured absent here, and available somewhere reachable. */
  missing: CapabilityAbsence[];
  /** Not answerable either way by this environment. */
  unknown: ExecutorCapability[];
}

/**
 * How one environment's capability row reads: what it has, what it lacks and
 * can point elsewhere for, and what it could not answer for at all.
 *
 * Three buckets rather than two, and the third is the whole point. A capability
 * missing from `capabilities` is either measured absent or never measured, and
 * only the first is an absence — rendering the second under "Not here" told the
 * user their own laptop does not run Python when nothing had ever asked it.
 * Disjoint by construction, so no capability can be claimed and denied at once.
 */
export function partitionCapabilities(
  selected: ExecutorInfo,
  all: readonly ExecutorInfo[],
): CapabilityRow {
  const here = new Set(selected.capabilities);
  const unmeasured = new Set(selected.unmeasuredCapabilities ?? []);
  const reachable = all.filter((exec) => exec.available && exec.name !== selected.name);
  return {
    has: EXECUTOR_CAPABILITIES.filter((capability) => here.has(capability)),
    unknown: EXECUTOR_CAPABILITIES.filter((capability) => unmeasured.has(capability)),
    // Only absences somewhere reachable can cover: an absence you cannot act on
    // is not information, and listing all sixteen would bury the ones you can.
    missing: EXECUTOR_CAPABILITIES
      .filter((capability) => !(
        here.has(capability) || unmeasured.has(capability) || isFilesystemTopology(capability)))
      .map((capability) => ({
        capability,
        where: reachable
          .filter((exec) => exec.capabilities.includes(capability))
          .map((exec) => executorLabel(exec.name)),
      }))
      .filter((row) => row.where.length > 0),
  };
}
