/**
 * The deployed release configuration: the two things a production incident needs
 * to already be true, because neither can be established afterwards.
 *
 * A1 THE CONTAINER IMAGE IS IMMUTABLE. `docker.io/cloudflare/sandbox:0.12.8` is a
 *   mutable pointer. Anyone who can push that repository can re-point the tag,
 *   and the next container start runs the new bytes with nothing in this
 *   repository changed — inside a container holding somebody's workspace, and
 *   with no record afterwards of which image actually ran. A digest cannot be
 *   re-pointed: it IS the bytes. So every deployable environment must name the
 *   image by digest, both must name the SAME one, and that digest must be the one
 *   resolved for the `@cloudflare/sandbox` version this deployment ships — the
 *   SDK asks the container for its own SANDBOX_VERSION on every start
 *   (Sandbox.checkVersionCompatibility), so a digest from another version is a
 *   mismatch logged at container start rather than a failed deploy.
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
 * A3 NO CREDENTIAL-BEARING JOB RUNS UNREVIEWED CODE. The old `eval.yml`'s
 *   benchmark job could be started by labelling a pull request, and a
 *   `pull_request` checkout is that pull request's code: it installed the
 *   branch's lockfile and ran the branch's scripts with the eval-service token and
 *   two vendor keys in the environment. So no job holding a secret may be started
 *   by a pull request at all (`evals.yml` measures the deployed build, dispatched
 *   after a deploy), and each is bound to a GitHub environment so the secret is
 *   not readable by every other workflow in the repository.
 *
 * A4 NO WORKFLOW FETCHES ITS TOOLCHAIN FROM A MOVING TARGET. Three workflows
 *   piped `master` of the elan installer into a shell, and in the staging deploy
 *   the toolchain it installed then ran inside the step holding
 *   `CLOUDFLARE_API_TOKEN`, because `verify:lean` is a required gate. Every
 *   workflow's tools now come from a named release whose checksum is verified
 *   before anything executes, and no `uses:` may name a branch.
 *
 * WHAT THIS FILE IS NOT. It reads configuration; it cannot pull an image, read a
 * running container, or narrow an account-scoped API token. That the digest is
 * pullable and that the container reports the matching SANDBOX_VERSION are
 * deploy-time and account-level facts — `UNCAPTURED` in scripts/infra-manifest.ts
 * names them with the command that answers them. What a Cloudflare token may do,
 * and which reviewers an environment requires, are dashboard settings; the
 * workflow comments name them where an operator will look.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';

import { isPreviewHostRequest, previewHostSuffix } from '../packages/core/src/preview/preview-origin';
import { SANDBOX_TRANSPORT } from '../packages/core/src/preview/sandbox-id';
import { parseJsonc } from './jsonc';
import { CONTAINER_IMAGES, imageReference, readSource, sourceHash, type ContainerImage } from './container-images';
import { allCommands, invocation, parseShell, type ShellScript } from './shell-words';
import { readRepositoryFile, trackedFiles } from './sources';
import { type ContextPath, contextPaths } from './workflow-expressions';
// The config module itself, not its text: the failure being guarded is a hook
// that exists and decides the wrong thing, which no source-text assertion sees.
import viteConfigFor from '../packages/cf-backend/vite.config';

const REPO_ROOT = join(import.meta.dir, '..');

const WRANGLER = 'packages/cf-backend/wrangler.jsonc';

const PACKAGE = 'packages/cf-backend/package.json';

const VITE_CONFIG = 'packages/cf-backend/vite.config.ts';

const WORKFLOWS = '.github/workflows';

const SETUP_LEAN = '.github/actions/setup-lean/action.yml';

const LEAN_VERIFY = '.github/workflows/lean-verify.yml';

const BLOCK_LOWER = 'packages/devbox/block-lower';

/** The container hosts: every Worker config that runs the block-lower image. */
const CONTAINER_HOSTS = [WRANGLER, 'packages/devbox/bench/wrangler.jsonc', 'packages/devbox/example/wrangler.jsonc'];

/**
 * The sandbox container image every environment runs, declared ONCE: the block-lower artifact record.
 *
 * `packages/devbox/block-lower/Dockerfile` compiles `devbox-block-lower` and `devbox-squashfuse` into the
 * upstream `@cloudflare/sandbox` base, and the result is pushed to this account's registry; the push writes
 * `upstream.json` with the pushed manifest's digest, the sandbox release whose container the SDK expects,
 * and the hash of every source the image was built from. Each wrangler.jsonc repeats the reference because a
 * JSONC file cannot import a constant; this record is what they are held to.
 */
