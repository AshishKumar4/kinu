/**
 * A branch, read the way the chat is read.
 *
 * The owner's ask, verbatim: *"when I open one of the nodes, I should be able to
 * see the agent's transcript/entire behavior, just the way I can see that of the
 * main or subordinate agents in the main chat view — infact, it should just be
 * like a chat view except there are no user inputs or user messages."*
 *
 * So it IS the chat view. Every step goes through `MessageView` — the same
 * component `WorkspacePage` renders the main thread with — which is what buys
 * reasoning blocks that expand, tool calls with real input/output panels and
 * language-aware code fences, failure detection, and markdown prose, none of
 * which a second renderer would keep in step. The user affordances are removed
 * by NOT passing them: `onFork`, `onFeedback`, `onRestoreFiles` and `takesChip`
 * are optional, every step is `role: 'assistant'`, and a branch has no user
 * turns to draw in the first place.
 *
 * What this file owns is therefore only the fold — `HeadStep` → `UIMessage` — and
 * the frame around it: the task pinned and expandable, the answer highlighted
 * away from the steps that reached it, the path back to the root, and four
 * distinguishable ways for there to be nothing to show.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader } from "@cloudflare/kumo";
import {
  BrainIcon, CaretDownIcon, CaretRightIcon, CheckCircleIcon, GitForkIcon,
  TreeStructureIcon, WarningCircleIcon,
} from "@phosphor-icons/react";
import type { UIMessage } from "ai";
import type { HeadStep, HeadStepToolCall, NodeTranscriptView } from "@proteus/core";
import { usageTotal } from "@proteus/core";
import { MessageView } from "@/components/MessageView";
import { DetailSection, EmptyState, MarkdownContent, Metric, timeAgo } from "@/components/surfaces/shared";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { cleanNodeLabel, findForkNode } from "@/components/swarm-tree-model";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { fmtTokens } from "@/lib/format";
import type { ForkNode, Rpc } from "@/lib/protocol";

/* ── the fold: a branch's trace as chat messages ─────────────────── */

/**
 * One recorded step as one assistant message.
 *
 * A step is exactly what the chat already draws: optional reasoning, optional
 * prose, and the calls it made. The only translation needed is the tool shape —
 * the journal stores `{ name, input, output }` and the chat reads AI-SDK tool
 * parts — so that is all this does.
 *
 * `dynamic-tool` rather than a typed `tool-<name>` part because the head's tool
 * set is not statically known to the browser, and `groupMessageParts` /
 * `ToolCallPart` treat both variants identically by design (tool-call-grouping.ts).
 *
 * A call with no recorded output is `input-available`, which the chat draws as
 * still running — true of the step a live branch is in the middle of, and the
 * honest reading of a call whose result never came back.
 */
function stepAsMessage(step: HeadStep, index: number, headId: string): UIMessage {
  const parts: UIMessage["parts"] = [];
  if (step.reasoning) parts.push({ type: "reasoning", text: step.reasoning, state: "done" });
  if (step.text) parts.push({ type: "text", text: step.text, state: "done" });
  step.toolCalls.forEach((call: HeadStepToolCall, callIndex) => {
    const toolCallId = `${headId}-s${index}-t${callIndex}`;
    parts.push(call.output === undefined
      ? { type: "dynamic-tool", toolName: call.name, toolCallId, state: "input-available", input: call.input }
      : { type: "dynamic-tool", toolName: call.name, toolCallId, state: "output-available", input: call.input, output: call.output });
  });
  return { id: `${headId}-s${index}`, role: "assistant", parts };
}

/* ── the frame ───────────────────────────────────────────────────── */
/**
 * One dot vocabulary, covering BOTH lifecycles this panel can show: a head's
 * journal status and a search node's status. Colours and shape match the tree's
 * own `statusDot`, so the node the reader clicked does not change colour when
 * its panel opens. A word neither vocabulary declares gets the quiet dot — an
 * unrecognised status is not an error.
 */
