import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AGENT_HOME, BIN_DIR, ensureBinDir, loadConfigFile, resolveCloudOrigin } from '../config';
import { ACCENT, DIM, OK, VERSION, WARN } from '../display';
import { fetchServedVersion, isSameBuild } from '../version-check';
import { updateConfigFile } from '../config';

export async function updateCommand(target: string | undefined, opts: { origin?: string; force?: boolean }): Promise<void> {
  const what = target ?? 'self';
  if (what !== 'self' && what !== 'kinu') throw new Error('Usage: kinu update [self] [--origin <url>]');
  const origin = resolveCloudOrigin(opts);
  ensureBinDir();
  const path = join(BIN_DIR, 'kinu');

  // A null served version means an old server without the endpoint (or an
  // unreachable one): fall back to the unconditional download rather than
  // refusing to update because the *check* failed.
  const served = opts.force ? null : await fetchServedVersion(origin);
  if (served) {
    updateConfigFile((c) => { c.updateCheckedAt = Date.now(); c.updateLatestSeen = served.version; });
    if (isSameBuild(VERSION, served.version) && existsSync(path)) {
      console.log(`${OK('✓')} Already on the latest version ${ACCENT(VERSION)}`);
      return;
    }
  }

  const res = await fetch(`${origin}/downloads/kinu`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Update download failed: HTTP ${res.status}`);
  const script = await res.text();
  writeFileSync(path, script, { mode: 0o755 });
  if (served && !isSameBuild(VERSION, served.version)) {
    console.log(`${OK('✓')} Updated ${ACCENT(VERSION)} ${DIM('→')} ${ACCENT(served.version)}`);
  }
  chmodSync(path, 0o755);
  console.log(`${OK('✓')} Updated ${ACCENT('kinu')} ${DIM(path)}`);
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
  console.log(`${DIM('Build cache:')} ${join(AGENT_HOME, 'cli', 'current')}`);
  console.log(`${DIM('Current entry:')} ${process.argv[1] ? dirname(process.argv[1]) : '(unknown)'}`);

  const served = await fetchServedVersion(origin);
  const servedLabel = !served
    ? WARN('unreachable')
    : isSameBuild(VERSION, served.version) ? OK(`${served.version} (current)`)
    : WARN(`${served.version} — run: kinu update`);
  console.log(`${DIM('Version:')} ${VERSION} ${DIM('· served:')} ${servedLabel}`);
}
