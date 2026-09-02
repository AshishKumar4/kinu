#!/usr/bin/env bun
/**
 * Lane 0 in-container helper. Uploaded by probe.ts through `/put` and run
 * through `/exec` under the image's own bun. Every subcommand prints ONE JSON
 * line on stdout; progress and refusals go to stderr.
 *
 *   r2 put KEY BYTES CHECKSUM         one PUT to the SDK-intercepted endpoint,
 *                                     CHECKSUM = sha256 | none; prints the
 *                                     latency and the whole receipt (status,
 *                                     every response header)
 *   r2 range KEY OBJECT_BYTES RANGE_BYTES CONCURRENCY REQUESTS SEED
 *                                     range GETs at a fixed concurrency; p50,
 *                                     p95, MiB/s
 *   r2 head KEY                       HEAD through the endpoint
 *   daemon SOCKET OP                  one control request to a journal daemon
 *   smallstat DIR COUNT               the decisive driver's `small-stat`
 *                                     loop, statSync from bun, ms
 *
 * The endpoint is `http://r2.internal/<binding>/<key>`: the host the SDK
 * registers for outbound interception when a bucket is mounted with
 * `mountBucket`, path-style, no credential (the egress handler resolves the
 * binding from the Worker env and never reads the signature).
 */

import { closeSync, openSync, readdirSync, statSync, writeSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const ENDPOINT = 'http://r2.internal';
const BINDING = 'BACKUP_BUCKET';
const MiB = 1024 * 1024;

const now = (): number => Number(process.hrtime.bigint()) / 1e6;

interface LatencySummary {
  readonly requests: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly meanMs: number;
  readonly maxMs: number;
}

function summarize(latencies: readonly number[]): LatencySummary {
  const sorted = [...latencies].sort((a, b) => a - b);
  const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    requests: sorted.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    meanMs: sorted.length === 0 ? 0 : sum / sorted.length,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

/** Deterministic, incompressible bytes: a store that deduplicates or
 *  compresses cannot shorten a measurement. */
function payload(bytes: number, seed: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let x = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < bytes; i += 4) {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const word = (t ^ (t >>> 14)) >>> 0;
    out[i] = word & 0xff;
    if (i + 1 < bytes) out[i + 1] = (word >>> 8) & 0xff;
    if (i + 2 < bytes) out[i + 2] = (word >>> 16) & 0xff;
    if (i + 3 < bytes) out[i + 3] = (word >>> 24) & 0xff;
  }
  return out;
}

function objectUrl(key: string): string {
  return `${ENDPOINT}/${BINDING}/${key}`;
}

function headerRecord(headers: Headers): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  headers.forEach((value, name) => { out.push({ name, value }); });
  return out;
}

async function r2Put(key: string, bytes: number, checksum: string): Promise<void> {
  const body = payload(bytes, bytes);
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(body);
  const digest = hasher.digest();
  const sha256Hex = Buffer.from(digest).toString('hex');
  const headers = new Headers({
    'content-length': String(bytes),
    'content-type': 'application/octet-stream',
  });
  if (checksum === 'sha256') {
    headers.set('x-amz-content-sha256', sha256Hex);
    headers.set('x-amz-checksum-sha256', Buffer.from(digest).toString('base64'));
  }
  const t0 = now();
  const response = await fetch(objectUrl(key), { method: 'PUT', headers, body });
  const text = await response.text();
  const ms = now() - t0;
  process.stdout.write(`${JSON.stringify({
    op: 'put', key, bytes, checksum, ms, status: response.status, sha256Hex,
    responseHeaders: headerRecord(response.headers), bodyText: text.slice(0, 400),
    mibPerSec: (bytes / MiB) / (ms / 1e3),
  })}\n`);
  if (response.status !== 200) process.exit(1);
}

async function r2Head(key: string): Promise<void> {
  const t0 = now();
  const response = await fetch(objectUrl(key), { method: 'HEAD' });
  const ms = now() - t0;
  process.stdout.write(`${JSON.stringify({
    op: 'head', key, ms, status: response.status, responseHeaders: headerRecord(response.headers),
  })}\n`);
}


