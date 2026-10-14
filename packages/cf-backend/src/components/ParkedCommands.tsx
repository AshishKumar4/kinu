/**
 * Parked commands, decided in the attention stack: one at a time on its card, or several together, chosen by their
 * boxes. Nothing here has run; approving wakes the agent, which issues the command again.
 */
import { Cause, Effect } from "effect";
import { useCallback, useState, useSyncExternalStore } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import { revealMisrepresenting, timeAgo, type Omitted, type PendingAction } from "@kinu.run/core";
import { detach, renderThrownChain, settle } from "@kinu.run/core/obs";
import { FilledButton } from "@/components/ui/FilledButton";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { FileBody } from "@/components/surfaces/changes/ChangesPanel";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";

function countLabel(chosen: number, total: number): string {
  if (total === 1) return "";

  return chosen === total ? "all" : String(chosen);
}

/** `always` also records a standing grant per tripped gate-tier rule on that environment; it widens no access, and a refused rule cannot be granted. */
export type ParkedDecision = "approved" | "denied" | "always";

export interface ParkedDecisionDeps {
  decide: (ids: string[], decision: ParkedDecision) => Promise<{ decided: string[] }>;
  /** Told which commands were decided, so their cards leave and the queue is read again. */
  onDecided: (decided: readonly string[]) => void;
}

export interface ParkedQueueSnapshot {
  /** Null means everything, so an action parked mid-review joins "approve all"; after a decision it is the empty set. */
  readonly selected: ReadonlySet<string> | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly decided: ParkedDecision | null;
}

/** A decision never re-selects what was just decided, and always re-reads the queue. */
export class ParkedDecisionFlow {
  #snapshot: ParkedQueueSnapshot = { selected: null, busy: false, error: null, decided: null };
  readonly #listeners = new Set<() => void>();
  readonly #deps: ParkedDecisionDeps;

  constructor(deps: ParkedDecisionDeps) {
    this.#deps = deps;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => { this.#listeners.delete(listener); };
  };

  readonly snapshot = (): ParkedQueueSnapshot => this.#snapshot;

  chosen(allIds: readonly string[]): ReadonlySet<string> {
    return this.#snapshot.selected ?? new Set(allIds);
  }