const BlockLowerArtifactSchema = v.object({
  image: v.string(),
  digest: v.string(),
  sandboxVersion: v.string(),
  files: v.record(v.string(), v.string()),
});

const ARTIFACT = v.parse(BlockLowerArtifactSchema, JSON.parse(readRepositoryFile(REPO_ROOT, `${BLOCK_LOWER}/upstream.json`)));

const SANDBOX_IMAGE = {
  repository: ARTIFACT.image.slice(0, ARTIFACT.image.lastIndexOf('@')),
  version: ARTIFACT.sandboxVersion,
  digest: ARTIFACT.digest,
} as const;

const PINNED_IMAGE = ARTIFACT.image;

/** Each container class and the one image the release record declares for it. */
const PINNED_IMAGES = new Map(Object.entries(CONTAINER_IMAGES).map(([className, image]) => [className, imageReference(image)]));

/** A vite plugin that decides something per environment — the one shape this
 *  file calls. `PluginOption` also admits arrays, promises and `false`, so the
 *  list is narrowed by PARSING each entry rather than by asking what it looks
 *  like: a plugin that stops being environment-scoped fails the count below
 *  instead of being read as one. */
const EnvironmentScopedPluginSchema = v.looseObject({
  name: v.string(),
  configEnvironment: v.function(),
});

/**
 * An image reference nothing can re-point: a digest, and no tag beside it.
 *
 * `repo:tag@sha256:…` is deliberately refused even though the digest decides the
 * pull. The tag is then still in the deployed config, where a reader believes it
 * and an operator bumps it, and the two can disagree with nobody the wiser.
 */
function isImmutableImageReference(reference: string): boolean {
  const parts = reference.split('@');

  if (parts.length !== 2) return false;
  const [name, digest] = parts;

  if (name === undefined || digest === undefined) return false;

  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) return false;

  // Only the last segment can carry a tag; an earlier colon is a registry port.
  return !name.slice(name.lastIndexOf('/') + 1).includes(':');
}

/** A container host's config, narrowed to the images it runs. */
const ContainerHostSchema = v.object({
  containers: v.array(v.object({ class_name: v.string(), image: v.string() })),
});

/** Only the keys this file reads. A narrow schema rather than the manifest's
 *  full one: a shape that admitted more would start answering other questions,
 *  and a key present but wrongly shaped fails the parse instead of reading as
 *  absent — a config this cannot read is not a config it may pass. */
const WranglerSchema = v.object({
  upload_source_maps: v.optional(v.boolean()),
  containers: v.optional(v.array(v.object({
    class_name: v.string(),
    image: v.string(),
  }))),
  assets: v.object({ run_worker_first: v.union([v.boolean(), v.array(v.string())]) }),
  vars: v.object({ PREVIEW_HOST_SUFFIX: v.string(), CLI_PUBLIC_ORIGIN: v.string(), SANDBOX_TRANSPORT: v.string() }),
  kv_namespaces: v.array(v.object({ binding: v.string() })),
  d1_databases: v.optional(v.array(v.object({ binding: v.string() }))),
  durable_objects: v.object({ bindings: v.array(v.object({ name: v.string(), class_name: v.string() })) }),
});

const CONFIG = parseJsonc(readFileSync(join(REPO_ROOT, WRANGLER), 'utf8'), WranglerSchema, WRANGLER);

