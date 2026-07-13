import { WarningCircleIcon } from "@phosphor-icons/react";
import { cloudflareReconnectPath } from "@/lib/user-api";

interface CloudflareAIConnectNoticeProps {
  returnTo: string;
  message?: string;
}

export function CloudflareAIConnectNotice({
  returnTo,
  message = "Cloudflare Workers AI is not connected for this account.",
}: CloudflareAIConnectNoticeProps) {
  return (
    <div className="rounded-md px-3 py-2 text-xs p-notice-warning">
      <div className="flex items-start gap-2">
        <WarningCircleIcon size={14} className="mt-0.5 shrink-0 p-warning" />
        <div className="min-w-0 space-y-2">
          <p>{message}</p>
          <a
            href={cloudflareReconnectPath(returnTo)}
            className="inline-flex items-center rounded-md border p-border px-2 py-1 text-[11px] font-medium p-warning hover:p-card-hover"
          >
            Connect Cloudflare Workers AI
          </a>
        </div>
      </div>
    </div>
  );
}
