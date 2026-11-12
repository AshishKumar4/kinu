/** The chat's frames: transcripts, the composer, tool calls, streaming, history and quality. */
import { Effect } from 'effect';
import { useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import type { ShownAttachment } from "@/hooks/use-pending-attachments";
import { threadLiveTail, type TurnLiveness, type ModelMenuEntry, type WorkspaceEntry } from "@kinu.run/core";
import { KinuError } from "@kinu.run/core/obs";
import { Button } from "@/components/ui/Button";
import { READS_CHANGED_EVENT } from "@kinu.run/core";
import type { ReasoningEffort } from "@kinu.run/core";
import { ModelPicker } from "@/components/ModelPicker";
import { Composer, type ComposerNotice } from "@/components/Composer";
import type { WorkMode } from "@kinu.run/core";
import { NodeTranscript } from "@/components/NodeTranscript";
import { BranchRunChip } from "@/components/AlternateTakes";
import { SLATE_GALLERY_URL } from "@/gallery-slate-fallback";
import { SlateInlineContext } from "@/components/slates/context";
import { ConversationStartBoundary, HistoryBoundary, MarkdownContent } from "@/components/surfaces/shared";
import { QualityView } from "@/components/surfaces/evolution-panels";
import { useKinu } from "@/hooks/use-kinu";
import { ChatLiveTail, MessageView, SteerBubble } from "@/components/MessageView";
import { buildTranscript } from "@kinu.run/core";
import { ConversationSkeleton, EmptyConversation, turnEndNotices } from "@/components/ChatColumn";
import { useChatThread } from "@/hooks/use-chat-thread";
import { useGrowingScroll } from "@/hooks/use-growing-scroll";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { workspaceGenesisSignal, type SlateSummary } from "@kinu.run/core";
import { answeringRpc, wireOf, type WorkspaceAnswers } from "@/lib/workspace-rpc";
import type { ExecutorInfo } from "@kinu.run/core";
import type { ChatHistoryEntry, ChatHistoryPage } from "@kinu.run/core";
import type { ModelTestResult } from "@/lib/user-api";
import * as v from "valibot";
import { galleryServerPush, serveGalleryRpc } from "@/gallery-agent-stub";
import { BACKGROUND_JOBS, BRAIN_STATUS, IDLE_TURN, NOW, NO_HEAD_ACTIVITY, WORKSPACE_PAGE_NAME } from "@/gallery-data";
import { ChatMessages, EVENT_CARD_ROWS, GalleryComposer, GalleryWorkspaceHeader, MCTS_TREES, MESSAGES, MODEL_STUBS, OPENING_SNAPSHOT, PAGE_ANSWERS, QUALITY_DAYS, QUALITY_WINDOW, SYSTEM_EVENT_ROWS, Shell, forkRpc, galleryAgentPlan, galleryRpc, msg, rosterAnswer, rosterAuthorityHold, said, slateRpc, textEntry, type MountedFrame, useBuildingJob, withChat } from "@/gallery-shared";
import { workspacePageWire, framed, type FrameTable } from "@/gallery-shared";

const LIVE_TURN: TurnLiveness = { kind: "live", turnId: null };

/* Shared so the wide and narrow frames photograph the same affordance. */
const REFRESH_NOTICE: readonly ComposerNotice[] = [{
  id: "jobs",
  tone: "danger",
  text: "Could not refresh background jobs.",
  action: { label: "Retry", onClick: () => {} },
}];

/** A settled chat with nothing to say about how its last turn ended. */
const NO_TURN_END = {
  newest: undefined, live: false, retryOwed: false, dismissed: null, retry: () => {}, dismiss: () => {}, clearChatError: () => {},
} as const;

/* The width Column A gets (42% of the shell); full-bleed would flatter truncation. */
function ChatFrame() {
  return (
    <div className="flex h-screen justify-center p-bg p-text">
      <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
        <GalleryWorkspaceHeader />
        <ChatMessages />
        <GalleryComposer notices={[
          ...REFRESH_NOTICE,
          ...turnEndNotices({ ...NO_TURN_END, chatError: { body: "fetch failed: provider stream reset before completion (opencode-go/muse-spark-1.3-contributor)", refused: false } }),
          // The runtime refusing this tab, as `sunlit-stone-4a20` answers a resume ACK.
          ...turnEndNotices({ ...NO_TURN_END, chatError: { body: "Unauthorized", refused: true } }),
        ]} />
      </div>
    </div>
  );
}

/* Production shapes: `steer-a` is a `recordLandedSteers` row, `f8798675…` a restored fork-interrupted notice with metadata, `sys-1` a markerless row the read model reports as `system`. */
const STEERED_THREAD: UIMessage[] = [
  msg({
    id: "su1", role: "user", createdAt: NOW - 9 * 60e3,
    parts: [{ type: "text", text: "Research the current state of the art in LLM post-training and tell me what fits flaxdiff." }],
  }),
  msg({
    id: "steer-a", role: "user", createdAt: NOW - 6 * 60e3,
    metadata: { kinuSteer: true, kinuSteerAtStep: 2 },
    parts: [{ type: "text", text: "Can you actually use the research swarm for researching these topics and the project and other stuff?" }],
  }),
  msg({
    id: "sa1", role: "assistant", createdAt: NOW - 5 * 60e3,
    parts: [
      { type: "step-start" },
      { type: "reasoning", text: "Two decisions to make before searching: which post-training family actually ports to JAX, and whether flaxdiff's trainer can host an RL loop at all." },
      { type: "tool-web", toolCallId: "s1", state: "output-available", input: { op: "search", query: "LLM post-training 2026 RLVR GRPO agentic" }, output: "12 results" },
      { type: "step-start" },
      { type: "tool-web", toolCallId: "s2", state: "output-available", input: { op: "fetch", url: "https://github.com/volcengine/verl" }, output: "…" },
      { type: "text", text: "veRL is the dominant RL post-training stack, and Levanter has merged into the marin monorepo as the JAX pretraining path." },
      { type: "step-start" },
      { type: "reasoning", text: "The steer changes the shape of this: run it as a measured search rather than answering directly." },
      { type: "tool-agents", toolCallId: "s3", state: "output-available", input: { op: "swarm", preset: "ideate", task: "Distinct designs for extending flaxdiff into a unified JAX platform" }, output: "5 candidates" },
      { type: "text", text: "Kicked off an ideate swarm over the design space — five nodes, each returning a distinct approach rather than a ranked one." },
    ],
  }),
  msg({
    id: "f8798675-5e9a-4d13-aac2-293f4557f1c1", role: "system", createdAt: NOW - 4 * 60e3,
    metadata: { kinuEvent: "fork_interrupted", runs: ["6xrijuf933p0jclpctw59"], heads: 9 },
    parts: [{ type: "text", text: "9 head(s) across 1 fork run(s) were still marked running from an activation that has ended, so nothing is executing them and no report will arrive." }],
  }),
  msg({
    id: "sys-1", role: "system", createdAt: NOW - 3 * 60e3,
    parts: [{ type: "text", text: "The workspace was reactivated and its pending work re-driven." }],
  }),
];

/* A mid-turn message (#210) between the work it split, and a `fork_interrupted` notice restored by the history walk (#222) keeping its card. */
function ChatSteerFrame() {
  const thread = buildTranscript(STEERED_THREAD, [
    { id: "steer-live", text: "actually, cap it at three heads", state: "queued", atStep: null },
  ]);

  return (
    <div className="flex h-screen justify-center p-bg p-text">
      <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
        <GalleryWorkspaceHeader />
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 lg:px-8" data-gallery-chat>
          {thread.entries.map(({ message, steers }) => (
            <div key={message.id} data-chat-row={message.id}>
              <MessageView
                message={message} steers={steers} onFork={() => {}} />
            </div>
          ))}
          {thread.trailing.map((steer) => <SteerBubble key={steer.id} steer={steer} />)}
        </div>
        <GalleryComposer />
      </div>
    </div>
  );
}

/* One ts, bash and json fence each: a fence that renders flat is the highlighting defect. */
const CODE_THREAD: UIMessage[] = [
  msg({
    id: "cu1", role: "user", createdAt: NOW - 4 * 60e3,
    parts: [{ type: "text", text: "Show me the fix for the /api/health 500, how to run it, and what it answers." }],
  }),
  msg({
    id: "ca1", role: "assistant", createdAt: NOW - 3 * 60e3,
    parts: [
      { type: "text", text: [
        "The patch reads the database by its new binding, and by the old one until staging redeploys:",
        "",
        "```ts",
        "interface Env { SESSIONS_DB?: D1Database; DB?: D1Database }",
        "export function openDb(env: Env): D1Database {",
        "  const db = env.SESSIONS_DB ?? env.DB;",
        "  if (db === undefined) throw new MissingBinding('SESSIONS_DB');",
        "  return db;",
        "}",
        "```",
        "",
        "Run the suite from the Worker's folder:",
        "",
        "```bash",
        "bun test workers/api --filter sessions-binding",
        "git diff --stat workers/api/wrangler.jsonc",
        "```",
        "",
        "and /api/health now answers:",
        "",
        "```json",
        "{ \"ok\": true, \"db\": \"up\", \"binding\": \"SESSIONS_DB\", \"latencyMs\": 14 }",
        "```",
      ].join("\n") },
    ],
  }),
];

function ChatCodeFrame() {
  return (
    <div className="flex h-screen justify-center p-bg p-text">
      <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
        <GalleryWorkspaceHeader />
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 lg:px-8" data-gallery-chat>
          {CODE_THREAD.map((m) => (
            <div key={m.id} data-chat-row={m.id}>
              <MessageView message={m} onFork={() => {}} />
            </div>
          ))}
        </div>
        <GalleryComposer />
      </div>
    </div>
  );
}

/* The mission is a standing brief, deliberately not sent as an opening message. */
function ChatEmptyFrame() {
  return (
    <div className="flex h-screen justify-center p-bg p-text">
      <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
        <GalleryWorkspaceHeader />
        <div className="flex-1 overflow-y-auto px-6 py-5 lg:px-8">
          <EmptyConversation mission={BRAIN_STATUS.purpose} />
        </div>
        <GalleryComposer />
      </div>
    </div>
  );
}

/* A workspace with history before its transcript arrives: must read "not yet", distinct from ChatEmptyFrame's "nothing here". */
function ChatLoadingFrame() {
  return (
    <div className="flex h-screen justify-center p-bg p-text">
      <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
        <GalleryWorkspaceHeader />
        <div className="flex-1 overflow-y-auto px-6 py-5 lg:px-8">
          <ConversationSkeleton />
        </div>
        <GalleryComposer />
      </div>
    </div>
  );
}

/* The real composer at reading width: at rest with a draft, mid-turn (Stop / Branch / Steer), and with a status row. */
function ComposerFrame() {
  const [value, setValue] = useState("Ship the binding fix behind a preview first.");
  const [mode, setMode] = useState<WorkMode>("build");
  const [model, setModel] = useState("opencode-go/muse-spark-1.3-contributor");
  /* The thinking level travels with the model; the composer sizes the row, so the picker takes no width class. */
  const [effort, setEffort] = useState<ReasoningEffort | null>(null);
  const [parts, setParts] = useState<ShownAttachment[]>([]);

  const picker = () => (
    <ModelPicker models={MODEL_STUBS()} value={model} onChange={setModel} size="xs"
      effort={{ value: effort, onChange: setEffort }} />
  );

  const shared = {
    onValueChange: setValue,
    onSend: () => {},
    onStop: () => {},
    placeholder: "Send a message...",
    disabled: false,
    mode: { value: mode, onChange: setMode, locked: false },
    attachments: {
      items: parts,
      // A file dropped here is shown as kept: the gallery has no workspace to upload it to.
      onAdd: (files: FileList | null | undefined) => setParts((held) => [...held, ...[...files ?? []].map((file): ShownAttachment => ({
        key: `${file.name}-${String(held.length)}`, file: null, name: file.name, mediaType: file.type,
        state: { kind: "uploaded", path: `/uploads/${file.name}` }, preview: null,
      }))]),
      onRemove: (index: number) => setParts((held) => held.filter((_, at) => at !== index)),
    },
  } as const;

  return (
    <div className="p-bg p-text min-h-screen flex justify-center">
      <div className="w-full max-w-[640px] space-y-8 py-10">
        <div className="space-y-1">
          <div className="t-label px-4">At rest, with a draft</div>
          <Composer {...shared} value={value} liveness={IDLE_TURN} modelPicker={picker()} />
        </div>
        <div className="space-y-1" data-gallery-composer="live">
          <div className="t-label px-4">Mid-turn — Stop, Branch, Steer</div>
          <Composer {...shared} value={value} liveness={LIVE_TURN} onBranch={() => {}}
            modelPicker={picker()} />
        </div>
        <div className="space-y-1" data-gallery-composer="notice">
          <div className="t-label px-4">With a status row</div>
          <Composer {...shared} value="" liveness={IDLE_TURN} modelPicker={picker()} notices={REFRESH_NOTICE} />
        </div>
        <ModelPickerStates />
      </div>
    </div>
  );
}

const PICKER_MODELS: ModelMenuEntry[] = [
  { spec: "codex/gpt-5.5", label: "GPT-5.5 (Codex)", provider: "codex", providerLabel: "ChatGPT Codex (subscription)", contextWindow: 272_000, capabilities: ["reasoning", "vision"] },
  { spec: "codex/gpt-6-sol", label: "GPT-6 Sol (Codex)", provider: "codex", providerLabel: "ChatGPT Codex (subscription)", contextWindow: 272_000, capabilities: ["reasoning", "vision"] },
  { spec: "claude/claude-opus-4-8", label: "Claude Opus 4.8", provider: "claude", providerLabel: "Claude (subscription)", contextWindow: 1_000_000, capabilities: ["reasoning", "vision"] },
  { spec: "claude/claude-sonnet-4-8", label: "Claude Sonnet 4.8", provider: "claude", providerLabel: "Claude (subscription)", contextWindow: 1_000_000, capabilities: ["reasoning"] },
  { spec: "workers-ai/@cf/zai-org/glm-5.3", label: "GLM 5.3", provider: "workers-ai", providerLabel: "Workers AI", contextWindow: 1_048_576, capabilities: ["reasoning"] },
  { spec: "openrouter/qwen/qwen3.6-max", label: "Qwen 3.6 Max", provider: "openrouter", providerLabel: "OpenRouter", contextWindow: 262_144 },
  { spec: "opencode-go/glm-5", label: "GLM-5 (OpenCode Go)", provider: "opencode-go", providerLabel: "OpenCode Go", contextWindow: 200_000 },
];

const PICKER_FAILURES = [{ provider: "codex", label: "ChatGPT Codex (subscription)", reason: "Codex models could not be read: chatgpt.com refused this server's network (HTTP 403 block page, before sign-in); showing the built-in list" }];

const PICKER_TEST_RESULTS = new Map<string, ModelTestResult>([
  ["opencode-go", { ok: false, failure: "spent", until: Date.parse("2026-10-03T14:56:00Z"), message: "opencode-go is rate-limited until 2026-10-03 14:56 UTC (in 8d 10h): Monthly usage limit reached. (HTTP 429)" }],
  ["codex", { ok: false, failure: "unreachable", message: "Codex is unreachable from here (HTTP 503, codex_unavailable)" }],
]);

function galleryModelTest(spec: string, signal: AbortSignal): Promise<ModelTestResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ModelTestResult>();
  const result = PICKER_TEST_RESULTS.get(spec.split("/")[0] ?? "") ?? { ok: true, firstTokenMs: 640, totalMs: 910 };
  const timer = setTimeout(() => resolve(result), 700);

  signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); });

  return promise;
}

