import { useCallback, useState } from "react";
import { CubeIcon } from "@phosphor-icons/react";
import { Effect } from "effect";
import type { Rpc } from "@kinu.run/core";
import { attempt, renderThrownChain, settle } from "@kinu.run/core/obs";
import { BOX_SIZE_ORDER, DEFAULT_BOX_SIZE, type BoxSize } from "@kinu.run/devbox/sizes";
import { Card, Choice, Field } from "@/components/ui/form";
import { CardSlot } from "@/components/ui/CardSlot";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { getAccountSandboxSize, setAccountSandboxSize } from "../lib/user-api";
import { ACCOUNT_DEFAULT, sandboxSizeText, workspaceSizeNote, workspaceSizeOptions } from "../lib/sandbox-size-text";
import type { SandboxSizeState } from "../sandbox-size";

const shownIn = (show: (message: string) => void) => (failure: { readonly cause?: unknown }) =>
  Effect.sync(() => { show(renderThrownChain({ cause: failure.cause ?? failure })); });

export function SandboxSizeRow({ rpc }: { rpc: Rpc }) {
  const load = useCallback(() => rpc<SandboxSizeState | null>("getSandboxSize"), [rpc]);
  const { resource, set } = useAsyncResource(load);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const state = lastValue(resource);

  if (state === null) return null;

  const choose = (value: BoxSize | typeof ACCOUNT_DEFAULT) => {
    setPending(true);
    setFailure(null);

    return attempt({ doing: "resizing the sandbox", otherwise: "io" },
      () => rpc<SandboxSizeState | null>("resizeSandbox", [value === ACCOUNT_DEFAULT ? null : value])).pipe(
      Effect.map((next) => { if (next !== null) set(next); }),
      Effect.catch(shownIn(setFailure)),
      Effect.ensuring(Effect.sync(() => { setPending(false); })),
    );
  };

  const note = failure ?? workspaceSizeNote(state, pending);

  return (
    <div data-env-size className="space-y-1" onClick={(event) => event.stopPropagation()}
      title="A running sandbox restarts at the new size: files stay, supervised servers come back, a running command ends.">
      <Choice
        label="Sandbox size"
        size="sm"
        value={state.chosen ?? ACCOUNT_DEFAULT}
        options={workspaceSizeOptions(state.account)}
        onChange={(value) => settle(choose(value))}
        disabled={pending}
      />
      {note !== null && <div className={`p-meta ${failure === null ? "p-text-3" : "p-danger"}`}>{note}</div>}
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

    return attempt({ doing: "saving the default sandbox size", otherwise: "io" }, () => setAccountSandboxSize(size)).pipe(
      Effect.map(() => { set(size); }),
      Effect.catch(shownIn(setFailure)),
      Effect.ensuring(Effect.sync(() => { setSaving(false); })),
    );
  };

  return (
    <Card title="Sandbox size" icon={CubeIcon}
      description="Each workspace's sandbox starts at this size unless the workspace chooses its own on its Environment card. It applies the next time a sandbox starts.">
      <CardSlot resource={resource} what="your sandbox size" onRetry={reload}>
        {(account) => (
          <Field label="Default size" hint={failure ?? (saving ? "Saving…" : undefined)}>
            <Choice
              label="Default sandbox size"
              value={account ?? DEFAULT_BOX_SIZE}
              options={BOX_SIZE_ORDER.map((size) => ({ value: size, label: sandboxSizeText(size) }))}
              onChange={(value) => settle(choose(value))}
              disabled={saving}
            />
          </Field>
        )}
      </CardSlot>
    </Card>
  );
}
