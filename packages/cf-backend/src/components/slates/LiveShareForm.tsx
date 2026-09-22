/** The server grant is the read set plus the ticked set; the dialog renders, never decides. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import { GlobeIcon, UsersIcon } from "@phosphor-icons/react";
import * as v from "valibot";
import {
  LiveShareRecordSchema, SlateCapabilityGraphSchema,
  SHARE_SPEND_CAP_USD_PER_DAY, SHARE_VIEWER_REQUESTS_PER_MINUTE,
  type LiveShareCreated, type LiveShareRecord, type LiveShareVisibility, type Rpc, type SlateAnswer, type SlateCapability, type SlateCapabilityGraph, type SlateGraphBinding,
} from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import { FilledButton } from "@/components/ui/FilledButton";
import { CopyButton } from "@/components/ui/CopyButton";
import { inputCls } from "@/components/ui/form";
import { revokeLiveShare, shareLive } from "@/lib/shared-api";
import { answered } from "./BlueprintShareForm";

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
      <ul className="space-y-1 pl-3">
        {binding.members.map((member) => {
          const approval = { slate: binding.slate, binding: binding.name, member: member.member };
          const key = approvalKey(approval);
          const risk = visibility === "public" ? member.risk.public : member.risk.users;

          if (member.effect === "read") {
            return (
              <li key={key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-mono p-text-2">{member.member}</span>
                <span className="p-badge-success rounded px-1.5 py-0.5 text-[10px]">read-only · granted</span>
              </li>
            );
          }

          const checked = approved.has(key);

          return (
            <li key={key} className={`rounded-md px-2 py-1.5 -mx-2 ${checked ? "p-tint-warning border" : ""}`}>
              <label className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5">
                <input type="checkbox" checked={checked} onChange={() => onToggle(approval)} disabled={disabled}
                  aria-describedby={`risk-${key}`} data-approve={`${binding.name}.${member.member}`} />
                <span className="font-mono p-text">{member.member}</span>
                <span className="p-badge-warning rounded px-1.5 py-0.5 text-[10px]">mutating</span>
              </label>
              <p id={`risk-${key}`} className="mt-1 leading-relaxed p-text-3">{risk}</p>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <li className="space-y-1.5 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-xs p-text">{binding.name}</span>
        <span className="p-badge-neutral rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide">{binding.kind}</span>
        <span className="p-text-3">→ {capabilityLabel(binding.capability)}</span>
      </div>
      {members}
    </li>
  );
}

function VisibilityOption({ value, current, onPick, icon: Icon, title, detail, badge, disabled }: {
  value: LiveShareVisibility;
  current: LiveShareVisibility;
  onPick: (value: LiveShareVisibility) => void;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  detail: string;
  badge?: string;
  disabled: boolean;
}) {
  const selected = value === current;

  return (
    <button type="button" role="radio" aria-checked={selected} disabled={disabled} onClick={() => onPick(value)}
      className={`flex flex-1 items-start gap-2 rounded-md border px-3 py-2 text-left ${selected ? "border-[var(--c-accent)] p-accent-bg" : "p-border"}`}>
      <Icon size={14} className={`mt-0.5 shrink-0 ${selected ? "p-accent" : "p-text-3"}`} />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-xs font-medium p-text">
          {title}
          {badge !== undefined && <span className="p-badge-warning rounded px-1.5 py-0.5 text-[10px]">{badge}</span>}
        </span>
        <span className="block p-meta p-text-3">{detail}</span>
      </span>
    </button>
  );
}

export function LiveShareForm({ workspace, slate, rpc, onClose, onBusy, fixture }: {
  workspace: string;
  slate: string;
  rpc: Rpc;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
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
  const [created, setCreated] = useState<LiveShareCreated | null>(null);
  const setBusy = useCallback((next: boolean) => { setBusyState(next); onBusy(next); }, [onBusy]);

  useEffect(() => {
    if (fixture !== undefined) return;
    let live = true;
    const failed = (...rejection: [unknown]): void => { if (live) setErr(renderThrownChain({ cause: rejection[0] })); };

    Promise.all([
      rpc<SlateAnswer<unknown>>("slate", [{ op: "graph", id: slate }]),
      rpc<SlateAnswer<unknown>>("slate", [{ op: "liveShares" }]),
    ]).then(([drawn, rows]) => {
      if (!live) return;
      setGraph(answered(drawn, SlateCapabilityGraphSchema));
      setShares(answered(rows, v.array(LiveShareRecordSchema)).filter((share) => share.slate === slate && share.revokedAt === null));
    }).catch(failed);

    return () => { live = false; };
  }, [fixture, rpc, slate]);

  const counts = useMemo(() => {
    const members = graph?.bindings.flatMap((binding) => binding.problem === undefined ? binding.members : []) ?? [];

    return { read: members.filter((member) => member.effect === "read").length, mutating: members.filter((member) => member.effect === "mutate").length };
  }, [graph]);

  const toggle = useCallback((approval: Approval) => {
    setApproved((previous) => {
      const next = new Set(previous);
      const key = approvalKey(approval);

      if (next.has(key)) next.delete(key); else next.add(key);

      return next;
    });
  }, []);

  const emailList = emails.split(/[\s,;]+/).map((email) => email.trim()).filter(Boolean);
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
    } catch (cause) {
      setErr(renderThrownChain({ cause }));
    } finally {
      setBusy(false);
    }
  }, [canShare, approved, workspace, slate, visibility, emailList, fork, setBusy]);

  const revoke = useCallback(async (shareId: string) => {
    setErr(null);

    try {
      await revokeLiveShare({ workspace, share: shareId });
      setShares((previous) => previous.filter((row) => row.id !== shareId));
    } catch (cause) {
      setErr(renderThrownChain({ cause }));
    }
  }, [workspace]);

  const slatesInOrder = graph?.slates ?? [];

  return (
    <>
      {created !== null ? (
        <div className="space-y-2 text-xs">
          <div className="p-notice-success rounded-md px-3 py-2">Shared live. Viewers reach exactly the members you granted; stop sharing here at any time.</div>
          {created.url === null ? (
            <div className="p-notice-info rounded-md px-3 py-2">This deployment cannot mint share links: no preview host or signing secret is configured.</div>
          ) : (
            <div className="flex items-center gap-2">
              <a href={created.url} className="min-w-0 flex-1 break-all font-mono p-accent" target="_blank" rel="noopener noreferrer">{created.url}</a>
              <CopyButton value={created.url} what="the share link" className="p-btn-quiet rounded p-1" />
            </div>
          )}
          {created.share.visibility === "users" && emailList.length > 0 && <p className="p-text-3">Shared with {emailList.join(", ")}.</p>}
        </div>
      ) : (
        <div className="space-y-4 text-xs">
          <p className="p-text-2 leading-relaxed">
            A live share runs this slate here, in your workspace, for whoever you admit. Every call a viewer makes goes through the members below, as you.
          </p>
          <p className="p-text-3 leading-relaxed">
            Each viewer gets {SHARE_VIEWER_REQUESTS_PER_MINUTE} requests a minute, and each share gets ${SHARE_SPEND_CAP_USD_PER_DAY} of model spend a day. Past either limit, a viewer is refused until the limit resets.
          </p>
          <div role="radiogroup" aria-label="Who can open this share" className="flex flex-col gap-2 sm:flex-row">
            <VisibilityOption value="users" current={visibility} onPick={setVisibility} icon={UsersIcon} disabled={busy}
              title="People I name" detail="Signed-in Kinu users you list. Each opens through a short-lived ticket." />
            <VisibilityOption value="public" current={visibility} onPick={setVisibility} icon={GlobeIcon} disabled={busy}
              title="Anyone with the link" detail="No sign-in. Listed on the Shared page." badge="public" />
          </div>
          {visibility === "users" && (
            <label className="block space-y-1">
              <span className="p-meta p-text-3">Emails</span>
              <input value={emails} onChange={(event) => setEmails(event.target.value)} className={inputCls} placeholder="pat@example.com, sam@example.com" disabled={busy} data-share-emails />
            </label>
          )}
          <div className="space-y-1">
            <div className="p-meta p-text-3">What a viewer reaches</div>
            {graph === null && err === null && <div className="flex justify-center py-4"><Loader size="sm" /></div>}
            {graph !== null && graph.bindings.length === 0 && <p className="p-text-3">Nothing: this slate declares no bindings, so a viewer only runs its code.</p>}
            {graph !== null && slatesInOrder.map((slateId) => {
              const rows = graph.bindings.filter((binding) => binding.slate === slateId);

              if (rows.length === 0) return null;

              const via = slateId === graph.slate ? null
                : graph.bindings.find((binding) => binding.capability.kind === "slate" && binding.capability.id === slateId)?.name ?? slateId;

              return (
                <div key={slateId} className={via === null ? "" : "mt-2 border-l-2 p-border pl-3"}>
                  {via !== null && <div className="p-meta p-text-3">via <span className="font-mono">{via}</span> → <span className="font-mono">{slateId}</span></div>}
                  <ul className="divide-y divide-[var(--c-border)]">
                    {rows.map((binding) => (
                      <BindingRow key={`${binding.slate}/${binding.name}`} binding={binding} visibility={visibility} approved={approved} onToggle={toggle} disabled={busy} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
          {graph !== null && (
            <p className="p-text-2" data-grant-summary>
              Viewers get {counts.read} read-only member{counts.read === 1 ? "" : "s"}. You approved {approved.size} of {counts.mutating} mutating member{counts.mutating === 1 ? "" : "s"}.
            </p>
          )}
          <label className="flex items-center gap-2 p-text">
            <input type="checkbox" checked={fork} onChange={(event) => setFork(event.target.checked)} disabled={busy} />
            <span>Viewers can fork <span className="p-text-3">into a workspace of their own, with every binding unmapped</span></span>
          </label>
          {shares.length > 0 && (
            <div className="space-y-1">
              <div className="p-meta p-text-3">Already shared live</div>
              <ul className="space-y-1">
                {shares.map((row) => (
                  <li key={row.id} className="flex items-center gap-2">
                    <span className={`${row.visibility === "public" ? "p-badge-warning" : "p-badge-neutral"} shrink-0 rounded px-1.5 py-0.5 text-[10px]`}>{row.visibility === "public" ? "public" : "people"}</span>
                    <span className="min-w-0 flex-1 truncate p-text-2">
                      {row.grant.members.length} member{row.grant.members.length === 1 ? "" : "s"} granted · {new Date(row.createdAt).toLocaleDateString()}{row.users.length > 0 ? ` · ${row.users.join(", ")}` : ""}
                      {row.paused === true && <span className="p-badge-warning rounded px-1 py-0.5 text-[10px]">paused: daily spend limit reached</span>}
                    </span>
                    <button type="button" onClick={() => revoke(row.id)} className="p-btn-quiet rounded-md px-2 py-0.5" disabled={busy}>Stop sharing</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {err && <div className="p-notice-danger rounded-md px-3 py-2">{err}</div>}
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        {created === null ? (
          <>
            <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <FilledButton onClick={share} disabled={!canShare}>
              {busy ? <><Loader size="sm" /><span className="ml-1">Sharing…</span></> : "Share live"}
            </FilledButton>
          </>
        ) : <Button size="sm" variant="ghost" onClick={onClose}>Done</Button>}
      </div>
    </>
  );
}
