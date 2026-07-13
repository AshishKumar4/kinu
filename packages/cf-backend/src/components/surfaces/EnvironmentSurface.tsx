/**
 * Environment surface — WHERE the agent works. The merge of the old
 * "Workspace" and "Devices" tabs: the CompositeVFS mount table is the spine
 * (one chip per environment: liveness, policy, consistency) and Files /
 * Terminal / Previews are panes over the selected mount. The workspace's
 * agents (default orchestrator + team peers) sit in the header strip.
 *
 * Liveness renders here ONCE: each mount chip's dot fuses the polled executor
 * status (exec plane) with the mount's own live flag (file plane). Files
 * browse through the ONE FilesPane entry point over the composite ('workspace'
 * executor, keyed at the mount prefix), so /local, /sandbox, /nimbus and /pc
 * — including consented /pc descent — share a single browser.
 *
 * Device registration/consent are settings, not work surfaces: registering or
 * revoking a PC lives in Account settings → Devices; the per-agent file-access
 * tier lives in Workspace settings. The offline /pc mount keeps only a
 * connect call-to-action pointing there.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Loader } from "@cloudflare/kumo";
import {
  RobotIcon, UsersThreeIcon, HardDrivesIcon, CircleIcon, ArrowsClockwiseIcon,
  LockSimpleIcon, TerminalIcon, FolderOpenIcon, PlugIcon, GearSixIcon,
} from "@phosphor-icons/react";
import type { MountInfo } from "@proteus/core";
import type { Rpc, WorkspaceAgent } from "@/lib/protocol";
import {
  executorForMount, executorLabel, isExecutorActive, pickDefaultExecutor,
  type ExecutorInfo,
} from "@/lib/executors";
import type { ExecutorOutput } from "@/hooks/use-proteus";
import { FilesPane } from "@/components/FilesPane";
import { ExecutorTerminal } from "@/components/ExecutorTerminal";
import { PreviewFrame } from "@/components/PreviewFrame";
import { listDevices, type UserDevice } from "@/lib/user-api";
import type { PinnedPort } from "./OutputSurface";
import { EmptyState } from "./shared";

const CONSISTENCY_HINT: Record<MountInfo["policy"]["consistency"], string> = {
  durable: "durable — survives everything",
  ephemeral: "ephemeral — dies with the container",
  "live-shared": "live — the user's own machine",
};

export interface EnvironmentSurfaceProps {
  rpc: Rpc;
  executors: ExecutorInfo[];
  executorOutputs: Map<string, ExecutorOutput[]>;
  lastActiveExecutor?: string | null;
  onExecute: (id: string, cmd: string) => Promise<unknown>;
  pinnedPorts: PinnedPort[];
}

type Pane =
  | { kind: "files" }
  | { kind: "terminal" }
  | { kind: "preview"; port: number };

function mountDotClass(mount: MountInfo, exec: ExecutorInfo | undefined): string {
  if (!mount.live) return "p-text-3";
  if (exec?.status === "error") return "p-danger";
  if (exec && isExecutorActive(exec)) return "p-success";
  return exec?.status === "idle" || exec?.configured ? "p-info" : "p-success";
}

function mountTitle(mount: MountInfo, exec: ExecutorInfo | undefined): string {
  if (!mount.live) return `${mount.prefix} — not available: ${mount.reason ?? exec?.reason ?? "environment offline"}`;
  return `${mount.prefix} (${CONSISTENCY_HINT[mount.policy.consistency]})`;
}

export function EnvironmentSurface(props: EnvironmentSurfaceProps) {
  const { rpc, executors, executorOutputs, lastActiveExecutor, onExecute, pinnedPorts } = props;
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [mounts, setMounts] = useState<MountInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null); // mount name
  const [pane, setPane] = useState<Pane>({ kind: "files" });

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const [roster, table] = await Promise.all([
        rpc<WorkspaceAgent[]>("getWorkspaceAgents"),
        rpc<MountInfo[]>("listMounts"),
      ]);
      setAgents(roster);
      setMounts(table);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [rpc]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Executor availability is polled live; when it flips (PC connects, sandbox
  // wakes) the mount table's live flags are stale — refetch them.
  const availabilitySignature = executors.map((e) => `${e.name}:${e.available}:${e.status ?? ""}`).join("|");
  const lastSignature = useRef(availabilitySignature);
  useEffect(() => {
    if (lastSignature.current === availabilitySignature) return;
    lastSignature.current = availabilitySignature;
    void refresh();
  }, [availabilitySignature, refresh]);

  const execByName = useMemo(() => new Map(executors.map((e) => [e.name, e])), [executors]);

  // Default selection: the environment the agent last actually worked in.
  const defaultMount = useMemo(() => {
    const preferred = pickDefaultExecutor(executors, lastActiveExecutor);
    const match = mounts.find((m) => executorForMount(m.name) === preferred);
    return match?.name ?? mounts.find((m) => m.live)?.name ?? mounts[0]?.name ?? null;
  }, [executors, lastActiveExecutor, mounts]);
  const selectedName = selected ?? defaultMount;
  const selectedMount = mounts.find((m) => m.name === selectedName) ?? null;
  const selectedExec = selectedMount ? execByName.get(executorForMount(selectedMount.name)) : undefined;

  // Auto-focus newly-exposed ports: jump to the sandbox mount's newest
  // preview. On first render, ports that already exist only steer the view
  // when the user hasn't picked a mount themselves.
  const prevPortsRef = useRef<number[] | null>(null);
  useEffect(() => {
    const cur = pinnedPorts.map((p) => p.port);
    const prev = prevPortsRef.current;
    prevPortsRef.current = cur;
    if (prev === null) {
      if (cur.length > 0 && selected === null) {
        setSelected("sandbox");
        setPane({ kind: "preview", port: cur[cur.length - 1] });
      }
      return;
    }
    const added = cur.filter((p) => !prev.includes(p));
    if (added.length > 0) {
      setSelected("sandbox");
      setPane({ kind: "preview", port: added[added.length - 1] });
    } else if (pane.kind === "preview" && !cur.includes(pane.port)) {
      setPane(cur.length > 0 ? { kind: "preview", port: cur[0] } : { kind: "files" });
    }
  }, [pinnedPorts, pane, selected]);

  const orchestrator = agents.find((a) => a.role === "orchestrator");
  const peers = agents.filter((a) => a.role !== "orchestrator");
  const mountPorts = selectedMount?.name === "sandbox" ? pinnedPorts : [];

  return (
    <div className="flex flex-col h-full -m-5">
      <div className="px-4 pt-3 pb-3 space-y-3 shrink-0 border-b p-border">
        {err && <div className="text-xs p-danger p-card rounded-lg px-3 py-2">{err}</div>}

        {/* Agents — the actors inside this workspace */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <UsersThreeIcon size={14} className="p-accent" />
            <span className="text-xs font-semibold p-text">Agents</span>
            <span className="text-[10px] p-text-3">the workspace's default agent, plus team peers it can message or spawn</span>
            <button onClick={() => void refresh()} className="ml-auto p-text-3 hover:p-text p-1" title="Refresh">
              <ArrowsClockwiseIcon size={12} />
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {orchestrator && (
              <span className="inline-flex items-center gap-1.5 rounded-md p-card px-2.5 py-1.5 text-xs">
                <RobotIcon size={13} className="p-accent" />
                <span className="p-text font-medium truncate max-w-48">{orchestrator.displayName || orchestrator.name}</span>
                <span className="text-[10px] p-accent-subtle p-accent rounded px-1 py-px">orchestrator</span>
              </span>
            )}
            {peers.map((p) => (
              <span key={p.name} title={p.name}
                className="inline-flex items-center gap-1.5 rounded-md p-card px-2.5 py-1.5 text-xs">
                <RobotIcon size={13} className="p-text-3" />
                <span className="p-text-2 truncate max-w-48">{p.displayName || p.name}</span>
                <span className="text-[10px] p-text-3 rounded px-1 py-px border p-border">subordinate</span>
              </span>
            ))}
            {agents.length === 0 && <span className="text-xs p-text-3">loading…</span>}
          </div>
        </section>

        {/* Mount table — the spine. One chip per environment. */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <HardDrivesIcon size={14} className="p-accent" />
            <span className="text-xs font-semibold p-text">Environments</span>
            <span className="text-[10px] p-text-3">every environment as one filesystem — /local is the durable base</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {mounts.map((m) => {
              const exec = execByName.get(executorForMount(m.name));
              return (
                <button key={m.name}
                  onClick={() => { setSelected(m.name); setPane({ kind: "files" }); }}
                  title={mountTitle(m, exec)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors cursor-pointer ${
                    selectedName === m.name ? "p-accent-subtle p-accent"
                      : m.live ? "p-card hover:p-card-hover p-text-2"
                      : "p-text-3 border p-border border-dashed hover:p-card-hover"
                  }`}>
                  <CircleIcon size={7} weight="fill" className={mountDotClass(m, exec)} />
                  <span className="font-mono">{m.prefix}</span>
                  <span className="text-[10px] p-text-3">{executorLabel(executorForMount(m.name))}</span>
                  {m.policy.readOnly && <LockSimpleIcon size={11} className="p-text-3" />}
                  <span className="text-[10px] p-text-3">{m.live ? m.policy.consistency : "unavailable"}</span>
                </button>
              );
            })}
            {mounts.length === 0 && <span className="text-xs p-text-3">loading…</span>}
          </div>
        </section>
      </div>

      {/* Per-mount pane */}
      {selectedMount === null ? (
        <div className="flex-1 min-h-0" />
      ) : !selectedMount.live ? (
        <div className="flex-1 min-h-0">
          <UnavailableMount mount={selectedMount} exec={selectedExec} />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1 px-3 py-1.5 border-b p-border overflow-x-auto shrink-0">
            {mountPorts.map((p) => (
              <button key={p.port}
                onClick={() => setPane({ kind: "preview", port: p.port })}
                title={p.name ? `:${p.port} (${p.name})` : `:${p.port}`}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors ${
                  pane.kind === "preview" && pane.port === p.port ? "p-card p-text" : "p-text-2 hover:p-card-hover"
                }`}>
                <span className="size-1.5 rounded-full p-dot-success" />
                <span className="font-mono">:{p.port}</span>
                {p.name && <span className="p-text-3 truncate max-w-[100px]">{p.name}</span>}
              </button>
            ))}
            {selectedMount.name === "sandbox" && mountPorts.length === 0 && (
              <div className="text-[11px] p-text-3 italic">
                No exposed ports yet — when the agent calls <code className="font-mono p-elevated px-1 rounded">sandbox.exposePort(N)</code>, the preview will open here.
              </div>
            )}
            <div className="ml-auto flex items-center gap-1 shrink-0">
              <PaneTabButton icon={FolderOpenIcon} label="Files"
                active={pane.kind === "files"} onClick={() => setPane({ kind: "files" })} />
              {selectedExec && (
                <PaneTabButton icon={TerminalIcon} label="Terminal"
                  active={pane.kind === "terminal"}
                  badge={(executorOutputs.get(selectedExec.name) ?? []).length || undefined}
                  onClick={() => setPane({ kind: "terminal" })} />
              )}
            </div>
          </div>

          {/* Capabilities — what this runtime can actually do, so "which
              runtime for this job" isn't guesswork (npm / git / docker / …). */}
          {selectedExec && selectedExec.capabilities.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap px-3 py-1 border-b p-border shrink-0">
              <span className="text-[10px] p-text-3 mr-1">{selectedExec.kind}</span>
              {selectedExec.capabilities.map((c) => (
                <span key={c} className="text-[10px] px-1.5 py-0.5 rounded-full p-elevated p-text-3 font-mono">{c}</span>
              ))}
            </div>
          )}

          <div className="flex-1 min-h-0">
            {pane.kind === "preview" && (() => {
              const p = mountPorts.find((x) => x.port === pane.port);
              if (!p) return <div className="p-6 text-xs p-text-3">Preview no longer available.</div>;
              return <PreviewFrame url={p.url} label={`:${p.port}${p.name ? ` · ${p.name}` : ""}`} />;
            })()}
            {pane.kind === "files" && (
              /* ONE browser over the CompositeVFS, keyed at the mount prefix. */
              <FilesPane key={selectedMount.prefix} execName="workspace" rpc={rpc} initialPath={selectedMount.prefix} />
            )}
            {pane.kind === "terminal" && selectedExec && (
              <ExecutorTerminal
                executor={selectedExec.name}
                outputs={executorOutputs.get(selectedExec.name) ?? []}
                onExecute={(cmd) => onExecute(selectedExec.name, cmd)}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function PaneTabButton({ icon: Icon, label, active, badge, onClick }: {
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
      {badge !== undefined && badge > 0 && <Badge variant="secondary">{badge}</Badge>}
    </button>
  );
}

/* ── Unavailable environments ────────────────────────────────────── */

function UnavailableMount({ mount, exec }: { mount: MountInfo; exec: ExecutorInfo | undefined }) {
  if (mount.name === "pc") return <PcConnectCta />;
  const docs = mount.name === "nimbus"
    ? { text: "Nimbus is a lightweight Linux environment that runs inside Proteus. It isn't enabled on this deployment. Your agent can still use the Sandbox or its built-in workspace shell.", href: "https://github.com/AshishKumar4/Proteus/blob/main/docs/NIMBUS-INTEGRATION.md" }
    : mount.name === "sandbox"
      ? { text: "The Sandbox gives your agent a full Linux container with live previews. It isn't enabled on this deployment. Your agent can still use Nimbus (if available) or its built-in workspace shell.", href: "https://github.com/AshishKumar4/Proteus/blob/main/docs/EXECUTION-LAYER-SPEC.md" }
      : { text: mount.reason ?? exec?.reason ?? "This environment isn't enabled on this deployment.", href: "https://github.com/AshishKumar4/Proteus/blob/main/docs/EXECUTION-LAYER-SPEC.md" };
  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-3">
        <PlugIcon size={28} className="p-text-3 mx-auto" />
        <div className="text-sm font-medium p-text">{executorLabel(executorForMount(mount.name))} isn't available here</div>
        <p className="text-xs p-text-2 leading-relaxed">
          {docs.text}{" "}
          <a href={docs.href} target="_blank" rel="noreferrer" className="p-accent hover:underline">Learn more</a>
        </p>
      </div>
    </div>
  );
}

/** The /pc mount's connect call-to-action. Registration, revocation and
 *  consent live in Account settings → Devices — this only reads status to say
 *  the honest thing (daemon offline vs no device registered) and links there. */
function PcConnectCta() {
  const [devices, setDevices] = useState<UserDevice[] | null>(null);

  useEffect(() => {
    listDevices().then(setDevices).catch(() => setDevices([]));
  }, []);

  if (devices === null) {
    return <div className="h-full flex items-center justify-center"><Loader size="base" /></div>;
  }

  const registered = devices.length > 0;
  const labels = devices.map((d) => d.label).join(", ");
  return (
    <div className="h-full flex items-center justify-center overflow-y-auto p-6">
      <EmptyState
        icon={<PlugIcon size={26} />}
        title={registered ? "Device offline" : "Connect your PC"}
        hint={registered
          ? <>
              {labels} {devices.length > 1 ? "are" : "is"} registered but the daemon is not running.
              Restart it on that machine with <code className="font-mono p-elevated px-1 rounded">proteus connect</code>.
            </>
          : "Link a laptop or PC to your account so your agents can run commands, read files, and serve previews on it — with your consent, one device for all your agents."}
      >
        <Link to="/user/settings#devices"
          className="mt-4 inline-flex items-center gap-1.5 px-3 py-2 rounded-md p-accent-bg p-accent text-xs font-medium hover:opacity-90">
          <GearSixIcon size={13} />
          {registered ? "Manage devices in Account settings" : "Connect a device in Account settings"}
        </Link>
      </EmptyState>
    </div>
  );
}
