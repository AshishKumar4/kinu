import { useState, useEffect, useCallback, useRef } from "react";
import type { ComponentType, ReactNode } from "react";
import { Button, Loader, type ButtonProps } from "@cloudflare/kumo";
import {
  GitBranchIcon, PackageIcon, BrainIcon,
  SparkleIcon, TimerIcon, ChecksIcon, CheckIcon, XIcon, GitDiffIcon,
  NotePencilIcon, ArrowsClockwiseIcon,
  CaretDownIcon, CaretRightIcon,
} from "@phosphor-icons/react";
import type { ChangelogEntryKind, DiffLine } from "@kinu.run/core";
import * as v from "valibot";
import type { Rpc } from "@kinu.run/core";
import { LIVE_DATA_REFRESH_MS } from "@/hooks/use-kinu";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { diagnostics, renderThrownChain, toKinuError } from "@kinu.run/core/obs";
import { type AsyncResource, lastValue, loadFailed, loadSucceeded, useAsyncResource } from "@/hooks/use-async-resource";
import {
  DiffLines, CodeBlock,
  changelogFactKey, changelogToolName, withToolDetails,
  type ChangelogEntryView, type CraftedToolDetail,
} from "./shared";
import { timeAgo } from "@kinu.run/core";

export interface ChangelogView { entries: ChangelogEntryView[]; unseenCount: number; seenAt: number }

const CraftedToolListSchema = v.looseObject({
  crafted: v.optional(v.array(v.looseObject({
    name: v.string(),
    description: v.optional(v.string()),
    qualityScore: v.optional(v.number()),
    usageCount: v.optional(v.number()),
  }))),
});

interface ScaffoldDiff { version: number; previousVersion: number | null; added: number; removed: number; lines: DiffLine[] }

const KIND_ICON = {
  scaffold: GitBranchIcon,
  tool: PackageIcon,
  fact: BrainIcon,
  gepa: SparkleIcon,
  replay: TimerIcon,
  outcomes: ChecksIcon,
  prompt_section: NotePencilIcon,
  refinement: ArrowsClockwiseIcon,
} satisfies Record<ChangelogEntryKind, ComponentType<{ size?: number; className?: string }>>;

/** The needs-you queue polls the same ledger at this cadence; a slower read lets it announce a self-change the journal has not fetched. */
export const CHANGELOG_REVALIDATE_MS = LIVE_DATA_REFRESH_MS;

/** A digest has no settled state: a self-change can land on an idle workspace at any time. */
export const changelogRevalidate = (): number => CHANGELOG_REVALIDATE_MS;

/** Showing the digest marks it seen; `onSeen` zeroes the tab badge upstream. */
export function useChangelog(rpc: Rpc, onSeen?: () => void) {
  const load = useCallback(async (): Promise<ChangelogView> => {
    const view = await rpc<ChangelogView>("getEvolutionChangelog", [{ limit: 30 }]);
    // Enrichment only: a failed or misshapen tool list leaves the entries as their rows hold them.
    let tools: CraftedToolDetail[] = [];

    try {
      const parsed = v.safeParse(CraftedToolListSchema, await rpc<unknown>("getToolDescriptions", []));

      if (parsed.success) {
        tools = (parsed.output.crafted ?? []).map((tool) => ({
          name: tool.name, description: tool.description ?? '',
          qualityScore: tool.qualityScore ?? 0.5, usageCount: tool.usageCount ?? 0,
        }));
      }
    } catch (cause) {
      diagnostics.failure('changelog.tool_list_unavailable', toKinuError({
        doing: 'enriching changelog tool entries with the live tool list',
        cause, otherwise: 'unavailable',
      }));
      tools = [];
    }

    return { ...view, entries: withToolDetails(view.entries, tools) };
  }, [rpc]);

  const { resource, reload } = useAsyncResource(load, changelogRevalidate);
  const view = lastValue(resource);

  // Freshness is judged against the marker pinned on first read; later reads return a marker newer than every entry.
  const openedSeenAt = useRef<number | null>(null);

  if (openedSeenAt.current === null && view !== null) openedSeenAt.current = view.seenAt;

  const [seenError, setSeenError] = useState<string | null>(null);

  const markSeen = useCallback(async () => {
    if (!view || view.unseenCount === 0) return;
    await rpc("markChangelogSeen", []);
    setSeenError(null);
    onSeen?.();
  }, [view, rpc, onSeen]);

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

  return <div className="flex items-center justify-center gap-2 py-4 text-xs p-text-3" role="status">
    <Loader size="sm" />
    <span>Loading journal…</span>
  </div>;
}