describe('the sandbox container image is pinned', () => {
  test('the Worker runs the pinned digest and names no tag', () => {
    const containers = CONFIG.containers ?? [];

    expect(containers.map((container) => container.class_name).sort(), 'the Worker declares other containers than the record')
      .toEqual([...PINNED_IMAGES.keys()].sort());

    for (const { class_name: className, image } of containers) {
      expect(isImmutableImageReference(image), 'the Worker runs a re-pointable image').toBe(true);
      expect(image, 'the Worker runs an image the release record does not declare').toBe(PINNED_IMAGES.get(className) ?? `no pin for ${className}`);
    }
  });

  test('each image\'s source is the source its digest was built from', () => {
    // The sandbox's sources are held by its own artifact record (A8).
    for (const [className, image] of Object.entries<ContainerImage>(CONTAINER_IMAGES)) {
      if (image.sourceHash === undefined) continue;
      const files = readSource(REPO_ROOT, image.source);

      expect({ className, files: files.size > 0 }).toEqual({ className, files: true });
      expect({ className, sourceHash: sourceHash(files) }, `${image.source} changed with no new digest: see container-images.ts`)
        .toEqual({ className, sourceHash: image.sourceHash });
    }
  });

  test('the pin names the @cloudflare/sandbox version that ships', () => {
    const manifest = v.parse(
      v.object({ dependencies: v.record(v.string(), v.string()) }),
      JSON.parse(readFileSync(join(REPO_ROOT, PACKAGE), 'utf8')),
    );

    // Exact, not a range: the container reports one SANDBOX_VERSION and the SDK
    // compares it to the installed one, so `^0.12.8` would let an install decide
    // which container is correct.
    expect(manifest.dependencies['@cloudflare/sandbox']).toBe(SANDBOX_IMAGE.version);
  });

  test('a re-pointable reference is refused, in both directions', () => {
    expect(isImmutableImageReference(PINNED_IMAGE)).toBe(true);
    expect(isImmutableImageReference(`localhost:5000/sandbox@${SANDBOX_IMAGE.digest}`)).toBe(true);

    expect(isImmutableImageReference(`${SANDBOX_IMAGE.repository}:0.12.8`)).toBe(false);
    expect(isImmutableImageReference(`${SANDBOX_IMAGE.repository}:latest`)).toBe(false);
    // The digest pulls, and the tag is still there to be believed and bumped.
    expect(isImmutableImageReference(`${SANDBOX_IMAGE.repository}:0.12.8@${SANDBOX_IMAGE.digest}`))
      .toBe(false);
    expect(isImmutableImageReference(SANDBOX_IMAGE.repository)).toBe(false);
    expect(isImmutableImageReference(`${SANDBOX_IMAGE.repository}@sha256:822501de`)).toBe(false);
    expect(isImmutableImageReference(`${SANDBOX_IMAGE.repository}@md5:${'0'.repeat(64)}`)).toBe(false);
  });
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

      return parsed.success ? [parsed.output] : [];
    });

    expect(plugins.length, `${VITE_CONFIG} declares no environment-scoped plugin`).toBe(1);
    const [sourceMaps] = plugins;

    // The worker environment is named after the worker (`kinu`), so the hook
    // decides by what an environment is NOT rather than by naming it.
    expect(sourceMaps?.configEnvironment('kinu')).toEqual({ build: { sourcemap: true } });
    // A map in `dist/client` is original TypeScript published on the public
    // origin, so the client is the one environment that must not get one.
    expect(sourceMaps?.configEnvironment('client')).toBeNull();
  });
});

/* ── The workflows that publish and measure this product ────────────────── */

/** Only what these assertions read. `v.unknown()` where the shape is a union
 *  GitHub allows three spellings of: the questions below are answered from the
 *  expressions a job holds or from one key, never from a shape this file has to model. */
/** A YAML value, reduced at the parse to every string it holds at any depth:
 *  the only text a `${{ … }}` expression can sit in. */
const StringsSchema: v.GenericSchema<unknown, readonly string[]> = v.union([
  v.pipe(v.string(), v.transform((one) => [one])),
  v.pipe(v.array(v.lazy(() => StringsSchema)), v.transform((all) => all.flat())),
  v.pipe(v.record(v.string(), v.lazy(() => StringsSchema)), v.transform((table) => Object.values(table).flat())),
  v.pipe(v.unknown(), v.transform(() => [])),
]);

const EnvSchema = v.optional(v.record(v.string(), StringsSchema));

const StepSchema = v.looseObject({
  uses: v.optional(v.string()),
  run: v.optional(v.string()),
  env: EnvSchema,
});

// `looseObject`, not `object`: the secret search below reads every value in the
// job, and a schema that stripped the keys it does not name would strip the
// `with` block a credential can arrive in.
const JobSchema = v.looseObject({
  environment: v.optional(v.unknown()),
  env: EnvSchema,
  secrets: v.optional(v.unknown()),
  steps: v.optional(v.array(StepSchema)),
});

/** `on:` in the three spellings GitHub accepts, normalised to the trigger names
 *  at the parse rather than by a reader asking which spelling arrived. */
const TriggersSchema = v.union([
  v.pipe(v.string(), v.transform((one) => [one])),
  v.array(v.string()),
  v.pipe(v.record(v.string(), v.unknown()), v.transform((table) => Object.keys(table))),
]);

