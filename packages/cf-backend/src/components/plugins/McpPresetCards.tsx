/**
 * The one-click MCP presets — a card per `MCP_PRESETS` entry, drawn in the
 * PluginCard grammar (icon well, name, one line, one status) so the Plugins
 * grid and the MCP panel read as one surface.
 *
 * A card's state is the row the account already holds: `preset_id` tags it, so
 * a preset server appears here AND in the server list like any other server.
 * `oauth` presets connect in one click — the SDK answers an authorize URL,
 * which opens in a new tab (the same pattern the add form uses). `token`
 * presets expand one labelled field. Removal is the ordinary server remove.
 */
import { useState, type ComponentType } from "react";
import {
  ArrowSquareOutIcon, GithubLogoIcon, GoogleLogoIcon, TrashIcon,
} from "@phosphor-icons/react";
import {
  MCP_PRESETS, type McpPreset, type McpPresetId,
} from "@kinu.run/core";
import {
  addMcpServer, removeMcpServer,
  type McpServerInput, type McpServerSummary,
} from "@/lib/user-api";
import { inputCls } from "@/components/ui/form";
import { SECRET_REGION } from "@/components/ui/SecretValue";
import { renderThrownChain } from "@kinu.run/core/obs";

/** The small mark phosphor does not carry: Cloudflare's cloud with the sun
 *  bar behind it. Drawn at the icon well's size, `currentColor` apart from
 *  the bar. */
function CloudflareMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 256 256" width={size} height={size} className={className}
      fill="currentColor" aria-hidden="true">
      <path d="M196,68a40,40,0,0,0-39.6,45.2A60,60,0,0,1,196,68Z" fill="#f6821f" />
      <path d="M180,124a44,44,0,0,0-43.6,38H60a36,36,0,1,1,13.5-69.6A56,56,0,0,1,180,124Z" />
    </svg>
  );
}

const PRESET_ICON: Record<McpPresetId, ComponentType<{ size?: number; className?: string }>> = {
  github: GithubLogoIcon,
  cloudflare: CloudflareMark,
  google: GoogleLogoIcon,
};

/** The one status a preset card says. Rows that are mid-flight still read as
 *  one word; 'Not added' means no row claims this preset at all. */
function presetWord(server: McpServerSummary | undefined) {
  switch (server?.status) {
    case undefined:
      return { word: 'Not added', dot: 'p-dot-neutral' };
    case 'ready':
    case 'connected':
      return { word: 'Connected', dot: 'p-dot-success' };
    case 'authenticating':
      return { word: 'Needs sign-in', dot: 'p-dot-warning' };
    case 'failed':
      return { word: 'Failed', dot: 'bg-[var(--c-danger)]' };
    default:
      return { word: 'Connecting', dot: 'p-dot-warning' };
  }
}

