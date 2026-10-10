/**
 * The workspace page's reads as one policy: which sources it reads, which a landed opening refreshes, which read may
 * still publish, and how their failures read to the owner. Pure; `useKinu` drives it.
 */
import { looksLikeSecretField } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import * as v from "valibot";

/** Each source owns and clears its own message, so one recovery never hides another failure.
 *  Sources store the bare reason; the sentence is composed once, below. */
export type LiveRefreshSource =
  | "snapshot"
  | "roster"
  | "jobs"
  | "work"
  | "pendingActions"
  | "questions"
  | "presence"
  | "memoryContent"
  | "executors"
  | "agents"
  | "slates"
  | "consents"
  | "consentResolution"
  | "plan";

export type LiveRefreshErrors = Partial<Record<LiveRefreshSource, string>>;

interface LiveRefreshDescriptor {
  source: LiveRefreshSource;
  label: string;
}

const LIVE_REFRESH_DESCRIPTORS: readonly LiveRefreshDescriptor[] = [
  { source: "snapshot", label: "this workspace" },
  { source: "roster", label: "the agent roster" },
  { source: "jobs", label: "background jobs" },
  { source: "work", label: "work in progress" },
  { source: "pendingActions", label: "pending actions" },
  { source: "questions", label: "the agent's questions" },
  { source: "memoryContent", label: "memory content" },
  { source: "presence", label: "tab presence" },
  { source: "executors", label: "executors" },
  { source: "agents", label: "the agents panel" },
  { source: "slates", label: "slates" },
  { source: "consents", label: "device consents" },
  { source: "consentResolution", label: "device consents" },
  { source: "plan", label: "active plan" },
];

/** A landed opening is a fresh read of each of these, so it clears their failures. */
export const SNAPSHOT_SEEDED_SOURCES: readonly LiveRefreshSource[] = [
  "memoryContent",
  "executors",
  "presence",
  "plan",
  "slates",
  "pendingActions",
  "jobs",
  "work",
];

/** Action failures keep their own prose: they name what did not happen. */
export type ErrorSource = LiveRefreshSource | "model" | "memory" | "recover";

export type WorkspaceErrors = Partial<Record<ErrorSource, string>>;

export type LiveRefreshReporter = (source: LiveRefreshSource, message: string | null) => void;

export type ConsentResolutionReporter = (consentId: string, message: string | null) => void;

export interface LiveRefreshAdmission {
  activateActor(actorKey: string): void;
  admit(actorKey: string, requestKey: string): () => boolean;
  invalidateActor(actorKey: string): void;
}

export function createLiveRefreshAdmission(): LiveRefreshAdmission {
  let activeActor: string | null = null;
  let actorEpoch = 0;
  let requestSequence = 0;
  const latestRequest = new Map<string, number>();

  const advanceActor = (actorKey: string | null) => {
    activeActor = actorKey;
    actorEpoch += 1;
    latestRequest.clear();
  };

  return {
    activateActor(actorKey) {
      advanceActor(actorKey);
    },
    admit(actorKey, requestKey) {
      const admittedActor = actorEpoch;

      if (actorKey !== activeActor) return () => false;
      const requestId = ++requestSequence;
      latestRequest.set(requestKey, requestId);

      return () => actorKey === activeActor
        && admittedActor === actorEpoch
        && latestRequest.get(requestKey) === requestId;
    },
    invalidateActor(actorKey) {
      if (actorKey === activeActor) advanceActor(null);
    },
  };
}

/** A snapshot failure subsumes seeded surfaces that failed on the same reason (one outage, one line). */
function collectReadFailures(errors: LiveRefreshErrors) {
  const subsumed = errors.snapshot;
  const labels: string[] = [];
  const reasons: string[] = [];

  for (const descriptor of LIVE_REFRESH_DESCRIPTORS) {
    const reason = errors[descriptor.source];

    if (!reason) continue;

    if (!reasons.includes(reason)) reasons.push(reason);

    if (reason === subsumed && SNAPSHOT_SEEDED_SOURCES.includes(descriptor.source)) continue;

    if (!labels.includes(descriptor.label)) labels.push(descriptor.label);
  }

  return { labels, reasons };
}

/** `blocking`: the essential snapshot read failed. `partial`: an optional read failed; the composer
 *  stays enabled. `retry` is null for user-initiated actions the owner re-issues. */
export interface WorkspaceNotice {
  severity: "blocking" | "partial";
  title: string;
  scope: string;
  detail: string;
  retry: string | null;
}

/** `redactPayload`'s secret-name list applied to `name = value` / `name: value` pairs and `Bearer`;
 *  one policy list, so it cannot drift from core's. */
