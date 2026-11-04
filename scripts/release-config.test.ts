/**
 * The deployed release configuration: the two things a production incident needs
 * to already be true, because neither can be established afterwards.
 *
 * A1 CUSTOM IMAGES ARE IMMUTABLE. A custom image uses its recorded digest, never
 *   a moving tag. Devbox starts the official managed base directly and prepares
 *   no Wrangler image; its golden installs the pinned tools archive (D66/D72).
 *   The tools record pins the Sandbox shim version and the source it was built
 *   from. A declared Ubuntu image would prepare bytes no box ever boots.
 *
 * A2 THE WORKER'S STACK TRACES ARE READABLE. An uncaught exception in a deployed
 *   Worker reaches Workers Logs as a stack over one minified bundle unless
 *   Cloudflare has that version's source maps, and the persisted trace is the
 *   whole evidence for a provider or turn failure that nobody was watching — the
 *   2026-07-13 abrupt-stop incident's root error was unrecoverable for exactly
 *   this reason. `upload_source_maps` is the switch, and it needs maps ON DISK to
 *   upload: the deploy goes through the Vite plugin's generated config, which
 *   sets `no_bundle`, so wrangler bundles nothing of its own and scans each
 *   module's `sourceMappingURL` instead. The flag without the Vite side is a
 *   silent no-op, which is why both halves are asserted here.
 *
 * WHAT THIS FILE IS NOT. It reads configuration; it cannot pull an image, read a
 * running container, or narrow an account-scoped API token. That the digest is
 * pullable and that the container reports the matching SANDBOX_VERSION are
 * deploy-time and account-level facts — `UNCAPTURED` in scripts/infra-manifest.ts
 * names them with the command that answers them.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

import { isPreviewHostRequest, previewHostSuffix } from '../packages/core/src/preview/preview-origin';
import { parseJsonc } from './jsonc';
import { isWorkerConfig, readRepositoryFile, trackedFiles } from './sources';
import { REPO_ROOT } from './repo-root';
// The config module itself, not its text: the failure being guarded is a hook
// that exists and decides the wrong thing, which no source-text assertion sees.
import viteConfigFor from '../packages/cf-backend/vite.config';


const WRANGLER = 'packages/cf-backend/wrangler.jsonc';

/** The package that imports the SDK and so decides which of its versions ships; Kinu reaches it through devbox. */
const PACKAGE = 'packages/devbox/package.json';

const BLOCK_LOWER = 'packages/devbox/block-lower';

/** The container hosts: every Worker config that uses the devbox tools. */
const CONTAINER_HOSTS = [WRANGLER, 'packages/devbox/bench/wrangler.jsonc', 'packages/devbox/example/wrangler.jsonc'];

/**
 * The tools record holds their build sources, shim release and managed base.
 */
const BlockLowerArtifactSchema = v.object({
  base: v.literal('cloudflare/debian-trixie'),
  sandboxVersion: v.string(),
  files: v.record(v.string(), v.string()),
});

const ARTIFACT = v.parse(BlockLowerArtifactSchema, JSON.parse(readRepositoryFile(REPO_ROOT, `${BLOCK_LOWER}/upstream.json`)));

/** A vite plugin that decides something per environment — the one shape this
 *  file calls. `PluginOption` also admits arrays, promises and `false`, so the
 *  list is narrowed by PARSING each entry rather than by asking what it looks
 *  like: a plugin that stops being environment-scoped fails the count below
 *  instead of being read as one. */
const EnvironmentScopedPluginSchema = v.looseObject({
  name: v.string(),
  configEnvironment: v.function(),
});

/** One container: an application-wide image (the `default` scheduling policy), or the named images an
 *  object starts by name (`durable_object`). */
const ContainerSchema = v.union([
  v.object({ class_name: v.string(), image: v.string() }),
  v.object({ class_name: v.string(), scheduling_policy: v.literal('durable_object'), images: v.optional(v.record(v.string(), v.object({ image: v.string() }))) }),
]);

const imagesOf = (container: v.InferOutput<typeof ContainerSchema>): string[] =>
  'image' in container ? [container.image] : Object.values(container.images ?? {}).map((entry) => entry.image);

/** A container host's config, narrowed to the images it runs. */
const ContainerHostSchema = v.object({ containers: v.array(ContainerSchema) });

