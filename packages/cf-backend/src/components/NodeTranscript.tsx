/** A branch rendered through `MessageView`, the main chat's renderer; user affordances are omitted by not passing them. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader } from "@cloudflare/kumo";
import {
  BrainIcon, CaretDownIcon, CaretRightIcon, CheckCircleIcon, GitForkIcon,
  TreeStructureIcon, WarningCircleIcon,
} from "@phosphor-icons/react";
import type { HeadStep, NodeTranscriptView } from "@kinu.run/core";
import { threadLiveTail, usageTotal, type TurnLiveness } from "@kinu.run/core";
import { diagnostics, renderThrownChain } from "@kinu.run/core/obs";
import { ChatLiveTail, MessageView } from "@/components/MessageView";
import {
  deltaAsMessage, stepAsMessage, NO_HEAD_DELTAS, type HeadDelta, type HeadDeltas,
} from "@kinu.run/core";
import { DetailSection, EmptyState, HistoryBoundary, MarkdownContent, Metric, CodeBlock } from "@/components/surfaces/shared";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { cleanNodeLabel, findForkNode } from "@kinu.run/core";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { useGrowingScroll } from "@/hooks/use-growing-scroll";
import type { SeekCursor } from "@kinu.run/core";
import { fmtTokens, timeAgo } from "@kinu.run/core";
import type { ForkNode, Rpc } from "@kinu.run/core";


interface OlderPageLoad {
  promise: Promise<void> | null;
}

/** Shared by this panel and the run pane's node list; covers head-journal and search-node statuses. An unknown status gets the quiet dot. */
export function statusDot(status: string): string {
  if (status === "running") return "p-dot-accent";

  if (status === "budget_exceeded") return "p-dot-warning";

  if (status === "completed" || status === "terminal") return "p-dot-success";

  if (status === "errored" || status === "failed" || status === "aborted") return "p-dot-danger";

  return "p-dot-neutral";
}

const TASK_CLAMP = 240;

