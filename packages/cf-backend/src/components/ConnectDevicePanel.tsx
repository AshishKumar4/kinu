import { Button } from "@/components/ui/Button";
import { Effect } from "effect";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { DesktopTowerIcon, PlugIcon, WarningIcon } from "@phosphor-icons/react";
import { Loader } from "@/components/ui/Loader";
import { DEVICE_CONNECT_DISCLOSURE, issuedDeviceConnected } from "@kinu.run/core";
import { renderThrownChain, detach } from "@kinu.run/core/obs";
import { registerDevice, type UserDevice } from "@/lib/user-api";
import { Modal } from "@/components/ui/Modal";
import { CopyButton } from "@/components/ui/CopyButton";
import { inputCls } from "@/components/ui/form";
import { useDeviceRoster } from "@/hooks/use-device-roster";
import { lastValue } from "@/hooks/use-async-resource";
import { LoadFailure } from "@/components/ui/LoadFailure";

type ConnectState =
  | { readonly kind: "ready" }
  | { readonly kind: "registering" }
  /** `deviceId` is the device the hub issued for this connect: the machine registers as it. */
  | { readonly kind: "handed"; readonly command: string; readonly deviceId: string }
  | { readonly kind: "connected"; readonly device: UserDevice }
  | { readonly kind: "failed"; readonly message: string };

interface ConnectFlowDeps {
  /** The server issues the device and composes the one-liner that registers as it. */
  register: (label?: string) => Promise<{ installCommand: string; deviceId: string }>;
  onConnected: (device: UserDevice) => void;
}

/** The refusal lives in `start`, not a disabled attribute: a second ask must not issue a second device. */
export class DeviceConnectFlow {
  #state: ConnectState = { kind: "ready" };
  readonly #listeners = new Set<() => void>();
  readonly #deps: ConnectFlowDeps;

  constructor(deps: ConnectFlowDeps) {
    this.#deps = deps;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => { this.#listeners.delete(listener); };
  };

  readonly snapshot = (): ConnectState => this.#state;

  readonly start = async (label: string | undefined): Promise<void> => {
    if (this.#state.kind !== "ready" && this.#state.kind !== "failed") return;
    this.#publish({ kind: "registering" });

    try {
      const { installCommand, deviceId } = await this.#deps.register(label);
      this.#publish({ kind: "handed", command: installCommand, deviceId });
    } catch (cause) {
      this.#publish({ kind: "failed", message: renderThrownChain({ cause }) });
    }
  };

  readonly observe = (devices: readonly UserDevice[]): void => {
    if (this.#state.kind !== "handed") return;
    const arrived = issuedDeviceConnected(devices, this.#state.deviceId);

    if (arrived === undefined) return;
    this.#publish({ kind: "connected", device: arrived });
    this.#deps.onConnected(arrived);
  };

  #publish(state: ConnectState): void {
    this.#state = state;

    for (const listener of this.#listeners) listener();
  }
}

interface ConnectDevicePanelProps {
  flow: DeviceConnectFlow;
  devices: readonly UserDevice[] | null;
  rosterError?: string | null;
  /** The workspace it is opened from, which the machine is granted to as it connects; null from Account settings. */
  workspace?: string | null;
}

export function ConnectDevicePanel({ flow, devices, rosterError = null, workspace = null }: ConnectDevicePanelProps) {
  const state = useSyncExternalStore(flow.subscribe, flow.snapshot, flow.snapshot);
  const [label, setLabel] = useState("");

  useEffect(() => {
    if (devices !== null) flow.observe(devices);
  }, [devices, flow]);

  const start = useCallback(async () => { await flow.start(label.trim() || undefined); }, [flow, label]);

  if (state.kind === "connected") {
    return (
      <div data-connect-state="connected" className="t-meta flex items-center gap-2 p-success">
        <DesktopTowerIcon size={14} /> {state.device.label} is connected.
      </div>
    );
  }

  if (state.kind === "handed") {
    return (
      <div data-connect-state="handed" className="space-y-3">
        <p className="t-meta p-text-2">
          Run this on the machine you want to connect. It installs the CLI, signs you in, and starts
          the daemon:
        </p>
        <div className="flex items-start gap-2 rounded-md p-fill border p-border p-3">
          <code data-connect-command className="t-code p-text flex-1 break-all select-all">
            {state.command}
          </code>
          <CopyButton value={state.command} what="the connect command" size={13} className="p-text-3 hover:p-text shrink-0" />
        </div>
        <div data-connect-waiting className="t-meta flex items-center gap-2 p-text-3">
          <Loader size="sm" /> Waiting for this machine. This panel closes when it connects.
        </div>
        {/* The prose is one flex item: a `code` sibling would become its own column and split the sentence. */}
        <p className="t-meta p-text-3 flex items-start gap-2">
          <WarningIcon size={11} className="mt-px shrink-0" />
          <span>
            <code className="font-mono">kinu connect</code> writes the device secrets on that machine.
            You can close this panel. The machine appears on the Devices page when it
            connects.
          </span>
        </p>
      </div>
    );
  }

  return (
    <div data-connect-state={state.kind} className="space-y-3">
      {/* Joined: the array is wrapped for an 80-column terminal, so its line breaks are not paragraph breaks. */}
      <p className="t-meta p-text-2">{DEVICE_CONNECT_DISCLOSURE.join(" ")}</p>
      {/* Said before the command is made (L111 #6): a machine connected from a workspace is that workspace's at once. */}
      {workspace !== null && (
        <p data-connect-grant className="t-meta p-text-1">
          Connected from here, it is <span className="font-medium">{workspace}</span>'s at once: its agents use this machine
          without asking, until you take it back under Account settings → Devices. Before it links, the command shows the folder it shares.
        </p>
      )}
      {rosterError !== null && (
        <p className="t-meta p-danger">{rosterError}</p>
      )}
      {state.kind === "failed" && (
        <p data-connect-error className="t-meta p-danger">Could not register this device: {state.message}</p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Name this machine (optional)"
          aria-label="Device name"
          className={`${inputCls} t-meta`}
          disabled={state.kind === "registering"}
        />
        <Button variant="primary" size="md"
          data-connect-start
          onClick={(...args: Parameters<typeof start>) => detach(Effect.promise(async () => start(...args)))}
          disabled={state.kind === "registering"}
          className="shrink-0"
        >
          <PlugIcon size={12} />
          {state.kind === "registering" ? "Generating…" : "Get the connect command"}
        </Button>
      </div>
    </div>
  );
}

/** `workspace`: opened from that workspace's Env tab, so the machine connects already granted to it. */
export function ConnectDeviceDialog({ workspace, onClose }: { workspace: string | undefined; onClose: () => void }) {
  const { resource, reload } = useDeviceRoster();
  const devices = lastValue(resource);

  const [flow] = useState(() => new DeviceConnectFlow({
    register: async (label) => registerDevice({ label, workspace }),
    onConnected: onClose,
  }));

  return (
    <Modal title="Connect a machine" onClose={onClose} icon={<PlugIcon size={16} className="p-accent-fg" />} maxWidthClass="max-w-lg">
      {resource.status === "error" && (
        <LoadFailure what="your devices" message={resource.message} onRetry={reload} />
      )}
      <ConnectDevicePanel flow={flow} devices={devices} workspace={workspace ?? null} />
    </Modal>
  );
}
