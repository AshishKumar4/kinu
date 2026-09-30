import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

/**
 * `docker build` of a test image, its steps on the host's network. A step on Docker's default bridge adds a veth to
 * the host while it runs, and the veth's IPv6 link-local address is an address change to every process there: Chrome
 * flushes its socket pools, and each module a browser row's page still has queued fails with net::ERR_NETWORK_CHANGED,
 * which leaves the app unmounted. CI runs 36692757065, 36695091265 and 36742984678 each blanked a gallery page while
 * one of these builds ran beside it (docs/ARCHITECTURE-DECISIONS.md L14). On the host's network a step adds no
 * interface, and it still fetches what it installs.
 */
export function dockerBuild(image: string, context: string): SpawnSyncReturns<string> {
  return spawnSync('docker', ['build', '--network=host', '-t', image, context], { encoding: 'utf8' });
}
