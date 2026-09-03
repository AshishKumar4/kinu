/**
 * Environment surface — WHERE the agent can act, for the OWNER's questions:
 * is it up, what is it, do files survive there, and what can I do about it.
 * One card per environment (status · name · durability · one line of what it
 * is · actions), with the selected environment's terminal below.
 *
 * What is deliberately NOT here: capability doctrine. "Runs JavaScript / Not
 * here: Runs Python" is the agent's own routing vocabulary — it stays in the
 * model-facing execution-status block (core/src/prompting/volatile-context.ts)
 * and never renders in user UI again.
 *
 * Browsing files moved to the Files tab, which walks the ONE composite plane
 * (workspace tree + /pc + /sandbox mounts). A card's Files action jumps there
 * at that environment's own root, so "where do this machine's files live" has
 * exactly one answer.
 *
 * Liveness renders here ONCE: each card's dot fuses the polled executor
 * status (exec plane) with the row's own live flag (file plane).
 *
 * Device registration/consent are settings, not work surfaces: the roster, the
 * revocations and the per-agent file-access tier live in Account settings and
 * in Workspace settings. Linking a machine is neither — it is a thing the
 * owner wants DONE, from here, without losing the surface they are on, so the
 * offline PC card opens the shared connect panel in place
 * (`components/ConnectDevicePanel`) rather than navigating to settings.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import {
  CircleIcon, FolderOpenIcon, LockSimpleIcon, PlugIcon, TerminalIcon,
} from "@phosphor-icons/react";
import { EXECUTOR_MOUNTS, type MountInfo } from "@kinu.run/core";
import type { ExecutorCommandResult, Rpc } from "@/lib/protocol";
import {
  executorDescription, executorLabel, isExecutorActive,
  pickDefaultExecutor,
  type ExecutorInfo,
} from "@/lib/executors";
import type { ExecutorOutput } from "@/hooks/use-kinu";
import { TerminalPane } from "@/components/TerminalPane";
import type { UserDevice } from "@/lib/user-api";
import { useDeviceRoster } from "@/hooks/use-device-roster";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { EmptyState } from "./shared";

/** Durability, in the words a user decides with. */
const CONSISTENCY_HINT = {
  durable: "Durable. Survives restarts.",
  ephemeral: "Ephemeral. Ends with the container.",
  "live-shared": "Files stay on your machine.",
} satisfies Record<MountInfo["policy"]["consistency"], string>;

export interface EnvironmentSurfaceProps {
  rpc: Rpc;
  executors: ExecutorInfo[];
  executorOutputs: Map<string, ExecutorOutput[]>;
  lastActiveExecutor?: string | null;
  onExecute: (id: string, cmd: string) => Promise<ExecutorCommandResult>;
  /** Jump to the Files tab at this composite-plane root ('/', '/pc', '/sandbox'). */
  onOpenFiles: (root: string) => void;
  /** Open the connect panel over this surface. Owned by the work surface, so
   *  the Files drive's offline row opens the same one. */
  onConnectDevice: () => void;
}

/** Where this environment's files live on the composite plane, or null for an
 *  environment the drive does not mount (a fork's parent). */
function filesRootFor(name: string): string | null {
  if (name === "workspace") return "/";
  const prefixes: Record<string, string | undefined> = EXECUTOR_MOUNTS;
  return prefixes[name] ?? null;
}

type StatusReading = { word: string; dotClass: string };

function statusOf(mount: MountInfo, exec: ExecutorInfo | undefined): StatusReading {
  if (!mount.live) return { word: "offline", dotClass: "p-text-3" };
  if (exec?.status === "error") return { word: "error", dotClass: "p-danger" };
  if (exec && isExecutorActive(exec)) return { word: "active", dotClass: "p-success" };
  if (exec?.status === "idle" || exec?.configured) return { word: "idle", dotClass: "p-info" };
  return { word: "live", dotClass: "p-success" };
}

