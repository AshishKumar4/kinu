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

/** device.json as `kinu connect` writes it and the daemon reads it (device protocol 5); fields beyond these are kept.
 *  Mode 0600 beside device.key: its connect secret signs each connect with the key. */
export interface DeviceConfig {
  readonly user: string;
  /** The registration the hub issued, whose key signs every connect. */
  readonly device: string;
  /** One the daemon connects to: https, or plain http to this machine. */
  readonly origin: string;
  /** The directory the owner linked, absolute: their home, or the one the connect command named. */
  readonly root: string;
  /** The connect secret the hub last handed this machine ('' before its first connect), which its next connect signs. */
  readonly connectSecret: string;
}

/** The contents of the file at `configPath` as a device config, or throws naming the file and the command that mends
 *  it: `kinu connect`, or `kinu update` for one an earlier protocol wrote. */
export function parseDeviceConfig(text: string, configPath: string): DeviceConfig;