function EntryField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 text-[11px] leading-relaxed">
      <span className="p-text-4">{label}</span>
      <span className="p-text-2 min-w-0 break-words">{children}</span>
    </div>
  );
}

/** No Edit or Remove: no UI RPC exposes either. */
function EntryFacts({ entry }: { entry: ChangelogEntryView }) {
  const when = new Date(entry.at);
  const whenText = isNaN(when.getTime()) ? null : when.toLocaleString();

  if (entry.kind === 'fact') {
    const key = changelogFactKey(entry);
    // Forgotten facts are gone from the digest, so a present `revert` reads applied; a staged decision reads proposed.
    let status: string | null = null;

    if (entry.decision) status = 'proposed';
    else if (entry.revert) status = 'applied';

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

  if (entry.kind === 'tool') {
    const name = changelogToolName(entry);
    const detail = entry.toolDetail;

    return (
      <div className="space-y-1">
        {name !== null && <EntryField label="Tool"><span className="font-mono">{name}</span></EntryField>}
        {detail ? (
          <>
            {detail.description !== '' && <EntryField label="Purpose">{detail.description}</EntryField>}
            <EntryField label="Score">EMA {detail.qualityScore.toFixed(2)} over {detail.usageCount} use{detail.usageCount === 1 ? '' : 's'}</EntryField>
            <EntryField label="Scope">this workspace</EntryField>
          </>
        ) : (
          <EntryField label="Stored"><span className="font-mono whitespace-pre-wrap break-words">{entry.evidence || entry.summary}</span></EntryField>
        )}
        {whenText !== null && <EntryField label="Updated"><span title={when.toISOString()}>{whenText}</span></EntryField>}
      </div>
    );
  }

  return null;
}

function useEntryRevert(entryId: string, rpc: Rpc, onReverted: () => void) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  const revert = useCallback(async () => {
    setBusy(true);
    setNotice(null);

    try {
      const r = await rpc<{ ok: boolean; detail?: string; error?: string }>("revertChangelogEntry", [entryId]);
      setNotice({ text: r.ok ? `Reverted: ${r.detail ?? "done"}` : (r.error ?? "revert failed"), ok: r.ok });

      if (r.ok) onReverted();
    } catch (e) {
      setNotice({ text: renderThrownChain({ cause: e }), ok: false });
    } finally {
      setBusy(false);
    }
  }, [rpc, entryId, onReverted]);

  return { busy, notice, revert };
}

function entryHasDetails(entry: ChangelogEntryView): boolean {
  return Boolean(entry.evidence) || (entry.items?.length ?? 0) > 0
    || entry.kind === 'fact' || entry.kind === 'tool';
}

function EntryScaffoldDiff({ diff, onRetry }: {
  diff: AsyncResource<ScaffoldDiff> | null;
  onRetry: () => void;
}) {
  if (diff === null) return null;

  if (diff.status === "error") {
    return <LoadFailure className="mt-2" what="this diff" message={diff.message} onRetry={onRetry} />;
  }

  if (diff.status === "loading") return <div className="flex justify-center py-3"><Loader size="sm" /></div>;

  return (
    <div className="mt-2 rounded-md border p-border overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-1.5 border-b p-border p-annotation p-text-3">
        <span>v{diff.value.previousVersion ?? "∅"} → v{diff.value.version}</span>
        <span className="p-success">+{diff.value.added}</span>
        <span className="p-danger">−{diff.value.removed}</span>
      </div>
      <DiffLines lines={diff.value.lines} />
    </div>
  );
}

export interface ChangelogEntryCardProps {
  entry: ChangelogEntryView;
  grouped?: boolean;
  seenAt: number;
  rpc: Rpc;
  onReverted: () => void;
}

