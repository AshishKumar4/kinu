/** Where a provider's sign-in ends in its helper window: it tells the tab that opened it, then closes itself. */
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { announceConnected, sameOriginPath } from "@/lib/connect-window";

export default function ConnectedPage() {
  const [search] = useSearchParams();
  const next = sameOriginPath(search.get("next"));

  useEffect(() => { announceConnected(next); }, [next]);

  return (
    <div className="flex h-screen items-center justify-center p-bg p-text-3 text-sm">
      Connected. You can close this window.
    </div>
  );
}
