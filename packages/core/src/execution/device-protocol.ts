import protocol from './device-protocol.json';
import { ERROR_CODES, KinuError, type ErrorCode } from '../obs/error';

export const DEVICE_PROTOCOL_VERSION = protocol.version;

export const DEVICE_VERSION_REFUSAL_CLOSE = protocol.versionRefusalClose;

export const DEVICE_FRAMES = protocol.frames;

export const DEVICE_ERRORS = protocol.errors;

export const DEVICE_UPDATE_REQUIRED = protocol.updateRequired;

export const DEVICE_METHOD = Object.fromEntries(Object.keys(protocol.methods).map((method) => [method, method]));

export type DeviceMethod = keyof typeof protocol.methods;

export const DEVICE_FEATURES: readonly string[] = Object.keys(protocol.methods);

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

