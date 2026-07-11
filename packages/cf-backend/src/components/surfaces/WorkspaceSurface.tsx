/**
 * Workspace surface — the container view. Renders what the workspace IS
 * (object model §A2): its agents (the default orchestrator + team peers
 * spawnable via the `team` tool) and its file plane (the CompositeVFS mount
 * table via listMounts + the unified browser over it).
 *
 * The browser reuses FilesPane against the `workspace` executor: CompositeVFS
 * IS `Storage.vfs`, so readdir('/') lists live mounts and descending into
 * /local, /sandbox, /nimbus or /pc browses that environment. The mount table
 * above it adds what a bare listing can't show: reserved-but-unavailable
 * mounts, live state, and each mount's declared policy.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  RobotIcon, UsersThreeIcon, HardDrivesIcon, FolderOpenIcon,
  CircleIcon, ArrowsClockwiseIcon, LockSimpleIcon,
} from "@phosphor-icons/react";
import type { MountInfo } from "@proteus/core";
import type { Rpc, WorkspaceAgent } from "@/lib/protocol";
import { FilesPane } from "@/components/ExecutorsPanel";

const CONSISTENCY_HINT: Record<MountInfo["policy"]["consistency"], string> = {
  durable: "durable — survives everything",
  ephemeral: "ephemeral — dies with the container",
  "live-shared": "live — the user's own machine",
};

export interface WorkspaceSurfaceProps {
  rpc: Rpc;
}

export function WorkspaceSurface({ rpc }: WorkspaceSurfaceProps) {
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [mounts, setMounts] = useState<MountInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // Browser location: remount FilesPane at a mount's prefix when a row is
  // clicked, so the table doubles as root navigation.
  const [browseAt, setBrowseAt] = useState("/");

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

  const orchestrator = agents.find((a) => a.role === "orchestrator");
  const peers = agents.filter((a) => a.role === "peer");

  return (
    <div className="flex flex-col h-full -m-5">
      <div className="px-4 pt-4 pb-3 space-y-4 shrink-0 border-b p-border">
        {err && <div className="text-xs text-red-400 p-card rounded-lg px-3 py-2">{err}</div>}

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
              <Link key={p.name} to={`/workspace/${p.name}`} title={`Open workspace ${p.name}`}
                className="inline-flex items-center gap-1.5 rounded-md p-card hover:p-card-hover px-2.5 py-1.5 text-xs transition-colors">
                <RobotIcon size={13} className="p-text-3" />
                <span className="p-text-2 truncate max-w-48">{p.displayName || p.name}</span>
                <span className="text-[10px] p-text-3 rounded px-1 py-px border p-border">peer</span>
              </Link>
            ))}
            {agents.length === 0 && <span className="text-xs p-text-3">loading…</span>}
          </div>
        </section>

        {/* Mount table — the workspace file plane */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <HardDrivesIcon size={14} className="p-accent" />
            <span className="text-xs font-semibold p-text">Mounts</span>
            <span className="text-[10px] p-text-3">every environment as one filesystem — /local is the durable base</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {mounts.map((m) => {
              const disabled = !m.live;
              return (
                <button key={m.name} disabled={disabled}
                  onClick={() => setBrowseAt(m.prefix)}
                  title={disabled
                    ? `${m.prefix} — not available: ${m.reason ?? "environment offline"}`
                    : `Browse ${m.prefix} (${CONSISTENCY_HINT[m.policy.consistency]})`}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-mono transition-colors ${
                    disabled ? "p-text-3 border p-border border-dashed opacity-70 cursor-not-allowed"
                      : browseAt === m.prefix ? "p-accent-subtle p-accent"
                      : "p-card hover:p-card-hover p-text-2 cursor-pointer"
                  }`}>
                  <CircleIcon size={7} weight="fill" className={m.live ? "text-emerald-400" : "p-text-3"} />
                  {m.prefix}
                  {m.policy.readOnly && <LockSimpleIcon size={11} className="p-text-3" />}
                  <span className="text-[10px] p-text-3 font-sans">{m.live ? m.policy.consistency : "unavailable"}</span>
                </button>
              );
            })}
          </div>
        </section>

        <div className="flex items-center gap-2">
          <FolderOpenIcon size={14} className="p-accent" />
          <span className="text-xs font-semibold p-text">Files</span>
          <span className="text-[10px] p-text-3 font-mono">{browseAt}</span>
        </div>
      </div>

      {/* Unified browser over the CompositeVFS ('workspace' executor reads
          Storage.vfs directly). Keyed remount when jumping via the table. */}
      <div className="flex-1 min-h-0">
        <FilesPane key={browseAt} execName="workspace" rpc={rpc} initialPath={browseAt} />
      </div>
    </div>
  );
}
