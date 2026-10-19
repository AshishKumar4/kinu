/** The server grant is the read set plus the ticked set; the dialog renders, never decides. */
import { Effect } from 'effect';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import { CaretDownIcon, CaretRightIcon, FileDashedIcon, GlobeIcon, IdentificationCardIcon, PackageIcon, UserCircleIcon, UsersIcon, WarningIcon } from "@phosphor-icons/react";
import * as v from "valibot";
import { LiveShareRecordSchema, SlateReachSchema, SHARE_SPEND_CAP_USD_PER_DAY, SHARE_VIEWER_REQUESTS_PER_MINUTE, type LiveShareBody, type LiveShareCreated, type LiveShareRecord, type LiveShareVisibility, type SharePreapproval, type ShareMode, type SlateCapabilityGraph, type SlateGraphNamespace, type SlateGraphMember, type SlateReach } from "@kinu.run/core";
import { showing, detach } from "@kinu.run/core/obs";
import { FilledButton } from "@/components/ui/FilledButton";
import { CopyButton } from "@/components/ui/CopyButton";
import { listShare, readPreapprovals, revokeShare, setShareMode, shareLive, withdrawPreapproval } from "@/lib/shared-api";
import { ShareListing, type ListShare } from "./ShareListing";
import { answered } from "./BlueprintShareForm";
import { AccessPicker, EmailsField, emailsOf, Failure, Lead, StopButton, type AccessOption } from "./ShareParts";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";

