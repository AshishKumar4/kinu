/** Where a provider's sign-in ends in its helper window: it tells the tab that opened it, then closes itself. */
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { announceConnected } from "@/lib/connect-window";
import { sanitizeReturnTo } from "@kinu.run/core";

export default function ConnectedPage() {
  const [search] = useSearchParams();
  // `next` comes off a URL anyone can write.
  const next = sanitizeReturnTo(search.get("next") ?? "/", window.location.origin);

  useEffect(() => { announceConnected(next); }, [next]);

  return (
    <div className="t-body flex h-screen items-center justify-center p-bg p-text-3">
      Connected. You can close this window.
    </div>
  );
}
