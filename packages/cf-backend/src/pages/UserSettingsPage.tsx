/**
 * User-level settings — credentials + defaults that apply across ALL of
 * this user's agents. Connect ChatGPT once → every agent sees it.
 *
 * Sections:
 *   1. Profile (email read-only, displayName editable)
 *   2. Connections
 *      - ChatGPT Codex via device-code flow
 *      - BYO API keys: OpenAI / Anthropic / OpenRouter / openai-compat
 *   3. Defaults
 *      - default model new agents inherit
 */
import { useEffect, useState, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import {
  PlugIcon, KeyIcon, GearSixIcon, CheckIcon, CopyIcon,
  UserCircleIcon, ArrowSquareOutIcon, TrashIcon, ArrowLeftIcon,
} from "@phosphor-icons/react";
import { CloudflareAIConnectNotice } from "@/components/CloudflareAIConnectNotice";
import {
  getProfile, listCredentials, setCredential, deleteCredential,
  codexStatus, startCodexFlow, pollCodexFlow, disconnectCodex,
  listAvailableModels, getConfig, setConfig, getCliSetup,
  type UserProfile, type CredentialSummary, type CodexStatus,
  type ModelMenuEntry, type DeviceFlowStart, type CliSetup,
} from "../lib/user-api";

const inputCls = "w-full rounded-md px-3 py-2 text-sm p-text focus:outline-none transition-all"
  + " border border-[var(--c-input-border)] bg-[var(--c-surface)]"
  + " focus:border-[var(--c-accent)] focus:ring-1 focus:ring-[var(--c-accent-subtle)]"
  + " placeholder:p-text-3";

function Card({ title, icon: Icon, children }: {
  title: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <section className="p-card rounded-xl p-5 space-y-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Icon size={16} className="p-accent" />
        <span>{title}</span>
      </h2>
      {children}
    </section>
  );
}

export default function UserSettingsPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [creds, setCreds] = useState<CredentialSummary[]>([]);
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const [models, setModels] = useState<ModelMenuEntry[]>([]);
  const [defaults, setDefaults] = useState<{ model: string | null }>({ model: null });
  const [cliSetup, setCliSetup] = useState<CliSetup | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setErr(null);
      const [p, c, k, m, defaultModel, cli] = await Promise.all([
        getProfile().catch(() => null),
        listCredentials().catch(() => []),
        codexStatus().catch(() => null),
        listAvailableModels().catch(() => []),
        getConfig('default_model').catch(() => ({ key: 'default_model', value: null })),
        getCliSetup().catch(() => null),
      ]);
      setProfile(p);
      setCreds(c ?? []);
      setCodex(k);
      setModels(m ?? []);
      setDefaults({ model: defaultModel?.value ?? null });
      setCliSetup(cli);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (loading) {
    return <div className="h-full flex items-center justify-center"><Loader size="base" /></div>;
  }
  const workersAIConnected = models.some((model) => model.provider === 'workers-ai');

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        <header>
          <Link to="/" className="text-xs p-text-3 flex items-center gap-1 hover:p-text mb-2">
            <ArrowLeftIcon size={12} /> Back
          </Link>
          <h1 className="text-2xl font-semibold">User settings</h1>
          <p className="text-xs p-text-3 mt-1">
            Account-level: credentials apply to every agent you own.
          </p>
        </header>

        {err && <div className="p-card rounded-lg p-3 text-xs text-red-400">{err}</div>}

        {/* Profile */}
        <Card title="Profile" icon={UserCircleIcon}>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="space-y-1">
              <div className="p-text-3">Email</div>
              <div className="font-mono">{profile?.email ?? '—'}</div>
            </div>
            <div className="space-y-1">
              <div className="p-text-3">Member since</div>
              <div>{profile?.createdAt ? new Date(profile.createdAt).toLocaleDateString() : '—'}</div>
            </div>
          </div>
        </Card>

        <Card title="CLI" icon={KeyIcon}>
          <div className="space-y-3">
            <p className="text-xs p-text-2">
              Install the CLI, sign in through the browser, and configure local execution from one terminal command.
            </p>
            <CommandCopy label="Setup" command={cliSetup?.installCommand ?? "curl -fsSL 'https://proteus.ashishkumarsingh.com/install.sh' | bash"} />
          </div>
        </Card>

        <Card title="Cloudflare Workers AI" icon={PlugIcon}>
          {workersAIConnected ? (
            <div className="flex items-center gap-2 text-xs text-emerald-300">
              <CheckIcon size={13} /> Connected
            </div>
          ) : (
            <CloudflareAIConnectNotice
              returnTo="/user/settings"
              message="Connect Cloudflare Workers AI so agents can use your Cloudflare account quota."
            />
          )}
        </Card>

        {/* Codex */}
        <Card title="ChatGPT (Codex)" icon={PlugIcon}>
          <CodexConnect status={codex} onChanged={refresh} />
        </Card>

        {/* BYO API keys */}
        <Card title="API keys" icon={KeyIcon}>
          <ApiKeyManager creds={creds} onChanged={refresh} />
        </Card>

        {/* MCP servers */}
        <Card title="MCP servers" icon={PlugIcon}>
          <div className="space-y-2 text-xs">
            <p className="p-text-2">
              Connect Model Context Protocol servers (GitHub, Notion, your own…) so every agent
              you own can call their tools. One OAuth grant per server; shared across all your
              agents.
            </p>
            <Link
              to="/user/settings/mcp"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md p-card hover:p-card-hover"
            >Manage MCP servers <ArrowSquareOutIcon size={12} /></Link>
          </div>
        </Card>

        {/* Defaults */}
        <Card title="Defaults" icon={GearSixIcon}>
          <div className="space-y-2">
            <div className="text-xs p-text-2">Default model for new agents</div>
            <select
              value={defaults.model ?? ''}
              onChange={async (e) => {
                const v = e.target.value;
                setDefaults({ model: v });
                try { await setConfig('default_model', v); } catch (err) { alert((err as Error).message); }
              }}
              className={inputCls}
            >
              <option value="">(use system default)</option>
              {models.map((m) => (
                <option key={m.spec} value={m.spec}>{m.label}</option>
              ))}
            </select>
            <p className="text-[11px] p-text-3">
              New agents pick this up at creation. Existing agents keep their own choice (change per-agent under "Agent settings").
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}

