/** The server grant is the read set plus the ticked set; the dialog renders, never decides. */
import { Effect } from 'effect';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import { CaretDownIcon, CaretRightIcon, GlobeIcon, IdentificationCardIcon, UserCircleIcon, UsersIcon, WarningIcon } from "@phosphor-icons/react";
import * as v from "valibot";
import { LiveShareRecordSchema, SlateReachSchema, SHARE_SPEND_CAP_USD_PER_DAY, SHARE_VIEWER_REQUESTS_PER_MINUTE, type LiveShareCreated, type LiveShareRecord, type LiveShareVisibility, type ShareMode, type SlateCapabilityGraph, type SlateGraphNamespace, type SlateGraphMember, type SlateReach } from "@kinu.run/core";
import { showing, detach } from "@kinu.run/core/obs";
import { FilledButton } from "@/components/ui/FilledButton";
import { CopyButton } from "@/components/ui/CopyButton";
import { listShare, revokeShare, setShareMode, shareLive } from "@/lib/shared-api";
import { ShareListing, type ListShare } from "./ShareListing";
import { answered } from "./BlueprintShareForm";
import { AccessPicker, EmailsField, emailsOf, Failure, Lead, StopButton, type AccessOption } from "./ShareParts";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";

export interface LiveShareFixture {
  graph: SlateReach;
  liveShares: LiveShareRecord[];
}

/** The ticked members, as the share route takes them. */
const approvalsOf = (approved: ReadonlySet<string>) => [...approved]
  .map((key) => v.parse(v.tuple([v.string(), v.string(), v.string()]), JSON.parse(key)))
  .map(([slateId, namespace, member]) => ({ slate: slateId, namespace, member }));

interface Approval {
  slate: string;
  namespace: string;
  member: string;
}

function approvalKey(approval: Approval): string {
  return JSON.stringify([approval.slate, approval.namespace, approval.member]);
}

/** Each impact as a person reads it beside the member that has it. */
const IMPACT_WORDS: Readonly<Record<SlateGraphMember["impact"], string>> = {
  observe: "reads", mutate: "changes", externalSend: "sends out", execute: "runs", delegate: "delegates", administer: "administers",
};

const ACCESS: readonly AccessOption<LiveShareVisibility>[] = [
  { id: "users", icon: <UsersIcon size={15} />, label: "Only people you add", detail: "Anyone else who gets the link sees nothing." },
  { id: "public", icon: <GlobeIcon size={15} />, label: "Anyone with the link", detail: "No sign-in needed. It still runs as you." },
];

/**
 * Whose access the shared slate's server acts with (docs/SLATE-SHARING-NIMBUS.md §2). Their own: none of the owner's,
 * each person's own parts on their own connections, and it can be listed. Mine: the owner's connections within the
 * reach listed, each change waiting for the owner, never listed in the Gallery.
 */
const MODES: readonly { id: ShareMode; icon: ReactNode; label: string; detail: string }[] = [
  { id: "own", icon: <UserCircleIcon size={16} />, label: "Their own access", detail: "Each person sees their own data, on their own connections. Nothing of yours is used." },
  { id: "owner", icon: <IdentificationCardIcon size={16} />, label: "My access", detail: "It acts with your connections, within the reach below. Each change waits for you." },
];

/**
 * The choice of mode, both shown, as it decides what the slate can do with whose data. `unbuilt`: the slate has no
 * version yet whose reach the owner could approve, so their access waits until it has been opened once.
 */
function ModeChoice({ value, onChange, disabled, unbuilt }: { value: ShareMode; onChange: (mode: ShareMode) => void; disabled: boolean; unbuilt: boolean }) {
  return (
    <div role="radiogroup" aria-label="It runs with" className="p-group">
      {MODES.map((mode) => (
        <button key={mode.id} type="button" role="radio" aria-checked={value === mode.id} data-share-mode={mode.id} onClick={() => onChange(mode.id)}
          disabled={disabled || (mode.id === "owner" && unbuilt)}
          className={`flex w-full items-start gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--c-elevated)] ${value === mode.id ? "bg-[var(--c-elevated)]" : ""}`}>
          <span className={`mt-0.5 flex shrink-0 ${value === mode.id ? "p-accent" : "p-text-3"}`}>{mode.icon}</span>
          <span className="min-w-0 flex-1">
            <span className="block p-row-text font-medium p-text">{mode.label}</span>
            <span className="block p-meta p-text-3">{mode.id === "owner" && unbuilt ? "Open it once first, so there is a version of it to approve." : mode.detail}</span>
          </span>
          <span className={`mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border ${value === mode.id ? "border-[var(--c-accent)]" : "border-[var(--c-border-strong)]"}`}>
            {value === mode.id && <span className="size-2 rounded-full bg-[var(--c-accent)]" />}
          </span>
        </button>
      ))}
    </div>
  );
}

