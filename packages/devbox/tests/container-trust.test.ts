// SDK audit (c), 2026-10-01: the trust step runs where the SDK docs run it, after the intercepts.
import { TestDevbox } from './support/test-devbox';
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';

import { BOX_CHROMIUM_POLICY, CHROMIUM_PROFILES } from '../src/desktop';
import { CONTAINER_ENV, TRUST } from '../src/processes';
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

// Mozilla bug 2083449 (2026-10-17): eight eMudhra intermediates' keys were recoverable, and the image's bundle still
// trusted the roots they chain to. The box's bundle leaves those out, and is otherwise the image's as it was.
test('each start leaves the roots eMudhra\'s compromised intermediates chain to out of the system bundle', () => {
  const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}distrust-`));
  const distrusted = readFileSync(join(import.meta.dir, 'fixtures/distrusted-roots.pem'), 'utf8');

  try {
    mkdirSync(join(root, 'etc/cloudflare/certs'), { recursive: true });
    mkdirSync(join(root, 'etc/ssl/certs'), { recursive: true });
    const kept = freshCa(root, 'a-kept-root');
    const start = freshCa(root, 'this-start');

    writeFileSync(join(root, 'etc/ssl/certs/ca-certificates.crt'), `${kept}${distrusted}`);
    writeFileSync(join(root, 'etc/cloudflare/certs/cloudflare-containers-ca.crt'), start);
    trustIn(root);

    const bundle = readFileSync(join(root, 'etc/ssl/certs/ca-certificates.crt'), 'utf8');
    const policy = v.parse(v.object({ CADistrustedCertificates: v.array(v.string()) }), JSON.parse(readFileSync(join(root, BOX_CHROMIUM_POLICY.replace('/etc/', 'etc/')), 'utf8')));
    const chromiums = distrusted.match(/# emSign ECC Root CA - G3[^\n]*\n(-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----)/u)?.[1] ?? '';

    expect(bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu)?.map(derOf)).toEqual([derOf(kept), derOf(start)]);
    // Chromium reads its own root store, not the bundle: its policy distrusts the one of them that store holds.
    expect(policy.CADistrustedCertificates).toEqual([derOf(chromiums)]);
    // A second start reads the image's bundle again, and leaves the same out.
    trustIn(root);
    expect(readFileSync(join(root, 'etc/ssl/certs/ca-certificates.crt'), 'utf8')).toBe(bundle);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Node keeps roots of its own, and the image's Node 24 answered a G3B chain the bundle no longer trusts: the box's
// environment has every Node read the bundle the trust step writes instead.
test('Node in the box reads the system bundle the trust step writes, not its own roots', async () => {
  const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}node-trust-`));

  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem')], { encoding: 'utf8' });

  if (made.status !== 0) throw new Error(made.stderr);
  const cert = readFileSync(join(root, 'cert.pem'), 'utf8');
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', tls: { cert, key: readFileSync(join(root, 'key.pem'), 'utf8') }, fetch: () => new Response('ok') });
  const ask = `require('https').get('https://localhost:${String(server.port)}/', (res) => { console.log(res.statusCode); }).on('error', (error) => { console.log(error.code); })`;

  const asked = async (bundle: string, env: Readonly<Record<string, string>>) => {
    writeFileSync(join(root, 'bundle.crt'), bundle);
    const child = Bun.spawn(['node', '-e', ask], { env: { PATH: process.env['PATH'] ?? '', SSL_CERT_FILE: join(root, 'bundle.crt'), ...env }, stdout: 'pipe' });

    return (await new Response(child.stdout).text()).trim();
  };

  try {
    expect({
      boxReadsBundle: await asked(cert, { NODE_OPTIONS: CONTAINER_ENV.NODE_OPTIONS }),
      boxWithoutIt: await asked('', { NODE_OPTIONS: CONTAINER_ENV.NODE_OPTIONS }),
      nodeAsShipped: await asked(cert, {}),
    }).toEqual({ boxReadsBundle: '200', boxWithoutIt: 'DEPTH_ZERO_SELF_SIGNED_CERT', nodeAsShipped: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  } finally {
    await server.stop(true);
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
