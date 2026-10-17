// SDK audit (c), 2026-10-01: the trust step runs where the SDK docs run it, after the intercepts.
import { TestDevbox } from './support/test-devbox';
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';

import { BOX_CHROMIUM_POLICY, CHROMIUM_PROFILES } from '../src/desktop';
import { TRUST } from '../src/processes';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';

import { harness } from './support/devbox-harness';

test('a started container trusts the intercept CA once, after its HTTPS intercept', async () => {
  const { box, container } = harness(TestDevbox);
  await box.devboxStartup();

  expect(container.sequence.filter((step) => step === 'intercept:https' || step === 'trust')).toEqual(['intercept:https', 'trust']);
});

/** Runs the trust step as the box does, its absolute paths moved under `root`. */
function trustIn(root: string): void {
  const [shell, flag, script] = TRUST;
  const moved = script.replaceAll('/etc/', `${root}/etc/`).replaceAll('/root/', `${root}/root/`);
  const ran = spawnSync(shell, [flag, moved, 'devbox-trust'], { encoding: 'utf8' });

  if (ran.status !== 0) throw new Error(`the trust step failed: ${ran.stderr}`);
}

/** A self-signed CA's PEM, as the platform writes it for one start. */
function freshCa(dir: string, name: string): string {
  const ran = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', `/CN=${name}`,
    '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.pem`)], { encoding: 'utf8' });

  if (ran.status !== 0) throw new Error(ran.stderr);

  return readFileSync(join(dir, `${name}.pem`), 'utf8');
}

const derOf = (pem: string) => pem.split('\n').filter((line) => line !== '' && !line.startsWith('-----')).join('');

const PolicySchema = v.object({ CACertificates: v.array(v.string()), CommandLineFlagSecurityWarningsEnabled: v.boolean() });

// The desktop's Chromium reads none of the system bundle: every intercepted site showed ERR_CERT_AUTHORITY_INVALID
// (staging, 2026-10-16, Chromium 154). Its managed policy names exactly this start's CA, and nothing else's.
test("each start's trust names exactly its own CA to Chromium, and leaves a host's or an eval's policy alone", () => {
  const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}trust-`));
  const policies = join(root, 'etc/chromium/policies/managed');

  try {
    mkdirSync(join(root, 'etc/cloudflare/certs'), { recursive: true });
    mkdirSync(join(root, 'etc/ssl/certs'), { recursive: true });
    mkdirSync(policies, { recursive: true });
    writeFileSync(join(root, 'etc/ssl/certs/ca-certificates.crt'), '# the image\'s roots\n');
    writeFileSync(join(policies, 'devbox.json'), '{"CommandLineFlagSecurityWarningsEnabled": false}\n');
    writeFileSync(join(policies, 'eval.json'), '{"DeveloperToolsAvailability": 2}\n');

    const policy = () => v.parse(PolicySchema, JSON.parse(readFileSync(join(root, BOX_CHROMIUM_POLICY.replace('/etc/', 'etc/')), 'utf8')));
    const first = freshCa(root, 'first-start');

    writeFileSync(join(root, 'etc/cloudflare/certs/cloudflare-containers-ca.crt'), first);
    trustIn(root);
    expect(policy()).toEqual({ CACertificates: [derOf(first)], CommandLineFlagSecurityWarningsEnabled: false });

    // A restart's CA replaces the last one, in the policy as in the bundle.
    const second = freshCa(root, 'second-start');

    writeFileSync(join(root, 'etc/cloudflare/certs/cloudflare-containers-ca.crt'), second);
    trustIn(root);
    expect(policy().CACertificates).toEqual([derOf(second)]);
    expect(readFileSync(join(root, 'etc/ssl/certs/ca-certificates.crt'), 'utf8')).toBe(`# the image's roots\n${second}`);
    expect([...readdirSync(policies)].sort()).toEqual(['eval.json', 'kinu-box.json']);
    expect(readFileSync(join(policies, 'eval.json'), 'utf8')).toBe('{"DeveloperToolsAvailability": 2}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A box's stop ends Chromium with the container, and the next start showed "Restore pages? Chromium didn't shut down
// correctly" (the container tier's restart shot, 2026-10-16). Each profile's last exit is marked clean before it runs.
test('each start marks every Chromium profile as having exited cleanly, and a profile it cannot read stops nothing', () => {
  const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}clean-exit-`));
  const profiles = join(root, CHROMIUM_PROFILES.replace('/root/', 'root/'));

  try {
    mkdirSync(join(root, 'etc/cloudflare/certs'), { recursive: true });
    mkdirSync(join(root, 'etc/ssl/certs'), { recursive: true });
    writeFileSync(join(root, 'etc/ssl/certs/ca-certificates.crt'), '');
    writeFileSync(join(root, 'etc/cloudflare/certs/cloudflare-containers-ca.crt'), freshCa(root, 'a-start'));
    mkdirSync(join(profiles, 'Default'), { recursive: true });
    mkdirSync(join(profiles, 'Profile 1'), { recursive: true });
    mkdirSync(join(profiles, 'Torn'), { recursive: true });
    writeFileSync(join(profiles, 'Default/Preferences'), JSON.stringify({ profile: { exit_type: 'Crashed', exited_cleanly: false, name: 'Person' }, homepage: 'https://kinu.run' }));
    writeFileSync(join(profiles, 'Profile 1/Preferences'), JSON.stringify({ browser: { window_placement: { maximized: true } } }));
    writeFileSync(join(profiles, 'Torn/Preferences'), '{"profile": ');

    trustIn(root);

    const read = (profile: string) => v.parse(v.record(v.string(), v.unknown()), JSON.parse(readFileSync(join(profiles, profile, 'Preferences'), 'utf8')));

    expect(read('Default')).toEqual({ profile: { exit_type: 'Normal', exited_cleanly: true, name: 'Person' }, homepage: 'https://kinu.run' });
    expect(read('Profile 1')).toEqual({ browser: { window_placement: { maximized: true } }, profile: { exit_type: 'Normal', exited_cleanly: true } });
    expect(readFileSync(join(profiles, 'Torn/Preferences'), 'utf8')).toBe('{"profile": ');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
