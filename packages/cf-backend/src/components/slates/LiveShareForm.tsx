/** The server grant is the read set plus the ticked set; the dialog renders, never decides. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import { CaretDownIcon, CaretRightIcon, GlobeIcon, UsersIcon } from "@phosphor-icons/react";
import * as v from "valibot";
import {
  LiveShareRecordSchema, SlateCapabilityGraphSchema,
  SHARE_SPEND_CAP_USD_PER_DAY, SHARE_VIEWER_REQUESTS_PER_MINUTE,
  type LiveShareCreated, type LiveShareRecord, type LiveShareVisibility, type Rpc, type SlateAnswer, type SlateCapability, type SlateCapabilityGraph, type SlateGraphBinding,
} from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import { FilledButton } from "@/components/ui/FilledButton";
import { CopyButton } from "@/components/ui/CopyButton";
import { revokeShare, shareLive } from "@/lib/shared-api";
import { answered } from "./BlueprintShareForm";
import { AccessPicker, EmailsField, emailsOf, Failure, Lead, StopButton, type AccessOption } from "./ShareParts";
import { showRejection } from "@/hooks/use-async-resource";

export interface LiveShareFixture {
  graph: SlateCapabilityGraph;
  liveShares: LiveShareRecord[];
}

interface Approval {
  slate: string;
  binding: string;
  member: string;
}

function approvalKey(approval: Approval): string {
  return JSON.stringify([approval.slate, approval.binding, approval.member]);
}

function capabilityLabel(capability: SlateCapability): string {
  switch (capability.kind) {
    case "executor": return `${capability.namespace} executor`;
    case "mcp": return capability.title;
    case "tool": return `tool ${capability.name}`;
    case "memory": return "your workspace memory";
    case "tasks": return "your task list";
    case "web": return "the web, as you";
    case "rpc": return "read models";
    case "agent": return "your agent";
    case "model": return `your ${capability.tier} tier`;
    case "slate": return `slate ${capability.id}`;
  }
}

const ACCESS: readonly AccessOption<LiveShareVisibility>[] = [
  { id: "users", icon: <UsersIcon size={15} />, label: "Only people you add", detail: "Anyone else who gets the link sees nothing." },
  { id: "public", icon: <GlobeIcon size={15} />, label: "Anyone with the link", detail: "No sign-in needed. It still runs as you." },
];

function BindingRow({ binding, visibility, approved, onToggle, disabled }: {
  binding: SlateGraphBinding;
  visibility: LiveShareVisibility;
  approved: ReadonlySet<string>;
  onToggle: (approval: Approval) => void;
  disabled: boolean;
}) {
  let members: ReactNode;

  if (binding.problem !== undefined) {
    members = <p className="p-badge-danger inline-block rounded px-2 py-0.5 text-[11px]">{binding.problem}</p>;
  } else if (binding.members.length === 0) {
    members = <p className="p-text-4">No members.</p>;
  } else {
    members = (
      <ul className="space-y-1">
        {binding.members.map((member) => {
          const approval = { slate: binding.slate, binding: binding.name, member: member.member };
          const key = approvalKey(approval);
          const risk = visibility === "public" ? member.risk.public : member.risk.users;

          if (member.effect === "read") {
            return (
              <li key={key} className="flex items-center gap-2">
                <span className="font-mono p-text-2">{member.member}</span>
                <span className="ml-auto p-text-4">Always on</span>
              </li>
            );
          }

          const checked = approved.has(key);

          return (
            <li key={key} className={`-mx-2 rounded-md px-2 py-1.5 ${checked ? "p-tint-warning" : ""}`}>
              <label className="flex cursor-pointer items-center gap-2">
                <span className="font-mono p-text">{member.member}</span>
                <input type="checkbox" checked={checked} onChange={() => onToggle(approval)} disabled={disabled}
                  className="ml-auto size-4 accent-[var(--c-accent)]" aria-describedby={`risk-${key}`} data-approve={`${binding.name}.${member.member}`} />
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
        <span className="font-mono text-xs font-medium p-text">{binding.name}</span>
        <span className="p-text-4">{capabilityLabel(binding.capability)}</span>
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
    const members = graph.bindings.flatMap((binding) => binding.problem === undefined ? binding.members : []);

    return { read: members.filter((member) => member.effect === "read").length, mutating: members.filter((member) => member.effect === "mutate").length };
  }, [graph]);

  const names = [...new Set(graph.bindings.filter((binding) => binding.slate === graph.slate).map((binding) => capabilityLabel(binding.capability)))].join(", ");
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
            const rows = graph.bindings.filter((binding) => binding.slate === slateId);

            if (rows.length === 0) return null;

            const via = slateId === graph.slate ? null
              : graph.bindings.find((binding) => binding.capability.kind === "slate" && binding.capability.id === slateId)?.name ?? slateId;

            return (
              <div key={slateId} className={via === null ? "" : "border-l-2 p-border pl-3"}>
                {via !== null && <div className="p-text-3">via <span className="font-mono">{via}</span> → <span className="font-mono">{slateId}</span></div>}
                <ul className="divide-y divide-[var(--c-border)]">
                  {rows.map((binding) => (
                    <BindingRow key={`${binding.slate}/${binding.name}`} binding={binding} visibility={visibility} approved={approved} onToggle={onToggle} disabled={disabled} />
                  ))}
                </ul>
              </div>
            );
          })}
          <p className="p-text-2" data-grant-summary>
            People get {counts.read} read-only member{counts.read === 1 ? "" : "s"}. You allowed {approved.size} of {counts.mutating} change{counts.mutating === 1 ? "" : "s"}.
          </p>
        </div>
      )}
    </div>
  );
}

function SharedNow({ shares, onStop, disabled }: { shares: readonly LiveShareRecord[]; onStop: (id: string) => void; disabled: boolean }) {
  return (
    <div className="space-y-1.5">
      <p className="p-meta font-medium p-text-3">Shared now</p>
      <ul className="p-group">
        {shares.map((row) => (
          <li key={row.id} data-live-share={row.id} className="flex items-center gap-3 px-3.5 py-2">
            <span className="flex shrink-0 p-text-3">{row.visibility === "public" ? <GlobeIcon size={14} /> : <UsersIcon size={14} />}</span>
            <span className="min-w-0 flex-1 truncate p-meta p-text-2">
              {row.visibility === "public" ? "Anyone with the link" : row.users.join(", ") || "People you added"}
              {row.paused === true && <span className="p-warning"> · paused today: limit reached</span>}
            </span>
            <StopButton onStop={() => onStop(row.id)} disabled={disabled} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LiveShareForm({ workspace, slate, rpc, onClose, onBusy, onListingPending, fixture }: {
  workspace: string;
  slate: string;
  rpc: Rpc;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  onListingPending?: () => void;
  fixture?: LiveShareFixture;
}) {
  const [graph, setGraph] = useState<SlateCapabilityGraph | null>(fixture?.graph ?? null);
  const [shares, setShares] = useState<LiveShareRecord[]>(fixture?.liveShares ?? []);
  const [visibility, setVisibility] = useState<LiveShareVisibility>("users");
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
    Promise.all([
      rpc<SlateAnswer<unknown>>("slate", [{ op: "graph", id: slate }]),
      rpc<SlateAnswer<unknown>>("slate", [{ op: "liveShares" }]),
    ]).then(([drawn, rows]) => {
      if (!live) return;
      setGraph(answered(drawn, SlateCapabilityGraphSchema));
      setShares(answered(rows, v.array(LiveShareRecordSchema)).filter((share) => share.slate === slate && share.revokedAt === null));
    }).catch(showRejection(setErr, () => live));

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
  const canShare = graph !== null && !busy && (visibility === "public" || emailList.length > 0);

  const share = useCallback(async () => {
    if (!canShare) return;
    setBusy(true);
    setErr(null);

    try {
      const approvals = [...approved].map((key) => v.parse(v.tuple([v.string(), v.string(), v.string()]), JSON.parse(key)))
        .map(([slateId, binding, member]) => ({ slate: slateId, binding, member }));

      const result = await shareLive({ workspace, slate, visibility, emails: visibility === "users" ? emailList : undefined, approved: approvals, fork });
      setCreated(result);
      setShares((previous) => [result.share, ...previous]);

      if (result.listing === 'pending') onListingPending?.();
    } catch (cause) {
      setErr(renderThrownChain({ cause }));
    } finally {
      setBusy(false);
    }
  }, [canShare, approved, workspace, slate, visibility, emailList, fork, setBusy, onListingPending]);

  const revoke = useCallback(async (shareId: string) => {
    setErr(null);

    try {
      const revoked = await revokeShare({ workspace, share: shareId });
      setShares((previous) => previous.filter((row) => row.id !== shareId));

      if (revoked.listing === 'pending') onListingPending?.();
    } catch (cause) {
      setErr(renderThrownChain({ cause }));
    }
  }, [workspace, onListingPending]);

  if (created !== null) {
    return (
      <>
        <div className="space-y-3 text-xs">
          <p className="p-notice-success rounded-md px-3 py-2" data-share-created>
            Shared. {created.share.visibility === "public" ? "Anyone with the link can open it." : `${emailList.join(", ")} can open it.`}
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

  const reaches = graph !== null && graph.bindings.length > 0;

  const limits = reaches
    ? `Each person gets ${String(SHARE_VIEWER_REQUESTS_PER_MINUTE)} requests a minute; the share gets $${String(SHARE_SPEND_CAP_USD_PER_DAY)} of model spend a day.`
    : `Each person gets ${String(SHARE_VIEWER_REQUESTS_PER_MINUTE)} requests a minute.`;

  return (
    <>
      <div className="space-y-4">
        <Lead>People open your slate and use it. It runs in your workspace, as you.</Lead>
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
        {graph === null && err === null && <div className="flex justify-center py-2"><Loader size="sm" /></div>}
        {graph !== null && reaches && <Reach graph={graph} visibility={visibility} approved={approved} onToggle={toggle} disabled={busy} />}
        {graph !== null && <p className="p-meta p-text-3" data-share-limits>{limits}</p>}
        {shares.length > 0 && <SharedNow shares={shares} onStop={(id) => void revoke(id)} disabled={busy} />}
        <Failure message={err} />
      </div>
      <div className="flex justify-end gap-2 border-t p-border pt-4">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <FilledButton className="h-8 px-4 text-sm" onClick={() => void share()} disabled={!canShare} data-share-submit>
          {busy ? <><Loader size="sm" /><span className="ml-1">Sharing…</span></> : "Share"}
        </FilledButton>
      </div>
    </>
  );
}
