/**
 * Executors panel — per-executor view with previews-as-tabs + right-aligned
 * Files + Terminal tabs.
 *
 * Layout:
 *
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │ ● Sandbox  ○ Your PC  ○ Local                                       │ <- executor sub-tabs
 *   ├─────────────────────────────────────────────────────────────────────┤
 *   │ :8080 hello-world  :3000 api               │  Files    Terminal     │ <- preview tabs LEFT, utility RIGHT
 *   ├─────────────────────────────────────────────────────────────────────┤
 *   │                                                                     │
 *   │            [ active tab content — full-size iframe                  │
 *   │              or files tree or xterm terminal ]                      │
 *   │                                                                     │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * Auto-focus on new previews: when a fresh port appears in `pinnedPorts`
 * (length increases), the panel auto-switches to that preview tab.
 *
 * The "not connected" states (your PC, etc.) are shown when the executor
 * is unavailable, with inline action buttons (e.g. "Generate install
 * command" for the PC daemon).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TerminalIcon, FolderOpenIcon, FolderIcon, FileIcon, ArrowSquareOutIcon, ArrowsClockwiseIcon,
  ArrowLeftIcon, CopyIcon, EyeIcon, WarningIcon, PlugIcon, TrashIcon,
} from "@phosphor-icons/react";
import { Badge } from "@cloudflare/kumo";
import { ExecutorTerminal } from "./ExecutorTerminal";
import type { ExecutorOutput } from "../hooks/use-proteus";
import type { DirEntry } from "@/lib/protocol";
import { listDevices, registerDevice, revokeDevice, type UserDevice } from "@/lib/user-api";

const EXECUTOR_LABELS: Record<string, string> = {
  sandbox:   "Sandbox",
  laptop:    "Your PC",
  workspace: "Local",
  nimbus:    "Nimbus",
};

const EXECUTOR_ORDER = ["sandbox", "laptop", "workspace", "nimbus"];

export interface ExecutorsPanelProps {
  executors: Array<{ name: string; kind: string; capabilities: string[]; available: boolean }>;
  outputs: Map<string, ExecutorOutput[]>;
  onExecute: (id: string, cmd: string) => Promise<unknown>;
  agentName?: string;
  rpc: (method: string, args?: unknown[]) => Promise<unknown>;
  pinnedPorts: Array<{ port: number; url: string; name?: string }>;
}

export default function ExecutorsPanel(props: ExecutorsPanelProps) {
  const sorted = useMemo(() => {
    const arr = [...props.executors];
    arr.sort((a, b) => {
      const ia = EXECUTOR_ORDER.indexOf(a.name);
      const ib = EXECUTOR_ORDER.indexOf(b.name);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    return arr;
  }, [props.executors]);

  const [activeExec, setActiveExec] = useState<string>(
    () => sorted.find(e => e.available)?.name ?? sorted[0]?.name ?? "sandbox",
  );

  // Keep activeExec valid if executors list changes.
  useEffect(() => {
    if (!sorted.find(e => e.name === activeExec)) {
      setActiveExec(sorted.find(e => e.available)?.name ?? sorted[0]?.name ?? "sandbox");
    }
  }, [sorted, activeExec]);

  const activeInfo = sorted.find(e => e.name === activeExec);

  return (
    <div className="h-full flex flex-col">
      {/* Executor sub-tabs (Sandbox / Your PC / Local) */}
      <div className="flex items-center gap-1 px-3 pt-2 pb-2 border-b p-border">
        {sorted.map(exec => (
          <button
            key={exec.name}
            onClick={() => setActiveExec(exec.name)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
              activeExec === exec.name ? "p-card p-text" : "p-text-2 hover:p-card-hover"
            }`}
            title={exec.available ? `${exec.name} — connected` : `${exec.name} — not connected`}
          >
            <span className={`size-1.5 rounded-full ${exec.available ? "bg-green-500" : "bg-zinc-500"}`} />
            {EXECUTOR_LABELS[exec.name] ?? exec.name}
          </button>
        ))}
      </div>

      {/* Per-executor view */}
      <div className="flex-1 min-h-0">
        {activeInfo && (
          <PerExecutorView
            exec={activeInfo}
            outputs={props.outputs.get(activeInfo.name) ?? []}
            onExecute={(cmd) => props.onExecute(activeInfo.name, cmd)}
            rpc={props.rpc}
            agentName={props.agentName}
            pinnedPorts={activeInfo.name === "sandbox" ? props.pinnedPorts : []}
          />
        )}
      </div>
    </div>
  );
}

// ── Per-executor view ────────────────────────────────────────────

interface PerExecutorViewProps {
  exec: { name: string; kind: string; capabilities: string[]; available: boolean };
  outputs: ExecutorOutput[];
  onExecute: (cmd: string) => Promise<unknown>;
  rpc: (method: string, args?: unknown[]) => Promise<unknown>;
  agentName?: string;
  pinnedPorts: Array<{ port: number; url: string; name?: string }>;
}

type TabSelection =
  | { kind: 'preview'; port: number }
  | { kind: 'files' }
  | { kind: 'terminal' };

function PerExecutorView(props: PerExecutorViewProps) {
  const { exec, outputs, onExecute, rpc, agentName, pinnedPorts } = props;

  // Initial tab: first preview if any, else terminal.
  const [active, setActive] = useState<TabSelection>(() =>
    pinnedPorts.length > 0
      ? { kind: 'preview', port: pinnedPorts[0].port }
      : { kind: 'terminal' },
  );

  // Auto-focus newly-exposed ports. When the port set grows, switch to the
  // newest one; when the active port disappears, fall back gracefully.
  const prevPortsRef = useRef<number[]>([]);
  useEffect(() => {
    const cur = pinnedPorts.map(p => p.port);
    const prev = prevPortsRef.current;
    const added = cur.filter(p => !prev.includes(p));
    if (added.length > 0) {
      // Focus the newest port.
      setActive({ kind: 'preview', port: added[added.length - 1] });
    } else if (active.kind === 'preview' && !cur.includes(active.port)) {
      // Active port was removed; pick another or fall back to terminal.
      setActive(cur.length > 0 ? { kind: 'preview', port: cur[0] } : { kind: 'terminal' });
    }
    prevPortsRef.current = cur;
  }, [pinnedPorts, active]);

  // Not connected → connection-help card
  if (!exec.available) {
    return <ConnectionHelp exec={exec} rpc={rpc} agentName={agentName} />;
  }

  return (
    <div className="h-full flex flex-col">
      {/* Tabs row: previews on left, Files + Terminal right-aligned */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b p-border overflow-x-auto">
        {pinnedPorts.length === 0 && (
          <div className="text-[11px] p-text-3 italic">No exposed ports yet — when the agent calls <code className="font-mono p-elevated px-1 rounded">sandbox.exposePort(N)</code>, the preview will open here.</div>
        )}
        {pinnedPorts.map(p => (
          <PreviewTabButton
            key={p.port}
            port={p.port}
            label={p.name}
            active={active.kind === 'preview' && active.port === p.port}
            onClick={() => setActive({ kind: 'preview', port: p.port })}
          />
        ))}

        <div className="ml-auto flex items-center gap-1 shrink-0">
          <UtilityTabButton
            icon={FolderOpenIcon}
            label="Files"
            active={active.kind === 'files'}
            onClick={() => setActive({ kind: 'files' })}
          />
          <UtilityTabButton
            icon={TerminalIcon}
            label="Terminal"
            active={active.kind === 'terminal'}
            badge={outputs.length || undefined}
            onClick={() => setActive({ kind: 'terminal' })}
          />
        </div>
      </div>

      {/* Capabilities — what this runtime can actually do, so "which runtime
          for this job" isn't guesswork (npm / git / docker / net / …). */}
      {exec.capabilities.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap px-3 py-1 border-b p-border">
          <span className="text-[10px] p-text-3 mr-1">{exec.kind}</span>
          {exec.capabilities.map((c) => (
            <span key={c} className="text-[10px] px-1.5 py-0.5 rounded-full p-elevated p-text-3 font-mono">{c}</span>
          ))}
        </div>
      )}

      {/* Body — full-size active-tab content */}
      <div className="flex-1 min-h-0 relative">
        {active.kind === 'preview' && (() => {
          const p = pinnedPorts.find(x => x.port === active.port);
          if (!p) return <div className="p-6 text-xs p-text-3">Preview no longer available.</div>;
          return <PreviewPane port={p.port} url={p.url} name={p.name} />;
        })()}
        {active.kind === 'files' && (
          <FilesPane execName={exec.name} rpc={rpc} />
        )}
        {active.kind === 'terminal' && (
          <TerminalPane execName={exec.name} outputs={outputs} onExecute={onExecute} />
        )}
      </div>
    </div>
  );
}

// ── Tab buttons ──────────────────────────────────────────────────

function PreviewTabButton({ port, label, active, onClick }: {
  port: number; label?: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors group ${
        active ? "p-card p-text" : "p-text-2 hover:p-card-hover"
      }`}
      title={label ? `:${port} (${label})` : `:${port}`}
    >
      <span className="size-1.5 rounded-full bg-green-500" />
      <span className="font-mono">:{port}</span>
      {label && <span className="p-text-3 truncate max-w-[100px]">{label}</span>}
    </button>
  );
}