/** What "My access" lets the people it is shared with do, said before it is chosen; it is never listed. */
function OwnerWarning() {
  return (
    <p data-share-owner-warning className="flex gap-2 rounded-lg p-tint-warning px-3 py-2 p-meta p-text">
      <WarningIcon size={14} className="mt-0.5 shrink-0 p-warning" />
      <span>Everyone you share it with acts as you, within this reach: what it reads of yours, they see. Any change it makes waits for you to approve it, and a change to its code stops it until you approve the new reach. It can't be listed in the Gallery.</span>
    </p>
  );
}

/** The reach the owner's access acts within, and what choosing it means; a spinner while the reach is read. */
function OwnerReach({ graph, failed, visibility, approved, onToggle, disabled }: {
  graph: SlateReach | null;
  failed: boolean;
  visibility: LiveShareVisibility;
  approved: ReadonlySet<string>;
  onToggle: (approval: Approval) => void;
  disabled: boolean;
}) {
  if (graph === null) return failed ? null : <div className="flex justify-center py-2"><Loader size="sm" /></div>;

  return (
    <>
      {graph.namespaces.length > 0 && <Reach graph={graph} visibility={visibility} approved={approved} onToggle={onToggle} disabled={disabled} />}
      <OwnerWarning />
    </>
  );
}

/** Share, or, while a stopped share's reach is shown, approving it again. */
function PrimaryAction({ reviewing, busy, canShare, canApprove, onShare, onApprove }: {
  reviewing: boolean;
  busy: boolean;
  canShare: boolean;
  canApprove: boolean;
  onShare: () => void;
  onApprove: () => void;
}) {
  if (reviewing) return <FilledButton className="h-8 px-4 text-sm" onClick={onApprove} disabled={busy || !canApprove} data-share-approve-reach>Approve the new reach</FilledButton>;

  return (
    <FilledButton className="h-8 px-4 text-sm" onClick={onShare} disabled={!canShare} data-share-submit>
      {busy ? <><Loader size="sm" /><span className="ml-1">Sharing…</span></> : "Share"}
    </FilledButton>
  );
}

/** Who a share lets in, as the share records them. */
function whoCanOpen(share: LiveShareRecord): string {
  if (share.visibility === "public") return "Anyone with the link can open it.";

  return share.users.length === 0 ? "Only you can open it." : `${share.users.join(", ")} can open it.`;
}

