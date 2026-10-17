#!/usr/bin/env bun
/** Real-container contracts at the staging deploy tier (m282, D72). Each run deploys the lasting fixture Worker again and
 *  owns its bucket, boxes, snapshots and containers (`fixtures/devbox-e2e/fixture.ts`). */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { copyPinnedTools, uploadPinnedTools } from './devbox-tools';
import { requireEqual, tierIdentity } from './fixtures/devbox-e2e/oracle';
import { completeTeardown } from './fixtures/devbox-e2e/teardown';
import { CONTRACT_TEARDOWN_BUCKET, ContractTeardownSchema, contractLedger, contractOwner, contractOwnerEnded, recoverAbandoned } from './fixtures/devbox-e2e/ledger';
import { dropLease, fixtureNames, takeLease } from './fixtures/devbox-e2e/fixture';
import type { ContractLedger } from './fixtures/devbox-e2e/ledger';
import { containerApplicationsNamed, r2, requireCloudflareAccountId } from './infra-cloudflare';
import { deployedConfig } from './infra-manifest';
import { r2ResiduePlane, drainBucketResidue } from './bench-devbox-fixture';
import { deleteR2Prefix } from './cloudflare-rest';
import { restApiToken } from './cloudflare-token';
import { runWrangler, publishTeardown, runTeardownOnce, delay } from './ephemeral-deployment';
import { snapshotRegistry } from '../packages/devbox/src/snapshot-registry';
import artifact from '../packages/devbox/block-lower/upstream.json';
import { CONTAINER_CONTRACTS, DISK_CONTRACTS } from '../packages/devbox/bench/contract-types';
import { shellQuote } from '../packages/core/src/utils/shell';
import { endedNearSilence } from './row-verdicts';
import { withTestChrome } from './test-chrome';
import { contextSignedInAt } from '../evals/src/browser';
import { BOX_CHROMIUM_POLICY, CHROMIUM_PROFILES, DESKTOP_COLOURS, DESKTOP_LOG, DESKTOP_PANEL, DESKTOP_SIZE } from '../packages/devbox/src/desktop';
import { CHORD, DISTINCT_PY, DOWN_PY, GRID, GRID_POINTS, HOLD, RANGE, RING_PY, SCROLL, SITE_TRUST_PY, TEXT, TICKER, sizeOf } from './fixtures/devbox-e2e/desktop-pages';
import { REPO_ROOT as REPO } from './repo-root';


const ACCOUNT = requireCloudflareAccountId();

/** The box's own words when the platform refused it a container and it armed a startup (packages/devbox/src/devbox.ts). */
const ASK_AGAIN = 'A startup is armed, so ask again';

/** Asks of one call, a minute apart in all: the startup the box armed retries within seconds. */
const ASK_AGAIN_TIMES = 12;

const ASK_AGAIN_MS = 5_000;

/** The name the fixture's boxes answer to (its `hostname`, set through the Worker's vars). */
const BOX_NAME = 'contract-box';

/** Sites the desktop's browser opens over HTTPS, and a word of each one's title. */
const TRUSTED_SITES = [['https://example.com/', 'Example Domain'], ['https://github.com/', 'GitHub'], ['https://en.wikipedia.org/wiki/Main_Page', 'Wikipedia']] as const;

/** The port the name step's server binds; no other step listens on it. */
const NAME_HTTP_PORT = 8799;

/**
 * The box's name, read in the box (D96): the kernel's, the prompt a person's shell shows, how a lookup of the name
 * answers (its time and addresses), what getfqdn makes of it, and whether `python3 -m http.server`, which calls it as it
 * binds, serves. The platform's own 64-character name is no DNS label, and Python died on it.
 */
const BOX_NAME_READ = [
  'printf "kernel=%s\\n" "$(hostname)"',
  `printf "prompt=%s\\n" "$(cd /workspace 2>/dev/null; TERM=dumb bash -i -c 'printf "%s" "\${PS1@P}"' 2>/dev/null)"`,
  `printf "lookup=%s\\n" "$(python3 -c 'import socket,time
t=time.time()
try: a=sorted({r[4][0] for r in socket.getaddrinfo(socket.gethostname(), None)})
except Exception as e: a=[type(e).__name__]
print("%d %s" % ((time.time()-t)*1000, " ".join(a)))' 2>&1 | tail -1)"`,
  `printf "fqdn=%s\\n" "$(python3 -c 'import socket; print(socket.getfqdn())' 2>&1 | tail -1)"`,
  // The lookup's answers that are the box's own: an address a socket on the box can bind, and not loopback's.
  `printf "own=%s\\n" "$(python3 -c 'import ipaddress,socket
own=[]
for info in socket.getaddrinfo(socket.gethostname(), None, type=socket.SOCK_DGRAM):
    address=info[4][0]
    if ipaddress.ip_address(address.split("%")[0]).is_loopback: continue
    try: socket.socket(info[0], socket.SOCK_DGRAM).bind(info[4])
    except OSError: continue
    own.append(address)
print(" ".join(sorted(set(own))))' 2>&1 | tail -1)"`,
  `( cd /var/tmp && timeout 8 python3 -m http.server ${String(NAME_HTTP_PORT)} >/var/tmp/name-http.log 2>&1 & )`,
  `for _ in $(seq 40); do python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${String(NAME_HTTP_PORT)}/', timeout=1)" 2>/dev/null && break; sleep 0.1; done`,
  `printf "http=%s\\n" "$(python3 -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:${String(NAME_HTTP_PORT)}/', timeout=2).status)" 2>&1 | tail -1) $(tail -1 /var/tmp/name-http.log | cut -c1-80)"`,
].join('\n');

/** A lookup of the box's own name answers locally: measured 3 ms with libnss-myhostname, against 79-430 ms at DNS. */
const NAME_LOOKUP_MS = 50;

/** How long the tier watches a refused box for another start: the box this contract caught re-armed every second. */
const PARKED_WATCH_MS = 20_000;

/** A job that stops at a prompt, then answers with what it was told (D95). */
const JOB_PROMPT = 'printf "Your name? "; read name; echo "hi $name"';

/** How many times, and how far apart, a job's status is read while it starts and finishes: a person waits seconds. */
const JOB_READS = 40;

const JOB_READ_MS = 500;

/**
 * A server a session runs in a folder of its own, as the computer-sessions flow does on a deployment. The folder's name
 * holds a space, quotes, a dollar and the marker f588b0bed reserved: any folder reads back whole. A tab and a
 * backslash are the unit test's, from real tmux: typed into a pane, a tab completes instead of arriving.
 */
const SESSION_FOLDER = `/workspace/flow web/<<kinu>>/a"b'c $x`;

const SESSION_PORT = 8765;

/** The folder as one shell word: single-quoted, each single quote closed, escaped and reopened. */
const SESSION_FOLDER_WORD = `'${SESSION_FOLDER.replaceAll("'", String.raw`'\''`)}'`;

const SESSION_SERVER = `mkdir -p ${SESSION_FOLDER_WORD} && cd ${SESSION_FOLDER_WORD} && python3 -m http.server ${String(SESSION_PORT)}`;

/** How many times, and how far apart, the sessions are read while the server starts: a person waits seconds. */
const SESSION_READS = 20;

const SESSION_READ_MS = 500;

/**
 * Bun's WebSocket, which takes the handshake's headers (bun-types `Bun.WebSocketOptions`); the ambient type here is
 * undici's, which takes protocols only (as evals/src/session-protocol.ts measured). The fixture admits a bearer header.
 */
const HeaderSocket = v.parse(
  v.custom<new (url: URL, options: Bun.WebSocketOptions) => WebSocket>((value) => value === globalThis.WebSocket, 'the global WebSocket constructor'),
  globalThis.WebSocket,
);

const RESURRECT_MARKER = '/var/tmp/kinu-resurrect-marker';

const RESURRECT_COUNT = '/var/tmp/kinu-resurrect-count';

/**
 * What a person was running when the box stopped (D97): quotes, a `$()` that touches a marker, `;`, and a newline inside
 * a quoted string, ending in a long sleep so it runs as the box stops. Typed into the session as a person types it.
 */
const RESURRECT_LINE = `echo "it's $(touch ${RESURRECT_MARKER}; echo ok)"; printf 'a;b\\n'; echo 1 >> ${RESURRECT_COUNT}; echo "two
lines"; sleep 600`;

/** After the prompt shows, how long the step waits before reading the files: long enough for a line to have run. */
const RESURRECT_SETTLE_MS = 2_000;

/** How many times, and how far apart, the session's screen and files are read across the stop: a person waits seconds. */
const RESURRECT_READS = 120;

const RESURRECT_READ_MS = 500;