export function ChangelogEntryCard({ entry, grouped = false, seenAt, rpc, onReverted }: ChangelogEntryCardProps) {
  const [kept, setKept] = useState(false);
  const { busy, notice, revert } = useEntryRevert(entry.id, rpc, onReverted);
  const [diff, setDiff] = useState<AsyncResource<ScaffoldDiff> | null>(null);
  const [expanded, setExpanded] = useState(false);

  const toggleDiff = useCallback(async () => {
    if (diff !== null) {
      setDiff(null);

      return;
    }

    if (entry.scaffoldVersion == null) return;
    setDiff({ status: "loading" });

    try {
      const d = await rpc<ScaffoldDiff>("getScaffoldDiff", [entry.scaffoldVersion]);
      setDiff(loadSucceeded(d));
    } catch (cause) {
      setDiff(loadFailed({ status: "loading" }, { cause }));
    }
  }, [rpc, entry.scaffoldVersion, diff]);

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
        <span className="p-row-text p-text flex-1" title={entry.summary}>{entry.summary}</span>
        {fresh && !kept && <span className="shrink-0 size-1.5 rounded-full bg-[var(--c-accent)]" />}
      </div>
      <div className="mt-1 p-meta p-text-3">{timeAgo(entry.at)}</div>
    </div>
  );

  return (
    <div className={`${grouped ? "p-3" : "p-group p-3"} ${kept ? "opacity-70" : ""}`}>
      <div className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-start gap-2">
        <Icon size={14} className={`mt-0.5 shrink-0 ${fresh ? "p-accent" : "p-text-3"}`} />
        {hasDetails ? (
          <button
            type="button"
            className="min-w-0 rounded-md text-left"
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
            <Button size="sm" variant="ghost" {...({ 'shape': 'square' } satisfies Pick<ButtonProps, 'shape'>)} onClick={() => setExpanded((previous) => !previous)}
              aria-expanded={expanded} aria-controls={detailsId}
              aria-label={expanded ? `Collapse ${entry.summary}` : `Expand ${entry.summary}`}
              icon={expanded ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />} />
          )}
        </div>
      </div>

      {notice && (
        <div className={`mt-1.5 p-t-status ${notice.ok ? "p-success" : "p-danger"}`}>{notice.text}</div>
      )}

      {hasDetails && (
        <div id={detailsId} role="region" aria-label={`Details for ${entry.summary}`} hidden={!expanded}
          className="mt-2 ml-6 border-t p-border pt-2">
          {(entry.kind === 'fact' || entry.kind === 'tool') && (
            <div className="mb-2"><EntryFacts entry={entry} /></div>
          )}
          {entry.evidence && entry.kind !== 'fact' && entry.kind !== 'tool' && (
            <div className="p-annotation p-text-3 whitespace-pre-wrap break-words">
              {entry.evidence}
            </div>
          )}
          {entry.items && entry.items.length > 0 && (
            <SubEntryList
              items={entry.items}
              className={`${entry.evidence && entry.kind !== 'fact' && entry.kind !== 'tool' ? "mt-2" : ""} space-y-1.5`}
              rpc={rpc}
              onReverted={onReverted}
            />
          )}
        </div>
      )}

      <EntryScaffoldDiff diff={diff} onRetry={toggleDiff} />
    </div>
  );
}

interface StagedSkillView {
  requestId: string; routeIndex: number; target: string;
  digest: string; source: string; intact: boolean;
}

type StagedSkillResult = { ok: true; view: StagedSkillView } | { ok: false; error: string };

/**
 * Opens the whole file, never an excerpt, and sends back the digest it displayed; the backend
 * refuses any other digest, so a proposal changed after reading cannot be approved.
 */
