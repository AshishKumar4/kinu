import { Effect } from 'effect';
import { useState, useEffect, useCallback, useRef } from "react";
import type { ComponentType, ReactNode } from "react";
import { Loader } from "@/components/ui/Loader";
import { Button } from "@/components/ui/Button";
import {
  GitBranchIcon, BrainIcon,
  ChecksIcon, CheckIcon, XIcon, GitDiffIcon,
  NotePencilIcon, ArrowsClockwiseIcon, SquaresFourIcon,
  CaretDownIcon, CaretRightIcon,
} from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import type { ChangelogEntry, ChangelogEntryKind } from "@kinu.run/core";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { showing, detach } from "@kinu.run/core/obs";
import { type AsyncResource, lastValue, useAsyncResource, useReloadWhenMoved } from "@/hooks/use-async-resource";
import { ScaffoldVersionDiff } from "./ScaffoldLineage";
import { changelogFactKey } from "./shared";
import { timeAgo } from "@kinu.run/core";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";

interface ChangelogView { entries: ChangelogEntry[]; unseenCount: number; seenAt: number }

const KIND_ICON = {
  scaffold: GitBranchIcon,
  fact: BrainIcon,
  ratings: ChecksIcon,
  artifact: NotePencilIcon,
  refinement: ArrowsClockwiseIcon,
  workspace: SquaresFourIcon,
} satisfies Record<ChangelogEntryKind, ComponentType<{ size?: number; className?: string }>>;

/** Showing the digest marks it seen, so what is new to the owner is lit once. */
export function useChangelog(rpc: WorkspaceRpc, moved = 0) {
  const load = useCallback((): Promise<ChangelogView> => rpc("getEvolutionChangelog", [{ limit: 30 }]), [rpc]);

  const { resource, reload } = useAsyncResource(load);
  const view = lastValue(resource);

  useReloadWhenMoved(moved, reload);

  // Freshness is judged against the marker pinned on first read; later reads return a marker newer than every entry.
  const openedSeenAt = useRef<number | null>(null);

  if (openedSeenAt.current === null && view !== null) openedSeenAt.current = view.seenAt;

  const [seenError, setSeenError] = useState<string | null>(null);

  const markSeen = useCallback(async () => {
    if (!view || view.unseenCount === 0) return;
    await rpc("markChangelogSeen", []);
    setSeenError(null);
  }, [view, rpc]);

  const { resource: seenMark } = useAsyncResource(markSeen);

  useEffect(() => {
    if (seenMark.status === "error") setSeenError(seenMark.message);
  }, [seenMark]);

  return { view, seenAt: openedSeenAt.current ?? 0, resource, reload, seenError };
}

/** A broken read must never look like a build that never had a changelog. */
export function ChangelogFailure(
  { resource, reload }: { resource: AsyncResource<ChangelogView>; reload: () => void },
) {
  if (resource.status === "error") {
    return <LoadFailure what="the changelog" message={resource.message} onRetry={reload} />;
  }

  return <div className="t-meta flex items-center justify-center gap-2 py-4 p-text-3" role="status">
    <Loader size="sm" />
    <span>Loading journal…</span>
  </div>;
}

function EntryField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="t-meta grid grid-cols-[64px_minmax(0,1fr)] gap-2">
      <span className="p-text-3">{label}</span>
      <span className="p-text-2 min-w-0 break-words">{children}</span>
    </div>
  );
}

/** No Edit or Remove: no UI RPC exposes either. */
function EntryFacts({ entry }: { entry: ChangelogEntry }) {
  const when = new Date(entry.at);
  const whenText = isNaN(when.getTime()) ? null : when.toLocaleString();

  if (entry.kind === 'fact') {
    const key = changelogFactKey(entry);
    // Forgotten facts are gone from the digest, so a present `revert` reads applied.
    const status = entry.revert ? 'applied' : null;

    return (
      <div className="space-y-1">
        {key !== null && <EntryField label="Key"><span className="font-mono">{key}</span></EntryField>}
        <EntryField label="Stored"><span className="font-mono whitespace-pre-wrap break-words">{entry.evidence || entry.summary}</span></EntryField>
        <EntryField label="Scope">this workspace</EntryField>
        {status !== null && <EntryField label="Status">{status}</EntryField>}
        {whenText !== null && <EntryField label="When"><span title={when.toISOString()}>{whenText}</span></EntryField>}
      </div>
    );
  }

  return null;
}

