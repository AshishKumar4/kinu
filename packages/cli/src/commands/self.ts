import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AGENT_HOME, BIN_DIR, ensureBinDir, loadConfigFile, resolveCloudOrigin } from '../config.js';
import { ACCENT, DIM, OK, WARN } from '../display.js';

export async function updateCommand(target: string | undefined, opts: { origin?: string; force?: boolean }): Promise<void> {
  const what = target ?? 'self';
  if (what !== 'self' && what !== 'proteus') throw new Error('Usage: proteus update [self] [--origin <url>]');
  const origin = resolveCloudOrigin(opts);
  ensureBinDir();
  const path = join(BIN_DIR, 'proteus');
  const res = await fetch(`${origin}/downloads/proteus`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Update download failed: HTTP ${res.status}`);
  const script = await res.text();
  writeFileSync(path, script, { mode: 0o755 });
  chmodSync(path, 0o755);
  console.log(`${OK('✓')} Updated ${ACCENT('proteus')} ${DIM(path)}`);
}

export async function uninstallCommand(opts: { purge?: boolean }): Promise<void> {
  const path = join(BIN_DIR, 'proteus');
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
    console.log(DIM(`Remove it with: proteus uninstall --purge`));
  }
}

export async function doctorCommand(): Promise<void> {
  const origin = resolveCloudOrigin();
  const installed = join(BIN_DIR, 'proteus');
  console.log(`${DIM('Home:')} ${AGENT_HOME}`);
  console.log(`${DIM('Command:')} ${existsSync(installed) ? OK(installed) : WARN(`missing ${installed}`)}`);
  console.log(`${DIM('Origin:')} ${origin}`);
  console.log(`${DIM('PATH:')} ${(process.env.PATH ?? '').split(':').includes(BIN_DIR) ? OK('configured') : WARN(`${BIN_DIR} not in PATH`)}`);
  console.log(`${DIM('Source cache:')} ${join(AGENT_HOME, 'source')}`);
  console.log(`${DIM('Current entry:')} ${process.argv[1] ? dirname(process.argv[1]) : '(unknown)'}`);
}