function ModelPickerStates() {
  const [model, setModel] = useState("codex/gpt-5.5");
  const [tier, setTier] = useState("");
  const models = PICKER_MODELS;
  const failures = PICKER_FAILURES;
  const test = galleryModelTest;

  return (
    <div className="space-y-6 px-4" data-model-picker-states>
      <div className="space-y-1">
        <div className="t-label">Model picker, a failed Codex list</div>
        <div className="flex items-center gap-1">
          <ModelPicker models={models} failures={failures} value={model} onChange={setModel} size="xs" test={test} label="Picker" />
        </div>
      </div>
      <div className="space-y-1">
        <div className="t-label">Settings tier, inheriting the default</div>
        <ModelPicker models={models} failures={failures} value={tier} onChange={setTier} clearable size="sm"
          label="deep model" placeholder="Use default: GPT-5.5 (Codex)" test={test} />
      </div>
    </div>
  );
}

/* The real chat thread and scroll over a stub page source. ?latency=ms ?fail=1 (first fetch fails) ?depth=N (pages). */
const HISTORY_PAGE = 12;

const historyParams = new URLSearchParams(location.search);

const HISTORY_LATENCY = Number(historyParams.get("latency") ?? 400);

const HISTORY_DEPTH = Number(historyParams.get("depth") ?? 4);