const WorkflowSchema = v.object({
  permissions: v.optional(v.unknown()),
  on: TriggersSchema,
  env: EnvSchema,
  jobs: v.record(v.string(), JobSchema),
});

type ParsedWorkflow = v.InferOutput<typeof WorkflowSchema>;

type Job = v.InferOutput<typeof JobSchema>;

type Env = v.InferOutput<typeof EnvSchema>;

interface Workflow {
  readonly file: string;
  readonly parsed: ParsedWorkflow;
}

/** Every workflow, from the one repository enumerator. A workflow added tomorrow
 *  is covered the day it is added. */
function workflows(): readonly Workflow[] {
  return trackedFiles()
    .filter((file) => dirname(file) === WORKFLOWS)
    .map((file) => ({ file, parsed: v.parse(WorkflowSchema, Bun.YAML.parse(readRepositoryFile(REPO_ROOT, file))) }));
}

const WORKFLOW_FILES = workflows();

/** Every step in every job, flattened, with where it came from and the `env`
 *  maps it sees, innermost first. */
function steps(): readonly { file: string; job: string; step: v.InferOutput<typeof StepSchema>; envs: readonly Env[] }[] {
  return WORKFLOW_FILES.flatMap(({ file, parsed }) =>
    Object.entries(parsed.jobs).flatMap(([job, definition]) =>
      (definition.steps ?? []).map((step) => ({ file, job, step, envs: [step.env, definition.env, parsed.env] }))));
}

const readsSecrets = (strings: readonly string[]): boolean =>
  strings.flatMap(contextPaths).some(([context]) => context === 'secrets');

/** A job holds a secret when an expression anywhere in it reads the `secrets`
 *  context (`secrets.X`, `secrets['X']`, `toJSON(secrets)`), when it hands
 *  secrets to a called workflow (`secrets: inherit`), or when the workflow-level
 *  `env` every job inherits reads one. */
function holdsSecret(workflow: ParsedWorkflow, job: Job): boolean {
  return job.secrets !== undefined || readsSecrets(v.parse(StringsSchema, job))
    || readsSecrets(Object.values(workflow.env ?? {}).flat());
}

/** Does a `run:` body splice event data into its text? Event data is
 *  `github.event…`, `github.head_ref`, the whole `github` context, any `inputs`
 *  value, or an `env` value (step, job, then workflow) that itself holds one:
 *  `${{ env.X }}` substitutes X's value into the script exactly as the original would. */
function splicesEventData(run: string, envs: readonly Env[]): boolean {
  const lookup = (name: string): readonly string[] => envs
    .map((env) => Object.entries(env ?? {}).find(([key]) => key.toLowerCase() === name)?.[1])
    .find((value) => value !== undefined) ?? [];

  const tainted = ([context, property]: ContextPath, seen: ReadonlySet<string>): boolean => {
    if (context === 'inputs') return true;

    if (context === 'github') {
      return property === undefined || property === '*' || property === 'event' || property === 'head_ref';
    }

    if (context !== 'env') return false;

    const names = property === undefined || property === '*'
      ? envs.flatMap((env) => Object.keys(env ?? {}).map((key) => key.toLowerCase()))
      : [property];

    return names.some((name) => !seen.has(name)
      && lookup(name).flatMap(contextPaths).some((inner) => tainted(inner, new Set([...seen, name]))));
  };

  return contextPaths(run).some((path) => tainted(path, new Set()));
}

const DOWNLOADERS = new Set(['curl', 'wget']);

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'eval', 'source', '.']);

const programIn = (programs: ReadonlySet<string>, command: Parameters<typeof invocation>[0]): boolean =>
  programs.has(invocation(command)?.program ?? '');

/** Does a shell body run a download as a script: `curl … | sh`, or a shell whose
 *  argument or input is a download (`bash -c "$(curl …)"`, `bash <(curl …)`)? */
function runsDownload(script: ShellScript): boolean {
  return script.some((pipeline) => {
    const download = pipeline.findIndex((command) => programIn(DOWNLOADERS, command));

    return (download !== -1 && pipeline.slice(download + 1).some((command) => programIn(SHELLS, command)))
      || pipeline.some((command) => (programIn(SHELLS, command)
        && allCommands(command.substitutions).some((inner) => programIn(DOWNLOADERS, inner)))
        || runsDownload(command.substitutions));
  });
}

