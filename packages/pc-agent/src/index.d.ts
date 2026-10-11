/**
 * The daemon as the CLI calls into it: the schema of its config alone.
 *
 * `packages/cli/src/device-connect.ts` imports `parseDeviceConfig`, so
 * device.json has one schema, the one the daemon reads it by; requiring the
 * module starts nothing. The bytes it installs as `~/.kinu/pc-agent.js` it
 * reads from disk, beside the release or in the source tree: Bun gives one
 * file one loader, so the daemon is never also imported as text.
 *
 * A declaration beside the file is what TypeScript resolves for a specifier
 * that names it: `index.js` is JavaScript, so without this the import is
 * TS7016. A wildcard ambient declaration in the importing package is not
 * equivalent — TypeScript consults a pattern only where normal resolution
 * finds nothing, and it finds this file.
 */

/** device.json as `kinu connect` writes it and the daemon reads it; fields beyond these are kept. */
export interface DeviceConfig {
  readonly user: string;
  readonly device: string;
  readonly token: string;
  /** One the daemon sends its token to: https, or plain http to this machine. */
  readonly origin: string;
  /** The directory `kinu connect` ran in, absolute. */
  readonly root: string;
}

/** The contents of the file at `configPath` as a device config, or throws naming the file and `kinu connect`. */
export function parseDeviceConfig(text: string, configPath: string): DeviceConfig;