function StagedSkillDecision(
  { decision, rpc, onDecided }: {
    decision: { requestId: string; routeIndex: number };
    rpc: Rpc;
    onDecided: () => void;
  },
) {
  const [staged, setStaged] = useState<AsyncResource<StagedSkillView> | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  const open = useCallback(async () => {
    if (staged !== null) {
      setStaged(null);

      return;
    }

    setStaged({ status: "loading" });

    try {
      const result = await rpc<StagedSkillResult>("showRefinement", [decision.requestId, decision.routeIndex]);
      setStaged((previous) => result.ok
        ? loadSucceeded(result.view)
        : loadFailed(previous ?? { status: "loading" }, { cause: new Error(result.error) }));
    } catch (cause) {
      setStaged((previous) => loadFailed(previous ?? { status: "loading" }, { cause }));
    }
  }, [rpc, decision.requestId, decision.routeIndex, staged]);

  const decide = useCallback(async (verdict: "approve" | "reject", digest: string) => {
    setBusy(true);
    setNotice(null);

    try {
      const result = await rpc<{ ok: boolean; detail?: string; error?: string }>(
        "decideRefinement",
        [{
          requestId: decision.requestId,
          routeIndex: decision.routeIndex,
          expectedDigest: digest,
          decision: verdict,
        }],
      );

      setNotice({ text: result.ok ? (result.detail ?? "done") : (result.error ?? "failed"), ok: result.ok });

      if (result.ok) onDecided();
    } catch (error) {
      setNotice({ text: renderThrownChain({ cause: error }), ok: false });
    } finally {
      setBusy(false);
    }
  }, [rpc, decision.requestId, decision.routeIndex, onDecided]);

  return (
    <div className="mt-1.5">
      <Button size="sm" variant="ghost" onClick={open}>
        {staged === null ? "Read the proposed skill" : "Hide"}
      </Button>
      {staged?.status === "error" && (
        <div className="mt-1.5 p-t-status p-danger">{staged.message}</div>
      )}
      {staged?.status === "loading" && (
        <div className="flex justify-center py-3"><Loader size="sm" /></div>
      )}
      {staged?.status === "ready" && (
        <div className="mt-1.5 rounded-md border p-border overflow-hidden">
          <div className="px-3 py-1.5 border-b p-border p-annotation p-text-3 break-all">
            {staged.value.target} · {staged.value.digest}
          </div>
          {!staged.value.intact && (
            <div className="px-3 py-1.5 border-b p-border p-t-status p-danger">
              These bytes differ from the refinement's record. Re-run the refinement before approving.
            </div>
          )}
          <div className="max-h-96 overflow-auto px-3"><CodeBlock className={`language-${staged.value.target.split('.').at(-1) ?? ''}`}>{staged.value.source}</CodeBlock></div>
          <div className="flex items-center gap-2 px-3 py-2 border-t p-border">
            <Button size="sm" disabled={busy || !staged.value.intact}
              onClick={() => decide("approve", staged.value.digest)}>
              Approve these bytes
            </Button>
            <Button size="sm" variant="ghost" disabled={busy}
              onClick={() => decide("reject", staged.value.digest)}>
              Reject
            </Button>
            {busy && <Loader size="sm" />}
          </div>
        </div>
      )}
      {notice && (
        <div className={`mt-1.5 p-t-status ${notice.ok ? "p-success" : "p-danger"}`}>{notice.text}</div>
      )}
    </div>
  );
}

function SubEntry({ entry, rpc, onReverted }: { entry: ChangelogEntryView; rpc: Rpc; onReverted: () => void }) {
  const [kept, setKept] = useState(false);
  const { busy, notice, revert } = useEntryRevert(entry.id, rpc, onReverted);

  return (
    <li className={`rounded-md border p-border px-2.5 py-2 ${kept ? "opacity-70" : ""}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs p-text-2 leading-relaxed">{entry.summary}</div>
          {(entry.kind === 'fact' || entry.kind === 'tool') ? (
            <div className="mt-1"><EntryFacts entry={entry} /></div>
          ) : entry.evidence && (
            <div className="mt-1 p-annotation p-text-3 whitespace-pre-wrap break-words">
              {entry.evidence}
            </div>
          )}
          {notice && (
            <div className={`mt-1.5 p-t-status ${notice.ok ? "p-success" : "p-danger"}`}>{notice.text}</div>
          )}
          {entry.decision && (
            <StagedSkillDecision decision={entry.decision} rpc={rpc} onDecided={onReverted} />
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
        <SubEntryList items={entry.items} className="mt-2 space-y-1.5 pl-2 border-l p-border" rpc={rpc} onReverted={onReverted} />
      )}
    </li>
  );
}

function SubEntryList({ items, className, rpc, onReverted }: {
  items: readonly ChangelogEntryView[];
  className: string;
  rpc: Rpc;
  onReverted: () => void;
}) {
  return (
    <ul className={className}>
      {items.map((item) => <SubEntry key={item.id} entry={item} rpc={rpc} onReverted={onReverted} />)}
    </ul>
  );
}
