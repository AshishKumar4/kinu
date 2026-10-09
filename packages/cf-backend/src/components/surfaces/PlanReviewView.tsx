import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import { CheckCircleIcon, ChatCircleDotsIcon, NotePencilIcon, TrashIcon } from "@phosphor-icons/react";
import {
  freshNotes,
  planReviewAwaitingDecision,
  type GeneralNote,
  type NoteReply,
  type PassageNote,
  type PlanReview,
  type ReviewAnnotation,
  type PlanReviewResult,
} from "@kinu.run/core";
import { Effect, Cause } from "effect";
import { Viewer } from "@/components/plan-review/Viewer";
import { AnnotationPanel } from "@/components/plan-review/AnnotationPanel";
import { CommentThread } from "@/components/plan-review/CommentThread";
import { editorAnnotationOf } from "@/components/plan-review/notes";
import type { Block, EditorMode } from "@plannotator/ui/types";
import { extractFrontmatter, parseMarkdownToBlocks } from "@plannotator/ui/utils/parser";
import type { Rpc } from "@kinu.run/core";
import { createPlanAnnotationSaveQueue } from "@kinu.run/core";
import { renderThrownChain, showing, detach } from "@kinu.run/core/obs";
import { FilledButton } from "@/components/ui/FilledButton";
import { usePlanDecision } from "@/hooks/use-plan-decision";
import { usePlanRepliesSeen } from "@/hooks/use-plan-replies-seen";

type RootNote = PassageNote | GeneralNote;

const isRoot = (note: ReviewAnnotation): note is RootNote => note.type !== "REPLY";

const isReply = (note: ReviewAnnotation): note is NoteReply => note.type === "REPLY";

const isPassage = (note: ReviewAnnotation): note is PassageNote => note.type === "COMMENT" || note.type === "DELETION";

const notesOf = (plan: PlanReview | null): ReviewAnnotation[] => [...(plan?.annotations ?? [])];

