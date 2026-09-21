/**
 * Self-changes — the "what I changed about myself" entries, with their evidence
 * and their per-line actions: ✓ keep (default, no-op) · ✕ revert (the REAL
 * rollback paths) · diff (scaffold entries, reusing DiffLines).
 *
 * This is the transparency surface behind the autonomy-ON defaults, and it now
 * renders as entries in the Work surface's journal rather than as a block
 * inside the agent's own description: a self-change is something that HAPPENED,
 * on the same time axis as a settled job or a closed task, and "what happened
 * while I was away" is not a question anybody opens a CV to answer.
 *
 * The load and the seen-marking are a hook so the journal can interleave these
 * with the rest of the feed by timestamp; each card owns its own kept / busy /
 * diff state, which is per-entry anyway.
 */
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

/**
 * How often the digest re-reads while the surface showing it is open.
 *
 * It is the surface-wide cadence deliberately, not a number of its own. The
 * needs-you queue polls the SAME ledger through `listPendingActions` at that
 * rate; reading the entries any slower means the queue can announce a
 * self-change the journal beneath it has not fetched yet, and "1 self-change
 * you have not seen" sits above "Nothing has settled yet" until something else
 * remounts the tab. Loading once at mount — which is what this did — made that
 * window permanent for anyone who left Work open, i.e. everyone: Work is the
 * surface a workspace opens on.
 */
export const CHANGELOG_REVALIDATE_MS = LIVE_DATA_REFRESH_MS;

/** Never stand down: unlike a plan or a fork run, a digest has no settled
 *  state to infer from what loaded — a scaffold promotion, a crafted tool or a
 *  graded turn can land on an idle workspace at any time. Exported for the
 *  other surfaces reading the same ledgers at the same cadence. */
export const changelogRevalidate = (): number => CHANGELOG_REVALIDATE_MS;

/**
 * The changelog for the surface that shows it, marked seen by the act of
 * showing it — seeing the digest IS the acknowledgement, never a blocking
 * modal. `onSeen` zeroes the tab badge upstream.
 */
