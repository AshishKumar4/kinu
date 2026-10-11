/**
 * The daemon as the CLI takes it: its text, and the schema of its config.
 *
 * `packages/cli/src/device-connect.ts` imports this file with
 * `{ type: 'text' }` and writes the bytes to `~/.kinu/pc-agent.js`, so the
 * daemon ships inside the CLI release and `kinu connect` downloads nothing.
 * Bun inlines the bytes when `scripts/build-cli-dist.sh` bundles the CLI, and
 * reads this file when Bun runs the CLI from source. It imports the module once
 * more for `parseDeviceConfig` alone, so device.json has one schema, the one
 * the daemon reads it by; requiring the module starts nothing.
 *
 * A declaration beside the file is what TypeScript resolves for a specifier
 * that names it: `index.js` is JavaScript, so without this the import is
 * TS7016. A wildcard ambient declaration in the importing package is not
 * equivalent — TypeScript consults a pattern only where normal resolution
 * finds nothing, and it finds this file.
 */
declare const source: string;

export default source;

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