const STORED_HISTORY: ChatHistoryEntry[] = Array.from(
  { length: HISTORY_PAGE * HISTORY_DEPTH },
  (_, i) => textEntry({
    id: `h${i + 1}`,
    position: i,
    role: i % 2 === 0 ? "user" as const : "assistant" as const,
    turnId: null,
    content: `Archived message ${i + 1} of ${HISTORY_PAGE * HISTORY_DEPTH}. `
      + "Long enough to occupy real vertical space, so the scroll anchoring is "
      + "measured against a container that actually overflows.",
    createdAt: "2026-01-01 00:00:00",
  }),
);

function ChatHistoryFrame() {
  const [live, setLive] = useState<UIMessage[]>(() => MESSAGES.slice(-3));
  const failed = useRef(historyParams.get("fail") === "1");
  const requests = useRef(0);
  const [calls, setCalls] = useState<string[]>([]);

  const rpc = useMemo(() => answeringRpc({ getChatHistoryPage: (asked) => Effect.gen(function* () {
    const cursor = asked?.cursor;
    const request = ++requests.current;
    setCalls((prev) => [...prev, cursor === undefined ? "newest" : String(cursor.before)]);
    const settled = Promise.withResolvers<void>();
    setTimeout(settled.resolve, HISTORY_LATENCY);
    yield* Effect.promise(async () => settled.promise);

    if (request === requests.current && failed.current) {
      failed.current = false;

      return yield* new KinuError("unavailable", "stub failure");
    }

    const end = Math.min(cursor?.before ?? STORED_HISTORY.length, STORED_HISTORY.length);
    const start = Math.max(0, end - HISTORY_PAGE);
    const items = STORED_HISTORY.slice(start, end);

    const page: ChatHistoryPage = start === 0 ? { status: "end", items } : { status: "more", items, next: { before: start } };

    return page;
  }) }), []);

  // The live rows follow the stored ones, as the room's window says of its own.
  const seedEdge = useMemo(() => (live[0] === undefined ? null : { from: live[0].id, older: { before: STORED_HISTORY.length } }), [live]);
  const { history, transcript } = useChatThread({ rpc, live, seeded: true, seedEdge });

  const messagesRef = useGrowingScroll({
    grows: "up", content: transcript, fetched: history.entries, loading: history.loading,
    onReachEdge: history.loadMore,
  });

  // Driven from the test so a live turn can land while an older page is in flight.
  useEffect(() => {
    const onArrive = (event: Event) => {
      const detail = v.safeParse(v.pipe(v.string(), v.nonEmpty()), event instanceof CustomEvent ? event.detail : null);
      const id = detail.success ? detail.output : `live-${Date.now()}`;
      setLive((prev) => [...prev, {
        id, role: "assistant", parts: [{ type: "text", text: `Live arrival ${id}` }],
      }]);
    };

    // A streaming answer: the last live message grows by one paragraph.
    const onStream = () => {
      setLive((prev) => prev.map((message, index) => (index === prev.length - 1
        ? { ...message, parts: [...message.parts, { type: "text", text: `A further paragraph of the streaming answer, long enough to wrap across the column and grow it. ${String(message.parts.length)}` }] }
        : message)));
    };

    window.addEventListener("gallery:arrive", onArrive);
    window.addEventListener("gallery:stream", onStream);

    return () => {
      window.removeEventListener("gallery:arrive", onArrive);
      window.removeEventListener("gallery:stream", onStream);
    };
  }, []);

  return (
    <div className="flex h-screen justify-center p-bg p-text">
      <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
        <GalleryWorkspaceHeader />
        <div ref={messagesRef} data-testid="chat-scroll"
          className="flex-1 overflow-y-auto px-6 py-5 space-y-5 lg:px-8">
          <HistoryBoundary
            loading={history.loading} error={history.error}
            exhausted={history.exhausted} onRetry={history.retry} />
          {transcript.map((m) => (
            <div key={m.id} data-msg={m.id}>
              <MessageView message={m} />
            </div>
          ))}
        </div>
        <div data-testid="probe" className="hidden">{JSON.stringify({
          ids: transcript.map((m) => m.id), calls,
          loading: history.loading, exhausted: history.exhausted, error: history.error,
        })}</div>
        <GalleryComposer />
      </div>
    </div>
  );
}

