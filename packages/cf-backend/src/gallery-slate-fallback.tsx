import { useEffect, useState } from "react";
import type { SlateSummary } from "@kinu.run/core";
import type { ForkNode, Rpc } from "@/lib/protocol";
import { WorkSurface, type SurfaceKind } from "@/components/surfaces/WorkSurface";
import { SLATE_PREFIX } from "@/components/surfaces/presence";

const FALLBACK_ID = "fallback-probe";
const FALLBACK_SLATES: readonly SlateSummary[] = [{
  id: FALLBACK_ID,
  title: "Fallback Probe",
  bindings: [],
}];
export const SLATE_GALLERY_URL = 'https://6s5-abcdef0123-aaaaaaaaaaaaaaa-gallery.preview.example.test/';
const EMPTY_TREES: ReadonlyMap<string, ForkNode> = new Map();
const NO_ACTIVITY: ReadonlyMap<string, number> = new Map();

/** Gallery-only previewSlate fixture. It does not exercise a production origin. */
export function SlateFallbackFrame({ rpc }: { rpc: Rpc }) {
  const [slates, setSlates] = useState<readonly SlateSummary[]>(FALLBACK_SLATES);
  const [surface, setSurface] = useState<SurfaceKind>(`${SLATE_PREFIX}${FALLBACK_ID}`);
  useEffect(() => {
    const unpublish = (): void => { setSlates([]); };
    window.addEventListener("gallery:slate-unpublish", unpublish);
    return () => { window.removeEventListener("gallery:slate-unpublish", unpublish); };
  }, []);
  const frameRpc: Rpc = async <T,>(method: string, args?: Parameters<Rpc>[1]): Promise<T> => {
    if (method === "previewSlate") {
      return new Response(JSON.stringify({
        ok: true,
        value: { url: SLATE_GALLERY_URL, port: 8789 },
      })).json<T>();
    }
    return rpc(method, args);
  };
  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[430px] min-h-screen border-x p-border">
        <WorkSurface
          surface={surface}
          onSurface={setSurface}
          pinnedPorts={[]}
          previewError={null}
          onRefreshPorts={() => {}}
          plan={null}
          snapshot={{ status: "loading" }}
          tools={[]}
          memory={[]}
          memoryContent=""
          onRetryLoad={() => {}}
          onSearchMemory={() => {}}
          mctsTrees={EMPTY_TREES}
          headActivity={NO_ACTIVITY}
          isStreaming={false}
          executors={[]}
          executorOutputs={new Map()}
          onExecute={async () => ({})}
          backgroundJobs={[]}
          onRefreshJobs={() => {}}
          pendingActions={[]}
          slates={slates}
          tabPresence={{ releases: true, explorations: true }}
          rpc={frameRpc}
        />
      </div>
    </div>
  );
}
