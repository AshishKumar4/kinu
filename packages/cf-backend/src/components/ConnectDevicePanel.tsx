/**
 * Linking a machine, wherever the owner asks for it.
 *
 * The Environment tab, the Files drive and Account settings all used to answer
 * "connect my PC" with a link to Account settings → Devices. From a workspace
 * that is a page change in the middle of a job: the owner leaves the surface
 * they were working on to reach a button, and nothing brings them back. The
 * same panel now opens in place on every one of those surfaces.
 *
 * The panel owns four things and no fetching of its own:
 *   1. the disclosure, stated BEFORE anything is installed (`@kinu.run/core`,
 *      the same five sentences `kinu connect` prints);
 *   2. one registration — `POST /api/user/devices`, which composes the install
 *      command server-side;
 *   3. that command, verbatim, with a copy action;
 *   4. the wait, over the roster its caller already polls.
 *
 * `DeviceConnectFlow` is the whole decision half, and it is a plain object so
 * every claim about it is provable without a browser: one registration per
 * panel, a command rendered as the server wrote it, and a settle that fires
 * exactly when a device the account did not have reports connected.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { DesktopTowerIcon, PlugIcon, WarningIcon } from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo";
import { DEVICE_CONNECT_DISCLOSURE } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import { registerDevice, type UserDevice } from "@/lib/user-api";
import { Modal } from "@/components/ui/Modal";
import { CopyButton } from "@/components/ui/CopyButton";
import { FilledButton } from "@/components/ui/FilledButton";
import { inputCls } from "@/components/ui/form";
import { useDeviceRoster } from "@/hooks/use-device-roster";
import { LoadFailure } from "@/components/ui/LoadFailure";

/** Where the panel is in the one sequence it runs. */
export type ConnectState =
  /** Nothing has been asked for yet — the disclosure is on screen. */
  | { readonly kind: "ready" }
  | { readonly kind: "registering" }
  /**
   * The server handed over a command. `confirmable` is false when the roster
   * could not be read at that moment: with no baseline, an arriving machine is
   * indistinguishable from one the account already had, and the panel says so
   * rather than waiting on a signal it cannot compute.
   */
  | { readonly kind: "handed"; readonly command: string; readonly confirmable: boolean }
  | { readonly kind: "connected"; readonly device: UserDevice }
  | { readonly kind: "failed"; readonly message: string };

export interface ConnectFlowDeps {
  /** `POST /api/user/devices`. The server composes the one-liner; nothing here
   *  builds a command out of an origin. */
  register: (label?: string) => Promise<{ installCommand: string }>;
  /** The machine arrived and is connected. The surface closes the panel. */
  onConnected: (device: UserDevice) => void;
}

/**
 * The device that arrived while this panel waited: present in `devices`,
 * absent from `baseline`, and connected.
 *
 * `registerDevice` on the UserDO always inserts a row, so every `kinu connect`
 * run is a new id — an id the account did not have is the machine the owner
 * just linked. A null baseline means the roster was unreadable when the
 * command was handed over, and nothing can be concluded from the roster then.
 */
function arrivedDevice(
  devices: readonly UserDevice[],
  baseline: ReadonlySet<string> | null,
): UserDevice | null {
  if (baseline === null) return null;
  return devices.find((device) => !baseline.has(device.id) && device.connected) ?? null;
}

/**
 * One panel, one registration.
 *
 * The refusal is in `start` rather than in a disabled attribute, because a
 * disabled button is a rendering and this is a rule: a second ask — a double
 * click, a re-render, a second surface driving the same flow — must not mint a
 * second device row on the owner's account.
 */
export class DeviceConnectFlow {
  #state: ConnectState = { kind: "ready" };
  #baseline: ReadonlySet<string> | null = null;
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