/** Only the keys this file reads. A narrow schema rather than the manifest's
 *  full one: a shape that admitted more would start answering other questions,
 *  and a key present but wrongly shaped fails the parse instead of reading as
 *  absent — a config this cannot read is not a config it may pass. */
const WranglerSchema = v.object({
  compatibility_date: v.string(),
  upload_source_maps: v.optional(v.boolean()),
  assets: v.object({ run_worker_first: v.union([v.boolean(), v.array(v.string())]) }),
  vars: v.object({ PREVIEW_HOST_SUFFIX: v.string(), CLI_PUBLIC_ORIGIN: v.string() }),
  kv_namespaces: v.array(v.object({ binding: v.string() })),
  d1_databases: v.optional(v.array(v.object({ binding: v.string() }))),
  durable_objects: v.object({ bindings: v.array(v.object({ name: v.string(), class_name: v.string() })) }),
});

const CONFIG = parseJsonc(readFileSync(join(REPO_ROOT, WRANGLER), 'utf8'), WranglerSchema, WRANGLER);

test('every Worker manifest uses the canonical deployment compatibility date', () => {
  const schema = v.object({
    compatibility_date: v.string(),
    env: v.optional(v.record(v.string(), v.object({ compatibility_date: v.optional(v.string()) }))),
  });

  for (const file of trackedFiles().filter(isWorkerConfig)) {
    const config = parseJsonc(readRepositoryFile(REPO_ROOT, file), schema, file);

    expect(config.compatibility_date, `${file} differs from the deployed runtime`).toBe(CONFIG.compatibility_date);

    for (const [name, environment] of Object.entries(config.env ?? {})) {
      if (environment.compatibility_date !== undefined) {
        expect(environment.compatibility_date, `${file} env.${name} differs from the deployed runtime`).toBe(CONFIG.compatibility_date);
      }
    }
  }
});

describe('the managed base', () => {
  test('the pin names the @cloudflare/sandbox version that ships', () => {
    const manifest = v.parse(
      v.object({ dependencies: v.record(v.string(), v.string()) }),
      JSON.parse(readFileSync(join(REPO_ROOT, PACKAGE), 'utf8')),
    );

    // Exact, not a range: the container reports one SANDBOX_VERSION and the SDK
    // compares it to the installed one, so `^0.12.8` would let an install decide
    // which container is correct.
    expect(manifest.dependencies['@cloudflare/sandbox']).toBe(ARTIFACT.sandboxVersion);
  });
});

// One Bun everywhere this repository runs one: an older one, or a moving `canary`, is how a synchronous spawn kept
// spinning over a zombie child after Bun 1.4.3 fixed it (oven-sh/bun#44581; #83). Armada's setup runs before any
// checkout, so it carries the release as text.
test('armada installs the Bun package.json pins, and the Bun is a release', () => {
  const pinned = /^bun@(\d+\.\d+\.\d+)$/u.exec(v.parse(v.object({ packageManager: v.string() }), JSON.parse(readRepositoryFile(REPO_ROOT, 'package.json'))).packageManager)?.[1];
  const bootstrap = /bun\.sh\/install \| BUN_INSTALL=\/usr\/local bash -s bun-v(\S+)/u.exec(readRepositoryFile(REPO_ROOT, 'scripts/armada/setup.sh'))?.[1];

  expect(pinned, 'packageManager names one Bun release').toBeDefined();
  expect(bootstrap).toBe(pinned);
});

describe("the deployed Worker's stack traces are readable", () => {
  test('the Worker uploads its source maps', () => {
    expect(CONFIG.upload_source_maps, 'the Worker would report minified stacks').toBe(true);
  });

  // The decision, called — not the text that expresses it. A source-text
  // assertion here would pass over a hook that returns the wrong thing, and the
  // whole failure being guarded is a flag whose other half is missing.
  test('the vite build emits worker source maps and leaves the client without', () => {
    // As `vite build` resolves it: the release is a build.
    const plugins = (viteConfigFor({ command: 'build', mode: 'production' }).plugins ?? []).flatMap((plugin) => {
      const parsed = v.safeParse(EnvironmentScopedPluginSchema, plugin);

      return parsed.success && parsed.output.name === 'kinu:worker-source-maps' ? [parsed.output] : [];
    });

    const [sourceMaps] = plugins;

    // The worker environment is named after the worker (`kinu`), so the hook
    // decides by what an environment is NOT rather than by naming it.
    expect(sourceMaps?.configEnvironment('kinu')).toEqual({ build: { sourcemap: true } });
    // A map in `dist/client` is original TypeScript published on the public
    // origin, so the client is the one environment that must not get one.
    expect(sourceMaps?.configEnvironment('client')).toBeNull();
  });
});

