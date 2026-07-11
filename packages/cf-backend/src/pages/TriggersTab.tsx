/**
 * Per-agent Triggers tab — list / create / revoke webhook + timer triggers.
 *
 * Inline:
 *   - List of triggers with state, kind, label, last fire / fire count
 *   - "+ New webhook" button → modal w/ label + auth mode + content type
 *   - On create: shows the URL + secret ONCE + an inline curl test command
 *   - Cancel button per trigger (revokes; idempotent)
 *
 * Step-up auth: creating a durable webhook requires a fresh Proteus browser
 * session (≤5 min since login). If POST returns 401 with the step-up message,
 * we send the user through Proteus login and return here.
 */
import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import { Modal } from "@/components/ui/Modal";
import {
  PlugIcon, PlusIcon, TrashIcon, CopyIcon,
  CheckIcon, WarningIcon, ArrowLeftIcon,
} from "@phosphor-icons/react";
import {
  listTriggers, createDurableWebhook, cancelTrigger,
  type TriggerSummary, type CreateWebhookResult,
} from "../lib/user-api";

const inputCls = "w-full rounded-md px-3 py-2 text-sm p-text focus:outline-none transition-all"
  + " border border-[var(--c-input-border)] bg-[var(--c-surface)]"
  + " focus:border-[var(--c-accent)] focus:ring-1 focus:ring-[var(--c-accent-subtle)]"
  + " placeholder:p-text-3";