export interface LiveShareFixture {
  graph: SlateReach;
  liveShares: LiveShareRecord[];
  /** Why the shared slate does not run, as its preview would refuse it. */
  refused?: string;
  /** What the owner answered "Always for this slate" to, standing now. */
  preapproved?: SharePreapproval[];
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
const MODES: readonly CardOption<ShareMode>[] = [
  { id: "own", icon: <UserCircleIcon size={16} />, label: "Their own access", detail: "Each person sees their own data, on their own connections. Nothing of yours is used." },
  { id: "owner", icon: <IdentificationCardIcon size={16} />, label: "My access", detail: "It acts with your connections, within the reach below. Each change waits for you." },
];

/** One choice of a few, each with what it means, all shown at once. `marker` names its data attribute. */
interface CardOption<T extends string> {
  readonly id: T;
  readonly icon: ReactNode;
  readonly label: string;
  readonly detail: string;
  readonly disabled?: boolean;
}

function ChoiceCards<T extends string>({ label, marker, options, value, onChange, disabled }: {
  label: string;
  marker: `data-${string}`;
  options: readonly CardOption<T>[];
  value: T;
  onChange: (id: T) => void;
  disabled: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="p-group">
      {options.map((option) => (
        <button key={option.id} type="button" role="radio" aria-checked={value === option.id} {...{ [marker]: option.id }} onClick={() => onChange(option.id)}
          disabled={disabled || option.disabled === true}
          className={`flex w-full items-start gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--c-elevated)] ${value === option.id ? "bg-[var(--c-elevated)]" : ""}`}>
          <span className={`mt-0.5 flex shrink-0 ${value === option.id ? "p-accent" : "p-text-3"}`}>{option.icon}</span>
          <span className="min-w-0 flex-1">
            <span className="block p-row-text font-medium p-text">{option.label}</span>
            <span className="block p-meta p-text-3">{option.detail}</span>
          </span>
          <span className={`mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border ${value === option.id ? "border-[var(--c-accent)]" : "border-[var(--c-border-strong)]"}`}>
            {value === option.id && <span className="size-2 rounded-full bg-[var(--c-accent)]" />}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * The choice of mode, both shown, as it decides what the slate can do with whose data. `unbuilt`: the slate has no
 * version yet whose reach the owner could approve, so their access waits until it has been opened once.
 */
function ModeChoice({ value, onChange, disabled, unbuilt, emptyCopy }: {
  value: ShareMode;
  onChange: (mode: ShareMode) => void;
  disabled: boolean;
  unbuilt: boolean;
  /** An empty copy runs on each person's own access: it has nothing of the owner's to act on. */
  emptyCopy: boolean;
}) {
  const ownerAccess = (mode: CardOption<ShareMode>) => {
    if (emptyCopy) return { ...mode, disabled: true, detail: "An empty copy runs on each person's own access." };

    return unbuilt ? { ...mode, disabled: true, detail: "Open it once first, so there is a version of it to approve." } : mode;
  };

  const options = MODES.map((mode) => (mode.id === "owner" ? ownerAccess(mode) : mode));

  return <ChoiceCards label="It runs with" marker="data-share-mode" options={options} value={value} onChange={onChange} disabled={disabled} />;
}

/**
 * What the people it is first shared with start from (docs/SLATE-SHARING-NIMBUS.md, H7): the slate as it is, or a copy of
 * its code with nothing in it, shared in its place, so what this slate already holds stays the owner's.
 */
type ShareStart = NonNullable<LiveShareBody["start"]>;

const STARTS: readonly CardOption<ShareStart>[] = [
  { id: "as-is", icon: <PackageIcon size={16} />, label: "As it is now", detail: "They see what it holds now, and what it holds next." },
  { id: "empty", icon: <FileDashedIcon size={16} />, label: "An empty copy", detail: "A copy of its code, holding nothing yet, is shared instead. This one stays as it is." },
];

function StartChoice({ value, onChange, disabled }: { value: ShareStart; onChange: (start: ShareStart) => void; disabled: boolean }) {
  return <ChoiceCards label="They start with" marker="data-share-start" options={STARTS} value={value} onChange={onChange} disabled={disabled} />;
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

  if (row.stale !== true) return "Your access";

  const editor = row.editedBy;

  return <span className="p-warning">Stopped: {editor === null ? "its code changed" : <>changed by {editor}</>} since you approved its reach</span>;
}

/** Each person a share names, and whether they edit it or use it. */
function SharedPeople({ row }: { row: LiveShareRecord }) {
  return (
    <ul className="mt-0.5 space-y-0.5">
      {row.users.map((email) => {
        const edits = row.editors.includes(email);

        return (
          <li key={email} data-live-share-person={email} data-live-share-role={edits ? "edit" : "use"} className="flex items-center gap-2 p-meta">
            <span className="min-w-0 flex-1 truncate p-text-2">{email}</span>
            <span className={`shrink-0 ${edits ? "p-accent" : "p-text-3"}`}>{edits ? "Edits" : "Uses"}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The people being added, each to use it or also to edit it: an editor changes the slate from their own workspace's
 * agent, in the owner's workspace (docs/SLATE-SHARING-NIMBUS.md, editors). Only people added by name can edit.
 */
function PeopleRoles({ people, editors, onRole, ownerAccess, disabled }: {
  people: readonly string[];
  editors: ReadonlySet<string>;
  onRole: (email: string, edits: boolean) => void;
  /** On the owner's access, an editor's change stops the share until its reach is approved again. */
  ownerAccess: boolean;
  disabled: boolean;
}) {
  if (people.length === 0) return null;

  const anyEditor = people.some((email) => editors.has(email));

  return (
    <div className="space-y-1.5">
      <ul className="p-group">
        {people.map((email) => (
          <li key={email} data-share-person={email} className="flex items-center gap-3 px-3.5 py-2">
            <span className="min-w-0 flex-1 truncate p-meta p-text-2">{email}</span>
            <div role="radiogroup" aria-label={`What ${email} can do`} className="flex shrink-0 rounded-md p-fill p-0.5">
              {([["use", "Use"], ["edit", "Edit"]] as const).map(([role, label]) => {
                const on = (role === "edit") === editors.has(email);

                return (
                  <button key={role} type="button" role="radio" aria-checked={on} data-share-person-role={role} disabled={disabled} onClick={() => onRole(email, role === "edit")}
                    className={`rounded px-2.5 py-0.5 text-xs ${on ? "p-surface font-medium p-text shadow-sm" : "p-text-3"}`}>{label}</button>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
      {anyEditor && (
        <p data-share-editors-note className="p-meta p-text-3">
          People who edit change it from their own workspace&apos;s agent, here in yours.
          {ownerAccess && " Each change stops it on your access until you approve its reach again."}
        </p>
      )}
    </div>
  );
}

/**
 * Why the shared slate does not run, as its preview refused it: its own files must build alone once it is shared. Nothing
 * while it is shared with no one, or runs.
 */
function NotRunning({ reason, shared }: { reason: string | null; shared: boolean }) {
  if (reason === null || !shared) return null;

  return <p role="status" data-share-broken className="flex gap-2 rounded-lg p-tint-warning px-3 py-2 p-meta p-text"><WarningIcon size={14} className="mt-0.5 shrink-0 p-warning" /><span>{reason}</span></p>;
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
          <li key={row.id} data-live-share={row.id} className="space-y-1.5 px-3.5 py-2">
            {/* Who and on whose access, then what the owner can do with it, then its place in the Gallery: one line each. */}
            <div className="flex items-start gap-3">
              <span className="flex shrink-0 pt-0.5 p-text-3">{row.visibility === "public" ? <GlobeIcon size={14} /> : <UsersIcon size={14} />}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate p-meta p-text-2">
                  {row.visibility === "public" ? "Anyone with the link" : "People you added"}
                  {row.paused === true && <span className="p-warning"> · paused today: limit reached</span>}
                </span>
                <span data-live-share-mode={row.mode} className="block p-meta p-text-3">{modeWords(row)}</span>
                {row.visibility === "users" && <SharedPeople row={row} />}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pl-[26px]">
              {row.mode === "owner" && row.stale === true && (
                <Button size="xs" variant="secondary" data-live-share-review={row.id} onClick={() => onReview(row.id)} disabled={disabled}>Review the new reach</Button>
              )}
              {row.mode === "owner" && (
                <Button size="xs" variant="ghost" data-live-share-own={row.id} onClick={() => onOwnAccess(row.id)} disabled={disabled}>Use their own access</Button>
              )}
              <StopButton onStop={() => onStop(row.id)} disabled={disabled} />
            </div>
            {/* Anyone can open it from a Gallery card only through its link. */}
            {row.visibility === "public" && <div className="pl-[26px]"><ShareListing share={row} onList={(listing) => onList(row.id, listing)} disabled={disabled} /></div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A standing approval's key: the slate that makes the call, the member, and its root. */
const standingKey = (entry: SharePreapproval) => `${entry.slate}/${entry.namespace}.${entry.member}`;

/** The root a standing approval holds to, as a person reads it; none when it holds to no one root. */
const rootWords = (root: Readonly<Record<string, string>>) => Object.entries(root).map(([key, value]) => `${key} ${value}`).join(" · ");

/**
 * What the owner answered "Always for this slate" to, standing now: each change named as the reach names it, and taken
 * back from every share of the slate on their access in one press.
 */
function AlwaysAllowed({ standing, graph, onWithdraw, disabled }: {
  standing: readonly SharePreapproval[];
  graph: SlateReach | null;
  onWithdraw: (entry: SharePreapproval) => void;
  disabled: boolean;
}) {
  if (standing.length === 0) return null;

  const titleOf = (entry: SharePreapproval) => graph?.namespaces.find((row) => row.slate === entry.slate && row.namespace === entry.namespace)?.title ?? entry.namespace;

  return (
    <div data-share-always className="space-y-1.5">
      <p className="p-meta font-medium p-text-3">Always allowed</p>
      <ul className="p-group">
        {standing.map((entry) => (
          <li key={JSON.stringify([standingKey(entry), entry.root])} data-share-always-entry={standingKey(entry)} className="flex items-center gap-3 px-3.5 py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate p-meta p-text-2"><span className="font-mono">{entry.member}</span> on {titleOf(entry)}</span>
              {Object.keys(entry.root).length > 0 && <span className="block truncate p-meta p-text-3">{rootWords(entry.root)}</span>}
            </span>
            <Button size="xs" variant="ghost" data-share-always-withdraw onClick={() => onWithdraw(entry)} disabled={disabled}>Revoke</Button>
          </li>
        ))}
      </ul>
      <p className="p-meta p-text-3">These go ahead without asking you, on every share of it on your access, until its code changes.</p>
    </div>
  );
}

/** The slate's standing approvals, read with the sheet, and each taken back from every share of it. */
function useStanding(workspace: string, slate: string, fixture: LiveShareFixture | undefined, failed: (chain: string) => void) {
  const [standing, setStanding] = useState<readonly SharePreapproval[]>(fixture?.preapproved ?? []);

  useEffect(() => {
    if (fixture !== undefined) return;
    let live = true;

    detach(Effect.catchCause(
      Effect.map(Effect.promise(() => readPreapprovals({ workspace, slate })), (read) => { if (live) setStanding(read.preapproved); }),
      showing((chain) => { if (live) failed(chain); }),
    ));

    return () => { live = false; };
  }, [fixture, workspace, slate, failed]);

  const withdraw = useCallback((entry: SharePreapproval) => detach(Effect.catchCause(
    Effect.map(
      Effect.promise(() => withdrawPreapproval({ workspace, slate, entry: { slate: entry.slate, namespace: entry.namespace, member: entry.member, root: entry.root } })),
      (left) => setStanding(left.preapproved),
    ),
    showing(failed),
  )), [workspace, slate, failed]);

  return { standing, withdraw };
}

/** The people typed in, and of them those who edit too; only people added by name edit: a link opens it for use alone. */
function usePeopleRoles(emails: string, visibility: LiveShareVisibility) {
  const [editing, setEditing] = useState<ReadonlySet<string>>(new Set());
  const emailList = useMemo(() => emailsOf(emails), [emails]);
  const editors = visibility === "users" ? emailList.filter((email) => editing.has(email)) : [];

  const setRole = useCallback((email: string, edits: boolean) => setEditing((previous) => {
    const next = new Set(previous);

    if (edits) next.add(email); else next.delete(email);

    return next;
  }), []);

  return { emailList, editing, editors, setRole };
}

/** A shared slate runs only as its own files build: why its preview refuses it, when it does. */
function useSharedRefusal(rpc: WorkspaceRpc, slate: string, fixture: LiveShareFixture | undefined): string | null {
  const [refused, setRefused] = useState<string | null>(fixture?.refused ?? null);

  useEffect(() => {
    if (fixture !== undefined) return;
    let live = true;

    detach(Effect.map(Effect.promise(() => rpc("slate", [{ op: "preview", id: slate }])), (shown) => {
      if (live && !shown.ok && shown.reason === "bad_input") setRefused(shown.error);
    }));

    return () => { live = false; };
  }, [fixture, rpc, slate]);

  return refused;
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
  // Asked at the slate's first share only: a later share shares what the first one did.
  const [start, setStart] = useState<ShareStart>("as-is");
  // A stopped owner share whose new reach the form shows, for the owner to approve instead of making a share.
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [emails, setEmails] = useState("");
  const refused = useSharedRefusal(rpc, slate, fixture);
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

  const { emailList, editing, editors, setRole } = usePeopleRoles(emails, visibility);
  const { standing, withdraw } = useStanding(workspace, slate, fixture, setErr);

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
        workspace, slate, visibility, emails: visibility === "users" ? emailList : undefined, editors, fork, start,
        ...(mode === "owner" && revision !== null ? { mode, revision, approved: approvalsOf(approved) } : { mode: "own", approved: [] }),
      }));

      setCreated(result);
      setShares((previous) => [result.share, ...previous]);

      if (result.listing === 'pending') onListingPending?.();
    }), showing(setErr)), Effect.sync(() => {
      setBusy(false);
    }));
  })), [canShare, approved, workspace, slate, visibility, emailList, editors, mode, revision, fork, start, setBusy, onListingPending]);

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
        <NotRunning reason={refused} shared={shares.length > 0} />
        {visibility === "users" && (
          <>
            <EmailsField value={emails} onChange={setEmails} disabled={busy} placeholder="Add people by email" />
            <PeopleRoles people={emailList} editors={editing} onRole={setRole} ownerAccess={mode === "owner"} disabled={busy} />
          </>
        )}
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
        {shares.length === 0 && <StartChoice value={start} disabled={busy} onChange={(next) => {
          setStart(next);

          if (next === "empty") setMode("own");
        }} />}
        <ModeChoice value={mode} onChange={setMode} disabled={busy || reviewing !== null} unbuilt={graph !== null && revision === null} emptyCopy={start === "empty"} />
        {mode === "owner" && <OwnerReach graph={graph} failed={err !== null} visibility={visibility} approved={approved} onToggle={toggle} disabled={busy} />}
        {graph !== null && <p className="p-meta p-text-3" data-share-limits>{limits}</p>}
        {shares.length > 0 && (
          <SharedNow shares={shares} onStop={(id) => revoke(id)} onOwnAccess={ownAccess} onList={list} disabled={busy}
            onReview={(id) => { setMode("owner"); setReviewing(id); }} />
        )}
        <AlwaysAllowed standing={standing} graph={graph} onWithdraw={withdraw} disabled={busy} />
        <Failure message={err} />
      </div>
      <div className="flex justify-end gap-2 border-t p-border pt-4">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <PrimaryAction reviewing={reviewing !== null} busy={busy} canShare={canShare} canApprove={revision !== null} onShare={share} onApprove={approveReach} />
      </div>
    </>
  );
}
