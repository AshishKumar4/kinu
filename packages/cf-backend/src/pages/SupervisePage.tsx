/**
 * Supervise altitude — the agent over time (automation + research operations),
 * distinct from the per-run RUN altitude. One scrollable canvas of blocks, each
 * bound to wired RPCs. Timers and webhooks are active; speculative trigger
 * kinds stay represented in durable state until their operator flows are added.
 *
 * Blocks: Curriculum (Voyager self-proposed tasks — fully actionable),
 * Run history (cross-run list), Automations (the ONE trigger surface:
 * list + create webhooks + revoke), Fork lineage.
 */
import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Button, Badge, Loader } from "@cloudflare/kumo";
import {
  GraduationCapIcon, ClockIcon, LightningIcon, PlayIcon, CheckIcon, XIcon,
  PlusIcon, TrashIcon, CopyIcon, WarningIcon, PlugIcon,
} from "@phosphor-icons/react";
import { EmptyState } from "@/components/surfaces/shared";
import { Modal } from "@/components/ui/Modal";
import { inputCls } from "@/components/ui/form";
import { createDurableWebhook, cancelTrigger, type CreateWebhookResult } from "@/lib/user-api";
import type { Rpc, BackgroundJob } from "@/lib/protocol";

interface ProposedTask { id: string; task: string; rationale: string; predictedSuccess: number; targetsSkills: string[]; proposedAt: number; status: "pending" | "accepted" | "rejected" | "completed" }
interface RunSummary { runId: string; startedAt: number; causedBy: string | null; userMessage: string | null; status: string | null; tokensIn: number; tokensOut: number; tokensCached: number; eventCount: number }
interface TriggerRow {
  id: string;
  kind: string;
  spec?: Record<string, unknown>;
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

/* ── Automations — THE trigger surface: list + create + revoke ─── */

function AutomationsBlock({ rpc }: { rpc: Rpc }) {
  const { agentId } = useParams();
  const [triggers, setTriggers] = useState<TriggerRow[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<CreateWebhookResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    rpc<{ triggers: TriggerRow[] }>("listTriggers", []).then((r) => setTriggers(r.triggers ?? [])).catch(() => setTriggers([]));
  }, [rpc]);
  useEffect(() => { load(); }, [load]);

  const revoke = useCallback(async (triggerId: string) => {
    if (!agentId) return;
    if (!confirm("Revoke this trigger? The URL stops working immediately.")) return;
    setErr(null);
    try { await cancelTrigger(agentId, triggerId); } catch (e) { setErr((e as Error).message); }
    load();
  }, [agentId, load]);

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
        {nextFire && <span className="text-[11px] p-text-3 tabular-nums">next {new Date(nextFire).toLocaleString()}</span>}
        <Button size="sm" variant="secondary" className="ml-auto" icon={<PlusIcon size={12} />}
          onClick={() => { setShowCreate(true); setCreated(null); }}>New webhook</Button>
      </div>
      <p className="text-xs p-text-3 mb-3">External systems that can wake this agent — webhooks (GitHub, Stripe, your CI) and timers.</p>
      {err && <div className="text-xs p-danger mb-2">{err}</div>}
      {created && <NewWebhookCard result={created} onDismiss={() => setCreated(null)} />}
      {triggers === null ? <div className="flex justify-center py-6"><Loader size="sm" /></div>
        : triggers.length === 0 ? <p className="text-xs p-text-3">No triggers registered — create a webhook to let external systems wake this agent.</p>
        : (
          <div className="rounded-md border p-border overflow-hidden text-xs">
            {triggers.map((t) => (
              <TriggerLine key={t.id} trigger={t} agentName={agentId ?? ""} onRevoke={() => revoke(t.id)} />
            ))}
          </div>
        )}
      {showCreate && agentId && (
        <CreateWebhookModal
          agentName={agentId}
          onClose={() => setShowCreate(false)}
          onCreated={(r) => { setCreated(r); setShowCreate(false); load(); }}
        />
      )}
    </section>
  );
}

