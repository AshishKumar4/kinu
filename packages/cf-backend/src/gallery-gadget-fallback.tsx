import { useEffect, useState } from "react";
import type { GadgetSummary } from "@kinu.run/core";
import type { ForkNode, Rpc } from "@/lib/protocol";
import { WorkSurface, type SurfaceKind } from "@/components/surfaces/WorkSurface";
import { GADGET_PREFIX } from "@/components/surfaces/presence";

const FALLBACK_SLUG = "fallback-probe";

const FALLBACK_GADGETS: readonly GadgetSummary[] = [
  {
    slug: FALLBACK_SLUG,
    title: "Fallback Probe",
    subtitle: null,
    hasServer: false,
    hasClient: true,
    bindings: [],
  },
];

const EMPTY_TREES: ReadonlyMap<string, ForkNode> = new Map();
const NO_ACTIVITY: ReadonlyMap<string, number> = new Map();

/** The fixture client the open tab runs before the removal lands. */
const FALLBACK_CLIENT_JS = "const el = document.createElement('p');"
  + "el.setAttribute('data-fallback-client', '');"
  + "el.textContent = 'fallback probe running';"
  + "document.body.append(el);";

export function GadgetFallbackFrame({ rpc }: { rpc: Rpc }) {
  const [gadgets, setGadgets] = useState<readonly GadgetSummary[]>(FALLBACK_GADGETS);
  const [surface, setSurface] = useState<SurfaceKind>(`${GADGET_PREFIX}${FALLBACK_SLUG}`);
  useEffect(() => {
    const unpublish = (): void => {
      setGadgets([]);
    };
    window.addEventListener("gallery:gadget-unpublish", unpublish);
    return () => {
      window.removeEventListener("gallery:gadget-unpublish", unpublish);
    };
  }, []);
  const frameRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
    if (method === "getGadgetClient") {
      return new Response(JSON.stringify({ ok: true, value: { js: FALLBACK_CLIENT_JS, css: null } })).json<T>();
    }
    if (method === "gadgetCall") {
      return new Response(JSON.stringify({ ok: true, value: null })).json<T>();
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
          gadgets={gadgets}
          tabPresence={{ releases: true, explorations: true }}
          rpc={frameRpc}
        />
      </div>
    </div>
  );
}
