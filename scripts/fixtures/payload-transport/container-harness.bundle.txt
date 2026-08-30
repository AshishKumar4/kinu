/**
 * The IN-CONTAINER harness for the payload-transport benchmark.
 *
 * This file runs INSIDE the @cloudflare/sandbox container under `bun`. The
 * owning Sandbox Durable Object writes this exact source into the container
 * during its idempotent `onStart` (the worker bundles this file as raw text),
 * so there is no second install path to drift.
 *
 * It owns two jobs:
 *
 *   seed      generate a deterministic, effectively incompressible file of an
 *             exact size (mulberry32 over a fixed seed), OUTSIDE all timed windows
 *   transfer  execute ONE timed transport (loopback r2.internal interception,
 *             direct presigned URL, or SigV4 with temporary scoped credentials)
 *             and verify digest + length of what it sent/received
 *
 * Output contract: exactly one JSON object on stdout as the LAST line.
 *
 * CREDENTIALS NEVER APPEAR IN ARGV: the SigV4 arm reads them from the process
 * environment (`BENCH_R2_*`), which the owner DO supplies through
 * ProcessOptions.env. A command line is world-readable in the container; an
 * environment variable is not.
 */

import { createHash, createHmac } from 'node:crypto';
import { statSync } from 'node:fs';

/** Identical generator to the one documented in arms.ts/payload.ts. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIB = 1024 * 1024;

export async function seed(path: string, sizeMiB: number, seedValue: number): Promise<void> {
  const next = mulberry32(seedValue);
  const chunk = new Uint8Array(1 << 20);
  const digest = createHash('sha256');
  // A plain chunked file writer: deterministic bytes, no streaming pitfalls.
  const writer = Bun.file(path).writer();
  for (let written = 0; written < sizeMiB * MIB; written += chunk.length) {
    for (let i = 0; i < chunk.length; i += 1) chunk[i] = Math.floor(next() * 256);
    digest.update(chunk);
    await writer.write(chunk);
  }
  await writer.end();
  process.stdout.write(`${JSON.stringify({ sha256: digest.digest('hex'), bytes: sizeMiB * MIB })}\n`);
}

function sha256Hex(data: ArrayBuffer | Uint8Array): string {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  return createHash('sha256').update(view).digest('hex');
}

interface TransferArgs {
  readonly op: 'put' | 'get';
  readonly mode: 'loopback' | 'direct' | 'sigv4';
  readonly path: string;
  readonly url?: string;
  readonly endpoint?: string;
  readonly key?: string;
}

/**
 * Minimal AWS SigV4 signer for one S3 request using the temporary scoped
 * credentials minted by the owning DO. Signs host, x-amz-content-sha256,
 * x-amz-date, and x-amz-security-token; region 'auto' per R2 convention.
 */
export function sigv4Headers(
  method: 'PUT' | 'GET',
  url: URL,
  payloadHash: string,
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken: string,
): Headers {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers = new Headers({ host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, 'x-amz-security-token': sessionToken });
  const names = [...headers.keys()].sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((name) => `${name}:${headers.get(name)!}\n`).join('');
  const canonicalRequest = [method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), 'auto'), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  headers.set('authorization', `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
  return headers;
}

export async function transfer(args: TransferArgs): Promise<void> {
  const expectedSha256 = sha256Hex(await Bun.file(args.path).arrayBuffer());
  const expectedBytes = statSync(args.path).size;

  let targetUrl: string;
  let init: RequestInit;
  if (args.mode === 'sigv4') {
    const accessKeyId = process.env['BENCH_R2_ACCESS_KEY_ID'];
    const secretAccessKey = process.env['BENCH_R2_SECRET_ACCESS_KEY'];
    const sessionToken = process.env['BENCH_R2_SESSION_TOKEN'];
    if (args.endpoint === undefined || args.key === undefined || accessKeyId === undefined || secretAccessKey === undefined || sessionToken === undefined) {
      throw new Error('sigv4 mode needs endpoint/key arguments plus BENCH_R2_* credential environment variables');
    }
    const url = new URL(`${args.endpoint.replace(/\/$/, '')}/${args.key}`);
    if (args.op === 'put') {
      const body = await Bun.file(args.path).arrayBuffer();
      init = { method: 'PUT', body, headers: sigv4Headers('PUT', url, sha256Hex(body), accessKeyId, secretAccessKey, sessionToken) };
    } else {
      init = { method: 'GET', headers: sigv4Headers('GET', url, sha256Hex(new Uint8Array(0)), accessKeyId, secretAccessKey, sessionToken) };
    }
    targetUrl = url.toString();
  } else {
    if (args.url === undefined) throw new Error(`${args.mode} mode needs --url`);
    targetUrl = args.url;
    init = args.op === 'put' ? { method: 'PUT', body: Bun.file(args.path) } : {};
  }

  const started = performance.now();
  const response = await fetch(targetUrl, init);
  if (!response.ok) throw new Error(`${args.mode} ${args.op} → ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const received = args.op === 'get' ? new Uint8Array(await response.arrayBuffer()) : null;
  const ms = performance.now() - started;

  // Digest AND length verified inside the container, against the seeded source.
  const receivedSha256 = received === null ? expectedSha256 : sha256Hex(received);
  const receivedBytes = received === null ? expectedBytes : received.byteLength;
  if (receivedSha256 !== expectedSha256 || receivedBytes !== expectedBytes) {
    process.stdout.write(`${JSON.stringify({ corrupt: true, expectedSha256, receivedSha256, expectedBytes, receivedBytes })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ ms, sha256: receivedSha256, bytes: receivedBytes })}\n`);
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === 'seed') {
    await seed(flag('--path')!, Number(flag('--size-mib')), Number(flag('--seed')));
  } else if (command === 'transfer') {
    await transfer({
      op: flag('--op') === 'put' ? 'put' : 'get',
      mode: flag('--mode') === 'loopback' ? 'loopback' : flag('--mode') === 'direct' ? 'direct' : 'sigv4',
      path: flag('--path')!,
      url: flag('--url'),
      endpoint: flag('--endpoint'),
      key: flag('--key'),
    });
  } else {
    throw new Error(`unknown harness command: ${String(command)}`);
  }
}