function TriggerLine({ trigger, agentName, onRevoke }: {
  trigger: TriggerRow; agentName: string; onRevoke: () => void;
}) {
  const isWebhook = trigger.kind === "webhook_durable" || trigger.kind === "webhook_ephemeral";
  const url = isWebhook && agentName
    ? `${window.location.origin}/api/workspaces/${encodeURIComponent(agentName)}/webhook/${encodeURIComponent(trigger.id)}`
    : null;
  const spec = (trigger.spec ?? {}) as { label?: string; cron?: string };
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b p-border last:border-0">
      <span className={`size-1.5 rounded-full shrink-0 ${trigger.state === "active" ? "p-dot-success" : trigger.state === "paused" ? "p-dot-warning" : "p-dot-neutral"}`} />
      <span className="font-medium p-text-2 truncate max-w-40" title={spec.label ?? trigger.id}>{spec.label ?? trigger.id}</span>
      <span className="font-mono p-text-3 shrink-0">{trigger.kind}</span>
      {spec.cron && <code className="p-elevated px-1 rounded p-text-3 shrink-0">{spec.cron}</code>}
      <span className="flex-1" />
      {typeof trigger.fire_count === "number" && trigger.fire_count > 0 && <span className="p-text-3 shrink-0 tabular-nums">{trigger.fire_count} fires</span>}
      <span className="p-text-3 shrink-0">{trigger.state}</span>
      {url && (
        <button className="p-1 rounded hover:p-card-hover p-text-3 shrink-0" title="Copy webhook URL"
          onClick={() => navigator.clipboard.writeText(url)}><CopyIcon size={11} /></button>
      )}
      <button
        onClick={onRevoke}
        disabled={trigger.state === "revoked"}
        className="p-text-3 hover:p-danger disabled:opacity-30 p-1 shrink-0"
        title="Revoke"
      ><TrashIcon size={11} /></button>
    </div>
  );
}

/* Newly-created webhook — the URL + secret shown ONCE, with a curl test. */
function NewWebhookCard({ result, onDismiss }: {
  result: CreateWebhookResult; onDismiss: () => void;
}) {
  const url = `${window.location.origin}${result.url}`;
  const curlSnippet = result.auth_mode === "hmac"
    ? `# HMAC test (compute SIGNATURE = HMAC-SHA256 of "<ts>.<body>")
TS=$(date +%s)
BODY='{"hello":"world"}'
SIG=$(printf "%s.%s" "$TS" "$BODY" | openssl dgst -sha256 -hmac "${result.secret ?? "<your-secret>"}" -hex | cut -d' ' -f2)
curl -X POST '${url}' \\
  -H "x-proteus-timestamp: $TS" \\
  -H "x-proteus-signature: $SIG" \\
  -H "content-type: application/json" \\
  -d "$BODY"`
    : result.auth_mode === "bearer"
    ? `curl -X POST '${url}' \\
  -H "Authorization: Bearer ${result.secret ?? "<your-secret>"}" \\
  -H "content-type: application/json" \\
  -d '{"hello":"world"}'`
    : `# mTLS — present your client certificate via your HTTP client
curl -X POST '${url}' --cert client.pem --key client.key \\
  -H "content-type: application/json" -d '{"hello":"world"}'`;

  return (
    <div className="p-card rounded-xl p-5 space-y-3 border p-border mb-3">
      <div className="flex items-center gap-2">
        <CheckIcon size={16} className="p-success" />
        <span className="text-sm font-semibold">Webhook created</span>
        <button className="ml-auto text-xs p-text-3 hover:p-text" onClick={onDismiss}>Dismiss</button>
      </div>
      <p className="text-xs p-text-2">
        Save the secret now — it's shown only once. The URL is permanent until you revoke the trigger.
      </p>
      <div className="space-y-2">
        <div>
          <div className="text-[10px] p-text-3 mb-1">URL</div>
          <div className="flex items-center gap-2">
            <code className="text-xs p-elevated px-2 py-1.5 rounded font-mono flex-1 break-all">{url}</code>
            <button className="p-2 rounded p-card hover:p-card-hover" onClick={() => navigator.clipboard.writeText(url)}>
              <CopyIcon size={12} />
            </button>
          </div>
        </div>
        {result.secret && (
          <div>
            <div className="text-[10px] p-text-3 mb-1">Secret <span className="p-danger">(shown once)</span></div>
            <div className="flex items-center gap-2">
              <code className="text-xs p-elevated px-2 py-1.5 rounded font-mono flex-1 break-all">{result.secret}</code>
              <button className="p-2 rounded p-card hover:p-card-hover" onClick={() => navigator.clipboard.writeText(result.secret ?? "")}>
                <CopyIcon size={12} />
              </button>
            </div>
          </div>
        )}
        <div>
          <div className="text-[10px] p-text-3 mb-1">Test with curl</div>
          <pre className="text-[11px] p-elevated p-3 rounded font-mono overflow-x-auto whitespace-pre">{curlSnippet}</pre>
        </div>
      </div>
    </div>
  );
}