/** Jobs holding a secret, with the triggers that can start them. */
function secretBearingJobs(): readonly { label: string; job: Job; triggers: readonly string[] }[] {
  return WORKFLOW_FILES.flatMap(({ file, parsed }) =>
    Object.entries(parsed.jobs)
      .filter(([, job]) => holdsSecret(parsed, job))
      .map(([name, job]) => ({
        label: `${file}#${name}`,
        job,
        triggers: parsed.on,
      })));
}

const SECRET_JOBS = secretBearingJobs();

const WORKFLOW_FIXTURE = (text: string): ParsedWorkflow => v.parse(WorkflowSchema, Bun.YAML.parse(text));

describe('the workflow readers see what GitHub and the shell run', () => {
  test('a secret is held however the expression spells it, and prose naming secrets holds none', () => {
    const held = (text: string): string[] => {
      const workflow = WORKFLOW_FIXTURE(text);

      return Object.entries(workflow.jobs).filter(([, job]) => holdsSecret(workflow, job)).map(([name]) => name);
    };

    expect(held([
      'on: push',
      'env:',
      '  TOKEN: ${{ secrets.DEPLOY_TOKEN }}',
      'jobs:',
      '  build: { steps: [{ run: make }] }',
    ].join('\n'))).toEqual(['build']);

    expect(held([
      'on: push',
      'jobs:',
      "  bracket: { steps: [{ run: make, env: { T: \"${{ secrets['DEPLOY_TOKEN'] }}\" } }] }",
      '  called: { uses: ./.github/workflows/x.yml, secrets: inherit }',
      "  prose: { steps: [{ run: 'echo rotate the secrets. then retry' }] }",
    ].join('\n'))).toEqual(['bracket', 'called']);
  });

  test('event data is found in every spelling that reaches the script text', () => {
    const title = v.parse(EnvSchema, { TITLE: '${{ github.event.issue.title }}', SAFE: '${{ github.repository }}' });

    for (const run of [
      "echo \"${{ github['event'].issue.title }}\"",
      'echo "${{ GitHub.Event.issue.title }}"',
      'echo "${{ inputs.model }}"',
      'echo \'${{ toJSON(github) }}\'',
      'echo "${{ env.TITLE }}"',
    ]) expect(splicesEventData(run, [title]), run).toBe(true);

    for (const run of ['echo "$TITLE"', 'echo "${{ env.SAFE }}"', 'echo "${{ github.event_name }}"', 'echo github.event']) {
      expect(splicesEventData(run, [title]), run).toBe(false);
    }
  });

  test('a download run as a script is found through quoting, continuations and wrappers', () => {
    for (const run of [
      'curl -fsSL https://example.test/install.sh | sh',
      'bash -c "$(curl -fsSL https://example.test/install.sh)"',
      'curl -fsSL https://example.test/install.sh \\\n  | sudo bash',
      'wget -qO- https://example.test/install.sh | /bin/sh -s -- --yes',
      'source <(curl -fsSL https://example.test/env.sh)',
    ]) expect(runsDownload(parseShell(run)), run).toBe(true);

    for (const run of ['echo "never curl | sh"', 'sha=$(curl -fsS https://example.test/health | jq -r .sha)']) {
      expect(runsDownload(parseShell(run)), run).toBe(false);
    }
  });
});