function UtilityTabButton({ icon: Icon, label, active, badge, onClick }: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors ${
        active ? "p-card p-text" : "p-text-2 hover:p-card-hover"
      }`}
    >
      <Icon size={12} className="opacity-70" />
      <span>{label}</span>
      {badge !== undefined && badge > 0 && (
        <Badge variant="secondary">{badge}</Badge>
      )}
    </button>
  );
}

// ── Panes ────────────────────────────────────────────────────────

function PreviewPane({ port, url, name }: { port: number; url: string; name?: string }) {
  const [reloadKey, setReloadKey] = useState(0);
  const [copied, setCopied] = useState(false);
  return (
    <div className="h-full flex flex-col bg-zinc-950">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b p-border bg-[var(--c-elevated,#18181b)]">
        <span className="size-1.5 rounded-full bg-green-500" />
        <span className="font-mono text-[11px] p-text-2">:{port}{name ? ` · ${name}` : ''}</span>
        <code className="text-[10px] p-text-3 font-mono truncate ml-2 flex-1">{url}</code>
        <button
          onClick={() => { navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}
          className="p-text-3 hover:p-text p-1 shrink-0"
          title="Copy URL"
        >{copied ? <span className="text-[10px]">copied</span> : <CopyIcon size={11} />}</button>
        <button
          onClick={() => setReloadKey(k => k + 1)}
          className="p-text-3 hover:p-text p-1 shrink-0"
          title="Reload"
        ><ArrowsClockwiseIcon size={11} /></button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="p-text-3 hover:p-text p-1 shrink-0"
          title="Open in new tab"
        ><ArrowSquareOutIcon size={11} /></a>
      </div>
      <iframe
        key={reloadKey}
        src={url}
        className="flex-1 w-full bg-white"
        title={`port-${port}`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
      />
    </div>
  );
}

function TerminalPane({ execName, outputs, onExecute }: {
  execName: string;
  outputs: ExecutorOutput[];
  onExecute: (cmd: string) => Promise<unknown>;
}) {
  return (
    <div className="h-full">
      <ExecutorTerminal executor={execName} outputs={outputs} onExecute={onExecute} />
    </div>
  );
}

type Rpc = (method: string, args?: unknown[]) => Promise<unknown>;
interface FileState { content?: string; truncated?: boolean; error?: string }

function fmtSize(n: number): string {
  if (n < 1024) return `${n}b`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}k`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/** General per-executor file manager: typed directory listing (getExecutorFiles)
 *  + a text viewer (readExecutorFile). Drives its own fetches off the stable
 *  `rpc`, so it only re-reads when the path or executor changes. */
function FilesPane({ execName, rpc }: { execName: string; rpc: Rpc }) {
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);   // full path of file in the viewer
  const [file, setFile] = useState<FileState | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const refresh = useCallback(async (p: string) => {
    setLoading(true);
    setErr(null);
    try {
      const r = await rpc("getExecutorFiles", [execName, p]) as { entries?: DirEntry[]; error?: string };
      if (r.error) { setErr(r.error); setEntries([]); }
      else setEntries(r.entries ?? []);
    } catch (e) { setErr((e as Error).message); setEntries([]); }
    finally { setLoading(false); }
  }, [rpc, execName]);

  const openFile = useCallback(async (full: string) => {
    setViewing(full);
    setFile(null);
    setFileLoading(true);
    try {
      setFile(await rpc("readExecutorFile", [execName, full]) as FileState);
    } catch (e) { setFile({ error: (e as Error).message }); }
    finally { setFileLoading(false); }
  }, [rpc, execName]);

  // Re-list on path/executor change; leaving any open file viewer.
  useEffect(() => { setViewing(null); refresh(path); }, [path, execName, refresh]);

  const segments = path === "/" ? [] : path.split("/").filter(Boolean);

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b p-border flex items-center gap-1 text-xs font-mono">
        <button onClick={() => setPath("/")} className="p-text-2 hover:p-text">/</button>
        {segments.map((seg, i) => (
          <span key={i} className="flex items-center gap-1">
            <button
              onClick={() => setPath('/' + segments.slice(0, i + 1).join('/'))}
              className="p-text-2 hover:p-text"
            >{seg}</button>
            {i < segments.length - 1 && <span className="p-text-3">/</span>}
          </span>
        ))}
        <button
          onClick={() => viewing ? openFile(viewing) : refresh(path)}
          className="ml-auto p-text-3 hover:p-text p-1"
          title="Refresh"
        ><ArrowsClockwiseIcon size={11} /></button>
      </div>

      {viewing ? (
        <FileViewer
          name={viewing.split("/").pop() ?? viewing}
          state={file}
          loading={fileLoading}
          onBack={() => setViewing(null)}
        />
      ) : (
        <div className="flex-1 overflow-y-auto px-3 py-2 text-xs space-y-0.5">
          {err && <div className="text-red-400">{err}</div>}
          {loading && <div className="p-text-3">Loading…</div>}
          {!loading && segments.length > 0 && (
            <button
              onClick={() => setPath('/' + segments.slice(0, -1).join('/'))}
              className="flex items-center gap-1.5 p-text-3 hover:p-text font-mono"
            ><FolderIcon size={12} /> ..</button>
          )}
          {entries.map((e) => (
            <button
              key={e.name}
              onClick={() => e.type === "dir" ? setPath(joinPath(path, e.name)) : openFile(joinPath(path, e.name))}
              className="flex items-center gap-1.5 w-full text-left font-mono p-text-2 hover:p-text"
            >
              {e.type === "dir"
                ? <FolderIcon size={12} className="text-sky-400 shrink-0" weight="fill" />
                : <FileIcon size={12} className="p-text-3 shrink-0" />}
              <span className="truncate flex-1">{e.name}</span>
              {e.type === "file" && e.size != null && <span className="p-text-3 shrink-0 tabular-nums">{fmtSize(e.size)}</span>}
            </button>
          ))}
          {!loading && entries.length === 0 && !err && (
            <div className="p-text-3 italic">(empty)</div>
          )}
        </div>
      )}
    </div>
  );
}