  /**
   * Register this machine. `known` is the roster as the caller last read it —
   * null when that read has not landed or failed.
   */
  readonly start = async (label: string | undefined, known: readonly UserDevice[] | null): Promise<void> => {
    if (this.#state.kind !== "ready" && this.#state.kind !== "failed") return;
    this.#baseline = known === null ? null : new Set(known.map((device) => device.id));
    this.#publish({ kind: "registering" });
    try {
      const { installCommand } = await this.#deps.register(label);
      this.#publish({ kind: "handed", command: installCommand, confirmable: this.#baseline !== null });
    } catch (cause) {
      this.#publish({ kind: "failed", message: renderThrownChain({ cause }) });
    }
  };

  /** A roster read landed. */
  readonly observe = (devices: readonly UserDevice[]): void => {
    if (this.#state.kind !== "handed") return;
    const arrived = arrivedDevice(devices, this.#baseline);
    if (arrived === null) return;
    this.#publish({ kind: "connected", device: arrived });
    this.#deps.onConnected(arrived);
  };

  #publish(state: ConnectState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

export interface ConnectDevicePanelProps {
  flow: DeviceConnectFlow;
  /** The roster the caller polls, or null while it has never been read. */
  devices: readonly UserDevice[] | null;
  /** Why the roster could not be read, for the branch that cannot confirm. */
  rosterError?: string | null;
}

/**
 * The panel body. Given a flow, it renders that flow's one state and drives
 * the two transitions the owner can make.
 */
export function ConnectDevicePanel({ flow, devices, rosterError = null }: ConnectDevicePanelProps) {
  const state = useSyncExternalStore(flow.subscribe, flow.snapshot, flow.snapshot);
  const [label, setLabel] = useState("");

  // The only effect: hand every roster read to the flow, which decides whether
  // it is the arrival this panel is waiting for.
  useEffect(() => {
    if (devices !== null) flow.observe(devices);
  }, [devices, flow]);

  const start = useCallback(
    async () => { await flow.start(label.trim() || undefined, devices); },
    [flow, label, devices],
  );

  if (state.kind === "connected") {
    return (
      <div data-connect-state="connected" className="flex items-center gap-2 text-xs p-success">
        <DesktopTowerIcon size={14} /> {state.device.label} is connected.
      </div>
    );
  }

  if (state.kind === "handed") {
    return (
      <div data-connect-state="handed" className="space-y-3">
        <p className="text-xs p-text-2">
          Run this on the machine you want to connect. It installs the CLI, signs in as you, and
          starts the local daemon:
        </p>
        <div className="flex items-start gap-2 rounded-md p-fill border p-border p-3">
          <code data-connect-command className="font-mono p-meta p-text flex-1 break-all select-all leading-relaxed">
            {state.command}
          </code>
          <CopyButton value={state.command} what="the connect command" size={13} className="p-text-3 hover:p-text shrink-0" />
        </div>
        {state.confirmable ? (
          <div data-connect-waiting className="flex items-center gap-2 text-xs p-text-3">
            <Loader size="sm" /> Waiting for this machine to report in. This panel closes itself when it does.
          </div>
        ) : (
          <p data-connect-unconfirmable className="text-xs p-text-3">
            Your device list could not be read, so this panel cannot confirm the connection.
            Check Account settings → Devices once the command finishes.
          </p>
        )}
        {/* The icon is the only flex item; the prose is one, because a `code`
            span as a sibling flex item becomes its own column and cuts the
            sentence into three. */}
        <p className="p-meta p-text-3 flex items-start gap-1.5">
          <WarningIcon size={11} className="mt-0.5 shrink-0" />
          <span>
            Device secrets are written on that machine by <code className="font-mono">kinu connect</code>;
            they are not in this command. Closing this panel keeps the machine's place — it appears
            under Account settings → Devices as soon as it connects.
          </span>
        </p>
      </div>
    );
  }

  return (
    <div data-connect-state={state.kind} className="space-y-3">
      {/* Joined, not one paragraph per entry: the array is wrapped for an
          80-column terminal, and rendering its line breaks as paragraph breaks
          puts a gap in the middle of a sentence. Same words, reflowed. */}
      <p className="text-xs p-text-2 leading-relaxed">{DEVICE_CONNECT_DISCLOSURE.join(" ")}</p>
      {rosterError !== null && (
        <p className="p-meta p-danger">{rosterError}</p>
      )}
      {state.kind === "failed" && (
        <p data-connect-error className="text-xs p-danger">Could not register this device: {state.message}</p>
      )}
      <div className="flex items-center gap-2">
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Name this machine (optional)"
          aria-label="Device name"
          className={`${inputCls} text-xs`}
          disabled={state.kind === "registering"}
        />
        <FilledButton
          data-connect-start
          onClick={start}
          disabled={state.kind === "registering"}
          className="shrink-0"
        >
          <PlugIcon size={12} />
          {state.kind === "registering" ? "Generating…" : "Get the connect command"}
        </FilledButton>
      </div>
    </div>
  );
}

/**
 * The panel as a dialog over whatever surface asked for it, with the roster it
 * waits on. This is what a work surface mounts: the Environment card, the
 * Environment call-to-action and the Files drive's offline row all open this
 * one, and it closes itself the moment the machine reports in.
 */
export function ConnectDeviceDialog({ onClose }: { onClose: () => void }) {
  const { resource, reload } = useDeviceRoster();
  const devices = resource.status === "ready" ? resource.value : resource.status === "error" ? resource.last : null;
  const [flow] = useState(() => new DeviceConnectFlow({
    register: registerDevice,
    // The roster is what the surfaces behind this dialog read too, so there is
    // nothing to hand back: closing is the whole reaction.
    onConnected: onClose,
  }));
  return (
    <Modal title="Connect a machine" onClose={onClose} icon={<PlugIcon size={16} className="p-accent" />} maxWidthClass="max-w-lg">
      {resource.status === "error" && (
        <LoadFailure what="your devices" message={resource.message} onRetry={reload} />
      )}
      <ConnectDevicePanel flow={flow} devices={devices} />
    </Modal>
  );
}
