/** The deploy tier's eval-owned throwaway Worker. No route is added to Kinu. */
import * as v from 'valibot';
import { Devbox, GOLDEN_NAME, type BoxPeers, type DevboxStore, type DevboxState } from '../../../devbox/src/index';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace/nimbus-workspace.js';
import { GOLDEN_BASE, GoldenStateSchema, pipeParts } from '../../../devbox/src/golden';
import { settle } from '../../../devbox/src/errors';
import { DEFAULT_DEVBOX_POLICY, describeThrown } from '../../../devbox/src/lifecycle';
import { fileErrorContract, runContainerContract } from '../../../devbox/bench/container-contracts';
import { CONTAINER_CONTRACTS, DISK_CONTRACTS } from '../../../devbox/bench/contract-types';
import { diskContract } from '../../../devbox/bench/disk-contracts';
import { desktopClientUrl, sandboxFiles, withAppSecurityHeaders } from '@kinu.run/core';
import { adaptCloudflareSandbox } from '../../src/sandbox-exec-lane';
import { terminalRoutes } from '../../src/terminal-route';
import { serveFamily } from '../helpers/api';

export { DevboxOutbound, DevboxStoreGateway } from '../../../devbox/src/index';

interface Env {
  readonly Box: DurableObjectNamespace<ContractBox>;
  readonly STORE: R2Bucket;
  readonly EVAL_IDENTITY: string;
  readonly DEVBOX_REGISTRY_TOKEN: string;
  readonly ACCOUNT: string;
  readonly ASSETS: Fetcher;
  readonly PROBE_HTTP: string;
  readonly PROBE_ACCESS_KEY_ID?: string;
  readonly PROBE_SECRET_ACCESS_KEY?: string;
  readonly PROBE_BUCKET: string;
}

const Snapshot = v.looseObject({ id: v.string(), lineage: v.optional(v.array(v.string()), []) });

export class ContractBox extends Devbox<Env> {
  #remoteCalls = 0;

  constructor(ctx: DevboxState, env: Env) {
    super(ctx, env);
    const container = ctx.container;

    if (container !== undefined) {
      const exec = container.exec.bind(container);
      container.exec = (argv, options) => {
        this.#remoteCalls += 1;

        return exec(argv, options);
      };
    }
  }

  enableInternet = this.env.PROBE_HTTP === '1';
  protected override get containerImage(): string { return GOLDEN_BASE; }
  protected override get store(): DevboxStore { return { binding: 'STORE', bucket: this.env.STORE }; }
  protected override get namespaceBinding(): string { return 'Box'; }
  protected override get registryToken(): string { return this.env.DEVBOX_REGISTRY_TOKEN; }
  protected override get registryAccount(): string { return this.env.ACCOUNT; }
  protected override get peers(): BoxPeers {
    return { golden: () => this.env.Box.getByName(GOLDEN_NAME), box: id => this.env.Box.get(this.env.Box.idFromString(id)) };
  }
  protected override get policy() { return { ...DEFAULT_DEVBOX_POLICY, checkpointIntervalMs: 2_000 }; }
  protected override get ambientCheckpoints(): boolean { return false; }

