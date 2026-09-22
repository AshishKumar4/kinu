/** One-click MCP preset rows; a row's state is the account's server row tagged with its `preset_id`. */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { useCloseOnOutsideClick } from "@/hooks/use-close-on-outside-click";
import {
  ArrowSquareOutIcon, CaretDownIcon, PlusIcon, TrashIcon, XIcon,
} from "@phosphor-icons/react";
import {
  MCP_PRESETS, mcpPresetById, type McpPreset, type McpPresetId,
} from "@kinu.run/core";
import {
  addMcpServer, removeMcpServer,
  type McpServerInput, type McpServerSummary,
} from "@/lib/user-api";
import { inputCls } from "@/components/ui/form";
import { SECRET_REGION } from "@/components/ui/SecretValue";
import { BrandMark, type BrandName } from "@/components/ui/BrandMark";
import { PluginRow, PLUGIN_ACTION, PLUGIN_PILL } from "@/components/plugins/PluginRow";
import { renderThrownChain } from "@kinu.run/core/obs";

const PRESET_MARK: Record<McpPresetId, BrandName> = {
  github: "github",
  cloudflare: "cloudflare",
  google: "google",
};

/** `preset_id` is an arbitrary string on the wire; the catalog resolves it. */
export function presetBrand(presetId: string | null): BrandName | undefined {
  const preset = presetId === null ? undefined : mcpPresetById(presetId);

  return preset === undefined ? undefined : PRESET_MARK[preset.id];
}

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
    case 'connecting':
    case 'discovering':
    case 'unknown':
      return { word: 'Connecting', dot: 'p-dot-warning' };
  }
}

function PresetMenu({ preset, word, dot, onRemove }: {
  preset: McpPreset;
  word: string;
  dot: string;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useCloseOnOutsideClick(open, menu, close);

  const item = "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm p-card-hover";

  return (
    <div ref={menu} className="relative shrink-0">
      <button type="button" data-plugin-menu aria-haspopup="menu" aria-expanded={open}
        aria-label={`${preset.title} options`} onClick={() => setOpen((value) => !value)}
        className={`${PLUGIN_PILL} transition-colors hover:bg-[var(--c-elevated)] hover:p-text`}>
        <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
        {word}
        <CaretDownIcon size={9} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-10 mt-1 w-40 p-card border p-border p-1.5 p-shadow-menu">
          <a role="menuitem" href={preset.docsUrl} target="_blank" rel="noopener noreferrer"
            className={item} onClick={() => setOpen(false)}>
            <ArrowSquareOutIcon size={14} /> Docs
          </a>
          <button type="button" role="menuitem" className={`${item} hover:p-danger`}
            onClick={() => { setOpen(false); onRemove(); }}>
            <TrashIcon size={14} /> Remove
          </button>
        </div>
      )}
    </div>
  );
}

function PresetRow({ preset, server, appConfigured, onChanged }: {
  preset: McpPreset;
  server: McpServerSummary | undefined;
  /** `undefined` while loading, treated as configured so a row never flickers to its fallback. */
  appConfigured: boolean | undefined;
  onChanged: () => void;
}) {
  const [openToken, setOpenToken] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const { word, dot } = presetWord(server);
  const brand = PRESET_MARK[preset.id];
  const added = server !== undefined;

  // 'oauth' always signs in; 'oauth-app' only with the deployment's registration, else token fallback.
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

  const asking = openToken && !added;

  let trailing: ReactNode;

  if (added) {
    trailing = <PresetMenu preset={preset} word={word} dot={dot} onRemove={() => void remove()} />;
  } else if (asking) {
    trailing = (
      <button type="button" data-plugin-cancel onClick={() => setOpenToken(false)}
        aria-label={`Cancel ${preset.title}`} title="Cancel" className={PLUGIN_ACTION}>
        <XIcon size={14} />
      </button>
    );
  } else {
    trailing = (
      <button type="button" data-plugin-add onClick={connect} disabled={busy}
        aria-label={`Add ${preset.title}`} title={`Add ${preset.title}`}
        className={PLUGIN_ACTION}>
        <PlusIcon size={16} />
      </button>
    );
  }

  return (
    <PluginRow source={preset.id} state={word}
      name={preset.title} description={preset.description}
      tile={<BrandMark brand={brand} size={22} />}
      trailing={trailing}
      below={asking || err !== null ? (
        <div className="mt-2 space-y-1 pl-[52px]">
          {asking && (
            <div className="flex items-center gap-2">
              {/* Credential region: the marker keeps the value out of feedback screenshots. */}
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
          {err !== null && <p className="p-t-status p-danger">{err}</p>}
        </div>
      ) : undefined}
    />
  );
}

/** Fragment so the caller owns layout. An unconfigured `oauth-app` preset without a token
 *  fallback appears only once added; while loading it renders as configured. */
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
          <PresetRow key={preset.id} preset={preset} server={server}
            appConfigured={appConfigured} onChanged={onChanged} />
        );
      })}
    </>
  );
}