function useEntryRevert(entryId: string, rpc: WorkspaceRpc, onReverted: () => void) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  const revert = useCallback(() => detach(Effect.gen(function* () {
    setBusy(true);
    setNotice(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      const r = yield* Effect.promise(async () => rpc("revertChangelogEntry", [entryId]));
      setNotice({ text: r.ok ? `Reverted: ${r.detail ?? "done"}` : (r.error ?? "revert failed"), ok: r.ok });

      if (r.ok) onReverted();
    }), showing((chain) => {
      setNotice({ text: chain, ok: false });
    })), Effect.sync(() => {
      setBusy(false);
    }));
  })), [rpc, entryId, onReverted]);

  return { busy, notice, revert };
}

function entryHasDetails(entry: ChangelogEntry): boolean {
  return Boolean(entry.evidence) || (entry.items?.length ?? 0) > 0
    || entry.kind === 'fact';
}

/** The scaffold version an entry changed, as a diff below it while shown. */
function EntryScaffoldDiff({ rpc, version, shown }: { rpc: WorkspaceRpc; version: number | null | undefined; shown: boolean }) {
  if (!shown || version == null) return null;

  return <div className="mt-2"><ScaffoldVersionDiff rpc={rpc} version={version} /></div>;
}

interface ChangelogEntryCardProps {
  entry: ChangelogEntry;
  grouped?: boolean;
  seenAt: number;
  rpc: WorkspaceRpc;
  onReverted: () => void;
}

/** An entry's details, hidden until it is expanded: its facts or its evidence, the workspace it made, its child rows. */
function EntryDetails({ entry, id, expanded, rpc, onReverted }: {
  entry: ChangelogEntry; id: string; expanded: boolean; rpc: WorkspaceRpc; onReverted: () => void;
}) {
  const evidence = entry.evidence !== '' && entry.kind !== 'fact';

  return (
    <div id={id} role="region" aria-label={`Details for ${entry.summary}`} hidden={!expanded} className="mt-2 ml-6 border-t p-border pt-2">
      {entry.kind === 'fact' && <div className="mb-2"><EntryFacts entry={entry} /></div>}
      {evidence && <div className="t-meta t-mono p-text-3 whitespace-pre-wrap break-words">{entry.evidence}</div>}
      {entry.workspace !== undefined && (
        <Link to={`/workspace/${encodeURIComponent(entry.workspace)}`} className="t-meta mt-2 inline-block p-accent-fg hover:underline" data-changelog-workspace={entry.workspace}>
          Open the workspace
        </Link>
      )}
      {entry.items && entry.items.length > 0 && (
        <SubEntryList items={entry.items} className={`${evidence ? "mt-2" : ""} space-y-2`} rpc={rpc} onReverted={onReverted} />
      )}
    </div>
  );
}