/** How long after its first frame a fresh desktop must show its background and panel: a person waits seconds, not minutes. */
const DESKTOP_SEEN_MS = 30_000;

/** The ground a bell's ring is followed by: no colour the desktop draws, so seeing it is seeing what came after. */
const RUNG = '#ff00ff';

const Json = v.looseObject({ error: v.optional(v.string()) });

const Exec = v.object({ exitCode: v.number(), stdout: v.string(), stderr: v.string() });

/** What `computer.screenshot()` and `computer.watch()` answer a program: a PNG data URL. */
const Screen = v.pipe(v.string(), v.startsWith('data:image/png;base64,'));

/** A refusal a program branches on. */
const Refused = v.object({ success: v.literal(false), reason: v.string(), error: v.string() });

/** A desktop member's value: the screen, null for an action, or a refusal. */
const AgentAnswer = v.union([Screen, v.null(), Refused]);

const Commit = v.looseObject({ kind: v.string(), reason: v.optional(v.string()), movedBytes: v.optional(v.number()) });

/** What a box holds once cleared (`ContractBox.clear`). */
const Emptied = v.object({ running: v.boolean(), keys: v.number(), tables: v.number(), alarm: v.nullable(v.number()) });

const State = v.looseObject({ chain: v.nullable(v.looseObject({ rev: v.number(), base: v.looseObject({ key: v.string() }), deltas: v.array(v.unknown()) })), snapshot: v.nullable(v.looseObject({ id: v.string() })) });

/** A `--tools` file is uploaded as the pin's parts; without one, staging's are copied. */
async function installTools(bucket: string, cached: string | undefined): Promise<void> {
  if (cached === undefined) await copyPinnedTools(bucket);
  else uploadPinnedTools(bucket, readFileSync(cached));
}

interface Step { readonly contract: string; readonly ms: number; readonly detail: unknown }

/** The desktop as its client draws it: pixels at the ground, the wallpaper's glow and the panel, and where it is drawn. */
interface DesktopReading {
  readonly desktop: readonly number[];
  readonly glow: readonly number[];
  readonly panel: readonly number[];
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

interface FixtureSecrets {
  readonly EVAL_IDENTITY: string;
  readonly DEVBOX_REGISTRY_TOKEN: string;
  PROBE_ACCESS_KEY_ID?: string;
  PROBE_SECRET_ACCESS_KEY?: string;
}

/** The header the fixture sets on every answer it makes (`devbox-contracts.ts`). */
const FIXTURE_ANSWER = 'x-devbox-fixture';

/** How long after a deploy an edge may still answer the fixture's route with its own 404 page. */
const ROUTE_ROLLOUT_MS = 180_000;

/**
 * A request to the fixture, answered by the fixture. For minutes after `wrangler deploy` some edges answer the new
 * workers.dev route with Cloudflare's own 404 page, authorized or not, between answers from the fixture
 * (armada 20261013191147-e27c45c5: 401, 401, then a 404 page, then 401 again), so one answer is not the route serving.
 * An answer without the fixture's mark is asked again until the rollout's bound; past it, it is the answer.
 */
async function fixtureFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const until = Date.now() + ROUTE_ROLLOUT_MS;

  for (;;) {
    const reply = await fetch(url, init);

    if (reply.headers.has(FIXTURE_ANSWER) || Date.now() >= until) return reply;
    await reply.body?.cancel();
    await delay(3_000);
  }
}

function writeFixtureConfig(worker: string, bucket: string, scratch: string, priorDeclared?: string) {
  const config = join(scratch, 'wrangler.jsonc');
  const imageArgument = process.argv.indexOf('--declared-image');
  const productContainer = deployedConfig('staging').containers?.find(row => row.class_name === 'KinuDevbox');
  const configured = productContainer !== undefined && 'images' in productContainer ? productContainer.images?.['devbox']?.image : undefined;
  const declared = priorDeclared ?? (imageArgument === -1 ? configured ?? artifact.base : process.argv[imageArgument + 1]);

  if (declared === undefined) throw new Error('the staging config names no devbox image');
  const containers: { class_name: string; scheduling_policy: string; images?: { devbox: { image: string } } }[] = [{ class_name: 'ContractBox', scheduling_policy: 'durable_object' }];

  if (declared !== artifact.base) containers[0] = { class_name: 'ContractBox', scheduling_policy: 'durable_object', images: { devbox: { image: declared } } };
  writeFileSync(config, JSON.stringify({
    name: worker, account_id: ACCOUNT, main: join(REPO, 'packages/cf-backend/tests/fixtures/devbox-contracts.ts'),
    compatibility_date: '2026-09-30', compatibility_flags: ['nodejs_compat'], workers_dev: true,
    observability: { enabled: true },
    durable_objects: { bindings: [{ name: 'Box', class_name: 'ContractBox' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['ContractBox'] }],
    containers,
    r2_buckets: [{ binding: 'STORE', bucket_name: bucket }],
    assets: { directory: join(REPO, 'packages/cf-backend/public'), binding: 'ASSETS', run_worker_first: true },
    vars: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, PROBE_BUCKET: bucket, PROBE_HTTP: process.argv.includes('--probe') ? '1' : '0', BOX_NAME },
  }));

  return { config, declared };
}

function recoveryReport(argument: number) {
  if (argument === -1) return undefined;

  return v.parse(v.object({
    ...ContractTeardownSchema.entries,
    steps: v.array(v.object({ contract: v.string(), ms: v.number(), detail: v.unknown() })),
  }), JSON.parse(readFileSync(process.argv[argument + 1] ?? '', 'utf8')));
}

/** The registry token production's devbox holds and the deploy's REST token, armada secrets both (the row's `secrets`),
 *  never wrangler's OAuth token, which expired mid-run (2026-10-08: the fixture's snapshot cleanup answered 401 minutes
 *  after it started) and which no armada container holds. Every wrangler this tier starts reads the REST token as its
 *  CLOUDFLARE_API_TOKEN, so none falls back to a login. */
function fixtureTokens() {
  const token = process.env['DEVBOX_REGISTRY_TOKEN']?.trim() ?? '';
  const rest = restApiToken();

  if (token === '' || rest === '') throw new Error('the real-container tier needs DEVBOX_REGISTRY_TOKEN and KINU_CLOUDFLARE_API_TOKEN (armada secrets)');
  process.env['CLOUDFLARE_API_TOKEN'] = rest;

  return { token, rest };
}

function fixturePlan(recovering: ReturnType<typeof recoveryReport>) {
  const run = recovering?.run ?? `dc${new Date().toISOString().replace(/\D/gu, '').slice(0, 14)}${crypto.randomUUID().slice(0, 5)}`;
  const named = fixtureNames(run);
  const worker = recovering?.worker ?? named.worker;
  const bucket = recovering?.bucket ?? named.bucket;
  const box = `eval-devbox-${run}`;
  // The fifth is a box only the desktop's check opens, so it opens on a fresh box; the sixth is the agent's desktop box;
  // the seventh fails every start (D94); the eighth stops and starts under an open terminal session (D97).
  const names = recovering?.boxes ?? [box, `${box}-native`, `${box}-disk`, 'devbox-golden', `${box}-desktop`, `${box}-agent`, `${box}-parked`, `${box}-sessions`];
  const app = recovering?.app ?? named.app;
  const owner = recovering?.owner ?? contractOwner(process.env);
  const { job, index, attempt, vessel, statusUrl } = owner;
  const reportedOwner = { job, index, attempt, vessel, statusUrl };

  return { run, worker, bucket, box, names, app, owner, reportedOwner };
}

function prepareLedger() {
  const accessKeyId = process.env['R2_ACCESS_KEY_ID'];
  const secretAccessKey = process.env['R2_SECRET_ACCESS_KEY'];

  if (accessKeyId === undefined || secretAccessKey === undefined) throw new Error('the real-container tier requires its R2 keys to persist teardown outside the checkout');
  const control = r2(CONTRACT_TEARDOWN_BUCKET);

  if (control.state === 'unknown') throw new Error(control.reason);

  if (control.state === 'absent') {
    // Another tier may have provisioned the same permanent control bucket after this read.
    runWrangler(REPO, ['r2', 'bucket', 'create', CONTRACT_TEARDOWN_BUCKET], { allowFailure: true });
    const provisioned = r2(CONTRACT_TEARDOWN_BUCKET);

    if (provisioned.state !== 'present') throw new Error(`contract teardown control bucket was not provisioned: ${JSON.stringify(provisioned)}`);
  }

  const ledger = contractLedger({ account: ACCOUNT, accessKeyId, secretAccessKey });

  return { ledger, accessKeyId, secretAccessKey };
}

