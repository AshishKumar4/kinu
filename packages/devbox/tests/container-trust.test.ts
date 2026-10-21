// SDK audit (c), 2026-10-01: the trust step runs where the SDK docs run it, after the intercepts.
import { TestDevbox } from './support/test-devbox';
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';

import { BOX_CHROMIUM_POLICY, CHROMIUM_PROFILES } from '../src/desktop';
import { X509Certificate } from 'node:crypto';
import { KINU_BUN_VERSION } from '../../core/src/cli/bun-runtime';
import { boxEnv, TRUST } from '../src/processes';
import DISTRUSTED from '../src/distrusted-roots.json';
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

  const moved = script.replaceAll('/etc/', `${root}/etc/`).replaceAll('/root/', `${root}/root/`).replaceAll('/usr/share/', `${root}/usr/share/`)
    .replaceAll('/usr/local/share/', `${root}/usr/local/share/`);

  const ran = spawnSync(shell, [flag, moved, 'devbox-trust'], { encoding: 'utf8' });

  if (ran.status !== 0) throw new Error(`the trust step failed: ${ran.stderr}`);
}

/** A leaf for localhost, signed by `ca` (its PEM and key in `dir`, as `freshCa` made them). */
function leafOf(dir: string, ca: string, name: string) {
  const key = join(dir, `${name}.key`);
  const made = spawnSync('openssl', ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=localhost', '-keyout', key, '-out', join(dir, `${name}.csr`)], { encoding: 'utf8' });
  const ext = join(dir, `${name}.ext`);

  if (made.status !== 0) throw new Error(made.stderr);
  // As strict a leaf as Python's default context asks (its X509_STRICT): keys named, usage and purpose stated.
  writeFileSync(ext, 'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n');
  const signed = spawnSync('openssl', ['x509', '-req', '-in', join(dir, `${name}.csr`), '-CA', join(dir, `${ca}.pem`), '-CAkey', join(dir, `${ca}.key`), '-CAcreateserial', '-days', '1', '-extfile', ext, '-out', join(dir, `${name}.pem`)], { encoding: 'utf8' });

  if (signed.status !== 0) throw new Error(signed.stderr);

  return { cert: readFileSync(join(dir, `${name}.pem`), 'utf8'), key: readFileSync(key, 'utf8') };
}

/** A box's Debian store under `root`, as ca-certificates installs it: each source named in its conf, then made. */
function debianStore(root: string, sources: Readonly<Record<string, string>>): void {
  for (const [name, pem] of Object.entries(sources)) {
    mkdirSync(join(root, 'usr/share/ca-certificates', name, '..'), { recursive: true });
    writeFileSync(join(root, 'usr/share/ca-certificates', name), pem);
  }

  mkdirSync(join(root, 'etc/ssl/certs'), { recursive: true });
  mkdirSync(join(root, 'usr/local/share/ca-certificates'), { recursive: true });
  writeFileSync(join(root, 'etc/ca-certificates.conf'), `${Object.keys(sources).join('\n')}\n`);

  // Debian's own tool, where Debian installs it: outside a user's PATH, as the box runs it as root.
  const made = spawnSync('/usr/sbin/update-ca-certificates', ['--certsconf', join(root, 'etc/ca-certificates.conf'), '--certsdir', join(root, 'usr/share/ca-certificates'),
    '--localcertsdir', join(root, 'usr/local/share/ca-certificates'), '--etccertsdir', join(root, 'etc/ssl/certs'), '--hooksdir', join(root, 'etc/ca-certificates/update.d')], { encoding: 'utf8' });

  if (made.status !== 0) throw new Error(`update-ca-certificates: ${made.error?.message ?? ''} ${made.stderr} ${made.stdout}`);
}

const fingerprintOf = (pem: string) => new X509Certificate(pem).fingerprint256.replaceAll(':', '');

/** The fingerprint of every certificate the hashed directory resolves to. */
const hashedIn = (dir: string) => readdirSync(dir).filter((name) => /^[0-9a-f]{8}\.\d+$/u.test(name)).map((name) => fingerprintOf(readFileSync(realpathSync(join(dir, name)), 'utf8')));

/** A self-signed CA's PEM, as the platform writes it for one start, with the usage a strict verifier asks of a root. */
function freshCa(dir: string, name: string): string {
  const ran = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', `/CN=${name}`,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
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

const FIXTURE = readFileSync(join(import.meta.dir, 'fixtures/distrusted-roots.pem'), 'utf8');

/** The incident record's root named `name`, from the fixture its PEMs were copied into. */
const recorded = (name: string) => FIXTURE.match(new RegExp(`# ${name} [^\\n]*\\n(-----BEGIN CERTIFICATE-----[\\s\\S]+?-----END CERTIFICATE-----)`, 'u'))?.[1] ?? '';

// Mozilla bug 2083449 (2026-10-17): eight eMudhra intermediates' keys were recoverable, and the image's store still
// trusted the roots they chain to, in its bundle and in the hashed directory OpenSSL reads (curl, Python, Node with
// --use-openssl-ca: all answered a G3B chain after a bundle-only filter, in node:24.20.0-trixie-slim, 2026-10-21).
test('the roots Debian names for the incident are its own: the record\'s, by fingerprint', () => {
  const named = DISTRUSTED.roots.filter((root) => root.debian !== null);

  expect(named.map((root) => root.name).sort()).toEqual(['AAA Certificate Services', 'emSign ECC Root CA - G3']);
  expect(named.map((root) => fingerprintOf(recorded(root.name)))).toEqual(named.map((root) => root.sha256));
});

test('each start deselects those roots the Debian way: out of the bundle and the hashed directory, once', () => {
  const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}distrust-`));
  const certs = join(root, 'etc/ssl/certs');

  try {
    const kept = freshCa(root, 'a-kept-root');
    const start = freshCa(root, 'this-start');
    const distrusted = Object.fromEntries(DISTRUSTED.roots.flatMap((each) => (each.debian === null ? [] : [[each.debian, recorded(each.name)]])));

    debianStore(root, { ...distrusted, 'mozilla/a-kept-root.crt': kept });
    mkdirSync(join(root, 'etc/cloudflare/certs'), { recursive: true });
    writeFileSync(join(root, 'etc/cloudflare/certs/cloudflare-containers-ca.crt'), start);
    const out = new Set(DISTRUSTED.roots.map((each) => each.sha256));

    // As ca-certificates left it: both of them in the directory OpenSSL reads.
    expect(hashedIn(certs).filter((print) => out.has(print))).toHaveLength(2);
    trustIn(root);

    const bundle = readFileSync(join(certs, 'ca-certificates.crt'), 'utf8');

    expect(bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu)?.map(derOf)).toEqual([derOf(kept), derOf(start)]);
    expect({ hashed: hashedIn(certs).filter((print) => out.has(print)), kept: hashedIn(certs).includes(fingerprintOf(kept)) }).toEqual({ hashed: [], kept: true });
    expect(readFileSync(join(root, 'etc/ca-certificates.conf'), 'utf8').split('\n').filter((line) => line.startsWith('!')).sort())
      .toEqual(Object.keys(distrusted).map((name) => `!${name}`).sort());
    // Chromium reads its own root store, not the system's: its policy distrusts the one of them that store holds.
    const policy = v.parse(v.object({ CADistrustedCertificates: v.array(v.string()) }), JSON.parse(readFileSync(join(root, BOX_CHROMIUM_POLICY.replace('/etc/', 'etc/')), 'utf8')));

    expect(policy.CADistrustedCertificates).toEqual([derOf(recorded('emSign ECC Root CA - G3'))]);
    // A second start finds them deselected, and writes the same bundle.
    trustIn(root);
    expect(readFileSync(join(certs, 'ca-certificates.crt'), 'utf8')).toBe(bundle);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The clients the box's programs use, each reading only the hashed directory (an empty bundle): a chain through a root
// at a deselected name is refused after the trust step, and one through a kept root still answers.
test('after the trust step Node, curl and Python refuse a chain through a deselected root, and keep the rest', async () => {
  const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}distrust-clients-`));
  const [deselected = ''] = DISTRUSTED.roots.flatMap((each) => (each.debian === null ? [] : [each.debian]));
  const servers: ReturnType<typeof Bun.serve>[] = [];

  try {
    // A root of this test's own, at the Debian name the box deselects: its key signs a leaf the clients are shown.
    const standIn = freshCa(root, 'stand-in');
    const kept = freshCa(root, 'kept');

    const serve = (leaf: { readonly cert: string; readonly key: string }) => {
      const server = Bun.serve({ port: 0, hostname: '127.0.0.1', tls: leaf, fetch: () => new Response('ok') });

      servers.push(server);

      return `https://localhost:${String(server.port)}/`;
    };

    const through = { deselected: serve(leafOf(root, 'stand-in', 'leaf-stand-in')), kept: serve(leafOf(root, 'kept', 'leaf-kept')) };

    debianStore(root, { [deselected]: standIn, 'mozilla/kept.crt': kept });
    mkdirSync(join(root, 'etc/cloudflare/certs'), { recursive: true });
    writeFileSync(join(root, 'etc/cloudflare/certs/cloudflare-containers-ca.crt'), freshCa(root, 'this-start'));
    // A bundle of an unrelated root: the directory alone holds these, the one store a bundle-only filter left trusting.
    writeFileSync(join(root, 'unrelated.crt'), freshCa(root, 'unrelated'));
    const env = { PATH: process.env['PATH'] ?? '', SSL_CERT_DIR: join(root, 'etc/ssl/certs'), SSL_CERT_FILE: join(root, 'unrelated.crt'), NODE_OPTIONS: boxEnv({}).NODE_OPTIONS };

    const clients = {
      node: (url: string) => ['node', '-e', `require('https').get('${url}', (res) => { console.log(res.statusCode); }).on('error', (error) => { console.log(error.code); })`],
      curl: (url: string) => ['sh', '-c', `curl -s -o /dev/null -w '%{http_code}' --capath "$SSL_CERT_DIR" '${url}' | grep -x 200 || echo refused`],
      python: (url: string) => ['python3', '-c', `import urllib.request\ntry:\n  print(urllib.request.urlopen('${url}').status)\nexcept Exception:\n  print('refused')`],
    };

    const asked = async () => Object.fromEntries(await Promise.all(Object.entries(clients).map(async ([client, argv]) => {
      const answers = await Promise.all(Object.values(through).map(async (url) => {
        const child = Bun.spawn(argv(url), { env, stdout: 'pipe', stderr: 'ignore' });

        return (await new Response(child.stdout).text()).trim().replace(/^.*[A-Z_]{8,}.*$/u, 'refused');
      }));

      return [client, Object.fromEntries(Object.keys(through).map((name, at) => [name, answers[at]]))] as const;
    })));

    expect(await asked()).toEqual({ node: { deselected: '200', kept: '200' }, curl: { deselected: '200', kept: '200' }, python: { deselected: '200', kept: '200' } });
    trustIn(root);
    expect(await asked()).toEqual({ node: { deselected: 'refused', kept: '200' }, curl: { deselected: 'refused', kept: '200' }, python: { deselected: 'refused', kept: '200' } });
  } finally {
    await Promise.all(servers.map(async (server) => server.stop(true)));
    rmSync(root, { recursive: true, force: true });
  }
});

test('a program\'s own NODE_OPTIONS keeps the box\'s trust after it, in an exec\'s environment and its pane\'s', () => {
  expect(boxEnv({ NODE_OPTIONS: '--max-old-space-size=512' }).NODE_OPTIONS).toBe('--max-old-space-size=512 --use-openssl-ca');
  expect(boxEnv({}).NODE_OPTIONS).toBe('--use-openssl-ca');
  expect(boxEnv({ PATH: '/bin' }).PATH).toBe('/bin');
});

// The box's Bun keeps its own roots (no option drops them), so it distrusts only when its pin moves to a Bun that does:
// pc-agent's trust test goes red the day the CLI's Bun ships the distrust, and this holds the box's pin to the CLI's.
test('the box\'s Bun is the CLI\'s, so the day its distrust ships is one day for both', () => {
  const setup = readFileSync(join(import.meta.dir, '../block-lower/tools-setup.sh'), 'utf8');

  expect(/bun-v(\d+\.\d+\.\d+)\/bun-linux/u.exec(setup)?.[1]).toBe(KINU_BUN_VERSION);
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
