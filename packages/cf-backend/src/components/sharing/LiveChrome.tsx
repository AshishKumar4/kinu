/**
 * The live page around a shared slate: a thin bar with its name, whose it is, who is here, Edit for those who may change
 * it and Fork for everyone, the one way to a copy of their own (the owner, 2026-10-15), which signs a visitor in first;
 * and what the page shows when a person's session ends under them.
 */
import { Button } from "@cloudflare/kumo";
import { GitForkIcon, PencilSimpleIcon, ShareNetworkIcon } from "@phosphor-icons/react";
import type { RoomEnded, RoomPresence, RoomSession } from "@kinu.run/core";
import { Avatar } from "@/components/ui/Avatar";
import { FilledButton } from "@/components/ui/FilledButton";
import { KinuLogo } from "@/components/ui/KinuLogo";
import { Presence } from "./Presence";
import { firstName, nameOf } from "./words";

export function LiveBar({ session, presence, onShare, onEdit, onFork }: {
  session: RoomSession;
  presence: RoomPresence;
  /** The owner's sheet; null for everyone else. */
  onShare: (() => void) | null;
  onEdit: () => void;
  onFork: () => void;
}) {
  // Everyone here but this session's own person.
  const here = presence.here.filter((each) => each.person.email !== session.me?.email).map((each) => nameOf(each.person));

  return (
    <header data-live-bar className="flex h-12 shrink-0 items-center gap-3 border-b p-border p-bg px-3 sm:px-4">
      <a href="/" aria-label="Kinu home" className="flex shrink-0 items-center"><KinuLogo /></a>
      <span className="h-4 w-px shrink-0 bg-[var(--c-border)]" />
      <span className="min-w-0 truncate p-row-text font-medium p-text">{session.title}</span>
      <span className="hidden shrink-0 items-center gap-1.5 p-meta p-text-3 sm:inline-flex"><Avatar name={nameOf(session.owner)} size={18} />{nameOf(session.owner)}</span>
      <span className="ml-auto" />
      <Presence here={here} viewing={presence.signedOut} />
      {session.mayEdit && <Button size="sm" variant="secondary" aria-label="Edit" data-live-edit onClick={onEdit}><PencilSimpleIcon size={13} /><span className="hidden sm:inline">Edit</span></Button>}
      {onShare !== null && <Button size="sm" variant="secondary" aria-label="Share" data-live-share onClick={onShare}><ShareNetworkIcon size={13} /><span className="hidden sm:inline">Share</span></Button>}
      {(session.mayFork || session.me === null) && <Button size="sm" variant="secondary" aria-label="Fork" data-live-fork onClick={onFork}><GitForkIcon size={13} /><span className="hidden sm:inline">Fork</span></Button>}
    </header>
  );
}

/** Why a person's session ended under them, pushed to their open page at once (security §2.5). */
export function Ended({ ended, slate, onAsk }: { ended: RoomEnded; slate: string; onAsk: () => void }) {
  const by = firstName(ended.by);
  const said = ended.kind === "removed" ? `${by} removed you from ${slate}` : `${by} stopped sharing this slate.`;

  return (
    <div data-live-ended={ended.kind} className="absolute inset-0 z-30 flex items-center justify-center bg-[color-mix(in_srgb,var(--c-bg)_75%,transparent)] backdrop-blur-[2px]">
      <div role="alertdialog" aria-label={said} className="mx-4 max-w-xs border p-border p-overlay p-5 text-center">
        <Avatar name={nameOf(ended.by)} size={32} />
        <p className="mt-3 p-heading text-[15px] p-text">{said}</p>
        {ended.kind === "removed" && <p className="mt-1 p-row-text p-text-2">What you saw stays with you.</p>}
        {/* The room has no one to ask through once a session ended: an email to the owner still offers a way on. */}
        <div className="mt-4"><FilledButton data-live-ask-owner onClick={onAsk}>Email {by}</FilledButton></div>
      </div>
    </div>
  );
}