const NO_HISTORY_LIVE: readonly UIMessage[] = [];

/** The first request is held until the browser releases it, then fails once; Retry answers the authoritative empty page. */
function HistoryAuthorityFrame() {
  const [hold] = useState(() => Promise.withResolvers<void>());
  const failFirst = useRef(true);
  const requests = useRef(0);

  const rpc = useMemo(() => answeringRpc({ getChatHistoryPage: () => Effect.gen(function* () {
    const request = ++requests.current;
    yield* Effect.promise(async () => hold.promise);

    // StrictMode can retire a held walk: only the latest request consumes the planned failure.
    if (request === requests.current && failFirst.current) {
      failFirst.current = false;

      return yield* new KinuError("unavailable", "fixture could not read the first history page");
    }

    const page: ChatHistoryPage = { status: "end", items: [] };

    return page;
  }) }), [hold]);

  const { history } = useChatThread({ rpc, live: NO_HISTORY_LIVE, seeded: true });

  const loadMore = history.loadMore;
  useEffect(() => { loadMore(); }, [loadMore]);

  return (
    <div data-history-authority className="flex h-screen justify-center p-bg p-text">
      <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
        <GalleryWorkspaceHeader />
        <Button size="sm" data-history-release onClick={() => hold.resolve()} className="m-2 self-start">Release first page</Button>
        <Button size="sm" data-history-reset onClick={history.reset} className="m-2 self-start">Clear fetched history</Button>
        <div className="flex-1 overflow-y-auto px-6 py-5 lg:px-8">
          <ConversationStartBoundary
            hasEntries={false}
            streaming={false}

            error={history.error}
            exhausted={history.exhausted}
            onRetry={history.retry}
            pending={<ConversationSkeleton />}
            empty={<EmptyConversation mission="Audit the Worker's deploy history" />}
          />
        </div>
        <div data-history-probe className="hidden">{JSON.stringify({
          loading: history.loading,
          error: history.error,
          exhausted: history.exhausted,
        })}</div>
      </div>
    </div>
  );
}

/** KINU-060: only the transport response is held; a released old response must not undo the hook's upsert/rename. */
function RosterAuthorityFrame() {
  const roster = useWorkspaceRoster();

  const entry: WorkspaceEntry = {
    name: "api-worker",
    displayName: "API Worker",
    createdAt: NOW - 7 * 864e5,
    lastVisited: NOW - 60e3,
  };

  return (
    <div data-roster-authority className="p-bg p-text min-h-screen p-6">
      <button data-roster-local-rename type="button" onClick={() => {
        roster.upsert(entry);
        roster.rename(entry.name, "Renamed locally");
      }}>Apply local rename</button>
      <button data-roster-release type="button" onClick={() => {
        rosterAuthorityHold.resolve(new Response(JSON.stringify(rosterAnswer(new URLSearchParams())), {
          headers: { "content-type": "application/json" },
        }));
      }}>Release stale roster</button>
      <div data-roster-probe data-roster-pending={String(roster.pending)}>{roster.entries.map((row) => `${row.name}:${row.displayName}`).join("|")}</div>
    </div>
  );
}

const CONTINUITY_LONG_TOKEN = `https://example.invalid/${"unbroken".repeat(90)}`;

/** The hidden probe reports only action results, never an implementation flag. */
function ClientContinuityFrame() {
  const [draft, setDraft] = useState("compose this");
  const [sends, setSends] = useState(0);
  const [files, setFiles] = useState<string[]>([]);

  const userMessage: UIMessage = {
    id: "continuity-user",
    role: "user",
    parts: [{ type: "text", text: CONTINUITY_LONG_TOKEN }],
  };

  return (
    <div data-client-continuity className="p-bg p-text min-h-screen px-4 py-6">
      <div className="mx-auto max-w-[760px] space-y-6">
        <div data-wrap-user>
          <MessageView message={userMessage} />
        </div>
        <div data-wrap-steer>
          <SteerBubble steer={{
            id: "continuity-steer", text: CONTINUITY_LONG_TOKEN,
            state: "queued", atStep: null,
          }} />
        </div>
        <Composer
          value={draft}
          onValueChange={setDraft}
          onSend={() => setSends((count) => count + 1)}
          onStop={() => {}}
          placeholder="Send a message"
          disabled={false}
          liveness={IDLE_TURN}
          attachments={{
            items: [],
            onAdd: (added) => setFiles((current) => [
              ...current,
              ...Array.from(added ?? [], (file) => `${file.name}:${file.size}`),
            ]),
            onRemove: () => {},
          }}
        />
        <div data-image-success>
          <MarkdownContent content="![Loaded image](/assets/kinu-icon.svg)" />
        </div>
        <div data-image-failure>
          <MarkdownContent content="![Request flow diagram](/assets/missing-continuity-image.png)" />
        </div>
        <Button size="sm" data-continuity-reset onClick={() => { setDraft(""); setSends(0); setFiles([]); }}>Reset fixture</Button>
        <div data-continuity-probe className="hidden"
          data-draft={draft}
          data-sends={sends}
          data-files={files.join("|")}
          data-token-length={CONTINUITY_LONG_TOKEN.length} />
      </div>
    </div>
  );
}

