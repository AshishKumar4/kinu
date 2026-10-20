import { WarningCircleIcon } from "@phosphor-icons/react";
import { cloudflareReconnectPath } from "@/lib/user-api";
import { connectCloudflareInHelper } from "@/lib/connect-window";

interface CloudflareAIConnectNoticeProps {
  returnTo: string;
  message?: string;
  /** The link's own words, where connecting is signing in again. */
  action?: string;
}

export function CloudflareAIConnectNotice({
  returnTo,
  message = "Cloudflare Workers AI is not connected for this account.",
  action = "Connect Cloudflare Workers AI",
}: CloudflareAIConnectNoticeProps) {
  return (
    <div className="rounded-md px-3 py-2 text-xs p-notice-warning">
      <div className="flex items-start gap-2">
        <WarningCircleIcon size={14} className="mt-0.5 shrink-0 p-warning" />
        <div className="min-w-0 space-y-2">
          <p>{message}</p>
          <a
            href={cloudflareReconnectPath(returnTo)}
            onClick={(event) => { if (connectCloudflareInHelper(returnTo)) event.preventDefault(); }}
            className="inline-flex items-center rounded-md border p-border px-2 py-1 p-t-control p-warning p-card-hover"
          >
            {action}
          </a>
        </div>
      </div>
    </div>
  );
}