/** Each abandoned run's teardown, replayed by this script's own `--cleanup-report` in a directory of its own. */
async function recoverContracts(ledger: ContractLedger, scratch: string): Promise<Step[]> {
  return recoverAbandoned(await ledger.pending(), async (abandoned) => {
    const directory = join(scratch, abandoned.run);

    mkdirSync(directory, { recursive: true });
    const recovery = join(directory, 'recovery.json');

    writeFileSync(recovery, JSON.stringify({ ...abandoned, steps: [] }));
    const replay = Bun.spawn([process.execPath, import.meta.path, '--cleanup-report', recovery], { cwd: REPO, env: process.env, stdout: 'inherit', stderr: 'inherit' });

    try {
      if (await replay.exited !== 0) throw new Error(`its replay exited ${String(replay.exitCode)}`);
    } finally { rmSync(recovery, { force: true }); }
  });
}

async function main(): Promise<void> {
  const identity = tierIdentity(process.env);
  const recoveryArgument = process.argv.indexOf('--cleanup-report');
  const recovering = recoveryReport(recoveryArgument);
  const { run, worker, bucket, box, names, app, owner, reportedOwner } = fixturePlan(recovering);
  const scratch = recovering === undefined ? mkdtempSync(join(tmpdir(), 'kinu-devbox-contracts-')) : dirname(process.argv[recoveryArgument + 1] ?? '');
  process.env['WRANGLER_LOG_PATH'] = join(scratch, 'wrangler');
  const { token, rest } = fixtureTokens();
  const { ledger, accessKeyId, secretAccessKey } = prepareLedger();
  const applicationIds = new Set<string>(recovering?.applicationIds);
  const report = join(scratch, 'report.json');
  const steps: Step[] = recovering?.steps ?? [];
  const snapshots = new Set<string>(recovering?.snapshots);
  const cleanupErrors: string[] = [];
  const { config, declared } = writeFixtureConfig(worker, bucket, scratch, recovering?.declared);
  let origin: string | undefined = recovering?.origin;

  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  const dirtyDigest = createHash('sha256').update(spawnSync('git', ['diff', 'HEAD'], { cwd: REPO }).stdout).digest('hex');

  const writeReport = async () => {
    await ledger.put({ schema: 'devbox-contracts/teardown@3', run, worker, app, bucket, boxes: names, declared, origin, snapshots: [...snapshots], applicationIds: [...applicationIds], owner });
    const contents = JSON.stringify({ run, worker, app, bucket, boxes: names, box, declared, origin, revision, dirtyDigest, steps, snapshots: [...snapshots], applicationIds: [...applicationIds], owner: reportedOwner, cleanupErrors }, null, 2);
    writeFileSync(report, contents);
    const evidence = process.env['BENCH_ARTIFACTS'];

    if (evidence !== undefined) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, `${run}.json`), contents);
    }
  };

  const call = async <Schema extends v.GenericSchema>(path: string, schema: Schema, body?: Record<string, string>, name = box): Promise<v.InferOutput<Schema>> => {
    if (origin === undefined) throw new Error('the fixture has not deployed');
    const url = new URL(path, origin);
    url.searchParams.set('box', name);

    // A box the platform refused a container (a dropped connection, no room) arms its own startup and says to ask
    // again; a contract asks again, as an agent does, rather than read a platform refusal as the contract broken
    // (390ad4e4c's disk-chain: "Network connection lost." after /lose-snapshot).
    for (let asked = 1; ; asked += 1) {
      const reply = await fixtureFetch(url, { headers: { authorization: `Bearer ${identity}`, 'content-type': 'application/json' }, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
      const value: unknown = await reply.json();

      if (reply.ok) return v.parse(schema, value);
      const said = JSON.stringify(value);

      if (asked < ASK_AGAIN_TIMES && said.includes(ASK_AGAIN)) {
        process.stdout.write(`[${run}] ${path}: not ready, asking again: ${said.slice(-300)}\n`);
        await delay(ASK_AGAIN_MS);
        continue;
      }

      throw new Error(`${path}: ${String(reply.status)} ${said.slice(-900)}`);
    }
  };

  const step = async <Evidence>(contract: string, work: () => Promise<Evidence>) => {
    const at = Date.now();
    const detail = await work();
    steps.push({ contract, ms: Date.now() - at, detail });
    await writeReport();
    process.stdout.write(`[${run}] ${contract}: ${String(Date.now() - at)} ms\n`);
  };

  /** A person at a computer's terminal session (`shell`), through the product's own attach: what it shows, and keys. */
  const openSession = async (name: string) => {
    if (origin === undefined) throw new Error('the fixture has not deployed');
    const url = new URL(`/api/workspaces/${name}/terminal`, origin.replace(/^http/u, 'ws'));
    url.searchParams.set('executor', 'computer');
    url.searchParams.set('session', 'shell');
    url.searchParams.set('cols', '160');
    url.searchParams.set('rows', '40');
    const socket = new HeaderSocket(url, { headers: { authorization: `Bearer ${identity}` } });
    const decoder = new TextDecoder();
    let shown = '';

    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => { if (event.data instanceof ArrayBuffer) shown += decoder.decode(event.data, { stream: true }); });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => { resolve(); }, { once: true });
      socket.addEventListener('error', () => { reject(new Error(`the terminal of ${name} refused the socket`)); }, { once: true });
    });

    return {
      // The screen's text, its escape sequences left out.
      screen: () => stripVTControlCharacters(shown).replaceAll('\r', ''),
      type: (keys: string) => { socket.send(new TextEncoder().encode(keys)); },
      close: () => { socket.close(); },
    };
  };

  /** Asks again until `holds`, as a person watching would, up to RESURRECT_READS times. */
  const waitFor = async (holds: () => boolean | Promise<boolean>, what: string) => {
    for (let asked = 0; asked < RESURRECT_READS; asked++) {
      if (await holds()) return;
      await delay(RESURRECT_READ_MS);
    }

    throw new Error(`waited ${String(RESURRECT_READS * RESURRECT_READ_MS / 1000)} s for ${what}`);
  };

  const shell = async (command: string, name = box) => {
    const ran = await call('/exec', Exec, { command }, name);

    if (ran.exitCode !== 0) throw new Error(`container command failed (${String(ran.exitCode)}): ${ran.stderr.slice(-900)}`);

    return ran.stdout.trim();
  };

  const collectSnapshots = async (name: string) => {
    for (const id of await call('/snapshots', v.array(v.string()), undefined, name)) snapshots.add(id);
    await writeReport();
  };

  const registry = snapshotRegistry({ account: ACCOUNT, token, fetch: (input, init) => fetch(input, init) });
  // The application's id, learnt once the deploy made it: its snapshots are found by it.
  const learnApplication = () => { for (const found of containerApplicationsNamed([app])) applicationIds.add(found.id); };

  publishTeardown(async () => {
    let recorded = false;

    const outcome = await completeTeardown({
      health: async () => origin === undefined ? null : (await fixtureFetch(`${origin}/health`, { headers: { authorization: `Bearer ${identity}` } })).status,
      boxes: async (health) => {
      learnApplication();
      await writeReport();
      recorded = true;
      const failed: string[] = [];

      const each = async (name: string, work: () => Promise<void>) => {
        const [settled] = await Promise.allSettled([work()]);

        if (settled?.status === 'rejected') failed.push(`${name}: ${String(settled.reason)}`);
      };

      // The bucket goes only once every box is empty (`completeTeardown`), so with it gone there is nothing to clear,
      // and a clear, which reads the store, would fail on its absence.
      const storeGone = r2(bucket).state === 'absent';

      // `origin` is recorded once this run deployed the fixture: before that it made no box.
      if (origin !== undefined && !storeGone && 'status' in health && health.status !== 404) for (const name of names) {
        await each(`snapshots ${name}`, async () => { await collectSnapshots(name); });
        // Each box answers what it holds once cleared: its container stopped, and no key, table or alarm left.
        await each(`cleanup ${name}`, async () => { requireEqual(await call('/cleanup', Emptied, {}, name), { running: false, keys: 0, tables: 0, alarm: null }); });
      }

      for (const id of snapshots) await each(`snapshot ${id}`, async () => {
        const removed = await registry.delete(id);

        if (removed.kind === 'refused') throw new Error(removed.reason);
        requireEqual((await registry.delete(id)).kind, 'absent');
      });

      if (failed.length > 0) throw new Error(failed.join('; '));
      },
      snapshots: async () => {
      if (!recorded) throw new Error('application identities were not persisted; snapshots retained for recovery');

      for (const applicationId of applicationIds) {
        const swept = await registry.deleteApplication(applicationId);

        if (swept.kind === 'refused') throw new Error(`${app}'s snapshots were not deleted: ${swept.reason}`);

        if (swept.left.length > 0) throw new Error(`${app} left ${String(swept.left.length)} snapshot(s) in the registry: ${swept.left.join(', ')}`);
      }
      },
      bucket: async () => {
      if (!recorded) throw new Error('application identities were not persisted; bucket retained for recovery');
      // By name: `r2 bucket list` answers its first 20 buckets only, so a bucket past that page read as gone, and
      // every run on an account of more than 20 left its bucket behind (seven on 2026-10-08).
      const before = r2(bucket);

      if (before.state === 'absent') return;

      if (before.state === 'unknown') throw new Error(before.reason);
      await deleteR2Prefix({ accountId: ACCOUNT, bucket, prefix: '', token: rest });
      await drainBucketResidue(r2ResiduePlane({ accountId: ACCOUNT, accessKeyId, secretAccessKey }), bucket);
      runWrangler(REPO, ['r2', 'bucket', 'delete', bucket]);
      const after = r2(bucket);

      if (after.state !== 'absent') throw new Error(`the bucket is ${after.state === 'present' ? 'still there' : after.reason} after deletion`);
      },
    });

    steps.push({ contract: 'cleanup-health', ms: 0, detail: outcome.health });
    cleanupErrors.push(...outcome.errors);
    await writeReport();

    if (cleanupErrors.length === 0) await ledger.remove(run);

    // A replay runs under the lease of the run that replays it.
    if (recovering === undefined) {
      const [dropped] = await Promise.allSettled([dropLease(ledger.lease(worker), run)]);

      if (dropped?.status === 'rejected') cleanupErrors.push(`lease: ${String(dropped.reason)}`);
    }
  });

  for (const [signal, status] of [['SIGTERM', 143], ['SIGINT', 130]] as const) process.once(signal, () => {
    void runTeardownOnce().then(() => { process.exit(cleanupErrors.length === 0 ? status : 1); }, (...rejection: [unknown]) => {
      const [cause] = rejection;
      process.stderr.write(`fixture teardown failed: ${String(cause)}\n`);
      process.exit(1);
    });
  });

  if (recovering === undefined) {
    await takeLease(ledger.lease(worker), { schema: 'devbox-contracts/lease@1', worker, run, owner }, async (holder) => await contractOwnerEnded(holder));

    // The teardown gives the lease up, with nothing of this run's made yet.
    try { steps.push(...await recoverContracts(ledger, scratch)); }
    catch (cause) { await runTeardownOnce(); throw cause; }
  }

  // Durable before the first fixture bucket, Worker or application exists.
  await writeReport();
  process.stdout.write(`[${run}] report ${report}\n`);

  if (recovering !== undefined) {
    await runTeardownOnce();

    if (cleanupErrors.length !== 0) throw new Error(cleanupErrors.join('; '));
    process.stdout.write(`[${run}] recovered cleanup verified\n`);

    return;
  }

  /**
   * What a person sees on opening the desktop of a fresh box with nothing launched, through the product's client and
   * routes in a browser on this host: a desktop (its background, a panel along its foot), not a black screen, whose
   * panel launches a terminal and a browser (D80). Production opened an empty X session and showed a cursor on black.
   */
  const desktopClient = async () => {
    await step('desktop-client', async () => {
      const fresh = names[4] ?? '';

      try {
        return await withTestChrome(async browser => {
          // What the step waits on now, and what it last read there: named when the run's silence nears its bound.
          let waiting = 'the sign-in on the fixture';
          let reading = '';
          const heard: string[] = [];

          const watched = (async () => {
            // Signed in once on the fixture's origin, which the browser scopes the session to (`contextSignedInAt`).
            const page = await (await contextSignedInAt(browser, `${origin}/sign-in`, { authorization: `Bearer ${identity}` })).newPage();
            page.setDefaultTimeout(0);
            page.on('console', (message) => { if (message.type() === 'error' && heard.length < 12) heard.push(`console: ${message.text().slice(0, 200)}`); });
            page.on('requestfailed', (request) => { if (heard.length < 12) heard.push(`failed: ${request.url().slice(0, 160)} ${request.failure()?.errorText ?? ''}`); });
            page.on('response', (response) => { if (response.status() >= 400 && heard.length < 12) heard.push(`${String(response.status())}: ${response.url().slice(0, 160)}`); });
            await page.setViewport({ width: 1300, height: 820 });
            waiting = 'the view page';
            await page.goto(`${origin}/view?box=${fresh}`);
            waiting = 'the view page\'s frame';
            const frame = await (await page.waitForSelector('iframe'))?.contentFrame();

            if (frame == null) throw new Error('the desktop client did not frame');

            // The desktop a quarter in from its corner, where X never starts its pointer (the middle), the wallpaper's glow
            // just above the panel's middle, and the foot's middle, in the desktop's own coordinates; and where the client
            // draws it.
            const screen = (): Promise<DesktopReading | null> => frame.evaluate((size, footY, glowY) => {
              const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];

              if (canvas === undefined || canvas.width < 640) return null;
              const context = canvas.getContext('2d');
              const at = (x: number, y: number) => [...context?.getImageData(x * canvas.width / size.width, y * canvas.height / size.height, 1, 1).data ?? []];
              const rect = canvas.getBoundingClientRect();

              return {
                desktop: at(size.width / 4, size.height / 4), glow: at(size.width / 2, glowY), panel: at(size.width / 2, footY),
                rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
              };
            }, DESKTOP_SIZE, DESKTOP_SIZE.height - DESKTOP_PANEL.height / 2, DESKTOP_SIZE.height - DESKTOP_PANEL.height - 8);

            // The client's first frame: its canvas drawn opaque at the middle. Read, not awaited by the page, so a wait
            // that never ends says what the frame held.
            waiting = 'the desktop client\'s first frame';

            for (;;) {
              const first = await frame.evaluate(() => {
                const canvases = [...document.querySelectorAll('canvas')].sort((x, y) => y.width * y.height - x.width * x.height);
                const canvas = canvases[0];
                const alpha = canvas === undefined || canvas.width < 640 ? null : canvas.getContext('2d')?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data[3] ?? null;

                return { href: location.href, canvases: canvases.map((each) => `${String(each.width)}x${String(each.height)}`), alpha, text: document.body?.innerText.slice(0, 160) ?? '' };
              });

              reading = JSON.stringify(first);

              if (first.alpha === 255) break;
              await delay(250);
            }

            const near = (rgba: readonly number[] | undefined, hex: string) => rgba !== undefined
              && [1, 3, 5].every((at, channel) => Math.abs((rgba[channel] ?? -99) - Number.parseInt(hex.slice(at, at + 2), 16)) <= 12);

            // The wallpaper's glow warms the ground above the panel: its red stands well above its blue, where the bare
            // ground's sit within a few levels of each other (D88).
            const glowing = (rgba: readonly number[] | undefined) => rgba !== undefined && (rgba[0] ?? 0) - (rgba[2] ?? 0) >= 12;

            const drawn = (shown: DesktopReading | null) => shown !== null
              && near(shown.desktop, DESKTOP_COLOURS.background) && glowing(shown.glow) && near(shown.panel, DESKTOP_COLOURS.panel);

            // The first frame may come before the panel and the wallpaper paint: a person sees the desktop within seconds, or
            // sees none.
            waiting = 'the desktop\'s ground, wallpaper and panel';
            const seenBy = Date.now() + DESKTOP_SEEN_MS;
            let seen = await screen();

            while (!drawn(seen) && Date.now() < seenBy) {
              await delay(250);
              seen = await screen();
              reading = JSON.stringify(seen);
            }

            if (seen === null || !drawn(seen)) {
              throw new Error(`opening the desktop of a fresh box showed ${JSON.stringify({ desktop: seen?.desktop, glow: seen?.glow, panel: seen?.panel })} `
                + `${String(DESKTOP_SEEN_MS / 1000)} s after its first frame, not its ground ${DESKTOP_COLOURS.background}, the wallpaper's glow `
                + `and the panel ${DESKTOP_COLOURS.panel}`);
            }

            // A ring of the desktop's bell plays nothing in the owner's tab: Kinu's own alerts are its only sounds
            // (use-owner-alerts.ts), and the client chimed on every ring, an agent's every look among them (staging,
            // 2026-10-15). The ground repainted after the ring is the client's proof it has the ring: RFB keeps the
            // server's messages in order, and the client plays its bell (its own `noVNC_bell`) as it reads one.
            waiting = 'a ring of the desktop\'s bell, then the ground it was followed by';
            await frame.evaluate(() => {
              const bell = document.getElementById('noVNC_bell');

              if (!(bell instanceof HTMLMediaElement)) throw new Error('the desktop client has no bell element to count');
              bell.dataset.rings = '0';
              bell.play = async () => { bell.dataset.rings = String(Number(bell.dataset.rings) + 1); };
            });
            await shell(`DISPLAY=:0 python3 -c ${shellQuote(RING_PY)} && DISPLAY=:0 xsetroot -solid '${RUNG}'`, fresh);

            for (let rung = await screen(); !near(rung?.desktop, RUNG); rung = await screen()) {
              reading = JSON.stringify(rung);
              await delay(250);
            }

            requireEqual(await frame.evaluate(() => document.getElementById('noVNC_bell')?.dataset.rings), '0');

            const rect = seen.rect;

            const opened = async (launcher: keyof typeof DESKTOP_PANEL.launchers, windowClass: string) => {
              waiting = `the panel's ${launcher} opening a ${windowClass} window`;
              await page.mouse.click(rect.x + DESKTOP_PANEL.launchers[launcher] * rect.width / DESKTOP_SIZE.width,
                rect.y + (DESKTOP_SIZE.height - DESKTOP_PANEL.height / 2) * rect.height / DESKTOP_SIZE.height);
              await shell(`until DISPLAY=:0 xdotool search --onlyvisible --class ${windowClass} >/dev/null 2>&1; do sleep 0.1; done`, fresh);
            };

            await opened('terminal', 'xterm');
            await opened('browser', 'chromium');

            waiting = 'a foreign socket refused by the client\'s policy';

            const elsewhere = await frame.evaluate(() => new Promise<string>(resolve => {
              document.addEventListener('securitypolicyviolation', event => { resolve(event.violatedDirective); }, { once: true });
              new WebSocket('ws://elsewhere.example/websockify', ['binary']).addEventListener('open', () => { resolve('opened'); });
            }));

            requireEqual(elsewhere, 'connect-src');

            return 'a fresh box\'s desktop opened on its background and panel; a ring of its bell played nothing; the panel\'s clicks opened a terminal and a browser; foreign sockets refused';
          })();

          return endedNearSilence(watched, async () => { await browser.disconnect(); },
            () => `${waiting}${reading === '' ? '' : `; it last read ${reading}`}${heard.length === 0 ? '' : `; the page heard ${heard.join(' | ')}`}`);
        });
      } catch (cause) {
        // Said before anything else is asked of the box, so a fetch of its log that hangs cannot swallow it.
        process.stdout.write(`[${run}] desktop-client failed: ${String(cause)}\n`);
        // The desktop's own log says why a part did not paint: the wallpaper's and the panel's errors land there.
        const log = await shell(`grep -v 'INFO\\|\\[mi\\]\\|^$' ${DESKTOP_LOG} | tail -n 30 2>&1; true`, fresh);

        throw new Error(`${String(cause)}; the desktop's log:\n${log}`, { cause });
      }
    });
  };

  /**
   * The desktop's Chromium trusts the intercept CA of the start it runs in, and only that one: every HTTPS site through
   * the gateway showed `ERR_CERT_AUTHORITY_INVALID` (staging, 2026-10-16), as Debian's Chromium reads none of the bundle
   * the trust step builds. Read on two starts of one box, each with its own CA, in a browser held to TCP, where the
   * intercept sits (QUIC leaves past it, D82); and the person's own browser, as they open each site, shot on the box.
   */
  const browserTrust = async () => {
    await step('browser-trust', async () => {
      const name = names[4] ?? '';
      const shots = join(scratch, 'browser-trust');
      const intercept = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';

      const policyNamesCa = `import json
der = ''.join(line.strip() for line in open('${intercept}') if line.strip() and not line.startswith('-----'))
print('exact' if json.load(open('${BOX_CHROMIUM_POLICY}'))['CACertificates'] == [der] else 'other')`;

      const port = 9333;

      const Seen = v.object({ url: v.string(), state: v.nullable(v.string()), issuer: v.nullable(v.string()), error: v.nullable(v.string()), title: v.nullable(v.string()) });

      mkdirSync(shots, { recursive: true });

      const judged = async (start: string) => {
        const ca = await shell(`openssl x509 -in ${intercept} -noout -fingerprint -sha256 | cut -d= -f2`, name);
        const issuer = await shell(`openssl x509 -in ${intercept} -noout -subject -nameopt sep_multiline,utf8 | sed -n 's/^ *CN=//p'`, name);

        requireEqual(await shell(`python3 -c ${shellQuote(policyNamesCa)}`, name), 'exact');
        await shell(`rm -rf /tmp/kinu-trust && (DISPLAY=:0 setsid chromium --remote-debugging-port=${String(port)} --user-data-dir=/tmp/kinu-trust --disable-quic --new-window about:blank `
          + `>/tmp/kinu-trust.log 2>&1 </dev/null &) && timeout 60 sh -c 'until curl -sf http://127.0.0.1:${String(port)}/json/version >/dev/null; do sleep 0.2; done' `
          + `|| { tail -n 20 /tmp/kinu-trust.log; ps -eo pid,etimes,args | grep -c '[c]hromium'; exit 1; } >&2`, name);
        // The pattern's bracket keeps pkill from matching the shell that runs it, whose command line names the port too.
        const read = await shell(`PORT=${String(port)} timeout 150 python3 -c ${shellQuote(SITE_TRUST_PY)} ${TRUSTED_SITES.map(([url]) => url).join(' ')}; pkill -f 'remote-debugging-por[t]=${String(port)}'; true`, name);
        const seen = read.split('\n').map((line) => v.parse(Seen, JSON.parse(line)));

        for (const [at, [url, title]] of TRUSTED_SITES.entries()) {
          requireEqual(seen[at], { url, state: 'secure', issuer, error: null, title: seen[at]?.title ?? null });

          if (!(seen[at]?.title ?? '').includes(title)) throw new Error(`${url} read ${JSON.stringify(seen[at]?.title)} on the ${start} start`);
          // The person's own browser, its profile and QUIC as they are: the site's title in its window, and a shot of it.
          const titled = `until DISPLAY=:0 xdotool search --onlyvisible --name ${shellQuote(title)} >/dev/null; do sleep 0.3; done`;

          await shell(`(DISPLAY=:0 setsid chromium ${url} >/dev/null 2>&1 </dev/null &) && timeout 60 sh -c ${shellQuote(titled)} && sleep 2`, name);
          writeFileSync(join(shots, `${start}-${new URL(url).hostname}.png`), Buffer.from(await shell('DISPLAY=:0 scrot -z -o /tmp/kinu-trust.png && base64 -w0 /tmp/kinu-trust.png', name), 'base64'));
        }

        return { ca, sites: seen.map((each) => `${each.url} ${String(each.state)} ${String(each.title)}`) };
      };

      const first = await judged('first');

      requireEqual((await call('/stop', Commit, undefined, name)).kind, 'committed');
      // An agent's look opens the desktop again on the new start, as the person's first open would.
      const looked = await call('/agent-desktop', AgentAnswer, { driver: 'trust', member: 'screenshot', args: '[]' }, name);

      if (typeof looked !== 'string') throw new Error(`an agent's look did not open the second start's desktop: ${JSON.stringify(looked)}`);
      // The stop ended the person's browser with the container; the start marked its exit clean, so it reopens with no
      // "Restore pages?" (the second start's shots show its window).
      const exited = `import json; print(json.load(open('${CHROMIUM_PROFILES}/Default/Preferences'))['profile']['exit_type'])`;

      requireEqual(await shell(`python3 -c ${shellQuote(exited)}`, name), 'Normal');
      const second = await judged('second');

      if (second.ca === first.ca) throw new Error(`the restart kept its CA ${first.ca}: the second start proves nothing`);

      return { first, second, shots };
    });
  };

  /**
   * An agent's desktop on a fresh box (D89), through the product's own `computer.*` members and adapter: it looks at the
   * screen the owner watches, at its own size; its clicks, keys, text, wheel and drags land where its screenshot put
   * them; nothing stays pressed after a call; a program a shell starts opens there; and a second agent waits its turn.
   */
  const desktopAgent = async () => {
    await step('desktop-agent', async () => {
      const fresh = names[5] ?? '';
      const desk = (member: string, args: readonly unknown[] = [], driver = 'agent', stop?: string) => call('/agent-desktop', AgentAnswer, { driver, member, args: JSON.stringify(args), ...(stop !== undefined && { stop }) }, fresh);
      const sh = (command: string) => shell(command, fresh);

      /** How many of a PNG's `cols`×`rows` tiles differ from every other, read on the box by its own Pillow. */
      const distinct = async (url: string, cols: number, rows: number): Promise<number> => {
        const data = url.slice(url.indexOf(',') + 1);

        await sh('mkdir -p /tmp/kinu-desk && rm -f /tmp/kinu-desk/sheet.b64');

        // Base64 needs no quoting; in pieces, as one argument is held under the kernel's limit.
        for (let at = 0; at < data.length; at += 60_000) await sh(`printf %s ${data.slice(at, at + 60_000)} >>/tmp/kinu-desk/sheet.b64`);

        return Number(await sh(`base64 -d /tmp/kinu-desk/sheet.b64 >/tmp/kinu-desk/sheet.png && python3 -c ${shellQuote(DISTINCT_PY)} /tmp/kinu-desk/sheet.png ${String(cols)} ${String(rows)}`));
      };

      const title = async () => (await sh('xdotool getactivewindow getwindowname 2>/dev/null || true')).replace(/ - Chromium$/u, '');

      const until = async (what: string, seen: (now: string) => boolean): Promise<string> => {
        const by = Date.now() + DESKTOP_SEEN_MS;

        for (let now = await title(); ; now = await title()) {
          if (seen(now)) return now;

          if (Date.now() > by) throw new Error(`${what}: the screen still said ${JSON.stringify(now)} after ${String(DESKTOP_SEEN_MS / 1000)} s`);
          await delay(200);
        }
      };

      const sessions = () => sh('for p in Xkasmvnc openbox tint2 Xvfb; do printf "%s=%s " "$p" "$(pgrep -c -x "$p")"; done');
      const one = 'Xkasmvnc=1 openbox=1 tint2=1 Xvfb=0';

      // A box whose desktop never opened: the first look starts it, at the screen's size; looks at once share it.
      requireEqual(sizeOf(v.parse(Screen, await desk('screenshot'))), [1280, 768]);
      await Promise.all([desk('screenshot'), desk('screenshot', [], 'other'), desk('screenshot')]);
      requireEqual(await sessions(), one);
      await sh('pkill -x tint2; pkill -x openbox; true');
      await desk('screenshot');
      requireEqual(await sessions(), one);

      // The agent's shell runs on that screen.
      requireEqual(await sh('echo "$DISPLAY"'), ':0');
      const pages = Object.entries({ grid: GRID, text: TEXT, scroll: SCROLL, range: RANGE, hold: HOLD, chord: CHORD, ticker: TICKER });
      await sh(`mkdir -p /tmp/kinu-desk && ${pages.map(([name, html]) => `printf %s ${shellQuote(html)} >/tmp/kinu-desk/${name}.html`).join(' && ')}`);
      await sh('setsid -f python3 -m http.server 8765 --bind 127.0.0.1 --directory /tmp/kinu-desk >/dev/null 2>&1');

      const open = async (page: string) => {
        await sh('pkill -x chromium; while pgrep -x chromium >/dev/null; do sleep 0.1; done; true');
        // A profile of its own per page: one killed and started again would show its restore bubble over the page.
        await sh(`setsid -f chromium --kiosk --no-first-run --no-default-browser-check --user-data-dir=/tmp/kinu-desk/profile-${page} http://127.0.0.1:8765/${page}.html >/dev/null 2>&1`);
        await until(`the ${page} page opened`, (now) => now === `ready ${page}`);
        await desk('screenshot');
      };

      await open('grid');
      requireEqual(await desk('move', [GRID_POINTS[0]]), null);
      await until('hovering the first cell', (now) => now === 'over c0');

      for (const [at, point] of GRID_POINTS.entries()) {
        requireEqual(await desk('click', [point]), null);
        await until(`a click on cell ${String(at)}`, (now) => now === `click c${String(at)} 1`);
      }

      const centre = GRID_POINTS[4] ?? [640, 395];
      const again = Date.now();
      await desk('click', [centre]);
      await desk('click', [centre]);
      const twice = Date.now() - again;

      if (twice > 3_000) throw new Error(`two clicks at one point took ${String(twice)} ms: the second waited on the pointer to move`);
      await desk('click', [GRID_POINTS[0], { button: 'right' }]);
      await until('a right-click', (now) => now === 'right c0');
      await desk('click', [GRID_POINTS[8], { count: 2 }]);
      await until('a double-click', (now) => now === 'double c8');
      await desk('click', [GRID_POINTS[2], { hold: 'shift' }]);
      await until('a shift-click', (now) => now === 'click c2 1 shift');
      // Nothing it held stays down.
      await desk('click', [GRID_POINTS[6]]);
      await until('a plain click after it', (now) => now === 'click c6 1');

      // The box's own refusals, before any input: a point off the screen, another agent's input.
      requireEqual(v.parse(Refused, await desk('click', [[1280, 10]])).reason, 'bad_input');
      requireEqual(v.parse(Refused, await desk('click', [centre], 'other')).reason, 'unavailable');

      await open('text');
      await desk('click', [[640, 400]]);
      const typed = `${'y'.repeat(49)}\n${'z'.repeat(70)} echo "$DISPLAY ü"`;
      await desk('type', [typed]);
      await until('the typed text', (now) => now === `text ${JSON.stringify(typed)}`);
      await desk('key', ['ctrl+a']);
      await desk('type', ['x']);
      await until('the text replaced', (now) => now === 'text "x"');

      await open('scroll');
      await desk('scroll', [[640, 400], 5, { dx: 3 }]);
      await until('the page scrolled both ways', (now) => /^scroll [1-9]\d* [1-9]\d*$/u.test(now));
      requireEqual(await desk('scroll', [[640, 400], -50, { dx: -50 }]), null);
      await until('the page scrolled back', (now) => now === 'scroll 0 0');

      await open('range');
      await desk('drag', [[4, 150], [1276, 150]]);
      await until('the range dragged to its end', (now) => /^range (?:9\d|100)$/u.test(now));

      // A held key is held as long as asked, and let go.
      await open('hold');
      requireEqual(await desk('key', ['w', { hold: 800 }]), null);
      const held = Number(/^held w (\d+)$/u.exec(await until('the key let go', (now) => now.startsWith('held w ')))?.[1]);

      if (!(held >= 700 && held <= 1_500)) throw new Error(`a key held for 800 ms was down ${String(held)} ms`);

      // Stopped mid-chord, with a button a run cut short left down: the run is ended there, and whatever X holds is let up
      // at once, read from X itself; the X server then has no key and no button down.
      await open('chord');
      await sh('DISPLAY=:0 xdotool mousedown 1');
      const chording = desk('key', ['alt+shift+k', { hold: 10_000 }], 'agent', 'chord-stop');
      await until('the chord held', (now) => now === 'held AltLeft KeyK ShiftLeft');
      requireEqual(await call('/agent-desktop-stop', v.object({ stopped: v.boolean() }), { stop: 'chord-stop' }, fresh), { stopped: true });
      requireEqual(v.parse(Refused, await chording).reason, 'cancelled');
      await until('the stopped chord let up', (now) => now === 'released');
      requireEqual(await sh(`python3 -c ${shellQuote(DOWN_PY)}`), 'keys buttons');

      // A watch is one image of frames over its window: four by default, two to a row; eight, four to a row. Each frame
      // shows the page as it changed, so no two tiles are alike.
      await open('ticker');
      const four = v.parse(Screen, await desk('watch', [2]));
      const eight = v.parse(Screen, await desk('watch', [2, { fps: 4 }]));
      requireEqual([sizeOf(four), await distinct(four, 2, 2), sizeOf(eight), await distinct(eight, 4, 2)], [[1280, 768], 4, [2560, 768], 8]);

      return 'a fresh box\'s desktop came up for an agent\'s look at 1280×768, once, and came back after its parts died; '
        + 'clicks of every kind, keys, text with breaks, both wheels and a drag landed where its screenshot put them; '
        + 'nothing stayed held; a point off the screen and a second agent\'s input were refused before reaching it; a key '
        + 'was held as long as asked; a chord stopped mid-hold was let up at once, a button left down with it, and X held '
        + 'nothing down after; a watch '
        + 'answered one sheet of frames that each showed the page changing';
    });
  };

  /** The container's contracts, the desktop through the product routes, and the product's own chain. */
  const productContracts = async () => {
    /**
     * A session comes back from the box's stop as it was (D97): its screen, a rule that it restarted, and the line it
     * was running offered at the prompt, which runs only on the person's Enter, once. CRIU cannot run here (no kcmp,
     * no ns_last_pid on this kernel, measured), so no process survives; the line is the person's to run again.
     */
    await step('resurrect', async () => {
      const name = names[7] ?? '';
      // What the line's whole run leaves: the marker its `$()` touched, then one count.
      const files = () => shell(`test -e ${RESURRECT_MARKER} && echo marker; cat ${RESURRECT_COUNT} 2>/dev/null | wc -l`, name);
      const ranOnce = async () => (await files()) === 'marker\n1';
      // Only the screen saved before the stop can show this on the new socket.
      const seen = `kinu-screen-${crypto.randomUUID().slice(0, 8)}`;
      const before = await openSession(name);

      await waitFor(() => /[#$]\s*$/u.test(before.screen()), "the shell's prompt");
      before.type(`echo ${seen}\r`);
      await waitFor(() => before.screen().includes(seen), 'the screen to show what the stop must keep');
      before.type(`${RESURRECT_LINE}\r`);
      await waitFor(ranOnce, 'the typed line to run once');
      await shell(`rm -f ${RESURRECT_MARKER} ${RESURRECT_COUNT}`, name);
      before.close();
      requireEqual((await call('/stop', Commit, undefined, name)).kind, 'committed');

      const after = await openSession(name);

      // The saved screen, then the restart's rule, and under it the line twice: as what was running, and at the prompt.
      const offered = () => {
        const shown = after.screen();
        const rule = shown.indexOf('restarted');

        return rule > shown.indexOf(seen) && shown.includes(seen) && shown.slice(rule).split(`echo "it's`).length > 2;
      };

      await waitFor(offered, 'the saved screen, the rule, and the line at the prompt');
      await delay(RESURRECT_SETTLE_MS);
      const waiting = await files();

      if (waiting !== '0') throw new Error(`before Enter the box held ${JSON.stringify(waiting)}: the offered line ran on its own`);
      after.type('\r');
      await waitFor(ranOnce, 'the line to run on Enter');
      await delay(RESURRECT_SETTLE_MS);
      const ran = await files();
      after.close();

      if (ran !== 'marker\n1') throw new Error(`after one Enter the box held ${JSON.stringify(ran)}, not the line's one run`);

      return { beforeEnter: waiting, afterEnter: ran, screen: after.screen().slice(-400) };
    });

    /**
     * The box answers to the name its class gives it, as one DNS label, and that name resolves at once to the box's own
     * addresses (D96). The platform's 64-character name broke `python3 -m http.server` on every computer (staging
     * 7591e6fec), and a renamed kernel with nothing to answer for it waited on DNS for an address that is not the box.
     */
    await step('box-name', async () => {
      const named = new Map((await shell(BOX_NAME_READ)).split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      const [lookupMs, ...looked] = (named.get('lookup') ?? '').split(' ');
      const own = (named.get('own') ?? '').split(' ').filter((address) => address !== '');

      process.stdout.write(`[${run}] box name ${JSON.stringify(Object.fromEntries(named))}\n`);

      if (named.get('kernel') !== BOX_NAME) throw new Error(`the box answers to ${named.get('kernel') ?? 'nothing'}, not ${BOX_NAME}`);

      if (named.get('prompt')?.includes(`@${BOX_NAME}`) !== true) throw new Error(`a shell's prompt reads ${named.get('prompt') ?? 'nothing'}, not ${BOX_NAME}`);

      if (Number(lookupMs) > NAME_LOOKUP_MS || own.length === 0) {
        throw new Error(`its own name resolved in ${lookupMs ?? '?'} ms to ${looked.join(' ')}, not at once to an address of the box itself`);
      }

      if (named.get('fqdn') !== BOX_NAME) throw new Error(`getfqdn answered ${named.get('fqdn') ?? 'nothing'}`);

      if (named.get('http')?.startsWith('200') !== true) throw new Error(`python3 -m http.server answered ${named.get('http') ?? 'nothing'}`);

      return Object.fromEntries(named);
    });

    /**
     * An agent's job runs in a terminal session of its own (D95): stopped at a prompt, the job reads "waiting for input"
     * with its last line, its session reads needs input, an answer typed into the session reaches it, and its log has
     * what it wrote. Stopping it takes its session.
     */
    await step('agent-job', async () => {
      const Row = v.looseObject({ processId: v.string(), status: v.string(), waiting: v.optional(v.string()), session: v.optional(v.string()) });
      const Session = v.looseObject({ id: v.string(), name: v.string(), needsInput: v.boolean(), job: v.optional(v.string()) });
      const { processId } = await call('/job-start', v.object({ processId: v.string() }), { command: JOB_PROMPT }, names[1]);
      const rowOf = async () => (await call('/job-list', v.array(Row), {}, names[1])).find((row) => row.processId === processId);
      let row = await rowOf();

      for (let asked = 0; row?.status !== 'waiting for input' && asked < JOB_READS; asked++) { await delay(JOB_READ_MS); row = await rowOf(); }

      if (row?.status !== 'waiting for input' || row.waiting?.trim() !== 'Your name?' || row.session === undefined) {
        throw new Error(`a job at its prompt read ${JSON.stringify(row)}, not waiting for input at "Your name?"`);
      }

      const session = row.session;
      const listed = (await call('/sessions', v.array(Session), {}, names[1])).find((candidate) => candidate.id === session);

      if (listed?.needsInput !== true || listed.job !== processId) throw new Error(`its session read ${JSON.stringify(listed)}, not the job's, needing input`);

      await shell(`tmux send-keys -t '=${session}:' Ada Enter`, names[1]);

      for (let asked = 0; row?.status !== 'completed' && asked < JOB_READS; asked++) { await delay(JOB_READ_MS); row = await rowOf(); }

      if (row?.status !== 'completed') throw new Error(`the answered job read ${JSON.stringify(row)}, not completed`);
      const log = await shell(`cat /var/tmp/devbox/processes/${processId}/stdout.log`, names[1]);

      if (!log.includes('hi Ada')) throw new Error(`the job's log holds ${JSON.stringify(log.slice(-300))}, not its answer`);
      await call(`/job-stop?id=${processId}`, v.object({ stopped: v.boolean() }), {}, names[1]);
      const after = await call('/sessions', v.array(Session), {}, names[1]);

      if (after.some((candidate) => candidate.id === session)) throw new Error('a stopped job left its session listed');

      return { processId, session, waiting: listed.needsInput, log: log.slice(-120) };
    });

    /**
     * A person's terminal session reads as it is on a real box (D90): open, its folder, the port its server listens
     * on. Staging 7591e6fec read every session closed: tmux printed the read's tab separators as `_`.
     */
    await step('terminal-sessions', async () => {
      const Session = v.looseObject({ id: v.string(), open: v.boolean(), cwd: v.string(), ports: v.array(v.number()) });

      await shell(`tmux new-session -d -s shell -c /workspace && tmux send-keys -t '=shell:' -l ${`'${SESSION_SERVER.replaceAll("'", String.raw`'\''`)}'`} && tmux send-keys -t '=shell:' Enter`, names[1]);
      let shell$ = (await call('/sessions', v.array(Session), {}, names[1])).find((session) => session.id === 'shell');

      for (let asked = 0; !(shell$?.cwd === SESSION_FOLDER && shell$.ports.includes(SESSION_PORT)) && asked < SESSION_READS; asked++) {
        await delay(SESSION_READ_MS);
        shell$ = (await call('/sessions', v.array(Session), {}, names[1])).find((session) => session.id === 'shell');
      }

      const read = shell$?.open === true && shell$.cwd === SESSION_FOLDER && shell$.ports.includes(SESSION_PORT);

      // On a miss, what the box holds: the pane's screen, its processes, and the read's own rows.
      const seen = read ? '' : await shell(
        `tmux capture-pane -p -t '=shell:' | grep -v '^$' | tail -5; tmux list-panes -a -F '#{pane_pid} #{pane_current_command}'; ps -eo pid,ppid,pgid,comm | tail -12; true`,
        names[1],
      );

      await shell("tmux kill-session -t '=shell' 2>/dev/null; true", names[1]);

      if (!read) throw new Error(`a session running a server in ${SESSION_FOLDER} on :${String(SESSION_PORT)} read ${JSON.stringify(shell$)}; the box: ${seen}`);

      return shell$;
    });

    await step('file-metadata', async () => {
      const measured = await call('/file-contract', Json, {}, names[1]);
      process.stdout.write(`[${run}] file metadata ${JSON.stringify(measured)}\n`);

      return measured;
    });

    for (const kind of CONTAINER_CONTRACTS) await step(kind, () => call(`/contract?kind=${kind}`, Json, {}, names[1]));

    // `--headless`: everything but the desktop's client, which drives a browser on this host.
    /**
     * A start that fails the same way every time is refused once and arms nothing (D94): staging 7e411119d's box named
     * itself into the read-only /etc/hostname, an uncoded failure, and re-armed its startup every second, 1,873 alarms
     * in 30 minutes with no caller. The fixture's `-parked` box fails every start that way, on the platform's container.
     */
    await step('parked-start', async () => {
      const parked = names[6] ?? '';
      const url = new URL('/exec', origin);
      url.searchParams.set('box', parked);
      const asked = await fixtureFetch(url, { method: 'POST', headers: { authorization: `Bearer ${identity}`, 'content-type': 'application/json' }, body: JSON.stringify({ command: 'true' }) });
      const said = JSON.stringify(await asked.json());
      await delay(PARKED_WATCH_MS);
      const armed = await call('/armed', v.record(v.string(), v.number()), undefined, parked);
      const state = await call('/state', v.looseObject({ incidents: v.looseObject({ total: v.number() }) }), undefined, parked);
      const seen = { status: asked.status, said: said.slice(-400), startupArms: armed['devboxStartup'] ?? 0, incidents: state.incidents.total, watchedMs: PARKED_WATCH_MS };

      process.stdout.write(`[${run}] parked start ${JSON.stringify(seen)}\n`);

      if (asked.ok || !said.includes('nothing retries it')) throw new Error(`the parked box was not refused: ${JSON.stringify(seen)}`);

      if (seen.startupArms > 1 || seen.incidents !== 1) throw new Error(`a start refused the same way kept asking: ${JSON.stringify(seen)}`);

      return seen;
    });

    if (!process.argv.includes('--headless')) {
      await desktopClient();
      await browserTrust();
    }

    await desktopAgent();

    await step('disk-chain', async () => {
      await shell('set -e; cd /workspace; mkdir -p private gone/sub src empty node_modules/pkg; chmod 700 private; '
        + 'echo secret >private/key; echo gone >gone/sub/f; echo old >src/f; ln -s src/f link; '
        + 'head -c 8388608 /dev/urandom >db.bin; echo excluded >node_modules/pkg/f; echo noise >build.log; touch -d 2020-01-01 src/f');
      requireEqual((await call('/checkpoint?kind=tick', Commit, {})).kind, 'committed');
      const base = (await call('/state', State)).chain?.base.key;

      for (const command of [
        "python3 -c \"import os; f=os.open('/workspace/db.bin',os.O_WRONLY); os.pwrite(f,b'A'*4096,100000); os.close(f)\"; echo first >>/workspace/src/f; rm -rf /workspace/gone",
        'truncate -s 9437184 /workspace/db.bin; echo new >/workspace/new; rm /workspace/link; ln -s private /workspace/link',
        "python3 -c \"import os; f=os.open('/workspace/db.bin',os.O_WRONLY); os.pwrite(f,b'B'*20,100100); os.close(f)\"; truncate -s 6291456 /workspace/db.bin",
      ]) {
        await shell(command);
        await delay(2_000);
        const saved = await call('/checkpoint?kind=tick', Commit, {});
        requireEqual(saved.kind, 'committed');

        if ((saved.movedBytes ?? Infinity) >= 256 * 1024) throw new Error('an in-place edit sent the whole file');
        requireEqual((await call('/state', State)).chain?.base.key, base);
      }

      const digest = "cd /workspace; find . -xdev \\( -name node_modules -o -name '*.log' \\) -prune -o ! -path . -printf '%P %y %m %l\\n' | LC_ALL=C sort; "
        + "find . -xdev \\( -name node_modules -o -name '*.log' \\) -prune -o -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum";

      const expected = await shell(digest);
      requireEqual((await call('/stop', Commit, {})).kind, 'skipped');
      await collectSnapshots(box);
      requireEqual(await shell(digest), expected);
      requireEqual(await shell('cat /workspace/node_modules/pkg/f'), 'excluded');
      requireEqual((await call('/stop', Commit, {})).kind, 'skipped');
      await collectSnapshots(box);
      requireEqual((await call('/lose-snapshot', v.object({ ok: v.boolean() }), {})).ok, true);
      requireEqual(await shell(digest), expected);
      requireEqual(await shell('test ! -e /workspace/node_modules && test ! -e /workspace/build.log && echo excluded'), 'excluded');
      await shell('echo recovered >>/workspace/src/f; rm /workspace/new; mkdir -p /workspace/later; echo later >/workspace/later/f');
      await delay(2_000);
      requireEqual((await call('/checkpoint?kind=tick', Commit, {})).kind, 'committed');
      const later = await shell(digest);
      await call('/stop', Commit, {});
      await collectSnapshots(box);
      requireEqual(await shell(digest), later);

      return { base, recoveryExact: true, afterRecoveryExact: true, state: await call('/state', State) };
    });
  };

  try {
    runWrangler(REPO, ['r2', 'bucket', 'create', bucket]);
    const toolsArgument = process.argv.indexOf('--tools');
    await installTools(bucket, toolsArgument === -1 ? undefined : process.argv[toolsArgument + 1]);
    const secrets = join(scratch, 'secrets.json');
    // Wrangler's secret file exists only in the run's private scratch directory and is removed immediately.
    const authority: FixtureSecrets = { EVAL_IDENTITY: identity, DEVBOX_REGISTRY_TOKEN: token };

    if (process.argv.includes('--probe')) {
      authority['PROBE_ACCESS_KEY_ID'] = process.env['R2_ACCESS_KEY_ID'];
      authority['PROBE_SECRET_ACCESS_KEY'] = process.env['R2_SECRET_ACCESS_KEY'];
    }

    writeFileSync(secrets, JSON.stringify(authority), { mode: 0o600 });
    let published: string;

    try { published = runWrangler(REPO, ['deploy', '--config', config, '--secrets-file', secrets]); }
    finally { rmSync(secrets); }

    origin = /https:\/\/[\w.-]+\.workers\.dev/u.exec(published)?.[0];
    learnApplication();

    if (origin === undefined) throw new Error('the fixture deploy printed no origin');
    await writeReport();
    // D17's fixture readiness: deploy returns before the workers.dev route answers.
    const ready = await fixtureFetch(`${origin}/health`, { headers: { authorization: `Bearer ${identity}` } });

    if (ready.status !== 200) throw new Error(`the fixture route did not become ready: ${String(ready.status)}`);
    requireEqual((await fixtureFetch(`${origin}/health`)).status, 401);
    await step('golden', () => call('/golden', v.object({ id: v.string() }), {}, 'devbox-golden'));
    await collectSnapshots('devbox-golden');
    await step('declared-image-use', () => call('/inspection', v.unknown()));
    const probeArgument = process.argv.indexOf('--probe');

    if (probeArgument !== -1) {
      await step('storage-alternatives', async () => {
        const probe = '/var/tmp/devbox-probe';
        const command = `bash -c ${shellQuote(readFileSync(process.argv[probeArgument + 1] ?? '', 'utf8'))}; rc=$?; echo "$rc" >${probe}/exit`;
        const launched = await call('/storage-probe', Exec, { command: `mkdir -p ${probe}; setsid bash -c ${shellQuote(command)} >${probe}/output 2>&1 </dev/null & echo launched` });
        requireEqual(launched.exitCode, 0);

        for (;;) {
          const status = await shell(`if [ -e ${probe}/exit ]; then cat ${probe}/exit; else echo running; fi`);

          if (status === 'running') { await delay(1_000); continue; }

          const output = await shell(`cat ${probe}/output`);

          if (status !== '0') throw new Error(`storage probe exited ${status}: ${output.slice(-5000)}`);

          return output;
        }
      });

    } else {
      const diskContracts = async () => {
        for (const kind of DISK_CONTRACTS) await step(`disk-${kind}`, () => call(`/disk-contract?kind=${kind}`, Json, {}, `${box}-disk`));
      };

      // At once, on boxes of their own, each store prefix its box's: on armada 2026-10-13 the product's took about
      // 110 s and the disk chain's 131 s, one after the other. Both end before a failure is reported, so the
      // teardown never meets a contract still calling the fixture. `--disk`: the disk chain's alone, with no desktop
      // and so no browser on this host.
      const ended = await Promise.allSettled([process.argv.includes('--disk') ? Promise.resolve() : productContracts(), diskContracts()]);
      const failed = ended.find((outcome) => outcome.status === 'rejected');

      if (failed !== undefined) throw failed.reason;
    }
  } catch (cause) {
    steps.push({ contract: 'failure', ms: 0, detail: String(cause) });
    await writeReport();
    throw cause;
  } finally {
    await runTeardownOnce();
    process.stdout.write(`[${run}] cleanup ${cleanupErrors.length === 0 ? 'verified' : cleanupErrors.join('; ')}; report ${report}\n`);
  }

  if (cleanupErrors.length !== 0) throw new Error('the real-container tier left resources behind');
  process.stdout.write('Real-container contracts passed. Blind spots: account saturation, long snapshot lifetime, and the full product\'s model path.\n');
}

if (import.meta.main) {
  if (process.env['ARMADA_INDEX'] === undefined) {
    process.stderr.write('Devbox contracts require armada: armada map --connection="$HOME/.config/armada/armada-kinu.json" --commit=HEAD --times=1 --secrets=DEVBOX_REGISTRY_TOKEN,KINU_CLOUDFLARE_API_TOKEN,R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY,KINU_EVAL_STAGING_WEB_IDENTITY -- bun run gate:devbox-e2e\n');
    process.exitCode = 1;
  } else await main();
}
