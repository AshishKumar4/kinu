/**
 * Supervise altitude — the agent over time (automation + research operations),
 * distinct from the per-run RUN altitude. One scrollable canvas of blocks, each
 * bound to a wired RPC. Honest about wired-vs-stub: the event reactor is not yet
 * live, so triggers are shown read-only with that stated plainly.
 *
 * Blocks: Curriculum (Voyager self-proposed tasks — fully actionable),
 * Run history (cross-run list), Automations (triggers + honest reactor state),
 * Fork lineage.
 */
import { useState, useEffect, useCallback } from "react";
import { Button, Badge, Loader } from "@cloudflare/kumo";
import {
  GraduationCapIcon, ClockIcon, LightningIcon, PlayIcon, CheckIcon, XIcon, WarningIcon,
} from "@phosphor-icons/react";
import { EmptyState } from "@/components/surfaces/shared";
import type { Rpc } from "@/lib/protocol";

interface ProposedTask { id: string; task: string; rationale: string; predictedSuccess: number; targetsSkills: string[]; proposedAt: number; status: "pending" | "accepted" | "rejected" | "completed" }
interface RunRow { runId: string; lastTs: string; eventCount: number }
interface TriggerRow { id: string; kind: string; state: string; created_at: number; rate_limit_per_min?: number }

export interface SupervisePageProps {
  rpc: Rpc;
  onRunTask: (task: string) => void;
}

export function SupervisePage({ rpc, onRunTask }: SupervisePageProps) {
  return (
    <div className="h-full overflow-y-auto px-6 py-5 lg:px-10 max-w-5xl mx-auto space-y-8">
      <CurriculumBlock rpc={rpc} onRunTask={onRunTask} />
      <div className="grid md:grid-cols-2 gap-8">
        <RunHistoryBlock rpc={rpc} />
        <AutomationsBlock rpc={rpc} />
      </div>
    </div>
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
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  useEffect(() => { rpc<RunRow[]>("listRuns", [50]).then(setRuns).catch(() => setRuns([])); }, [rpc]);
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <ClockIcon size={16} className="p-accent" />
        <h2 className="text-sm font-semibold p-text">Run history</h2>
        {runs && <Badge variant="secondary">{runs.length}</Badge>}
      </div>
      {runs === null ? <div className="flex justify-center py-6"><Loader size="sm" /></div>
        : runs.length === 0 ? <p className="text-xs p-text-3">No recorded runs yet.</p>
        : (
          <div className="rounded-md border p-border overflow-hidden text-xs">
            {runs.map((r) => (
              <div key={r.runId} className="flex items-center gap-2 px-3 py-1.5 border-b p-border last:border-0">
                <span className="font-mono p-text-2 truncate flex-1">{r.runId}</span>
                <span className="p-text-3 shrink-0">{r.eventCount} events</span>
                <span className="p-text-3 shrink-0 tabular-nums">{new Date(r.lastTs).toLocaleString()}</span>
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
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <LightningIcon size={16} className="p-accent" />
        <h2 className="text-sm font-semibold p-text">Automations</h2>
        {triggers && <Badge variant="secondary">{triggers.length}</Badge>}
      </div>
      <div className="flex items-start gap-2 text-[11px] p-text-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 mb-3">
        <WarningIcon size={13} className="text-amber-400 mt-0.5 shrink-0" />
        <span>The event reactor isn't wired into live turns yet — triggers are registered but don't auto-drive runs. Only webhooks are creatable today; timer/watch/peer/mcp triggers + reactor activation are in progress.</span>
      </div>
      {triggers === null ? <div className="flex justify-center py-6"><Loader size="sm" /></div>
        : triggers.length === 0 ? <p className="text-xs p-text-3">No triggers registered.</p>
        : (
          <div className="rounded-md border p-border overflow-hidden text-xs">
            {triggers.map((t) => (
              <div key={t.id} className="flex items-center gap-2 px-3 py-1.5 border-b p-border last:border-0">
                <span className={`size-1.5 rounded-full shrink-0 ${t.state === "active" ? "bg-emerald-500" : "bg-zinc-500"}`} />
                <span className="font-mono p-text-2">{t.kind}</span>
                <span className="p-text-3 truncate flex-1">{t.id}</span>
                <span className="p-text-3 shrink-0">{t.state}</span>
              </div>
            ))}
          </div>
        )}
    </section>
  );
}
