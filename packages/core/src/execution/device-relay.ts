// The device relay (docs/DEPLOYMENT.md § Codex from the cloud).
import * as v from 'valibot';
import { base64ToBytes } from '../utils/base64';
import { settle, tolerate } from '../obs/effect';
import { KinuError, toKinuError } from '../obs/error';
import { diagnostics } from '../obs/log';
import { Effect } from 'effect';
import { DEVICE_FRAMES, DEVICE_METHOD } from './device-protocol';
import type { DeviceCancelResult } from './device-tunnel';

export const DEVICE_RELAY = {
  method: DEVICE_METHOD.codexRelay,
  head: DEVICE_FRAMES.relayHead,
  body: DEVICE_FRAMES.relayBody,
} as const;

export type RelayedProvider = 'codex' | 'chatgpt';

export const DEVICE_CHATGPT = { status: DEVICE_METHOD.chatgptStatus, signIn: DEVICE_METHOD.chatgptSignIn, signOut: DEVICE_METHOD.chatgptSignOut } as const;

export type DeviceChatGptMethod = (typeof DEVICE_CHATGPT)[keyof typeof DEVICE_CHATGPT];

export const DeviceChatGptStatusSchema = v.object({
  signedIn: v.boolean(),
  email: v.nullable(v.string()),
  planEnabled: v.boolean(),
  planDeclined: v.optional(v.boolean(), false),
  pending: v.boolean(),
  lastFailure: v.nullable(v.string()),
  firstSignIn: v.boolean(),
});

export type DeviceChatGptStatus = v.InferOutput<typeof DeviceChatGptStatusSchema>;

/** `device <label>` or `relay`. */
export const EGRESS_ROUTE_HEADER = 'x-kinu-egress';

const HeaderPairsSchema = v.array(v.tuple([v.string(), v.string()]));

export interface DeviceRelayRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string | null;
}

const RelayFrameSchema = v.variant('type', [
  v.object({ type: v.literal(DEVICE_RELAY.head), relay: v.string(), status: v.number(), headers: HeaderPairsSchema }),
  v.object({ type: v.literal(DEVICE_RELAY.body), relay: v.string(), data: v.string() }),
]);

export type DeviceRelayFrame = v.InferOutput<typeof RelayFrameSchema>;

export function parseDeviceRelayFrame(data: string): DeviceRelayFrame | null {
  const parsed = v.safeParse(RelayFrameSchema, tolerate(() => JSON.parse(data), 'malformed-input'));

  return parsed.success ? parsed.output : null;
}

interface OpenRelay {
  readonly deviceId: string;
  readonly stop: () => Promise<void>;
  /** The reader left: the machine is told to stop, and later frames find no entry. */
  readonly abandon: () => Promise<void>;
  readonly head: ReturnType<typeof Promise.withResolvers<Effect.Effect<Response, KinuError>>>;
  body: ReadableStreamDefaultController<Uint8Array> | null;
  headed: boolean;
}

/** A frame from any machine but the one asked is dropped. */
export class DeviceRelays {
  readonly #open = new Map<string, OpenRelay>();

  open(input: {
    readonly id: string;
    readonly deviceId: string;
    readonly cancel: () => Promise<DeviceCancelResult | null>;
    readonly answered: () => Promise<PromiseSettledResult<unknown>>;
  }): Promise<Response> {
    const fail = (cause: KinuError): void => {
      if (this.#open.get(input.id) !== entry) return;
      this.#open.delete(input.id);

      if (entry.headed) entry.body?.error(cause);
      else entry.head.resolve(Effect.fail(cause));
    };

    const entry: OpenRelay = {
      deviceId: input.deviceId, head: Promise.withResolvers<Effect.Effect<Response, KinuError>>(), body: null, headed: false,
      stop: async () => {
        fail(new KinuError('cancelled', 'the caller stopped the request'));
        await input.cancel();
      },
      abandon: async () => {
        if (this.#open.get(input.id) !== entry) return;
        this.#open.delete(input.id);
        await input.cancel();
      },
    };

    this.#open.set(input.id, entry);

    const ended = input.answered().then((outcome) => {
      if (this.#open.get(input.id) !== entry) return entry.head.promise;

      if (outcome.status === 'rejected') {
        const reason: unknown = outcome.reason;
        fail(reason instanceof KinuError ? reason : toKinuError({ doing: 'relaying a call through the machine', cause: reason, otherwise: 'unavailable' }));
      } else if (!entry.headed) fail(new KinuError('io', 'the machine ended the relay without an answer'));
      else {
        this.#open.delete(input.id);
        entry.body?.close();
      }

      return entry.head.promise;
    });

    return settle(Effect.flatMap(Effect.promise(() => Promise.race([entry.head.promise, ended])), (answer) => answer));
  }

  async cancel(id: string): Promise<void> {
    await this.#open.get(id)?.stop();
  }

  receive(deviceId: string, frame: DeviceRelayFrame): void {
    const entry = this.#open.get(frame.relay);

    if (entry?.deviceId !== deviceId) {
      diagnostics.event('device.relay_orphan_frame_dropped', { device: deviceId, reason: 'unclaimed_relay' });

      return;
    }

    if ('status' in frame) {
      if (entry.headed) {
        diagnostics.event('device.relay_duplicate_head_dropped', { device: deviceId, reason: 'duplicate_relay_head' });

        return;
      }

      entry.headed = true;
      const body = new ReadableStream<Uint8Array>({ start: (controller) => { entry.body = controller; }, cancel: entry.abandon });
      entry.head.resolve(Effect.succeed(new Response(nullBodyStatus(frame.status) ? null : body, { status: frame.status, headers: frame.headers })));

      return;
    }

    if (entry.headed) entry.body?.enqueue(base64ToBytes(frame.data));
    else diagnostics.event('device.relay_premature_body_dropped', { device: deviceId, reason: 'relay_body_before_head' });
  }
}

function nullBodyStatus(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}
