import { Effect } from 'effect';
import { useState, useCallback } from "react";
import { Badge, Loader } from "@cloudflare/kumo";
import { Button } from "@/components/ui/Button";
import {
  LightningIcon, CheckIcon,
  PlusIcon, TrashIcon, WarningIcon, PlugIcon,
} from "@phosphor-icons/react";
import { CopyButton } from "@/components/ui/CopyButton";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { SECRET_REGION, SecretValue } from "@/components/ui/SecretValue";
import { Modal } from "@/components/ui/Modal";
import { inputCls } from "@/components/ui/form";
import { useConfirmation } from "@/components/ui/ConfirmDialog";
import { StatusDot, type StatusTone } from "@/components/ui/Status";
import { createDurableWebhook, cancelTrigger, type CreateWebhookResult } from "@/lib/user-api";
import * as v from "valibot";
import { showing, detach } from '@kinu.run/core/obs';
import { dailyTimeOf } from "@kinu.run/core";
import type { WorkspaceAnswer, WorkspaceRpc } from "@/lib/workspace-rpc";

type TriggerRow = WorkspaceAnswer<"listTriggers">["triggers"][number];

const AuthModeSchema = v.picklist(["hmac", "bearer", "mtls"]);


/** What wakes this workspace's agent from outside: its webhooks and timers. */
export function WorkspaceAutomations({ rpc, workspace }: { rpc: WorkspaceRpc; workspace: string }) {
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<CreateWebhookResult | null>(null);

  const load = useCallback(async () => (await rpc("listTriggers", [])).triggers, [rpc]);

  const { resource, reload } = useAsyncResource(load);
  const triggers = lastValue(resource);

  const { ask, dialog } = useConfirmation();

  const revoke = useCallback((triggerId: string) => ask({
    title: "Revoke this automation?", body: "It stops firing, and a webhook's URL stops working.", action: "Revoke",
    failed: "Could not revoke it", run: async () => { await cancelTrigger(workspace, triggerId); reload(); },
  }), [ask, workspace, reload]);

  const active = (triggers ?? []).filter((t) => t.state === "active").length;

  const nextFire = (triggers ?? [])
    .map((t) => t.next_fire_at)
    .filter((ts): ts is number => ts !== undefined && ts !== null && ts > Date.now())
    .sort((a, b) => a - b)[0];

  return (
    <section className="min-w-0">
      {dialog}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <LightningIcon size={16} className="p-accent" />
        <h2 className="t-label p-text">Automations</h2>
        {triggers && <Badge variant="secondary">{active}/{triggers.length} active</Badge>}
        {nextFire && <span className="t-meta p-text-3 tabular-nums">next {new Date(nextFire).toLocaleString()}</span>}
        <Button size="sm" variant="secondary" className="ml-auto" icon={<PlusIcon size={12} />}
          onClick={() => { setShowCreate(true); setCreated(null); }}>New webhook</Button>
      </div>
      <p className="t-meta p-text-3 mb-3">Webhooks and timers: what wakes this workspace's agent from outside.</p>
      {created && <NewWebhookCard result={created} onDismiss={() => setCreated(null)} />}
      {triggers === null && (resource.status === "error"
        ? <LoadFailure what="automations" message={resource.message} onRetry={reload} />
        : <div className="flex justify-center py-6"><Loader size="sm" /></div>)}
      {triggers !== null && triggers.length === 0 && <p className="t-meta p-text-3">No webhooks or timers yet. Use New webhook to let another system wake this agent.</p>}
      {triggers !== null && triggers.length > 0 && (
        <div className="t-meta rounded-md border p-border overflow-hidden">
          {triggers.map((t) => (
            <TriggerLine key={t.id} trigger={t} onRevoke={() => revoke(t.id)} rpc={rpc} onMoved={reload} />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateWebhookModal
          agentName={workspace}
          onClose={() => setShowCreate(false)}
          onCreated={(r) => { setCreated(r); setShowCreate(false); reload(); }}
        />
      )}
    </section>
  );
}

/** An active trigger is healthy; a paused one needs a look. */
const TRIGGER_TONE: ReadonlyMap<string, StatusTone> = new Map([["active", "success"], ["paused", "warning"]]);

/** The delivery URL carries a signed route capability; a URL built here would 404. */
/** A daily schedule's time, kept as typed until it is sent; a refusal says why beside it. */
function DailyTime({ rpc, trigger, at, onMoved }: { rpc: WorkspaceRpc; trigger: TriggerRow; at: string; onMoved: () => void }) {
  const [failure, setFailure] = useState<string | null>(null);

  const move = (next: string) => (next === "" || next === at ? Effect.void : Effect.catchCause(Effect.gen(function* () {
    setFailure(null);
    yield* Effect.promise(() => rpc("retimeDailySchedule", [trigger.id, next]));
    onMoved();
  }), showing(setFailure)));

  return (
    <span className="flex shrink-0 items-center gap-2" data-schedule-time={trigger.id}>
      <span className="p-text-3">each day at</span>
      <input type="time" defaultValue={at} aria-label="Time of day" disabled={trigger.state === "revoked"}
        onBlur={(event) => detach(move(event.target.value))} onKeyDown={(event) => detach(event.key === "Enter" ? move(event.currentTarget.value) : Effect.void)}
        className="rounded-sm border p-border bg-transparent px-1 font-mono p-text-2" />
      {failure !== null && <span className="p-danger" role="alert">{failure}</span>}
    </span>
  );
}

function TriggerLine({ trigger, onRevoke, rpc, onMoved }: {
  trigger: TriggerRow; onRevoke: () => void; rpc: WorkspaceRpc; onMoved: () => void;
}) {
  const isWebhook = trigger.kind === "webhook_durable" || trigger.kind === "webhook_ephemeral";
  const url = trigger.url ? `${window.location.origin}${trigger.url}` : null;
  // The spec is the trigger's own JSON: a label and a cron are read where they are strings.
  const label = typeof trigger.spec.label === "string" ? trigger.spec.label : trigger.id;
  const cron = typeof trigger.spec.cron === "string" ? trigger.spec.cron : null;
  const daily = cron === null ? null : dailyTimeOf(cron);

  return (
    <div className="flex items-center gap-2 px-3 py-1 border-b p-border last:border-0">
      <StatusDot tone={TRIGGER_TONE.get(trigger.state) ?? "neutral"} />
      <span className="font-medium p-text-2 truncate max-w-40" title={label}>{label}</span>
      <span className="font-mono p-text-3 shrink-0">{trigger.kind}</span>
      {daily !== null && <DailyTime rpc={rpc} trigger={trigger} at={daily} onMoved={onMoved} />}
      {cron !== null && daily === null && <code className="p-fill px-1 rounded-sm p-text-3 shrink-0">{cron}</code>}
      <span className="flex-1" />
      {trigger.fire_count > 0 && <span className="p-text-3 shrink-0 tabular-nums">{trigger.fire_count} fires</span>}
      <span className="p-text-3 shrink-0">{trigger.state}</span>
      {url !== null && (
        <CopyButton value={url} what="the webhook URL" size={11}
          className="p-1 rounded-sm p-card-hover p-text-3 shrink-0" />
      )}
      {url === null && isWebhook && (
        <span className="p-text-3 shrink-0"
          title="Set WEBHOOK_ROUTE_SECRET on this deployment to deliver webhooks.">
          no URL
        </span>
      )}
      <button
        onClick={onRevoke}
        disabled={trigger.state === "revoked"}
        className="p-text-3 hover:p-danger disabled:opacity-30 p-1 shrink-0"
        title="Revoke" aria-label="Revoke"
      ><TrashIcon size={11} /></button>
    </div>
  );
}

/** Split at the credential: it renders through `SecretValue`, never a template string. */
interface CurlCommand {
  readonly before: string;
  readonly secret: string | null;
  readonly after: string;
}

function curlCommand(url: string, result: CreateWebhookResult): CurlCommand {
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

export function NewWebhookCard({ result, onDismiss }: {
  result: CreateWebhookResult; onDismiss: () => void;
}) {
  const url = `${window.location.origin}${result.url}`;
  const curl = curlCommand(url, result);

  return (
    <div className="p-card p-5 space-y-3 border p-border mb-3">
      <div className="flex items-center gap-2">
        <CheckIcon size={16} className="p-success" />
        <span className="t-label">Webhook created</span>
        <button className="t-meta ml-auto p-text-3 hover:p-text" onClick={onDismiss}>Dismiss</button>
      </div>
      <p className="t-meta p-text-2">
        {result.secret ? "Save the secret now. Kinu shows it only once. " : ""}The URL works until you revoke this webhook.
      </p>
      <div className="space-y-2">
        <div>
          <div className="t-label mb-1">URL</div>
          <div className="flex items-center gap-2">
            <code className="t-meta t-mono p-fill px-2 py-1 rounded-sm flex-1 break-all">{url}</code>
            <CopyButton value={url} what="the webhook URL" className="p-2 rounded-sm p-card p-card-hover" />
          </div>
        </div>
        {result.secret && (
          <div>
            <div className="t-label mb-1">Secret <span className="p-danger">(shown once)</span></div>
            <div className="flex items-center gap-2">
              <SecretValue value={result.secret}
                className="t-meta t-mono p-fill px-2 py-1 rounded-sm flex-1 break-all" />
              <CopyButton value={result.secret} what="the secret" className="p-2 rounded-sm p-card p-card-hover" />
            </div>
          </div>
        )}
        <div>
          <div className="t-label mb-1">Test with curl</div>
          <pre className="t-meta t-mono p-fill p-3 rounded-sm overflow-x-auto whitespace-pre">
            {curl.before}
            {curl.secret !== null && <SecretValue value={curl.secret} />}
            {curl.after}
          </pre>
        </div>
      </div>
    </div>
  );
}

/* Creating a webhook requires a fresh (≤5 min) Kinu session; the step-up 401 sends the user through login and back. */
/** Back through sign-in to this page, for a step that needs a fresh one. */
function signInAgain(): void {
  const login = new URL("/login", window.location.origin);

  login.searchParams.set("prompt", "login");
  login.searchParams.set("return_to", window.location.pathname + window.location.search);
  window.location.href = login.toString();
}

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
  const [stepUp, setStepUp] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(() => detach(Effect.gen(function* () {
    if (!label.trim()) {
      setErr("Give the webhook a label.");

      return;
    }

    setSubmitting(true); setErr(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      // Blank means the server mints and stores the secret.
      const r = yield* Effect.promise(async () => createDurableWebhook(agentName, {
        label: label.trim(),
        auth_mode: authMode,
        secret: authMode === "mtls" ? undefined : (secret.trim() || undefined),
        accepted_content_type: contentType.trim() || "application/json",
      }));

      onCreated(r);
    }), showing((msg) => {
      if (msg.includes("step-up")) {
        setStepUp(true);
      } else {
        setErr(msg);
      }
    })), Effect.sync(() => {
      setSubmitting(false);
    }));
  })), [agentName, label, authMode, secret, contentType, onCreated]);

  return (
    <Modal
      title="New webhook"
      icon={<PlugIcon size={16} className="p-accent" />}
      onClose={onClose}
      busy={submitting}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={submitting || !label.trim()}>
          {submitting ? <><Loader size="sm" /><span className="ml-1">Creating…</span></> : "Create"}
        </Button>
      </>}
    >
      <div className="space-y-2">
        <label className="block">
          <div className="t-meta p-text-2 mb-1">Label</div>
          <input value={label} onChange={(e) => setLabel(e.target.value)} className={inputCls}
            placeholder="github-pr-events" />
        </label>
        <label className="block">
          <div className="t-meta p-text-2 mb-1">Authentication</div>
          <select value={authMode} onChange={(e) => setAuthMode(v.parse(AuthModeSchema, e.target.value))} className={inputCls}>
            <option value="hmac">HMAC (signed body)</option>
            <option value="bearer">Bearer token (Authorization header)</option>
            <option value="mtls">mTLS (client certificate)</option>
          </select>
        </label>
        {authMode !== "mtls" && (
          <label className="block">
            <div className="t-meta p-text-2 mb-1">Secret</div>
            {/* Marked for redaction too, so a later reveal toggle to `text` cannot undo it. */}
            <input {...SECRET_REGION} type="password" value={secret}
              onChange={(e) => setSecret(e.target.value)} className={inputCls}
              placeholder="Leave blank and Kinu generates one" />
          </label>
        )}
        <label className="block">
          <div className="t-meta p-text-2 mb-1">Accepted content type</div>
          <input value={contentType} onChange={(e) => setContentType(e.target.value)} className={inputCls} placeholder="application/json" />
        </label>
      </div>
      {err && <div className="t-meta p-danger">{err}</div>}
      {stepUp && (
        <div role="status" className="t-meta flex items-center gap-2 p-text-2">
          <span className="min-w-0 flex-1">Creating a webhook needs a sign-in from the last five minutes.</span>
          <Button size="sm" variant="secondary" onClick={signInAgain}>Sign in again</Button>
        </div>
      )}
      <p className="t-meta p-text-3 flex items-start gap-2">
        <WarningIcon size={11} className="mt-px shrink-0" />
        <span>Creating a webhook needs a sign-in from the last five minutes. Sign in again if it fails.</span>
      </p>
    </Modal>
  );
}