function redactErrorText(text: string): string {
  return text
    .replace(/([A-Za-z][\w-]*)(\s*[=:]\s*)("([^"\\]|\\.)*"|'[^']*'|\S+)/g,
      (whole, name: string, sep: string) =>
        looksLikeSecretField(name) ? `${name}${sep}<redacted>` : whole)
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>");
}

/** Until the first snapshot there is no last known data, so a failed essential read is a failed open.
 *  Each distinct reason appears once. */
export function formatWorkspaceError(errors: WorkspaceErrors, loaded: boolean): WorkspaceNotice | null {
  const action = errors.model ?? errors.memory ?? errors.recover ?? null;
  const { labels, reasons } = collectReadFailures(errors);

  if (action === null && labels.length === 0) return null;

  const detail = reasons.map(redactErrorText).join(" ");
  const blocking = errors.snapshot !== undefined;

  if (labels.length === 0) {
    return { severity: "partial", title: action ?? "", scope: "", detail: "", retry: null };
  }

  const blocked = loaded ? "Showing last known data." : "Nothing has loaded yet.";
  const available = loaded ? "The conversation is available. Showing last known data." : "The conversation is available.";
  const scope = blocking ? blocked : available;

  // Reasons are arbitrary RPC text, so they are listed one after another, not conjoined.
  const list = formatNaturalList(labels);

  const sentenceCased = `${list.slice(0, 1).toUpperCase()}${list.slice(1)}`;
  const blockedTitle = loaded ? `Could not refresh ${list}.` : "Could not open this workspace";

  const readTitle = blocking
    ? blockedTitle
    : `${sentenceCased} could not be ${loaded ? "refreshed" : "loaded"}.`;

  const title = action === null ? readTitle : `${action} ${readTitle}`;

  const retry = !blocking && labels.length === 1 ? `Retry loading ${labels[0]}` : "Retry";

  return { severity: blocking ? "blocking" : "partial", title, scope, detail, retry };
}

/** `superseded`: a newer load or a different actor took the surface; it reports nothing and
 *  nothing may be scheduled for it. */
export type SnapshotLoad = "loaded" | "superseded" | { failed: string };

/** A landed snapshot clears its seeded surfaces' failures, except any whose own refresh was
 *  admitted after this load started. The reason is returned; retry cadence is the caller's. */
export async function loadWorkspaceSnapshot(
  read: (
    isCurrent: () => boolean,
    isSourceCurrent: (source: LiveRefreshSource) => boolean,
  ) => Promise<void>,
  report: LiveRefreshReporter,
  admit: (requestKey: LiveRefreshSource) => () => boolean,
  seeded: readonly LiveRefreshSource[],
): Promise<SnapshotLoad> {
  const isCurrent = admit("snapshot");

  const seededReads = new Map(
    seeded.map((source) => [source, admit(source)] as const),
  );

  const isSourceCurrent = (source: LiveRefreshSource): boolean =>
    seededReads.get(source)?.() ?? false;

  try {
    await read(isCurrent, isSourceCurrent);

    if (!isCurrent()) return "superseded";
    report("snapshot", null);

    for (const [source, stillCurrent] of seededReads) if (stillCurrent()) report(source, null);

    return "loaded";
  } catch (error) {
    if (!isCurrent()) return "superseded";
    const failed = errorMessage({ cause: error });
    report("snapshot", failed);

    return { failed };
  }
}

export interface LiveResourceRead<Value> {
  readonly source: LiveRefreshSource;
  readonly read: () => Promise<Value>;
  readonly apply: (value: Value) => void;
  readonly report: LiveRefreshReporter;
  readonly isCurrent: () => boolean;
}

export async function refreshLiveResource<Value>(
  { source, read, apply, report, isCurrent }: LiveResourceRead<Value>,
): Promise<void> {
  if (!isCurrent()) return;

  try {
    const value = await read();

    if (!isCurrent()) return;
    apply(value);
    report(source, null);
  } catch (error) {
    if (!isCurrent()) return;
    report(source, errorMessage({ cause: error }));
  }
}

export function errorMessage({ cause }: { cause: unknown }): string {
  if (cause instanceof Error && cause.message) return renderThrownChain({ cause });
  const text = v.safeParse(v.string(), cause);

  if (text.success && text.output.trim()) return text.output;

  try { return JSON.stringify(cause) || "unknown error"; }
  catch (error) { return `unrenderable error: ${renderThrownChain({ cause: error })}`; }
}

export function formatNaturalList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "unknown data";

  if (values.length === 2) return `${values[0]} and ${values[1]}`;

  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}