/* Step-up auth: creating a durable webhook requires a fresh Proteus browser
 * session (≤5 min since login). On the step-up 401 we send the user through
 * Proteus login and return here. */
function CreateWebhookModal({ agentName, onClose, onCreated }: {
  agentName: string;
  onClose: () => void;
  onCreated: (r: CreateWebhookResult) => void;
}) {
  const [label, setLabel] = useState("");
  const [authMode, setAuthMode] = useState<"hmac" | "bearer" | "mtls">("hmac");
  const [secret, setSecret] = useState("");
  const [contentType, setContentType] = useState("application/json");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!label.trim()) { setErr("label required"); return; }
    setSubmitting(true); setErr(null);
    try {
      const secretToUse = secret.trim() || autoGenSecret(authMode);
      const r = await createDurableWebhook(agentName, {
        label: label.trim(),
        auth_mode: authMode,
        secret: authMode === "mtls" ? undefined : secretToUse,
        accepted_content_type: contentType.trim() || "application/json",
      });
      onCreated(r);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("step-up")) {
        if (confirm("A fresh login is required to create webhook URLs. Redirect to sign in?")) {
          const login = new URL("/login", window.location.origin);
          login.searchParams.set("prompt", "login");
          login.searchParams.set("return_to", window.location.pathname + window.location.search);
          window.location.href = login.toString();
        }
      } else {
        setErr(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }, [agentName, label, authMode, secret, contentType, onCreated]);

  return (
    <Modal
      title="Create durable webhook"
      icon={<PlugIcon size={16} className="p-accent" />}
      onClose={onClose}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button size="sm" variant="primary" onClick={submit} disabled={submitting || !label.trim()}>
          {submitting ? <><Loader size="sm" /><span className="ml-1">Creating…</span></> : "Create"}
        </Button>
      </>}
    >
      <div className="space-y-2">
        <label className="block">
          <div className="text-xs p-text-2 mb-1">Label</div>
          <input value={label} onChange={(e) => setLabel(e.target.value)} className={inputCls}
            placeholder="github-pr-events" />
        </label>
        <label className="block">
          <div className="text-xs p-text-2 mb-1">Auth mode</div>
          <select value={authMode} onChange={(e) => setAuthMode(e.target.value as "hmac" | "bearer" | "mtls")} className={inputCls}>
            <option value="hmac">HMAC (signed body)</option>
            <option value="bearer">Bearer token (Authorization header)</option>
            <option value="mtls">mTLS (client certificate)</option>
          </select>
        </label>
        {authMode !== "mtls" && (
          <label className="block">
            <div className="text-xs p-text-2 mb-1">Secret <span className="p-text-3">(blank = auto-generate)</span></div>
            <input value={secret} onChange={(e) => setSecret(e.target.value)} className={inputCls} placeholder="leave blank to auto-generate" />
          </label>
        )}
        <label className="block">
          <div className="text-xs p-text-2 mb-1">Accepted content type</div>
          <input value={contentType} onChange={(e) => setContentType(e.target.value)} className={inputCls} placeholder="application/json" />
        </label>
      </div>
      {err && <div className="text-xs p-danger">{err}</div>}
      <p className="text-[10px] p-text-3 flex items-start gap-1.5">
        <WarningIcon size={11} className="mt-0.5 shrink-0" />
        <span>Webhook creation requires a recent login (within 5 minutes). If it fails, you'll be prompted to sign in again.</span>
      </p>
    </Modal>
  );
}

function autoGenSecret(authMode: "hmac" | "bearer" | "mtls"): string {
  if (authMode === "mtls") return "";
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