/** The quality read fails until healed, so its retry is observable. */
function QualityRetryFrame() {
  const healthy = useRef(false);

  useEffect(() => {
    const heal = () => { healthy.current = true; };

    window.addEventListener("gallery:quality-heal", heal);

    return () => window.removeEventListener("gallery:quality-heal", heal);
  }, []);

  const rpc = useMemo(() => galleryRpc({
    getQuality: () => (healthy.current ? Effect.succeed(QUALITY_DAYS) : Effect.fail(new KinuError("unavailable", "quality fixture failed"))),
    getQualityWindow: () => QUALITY_WINDOW,
  }), []);

  return (
    <div data-quality-retry className="p-bg p-text min-h-screen p-6">
      <div className="mx-auto max-w-[760px]">
        <QualityView rpc={rpc} moved={0} />
      </div>
    </div>
  );
}

/* The thread ends on a bare`slate://` address: the markdown pass must turn it into the card, not a link. */
const SLATE_THREAD: UIMessage[] = [
  msg({
    id: "sl-u1", role: "user", createdAt: NOW - 4 * 60e3,
    parts: [{ type: "text", text: "Which target should the release go to?" }],
  }),
  msg({
    id: "sl-a1", role: "assistant", createdAt: NOW - 3 * 60e3,
    parts: [{ type: "text", text: "Pick one below and I will continue.\n\nslate://deploy-choice" }],
  }),
];

function ChatSlateFrame() {
  const thread = buildTranscript(SLATE_THREAD, []);
  const inline = { rpc: slateRpc, openSlate: () => {} };

  return (
    <SlateInlineContext.Provider value={inline}>
      <div className="flex h-screen justify-center p-bg p-text">
        <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
          <GalleryWorkspaceHeader />
          <div className="flex-1 overflow-y-auto px-6 py-7 space-y-5 lg:px-8" data-gallery-chat>
            {thread.entries.map(({ message, steers }) => (
              <div key={message.id} data-chat-row={message.id}>
                <MessageView
                  message={message} steers={steers} onFork={() => {}} />
              </div>
            ))}
          </div>
          <GalleryComposer />
        </div>
      </div>
    </SlateInlineContext.Provider>
  );
}

function JobStreamingFrame() {
  const building = useBuildingJob();

  return <Shell backgroundJobs={[building, ...BACKGROUND_JOBS]} />;
}

/** One message per state the `chat` frame folds or cannot pre-expand; auto-expanded on mount below. */
const TOOLCALL_MESSAGES: UIMessage[] = [
  msg({
    id: "tc-quiet", role: "assistant",
    parts: [
      { type: "text", text: "Successful error-shaped data — the invocation completed normally, so these returned fields do not mark it as failed." },
      { type: "tool-file", toolCallId: "tc1", state: "output-available", input: { op: "edit", path: "workers/api/wrangler.jsonc", edits: [{}, {}] }, output: { error: "old_text not found or not unique — the file changed since the last read" } },
    ],
  }),
  msg({
    id: "tc-protocol", role: "assistant",
    parts: [
      { type: "text", text: "Protocol-level failure — the executor crashed before it could return anything; the reason lives in errorText, not output." },
      { type: "tool-run", toolCallId: "tc2", state: "output-error", input: { runtime: "workspace", command: "curl -sf https://ci.internal/status/api-worker" }, errorText: "fetch failed: connect ETIMEDOUT 10.0.4.12:443" },
    ],
  }),
  msg({
    id: "tc-run", role: "assistant",
    parts: [
      { type: "text", text: "A multi-line `shell` command, expanded — a shell script, not an escaped JSON string." },
      {
        type: "tool-run", toolCallId: "tc3", state: "output-available",
        input: { runtime: "computer", command: "for f in workers/api/migrations/*.sql; do\n  echo \"-- checking $f\"\n  sqlite3 :memory: < \"$f\" || exit 1\ndone" },
        output: "-- checking workers/api/migrations/0006_users.sql\n-- checking workers/api/migrations/0007_sessions.sql",
      },
    ],
  }),
  msg({
    id: "tc-mcp", role: "assistant",
    parts: [
      { type: "text", text: "An MCP tool with no known summarizer contract — the honest fallback (name + its one argument), and long enough to test truncation." },
      {
        type: "dynamic-tool", toolCallId: "tc4", toolName: "mcp_gh_search_pull_requests", state: "output-available",
        input: { query: "repo:AshishKumar4/api-worker is:open head:fix/sessions-binding base:main status:success review-requested:AshishKumar4" },
        output: "1 open PR: #212 \"Read the sessions database by its new binding\" — checks pending",
      },
    ],
  }),
  msg({
    id: "tc-group", role: "assistant",
    parts: [
      { type: "text", text: "Five finished calls with one failed invocation — the group's status comes from the error channel." },
      { type: "tool-file", toolCallId: "tc5", state: "output-available", input: { op: "read", path: "workers/api/src/db.ts" }, output: "…" },
      { type: "tool-file", toolCallId: "tc6", state: "output-available", input: { op: "read", path: "workers/api/wrangler.jsonc" }, output: "…" },
      { type: "tool-file", toolCallId: "tc7", state: "output-error", input: { op: "edit", path: "workers/api/wrangler.jsonc", edits: [{}, {}] }, errorText: "old_text not found or not unique" },
      { type: "tool-file", toolCallId: "tc8", state: "output-available", input: { op: "write", path: "workers/api/test/integration/sessions-binding.test.ts" }, output: "ok" },
      { type: "tool-agents", toolCallId: "tc9", state: "output-available", input: { op: "swarm", branches: 3, task: "Check every other call site" }, output: "3 forks merged" },
    ],
  }),
];