function PresetCard({ preset, server, appConfigured, onChanged }: {
  preset: McpPreset;
  server: McpServerSummary | undefined;
  /** Whether the deployment carries this preset's registered OAuth app.
   *  `undefined` while the availability read is still open — optimistic, so
   *  a configured card never flickers into its fallback on first paint. */
  appConfigured: boolean | undefined;
  onChanged: () => void;
}) {
  const [openToken, setOpenToken] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const { word, dot } = presetWord(server);
  const Icon = PRESET_ICON[preset.id];
  const added = server !== undefined;

  // Sign-in exists for every preset that answers an authorize URL: 'oauth'
  // unconditionally (the server registers the client itself), 'oauth-app'
  // only while the deployment carries the registration. Without it, an
  // oauth-app card asks for its token fallback instead.
  const signIn = preset.auth === 'oauth' || (preset.auth === 'oauth-app' && appConfigured !== false);

  const tokenLabel = preset.auth === 'oauth-app'
    ? preset.tokenFallback?.label ?? 'Access token'
    : preset.tokenLabel ?? 'Access token';

  const add = async (input: McpServerInput) => {
    setErr(null);
    setBusy(true);

    try {
      const result = await addMcpServer(input);

      if (result.authUrl) {
        window.open(result.authUrl, '_blank', 'noopener,noreferrer');
      }

      setOpenToken(false);
      setToken('');
      onChanged();
    } catch (e) {
      setErr(renderThrownChain({ cause: e }));
    } finally {
      setBusy(false);
    }
  };

  const connect = async (): Promise<void> => {
    if (signIn) {
      await add({ presetId: preset.id });
    } else {
      setOpenToken(true);
    }
  };

  const remove = async () => {
    if (!server) return;

    if (!confirm(`Remove "${server.name}"? All workspaces will lose access to its tools.`)) return;

    setErr(null);

    try { await removeMcpServer(server.id); onChanged(); }
    catch (e) { setErr(renderThrownChain({ cause: e })); }
  };

  return (
    <div className="p-card flex items-start gap-3 p-4" data-mcp-preset={preset.id}>
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg p-fill p-text-3">
        <Icon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="truncate p-row-text font-medium p-text">{preset.title}</div>
          <a href={preset.docsUrl} target="_blank" rel="noopener noreferrer"
            aria-label={`${preset.title} docs`} title="Docs"
            className="shrink-0 p-text-3 hover:p-text">
            <ArrowSquareOutIcon size={12} />
          </a>
          <div className="ml-auto flex items-center gap-2">
            {added ? (
              <button onClick={remove}
                className="text-xs p-text-3 hover:p-danger flex items-center gap-1"
                title="Remove server">
                <TrashIcon size={11} /> Remove
              </button>
            ) : signIn ? (
              <button onClick={connect} disabled={busy}
                className="text-xs px-2 py-1 rounded-sm p-accent-bg p-accent font-medium disabled:opacity-50">
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            ) : !openToken ? (
              <button onClick={connect} disabled={busy}
                className="text-xs px-2 py-1 rounded-sm p-card p-card-hover">
                Connect
              </button>
            ) : null}
          </div>
        </div>
        <p className="truncate p-meta p-text-3 font-mono" title={preset.serverUrl}>{preset.serverUrl}</p>
        <div className="mt-1 flex items-center gap-1.5 p-meta p-text-3">
          <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
          <span data-mcp-preset-status={preset.id}>{word}</span>
        </div>
        {openToken && !added && (
          <div className="mt-2 flex items-center gap-2">
            {/* A credential region: the typed value must not reach a feedback
                screenshot, so it carries the same marker the add form does. */}
            <input {...SECRET_REGION} type="password" autoComplete="off"
              value={token} onChange={(e) => setToken(e.target.value)}
              aria-label={tokenLabel} placeholder={tokenLabel}
              className={inputCls + ' min-w-0 flex-1'} />
            <button
              onClick={async () => { await add({
                presetId: preset.id,
                headers: { Authorization: `Bearer ${token}` },
              }); }}
              disabled={busy || !token.trim()}
              className="text-xs px-2 py-1.5 rounded-md p-accent-bg p-accent font-medium disabled:opacity-50">
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        )}
        {err && <p className="mt-1 p-t-status p-danger">{err}</p>}
      </div>
    </div>
  );
}

/** One card per preset; rendered as a fragment so the caller's grid owns the
 *  layout (PluginSection's grid on the plugins page, the panel's own row in
 *  account surfaces). An `oauth-app` preset with no configured app and no
 *  token fallback offers nothing, so its card only appears once the user has
 *  added the server another way — while the availability read is open the
 *  card renders as though configured rather than vanish on first paint. */
export function McpPresetCards({ servers, availability, onChanged }: {
  servers: readonly McpServerSummary[];
  availability: readonly { id: string; appConfigured: boolean }[] | undefined;
  onChanged: () => void;
}) {
  return (
    <>
      {MCP_PRESETS.map((preset) => {
        const server = servers.find((s) => s.presetId === preset.id);
        const appConfigured = availability?.find((a) => a.id === preset.id)?.appConfigured;

        if (preset.auth === 'oauth-app' && appConfigured === false
          && preset.tokenFallback === undefined && server === undefined) {
          return null;
        }

        return (
          <PresetCard key={preset.id} preset={preset} server={server}
            appConfigured={appConfigured} onChanged={onChanged} />
        );
      })}
    </>
  );
}