async function r2Range(
  key: string, objectBytes: number, rangeBytes: number, concurrency: number, requests: number, seed: number,
): Promise<void> {
  const windows = Math.floor(objectBytes / rangeBytes);
  if (windows < 1) throw new Error('object smaller than one range');
  const latencies: number[] = Array.from({ length: requests }, () => 0);
  let next = 0;
  let bytes = 0;
  let failures = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      if (index >= requests) return;
      next += 1;
      /* 7919 is odd, so this is a permutation for every power-of-two
       * window count the probe uses: no range is reused inside a cell. */
      const window = (index * 7919 + seed) % windows;
      const start = window * rangeBytes;
      const end = start + rangeBytes - 1;
      const t0 = now();
      const response = await fetch(objectUrl(key), { headers: { range: `bytes=${String(start)}-${String(end)}` } });
      const got = await response.arrayBuffer();
      latencies[index] = now() - t0;
      bytes += got.byteLength;
      if (response.status !== 206 || got.byteLength !== rangeBytes) {
        failures += 1;
        process.stderr.write(`range ${String(start)}-${String(end)}: status ${String(response.status)}, ${String(got.byteLength)} bytes\n`);
      }
    }
  };
  const wall0 = now();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const wallMs = now() - wall0;
  process.stdout.write(`${JSON.stringify({
    op: 'range', key, rangeBytes, concurrency, bytes, failures, wallMs,
    ...summarize(latencies), mibPerSec: (bytes / MiB) / (wallMs / 1e3),
  })}\n`);
  if (failures > 0) process.exit(1);
}

/** One JSON line in, one JSON line out, the daemon's own control protocol. */
function daemonRequest(socketPath: string, op: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let received = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: `measure-${String(Date.now())}`, op })}\n`);
    });
    socket.on('data', (chunk: string) => {
      received += chunk;
      const newline = received.indexOf('\n');
      if (newline !== -1) {
        socket.end();
        resolve(received.slice(0, newline));
      }
    });
    socket.on('error', (error: Error) => { reject(new Error(`control socket ${socketPath}: ${error.message}`, { cause: error })); });
    socket.on('close', () => {
      if (!received.includes('\n')) reject(new Error(`control socket ${socketPath} closed before a reply`));
    });
  });
}

async function daemon(socketPath: string, op: string): Promise<void> {
  const t0 = now();
  const reply = await daemonRequest(socketPath, op);
  const ms = now() - t0;
  process.stdout.write(`${JSON.stringify({ op, ms, reply: JSON.parse(reply) })}\n`);
}

/** The decisive driver's small-file loop: create COUNT 256-byte files, then
 *  stat each one from bun and sum the per-call latencies, exactly as
 *  `phaseSmallSized` in scripts/fixtures/r2-bench/probe.ts does. */
function smallStat(dir: string, count: number): void {
  const body = Buffer.alloc(256, 'a');
  const names: string[] = [];
  for (let i = 0; i < count; i++) names.push(join(dir, `f${String(i).padStart(6, '0')}.txt`));
  const createLatencies: number[] = [];
  for (const name of names) {
    const t0 = now();
    const fd = openSync(name, 'w');
    writeSync(fd, body);
    closeSync(fd);
    createLatencies.push(now() - t0);
  }
  const statLatencies: number[] = [];
  for (const name of names) {
    const t0 = now();
    statSync(name);
    statLatencies.push(now() - t0);
  }
  const l0 = now();
  const listed = readdirSync(dir).length;
  const readdirMs = now() - l0;
  const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
  process.stdout.write(`${JSON.stringify({
    op: 'smallstat', dir, count, listed, readdirMs,
    createWallMs: sum(createLatencies), statWallMs: sum(statLatencies),
    stat: summarize(statLatencies),
  })}\n`);
}

function integer(text: string | undefined, what: string): number {
  const value = Number.parseInt(text ?? '', 10);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${what} must be a non-negative integer, got ${String(text)}`);
  return value;
}

async function main(): Promise<number> {
  const [group, ...rest] = process.argv.slice(2);
  if (group === 'r2') {
    const [verb, key] = rest;
    if (key === undefined) throw new Error('r2 needs a key');
    if (verb === 'put') {
      await r2Put(key, integer(rest[2], 'bytes'), rest[3] ?? 'none');
      return 0;
    }
    if (verb === 'head') {
      await r2Head(key);
      return 0;
    }
    if (verb === 'range') {
      await r2Range(
        key, integer(rest[2], 'object bytes'), integer(rest[3], 'range bytes'),
        integer(rest[4], 'concurrency'), integer(rest[5], 'requests'), integer(rest[6], 'seed'),
      );
      return 0;
    }
    throw new Error(`unknown r2 verb ${String(verb)}`);
  }
  if (group === 'daemon') {
    const [socketPath, op] = rest;
    if (socketPath === undefined || op === undefined) throw new Error('daemon needs SOCKET OP');
    await daemon(socketPath, op);
    return 0;
  }
  if (group === 'smallstat') {
    const [dir, count] = rest;
    if (dir === undefined) throw new Error('smallstat needs DIR COUNT');
    smallStat(dir, integer(count, 'count'));
    return 0;
  }
  throw new Error(`unknown command ${String(group)}`);
}

process.exit(await main());
