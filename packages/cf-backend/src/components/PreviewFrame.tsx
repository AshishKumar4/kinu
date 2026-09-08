/**
 * The one preview-iframe pipeline. Every surface that renders an exposed-port
 * app — compact chat cards and full-height preview tabs — uses this frame,
 * so URL/copy/open-in-new-tab chrome and the sandbox policy never drift apart.
 *
 * Fills its parent: render inside a sized container (flex-1 min-h-0 column,
 * or a fixed-height wrapper for the inline chat card).
 */
import { CopyButton } from "@/components/ui/CopyButton";
import { PREVIEW_SANDBOX, isPreviewUrl } from "@/lib/preview-origin";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";

export function PreviewFrame({ url, label }: {
  url: string;
  /** The frame's accessible name — a tab title or a port label. The header
   *  shows the URL only: the tab that opened this frame already names it, and
   *  a second title beside the URL is the duplication the tabs replaced. */
  label?: string;
}) {
  // The only gate on what this app frames. Preview URLs reach here out of raw
  // tool output, so an agent that writes a URL of its own choosing must not get
  // it rendered inside the workspace chrome.
  if (!isPreviewUrl(url)) {
    return (
      <div className="h-full flex items-center justify-center p-4 text-center">
        <span className="text-[11px] p-text-3 font-mono break-all">
          Refused to preview a URL that is not a Kinu preview: {url}
        </span>
      </div>
    );
  }
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b p-border p-fill shrink-0">
        <code className="text-[10px] p-text-3 font-mono truncate flex-1">{url}</code>
        <CopyButton value={url} what="the preview URL" size={11} className="p-text-3 hover:p-text p-1 shrink-0" />
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="p-text-3 hover:p-text p-1 shrink-0"
          title="Open in new tab"
        ><ArrowSquareOutIcon size={11} /></a>
      </div>
      <iframe
        src={url}
        title={label ?? url}
        className="p-bg flex-1 min-h-0 w-full border-0"
        sandbox={PREVIEW_SANDBOX}
      />
    </div>
  );
}
