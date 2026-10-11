/** Real PostgreSQL and MariaDB sessions through the built workspace; run on armada with both servers installed. */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';

async function run(command: string, args: readonly string[], env = process.env): Promise<void> {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';

  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  if (code !== 0) throw new Error(`${command} failed (${String(code)}): ${output}`);
  process.stdout.write(output);
}

const root = mkdtempSync(join(tmpdir(), 'kinu-starttls-proof-'));

const host = '127.0.0.1.nip.io';

const database = 'proof';

const password = 'starttls-test-password';

const ca = join(root, 'ca.pem');

const key = join(root, 'server.key');

const certificate = join(root, 'server.pem');

const pgData = join(root, 'pg');

const mysqlData = join(root, 'mysql');

const mysqlSocket = join(root, 'mysql.sock');

const version = readdirSync('/usr/lib/postgresql').sort().at(-1);

if (version === undefined) throw new Error('PostgreSQL is not installed in this proof environment');

const pg = join('/usr/lib/postgresql', version, 'bin');

const reservations = Array.from({ length: 2 }, () => Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: (socket) => { socket.end(); } } }));

const [pgPort, mysqlPort] = reservations.map(({ port }) => port);

for (const reservation of reservations) reservation.stop();

if (pgPort === undefined || mysqlPort === undefined) throw new Error('the proof did not reserve its database ports');

try {
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'ca.key'), '-out', ca, '-days', '1', '-subj', '/CN=Kinu STARTTLS proof CA']);
  await run('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', join(root, 'server.csr'), '-subj', `/CN=${host}`]);
  writeFileSync(join(root, 'certificate.conf'), `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
  await run('openssl', ['x509', '-req', '-in', join(root, 'server.csr'), '-CA', ca, '-CAkey', join(root, 'ca.key'), '-CAcreateserial', '-out', certificate, '-days', '1', '-extfile', join(root, 'certificate.conf')]);
  chmodSync(key, 0o600);
  writeFileSync(join(root, 'password'), password, { mode: 0o600 });
  await run(join(pg, 'initdb'), ['-D', pgData, '--username', database, '--auth-local=trust', '--auth-host=scram-sha-256', '--pwfile', join(root, 'password')]);
  writeFileSync(join(pgData, 'postgresql.auto.conf'), [
    "listen_addresses='127.0.0.1'", `port=${String(pgPort)}`, 'ssl=on', `ssl_cert_file='${certificate}'`, `ssl_key_file='${key}'`, `unix_socket_directories='${root}'`,
  ].join('\n') + '\n');
  await run(join(pg, 'pg_ctl'), ['-D', pgData, '-l', join(root, 'postgres.log'), '-w', 'start']);

  try {
    mkdirSync(mysqlData);
    await run('mariadb-install-db', ['--no-defaults', `--datadir=${mysqlData}`, '--auth-root-authentication-method=normal', '--skip-test-db']);

    const mysql = spawn('mariadbd', [
      '--no-defaults', `--user=${userInfo().username}`, `--datadir=${mysqlData}`, `--socket=${mysqlSocket}`, `--pid-file=${join(root, 'mysql.pid')}`,
      '--bind-address=127.0.0.1', `--port=${String(mysqlPort)}`, `--ssl-ca=${ca}`, `--ssl-cert=${certificate}`, `--ssl-key=${key}`, '--skip-log-bin',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let mysqlLog = '';
    const closed = new Promise<void>((resolve) => { mysql.once('close', () => resolve()); });

    const ready = new Promise<void>((resolve, reject) => {
      mysql.once('error', reject);
      mysql.once('close', (code) => reject(new Error(`MariaDB stopped before readiness (${String(code)}): ${mysqlLog}`)));
      mysql.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        mysqlLog += chunk;

        if (mysqlLog.includes('ready for connections')) resolve();
      });
    });

    try {
      await ready;
      await run('mariadb', ['--no-defaults', `--socket=${mysqlSocket}`, '--user=root', '--execute', `CREATE DATABASE ${database}; CREATE USER '${database}'@'%' IDENTIFIED BY '${password}'; GRANT SELECT ON ${database}.* TO '${database}'@'%';`]);

      const env = {
        ...process.env, NODE_EXTRA_CA_CERTS: ca, PERF_PG_HOST: host, PERF_PG_PORT: String(pgPort), PERF_PG_USER: database, PERF_PG_PASSWORD: password,
        PERF_PG_DATABASE: 'postgres', PERF_MYSQL_HOST: host, PERF_MYSQL_PORT: String(mysqlPort), PERF_MYSQL_USER: database, PERF_MYSQL_PASSWORD: password, PERF_MYSQL_DATABASE: database,
      };

      await run('bun', ['scripts/turn-file-io.ts', '--shape=node-identity', '--samples=1', ...process.argv.slice(2)], env);
      await run('bun', ['scripts/turn-file-io.ts', '--shape=starttls', '--samples=1', ...process.argv.slice(2)], env);
      process.stdout.write(JSON.stringify({ event: 'starttls.proof', host, postgres: version }) + '\n');
    } finally {
      mysql.kill('SIGTERM');
      await closed;
    }
  } finally {
    await run(join(pg, 'pg_ctl'), ['-D', pgData, '-w', '-m', 'immediate', 'stop']);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