function NamespaceRow({ row, visibility, approved, onToggle, disabled }: {
  row: SlateGraphNamespace;
  visibility: LiveShareVisibility;
  approved: ReadonlySet<string>;
  onToggle: (approval: Approval) => void;
  disabled: boolean;
}) {
  let members: ReactNode;

  if (row.problem !== undefined) {
    members = <p className="p-badge-danger inline-block rounded px-2 py-0.5 text-[11px]">{row.problem}</p>;
  } else if (row.members.length === 0) {
    members = <p className="p-text-4">No members.</p>;
  } else {
    members = (
      <ul className="space-y-1">
        {row.members.map((member) => {
          const approval = { slate: row.slate, namespace: row.namespace, member: member.member };
          const key = approvalKey(approval);
          const risk = visibility === "public" ? member.risk.public : member.risk.users;

          if (member.impact === "observe") {
            return (
              <li key={key} className="flex items-center gap-2">
                <span className="font-mono p-text-2">{member.member}</span>
                <span className="p-text-4">{IMPACT_WORDS[member.impact]}</span>
                <span className="ml-auto p-text-4">Always on</span>
              </li>
            );
          }

          const checked = approved.has(key);

          return (
            <li key={key} className={`-mx-2 rounded-md px-2 py-1.5 ${checked ? "p-tint-warning" : ""}`}>
              <label className="flex cursor-pointer items-center gap-2">
                <span className="font-mono p-text">{member.member}</span>
                <span className="p-text-3">{IMPACT_WORDS[member.impact]}</span>
                <input type="checkbox" checked={checked} onChange={() => onToggle(approval)} disabled={disabled}
                  className="ml-auto size-4 accent-[var(--c-accent)]" aria-describedby={`risk-${key}`} data-approve={`${row.namespace}.${member.member}`} />
              </label>
              <p id={`risk-${key}`} className="mt-0.5 leading-relaxed p-text-3">{risk}</p>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <li className="space-y-1.5 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-xs font-medium p-text">{row.namespace}</span>
        {row.title !== row.namespace && <span className="p-text-4">{row.title}</span>}
      </div>
      {members}
    </li>
  );
}

function Reach({ graph, visibility, approved, onToggle, disabled }: {
  graph: SlateCapabilityGraph;
  visibility: LiveShareVisibility;
  approved: ReadonlySet<string>;
  onToggle: (approval: Approval) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);

  const counts = useMemo(() => {
    const members = graph.namespaces.flatMap((row) => row.problem === undefined ? row.members : []);

    return { read: members.filter((member) => member.impact === "observe").length, acting: members.filter((member) => member.impact !== "observe").length };
  }, [graph]);

  const names = [...new Set(graph.namespaces.filter((row) => row.slate === graph.slate).map((row) => row.title))].join(", ");
  let changes = "reading only";

  if (approved.size > 0) changes = `${String(approved.size)} ${approved.size === 1 ? "change" : "changes"} allowed`;

  return (
    <div className="p-group">
      <button type="button" aria-expanded={open} data-share-reach onClick={() => setOpen((shown) => !shown)}
        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--c-elevated)]">
        <span className="w-14 shrink-0 p-row-text font-medium p-text">Reach</span>
        <span className="flex min-w-0 flex-1 p-meta p-text-3">
          <span className="truncate">{names}</span>
          <span className="shrink-0 whitespace-pre"> · {changes}</span>
        </span>
        {open ? <CaretDownIcon size={13} className="shrink-0 p-text-4" /> : <CaretRightIcon size={13} className="shrink-0 p-text-4" />}
      </button>
      {open && (
        <div className="space-y-2 border-t p-border px-3.5 py-2 text-xs">
          <p className="p-text-3">Everything here uses your connections. Reading is on; each change stays off until you tick it.</p>
          {graph.slates.map((slateId) => {
            const rows = graph.namespaces.filter((row) => row.slate === slateId);

            if (rows.length === 0) return null;

            const via = slateId === graph.slate ? null
              : graph.namespaces.find((row) => row.namespace === `slates.${slateId}`)?.slate ?? slateId;

            return (
              <div key={slateId} className={via === null ? "" : "border-l-2 p-border pl-3"}>
                {via !== null && <div className="p-text-3">via <span className="font-mono">{via}</span> → <span className="font-mono">{slateId}</span></div>}
                <ul className="divide-y divide-[var(--c-border)]">
                  {rows.map((row) => (
                    <NamespaceRow key={`${row.slate}/${row.namespace}`} row={row} visibility={visibility} approved={approved} onToggle={onToggle} disabled={disabled} />
                  ))}
                </ul>
              </div>
            );
          })}
          <p className="p-text-2" data-grant-summary>
            People get {counts.read} read-only member{counts.read === 1 ? "" : "s"}. You allowed {approved.size} of {counts.acting} change{counts.acting === 1 ? "" : "s"}.
          </p>
        </div>
      )}
    </div>
  );
}

/** What a share runs with, as its row says it; an owner share whose code changed is stopped until approved again. */
function modeWords(row: LiveShareRecord): ReactNode {
  if (row.mode === "own") return "Their own access";

  return row.stale === true ? <span className="p-warning">Stopped: its code changed since you approved its reach</span> : "Your access";
}

function SharedNow({ shares, onStop, onOwnAccess, onReview, onList, disabled }: {
  shares: readonly LiveShareRecord[];
  onStop: (id: string) => void;
  /** Moves an owner share to each person's own access: nothing of the owner's is used from then on. */
  onOwnAccess: (id: string) => void;
  /** Shows a stopped owner share's new reach, for the owner to approve at the slate's new revision. */
  onReview: (id: string) => void;
  onList: (id: string, listing: Parameters<ListShare>[0]) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <p className="p-meta font-medium p-text-3">Shared now</p>
      <ul className="p-group">
        {shares.map((row) => (
          <li key={row.id} data-live-share={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2">
            <span className="flex shrink-0 p-text-3">{row.visibility === "public" ? <GlobeIcon size={14} /> : <UsersIcon size={14} />}</span>
            {/* Wide enough to read: on a phone the actions wrap under it. */}
            <span className="min-w-48 flex-1">
              <span className="block truncate p-meta p-text-2">
                {row.visibility === "public" ? "Anyone with the link" : row.users.join(", ") || "People you added"}
                {row.paused === true && <span className="p-warning"> · paused today: limit reached</span>}
              </span>
              <span data-live-share-mode={row.mode} className="block p-meta p-text-3">{modeWords(row)}</span>
            </span>
            {row.mode === "owner" && row.stale === true && (
              <Button size="xs" variant="secondary" data-live-share-review={row.id} onClick={() => onReview(row.id)} disabled={disabled}>Review the new reach</Button>
            )}
            {row.mode === "owner" && (
              <Button size="xs" variant="ghost" data-live-share-own={row.id} onClick={() => onOwnAccess(row.id)} disabled={disabled}>Use their own access</Button>
            )}
            <StopButton onStop={() => onStop(row.id)} disabled={disabled} />
            {/* Anyone can open it from a Gallery card only through its link. */}
            {row.visibility === "public" && <div className="basis-full"><ShareListing share={row} onList={(listing) => onList(row.id, listing)} disabled={disabled} /></div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LiveShareForm({ workspace, slate, rpc, onClose, onBusy, onListingPending, fixture }: {
  workspace: string;
  slate: string;
  rpc: WorkspaceRpc;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  onListingPending?: () => void;
  fixture?: LiveShareFixture;
}) {
  const [graph, setGraph] = useState<SlateReach | null>(fixture?.graph ?? null);
  const [shares, setShares] = useState<LiveShareRecord[]>(fixture?.liveShares ?? []);
  const [visibility, setVisibility] = useState<LiveShareVisibility>("users");
  const [mode, setMode] = useState<ShareMode>("own");
  // A stopped owner share whose new reach the form shows, for the owner to approve instead of making a share.
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [emails, setEmails] = useState("");
  const [approved, setApproved] = useState<ReadonlySet<string>>(new Set());
  const [fork, setFork] = useState(true);
  const [busy, setBusyState] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<LiveShareCreated & { listing?: "pending" } | null>(null);
  const setBusy = useCallback((next: boolean) => { setBusyState(next); onBusy(next); }, [onBusy]);

  useEffect(() => {
    if (fixture !== undefined) return;
    let live = true;
    detach(Effect.catchCause(Effect.map(Effect.promise(() => Promise.all([
      rpc("slate", [{ op: "graph", id: slate }]),
      rpc("slate", [{ op: "liveShares" }]),
    ])), ([drawn, rows]) => {
      if (!live) return;
      setGraph(answered(drawn, SlateReachSchema));
      setShares(answered(rows, v.array(LiveShareRecordSchema)).filter((share) => share.slate === slate && share.revokedAt === null));
    }), showing((chain) => { if (live) setErr(chain); })));

    return () => { live = false; };
  }, [fixture, rpc, slate]);

  const toggle = useCallback((approval: Approval) => {
    setApproved((previous) => {
      const next = new Set(previous);
      const key = approvalKey(approval);

      if (next.has(key)) next.delete(key); else next.add(key);

      return next;
    });
  }, []);

  const emailList = useMemo(() => emailsOf(emails), [emails]);
  // The owner's access is approved at a revision of the slate: none before it has been opened once.
  const revision = graph?.revision ?? null;
  const canShare = graph !== null && !busy && (visibility === "public" || emailList.length > 0) && (mode === "own" || revision !== null);

  const share = useCallback(() => detach(Effect.gen(function* () {
    if (!canShare) return;
    setBusy(true);
    setErr(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      // Their own access acts with nothing of the owner's: no change is allowed, whatever was ticked before switching.
      const result = yield* Effect.promise(async () => shareLive({
        workspace, slate, visibility, emails: visibility === "users" ? emailList : undefined, fork,
        ...(mode === "owner" && revision !== null ? { mode, revision, approved: approvalsOf(approved) } : { mode: "own", approved: [] }),
      }));

      setCreated(result);
      setShares((previous) => [result.share, ...previous]);

      if (result.listing === 'pending') onListingPending?.();
    }), showing(setErr)), Effect.sync(() => {
      setBusy(false);
    }));
  })), [canShare, approved, workspace, slate, visibility, emailList, mode, revision, fork, setBusy, onListingPending]);

  // Lists a share in the Gallery, or takes it off.
  const list = useCallback((shareId: string, listing: Parameters<ListShare>[0]) => detach(Effect.catchCause(Effect.gen(function* () {
    setErr(null);

    const updated = yield* Effect.promise(async () => listShare(listing === null ? { workspace, share: shareId, listed: false } : { workspace, share: shareId, listed: true, ...listing }));

    setShares((previous) => previous.map((row) => (row.id === updated.id ? updated : row)));
  }), showing(setErr))), [workspace]);

  // Approves a stopped owner share's reach again, at the revision the form read it at.
  const approveReach = useCallback(() => detach(Effect.gen(function* () {
    if (reviewing === null || revision === null) return;
    setBusy(true);
    setErr(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      const updated = yield* Effect.promise(async () => setShareMode({ workspace, share: reviewing, mode: "owner", revision, approved: approvalsOf(approved) }));

      setShares((previous) => previous.map((row) => (row.id === updated.id ? updated : row)));
      setReviewing(null);
    }), showing(setErr)), Effect.sync(() => setBusy(false)));
  })), [reviewing, revision, approved, workspace, setBusy]);

  const revoke = useCallback((shareId: string) => detach(Effect.gen(function* () {
    setErr(null);

    return yield* Effect.catchCause(Effect.gen(function* () {
      const revoked = yield* Effect.promise(async () => revokeShare({ workspace, share: shareId }));
      setShares((previous) => previous.filter((row) => row.id !== shareId));

      if (revoked.listing === 'pending') onListingPending?.();
    }), showing(setErr));
  })), [workspace, onListingPending]);

  const ownAccess = useCallback((shareId: string) => detach(Effect.gen(function* () {
    setErr(null);

    return yield* Effect.catchCause(Effect.gen(function* () {
      const updated = yield* Effect.promise(async () => setShareMode({ workspace, share: shareId, mode: "own" }));

      setShares((previous) => previous.map((row) => (row.id === updated.id ? updated : row)));
    }), showing(setErr));
  })), [workspace]);

  if (created !== null) {
    return (
      <>
        <div className="space-y-3 text-xs">
          <p className="p-notice-success rounded-md px-3 py-2" data-share-created>
            Shared. {whoCanOpen(created.share)}
            {created.listing === "pending" && " The list will catch up."}
          </p>
          {created.url === null ? (
            <p className="p-meta p-text-3">This deployment cannot make share links: it has no preview host or signing secret.</p>
          ) : (
            <div className="flex items-center gap-2">
              <a href={created.url} className="min-w-0 flex-1 break-all font-mono p-accent" target="_blank" rel="noopener noreferrer">{created.url}</a>
              <CopyButton value={created.url} what="the share link" className="p-btn-quiet rounded p-1" />
            </div>
          )}
        </div>
        <div className="flex justify-end"><FilledButton className="h-8 px-4 text-sm" onClick={onClose}>Done</FilledButton></div>
      </>
    );
  }

  const reaches = graph !== null && graph.namespaces.length > 0;

  const limits = reaches
    ? `Each person gets ${String(SHARE_VIEWER_REQUESTS_PER_MINUTE)} requests a minute; the share gets $${String(SHARE_SPEND_CAP_USD_PER_DAY)} of model spend a day.`
    : `Each person gets ${String(SHARE_VIEWER_REQUESTS_PER_MINUTE)} requests a minute.`;

  return (
    <>
      <div className="space-y-4">
        <Lead>People open your slate and use it, in your workspace.</Lead>
        {visibility === "users" && <EmailsField value={emails} onChange={setEmails} disabled={busy} placeholder="Add people by email" />}
        <AccessPicker options={ACCESS} value={visibility} onChange={setVisibility} disabled={busy} />
        <label className="flex items-start gap-3">
          <span className="flex w-7 shrink-0 justify-center pt-1">
            <input type="checkbox" checked={fork} onChange={(event) => setFork(event.target.checked)} disabled={busy} data-share-fork className="size-4 accent-[var(--c-accent)]" />
          </span>
          <span>
            <span className="block p-row-text font-medium p-text">Let them fork it</span>
            <span className="block p-meta p-text-3">A fork is their own copy, on their own connections.</span>
          </span>
        </label>
        <ModeChoice value={mode} onChange={setMode} disabled={busy || reviewing !== null} unbuilt={graph !== null && revision === null} />
        {mode === "owner" && <OwnerReach graph={graph} failed={err !== null} visibility={visibility} approved={approved} onToggle={toggle} disabled={busy} />}
        {graph !== null && <p className="p-meta p-text-3" data-share-limits>{limits}</p>}
        {shares.length > 0 && (
          <SharedNow shares={shares} onStop={(id) => revoke(id)} onOwnAccess={ownAccess} onList={list} disabled={busy}
            onReview={(id) => { setMode("owner"); setReviewing(id); }} />
        )}
        <Failure message={err} />
      </div>
      <div className="flex justify-end gap-2 border-t p-border pt-4">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <PrimaryAction reviewing={reviewing !== null} busy={busy} canShare={canShare} canApprove={revision !== null} onShare={share} onApprove={approveReach} />
      </div>
    </>
  );
}
