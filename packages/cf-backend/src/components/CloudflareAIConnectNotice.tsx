import { WarningCircleIcon } from "@phosphor-icons/react";
import { CLOUDFLARE_CONNECT_PATH } from "@/lib/user-api";
import { beginConnect } from "@/lib/connect-window";

interface CloudflareAIConnectNoticeProps {
  /** Rereads what the connection changes, once the connect has ended. */
  onConnected: () => void;
  message?: string;
  action?: string;
}

export function CloudflareAIConnectNotice({
  onConnected,
  message = "Cloudflare Workers AI is not connected for this account.",
  action = "Connect Cloudflare Workers AI",
}: CloudflareAIConnectNoticeProps) {
  return (
    <div className="rounded-md px-3 py-2 text-xs p-notice-warning">
      <div className="flex items-start gap-2">
        <WarningCircleIcon size={14} className="mt-0.5 shrink-0 p-warning" />
        <div className="min-w-0 space-y-2">
          <p>{message}</p>
          <button
            type="button"
            onClick={() => { beginConnect().start(CLOUDFLARE_CONNECT_PATH, onConnected); }}
            className="inline-flex items-center rounded-md border p-border px-2 py-1 p-t-control p-warning p-card-hover"
          >
            {action}
          </button>
        </div>
      </div>
    </div>
  );
}
