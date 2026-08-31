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
 * A3 NO CREDENTIAL-BEARING JOB RUNS UNREVIEWED CODE. `eval.yml`'s benchmark job
 *   can be started by labelling a pull request, and a `pull_request` checkout is
 *   that pull request's code. It therefore installed the branch's lockfile and ran
 *   the branch's `scripts/eval.ts` with the eval-service token and two vendor keys
 *   in the environment. A job holding a secret must check out a revision somebody
 *   reviewed, and must be bound to a GitHub environment so the secret is not
 *   readable by every other workflow in the repository.
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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';

import { parseJsonc } from './jsonc';
import { readRepositoryFile, trackedFiles } from './sources';
// The config module itself, not its text: the failure being guarded is a hook
// that exists and decides the wrong thing, which no source-text assertion sees.
import viteConfig from '../packages/cf-backend/vite.config';

const REPO_ROOT = join(import.meta.dir, '..');
const WRANGLER = 'packages/cf-backend/wrangler.jsonc';
const PACKAGE = 'packages/cf-backend/package.json';
const VITE_CONFIG = 'packages/cf-backend/vite.config.ts';
const WORKFLOWS = '.github/workflows';
const SETUP_LEAN = '.github/actions/setup-lean/action.yml';
const LEAN_VERIFY = '.github/workflows/lean-verify.yml';

/**
 * The sandbox container image every environment runs, declared ONCE.
 *
 * `version` is the `@cloudflare/sandbox` release whose container the SDK expects,
 * held below against the dependency that actually ships. `digest` is what the
 * registry answered for that version's tag on 2026-08-27:
 *
 *   curl -sI -H "Authorization: Bearer <docker.io pull token>" \
 *     -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
 *     https://registry-1.docker.io/v2/cloudflare/sandbox/manifests/0.12.8
 *   docker-content-digest: sha256:822501de…
 *
 * wrangler.jsonc repeats the reference once per environment because a JSONC file
 * cannot import a constant. This is the declaration those two are held to, so a
 * version bump edits this record and both config blocks and nothing else. The
 * same command re-resolves the digest for a new version.
 */
const SANDBOX_IMAGE = {
  repository: 'docker.io/cloudflare/sandbox',
  version: '0.12.8',
  digest: 'sha256:822501de5f0c52a012c125c4e5e4c0080421a8e93ca4ce0ba3d247148021989f',
} as const;

const PINNED_IMAGE = `${SANDBOX_IMAGE.repository}@${SANDBOX_IMAGE.digest}`;

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

/** Only the keys this file reads. A narrow schema rather than the manifest's
 *  full one: a shape that admitted more would start answering other questions,
 *  and a key present but wrongly shaped fails the parse instead of reading as
 *  absent — a config this cannot read is not a config it may pass. */
const DeploymentSchema = v.object({
  upload_source_maps: v.optional(v.boolean()),
  containers: v.optional(v.array(v.object({
    class_name: v.string(),
    image: v.string(),
  }))),
});

const WranglerSchema = v.object({
  ...DeploymentSchema.entries,
  env: v.optional(v.record(v.string(), DeploymentSchema)),
});

type Deployment = readonly [name: string, block: v.InferOutput<typeof DeploymentSchema>];

/**
 * Every environment a deploy can publish, production first.
 *
 * Derived from the file rather than listed here, so an environment added
 * tomorrow is covered the day it is added. That is the failure shape this whole
 * file guards: a second deployment nobody re-checked.
 */
function deployments(): readonly Deployment[] {
  const config = parseJsonc(
    readFileSync(join(REPO_ROOT, WRANGLER), 'utf8'), WranglerSchema, WRANGLER,
  );
  return [['production', config], ...Object.entries(config.env ?? {})];
}

const DEPLOYMENTS = deployments();
const EACH = DEPLOYMENTS.map((deployment) => [deployment[0], deployment[1]] as const);

