import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isSameBuild } from '@kinu.run/core';
import { AGENT_HOME, BIN_DIR, ensureBinDir, loadConfigFile, resolveCloudOrigin } from '../config';
import { ACCENT, DIM, OK, VERSION, WARN } from '../display';
import { fetchServedVersion } from '../version-check';
import { CLI_CURRENT, refreshCliTree } from '../self-update';
import { updateConfigFile } from '../config';

export interface UpdateOptions {
  origin?: string;
  force?: boolean;
  /** The startup check's detached child: tree only, silently. */
  background?: boolean;
}

/**
 * `kinu update`: install the served build as the CLI tree, then refresh the
 * launcher script. The tree work adopts a tree the background refresh already
 * staged and verified, or stages one now; `--force` stages afresh even when
 * this build is the served one. The launcher is rewritten only here, and only
 * when the served script differs from the installed one.
 */
/** How the deployment's build reads beside this one: unreachable, current, or
 *  newer than the CLI in hand. */
function servedVersionLabel(served: { version: string } | null): string {
  if (served === null) return WARN('unreachable');

  return isSameBuild(VERSION, served.version) ? OK(`${served.version} (current)`) : WARN(`${served.version}. Run: kinu update`);
}

export async function updateCommand(target: string | undefined, opts: UpdateOptions): Promise<void> {
  const what = target ?? 'self';

  if (what !== 'self' && what !== 'kinu') throw new Error('Usage: kinu update [self] [--origin <url>]');
  const origin = resolveCloudOrigin(opts);

  if (opts.background) return refreshInBackground(origin);
  ensureBinDir();
  const path = join(BIN_DIR, 'kinu');
  // A null served version means an old server without the endpoint (or an
  // unreachable one): the tree cannot be verified against a stamp nobody
  // published, so only the launcher is refreshed rather than refusing to do
  // anything because the *check* failed.
  const served = await fetchServedVersion(origin);

  if (served) {
    updateConfigFile((c) => { c.updateCheckedAt = Date.now(); c.updateLatestSeen = served.version; });
  }

  if (served && (opts.force || !isSameBuild(VERSION, served.version))) {
    await refreshCliTree(origin, served.version);
    console.log(`${OK('✓')} Installed ${ACCENT(served.version)} ${DIM(`(was ${VERSION}; applies on the next launch)`)}`);
  } else if (served) {
    console.log(`${OK('✓')} Already on the latest version ${ACCENT(VERSION)}`);
  } else {
    console.log(`${WARN('!')} ${origin} published no build version; the CLI at ${DIM(CLI_CURRENT)} was left as it is`);
  }

  const res = await fetch(`${origin}/downloads/kinu`, { cache: 'no-store' });

  if (!res.ok) throw new Error(`Update download failed: HTTP ${res.status}`);
  const script = await res.text();

  if (existsSync(path) && readFileSync(path, 'utf-8') === script) {
    chmodSync(path, 0o755);

    return;
  }

  writeFileSync(path, script, { mode: 0o755 });
  chmodSync(path, 0o755);
  console.log(`${OK('✓')} Updated ${ACCENT('kinu')} ${DIM(path)}`);
}

/** The tree refresh the startup check spawned: silent on success, and silent
 *  when the served build is already installed — this child may be one of
 *  several the day's first commands started. A failure still exits non-zero,
 *  so a log reader can see it. */
async function refreshInBackground(origin: string): Promise<void> {
  const served = await fetchServedVersion(origin);

  if (served === null || isSameBuild(VERSION, served.version)) return;
  await refreshCliTree(origin, served.version);
}

export async function uninstallCommand(opts: { purge?: boolean }): Promise<void> {
  const path = join(BIN_DIR, 'kinu');

  if (existsSync(path)) {
    rmSync(path, { force: true });
    console.log(`${OK('✓')} Removed ${DIM(path)}`);
  } else {
    console.log(`${WARN('!')} No installed command found at ${DIM(path)}`);
  }

  if (opts.purge) {
    const cfg = loadConfigFile();
    rmSync(AGENT_HOME, { recursive: true, force: true });
    console.log(`${OK('✓')} Removed ${DIM(AGENT_HOME)}`);

    if (cfg.origin) console.log(DIM(`Account token for ${cfg.origin} was removed locally.`));
  } else {
    console.log(DIM(`Kept data in ${AGENT_HOME}`));
    console.log(DIM(`Remove it with: kinu uninstall --purge`));
  }
}

export async function doctorCommand(): Promise<void> {
  const origin = resolveCloudOrigin();
  const installed = join(BIN_DIR, 'kinu');
  console.log(`${DIM('Home:')} ${AGENT_HOME}`);
  console.log(`${DIM('Command:')} ${existsSync(installed) ? OK(installed) : WARN(`missing ${installed}`)}`);
  console.log(`${DIM('Origin:')} ${origin}`);
  console.log(`${DIM('PATH:')} ${(process.env.PATH ?? '').split(':').includes(BIN_DIR) ? OK('configured') : WARN(`${BIN_DIR} not in PATH`)}`);
  console.log(`${DIM('Build cache:')} ${CLI_CURRENT}`);
  console.log(`${DIM('Current entry:')} ${process.argv[1] ? dirname(process.argv[1]) : '(unknown)'}`);

  const served = await fetchServedVersion(origin);

  const servedLabel = servedVersionLabel(served);

  console.log(`${DIM('Version:')} ${VERSION} ${DIM('· served:')} ${servedLabel}`);
}
