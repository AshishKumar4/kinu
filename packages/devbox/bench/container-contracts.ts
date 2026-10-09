/** D72: these contracts run on a throwaway Cloudflare container, never a local image. */
import { Files, SandboxFileError } from '@cloudflare/sandbox';
import * as v from 'valibot';
import { settle } from '../src/errors';
import { describeThrown } from '../src/lifecycle';
import { listFiles } from '../src/file-listing';
import { Processes, CONTAINER_TRUST_ENV, TRUST } from '../src/processes';
import { collectExecRecords } from '../src/exec-stream';
import { TOOLS_STAMP, toolsInstallCommand } from '../src/tools';
import { DESKTOP_START, DESKTOP_PORT } from '../src/desktop';
import type { Devbox } from '../src/devbox';

import type { ContainerContract } from './contract-types';

function equal<Value>(actual: Value, expected: Value): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`contract mismatch: ${JSON.stringify({ actual, expected })}`);
}

const text = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);

async function native(container: Container, command: string): Promise<string> {
  const ran = await (await container.exec(['/bin/bash', '-c', command])).output();

  if (ran.exitCode !== 0) throw new Error(`container command exited ${String(ran.exitCode)}: ${text(ran.stderr).slice(-800)}`);

  return text(ran.stdout).trim();
}

const ROOT = '/var/tmp/devbox/processes';

const SCRATCH = '/var/tmp/devbox-contracts';

async function tools(container: Container, pin: string): Promise<void> {
  equal(await native(container, `. /etc/os-release; printf '%s %s' "$ID" "$VERSION_ID"`), 'debian 13');
  equal(await native(container, `cat ${TOOLS_STAMP}`), pin);
  equal(await native(container, 'for t in bun git tmux tini s3fs fuse-overlayfs mksquashfs unsquashfs zstd curl python3 flock devbox-squashfuse '
    + 'devbox-block-lower sandbox-shim Xkasmvnc openbox tint2 xterm xsetroot chromium xdotool scrot; do command -v "$t" >/dev/null || exit 1; done'), '');
  equal(await native(container, `set -e; d=${SCRATCH}/fuse; mkdir -p $d/src $d/m $d/u $d/w $d/o; echo fuse-ok >$d/src/f; `
    + 'mksquashfs $d/src $d/l.sqsh -noappend -quiet >/dev/null; devbox-squashfuse $d/l.sqsh $d/m; '
    + 'fuse-overlayfs -o lowerdir=$d/m,upperdir=$d/u,workdir=$d/w $d/o; cat $d/o/f; fusermount3 -u $d/o; fusermount3 -u $d/m'), 'fuse-ok');
  await native(container, DESKTOP_START);
  await native(container, DESKTOP_START);
  equal(await native(container, 'pgrep -cx Xkasmvnc; pgrep -cx openbox; pgrep -cx tint2'), '1\n1\n1');

  const rfb = await native(container, `exec 3<>/dev/tcp/127.0.0.1/${String(DESKTOP_PORT)}; printf 'GET /websockify HTTP/1.1\\r\\nHost: box\\r\\n`
    + 'Upgrade: websocket\\r\\nConnection: Upgrade\\r\\nOrigin: http://box\\r\\nSec-WebSocket-Version: 13\\r\\n'
    + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Protocol: binary\\r\\n\\r\\n\' >&3; '
    + 'grep -a -o -m 2 -e "101 Switching Protocols" -e "RFB 003.008" <&3');

  equal(rfb, '101 Switching Protocols\nRFB 003.008');
  const archive = `${SCRATCH}/tools.tgz`;
  await native(container, `head -c 268435456 ${archive} >${SCRATCH}/incomplete.tgz`);
  const refused = await (await container.exec(['/bin/bash', '-c', toolsInstallCommand(`${SCRATCH}/incomplete.tgz`, pin)])).output();
  equal(refused.exitCode, 1);
  equal(await native(container, `cat ${TOOLS_STAMP}`), pin);
  const reinstalled = await native(container, toolsInstallCommand(archive, pin));
  equal(/changed=(\d+)/u.exec(reinstalled)?.[1], '0');
  equal(await native(container, `cat ${TOOLS_STAMP}`), pin);
}

