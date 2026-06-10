/**
 * The one preview-iframe pipeline. Every surface that renders an exposed-port
 * app — the chat inline preview card, the Output surface, and the Devices
 * (ExecutorsPanel) preview tab — uses this frame, so the chrome (copy /
 * reload / open-in-new-tab) and the sandbox policy never drift apart.
 *
 * Fills its parent: render inside a sized container (flex-1 min-h-0 column,
 * or a fixed-height wrapper for the inline chat card).
 */
import { useState } from "react";
import { ArrowsClockwiseIcon, ArrowSquareOutIcon, CopyIcon } from "@phosphor-icons/react";

const IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads";

export function PreviewFrame({ url, label }: {
  url: string;
  /** Header label, e.g. ":8080 · hello-world". The URL is always shown. */
  label?: string;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [copied, setCopied] = useState(false);
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b p-border p-elevated shrink-0">
        <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
        {label && <span className="font-mono text-[11px] p-text-2 shrink-0">{label}</span>}
        <code className="text-[10px] p-text-3 font-mono truncate ml-2 flex-1">{url}</code>
        <button
          onClick={() => { navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}
          className="p-text-3 hover:p-text p-1 shrink-0"
          title="Copy URL"
        >{copied ? <span className="text-[10px]">copied</span> : <CopyIcon size={11} />}</button>
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
        className="flex-1 w-full bg-white"
        sandbox={IFRAME_SANDBOX}
      />
    </div>
  );
}
