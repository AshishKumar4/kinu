#!/usr/bin/env bun
/**
 * Deploys `kinu-ci-runner` (scripts/ci-runner/) to Kinu's account with this machine's wrangler login, and leaves
 * `scripts/ci-remote.ts` able to reach it:
 *
 *   1. the R2 bucket `kinu-ci-artifacts`, with packs and runs expiring after 7 days (verdict files are kept);
 *   2. the bearer token: `~/.config/kinu/ci-token` (made once, mode 600) and the Worker's `CI_TOKEN` secret;
 *   3. `wrangler deploy`, and the Worker's URL in `~/.config/kinu/ci-url`.
 *
 * There is no image to build: the containers start Cloudflare's managed base or an environment snapshot
 * (scripts/ci-runner/container.ts). Each step is safe to repeat.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ACCOUNT = 'f44999d1ddda7012e9a87729eba250f1';

const BUCKET = 'kinu-ci-artifacts';

const CONFIG = join(homedir(), '.config', 'kinu');

const root = join(import.meta.dir, '..');

function wrangler(args: readonly string[], stdin?: string): string {
  const ran = Bun.spawnSync([join(root, 'node_modules', '.bin', 'wrangler'), ...args], {
    cwd: root, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe',
  });

  const output = ran.stdout.toString() + ran.stderr.toString();

  if (ran.exitCode !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} exited ${String(ran.exitCode)}:\n${output.slice(-3000)}`);

  return output;
}

function bucket(): void {
  if (!wrangler(['r2', 'bucket', 'list']).includes(BUCKET)) wrangler(['r2', 'bucket', 'create', BUCKET]);
  const rules = wrangler(['r2', 'bucket', 'lifecycle', 'list', BUCKET]);

  for (const prefix of ['packs/', 'runs/']) {
    const name = `expire-${prefix.slice(0, -1)}`;

    if (!rules.includes(name)) wrangler(['r2', 'bucket', 'lifecycle', 'add', BUCKET, name, prefix, '--expire-days', '7', '--force']);
  }
}

function token(): string {
  const file = join(CONFIG, 'ci-token');

  if (!existsSync(file)) {
    mkdirSync(CONFIG, { recursive: true });
    writeFileSync(file, [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, '0')).join('') + '\n');
    chmodSync(file, 0o600);
  }

  return readFileSync(file, 'utf8').trim();
}

function deploy(): void {
  const config = join('scripts', 'ci-runner', 'wrangler.jsonc');
  const deployed = wrangler(['deploy', '-c', config]);
  const url = /https:\/\/kinu-ci-runner\.[a-z0-9-]+\.workers\.dev/u.exec(deployed)?.[0];

  if (url === undefined) throw new Error(`the deploy printed no workers.dev URL:\n${deployed.slice(-2000)}`);
  wrangler(['secret', 'put', 'CI_TOKEN', '-c', config], token());
  writeFileSync(join(CONFIG, 'ci-url'), url + '\n');
  console.log(`kinu-ci-runner: ${url}`);
}

bucket();

deploy();
