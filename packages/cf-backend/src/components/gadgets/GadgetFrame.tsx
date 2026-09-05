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
 * shows its `reason: error` text rather than an empty box.
 */

import { useEffect, useRef, useState } from "react";
import { Loader } from "@cloudflare/kumo/components/loader";
import * as v from "valibot";
import type { GadgetCallResult } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import type { Rpc } from "@/lib/protocol";
import { GADGET_IFRAME_SANDBOX, gadgetDocument } from "./gadget-document";
import { attachGadgetBridge, type GadgetConsoleMessage } from "./gadget-bridge";

const GadgetClientSchema = v.object({ js: v.string(), css: v.nullable(v.string()) });

export function GadgetFrame({ slug, rpc, reloadKey = 0, onConsole }: {
  slug: string;
  rpc: Rpc;
  /** Bumped when the gadget's files change — remounts the iframe. */
  reloadKey?: number;
  onConsole?: (message: GadgetConsoleMessage) => void;
}) {
  const [document, setDocument] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    return attachGadgetBridge({ iframe, slug, rpc, onConsole });
  }, [slug, rpc, onConsole, reloadKey]);

  useEffect(() => {
    let live = true;
    setDocument(null);
    setRefusal(null);
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
    </div>
  );
}
