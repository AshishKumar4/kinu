import { useEffect, useRef, useState } from "react";
import { Button, Tabs } from "@cloudflare/kumo";
import {
  ArrowCounterClockwiseIcon,
  CheckCircleIcon,
  GearSixIcon,
  PauseIcon,
  PlayIcon,
} from "@phosphor-icons/react";
import type { UIMessage } from "ai";
import { Composer, type ChatMode } from "@/components/Composer";
import { MessageView } from "@/components/MessageView";

type DemoPhase = "chat" | "working" | "review";
type JournalFilter = "all" | "jobs" | "plan";

const PHASES = [
  { value: "chat", label: "Chat" },
  { value: "working", label: "Working" },
  { value: "review", label: "Review" },
] as const satisfies ReadonlyArray<{ value: DemoPhase; label: string }>;

const PHASE_COPY = {
  chat: "Give Jarvis a task from the same composer used in the app.",
  working: "Jarvis is reading the workspace and running audit branches.",
  review: "The run is settled. Its result and decisions are ready to review.",
} as const satisfies Record<DemoPhase, string>;

const NEXT_PHASE = {
  chat: "working",
  working: "review",
} as const satisfies Record<Exclude<DemoPhase, "review">, DemoPhase>;

const PHASE_ORDER = {
  chat: 0,
  working: 1,
  review: 2,
} as const satisfies Record<DemoPhase, number>;

const USER_MESSAGE = {
  id: "workspace-demo-user",
  role: "user",
  parts: [{
    type: "text",
    text: "Audit the Kinu workspace. Find the slowest path and show me the code that causes it.",
  }],
} satisfies UIMessage;

const AUDIT_PARTS = [
  {
    type: "reasoning",
    text: "I should map the request path, measure the slow tests, and run separate audit branches before changing anything.",
  },
  {
    type: "tool-file",
    toolCallId: "workspace-demo-map",
    state: "output-available",
    input: { action: "read", path: "packages/cf-backend/src" },
    output: "Mapped 7 packages and the workspace request path.",
  },
  {
    type: "tool-run",
    toolCallId: "workspace-demo-test",
    state: "output-available",
    input: { runtime: "workspace", command: "bun test packages/cf-backend" },
    output: "18 pass · 2.4 s",
  },
] satisfies UIMessage["parts"];

const SWARM_INPUT = {
  action: "fork",
  task: "Trace the workspace resume path and report one measured bottleneck.",
  forks: [{}, {}, {}, {}, {}],
};

const WORKING_MESSAGE = {
  id: "workspace-demo-work",
  role: "assistant",
  parts: [
    ...AUDIT_PARTS,
    {
      type: "tool-agents",
      toolCallId: "workspace-demo-swarm",
      state: "input-available",
      input: SWARM_INPUT,
    },
  ],
} satisfies UIMessage;

const REVIEW_WORK_MESSAGE = {
  ...WORKING_MESSAGE,
  parts: [
    ...AUDIT_PARTS,
    {
      type: "tool-agents",
      toolCallId: "workspace-demo-swarm",
      state: "output-available",
      input: SWARM_INPUT,
      output: "5 branches settled · 3 code-grounded findings",
    },
  ],
} satisfies UIMessage;

const SYSTEM_MESSAGE = {
  id: "workspace-demo-system",
  role: "system",
  parts: [{
    type: "text",
    text: "The five audit branches settled. Their reports were added to this turn and shown to Jarvis.",
  }],
} satisfies UIMessage;

const RESULT_MESSAGE = {
  id: "workspace-demo-result",
  role: "assistant",
  parts: [{
    type: "text",
    text: "The slow path is the workspace resume loop. Every reconnect reads the full journal before it checks the saved cursor.\n\n**Result:** moving the cursor check ahead of journal hydration cut the focused test from 1.8 s to 640 ms. All 18 workspace tests pass.",
  }],
} satisfies UIMessage;

