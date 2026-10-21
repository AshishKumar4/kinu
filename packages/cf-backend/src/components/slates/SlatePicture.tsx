import { useState, type ReactNode } from "react";
import { pictureUrl } from "@/lib/user-api";
import { pictureSrc } from "@kinu.run/core/web/picture-src";
import { CaptureMat } from "@/components/ui/Tiles";

/**
 * A slate's latest capture, or `fallback` while it has none or when that picture fails to load. `at` is where its
 * pictures are read: the owner's own by default, a listed slate's from the Gallery.
 */
export function SlatePicture({ workspace, slate, className, fallback, at = pictureUrl, mat = false }: {
  workspace: string;
  slate: { readonly id: string; readonly title: string; readonly picture?: string | null } | undefined;
  className: string;
  fallback: ReactNode;
  at?: (workspace: string, slate: string, picture: string) => string;
  /** A tile's cover: the capture on its mat (`CaptureMat`); the fallback is drawn bare. */
  mat?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);

  if (slate === undefined || slate.picture === undefined || slate.picture === null) return fallback;
  const src = pictureSrc(at(workspace, slate.id, slate.picture));

  if (src === failed) return fallback;

  const picture = <img src={src} alt={slate.title} loading="lazy" decoding="async" onError={() => setFailed(src)} className={className} data-slate-picture />;

  return mat ? <CaptureMat>{picture}</CaptureMat> : picture;
}
