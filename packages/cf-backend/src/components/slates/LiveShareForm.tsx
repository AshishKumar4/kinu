/** The server grant is the read set plus the ticked set; the dialog renders, never decides. */
import { Effect } from 'effect';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader } from "@/components/ui/Loader";
import { Button } from "@/components/ui/Button";
import {
  CaretDownIcon, CaretRightIcon, FileDashedIcon, GlobeIcon, IdentificationCardIcon, PackageIcon, SquaresFourIcon, StopCircleIcon, UserCircleIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import * as v from "valibot";
import { OwnedLiveShareSchema, SlateReachSchema, SHARE_SPEND_CAP_USD_PER_DAY, SHARE_VIEWER_REQUESTS_PER_MINUTE, type LiveShareBody, type LiveShareCreated, type LiveShareVisibility, type OwnedLiveShare, type SharePreapproval, type ShareMode, type SlateCapabilityGraph, type SlateGraphNamespace, type SlateGraphMember, type SlateReach } from "@kinu.run/core";
import { showing, detach } from "@kinu.run/core/obs";
import { CopyButton } from "@/components/ui/CopyButton";
import { listShare, readPreapprovals, revokeShare, setShareMode, shareLive, withdrawPreapproval } from "@/lib/shared-api";
import { ShareListing, type ListShare } from "./ShareListing";
import { answered } from "./BlueprintShareForm";
import { AccessPicker, EmailsField, emailsOf, Failure, Lead, type AccessOption } from "./ShareParts";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import { Notice } from "@/components/ui/Notice";
import { Group } from "@/components/ui/Group";
import { Choices, type Choice } from "@/components/ui/Choices";
import { Checkbox } from "@/components/ui/Check";
import { Pressable } from "@/components/ui/Pressable";
import { Segmented } from "@/components/ui/Segmented";

export interface LiveShareFixture {
  graph: SlateReach;
  liveShares: OwnedLiveShare[];
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
const MODES: readonly Choice<ShareMode>[] = [
  { id: "own", icon: <UserCircleIcon size={16} />, label: "Their own access", detail: "Each person sees their own data, on their own connections. Nothing of yours is used." },
  { id: "owner", icon: <IdentificationCardIcon size={16} />, label: "My access", detail: "It acts with your connections, within the reach below. Each change waits for you." },
];

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
  const ownerAccess = (mode: Choice<ShareMode>) => {
    if (emptyCopy) return { ...mode, disabled: true, detail: "An empty copy runs on each person's own access." };

    return unbuilt ? { ...mode, disabled: true, detail: "Open it once first, so there is a version of it to approve." } : mode;
  };

  const options = MODES.map((mode) => (mode.id === "owner" ? ownerAccess(mode) : mode));

  return <Choices label="It runs with" marker="data-share-mode" options={options} value={value} onChange={onChange} disabled={disabled} />;
}

/**
 * What the people it is first shared with start from (docs/SLATE-SHARING-NIMBUS.md, H7): the slate as it is, or a copy of
 * its code with nothing in it, shared in its place, so what this slate already holds stays the owner's.
 */
type ShareStart = NonNullable<LiveShareBody["start"]>;

const STARTS: readonly Choice<ShareStart>[] = [
  { id: "as-is", icon: <PackageIcon size={16} />, label: "As it is now", detail: "They see what it holds now, and what it holds next." },
  { id: "empty", icon: <FileDashedIcon size={16} />, label: "An empty copy", detail: "A copy of its code, holding nothing yet, is shared instead. This one stays as it is." },
];

function StartChoice({ value, onChange, disabled }: { value: ShareStart; onChange: (start: ShareStart) => void; disabled: boolean }) {
  return <Choices label="They start with" marker="data-share-start" options={STARTS} value={value} onChange={onChange} disabled={disabled} />;
}

/** What "My access" lets the people it is shared with do, said before it is chosen; it is never listed. */
function OwnerWarning() {
  return (
    <Notice tone="warning" data-share-owner-warning="">
      Everyone you share it with acts as you, within this reach: what it reads of yours, they see. Any change it makes waits for you to approve it, and a change to its code stops it until you approve the new reach. It can't be listed in the Gallery.
    </Notice>
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
  if (reviewing) return <Button variant="primary" size="sm"  onClick={onApprove} disabled={busy || !canApprove} data-share-approve-reach>Approve the new reach</Button>;

  return (
    <Button variant="primary" size="sm"  onClick={onShare} disabled={!canShare} data-share-submit>
      {busy ? <><Loader size="sm" /><span className="ml-1">Sharing…</span></> : "Share"}
    </Button>
  );
}

/** Who a share lets in, as the share records them. */
function whoCanOpen(share: OwnedLiveShare): string {
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
    members = <p className="t-meta p-danger">{row.problem}</p>;
  } else if (row.members.length === 0) {
    members = <p className="p-text-3">No members.</p>;
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
                <span className="p-text-3">{IMPACT_WORDS[member.impact]}</span>
                <span className="ml-auto p-text-3">Always on</span>
              </li>
            );
          }

          const checked = approved.has(key);

          return (
            <li key={key} className="py-1">
              <Checkbox checked={checked} onChange={() => onToggle(approval)} disabled={disabled} describedBy={`risk-${key}`}
                data-approve={`${row.namespace}.${member.member}`}
                label={<span className="flex flex-wrap gap-x-2"><span className="t-mono p-text">{member.member}</span><span className="p-text-3">{IMPACT_WORDS[member.impact]}</span></span>} />
              <p id={`risk-${key}`} className="mt-px pl-6 p-text-3">{risk}</p>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <li className="space-y-2 border-t p-border py-2 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="t-status t-mono p-text">{row.namespace}</span>
        {row.title !== row.namespace && <span className="p-text-3">{row.title}</span>}
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
    <Group>
      <Pressable aria-expanded={open} data-share-reach onClick={() => setOpen((shown) => !shown)} className="flex items-center gap-3 px-3 py-2">
        <span className="t-item w-14 shrink-0 p-text">Reach</span>
        <span className="t-meta flex min-w-0 flex-1 p-text-3">
          <span className="truncate">{names}</span>
          <span className="shrink-0 whitespace-pre"> · {changes}</span>
        </span>
        {open ? <CaretDownIcon size={14} className="shrink-0 p-text-3" /> : <CaretRightIcon size={14} className="shrink-0 p-text-3" />}
      </Pressable>
      {open && (
        <div className="t-meta space-y-2 border-t p-border px-3 py-2">
          <p className="p-text-3">Everything here uses your connections. Reading is on; each change stays off until you tick it.</p>
          {graph.slates.map((slateId) => {
            const rows = graph.namespaces.filter((row) => row.slate === slateId);

            if (rows.length === 0) return null;

            const via = slateId === graph.slate ? null
              : graph.namespaces.find((row) => row.namespace === `slates.${slateId}`)?.slate ?? slateId;

            return (
              <div key={slateId} className={via === null ? "" : "border-l-2 p-border pl-3"}>
                {via !== null && <div className="p-text-3">via <span className="font-mono">{via}</span> → <span className="font-mono">{slateId}</span></div>}
                <ul>
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
    </Group>
  );
}

/** What a share runs with, as its row says it; an owner share whose code changed is stopped until approved again. */
function modeWords(row: OwnedLiveShare): ReactNode {
  if (row.mode === "own") return "Their own access";

  if (!row.stale) return "Your access";

  const editor = row.editedBy;

  return <span className="p-warning">Stopped: {editor === null ? "its code changed" : <>changed by {editor}</>} since you approved its reach</span>;
}

const PERSON_ROLES: readonly { readonly id: "use" | "edit"; readonly label: string }[] = [{ id: "use", label: "Use" }, { id: "edit", label: "Edit" }];

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
    <div className="space-y-2">
      <Group list>
        {people.map((email) => (
          <li key={email} data-share-person={email} className="flex items-center gap-3 px-3 py-2">
            <span className="t-meta min-w-0 flex-1 truncate p-text-2">{email}</span>
            <Segmented size="sm" label={`What ${email} can do`} segments={PERSON_ROLES} value={editors.has(email) ? "edit" : "use"}
              onChange={(role) => onRole(email, role === "edit")} disabled={disabled} />
          </li>
        ))}
      </Group>
      {anyEditor && (
        <p data-share-editors-note className="t-meta p-text-3">
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

  return <Notice tone="warning" data-share-broken="">{reason}</Notice>;
}

/** A share's numbers, as its owner reads them: who opened it through its link, and how often; never who. */
function viewsWords(row: OwnedLiveShare): string {
  const { views } = row;

  if (views.opens === 0) return "Not opened yet";
  const people = views.viewers === 1 ? "1 person opened it" : `${views.viewers.toLocaleString("en-US")} people opened it`;
  const opens = views.opens === 1 ? "1 open" : `${views.opens.toLocaleString("en-US")} opens`;
  const signedOut = views.signedOutOpens === 0 ? "" : ` (${views.signedOutOpens.toLocaleString("en-US")} signed out)`;

  return views.viewers === 0 ? `${opens}${signedOut}` : `${people} · ${opens}${signedOut}`;
}

/** Who a share lets in, on one line: anyone with its link, or the people it names, those who edit marked. */
function WhoLine({ row }: { row: OwnedLiveShare }) {
  if (row.visibility === "public") return <span className="truncate">Anyone with the link</span>;

  return (
    <span className="flex min-w-0 flex-wrap gap-x-1">
      {row.users.map((email, index) => {
        const edits = row.editors.includes(email);

        return (
          <span key={email} data-live-share-person={email} data-live-share-role={edits ? "edit" : "use"} className="min-w-0 truncate">
            {email}{edits && <span className="p-accent-fg"> (edits)</span>}{index < row.users.length - 1 && ","}
          </span>
        );
      })}
    </span>
  );
}

interface SharedRowActions {
  readonly onStop: (id: string) => void;
  /** Moves an owner share to each person's own access: nothing of the owner's is used from then on. */
  readonly onOwnAccess: (id: string) => void;
  /** Shows a stopped owner share's new reach, for the owner to approve at the slate's new revision. */
  readonly onReview: (id: string) => void;
  readonly onList: (id: string, listing: Parameters<ListShare>[0]) => void;
  readonly disabled: boolean;
}

/** What the row's menu offers for a share: its own access, its place in the Gallery, and stopping it. */
function rowMenu(row: OwnedLiveShare, actions: SharedRowActions, onListing: () => void): MenuItem[] {
  const items: MenuItem[] = [];

  if (row.mode === "owner") items.push({ label: "Use their own access", icon: <UserCircleIcon size={15} />, marker: "data-live-share-own", onSelect: () => actions.onOwnAccess(row.id) });

  if (row.visibility === "public") {
    items.push({
      label: row.gallery === null ? "List in the Gallery…" : "Gallery listing…", icon: <SquaresFourIcon size={15} />, marker: "data-live-share-listing", onSelect: onListing,
      ...(row.mode === "owner" && { refused: "It runs on your access. Use their own access to list it." }),
    });
  }

  items.push({ label: "Stop sharing", icon: <StopCircleIcon size={15} />, danger: true, apart: items.length > 0, marker: "data-stop-sharing", onSelect: () => actions.onStop(row.id) });

  return items;
}

/** One share, on one compact row: who, whose access and its numbers, the one action a stopped share needs, and a menu. */
function SharedRow({ row, actions }: { row: OwnedLiveShare; actions: SharedRowActions }) {
  const [listing, setListing] = useState(false);
  const who = row.visibility === "public" ? "Anyone with the link" : "People you added";

  return (
    <li data-live-share={row.id} className="flex items-start gap-3 px-3 py-2">
      <span className="flex shrink-0 pt-px p-text-3">{row.visibility === "public" ? <GlobeIcon size={14} /> : <UsersIcon size={14} />}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-px">
          <span className="t-meta flex min-w-0 p-text-2"><WhoLine row={row} /></span>
          <span className="t-meta block p-text-3">
            <span data-live-share-mode={row.mode}>{modeWords(row)}</span>
            {row.paused && <span className="p-warning"> · paused today: limit reached</span>}
            {row.gallery !== null && <span data-live-share-listed> · In the Gallery</span>}
          </span>
          <span data-live-share-views className="t-meta block p-text-3">{viewsWords(row)}</span>
        </div>
        {row.mode === "owner" && row.stale && (
          <Button size="sm" variant="secondary" data-live-share-review={row.id} onClick={() => actions.onReview(row.id)} disabled={actions.disabled}>Review the new reach</Button>
        )}
        {listing && row.mode === "own" && <ShareListing share={row} onList={(next) => actions.onList(row.id, next)} disabled={actions.disabled} />}
      </div>
      <Menu name={who} items={rowMenu(row, actions, () => setListing((open) => !open))} className="relative shrink-0" />
    </li>
  );
}

function SharedNow({ shares, actions }: { shares: readonly OwnedLiveShare[]; actions: SharedRowActions }) {
  return (
    <div className="space-y-2">
      <p className="t-status p-text-3">Shared now</p>
      <Group list>
        {shares.map((row) => <SharedRow key={row.id} row={row} actions={actions} />)}
      </Group>
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
    <details data-share-always className="group space-y-2">
      <summary className="t-status flex cursor-pointer list-none items-center gap-2 p-text-3">
        <CaretRightIcon size={12} className="transition-transform group-open:rotate-90" />Always allowed ({standing.length})
      </summary>
      <Group list>
        {standing.map((entry) => (
          <li key={JSON.stringify([standingKey(entry), entry.root])} data-share-always-entry={standingKey(entry)} className="flex items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="t-meta block truncate p-text-2"><span className="font-mono">{entry.member}</span> on {titleOf(entry)}</span>
              {Object.keys(entry.root).length > 0 && <span className="t-meta block truncate p-text-3">{rootWords(entry.root)}</span>}
            </span>
            <Button size="sm" variant="ghost" data-share-always-withdraw onClick={() => onWithdraw(entry)} disabled={disabled}>Revoke</Button>
          </li>
        ))}
      </Group>
      <p className="t-meta p-text-3">These go ahead without asking you, on every share of it on your access, until its code changes.</p>
    </details>
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

/** A shared slate runs only what its own folder builds alone: why its preview refuses it, when it does (`sharedBuildRefusal`). */
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

/** Whether the people it is shared with may fork it: a fork is their own copy, on their own connections. */
function ForkChoice({ value, onChange, disabled }: { value: boolean; onChange: (fork: boolean) => void; disabled: boolean }) {
  return (
    <Checkbox checked={value} onChange={onChange} disabled={disabled} data-share-fork=""
      label={<span><span className="t-item block">Let them fork it</span><span className="t-meta block">A fork is their own copy, on their own connections.</span></span>} />
  );
}

/** The choices a share is made with, as one line: whose access, what they start from (a first share only), and forking. */
function choicesWords(choices: { mode: ShareMode; start: ShareStart | null; fork: boolean }): string {
  return [
    choices.mode === "own" ? "Runs on each person's own access" : "Runs with your access",
    ...(choices.start === null ? [] : [choices.start === "as-is" ? "Shows what it holds now" : "Shares an empty copy"]),
    choices.fork ? "Can be forked" : "Can't be forked",
  ].join(" · ");
}

/** The choices, said in one line until asked for, then each in place: the safe ones are the defaults. */
function ChoicesSummary({ words, open, onToggle, disabled }: { words: string; open: boolean; onToggle: () => void; disabled: boolean }) {
  return (
    <div data-share-summary className="flex flex-wrap items-center gap-x-2">
      <span className="t-meta">{words}</span>
      <Button variant="ghost" size="sm" data-share-options aria-expanded={open} onClick={onToggle} disabled={disabled}>{open ? "Done" : "Change"}</Button>
    </div>
  );
}

interface ShareChoicesState {
  readonly mode: ShareMode;
  readonly start: ShareStart;
  readonly fork: boolean;
}

/** What one share asks of a person, by the slate's reach: requests a minute each, and model spend a day where it reaches. */
function limitsWords(graph: SlateReach): string {
  return graph.namespaces.length > 0
    ? `Each person gets ${String(SHARE_VIEWER_REQUESTS_PER_MINUTE)} requests a minute; the share gets $${String(SHARE_SPEND_CAP_USD_PER_DAY)} of model spend a day.`
    : `Each person gets ${String(SHARE_VIEWER_REQUESTS_PER_MINUTE)} requests a minute.`;
}

/**
 * A share's choices: one line of them until asked to change, then each in place. A stopped share's reach, shown for
 * approving again, opens them with no line above. What a first share starts from is asked of it alone.
 */
function ShareChoices({ choices, set, first, reviewing, reach, busy }: {
  choices: ShareChoicesState;
  set: { readonly mode: (mode: ShareMode) => void; readonly start: (start: ShareStart) => void; readonly fork: (fork: boolean) => void };
  first: boolean;
  reviewing: boolean;
  reach: { readonly graph: SlateReach | null; readonly failed: boolean; readonly visibility: LiveShareVisibility; readonly approved: ReadonlySet<string>; readonly onToggle: (approval: Approval) => void };
  busy: boolean;
}) {
  const [choosing, setChoosing] = useState(false);
  const { mode, start, fork } = choices;
  const { graph } = reach;

  return (
    <>
      {!reviewing && (
        <ChoicesSummary words={choicesWords({ mode, start: first ? start : null, fork })} open={choosing} onToggle={() => setChoosing((open) => !open)} disabled={busy} />
      )}
      {(choosing || reviewing) && (
        <div data-share-choices className="space-y-4">
          <ForkChoice value={fork} onChange={set.fork} disabled={busy} />
          {first && <StartChoice value={start} disabled={busy} onChange={(next) => {
            set.start(next);

            if (next === "empty") set.mode("own");
          }} />}
          <ModeChoice value={mode} onChange={set.mode} disabled={busy || reviewing} unbuilt={graph !== null && graph.revision === null} emptyCopy={start === "empty"} />
          {mode === "owner" && <OwnerReach graph={graph} failed={reach.failed} visibility={reach.visibility} approved={reach.approved} onToggle={reach.onToggle} disabled={busy} />}
          {graph !== null && <p className="t-meta p-text-3" data-share-limits>{limitsWords(graph)}</p>}
        </div>
      )}
    </>
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
  const [shares, setShares] = useState<OwnedLiveShare[]>(fixture?.liveShares ?? []);
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
      setShares(answered(rows, v.array(OwnedLiveShareSchema)).filter((share) => share.slate === slate && share.revokedAt === null));
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
        <div className="t-meta space-y-3">
          <Notice tone="success" data-share-created="">
            Shared. {whoCanOpen(created.share)}
            {created.listing === "pending" && " The list will catch up."}
          </Notice>
          {created.url === null ? (
            <p className="t-meta p-text-3">This deployment cannot make share links: it has no preview host or signing secret.</p>
          ) : (
            <div className="flex items-center gap-2">
              <a href={created.url} className="min-w-0 flex-1 break-all font-mono p-accent-fg" target="_blank" rel="noopener noreferrer">{created.url}</a>
              <CopyButton variant="secondary" value={created.url} what="the share link" />
            </div>
          )}
        </div>
        <div className="flex justify-end"><Button variant="primary" size="md" onClick={onClose}>Done</Button></div>
      </>
    );
  }

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
        <ShareChoices choices={{ mode, start, fork }} set={{ mode: setMode, start: setStart, fork: setFork }} first={shares.length === 0} reviewing={reviewing !== null}
          reach={{ graph, failed: err !== null, visibility, approved, onToggle: toggle }} busy={busy} />
        {shares.length > 0 && (
          <SharedNow shares={shares} actions={{
            onStop: (id) => revoke(id), onOwnAccess: ownAccess, onList: list, disabled: busy,
            onReview: (id) => { setMode("owner"); setReviewing(id); },
          }} />
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
