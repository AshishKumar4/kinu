import { useState, type ReactNode } from "react";
import { pictureUrl } from "@/lib/user-api";

/** A slate's latest capture, or `fallback` while it has none or when that picture fails to load. */
export function SlatePicture({ workspace, slate, className, fallback }: {
  workspace: string;
  slate: { readonly id: string; readonly title: string; readonly picture?: string | null } | undefined;
  className: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState<string | null>(null);

  if (slate === undefined || slate.picture === undefined || slate.picture === null) return fallback;
  const src = pictureUrl(workspace, slate.id, slate.picture);

  if (src === failed) return fallback;

  return <img src={src} alt={slate.title} loading="lazy" decoding="async" onError={() => setFailed(src)} className={className} data-slate-picture />;
}