async function exec(box: Devbox<unknown>): Promise<void> {
  const command = String.raw`pwd; printf '%s\n' "$REQUESTS_CA_BUNDLE" "$NODE_EXTRA_CA_CERTS"; printf '\377\000x'; printf 'err\n' >&2; exit 3`;
  const options = { cwd: SCRATCH, env: { REQUESTS_CA_BUNDLE: '/own-bundle.pem' } };
  const bytes = new Uint8Array([...new TextEncoder().encode(`${SCRATCH}\n/own-bundle.pem\n${CONTAINER_TRUST_ENV.NODE_EXTRA_CA_CERTS}\n`), 255, 0, 120]);
  const expected = { stdout: new TextDecoder().decode(bytes), stderr: 'err\n', exitCode: 3 };
  equal(await box.exec(command, options), expected);
  equal(await box.execUntimed(command, { ...options, execId: 'contract-untimed' }), expected);
  const chunks: Uint8Array[] = [];
  equal(await collectExecRecords(await box.execUntimedStream(command, { ...options, execId: 'contract-stream' }), (from, data) => {
    if (from === 'stdout') chunks.push(data);
  }), expected);
  equal(chunks.flatMap(chunk => [...chunk]), [...bytes]);
  const binary = new Uint8Array([137, 80, 0, 255, 254]);
  await box.writeFile(`${SCRATCH}/binary`, btoa(String.fromCharCode(...binary)), { encoding: 'base64' });
  equal((await box.readFile(`${SCRATCH}/binary`, { encoding: 'base64' })).content, btoa(String.fromCharCode(...binary)));
  equal([...new Uint8Array(await new Response(await box.readFileStream(`${SCRATCH}/binary`)).arrayBuffer())], [...binary]);
}

async function processes(container: Container): Promise<void> {
  const process = new Processes(container);
  const ready = (id: string) => native(container, `until [ -e ${SCRATCH}/${id} ]; do sleep 0.05; done`);

  for (const [id, command, exit] of [
    ['ignores', `trap '' TERM; touch ${SCRATCH}/ignores; while :; do sleep 1; done`, 137],
    ['obeys', `touch ${SCRATCH}/obeys; exec sleep 7101`, 143],
  ] as const) {
    await process.start(command, { cwd: '/', processId: id });
    await ready(id);
    const pid = (await process.get(id))?.pid;
    await process.kill(id);
    equal((await process.get(id))?.exitCode, exit);
    equal(await native(container, `ps -o stat= -p ${String(pid)} | awk '$1 !~ /^Z/ {print}'`), '');
  }

  await process.start('sleep 7102', { cwd: `${SCRATCH}/missing`, processId: 'cwd' });
  await native(container, `until [ -e ${ROOT}/cwd/exit ]; do sleep 0.05; done`);
  equal((await process.get('cwd'))?.exitCode, 1);
  equal(await native(container, `cat ${ROOT}/cwd/stderr.log`), `Failed to change directory to '${SCRATCH}/missing'`);
  await native(container, `mkdir -p ${SCRATCH}/missing`);
  await process.start(`touch ${SCRATCH}/cwd; exec sleep 7102`, { cwd: `${SCRATCH}/missing`, processId: 'cwd' });
  await ready('cwd');
  equal(await native(container, "ps -eo args= | grep -cxF 'sleep 7102'"), '1');
  await process.kill('cwd');

  for (const fault of ['refuse', 'lose'] as const) {
    let injected = false;

    const faulted = new Processes({
      get running() { return container.running; },
      exec: async (argv: string[], options?: ContainerExecOptions) => {
        if (!injected && argv[3] === 'devbox-process') {
          injected = true;

          if (fault === 'lose') await container.exec(argv, options);
          throw new Error(`contract ${fault}`);
        }

        return container.exec(argv, options);
      },
    });

    const command = `touch ${SCRATCH}/${fault}; exec sleep ${fault === 'refuse' ? '7103' : '7104'}`;
    const [first] = await Promise.allSettled([faulted.start(command, { cwd: '/', processId: fault })]);
    equal(first?.status, 'rejected');

    if (fault === 'refuse') equal((await faulted.get(fault))?.status, 'failed');
    await faulted.start(command, { cwd: '/', processId: fault });
    await ready(fault);
    equal(await native(container, `ps -eo args= | grep -cxF 'sleep ${fault === 'refuse' ? '7103' : '7104'}'`), '1');
    const pid = await native(container, `cat ${ROOT}/${fault}/pid`);
    equal(pid.split(' ')[1], await native(container, 'cat /proc/sys/kernel/random/boot_id'));
    await faulted.kill(fault);
  }

  await native(container, `for id in restored foreign current; do mkdir -p ${ROOT}/$id; `
    + `printf '{"id":"%s","command":"sleep 1","cwd":"/"}' "$id" >${ROOT}/$id/process.json; ln -sf launched ${ROOT}/$id/launch; done; `
    + `echo 1 >${ROOT}/restored/pid; touch -d 2020-01-01 ${ROOT}/restored/pid; echo '1 foreign-boot' >${ROOT}/foreign/pid; echo 1 >${ROOT}/current/pid`);
  await process.kill('restored');
  await process.kill('foreign');
  equal([(await process.get('restored'))?.status, (await process.get('foreign'))?.status, (await process.get('current'))?.status], ['failed', 'failed', 'running']);
  await native(container, 'kill -0 1');
  await new Files(container).remove(`${ROOT}/current`, { recursive: true });
}

