/**
 * The one-click MCP presets — a row per `MCP_PRESETS` entry in the plugins
 * page's row grammar (the brand's mark on a tile, the name, the catalog's own
 * one line, one trailing control) so the Plugins list and the MCP panel read
 * as one surface.
 *
 * A row's state is the server row the account already holds: `preset_id` tags
 * it, so the same server the panel lists is what flips this row to Connected.
 * `oauth` presets connect in one click — the SDK answers an authorize URL,
 * which opens in a new tab (the same pattern the add form uses). `token`
 * presets expand one labelled field under the row. Removal is the ordinary
 * server remove, under the added row's own menu.
 */
import { useCallback, useRef, useState } from "react";
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

/** Each provider's official mark; the tile is the brand's own — a mark drawn
 *  in its own hex reads on the tile BrandMark picks for it in either theme.
 *  At 22px the tile it draws is the row's 40px. */
const PRESET_MARK: Record<McpPresetId, BrandName> = {
  github: "github",
  cloudflare: "cloudflare",
  google: "google",
};

/** The mark a stored server wears where a preset tagged it. `preset_id` is an
 *  arbitrary string on the wire, so the catalog is what resolves it. */
export function presetBrand(presetId: string | null): BrandName | undefined {
  const preset = presetId === null ? undefined : mcpPresetById(presetId);

  return preset === undefined ? undefined : PRESET_MARK[preset.id];
}

/** The one status a preset row says. Rows that are mid-flight still read as
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

/** An added row's one control: the state its server is in, and — on click —
 *  the two things a person does with it. */
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
  /** Whether the deployment carries this preset's registered OAuth app.
   *  `undefined` while the availability read is still open — optimistic, so
   *  a configured row never flickers into its fallback on first paint. */
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

  // Sign-in exists for every preset that answers an authorize URL: 'oauth'
  // unconditionally (the server registers the client itself), 'oauth-app'
  // only while the deployment carries the registration. Without it, an
  // oauth-app row asks for its token fallback instead.
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

  // The row's one control, by what the row can do next: remove what it holds,
  // drop the field it opened, or add itself.
  const trailing = added
    ? <PresetMenu preset={preset} word={word} dot={dot} onRemove={() => void remove()} />
    : asking
      ? (
        <button type="button" data-plugin-cancel onClick={() => setOpenToken(false)}
          aria-label={`Cancel ${preset.title}`} title="Cancel" className={PLUGIN_ACTION}>
          <XIcon size={14} />
        </button>
      )
      : (
        <button type="button" data-plugin-add onClick={connect} disabled={busy}
          aria-label={`Add ${preset.title}`} title={`Add ${preset.title}`}
          className={PLUGIN_ACTION}>
          <PlusIcon size={16} />
        </button>
      );

  return (
    <PluginRow source={preset.id} state={word}
      name={preset.title} description={preset.description}
      tile={<BrandMark brand={brand} size={22} />}
      trailing={trailing}
      below={asking || err !== null ? (
        <div className="mt-2 space-y-1 pl-[52px]">
          {asking && (
            <div className="flex items-center gap-2">
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
          {err !== null && <p className="p-t-status p-danger">{err}</p>}
        </div>
      ) : undefined}
    />
  );
}

/** One row per preset; rendered as a fragment so the caller's list owns the
 *  layout (the plugins page's two-column list, the panel's own column in
 *  account surfaces). An `oauth-app` preset with no configured app and no
 *  token fallback offers nothing, so its row only appears once the user has
 *  added the server another way — while the availability read is open the
 *  row renders as though configured rather than vanish on first paint. */
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