const FILE_TREE_BRANCH = /^\s*(?:[│|]\s*)*(?:├──|└──|\|--|`--)\s+\S/;

function looksLikeFileTree(content: string): boolean {
  let branches = 0;

  for (const line of content.split("\n")) {
    if (FILE_TREE_BRANCH.test(line) && ++branches === 2) return true;
  }

  return false;
}

/** Images and raw HTML are inert in plan review. The approved source remains
 * byte-for-byte in the durable plan; only the browser renderer is narrowed. */
function planReviewBlocks(markdown: string): Block[] {
  return parseMarkdownToBlocks(markdown).map((block) => {
    if (block.type === "html") return { ...block, type: "code", language: "html" };

    if (block.type === "code") {
      const plainText = block.language === undefined
        || block.language === ""
        || block.language === "text"
        || block.language === "plaintext";

      return plainText && looksLikeFileTree(block.content) ? { ...block, language: "tree" } : block;
    }

    if (block.type === "math") return block;

    return { ...block, content: omitMarkdownImages(block.content) };
  });
}

function omitMarkdownImages(markdown: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < markdown.length) {
    const start = markdown.indexOf("![", cursor);

    if (start < 0) return output + markdown.slice(cursor);
    output += markdown.slice(cursor, start);
    const labelEnd = markdown.indexOf("](", start + 2);

    if (labelEnd < 0) { output += markdown.slice(start); break; }

    let end = labelEnd + 2;
    let depth = 1;

    for (; end < markdown.length && depth > 0; end++) {
      if (markdown[end] === "\\") { end++; continue; }

      if (markdown[end] === "(") depth++;

      if (markdown[end] === ")") depth--;
    }

    if (depth !== 0) { output += markdown.slice(start); break; }

    const alt = markdown.slice(start + 2, labelEnd).trim();
    output += alt ? `[Image omitted: ${alt}]` : "[Image omitted]";
    cursor = end;
  }

  return output;
}

const STATUS_LABEL = {
  pending: "Awaiting review",
  changes_requested: "Revision requested",
  approved: "Approved",
  superseded: "Superseded",
  dismissed: "Dismissed",
} satisfies Record<PlanReview["status"], string>;

const STATUS_TONE = {
  pending: "p-badge-warning",
  changes_requested: "p-badge-warning",
  approved: "p-badge-success",
  superseded: "p-badge-neutral",
  dismissed: "p-badge-neutral",
} satisfies Record<PlanReview["status"], string>;

/** States are ordered: read-only history, open revision, unpicked decision, then plan status. */
function footerNote(
  { readOnly, editable, handoffPending, status }: {
    readOnly: boolean; editable: boolean; handoffPending: boolean; status: PlanReview["status"];
  },
): string {
  if (readOnly) return "Read-only plan history.";

  if (status === "dismissed") return "Dismissed. The conversation is no longer held in Plan.";
  const approved = status === "approved";

  if (editable) return "Approve this revision, or comment on what needs work.";

  if (handoffPending) {
    return approved
      ? "Kinu saved your approval. Implementation has not started."
      : "Kinu saved your review. The revision has not started.";
  }

  return approved
    ? "Implementation started from this revision."
    : "The agent is preparing the next revision.";
}

export interface PlanReviewViewProps {
  plan: PlanReview | null;
  rpc: Rpc;
  readOnly?: boolean;
  /** The agent that wrote the plan, as its replies name it. */
  agentName?: string;
}

function DismissPlan({ plan, rpc, readOnly, deciding, saving, onError }: {
  plan: PlanReview;
  rpc: PlanReviewViewProps["rpc"];
  readOnly: boolean;
  deciding: string | null;
  saving: boolean;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  if (readOnly || !planReviewAwaitingDecision(plan)) return null;

  const dismiss = () => Effect.gen(function* () {
    setBusy(true);
    onError(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      const result = yield* Effect.promise(async () => rpc<PlanReviewResult>("dismissPlanReview", [plan.id, plan.revision]));

      if (!result.ok) onError(result.error);
    }), showing(onError)), Effect.sync(() => {
      setBusy(false);
    }));
  });

  return (
    // Stacked, it sits under the decisions: the quiet way out after the two that answer the plan.
    <Button type="button" size="sm" variant="ghost" className="order-last self-center whitespace-nowrap @[36rem]:order-none @[36rem]:self-auto" onClick={() => detach(dismiss())} disabled={deciding !== null || saving || busy}>
      {busy ? <Loader size="sm" /> : "Dismiss"}
    </Button>
  );
}

/** The header's controls: the comments, with their count and a mark for unread replies, and the marking mode. */
function PlanHeaderActions({ comments, unread, panelOpen, onToggle, mode, onMode, busy }: {
  comments: number;
  unread: boolean;
  panelOpen: boolean;
  onToggle: () => void;
  /** Null while the revision is not open for review. */
  mode: EditorMode | null;
  onMode: (mode: EditorMode) => void;
  busy: boolean;
}) {
  return (
    <div data-plan-actions className="flex max-w-full flex-wrap items-center justify-end gap-1.5">
      <Button
        type="button"
        size="sm"
        variant={panelOpen ? "secondary" : "ghost"}
        onClick={onToggle}
        icon={<ChatCircleDotsIcon size={13} />}
        aria-expanded={panelOpen}
        aria-label={`Comments, ${String(comments)}${unread ? ", new replies" : ""}`}
        data-plan-comments-toggle
      >
        Comments <span className="p-num">{comments}</span>
        {unread && <span data-plan-comments-unread className="size-1.5 rounded-full p-dot-accent" aria-hidden="true" />}
      </Button>
      {mode !== null && (
        <div className="flex items-center rounded-md border p-border p-recessed p-0.5" aria-label="Annotation mode">
          <Button
            type="button"
            size="sm"
            variant={mode === "comment" ? "secondary" : "ghost"}
            onClick={() => onMode("comment")}
            aria-pressed={mode === "comment"}
            disabled={busy}
            icon={<ChatCircleDotsIcon size={12} />}
          >
            Comment
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "redline" ? "secondary" : "ghost"}
            onClick={() => onMode("redline")}
            aria-pressed={mode === "redline"}
            disabled={busy}
            icon={<TrashIcon size={12} />}
          >
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}

export default function PlanReviewView({ plan, rpc, readOnly = false, agentName = "Kinu" }: PlanReviewViewProps) {
  const [notes, setNotes] = useState<ReviewAnnotation[]>(() => notesOf(plan));
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<EditorMode>("comment");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const planId = plan?.id ?? null;
  const planRevision = plan?.revision ?? null;
  const planKey = planId === null || planRevision === null ? null : `${planId}:${planRevision}`;
  const activePlanKey = useRef(planKey);
  activePlanKey.current = planKey;
  const seen = usePlanRepliesSeen(planId);

  // The reviewer writes only this revision's own notes; the review keeps the threads carried from earlier ones.
  const annotationSaves = useMemo(() => createPlanAnnotationSaveQueue<ReviewAnnotation>(async (next) => {
    if (planId === null || planRevision === null) return false;

    if (activePlanKey.current === planKey) setError(null);

    try {
      const result = await rpc<PlanReviewResult>("savePlanReviewAnnotations", [planId, planRevision, freshNotes(next)]);

      if (!result.ok) {
        if (activePlanKey.current === planKey) setError(result.error);

        return false;
      }

      return true;
    } catch (cause) {
      if (activePlanKey.current === planKey) {
        setError(renderThrownChain({ cause }));
      }

      return false;
    }
  }), [planId, planKey, planRevision, rpc]);

  useEffect(() => {
    setNotes(notesOf(plan));
    setSelected(null);
    setPanelOpen(false);
    setSaving(false);
    setError(null);
  }, [plan?.id, plan?.revision]);

  const editable = !readOnly && plan?.status === "pending";
  // An open revision is the reviewer's draft; any other follows the review, so the agent's replies arrive as written.
  const shown = editable ? notes : notesOf(plan);
  const roots = useMemo(() => shown.filter(isRoot), [shown]);
  const rootsById = useMemo(() => new Map(roots.map((note) => [note.id, note])), [roots]);
  const replies = useMemo(() => shown.filter(isReply).sort((left, right) => left.createdA - right.createdA), [shown]);
  const written = useMemo(() => freshNotes(shown), [shown]);
  // Carried passages quote an earlier text, so only this revision's own are marked in it.
  const passages = useMemo(() => written.filter(isPassage), [written]);
  const unread = replies.some((reply) => reply.author === "agent" && reply.createdA > seen.seenAt);

  const blocks = useMemo(() => planReviewBlocks(plan?.content ?? ""), [plan?.content]);
  const frontmatter = useMemo(() => extractFrontmatter(plan?.content ?? "").frontmatter, [plan?.content]);

  /* Only a first-block h1 is promoted to the title; later h1s stay in place. */
  const titleBlock = useMemo(() => {
    const lead = blocks[0];

    return lead?.type === "heading" && (lead.level ?? 1) === 1 ? lead : null;
  }, [blocks]);

  const titleBlocks = useMemo(() => titleBlock === null ? [] : [titleBlock], [titleBlock]);

  const titlePassages = useMemo(
    () => titleBlock === null ? [] : passages.filter((note) => note.blockId === titleBlock.id),
    [passages, titleBlock],
  );

  const documentPassages = useMemo(
    () => titleBlock === null ? passages : passages.filter((note) => note.blockId !== titleBlock.id),
    [passages, titleBlock],
  );

  const documentBlocks = useMemo(
    () => titleBlock === null ? blocks : blocks.slice(1),
    [blocks, titleBlock],
  );

  const handoffPending = !readOnly && plan != null && !plan.handoffAccepted
    && (plan.status === "approved" || plan.status === "changes_requested");

  const save = useCallback(async (next: ReviewAnnotation[]): Promise<boolean> => {
    if (readOnly || planKey === null) return false;
    setNotes(next);
    setSaving(true);
    const saved = await annotationSaves.enqueue(next);

    if (annotationSaves.pending() === 0 && activePlanKey.current === planKey) {
      setSaving(false);
    }

    return saved;
  }, [annotationSaves, planKey, readOnly]);

  const { busy: decisionBusy, inFlight: decisionInFlight, decide } = usePlanDecision({
    plan,
    editable,
    handoffPending,
    rpc,
    save: () => save(notes),
    onError: setError,
  });

  const changeNotes = useCallback((next: ReviewAnnotation[]) => detach(Effect.gen(function* () {
    if (decisionInFlight()) return;
    // Decided after the handler so a superseded revision does not read as a failed save.
    let thrown: { readonly cause: unknown } | undefined;

    yield* Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(async () => save(next));
    }), (failed) => Effect.sync(() => {
      const cause = Cause.squash(failed);
      thrown = { cause };
    }));

    if (thrown !== undefined && activePlanKey.current === planKey) {
      setError(renderThrownChain({ cause: thrown.cause }));

      if (annotationSaves.pending() === 0) setSaving(false);
    }
  })), [annotationSaves, decisionInFlight, planKey, save]);

  const openPanel = useCallback(() => {
    seen.markSeen();
    setPanelOpen(true);
  }, [seen]);

  const addNote = useCallback((note: RootNote) => {
    if (decisionInFlight()) return;
    setSelected(note.id);
    openPanel();

    return changeNotes([...notes, note]);
  }, [notes, changeNotes, decisionInFlight, openPanel]);

  const reply = useCallback((root: string, text: string) => changeNotes([
    ...notes,
    { id: crypto.randomUUID(), type: "REPLY", inReplyTo: root, text, author: "owner", createdA: Date.now() },
  ]), [notes, changeNotes]);

  const selectNote = useCallback((id: string | null) => {
    setSelected(id);

    if (id !== null) openPanel();
  }, [openPanel]);

  if (!plan) {
    return (
      <div data-kinu-plan-review className="h-full grid place-items-center p-8">
        <div className="max-w-sm text-center">
          <NotePencilIcon size={30} className="mx-auto mb-3 text-muted-foreground" />
          <h3 className="text-sm font-medium text-foreground">No plan submitted yet</h3>
          <p className="mt-1 text-xs text-muted-foreground">Ask the agent for a plan, or choose Plan in the composer. The agent investigates and submits a plan for your review.</p>
        </div>
      </div>
    );
  }

  const closePanel = () => {
    setPanelOpen(false);
    setSelected(null);
  };

  const updatedAt = new Date(plan.updatedAt);
  const retryLabel = plan.status === "approved" ? "Retry implementation" : "Retry revision";
  const reviewing = editable && decisionBusy === null;

  return (
    <section
      data-kinu-plan-review
      data-plan-review-root
      aria-labelledby="plan-document-title"
      className="relative h-full min-h-0 flex flex-col"
    >
      <header data-plan-header className="p-surface shrink-0 border-b p-border px-4 py-4 sm:px-6 sm:py-5">
        <div className="mx-auto flex max-w-6xl flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="p-eyebrow">Plan</span>
              <span className="p-badge-neutral p-annotation px-2 py-0.5">r{plan.revision}</span>
              <span data-plan-status className={`${STATUS_TONE[plan.status]} px-2 py-0.5`}>{STATUS_LABEL[plan.status]}</span>
            </div>
            {titleBlock === null ? (
              <h1 id="plan-document-title" data-plan-title className="p-display p-text mt-2 text-2xl leading-tight sm:text-3xl">
                Plan
              </h1>
            ) : (
              <div id="plan-document-title" data-plan-title className="p-display p-text mt-2 text-2xl leading-tight sm:text-3xl">
                <Viewer
                  blocks={titleBlocks}
                  annotations={titlePassages}
                  onAddAnnotation={addNote}
                  onSelectAnnotation={selectNote}
                  selectedAnnotationId={selected}
                  mode={mode}
                  readOnly={!reviewing}
                />
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <time className="p-annotation p-text-3" dateTime={updatedAt.toISOString()} title={updatedAt.toLocaleString()}>
                Updated {updatedAt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              </time>
              {saving && <span aria-live="polite" className="p-annotation p-info">Saving comments…</span>}
            </div>
            {editable && roots.length === 0 && (
              <p className="p-meta p-text-3 mt-2">Select text to comment or mark it for removal.</p>
            )}
          </div>

          <PlanHeaderActions
            comments={roots.length}
            unread={unread}
            panelOpen={panelOpen}
            onToggle={() => panelOpen ? closePanel() : openPanel()}
            mode={editable ? mode : null}
            onMode={setMode}
            busy={decisionBusy !== null}
          />
        </div>
      </header>

      <div data-plan-body className="relative flex flex-1 min-h-0">
        <div data-plan-scroll className="flex-1 min-w-0 overflow-y-auto px-4 py-8 sm:px-8 sm:py-10">
          <div data-plan-document className="plan-review-document mx-auto">
            <Viewer
              blocks={documentBlocks}
              frontmatter={frontmatter}
              annotations={documentPassages}
              onAddAnnotation={addNote}
              onSelectAnnotation={selectNote}
              selectedAnnotationId={selected}
              mode={mode}
              readOnly={!reviewing}
            />
          </div>
        </div>
        {panelOpen && (
          <button
            type="button"
            data-plan-scrim
            aria-label="Close comments"
            className="p-scrim"
            onClick={closePanel}
          />
        )}
        <AnnotationPanel
          isOpen={panelOpen}
          title="Comments"
          annotations={roots.map(editorAnnotationOf)}
          selectedId={selected}
          onSelect={setSelected}
          onDelete={(id) => {
            if (selected === id) setSelected(null);

            return changeNotes(notes.filter((note) => note.id !== id && !(note.type === "REPLY" && note.inReplyTo === id)));
          }}
          onEdit={(id, updates) => changeNotes(notes.map((note) => (
            note.id === id && isRoot(note) && updates.text !== undefined ? { ...note, text: updates.text } : note
          )))}
          onClose={closePanel}
          readOnly={!reviewing}
          isLocked={(annotation) => rootsById.get(annotation.id)?.revision !== undefined}
          placeOf={(annotation) => {
            const from = rootsById.get(annotation.id)?.revision;

            return from === undefined ? undefined : `From revision ${String(from)}`;
          }}
          renderThread={(annotation) => (
            <CommentThread
              replies={replies.filter((each) => each.inReplyTo === annotation.id)}
              agentName={agentName}
              seenAt={seen.since}
              onReply={reviewing ? (text) => reply(annotation.id, text) : undefined}
              onDelete={reviewing ? (id) => changeNotes(notes.filter((note) => note.id !== id)) : undefined}
            />
          )}
          width="min(var(--plan-rail-width), 100%)"
        />
      </div>

      {/* Laid out by its own width, not the window's: a plan reads in a column as narrow as a phone. Below a row's room
          the decisions stack, each label on one line, rather than squeeze. */}
      <footer data-plan-footer className="@container p-surface shrink-0 border-t p-border px-4 py-3">
        <div className="flex flex-col gap-2 @[36rem]:flex-row @[36rem]:items-center">
          {error ? (
            <p role="alert" className="p-notice-danger p-meta px-3 py-2 @[36rem]:mr-auto">{error}</p>
          ) : (
            <p className="p-meta p-text-3 @[36rem]:mr-auto">
              {footerNote({ readOnly, editable, handoffPending, status: plan.status })}
            </p>
          )}
          <DismissPlan plan={plan} rpc={rpc} readOnly={readOnly} deciding={decisionBusy} saving={saving} onError={setError} />
          {editable && (
            <div data-plan-decisions className="flex flex-col-reverse gap-2 @[22rem]:flex-row @[22rem]:justify-end">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="w-full justify-center whitespace-nowrap @[22rem]:w-auto"
                onClick={() => detach(Effect.promise(async () => decide("request_changes")))}
                disabled={decisionBusy !== null || saving || written.length === 0}
              >
                {decisionBusy === "request" ? <Loader size="sm" /> : "Request changes"}
              </Button>
              <FilledButton
                className="w-full justify-center whitespace-nowrap @[22rem]:w-auto"
                onClick={() => detach(Effect.promise(async () => decide("approve")))}
                disabled={decisionBusy !== null || saving || written.length > 0}
              >
                {decisionBusy === "approve" ? <Loader size="sm" /> : <><CheckCircleIcon size={14} />Approve &amp; implement</>}
              </FilledButton>
            </div>
          )}
          {handoffPending && (
            <FilledButton
              className="justify-center whitespace-nowrap"
              onClick={() => detach(Effect.promise(async () => decide(plan.status === "approved" ? "approve" : "request_changes")))}
              disabled={decisionBusy !== null || saving}
            >
              {decisionBusy ? <Loader size="sm" /> : retryLabel}
            </FilledButton>
          )}
        </div>
      </footer>
    </section>
  );
}