const MESSAGES_BY_PHASE = {
  chat: [USER_MESSAGE],
  working: [USER_MESSAGE, WORKING_MESSAGE],
  review: [USER_MESSAGE, REVIEW_WORK_MESSAGE, SYSTEM_MESSAGE, RESULT_MESSAGE],
} as const satisfies Record<DemoPhase, readonly UIMessage[]>;

const JOURNAL_ROWS = [
  { from: "review", filter: "jobs", label: "Audit swarm settled · 5 reports", age: "now", tone: "accent" },
  { from: "review", filter: "plan", label: "Measured the workspace resume path", age: "1m", tone: "success" },
  { from: "working", filter: "jobs", label: "Ran 18 workspace tests", age: "2m", tone: "success" },
  { from: "working", filter: "plan", label: "Mapped 7 packages", age: "3m", tone: "success" },
  { from: "chat", filter: "plan", label: "Workspace mission loaded", age: "4m", tone: "success" },
] as const satisfies ReadonlyArray<{
  from: DemoPhase;
  filter: Exclude<JournalFilter, "all">;
  label: string;
  age: string;
  tone: "accent" | "success";
}>;

function isDemoPhase(value: string): value is DemoPhase {
  return PHASES.some((phase) => phase.value === value);
}

function WorkspaceRail({ onReset }: { onReset: () => void }) {
  return (
    <aside className="hidden h-full min-h-0 flex-col border-r p-border p-sidebar @3xl:flex" aria-label="Workspace rail">
      <div className="flex items-center gap-2.5 px-5 pb-2 pt-4">
        <span aria-hidden className="inline-block rotate-12 font-serif text-xl leading-none p-gold">❯</span>
        <span className="font-serif text-xl font-semibold tracking-[.01em]">Kinu</span>
      </div>

      <Button
        size="sm"
        variant="outline"
        className="mx-3 mt-3 justify-center p-text-2"
        onClick={onReset}
      >
        <span aria-hidden className="text-sm leading-none">+</span>
        New workspace
      </Button>

      <div className="px-5 pb-2 pt-6 font-mono text-[9px] uppercase tracking-[.18em] p-text-4">
        Workspaces
      </div>
      <div className="mx-2 flex items-center gap-2 rounded-lg bg-[var(--c-elevated)] px-3 py-2">
        <span className="size-1.5 shrink-0 rounded-full p-dot-accent" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">Jarvis</span>
        <span className="font-mono text-[10px] p-text-4">now</span>
      </div>
      <div className="mx-5 mt-1 border-l p-border pl-2.5">
        <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5">
          <span className="min-w-0 flex-1 truncate text-xs p-text-2">Scout</span>
          <span className="text-[10px] p-text-4">research</span>
        </div>
        <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5">
          <span className="min-w-0 flex-1 truncate text-xs p-text-2">Sentry</span>
          <span className="text-[10px] p-text-4">PR review</span>
        </div>
        <div className="px-2.5 py-1.5 text-[11px] p-text-4">+ New agent</div>
      </div>

      <div className="mt-auto flex items-center gap-2.5 border-t p-border px-4 py-3.5">
        <span className="flex size-7 items-center justify-center rounded-full p-accent-bg text-xs font-semibold p-gold">A</span>
        <span className="min-w-0 flex-1 truncate text-xs p-text-3">ashishkmr472</span>
        <GearSixIcon size={13} className="p-text-4" aria-hidden />
      </div>
    </aside>
  );
}

function WorkspaceHeader({ working }: { working: boolean }) {
  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b p-border p-sidebar px-4 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <span className="truncate text-[15px] font-semibold">Jarvis</span>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--c-accent)_28%,transparent)] bg-[var(--c-accent-subtle)] px-2.5 py-1 text-[11px] font-medium p-gold">
          <span className={`size-1.5 rounded-full ${working ? "p-dot-accent p-dot-pulse" : "p-dot-success"}`} aria-hidden />
          {working ? "Working" : "Live"}
        </span>
        <span className="hidden max-w-48 truncate rounded-full border p-border p-fill px-3 py-1 font-mono text-[11px] p-text-4 @5xl:inline">
          deepseek-v4-pro-0813
        </span>
      </div>
      <div className="flex items-center gap-0.5 rounded-full border p-border p-fill p-1" aria-label="Workspace mode">
        <span className="rounded-full bg-[var(--c-accent)] px-4 py-1 text-xs font-semibold text-[var(--c-accent-on)]">Run</span>
        <span className="px-4 py-1 text-xs font-semibold p-text-4">Supervise</span>
      </div>
    </header>
  );
}