function FileViewer({ name, state, loading, onBack }: {
  name: string; state: FileState | null; loading: boolean; onBack: () => void;
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b p-border">
        <button onClick={onBack} className="p-text-3 hover:p-text" title="Back to files" aria-label="Back to files">
          <ArrowLeftIcon size={12} />
        </button>
        <span className="text-xs font-mono p-text-2 truncate">{name}</span>
        {state?.truncated && <span className="text-[10px] px-1 rounded p-elevated p-text-3 ml-auto shrink-0">truncated</span>}
      </div>
      <div className="flex-1 overflow-auto">
        {loading ? <div className="p-text-3 text-xs px-3 py-3">Loading…</div>
          : state?.error ? <div className="text-red-400 text-xs px-3 py-3">{state.error}</div>
          : <pre className="text-[11px] font-mono p-text-2 whitespace-pre px-3 py-2 leading-relaxed">{state?.content ?? ""}</pre>}
      </div>
    </div>
  );
}

// ── "Not connected" states ───────────────────────────────────────

function ConnectionHelp({ exec, rpc, agentName }: {
  exec: { name: string; kind: string };
  rpc: (method: string, args?: unknown[]) => Promise<unknown>;
  agentName?: string;
}) {
  if (exec.name === "laptop") {
    return <YourPcConnect />;
  }
  if (exec.name === "nimbus") {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-3">
          <PlugIcon size={28} className="p-text-3 mx-auto" />
          <div className="text-sm font-medium p-text">Nimbus not configured</div>
          <p className="text-xs p-text-2 leading-relaxed">
            Nimbus is a lightweight DO-backed Linux env. To enable it, set{" "}
            <code className="font-mono p-elevated px-1 rounded">NIMBUS_ENDPOINT</code>
            {" "}in <code className="font-mono p-elevated px-1 rounded">wrangler.jsonc</code>{" "}
            (and optionally{" "}
            <code className="font-mono p-elevated px-1 rounded">NIMBUS_TOKEN</code>
            {" "}as a wrangler secret). The agent can still use{" "}
            <code className="font-mono p-elevated px-1 rounded">sandbox</code> or{" "}
            <code className="font-mono p-elevated px-1 rounded">workspace</code> in the meantime.
          </p>
        </div>
      </div>
    );
  }
  if (exec.name === "sandbox") {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-3">
          <PlugIcon size={28} className="p-text-3 mx-auto" />
          <div className="text-sm font-medium p-text">Sandbox not provisioned</div>
          <p className="text-xs p-text-2 leading-relaxed">
            The full Cloudflare Sandbox needs a{" "}
            <code className="font-mono p-elevated px-1 rounded">Sandbox</code> DO binding plus a{" "}
            <code className="font-mono p-elevated px-1 rounded">PREVIEW_HOSTNAME</code>{" "}
            with wildcard DNS so preview URLs round-trip. Without it the agent can
            still use Nimbus (if configured) or the in-VFS workspace shell.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-3">
        <PlugIcon size={28} className="p-text-3 mx-auto" />
        <div className="text-sm font-medium p-text">{EXECUTOR_LABELS[exec.name] ?? exec.name} not connected</div>
        <p className="text-xs p-text-2 leading-relaxed">
          This executor needs a binding in <code className="font-mono p-elevated px-1 rounded">wrangler.jsonc</code>.
          See <code className="font-mono p-elevated px-1 rounded">docs/EXECUTION.md</code>.
        </p>
      </div>
    </div>
  );
}

