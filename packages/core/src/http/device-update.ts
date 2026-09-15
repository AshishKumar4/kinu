/**
 * Self-update vocabulary shared by the hub, the CLI and the device row.
 *
 * The served build stamp (`/downloads/kinu-version.json`, written by
 * scripts/build-cli-dist.sh) is the only version source. A CLI or a daemon is
 * "behind" when its own stamp is not that one; nothing here orders versions,
 * because `0.1.0+abc` and `0.1.0+def` are different builds of one semver and
 * the deploy that published the stamp is by definition the build to run.
 */
import { CLI_DIST_PLATFORMS } from './deployed-assets';

/** Build metadata is significant here: 0.1.0+aaa and 0.1.0+bbb are different
 *  builds even though semver treats the suffix as ignorable. */
export function isSameBuild(installed: string, served: string): boolean {
  return installed.trim() === served.trim();
}

/**
 * The frame the hub sends a daemon whose HELLO named another build:
 * `{ type: 'UPDATE', version, urls: { tarball, checksum }, sha256 }`.
 *
 * `urls` are PATHS on the daemon's own origin, never absolute: the daemon
 * downloads over the origin its credentials already trust, and a frame cannot
 * point it anywhere else. `sha256` is the published checksum, so the daemon
 * can tell a frame from an earlier deploy apart from the archive now served.
 */
export const DEVICE_UPDATE = 'UPDATE';

export interface DeviceUpdateFrame {
  type: typeof DEVICE_UPDATE;
  version: string;
  urls: { tarball: string; checksum: string };
  sha256: string;
}

/** The published CLI artifact for a machine, by the words its daemon's HELLO
 *  uses (`os.platform()`, `os.arch()`), or null when no artifact is built for
 *  that platform. */
export function cliArtifactPath(os: string | undefined, arch: string | undefined): string | null {
  const platform = `${os ?? ''}-${arch ?? ''}`;

  if (!CLI_DIST_PLATFORMS.some((built) => built === platform)) return null;

  return `/downloads/kinu-cli-${platform}.tar.gz`;
}

/**
 * What the Devices card says about a machine's software, and what the hub
 * decides on HELLO. `off` is the owner's `updateCheck: false`, reported by the
 * daemon; it wins over `behind` because the owner asked not to be touched.
 * `unreported` is a daemon too old to name its build at all. `current` also
 * covers a hub that has no served stamp to compare against.
 */
export type DeviceUpdateState = 'current' | 'behind' | 'off' | 'unreported';

export const DEVICE_UPDATE_STATES = ['current', 'behind', 'off', 'unreported'] as const;

export function deviceUpdateState(
  reported: { version: string | null; updateCheck: boolean },
  served: string | null,
): DeviceUpdateState {
  if (reported.version === null) return 'unreported';

  if (!reported.updateCheck) return 'off';

  if (served === null || isSameBuild(reported.version, served)) return 'current';

  return 'behind';
}
