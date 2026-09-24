import type { ReactNode } from "react";
import { GlobeIcon, UsersIcon } from "@phosphor-icons/react";
import { SHARE_ICON } from "@/components/drive/DriveTiles";

export interface Person {
  readonly name: string;
  readonly email: string;
}

export type Access =
  | { readonly kind: "private" }
  | { readonly kind: "people"; readonly people: readonly Person[] }
  | { readonly kind: "link" };

export type ShareKind = "live" | "blueprint" | "workspace";

export const LIST = new Intl.ListFormat("en-GB", { type: "conjunction" });

export const KIND: Record<ShareKind, { label: string; icon: ReactNode }> = {
  live: { label: "Live", icon: SHARE_ICON.live },
  blueprint: { label: "Blueprint", icon: SHARE_ICON.blueprint },
  workspace: { label: "Workspace", icon: SHARE_ICON.workspace },
};

export function AccessGlyph({ access }: { access: Access | undefined }) {
  if (access === undefined || access.kind === "private") return null;

  return access.kind === "link"
    ? <GlobeIcon size={13} className="shrink-0 p-text-4" aria-label="Anyone with the link" />
    : <UsersIcon size={13} className="shrink-0 p-text-4" aria-label={`Shared with ${String(access.people.length)}`} />;
}
