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
import { useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Button, Badge, Loader } from "@cloudflare/kumo";
import {
  GraduationCapIcon, ClockIcon, LightningIcon, PlayIcon, CheckIcon, XIcon,
  PlusIcon, TrashIcon, WarningIcon, PlugIcon,
} from "@phosphor-icons/react";
import { EmptyState } from "@/components/surfaces/shared";
import { CopyButton } from "@/components/ui/CopyButton";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { ScrollBoundary } from "@/components/ui/ScrollBoundary";
import { describeError, lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { usePagedScroll } from "@/hooks/use-paged-scroll";
import { useGrowingScroll } from "@/hooks/use-growing-scroll";
import { Modal } from "@/components/ui/Modal";
import { btnSmCls, inputCls } from "@/components/ui/form";
import { createDurableWebhook, cancelTrigger, type CreateWebhookResult } from "@/lib/user-api";
import type { Rpc } from "@/lib/protocol";
import { fmtTokens, fmtPct } from "@/lib/format";
import { addUsage, cacheHitRate, pageSchema, UsageSchema, usageTotal, type SeekCursor, type Usage } from "@proteus/core";
import * as v from "valibot";
import { renderThrownChain } from '@proteus/core/obs';

const ProposedTaskSchema = v.object({
  id: v.string(), task: v.string(), rationale: v.string(), predictedSuccess: v.number(),
  targetsSkills: v.array(v.string()), proposedAt: v.number(),
  status: v.picklist(["pending", "accepted", "rejected", "completed"]),
});
type ProposedTask = v.InferOutput<typeof ProposedTaskSchema>;

const RunSummarySchema = v.object({
  runId: v.string(), startedAt: v.number(), causedBy: v.nullable(v.string()),
  userMessage: v.nullable(v.string()), status: v.nullable(v.string()),
  usage: UsageSchema, turnsWithoutUsage: v.number(), eventCount: v.number(),
});

const TriggerRowSchema = v.object({
  id: v.string(),
  kind: v.string(),
  spec: v.optional(v.object({ label: v.optional(v.string()), cron: v.optional(v.string()) })),
  state: v.string(),
  created_at: v.number(),
  rate_limit_per_min: v.optional(v.number()),
  next_fire_at: v.optional(v.nullable(v.number())),
  last_fire_at: v.optional(v.nullable(v.number())),
  fire_count: v.optional(v.number()),
});
type TriggerRow = v.InferOutput<typeof TriggerRowSchema>;

const AuthModeSchema = v.picklist(["hmac", "bearer", "mtls"]);


export interface SupervisePageProps {
  rpc: Rpc;
  onRunTask: (task: string) => void;
}

/**
 * The background-jobs digest that used to close this page is gone. It was a
 * third rendering of one list — six rows and a "Manage in Jobs →" cross-link,
 * kept because the data was handy and because Jobs was hard to find. Jobs are
 * one glance in the RUN altitude's Work tab now, running beside the plan and
 * settled in the journal, so the crutch has nothing left to hold up.
 */
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
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await rpc("listCurriculumTasks", []);
    return v.parse(v.object({ tasks: v.array(ProposedTaskSchema) }), result).tasks;
  }, [rpc]);
  const { resource, reload } = useAsyncResource(load);
  const tasks = lastValue(resource);

  const propose = useCallback(async () => {
    setBusy(true);
    setActionErr(null);
    try { await rpc("proposeCurriculumTasks", [5]); reload(); }
    catch (e) { setActionErr(`Couldn't propose tasks: ${describeError(e)}`); }
    finally { setBusy(false); }
  }, [rpc, reload]);

  /** Resolves true only when the status write landed — "Run" starts a chat turn
   *  on the back of this, and must not do so for a task that stayed pending.
   *  The failure is reported here, so a caller that has nothing to add is not
   *  forced to silence a rejection. */
  const setStatus = useCallback(async (id: string, status: ProposedTask["status"]): Promise<boolean> => {
    setActionErr(null);
    try {
      await rpc("setCurriculumTaskStatus", [id, status]);
      reload();
      return true;
    } catch (e) {
      setActionErr(`Couldn't mark the task ${status}: ${describeError(e)}`);
      return false;
    }
  }, [rpc, reload]);

  return (
    <section>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <GraduationCapIcon size={16} className="p-accent" />
        <h2 className="text-sm font-semibold p-text">Curriculum</h2>
        {tasks && <Badge variant="secondary">{tasks.length}</Badge>}
        <Button size="sm" variant="secondary" className="ml-auto" disabled={busy} onClick={propose}
          icon={busy ? <Loader size="sm" /> : undefined}>Propose tasks</Button>
      </div>
      <p className="text-xs p-text-3 mb-3">Tasks the agent proposed for itself (Voyager-style). Predicted-success ≈ 0.5 is the ideal "barely succeeds" frontier. Accept &amp; run to grow its skills.</p>
      {actionErr && <div className="p-meta p-danger mb-2">{actionErr}</div>}
      {tasks === null ? (
        resource.status === "error"
          ? <LoadFailure what="the curriculum" message={resource.message} onRetry={reload} />
          : <div className="flex justify-center py-6"><Loader size="sm" /></div>
        )
        : tasks.length === 0 ? <EmptyState icon={<GraduationCapIcon size={28} />} title="No proposed tasks" hint="Click “Propose tasks” to have the agent author its own next challenges." />
        : (
          <div className="space-y-2">
            {tasks.map((t) => (
              <div key={t.id} className="p-card p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm p-text mb-0.5">{t.task}</div>
                    <div className="p-meta p-text-3 line-clamp-2">{t.rationale}</div>
                    {t.targetsSkills.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {t.targetsSkills.map((s) => <span key={s} className="p-meta px-1.5 py-0.5 rounded-full p-fill p-text-3">{s}</span>)}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className="p-meta p-text-3">p≈{(t.predictedSuccess * 100).toFixed(0)}%</span>
                    {t.status !== "pending" && <Badge variant="secondary">{t.status}</Badge>}
                  </div>
                </div>
                {t.status === "pending" && (
                  <div className="flex items-center gap-2 mt-2">
                    <button className={`p-btn ${btnSmCls}`}
                      onClick={() => void setStatus(t.id, "accepted").then((landed) => { if (landed) onRunTask(t.task); })}><PlayIcon size={12} />Run</button>
                    <Button size="sm" variant="ghost" icon={<CheckIcon size={12} />} onClick={() => void setStatus(t.id, "accepted")}>Accept</Button>
                    <Button size="sm" variant="ghost" icon={<XIcon size={12} />} onClick={() => void setStatus(t.id, "rejected")}>Reject</Button>
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

/** One page of the history. Each row costs a full read of that run's events to
 *  fold its provenance and usage, so the page is smaller than a list's. */
const RUN_HISTORY_PAGE = 30;

const RunPageSchema = pageSchema(RunSummarySchema);

/**
 * The cross-run history, and the budget folded over it.
 *
 * The totals here are the reason this read had to become cursored rather than
 * merely scroll further. They are summed over the runs ON SCREEN, and under a
 * bare `LIMIT 30` that made a thirty-run window read as the workspace's whole
 * spend. So the figures now say which runs they cover: bare when the walk has
 * reached the end, "so far" while there is more behind them. A number the owner
 * decides on must state its own denominator.
 */
function RunHistoryBlock({ rpc }: { rpc: Rpc }) {
  const load = useCallback(
    async () => v.parse(RunPageSchema, await rpc("getRunSummaries", [{ limit: RUN_HISTORY_PAGE }])),
    [rpc],
  );
  const { resource, reload } = useAsyncResource(load);
  const first = lastValue(resource);

  const fetchPage = useCallback(
    async (cursor: SeekCursor) => v.parse(
      RunPageSchema, await rpc("getRunSummaries", [{ cursor, limit: RUN_HISTORY_PAGE }]),
    ),
    [rpc],
  );
  // The first page's own `next`, never an anchor built here: this read's cursor
  // is opaque and only the server knows how to spell it.
  const startFrom = useCallback(
    () => (first !== null && first.status === "more" ? first.next : null),
    [first],
  );
  const tail = usePagedScroll<v.InferOutput<typeof RunSummarySchema>>({ grows: "down", fetchPage, startFrom });

  const runs = first === null ? null : [...first.items, ...tail.fetched];
  // A first page that already said 'end' is exhausted before the pager ever
  // runs, and the pager cannot know that.
  const exhausted = first !== null && (first.status === "end" || tail.exhausted);
  const containerRef = useGrowingScroll<HTMLDivElement>({
    grows: "down", content: runs, fetched: tail.fetched, onReachEdge: tail.loadMore,
  });

  const totalUsage = (runs ?? []).reduce<Usage>((acc, r) => addUsage(acc, r.usage), {});
  const totalTokens = usageTotal(totalUsage);
  // One definition of a cache hit, shared with the Activity surface. Null
  // unless input AND cache-read were both reported — an absent rate is not 0%.
  const hitRate = cacheHitRate(totalUsage);
  // The denominator for the totals above: runs the provider went quiet on.
  const silentRuns = (runs ?? []).filter((r) => r.turnsWithoutUsage > 0).length;
  const covers = exhausted ? "" : " so far";
  return (
    <section className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <ClockIcon size={16} className="p-accent" />
        <h2 className="text-sm font-semibold p-text">Run history &amp; budget</h2>
        {runs && <Badge variant="secondary">{exhausted ? `${runs.length}` : `${runs.length}+`}</Badge>}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {hitRate !== null && <span className="p-meta p-success" title={`prompt-cache hit rate (cache-read input / total input) over the ${runs?.length ?? 0} runs loaded`}>{fmtPct(hitRate)} cached{covers}</span>}
          {totalTokens !== undefined && <span className="p-meta p-text-3" title={exhausted ? "tokens in+out across every recorded run" : "tokens in+out across the runs loaded — scroll for more"}>{fmtTokens(totalTokens)} tokens{covers}</span>}
          {silentRuns > 0 && (
            <span className="p-meta p-text-3" title="These runs are not in the totals: their provider reported no usage, which is not the same as costing nothing.">
              {silentRuns} unreported
            </span>
          )}
        </span>
      </div>
      {runs === null ? (
        resource.status === "error"
          ? <LoadFailure what="the run history" message={resource.message} onRetry={reload} />
          : <div className="flex justify-center py-6"><Loader size="sm" /></div>
        )
        : runs.length === 0 ? <p className="text-xs p-text-3">No recorded runs yet.</p>
        : (
          <div ref={containerRef} className="max-h-[28rem] overflow-y-auto rounded-md border p-border text-xs">
            {runs.map((r) => {
              const tokens = usageTotal(r.usage);
              return (
                <div key={r.runId} className="flex items-center gap-2 px-3 py-1.5 border-b p-border">
                  <span className={`size-1.5 rounded-full shrink-0 ${r.status === "completed" ? "p-dot-success" : r.status === "aborted" ? "p-dot-danger" : "p-dot-neutral"}`} />
                  <span className="p-meta px-1 rounded-sm p-fill p-text-3 shrink-0">{r.causedBy ?? "chat"}</span>
                  <span className="p-text-2 truncate flex-1" title={r.userMessage ?? r.runId}>{r.userMessage ?? r.runId}</span>
                  <span className="p-text-3 shrink-0 tabular-nums"
                    title={tokens === undefined
                      ? `no usage reported — ${r.turnsWithoutUsage} turn${r.turnsWithoutUsage === 1 ? "" : "s"} ended without the provider counting anything`
                      : "tokens in+out"}>{fmtTokens(tokens)} tok</span>
                  <span className="p-text-3 shrink-0 tabular-nums">{new Date(r.startedAt).toLocaleDateString()}</span>
                </div>
              );
            })}
            <ScrollBoundary what="runs" count={runs.length}
              loading={tail.loading} exhausted={exhausted} error={tail.error} onRetry={tail.loadMore} />
          </div>
        )}
    </section>
  );
}

/* ── Automations — THE trigger surface: list + create + revoke ─── */

function AutomationsBlock({ rpc }: { rpc: Rpc }) {
  const { agentId } = useParams();
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<CreateWebhookResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await rpc("listTriggers", []);
    return v.parse(v.object({ triggers: v.array(TriggerRowSchema) }), result).triggers;
  }, [rpc]);
  const { resource, reload } = useAsyncResource(load);
  const triggers = lastValue(resource);

  const revoke = useCallback(async (triggerId: string) => {
    if (!agentId) return;
    if (!confirm("Revoke this trigger? The URL stops working immediately.")) return;
    setErr(null);
    try { await cancelTrigger(agentId, triggerId); } catch (e) { setErr(renderThrownChain({ cause: e })); }
    reload();
  }, [agentId, reload]);

  const active = (triggers ?? []).filter((t) => t.state === "active").length;
  const nextFire = (triggers ?? [])
    .map((t) => t.next_fire_at)
    .filter((ts): ts is number => ts !== undefined && ts !== null && ts > Date.now())
    .sort((a, b) => a - b)[0];
  return (
    <section className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <LightningIcon size={16} className="p-accent" />
        <h2 className="text-sm font-semibold p-text">Automations</h2>
        {triggers && <Badge variant="secondary">{active}/{triggers.length} active</Badge>}
        {nextFire && <span className="p-meta p-text-3 tabular-nums">next {new Date(nextFire).toLocaleString()}</span>}
        <Button size="sm" variant="secondary" className="ml-auto" icon={<PlusIcon size={12} />}
          onClick={() => { setShowCreate(true); setCreated(null); }}>New webhook</Button>
      </div>
      <p className="text-xs p-text-3 mb-3">External systems that can wake this agent: webhooks (GitHub, Stripe, your CI) and timers.</p>
      {err && <div className="text-xs p-danger mb-2">{err}</div>}
      {created && <NewWebhookCard result={created} onDismiss={() => setCreated(null)} />}
      {triggers === null ? (
        resource.status === "error"
          ? <LoadFailure what="automations" message={resource.message} onRetry={reload} />
          : <div className="flex justify-center py-6"><Loader size="sm" /></div>
        )
        : triggers.length === 0 ? <p className="text-xs p-text-3">No triggers registered. Create a webhook to let external systems wake this agent.</p>
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
          onCreated={(r) => { setCreated(r); setShowCreate(false); reload(); }}
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
  const spec = trigger.spec ?? {};
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b p-border last:border-0">
      <span className={`size-1.5 rounded-full shrink-0 ${trigger.state === "active" ? "p-dot-success" : trigger.state === "paused" ? "p-dot-warning" : "p-dot-neutral"}`} />
      <span className="font-medium p-text-2 truncate max-w-40" title={spec.label ?? trigger.id}>{spec.label ?? trigger.id}</span>
      <span className="font-mono p-text-3 shrink-0">{trigger.kind}</span>
      {spec.cron && <code className="p-fill px-1 rounded-sm p-text-3 shrink-0">{spec.cron}</code>}
      <span className="flex-1" />
      {trigger.fire_count !== undefined && trigger.fire_count > 0 && <span className="p-text-3 shrink-0 tabular-nums">{trigger.fire_count} fires</span>}
      <span className="p-text-3 shrink-0">{trigger.state}</span>
      {url && (
        <CopyButton value={url} what="the webhook URL" size={11}
          className="p-1 rounded-sm p-card-hover p-text-3 shrink-0" />
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
    <div className="p-card p-5 space-y-3 border p-border mb-3">
      <div className="flex items-center gap-2">
        <CheckIcon size={16} className="p-success" />
        <span className="text-sm font-semibold">Webhook created</span>
        <button className="ml-auto text-xs p-text-3 hover:p-text" onClick={onDismiss}>Dismiss</button>
      </div>
      <p className="text-xs p-text-2">
        Save the secret now: it's shown only once. The URL is permanent until you revoke the trigger.
      </p>
      <div className="space-y-2">
        <div>
          <div className="p-eyebrow mb-1">URL</div>
          <div className="flex items-center gap-2">
            <code className="text-xs p-fill px-2 py-1.5 rounded-sm font-mono flex-1 break-all">{url}</code>
            <CopyButton value={url} what="the webhook URL" className="p-2 rounded-sm p-card p-card-hover" />
          </div>
        </div>
        {result.secret && (
          <div>
            <div className="p-eyebrow mb-1">Secret <span className="p-danger">(shown once)</span></div>
            <div className="flex items-center gap-2">
              <code className="text-xs p-fill px-2 py-1.5 rounded-sm font-mono flex-1 break-all">{result.secret}</code>
              <CopyButton value={result.secret} what="the secret" className="p-2 rounded-sm p-card p-card-hover" />
            </div>
          </div>
        )}
        <div>
          <div className="p-eyebrow mb-1">Test with curl</div>
          <pre className="p-meta p-fill p-3 rounded-sm font-mono overflow-x-auto whitespace-pre">{curlSnippet}</pre>
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
      const msg = renderThrownChain({ cause: e });
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
      busy={submitting}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
        <button className={`p-btn ${btnSmCls}`} onClick={submit} disabled={submitting || !label.trim()}>
          {submitting ? <><Loader size="sm" /><span className="ml-1">Creating…</span></> : "Create"}
        </button>
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
          <select value={authMode} onChange={(e) => setAuthMode(v.parse(AuthModeSchema, e.target.value))} className={inputCls}>
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
      <p className="p-meta p-text-3 flex items-start gap-1.5">
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
