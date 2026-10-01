// SDK audit (c), 2026-10-01: the intercept CA in the image's own trust store. Commands trusted the
// CA only through env vars, so a tool that reads none (apt, Java, a cleared env) refused every
// intercepted site. Public roots still held through the hashed /etc/ssl/certs, so those stay pinned.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { CONTAINER_TRUST_ENV, TRUST } from '../src/processes';
import { buildBlockImage, removeBlockImage } from './support/block-image';
import { inContainer } from './support/docker-container';

const image = `devbox-trust-${process.pid}`;

const name = `devbox-trust-${process.pid}`;

const CA = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';

/** A root, and a localhost leaf it signs served on `port`. */
const SERVE = `set -e; cd /tmp/tls; name=$1; port=$2
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=$name root" -keyout $name.key -out $name.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj /CN=localhost -keyout $name-leaf.key -out $name-leaf.csr 2>/dev/null
printf 'subjectAltName=DNS:localhost\\n' > san.ext
openssl x509 -req -in $name-leaf.csr -CA $name.crt -CAkey $name.key -CAcreateserial -days 1 -extfile san.ext -out $name-leaf.crt 2>/dev/null
setsid openssl s_server -quiet -www -accept $port -cert $name-leaf.crt -key $name-leaf.key >/dev/null 2>&1 &
until (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; do sleep 0.1; done`;

function sh(script: string, ...args: string[]): ReturnType<typeof inContainer> {
  return inContainer(name, ['bash', '-c', script, 'test', ...args]);
}

function must(script: string, ...args: string[]): void {
  const ran = sh(script, ...args);

  if (ran.status !== 0) throw new Error(ran.stderr);
}

/** Runs the box's trust step, as the box does after its intercept. */
function trust(): void {
  const ran = inContainer(name, [...TRUST]);

  if (ran.status !== 0) throw new Error(ran.stderr);
}

/** Which clients reach `port` with the box's command env, and with none (`bare`, as apt or wget). */
function reaches(port: number) {
  const env = Object.entries(CONTAINER_TRUST_ENV).map(([key, value]) => `${key}=${value}`);
  const url = `https://localhost:${port}/`;
  const ran = (argv: string[]) => inContainer(name, ['env', ...env, ...argv]).status === 0;

  return {
    curl: ran(['curl', '-sSf', '-o', '/dev/null', url]),
    // Not a git server: git's refusal names the certificate only when the handshake failed.
    git: sh(`env ${env.join(' ')} git ls-remote ${url}repo.git 2>&1 | grep -qi certificate`).status !== 0,
    python: ran(['python3', '-c', `import urllib.request; urllib.request.urlopen('${url}')`]),
    node: ran(['node', '-e', `fetch('${url}').then(() => process.exit(0), () => process.exit(1))`]),
    bare: inContainer(name, ['env', '-i', 'PATH=/usr/bin:/bin', 'curl', '-sSf', '-o', '/dev/null', url]).status === 0,
  };
}

beforeAll(() => {
  buildBlockImage(image);
  const started = spawnSync('docker', ['run', '--detach', '--name', name, '--network=none', image], { encoding: 'utf8' });

  if (started.status !== 0) throw new Error(started.stderr);
  must('mkdir -p /tmp/tls /etc/cloudflare/certs');
  // A public root the image ships: in the system bundle before the box ever runs.
  must(SERVE, 'public', '9443');
  must('cp /tmp/tls/public.crt /usr/local/share/ca-certificates/public.crt && update-ca-certificates >/dev/null');
  must(SERVE, 'intercept', '8443');
  must(SERVE, 'next', '7443');
});

afterAll(() => {
  const removal = spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });

  removeBlockImage(image);

  if (removal.status !== 0) throw new Error(removal.stderr);
});

test('a command trusts the intercept CA and the public roots; a tool reading no env trusts the CA too', () => {
  must(`cp /tmp/tls/intercept.crt ${CA}`);
  trust();

  expect({ intercepted: reaches(8443), public: reaches(9443) }).toEqual({
    intercepted: { curl: true, git: true, python: true, node: true, bare: true },
    // Node keeps its own roots, which hold no test root; the intercept is what reaches the internet.
    public: { curl: true, git: true, python: true, node: false, bare: true },
  });
});

test('a snapshot\'s next container trusts its own CA only, and the bundle holds one CA beyond the system\'s', () => {
  must(`cp /tmp/tls/next.crt ${CA}`);
  trust();
  trust();
  const count = (file: string) => Number(sh(`grep -c 'BEGIN CERTIFICATE' ${file}`).stdout.trim());

  expect({
    previous: reaches(8443).bare,
    next: reaches(7443).bare,
    beyond: count('/etc/ssl/certs/ca-certificates.crt') - count('/etc/ssl/certs/ca-certificates.system.crt'),
  }).toEqual({ previous: false, next: true, beyond: 1 });
});