function Conversation({
  phase,
  draft,
  onDraft,
  onSend,
  onStop,
  mode,
  onMode,
}: {
  phase: DemoPhase;
  draft: string;
  onDraft: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  mode: ChatMode;
  onMode: (mode: ChatMode) => void;
}) {
  const messages = MESSAGES_BY_PHASE[phase];
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = messagesRef.current;
    if (container) container.scrollTop = phase === "chat" ? 0 : container.scrollHeight;
  }, [phase]);

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Jarvis conversation">
      <div className="flex shrink-0 items-stretch border-b p-border px-2" aria-label="Workspace agents">
        <span className="p-tab p-tab-active -mb-px px-3 py-2 text-xs font-medium">Main</span>
        <span className="p-tab -mb-px px-3 py-2 text-xs">Scout</span>
        <span className="p-tab -mb-px px-3 py-2 text-xs">Sentry</span>
      </div>

      <div ref={messagesRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 @xl:px-6">
        <div className="mx-auto max-w-2xl space-y-5">
          {messages.map((message, index) => (
            <MessageView
              key={message.id}
              message={message}
              isLast={index === messages.length - 1}
              isStreaming={phase === "working"}
            />
          ))}
        </div>
      </div>

      <div className="shrink-0 border-t p-border p-sidebar">
        <Composer
          value={draft}
          onValueChange={onDraft}
          onSend={onSend}
          placeholder={phase === "working" ? "Steer the running turn…" : "Send a message…"}
          disabled={false}
          streaming={phase === "working"}
          onStop={onStop}
          onSteer={onSend}
          onBranch={onSend}
          mode={{ value: mode, onChange: onMode, locked: false }}
          modelPicker={(
            <span className="min-w-0 max-w-40 truncate px-1 text-xs p-text-4" title="DeepSeek V4 Pro">
              DeepSeek V4 Pro
            </span>
          )}
        />
      </div>
    </section>
  );
}

function JournalMark({ tone }: { tone: "accent" | "success" }) {
  if (tone === "success") return <CheckCircleIcon size={12} className="p-success" weight="fill" aria-hidden />;
  return <span className="text-xs p-gold" aria-hidden>◈</span>;
}