export default function TriggersTab() {
  const { agentId } = useParams();
  const [triggers, setTriggers] = useState<TriggerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<CreateWebhookResult | null>(null);

  const refresh = useCallback(async () => {
    if (!agentId) return;
    try {
      const { triggers } = await listTriggers(agentId);
      setTriggers(triggers);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleCancel = useCallback(async (trigger_id: string) => {
    if (!agentId) return;
    if (!confirm('Revoke this trigger? The URL stops working immediately.')) return;
    try {
      await cancelTrigger(agentId, trigger_id);
      await refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  }, [agentId, refresh]);

  if (loading) return <div className="h-full flex items-center justify-center"><Loader size="base" /></div>;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <Link to={`/workspace/${agentId}`} className="text-xs p-text-3 flex items-center gap-1 hover:p-text mb-2">
              <ArrowLeftIcon size={12} /> Back to chat
            </Link>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <PlugIcon size={20} className="p-accent" />
              Triggers
            </h1>
            <p className="text-xs p-text-3 mt-1">
              External systems that can wake this agent.
              <span className="font-mono"> {agentId}</span>
            </p>
          </div>
          <button
            onClick={() => { setShowCreate(true); setCreated(null); }}
            className="px-3 py-1.5 rounded-md p-accent-bg p-accent text-xs font-medium hover:opacity-90 flex items-center gap-1.5"
          >
            <PlusIcon size={12} /> New webhook
          </button>
        </header>

        {err && <div className="p-card rounded-lg p-3 text-xs text-red-400">{err}</div>}

        {/* Newly-created webhook — show URL + secret once */}
        {created && <NewWebhookCard result={created} agentName={agentId ?? ''} onDismiss={() => setCreated(null)} />}

        {/* List */}
        <section className="space-y-2">
          {triggers.length === 0 ? (
            <div className="p-card rounded-xl p-6 text-center">
              <p className="text-sm p-text-2 mb-2">No triggers yet.</p>
              <p className="text-xs p-text-3">
                Create a webhook to let external systems (GitHub, Stripe, your CI) wake this agent.
              </p>
            </div>
          ) : (
            triggers.map((t) => <TriggerRow key={t.id} trigger={t} agentName={agentId ?? ''} onCancel={() => handleCancel(t.id)} />)
          )}
        </section>

        {showCreate && (
          <CreateWebhookModal
            agentName={agentId ?? ''}
            onClose={() => setShowCreate(false)}
            onCreated={(r) => { setCreated(r); setShowCreate(false); refresh(); }}
          />
        )}
      </div>
    </div>
  );
}

// ── Components ──────────────────────────────────────────────────

function TriggerRow({ trigger, agentName, onCancel }: {
  trigger: TriggerSummary; agentName: string; onCancel: () => void;
}) {
  const isWebhook = trigger.kind === 'webhook_durable' || trigger.kind === 'webhook_ephemeral';
  const url = isWebhook
    ? `${window.location.origin}/api/workspaces/${encodeURIComponent(agentName)}/webhook/${encodeURIComponent(trigger.id)}`
    : null;
  const spec = trigger.spec as { label?: string; auth_mode?: string; cron?: string };

  return (
    <div className="p-card rounded-lg p-3 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${badgeFor(trigger.state)}`}>
            {trigger.state}
          </span>
          <span className="font-medium truncate">{spec.label ?? trigger.kind}</span>
          <span className="text-[10px] p-text-3 font-mono">{trigger.kind}</span>
        </div>
        {url && (
          <div className="mt-1.5 flex items-center gap-2">
            <code className="text-[10px] p-elevated px-1.5 py-0.5 rounded font-mono truncate flex-1">{url}</code>
            <button
              className="p-1 rounded hover:p-card-hover p-text-3"
              onClick={() => navigator.clipboard.writeText(url)}
              title="Copy URL"
            ><CopyIcon size={11} /></button>
          </div>
        )}
        <div className="mt-1 text-[11px] p-text-3 flex items-center gap-2">
          {spec.auth_mode && <span>auth: {spec.auth_mode}</span>}
          {spec.cron && <span>cron: <code className="p-elevated px-1 rounded">{spec.cron}</code></span>}
          <span>rate ≤ {trigger.rate_limit_per_min}/min</span>
          <span>created {new Date(trigger.created_at).toLocaleString()}</span>
        </div>
      </div>
      <button
        onClick={onCancel}
        disabled={trigger.state === 'revoked'}
        className="p-text-3 hover:p-danger disabled:opacity-30 p-1.5"
        title="Revoke"
      ><TrashIcon size={12} /></button>
    </div>
  );
}

function badgeFor(state: TriggerSummary['state']): string {
  switch (state) {
    case 'active':  return 'bg-green-500/15 text-green-300';
    case 'paused':  return 'bg-yellow-500/15 text-yellow-300';
    case 'revoked': return 'bg-red-500/15 text-red-300';
  }
}

function NewWebhookCard({ result, agentName, onDismiss }: {
  result: CreateWebhookResult; agentName: string; onDismiss: () => void;
}) {
  const url = `${window.location.origin}${result.url}`;
  const curlSnippet = result.auth_mode === 'hmac'
    ? `# HMAC test (compute SIGNATURE = HMAC-SHA256 of "<ts>.<body>")
TS=$(date +%s)
BODY='{"hello":"world"}'
SIG=$(printf "%s.%s" "$TS" "$BODY" | openssl dgst -sha256 -hmac "${result.secret ?? '<your-secret>'}" -hex | cut -d' ' -f2)
curl -X POST '${url}' \\
  -H "x-proteus-timestamp: $TS" \\
  -H "x-proteus-signature: $SIG" \\
  -H "content-type: application/json" \\
  -d "$BODY"`
    : result.auth_mode === 'bearer'
    ? `curl -X POST '${url}' \\
  -H "Authorization: Bearer ${result.secret ?? '<your-secret>'}" \\
  -H "content-type: application/json" \\
  -d '{"hello":"world"}'`
    : `# mTLS — present your client certificate via your HTTP client
curl -X POST '${url}' --cert client.pem --key client.key \\
  -H "content-type: application/json" -d '{"hello":"world"}'`;

  return (
    <div className="p-card rounded-xl p-5 space-y-3 border border-green-500/30">
      <div className="flex items-center gap-2">
        <CheckIcon size={16} className="text-green-400" />
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
            <div className="text-[10px] p-text-3 mb-1">Secret <span className="text-red-300">(shown once)</span></div>
            <div className="flex items-center gap-2">
              <code className="text-xs p-elevated px-2 py-1.5 rounded font-mono flex-1 break-all">{result.secret}</code>
              <button className="p-2 rounded p-card hover:p-card-hover" onClick={() => navigator.clipboard.writeText(result.secret ?? '')}>
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

function CreateWebhookModal({ agentName, onClose, onCreated }: {
  agentName: string;
  onClose: () => void;
  onCreated: (r: CreateWebhookResult) => void;
}) {
  const [label, setLabel] = useState('');
  const [authMode, setAuthMode] = useState<'hmac' | 'bearer' | 'mtls'>('hmac');
  const [secret, setSecret] = useState('');
  const [contentType, setContentType] = useState('application/json');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!label.trim()) { setErr('label required'); return; }
    setSubmitting(true); setErr(null);
    try {
      const secretToUse = secret.trim() || autoGenSecret(authMode);
      const r = await createDurableWebhook(agentName, {
        label: label.trim(),
        auth_mode: authMode,
        secret: authMode === 'mtls' ? undefined : secretToUse,
        accepted_content_type: contentType.trim() || 'application/json',
      });
      onCreated(r);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('step-up')) {
        if (confirm('A fresh login is required to create webhook URLs. Redirect to sign in?')) {
          const login = new URL('/login', window.location.origin);
          login.searchParams.set('prompt', 'login');
          login.searchParams.set('return_to', window.location.pathname + window.location.search);
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
          <select value={authMode} onChange={(e) => setAuthMode(e.target.value as 'hmac' | 'bearer' | 'mtls')} className={inputCls}>
            <option value="hmac">HMAC (signed body)</option>
            <option value="bearer">Bearer token (Authorization header)</option>
            <option value="mtls">mTLS (client certificate)</option>
          </select>
        </label>
        {authMode !== 'mtls' && (
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
      {err && <div className="text-xs text-red-400">{err}</div>}
      <p className="text-[10px] p-text-3 flex items-start gap-1.5">
        <WarningIcon size={11} className="mt-0.5 shrink-0" />
        <span>Webhook creation requires a recent login (within 5 minutes). If it fails, you'll be prompted to sign in again.</span>
      </p>
    </Modal>
  );
}

function autoGenSecret(authMode: 'hmac' | 'bearer' | 'mtls'): string {
  if (authMode === 'mtls') return '';
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
