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
import { parseJsonc } from './jsonc';
import { CONTAINER_IMAGES } from './container-images';
import { allCommands, invocation, parseShell, type ShellScript } from './shell-words';
import { isWorkerConfig, readRepositoryFile, trackedFiles } from './sources';
import { type ContextPath, contextPaths } from './workflow-expressions';
// The config module itself, not its text: the failure being guarded is a hook
// that exists and decides the wrong thing, which no source-text assertion sees.
import viteConfigFor from '../packages/cf-backend/vite.config';

const REPO_ROOT = join(import.meta.dir, '..');

const WRANGLER = 'packages/cf-backend/wrangler.jsonc';

/** The package that imports the SDK and so decides which of its versions ships; Kinu reaches it through devbox. */
const PACKAGE = 'packages/devbox/package.json';

const VITE_CONFIG = 'packages/cf-backend/vite.config.ts';

const WORKFLOWS = '.github/workflows';

const SETUP_LEAN = '.github/actions/setup-lean/action.yml';

const LEAN_VERIFY = '.github/workflows/lean-verify.yml';

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
  containers: v.optional(v.array(ContainerSchema)),
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
  test('the Worker runs only the native devbox, which prepares no image', () => {
    const containers = CONFIG.containers ?? [];

    expect(containers.map((container) => container.class_name).sort(), 'the Worker declares other containers than the record')
      .toEqual(Object.keys(CONTAINER_IMAGES).sort());

    for (const container of containers) expect(imagesOf(container), container.class_name).toEqual([]);
  });

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

    expect(plugins.length, `${VITE_CONFIG} declares no worker source-map plugin`).toBe(1);
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
