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
    <div className="rounded-md border border-amber-400/40 px-3 py-2 text-xs text-amber-100" style={{ background: "rgba(245,158,11,0.08)" }}>
      <div className="flex items-start gap-2">
        <WarningCircleIcon size={14} className="mt-0.5 shrink-0 text-amber-300" />
        <div className="min-w-0 space-y-2">
          <p>{message}</p>
          <a
            href={cloudflareReconnectPath(returnTo)}
            className="inline-flex items-center rounded-md border border-amber-300/40 px-2 py-1 text-[11px] font-medium text-amber-100 hover:bg-amber-300/10"
          >
            Connect Cloudflare Workers AI
          </a>
        </div>
      </div>
    </div>
  );
}
