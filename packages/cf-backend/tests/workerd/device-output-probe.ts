/**
 * A function a workspace passes over DO RPC, called from the hub's device-socket message handler while that call is
 * still pending: the path a device command's output takes to its workspace (`UserDO.deviceRpc`'s `onOutput`). The bun
 * fakes have no RPC, so only workerd can say whether that stub answers from there.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { DeviceSocketHub, DEVICE_FEATURES, DEVICE_PROTOCOL_VERSION, deviceIdFromSocket, type DeviceExecOutput, type JsonValue } from '@kinu.run/core';
import { detach, logged } from '@kinu.run/core/obs';

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

  async exec(onOutput: (output: DeviceExecOutput) => Promise<void>): Promise<JsonValue | undefined> {
    const tunnel = this.devices.tunnel(DEVICE);

    if (tunnel === null) throw new Error('no device socket');

    return tunnel.rpc('exec', ['bun run build'], {
      onOutput: (output) => detach(logged('device.output_unsent', {
        doing: "handing a running command's output to its workspace", otherwise: 'unavailable',
      }, async () => { await onOutput(output); })),
    });
  }
}

/** The workspace: it passes the callback and keeps what reaches it. */
export class DeviceOutputWorkspaceProbeDO extends DurableObject<Cloudflare.Env> {
  async watch(hub: string): Promise<{ readonly answer: JsonValue | undefined; readonly heard: DeviceExecOutput[] }> {
    const heard: DeviceExecOutput[] = [];
    const devices = this.env.DEVICE_OUTPUT_HUB_PROBE.get(this.env.DEVICE_OUTPUT_HUB_PROBE.idFromName(hub));
    const answer = await devices.exec(async (output) => { heard.push(output); });

    // Copied at the answer: a frame that reached the workspace after it is not in it.
    return { answer, heard: [...heard] };
  }
}