  readonly toggle = (id: string, allIds: readonly string[]): void => {
    const chosen = this.chosen(allIds);
    this.#set({
      selected: new Set(
        chosen.has(id) ? [...chosen].filter((x) => x !== id) : [...chosen, id],
      ),
    });
  };

  decide(decision: ParkedDecision, ids: readonly string[]): Promise<void> {
    if (this.#snapshot.busy || ids.length === 0) return Promise.resolve();
    this.#set({ busy: true, error: null, decided: null });

    return settle(Effect.catchCause(Effect.gen({ self: this }, function* () {
      const { decided } = yield* Effect.promise(() => this.#deps.decide([...ids], decision));

      // The empty set, never null: null selects everything.
      this.#set({ busy: false, selected: new Set(), error: null, decided: decision });
      this.#deps.onDecided(decided);
    }), (failed) => Effect.sync(() => {
      // The answer never landed, so the selection stands.
      this.#set({ busy: false, error: `Could not record the decision: ${renderThrownChain({ cause: Cause.squash(failed) })}` });
    })));
  }

  #set(partial: Partial<ParkedQueueSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...partial };

    for (const listener of this.#listeners) listener();
  }
}

/** Permission is not an effect: the command still has not run, so never say "done". */
const DECIDED_LINE: Record<ParkedDecision, string> = {
  denied: "Denied. The agent will be told, and nothing runs.",
  always: "Approved. Kinu will stop asking about these checks in this environment.",
  approved: "Approved. It runs when the agent picks the decision up.",
};

/** Several parked commands, as the attention stack decides them: some or all, approved, always allowed or denied. */
export function ParkedCommands({ actions, rpc, onDecided, flow: injected }: {
  actions: readonly PendingAction[]; rpc: WorkspaceRpc; onDecided?: (decided: readonly string[]) => void; flow?: ParkedDecisionFlow;
}) {
  const [fresh] = useState(() => new ParkedDecisionFlow({
    decide: (ids, decision) => rpc("decideDeferredApprovals", [ids, decision]),
    onDecided: (decided) => onDecided?.(decided),
  }));

  const flow = injected ?? fresh;
  const state = useSyncExternalStore(flow.subscribe, flow.snapshot, flow.snapshot);
  const allIds = actions.map((a) => a.id);
  const chosen = flow.chosen(allIds);

  const decidedLine = state.decided === null ? null : DECIDED_LINE[state.decided];

  return (
    <div className="space-y-2" data-parked-commands>
      <div className="min-w-0">
        <div className="p-row-text p-text">
          {actions.length} command{actions.length === 1 ? "" : "s"} waiting on your approval
        </div>
        <div className="p-meta p-text-3 mt-0.5">
          These checks are queued. Approve them so the agent can run them when it resumes.
        </div>
      </div>

      <div className="space-y-1">
        {actions.map((action) => (
          <label key={action.id} data-parked-command={action.id}
            className="flex items-start gap-2 rounded-md px-2 py-1.5 p-elevated cursor-pointer">
            <input type="checkbox" className="mt-0.5 shrink-0 cursor-pointer accent-[var(--c-accent)] hover:brightness-110" checked={chosen.has(action.id)}
              onChange={() => flow.toggle(action.id, allIds)} disabled={state.busy} />
            <span className="min-w-0 flex-1">
              <code className="block p-t-code p-text break-all whitespace-pre-wrap">{revealMisrepresenting(action.detail ?? "")}</code>
              {action.where !== undefined && <span className="block p-meta p-text-2 mt-0.5 break-all">Runs {revealMisrepresenting(action.where)}</span>}
              <span className="block p-meta p-text-3 mt-0.5">{action.title} · queued {timeAgo(action.at)}</span>
            </span>
          </label>
        ))}
        {actions.filter((action) => action.write !== undefined).map((action) => (
          <ParkedWriteChange key={`change-${action.id}`} id={action.id} rpc={rpc} />
        ))}
      </div>

      {state.error && <div className="p-t-status p-danger">{state.error}</div>}
      {decidedLine && <div className="p-t-status p-text-3">{decidedLine}</div>}

      <div className="flex items-center justify-end gap-1.5 flex-wrap">
        <FilledButton disabled={state.busy || chosen.size === 0}
          onClick={() => detach(Effect.promise(async () => flow.decide("approved", [...chosen])))}>
          Approve {countLabel(chosen.size, actions.length)}
        </FilledButton>
        <Button size="sm" variant="secondary" disabled={state.busy || chosen.size === 0}
          onClick={() => detach(Effect.promise(async () => flow.decide("always", [...chosen])))}
          title="Approve these checks for this environment. Revoke under Settings → Standing approvals.">
          Always allow {countLabel(chosen.size, actions.length)}
        </Button>
        <Button size="sm" variant="ghost" disabled={state.busy || chosen.size === 0}
          onClick={() => detach(Effect.promise(async () => flow.decide("denied", [...chosen])))}>
          Deny {countLabel(chosen.size, actions.length)}
        </Button>
      </div>
    </div>
  );
}

const OMITTED_TEXT: Record<Omitted, string> = { binary: "Binary content", large: "Too large to show line by line" };

function byteCount(bytes: number): string {
  return `${bytes.toLocaleString()} byte${bytes === 1 ? "" : "s"}`;
}

/** The parked bytes against the file as it is now: approving writes exactly these. */
export function ParkedWriteChange({ id, rpc }: { id: string; rpc: WorkspaceRpc }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-md px-2 py-1.5 p-elevated" data-parked-write={id}>
      <button type="button" className="p-meta p-accent-fg hover:underline" onClick={() => setOpen((was) => !was)} aria-expanded={open}>
        {open ? "Hide the change" : "Show the change"}
      </button>
      {open && <ParkedWriteDiff id={id} rpc={rpc} />}
    </div>
  );
}

function ParkedWriteDiff({ id, rpc }: { id: string; rpc: WorkspaceRpc }) {
  const load = useCallback(() => rpc("reviewParkedWrite", [id]), [rpc, id]);
  const { resource, reload } = useAsyncResource(load);
  const review = lastValue(resource);

  if (review === null) {
    return resource.status === "error"
      ? <LoadFailure what="the change" message={resource.message} onRetry={reload} />
      : <div className="flex justify-center py-2"><Loader size="sm" /></div>;
  }

  const sizes = `${review.currentBytes === null ? "New file" : byteCount(review.currentBytes)} → ${byteCount(review.nextBytes)}`;

  return (
    <div className="mt-1.5 space-y-1.5">
      <div className="p-meta p-text-3">{review.path} · {sizes}</div>
      {review.changedSinceAsked && (
        <div className="p-t-status p-warning">The file changed after the agent asked, so approving writes nothing.</div>
      )}
      {review.diff.omitted === undefined
        ? <div className="overflow-hidden rounded-md border p-border"><FileBody file={review.diff} stacked={false} onOpenInFiles={null} /></div>
        : <div className="p-meta p-text-2">{OMITTED_TEXT[review.diff.omitted]}.</div>}
    </div>
  );
}

