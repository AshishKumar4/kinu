#!/usr/bin/env bun
/** Real-container contracts at the staging deploy tier (m282, D72). Each run owns its Worker, bucket and snapshots. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { copyPinnedTools } from './devbox-tools';
import { requireEqual, tierIdentity } from './fixtures/devbox-e2e/oracle';
import { deleteApplicationSnapshots } from './fixtures/application-snapshots';
import { completeTeardown } from './fixtures/devbox-e2e/teardown';
import { r2 } from './infra-cloudflare';
import { deployedConfig } from './infra-manifest';
import { r2ResiduePlane, drainBucketResidue } from './bench-devbox-fixture';
import { deleteR2Prefix, restApiToken } from './cloudflare-rest';
import { runWrangler, wranglerProvesAbsence, deleteContainerApps, containerAppIds, publishTeardown, runTeardownOnce, delay } from './fixtures/r2-bench/deploy-substrate';
import { snapshotRegistry } from '../packages/devbox/src/snapshot-registry';
import artifact from '../packages/devbox/block-lower/upstream.json';
import { CONTAINER_CONTRACTS, DISK_CONTRACTS } from '../packages/devbox/bench/contract-types';
import { shellQuote } from '../packages/core/src/utils/shell';
import { withTestChrome } from './test-chrome';
import { DESKTOP_COLOURS, DESKTOP_PANEL, DESKTOP_SIZE } from '../packages/devbox/src/desktop';

const REPO = join(import.meta.dir, '..');

const ACCOUNT = 'f44999d1ddda7012e9a87729eba250f1';

const PART_BYTES = 256 * 1024 * 1024;

/** The box's own words when the platform refused it a container and it armed a startup (packages/devbox/src/devbox.ts). */
const ASK_AGAIN = 'A startup is armed, so ask again';

/** Asks of one call, a minute apart in all: the startup the box armed retries within seconds. */
const ASK_AGAIN_TIMES = 12;

const ASK_AGAIN_MS = 5_000;

/** How long after its first frame a fresh desktop must show its background and panel: a person waits seconds, not minutes. */
const DESKTOP_SEEN_MS = 30_000;

const Json = v.looseObject({ error: v.optional(v.string()) });

const Exec = v.object({ exitCode: v.number(), stdout: v.string(), stderr: v.string() });

const Commit = v.looseObject({ kind: v.string(), reason: v.optional(v.string()), movedBytes: v.optional(v.number()) });

const State = v.looseObject({ chain: v.nullable(v.looseObject({ rev: v.number(), base: v.looseObject({ key: v.string() }), deltas: v.array(v.unknown()) })), snapshot: v.nullable(v.looseObject({ id: v.string() })) });

async function installTools(bucket: string, cached?: string): Promise<void> {
  const key = `devbox-tools/${artifact.tools.sha256}.tgz`;

  if (cached !== undefined) {
    const bytes = readFileSync(cached);
    requireEqual(createHash('sha256').update(bytes).digest('hex'), artifact.tools.sha256);
    const scratch = mkdtempSync(join(tmpdir(), 'kinu-devbox-tools-'));

    try {
      for (let part = 0; part * PART_BYTES < bytes.length; part++) {
        const path = join(scratch, String(part));
        writeFileSync(path, bytes.subarray(part * PART_BYTES, (part + 1) * PART_BYTES));
        runWrangler(REPO, ['r2', 'object', 'put', `${bucket}/${key}.${String(part)}`, '--remote', '--file', path]);
      }
    } finally { rmSync(scratch, { recursive: true, force: true }); }

    return;
  }

  await copyPinnedTools(bucket);
}

interface Step { readonly contract: string; readonly ms: number; readonly detail: unknown }

interface FixtureSecrets {
  readonly EVAL_IDENTITY: string;
  readonly DEVBOX_REGISTRY_TOKEN: string;
  PROBE_ACCESS_KEY_ID?: string;
  PROBE_SECRET_ACCESS_KEY?: string;
}

function writeFixtureConfig(worker: string, scratch: string, priorDeclared?: string) {
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
    r2_buckets: [{ binding: 'STORE', bucket_name: worker }],
    assets: { directory: join(REPO, 'packages/cf-backend/public'), binding: 'ASSETS', run_worker_first: true },
    vars: { ACCOUNT, PROBE_BUCKET: worker, PROBE_HTTP: process.argv.includes('--probe') ? '1' : '0' },
  }));

  return { config, declared };
}