export function useChangelog(rpc: Rpc, onSeen?: () => void) {
  const load = useCallback(async (): Promise<ChangelogView> => {
    const view = await rpc<ChangelogView>("getEvolutionChangelog", [{ limit: 30 }]);
    // Enrichment, not the load: a tool list that fails or misshapes leaves
    // the entries as their rows hold them. That absence is a value — the
    // digest already arrived — not a fault to fail the journal over.
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

  // Freshness is judged against the marker as it stood when this surface
  // opened, pinned on the first read. Showing the digest marks it seen, so
  // every later read answers with a marker newer than every entry — and
  // rendering against THAT would blank the new-entry dots seconds after the
  // reader arrived, on the surface whose whole job is showing what is new.
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

/** The failure state, so a broken read is never indistinguishable from a build
 *  that never had a changelog — on the very surface that justifies autonomy. */
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

/** One labelled field of a retained memory or tool: the label column is fixed
 *  so the values align down the card. */
function EntryField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 text-[11px] leading-relaxed">
      <span className="p-text-4">{label}</span>
      <span className="p-text-2 min-w-0 break-words">{children}</span>
    </div>
  );
}

/**
 * What a retained memory or tool IS, from its row. A fact's row holds its
 * key, its stored record, and a revert while it is in effect; a tool's row
 * holds its name and its stamped evidence, joined to the live tool list for
 * purpose and score. No Edit or Remove: no UI RPC exposes either, so none is
 * offered (the revert path is the entry's own `revert`, rendered by the card).
 */
function EntryFacts({ entry }: { entry: ChangelogEntryView }) {
  const when = new Date(entry.at);
  const whenText = isNaN(when.getTime()) ? null : when.toLocaleString();

  if (entry.kind === 'fact') {
    const key = changelogFactKey(entry);
    // A fact row in the digest is live: the builder lists agent_facts, and a
    // forgotten fact is gone rather than marked. `revert` present therefore
    // reads applied; a staged decision reads proposed.
    const status = entry.decision ? 'proposed' : entry.revert ? 'applied' : null;

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

export interface ChangelogEntryCardProps {
  entry: ChangelogEntryView;
  /** Render inside the journal's shared grouped-row container. */
  grouped?: boolean;
  /** Entries newer than this were unseen when the surface opened. */
  seenAt: number;
  rpc: Rpc;
  onReverted: () => void;
}

export function ChangelogEntryCard({ entry, grouped = false, seenAt, rpc, onReverted }: ChangelogEntryCardProps) {
  const [kept, setKept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [diff, setDiff] = useState<AsyncResource<ScaffoldDiff> | null>(null);
  const [expanded, setExpanded] = useState(false);

  const revert = useCallback(async () => {
    setBusy(true);
    setNotice(null);

    try {
      const r = await rpc<{ ok: boolean; detail?: string; error?: string }>("revertChangelogEntry", [entry.id]);
      setNotice({ text: r.ok ? `Reverted: ${r.detail ?? "done"}` : (r.error ?? "revert failed"), ok: r.ok });

      if (r.ok) onReverted();
    } catch (e) {
      setNotice({ text: renderThrownChain({ cause: e }), ok: false });
    } finally {
      setBusy(false);
    }
  }, [rpc, entry.id, onReverted]);

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
      // Collapsing the panel made the click look like it did nothing.
      setDiff(loadFailed({ status: "loading" }, cause));
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
  const hasDetails = Boolean(entry.evidence || entry.items?.length || entry.kind === 'fact' || entry.kind === 'tool');
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
            <ul className={`${entry.evidence && entry.kind !== 'fact' && entry.kind !== 'tool' ? "mt-2" : ""} space-y-1.5`}>
              {entry.items.map((item) => (
                <SubEntry key={item.id} entry={item} rpc={rpc} onReverted={onReverted} />
              ))}
            </ul>
          )}
        </div>
      )}

      {diff !== null && (
        diff.status === "ready" ? (
          <div className="mt-2 rounded-md border p-border overflow-hidden">
            <div className="flex items-center gap-3 px-3 py-1.5 border-b p-border p-annotation p-text-3">
              <span>v{diff.value.previousVersion ?? "∅"} → v{diff.value.version}</span>
              <span className="p-success">+{diff.value.added}</span>
              <span className="p-danger">−{diff.value.removed}</span>
            </div>
            <DiffLines lines={diff.value.lines} />
          </div>
        ) : diff.status === "error" ? (
          <LoadFailure className="mt-2" what="this diff" message={diff.message} onRetry={toggleDiff} />
        ) : <div className="flex justify-center py-3"><Loader size="sm" /></div>
      )}
    </div>
  );
}

interface StagedSkillView {
  requestId: string; routeIndex: number; target: string;
  digest: string; source: string; intact: boolean;
}

type StagedSkillResult = { ok: true; view: StagedSkillView } | { ok: false; error: string };

/**
 * READ THE BYTES, THEN DECIDE.
 *
 * A staged skill is instructions, and the only thing that can grant instructions
 * is the owner. So this opens the WHOLE file — never an excerpt, because a
 * truncated approval surface asks for a decision about bytes the decider could
 * not see — and sends back the digest it displayed. The backend refuses any
 * other digest, so a proposal that changed between the reading and the clicking
 * cannot be approved by accident.
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
        : loadFailed(previous ?? { status: "loading" }, new Error(result.error)));
    } catch (cause) {
      setStaged((previous) => loadFailed(previous ?? { status: "loading" }, cause));
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
          {/* The WHOLE file. No clamp, deliberately: see the note above. */}
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

/** A grouped entry's members — same actions, no icon or diff of their own. */
function SubEntry({ entry, rpc, onReverted }: { entry: ChangelogEntryView; rpc: Rpc; onReverted: () => void }) {
  const [kept, setKept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  const revert = useCallback(async () => {
    setBusy(true);
    setNotice(null);

    try {
      const r = await rpc<{ ok: boolean; detail?: string; error?: string }>("revertChangelogEntry", [entry.id]);
      setNotice({ text: r.ok ? `Reverted: ${r.detail ?? "done"}` : (r.error ?? "revert failed"), ok: r.ok });

      if (r.ok) onReverted();
    } catch (e) {
      setNotice({ text: renderThrownChain({ cause: e }), ok: false });
    } finally {
      setBusy(false);
    }
  }, [rpc, entry.id, onReverted]);

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
        <ul className="mt-2 space-y-1.5 pl-2 border-l p-border">
          {entry.items.map((item) => (
            <SubEntry key={item.id} entry={item} rpc={rpc} onReverted={onReverted} />
          ))}
        </ul>
      )}
    </li>
  );
}
