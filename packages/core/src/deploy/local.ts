// Local door layout and workerd config, rendered from `release.json` (docs/SELF-DEPLOY.md).
// DO storage and KV map to disk directories; R2 (own protocol), Vectorize, AI, containers,
// Worker loader, Analytics Engine and email are left out by name. Paths are relative to the config.
import type { ReleaseBinding, ReleaseManifest } from './manifest';
import * as v from 'valibot';

/** Wrangler's default; 3000 is reserved for the repo dev server (AGENTS.md). */
export const LOCAL_PORT = 8787;

// Loopback keeps an unauthenticated first run off the network.
function localAddress(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

/** `current` symlinks into `releases/<version>/`; an update is one symlink swap. */
export interface LocalLayout {
  /** workerd's working directory. */
  readonly root: string;
  readonly releases: string;
  readonly current: string;
  readonly state: string;
  readonly bin: string;
  readonly workerd: string;
  readonly capnp: string;
  readonly config: string;
  readonly log: string;
  readonly pid: string;
}

export function localLayout(home: string): LocalLayout {
  const root = `${home.replace(/\/+$/u, '')}/local`;

  return {
    root,
    releases: `${root}/releases`,
    current: `${root}/current`,
    state: `${root}/state`,
    bin: `${root}/bin`,
    workerd: `${root}/bin/workerd`,
    capnp: `${root}/workerd.capnp`,
    config: `${root}/config.json`,
    log: `${root}/workerd.log`,
    pid: `${root}/workerd.pid`,
  };
}

export function releaseDir(layout: LocalLayout, version: string): string {
  return `${layout.releases}/${version}`;
}

export interface LocalConfig {
  readonly version: string;
  readonly port: number;
  readonly address: string;
  readonly renderedAt: string;
}

export const LocalConfigSchema: v.GenericSchema<LocalConfig> = v.object({
  version: v.string(),
  port: v.number(),
  address: v.string(),
  renderedAt: v.string(),
});

export function renderLocalConfig(input: { version: string; port: number; at: Date }): string {
  const config: LocalConfig = {
    version: input.version,
    port: input.port,
    address: localAddress(input.port),
    renderedAt: input.at.toISOString(),
  };

  return `${JSON.stringify(config, null, 2)}\n`;
}

// KV over a writable disk service cannot serve keys containing `/`; Kinu's keys carry none.
const KV_KIND = 'kv';

/** Printed by the caller so missing capabilities are never silent. */
export function unhostedBindings(manifest: ReleaseManifest): readonly string[] {
  return manifest.bindings
    .filter((binding) => !(binding.kind === 'assets' || binding.kind === 'durable-object' || binding.kind === KV_KIND))
    .map((binding) => binding.binding);
}

function quoted(text: string): string {
  return `"${text.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

// Keyed by binding: resource names are not unique within a release.
function serviceName(binding: ReleaseBinding): string {
  return `${binding.kind}-${binding.binding}`;
}

/** workerd refuses to start if a disk service directory is absent; create these first. */
export function workerdDirectories(manifest: ReleaseManifest): readonly string[] {
  return ['state/do', ...manifest.bindings.filter((binding) => binding.kind === KV_KIND).map(storePath)];
}

function storePath(binding: ReleaseBinding): string {
  return `state/${binding.kind}/${binding.resource === '' ? binding.binding : binding.resource}`;
}

/** DO unique keys must stay stable across renders: workerd keys on-disk storage by them. */
export function renderWorkerdConfig(input: {
  readonly manifest: ReleaseManifest;
  readonly version: string;
  readonly port: number;
}): string {
  const { manifest, version, port } = input;
  const release = `releases/${version}`;
  const stores = manifest.bindings.filter((binding) => binding.kind === KV_KIND);
  const classes = [...new Set(manifest.migrations.flatMap((migration) => migration.newSqliteClasses))];
  const assets = manifest.bindings.find((binding) => binding.kind === 'assets');

  const services = [
    '    (name = "main", worker = .mainWorker),',
    '    (name = "do-state", disk = (path = "state/do", writable = true)),',
    ...(assets === undefined
      ? []
      : [`    (name = "assets", disk = (path = ${quoted(`${release}/${manifest.worker.assets}`)}, writable = false)),`]),
    ...stores.map((binding) =>
      `    (name = ${quoted(serviceName(binding))}, disk = (path = ${quoted(storePath(binding))}, writable = true)),`),
  ];

  // Same rule as `steps.ts`: `.wasm` is a WebAssembly module, everything else an ES module.
  const modules = manifest.worker.modules.map((name) =>
    `    (name = ${quoted(name)}, ${name.endsWith('.wasm') ? 'wasm' : 'esModule'} = embed ${quoted(`${release}/${manifest.worker.modulesPath}/${name}`)}),`);

  const bindings = [
    ...(assets === undefined ? [] : [`    (name = ${quoted(assets.binding)}, service = "assets"),`]),
    ...stores.map((binding) =>
      `    (name = ${quoted(binding.binding)}, kvNamespace = ${quoted(serviceName(binding))}),`),
    ...manifest.bindings
      .filter((binding) => binding.kind === 'durable-object')
      .map((binding) =>
        `    (name = ${quoted(binding.binding)}, durableObjectNamespace = ${quoted(binding.resource)}),`),
    ...manifest.vars
      .filter((declared) => declared.policy === 'carried' && (declared.value ?? '') !== '')
      .map((declared) => `    (name = ${quoted(declared.name)}, text = ${quoted(declared.value ?? '')}),`),
  ];

  const namespaces = classes.map((className) =>
    `    (className = ${quoted(className)}, uniqueKey = ${quoted(`kinu-local-${className}`)}, enableSql = true),`);

  return [
    '# Generated by `kinu deploy local` from release.json. Edits are lost on the',
    `# next render. Release ${version}, built ${manifest.builtAt}.`,
    'using Workerd = import "/workerd/workerd.capnp";',
    '',
    'const config :Workerd.Config = (',
    '  services = [',
    ...services,
    '  ],',
    '  sockets = [',
    `    (name = "http", address = ${quoted(`127.0.0.1:${String(port)}`)}, http = (), service = "main"),`,
    '  ],',
    ');',
    '',
    'const mainWorker :Workerd.Worker = (',
    '  modules = [',
    ...modules,
    '  ],',
    `  compatibilityDate = ${quoted(manifest.worker.compatibilityDate)},`,
    `  compatibilityFlags = [${manifest.worker.compatibilityFlags.map(quoted).join(', ')}],`,
    ...(namespaces.length === 0
      ? []
      : ['  durableObjectNamespaces = [', ...namespaces, '  ],', '  durableObjectStorage = (localDisk = "do-state"),']),
    '  bindings = [',
    ...bindings,
    '  ],',
    ');',
    '',
  ].join('\n');
}