export function ChangelogEntryCard({ entry, grouped = false, seenAt, rpc, onReverted }: ChangelogEntryCardProps) {
  const [kept, setKept] = useState(false);
  const { busy, notice, revert } = useEntryRevert(entry.id, rpc, onReverted);
  const [diffShown, setDiffShown] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const toggleDiff = useCallback(() => setDiffShown((shown) => !shown), []);

  const actions = entry.revert && !kept ? (
    <>
      <Button size="sm" variant="ghost" {...{ 'shape': 'square' as const }} aria-label={`Keep: ${entry.summary}`}
        onClick={() => setKept(true)} icon={<CheckIcon size={12} />} />
      <Button size="sm" variant="ghost" {...{ 'shape': 'square' as const }} aria-label={`Revert: ${entry.summary}`}
        disabled={busy} onClick={revert}
        icon={busy ? <Loader size="sm" /> : <XIcon size={12} />} />
    </>
  ) : null;

  const Icon = KIND_ICON[entry.kind];
  const fresh = entry.at > seenAt;
  const hasDetails = entryHasDetails(entry);
  const detailsId = `changelog-details-${encodeURIComponent(entry.id)}`;

  const headline = (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="t-body p-text flex-1 decoration-[var(--c-border-strong)] underline-offset-4 group-hover/expander:underline" title={entry.summary}>{entry.summary}</span>
        {fresh && !kept && <span className="shrink-0 size-1.5 rounded-full bg-[var(--c-accent)]" />}
      </div>
      <div className="t-meta mt-1 p-text-3">{timeAgo(entry.at)}</div>
    </div>
  );

  return (
    <div className={`${grouped ? "p-3" : "p-group p-3"} ${kept ? "opacity-70" : ""}`}>
      <div className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-start gap-2">
        <Icon size={14} className={`mt-px shrink-0 ${fresh ? "p-accent-fg" : "p-text-3"}`} />
        {hasDetails ? (
          <button
            type="button"
            className="group/expander min-w-0 cursor-pointer rounded-md text-left"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((previous) => !previous)}
          >
            {headline}
          </button>
        ) : headline}
        <div className="grid auto-cols-max grid-flow-col items-center gap-1 justify-self-end">
          {entry.scaffoldVersion != null && (
            <Button size="sm" variant="ghost" {...{ 'shape': 'square' as const }} onClick={toggleDiff}
              icon={<GitDiffIcon size={12} />} aria-label="Show diff" />
          )}
          {actions}
          {hasDetails && (
            <Button size="sm" variant="ghost" onClick={() => setExpanded((previous) => !previous)}
              aria-expanded={expanded} aria-controls={detailsId}
              aria-label={expanded ? `Collapse ${entry.summary}` : `Expand ${entry.summary}`}
              icon={expanded ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />} />
          )}
        </div>
      </div>

      {notice && (
        <div className={`t-status mt-2 ${notice.ok ? "p-success" : "p-danger"}`}>{notice.text}</div>
      )}

      {hasDetails && <EntryDetails entry={entry} id={detailsId} expanded={expanded} rpc={rpc} onReverted={onReverted} />}

      <EntryScaffoldDiff rpc={rpc} version={entry.scaffoldVersion} shown={diffShown} />
    </div>
  );
}

function SubEntry({ entry, rpc, onReverted }: { entry: ChangelogEntry; rpc: WorkspaceRpc; onReverted: () => void }) {
  const [kept, setKept] = useState(false);
  const { busy, notice, revert } = useEntryRevert(entry.id, rpc, onReverted);

  return (
    <li className={`rounded-md border p-border px-2 py-2 ${kept ? "opacity-70" : ""}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="t-meta p-text-2">{entry.summary}</div>
          {entry.kind === 'fact' ? (
            <div className="mt-1"><EntryFacts entry={entry} /></div>
          ) : entry.evidence && (
            <div className="t-meta t-mono mt-1 p-text-3 whitespace-pre-wrap break-words">
              {entry.evidence}
            </div>
          )}
          {notice && (
            <div className={`t-status mt-2 ${notice.ok ? "p-success" : "p-danger"}`}>{notice.text}</div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {entry.revert && !kept && (
            <>
              <Button size="sm" variant="ghost" {...{ 'shape': 'square' as const }} aria-label={`Keep: ${entry.summary}`}
                onClick={() => setKept(true)} icon={<CheckIcon size={12} />} />
              <Button size="sm" variant="ghost" {...{ 'shape': 'square' as const }} aria-label={`Revert: ${entry.summary}`}
                disabled={busy} onClick={revert}
                icon={busy ? <Loader size="sm" /> : <XIcon size={12} />} />
            </>
          )}
        </div>
      </div>
      {entry.items && entry.items.length > 0 && (
        <SubEntryList items={entry.items} className="mt-2 space-y-2 pl-2 border-l p-border" rpc={rpc} onReverted={onReverted} />
      )}
    </li>
  );
}

function SubEntryList({ items, className, rpc, onReverted }: {
  items: readonly ChangelogEntry[];
  className: string;
  rpc: WorkspaceRpc;
  onReverted: () => void;
}) {
  return (
    <ul className={className}>
      {items.map((item) => <SubEntry key={item.id} entry={item} rpc={rpc} onReverted={onReverted} />)}
    </ul>
  );
}
