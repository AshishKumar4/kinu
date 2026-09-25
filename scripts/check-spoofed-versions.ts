#!/usr/bin/env bun
// Compares each client version Kinu's wire names with that client's latest release, since a server may
// refuse a stale one: `bun scripts/check-spoofed-versions.ts` reports, `--update` rewrites the pin.
// Run it by hand; it is not a gate. Shape after oh-my-pi's scripts/check-spoofed-versions.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

interface PinnedClient {
  readonly name: string;
  /** Repo-relative file holding the pin. */
  readonly file: string;
  /** First group: the pinned version. */
  readonly pin: RegExp;
  readonly npmPackage: string;
}

const CLIENTS: readonly PinnedClient[] = [
  {
    // `latest`, not `stable`: Anthropic gates new models on the newest release.
    name: 'Claude Code',
    file: 'packages/core/src/providers/claude.ts',
    pin: /DEFAULT_CLAUDE_CODE_VERSION = '(\d+\.\d+\.\d+)'/,
    npmPackage: '@anthropic-ai/claude-code',
  },
];

const NpmReleaseSchema = v.looseObject({ version: v.string() });

/** The `latest` dist-tag's semver, or null when npm cannot say; the reason is printed. */
async function latestNpmVersion(pkg: string): Promise<string | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { headers: { Accept: 'application/json' } });

    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    const release = v.parse(NpmReleaseSchema, await response.json());

    return /^\d+\.\d+\.\d+/.exec(release.version)?.[0] ?? null;
  } catch (error) {
    console.error(`npm answered nothing usable for ${pkg}: ${error instanceof Error ? error.message : String(error)}`);

    return null;
  }
}

async function check(client: PinnedClient, update: boolean): Promise<'current' | 'drift' | 'unknown'> {
  const path = join(import.meta.dir, '..', client.file);
  const source = readFileSync(path, 'utf8');
  const pinned = client.pin.exec(source);
  const latest = await latestNpmVersion(client.npmPackage);

  if (pinned?.[1] === undefined || latest === null) {
    console.error(`[FAIL] ${client.name}: ${pinned?.[1] === undefined ? `no pin in ${client.file}` : `npm has no latest ${client.npmPackage}`}`);

    return 'unknown';
  }

  if (pinned[1] === latest) {
    console.log(`[OK]    ${client.name} ${latest}`);

    return 'current';
  }

  console.log(`[DRIFT] ${client.name} ${pinned[1]} -> ${latest}`);

  if (update) {
    writeFileSync(path, source.replace(pinned[0], pinned[0].replace(pinned[1], latest)));
    console.log(`        updated ${client.file}`);
  }

  return 'drift';
}

const update = process.argv.includes('--update');

const outcomes = await Promise.all(CLIENTS.map((client) => check(client, update)));

if (outcomes.every((outcome) => outcome === 'unknown')) {
  console.error('No release could be read, so nothing is known to be current.');
  process.exit(1);
}

if (outcomes.includes('drift') && !update) {
  console.log('Run with --update to move the pins.');
  process.exit(1);
}
