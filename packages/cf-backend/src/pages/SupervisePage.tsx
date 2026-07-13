/**
 * Supervise altitude — the agent over time (automation + research operations),
 * distinct from the per-run RUN altitude. One scrollable canvas of blocks, each
 * bound to wired RPCs. Timers and webhooks are active; speculative trigger
 * kinds stay represented in durable state until their operator flows are added.
 *
 * Blocks: Curriculum (Voyager self-proposed tasks — fully actionable),
 * Run history (cross-run list), Automations (triggers + honest reactor state),
 * Fork lineage.
 */
import { useState, useEffect, useCallback } from "react";
import { Button, Badge, Loader } from "@cloudflare/kumo";
import {
  GraduationCapIcon, ClockIcon, LightningIcon, PlayIcon, CheckIcon, XIcon,
} from "@phosphor-icons/react";
import { EmptyState } from "@/components/surfaces/shared";
import type { Rpc, BackgroundJob } from "@/lib/protocol";

interface ProposedTask { id: string; task: string; rationale: string; predictedSuccess: number; targetsSkills: string[]; proposedAt: number; status: "pending" | "accepted" | "rejected" | "completed" }
interface RunSummary { runId: string; startedAt: number; causedBy: string | null; userMessage: string | null; status: string | null; tokensIn: number; tokensOut: number; tokensCached: number; eventCount: number }
interface TriggerRow {
  id: string;
  kind: string;
  state: string;
  created_at: number;
  rate_limit_per_min?: number;
  next_fire_at?: number | null;
  last_fire_at?: number | null;
  fire_count?: number;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export interface SupervisePageProps {
  rpc: Rpc;
  onRunTask: (task: string) => void;
  /** Cross-link into the RUN altitude's Tasks surface to manage a job. */
  onOpenTasks: () => void;
}

export function SupervisePage({ rpc, onRunTask, onOpenTasks }: SupervisePageProps) {
  return (
    <div className="h-full overflow-y-auto px-6 py-5 lg:px-10 max-w-5xl mx-auto space-y-8">
      <CurriculumBlock rpc={rpc} onRunTask={onRunTask} />
      <div className="grid md:grid-cols-2 gap-8">
        <RunHistoryBlock rpc={rpc} />
        <AutomationsBlock rpc={rpc} />
      </div>
      <BackgroundTasksBlock rpc={rpc} onOpenTasks={onOpenTasks} />
    </div>
  );
}

/* ── Background tasks — supervise-level digest, cross-linking to RUN ─ */

function BackgroundTasksBlock({ rpc, onOpenTasks }: { rpc: Rpc; onOpenTasks: () => void }) {
  const [jobs, setJobs] = useState<BackgroundJob[] | null>(null);
  useEffect(() => { rpc<BackgroundJob[]>("listBackgroundJobs", [20]).then(setJobs).catch(() => setJobs([])); }, [rpc]);
  const running = (jobs ?? []).filter((j) => j.status === "running").length;
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <ClockIcon size={16} className="p-accent" />
        <h2 className="text-sm font-semibold p-text">Background tasks</h2>
        {running > 0 && <Badge variant="secondary">{running} running</Badge>}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onOpenTasks}>Manage in Tasks →</Button>
      </div>
      {jobs === null ? <div className="flex justify-center py-6"><Loader size="sm" /></div>
        : jobs.length === 0 ? <p className="text-xs p-text-3">No background tasks — long tool calls (&gt;30s) detach here.</p>
        : (
          <div className="rounded-md border p-border overflow-hidden text-xs">
            {jobs.slice(0, 6).map((j) => (
              <div key={j.id} className="flex items-center gap-2 px-3 py-1.5 border-b p-border last:border-0">
                <span className={`size-1.5 rounded-full shrink-0 ${j.status === "running" ? "p-dot-warning" : j.status === "completed" ? "p-dot-success" : j.status === "cancelled" ? "p-dot-neutral" : "p-dot-danger"}`} />
                <span className="font-mono p-text-2">{j.kind}</span>
                <span className="p-text-3 truncate flex-1">{j.id.replace(/^bgjob-/, "").slice(0, 8)}</span>
                <span className="p-text-3 shrink-0">{j.status}</span>
              </div>
            ))}
          </div>
        )}
    </section>
  );
}

