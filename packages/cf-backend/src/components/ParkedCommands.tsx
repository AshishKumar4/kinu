/**
 * Parked commands, decided in the attention stack: one at a time on its card, or several together, chosen by their
 * boxes. Nothing here has run; approving wakes the agent, which issues the command again. A shared slate's change on its
 * owner's access parks here too: "always" on it stands for that slate's shares, not for the environment, and each row
 * says which before it is pressed.
 */
import { Cause, Effect } from "effect";
import { useCallback, useState, useSyncExternalStore } from "react";
import { Loader } from "@/components/ui/Loader";
import { Button } from "@/components/ui/Button";
import { revealMisrepresenting, timeAgo, type Omitted, type PendingAction } from "@kinu.run/core";
import { detach, renderThrownChain, settle } from "@kinu.run/core/obs";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { FileBody } from "@/components/surfaces/changes/ChangesPanel";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import { Checkbox } from "@/components/ui/Check";
import { Group } from "@/components/ui/Group";

function countLabel(chosen: number, total: number): string {
  if (total === 1) return "";

  return chosen === total ? "all" : String(chosen);
}

/** `always` also records a standing grant per tripped gate-tier rule on that environment; it widens no access, and a refused rule cannot be granted. */
export type ParkedDecision = "approved" | "denied" | "always";

export interface ParkedDecisionDeps {
  decide: (ids: string[], decision: ParkedDecision) => Promise<{ decided: string[] }>;
  /** Told which commands were decided, so their cards leave and the queue is read again. */
  onDecided: (decided: readonly string[]) => void | Promise<void>;
}

interface ParkedQueueSnapshot {
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
      yield* Effect.promise(async () => { await this.#deps.onDecided(decided); });
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
  always: "Approved. Kinu won't ask about these again, as each one said.",
  approved: "Approved. It runs when the agent picks the decision up.",
};

/** A root as a person reads it beside its tool: "org acme"; none when the call holds to no one root. */
const rootWords = (root: Readonly<Record<string, string>>) => Object.entries(root).map(([key, value]) => `${key} ${value}`).join(", ");

/** Where "always" on these rows stands: each shared slate's own shares, the environment, or both. */
export function alwaysLabel(actions: readonly PendingAction[], count: string): string {
  const slates = new Set(actions.flatMap((action) => (action.effect === undefined ? [] : [action.effect.slate])));

  if (slates.size === 0 || actions.some((action) => action.effect === undefined)) return `Always allow ${count}`.trim();

  return slates.size === 1 ? `Always for this slate ${count}`.trim() : `Always for their slates ${count}`.trim();
}

/**
 * What "always" stands for on one row, said before it is pressed: a shared slate's tool on its root, allowed on that
 * slate's shares until its code changes; or a command's checks, a standing approval of this environment's.
 */
export function AlwaysLine({ action }: { action: PendingAction }) {
  const { effect } = action;

  if (effect === undefined) {
    return <span data-parked-always="environment" className="t-meta block p-text-3">Always records a standing approval for this environment; revoke it under Settings → Standing approvals.</span>;
  }

  const on = rootWords(effect.root);

  return (
    <span data-parked-always="slate" className="t-meta block p-text-3">
      Always lets <span className="font-mono">{effect.tool}</span> on {effect.server}{on === "" ? "" : ` (${on})`} go ahead without asking on {effect.slate}'s shares,
      until its code changes; revoke it in its share sheet.
    </span>
  );
}

/** What the rows ask, by kind: commands an agent queued, changes a shared slate asked, or both. */
const ASKED = {
  commands: { noun: "command", lead: "These checks are queued. Approve them so the agent can run them when it resumes." },
  changes: { noun: "change", lead: "A shared slate asked to make these with your access. Nothing happens until you approve it." },
  both: { noun: "request", lead: "Approve each so it can go ahead: a command when the agent resumes, a slate's change at once." },
} as const;

function askedOf(actions: readonly PendingAction[]): keyof typeof ASKED {
  const effects = actions.filter((action) => action.effect !== undefined).length;

  if (effects === 0) return "commands";

  return effects === actions.length ? "changes" : "both";
}

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
  const { noun, lead } = ASKED[askedOf(actions)];
  // A row says where its "always" stands when a slate's change is among them; commands alone keep the button's word.
  const saysAlways = actions.some((action) => action.effect !== undefined);
  const picked = actions.filter((action) => chosen.has(action.id));

  return (
    <div className="space-y-2" data-parked-commands>
      <div className="min-w-0">
        <div className="t-body p-text">
          {actions.length} {noun}{actions.length === 1 ? "" : "s"} waiting on your approval
        </div>
        <div className="t-meta p-text-3 mt-px">{lead}</div>
      </div>

      <div className="space-y-1">
        <Group>
          {actions.map((action) => (
            <div key={action.id} data-parked-command={action.id} className="py-1">
              <Checkbox checked={chosen.has(action.id)} onChange={() => flow.toggle(action.id, allIds)} disabled={state.busy} label={
                <span className="min-w-0 flex-1">
                  <code className="t-code block p-text break-all whitespace-pre-wrap">{revealMisrepresenting(action.detail ?? "")}</code>
                  {action.where !== undefined && <span className="t-meta block p-text-2 mt-px break-all">Runs {revealMisrepresenting(action.where)}</span>}
                  <span className="t-meta block p-text-3 mt-px">{action.title} · queued {timeAgo(action.at)}</span>
                  {saysAlways && <AlwaysLine action={action} />}
                </span>} />
            </div>
          ))}
        </Group>
        {actions.filter((action) => action.write !== undefined).map((action) => (
          <ParkedWriteChange key={`change-${action.id}`} id={action.id} rpc={rpc} />
        ))}
      </div>

      {state.error && <div className="t-status p-danger">{state.error}</div>}
      {decidedLine && <div className="t-status p-text-3">{decidedLine}</div>}

      <div className="flex items-center justify-end gap-2 flex-wrap">
        <Button variant="primary" size="sm" disabled={state.busy || chosen.size === 0}
          onClick={() => detach(Effect.promise(async () => flow.decide("approved", [...chosen])))}>
          Approve {countLabel(chosen.size, actions.length)}
        </Button>
        <Button size="sm" variant="secondary" disabled={state.busy || chosen.size === 0}
          onClick={() => detach(Effect.promise(async () => flow.decide("always", [...chosen])))}
          title={saysAlways ? "Approve these, and allow each from now on as its row says." : "Approve these checks for this environment. Revoke under Settings → Standing approvals."}>
          {alwaysLabel(picked.length === 0 ? actions : picked, countLabel(chosen.size, actions.length))}
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
    <div className="rounded-md px-2 py-1 p-fill" data-parked-write={id}>
      <Button variant="ghost" size="sm" onClick={() => setOpen((was) => !was)} aria-expanded={open}>
        {open ? "Hide the change" : "Show the change"}
      </Button>
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
    <div className="mt-2 space-y-2">
      <div className="t-meta p-text-3">{review.path} · {sizes}</div>
      {review.changedSinceAsked && (
        <div className="t-status p-warning">The file changed after the agent asked, so approving writes nothing.</div>
      )}
      {review.diff.omitted === undefined
        ? <div className="overflow-hidden rounded-md border p-border"><FileBody file={review.diff} stacked={false} onOpenInFiles={null} /></div>
        : <div className="t-meta p-text-2">{OMITTED_TEXT[review.diff.omitted]}.</div>}
    </div>
  );
}