/**
 * A5 PREVIEWS ARE ISOLATED BY HOST. Agent-written apps are served on subdomains of the preview zone, and the
 * Worker tells a preview host from the app host before any route runs. That holds only if the Worker sees
 * every request: asset routing is path-only, so a path the asset router answered first (`/assets/*` on a
 * preview host included) would reach the app's files without the host check.
 */
describe('previews are isolated by host', () => {
  test("the production preview zone is the app host's own subdomains", () => {
    const vars = CONFIG.vars;
    const appHost = new URL(vars.CLI_PUBLIC_ORIGIN).hostname;

    expect(previewHostSuffix(vars)).toBe(appHost);
    expect(isPreviewHostRequest(new URL(vars.CLI_PUBLIC_ORIGIN), vars)).toBe(false);
    expect(isPreviewHostRequest(new URL(`https://probe.${appHost}`), vars)).toBe(true);
  });

  test('every request reaches the Worker before the asset router', () => {
    expect(CONFIG.assets.run_worker_first, `${WRANGLER} lets the asset router answer some paths first`).toBe(true);
  });
});

/**
 * A6 SIGN-IN HAS NO SINGLE CHOKEPOINT. Sign-in state is short-lived KV records plus each user's own object,
 * which answers whether a session is live, and a CLI sign-in's own objects. A database or a singleton auth object
 * in front of every sign-in would make one binding the login path of every user at once.
 */
describe('sign-in has no single chokepoint', () => {
  test('auth state is the AUTH_KV namespace and per-user or per-sign-in objects, and nothing fronts them', () => {
    const objects = CONFIG.durable_objects.bindings.flatMap((binding) => [binding.name, binding.class_name]);

    expect(CONFIG.kv_namespaces.map((namespace) => namespace.binding)).toContain('AUTH_KV');
    expect(CONFIG.d1_databases ?? []).toEqual([]);
    // Binding and class: one object per CLI sign-in, named by its device hash or user code (cli/auth-store.ts), so a
    // second device reads its approval strongly consistent; a new auth object is an edit made here.
    expect(objects.filter((name) => /auth/iu.test(name))).toEqual(['CliAuthDO', 'CliAuthDO']);
  });
});


/**
 * A8 THE TOOLS ARE BUILT FROM THIS TREE. A source change needs a new pinned artifact before the golden serves it.
 */
describe('the tools tarball is built from this tree', () => {
  test('the record hashes exactly the tools-stage sources, and each hash holds', () => {
    const sources = trackedFiles()
      .filter((file) => file.startsWith(`${BLOCK_LOWER}/`))
      .map((file) => file.slice(BLOCK_LOWER.length + 1))
      .filter((file) => ['Cargo.toml', 'Cargo.lock', 'tools-setup.sh', 'tools-build.sh'].includes(file) || /^src\/[^/]+\.rs$/u.test(file));

    expect(Object.keys(ARTIFACT.files).sort()).toEqual(sources.sort());

    for (const [file, recorded] of Object.entries(ARTIFACT.files)) {
      const built = createHash('sha256').update(readFileSync(join(REPO_ROOT, BLOCK_LOWER, file))).digest('hex');
      expect(built, `${file} changed since the image was built`).toBe(recorded);
    }
  });

  test('every devbox host uses the native scheduling policy with no image preparation', () => {
    for (const host of CONTAINER_HOSTS) {
      const config = parseJsonc(readRepositoryFile(REPO_ROOT, host), ContainerHostSchema, host);
      const sandboxes = config.containers;

      expect(sandboxes.map(row => 'scheduling_policy' in row ? row.scheduling_policy : 'default'), host).toEqual(sandboxes.map(() => 'durable_object'));
      expect(sandboxes.flatMap(imagesOf), host).toEqual([]);
    }
  });
});
