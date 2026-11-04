/** Fills its parent: render inside a sized container. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Effect } from "effect";
import { CopyButton } from "@/components/ui/CopyButton";
import { Switch } from "@/components/ui/Switch";
import { useConfirmation } from "@/components/ui/ConfirmDialog";
import { PREVIEW_SANDBOX, isPreviewUrl, type PinnedPreviewPort } from "@kinu.run/core";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import { detach, showing } from "@kinu.run/core/obs";
import { ArrowSquareOutIcon, SidebarSimpleIcon } from "@phosphor-icons/react";
import { Button, buttonClass } from "@/components/ui/Button";
import { Surface } from "@/components/ui/Surface";

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

/**
 * A preview's ways out, the same on every preview: copy its address, open it in the inspector (where the chat's copy
 * then folds, `usePreviewFold`), open it in a tab of its own. Each only where it can act: an answer's page has no
 * address of its own, and the inspector shows a site only through a preview of it.
 */
export function PreviewActions({ name, url, inInspector }: { name: string; url?: string | undefined; inInspector?: (() => void) | undefined }) {
  const ghost = `${buttonClass({ variant: "ghost", size: "sm", iconOnly: true })} shrink-0`;

  return (
    <>
      {url !== undefined && <CopyButton value={url} what="the preview URL" className="shrink-0" />}
      {inInspector !== undefined && (
        <Button variant="ghost" size="sm" className="shrink-0" onClick={inInspector} data-open-inspector
          icon={<SidebarSimpleIcon size={14} style={{ transform: "scaleX(-1)" }} />} aria-label={`Open ${name} in the inspector`} title="Open in the inspector" />
      )}
      {url !== undefined && (
        <a href={url} target="_blank" rel="noopener noreferrer" className={ghost} aria-label={`Open ${name} in a new tab`} title="Open in a new tab">
          <ArrowSquareOutIcon size={14} />
        </a>
      )}
    </>
  );
}

export function PreviewChrome({ url, publicLink, inInspector }: { url: string; publicLink?: PublicLink | undefined; inInspector?: (() => void) | undefined }) {
  return (
    <PreviewAddress url={url}>
      {publicLink !== undefined && <PublicLinkSwitch key={url} link={publicLink} />}
      <PreviewActions name={url} url={url} inInspector={inInspector} />
    </PreviewAddress>
  );
}

/** The bar alone, naming where a preview is: the landing's sample, whose address serves nothing to open or copy. */
export function PreviewAddress({ url, children }: { url: string; children?: ReactNode }) {
  return (
    <Surface look="tile" className="flex items-center gap-2 px-3 py-1 border-b p-border shrink-0">
      <code data-preview-address className="t-meta t-mono p-text-3 truncate flex-1">{url}</code>
      {children}
    </Surface>
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
      <label className="t-meta t-mono flex shrink-0 items-center gap-2 p-text-3" title={error ?? (open ? "Anyone with this link can open it" : "Opens only for you, signed in")} data-preview-public>
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

export function PreviewFrame({ url, label, publicLink, inInspector }: {
  url: string;
  label?: string;
  publicLink?: PublicLink | undefined;
  /** In the chat: shows this preview in the inspector, where one of its previews serves the site. */
  inInspector?: (() => void) | undefined;
}) {
  // The only gate on framed URLs: they come from raw tool output.
  if (!isPreviewUrl(url)) {
    return (
      <div className="h-full flex items-center justify-center p-4 text-center">
        <span className="t-meta t-mono p-text-3 break-all">
          Refused to preview a URL that is not a Kinu preview: {url}
        </span>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <PreviewChrome url={url} publicLink={publicLink} inInspector={inInspector} />
      <Surface look="page" as="iframe" className="flex-1 min-h-0 w-full border-0" src={url} title={label ?? url} sandbox={PREVIEW_SANDBOX} />
    </div>
  );
}
