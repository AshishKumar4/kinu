/**
 * The one preview-iframe pipeline. Every surface that renders an exposed-port
 * app — the chat inline preview card, the Output surface, and the Environment
 * preview pane — uses this frame, so the chrome (copy / reload /
 * open-in-new-tab) and the sandbox policy never drift apart.
 *
 * Fills its parent: render inside a sized container (flex-1 min-h-0 column,
 * or a fixed-height wrapper for the inline chat card).
 */
import { useState } from "react";
import { CopyButton } from "@/components/ui/CopyButton";
import { PREVIEW_SANDBOX, isPreviewUrl } from "@/lib/preview-origin";
import { ArrowsClockwiseIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";

export function PreviewFrame({ url, label }: {
  url: string;
  /** Header label, e.g. ":8080 · hello-world". The URL is always shown. */
  label?: string;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  // The only gate on what this app frames. Preview URLs reach here out of raw
  // tool output, so an agent that writes a URL of its own choosing must not get
  // it rendered inside the workspace chrome.
  if (!isPreviewUrl(url)) {
    return (
      <div className="h-full flex items-center justify-center p-4 text-center">
        <span className="text-[11px] p-text-3 font-mono break-all">
          Refused to preview a URL that is not a Proteus preview: {url}
        </span>
      </div>
    );
  }
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b p-border p-fill shrink-0">
        <span className="size-1.5 rounded-full p-dot-success shrink-0" />
        {label && <span className="font-mono text-[11px] p-text-2 shrink-0">{label}</span>}
        <code className="text-[10px] p-text-3 font-mono truncate ml-2 flex-1">{url}</code>
        <CopyButton value={url} what="the preview URL" size={11} className="p-text-3 hover:p-text p-1 shrink-0" />
        <button
          onClick={() => setReloadKey(k => k + 1)}
          className="p-text-3 hover:p-text p-1 shrink-0"
          title="Reload"
        ><ArrowsClockwiseIcon size={11} /></button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="p-text-3 hover:p-text p-1 shrink-0"
          title="Open in new tab"
        ><ArrowSquareOutIcon size={11} /></a>
      </div>
      <iframe
        key={reloadKey}
        src={url}
        title={label ?? url}
        className="p-bg flex-1 w-full"
        sandbox={PREVIEW_SANDBOX}
      />
    </div>
  );
}