function recoveryReport(argument: number) {
  if (argument === -1) return undefined;

  return v.parse(v.object({
    run: v.pipe(v.string(), v.regex(/^dc\d{14}[a-f0-9]{5}$/u)), origin: v.optional(v.string()), declared: v.string(),
    snapshots: v.array(v.string()), steps: v.array(v.object({ contract: v.string(), ms: v.number(), detail: v.unknown() })),
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

async function main(): Promise<void> {
  const identity = tierIdentity(process.env);
  const recoveryArgument = process.argv.indexOf('--cleanup-report');

  const recovering = recoveryReport(recoveryArgument);

  const run = recovering?.run ?? `dc${new Date().toISOString().replace(/\D/gu, '').slice(0, 14)}${crypto.randomUUID().slice(0, 5)}`;
  const worker = `kinu-${run}`;
  const box = `eval-devbox-${run}`;
  // The last is a box only the desktop's check opens, so it opens on a fresh box.
  const names = [box, `${box}-native`, `${box}-disk`, 'devbox-golden', `${box}-desktop`];
  const app = `${worker}-contractbox`;
  const scratch = recovering === undefined ? mkdtempSync(join(tmpdir(), 'kinu-devbox-contracts-')) : dirname(process.argv[recoveryArgument + 1] ?? '');
  process.env['WRANGLER_LOG_PATH'] = join(scratch, 'wrangler');
  const { token, rest } = fixtureTokens();
  const report = join(scratch, 'report.json');
  const steps: Step[] = recovering?.steps ?? [];
  const snapshots = new Set<string>(recovering?.snapshots);
  const cleanupErrors: string[] = [];
  const { config, declared } = writeFixtureConfig(worker, scratch, recovering?.declared);
  let origin: string | undefined = recovering?.origin;
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  const dirtyDigest = createHash('sha256').update(spawnSync('git', ['diff', 'HEAD'], { cwd: REPO }).stdout).digest('hex');
  const writeReport = () => { writeFileSync(report, JSON.stringify({ run, worker, app, bucket: worker, box, declared, origin, revision, dirtyDigest, steps, snapshots: [...snapshots], cleanupErrors }, null, 2)); };

  const call = async <Schema extends v.GenericSchema>(path: string, schema: Schema, body?: Record<string, string>, name = box): Promise<v.InferOutput<Schema>> => {
    if (origin === undefined) throw new Error('the fixture has not deployed');
    const url = new URL(path, origin);
    url.searchParams.set('box', name);

    // A box the platform refused a container (a dropped connection, no room) arms its own startup and says to ask
    // again; a contract asks again, as an agent does, rather than read a platform refusal as the contract broken
    // (390ad4e4c's disk-chain: "Network connection lost." after /lose-snapshot).
    for (let asked = 1; ; asked += 1) {
      const reply = await fetch(url, { headers: { authorization: `Bearer ${identity}`, 'content-type': 'application/json' }, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
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
    writeReport();
    process.stdout.write(`[${run}] ${contract}: ${String(Date.now() - at)} ms\n`);
  };

  const shell = async (command: string, name = box) => {
    const ran = await call('/exec', Exec, { command }, name);

    if (ran.exitCode !== 0) throw new Error(`container command failed (${String(ran.exitCode)}): ${ran.stderr.slice(-900)}`);

    return ran.stdout.trim();
  };

  const collectSnapshots = async (name: string) => { for (const id of await call('/snapshots', v.array(v.string()), undefined, name)) snapshots.add(id); };

  const registry = snapshotRegistry({ account: ACCOUNT, token, fetch: (input, init) => fetch(input, init) });
  publishTeardown(async () => {
    const finish = async <Evidence>(name: string, work: () => Promise<Evidence>) => {
      const [outcome] = await Promise.allSettled([work()]);

      if (outcome?.status === 'rejected') cleanupErrors.push(`${name}: ${String(outcome.reason)}`);
    };

    const outcome = await completeTeardown({
      health: async () => origin === undefined ? null : (await fetch(`${origin}/health`, { headers: { authorization: `Bearer ${identity}` } })).status,
      beforeDelete: async (health) => {
      if (origin !== undefined && 'status' in health && health.status !== 404) for (const name of names) {
        await finish(`snapshots ${name}`, () => collectSnapshots(name));
        await finish(`cleanup ${name}`, () => call('/cleanup', Json, {}, name));
      }

    for (const id of snapshots) await finish(`snapshot ${id}`, async () => {
      const removed = await registry.delete(id);

      if (removed.kind === 'refused') throw new Error(removed.reason);
      requireEqual((await registry.delete(id)).kind, 'absent');
    });
      },
      worker: async () => {
      const deleted = runWrangler(REPO, ['delete', '--name', worker, '--force'], { allowFailure: true });

      if (!wranglerProvesAbsence(deleted)) throw new Error(deleted);
      },
      application: async () => {
      const ids = containerAppIds(REPO, [app], () => undefined).map(found => found.id);
      const removed = deleteContainerApps(REPO, [app], line => { process.stderr.write(`${line}\n`); });

      if (removed.some(line => line.includes('FAILED'))) throw new Error(removed.join('; '));
      requireEqual(containerAppIds(REPO, [app], () => undefined), []);

      // Deleting the application leaves every snapshot it made, the ones no box still names included.
      for (const applicationId of ids) {
        const swept = await deleteApplicationSnapshots({ account: ACCOUNT, token, applicationId });

        if (swept.left.length > 0) throw new Error(`${app} left ${String(swept.left.length)} snapshot(s) in the registry: ${swept.left.join(', ')}`);
      }
      },
      bucket: async () => {
      // By name: `r2 bucket list` answers its first 20 buckets only, so a bucket past that page read as gone, and
      // every run on an account of more than 20 left its bucket behind (seven on 2026-10-08).
      const before = r2(worker);

      if (before.state === 'absent') return;

      if (before.state === 'unknown') throw new Error(before.reason);
      await deleteR2Prefix({ accountId: ACCOUNT, bucket: worker, prefix: '', token: rest });
      const accessKeyId = process.env['R2_ACCESS_KEY_ID'];
      const secretAccessKey = process.env['R2_SECRET_ACCESS_KEY'];

      if (accessKeyId !== undefined && secretAccessKey !== undefined) await drainBucketResidue(r2ResiduePlane({ accountId: ACCOUNT, accessKeyId, secretAccessKey }), worker);
      runWrangler(REPO, ['r2', 'bucket', 'delete', worker]);
      const after = r2(worker);

      if (after.state !== 'absent') throw new Error(`the bucket is ${after.state === 'present' ? 'still there' : after.reason} after deletion`);
      },
    });

    steps.push({ contract: 'cleanup-health', ms: 0, detail: outcome.health });
    cleanupErrors.push(...outcome.errors);
    writeReport();
  });

  for (const [signal, status] of [['SIGTERM', 143], ['SIGINT', 130]] as const) process.once(signal, () => {
    void runTeardownOnce().then(() => { process.exit(cleanupErrors.length === 0 ? status : 1); }, (...rejection: [unknown]) => {
      const [cause] = rejection;
      process.stderr.write(`fixture teardown failed: ${String(cause)}\n`);
      process.exit(1);
    });
  });
  writeReport();
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

      return withTestChrome(async browser => {
        const page = await browser.newPage();
        page.setDefaultTimeout(0);
        await page.setExtraHTTPHeaders({ authorization: `Bearer ${identity}` });
        await page.setViewport({ width: 1300, height: 820 });
        await page.goto(`${origin}/view?box=${fresh}`);
        const frame = await (await page.waitForSelector('iframe'))?.contentFrame();

        if (frame == null) throw new Error('the desktop client did not frame');

        // The desktop a quarter in from its corner, where X never starts its pointer (the middle), and the foot's middle,
        // in the desktop's own coordinates; and where the client draws it.
        const screen = () => frame.evaluate((size, footY) => {
          const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];

          if (canvas === undefined || canvas.width < 640) return null;
          const context = canvas.getContext('2d');
          const at = (x: number, y: number) => [...context?.getImageData(x * canvas.width / size.width, y * canvas.height / size.height, 1, 1).data ?? []];
          const rect = canvas.getBoundingClientRect();

          return { desktop: at(size.width / 4, size.height / 4), panel: at(size.width / 2, footY), rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } };
        }, DESKTOP_SIZE, DESKTOP_SIZE.height - DESKTOP_PANEL.height / 2);

        await frame.waitForFunction(() => {
          const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];

          return canvas !== undefined && canvas.width >= 640 && canvas.getContext('2d')?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data[3] === 255;
        }, { polling: 'raf' });

        const near = (rgba: readonly number[] | undefined, hex: string) => rgba !== undefined
          && [1, 3, 5].every((at, channel) => Math.abs((rgba[channel] ?? -99) - Number.parseInt(hex.slice(at, at + 2), 16)) <= 12);

        // The first frame may come before the panel paints: a person sees the desktop within seconds, or sees none.
        const seenBy = Date.now() + DESKTOP_SEEN_MS;
        let seen = await screen();

        while (!(near(seen?.desktop, DESKTOP_COLOURS.background) && near(seen?.panel, DESKTOP_COLOURS.panel)) && Date.now() < seenBy) {
          await delay(250);
          seen = await screen();
        }

        if (seen === null || !near(seen.desktop, DESKTOP_COLOURS.background) || !near(seen.panel, DESKTOP_COLOURS.panel)) {
          throw new Error(`opening the desktop of a fresh box showed ${JSON.stringify({ desktop: seen?.desktop, panel: seen?.panel })} `
            + `${String(DESKTOP_SEEN_MS / 1000)} s after its first frame, not its background ${DESKTOP_COLOURS.background} and panel ${DESKTOP_COLOURS.panel}`);
        }

        const rect = seen.rect;

        const opened = async (launcher: keyof typeof DESKTOP_PANEL.launchers, windowClass: string) => {
          await page.mouse.click(rect.x + DESKTOP_PANEL.launchers[launcher] * rect.width / DESKTOP_SIZE.width,
            rect.y + (DESKTOP_SIZE.height - DESKTOP_PANEL.height / 2) * rect.height / DESKTOP_SIZE.height);
          await shell(`until DISPLAY=:0 xdotool search --onlyvisible --class ${windowClass} >/dev/null 2>&1; do sleep 0.1; done`, fresh);
        };

        await opened('terminal', 'xterm');
        await opened('browser', 'chromium');

        const elsewhere = await frame.evaluate(() => new Promise<string>(resolve => {
          document.addEventListener('securitypolicyviolation', event => { resolve(event.violatedDirective); }, { once: true });
          new WebSocket('ws://elsewhere.example/websockify', ['binary']).addEventListener('open', () => { resolve('opened'); });
        }));

        requireEqual(elsewhere, 'connect-src');

        return 'a fresh box\'s desktop opened on its background and panel; the panel\'s clicks opened a terminal and a browser; foreign sockets refused';
      });
    });
  };

  /** The container's contracts, the desktop through the product routes, and the product's own chain. */
  const productContracts = async () => {
    await step('file-metadata', () => call('/file-contract', Json, {}, names[1]));

    for (const kind of CONTAINER_CONTRACTS) await step(kind, () => call(`/contract?kind=${kind}`, Json, {}, names[1]));

    // `--headless`: everything but the desktop's client, which drives a browser on this host.
    if (!process.argv.includes('--headless')) await desktopClient();

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
    runWrangler(REPO, ['r2', 'bucket', 'create', worker]);
    const toolsArgument = process.argv.indexOf('--tools');
    await installTools(worker, toolsArgument === -1 ? undefined : process.argv[toolsArgument + 1]);
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

    if (origin === undefined) throw new Error('the fixture deploy printed no origin');
    writeReport();
    // D17's fixture readiness: deploy returns before the workers.dev route answers.
    const readyBy = Date.now() + 180_000;

    for (;;) {
      const ready = await fetch(`${origin}/health`, { headers: { authorization: `Bearer ${identity}` } });

      if (ready.status === 200) break;

      if (Date.now() >= readyBy) throw new Error(`the fixture route did not become ready: ${String(ready.status)}`);
      await delay(3_000);
    }

    requireEqual((await fetch(`${origin}/health`)).status, 401);
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
    // `--disk`: only the disk chain's contracts, with no desktop and so no browser on this host.
    if (!process.argv.includes('--disk')) await productContracts();

    for (const kind of DISK_CONTRACTS) await step(`disk-${kind}`, () => call(`/disk-contract?kind=${kind}`, Json, {}, `${box}-disk`));
    }
  } catch (cause) {
    steps.push({ contract: 'failure', ms: 0, detail: String(cause) });
    writeReport();
    throw cause;
  } finally {
    await runTeardownOnce();
    process.stdout.write(`[${run}] cleanup ${cleanupErrors.length === 0 ? 'verified' : cleanupErrors.join('; ')}; report ${report}\n`);
  }

  if (cleanupErrors.length !== 0) throw new Error('the real-container tier left resources behind');
  process.stdout.write('Real-container contracts passed. Blind spots: account saturation, long snapshot lifetime, and the full product\'s model path.\n');
}

if (import.meta.main) await main();
