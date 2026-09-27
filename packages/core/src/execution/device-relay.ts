// The device relay (docs/DEPLOYMENT.md § Codex egress). Frame names are mirrored in packages/pc-agent/src/index.js.
import * as v from 'valibot';
import { base64ToBytes } from '../utils/base64';
import { tolerate } from '../obs/expected-failure';
import { toKinuError } from '../obs/error';

export const DEVICE_RELAY = {
  method: 'codexRelay',
  head: 'RELAY_HEAD',
  body: 'RELAY_BODY',
  cancel: 'RELAY_CANCEL',
} as const;

/** Names the route a Codex call took, `device <label>` or `relay`. */
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
  readonly stop: () => void;
  /** The reader left: the machine is told to stop, and later frames find no entry. */
  readonly abandon: () => void;
  readonly head: ReturnType<typeof Promise.withResolvers<Response>>;
  body: ReadableStreamDefaultController<Uint8Array> | null;
  headed: boolean;
}

/** A frame from any machine but the one asked is dropped. */
export class DeviceRelays {
  readonly #open = new Map<string, OpenRelay>();

  open(input: {
    readonly id: string;
    readonly deviceId: string;
    readonly cancel: () => void;
    readonly answered: () => Promise<PromiseSettledResult<unknown>>;
  }): Promise<Response> {
    const fail = (cause: Error): void => {
      if (this.#open.get(input.id) !== entry) return;
      this.#open.delete(input.id);

      if (entry.headed) entry.body?.error(cause);
      else entry.head.reject(cause);
    };

    const entry: OpenRelay = {
      deviceId: input.deviceId, head: Promise.withResolvers<Response>(), body: null, headed: false,
      stop: () => {
        input.cancel();
        fail(new DOMException('the caller stopped the request', 'AbortError'));
      },
      abandon: () => {
        if (this.#open.get(input.id) !== entry) return;
        this.#open.delete(input.id);
        input.cancel();
      },
    };

    this.#open.set(input.id, entry);

    const ended = input.answered().then((outcome) => {
      if (this.#open.get(input.id) !== entry) return entry.head.promise;

      if (outcome.status === 'rejected') {
        const reason: unknown = outcome.reason;
        fail(reason instanceof Error ? reason : toKinuError({ doing: 'relaying a call through the machine', cause: reason, otherwise: 'unavailable' }));
      } else if (!entry.headed) fail(new Error('the machine ended the relay without an answer'));
      else {
        this.#open.delete(input.id);
        entry.body?.close();
      }

      return entry.head.promise;
    });

    return Promise.race([entry.head.promise, ended]);
  }

  cancel(id: string): void {
    this.#open.get(id)?.stop();
  }

  receive(deviceId: string, frame: DeviceRelayFrame): void {
    const entry = this.#open.get(frame.relay);

    if (entry?.deviceId !== deviceId) return;

    if (frame.type === DEVICE_RELAY.head) {
      if (entry.headed) return;
      entry.headed = true;
      const body = new ReadableStream<Uint8Array>({ start: (controller) => { entry.body = controller; }, cancel: entry.abandon });
      entry.head.resolve(new Response(nullBodyStatus(frame.status) ? null : body, { status: frame.status, headers: frame.headers }));

      return;
    }

    if (entry.headed) entry.body?.enqueue(base64ToBytes(frame.data));
  }
}

function nullBodyStatus(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}