function TaskHeader({ task }: { task: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = task.length > TASK_CLAMP;

  return (
    <div className="shrink-0 border-b p-border px-4 py-2.5 p-recessed">
      <div className="flex items-start gap-2">
        <div className="p-eyebrow pt-0.5 shrink-0">Task</div>
        <div className="min-w-0 flex-1">
          <div className={`p-row-text p-text-2 whitespace-pre-wrap break-words ${long && !expanded ? "line-clamp-2" : ""}`}>
            {task}
          </div>
          {long && (
            <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded}
              className="mt-1 inline-flex items-center gap-1 p-t-control p-text-3 hover:p-text transition-colors cursor-pointer">
              {expanded ? <CaretDownIcon size={10} /> : <CaretRightIcon size={10} />}
              {expanded ? "collapse" : "expand"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SearchPath({ view, onSelect }: {
  view: NodeTranscriptView;
  onSelect?: (nodeId: string) => void;
}) {
  return (
    <nav aria-label="Search path" className="flex items-center gap-1 min-w-0 overflow-x-auto">
      <TreeStructureIcon size={11} className="p-text-3 shrink-0" />
      {view.path.map((crumb, index) => {
        const here = index === view.path.length - 1 || onSelect === undefined;
        // An empty first-crumb label (always, for MCTS) falls back to its depth.
        const label = cleanNodeLabel(crumb.label, `depth ${crumb.depth}`);

        return (
          <span key={crumb.id} className="flex items-center gap-1 shrink-0">
            {index > 0 && <span className="p-text-3 p-meta">/</span>}
            {here ? (
              <span className="p-t-control p-text max-w-[14rem] truncate" title={label}>{label}</span>
            ) : (
              <button onClick={() => onSelect(crumb.id)} title={label}
                className="p-t-control p-text-3 hover:p-text transition-colors max-w-[10rem] truncate cursor-pointer">
                {label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function Outcome({ view }: { view: NodeTranscriptView }) {
  return (
    <>
      {view.errorMessage && (
        <div className="shrink-0 border-b p-border border-l-2 px-4 py-3"
          style={{ background: "var(--c-danger-tint)", borderLeftColor: "var(--c-danger)" }}>
          <div className="flex items-center gap-1.5 p-t-status uppercase tracking-normal p-danger">
            <WarningCircleIcon size={11} weight="fill" />
            {view.status === "aborted" ? "Stopped" : "Failed"}
          </div>
          <div className="mt-1 p-row-text p-text-2 break-words">{view.errorMessage}</div>
        </div>
      )}
      {view.answer && (
        <div className="shrink-0 border-b p-border border-l-2 px-4 py-3 p-elevated"
          style={{ borderLeftColor: "var(--c-accent)" }}>
          <div className="flex items-center gap-1.5 p-t-status uppercase tracking-normal p-accent">
            <CheckCircleIcon size={11} weight="fill" />
            {view.origin === "head" ? "Report" : "Proposal"}
          </div>
          <div className="mt-1 prose-chat p-text max-h-64 overflow-y-auto">
            <MarkdownContent content={view.answer} />
          </div>
        </div>
      )}
      {view.codeUsed && (
        <div className="shrink-0 border-b p-border px-4 py-2.5">
          <div className="p-eyebrow">Code draft</div>
          <div className="max-h-40 overflow-auto"><CodeBlock className="language-js">{view.codeUsed}</CodeBlock></div>
        </div>
      )}
    </>
  );
}

function EmptyTrace({ view }: { view: NodeTranscriptView }) {
  if (view.origin === "rollout") {
    return (
      <EmptyState icon={<GitForkIcon size={24} />} title="A rollout has no step trace"
        hint="This branch made one proposal. The search scored it against its siblings." />
    );
  }

  if (view.status === "running") {
    return (
      <div className="flex items-center gap-2 py-8 justify-center p-t-status p-text-2">
        <Loader size="sm" />
        {view.lastStepAt === null
          ? "Working. This branch has not finished its first step."
          : "Working. Waiting on the next step."}
      </div>
    );
  }

  return (
    <EmptyState icon={<BrainIcon size={24} />} title="This branch recorded no steps"
      hint={view.errorMessage
        ? "It stopped before finishing a step. The reason is above."
        : "It stopped before finishing its first step, and reported no error."} />
  );
}

function clockValue(view: NodeTranscriptView, live: boolean): string {
  if (!live) return view.wallClockMs > 0 ? `${view.wallClockMs}ms` : "—";

  return view.lastStepAt === null ? "—" : timeAgo(view.lastStepAt);
}

export function TranscriptBody({ view, onSelect, older, onLoadOlder, pending }: {
  view: NodeTranscriptView;
  onSelect?: (nodeId: string) => void;
  older?: {
    readonly steps: readonly HeadStep[];
    readonly hasMore: boolean;
    readonly loading: boolean;
    readonly error: string | null;
  };
  onLoadOlder?: () => void;
  /** Never merged into the trace: counts and paging are computed from the journal. */
  pending?: HeadDelta;
}) {
  const live = view.status === "running";
  // Memoised on page identities: rebuilding re-folds every step and re-renders every MessageView.
  const olderSteps = older?.steps;
  const viewSteps = view.steps.items;

  const allSteps = useMemo(
    () => (olderSteps ? [...olderSteps, ...viewSteps] : viewSteps),
    [olderSteps, viewSteps],
  );

  const messages = useMemo(
    () => allSteps.map((step, index) => stepAsMessage(step, index, view.nodeId)),
    [allSteps, view.nodeId],
  );

  const arriving = useMemo(
    () => (live ? deltaAsMessage(pending, view.nodeId) : null),
    [live, pending, view.nodeId],
  );

  // Follow the newest step only while running; a settled transcript must not scroll under the reader.
  const tail = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (live) tail.current?.scrollIntoView({ block: "end" });
  }, [live, messages.length, arriving]);

  const scrollerRef = useGrowingScroll({
    grows: "up",
    content: messages,
    fetched: older?.steps.length ?? 0,
    loading: older?.loading ?? false,
    onReachEdge: older?.hasMore && !older.loading && !older.error ? onLoadOlder : undefined,
  });

  const liveness: TurnLiveness = live ? { kind: "live", turnId: null } : { kind: "idle" };

  const durableTail = threadLiveTail({ last: messages.at(-1), liveness });

  const arrivingTail = threadLiveTail({ last: arriving ?? undefined, liveness });

  return (
    <div className="min-h-0 flex-1 flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b p-border">
        <span className={`size-1.5 rounded-full shrink-0 ${statusDot(view.status)} ${live ? "p-dot-pulse" : ""}`} />
        <span className="p-t-status uppercase tracking-normal p-text-3 shrink-0">{view.status}</span>
        <div className="h-3 w-px bg-[var(--c-border)] shrink-0" />
        <SearchPath view={view} onSelect={onSelect} />
      </div>

      <TaskHeader task={view.task} />
      {view.rationale && (
        <div className="shrink-0 border-b p-border px-4 py-2 p-row-text p-text-3 break-words">
          <span className="p-eyebrow">Why this branch</span> · {view.rationale}
        </div>
      )}
      <Outcome view={view} />

      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 && arriving === null ? <EmptyTrace view={view} /> : (
          <div className="space-y-3">
            {older && (older.hasMore || older.loading || older.error) && (
              <HistoryBoundary
                loading={older.loading}
                error={older.error}
                exhausted={!older.hasMore}
                onRetry={onLoadOlder ?? (() => {})}
              />
            )}
            {/* Only the arriving step claims the live caret. */}
            {messages.map((message, index) => (
              <MessageView key={message.id} message={message}
                liveTail={arriving === null && index === messages.length - 1 ? durableTail : null} />
            ))}
            {arriving && (
              <div data-node-pending-step>
                <MessageView message={arriving} liveTail={arrivingTail} />
                <ChatLiveTail tail={arrivingTail} />
              </div>
            )}
            <div ref={tail} />
          </div>
        )}
        {view.decisions.length > 0 && (
          <div className="mt-3">
            <DetailSection title="Decisions">
              <div className="space-y-1">
                {view.decisions.map((decision, index) => (
                  <div key={index} className="rounded-md p-fill border p-border p-2 p-row-text">
                    <div className="p-text-2">{decision.question}</div>
                    <div className="p-accent mt-0.5">→ {decision.choice}</div>
                    {decision.rationale && <div className="p-text-3 mt-0.5">{decision.rationale}</div>}
                  </div>
                ))}
              </div>
            </DetailSection>
          </div>
        )}
      </div>

      {/* Store totals, not page counts, so paging never shrinks the metrics. */}
      <div className="shrink-0 border-t p-border px-4 py-2 grid grid-cols-4 gap-2">
        <Metric label="Steps" value={view.stepCount} />
        <Metric label="Tools" value={view.toolCount} />
        <Metric label="Tokens" value={fmtTokens(usageTotal(view.usage))} />
        <Metric label={live ? "Last step" : "Wall"} value={clockValue(view, live)} />
      </div>
    </div>
  );
}

const TRANSCRIPT_FALLBACK_MS = 4_000;

export function useNodeTranscript({ runId, nodeId, rpc, headActivity, headDeltas, running = false }: {
  runId: string | null;
  nodeId: string | null;
  rpc: Rpc;
  headActivity: ReadonlyMap<string, number>;
  headDeltas: HeadDeltas;
  /** Seed only: once loaded, the journal's own status decides the cadence. */
  running?: boolean;
}) {
  const load = useCallback(
    () => runId === null || nodeId === null
      ? Promise.resolve<NodeTranscriptView | null>(null)
      : rpc<NodeTranscriptView | null>("getNodeTranscript", [runId, nodeId]),
    [rpc, runId, nodeId],
  );

  const subject = `${runId}:${nodeId}`;

  /** Fallback poll under the push: a missed socket frame has no other recovery. Armed only while running. */
  const revalidate = useCallback(
    (view: NodeTranscriptView | null) =>
      (view === null ? running : view.status === "running") ? TRANSCRIPT_FALLBACK_MS : null,
    [running],
  );

  // `null` is a valid answer (neither store holds the node).
  const { resource, reload } = useAsyncResource<NodeTranscriptView | null>(load, revalidate, subject);

  const tick = nodeId === null ? 0 : headActivity.get(nodeId) ?? 0;
  const seen = useRef({ subject, tick });
  useEffect(() => {
    const previous = seen.current;
    seen.current = { subject, tick };

    // Re-load rather than re-key so the visible trace stays on screen while refreshing.
    if (previous.subject === subject && previous.tick !== tick) reload();
  }, [subject, tick, reload]);

  // The boundary cursor freezes once the first older page lands; new steps change only the view.
  const [walk, setWalk] = useState<{ steps: HeadStep[]; hasMore: boolean; below: SeekCursor | null; loading: boolean; error: string | null }>(
    () => ({ steps: [], hasMore: false, below: null, loading: false, error: null }),
  );

  useEffect(() => { setWalk({ steps: [], hasMore: false, below: null, loading: false, error: null }); }, [subject]);

  const view = lastValue(resource);

  /** Retire the live delta when the journal's step count rises, whichever read revealed it; otherwise the step paints twice. */
  const journalled = useRef({ subject, steps: -1 });
  useEffect(() => {
    const steps = view?.stepCount ?? -1;

    if (steps < 0 || nodeId === null) return;
    const before = journalled.current;
    journalled.current = { subject, steps };

    if (before.subject === subject && steps > before.steps) headDeltas.retire(nodeId);
  }, [subject, nodeId, view?.stepCount, headDeltas]);

  const hasMore = walk.steps.length > 0 ? walk.hasMore : view?.steps.status === 'more';
  const viewBelow = view?.steps.status === 'more' ? view.steps.next : null;
  const below = walk.steps.length > 0 ? walk.below : viewBelow;
  const walkRef = useRef(subject);
  walkRef.current = subject;
  const inFlight = useRef<OlderPageLoad | null>(null);

  const loadOlder = useCallback(() => {
    const at = walkRef.current;

    if (inFlight.current !== null || below === null) return;
    setWalk((prev) => ({ ...prev, loading: true, error: null }));
    const owner: OlderPageLoad = { promise: null };
    // Install the strong action owner before a synchronous RPC fake can settle the page load.
    inFlight.current = owner;
    owner.promise = (async () => {
      try {
        try {
          const next = await rpc<NodeTranscriptView | null>('getNodeTranscript', [runId, nodeId, { cursor: below }]);

          if (walkRef.current !== at) return;

          if (!next) {
            setWalk((prev) => ({ ...prev, loading: false, error: 'This trace could not be read.' }));

            return;
          }

          setWalk((prev) => ({
            steps: [...next.steps.items, ...prev.steps],
            hasMore: next.steps.status === 'more',
            below: next.steps.status === 'more' ? next.steps.next : null,
            loading: false,
            error: null,
          }));
        } catch (cause) {
          diagnostics.event('transcript.older_page_abandoned',
            { subject: at, error: renderThrownChain({ cause }) });

          if (walkRef.current === at) {
            setWalk((prev) => ({ ...prev, loading: false, error: renderThrownChain({ cause }) }));
          }
        }
      } catch (cause) {
        diagnostics.event('transcript.older_page_handler_failed',
          { subject: at, error: renderThrownChain({ cause }) });
      } finally {
        if (inFlight.current === owner) inFlight.current = null;
      }
    })();
  }, [rpc, runId, nodeId, below]);

  return {
    view,
    resource,
    reload,
    older: { steps: walk.steps, hasMore, loading: walk.loading, error: walk.error },
    loadOlder,
    pending: nodeId === null ? undefined : headDeltas.get(nodeId),
  };
}

export function NodeTranscript({ selection, trees, rpc, headActivity, headDeltas = NO_HEAD_DELTAS, onSelect }: {
  /** Structural: a transcript panel must not depend on the canvas module that owns `ExplorerSelection`. */
  selection: { runId: string; nodeId: string } | null;
  trees: ReadonlyMap<string, ForkNode>;
  rpc: Rpc;
  headActivity: ReadonlyMap<string, number>;
  headDeltas?: HeadDeltas;
  onSelect: (nodeId: string) => void;
}) {
  const runId = selection?.runId ?? null;
  const nodeId = selection?.nodeId ?? null;
  const drawnRoot = runId === null ? undefined : trees.get(runId);
  const drawn = drawnRoot && nodeId !== null ? findForkNode(drawnRoot, nodeId) : null;

  const { view, resource, reload, older, loadOlder, pending } = useNodeTranscript({
    runId, nodeId, rpc, headActivity, headDeltas, running: drawn?.status === "running",
  });

  const drawnLabel = cleanNodeLabel(drawn?.action, nodeId ?? "this branch");

  if (selection === null) {
    return (
      <div className="min-h-0 flex-1 flex items-center justify-center rounded-lg border p-border p-surface">
        <EmptyState icon={<TreeStructureIcon size={28} />} title="Pick a branch"
          hint="Select one in the tree to read its input, every step, and its answer." />
      </div>
    );
  }

  let body: ReactNode = null;

  if (view) {
    body = (
      <TranscriptBody view={view} onSelect={onSelect} older={older} onLoadOlder={loadOlder}
        pending={pending} />
    );
  } else if (resource.status === "loading") {
    body = (
      <div className="flex-1 flex items-center justify-center gap-2 p-t-status p-text-2">
        <Loader size="sm" />Reading the branch…
      </div>
    );
  } else if (resource.status === "ready") {
    // Null view: neither store holds this node (distinct from a node with no steps).
    body = (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState icon={<TreeStructureIcon size={28} />} title="This branch is no longer in the run"
          hint={`Nothing is recorded for ${drawnLabel}. The search pruned it, or the run was rewritten.`} />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 flex flex-col rounded-lg border p-border p-surface overflow-hidden">
      {/* Keeps the last loaded transcript underneath the error. */}
      {resource.status === "error" && (
        <LoadFailure what="this branch's transcript" message={resource.message} onRetry={reload}
          className="shrink-0 border-b p-border px-4 py-2" />
      )}
      {body}
    </div>
  );
}