  /** 2026-10-09, D81: the native exec counter saw 73 calls for a 72-entry listing on df51186a7. */
  async fileContract() {
    await this.ensureReady();

    const workspace = await NimbusWorkspace.create({
      sql: this.ctx.storage.sql,
      transactions: { storage: { transactionSync: work => this.ctx.storage.transactionSync(work) } },
    });

    workspace.filesystem.vfs.mount('/sandbox', sandboxFiles(adaptCloudflareSandbox(this, async () => {}, null)), { resolvesPaths: true });
    const listing: { width: number; calls: number; ms: number }[] = [];
    const find: { command: string; calls: number; ms: number; entries: number }[] = [];

    for (const width of [1, 72]) {
      const path = `/var/tmp/devbox-contracts/list-${String(width)}`;
      await this.exec(`mkdir -p ${path}; for i in $(seq 1 ${String(width)}); do mkdir -p ${path}/entry-$i; done`);
      const calls = this.#remoteCalls;
      const at = Date.now();
      const listed = await this.listFiles(path);

      if (listed.files.length !== width) throw new Error('the listing lost a directory');
      listing.push({ width, calls: this.#remoteCalls - calls, ms: Date.now() - at });
    }

    const native = await this.exec('find /usr/share -maxdepth 1');

    if (native.exitCode !== 0) throw new Error(`the native find failed: ${native.stderr}`);
    const expected = native.stdout.trim().split('\n').map(path => `/sandbox${path}`).sort().join('\n');

    for (let repeat = 0; repeat < 3; repeat += 1) {
      const command = 'find /sandbox/usr/share -maxdepth 1';
      const calls = this.#remoteCalls;
      const at = Date.now();
      const ran = await workspace.exec(command);

      if (ran.exitCode !== 0) throw new Error(`the find failed: ${ran.stderr}`);
      find.push({ command, calls: this.#remoteCalls - calls, ms: Date.now() - at, entries: ran.stdout.trim().split('\n').length });

      if (ran.stdout.trim().split('\n').sort().join('\n') !== expected) throw new Error('the mounted find differs from the native directory walk');
    }

    const measured = { listing, find };

    if (listing.some(row => row.calls !== 1)) throw new Error(`a directory listing must cost one guest call: ${JSON.stringify(measured)}`);

    await this.#metadataContract();

    return measured;
  }

  async #metadataContract(): Promise<void> {
    const path = '/var/tmp/devbox-contracts/metadata';
    await this.exec(`mkdir -p ${path}/private; printf bytes >${path}/file; chmod 600 ${path}/file; chmod 700 ${path}/private; `
      + `printf child >${path}/private/child; touch -d @1700000000 ${path}/file; `
      + `ln -s private ${path}/link; ln -s missing ${path}/dangling; ln -s loop ${path}/loop; mkfifo ${path}/fifo`);
    const files = sandboxFiles(adaptCloudflareSandbox(this, async () => {}, null));
    const entries = await files.readdir(path);
    const file = entries.find(entry => entry.name === 'file');
    const link = entries.find(entry => entry.name === 'link');
    const fifo = entries.find(entry => entry.name === 'fifo');

    if (file?.stat?.size !== 5 || file.stat.mode !== 0o100600 || file.stat.mtimeMs !== 1_700_000_000_000
      || link?.type !== 'symlink' || link.stat?.type !== 'symlink' || fifo?.type !== 'fifo') {
      throw new Error(`the batched metadata differs from Linux: ${JSON.stringify(entries)}`);
    }

    const probes: [string, boolean, 'directory' | 'file' | 'symlink' | null][] = [
      ['/', true, 'directory'], [`${path}/file`, true, 'file'], [`${path}/link`, false, 'symlink'],
      [`${path}/link`, true, 'directory'], [`${path}/dangling`, true, null],
    ];

    for (const [operand, follow, type] of probes) {
      const before = this.#remoteCalls;
      const stat = await files.stat(operand, { follow });

      if ((stat?.type ?? null) !== type || this.#remoteCalls - before !== 1) throw new Error('stat/lstat did not read the single operand directly');
    }

    const calls = this.#remoteCalls;
    const recursive = await this.listFiles(path, { recursive: true });

    if (this.#remoteCalls - calls !== 1 || recursive.files.filter(entry => entry.name === 'child').length !== 1) {
      throw new Error('a recursive listing spawned extra guest calls or followed a directory link');
    }

    const container = this.ctx.container;

    if (container === undefined) throw new Error('this fixture has no container binding');
    await fileErrorContract(container, path);
  }

  async contract(kind: typeof CONTAINER_CONTRACTS[number]): Promise<void> {
    const container = this.ctx.container;

    if (container === undefined) throw new Error('this fixture has no container binding');

    if (kind === 'tools') {
      await this.ensureReady();
      await this.exec('mkdir -p /var/tmp/devbox-contracts');
      await settle(pipeParts({ get: key => this.env.STORE.get(key), container }, `devbox-tools/${this.toolsPin}.tgz`, '/var/tmp/devbox-contracts/tools.tgz'));
    }

    await runContainerContract(kind, this, container, this.toolsPin);
  }

  async inspection() {
    await this.ensureReady();

    return { images: this.ctx.container?.images, base: this.containerImage, actual: await this.ctx.container?.inspect(), state: await this.devboxState() };
  }

  async diskContract(kind: typeof DISK_CONTRACTS[number]): Promise<void> {
    await this.ensureReady();
    const container = this.ctx.container;

    if (container === undefined) throw new Error('this fixture has no container binding');
    // The first real checkpoint installs the box's R2 mount and scoped gateway; each case owns its own record.
    await this.checkpointNow('tick');
    await diskContract(kind, { container, kv: this.ctx.storage.kv, bucket: this.env.STORE, id: this.ctx.id.toString() });
  }

  storageProbe(command: string) {
    if (this.env.PROBE_HTTP !== '1') throw new Error('this contract run installs no storage alternatives');

    return this.exec(command, { env: {
      ACCESS_KEY: this.env.PROBE_ACCESS_KEY_ID ?? '', SECRET_KEY: this.env.PROBE_SECRET_ACCESS_KEY ?? '',
      AWS_ACCESS_KEY_ID: this.env.PROBE_ACCESS_KEY_ID ?? '', AWS_SECRET_ACCESS_KEY: this.env.PROBE_SECRET_ACCESS_KEY ?? '',
      PROBE_BUCKET: this.env.PROBE_BUCKET, PROBE_ACCOUNT: this.env.ACCOUNT,
    } });
  }

  loseSnapshot(): boolean {
    const held = v.safeParse(Snapshot, this.ctx.storage.kv.get('devbox:snapshot'));

    if (!held.success) return false;
    this.ctx.storage.kv.put('devbox:snapshot', { ...this.ctx.storage.kv.get<object>('devbox:snapshot'), id: crypto.randomUUID() });

    return true;
  }

  snapshots(): readonly string[] {
    const own = v.safeParse(Snapshot, this.ctx.storage.kv.get('devbox:snapshot'));
    const golden = v.safeParse(GoldenStateSchema, this.ctx.storage.kv.get('devbox:golden'));

    return [...new Set([
      ...own.success ? [...own.output.lineage, own.output.id] : [],
      ...golden.success ? [golden.output.current?.id, golden.output.previous?.id].filter((id): id is string => id !== undefined) : [],
    ])];
  }

  async clear(): Promise<void> {
    const snapshots = this.snapshots();
    await this.discardState();
    await this.destroy();

    for (const id of snapshots) {
      const outcome = await this.snapshotRegistry?.delete(id);

      if (outcome === undefined || outcome.kind === 'refused') throw new Error(`snapshot ${id}: ${outcome?.kind === 'refused' ? outcome.reason : 'no registry authority'}`);
    }
  }
}

const Body = v.object({ command: v.optional(v.string()) });

async function desktopRoute(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response | null> {
  if (url.pathname.startsWith('/kasmvnc/')) return withAppSecurityHeaders(await env.ASSETS.fetch(request), url, null);
  const desktopName = /^\/api\/workspaces\/(eval-devbox-[\w-]+)\/desktop$/.exec(url.pathname)?.[1];

  if (desktopName !== undefined) {
    const box = env.Box.getByName(desktopName);

    const route = serveFamily(terminalRoutes(() => ({
      resolveWorkspace: async () => ({
        prepareTerminal: async () => { await box.ensureReady();

 return { ok: true as const }; },
        openDeviceTerminal: async () => { throw new Error('this probe has no device'); },
        fetch: async () => new Response('this probe has no workspace terminal', { status: 404 }),
      }),
      resolveSandbox: () => box,
      UserDO: { idFromName: () => { throw new Error('this probe has no account devices'); }, get: () => { throw new Error('this probe has no account devices'); } },
    })), { workspace: { name: desktopName }, ctx });

    return await route(request, {}) ?? new Response('desktop route not found', { status: 404 });
  }

  return null;
}

async function contractRoute(url: URL, name: string, box: DurableObjectStub<ContractBox>, body: v.InferOutput<typeof Body>): Promise<Response> {
  switch (url.pathname) {
    case '/view': return new Response(`<iframe src="${desktopClientUrl(url, name)}" style="width:1280px;height:800px;border:0"></iframe>`, { headers: { 'content-type': 'text/html' } });
    case '/golden': return Response.json({ id: await box.ensureGolden() });
    case '/inspection': return Response.json(await box.inspection());
    case '/file-contract': return Response.json(await box.fileContract());
    case '/contract': await box.contract(v.parse(v.picklist(CONTAINER_CONTRACTS), url.searchParams.get('kind')));

      return Response.json({ ok: true });
    case '/disk-contract': await box.diskContract(v.parse(v.picklist(DISK_CONTRACTS), url.searchParams.get('kind')));

      return Response.json({ ok: true });
    case '/exec': return Response.json(await box.exec(body.command ?? ''));
    case '/storage-probe': return Response.json(await box.storageProbe(body.command ?? ''));
    case '/state': return Response.json(await box.devboxState());
    case '/checkpoint': return Response.json(await box.checkpointNow(url.searchParams.get('kind') === 'tick' ? 'tick' : 'quiesce'));
    case '/stop': return Response.json(await box.quiesce());
    case '/lose-snapshot': return Response.json({ ok: await box.loseSnapshot() });
    case '/snapshots': return Response.json(await box.snapshots());
    case '/cleanup': await box.clear();

      return Response.json({ ok: true });
    default: return new Response('no route', { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (env.EVAL_IDENTITY === undefined || request.headers.get('authorization') !== `Bearer ${env.EVAL_IDENTITY}`) return new Response('unauthorized', { status: 401 });
    const url = new URL(request.url);

    if (url.pathname === '/health') return Response.json({ ok: true });

    const desktop = await desktopRoute(request, env, ctx, url);

    if (desktop !== null) return desktop;

    const name = url.searchParams.get('box') ?? '';

    if (!name.startsWith('eval-devbox-') && name !== GOLDEN_NAME) return new Response('only this run\'s eval workspaces', { status: 403 });
    const box = env.Box.getByName(name);
    const body = request.method === 'POST' ? v.parse(Body, await request.json()) : {};

    try {
      return await contractRoute(url, name, box, body);
    } catch (cause) { return Response.json({ error: describeThrown({ cause }) }, { status: 500 }); }
  },
} satisfies ExportedHandler<Env>;
