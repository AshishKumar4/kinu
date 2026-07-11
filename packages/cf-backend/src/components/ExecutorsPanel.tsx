/**
 * Executors panel — connected execution devices with previews-as-tabs + right-aligned
 * Files + Terminal tabs.
 *
 * Layout:
 *
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │ ● Your PC  ○ Nimbus                            Workspace state      │ <- device sub-tabs
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
 * Disconnected or merely configured-on-demand executors stay out of the main
 * tab row. The agent's internal workspace is available from a subdued control
 * because it is state storage, not a user-facing execution device.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import {
  TerminalIcon, FolderOpenIcon, FolderIcon, FileIcon, ArrowsClockwiseIcon,
  ArrowLeftIcon, CopyIcon, WarningIcon, PlugIcon, TrashIcon, UploadSimpleIcon,
} from "@phosphor-icons/react";
import { Badge, Loader } from "@cloudflare/kumo";
import { ExecutorTerminal } from "./ExecutorTerminal";
import { PreviewFrame } from "./PreviewFrame";
import type { ExecutorOutput } from "../hooks/use-proteus";
import type { DirEntry } from "@/lib/protocol";
import { MAX_UPLOAD_BYTES, encodeBase64 } from "@/lib/files";
import { listDevices, registerDevice, revokeDevice, getCliSetup, type UserDevice } from "@/lib/user-api";
import { EmptyState } from "./surfaces/shared";

const EXECUTOR_LABELS: Record<string, string> = {
  sandbox:   "Sandbox",
  laptop:    "Your PC",
  workspace: "Workspace state",
  nimbus:    "Nimbus",
};

const EXECUTOR_ORDER = ["laptop", "nimbus", "sandbox", "workspace"];

type ExecutorLifecycleStatus = "not_configured" | "idle" | "active" | "disconnected" | "error";

interface ExecutorPanelInfo {
  name: string;
  kind: string;
  capabilities: string[];
  available: boolean;
  configured?: boolean;
  active?: boolean;
  status?: ExecutorLifecycleStatus;
  reason?: string;
}

function executorDotClass(exec: ExecutorPanelInfo): string {
  if (exec.status === "error") return "bg-red-500";
  if (exec.status === "active" || exec.active) return "bg-green-500";
  if (exec.status === "idle" || exec.configured) return "bg-sky-500";
  return "bg-stone-500";
}

function executorStatusLabel(exec: ExecutorPanelInfo): string {
  if (exec.status === "active" || exec.active) return "active";
  if (exec.status === "idle" || exec.configured) return "ready on demand";
  if (exec.status === "error") return exec.reason ? `error: ${exec.reason}` : "error";
  if (exec.status === "disconnected") return "disconnected";
  return "not configured";
}

function isVisibleExecutionDevice(exec: ExecutorPanelInfo, pinnedPortCount: number): boolean {
  if (exec.name === "workspace") return false;
  if (!exec.available) return false;
  if (exec.name === "laptop") return true;
  if (exec.name === "sandbox" && pinnedPortCount > 0) return true;
  return exec.active === true || exec.status === "active";
}

export interface ExecutorsPanelProps {
  executors: ExecutorPanelInfo[];
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
  const visibleDevices = useMemo(
    () => sorted.filter((exec) => isVisibleExecutionDevice(exec, props.pinnedPorts.length)),
    [sorted, props.pinnedPorts.length],
  );
  const workspaceInfo = sorted.find((exec) => exec.name === "workspace");

  const [activeExec, setActiveExec] = useState<string>(
    () => visibleDevices[0]?.name ?? "",
  );

  // Keep activeExec valid if executors list changes.
  useEffect(() => {
    const valid = new Set([
      ...visibleDevices.map((exec) => exec.name),
      ...(workspaceInfo ? [workspaceInfo.name] : []),
    ]);
    if (!activeExec || !valid.has(activeExec)) {
      setActiveExec(visibleDevices[0]?.name ?? "");
    }
  }, [visibleDevices, workspaceInfo, activeExec]);

  const activeInfo =
    visibleDevices.find(e => e.name === activeExec) ??
    (activeExec === "workspace" ? workspaceInfo : undefined);

  return (
    <div className="h-full flex flex-col">
      {/* Connected execution devices; workspace is tucked away as agent state. */}
      <div className="flex items-center gap-1 px-3 pt-2 pb-2 border-b p-border">
        {visibleDevices.length === 0 && (
          <span className="text-[11px] p-text-3">No execution device active yet</span>
        )}
        {visibleDevices.map(exec => (
          <button
            key={exec.name}
            onClick={() => setActiveExec(exec.name)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
              activeExec === exec.name ? "p-card p-text" : "p-text-2 hover:p-card-hover"
            }`}
            title={`${EXECUTOR_LABELS[exec.name] ?? exec.name} — ${executorStatusLabel(exec)}`}
          >
            <span className={`size-1.5 rounded-full ${executorDotClass(exec)}`} />
            {EXECUTOR_LABELS[exec.name] ?? exec.name}
          </button>
        ))}
        {workspaceInfo && (
          <button
            onClick={() => setActiveExec("workspace")}
            className={`ml-auto flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] transition-colors border ${
              activeExec === "workspace"
                ? "p-card p-text p-border"
                : "p-text-3 border-transparent hover:p-card-hover hover:p-text-2"
            }`}
            title="Internal Proteus workspace and state VFS"
          >
            <span className="size-1.5 rounded-full bg-stone-500" />
            Agent state
          </button>
        )}
      </div>

      {/* Per-executor view */}
      <div className="flex-1 min-h-0">
        {activeInfo ? (
          <PerExecutorView
            exec={activeInfo}
            outputs={props.outputs.get(activeInfo.name) ?? []}
            onExecute={(cmd) => props.onExecute(activeInfo.name, cmd)}
            rpc={props.rpc}
            agentName={props.agentName}
            pinnedPorts={activeInfo.name === "sandbox" ? props.pinnedPorts : []}
          />
        ) : (
          <NoDeviceActive />
        )}
      </div>
    </div>
  );
}

function NoDeviceActive() {
  const [devices, setDevices] = useState<UserDevice[] | null>(null);
  const [installCommand, setInstallCommand] = useState<string | null>(null);

  useEffect(() => {
    listDevices().then(setDevices).catch(() => setDevices([]));
    getCliSetup().then((s) => setInstallCommand(s.installCommand)).catch(() => null);
  }, []);

  if (devices === null) {
    return <div className="h-full flex items-center justify-center"><Loader size="base" /></div>;
  }

  if (devices.length > 0) {
    const labels = devices.map((d) => d.label).join(", ");
    return (
      <div className="h-full flex items-center justify-center overflow-y-auto p-6">
        <EmptyState
          icon={<PlugIcon size={26} />}
          title="Device offline"
          hint={<>
            {labels} {devices.length > 1 ? "are" : "is"} registered but the daemon is not running.
            Restart it on that machine with <code className="font-mono p-elevated px-1 rounded">proteus connect</code>.
          </>}
        />
      </div>
    );
  }

  return (
    <div className="h-full flex items-center justify-center overflow-y-auto p-6">
      <EmptyState
        icon={<PlugIcon size={26} />}
        title="No device connected"
        hint="Connect your PC so your agents can run commands, read files, and serve previews on it. Two steps from a terminal:"
      >
        <div className="mt-4 w-full max-w-md space-y-2">
          <CommandRow
            label="Install"
            command={installCommand ?? `curl -fsSL '${window.location.origin}/install.sh' | bash`}
          />
          <CommandRow label="Connect" command="proteus connect" />
        </div>
      </EmptyState>
    </div>
  );
}

function CommandRow({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border p-border p-2 text-left">
      <div className="w-14 shrink-0 text-[11px] p-text-3">{label}</div>
      <code className="font-mono text-[11px] p-text flex-1 truncate" title={command}>{command}</code>
      <button
        onClick={() => {
          navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1000);
          });
        }}
        className="px-2 py-1 rounded p-card hover:p-card-hover flex items-center gap-1 text-xs p-text-2"
      ><CopyIcon size={11} />{copied ? "copied" : "Copy"}</button>
    </div>
  );
}

// ── Per-executor view ────────────────────────────────────────────

interface PerExecutorViewProps {
  exec: ExecutorPanelInfo;
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
          <div className="text-[11px] p-text-3 italic">
            {exec.name === "sandbox"
              ? <>No exposed ports yet — when the agent calls <code className="font-mono p-elevated px-1 rounded">sandbox.exposePort(N)</code>, the preview will open here.</>
              : <>No exposed ports yet.</>}
          </div>
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
          return <PreviewFrame url={p.url} label={`:${p.port}${p.name ? ` · ${p.name}` : ''}`} />;
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

interface UploadState { name: string; status: "uploading" | "error"; error?: string }

/** General per-executor file manager: typed directory listing (getExecutorFiles)
 *  + a text viewer (readExecutorFile) + uploads (writeExecutorFile) via drop or
 *  the Upload button. Drives its own fetches off the stable `rpc`, so it only
 *  re-reads when the path or executor changes. Also reused by the Workspace
 *  surface as the unified CompositeVFS browser (execName "workspace",
 *  initialPath at a mount prefix). */
export function FilesPane({ execName, rpc, initialPath = "/" }: { execName: string; rpc: Rpc; initialPath?: string }) {
  const [path, setPath] = useState(initialPath);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);   // full path of file in the viewer
  const [file, setFile] = useState<FileState | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);

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

  // Sequential per-file upload into the current directory; failed files stay
  // listed with their error until the next upload batch replaces them.
  const uploadFiles = useCallback(async (files: FileList | null | undefined) => {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    setUploads(list.map((f) => ({ name: f.name, status: "uploading" as const })));
    for (const f of list) {
      try {
        if (f.size > MAX_UPLOAD_BYTES) throw new Error(`too large (max ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB)`);
        const b64 = encodeBase64(new Uint8Array(await f.arrayBuffer()));
        const r = await rpc("writeExecutorFile", [execName, joinPath(path, f.name), b64]) as { ok?: true; error?: string };
        if (r.error) throw new Error(r.error);
        setUploads((prev) => prev.filter((u) => u.name !== f.name));
      } catch (e) {
        setUploads((prev) => prev.map((u) => u.name === f.name
          ? { ...u, status: "error" as const, error: e instanceof Error ? e.message : String(e) }
          : u));
      }
    }
    await refresh(path);
  }, [rpc, execName, path, refresh]);

  const onListDragOver = useCallback((e: ReactDragEvent) => {
    if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); }
  }, []);
  const onListDragLeave = useCallback((e: ReactDragEvent) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setDragOver(false);
  }, []);
  const onListDrop = useCallback((e: ReactDragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    setDragOver(false);
    void uploadFiles(e.dataTransfer.files);
  }, [uploadFiles]);

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
        <input ref={uploadInputRef} type="file" multiple className="hidden"
          onChange={(e) => { void uploadFiles(e.currentTarget.files); e.currentTarget.value = ""; }} />
        <button
          onClick={() => uploadInputRef.current?.click()}
          className="ml-auto flex items-center gap-1 p-text-3 hover:p-text p-1"
          title={`Upload files to ${path}`}
        ><UploadSimpleIcon size={11} />Upload</button>
        <button
          onClick={() => viewing ? openFile(viewing) : refresh(path)}
          className="p-text-3 hover:p-text p-1"
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
        <div
          className={`flex-1 overflow-y-auto px-3 py-2 text-xs space-y-0.5 ${dragOver ? "outline-dashed outline-2 -outline-offset-2 outline-[var(--c-accent)]" : ""}`}
          onDragOver={onListDragOver} onDragLeave={onListDragLeave} onDrop={onListDrop}
        >
          {err && <div className="text-red-400">{err}</div>}
          {uploads.map((u) => (
            <div key={u.name} className="flex items-center gap-1.5 font-mono">
              {u.status === "uploading"
                ? <><Loader size="sm" /><span className="p-text-2 truncate">{u.name}</span><span className="p-text-3">uploading…</span></>
                : <><WarningIcon size={12} className="text-red-400 shrink-0" /><span className="p-text-2 truncate">{u.name}</span><span className="text-red-400 truncate">{u.error}</span></>}
            </div>
          ))}
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
            Nimbus is a lightweight DO-backed Linux env. To enable it, add the{" "}
            <code className="font-mono p-elevated px-1 rounded">NIMBUS_SESSION</code>
            {" "}Durable Object binding in{" "}
            <code className="font-mono p-elevated px-1 rounded">wrangler.jsonc</code>.
            It does not need endpoint or token secrets. The agent can still use{" "}
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
          <div className="text-sm font-medium p-text">Sandbox not configured</div>
          <p className="text-xs p-text-2 leading-relaxed">
            The full Cloudflare Sandbox needs a{" "}
            <code className="font-mono p-elevated px-1 rounded">Sandbox</code> Durable Object binding.
            Proteus exposes previews through its own authenticated path, so no per-agent subdomain is required.
            Without it the agent can still use Nimbus (if configured) or the in-VFS workspace shell.
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
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => { listDevices().then(setDevices).catch(() => setDevices([])); }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000); // running daemon flips connected within seconds
    return () => clearInterval(t);
  }, [refresh]);

  const issue = useCallback(async () => {
    setIssuing(true);
    setErr(null);
    try { const r = await registerDevice(); setInstall(r.installCommand); refresh(); }
    catch (e) { setErr(`Could not register device: ${(e as Error).message}`); }
    finally { setIssuing(false); }
  }, [refresh]);

  const revoke = useCallback(async (id: string) => {
    setErr(null);
    try { await revokeDevice(id); }
    catch (e) { setErr(`Could not revoke device: ${(e as Error).message}`); }
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
                <span className={`size-1.5 rounded-full shrink-0 ${d.connected ? "bg-emerald-500" : "bg-stone-500"}`} />
                <span className="font-medium p-text">{d.label}</span>
                {d.hostname && <span className="p-text-3 font-mono">{d.hostname}{d.os ? ` · ${d.os}` : ""}</span>}
                <span className="p-text-3 ml-auto">{d.connected ? "connected" : "offline"}</span>
                <button onClick={() => revoke(d.id)} title="Revoke device" className="p-text-3 hover:text-red-400"><TrashIcon size={13} /></button>
              </div>
            ))}
          </div>
        )}

        {err && <div className="text-xs text-red-400">{err}</div>}

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