export function EnvironmentSurface(props: EnvironmentSurfaceProps) {
  const { rpc, executors, executorOutputs, lastActiveExecutor, onExecute, onOpenFiles, onConnectDevice } = props;
  const [selected, setSelected] = useState<string | null>(null); // mount name
  // The workspace this surface's `rpc` is bound to — the terminal socket is
  // addressed by name, and it is the same workspace the route params name.
  const workspaceName = useParams().agentId ?? "";

  const load = useCallback(() => rpc<MountInfo[]>("listMounts"), [rpc]);
  const { resource, reload } = useAsyncResource(load);
  // The card grid needs to know whether it is empty or merely unread —
  // `length === 0` conflated the two.
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
    const match = mounts.find((m) => m.name === preferred);
    return match?.name ?? mounts.find((m) => m.live)?.name ?? mounts[0]?.name ?? null;
  }, [executors, lastActiveExecutor, mounts]);
  const selectedName = selected ?? defaultMount;
  const selectedMount = mounts.find((m) => m.name === selectedName) ?? null;
  const selectedExec = selectedMount ? execByName.get(selectedMount.name) : undefined;

  return (
    <div className="flex flex-col h-full -m-5">
      <div className="px-4 pt-3 pb-3 space-y-3 shrink-0 border-b p-border">
        {resource.status === "error" && (
          <LoadFailure what="the environments" message={resource.message} onRetry={reload} className="p-card px-3 py-2" />
        )}

        <section>
          <div className="flex items-center gap-2 mb-2">
            <span className="p-label">Environments</span>
          </div>
          <div className="grid gap-2 @[38rem]:grid-cols-2 @[64rem]:grid-cols-3">
            {mounts.map((m) => (
              <EnvironmentCard
                key={m.name}
                mount={m}
                exec={execByName.get(m.name)}
                active={selectedName === m.name}
                onSelect={() => setSelected(m.name)}
                onOpenFiles={onOpenFiles}
                onConnectDevice={onConnectDevice}
              />
            ))}
            {mounts.length === 0 && loaded !== null && <span className="text-xs p-text-3">No environments available.</span>}
            {mounts.length === 0 && resource.status === "loading" && <span className="text-xs p-text-3">loading…</span>}
          </div>
        </section>
      </div>

      {/* Selected environment's terminal. */}
      {selectedMount === null ? (
        <div className="flex-1 min-h-0" />
      ) : !selectedMount.live ? (
        <div className="flex-1 min-h-0">
          <UnavailableMount mount={selectedMount} exec={selectedExec} onConnectDevice={onConnectDevice} />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-b p-border shrink-0">
            <TerminalIcon size={12} className="p-text-3" />
            <span className="text-[10px] p-text-3">Terminal ·</span>
            <span className="text-[10px] p-text-3 font-mono">{executorLabel(selectedMount.name)}</span>
          </div>
          <div className="flex-1 min-h-0">
            {selectedExec ? (
              <TerminalPane
                workspace={workspaceName}
                executor={selectedExec.name}
                outputs={executorOutputs.get(selectedExec.name) ?? []}
                onExecute={(cmd) => onExecute(selectedExec.name, cmd)}
              />
            ) : (
              <div className="h-full flex items-center justify-center text-xs p-text-3">
                This environment has no command lane.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ── One environment, as a user reads it ─────────────────────────── */

function EnvironmentCard({ mount, exec, active, onSelect, onOpenFiles, onConnectDevice }: {
  mount: MountInfo;
  exec: ExecutorInfo | undefined;
  active: boolean;
  onSelect: () => void;
  onOpenFiles: (root: string) => void;
  onConnectDevice: () => void;
}) {
  const executor = mount.name;
  const status = statusOf(mount, exec);
  const filesRoot = filesRootFor(executor);
  // The device's own name where the user gave one; the generic label elsewhere.
  const title = executor === "laptop" && exec?.label ? exec.label : executorLabel(executor);
  return (
    <div
      data-env-card={mount.name}
      onClick={onSelect}
      className={`p-card rounded-lg px-3 py-2.5 space-y-1.5 cursor-pointer transition-colors border ${
        active ? "border-[rgba(224,164,88,.4)] bg-[rgba(224,164,88,.05)]" : "p-border hover:border-[var(--c-border-strong)]"
      } ${mount.live ? "" : "border-dashed"}`}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <CircleIcon size={7} weight="fill" className={`shrink-0 ${status.dotClass}`} />
        <span className={`text-[12.5px] font-medium truncate ${mount.live ? "p-text" : "p-text-3"}`}>{title}</span>
        {executor === "laptop" && exec?.label && (
          <span className="text-[10px] p-text-4 shrink-0">{executorLabel("laptop")}</span>
        )}
        {mount.policy.readOnly && (
          <span title="read-only" className="shrink-0 flex"><LockSimpleIcon size={11} className="p-text-3" /></span>
        )}
        <span data-env-status className="ml-auto text-[10px] p-text-3 shrink-0">{status.word}</span>
      </div>
      <div data-env-durability className="text-[10px] p-text-3">
        {mount.live ? CONSISTENCY_HINT[mount.policy.consistency] : mount.reason ?? exec?.reason ?? "not available on this deployment"}
      </div>
      <p className="text-[11px] p-text-2 leading-snug">
        {executorDescription(executor)}
      </p>
      <div className="flex items-center gap-1 pt-0.5" onClick={(e) => e.stopPropagation()}>
        {mount.live && filesRoot !== null && (
          <button
            data-env-files
            onClick={() => onOpenFiles(filesRoot)}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] p-text-2 p-fill hover:p-text"
            title={`Browse ${title}'s files at ${filesRoot}`}
          ><FolderOpenIcon size={12} />Files</button>
        )}
        {mount.live && (
          <button
            data-env-terminal
            onClick={onSelect}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] p-text-2 p-fill hover:p-text"
            title={`Open ${title}'s terminal`}
          ><TerminalIcon size={12} />Terminal</button>
        )}
        {!mount.live && executor === "laptop" && (
          <button
            data-env-connect
            onClick={onConnectDevice}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] p-accent p-fill hover:opacity-90"
            title="Link a machine to your account"
          ><PlugIcon size={12} />Connect</button>
        )}
      </div>
    </div>
  );
}

/* ── Unavailable environments ────────────────────────────────────── */

function UnavailableMount({ mount, exec, onConnectDevice }: {
  mount: MountInfo;
  exec: ExecutorInfo | undefined;
  onConnectDevice: () => void;
}) {
  // `laptop`, not `pc`: rows are named by their EXECUTOR now, and the old
  // mount name left this branch — the whole connect call-to-action — dead.
  if (mount.name === "laptop") return <PcConnectCta onConnectDevice={onConnectDevice} />;
  const docs = mount.name === "sandbox"
      ? { text: "This deployment has no Linux sandbox. Use the Workspace shell instead.", href: "https://github.com/AshishKumar4/kinu/blob/main/docs/EXECUTION-LAYER-SPEC.md" }
      : { text: mount.reason ?? exec?.reason ?? "This environment isn't enabled on this deployment.", href: "https://github.com/AshishKumar4/kinu/blob/main/docs/EXECUTION-LAYER-SPEC.md" };
  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-3">
        <PlugIcon size={28} className="p-text-3 mx-auto" />
        <div className="text-sm font-medium p-text">{executorLabel(mount.name)} isn't available here</div>
        <p className="text-xs p-text-2 leading-relaxed">
          {docs.text}{" "}
          <a href={docs.href} target="_blank" rel="noreferrer" className="p-accent hover:underline">Learn more</a>
        </p>
      </div>
    </div>
  );
}

/** The laptop executor's connect call-to-action. It reads the roster to say
 *  the honest thing — daemon offline versus no device registered — and opens
 *  the connect panel here rather than sending the owner to another page. */
function PcConnectCta({ onConnectDevice }: { onConnectDevice: () => void }) {
  const { resource, reload } = useDeviceRoster();
  const devices: UserDevice[] | null = lastValue(resource);

  if (devices === null && resource.status === "loading") {
    return <div className="h-full flex items-center justify-center"><Loader size="base" /></div>;
  }

  const live = (devices ?? []).filter((device) => device.revokedAt === null);
  const registered = live.length > 0;
  const labels = live.map((d) => d.label).join(", ");
  return (
    <div className="h-full flex items-center justify-center overflow-y-auto p-6">
      <div className="max-w-md w-full space-y-3">
        {resource.status === "error" && (
          <LoadFailure what="your devices" message={resource.message} onRetry={reload} />
        )}
        <EmptyState
          icon={<PlugIcon size={26} />}
          title={registered ? "Device offline" : "Connect your PC"}
          hint={registered
            ? <>
                {labels} {live.length > 1 ? "are" : "is"} offline. Run
                <code className="font-mono p-fill px-1 rounded-sm">kinu connect</code> on {live.length > 1 ? "those machines" : "that machine"}.
              </>
            : "Connect a laptop or PC. Every agent can use it after you approve workspace access."}
        >
          <button
            data-env-connect-cta
            onClick={onConnectDevice}
            className="mt-4 inline-flex items-center gap-1.5 px-3 py-2 rounded-md p-accent-bg p-accent text-xs font-medium hover:opacity-90">
            <PlugIcon size={13} />
            {registered ? "Connect another machine" : "Connect a machine"}
          </button>
        </EmptyState>
      </div>
    </div>
  );
}
