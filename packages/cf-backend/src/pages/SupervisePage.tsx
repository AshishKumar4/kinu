/**
 * Supervise altitude — the agent over time (automation + run history), distinct
 * from the per-run RUN altitude. One column of blocks, each bound to wired
 * RPCs. Timers and webhooks are active; speculative trigger kinds stay
 * represented in durable state until their operator flows are added.
 *
 * Blocks, in reading order: Automations (the ONE trigger surface: list +
 * create webhooks + revoke, plus the background jobs those and the operator
 * leave running), Run history, and Evolution — which renders only when the
 * changelog records a self-change: a scaffold edit, a kept lesson, a promoted
 * proposal. A window that closed with nothing to show renders nothing.
 */
import { useState, useCallback, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { Button, Badge, Loader } from "@cloudflare/kumo";
import { FilledButton } from "@/components/ui/FilledButton";
import {
  ClockIcon, LightningIcon, CheckIcon,
  PlusIcon, TrashIcon, WarningIcon, PlugIcon,
} from "@phosphor-icons/react";
import { CopyButton } from "@/components/ui/CopyButton";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { ScrollBoundary } from "@/components/ui/ScrollBoundary";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { usePagedScroll } from "@/hooks/use-paged-scroll";
import { useGrowingScroll } from "@/hooks/use-growing-scroll";
import { SECRET_REGION, SecretValue } from "@/components/ui/SecretValue";
import { changelogRevalidate } from "@/components/surfaces/changelog-entries";
import { EvolutionEntrySchema, EvolutionSection } from "@/components/surfaces/supervise-evolution";
import { Modal } from "@/components/ui/Modal";
import { inputCls } from "@/components/ui/form";
import { createDurableWebhook, cancelTrigger, type CreateWebhookResult } from "@/lib/user-api";
import type { Rpc } from "@kinu.run/core";
import { fmtTokens } from "@kinu.run/core";
import { pageSchema, UsageSchema, usageTotal, type SeekCursor } from "@kinu.run/core";
import * as v from "valibot";
import { renderThrownChain } from '@kinu.run/core/obs';

const RunSummarySchema = v.object({
  runId: v.string(), startedAt: v.number(), causedBy: v.nullable(v.string()),
  userMessage: v.nullable(v.string()), status: v.nullable(v.string()),
  usage: UsageSchema, turnsWithoutUsage: v.number(), eventCount: v.number(),
});

const JobRowSchema = v.object({
  id: v.string(), kind: v.string(), label: v.nullable(v.string()),
  status: v.string(), createdAt: v.number(), settledAt: v.nullable(v.number()),
});

const TriggerRowSchema = v.object({
  id: v.string(),
  kind: v.string(),
  /** Signed delivery path, minted by the server for webhook rows. Absent when
   *  the row is not a webhook, or when the deployment cannot sign one. */
  url: v.optional(v.string()),
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
}

/**
 * Automations first — what wakes this agent and what it has running — with the
 * run history directly under it. Evolution follows, and only when it exists:
 * the card mounts nothing until the changelog says there is a change to show.
 */
export function SupervisePage({ rpc }: SupervisePageProps) {
  return (
    <div className="h-full overflow-y-auto px-6 py-6 lg:px-8">
      <div className="mx-auto flex max-w-[1380px] flex-col gap-[18px]">
        <SuperviseCard><AutomationsBlock rpc={rpc} /></SuperviseCard>
        <SuperviseCard><RunHistoryBlock rpc={rpc} /></SuperviseCard>
        <EvolutionCard rpc={rpc} />
      </div>
    </div>
  );
}



/** One cell of the supervise layout: the outer card. */
function SuperviseCard({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-[14px] border p-border p-surface p-5">
      {children}
    </div>
  );
}

/* ── Evolution — only when the changelog records a change ──────── */

/** Reads the changelog and mounts the section only when it carries a change.
 *  `changesOnly` is decided inside the digest read — selection before limit —
 *  so a page of fresh bookkeeping cannot hide an older change. The changelog's
 *  own revalidation keeps the card live: a workspace that evolves after this
 *  view opened still earns the section. A failed read still gets the card — a
 *  broken digest must never pose as "no evolution". */
function EvolutionCard({ rpc }: { rpc: Rpc }) {
  const load = useCallback(
    async () => v.parse(
      v.object({ entries: v.array(EvolutionEntrySchema) }),
      await rpc("getEvolutionChangelog", [{ limit: 8, changesOnly: true }]),
    ).entries,
    [rpc],
  );

  const { resource, reload } = useAsyncResource(load, changelogRevalidate);
  const entries = lastValue(resource);

  // One failure policy for both reads on this page: a failed refresh is
  // reported above whatever last-good rows remain, and a failed first read
  // still gets the card — a broken digest must never pose as "no evolution".
  if (resource.status === "error") {
    return (
      <SuperviseCard>
        <LoadFailure what="the evolution digest" message={resource.message} onRetry={reload} />
        {entries !== null && entries.length > 0 && <EvolutionSection entries={entries} />}
      </SuperviseCard>
    );
  }

  if (entries === null || entries.length === 0) return null;

  return <SuperviseCard><EvolutionSection entries={entries} /></SuperviseCard>;
}

/* ── Run history ───────────────────────────────────────────────── */

/** One page of the history. Each row costs a full read of that run's events to
 *  fold its provenance and usage, so the page is smaller than a list's. */
const RUN_HISTORY_PAGE = 30;

const RunPageSchema = pageSchema(RunSummarySchema);

/** The cross-run history, newest first. Totals that a spend decision needs
 *  live on the Activity surface; this header names the list and its size. */
function RunHistoryBlock({ rpc }: { rpc: Rpc }) {
  const load = useCallback(
    async () => v.parse(RunPageSchema, await rpc("getRunSummaries", [{ limit: RUN_HISTORY_PAGE }])),
    [rpc],
  );

  const { resource, reload } = useAsyncResource(load);
  const first = lastValue(resource);

  const fetchPage = useCallback(
    async (cursor: SeekCursor | undefined) => v.parse(
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

  return (
    <section className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <ClockIcon size={16} className="p-accent" />
        <h2 className="text-sm font-semibold p-text">Run history</h2>
        {runs && <Badge variant="secondary">{exhausted ? `${runs.length}` : `${runs.length}+`}</Badge>}
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
                      ? `provider reported no usage for ${r.turnsWithoutUsage} turn${r.turnsWithoutUsage === 1 ? "" : "s"}`
                      : "input and output tokens"}>{fmtTokens(tokens)} tok</span>
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

/* ── Automations — triggers that wake the agent + what it has running ── */

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

  const loadJobs = useCallback(
    async () => v.parse(v.array(JobRowSchema), await rpc("listBackgroundJobs", [10])),
    [rpc],
  );

  const { resource: jobsResource, reload: reloadJobs } = useAsyncResource(loadJobs, changelogRevalidate);
  const jobs = lastValue(jobsResource);

  const revoke = useCallback(async (triggerId: string) => {
    if (!agentId) return;

    if (!confirm("Revoke this trigger? Its URL will stop working.")) return;
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
      <p className="text-xs p-text-3 mb-3">Webhooks, timers and background jobs — what wakes this agent and what it has running.</p>
      {err && <div className="text-xs p-danger mb-2">{err}</div>}
      {created && <NewWebhookCard result={created} onDismiss={() => setCreated(null)} />}
      {triggers === null ? (
        resource.status === "error"
          ? <LoadFailure what="automations" message={resource.message} onRetry={reload} />
          : <div className="flex justify-center py-6"><Loader size="sm" /></div>
        )
        : triggers.length === 0 ? <p className="text-xs p-text-3">No triggers. Create a webhook to wake this agent from another system.</p>
        : (
          <div className="rounded-md border p-border overflow-hidden text-xs">
            {triggers.map((t) => (
              <TriggerLine key={t.id} trigger={t} onRevoke={() => revoke(t.id)} />
            ))}
          </div>
        )}

      {/* A failed jobs read is reported, never dropped into the trigger list's
          silence — and last-good rows stay up behind the failure notice. */}
      {jobsResource.status === "error" && (
        <LoadFailure what="the background jobs" message={jobsResource.message} onRetry={reloadJobs} />
      )}

      {jobsResource.status === "loading" && (
        <div className="flex justify-center py-4"><Loader size="sm" /></div>
      )}

      {jobs !== null && jobs.length > 0 && (
        <div className="mt-3">
          <div className="p-eyebrow p-text-4 mb-1.5">Background jobs</div>
          <div className="rounded-md border p-border overflow-hidden text-xs">
            {jobs.map((job) => (
              <div key={job.id} className="flex items-center gap-2 px-3 py-1.5 border-b p-border last:border-0">
                <span className={`size-1.5 rounded-full shrink-0 ${job.status === "running" ? "p-dot-warning" : job.status === "completed" ? "p-dot-success" : job.status === "failed" ? "p-dot-danger" : "p-dot-neutral"}`} />
                <span className="font-medium p-text-2 truncate" title={job.label ?? job.id}>{job.label ?? job.id}</span>
                <span className="font-mono p-text-3 shrink-0">{job.kind}</span>
                <span className="flex-1" />
                <span className="p-text-3 shrink-0">{job.status}</span>
                <span className="p-text-3 shrink-0 tabular-nums">{new Date(job.settledAt ?? job.createdAt).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
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

/** One trigger row. The delivery URL is the server's, never assembled here: it
 *  carries a signed route capability, so a URL this page built would 404. */
function TriggerLine({ trigger, onRevoke }: {
  trigger: TriggerRow; onRevoke: () => void;
}) {
  const isWebhook = trigger.kind === "webhook_durable" || trigger.kind === "webhook_ephemeral";
  const url = trigger.url ? `${window.location.origin}${trigger.url}` : null;
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
      {url ? (
        <CopyButton value={url} what="the webhook URL" size={11}
          className="p-1 rounded-sm p-card-hover p-text-3 shrink-0" />
      ) : isWebhook ? (
        <span className="p-text-3 shrink-0"
          title="Set WEBHOOK_ROUTE_SECRET on this deployment to deliver webhooks.">
          no URL
        </span>
      ) : null}
      <button
        onClick={onRevoke}
        disabled={trigger.state === "revoked"}
        className="p-text-3 hover:p-danger disabled:opacity-30 p-1 shrink-0"
        title="Revoke"
      ><TrashIcon size={11} /></button>
    </div>
  );
}

/**
 * The curl that tests a new webhook, SPLIT AT THE CREDENTIAL.
 *
 * A template string cannot carry the screenshot's redaction marker, so a secret
 * interpolated into one is a secret in the PNG. Splitting the command is what
 * lets the credential render through `SecretValue` and nothing else.
 *
 * `secret` is the real credential or null: mTLS presents a client certificate
 * and carries none, and a mode whose secret was somehow not returned reads with
 * a placeholder, which belongs in the literal text because it is not a secret.
 */
interface CurlCommand {
  readonly before: string;
  readonly secret: string | null;
  readonly after: string;
}

function curlCommand(url: string, result: CreateWebhookResult): CurlCommand {
  // Empty whenever the credential is real, because the credential is then
  // rendered as its own redacted region rather than as text in this string.
  const placeholder = result.secret === null ? "<your-secret>" : "";

  switch (result.auth_mode) {
    case "hmac": return {
      before: `# HMAC test (compute SIGNATURE = HMAC-SHA256 of "<ts>.<body>")
TS=$(date +%s)
BODY='{"hello":"world"}'
SIG=$(printf "%s.%s" "$TS" "$BODY" | openssl dgst -sha256 -hmac "${placeholder}`,
      secret: result.secret,
      after: `" -hex | cut -d' ' -f2)
curl -X POST '${url}' \\
  -H "x-kinu-timestamp: $TS" \\
  -H "x-kinu-signature: $SIG" \\
  -H "content-type: application/json" \\
  -d "$BODY"`,
    };
    case "bearer": return {
      before: `curl -X POST '${url}' \\
  -H "Authorization: Bearer ${placeholder}`,
      secret: result.secret,
      after: `" \\
  -H "content-type: application/json" \\
  -d '{"hello":"world"}'`,
    };
    case "mtls": return {
      before: `# mTLS: present your client certificate through your HTTP client
curl -X POST '${url}' --cert client.pem --key client.key \\
  -H "content-type: application/json" -d '{"hello":"world"}'`,
      secret: null,
      after: "",
    };
  }
}

/* Newly-created webhook — the URL + secret shown ONCE, with a curl test. */
export function NewWebhookCard({ result, onDismiss }: {
  result: CreateWebhookResult; onDismiss: () => void;
}) {
  const url = `${window.location.origin}${result.url}`;
  const curl = curlCommand(url, result);

  return (
    <div className="p-card p-5 space-y-3 border p-border mb-3">
      <div className="flex items-center gap-2">
        <CheckIcon size={16} className="p-success" />
        <span className="text-sm font-semibold">Webhook created</span>
        <button className="ml-auto text-xs p-text-3 hover:p-text" onClick={onDismiss}>Dismiss</button>
      </div>
      <p className="text-xs p-text-2">
        Save the secret now. It appears once. The URL works until you revoke the trigger.
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
              <SecretValue value={result.secret}
                className="text-xs p-fill px-2 py-1.5 rounded-sm font-mono flex-1 break-all" />
              <CopyButton value={result.secret} what="the secret" className="p-2 rounded-sm p-card p-card-hover" />
            </div>
          </div>
        )}
        <div>
          <div className="p-eyebrow mb-1">Test with curl</div>
          <pre className="p-meta p-fill p-3 rounded-sm font-mono overflow-x-auto whitespace-pre">
            {curl.before}
            {curl.secret !== null && <SecretValue value={curl.secret} />}
            {curl.after}
          </pre>
        </div>
      </div>
    </div>
  );
}

/* Step-up auth: creating a durable webhook requires a fresh Kinu browser
 * session (≤5 min since login). On the step-up 401 we send the user through
 * Kinu login and return here. */
export function CreateWebhookModal({ agentName, onClose, onCreated }: {
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
    if (!label.trim()) {
      setErr("label required");

      return;
    }

    setSubmitting(true); setErr(null);

    try {
      // Blank means "mint one": the server decides and stores the secret for
      // every hmac/bearer webhook, so a browser-side generator here would be a
      // second answer to the same question — and the one that produced nothing
      // when a different client asked.
      const r = await createDurableWebhook(agentName, {
        label: label.trim(),
        auth_mode: authMode,
        secret: authMode === "mtls" ? undefined : (secret.trim() || undefined),
        accepted_content_type: contentType.trim() || "application/json",
      });

      onCreated(r);
    } catch (e) {
      const msg = renderThrownChain({ cause: e });

      if (msg.includes("step-up")) {
        if (confirm("Your login is too old. Sign in again?")) {
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
        <FilledButton onClick={submit} disabled={submitting || !label.trim()}>
          {submitting ? <><Loader size="sm" /><span className="ml-1">Creating…</span></> : "Create"}
        </FilledButton>
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
            {/* A password field is redacted from a screenshot without being
                annotated; the marker is carried too, so a later reveal toggle
                that flips this to `text` cannot silently undo that. */}
            <input {...SECRET_REGION} type="password" value={secret}
              onChange={(e) => setSecret(e.target.value)} className={inputCls}
              placeholder="leave blank to auto-generate" />
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
        <span>Creating a webhook needs a sign-in from the last five minutes. Sign in again if it fails.</span>
      </p>
    </Modal>
  );
}