function CommandCopy({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border p-border p-2">
      <div className="w-14 shrink-0 text-[11px] p-text-3">{label}</div>
      <code className="font-mono text-[11px] p-text flex-1 truncate">{command}</code>
      <button
        onClick={() => {
          navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1000);
          });
        }}
        className="px-2 py-1 rounded p-card hover:p-card-hover flex items-center gap-1 text-xs p-text-2"
      >
        <CopyIcon size={11} />{copied ? "copied" : "Copy"}
      </button>
    </div>
  );
}

// ── Codex device-code flow ──────────────────────────────────────────

function CodexConnect({ status, onChanged }: { status: CodexStatus | null; onChanged: () => void }) {
  const [flow, setFlow] = useState<DeviceFlowStart | null>(null);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const f = await startCodexFlow();
      setFlow(f);
      setPolling(true);
      const stopPolling = () => {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        setPolling(false);
      };
      pollRef.current = setInterval(async () => {
        try {
          const result = await pollCodexFlow();
          if (result.connected) {
            stopPolling();
            setFlow(null);
            onChanged();
          } else if (result.error) {
            // Still-pending polls return { connected: false } with no error;
            // a reported error (expired/denied/no flow) is terminal — stop
            // polling instead of hammering the endpoint forever.
            stopPolling();
            setFlow(null);
            setError(result.error);
          } else {
            setError(null); // still pending — clear any transient poll error
          }
        } catch (e) {
          // Thrown = the poll request itself failed (network blip) — show it
          // but keep polling; the flow may still complete.
          setError((e as Error).message);
        }
      }, Math.max(3, f.pollIntervalSec) * 1000);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [onChanged]);

  const disconnect = useCallback(async () => {
    if (!confirm('Disconnect ChatGPT? All your agents will lose access to Codex models.')) return;
    try { await disconnectCodex(); onChanged(); } catch (e) { setError((e as Error).message); }
  }, [onChanged]);

  if (status?.connected) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs">
          <CheckIcon size={14} className="p-success" />
          <span>Connected{status.accountId ? <span className="p-text-3"> · account {status.accountId.slice(0, 8)}…</span> : null}</span>
        </div>
        <button onClick={disconnect}
          className="text-xs px-3 py-1.5 rounded-md p-card hover:p-card-hover transition-colors">
          Disconnect
        </button>
      </div>
    );
  }

  if (flow && polling) {
    return (
      <div className="space-y-3">
        <p className="text-xs p-text-2">
          Open <a href={flow.portalURL} target="_blank" rel="noopener noreferrer" className="p-accent underline">{flow.portalURL}</a> and enter:
        </p>
        <div className="flex items-center gap-3">
          <code className="text-2xl font-mono tracking-widest p-card rounded-lg px-4 py-2 select-all">{flow.userCode}</code>
          <button
            onClick={() => navigator.clipboard.writeText(flow.userCode)}
            className="p-2 rounded-md p-card hover:p-card-hover"
            title="Copy"
          ><CopyIcon size={14} /></button>
          <a
            href={flow.portalURL}
            target="_blank" rel="noopener noreferrer"
            className="p-2 rounded-md p-card hover:p-card-hover"
            title="Open portal"
          ><ArrowSquareOutIcon size={14} /></a>
        </div>
        <p className="text-[11px] p-text-3 flex items-center gap-2"><Loader size="sm" /> Waiting for you to authorize…</p>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs p-text-2">
        Use your ChatGPT subscription as Proteus's chat backend.
        Authorize a device once — every agent you create can pick a Codex model afterward.
      </p>
      <button
        onClick={start}
        className="px-3 py-1.5 rounded-md p-accent-bg p-accent text-xs font-medium hover:opacity-90 transition-opacity"
      >Connect ChatGPT</button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

// ── BYO API keys ────────────────────────────────────────────────────

interface ProviderKeySpec {
  key: string;
  label: string;
  inputPlaceholder: string;
  acceptsBaseURL?: boolean;
}

const KNOWN_PROVIDERS: ProviderKeySpec[] = [
  { key: 'openai.bearer',      label: 'OpenAI',     inputPlaceholder: 'sk-...' },
  { key: 'anthropic.bearer',   label: 'Anthropic',  inputPlaceholder: 'sk-ant-...' },
  { key: 'openrouter.bearer',  label: 'OpenRouter', inputPlaceholder: 'sk-or-...' },
];

function ApiKeyManager({ creds, onChanged }: { creds: CredentialSummary[]; onChanged: () => void }) {
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});

  const stored = new Set(creds.map((c) => c.key));

  const save = useCallback(async (key: string) => {
    const value = inputs[key];
    if (!value || !value.trim()) return;
    setSavingKey(key);
    try {
      await setCredential(key, { kind: 'bearer', token: value.trim() });
      setInputs((prev) => ({ ...prev, [key]: '' }));
      onChanged();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSavingKey(null);
    }
  }, [inputs, onChanged]);

  const remove = useCallback(async (key: string) => {
    if (!confirm(`Remove the saved API key for "${key}"?`)) return;
    try { await deleteCredential(key); onChanged(); } catch (e) { alert((e as Error).message); }
  }, [onChanged]);

  // openai-compat — user-chosen key suffix.
  const [compatName, setCompatName] = useState('');
  const [compatBaseURL, setCompatBaseURL] = useState('');
  const [compatApiKey, setCompatApiKey] = useState('');
  const saveCompat = useCallback(async () => {
    if (!compatName.trim() || !compatBaseURL.trim() || !compatApiKey.trim()) return;
    const credKey = `openai-compat.${compatName.trim()}`;
    setSavingKey(credKey);
    try {
      await setCredential(credKey, {
        kind: 'openai-compat',
        baseURL: compatBaseURL.trim(),
        apiKey: compatApiKey.trim(),
      });
      setCompatName(''); setCompatBaseURL(''); setCompatApiKey('');
      onChanged();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSavingKey(null);
    }
  }, [compatName, compatBaseURL, compatApiKey, onChanged]);

  return (
    <div className="space-y-4">
      {KNOWN_PROVIDERS.map((p) => (
        <div key={p.key} className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">{p.label}</span>
            {stored.has(p.key) && (
              <button onClick={() => remove(p.key)} className="flex items-center gap-1 p-text-3 hover:p-danger">
                <TrashIcon size={11} /> Remove
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              value={inputs[p.key] ?? ''}
              onChange={(e) => setInputs((prev) => ({ ...prev, [p.key]: e.target.value }))}
              placeholder={stored.has(p.key) ? '••••••• (stored — paste to replace)' : p.inputPlaceholder}
              className={inputCls}
            />
            <button
              onClick={() => save(p.key)}
              disabled={savingKey === p.key || !inputs[p.key]?.trim()}
              className="px-3 py-1.5 rounded-md p-card hover:p-card-hover disabled:opacity-50 text-xs"
            >{savingKey === p.key ? '...' : (stored.has(p.key) ? 'Replace' : 'Save')}</button>
          </div>
        </div>
      ))}

      {/* OpenAI-compat slot */}
      <div className="pt-3 border-t p-border space-y-2">
        <div className="text-xs font-medium">OpenAI-compatible (Groq, Together, …)</div>
        <p className="text-[11px] p-text-3">Each named entry stores baseURL + apiKey. Use model spec <code className="p-card px-1">openai-compat:&lt;name&gt;/&lt;modelId&gt;</code>.</p>
        <div className="grid grid-cols-3 gap-2">
          <input
            value={compatName}
            onChange={(e) => setCompatName(e.target.value)}
            placeholder="name (e.g. groq)"
            className={inputCls}
          />
          <input
            value={compatBaseURL}
            onChange={(e) => setCompatBaseURL(e.target.value)}
            placeholder="https://api.example.com/v1"
            className={inputCls}
          />
          <input
            type="password"
            value={compatApiKey}
            onChange={(e) => setCompatApiKey(e.target.value)}
            placeholder="api key"
            className={inputCls}
          />
        </div>
        <button
          onClick={saveCompat}
          disabled={savingKey !== null || !compatName.trim() || !compatBaseURL.trim() || !compatApiKey.trim()}
          className="px-3 py-1.5 rounded-md p-card hover:p-card-hover disabled:opacity-50 text-xs"
        >Add endpoint</button>

        {/* List existing openai-compat */}
        {creds.filter((c) => c.key.startsWith('openai-compat.')).map((c) => (
          <div key={c.key} className="flex items-center justify-between text-xs px-2 py-1.5 p-card rounded">
            <span className="font-mono">{c.key}</span>
            <button onClick={() => remove(c.key)} className="flex items-center gap-1 p-text-3 hover:p-danger">
              <TrashIcon size={11} /> Remove
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
