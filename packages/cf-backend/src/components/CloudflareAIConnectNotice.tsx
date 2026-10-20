import { useState } from "react";
import { WarningCircleIcon } from "@phosphor-icons/react";
import type { ConnectEnded } from "@kinu.run/core";
import { cloudflareConnectPath } from "@/lib/user-api";
import { beginConnect } from "@/lib/connect-window";

interface CloudflareAIConnectNoticeProps {
  /** Rereads what the connection changes, once the connect has connected. */
  onConnected: () => void;
  message?: string;
  action?: string;
}

/** Runs a Cloudflare connect from a click: `onConnected` once it connected, `onFailed` with why it did not. */
export function connectCloudflare(onConnected: () => void, onFailed: (error: string) => void): void {
  const connect = beginConnect();

  connect.start(cloudflareConnectPath(connect.id), (ended: ConnectEnded) => {
    if (ended.error === null) onConnected();
    else onFailed(ended.error);
  });
}

export function CloudflareAIConnectNotice({
  onConnected,
  message = "Cloudflare Workers AI is not connected for this account.",
  action = "Connect Cloudflare Workers AI",
}: CloudflareAIConnectNoticeProps) {
  // Why the last connect did not connect, as Cloudflare or Kinu said it: its finish page closed with the only copy.
  const [failed, setFailed] = useState<string | null>(null);

  return (
    <div className="rounded-md px-3 py-2 text-xs p-notice-warning">
      <div className="flex items-start gap-2">
        <WarningCircleIcon size={14} className="mt-0.5 shrink-0 p-warning" />
        <div className="min-w-0 space-y-2">
          <p>{message}</p>
          {failed !== null && <p data-connect-failed className="p-danger">Cloudflare did not connect: {failed}</p>}
          <button
            type="button"
            data-connect-cloudflare
            onClick={() => { setFailed(null); connectCloudflare(onConnected, setFailed); }}
            className="inline-flex items-center rounded-md border p-border px-2 py-1 p-t-control p-warning p-card-hover"
          >
            {action}
          </button>
        </div>
      </div>
    </div>
  );
}