/** Fifty observations, three changes and one preview call placed mid-run with an `observe` shape, so only the preview rule can keep it. */
const LARGE_TOOL_RUN_MESSAGE: UIMessage = msg({
  id: "tc-large-run", role: "assistant",
  parts: [
    { type: "text", text: "A long repository inspection with three consequential changes." },
    ...Array.from({ length: 50 }, (_, index) => ({
      type: "tool-file" as const,
      toolCallId: `scan-${String(index)}`,
      state: "output-available" as const,
      input: { op: "read", path: `workers/api/src/generated/module-${String(index)}.ts` },
      output: "…",
    })),
    { type: "tool-run", toolCallId: "large-preview", state: "output-available", input: { runtime: "computer", command: "kinu expose 8789" }, output: { url: SLATE_GALLERY_URL, port: 8789 } },
    { type: "tool-file", toolCallId: "large-edit", state: "output-available", input: { op: "edit", path: "workers/api/wrangler.jsonc", edits: [{}, {}] }, output: { error: "old_text not found or not unique" } },
    { type: "tool-file", toolCallId: "large-write", state: "output-available", input: { op: "write", path: "workers/api/test/integration/sessions-binding.test.ts" }, output: "ok" },
    { type: "tool-tasks", toolCallId: "large-task", state: "output-available", input: { op: "update", id: "t4", status: "done" }, output: "ok" },
  ],
});

/** Credential-shaped fields nested where a webhook or MCP call puts them, plus free-text previews with the same token; `?frame=toolrun&secrets=1` asserts every secret is masked. */
/** Assembled in parts: the commit-tier secret scan shares the preview's redaction patterns, so a literal would block the commit. */
const ASSEMBLED_TOKEN = `cfut_${'a'.repeat(48)}`;

const SECRET_TOOL_RUN_PART: UIMessage['parts'][number] = {
  type: 'tool-run',
  toolCallId: 'secret-call',
  state: 'output-available',
  input: {
    runtime: 'computer',
    command: `curl -s https://api.stripe.example/v1/charges --token=${ASSEMBLED_TOKEN}`,
    headers: { authorization: 'Bearer sk-live-REDACTME' },
    nested: { apiKey: 'sk-live-REDACTME', keep: 'visible' },
  },
  output: {
    status: 200,
    headers: { authorization: 'Bearer sk-live-REDACTME' },
    nested: { apiKey: 'sk-live-REDACTME', keep: 'visible' },
    body: `token ${ASSEMBLED_TOKEN} accepted`,
  },
};

/** The token in a protocol-level failure's `errorText`. */
const SECRET_ERROR_PART: UIMessage['parts'][number] = {
  type: 'tool-run',
  toolCallId: 'secret-error',
  state: 'output-error',
  input: { runtime: 'computer', command: `deploy --token=${ASSEMBLED_TOKEN}` },
  errorText: `deploy rejected the credential ${ASSEMBLED_TOKEN}`,
};

const SECRET_TOOL_RUN_MESSAGE: UIMessage = msg({
  id: 'tc-secret-run', role: 'assistant',
  parts: [
    { type: 'text', text: 'A call that carries credential-shaped fields in both directions.' },
    SECRET_TOOL_RUN_PART,
    SECRET_ERROR_PART,
  ],
});

/** Clicks open every collapsed row after mount: the toggle is local state, and a gallery-only prop would change the real component. */
function useAutoExpandToolCalls(): void {
  useEffect(() => {
    const clickAll = () => {
      for (const element of document.querySelectorAll('button[aria-expanded="false"]')) {
        if (element instanceof HTMLButtonElement) element.click();
      }
    };

    const id = setTimeout(() => {
      clickAll();
      // A group's toggle mounts its members' toggles a render later.
      requestAnimationFrame(() => requestAnimationFrame(clickAll));
    }, 50);

    return () => clearTimeout(id);
  }, []);
}

/** A turn in flight, in each state its tail can be in; the part `state` fields are the AI SDK stream reducer's real ones. */
const STREAMING_MESSAGES: UIMessage[] = [
  msg({
    id: "st-text", role: "assistant",
    parts: [
      { type: "text", state: "streaming", text: "The 500 is a `.prepare` on `env.DB`, and after Tuesday's deploy the database is bound as `SESSIONS_DB`. The caret belongs at the end of this sentence" },
    ],
  }),
  msg({
    id: "st-after-tools", role: "assistant",
    parts: [
      { type: "text", state: "done", text: "Reading `openDb` and the config that landed Tuesday." },
      { type: "tool-file", toolCallId: "st1", state: "output-available", input: { op: "read", path: "workers/api/src/db.ts" }, output: "…" },
      { type: "tool-file", toolCallId: "st2", state: "output-available", input: { op: "read", path: "workers/api/wrangler.jsonc" }, output: "…" },
    ],
  }),
  msg({
    id: "st-tool", role: "assistant",
    parts: [
      { type: "text", state: "done", text: "Running the regression suite before I touch anything else." },
      { type: "tool-run", toolCallId: "st3", state: "input-available", input: { runtime: "computer", command: "bun test workers/api" } },
    ],
  }),
  msg({
    id: "st-reasoning", role: "assistant",
    parts: [
      { type: "reasoning", state: "streaming", text: "The health route fails and the static ones do not, so the cause is the database binding rather than the router. Before I patch it I want the config in front of me" },
    ],
  }),
  msg({
    id: "st-fence", role: "assistant",
    parts: [
      { type: "text", state: "streaming", text: "Here is the fix, mid-fence:\n\n```ts\nconst db = env.SESSIONS_DB ?? env.DB;\nif (db === undefined) throw new MissingBinding(\"SESSIONS_DB\");\n```" },
    ],
  }),
  msg({ id: "st-empty", role: "assistant", parts: [] }),
];

