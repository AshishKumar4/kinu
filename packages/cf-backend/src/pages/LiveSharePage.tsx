/**
 * `/shared/live/:workspace/:share`: where a live share is entered. Its visitor is signed in by the app, handed the
 * share's ticket, and sent on to the share's host, which admits them as themselves.
 */
import { showing, detach } from "@kinu.run/core/obs";
import { Effect } from "effect";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import { KinuLogo } from "@/components/ui/KinuLogo";
import { openLiveShare } from "@/lib/shared-api";

export default function LiveSharePage() {
  const { workspace = "", share = "" } = useParams();
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;

    detach(Effect.catchCause(
      Effect.map(Effect.promise(() => openLiveShare({ workspace, share })), ({ url }) => { if (live) location.replace(url); }),
      showing((chain) => { if (live) setErr(chain); }),
    ));

    return () => { live = false; };
  }, [workspace, share]);

  return (
    <div className="min-h-screen p-bg p-text">
      <header className="flex h-14 items-center justify-between border-b p-border px-5">
        <a href="/" aria-label="Kinu home" className="flex items-center"><KinuLogo /></a>
        <span className="p-meta p-text-3">Shared slate</span>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-8">
        {err === null
          ? <div className="flex justify-center py-16"><Loader size="base" /></div>
          : <div className="p-notice-danger rounded-md px-3 py-2 text-xs">{err}</div>}
      </main>
    </div>
  );
}
