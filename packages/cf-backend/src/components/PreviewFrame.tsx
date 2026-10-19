/** Fills its parent: render inside a sized container. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Effect } from "effect";
import { CopyButton } from "@/components/ui/CopyButton";
import { Switch } from "@/components/ui/Switch";
import { useConfirmation } from "@/components/ui/ConfirmDialog";
import { PREVIEW_SANDBOX, isPreviewUrl, type PinnedPreviewPort } from "@kinu.run/core";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import { detach, showing } from "@kinu.run/core/obs";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";

/** Whether a computer preview is a public link, and the owner's way to change it. */
export interface PublicLink {
  read: () => Promise<boolean | null>;
  set: (open: boolean) => Promise<void>;
}

/** A computer's preview opens for its owner alone unless they make it a public link; a workspace preview always does. */
export function useComputerPreviewLink(port: PinnedPreviewPort | undefined, rpc: WorkspaceRpc): PublicLink | undefined {
  const computerPort = port?.executor === "computer" ? port.port : null;

  return useMemo(() => (computerPort === null ? undefined : {
    read: async () => (await rpc("getComputerPreviewPublic", [computerPort])).public,
    set: async (open: boolean) => { await rpc("setComputerPreviewPublic", [computerPort, open]); },
  }), [computerPort, rpc]);
}

export function PreviewChrome({ url, publicLink }: { url: string; publicLink?: PublicLink | undefined }) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b p-border p-fill shrink-0">
      <code className="p-annotation p-text-3 truncate flex-1">{url}</code>
      {publicLink !== undefined && <PublicLinkSwitch key={url} link={publicLink} />}
      <CopyButton value={url} what="the preview URL" size={11} className="p-text-3 hover:p-text p-1 shrink-0" />
      <a href={url} target="_blank" rel="noopener noreferrer" className="p-text-3 hover:p-text p-1 shrink-0" title="Open in new tab"><ArrowSquareOutIcon size={11} /></a>
    </div>
  );
}

/** Off, the preview opens for its owner alone, signed in; on, for anyone holding its URL. Turning it on asks first. */
function PublicLinkSwitch({ link }: { link: PublicLink }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { ask, dialog } = useConfirmation();

  useEffect(() => {
    let current = true;

    detach(Effect.catchCause(Effect.map(Effect.promise(() => link.read()), (read) => {
      if (current) setOpen(read);
    }), showing((message) => { if (current) setError(message); })));

    return () => { current = false; };
  }, [link]);

  const change = useCallback((next: boolean) => detach(Effect.catchCause(Effect.gen(function* () {
    setError(null);
    yield* Effect.promise(() => link.set(next));
    setOpen(next);
  }), showing(setError))), [link]);

  if (open === null) return null;

  return (
    <>
      <label className="flex shrink-0 items-center gap-1.5 p-annotation p-text-3" title={error ?? (open ? "Anyone with this link can open it" : "Opens only for you, signed in")} data-preview-public>
        {open ? <span className="p-warning">Public link</span> : "Public link"}
        <Switch on={open} label="Anyone with the link can open this preview" data-preview-public-switch
          onChange={(next) => (next
            ? ask({
              title: "Make this preview a public link?",
              body: "Anyone holding its URL can then open it and use the app it serves, signed in or not, until you turn this off or the port is exposed again.",
              action: "Make it public",
              run: async () => { await link.set(true); setOpen(true); },
            })
            : change(false))} />
      </label>
      {dialog}
    </>
  );
}

export function PreviewFrame({ url, label, publicLink }: {
  url: string;
  label?: string;
  publicLink?: PublicLink | undefined;
}) {
  // The only gate on framed URLs: they come from raw tool output.
  if (!isPreviewUrl(url)) {
    return (
      <div className="h-full flex items-center justify-center p-4 text-center">
        <span className="p-annotation p-text-3 break-all">
          Refused to preview a URL that is not a Kinu preview: {url}
        </span>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <PreviewChrome url={url} publicLink={publicLink} />
      <iframe
        src={url}
        title={label ?? url}
        className="p-bg flex-1 min-h-0 w-full border-0"
        sandbox={PREVIEW_SANDBOX}
      />
    </div>
  );
}
