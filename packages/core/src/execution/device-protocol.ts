import protocol from './device-protocol.json';
import * as v from 'valibot';
import { ERROR_CODES, KinuError, type ErrorCode } from '../obs/error';

export const DEVICE_PROTOCOL_VERSION = protocol.version;

/** The close for a HELLO this hub does not serve: any protocol but this one, since only this one authenticates. */
export const DEVICE_VERSION_REFUSAL_CLOSE = protocol.versionRefusalClose;

/** The close for a socket whose AUTH named no live ticket: the daemon reads it as a dead credential and stops. */
export const DEVICE_CREDENTIALS_REJECTED_CLOSE = protocol.credentialsRejectedClose;

/** The close for a socket that sent no AUTH within {@link DEVICE_AUTH_DEADLINE_MS}; the daemon dials again. */
export const DEVICE_AUTH_DEADLINE_CLOSE = protocol.authDeadlineClose;

/**
 * The account a device socket is routed to. The Worker must pick the account's object before the socket's first
 * frame, and the account is no URL's: the name holds `auth`, so the platform's logs redact its value as a credential's
 * (cloud-wire.ts `PlatformRedactedHeader`), and the account never sits in a log beside the address that dialled it.
 */
export const DEVICE_CONNECT_ACCOUNT_HEADER = protocol.accountHeader;

/** How long an accepted socket may wait before its first frame, AUTH: nothing is served before it. */
export const DEVICE_AUTH_DEADLINE_MS = 10_000;

/** A terminal's window bound per axis, the daemon's and the hub's: the kernel carries each as an `unsigned short`, and a
 *  thousand cells on a side is past any real display, so more is a malformed frame. */
export const DEVICE_PTY_MAX_AXIS = protocol.ptyMaxAxis;

export const DEVICE_FRAMES = protocol.frames;

export const DEVICE_ERRORS = protocol.errors;

export const DEVICE_UPDATE_REQUIRED = protocol.updateRequired;

export const DEVICE_METHOD = Object.fromEntries(Object.keys(protocol.methods).map((method) => [method, method]));

/** Every method a current daemon answers, as its HELLO lists them. */
export const DEVICE_FEATURES: readonly string[] = Object.keys(protocol.methods);

/** A daemon's first frame on every socket: the account it connects to and the ticket its signed challenge bought. The
 *  ticket rides here, never in the socket's URL or headers, which edge and proxy logs keep. */
export const DeviceAuthFrameSchema = v.object({
  type: v.literal(DEVICE_FRAMES.auth),
  user: v.string(),
  ticket: v.string(),
});

/** The daemon's answer once the generation the hub sent is in its device.json: the hub commits it then. */
export const DeviceGenerationAckSchema = v.object({
  type: v.literal(DEVICE_FRAMES.generationAck),
  generation: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});

/** What every HELLO opens with: the protocol it speaks and the methods it answers, which decide the rest. */
export const DeviceHelloHeadSchema = v.object({
  type: v.literal(DEVICE_FRAMES.hello),
  protocolVersion: v.number(),
  features: v.array(v.string()),
});

/**
 * What an update push is decided on: whether, and to which build, the daemon is pushed one. `version` is absent on a
 * daemon with no build stamp, which is pushed nothing.
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
  /** The directory the owner linked (their home, unless the connect command named one), and the machine's home.
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
  /** Its screen (`DeviceDesktopSchema`), narrowed where it is recorded: one unknown word must not refuse the HELLO. */
  desktop: v.looseObject({ state: v.string() }),
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