function WorkRail({
  phase,
  needsAction,
  onReview,
  onDismiss,
}: {
  phase: DemoPhase;
  needsAction: boolean;
  onReview: () => void;
  onDismiss: () => void;
}) {
  const [filter, setFilter] = useState<JournalFilter>("all");
  const phaseRows = JOURNAL_ROWS.filter((row) => PHASE_ORDER[row.from] <= PHASE_ORDER[phase]);
  const rows = phaseRows.filter((row) => filter === "all" || row.filter === filter);
  const waiting = phase === "review" && needsAction;

  return (
    <aside className="hidden min-h-0 w-64 shrink-0 flex-col border-l p-border p-sidebar @3xl:flex @5xl:w-80" aria-label="Work rail">
      <div className="flex h-10 shrink-0 items-end gap-1 border-b p-border px-3">
        <span className="p-tab -mb-px px-2.5 py-2 text-[11px]">Output</span>
        <span className="p-tab p-tab-active -mb-px px-2.5 py-2 text-[11px] font-medium">Work</span>
        <span className="p-tab -mb-px px-2.5 py-2 text-[11px]">Explore</span>
        <span className="p-tab -mb-px px-2.5 py-2 text-[11px]">Agent</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <section className={`mb-5 overflow-hidden rounded-xl border ${waiting ? "border-[color-mix(in_srgb,var(--c-accent)_32%,transparent)] bg-[var(--c-accent-subtle)]" : "p-border p-surface"}`} aria-label="Needs you">
          <div className="flex items-center justify-between px-4 py-3">
            <h2 className={`text-xs font-semibold ${waiting ? "p-gold" : "p-text-3"}`}>Needs you</h2>
            <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${waiting ? "bg-[var(--c-accent-subtle)] p-gold" : "p-fill p-text-4"}`}>
              {waiting ? "1" : "0"}
            </span>
          </div>
          <div className="px-4 pb-4">
            {waiting ? (
              <>
                <p className="text-[13px] leading-relaxed">Three code-grounded findings are ready. Choose the result Jarvis should keep.</p>
                <p className="mt-1 text-[11px] p-text-4">agents · now</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Button size="xs" variant="outline" onClick={onReview}>Keep result</Button>
                  <Button size="xs" variant="ghost" onClick={onDismiss}>Dismiss</Button>
                </div>
              </>
            ) : (
              <p className="text-xs leading-relaxed p-text-4">
                {phase === "working" ? "Jarvis is still running. Decisions appear here when they are ready." : "No decisions are waiting."}
              </p>
            )}
          </div>
        </section>

        <section className="mb-5" aria-label="Now">
          <h2 className="p-label mb-2">
            Now <span className="font-normal">· {phase === "working" ? "3" : "0"} of 5 in flight</span>
          </h2>
          {phase === "working" ? (
            <div className="p-group">
              <div className="flex items-center gap-2.5 px-3 py-2.5 text-xs">
                <span className="size-1.5 rounded-full p-dot-accent p-dot-pulse" aria-hidden />
                <span className="min-w-0 flex-1 truncate">Trace resume loop</span>
                <span className="font-mono text-[10px] p-text-4">42 s</span>
              </div>
              <div className="flex items-center gap-2.5 px-3 py-2.5 text-xs">
                <span className="size-1.5 rounded-full p-dot-accent p-dot-pulse" aria-hidden />
                <span className="min-w-0 flex-1 truncate">Profile journal reads</span>
                <span className="font-mono text-[10px] p-text-4">31 s</span>
              </div>
              <div className="flex items-center gap-2.5 px-3 py-2.5 text-xs">
                <span className="size-1.5 rounded-full p-dot-warning" aria-hidden />
                <span className="min-w-0 flex-1 truncate">Compare branch reports</span>
                <span className="font-mono text-[10px] p-text-4">queued</span>
              </div>
            </div>
          ) : (
            <p className="text-xs leading-relaxed p-text-4">
              {phase === "review" ? "The run is settled. Its reports remain in the journal." : "Multi-step work and detached tools appear here."}
            </p>
          )}
        </section>

        <section aria-label="Journal">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="p-label min-w-0 flex-1">Journal · {phaseRows.length}</h2>
            <Tabs
              variant="segmented"
              value={filter}
              onValueChange={(value) => {
                if (value === "all" || value === "jobs" || value === "plan") setFilter(value);
              }}
              tabs={[
                { value: "all", label: "All", className: "text-[10px] px-2" },
                { value: "jobs", label: "Jobs", className: "text-[10px] px-2" },
                { value: "plan", label: "Plan", className: "text-[10px] px-2" },
              ]}
              className="shrink-0"
              listClassName="h-7"
            />
          </div>
          <div className="p-group">
            {rows.map((row) => (
              <div key={row.label} className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-2.5 px-3 py-2.5">
                <span className="pt-0.5"><JournalMark tone={row.tone} /></span>
                <span className="text-xs leading-relaxed p-text-2">{row.label}</span>
                <span className="font-mono text-[10px] p-text-4">{row.age}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </aside>
  );
}

export function WorkspaceDemo() {
  const [phase, setPhase] = useState<DemoPhase>("chat");
  const [playing, setPlaying] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<ChatMode>("build");
  const [needsAction, setNeedsAction] = useState(true);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const applyPreference = () => {
      setReducedMotion(media.matches);
      if (media.matches) {
        setPhase("review");
        setPlaying(false);
      } else {
        setPlaying(true);
      }
    };
    applyPreference();
    media.addEventListener("change", applyPreference);
    return () => media.removeEventListener("change", applyPreference);
  }, []);

  useEffect(() => {
    if (!playing || reducedMotion) return;
    if (phase === "review") {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setPhase(NEXT_PHASE[phase]), 3600);
    return () => window.clearTimeout(timer);
  }, [phase, playing, reducedMotion]);

  const replay = () => {
    setPhase("chat");
    setDraft("");
    setNeedsAction(true);
    setPlaying(!reducedMotion);
  };

  const send = () => {
    if (!draft.trim()) return;
    setDraft("");
    setPhase("working");
    setNeedsAction(true);
    setPlaying(!reducedMotion);
  };

  const togglePlayback = () => {
    if (reducedMotion) return;
    if (!playing && phase === "review") setPhase("chat");
    setPlaying((value) => !value);
  };

  return (
    <section className="@container w-full overflow-hidden rounded-xl border p-border p-bg p-text p-shadow-overlay" aria-label="Interactive Kinu workspace preview">
      <div className="flex min-h-12 flex-wrap items-center gap-2 border-b p-border p-sidebar px-3 py-2">
        <span className="hidden min-w-0 flex-1 font-mono text-[10px] uppercase tracking-[.14em] p-text-4 @lg:inline">
          Web workspace · live DOM
        </span>
        <Tabs
          variant="segmented"
          value={phase}
          activateOnFocus
          onValueChange={(value) => {
            if (!isDemoPhase(value)) return;
            setPhase(value);
            setPlaying(false);
          }}
          tabs={PHASES.map(({ value, label }) => ({ value, label, className: "text-xs px-3" }))}
          className="min-w-0"
          listClassName="h-8"
        />
        <div className="ml-auto flex items-center gap-1">
          {reducedMotion && <span className="hidden text-[10px] p-text-4 @xl:inline">Reduced motion · manual</span>}
          <Button
            size="sm"
            variant="ghost"
            icon={playing ? <PauseIcon size={13} weight="fill" /> : <PlayIcon size={13} weight="fill" />}
            title={reducedMotion ? "Playback is off because reduced motion is enabled" : playing ? "Pause preview" : "Play preview"}
            disabled={reducedMotion}
            onClick={togglePlayback}
          >
            {playing ? "Pause" : "Play"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<ArrowCounterClockwiseIcon size={14} />}
            title="Replay preview"
            onClick={replay}
          >
            Replay
          </Button>
        </div>
      </div>

      <div className="border-b p-border px-3 py-1.5 text-center text-[11px] p-text-4" role="status" aria-live="polite">
        <span className="font-medium p-text-2">{PHASES.find((item) => item.value === phase)?.label}</span>
        <span aria-hidden> · </span>
        {PHASE_COPY[phase]}
      </div>

      <div className="grid h-160 min-h-0 grid-cols-1 @3xl:grid-cols-[12rem_minmax(0,1fr)] @5xl:grid-cols-[15rem_minmax(0,1fr)]">
        <WorkspaceRail onReset={replay} />
        <div className="flex min-h-0 min-w-0 flex-col">
          <WorkspaceHeader working={phase === "working"} />
          <div className="flex min-h-0 flex-1">
            <Conversation
              phase={phase}
              draft={draft}
              onDraft={setDraft}
              onSend={send}
              onStop={() => {
                setPhase("chat");
                setPlaying(false);
              }}
              mode={mode}
              onMode={setMode}
            />
            <WorkRail
              phase={phase}
              needsAction={needsAction}
              onReview={() => setNeedsAction(false)}
              onDismiss={() => setNeedsAction(false)}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
