/**
 * The local door's layout and its workerd configuration, rendered from
 * `release.json` (docs/SELF-DEPLOY.md § The local door).
 *
 * WHY RENDERED AND NOT CHECKED IN. A local instance runs the same Worker build
 * as a deployed one, and what that build needs — its module list, its
 * compatibility date, its Durable Object classes, every binding — is already
 * data in the release manifest. A hand-kept `workerd.capnp` beside it would be
 * a second spelling of `wrangler.jsonc` that drifts the first time a binding is
 * added.
 *
 * WHAT WORKERD GIVES AND WHAT IT DOES NOT. Durable Object storage is a local
 * directory (`durableObjectStorage = (localDisk = …)`), and so is every
 * account-level store this Worker binds: there is no KV, R2 or Vectorize
 * implementation in workerd, so a `kv` or `r2` binding is rendered as a
 * writable disk service under `state/`, which is what `docs/SELF-DEPLOY.md`
 * means by "KV and R2 on local disk". A binding workerd cannot host at all —
 * Vectorize, AI, the container, the Worker loader, Analytics Engine, email —
 * is left out of the config with its name recorded, so a local instance loses
 * exactly those capabilities instead of refusing to start.
 *
 * PATHS ARE RELATIVE TO THE CONFIG FILE. `embed` is resolved that way by capnp
 * itself, and a tree that can be moved or copied is the point: the supervisor
 * runs workerd with `~/.kinu/local` as its working directory.
 */
import type { ReleaseBinding, ReleaseManifest } from './manifest';
import * as v from 'valibot';

/**
 * The port a local instance answers on.
 *
 * 8787 because 3000 is reserved for this repository's own dev server
 * (AGENTS.md) and 8787 is wrangler's own default, so a person who has run
 * `wrangler dev` already knows it.
 */
export const LOCAL_PORT = 8787;

/** The one address a local instance is reachable at. TLS is the host's
 *  concern, and a loopback bind is what keeps an unauthenticated first run off
 *  the network it sits on. */
function localAddress(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

/**
 * Where everything the local door owns lives, from one home directory.
 *
 * `current` is a symlink into `releases/<version>/`, so an update is a new
 * directory and one symlink swap, and the running instance's files are never
 * written under it.
 */
export interface LocalLayout {
  /** `~/.kinu/local`, and workerd's working directory. */
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

/** What the installer settled, read back by every later command: which release
 *  `current` points at, and the port the instance answers on. */
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

/** The store kinds workerd hosts as a directory: it has no KV or R2 of its
 *  own, so a local instance's session store and backup bucket are directories
 *  under `state/`. */
const DISK_KINDS: readonly string[] = ['kv', 'r2'];

/** The bindings a local instance does not get — Vectorize, AI, the container,
 *  the Worker loader, Analytics Engine, email. The caller prints these: a
 *  capability that is silently absent is a defect report later. */
export function unhostedBindings(manifest: ReleaseManifest): readonly string[] {
  return manifest.bindings
    .filter((binding) => !(binding.kind === 'assets' || binding.kind === 'durable-object' || DISK_KINDS.includes(binding.kind)))
    .map((binding) => binding.binding);
}

/** capnp text quoting: the only characters that can appear in a rendered
 *  string here are a path and a var value, and a quote or a backslash in
 *  either would end the literal early. */
function quoted(text: string): string {
  return `"${text.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

/** One name for a store's disk service and nothing else's: the binding is
 *  unique in a release where a resource name is not. */
function serviceName(binding: ReleaseBinding): string {
  return `${binding.kind}-${binding.binding}`;
}

/**
 * The writable directories the rendered config names, relative to the
 * instance's root.
 *
 * Exported because workerd REFUSES to start on a disk service whose directory
 * is absent ("Directory named … not found", measured with workerd 2026-09-03),
 * so whoever writes the config must create exactly these. Derived from the
 * same manifest the config is rendered from, so the two cannot disagree.
 */
export function workerdDirectories(manifest: ReleaseManifest): readonly string[] {
  return ['state/do', ...manifest.bindings.filter((binding) => DISK_KINDS.includes(binding.kind)).map(storePath)];
}

function storePath(binding: ReleaseBinding): string {
  return `state/${binding.kind}/${binding.resource === '' ? binding.binding : binding.resource}`;
}

/**
 * The workerd configuration for one release, as capnp text.
 *
 * The Durable Object unique key is derived from the class name and is stable
 * across renders: workerd keys a class's on-disk storage by it, so a key that
 * changed with every render would orphan the instance's whole database.
 */
export function renderWorkerdConfig(input: {
  readonly manifest: ReleaseManifest;
  readonly version: string;
  readonly port: number;
}): string {
  const { manifest, version, port } = input;
  const release = `releases/${version}`;
  const stores = manifest.bindings.filter((binding) => DISK_KINDS.includes(binding.kind));
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

  const modules = manifest.worker.modules.map((name) =>
    `    (name = ${quoted(name)}, esModule = embed ${quoted(`${release}/${manifest.worker.modulesPath}/${name}`)}),`);

  const bindings = [
    ...(assets === undefined ? [] : [`    (name = ${quoted(assets.binding)}, service = "assets"),`]),
    ...stores.map((binding) => `    (name = ${quoted(binding.binding)}, service = ${quoted(serviceName(binding))}),`),
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
