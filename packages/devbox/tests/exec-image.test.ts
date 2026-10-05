// Rank 42: raw, untimed and streamed exec launch one way in the real image: same cwd, bytes, exit and env precedence.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { collectExecRecords } from '../src/exec-stream';
import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import { CONTAINER_TRUST_ENV } from '../src/processes';
import { buildBlockImage, removeBlockImage } from './support/block-image';
import { Devbox, harness } from './support/devbox-harness';
import { dockerContainer, inContainer } from './support/docker-container';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';

const image = `devbox-exec-${process.pid}`;

const name = `devbox-exec-${process.pid}`;

const cwd = `/tmp/${DEVBOX_SCRATCH_PREFIX}exec`;

class TestBox extends Devbox<unknown> {
  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
  }

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

beforeAll(() => {
  buildBlockImage(image);
  const started = spawnSync('docker', ['run', '--detach', '--name', name, '--network=none', image], { encoding: 'utf8' });

  if (started.status !== 0) throw new Error(started.stderr);
  inContainer(name, ['mkdir', '-p', cwd]);
});

afterAll(() => {
  const removal = spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });

  removeBlockImage(image);

  if (removal.status !== 0) throw new Error(removal.stderr);
});

test('buffered, untimed and streamed exec keep the cwd, the bytes, the exit and a caller\'s env over the trust env', async () => {
  const container = dockerContainer(name);
  const { box } = harness(TestBox, undefined, (argv, options) => container.exec(argv, options));
  await box.devboxStartup();
  const command = String.raw`pwd; printf '%s\n' "$REQUESTS_CA_BUNDLE" "$NODE_EXTRA_CA_CERTS"; printf '\377\000x'; printf 'err\n' >&2; exit 3`;
  const env = { REQUESTS_CA_BUNDLE: '/tmp/own-bundle.pem' };
  const bytes = new Uint8Array([...new TextEncoder().encode(`${cwd}\n/tmp/own-bundle.pem\n${CONTAINER_TRUST_ENV.NODE_EXTRA_CA_CERTS}\n`), 0xff, 0x00, 0x78]);
  const text = { stdout: new TextDecoder().decode(bytes), stderr: 'err\n', exitCode: 3 };
  const streamed: Uint8Array[] = [];

  const buffered = await box.exec(command, { cwd, env });
  const untimed = await box.execUntimed(command, { cwd, env, execId: 'untimed' });
  const stream = await box.execUntimedStream(command, { cwd, env, execId: 'streamed' });
  const collected = await collectExecRecords(stream, (from, data) => { if (from === 'stdout') streamed.push(data); });

  expect({ buffered, untimed, collected, streamedBytes: Buffer.concat(streamed).equals(bytes) })
    .toEqual({ buffered: text, untimed: text, collected: text, streamedBytes: true });
  await box.destroy();
});