describe('the sandbox container image is pinned', () => {
  test('production and staging are both measured', () => {
    // Named rather than counted: every assertion below iterates, so an
    // environment silently dropped from the config would pass them vacuously.
    expect(DEPLOYMENTS.map(([name]) => name)).toEqual(['production', 'staging']);
  });

  test.each(EACH)('%s runs the pinned digest and names no tag', (name, block) => {
    const images = (block.containers ?? []).map((container) => container.image);

    expect(images.length, `${name} declares no container`).toBeGreaterThan(0);
    for (const image of images) {
      expect(isImmutableImageReference(image), `${name} runs a re-pointable image`).toBe(true);
      expect(image, `${name} runs an image the release record does not declare`).toBe(PINNED_IMAGE);
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
  test.each(EACH)('%s uploads its source maps', (name, block) => {
    expect(block.upload_source_maps, `${name} would report minified stacks`).toBe(true);
  });

  // The decision, called — not the text that expresses it. A source-text
  // assertion here would pass over a hook that returns the wrong thing, and the
  // whole failure being guarded is a flag whose other half is missing.
  test('the vite build emits worker source maps and leaves the client without', () => {
    const plugins = (viteConfig.plugins ?? []).flatMap((plugin) => {
      const parsed = v.safeParse(EnvironmentScopedPluginSchema, plugin);
      return parsed.success ? [parsed.output] : [];
    });

    expect(plugins.length, `${VITE_CONFIG} declares no environment-scoped plugin`).toBe(1);
    const [sourceMaps] = plugins;

    // The worker environment is named after the worker (`kinu`, and
    // `kinu_staging` under CLOUDFLARE_ENV=staging), so the hook must decide by
    // what an environment is NOT rather than by naming them.
    expect(sourceMaps?.configEnvironment('kinu')).toEqual({ build: { sourcemap: true } });
    expect(sourceMaps?.configEnvironment('kinu_staging')).toEqual({ build: { sourcemap: true } });
    // A map in `dist/client` is original TypeScript published on the public
    // origin, so the client is the one environment that must not get one.
    expect(sourceMaps?.configEnvironment('client')).toBeNull();
  });
});

/* ── The workflows that publish and measure this product ────────────────── */

/** Only what these assertions read. `v.unknown()` where the shape is a union
 *  GitHub allows three spellings of: the questions below are answered from the
 *  job's text or from one key, never from a shape this file has to model. */
// `looseObject`, not `object`: the secret search below reads the job's own JSON,
// and a schema that stripped every key it does not name would strip the `env`
// block the credential arrives in.
const StepSchema = v.looseObject({
  uses: v.optional(v.string()),
  run: v.optional(v.string()),
  // `ref` is named because one assertion reads it; `looseObject` keeps the rest
  // of `with` for the secret search.
  with: v.optional(v.looseObject({ ref: v.optional(v.string()) })),
});

const JobSchema = v.looseObject({
  environment: v.optional(v.unknown()),
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
  jobs: v.record(v.string(), JobSchema),
});

interface Workflow {
  readonly file: string;
  readonly parsed: v.InferOutput<typeof WorkflowSchema>;
  readonly text: string;
}

/** Every workflow, from the one repository enumerator. A workflow added tomorrow
 *  is covered the day it is added. */
function workflows(): readonly Workflow[] {
  return trackedFiles()
    .filter((file) => dirname(file) === WORKFLOWS)
    .map((file) => {
      const text = readRepositoryFile(REPO_ROOT, file);
      return { file, text, parsed: v.parse(WorkflowSchema, Bun.YAML.parse(text)) };
    });
}

const WORKFLOW_FILES = workflows();

/** Every step in every job, flattened, with where it came from. */
function steps(): readonly { file: string; job: string; step: v.InferOutput<typeof StepSchema> }[] {
  return WORKFLOW_FILES.flatMap(({ file, parsed }) =>
    Object.entries(parsed.jobs).flatMap(([job, definition]) =>
      (definition.steps ?? []).map((step) => ({ file, job, step }))));
}

/** Jobs whose steps name a secret. Read off the job's own text rather than
 *  modelled: a secret reaches a step through `env`, `with`, a `run` body or an
 *  input default, and a schema that covered four places would miss the fifth. */
function secretBearingJobs(): readonly { label: string; job: v.InferOutput<typeof JobSchema>; triggers: readonly string[] }[] {
  return WORKFLOW_FILES.flatMap(({ file, parsed }) =>
    Object.entries(parsed.jobs)
      .filter(([, job]) => JSON.stringify(job).includes('secrets.'))
      .map(([name, job]) => ({
        label: `${file}#${name}`,
        job,
        triggers: parsed.on,
      })));
}

const SECRET_JOBS = secretBearingJobs();


describe('the workflows that publish and measure this product', () => {
  test('every workflow is read, and the credential-bearing jobs are named', () => {
    expect(WORKFLOW_FILES.length, 'the workflow corpus collapsed').toBeGreaterThan(4);
    // Named, not counted. These two hold every credential in the repository, and
    // the assertions below are only worth anything if they are still the two.
    expect(SECRET_JOBS.map((entry) => entry.label).sort()).toEqual([
      '.github/workflows/deploy-staging.yml#deploy',
      '.github/workflows/eval.yml#benchmark',
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
    for (const { label, job } of SECRET_JOBS) {
      // Repository secrets are readable by every workflow in the repository,
      // including one added by a branch. An environment is the only boundary
      // GitHub offers that a file in the repository can ask for.
      expect(job.environment, `${label} reads a repository-wide secret`).toBeDefined();
    }
  });

  test('a job that holds a secret checks out no pull-request code', () => {
    let checked = 0;
    for (const { label, job, triggers } of SECRET_JOBS) {
      if (!triggers.includes('pull_request') && !triggers.includes('pull_request_target')) continue;
      for (const step of job.steps ?? []) {
        if (step.uses === undefined || !step.uses.includes('actions/checkout')) continue;
        const ref = step.with?.ref;
        // The default ref for a `pull_request` event is the pull request merged
        // into the base, so an absent `ref` IS the defect.
        expect(ref, `${label} checks out the default (pull request) ref`).toBeDefined();
        expect(ref ?? '', `${label} checks out the pull request's own head`)
          .not.toContain('head');
        expect(ref ?? '', `${label} does not pin the reviewed base revision`)
          .toContain('base.sha');
        checked += 1;
      }
    }
    // Non-vacuity: a secret-bearing job really is reachable from a pull request,
    // which is the whole reason this assertion exists.
    expect(checked, 'no secret-bearing job is triggered by a pull request any more')
      .toBeGreaterThan(0);
  });

  test('no run body interpolates event data into a command', () => {
    // A `${{ github.event… }}` expression inside a `run:` body is substituted
    // before the shell sees it, so the VALUE becomes syntax. The eval workflow
    // spliced a dispatch input into its command line exactly this way. Inputs
    // travel through `env` and are read as `"$VAR"`.
    const INTERPOLATED = /\$\{\{\s*github\.event/u;
    // Positive control, as a literal: a matcher that stops matching is
    // indistinguishable from a clean tree.
    expect(INTERPOLATED.test('bun x.ts --model "${{ github.event.inputs.model }}"')).toBe(true);

    for (const { file, job, step } of steps()) {
      if (step.run === undefined) continue;
      expect(step.run, `${file}#${job} lets event data decide what runs`)
        .not.toMatch(INTERPOLATED);
    }
  });

  test('no workflow pipes a remote script into a shell', () => {
    let bodies = 0;
    for (const { file, job, step } of steps()) {
      if (step.run === undefined) continue;
      bodies += 1;
      expect(step.run, `${file}#${job} pipes a download into a shell`)
        .not.toMatch(/(?:curl|wget)[^\n]*\|\s*(?:ba)?sh\b/u);
    }
    expect(bodies, 'no workflow runs a shell body any more').toBeGreaterThan(0);
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
    expect(pinned, 'no workflow uses an action any more').toBeGreaterThan(0);
  });
});