function statusDot(status: string): string {
  if (status === "running" || status === "budget_exceeded") return "p-dot-warning";
  if (status === "completed" || status === "terminal") return "p-dot-success";
  if (status === "errored" || status === "failed" || status === "aborted") return "p-dot-danger";
  return "p-dot-neutral";
}

/** How much task text reads as a heading rather than as a wall. */
const TASK_CLAMP = 240;

/**
 * The task, pinned and expandable.
 *
 * Pinned because it is the one thing a reader needs while scrolling everything
 * else — a step ten deep means nothing without the ask it belongs to — and
 * collapsed because a fork task is routinely a paragraph. Below the threshold
 * there is no affordance at all: a disclosure control that never hides anything
 * is chrome.
 */
function TaskHeader({ task }: { task: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = task.length > TASK_CLAMP;
  return (
    <div className="shrink-0 border-b p-border px-4 py-2.5 p-recessed">
      <div className="flex items-start gap-2">
        <div className="text-[10px] uppercase tracking-normal p-text-3 pt-0.5 shrink-0">Task</div>
        <div className="min-w-0 flex-1">
          <div className={`text-[12px] p-text-2 leading-relaxed whitespace-pre-wrap break-words ${long && !expanded ? "line-clamp-2" : ""}`}>
            {task}
          </div>
          {long && (
            <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded}
              className="mt-1 inline-flex items-center gap-1 text-[10px] p-text-3 hover:p-text transition-colors cursor-pointer">
              {expanded ? <CaretDownIcon size={10} /> : <CaretRightIcon size={10} />}
              {expanded ? "Show less" : `Show all ${task.length} characters`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Root → this node.
 *
 * Where the reader is, and the way back out. Every crumb but the last is a
 * control: selecting an ancestor is how you leave a branch you followed too far,
 * which the tree alone could only do by finding the node again.
 */
function SearchPath({ view, onSelect }: {
  view: NodeTranscriptView;
  /** Absent when the view has nowhere to go — a single-node run has no ancestor
   *  to leave for, so its one crumb is a label rather than a dead control. */
  onSelect?: (nodeId: string) => void;
}) {
  return (
    <nav aria-label="Search path" className="flex items-center gap-1 min-w-0 overflow-x-auto">
      <TreeStructureIcon size={11} className="p-text-3 shrink-0" />
      {view.path.map((crumb, index) => {
        const here = index === view.path.length - 1 || onSelect === undefined;
        const label = index === 0 && !crumb.label
          ? "root"
          : cleanNodeLabel(crumb.label, `depth ${crumb.depth}`);
        return (
          <span key={crumb.id} className="flex items-center gap-1 shrink-0">
            {index > 0 && <span className="p-text-3 text-[10px]">/</span>}
            {here ? (
              <span className="text-[10px] font-medium p-text max-w-[14rem] truncate" title={label}>{label}</span>
            ) : (
              <button onClick={() => onSelect(crumb.id)} title={label}
                className="text-[10px] p-text-3 hover:p-text transition-colors max-w-[10rem] truncate cursor-pointer">
                {label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/**
 * The branch's own outcome, held apart from the steps that produced it.
 *
 * Above the trace rather than at the end of it: a reader who opens a settled
 * branch wants its finding first, and burying it under forty steps is what made
 * the old panel a metadata card. The steps stay below, because "how" is the
 * second question, never the first.
 *
 * A failure and a report are separate bands, not a choice: a head that errored
 * after banking a partial finding has both, and the old panel showed the error
 * in a section far below the summary as if they were unrelated.
 */
function Outcome({ view }: { view: NodeTranscriptView }) {
  return (
    <>
      {view.errorMessage && (
        <div className="shrink-0 border-b p-border border-l-2 px-4 py-3"
          style={{ background: "var(--c-danger-tint)", borderLeftColor: "var(--c-danger)" }}>
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-normal p-danger">
            <WarningCircleIcon size={11} weight="fill" />
            {view.status === "aborted" ? "Stopped" : "Failed"}
          </div>
          <div className="mt-1 text-[12px] p-text-2 leading-relaxed break-words">{view.errorMessage}</div>
        </div>
      )}
      {view.answer && (
        <div className="shrink-0 border-b p-border border-l-2 px-4 py-3 p-elevated"
          style={{ borderLeftColor: "var(--c-accent)" }}>
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-normal p-accent">
            <CheckCircleIcon size={11} weight="fill" />
            {view.origin === "head" ? "Report" : "Proposal"}
          </div>
          <div className="mt-1 prose-chat p-text max-h-64 overflow-y-auto">
            <MarkdownContent content={view.answer} />
          </div>
        </div>
      )}
      {/* Pinned beside the proposal rather than filed under the trace: only a
          rollout carries one, a rollout's trace is empty by construction, and
          below an empty-state this scrolled out of sight entirely. */}
      {view.codeUsed && (
        <div className="shrink-0 border-b p-border px-4 py-2.5">
          <div className="text-[10px] uppercase tracking-normal p-text-3">Code draft</div>
          <pre className="mt-1 text-[11px] p-text-2 leading-relaxed whitespace-pre-wrap break-words max-h-40 overflow-y-auto rounded-md p-fill border p-border p-2">
            {view.codeUsed}
          </pre>
        </div>
      )}
    </>
  );
}

/**
 * Everything a reader can be looking at when the trace is empty, said apart.
 *
 * Four different facts used to render as one blank pane, which is the same
 * defect class as the blank canvas: a live branch, a branch that recorded
 * nothing before it died, a rollout that has no trace by construction, and a
 * read that failed all looked like lost data.
 */
function EmptyTrace({ view }: { view: NodeTranscriptView }) {
  if (view.origin === "rollout") {
    return (
      <EmptyState icon={<GitForkIcon size={24} />} title="A rollout has no step trace"
        hint="This branch made one proposal and was scored against its siblings — the proposal above is everything it produced. Only merged forks run a tool loop worth replaying." />
    );
  }
  if (view.status === "running") {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-[12px] p-text-2">
        <Loader size="sm" />
        {view.lastStepAt === null
          ? "Working — this branch has started but has not finished its first step."
          : "Working — waiting on the next step."}
      </div>
    );
  }
  return (
    <EmptyState icon={<BrainIcon size={24} />} title="This branch recorded no steps"
      hint={view.errorMessage
        ? "It stopped before finishing a step; the reason is above."
        : "It stopped before finishing its first step, and reported no error."} />
  );
}

/**
 * A transcript, given the view — no fetching, no surface state.
 *
 * Separate from {@link NodeTranscript} so anything holding a
 * {@link NodeTranscriptView} can render one: the Exploration surfaces reach it
 * through the panel below, and a mid-turn branch chip has its own way of getting
 * the same view for the same RPC.
 */
export function TranscriptBody({ view, onSelect }: {
  view: NodeTranscriptView;
  /** Selecting an ancestor from the search path; omitted by a caller whose view
   *  is one node deep. */
  onSelect?: (nodeId: string) => void;
}) {
  const live = view.status === "running";
  const messages = useMemo(
    () => view.steps.map((step, index) => stepAsMessage(step, index, view.nodeId)),
    [view.steps, view.nodeId],
  );
  const toolCalls = view.steps.reduce((sum, step) => sum + step.toolCalls.length, 0);

  // A live branch is read at its newest step, so the trace follows the work
  // instead of asking the reader to chase it. Only while running: scrolling a
  // settled transcript out from under someone reading it is the same rudeness.
  const tail = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (live) tail.current?.scrollIntoView({ block: "end" });
  }, [live, messages.length]);

  return (
    <div className="min-h-0 flex-1 flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b p-border">
        <span className={`size-1.5 rounded-full shrink-0 ${statusDot(view.status)} ${live ? "animate-pulse" : ""}`} />
        <span className="text-[10px] uppercase tracking-normal p-text-3 shrink-0">{view.status}</span>
        <div className="h-3 w-px bg-[var(--c-border)] shrink-0" />
        <SearchPath view={view} onSelect={onSelect} />
      </div>

      <TaskHeader task={view.task} />
      {view.rationale && (
        <div className="shrink-0 border-b p-border px-4 py-2 text-[11px] p-text-3 leading-relaxed break-words">
          <span className="uppercase tracking-normal text-[10px]">Why this branch</span> · {view.rationale}
        </div>
      )}
      <Outcome view={view} />

      {/* The trace, and only the trace, scrolls: the task and the answer stay
          put, which is the whole point of pinning them. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? <EmptyTrace view={view} /> : (
          <div className="space-y-3">
            {messages.map((message, index) => (
              <MessageView key={message.id} message={message}
                isLast={index === messages.length - 1} isStreaming={live} />
            ))}
            <div ref={tail} />
          </div>
        )}
        {view.decisions.length > 0 && (
          <div className="mt-3">
            <DetailSection title="Decisions">
              <div className="space-y-1">
                {view.decisions.map((decision, index) => (
                  <div key={index} className="rounded-md p-fill border p-border p-2 text-[11px]">
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

      {/* Liveness before cost: "is it stuck" is the question a reader of a
          running branch actually has, and a timestamp does not answer it. */}
      <div className="shrink-0 border-t p-border px-4 py-2 grid grid-cols-4 gap-2">
        <Metric label="Steps" value={view.steps.length} />
        <Metric label="Tools" value={toolCalls} />
        <Metric label="Tokens" value={fmtTokens(usageTotal(view.usage))} />
        <Metric label={live ? "Last step" : "Wall"}
          value={live
            ? (view.lastStepAt === null ? "—" : timeAgo(view.lastStepAt))
            : (view.wallClockMs > 0 ? `${view.wallClockMs}ms` : "—")} />
      </div>
    </div>
  );
}

/**
 * One node's transcript, live on that node's own writes.
 *
 * Live by push, not by clock. `head_activity` fires on the journal write itself
 * — every step as it lands, and the report after the last one — so this reloads
 * exactly when its branch moved and never otherwise. A rollout is written once
 * and announces nothing, which is correct: there is nothing further to see.
 *
 * Apart from the panel below because the panel is not the only reader: a
 * mid-turn branch chip knows its head id by derivation (`branchHeadId`) and
 * needs the same fetch without a canvas selection around it.
 */
/** The fallback cadence for an OPEN transcript on a WORKING node. Slower than
 *  the fork list's, because the push is the live channel and this is only the
 *  net under it. */
const TRANSCRIPT_FALLBACK_MS = 4_000;

export function useNodeTranscript({ runId, nodeId, rpc, headActivity, running = false }: {
  runId: string | null;
  nodeId: string | null;
  rpc: Rpc;
  /** Per-branch write counter from `useProteus`. */
  headActivity: ReadonlyMap<string, number>;
  /** Whether the node is still working. Arms the fallback clock below; a
   *  finished node has nothing further to poll for. */
  running?: boolean;
}) {
  const load = useCallback(
    () => runId === null || nodeId === null
      ? Promise.resolve<NodeTranscriptView | null>(null)
      : rpc<NodeTranscriptView | null>("getNodeTranscript", [runId, nodeId]),
    [rpc, runId, nodeId],
  );
  const subject = `${runId}:${nodeId}`;
  /**
   * A clock UNDER the push, not instead of it.
   *
   * The push is the live channel and stays the fast one — but it is a socket,
   * and a subscriber that missed a frame had no way back: an open transcript on
   * a working node sat frozen until the reader clicked a different node. Armed
   * only while the node is running, so a settled branch reads once and stops.
   */
  const revalidate = useCallback(
    () => (running ? TRANSCRIPT_FALLBACK_MS : null),
    [running],
  );
  const { resource, reload } = useAsyncResource(load, revalidate, subject);

  const tick = nodeId === null ? 0 : headActivity.get(nodeId) ?? 0;
  const seen = useRef({ subject, tick });
  useEffect(() => {
    const previous = seen.current;
    seen.current = { subject, tick };
    // A new subject already loads — it IS the resource identity. Only a tick
    // that moved under the SAME subject is news, and re-loading rather than
    // re-keying is what keeps the visible trace on screen while it refreshes.
    if (previous.subject === subject && previous.tick !== tick) reload();
  }, [subject, tick, reload]);

  return { view: lastValue(resource), resource, reload };
}

/**
 * The Exploration surfaces' node panel: fetch the selected node's transcript and
 * render it live.
 */
export function NodeTranscript({ selection, trees, rpc, headActivity, onSelect }: {
  /** The canvas's current selection: which run, and which node inside it.
   *  Structural on purpose — the tree owns `ExplorerSelection`, and a transcript
   *  panel has no business depending on the canvas's module. */
  selection: { runId: string; nodeId: string } | null;
  /** The drawn trees, keyed by run — the fallback headline for a node whose
   *  transcript has not arrived yet. */
  trees: ReadonlyMap<string, ForkNode>;
  rpc: Rpc;
  /** Per-branch write counter from `useProteus`. */
  headActivity: ReadonlyMap<string, number>;
  onSelect: (nodeId: string) => void;
}) {
  const runId = selection?.runId ?? null;
  const nodeId = selection?.nodeId ?? null;
  // Whatever the TREE calls this node — the only name left when the store has
  // no record of it, so the absent-node state can still say which one it means.
  // The tree also answers whether the node is still working, which is what arms
  // the transcript's fallback clock.
  const drawnRoot = runId === null ? undefined : trees.get(runId);
  const drawn = drawnRoot && nodeId !== null ? findForkNode(drawnRoot, nodeId) : null;
  const { view, resource, reload } = useNodeTranscript({
    runId, nodeId, rpc, headActivity, running: drawn?.status === "running",
  });
  const drawnLabel = cleanNodeLabel(drawn?.action, nodeId ?? "this branch");

  if (selection === null) {
    return (
      <div className="min-h-0 flex-1 flex items-center justify-center rounded-lg border p-border p-surface">
        <EmptyState icon={<TreeStructureIcon size={28} />} title="Pick a branch"
          hint="Select a node to read what that agent was given, every step it took, and the answer it reached." />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 flex flex-col rounded-lg border p-border p-surface overflow-hidden">
      {/* A failed read is its own state, and it keeps whatever last loaded
          underneath rather than replacing a working transcript with an error. */}
      {resource.status === "error" && (
        <LoadFailure what="this branch's transcript" message={resource.message} onRetry={reload}
          className="shrink-0 border-b p-border px-4 py-2" />
      )}
      {view ? <TranscriptBody view={view} onSelect={onSelect} />
        : resource.status === "loading" ? (
          <div className="flex-1 flex items-center justify-center gap-2 text-[12px] p-text-2">
            <Loader size="sm" />Reading the branch…
          </div>
        ) : resource.status === "ready" ? (
          // The read succeeded and neither store holds this node — distinct from
          // a node that recorded nothing, which returns a view with no steps.
          <div className="flex-1 flex items-center justify-center">
            <EmptyState icon={<TreeStructureIcon size={28} />} title="This branch is no longer in the run"
              hint={`Nothing is recorded for ${drawnLabel} — it was pruned, or the run was rewritten while you were reading it.`} />
          </div>
        ) : null}
    </div>
  );
}