/** Rendered as the last message of an open stream, the only condition that draws a live tail. */
function StreamingFrame() {
  return (
    <div className="flex justify-center p-bg p-text min-h-screen">
      <div data-gallery-stream className="@container flex w-full max-w-[640px] flex-col gap-8 border-x p-border px-6 py-6">
        {STREAMING_MESSAGES.map((message) => {
          const tail = threadLiveTail({ last: message, liveness: LIVE_TURN });

          return (
            <div data-stream-id={message.id} key={message.id}>
              <MessageView message={message} liveTail={tail} onFork={() => {}} />
              <ChatLiveTail tail={tail} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MessageColumn({ messages }: { messages: UIMessage[] }) {
  return (
    <div className="flex justify-center p-bg p-text min-h-screen">
      <div className="@container flex w-full max-w-[640px] flex-col gap-6 border-x p-border px-6 py-6">
        {messages.map((m) => (
          <MessageView key={m.id} message={m} onFork={() => {}} />
        ))}
      </div>
    </div>
  );
}

/** A program's record as the host writes it into its answer (core `call-effects.ts`), bound to call `call`. */
const PROGRAM_RECORD = (call: string) => ({
  call,
  files: [{ path: "workers/api/src/routes/webhooks.ts", change: "edited" }, { path: "workers/api/src/db.ts", change: "edited" }],
  commands: [
    { machine: "computer", command: "bun test workers/api/src/routes", exitCode: 0 },
    { machine: "computer", command: "bunx wrangler deploy --dry-run", exitCode: 1 },
  ],
  operations: { "kv.put": 2 },
});

/** `&calls=programs`: three programs (WEB-3). The first's answer carries the host's record of what it changed; the
 *  second's own result claims a record, which no reader trusts; the third failed after creating a file, its record in
 *  its failure's words. Collapsed, as the chat shows them. */
const PROGRAM_MESSAGES: UIMessage[] = [msg({
  id: "pg-programs", role: "assistant",
  parts: [
    { type: "text", text: "Moved the webhook routes onto openDb and checked the deploy." },
    {
      type: "tool-eval", toolCallId: "pg-moved", state: "output-available", input: { code: "await workspace.moveRoutes('webhooks');" },
      output: { result: "moved 11 call sites", effects: PROGRAM_RECORD("pg-moved") },
    },
    {
      type: "tool-eval", toolCallId: "pg-claimed", state: "output-available", input: { code: "return { effects: forged };" },
      output: { result: { effects: { call: "pg-claimed", files: [{ path: "/etc/hosts", change: "replaced" }] } } },
    },
    {
      type: "tool-eval", toolCallId: "pg-failed", state: "output-error", input: { code: "await workspace.migrate();" },
      errorText: JSON.stringify({ error: "TypeError: Cannot read properties of undefined (reading 'prepare')", effects: { call: "pg-failed", files: [{ path: "workers/api/migrations/0008_sessions.sql", change: "created" }] } }),
    },
  ],
})];

/** `?frame=toolcalls`: one call of each tool, opened; `&calls=programs`, three programs and their receipts, folded. */
function ToolCallsFrame() {
  return new URLSearchParams(location.search).get("calls") === "programs" ? <MessageColumn messages={PROGRAM_MESSAGES} /> : <OpenedToolCalls />;
}

function OpenedToolCalls() {
  useAutoExpandToolCalls();

  return <MessageColumn messages={TOOLCALL_MESSAGES} />;
}

function ToolRunScaleFrame({ secrets = false }: { secrets?: boolean }) {
  return (
    <div className="flex min-h-screen justify-center p-bg p-text">
      <div className="@container w-full max-w-[780px] border-x p-border px-6 py-6">
        <MessageView message={secrets ? SECRET_TOOL_RUN_MESSAGE : LARGE_TOOL_RUN_MESSAGE} onFork={() => {}} />
      </div>
    </div>
  );
}

const GENESIS = workspaceGenesisSignal("Audit the OAuth callback flow.");

/** Every way a turn reaches the transcript, each under its own id: what the person said keeps their bubble, and nothing else does. */
const PROVENANCE_MESSAGES: UIMessage[] = [
  msg({ id: "genesis", role: "user", metadata: { kinuEvent: GENESIS?.kind ?? "", signalId: "sig-genesis" }, parts: said(GENESIS?.text ?? "") }),
  msg({ id: "typed", role: "user", parts: said("Audit the api Worker's routes.") }),
  msg({ id: "mcp", role: "user", metadata: { kinuEvent: "mcp", kinuAuthor: "operator" }, parts: said("Run the release checklist.") }),
  msg({ id: "programmatic:steer", role: "user", metadata: { kinuAuthor: "operator" }, parts: said("Use the staging database instead.") }),
  msg({ id: "invented", role: "user", metadata: { kinuEvent: "a_kind_invented_tomorrow" }, parts: said("Something new happened.") }),
  msg({ id: "harness", role: "user", metadata: { kinuAuthor: "harness" }, parts: said("[Runtime check] The tree is clean.") }),
  ...EVENT_CARD_ROWS,
  ...SYSTEM_EVENT_ROWS,
];

function ProvenanceFrame() {
  return (
    <div className="flex justify-center p-bg p-text min-h-screen">
      <div className="@container flex w-full max-w-[640px] flex-col gap-6 border-x p-border px-6 py-6">
        {PROVENANCE_MESSAGES.map((message) => (
          <div key={message.id} data-chat-row={message.id}><MessageView message={message} onFork={() => {}} /></div>
        ))}
      </div>
    </div>
  );
}

/** Five transcript states that must not render as one blank pane. */
function TranscriptFrame() {
  return (
    <div className="p-bg p-text min-h-screen p-5 space-y-5">
      {[
        ["Completed head — task, steps, highlighted report, search path", "root-merge-1-h0"],
        ["Running head — partial trace, live liveness", "root-merge-1-h1"],
        ["Head that died before its first step", "root-merge-1-h2"],
        ["Competed rollout — one proposal, no trace by construction", "n003"],
        ["A node neither store holds", "gone-1"],
      ].map(([label, nodeId]) => (
        <div key={nodeId} className="space-y-1.5">
          <div className="text-[11px] uppercase tracking-wider p-text-3">{label}</div>
          <div className="h-[34rem] w-[44rem] flex flex-col">
            <NodeTranscript
              selection={{ runId: nodeId.startsWith("n") ? "n000" : "root-merge-1", nodeId }}
              trees={MCTS_TREES} rpc={forkRpc} headActivity={NO_HEAD_ACTIVITY}
              onSelect={() => {}} />
          </div>
        </div>
      ))}
      {/* The chat chip derives its head id, so needs no canvas selection; both statuses offer different things. */}
      <div className="space-y-1.5">
        <div className="text-[11px] uppercase tracking-wider p-text-3">
          Mid-turn branch chip — the transcript it opens in place
        </div>
        {(["running", "settled"] as const).map((status) => (
          <BranchRunChip key={status}
            run={{
              branchId: "steer-b7f21", status,
              task: "Actually, check staging first — I don't think the rename deployed there.",
              takeSetId: undefined, turnId: undefined, message: undefined,
            }}
            rpc={forkRpc} headActivity={NO_HEAD_ACTIVITY}
            // Unreachable here: picking needs a hydrated take set.
            onPick={() => Promise.reject(new Error("no take set in this frame"))}
            onDismiss={() => {}} />
        ))}
      </div>
    </div>
  );
}

function SnapshotRaceFrame() {
  const state = useKinu(WORKSPACE_PAGE_NAME);

  return <>
    <button data-snapshot-race-retry onClick={state.retryLoad}>Retry</button>
    <button data-snapshot-race-refresh onClick={() => galleryServerPush(JSON.stringify({
      type: READS_CHANGED_EVENT,
      reads: ["getMemoryContent", "getExecutors", "getWorkspaceTabPresence", "getActivePlanReview", "listSlates"],
    }))}>Refresh</button>
    <output data-snapshot-race-state>{JSON.stringify({
      snapshot: state.actorSnapshot?.displayName,
      memory: state.memoryContent,
      executors: state.executors.map((executor) => executor.name),
      plan: state.activePlan?.id ?? null,
      presence: state.tabPresence,
      slates: state.slates.map((slate) => slate.id),
    })}</output>
  </>;
}

/** The reads a snapshot race moves, at the revision `data-snapshot-race-revision` names: the snapshot's own, or `current`. */
function raceReads() {
  const current = document.documentElement.dataset.snapshotRaceRevision === "current";

  const executors: ExecutorInfo[] = current
    ? [{ name: "current-executor", kind: "workspace", capabilities: [], available: true, configured: true, active: true, status: "active" }]
    : [];

  const slates: SlateSummary[] = current ? [{ id: "current-slate", title: "Current slate" }] : [];

  return {
    memoryContent: current ? "current memory" : "snapshot memory",
    executors,
    activePlan: current ? { ...galleryAgentPlan, id: "current-plan" } : null,
    tabPresence: { work: current, explorations: false },
    slates,
  };
}

/** The page's answers, with the snapshot held until `gallery:release-snapshot` under `data-snapshot-race-hold="1"`. */
const SNAPSHOT_RACE_ANSWERS: WorkspaceAnswers = {
  ...PAGE_ANSWERS,
  getWorkspaceSnapshot: async () => {
    const { activePlan, ...seeded } = raceReads();
    const held = document.documentElement.dataset.snapshotRaceHold === "1";
    const displayName = held ? "held snapshot" : "initial snapshot";
    const answer = withChat({ ...OPENING_SNAPSHOT, ...seeded, status: { ...OPENING_SNAPSHOT.status, displayName } }, { displayName, activePlan });

    if (held) {
      document.documentElement.dataset.snapshotRaceWaiting = "1";
      await new Promise<void>((resolve) => {
        window.addEventListener("gallery:release-snapshot", () => { resolve(); }, { once: true });
      });
    }

    return answer;
  },
  getMemoryContent: () => raceReads().memoryContent,
  getExecutors: () => raceReads().executors,
  getActivePlanReview: () => raceReads().activePlan,
  getWorkspaceTabPresence: () => raceReads().tabPresence,
  listSlates: () => ({ slates: raceReads().slates, problems: [] }),
};

let qualityLiveRatings = 0;

/** The Quality tab as a rating lands. */
function QualityLiveFrame() {
  const state = useKinu(WORKSPACE_PAGE_NAME);

  const rpc = useMemo(() => answeringRpc({
    getQualityWindow: () => ({ ...QUALITY_WINDOW, rated: QUALITY_WINDOW.rated + qualityLiveRatings, turns: QUALITY_WINDOW.turns + qualityLiveRatings }),
    getQuality: () => {
      const today = QUALITY_DAYS.at(-1);

      return today === undefined ? QUALITY_DAYS : [
        ...QUALITY_DAYS.slice(0, -1),
        { ...today, rated: today.rated + qualityLiveRatings, turns: today.turns + qualityLiveRatings },
      ];
    },
  }), []);

  return (
    <div data-quality-live className="p-bg p-text min-h-screen p-6">
      <button data-quality-rate onClick={() => {
        qualityLiveRatings += 1;
        galleryServerPush(JSON.stringify({ type: READS_CHANGED_EVENT, reads: ["getQuality"] }));
      }}>Rate a turn</button>
      <div className="mx-auto max-w-[760px]"><QualityView rpc={rpc} moved={state.readMoves.getQuality ?? 0} /></div>
    </div>
  );
}

function snapshotRaceFrame(): MountedFrame {
  serveGalleryRpc(wireOf(SNAPSHOT_RACE_ANSWERS));

  return { entries: ["/"], node: <SnapshotRaceFrame /> };
}

/** This module's frames, by `?frame=`: gallery.tsx mounts the one asked for. */
export const chatFrames: FrameTable = {
  chat: () => framed(<ChatFrame />),
  chatsteer: () => framed(<ChatSteerFrame />),
  chatempty: () => framed(<ChatEmptyFrame />),
  chatloading: () => framed(<ChatLoadingFrame />),
  composer: () => framed(<ComposerFrame />),
  chathistory: () => framed(<ChatHistoryFrame />),
  historyauthority: () => framed(<HistoryAuthorityFrame />),
  rosterauthority: () => framed(<RosterAuthorityFrame />),
  clientcontinuity: () => framed(<ClientContinuityFrame />),
  qualityretry: () => framed(<QualityRetryFrame />),
  toolcalls: () => framed(<ToolCallsFrame />),
  toolrun: () => framed(<ToolRunScaleFrame secrets={new URLSearchParams(location.search).get("secrets") === "1"} />),
  provenance: () => framed(<ProvenanceFrame />),
  streaming: () => framed(<StreamingFrame />),
  transcript: () => framed(<TranscriptFrame />),
  "chat-slate": () => framed(<ChatSlateFrame />),
  jobstreaming: () => framed(<JobStreamingFrame />),
  chatcode: () => framed(<ChatCodeFrame />),
  snapshotrace: () => snapshotRaceFrame(),
  qualitylive: () => {
    serveGalleryRpc(workspacePageWire);

    return framed(<QualityLiveFrame />);
  },
};
