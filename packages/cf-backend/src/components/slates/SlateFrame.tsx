import { useEffect, useState } from "react";
import { Loader } from "@cloudflare/kumo/components/loader";
import * as v from "valibot";
import type { SlateCallResult } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import type { Rpc } from "@/lib/protocol";
import { PreviewFrame } from '@/components/PreviewFrame';

const SlatePreviewSchema = v.object({ url: v.string(), port: v.number() });
/**
 * Loads one Slate on its preview origin. The host only supplies the iframe URL:
 * preview code has no bridge back into the workspace RPC surface.
 */
export function SlateFrame({ id, rpc, reloadKey = 0 }: {
  id: string;
  rpc: Rpc;
  /** Bumped when the Slate changes, so its preview URL is re-read. */
  reloadKey?: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setUrl(null);
    setRefusal(null);
    const previewUnreachable = <Thrown,>(thrown: Thrown): void => {
      if (live) setRefusal(renderThrownChain({ cause: thrown }));
    };
    void rpc<SlateCallResult>("previewSlate", [id]).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setRefusal(`${result.reason}: ${result.error}`);
        return;
      }
      const preview = v.safeParse(SlatePreviewSchema, result.value);
      if (!preview.success) {
        setRefusal(`The Slate "${id}" answered an invalid preview URL.`);
        return;
      }
      setUrl(preview.output.url);
    }).catch(previewUnreachable);
    return () => { live = false; };
  }, [id, rpc, reloadKey]);

  return (
    <div className="flex flex-col">
      {refusal !== null && (
        <div className="p-notice-danger rounded-lg px-3 py-2 text-xs">
          <p className="break-words m-0">{refusal}</p>
        </div>
      )}
      {url === null && refusal === null && (
        <div className="flex justify-center py-16"><Loader /></div>
      )}
      {url !== null && (
        <div key={reloadKey} className="h-[480px] rounded-lg border p-border overflow-hidden">
          <PreviewFrame url={url} label={id} />
        </div>
      )}
    </div>
  );
}
