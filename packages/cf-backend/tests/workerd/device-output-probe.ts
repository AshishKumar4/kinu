/**
 * A function a workspace passes over DO RPC, called from the hub's device-socket message handler while that call is
 * still pending: the path a device command's output takes to its workspace (`UserDO.deviceRpc`'s `onOutput`). The bun
 * fakes have no RPC, so only workerd can say whether that stub answers from there. The call is framed by the product's
 * own `watchedOutput`, as `UserDO.deviceRpc` frames it.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { DeviceSocketHub, DEVICE_FEATURES, DEVICE_PROTOCOL_VERSION, deviceIdFromSocket, watchedOutput, type DeviceExecOutput, type JsonValue } from '@kinu.run/core';
import { createRecordingLogger, setDiagnosticsSink } from '@kinu.run/core/obs';

const DEVICE = 'dev-probe';

/** The hub as `UserDO` wires it: the device's hibernatable socket, its tunnel, and `deviceRpc`'s `onOutput`. */
export class DeviceOutputHubProbeDO extends DurableObject<Cloudflare.Env> {
  private readonly devices = new DeviceSocketHub(this.ctx);

  override async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    this.devices.accept(DEVICE, pair[1]);
    this.devices.hello(DEVICE, DEVICE_PROTOCOL_VERSION, DEVICE_FEATURES);

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const deviceId = deviceIdFromSocket(ws);

    // The daemon sends text frames.
    if (deviceId !== null) this.devices.handleMessage(deviceId, v.parse(v.string(), message));
  }

  /** The call as `UserDO.deviceRpc` frames it; with `losses`, it answers once that many outputs were logged as unsent. */
  async exec(onOutput: ((output: DeviceExecOutput) => Promise<void>) | null, losses = 0): Promise<{ readonly answer: JsonValue | undefined; readonly unsent: number }> {
    const tunnel = this.devices.tunnel(DEVICE);

    if (tunnel === null) throw new Error('no device socket');
    const recording = createRecordingLogger();
    const restore = setDiagnosticsSink(recording);
    const unsent = (lines: readonly { readonly event: string }[]) => lines.filter((line) => line.event === 'device.output_unsent').length;

    try {
      const answer = await tunnel.rpc('exec', ['bun run build'], watchedOutput(onOutput === null ? undefined : { onOutput }));
      await recording.until((lines) => unsent(lines) >= losses);

      return { answer, unsent: unsent(recording.emitted) };
    } finally {
      restore();
    }
  }
}

/** The workspace: it passes the callback and keeps what reaches it, watches nothing, or cannot take the output. */
export class DeviceOutputWorkspaceProbeDO extends DurableObject<Cloudflare.Env> {
  async watch(hub: string, mode: 'keep' | 'none' | 'reset' = 'keep'): Promise<{ readonly answer: JsonValue | undefined; readonly heard: DeviceExecOutput[]; readonly unsent: number }> {
    const heard: DeviceExecOutput[] = [];
    const devices = this.env.DEVICE_OUTPUT_HUB_PROBE.get(this.env.DEVICE_OUTPUT_HUB_PROBE.idFromName(hub));

    const callback = mode === 'none' ? null : async (output: DeviceExecOutput) => {
      if (mode === 'reset') throw new Error('the workspace was reset');
      heard.push(output);
    };

    const { answer, unsent } = await devices.exec(callback, mode === 'reset' ? 2 : 0);

    // Copied at the answer: a frame that reached the workspace after it is not in it.
    return { answer, heard: [...heard], unsent };
  }
}