function YourPcConnect() {
  const [devices, setDevices] = useState<UserDevice[] | null>(null);
  const [install, setInstall] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(() => { listDevices().then(setDevices).catch(() => setDevices([])); }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000); // running daemon flips connected within seconds
    return () => clearInterval(t);
  }, [refresh]);

  const issue = useCallback(async () => {
    setIssuing(true);
    try { const r = await registerDevice(); setInstall(r.installCommand); refresh(); }
    finally { setIssuing(false); }
  }, [refresh]);

  const revoke = useCallback(async (id: string) => {
    await revokeDevice(id).catch(() => {});
    refresh();
  }, [refresh]);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center gap-2">
          <TerminalIcon size={20} className="p-accent" />
          <h2 className="text-base font-semibold">Connect a device</h2>
        </div>
        <p className="text-sm p-text-2">
          Link a laptop or PC to <span className="font-medium">your account</span> — once connected,
          every one of your agents can use it (with your consent). The daemon opens one outbound
          WebSocket; no inbound ports, runs as your user, never root.
        </p>

        {devices && devices.length > 0 && (
          <div className="rounded-md border p-border overflow-hidden text-xs">
            {devices.map((d) => (
              <div key={d.id} className="flex items-center gap-2 px-3 py-2 border-b p-border last:border-0">
                <span className={`size-1.5 rounded-full shrink-0 ${d.connected ? "bg-emerald-500" : "bg-zinc-500"}`} />
                <span className="font-medium p-text">{d.label}</span>
                {d.hostname && <span className="p-text-3 font-mono">{d.hostname}{d.os ? ` · ${d.os}` : ""}</span>}
                <span className="p-text-3 ml-auto">{d.connected ? "connected" : "offline"}</span>
                <button onClick={() => revoke(d.id)} title="Revoke device" className="p-text-3 hover:text-red-400"><TrashIcon size={13} /></button>
              </div>
            ))}
          </div>
        )}

        {!install ? (
          <button
            onClick={issue}
            disabled={issuing}
            className="px-3 py-2 rounded-md p-accent-bg p-accent text-xs font-medium hover:opacity-90 disabled:opacity-50"
          >{issuing ? "Generating…" : "Connect a device"}</button>
        ) : (
          <div className="space-y-2">
            <p className="text-xs p-text-2">Paste this on the machine you want to connect. It installs the CLI, signs in, and starts the local daemon:</p>
            <div className="rounded-md p-elevated border p-border p-3 font-mono text-[11px] p-text break-all select-all leading-relaxed">
              {install}
            </div>
            <div className="flex items-center gap-2 text-xs">
              <button
                onClick={() => { navigator.clipboard.writeText(install).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}
                className="px-2 py-1 rounded p-card hover:p-card-hover flex items-center gap-1 p-text-2"
              ><CopyIcon size={11} />{copied ? "copied" : "Copy"}</button>
              <button onClick={() => setInstall(null)} className="p-text-3 hover:p-text">Done</button>
            </div>
            <p className="text-[11px] p-text-3 mt-1 flex items-center gap-1.5">
              <WarningIcon size={11} /> Device secrets are written locally by <code className="font-mono">proteus connect</code>; they are not shown in this command.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