/* ── Curriculum (Voyager self-proposed tasks) ──────────────────── */

function CurriculumBlock({ rpc, onRunTask }: { rpc: Rpc; onRunTask: (t: string) => void }) {
  const [tasks, setTasks] = useState<ProposedTask[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    rpc<{ tasks: ProposedTask[] }>("listCurriculumTasks", []).then((r) => setTasks(r.tasks)).catch(() => setTasks([]));
  }, [rpc]);
  useEffect(() => { load(); }, [load]);

  const propose = useCallback(async () => {
    setBusy(true);
    try { await rpc("proposeCurriculumTasks", [5]); load(); } finally { setBusy(false); }
  }, [rpc, load]);

  const setStatus = useCallback(async (id: string, status: ProposedTask["status"]) => {
    await rpc("setCurriculumTaskStatus", [id, status]); load();
  }, [rpc, load]);

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <GraduationCapIcon size={16} className="p-accent" />
        <h2 className="text-sm font-semibold p-text">Curriculum</h2>
        {tasks && <Badge variant="secondary">{tasks.length}</Badge>}
        <Button size="sm" variant="secondary" className="ml-auto" disabled={busy} onClick={propose}
          icon={busy ? <Loader size="sm" /> : undefined}>Propose tasks</Button>
      </div>
      <p className="text-xs p-text-3 mb-3">Tasks the agent proposed for itself (Voyager-style) — predicted-success ≈ 0.5 is the ideal "barely succeeds" frontier. Accept &amp; run to grow its skills.</p>
      {tasks === null ? <div className="flex justify-center py-6"><Loader size="sm" /></div>
        : tasks.length === 0 ? <EmptyState icon={<GraduationCapIcon size={28} />} title="No proposed tasks" hint="Click “Propose tasks” to have the agent author its own next challenges." />
        : (
          <div className="space-y-2">
            {tasks.map((t) => (
              <div key={t.id} className="p-card rounded-lg p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm p-text mb-0.5">{t.task}</div>
                    <div className="text-[11px] p-text-3 line-clamp-2">{t.rationale}</div>
                    {t.targetsSkills.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {t.targetsSkills.map((s) => <span key={s} className="text-[10px] px-1.5 py-0.5 rounded-full p-elevated p-text-3">{s}</span>)}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className="text-[10px] p-text-3">p≈{(t.predictedSuccess * 100).toFixed(0)}%</span>
                    {t.status !== "pending" && <Badge variant="secondary">{t.status}</Badge>}
                  </div>
                </div>
                {t.status === "pending" && (
                  <div className="flex items-center gap-2 mt-2">
                    <Button size="sm" variant="primary" icon={<PlayIcon size={12} />}
                      onClick={() => { void setStatus(t.id, "accepted"); onRunTask(t.task); }}>Run</Button>
                    <Button size="sm" variant="ghost" icon={<CheckIcon size={12} />} onClick={() => setStatus(t.id, "accepted")}>Accept</Button>
                    <Button size="sm" variant="ghost" icon={<XIcon size={12} />} onClick={() => setStatus(t.id, "rejected")}>Reject</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
    </section>
  );
}

/* ── Run history ───────────────────────────────────────────────── */

function RunHistoryBlock({ rpc }: { rpc: Rpc }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  useEffect(() => { rpc<RunSummary[]>("getRunSummaries", [30]).then(setRuns).catch(() => setRuns([])); }, [rpc]);
  const totalTokens = (runs ?? []).reduce((s, r) => s + r.tokensIn + r.tokensOut, 0);
  const totalCached = (runs ?? []).reduce((s, r) => s + (r.tokensCached ?? 0), 0);
  // Cache hit-rate = cached input / total input (a proxy; cached is a subset of in).
  const totalIn = (runs ?? []).reduce((s, r) => s + r.tokensIn, 0);
  const hitRate = totalIn > 0 ? Math.round((totalCached / totalIn) * 100) : 0;
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <ClockIcon size={16} className="p-accent" />
        <h2 className="text-sm font-semibold p-text">Run history &amp; budget</h2>
        {runs && <Badge variant="secondary">{runs.length}</Badge>}
        <span className="ml-auto flex items-center gap-2">
          {totalCached > 0 && <span className="text-[11px] p-success" title="prompt-cache hit rate (cached input / total input)">{hitRate}% cached</span>}
          {totalTokens > 0 && <span className="text-[11px] p-text-3">{fmtTokens(totalTokens)} tokens</span>}
        </span>
      </div>
      {runs === null ? <div className="flex justify-center py-6"><Loader size="sm" /></div>
        : runs.length === 0 ? <p className="text-xs p-text-3">No recorded runs yet.</p>
        : (
          <div className="rounded-md border p-border overflow-hidden text-xs">
            {runs.map((r) => (
              <div key={r.runId} className="flex items-center gap-2 px-3 py-1.5 border-b p-border last:border-0">
                <span className={`size-1.5 rounded-full shrink-0 ${r.status === "completed" ? "p-dot-success" : r.status === "aborted" ? "p-dot-danger" : "p-dot-neutral"}`} />
                <span className="text-[10px] px-1 rounded p-elevated p-text-3 shrink-0">{r.causedBy ?? "chat"}</span>
                <span className="p-text-2 truncate flex-1" title={r.userMessage ?? r.runId}>{r.userMessage ?? r.runId}</span>
                {(r.tokensIn + r.tokensOut) > 0 && <span className="p-text-3 shrink-0 tabular-nums" title="tokens in+out">{fmtTokens(r.tokensIn + r.tokensOut)} tok</span>}
                <span className="p-text-3 shrink-0 tabular-nums">{new Date(r.startedAt).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        )}
    </section>
  );
}

/* ── Automations (triggers) — honest wired-vs-stub ─────────────── */

function AutomationsBlock({ rpc }: { rpc: Rpc }) {
  const [triggers, setTriggers] = useState<TriggerRow[] | null>(null);
  useEffect(() => { rpc<{ triggers: TriggerRow[] }>("listTriggers", []).then((r) => setTriggers(r.triggers ?? [])).catch(() => setTriggers([])); }, [rpc]);
  const active = (triggers ?? []).filter((t) => t.state === "active").length;
  const nextFire = (triggers ?? [])
    .map((t) => t.next_fire_at)
    .filter((ts): ts is number => typeof ts === "number" && ts > Date.now())
    .sort((a, b) => a - b)[0];
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <LightningIcon size={16} className="p-accent" />
        <h2 className="text-sm font-semibold p-text">Automations</h2>
        {triggers && <Badge variant="secondary">{active}/{triggers.length} active</Badge>}
        {nextFire && <span className="ml-auto text-[11px] p-text-3 tabular-nums">next {new Date(nextFire).toLocaleString()}</span>}
      </div>
      {triggers === null ? <div className="flex justify-center py-6"><Loader size="sm" /></div>
        : triggers.length === 0 ? <p className="text-xs p-text-3">No triggers registered.</p>
        : (
          <div className="rounded-md border p-border overflow-hidden text-xs">
            {triggers.map((t) => (
              <div key={t.id} className="flex items-center gap-2 px-3 py-1.5 border-b p-border last:border-0">
                <span className={`size-1.5 rounded-full shrink-0 ${t.state === "active" ? "p-dot-success" : "p-dot-neutral"}`} />
                <span className="font-mono p-text-2">{t.kind}</span>
                <span className="p-text-3 truncate flex-1">{t.id}</span>
                {typeof t.fire_count === "number" && t.fire_count > 0 && <span className="p-text-3 shrink-0 tabular-nums">{t.fire_count} fires</span>}
                <span className="p-text-3 shrink-0">{t.state}</span>
              </div>
            ))}
          </div>
        )}
    </section>
  );
}