describe('the workflows that publish and measure this product', () => {
  test('every workflow is read, and the credential-bearing jobs are named', () => {
    expect(WORKFLOW_FILES.length, 'the workflow corpus collapsed').toBeGreaterThan(3);
    // Named, not counted. These hold every credential in the repository, and
    // the assertions below are only worth anything if they are still these.
    expect(SECRET_JOBS.map((entry) => entry.label).sort()).toEqual([
      '.github/workflows/evals.yml#diagnose',
      '.github/workflows/evals.yml#evals',
    ]);
  });

  test('every workflow declares its token permissions, and none of them write', () => {
    for (const { file, parsed } of WORKFLOW_FILES) {
      expect(parsed.permissions, `${file} inherits the default token permissions`).toBeDefined();
      const granted = JSON.stringify(parsed.permissions ?? null);
      expect(granted, `${file} grants write access`).not.toContain('write');
    }
  });

  test('a job that holds a secret is bound to a GitHub environment', () => {
    // Each credential-bearing job names its environment below, exactly as its
    // workflow file spells it. Repository secrets are readable by every workflow
    // in the repository, including one added by a branch. An environment is the
    // only boundary GitHub offers that a file in the repository can ask for.
    const bound = new Map([
      ['.github/workflows/evals.yml#diagnose', 'eval'],
      ['.github/workflows/evals.yml#evals', 'eval'],
    ]);

    for (const { label, job } of SECRET_JOBS) {
      expect(job.environment, `${label} reads a repository-wide secret`).toBe(bound.get(label));
    }
  });

  test('no pull request can start a job that holds a secret', () => {
    // A `pull_request` checkout is that pull request's code, and a label is all
    // it takes to start one: the job would run a branch nobody reviewed beside
    // the credential.
    const PULL_REQUEST = ['pull_request', 'pull_request_target'];

    for (const { label, triggers } of SECRET_JOBS) {
      expect(triggers.filter((trigger) => PULL_REQUEST.includes(trigger)), `${label} can be started by a pull request`).toEqual([]);
    }

    expect(SECRET_JOBS.length, 'no job holds a secret, so nothing here was checked').toBeGreaterThan(0);
  });

  test('no run body interpolates event data into a command', () => {
    // A `${{ … }}` expression inside a `run:` body is substituted before the
    // shell sees it, so the VALUE becomes syntax. The eval workflow spliced a
    // dispatch input into its command line exactly this way. Inputs travel
    // through `env` and are read as `"$VAR"`.
    let bodies = 0;

    for (const { file, job, step, envs } of steps()) {
      if (step.run === undefined) continue;
      bodies += 1;
      expect(splicesEventData(step.run, envs), `${file}#${job} lets event data decide what runs`).toBe(false);
    }

    expect(bodies, 'no workflow runs a shell body').toBeGreaterThan(0);
  });

  test('no workflow pipes a remote script into a shell', () => {
    let bodies = 0;

    for (const { file, job, step } of steps()) {
      if (step.run === undefined) continue;
      bodies += 1;
      expect(runsDownload(parseShell(step.run)), `${file}#${job} pipes a download into a shell`).toBe(false);
    }

    expect(bodies, 'no workflow runs a shell body').toBeGreaterThan(0);
  });

  test('the Lean toolchain is checksum-verified before it executes', () => {
    const action = v.parse(
      v.object({ runs: v.object({ steps: v.array(StepSchema) }) }),
      Bun.YAML.parse(readRepositoryFile(REPO_ROOT, SETUP_LEAN)),
    );

    const install = action.runs.steps.map((step) => step.run).find((run) => run !== undefined);
    expect(install, `${SETUP_LEAN} runs no install body`).toBeDefined();
    const body = install ?? '';

    // A named release, not a branch of somebody's repository.
    expect(body).toContain('releases/download/');
    expect(body).not.toContain('raw.githubusercontent.com');
    // And verified BEFORE the binary is allowed to run, which is the only
    // ordering that makes the checksum worth anything.
    expect(body.indexOf('sha256sum --check --strict'))
      .toBeLessThan(body.indexOf('elan-init'));
  });


  test('the Lean workflow triggers unfiltered and runs the local setup action', () => {
    const workflow = v.parse(
      v.object({
        on: v.object({
          push: v.nullable(v.object({ paths: v.optional(v.array(v.string())) })),
          pull_request: v.nullable(v.object({ paths: v.optional(v.array(v.string())) })),
        }),
        jobs: v.object({ verify: v.object({ steps: v.array(StepSchema) }) }),
      }),
      Bun.YAML.parse(readRepositoryFile(REPO_ROOT, LEAN_VERIFY)),
    );

    // NO paths filter, and its absence is the contract: the citation gate's
    // corpus is every tracked text file, so any filter is narrower than what
    // the gates read — the workflow's own header records the measured gap the
    // old filter opened. A reintroduced filter fails here by name.
    expect(workflow.on.push?.paths, `${LEAN_VERIFY} push regained a paths filter`).toBeUndefined();
    expect(
      workflow.on.pull_request?.paths,
      `${LEAN_VERIFY} pull_request regained a paths filter`,
    ).toBeUndefined();
    expect(
      workflow.jobs.verify.steps.map((step) => step.uses),
      `${LEAN_VERIFY} no longer runs the local setup action`,
    ).toContain('./.github/actions/setup-lean');
  });

  test('no action is used from a moving ref', () => {
    const commit = /^[0-9a-f]{40}$/u;
    const release = /^v\d+(?:\.\d+)*$/u;
    // GitHub's own org and Bun's publisher may be used at a release tag: this
    // repository already executes both (`actions/*` is GitHub's, and a Bun
    // release is the runtime every gate runs on). Everybody else is a commit,
    // because a tag is somebody else's mutable pointer at code that runs here.
    const TAG_ALLOWED = ['actions', 'oven-sh'];
    let pinned = 0;

    for (const { file, job, step } of steps()) {
      if (step.uses === undefined) continue;
      const uses = step.uses;

      if (uses.startsWith('./')) continue;
      const at = uses.lastIndexOf('@');
      const name = at === -1 ? uses : uses.slice(0, at);
      const ref = at === -1 ? '' : uses.slice(at + 1);
      const owner = name.slice(0, name.indexOf('/'));
      pinned += 1;

      if (TAG_ALLOWED.includes(owner)) {
        expect(
          commit.test(ref) || release.test(ref),
          `${file}#${job} uses ${uses}, which is neither a release tag nor a commit`,
        ).toBe(true);
        continue;
      }

      expect(commit.test(ref), `${file}#${job} uses ${uses} from outside a pinned commit`)
        .toBe(true);
    }

    expect(pinned, 'no workflow uses an action').toBeGreaterThan(0);
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
 * which answers whether a session is live. A database or a singleton auth object in front of every sign-in
 * would make one binding the login path of every user at once.
 */
describe('sign-in has no single chokepoint', () => {
  test('auth state is the AUTH_KV namespace and the user objects, and nothing fronts them', () => {
    const objects = CONFIG.durable_objects.bindings.flatMap((binding) => [binding.name, binding.class_name]);

    expect(CONFIG.kv_namespaces.map((namespace) => namespace.binding)).toContain('AUTH_KV');
    expect(CONFIG.d1_databases ?? []).toEqual([]);
    expect(objects.filter((name) => /auth/iu.test(name))).toEqual([]);
  });
});

/**
 * A7 THE SANDBOX HAS ONE TRANSPORT. The Sandbox SDK keeps the transport a sandbox was first reached over and
 * drops the in-flight requests of a client that names another. Product code opens every client through
 * `openSandbox`, which passes `SANDBOX_TRANSPORT`; the SDK's own lookup passes none (`proxyToSandbox`,
 * SDK 0.12.9), and the sandbox object then takes this var, whose absence means `http`.
 */
describe('the sandbox has one transport', () => {
  test('the deployed default is the transport every client names', () => {
    expect(CONFIG.vars.SANDBOX_TRANSPORT).toBe(SANDBOX_TRANSPORT);
  });
});

/**
 * A8 THE BLOCK-LOWER IMAGE IS BUILT FROM THIS TREE. The pushed image is the only thing any host runs, so a
 * source edited without a rebuild and a new record ships a container that is not the code reviewed here, and
 * a host left on an older digest runs a filesystem the others do not.
 */
describe('the block-lower image is built from this tree', () => {
  test('the record hashes exactly the sources the image builds from, and each hash holds', () => {
    const sources = trackedFiles()
      .filter((file) => file.startsWith(`${BLOCK_LOWER}/`))
      .map((file) => file.slice(BLOCK_LOWER.length + 1))
      .filter((file) => ['Cargo.toml', 'Cargo.lock', 'Dockerfile'].includes(file) || /^src\/[^/]+\.rs$/u.test(file));

    expect(Object.keys(ARTIFACT.files).sort()).toEqual(sources.sort());

    for (const [file, recorded] of Object.entries(ARTIFACT.files)) {
      const built = createHash('sha256').update(readFileSync(join(REPO_ROOT, BLOCK_LOWER, file))).digest('hex');
      expect(built, `${file} changed since the image was built`).toBe(recorded);
    }
  });

  test('every container host runs the recorded image, by digest', () => {
    expect(ARTIFACT.image.endsWith(`@${ARTIFACT.digest}`)).toBe(true);

    for (const host of CONTAINER_HOSTS) {
      const config = parseJsonc(readRepositoryFile(REPO_ROOT, host), ContainerHostSchema, host);
      // The Codex forwarder beside it is held by the pin test above.
      const sandboxes = config.containers.filter((container) => container.class_name !== 'CodexEgress');

      expect(sandboxes.map((container) => container.image), host).toEqual(sandboxes.map(() => PINNED_IMAGE));
    }
  });
});
