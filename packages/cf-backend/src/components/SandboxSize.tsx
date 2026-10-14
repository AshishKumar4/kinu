import { useCallback, useState, type ReactNode } from "react";
import { DesktopIcon } from "@phosphor-icons/react";
import { Effect } from "effect";
import { attempt, renderThrownChain, detach } from "@kinu.run/core/obs";
import { BOX_SIZES, BOX_SIZE_ORDER, DEFAULT_BOX_SIZE, type BoxSize } from "@kinu.run/devbox/sizes";
import { Card, Choice, Field } from "@/components/ui/form";
import { CardSlot } from "@/components/ui/CardSlot";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { getAccountSandboxSize, setAccountSandboxSize } from "../lib/user-api";
import { ACCOUNT_DEFAULT, sandboxSizeText, sizeSpecs, startRefusedNote, workspaceSizeNote, workspaceSizeOptions } from "../lib/sandbox-size-text";
import type { SandboxSizeState } from "../sandbox-size";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";

const shownIn = (show: (message: string) => void) => (failure: { readonly cause?: unknown }) =>
  Effect.sync(() => { show(renderThrownChain({ cause: failure.cause ?? failure })); });

export interface ComputerSizeState {
  readonly state: SandboxSizeState | null;
  /** What the size it runs at, or will start at, gives: `2 vCPU · 8 GiB`. */
  readonly specs: string | null;
  readonly pending: "resize" | "start" | null;
  /** The size a resize under way starts it at. */
  readonly restartingTo: string | null;
  /** A refused start, a failure, or a size waiting for the next start: said under the head. */
  readonly notice: ReactNode;
  readonly choose: (value: BoxSize | typeof ACCOUNT_DEFAULT) => Effect.Effect<void>;
}

const startPending = (pending: "resize" | "start" | null) => (pending === "start" ? "start" : null);

/**
 * The workspace's computer size: read when shown, chosen from the head, restarted at by the RPC that sets it. A resize
 * reads it again first: a computer its terminal woke since the page read it restarts, and the view says so (staging
 * f1f0b451b kept a terminal through the restart, then showed it closed).
 */
export function useComputerSize(rpc: WorkspaceRpc, enabled: boolean): ComputerSizeState {
  const load = useCallback(() => (enabled ? rpc("getComputerSize", []) : Promise.resolve(null)), [rpc, enabled]);
  const { resource, set } = useAsyncResource(load);
  const [pending, setPending] = useState<"resize" | "start" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<BoxSize | null>(null);
  const state = lastValue(resource);

  const act = (action: "resize" | "start", doing: string, change: () => Promise<SandboxSizeState | null>) => {
    setPending(action);
    setFailure(null);

    const call = (read: () => Promise<SandboxSizeState | null>) => attempt({ doing, otherwise: "io" }, read).pipe(
      Effect.map((next) => { if (next !== null) set(next); }),
    );

    return (action === "resize" ? call(() => rpc("getComputerSize", [])).pipe(Effect.andThen(call(change))) : call(change)).pipe(
      Effect.catch(shownIn(setFailure)),
      Effect.ensuring(Effect.sync(() => { setPending(null); setChoosing(null); })),
    );
  };

  const choose = (value: BoxSize | typeof ACCOUNT_DEFAULT) => Effect.sync(() => {
    setChoosing(value === ACCOUNT_DEFAULT ? state?.account ?? DEFAULT_BOX_SIZE : value);
  }).pipe(Effect.andThen(act("resize", "resizing the computer", () => rpc("resizeComputer", [value === ACCOUNT_DEFAULT ? null : value]))));

  // A stopped computer only records the choice; a running one restarts at it.
  const restarting = pending === "resize" && state?.running !== null;
  const note = failure ?? (state === null || restarting ? null : workspaceSizeNote(state, pending === "resize"));

  const notice = state === null ? null : (
    <>
      {state.startRefused !== null && (
        <div data-env-start-refused className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pb-1">
          <span className="p-meta p-danger">{startRefusedNote(state.startRefused)}</span>
          <button type="button" data-env-start-again onClick={() => detach(act("start", "starting the computer", () => rpc("startComputer", [])))}
            disabled={pending !== null} className="p-env-action">{pending === "start" ? "Starting…" : "Start again"}</button>
        </div>
      )}
      {note !== null && <p className={`px-4 pb-1 p-meta ${failure === null ? "p-text-3" : "p-danger"}`}>{note}</p>}
    </>
  );

  return {
    state,
    specs: state === null ? null : sizeSpecs(state.running ?? state.size),
    pending: restarting ? "resize" : startPending(pending),
    restartingTo: choosing === null ? null : BOX_SIZES[choosing].label,
    notice,
    choose,
  };
}

/** The head's size control: the size's name, and every size with what it gives in its list. */
export function ComputerSize({ state: size }: { state: ComputerSizeState }) {
  const { state } = size;

  if (state === null) return null;

  return (
    <div data-env-size title="A running computer restarts at the new size: files stay, services start again, open terminals start fresh.">
      <Choice
        label="Computer size"
        size="sm"
        className="!w-auto min-w-0"
        value={state.chosen ?? ACCOUNT_DEFAULT}
        options={workspaceSizeOptions(state.account)}
        shown={(value) => BOX_SIZES[value === ACCOUNT_DEFAULT ? state.account ?? DEFAULT_BOX_SIZE : value].label}
        onChange={(value) => detach(size.choose(value))}
        disabled={size.pending !== null}
      />
    </div>
  );
}

export function SandboxSizeSettings() {
  const { resource, reload, set } = useAsyncResource(getAccountSandboxSize);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const choose = (size: BoxSize) => {
    setSaving(true);
    setFailure(null);

    return attempt({ doing: "saving the default computer size", otherwise: "io" }, () => setAccountSandboxSize(size)).pipe(
      Effect.map(() => { set(size); }),
      Effect.catch(shownIn(setFailure)),
      Effect.ensuring(Effect.sync(() => { setSaving(false); })),
    );
  };

  return (
    <Card title="Computer size" icon={DesktopIcon}
      description="Each workspace's computer starts at this size unless the workspace chooses its own in its Environment tab. It applies the next time one starts.">
      <CardSlot resource={resource} what="the computer size" onRetry={reload}>
        {(account) => (
          <Field label="Default size" hint={failure ?? (saving ? "Saving…" : undefined)}>
            <Choice
              label="Default computer size"
              value={account ?? DEFAULT_BOX_SIZE}
              options={BOX_SIZE_ORDER.map((size) => ({ value: size, label: sandboxSizeText(size) }))}
              onChange={(value) => detach(choose(value))}
              disabled={saving}
            />
          </Field>
        )}
      </CardSlot>
    </Card>
  );
}
