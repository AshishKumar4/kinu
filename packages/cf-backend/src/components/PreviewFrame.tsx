/** Fills its parent: render inside a sized container. */
import { CopyButton } from "@/components/ui/CopyButton";
import { PREVIEW_SANDBOX, isPreviewUrl } from "@kinu.run/core";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";

export function PreviewChrome({ url }: { url: string }) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b p-border p-fill shrink-0">
      <code className="p-annotation p-text-3 truncate flex-1">{url}</code>
      <CopyButton value={url} what="the preview URL" size={11} className="p-text-3 hover:p-text p-1 shrink-0" />
      <a href={url} target="_blank" rel="noopener noreferrer" className="p-text-3 hover:p-text p-1 shrink-0" title="Open in new tab"><ArrowSquareOutIcon size={11} /></a>
    </div>
  );
}

export function PreviewFrame({ url, label }: {
  url: string;
  label?: string;
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
      <PreviewChrome url={url} />
      <iframe
        src={url}
        title={label ?? url}
        className="p-bg flex-1 min-h-0 w-full border-0"
        sandbox={PREVIEW_SANDBOX}
      />
    </div>
  );
}