async function kill(box: Devbox<unknown>, container: Container): Promise<void> {
  for (const lane of ['supervised', 'untimed'] as const) {
    for (const response of ['ignore', 'late'] as const) {
      const id = `${lane}-${response}`;
      const sleeper = `sleep ${String(7200 + (lane === 'supervised' ? 0 : 10) + (response === 'ignore' ? 1 : 2))}`;

      const command = response === 'ignore'
        ? `trap '' TERM; ${sleeper} & touch ${SCRATCH}/${id}; wait`
        : `trap '(trap "" TERM; exec ${sleeper}) & exit 0' TERM; sleep 7300 & touch ${SCRATCH}/${id}; wait`;

      const process = new Processes(container);
      const ran = lane === 'untimed' ? box.execUntimed(command, { cwd: '/', execId: id }) : process.start(command, { cwd: '/', processId: id });
      const outcome = Promise.allSettled([ran]);
      await native(container, `until [ -e ${SCRATCH}/${id} ]; do sleep 0.05; done`);

      if (lane === 'untimed') await box.killUntimed(id);
      else await process.kill(id);
      await outcome;
      equal(await native(container, `ps -eo args=,stat= | awk '$1 == "sleep" && $2 == "${sleeper.slice(6)}" && $3 !~ /^Z/ {print}'`), '');
    }
  }
}

