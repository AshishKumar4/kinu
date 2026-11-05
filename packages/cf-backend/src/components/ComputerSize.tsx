import { useCallback, useState, type ReactNode } from "react";
import { Effect } from "effect";
import { attempt } from "@kinu.run/core/obs";
import { BOX_SIZES, BOX_SIZE_ORDER, DEFAULT_BOX_SIZE, type BoxSize } from "@kinu.run/devbox/sizes";
import { Card } from "@/components/ui/Card";
import { Select } from "@/components/ui/Select";
import { Field } from "@/components/ui/Field";
import { CardSlot } from "@/components/ui/CardSlot";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { getAccountComputerSize, setAccountComputerSize } from "../lib/user-api";
import { ACCOUNT_DEFAULT, cappedSizeNote, computerSizeText, sizeSpecs, stalledNote, startRefusedNote, workspaceSizeNote, workspaceSizeOptions } from "../lib/computer-size-text";
import { useLimitRefusal } from "@/components/limits/LimitRefusal";
import { useComputerSizeCap } from "@/components/limits/limit-words";
import type { ComputerSizeState } from "../computer-size";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import { Button } from "@/components/ui/Button";
import { useLabelledStep } from "@/hooks/use-labelled-step";

export interface ComputerSizeControl {
  readonly state: ComputerSizeState | null;
  /** What the size it runs at, or will start at, gives: `2 vCPU · 8 GiB`. */
  readonly specs: string | null;
  readonly pending: "resize" | "start" | "stop" | null;
  /** The size a resize under way starts it at. */
  readonly restartingTo: string | null;
  /** A refused start, a failure, or a size waiting for the next start: said under the head. */
  readonly notice: ReactNode;
  readonly choose: (value: BoxSize | typeof ACCOUNT_DEFAULT) => void;
}

const startPending = (pending: "resize" | "start" | "stop" | null) => (pending === "resize" ? null : pending);

/**
 * The workspace's computer size: read when shown, chosen from the head, restarted at by the RPC that sets it. A resize
 * reads it again first: a computer its terminal woke since the page read it restarts, and the view says so (staging
 * f1f0b451b kept a terminal through the restart, then showed it closed).
 */
export function useComputerSize(rpc: WorkspaceRpc, enabled: boolean): ComputerSizeControl {
  const load = useCallback(() => (enabled ? rpc("getComputerSize", []) : Promise.resolve(null)), [rpc, enabled]);
  const { resource, set } = useAsyncResource(load);
  const { busy: pending, error: failure, run } = useLabelledStep<"resize" | "start" | "stop">();
  const [choosing, setChoosing] = useState<BoxSize | null>(null);
  const state = lastValue(resource);
  const cap = useComputerSizeCap();
  const offerRefusal = useLimitRefusal();

  const act = (action: "resize" | "start" | "stop", doing: string, change: () => Promise<ComputerSizeState | null>): void => run(action, () => {
    const call = (read: () => Promise<ComputerSizeState | null>) => attempt({ doing, otherwise: "io" }, read).pipe(
      Effect.map((next) => { if (next !== null) set(next); }),
    );

    return (action === "resize" ? call(() => rpc("getComputerSize", [])).pipe(Effect.andThen(call(change))) : call(change)).pipe(
      // One of the account's limits refusing the start is that limit's dialog; anything else is said under the head.
      Effect.catch((failed) => (offerRefusal({ cause: failed.cause ?? failed }) ? Effect.void : Effect.fail(failed))),
      Effect.ensuring(Effect.sync(() => { setChoosing(null); })),
    );
  });

  const choose = (value: BoxSize | typeof ACCOUNT_DEFAULT): void => {
    setChoosing(value === ACCOUNT_DEFAULT ? state?.account ?? DEFAULT_BOX_SIZE : value);
    act("resize", "resizing the computer", () => rpc("resizeComputer", [value === ACCOUNT_DEFAULT ? null : value]));
  };

  // A stopped computer only records the choice; a running one restarts at it.
  const restarting = pending === "resize" && state?.running !== null;
  const note = failure ?? (state === null || restarting ? null : workspaceSizeNote(state, pending === "resize", cap));

  const notice = state === null ? null : (
    <>
      {state.startRefused !== null && (
        <div data-env-start-refused className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-1">
          <span className="t-meta p-danger">{startRefusedNote(state.startRefused)}</span>
          <Button size="sm" data-env-start-again onClick={() => act("start", "starting the computer", () => rpc("startComputer", []))}
            disabled={pending !== null} busy={pending === "start"}>Start again</Button>
        </div>
      )}
      {state.stalled !== null && (
        <div data-env-stalled className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-1">
          <span className="t-meta p-danger">{stalledNote(state.stalled)}</span>
          <Button size="sm" data-env-stop-stalled onClick={() => act("stop", "stopping the computer", () => rpc("stopStalledComputer", []))}
            disabled={pending !== null} busy={pending === "stop"}>Stop</Button>
        </div>
      )}
      {note !== null && <p className={`t-meta px-4 pb-1 ${failure === null ? "p-text-3" : "p-danger"}`}>{note}</p>}
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
export function ComputerSize({ state: size }: { state: ComputerSizeControl }) {
  const { state } = size;

  if (state === null) return null;

  return (
    <div data-env-size title="A running computer restarts at the new size: files stay, services start again, open terminals start fresh.">
      <Select
        label="Computer size"
        size="sm"
        className="!w-auto min-w-0"
        value={state.chosen ?? ACCOUNT_DEFAULT}
        options={workspaceSizeOptions(state.account)}
        shown={(value) => BOX_SIZES[value === ACCOUNT_DEFAULT ? state.account ?? DEFAULT_BOX_SIZE : value].label}
        onChange={size.choose}
        disabled={size.pending !== null}
      />
    </div>
  );
}

export function ComputerSizeSettings() {
  const { resource, reload, set } = useAsyncResource(getAccountComputerSize);
  const cap = useComputerSizeCap();
  const { busy, error: failure, run } = useLabelledStep();
  const saving = busy !== null;

  const choose = (size: BoxSize): void => run("save", () => Effect.map(
    attempt({ doing: "saving the default computer size", otherwise: "io" }, () => setAccountComputerSize(size)),
    () => { set(size); },
  ));

  return (
    <Card title="Size">
      <CardSlot resource={resource} what="the computer size" onRetry={reload}>
        {(account) => (
          <Field label="Default size" hint={failure ?? (saving ? "Saving…" : cappedSizeNote(account ?? DEFAULT_BOX_SIZE, cap) ?? "Applies the next time a computer starts.")}>
            <Select
              label="Default computer size"
              value={account ?? DEFAULT_BOX_SIZE}
              options={BOX_SIZE_ORDER.map((size) => ({ value: size, label: computerSizeText(size) }))}
              onChange={choose}
              disabled={saving}
            />
          </Field>
        )}
      </CardSlot>
    </Card>
  );
}
