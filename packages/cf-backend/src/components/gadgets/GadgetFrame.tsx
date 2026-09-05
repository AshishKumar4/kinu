/**
 * The gadget frame — one agent-authored client, sandboxed.
 *
 * The client arrives over `getGadgetClient` as `{js, css}` and renders into
 * an iframe built by gadget-document.ts; the bridge (gadget-bridge.ts) is
 * attached from mount, BEFORE the document can load, so the iframe's
 * handshake can never land before its reader. A `reloadKey` bump — the
 * `gadgets_changed` broadcast arriving for this slug — remounts the iframe
 * and re-reads the client.
 *
 * When the gadget has no client the server answers a refusal, and the frame
 * shows its `reason: error` text rather than an empty box. The client's own
 * console lines and uncaught errors, forwarded by the document's prefix,
 * show under the frame: a typo in `client.js` is otherwise a blank box with
 * no reason anywhere the owner can read.
 */

import { useEffect, useRef, useState } from "react";
import { Loader } from "@cloudflare/kumo/components/loader";
import * as v from "valibot";
import type { GadgetCallResult } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import type { Rpc } from "@/lib/protocol";
import { GADGET_IFRAME_SANDBOX, gadgetDocument } from "./gadget-document";
import { attachGadgetBridge, type GadgetConsoleLevel, type GadgetConsoleMessage } from "./gadget-bridge";

const GadgetClientSchema = v.object({ js: v.string(), css: v.nullable(v.string()) });

/** How many console lines the frame keeps, oldest dropped first. */
const CONSOLE_LINES = 100;

export function GadgetFrame({ slug, rpc, reloadKey = 0 }: {
  slug: string;
  rpc: Rpc;
  /** Bumped when the gadget's files change — remounts the iframe. */
  reloadKey?: number;
}) {
  const [document, setDocument] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [lines, setLines] = useState<GadgetConsoleMessage[]>([]);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    return attachGadgetBridge({
      iframe, slug, rpc,
      onConsole: (line) => setLines((prev) => [...prev.slice(1 - CONSOLE_LINES), line]),
    });
  }, [slug, rpc, reloadKey]);

  useEffect(() => {
    let live = true;
    setDocument(null);
    setRefusal(null);
    setLines([]);
    // Named, not inline: the rejection callback stays a generic `Thrown` the
    // unknown-parameter rule accepts, passed by reference the way
    // FeedbackModal's capture handlers are.
    const clientUnreachable = <Thrown,>(thrown: Thrown): void => {
      if (live) setRefusal(renderThrownChain({ cause: thrown }));
    };
    void rpc<GadgetCallResult>("getGadgetClient", [slug]).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setRefusal(`${result.reason}: ${result.error}`);
        return;
      }
      const parsed = v.safeParse(GadgetClientSchema, result.value);
      if (!parsed.success) {
        setRefusal(`The "${slug}" gadget answered a client that is not JavaScript and CSS.`);
        return;
      }
      setDocument(gadgetDocument(parsed.output));
    }, clientUnreachable);
    return () => { live = false; };
  }, [slug, rpc, reloadKey]);

  return (
    <div className="flex flex-col">
      {refusal !== null && (
        <div className="p-notice-danger rounded-lg px-3 py-2 text-xs">
          <p className="break-words m-0">{refusal}</p>
        </div>
      )}
      {document === null && refusal === null && (
        <div className="flex justify-center py-16"><Loader /></div>
      )}
      {/* Always mounted, so the bridge above owns the handshake before the
          document arrives. Unfed until the client lands (`srcDoc` absent is
          about:blank); hidden while it waits or the read refused. */}
      <iframe
        key={reloadKey}
        ref={iframeRef}
        srcDoc={document ?? undefined}
        title={slug}
        sandbox={GADGET_IFRAME_SANDBOX}
        className={document === null ? "hidden" : "block h-[480px] w-full rounded-lg border p-border"}
      />
      {lines.length > 0 && (
        <ol data-gadget-console className="mt-2 max-h-40 overflow-y-auto rounded-lg border p-border p-surface m-0 list-none p-0 font-mono text-[10.5px]">
          {lines.map((line, index) => (
            <li key={index} data-level={line.level} className={`px-2 py-0.5 border-b p-border last:border-0 whitespace-pre-wrap break-words ${CONSOLE_TONE[line.level]}`}>
              <span className="p-text-3">{line.level}</span> {line.message.join(" ")}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const CONSOLE_TONE = {
  debug: "p-text-3",
  info: "p-text-2",
  log: "p-text-2",
  warn: "p-warning",
  error: "p-danger",
} satisfies Record<GadgetConsoleLevel, string>;
