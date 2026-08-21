/**
 * Environment surface — WHERE the agent can act. The merge of the old
 * "Workspace" and "Devices" tabs: one chip per environment (liveness, policy,
 * consistency), with Files and Terminal as the panes over the selected one.
 *
 * There is no mount table and no composite filesystem — those went with
 * CompositeVFS. Each environment is its OWN filesystem addressed in its own
 * native paths, listed straight off the executor router
 * (core/src/read-models/files.ts listEnvironments), and the chip's namespace
 * (`sandbox.*`) is how the agent reaches it. The workspace is one of these
 * rows, not a base the others hang off. `workspace.*` is the authoritative
 * Nimbus session: its file browser, shell, processes and ports all address the
 * same bytes. There is no second Nimbus environment.
 *
 * Two things left. The Agents chips were an inert roster — informational only,
 * duplicating chat's SubordinateTabs, which is the roster that can actually
 * spawn and dismiss; they existed because `getWorkspaceAgents` was loaded
 * alongside `listMounts`. And previews left with their auto-focus effect:
 * Output owns looking at a running thing, and TWO rules racing to steer where a
 * new port lands was never a design, it was a bug.
 *
 * Liveness renders here ONCE: each chip's dot fuses the polled executor status
 * (exec plane) with the row's own live flag (file plane).
 *
 * Device registration/consent are settings, not work surfaces: registering or
 * revoking a PC lives in Account settings → Devices; the per-agent file-access
 * tier lives in Workspace settings. The offline PC row keeps only a connect
 * call-to-action pointing there.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Loader } from "@cloudflare/kumo";
import {
  HardDrivesIcon, CircleIcon,
  LockSimpleIcon, TerminalIcon, FolderOpenIcon, PlugIcon, GearSixIcon,
} from "@phosphor-icons/react";
import type { MountInfo } from "@kinu.run/core";
import type { ExecutorCommandResult, Rpc } from "@/lib/protocol";
import {
  capabilityLabel, executorForMount, executorLabel, isExecutorActive,
  partitionCapabilities, pickDefaultExecutor,
  type ExecutorInfo,
} from "@/lib/executors";
import type { ExecutorOutput } from "@/hooks/use-kinu";
import { FilesPane } from "@/components/FilesPane";
import { ExecutorTerminal } from "@/components/ExecutorTerminal";
import { listDevices, type UserDevice } from "@/lib/user-api";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { EmptyState } from "./shared";

const CONSISTENCY_HINT = {
  durable: "durable, survives everything",
  ephemeral: "ephemeral, dies with the container",
  "live-shared": "live, your own machine",
} satisfies Record<MountInfo["policy"]["consistency"], string>;

export interface EnvironmentSurfaceProps {
  rpc: Rpc;
  executors: ExecutorInfo[];
  executorOutputs: Map<string, ExecutorOutput[]>;
  lastActiveExecutor?: string | null;
  onExecute: (id: string, cmd: string) => Promise<ExecutorCommandResult>;
}

type Pane = { kind: "files" } | { kind: "terminal" };

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
  const { rpc, executors, executorOutputs, lastActiveExecutor, onExecute } = props;
  const [selected, setSelected] = useState<string | null>(null); // mount name
  const [pane, setPane] = useState<Pane>({ kind: "files" });

  const load = useCallback(() => rpc<MountInfo[]>("listMounts"), [rpc]);
  const { resource, reload } = useAsyncResource(load);
  // The table needs to know whether it is empty or merely unread — `length ===
  // 0` conflated the two, printing "loading…" under an error banner and
  // spinning forever on a workspace that genuinely has none.
  const loaded = lastValue(resource);
  const mounts = loaded ?? [];

  // Executor availability is polled live; when it flips (PC connects, sandbox
  // wakes) the environment rows' live flags are stale — refetch them.
  const availabilitySignature = executors.map((e) => `${e.name}:${e.available}:${e.status ?? ""}`).join("|");
  const lastSignature = useRef(availabilitySignature);
  useEffect(() => {
    if (lastSignature.current === availabilitySignature) return;
    lastSignature.current = availabilitySignature;
    reload();
  }, [availabilitySignature, reload]);

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

  return (
    <div className="flex flex-col h-full -m-5">
      <div className="px-4 pt-3 pb-3 space-y-3 shrink-0 border-b p-border">
        {resource.status === "error" && (
          <LoadFailure what="the environments" message={resource.message} onRetry={reload} className="p-card px-3 py-2" />
        )}

        {/* One identity-stable chip per environment. */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <HardDrivesIcon size={14} className="p-accent" />
            <span className="text-xs font-semibold p-text">Environments</span>
            <span className="text-[10px] p-text-3">each one its own filesystem, in its own paths</span>
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
                      : m.live ? "p-card p-card-hover p-text-2"
                      : "p-text-3 border p-border border-dashed p-card-hover"
                  }`}>
                  <CircleIcon size={7} weight="fill" className={mountDotClass(m, exec)} />
                  <span className="font-mono">{m.prefix}</span>
                  <span className="text-[10px] p-text-3">{executorLabel(executorForMount(m.name))}</span>
                  {m.policy.readOnly && <LockSimpleIcon size={11} className="p-text-3" />}
                  <span className="text-[10px] p-text-3">{m.live ? m.policy.consistency : "unavailable"}</span>
                </button>
              );
            })}
            {mounts.length === 0 && loaded !== null && <span className="text-xs p-text-3">No environments available.</span>}
            {mounts.length === 0 && resource.status === "loading" && <span className="text-xs p-text-3">loading…</span>}
          </div>
        </section>
      </div>

      {/* Selected environment pane. */}
      {selectedMount === null ? (
        <div className="flex-1 min-h-0" />
      ) : !selectedMount.live ? (
        <div className="flex-1 min-h-0">
          <UnavailableMount mount={selectedMount} exec={selectedExec} />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1 px-3 py-1.5 border-b p-border overflow-x-auto shrink-0">
            <span className="text-[10px] p-text-3 font-mono">{selectedMount.prefix}</span>
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

          <EnvironmentCapabilities selected={selectedExec} all={executors} />

          <div className="flex-1 min-h-0">
            {pane.kind === "files" && (
              /* The selected environment's own file view. It opens by asking
                 the environment where it starts — nothing here knows. */
              <FilesPane key={selectedMount.name} execName={executorForMount(selectedMount.name)} rpc={rpc} />
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

/**
 * What this environment can do, and where to go for what it cannot.
 *
 * These are the executor's DECLARED capabilities — the same set the provider
 * registers (`ExecutorProvider.capabilities`) and the same set the agent now
 * reads in its own execution-status block. They were rendered here as a strip
 * of raw ids with no reading and no absences, which is data rather than an
 * answer: nothing in `workspace javascript typescript shell fs_shared npm git
 * net_outbound net_inbound process_spawn process_long process_signal` tells
 * you the reason a big clone dies here is that this environment is a Worker.
 *
 * So the row is a comparison. Every capability any REACHABLE environment
 * offers is listed once; the ones this environment lacks name the environment
 * that has them, which is the only action available at this point — switch.
 * Capabilities nothing reachable offers are omitted: an absence you cannot do
 * anything about is not information.
 *
 * "Not here" is a MEASUREMENT and only measurements go under it. An environment
 * that could not answer for a capability declares it (`unmeasuredCapabilities`),
 * and those render on their own line — the tunnelled laptop said nothing about
 * python until it was probed, and "Not here: Runs Python" said something false
 * about the user's own machine.
 */
function EnvironmentCapabilities(
  { selected, all }: { selected: ExecutorInfo | undefined; all: readonly ExecutorInfo[] },
) {
  if (selected === undefined) return null;
  const { has, missing, unknown } = partitionCapabilities(selected, all);

  if (has.length === 0 && missing.length === 0 && unknown.length === 0) return null;
  return (
    <div className="px-3 py-1.5 border-b p-border shrink-0 space-y-1">
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-[10px] p-text-3 mr-1 shrink-0">{executorLabel(selected.name)} can</span>
        {has.map((capability) => (
          <span key={capability} data-capability-chip title={capability}
            className="text-[10px] px-1.5 py-0.5 rounded-full p-fill p-text-2">
            {capabilityLabel(capability)}
          </span>
        ))}
        {has.length === 0 && <span className="text-[10px] p-text-3 italic">nothing declared</span>}
      </div>
      {missing.length > 0 && (
        <div data-capability-absences className="text-[10px] p-text-3 leading-relaxed">
          Not here:{" "}
          {missing.map((row, i) => (
            <span key={row.capability}>
              {i > 0 && " · "}
              <span title={row.capability}>{capabilityLabel(row.capability)}</span>
              {" — "}
              <span className="p-text-2">{row.where.join(" or ")}</span>
            </span>
          ))}
        </div>
      )}
      {unknown.length > 0 && (
        <div data-capability-unmeasured className="text-[10px] p-text-3 leading-relaxed">
          Not measured:{" "}
          {unknown.map((capability, i) => (
            <span key={capability}>
              {i > 0 && " · "}
              <span title={capability}>{capabilityLabel(capability)}</span>
            </span>
          ))}
          {" — may work anyway; nothing here can tell."}
        </div>
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
        active ? "p-card p-text" : "p-text-2 p-card-hover"
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
  // `laptop`, not `pc`: rows are named by their EXECUTOR now, and the old
  // mount name left this branch — the whole connect call-to-action — dead.
  if (mount.name === "laptop") return <PcConnectCta />;
  const docs = mount.name === "sandbox"
      ? { text: "The Sandbox gives your agent a full Linux container with live previews. It isn't enabled on this deployment. Your agent can still use the Workspace shell and every capability listed for it.", href: "https://github.com/AshishKumar4/Proteus/blob/main/docs/EXECUTION-LAYER-SPEC.md" }
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

/** The laptop executor's connect call-to-action. Registration, revocation and
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
              Restart it on that machine with <code className="font-mono p-fill px-1 rounded-sm">kinu connect</code>.
            </>
          : "Link a laptop or PC to your account so your agents can run commands, read files, and serve previews on it, with your consent. One device serves all your agents."}
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