async function trust(container: Container): Promise<void> {
  const ca = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
  const bundle = '/etc/ssl/certs/ca-certificates.crt';
  const system = '/etc/ssl/certs/ca-certificates.system.crt';
  // The fixture has no product vault; rotate local roots to prove the shipped trust step, including a bare client.
  const save = await native(container, `mkdir -p ${SCRATCH}/tls /etc/cloudflare/certs; if [ -e ${ca} ]; then cp ${ca} ${SCRATCH}/tls/original; echo yes; fi`);

  try {
    await native(container, `set -e; cd ${SCRATCH}/tls; for name in public intercept next; do `
      + 'openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=$name root" -keyout $name.key -out $name.crt 2>/dev/null; '
      + 'openssl req -newkey rsa:2048 -nodes -subj /CN=localhost -keyout $name-leaf.key -out $name-leaf.csr 2>/dev/null; '
      + 'echo subjectAltName=DNS:localhost >san.ext; openssl x509 -req -in $name-leaf.csr -CA $name.crt -CAkey $name.key -CAcreateserial '
      + '-days 1 -extfile san.ext -out $name-leaf.crt 2>/dev/null; done; '
      + `cat public.crt >>${system}; cat ${system} >${bundle}; `
      + 'for spec in public:9443 intercept:8443 next:7443; do name=${spec%:*}; port=${spec#*:}; '
      + 'setsid openssl s_server -quiet -www -accept $port -cert $name-leaf.crt -key $name-leaf.key >/dev/null 2>&1 </dev/null & done; '
      + 'for port in 9443 8443 7443; do until (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; do sleep 0.05; done; done');
    await native(container, `cp ${SCRATCH}/tls/intercept.crt ${ca}`);
    await (await container.exec([...TRUST])).output();
    const env = Object.entries(CONTAINER_TRUST_ENV).map(([key, value]) => `${key}=${value}`).join(' ');

    for (const port of [9443, 8443]) {
      const url = `https://localhost:${String(port)}/`;
      await native(container, `env -i PATH=/usr/bin:/bin curl -sSf -o /dev/null ${url}; env ${env} curl -sSf -o /dev/null ${url}; `
        + `env ${env} python3 -c "import urllib.request; urllib.request.urlopen('${url}')"; `
        + `! env ${env} git ls-remote ${url}repo.git 2>&1 | grep -qi certificate`);
    }

    await native(container, `env ${env} node -e "fetch('https://localhost:8443/').then(() => process.exit(0), () => process.exit(1))"`);
    await native(container, `cp ${SCRATCH}/tls/next.crt ${ca}`);
    await (await container.exec([...TRUST])).output();
    await (await container.exec([...TRUST])).output();
    equal(await native(container, `curl -sSf -o /dev/null https://localhost:7443/; curl -sSf -o /dev/null https://localhost:8443/ 2>/dev/null && exit 1; `
      + `echo $(( $(grep -c 'BEGIN CERTIFICATE' ${bundle}) - $(grep -c 'BEGIN CERTIFICATE' ${system}) ))`), '1');
  } finally {
    await native(container, `if [ '${save}' = yes ]; then cp ${SCRATCH}/tls/original ${ca}; else rm -f ${ca}; fi; cat ${system} >${bundle}`);
  }
}

/** Compare native POSIX failures with the SDK used before the batched listing. */
export async function fileErrorContract(container: Container, path: string): Promise<void> {
  // 2026-10-09, job 20261009181805-03542862: native user=65534:65534 still read mode-0700 root directories.
  const restricted = { exec: (argv: string[], options?: ContainerExecOptions) => container.exec([
    'setpriv', '--reuid=65534', '--regid=65534', '--clear-groups', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', ...argv,
  ], options) };

  const failures: [string, string][] = [[`${path}/missing`, 'ENOENT'], [`${path}/file`, 'ENOTDIR'], [`${path}/loop`, 'ELOOP'], [`${path}/private`, 'EACCES']];

  for (const [operand, code] of failures) {
    const [batch, sdk] = await Promise.allSettled([
      settle(listFiles(restricted, operand)), new Files(restricted).readDirectory(operand),
    ]);

    if (batch?.status !== 'rejected' || sdk?.status !== 'rejected' || !SandboxFileError.is(sdk.reason)) {
      const batchDetail = batch?.status === 'rejected' ? describeThrown({ cause: batch.reason }) : batch?.status;
      const sdkDetail = sdk?.status === 'rejected' ? describeThrown({ cause: sdk.reason }) : sdk?.status;

      throw new Error(`the ${code} listing contract was not observed: batch=${batchDetail}, SDK=${sdkDetail}`);
    }

    const failure = v.parse(v.object({ cause: v.object({ code: v.string(), path: v.string(), operation: v.string() }) }), batch.reason);

    if (failure.cause.code !== code || sdk.reason.code !== code || failure.cause.path !== sdk.reason.path || failure.cause.operation !== sdk.reason.operation) {
      throw new Error('the batched listing changed the SDK POSIX failure contract');
    }
  }
}

export async function runContainerContract(kind: ContainerContract, box: Devbox<unknown>, container: Container, pin: string): Promise<void> {
  await box.ensureReady();
  await native(container, `mkdir -p ${SCRATCH}`);

  switch (kind) {
    case 'tools': return tools(container, pin);
    case 'exec': return exec(box);
    case 'processes': return processes(container);
    case 'kill': return kill(box, container);
    case 'trust': return trust(container);
  }
}
