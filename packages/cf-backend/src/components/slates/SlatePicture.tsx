import { useState, type ReactNode } from "react";
import { pictureUrl } from "@/lib/user-api";

/**
 * A slate's latest capture, or `fallback` while it has none or when that picture fails to load. `at` is where its
 * pictures are read: the owner's own by default, a listed slate's from the Gallery.
 */
export function SlatePicture({ workspace, slate, className, fallback, at = pictureUrl }: {
  workspace: string;
  slate: { readonly id: string; readonly title: string; readonly picture?: string | null } | undefined;
  className: string;
  fallback: ReactNode;
  at?: (workspace: string, slate: string, picture: string) => string;
}) {
  const [failed, setFailed] = useState<string | null>(null);

  if (slate === undefined || slate.picture === undefined || slate.picture === null) return fallback;
  const src = at(workspace, slate.id, slate.picture);

  if (src === failed) return fallback;

  return <img src={src} alt={slate.title} loading="lazy" decoding="async" onError={() => setFailed(src)} className={className} data-slate-picture />;
}
