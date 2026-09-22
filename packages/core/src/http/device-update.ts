/**
 * Self-update vocabulary. The served build stamp (`/downloads/kinu-version.json`)
 * is the only version source; versions are compared for equality, never ordered.
 */
import { CLI_DIST_PLATFORMS } from './deployed-assets';

/** Build metadata is significant: 0.1.0+aaa and 0.1.0+bbb differ. */
export function isSameBuild(installed: string, served: string): boolean {
  return installed.trim() === served.trim();
}

/** Hub → daemon frame. `urls` are paths on the daemon's own origin, never absolute. */
export const DEVICE_UPDATE = 'UPDATE';

export interface DeviceUpdateFrame {
  type: typeof DEVICE_UPDATE;
  version: string;
  urls: { tarball: string; checksum: string };
  sha256: string;
  /** Signed checksums (`http/release-signing.ts`) the daemon verifies against its pinned key; relayed, never minted, by the hub. */
  checksums: Record<string, string>;
  signature: string;
}

/** Null when no artifact is built for `os.platform()`-`os.arch()`. */
export function cliArtifactPath(os: string | undefined, arch: string | undefined): string | null {
  const platform = `${os ?? ''}-${arch ?? ''}`;

  if (!CLI_DIST_PLATFORMS.some((built) => built === platform)) return null;

  return `/downloads/kinu-cli-${platform}.tar.gz`;
}

/**
 * `off` (owner's `updateCheck: false`) wins over `behind`. `unstamped`: no build
 * metadata, i.e. a source install; nothing is pushed over it.
 */
export type DeviceUpdateState = 'current' | 'behind' | 'off' | 'unreported' | 'unstamped';

export const DEVICE_UPDATE_STATES = ['current', 'behind', 'off', 'unreported', 'unstamped'] as const;

export function deviceUpdateState(
  reported: { version: string | null; updateCheck: boolean },
  served: string | null,
): DeviceUpdateState {
  if (reported.version === null) return 'unreported';

  if (!reported.updateCheck) return 'off';

  if (!reported.version.includes('+')) return 'unstamped';

  if (served === null || isSameBuild(reported.version, served)) return 'current';

  return 'behind';
}
