import protocol from './device-protocol.json';
import * as v from 'valibot';
import { ERROR_CODES, KinuError, type ErrorCode } from '../obs/error';

export const DEVICE_PROTOCOL_VERSION = protocol.version;

export const DEVICE_VERSION_REFUSAL_CLOSE = protocol.versionRefusalClose;

/** A terminal's window bound per axis, the daemon's and the hub's: the kernel carries each as an `unsigned short`, and a
 *  thousand cells on a side is past any real display, so more is a malformed frame. */
export const DEVICE_PTY_MAX_AXIS = protocol.ptyMaxAxis;

export const DEVICE_FRAMES = protocol.frames;

export const DEVICE_ERRORS = protocol.errors;

export const DEVICE_UPDATE_REQUIRED = protocol.updateRequired;

export const DEVICE_METHOD = Object.fromEntries(Object.keys(protocol.methods).map((method) => [method, method]));

export type DeviceMethod = keyof typeof protocol.methods;

/** Every method a current daemon answers, as its HELLO lists them. */
export const DEVICE_FEATURES: readonly string[] = Object.keys(protocol.methods);

/** What every HELLO opens with: the protocol it speaks and the methods it answers, which decide the rest. */
export const DeviceHelloHeadSchema = v.object({
  type: v.literal(DEVICE_FRAMES.hello),
  protocolVersion: v.number(),
  features: v.array(v.string()),
});

/**
 * What a daemon on the protocol before this one is read for: whether, and to which build, it is pushed the update.
 * `version` is absent on a daemon with no build stamp, which is pushed nothing.
 */
export const DeviceUpdateHelloSchema = v.object({
  ...DeviceHelloHeadSchema.entries,
  os: v.string(),
  arch: v.string(),
  version: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
  updateCheck: v.boolean(),
});

/** A current daemon's HELLO, every field it sends. */
export const DeviceHelloSchema = v.object({
  ...DeviceUpdateHelloSchema.entries,
  hostname: v.string(),
  /** The directory `kinu connect` ran in, and the machine's home.
   *  Absolute or ignored: a relative path names nothing the hub can scope a call to. */
  root: v.string(),
  home: v.string(),
  /** What the daemon proved at start. Words stay plain strings, narrowed by
   *  `sandboxVerdictFromHello`; a picklist would reject the whole HELLO over one unknown word. */
  sandbox: v.object({
    capability: v.nullable(v.string()),
    reason: v.nullable(v.string()),
    reasonDetail: v.optional(v.nullable(v.string())),
    gpu: v.array(v.string()),
  }),
  /** Where this machine keeps agent homes (`<home>/.kinu/agents`); the hub composes
   *  `<agentRoot>/<workspace>/home` per exec and never guesses a path. */
  agentRoot: v.string(),
  /** The daemon's runtime (`Bun 1.4.2`); a refusal holds until it changes. */
  runtime: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

const methodFlags: Readonly<Record<string, { consentFree?: boolean; checkpointStore?: boolean; deviceView?: boolean }>> = protocol.methods;

const failureKinds = new Map<string, ErrorCode>([
  [DEVICE_ERRORS.disconnected, 'unavailable'], [DEVICE_ERRORS.noOwner, 'unavailable'],
  [DEVICE_ERRORS.unresponsive, 'unavailable'], [DEVICE_ERRORS.unknownMethod, 'unsupported'],
  [DEVICE_ERRORS.protocolMismatch, 'unsupported'], [DEVICE_ERRORS.ambiguous, 'bad_input'],
  [DEVICE_ERRORS.sandboxUnavailable, 'denied'], ['EACCES', 'denied'], ['EPERM', 'denied'], ['ENOENT', 'missing'],
]);

export function deviceMethodHas(method: string, flag: 'consentFree' | 'checkpointStore' | 'deviceView'): boolean {
  return methodFlags[method]?.[flag] === true;
}

export function deviceFailure(code: string, message: string, input?: { cause: unknown }): KinuError {
  const category = ERROR_CODES.find((known) => known === code) ?? failureKinds.get(code) ?? 'io';

  return new KinuError(category, message, { cause: { code, message, cause: input?.cause } });
}

