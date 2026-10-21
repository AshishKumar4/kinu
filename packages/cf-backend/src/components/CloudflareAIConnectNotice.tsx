import { cloudflareReconnectPath } from "@/lib/user-api";
import { connectCloudflareInHelper } from "@/lib/connect-window";
import { Notice } from "@/components/ui/Notice";
import { buttonClass } from "@/components/ui/Button";

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
    <Notice tone="warning" action={
      <a
        href={cloudflareReconnectPath(returnTo)}
        onClick={(event) => { if (connectCloudflareInHelper(returnTo)) event.preventDefault(); }}
        className={`${buttonClass({ size: "sm" })} shrink-0`}
      >
        {action}
      </a>}>
      {message}
    </Notice>
  );
}
