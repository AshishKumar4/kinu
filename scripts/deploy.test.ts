import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { childEnv, runToExit, scratchDir, type Exited } from "@kinu.run/test-utils";
import { parseReleaseManifest } from "@kinu.run/core/deploy";
import { generateReleaseSigningKey } from "../packages/core/src/http/release-signing";
import {
  DEPLOY_PHASES, GATE_DEADLINE_SECONDS, LADDER, deployOrder, type DeployPhase,
} from "./ladder";
import { CONTROL_PLANE_ACCESS_PATHS, deriveInfrastructure } from "./infra-manifest";
import type { Deployment } from "./infra-cloudflare";
import type { Reset } from "./reset";
import { CONTROL_PLANE_API_ROUTE, CONTROL_PLANE_UI_ROUTE } from "../packages/cf-backend/src/control-plane/access-gate";
import { isDocument, readRepositoryFile, trackedFiles } from "./sources";
import * as v from "valibot";
import { inkBefore, runTuiInPty, type PtyRun } from "../packages/cli/tests/helpers/pty-screen";
import { BUILTIN_TUI_THEMES, createThemeRegistry, DEFAULT_TUI_THEME_SELECTION } from "../packages/cli/src/tui/theme";

const REPO_ROOT = resolve(import.meta.dir, "..");


/** The deploy's plan: which gate runs in which phase. deploy.sh runs a phase as one ladder call. */
const PLAN = deployOrder();

/** How deploy.sh runs one or more phases: the ladder runs their plan rows through one wave. */
function phaseRun(...phases: DeployPhase[]): string {
  return `bun scripts/ladder.ts --deploy-phase=${phases.join(",")}`;
}

/** The phases that stop a deploy on a red, in the order it runs them, as the fixture's event log spells them. Nothing
 *  is built or uploaded past a red one. */
const STOPS: readonly string[] = [phaseRun("preflight"), phaseRun("upload")];

/** How deploy.sh names, not runs, the rows that read a deployment which does not serve this build. */
function skipped(why: string): string {
  return `${phaseRun("post-publish")} --skip=${why}`;
}

/** The deploy's build, on armada (scripts/release-build.ts): the fixture's fails on purpose. */
function armadaBuild(environment: string, ...options: string[]): string {
  return ["bun scripts/release-build.ts", environment, "testsha", ...options].join(" ");
}

/** What a staging deploy runs after the fixture's build, which fails on purpose: the rows that read the deployment
 *  named as not run, then every local gate and the hammer, to their end. */
const AFTER_A_FAILED_BUILD: readonly string[] = [
  skipped("staging does not serve this build: the build on armada failed"), phaseRun("source"),
];

/** The commands one phase of the plan runs. */
function phaseGates(phase: string): string[] {
  return PLAN.filter((row) => (row.phase ?? "source") === phase).map((row) => row.run);
}

/** A staging deploy's own step before its build: HEAD's record on staging withdrawn (scripts/promote.ts). */
const WITHDRAW = "bun scripts/promote.ts forget";

function executable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

/** A CLI launched to prove an install works must read no state but the install's.
 *  Left on the ambient environment it opens the developer's own ~/.kinu — live
 *  config and SQLite that another process may be writing — so a launch failure
 *  could mean anything, which is the one thing a smoke test must not mean. */
function freshHome(directory: string) {
  const home = join(directory, "home");
  mkdirSync(home, { recursive: true });

  return childEnv({ HOME: home, KINU_HOME: join(home, ".kinu") });
}

/** Why a launch failed, in the assertion message. A bare exit code hides a
 *  signal kill behind an empty stderr, and this suite installs two ~2 GB trees
 *  into tmpfs: a red that says nothing cannot be told from a red that means
 *  the distribution no longer resolves. */
function launchFailure(result: Exited): string {
  return [
    `exit=${String(result.exitCode)} signal=${String(result.signalCode)}`,
    result.stderr.trim(),
    result.stdout.trim(),
  ].filter((part) => part.length > 0).join("\n");
}

function commandStub(name: string): string {
  // A command is recorded as deploy.sh writes it, relative to the repository: deploy.sh names its own
  // steps by their path under KINU_ROOT. A phase is one event: the ladder runs its gates.
  return `#!/usr/bin/bash
command_line="${name} $*"
command_line="\${command_line//$KINU_DEPLOY_ROOT\\//}"
printf '%s\\n' "$command_line" >> "$KINU_DEPLOY_GATE_LOG"
if [[ "$*" == *--ci-verdict=* ]] && [ "$KINU_CI_ABSENT" = "1" ]; then
  echo 'CI refused: armada has no verdict for testsha'
  exit 1
fi
if [[ "$*" == *--ci-verdict=* ]] && [ "$KINU_CI_RED" = "1" ]; then
  echo 'CI RED bun run test:core'
  exit 1
fi
# The deploy's report directory, as scripts/deploy-report.ts opens and names it.
if [ "\${1##*/}" = "deploy-report.ts" ] && [ "$2" = "open" ]; then
  printf '%s\\n' "$KINU_DEPLOY_ROOT/report"
fi
# WHAT THE INFRASTRUCTURE PHASE ACTUALLY SAW. The account gate reads its phase
# and account from the environment deploy.sh hands the ladder, so the only way to
# assert which a deploy ran is to record them where the ladder would start it.
if [ "$1" = "scripts/ladder.ts" ] && [ "$2" = "--deploy-phase=upload" ]; then
  printf '%s\\n' "\${KINU_INFRA_PHASE:-unset}" > "$KINU_DEPLOY_PHASE_LOG"
  printf '%s\\n' "\${KINU_INFRA_ENVIRONMENT:-unset}" > "$KINU_DEPLOY_INFRA_ENV_LOG"
  printf '%s\\n' "\${KINU_RESET_RECORD-unset}" > "$KINU_DEPLOY_RECORD_LOG"
  if [ -n "$KINU_DEPLOY_INFRA_PRELOAD" ]; then
    "${process.execPath}" --preload "$KINU_DEPLOY_INFRA_PRELOAD" "${join(REPO_ROOT, 'scripts/infra-verify.ts')}"
    status=$?
    printf '%s\\n' "$status" >> "$KINU_DEPLOY_INFRA_STATUS_LOG"
    exit "$status"
  fi
fi
if [ "$1" = "scripts/infra-verify.ts" ] && [ -n "$KINU_DEPLOY_INFRA_PRELOAD" ]; then
  "${process.execPath}" --preload "$KINU_DEPLOY_INFRA_PRELOAD" "${join(REPO_ROOT, 'scripts/infra-verify.ts')}" "$2"
  status=$?
  printf '%s\\n' "$status" >> "$KINU_DEPLOY_INFRA_STATUS_LOG"
  exit "$status"
fi
if [ "$1" = "-e" ] && [ "$KINU_DEPLOY_UPLOAD_FIXTURE" = "1" ]; then
  exec "${process.execPath}" "$@"
fi
if [ "$KINU_DEPLOY_KILL" = "$command_line" ]; then
  # SIGKILL this stub, the phase's runner: it then ends having published
  # nothing about itself, which is the OOM-kill shape, and deploy.sh has to
  # settle it from the child's fate alone.
  kill -9 "$$"
fi
if [ "$KINU_DEPLOY_FAIL" = "$command_line" ]; then
  exit 47
fi
if [[ "$1" == */scripts/release-build.ts ]]; then
  [ "$KINU_DEPLOY_UPLOAD_FIXTURE" = "1" ] && exit 0
  exit 86
fi
if [[ "$1" == */scripts/reset.ts ]] && [ "$2" = "pending" ]; then
  printf '%s\\n' "\${KINU_DEPLOY_PENDING_RESET:-none}"
  # The newest reset of the Worker, pending or finished, into the file the deploy names.
  if [ -n "$4" ]; then cp "$KINU_DEPLOY_NEWEST_RESET" "$4"; fi
fi
exit 0
`;
}

/** One deploy run against stub commands.
 *
 *  `failingGate` names a command (a phase, or a step deploy.sh takes itself) that exits 47; `killGate` SIGKILLs one,
 *  so it settles with no verdict of its own. `option` is the script's second word, and `ambientPhase` is a
 *  KINU_INFRA_PHASE already on the environment — the one thing that must never decide how strictly a deploy is
 *  checked. */
interface DeployRun {
  readonly failingGate?: string;
  readonly killGate?: string;
  readonly dirty?: boolean;
  readonly environment?: string;
  readonly option?: string;
  /** Further options after `option`, for the combinations the script accepts. */
  readonly options?: readonly string[];
  readonly ambientPhase?: string;
  /** A KINU_INFRA_ENVIRONMENT already on the environment, which must never decide
   *  which account's resources the gate checks. */
  readonly ambientEnvironment?: string;
  /** The scripted model Worker's bearer; empty is the deploy that has none. */
  readonly scriptedKey?: string;
  /** Another deploy of the environment holds its lock for the whole run. */
  readonly lockHeld?: boolean;
  readonly ciAbsent?: boolean;
  readonly ciRed?: boolean;
  /** The reset the environment is still in: its placeholder serves and its build never uploaded. */
  readonly pendingReset?: string;
  /** A KINU_RESET_RECORD already on the environment, which must never soften a deploy nobody asked to reset. */
  readonly ambientRecord?: string;
  readonly account?: DeployAccount;
  readonly uploadRuns?: readonly UploadRun[];
}

interface UploadRun {
  readonly says: string;
  readonly status: number;
}

/** The Cloudflare observations at the CLI boundary, without touching an account. */
interface DeployAccount {
  readonly live: Deployment;
  readonly reset: Reset;
  readonly missingContainers: readonly string[];
  readonly missingBuckets?: readonly string[];
}

function resetAccount(placeholder = false): DeployAccount {
  const staging = deriveInfrastructure('staging');

  const classes = staging.resources.filter((resource) => resource.kind === 'durable-object')
    .map((resource) => ({ className: resource.name.slice(staging.worker.workerName.length + 1), namespace: `namespace-${resource.binding ?? ''}` }));

  const reset: Reset = {
    environment: 'staging', worker: staging.worker.workerName, tag: 'reset-20261009T164913Z', at: '2026-10-09T16:49:13.363Z',
    placeholderVersion: '9c840710', state: 'done', classes,
    applications: [{ name: 'kinu-kinudevbox-staging', id: 'a'.repeat(32) }],
  };

  const bindings = staging.worker.bindings.map((name) => {
    const durable = classes.find((entry) => entry.namespace === `namespace-${name}`);

    return durable === undefined ? { name, type: 'fixture', target: undefined, namespace: undefined }
      : { name, type: 'durable_object_namespace', target: durable.className, namespace: durable.namespace };
  });

  return {
    reset, missingContainers: reset.applications.map((application) => application.name),
    live: { state: 'deployed', versionId: placeholder ? reset.placeholderVersion : '174af18c',
      bindings: placeholder ? [{ name: 'CF_VERSION_METADATA', type: 'version_metadata', target: undefined, namespace: undefined }] : bindings },
  };
}

async function runDeploy({
  failingGate = "",
  killGate = "",
  dirty = false,
  option,
  options = [],
  ambientPhase = "",
  ambientEnvironment = "",
  scriptedKey = "fixture-scripted-key",
  lockHeld = false,
  ciAbsent = false,
  ciRed = false,
  pendingReset = "none",
  ambientRecord = "",
  account,
  uploadRuns,
}: DeployRun = {}) {
  const fixture = scratchDir("deploy-gate");
  // The deploy lock lives in the runtime directory: the fixture's own, so a real deploy on this machine never blocks
  // a run here, nor one here a real deploy. Another deploy holding it is `flock` holding it around this one's whole run.
  const held = lockHeld ? ["flock", join(fixture, `kinu-deploy-${option === "--promote" ? "production" : "staging"}.lock`)] : [];
  const log = join(fixture, "events.log");
  const phaseLog = join(fixture, "infra-phase.log");
  const infraEnvironmentLog = join(fixture, "infra-environment.log");
  const recordLog = join(fixture, "infra-record.log");
  const infraStatusLog = join(fixture, "infra-status.log");
  const newestReset = join(fixture, "newest-reset.json");
  const uploadArgv = join(fixture, "upload-argv.log");
  const preload = join(fixture, "account.ts");

  writeFileSync(newestReset, JSON.stringify(account?.reset ?? {
    environment: 'staging', worker: 'kinu-staging', tag: pendingReset === 'none' ? 'reset-20261009T164913Z' : pendingReset,
    at: '2026-10-09T16:49:13.363Z', placeholderVersion: '9c840710', classes: [], applications: [], state: 'done',
  }));

  if (account !== undefined) {
    const cloudflare = join(REPO_ROOT, 'scripts/infra-cloudflare.ts');

    writeFileSync(preload, `
import { mock } from 'bun:test';
import * as cloudflare from ${JSON.stringify(cloudflare)};
import { SUPPLY } from ${JSON.stringify(join(REPO_ROOT, 'scripts/infra-manifest.ts'))};
const live: cloudflare.Deployment = ${JSON.stringify(account.live)};
const present = (): cloudflare.Observation => ({ state: 'present', detail: 'fixture account' });
mock.module(${JSON.stringify(cloudflare)}, () => ({
  ...cloudflare, authenticated: present, deployment: () => live,
  container: (name: string) => ${JSON.stringify(account.missingContainers)}.includes(name) ? { state: 'absent' } : present(),
  r2: (name: string) => ${JSON.stringify(account.missingBuckets ?? [])}.includes(name) ? { state: 'absent' } : present(),
  kvNamespace: present, vectorize: present, containerNamespace: present,
  servesWorker: present, edgeResponds: present, wildcardDns: present, hostResolves: present,
  emailRoutingToWorker: present, accessOrganization: present, accessApplication: present,
  accessPolicies: present, accessScope: present,
  secretNames: () => ({ ...present(), names: [...SUPPLY.keys()] }),
}));
`);
  }

  mkdirSync(join(fixture, "scripts"));
  mkdirSync(join(fixture, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(fixture, "packages", "cf-backend"), { recursive: true });

  executable(
    join(fixture, "scripts", "deploy.sh"),
    readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8"),
  );
  writeFileSync(join(fixture, "scripts", "repo-runtime.sh"), readFileSync(join(REPO_ROOT, "scripts", "repo-runtime.sh")));
  writeFileSync(join(fixture, 'scripts', 'deploy-smoke.sh'), readFileSync(join(REPO_ROOT, 'scripts', 'deploy-smoke.sh')));

  const uploadHelper = join(REPO_ROOT, 'scripts', 'deploy-upload.sh');

  if (existsSync(uploadHelper)) writeFileSync(join(fixture, 'scripts', 'deploy-upload.sh'), readFileSync(uploadHelper));

  if (uploadRuns !== undefined) {
    const build = join(fixture, 'packages', 'cf-backend', 'dist');
    const downloads = join(build, 'client', 'downloads');

    mkdirSync(join(build, 'kinu'), { recursive: true });
    mkdirSync(downloads, { recursive: true });
    mkdirSync(join(build, 'worker-release'));
    mkdirSync(join(fixture, 'packages', 'cli'));
    writeFileSync(join(fixture, 'packages', 'cli', 'package.json'), '{"version":"1.0.0"}');
    writeFileSync(join(build, 'kinu', 'wrangler.json'), JSON.stringify({
      targetEnvironment: 'staging', name: 'kinu-staging', vars: { CLI_PUBLIC_ORIGIN: 'https://fixture.invalid' },
      r2_buckets: [{ binding: 'RELEASES_BUCKET', bucket_name: 'fixture-releases' }, { binding: 'BACKUP_BUCKET', bucket_name: 'fixture-backups' }],
    }));

    for (const file of ['kinu-version.json', 'release.json', 'kinu-worker-1.0.0+testsha.tar.gz.sha256',
      ...['runtime-cpython', 'cli-darwin-arm64', 'cli-darwin-x64', 'cli-linux-arm64', 'cli-linux-x64']
        .flatMap((platform) => [`kinu-${platform}.tar.gz`, `kinu-${platform}.tar.gz.sha256`])]) {
      writeFileSync(join(downloads, file), 'fixture');
    }

    writeFileSync(join(build, 'worker-release', 'kinu-worker-1.0.0+testsha.tar.gz'), 'fixture');

    for (const [index, result] of uploadRuns.entries()) {
      writeFileSync(join(fixture, `upload.${String(index + 1)}.out`), result.says === 'success'
        ? `KinuDevbox\nRead 1 files from the assets directory ${join(build, 'client')}\nVersion ID: 9b1f\n` : result.says);
      writeFileSync(join(fixture, `upload.${String(index + 1)}.status`), String(result.status));
    }
  }

  executable(join(fixture, "node_modules", ".bin", "bun"), commandStub("bun"));
  executable(join(fixture, "bash"), commandStub("bash"));
  executable(join(fixture, "git"), `#!/usr/bin/bash
if [ "$3" = "rev-parse" ]; then
  printf 'testsha\\n'
elif [ "$3" = "status" ] && [ "$KINU_DEPLOY_DIRTY" = "1" ]; then
  printf ' M source.ts\\n'
fi
exit 0
`);
  executable(join(fixture, "node_modules", ".bin", "bunx"), `#!/usr/bin/bash
printf 'MUTATE bunx %s\\n' "$*" >> "$KINU_DEPLOY_GATE_LOG"
exit 86
`);
  executable(join(fixture, "npx"), `#!/usr/bin/bash
if [ "$*" = "wrangler whoami" ]; then
  exit 0
fi
printf 'MUTATE npx %s\\n' "$*" >> "$KINU_DEPLOY_GATE_LOG"
if [ "$KINU_DEPLOY_UPLOAD_FIXTURE" = "1" ]; then
  if [ "$2" = "r2" ]; then exit 0; fi
  if [ "$2" = "deploy" ]; then
    printf '%s\\0' "$@" >> "$KINU_DEPLOY_UPLOAD_ARGV"
    printf '\\n' >> "$KINU_DEPLOY_UPLOAD_ARGV"
    run=$(wc -l < "$KINU_DEPLOY_UPLOAD_ARGV")
    cat "$KINU_DEPLOY_ROOT/upload.$run.out"
    exit "$(cat "$KINU_DEPLOY_ROOT/upload.$run.status")"
  fi
fi
exit 87
`);
  executable(join(fixture, 'curl'), '#!/usr/bin/bash\nexit 7\n');
  executable(join(fixture, 'node'), `#!/usr/bin/bash\nexec "${process.execPath}" "$@"\n`);

  const argv = [...held, "/usr/bin/bash", "scripts/deploy.sh"];

  if (option !== undefined) argv.push(option);
  argv.push(...options);

  const run = await runToExit(argv, {
    cwd: fixture,
    env: childEnv({
      PATH: `${fixture}:/usr/bin:/bin`,
      KINU_DEPLOY_FAIL: failingGate,
      KINU_DEPLOY_KILL: killGate,
      TMPDIR: fixture,
      KINU_DEPLOY_GATE_LOG: log,
      KINU_DEPLOY_ROOT: fixture,
      KINU_DEPLOY_PHASE_LOG: phaseLog,
      KINU_DEPLOY_PENDING_RESET: pendingReset,
      KINU_DEPLOY_INFRA_ENV_LOG: infraEnvironmentLog,
      KINU_DEPLOY_RECORD_LOG: recordLog,
      KINU_DEPLOY_NEWEST_RESET: newestReset,
      KINU_DEPLOY_INFRA_PRELOAD: account === undefined ? '' : preload,
      KINU_DEPLOY_INFRA_STATUS_LOG: infraStatusLog,
      KINU_DEPLOY_UPLOAD_FIXTURE: uploadRuns === undefined ? '0' : '1',
      KINU_DEPLOY_UPLOAD_ARGV: uploadArgv,
      // Always set, so the assertion that the script overrides it is about the
      // script rather than about whichever shell ran the suite.
      KINU_INFRA_PHASE: ambientPhase,
      KINU_INFRA_ENVIRONMENT: ambientEnvironment,
      KINU_RESET_RECORD: ambientRecord,
      KINU_DEPLOY_DIRTY: dirty ? "1" : "0",
      KINU_SCRIPTED_MODEL_KEY: scriptedKey,
      SKIP_E2E: "1",
      KINU_CI_ABSENT: ciAbsent ? '1' : '0',
      KINU_CI_RED: ciRed ? '1' : '0',
      XDG_RUNTIME_DIR: fixture,
    }),
  });


  const logged = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    : [];

  // The report's own calls apart from the steps: what the deploy wrote into its report, each without the report's
  // directory, and a mark without the seconds it was reached at.
  const REPORT = "bun scripts/deploy-report.ts ";

  const events = logged.filter((event) => !event.startsWith(REPORT) && !event.startsWith('bun scripts/ladder.ts --ci-'));

  const report = logged.filter((event) => event.startsWith(REPORT))
    .map((event) => event.slice(REPORT.length).replace(/^(\w+) report( |$)/u, "$1$2").replace(/^mark (\S+) \d+$/u, "mark $1"));

  const infraPhase = existsSync(phaseLog) ? readFileSync(phaseLog, "utf8").trim() : null;

  const infraEnvironment = existsSync(infraEnvironmentLog) ? readFileSync(infraEnvironmentLog, "utf8").trim() : null;

  return {
    status: run.exitCode,
    events,
    report,
    ci: logged.filter((event) => event.startsWith('bun scripts/ladder.ts --ci-')),
    stdout: run.stdout.toString(),
    infraPhase,
    infraEnvironment,
    infraRecord: existsSync(recordLog) ? readFileSync(recordLog, "utf8").trim() : null,
    infraStatuses: existsSync(infraStatusLog) ? readFileSync(infraStatusLog, 'utf8').trim().split('\n').map(Number) : [],
    uploads: existsSync(uploadArgv) ? readFileSync(uploadArgv, 'utf8').trimEnd().split('\n').map((line) => line.split('\0').slice(0, -1)) : [],
  };
}

describe("deploy gate", () => {
  // CI's verdict is armada's, stored for this exact revision when its push was proved (L25), and a deploy takes it
  // before it runs anything else: a missing or red one builds, uploads and records nothing.
  test.each([
    ['no armada verdict', { ciAbsent: true }, 'armada has no verdict'],
    ['a red armada verdict', { ciRed: true }, 'CI RED bun run test:core'],
  ])('%s for the clean SHA refuses before any upload gate, build or record', async (_, options, said) => {
    const run = await runDeploy(options);

    expect({ status: run.status, events: run.events, ci: run.ci, said: run.stdout.includes(said), refused: run.stdout.includes('armada has no green verdict for testsha') })
      .toEqual({ status: 1, events: [phaseRun('preflight')], ci: ['bun scripts/ladder.ts --ci-verdict=testsha'], said: true, refused: true });
  });

  test('a green armada verdict is read once, before the upload gates', async () => {
    const run = await runDeploy({ option: '--gates-only' });

    expect({ events: run.events, ci: run.ci, marks: run.report.filter((entry) => entry.startsWith('mark ')).slice(0, 3) })
      .toEqual({ events: [...STOPS, phaseRun('source')], ci: ['bun scripts/ladder.ts --ci-verdict=testsha'], marks: ['mark preflight', 'mark ci', 'mark upload'] });
  });
  // AT THE DEPLOY BOUNDARY. deploy.sh runs each phase as one ladder call, which
  // runs that phase's gates through the ladder's wave (scripts/ladder.ts,
  // `tierWave`, whose admission ladder.test.ts holds). What is asserted here is
  // what deploy.sh itself decides: the phases, in order, each a barrier, the
  // options it hands them, that only the preflight and the upload gates stop
  // it, and what it writes into its report (L18).
  //
  // Review job 150, P1: a staging re-deploy of a verified commit replaces what staging serves for it, so it withdraws
  // that commit's record first, after its gates and before anything it builds can be published.
  test("runs the upload gates, withdraws HEAD's record, builds for staging, and runs every local gate after a failed build", async () => {
    const run = await runDeploy();

    expect(run.status).toBe(1);
    expect(run.events).toEqual([...STOPS, WITHDRAW, armadaBuild("staging"), ...AFTER_A_FAILED_BUILD]);
    expect(run.infraEnvironment).toBe("staging");
  });

  test("a record that cannot be withdrawn builds nothing, and every local gate still runs", async () => {
    const run = await runDeploy({ failingGate: WITHDRAW });

    expect(run.status).toBe(1);
    expect(run.events.some((event) => event.startsWith("MUTATE ") || event.startsWith("bun scripts/release-build.ts"))).toBe(false);
    expect(run.events).toEqual([
      ...STOPS, WITHDRAW,
      skipped("staging does not serve this build: testsha's record on staging could not be withdrawn, so this deploy will not replace what it verified"),
      phaseRun("source"),
    ]);
  });

  // ── Promotion ──────────────────────────────────────────────────
  //
  // Production takes only the build staging verified: the record staging's
  // deploy of HEAD wrote stands for the source gates, so a promotion runs none
  // of them, and a HEAD staging never verified builds nothing at all.
  const PROMOTION_CHECK = "bun scripts/promote.ts check";

  test("a promotion runs no source gate: staging's record, the upload gates on production, a production build", async () => {
    const run = await runDeploy({ option: "--promote" });

    expect(run.status).toBe(1);
    expect(run.events).toEqual([
      phaseRun("preflight"), PROMOTION_CHECK, phaseRun("upload"), armadaBuild("production", "--promote"),
      skipped("production does not serve this build: the build on armada failed"),
    ]);
    expect(run.infraEnvironment).toBe("production");
  });

  test("a promotion of a build staging never verified builds nothing", async () => {
    const run = await runDeploy({ option: "--promote", failingGate: PROMOTION_CHECK });

    expect(run.status).toBe(1);
    expect(run.events).toEqual([phaseRun("preflight"), PROMOTION_CHECK]);
    expect(run.infraEnvironment).toBeNull();
    expect(run.report).toContain(
      "note promote staging's record staging has not verified testsha with every phase green; deploy it to staging first.",
    );
  });

  // Review job 150, P2: a red promotion leaves production serving it, and one command must undo it.
  test("--rollback runs production's rollback and nothing else, and takes no other option", async () => {
    const rollback = await runDeploy({ option: "--rollback" });

    expect([rollback.status, rollback.events]).toEqual([0, ["bun scripts/promote.ts rollback"]]);

    const combined = await runDeploy({ option: "--rollback", options: ["--promote"] });

    expect([combined.status, combined.events]).toEqual([2, []]);
  });

  // A production reset is confirmed inside `reset.ts wipe`, at a terminal; a run with none stops before anything.
  test("a production reset with no terminal to confirm at runs nothing", async () => {
    const run = await runDeploy({ option: "--promote", options: ["--reset"] });

    expect([run.status, run.events]).toEqual([1, []]);
  });

  // The advertised `wipe production` deletes nothing unless a person types the words at a terminal: piped input is
  // refused before any Cloudflare call, and this child has no wrangler on its PATH to make one with.
  test("a production wipe with its words piped in deletes nothing", async () => {
    const record = join(scratchDir("reset-refused"), "record.json");

    const run = await runToExit([process.execPath, join(REPO_ROOT, "scripts", "reset.ts"), "wipe", "production", record], {
      env: childEnv({ PATH: "" }),
      stdin: "reset production\n",
    });

    expect([run.exitCode, run.stderr]).toEqual([1, expect.stringContaining("not confirmed at a terminal")]);
    expect(existsSync(record)).toBe(false);
  });

  // The wipe sits after the build: a red gate or a failed build must leave the storage as it was.
  test("a reset deletes nothing when a gate is red or the build fails", async () => {
    const wiped = (events: readonly string[]) => events.filter((event) => event.startsWith("bun scripts/reset.ts wipe"));

    const failedBuild = await runDeploy({ option: "--reset" });

    expect(failedBuild.events).toContain("bun scripts/reset.ts plan staging");
    expect(failedBuild.events).toContain(armadaBuild("staging"));
    expect(wiped(failedBuild.events)).toEqual([]);

    const redGate = await runDeploy({ option: "--reset", failingGate: phaseRun("upload") });

    expect(redGate.status).not.toBe(0);
    expect(redGate.events.some((event) => event.startsWith("MUTATE "))).toBe(false);
    expect(wiped(redGate.events)).toEqual([]);
  });

  // 2026-10-08: a staging reset stopped at its upload, its placeholder serving. 2026-10-09: its upload stored the
  // version and stopped short of the container application. Both times the deploy it printed, `--reset` again, was
  // refused by its own account gate on what the reset had deleted. A --reset deploy hands that gate the newest
  // reset's record, which defers exactly what it deleted (infra.test.ts); no other deploy carries one.
  test("reset recovery defers its absent container before upload and rejects it after upload", async () => {
    const account = resetAccount();
    const recovered = await runDeploy({ option: '--reset', account, uploadRuns: [{ says: 'success', status: 0 }] });

    expect(recovered.infraStatuses, recovered.stdout).toEqual([0, 1]);
    expect(recovered.uploads).toHaveLength(1);
    expect(recovered.events.some((event) => event.startsWith('bun scripts/promote.ts record'))).toBe(false);
  });

  test("a plain deploy with an old reset record still refuses its absent container", async () => {
    const account = resetAccount();
    const stale = join(scratchDir("stale-record"), "record.json");

    writeFileSync(stale, JSON.stringify(account.reset));

    const plain = await runDeploy({ ambientRecord: stale, account, uploadRuns: [{ says: 'success', status: 0 }] });

    expect(plain.infraStatuses, plain.stdout).toEqual([1]);
    expect(plain.uploads).toEqual([]);
    expect(plain.events.some((event) => event.includes('release-build.ts') || event.startsWith('MUTATE '))).toBe(false);
  });

  test("reset recovery defers inert bindings only while its recorded placeholder serves", async () => {
    const account = resetAccount(true);

    if (account.live.state !== 'deployed') throw new Error('fixture has no live Worker');

    const placeholder = await runDeploy({ option: '--reset', pendingReset: account.reset.tag, account });

    expect(placeholder.infraStatuses, placeholder.stdout).toEqual([0]);
    expect(placeholder.events).toContain(armadaBuild('staging'));

    const unrelated = await runDeploy({ option: '--reset', account: {
      ...account, live: { ...account.live, versionId: 'unrelated-placeholder' },
    } });

    expect(unrelated.infraStatuses, unrelated.stdout).toEqual([1]);
    expect(unrelated.events).not.toContain(armadaBuild('staging'));
  });

  test("reset recovery cannot defer a class outside its record or a binding missing from an uploaded version", async () => {
    const account = resetAccount();

    if (account.live.state !== 'deployed') throw new Error('fixture has no live Worker');

    for (const missing of ['UserDO', 'ASSETS']) {
      const refused = await runDeploy({ option: '--reset', account: {
        ...account, reset: { ...account.reset, classes: account.reset.classes.filter((entry) => entry.className !== 'UserDO') },
        live: { ...account.live, bindings: account.live.bindings.filter((binding) => binding.name !== missing) },
      } });

      expect(refused.infraStatuses, refused.stdout).toEqual([1]);
      expect(refused.events).not.toContain(armadaBuild('staging'));
    }
  });

  test("an ambient environment variable cannot point the account gate at the other deployment", async () => {
    // Assigned in both arms, like the phase: `export KINU_INFRA_ENVIRONMENT=production`
    // in a shell must not make a staging deploy certify production's resources.
    expect((await runDeploy({ ambientEnvironment: "production" })).infraEnvironment).toBe("staging");
    expect((await runDeploy({ option: "--promote", ambientEnvironment: "staging" })).infraEnvironment).toBe("production");
  });

  // STRUCTURAL, over the plan each phase runs, in DEPLOY_PHASES order; deploy.sh
  // runs the phases in that order, each a barrier. The preflight is first
  // because nothing may report on a machine the preflight has not passed; the
  // upload gates hold the upload, since their damage cannot be undone; the rows
  // that read the deployment share one wave with the source rows after it; the
  // hammer, whose subject is contention, is last and alone (L18).
  test("every gate outside the source wave declares its phase and why it runs there", () => {
    expect(DEPLOY_PHASES).toEqual(["preflight", "upload", "post-publish", "source", "hammer", "soak"]);
    const byPhase = Object.fromEntries(DEPLOY_PHASES.map((phase) => [phase, phaseGates(phase)]));
    expect(byPhase.preflight).toEqual(["bun scripts/preflight.ts"]);
    expect(byPhase.upload).toEqual(["bun scripts/secret-scan.ts", "bun run gate:infra"]);
    expect(byPhase["post-publish"]).toEqual(["bun run gate:first-run", "bun run gate:devbox-e2e", "bash scripts/product-flows-tier.sh"]);
    expect(byPhase.hammer).toEqual(["bun run gate:hammer"]);
    expect(byPhase.soak).toEqual(["bash scripts/eval-pass-tier.sh"]);
    expect(byPhase.source?.length).toBe(PLAN.length - 8);

    for (const gate of LADDER) {
      if (gate.phase === undefined) {
        expect(gate.alone, `${gate.run} explains where it runs but runs in the source wave`).toBeUndefined();
        continue;
      }

      expect(gate.alone?.length ?? 0, `${gate.run} declares its phase with no reason`).toBeGreaterThan(80);
    }
  });


  test("a gate's own hang bound is a declaration with a reason, longer than the shared one", () => {
    for (const row of PLAN) {
      const gate = LADDER.find((candidate) => candidate.run === row.run);

      if (gate?.deadline === undefined) continue;

      // Raising the shared figure would loosen the hang bound of every source gate at once.
      expect(gate.deadline.seconds, `${row.run} declares no longer than the shared bound`).toBeGreaterThan(GATE_DEADLINE_SECONDS);
      expect(gate.deadline.why.length, `${row.run} declares no reason for its own bound`).toBeGreaterThan(80);
    }
  });


  // A phase's runner can end without saying anything about itself: the OOM
  // killer takes it, or something outside its process tree SIGKILLs it.
  // deploy.sh settles that from the child's exit status, which the kernel
  // supplies whether the runner cooperates or not, and the report names the
  // phase, since the runner could not name its rows.
  test("a phase killed without a verdict of its own fails the deploy, and the report says so", async () => {
    const run = await runDeploy({ killGate: phaseRun("source") });

    expect(run.status).toBe(1);
    // 128 + SIGKILL. The status is the child's fate, not a claim the runner made.
    expect(run.stdout).toContain("the source phase failed (exit 137)");
    expect(run.events).toEqual([...STOPS, WITHDRAW, armadaBuild("staging"), ...AFTER_A_FAILED_BUILD]);
    expect(run.report).toContain(
      "note source the source phase's runner it ended with exit 137 and no verdict of its own, so a row it had not reported on may be red and unnamed",
    );
  });

  // THE TWO STOPS. A red preflight or upload phase TRUNCATES the run: nothing
  // later starts, nothing is built and nothing is published, with the former
  // skip variable (SKIP_E2E, on every run here) set. The preflight is the
  // precondition for any verdict; the upload gates hold what cannot be undone.
  test("a red preflight or upload phase stops the deploy before anything later, the build or a publish", async () => {
    for (const [index, phase] of STOPS.entries()) {
      const run = await runDeploy({ failingGate: phase });

      expect(run.status, `${phase} did not fail the deploy`).toBe(1);
      expect(run.events, `${phase} failed and a later step ran\n${run.stdout}`).toEqual(STOPS.slice(0, index + 1));
      expect(run.report.slice(-2)).toEqual(["mark end", "render"]);
    }
  });

  // ONE AT A TIME (L21). Continuous staging deploys only when no staging deploy runs, and two deploys of one
  // environment would race on its Worker, record and report index.
  test("a deploy while another of its environment runs does nothing and exits 75, and the other environment's runs", async () => {
    const blocked = await runDeploy({ lockHeld: true });

    expect([blocked.status, blocked.events, blocked.report]).toEqual([75, [], []]);
    expect(blocked.stdout).toContain("Another staging deploy is running on this machine");

    expect((await runDeploy({ lockHeld: true, option: "--promote" })).status).toBe(75);
    expect((await runDeploy()).events).toEqual([...STOPS, WITHDRAW, armadaBuild("staging"), ...AFTER_A_FAILED_BUILD]);
  });

  // REPORT-ALL. After the upload gates nothing stops a deploy: every phase runs
  // to its end, the hammer included, so one deploy reports every red (L18).
  test("a red after the upload gates stops nothing: every later phase runs, and the deploy is red", async () => {
    for (const option of [undefined, "--gates-only"]) {
      const run = await runDeploy({ failingGate: phaseRun("source"), option });

      const expected = option === undefined
        ? [...STOPS, WITHDRAW, armadaBuild("staging"), ...AFTER_A_FAILED_BUILD]
        : [...STOPS, phaseRun("source")];

      expect(run.status, `a red source phase under ${option ?? "a deploy"} did not fail it`).toBe(1);
      expect(run.events, `the ${option ?? "deploy"} stopped at the red source phase\n${run.stdout}`).toEqual(expected);
      expect(run.report.slice(-2)).toEqual(["mark end", "render"]);
    }
  });


  test("a dirty checkout is rejected before verification or mutation", async () => {
    const run = await runDeploy({ dirty: true });

    expect(run.status).not.toBe(0);
    expect(run.events).toEqual([]);
  });

  // Every post-publish tier reaches the scripted model through its bearer, so a deploy without it would fail after the upload.
  test("a deploy with no scripted model key runs nothing, and --gates-only needs none", async () => {
    // A key file of whitespace is no key: trimmed once, before the check and the upload alike.
    for (const scriptedKey of ["", " \n"]) {
      const refused = await runDeploy({ scriptedKey });

      expect([refused.status, refused.events]).toEqual([1, []]);
    }

    expect((await runDeploy({ scriptedKey: "", option: "--gates-only" })).status).toBe(0);
  });



  // ── The bootstrap option and the phase it selects ──────────────
  //
  // Without it, a deploy that DECLARES a resource only a deploy can create
  // refuses itself: `ControlPlaneDO` landed in `migrations`, the 55 source gates
  // passed, and the infrastructure gate then blocked the one upload that could
  // have created the namespace — telling the operator to run
  // `bun run infra:provision`, which cannot create a Durable Object namespace and
  // is forbidden from trying.
  //
  // `--bootstrap` answers that, and these tests are about the two properties that
  // keep it from being a bypass: it changes the PRE-DEPLOY PHASE and nothing else
  // (no gate is added, dropped or softened), and it cannot be reached by
  // accident, ambient environment, or a typo.
  test("bootstrap changes the phase and not one gate", async () => {
    const bootstrap = await runDeploy({ option: "--bootstrap" });

    // Same phases, same order, same failure semantics as any other deploy. This
    // is the assertion that would catch a future `--bootstrap` that skipped a
    // check rather than re-scoping one.
    expect(bootstrap.events).toEqual([...STOPS, WITHDRAW, armadaBuild("staging"), ...AFTER_A_FAILED_BUILD]);
    expect(bootstrap.infraPhase).toBe("bootstrap");
    // The operator is told what is deferred and what is not, before the gates run.
    expect(bootstrap.stdout).toContain("BOOTSTRAP");
    expect(bootstrap.stdout).toContain("Still refused before the upload");

    const normal = await runDeploy();
    expect(normal.infraPhase).toBe("full");
    expect(normal.events).toEqual(bootstrap.events);
    expect(normal.stdout).not.toContain("BOOTSTRAP");
  });

  test("an ambient phase variable cannot relax a deploy nobody bootstrapped", async () => {
    // The bypass this design refuses. The phase travels in the environment
    // because the gate line has to stay one string for ladder.ts to parse, so the
    // script assigns it in BOTH arms rather than reading whatever was exported —
    // otherwise `export KINU_INFRA_PHASE=bootstrap` in a shell would quietly
    // weaken every deploy launched from it.
    const inherited = await runDeploy({ ambientPhase: "bootstrap" });

    expect(inherited.infraPhase).toBe("full");
    expect(inherited.stdout).not.toContain("BOOTSTRAP");

    // And the flag still wins when it is actually passed, ambient value or not.
    const asked = await runDeploy({
      option: "--bootstrap", ambientPhase: "post-deploy",
    });

    expect(asked.infraPhase).toBe("bootstrap");
  });

  test("an unknown option deploys nothing", async () => {
    // Refused rather than ignored. A silently-dropped `--bootstrp` would fail the
    // deploy at the infrastructure gate with a diagnostic about a Durable Object
    // namespace, which is the wrong thing to debug.
    const run = await runDeploy({ option: "--bootstrp" });

    expect(run.status).toBe(2);
    expect(run.events).toEqual([]);
    expect(run.infraPhase).toBeNull();
  });

  // A plain deploy runs no real-model eval (the owner, 2026-10-08): evals run on a quiet staging, dispatched by hand.
  test("--evals is an option, and only a deploy given it dispatches evals.yml or starts the soak", async () => {
    expect((await runDeploy({ option: "--gates-only", options: ["--evals"] })).status).toBe(0);

    // As TEXT, as the post-deploy phase below is: the fixture's build fails on purpose, so no run reaches a serving build.
    const lines = readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#"));

    // The `if` lines still open at `index`, its own line among them.
    const guardsOf = (index: number) => lines.slice(0, index + 1)
      .filter((line, at) => /^\s*if /u.test(line) && !lines.slice(at + 1, index + 1).some((later) => /^\s*fi\b/u.test(later)));

    const asked = (index: number) => guardsOf(index).some((guard) => guard.includes('"$KINU_EVALS" = "1"'));
    const callsOf = (name: string) => lines.flatMap((line, index) => line.includes(name) && !line.includes(`${name}()`) ? [index] : []);

    // KINU_EVAL_KEYS stands for --evals only if it is set nowhere else.
    const keysAsked = callsOf("KINU_EVAL_KEYS=1").every(asked);

    for (const started of ["dispatch_evals", "start_soak", "provision_eval_keys"]) {
      const calls = callsOf(started);

      expect(calls.length).toBeGreaterThan(0);
      expect(calls.filter((call) => !asked(call) && !(keysAsked && guardsOf(call).some((guard) => guard.includes('"$KINU_EVAL_KEYS" = "1"'))))).toEqual([]);
    }
  });

  // The rehearsal path: every local phase, no build, no upload, no record.
  test("gates-only runs every local phase and mutates nothing", async () => {
    const run = await runDeploy({ option: "--gates-only" });

    expect(run.status).toBe(0);
    expect(run.events).toEqual([...STOPS, phaseRun("source")]);
    expect(run.stdout).toContain("Gates only: stopping before the build");
  });

  // ── The post-deploy phase ──────────────────────────────────────
  //
  // Asserted as TEXT, for the reason the version-annotation test above is: the
  // fixture's build stub fails on purpose, which is what every behavioural test
  // in this file depends on, so no run here reaches step 5. The properties that
  // matter are structural anyway — that the invocation exists, that it runs
  // whenever the upload happened, that it names the strictest phase, and that
  // its failure is a red of the deploy, which then writes no record.
  test("the post-deploy infrastructure phase runs whenever the upload happened, and its red is the deploy's", () => {
    // EXECUTABLE lines, whole-line comments dropped — the same reading the "no
    // shell script but the deploy script publishes" rule below takes, and for the
    // same reason: this script's prose names every command it runs, so a claim
    // about what it RUNS cannot be made against its comments.
    const lines = readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"));

    const source = lines.join("\n");

    // After the upload, and inside no condition but the upload's own, at column zero: nested inside any other `if`,
    // this would be a phase some deploys skip, which is the whole thing `--bootstrap` must not become.
    const uploaded = 'if [ "${DEPLOY_PUBLISHED:-0}" = "1" ]; then';
    const invocation = '  if bun scripts/infra-verify.ts --phase=post-deploy; then';
    const upload = 'if upload "$KINU_DEPLOY_LOG" npx wrangler deploy "${KINU_WRANGLER_ARGS[@]}"; then';
    expect(lines).toContain(uploaded);
    expect(lines).toContain(invocation);
    expect(lines).toContain(upload);
    expect(lines.indexOf(invocation)).toBeGreaterThan(lines.indexOf(upload));
    expect(lines.slice(lines.indexOf(uploaded) + 1, lines.indexOf(invocation)).filter((line) => /^\s*if /u.test(line))).toEqual([]);

    // Its failure arm is a red of the deploy's: its findings go into the report, and a deploy with a red writes no
    // record, so the build cannot be promoted.
    const arm = lines.slice(lines.indexOf(invocation));
    expect(arm.slice(0, arm.indexOf("  fi")).some((line) => line.includes('step_red publish "post-deploy infrastructure"'))).toBe(true);

    // `post-deploy` is the only phase spelled on an argv here, and it is the
    // strictest. `bootstrap` reaches the pre-deploy gate through the environment,
    // because that gate line has to stay one string for ladder.ts to parse; a
    // second argv spelling would be a second place for the two to disagree.
    const argvPhases = [...source.matchAll(/--phase=(\S+?)(?=[\s;]|$)/gu)].map(([, phase]) => phase);
    expect(argvPhases).toEqual(["post-deploy"]);

    // The pre-deploy phase is one of exactly two literals, both assigned here, so
    // an ambient value is never what decides it.
    expect(source).toContain('export KINU_INFRA_PHASE="bootstrap"');
    expect(source).toContain('export KINU_INFRA_PHASE="full"');
    expect([...source.matchAll(/KINU_INFRA_PHASE=/gu)]).toHaveLength(2);
  });

  // ── The control plane's outer gate ─────────────────────────────
  //
  // The admin plane fails CLOSED without a verifiable Cloudflare Access
  // assertion, which means a production deploy carrying no Access application
  // does not break loudly — it makes `/control` answer 404 to its own operators,
  // indistinguishable from an allowlist typo. So the proof has to be a gate, and
  // the gate has to be one no deploy can proceed past.
  test("no deploy can proceed without the gate that proves Access covers the admin plane", () => {
    // The declaration, from the manifest rather than from prose: the Worker
    // declares the organization, the application, its Allow policy and the
    // NEGATIVE scope assertion, and every one of them is required — so an absent
    // or unreadable row is a finding and `gate:infra` exits non-zero.
    const infrastructure = deriveInfrastructure();

    const access = infrastructure.resources.filter((resource) => resource.id.startsWith('access-'));

    expect(access.map((resource) => resource.id).sort()).toEqual([
      'access-application.kinu.run',
      'access-organization.kinu.run',
      'access-policy.kinu.run',
      'access-scope.kinu.run',
    ]);

    for (const resource of access) expect(resource.required).toBe(true);

    // And the gate that observes them is a REQUIRED gate of this pipeline, in
    // the upload phase, whose red stops the deploy before the build: an account
    // that cannot be proved never reaches Wrangler deployment. Both halves
    // matter: a declared-and-unobserved resource proves nothing, and an
    // observed-but-optional gate is a warning. A live gate against the
    // deployment runs after the publish, beside first-run, because a
    // pre-publish live gate can only measure the previous build and refuses
    // the deploy carrying its fix.
    expect(phaseGates('upload')).toContain('bun run gate:infra');
    expect(STOPS.at(-1)).toBe(phaseRun('upload'));
    expect(phaseGates('post-publish')).toContain('bun run gate:first-run');
    const source = readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8");
    expect(source.indexOf('stop_phase upload')).toBeLessThan(source.indexOf('Step 2: Building Kinu'));
    expect(source.indexOf('run_phase post-publish')).toBeGreaterThan(source.indexOf('Step 4: Post-deploy smoke test'));
  });

  test("the Worker demands an assertion for a subset of what Access is told to cover", () => {
    // The containment direction is the whole correctness argument, and it is
    // checkable here because both sides are in this repository: the paths the
    // manifest tells an operator to protect, and the paths the Worker refuses
    // without an assertion.
    //
    // Access covering LESS than the Worker demands is a permanent 404 no operator
    // can clear — there is no way to obtain an assertion for a path the
    // application does not cover. Covering MORE puts an interactive login in
    // front of the public product.
    expect(CONTROL_PLANE_ACCESS_PATHS).toEqual(['/control*', '/api/control*']);

    const covered = (path: string): boolean => CONTROL_PLANE_ACCESS_PATHS.some((pattern) =>
      path.startsWith(pattern.slice(0, -1)));

    // Each Worker route is a Hono pattern (`/x/*`), which matches the bare `/x` and everything beneath it.
    for (const route of [CONTROL_PLANE_UI_ROUTE, CONTROL_PLANE_API_ROUTE]) {
      const prefix = route.slice(0, -'/*'.length);

      for (const path of [prefix, `${prefix}/`, `${prefix}/users`]) expect(covered(path)).toBe(true);
    }

    // Access over the public product would put a login in front of it.
    for (const path of ['/', '/login', '/api/health', '/api/feedback', '/api/user/profile', '/assets/index-abc123.js', '/downloads/kinu']) {
      expect(covered(path)).toBe(false);
    }
  });
});

// ── One deploy path ───────────────────────────────────────────────────
//
// `scripts/deploy.sh` is the one deploy path, and the way that stops being
// true is a SECOND entry point rather than a change to this script. There was
// one: a per-package deploy script ran `vite build && … && wrangler deploy`,
// which skips every required gate, the CLI download asset check and all six
// post-deploy smoke checks — and the deploy documentation named it, so
// following the documentation was the bypass.
//
// The manifests, the workflows, the composite actions and the shell scripts all
// come from the one repository enumerator, so a new package, a new workflow or a
// new script cannot be outside this assertion's denominator.
describe("one deploy path", () => {
  /** Publishing a Worker or its assets. A manifest script, a workflow step or a
   *  shell line naming one of these is a deploy path, wherever it lives.
   *
   *  Read off `wrangler --help` at the installed 4.125.0 rather than remembered.
   *  `triggers deploy` is in that surface and was missing here: it re-points the
   *  routes and crons an uploaded version serves, so it publishes without the
   *  bytes ever passing through this repository's deploy script. `wrangler
   *  preview` is deliberately absent — it is private beta, and it creates a
   *  preview rather than moving what a route serves. */
  const PUBLISH_COMMANDS = [
    "wrangler deploy",
    "wrangler versions upload",
    "wrangler versions deploy",
    "wrangler pages deploy",
    "wrangler rollback",
    "wrangler triggers deploy",
  ] as const;

  /** Reaching `scripts/deploy.sh`: the root script, or the script itself. */
  const DEPLOY_ENTRYPOINTS = ["bun run deploy", "scripts/deploy.sh"] as const;

  /** A per-package deploy: `--cwd <package> deploy`. ONE shape, read by the
   *  document check and by the workflow check — a command is no less a bypass
   *  for sitting in a step body rather than in prose. */
  const PER_PACKAGE_DEPLOY = /--cwd\s+\S+\s+deploy/u;

  /** Launching a run that spends on a credential: the live tier's script, the
   *  root script that runs it, and the eval suite. */
  const EVAL_LAUNCHERS = [
    "scripts/live-tier.sh",
    "bun run test:live",
    "bun run evals",
  ] as const;

  /** What rules on which deployment a credential may name
   *  (`packages/test-utils/src/eval-identity.ts` holds the allowlist both read):
   *  `eval-credentials.ts` for a tier that takes KINU_EVAL_TOKEN, and the eval
   *  suite's own harness, which refuses an origin outside the allowlist before any
   *  trial (evals/src/target.test.ts). Without one, a job takes an origin and an
   *  auth header straight from repository secrets, so one secret can name
   *  production and nothing asks. */
  const EVAL_RESOLVERS = ["scripts/eval-credentials.ts", "bun run evals"] as const;

  const ScriptsSchema = v.object({ scripts: v.optional(v.record(v.string(), v.string())) });
  const manifests = trackedFiles().filter((file) => basename(file) === "package.json");

  const scriptsOf = (manifest: string): Record<string, string> =>
    v.parse(ScriptsSchema, JSON.parse(readRepositoryFile(REPO_ROOT, manifest))).scripts ?? {};

  test("every tracked package manifest is in the denominator", () => {
    expect(manifests, "the enumerator stopped listing the root manifest").toContain("package.json");
    expect(manifests, "the enumerator stopped listing the deployed package")
      .toContain("packages/cf-backend/package.json");
    expect(manifests.length, "the manifest corpus collapsed").toBeGreaterThan(2);
  });

  test("the root deploy script is the deploy script", () => {
    expect(scriptsOf("package.json").deploy).toBe("bash scripts/deploy.sh");
  });

  test("no package script publishes anything itself", () => {
    for (const manifest of manifests) {
      for (const [name, body] of Object.entries(scriptsOf(manifest))) {
        for (const command of PUBLISH_COMMANDS) {
          expect(body, `${manifest} script "${name}" publishes with \`${command}\``)
            .not.toContain(command);
        }
      }
    }
  });

  // Harness boundary: the manifest's own `scripts` block, parsed. Blind spot:
  // one level of indirection — a script that runs `bun scripts/<name>.ts` is one word
  // here whatever `x.ts` launches.
  test("no package script launches a live suite outside the tier script", () => {
    let tierLaunches = 0;

    for (const manifest of manifests) {
      for (const [name, body] of Object.entries(scriptsOf(manifest))) {
        if (body.includes("scripts/live-tier.sh")) tierLaunches += 1;
        // The tier resolves the credential, writes a spend file and runs the
        // skip ratchet. A script running the live suites directly has none of
        // that, and a run that measures nothing reads as a run that passed.
        expect(body, `${manifest} script "${name}" runs the live suites outside the tier script`)
          .not.toMatch(/bun test[^&|;]*tests\/live/u);
      }
    }

    // Non-vacuity: the corpus really does contain the tier's launch site.
    expect(tierLaunches, "no package script launches the live tier").toBeGreaterThan(0);
  });

  // The documented commands and the runnable ones are the same set or the
  // documentation is a bypass. A `--cwd <package> deploy…` line is that shape.
  test("no document names a per-package deploy command", () => {
    const documents = trackedFiles().filter(isDocument);
    expect(documents.length, "the document corpus collapsed").toBeGreaterThan(0);

    let rootCommands = 0;

    for (const document of documents) {
      const text = readRepositoryFile(REPO_ROOT, document);
      const scoped = PER_PACKAGE_DEPLOY.exec(text);
      expect(scoped?.[0], `${document} documents a per-package deploy command`).toBeUndefined();

      if (text.includes("bun run deploy")) rootCommands += 1;
    }

    // Non-vacuity: the check runs over prose that really does name the deploy.
    expect(rootCommands, "no document names the root deploy command")
      .toBeGreaterThan(0);
  });

  /** Every YAML GitHub executes, from the one repository enumerator: the
   *  workflows AND the composite actions beside them. `release-config.test.ts`
   *  reads `.github/workflows` alone, and a composite action's `run:` body is a
   *  command this repository executes inside the job that holds the deploy
   *  credential, so a composite action added later is read here too. */
  const automationFiles = trackedFiles()
    .filter((file) => file.startsWith(".github/") && /\.ya?ml$/u.test(file));

  /** The two shapes GitHub takes a shell body in, named at the boundary. A
   *  workflow keeps its steps under `jobs.<id>.steps[]` and a composite action
   *  keeps them under `runs.steps[]`. `looseObject` on purpose: these assertions
   *  read one key, and a schema that stripped the rest would start answering
   *  other questions. */
  const StepSchema = v.looseObject({ run: v.optional(v.string()) });
  const StepListSchema = v.looseObject({ steps: v.optional(v.array(StepSchema)) });

  const AutomationSchema = v.looseObject({
    jobs: v.optional(v.record(v.string(), StepListSchema)),
    runs: v.optional(StepListSchema),
  });

  /** `run:` bodies, grouped by the job that runs them, because a job is the unit
   *  GitHub binds an environment and its secrets to. A composite action makes
   *  one group under its own file name: the job it runs in belongs to whoever
   *  used it.
   *
   *  Blind spot of the parse: a third place GitHub grows for a shell body needs
   *  an arm above. The two named are every place it allows one today, and a file
   *  that parses as neither yields no bodies — which the non-vacuity count below
   *  fails on rather than passing quietly. */
  function automationJobs(): readonly { label: string; bodies: readonly string[] }[] {
    const bodiesOf = (steps: v.InferOutput<typeof StepListSchema> | undefined): string[] =>
      (steps?.steps ?? []).flatMap((step) => (step.run === undefined ? [] : [step.run]));

    return automationFiles.flatMap((file) => {
      const parsed = v.parse(AutomationSchema, Bun.YAML.parse(readRepositoryFile(REPO_ROOT, file)));

      return [
        ...Object.entries(parsed.jobs ?? {})
          .map(([job, definition]) => ({ label: `${file}#${job}`, bodies: bodiesOf(definition) })),
        { label: file, bodies: bodiesOf(parsed.runs) },
      ].filter(({ bodies }) => bodies.length > 0);
    });
  }

  const automation = automationJobs();

  const automationSteps = automation
    .flatMap(({ label, bodies }) => bodies.map((body) => ({ label, body })));

  // Harness boundary: the PARSED YAML of every tracked `.github` file, so a body
  // is read as GitHub will run it and a commented-out command is not a finding.
  // Blind spot: what a body then executes — `bun scripts/<name>.ts` is one word here
  // whatever `x.ts` publishes.
  test("every automation file GitHub executes is in the denominator", () => {
    expect(automationFiles, "the enumerator stopped listing the workflows")
      .toContain(".github/workflows/evals.yml");
    expect(automationFiles, "the enumerator stopped listing the secret scan")
      .toContain(".github/workflows/security-scan.yml");
    expect(automationFiles.length, "the automation corpus collapsed").toBeGreaterThan(1);
    expect(automationSteps.length, "the parse read no run body").toBeGreaterThan(10);

    // Deploys are run by a person through `bun run deploy`; no workflow deploys.
    // Named so a workflow that starts deploying is a deliberate change here.
    const deploying = automationSteps.filter(({ body }) =>
      DEPLOY_ENTRYPOINTS.some((entrypoint) => body.includes(entrypoint)));

    expect(deploying.map(({ label }) => label)).toEqual([]);
  });

  // Harness boundary: string containment over a step body, the same authority
  // `PUBLISH_COMMANDS` gives the manifest check. Blind spot: an argv array —
  // `scripts/bench-*.ts` spell theirs `runWrangler(root, ['deploy', …])`, which
  // writes no such word — and any command assembled at run time.
  test("no automation step publishes anything itself", () => {
    // Positive control, as a literal: a matcher that stops matching is
    // indistinguishable from a clean tree.
    expect(PUBLISH_COMMANDS.some((command) =>
      "bunx wrangler deploy".includes(command))).toBe(true);

    for (const { label, body } of automationSteps) {
      for (const command of PUBLISH_COMMANDS) {
        expect(body, `${label} publishes with \`${command}\` instead of running scripts/deploy.sh`)
          .not.toContain(command);
      }

      expect(PER_PACKAGE_DEPLOY.exec(body)?.[0], `${label} deploys one package around the deploy script`)
        .toBeUndefined();
    }
  });

  /** The one script that may publish. Every other shell script is a caller of
   *  it, or of nothing. */
  const SHELL_PUBLISHER = "scripts/deploy.sh";
  const shellScripts = trackedFiles().filter((file) => file.endsWith(".sh"));

  // Harness boundary: the script's executable lines, with whole-line `#`
  // comments dropped — deploy.sh's own header names the publish in prose a dozen
  // times, and so does the header of the archive builder beside it. Blind spot:
  // a trailing `# wrangler deploy` comment reads as an invocation here, and a
  // publish assembled from variables reads as none.
  test("no shell script but the deploy script publishes", () => {
    const commandLines = (file: string): string => readRepositoryFile(REPO_ROOT, file)
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    expect(shellScripts, "the enumerator stopped listing the deploy script").toContain(SHELL_PUBLISHER);
    expect(shellScripts.length, "the shell corpus collapsed").toBeGreaterThan(5);
    // Non-vacuity: the known publishing site is in the corpus, and this reading
    // of it really does contain the publish this rule is about.
    expect(commandLines(SHELL_PUBLISHER), "the deploy script stopped publishing")
      .toContain("npx wrangler deploy");

    for (const file of shellScripts) {
      if (file === SHELL_PUBLISHER) continue;

      for (const command of PUBLISH_COMMANDS) {
        expect(commandLines(file), `${file} publishes with \`${command}\`; the deploy path is ${SHELL_PUBLISHER}`)
          .not.toContain(command);
      }
    }
  });

  // Harness boundary: the JOB, because a job is the unit GitHub binds an
  // environment and its secrets to. Blind spot: ORDER inside the job — this
  // reads that the resolving step is in the same job, not that it runs first.
  // `eval-credentials.ts` refusing a target it does not allow is what stops a
  // credential aimed at production; this only proves the refusal is reachable.
  test("an eval a workflow launches resolves its target through the one resolver", () => {
    let launching = 0;

    for (const { label, bodies } of automation) {
      if (!bodies.some((body) => EVAL_LAUNCHERS.some((launcher) => body.includes(launcher)))) continue;
      launching += 1;
      expect(
        bodies.some((body) => EVAL_RESOLVERS.some((resolver) => body.includes(resolver))),
        `${label} launches an eval without resolving its target through ${EVAL_RESOLVERS.join(' or ')}`,
      ).toBe(true);
    }

    // Non-vacuity: a workflow really does launch an eval with a credential.
    expect(launching, "no workflow launches an eval").toBeGreaterThan(0);
  });
});

/**
 * The CLI is built at deploy time and published as artifacts. Before that it
 * shipped as a source archive every user had to `bun install`: measured cold
 * on 2026-09-01, that was 13.35 s of a 16.08 s install, 950 packages and
 * 1.9 GB of their disk. What replaces it must be built, executable, within
 * Cloudflare's per-file asset limit, and complete — a missing platform is a
 * platform that installs nothing.
 */
describe('CLI distribution signing prerequisites', () => {
  async function rejectedBuild(signing: Record<string, string> = {}) {
    const directory = scratchDir('cli-dist-signing');
    const out = join(directory, 'downloads');

    const build = await runToExit(['bash', join(REPO_ROOT, 'scripts/build-cli-dist.sh'), out], {
      cwd: REPO_ROOT,
      env: { ...freshHome(directory), KINU_RELEASE_SIGNING_KEY_FILE: join(directory, 'absent.key'), ...signing },
    });

    expect(build.exitCode, build.stderr).toBe(1);
    expect(existsSync(out), 'a refused signing configuration must leave the distribution unbuilt').toBe(false);

    return build.stderr;
  }

  test('a missing key refuses before building and names the bootstrap command', async () => {
    const error = await rejectedBuild();

    expect(error).toContain('bun scripts/release-signing-key.ts');
    expect(error).toContain('docs/SELF-HOSTING.md');
  });

  test('a missing or mismatched pin refuses before building and names both client pins', async () => {
    const key = await generateReleaseSigningKey();
    const other = await generateReleaseSigningKey();

    for (const pin of ['', other.publicKeyHex]) {
      const error = await rejectedBuild({ KINU_RELEASE_SIGNING_KEY: key.privateKeyPkcs8Base64, KINU_RELEASE_SIGNING_PUBLIC_KEY: pin });

      expect(error).toContain('packages/core/src/http/release-signing.ts');
      expect(error).toContain('packages/pc-agent/src/update.js');
    }
  });
});

describe("CLI distribution artifacts", () => {
  const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;
  const CPYTHON = "kinu-runtime-cpython.tar.gz";
  // Cloudflare's static-asset limit, per file, on both plans.
  const MAX_ASSET_BYTES = 25 * 1024 * 1024;

  async function buildDist() {
    const directory = scratchDir("cli-dist-test");
    const manifest = join(REPO_ROOT, "packages", "cli", "package.json");
    const before = { bytes: readFileSync(manifest, "utf8"), mtimeMs: statSync(manifest).mtimeMs };
    const env = freshHome(directory);
    const generated = await runToExit([process.execPath, join(REPO_ROOT, 'scripts/release-signing-key.ts')], { cwd: REPO_ROOT, env });
    expect(generated.exitCode, generated.stderr).toBe(0);
    const publicKey = /^RELEASE_SIGNING_PUBLIC_KEY=([0-9a-f]{64})$/m.exec(generated.stdout)?.[1];

    if (publicKey === undefined) throw new Error(`the key generator printed no public pin: ${generated.stdout}`);
    const keyFile = join(directory, 'home/.config/kinu/release-signing.key');
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(generated.stdout).not.toContain(readFileSync(keyFile, 'utf8').trim());

    const build = await runToExit(['bash', join(REPO_ROOT, 'scripts/build-cli-dist.sh'), directory], {
      cwd: REPO_ROOT, env: { ...env, KINU_RELEASE_SIGNING_PUBLIC_KEY: publicKey },
    });

    expect(build.exitCode, build.stderr).toBe(0);

    return { directory, before };
  }

  let distribution: Awaited<ReturnType<typeof buildDist>>;

  beforeAll(async () => { distribution = await buildDist(); });

  async function members(archive: string): Promise<Set<string>> {
    const listing = await runToExit(["tar", "-tzf", archive]);
    expect(listing.exitCode, listing.stderr).toBe(0);

    return new Set(listing.stdout.trim().split("\n"));
  }

  test("the build reads the CLI manifest and never writes it", () => {
    // The deploy runs its gates six at a time, and this build is one of them:
    // a stamp written into packages/cli/package.json and restored on exit was
    // read mid-flight by the CLI suite's version test on 2026-09-02 (staging
    // failed on `0.2.0+<sha>` against an imported `0.2.0`). The stamp is a
    // bundle-time define now, so the manifest's bytes AND mtime survive a
    // build — a restore-on-exit would keep the bytes and move the mtime.
    const manifest = join(REPO_ROOT, "packages", "cli", "package.json");
    const { directory, before } = distribution;
    expect(readFileSync(manifest, "utf8")).toBe(before.bytes);
    expect(statSync(manifest).mtimeMs).toBe(before.mtimeMs);
    // And the stamp still lands where it belongs: in what ships.
    const stamp = JSON.parse(readFileSync(join(directory, "kinu-version.json"), "utf8"));
    const base = JSON.parse(before.bytes).version;
    expect(stamp.version).toBe(`${base}+${stamp.sha}`);
  });

  test("publishes one artifact per platform, plus the runtime they share", async () => {
    const { directory } = distribution;

    for (const platform of PLATFORMS) {
      const artifact = join(directory, `kinu-cli-${platform}.tar.gz`);
      expect(existsSync(artifact), `no artifact for ${platform}`).toBe(true);
      const entries = await members(artifact);
      expect(entries.has("kinu/cli.js"), `${platform} artifact carries no cli.js`).toBe(true);

      // The daemon and its stamp, for a daemon updating itself from this archive.
      for (const name of ["pc-agent.js", "sandbox.js", "pty.js", "update.js", "chatgpt.js", "pc-agent.version"]) {
        expect(entries.has(`kinu/pc-agent/${name}`), `${platform} artifact carries no pc-agent/${name}`).toBe(true);
      }

      // The tree-sitter worker the markdown renderer spawns and the web-tree-
      // sitter wasm it parses through: bun materializes the worker beside
      // cli.js as parser.worker-<hash>.js, and an archive without it renders
      // raw markers.
      expect(
        [...entries].some((entry) => /^kinu\/parser\.worker-\w+\.js$/.test(entry)),
        `${platform} artifact carries no emitted parser worker`,
      ).toBe(true);
      expect(
        entries.has("kinu/node_modules/web-tree-sitter/tree-sitter.wasm"),
        `${platform} artifact carries no web-tree-sitter wasm`,
      ).toBe(true);

      // The native library is the whole reason this artifact is per platform.
      expect(
        [...entries].some((entry) => entry.startsWith(`kinu/node_modules/@opentui/core-${platform}/`)),
        `${platform} artifact carries no @opentui/core-${platform}`,
      ).toBe(true);

      // Grammar assets the worker loads offline: markdown and its inline
      // variant power the conceal and code highlighting in the chat surface.
      expect(
        [...entries].some((entry) => /^kinu\/tree-sitter-markdown-\w+\.wasm$/.test(entry)),
        `${platform} artifact carries no markdown grammar`,
      ).toBe(true);
      expect(
        [...entries].some((entry) => /^kinu\/tree-sitter-markdown_inline-\w+\.wasm$/.test(entry)),
        `${platform} artifact carries no markdown_inline grammar`,
      ).toBe(true);
      expect(
        [...entries].some((entry) => /^kinu\/highlights-\w+\.scm$/.test(entry)),
        `${platform} artifact carries no highlight queries`,
      ).toBe(true);

      // Every other platform's native library stays out of it.
      for (const other of PLATFORMS) {
        if (other === platform) continue;
        expect(
          [...entries].some((entry) => entry.includes(`@opentui/core-${other}/`)),
          `${platform} artifact also ships ${other}`,
        ).toBe(false);
      }

      // The CPython blobs are 13.71 MiB gzipped and identical on every
      // platform. Four copies is 41 MiB of duplicate assets.
      expect(
        [...entries].some((entry) => entry.includes("runtime-cpython")),
        `${platform} artifact duplicates the shared CPython runtime`,
      ).toBe(false);
    }

    const runtime = join(directory, CPYTHON);
    expect(existsSync(runtime)).toBe(true);
    expect((await members(runtime)).has("kinu/node_modules/@nimbus-sh/runtime-cpython/manifest.json")).toBe(true);
  });

  test("every artifact carries a matching checksum and fits the asset limit", () => {
    const { directory } = distribution;

    for (const name of [...PLATFORMS.map((p) => `kinu-cli-${p}.tar.gz`), CPYTHON]) {
      const artifact = join(directory, name);
      const bytes = readFileSync(artifact);
      expect(bytes.byteLength, `${name} is over Cloudflare's per-file asset limit`)
        .toBeLessThanOrEqual(MAX_ASSET_BYTES);
      const declared = readFileSync(`${artifact}.sha256`, "utf8").trim().split(/\s+/)[0];
      expect(declared, `${name} has no published checksum`).toMatch(/^[0-9a-f]{64}$/);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(declared);
    }
  });

  // The install this asserts is the one a stranger runs: unpack both archives
  // over one directory and launch. Nothing resolves a dependency here, so the
  // failure the old source archive kept having — a fresh machine installing
  // cleanly and then dying on `Cannot find module` — has no path left.
  test("the unpacked artifacts launch and report the build's stamped version", async () => {
    const { directory } = distribution;
    const host = `${process.platform}-${process.arch}`;
    const installed = join(directory, "installed");
    mkdirSync(installed);

    for (const name of [`kinu-cli-${host}.tar.gz`, CPYTHON]) {
      const unpack = await runToExit(["tar", "-xzf", join(directory, name), "-C", installed]);

      expect(unpack.exitCode, unpack.stderr).toBe(0);
    }

    const root = join(installed, "kinu");

    const stamp = v.parse(
      v.object({ version: v.string(), sha: v.string(), builtAt: v.string() }),
      JSON.parse(readFileSync(join(directory, "kinu-version.json"), "utf8")),
    );

    // The base version read off the manifest rather than retyped: the literal
    // this pinned had to be edited on every minor bump, beside the file that
    // already declares it.
    const manifest = v.parse(
      v.object({ version: v.string() }),
      JSON.parse(readFileSync(join(REPO_ROOT, "packages", "cli", "package.json"), "utf8")),
    );

    expect(stamp.version).toBe(`${manifest.version}+${stamp.sha}`);

    const version = await runToExit([process.execPath, "run", join(root, "cli.js"), "--version"], {
      cwd: root,
      env: freshHome(directory),
    });

    expect(version.exitCode, launchFailure(version)).toBe(0);
    // The stamp the assets advertise is the stamp the program reports. Two
    // stamping sites is how `kinu update` learns to chase a version nothing has.
    expect(version.stdout.trim()).toBe(stamp.version);

    // The shipped daemon, run the way a daemon updating itself runs it: it
    // loads its siblings from the archive and reports the same stamp.
    const daemon = await runToExit([process.execPath, join(root, "pc-agent", "pc-agent.js"), "--selftest"], {
      cwd: root,
      env: { ...freshHome(directory), KINU_HOME: join(root, "pc-agent") },
    });

    expect(daemon.exitCode, launchFailure(daemon)).toBe(0);
    expect(daemon.stdout.trim()).toBe(stamp.version);

    // What install.sh itself greps for before calling the install good.
    const help = await runToExit([process.execPath, "run", join(root, "cli.js"), "--help"], {
      cwd: root,
      env: freshHome(directory),
    });

    expect(help.exitCode, launchFailure(help)).toBe(0);
    expect(help.stdout).toMatch(/^[ \t]+setup[ \t]/m);
  });
  // The markdown pipeline the archive is for: the parser worker beside
  // cli.js, its web-tree-sitter wasm and grammar assets resolving from the
  // unpack dir alone. The run happens in a PTY off a scratch install with a
  // scratch KINU_HOME, a scrubbed child env (childEnv carries only PATH) and
  // a loopback proxy that answers every request 502 — so nothing in it can
  // fall back to the repository's node_modules, a warm TreeSitter cache, or
  // the network. The probe fetch through the same env proves the guard
  // actually intercepts, not merely that the network is down.

  const MARKDOWN_TURN = [
    "Ship verdict: **two green lanes** now.",
    "",
    "- worker bundle `parser.worker.js`",
    "- markdown grammar `tree-sitter-markdown.wasm`",
    "",
    "1. archive unpacked",
    "2. TUI rendered",
    "",
    "### Heading marker",
    "",
    "```ts",
    "const PACKAGED = true;",
    "```",
  ].join("\n");

  async function unpackHostCli(into: string): Promise<string> {
    const host = `${process.platform}-${process.arch}`;

    for (const name of [`kinu-cli-${host}.tar.gz`, CPYTHON]) {
      const unpack = await runToExit(["tar", "-xzf", join(distribution.directory, name), "-C", into]);

      expect(unpack.exitCode, unpack.stderr).toBe(0);
    }

    return join(into, "kinu");
  }

  const MockLlmReadySchema = v.object({ model: v.number(), proxy: v.number() });

  async function startMockLlmProcess(): Promise<{ modelPort: number; proxyPort: number; stop: () => void }> {
    const proc = Bun.spawn(
      [process.execPath, join(REPO_ROOT, "packages/cli/tests/fixtures/mock-llm-server.ts")],
      { env: { MOCK_LLM_ANSWER: MARKDOWN_TURN }, stdout: "pipe", stderr: "pipe" },
    );

    let banner = "";

    for await (const chunk of proc.stdout) {
      banner += new TextDecoder().decode(chunk);

      if (banner.includes("\n")) break;
    }

    const ready = /^READY (.+)$/m.exec(banner);
    const ports = v.parse(MockLlmReadySchema, JSON.parse(ready?.[1] ?? "null"));

    return { modelPort: ports.model, proxyPort: ports.proxy, stop: () => { proc.kill(); } };
  }

  // Every child the fixture runs — the provisioning CLI calls, the PTY chat,
  // and the guard probe — carries the same isolation policy: all traffic must
  // go through the rejecting loopback proxy except the loopback host itself.
  function offlineChildEnv(home: string, proxyPort: number) {
    const proxy = `http://127.0.0.1:${String(proxyPort)}`;

    return {
      ...freshHome(home),
      KINU_SKIP_DAEMON: "1",
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
    };
  }

  const NetworkCheckSchema = v.object({ attempted: v.boolean() });

  async function networkAttempted(modelPort: number): Promise<boolean> {
    const response = await fetch(`http://127.0.0.1:${String(modelPort)}/network-check`);

    return v.parse(NetworkCheckSchema, await response.json()).attempted;
  }

  // The red control: a fetch that must fail, and must fail AT the proxy —
  // if the proxy environment did not apply, this either succeeds outright or
  // fails somewhere the guard never saw, and `attempted` stays false. The
  // rejecting proxy answers with a status, which fetch resolves — the child
  // turns anything but a real 200 into a nonzero exit.
  async function proveNetworkGuard(env: Record<string, string>, modelPort: number): Promise<void> {
    const probe = await runToExit([process.execPath, "-e", "const r = await fetch('https://example.com'); if (r.status !== 200) process.exit(1)"], { cwd: REPO_ROOT, env });

    expect(probe.exitCode, "guard probe got a real 200 from example.com: isolation is not intercepting").not.toBe(0);
    expect(await networkAttempted(modelPort), "guard probe failed without touching the proxy").toBe(true);

    const reset = await fetch(`http://127.0.0.1:${String(modelPort)}/network-check`, { method: "POST" });
    expect(reset.status).toBe(200);
  }

  async function provisionWorkspace(root: string, env: Record<string, string>, baseURL: string): Promise<void> {
    const kinuHome = join(env.HOME ?? "", ".kinu");

    // The session override only reaches the resolver when the provider has a
    // stored credential: openaiCompat.default is the shape `provider connect`
    // writes for an OpenAI-compatible endpoint.
    mkdirSync(kinuHome, { recursive: true });
    writeFileSync(join(kinuHome, "config.json"), `${JSON.stringify({
      providers: { openaiCompat: { default: { baseURL, apiKey: "mock" } } },
    })}\n`);

    const run = async (args: string[]) => {
      const proc = await runToExit([process.execPath, "run", join(root, "cli.js"), ...args], {
        cwd: root,
        env,
      });

      expect(proc.exitCode, launchFailure(proc)).toBe(0);
    };

    await run(["create", "w1", "--mode", "local", "--model", "openai-compat/mock-model"]);
    // Turns read the profile tier, not the actor's stored hint: `create
    // --model` writes the hint, and only `kinu model` updates the tier the
    // resolver actually consults.
    await run(["model", "w1", "openai-compat/mock-model"]);
  }

  /** Without the worker the markers never leave, so that case reads its misses rather than failing on them. */
  function chatSurface(root: string, env: Record<string, string>, unmetWait: "fail" | "report" = "fail"): Promise<PtyRun> {
    return runTuiInPty(join(root, "cli.js"), {
      unmetWait,
      args: ["chat", "w1"],
      cwd: root,
      steps: [
        { wait: "Send a message" },
        { send: "say hi" },
        { wait: "say hi" },
        { send: "\r" },
        { wait: "two green lanes" },
        { wait: "archive unpacked" },
        // Only once the reply is all there is the absence of its markers
        // meaningful: `gone` holds the run open for them to leave, which is
        // where conceal fails when the worker never starts.
        { gone: "**" },
        { gone: "###" },
        { gone: "`" },
      ],
      env,
    });
  }

  test("a packaged chat renders streamed markdown: worker, conceal, and theme ink", async () => {
    const server = await startMockLlmProcess();

    try {
      const install = scratchDir("cli-dist-installed");
      const root = await unpackHostCli(install);
      const env = offlineChildEnv(join(install, "home"), server.proxyPort);

      // The control: this environment cannot reach the outside, and reaching
      // it provably goes through the guard. Until this holds, an `attempted:
      // false` verdict at the end means nothing.
      await proveNetworkGuard(env, server.modelPort);

      await provisionWorkspace(root, env, `http://127.0.0.1:${String(server.modelPort)}/v1`);

      const run = await chatSurface(root, env);


      // Conceal: every marker the text carries is gone from the frame. A
      // worker that never starts leaves all of them literal.
      expect(run.screen).toContain("two green lanes");
      expect(run.screen).not.toContain("**");
      expect(run.screen).not.toContain("###");
      expect(run.screen).not.toContain("`");
      expect(run.screen).toContain("worker bundle parser.worker.js");
      expect(run.screen).toContain("1. archive unpacked");
      expect(run.screen).toContain("2. TUI rendered");
      expect(run.screen).toContain("Heading marker");
      expect(run.screen).toContain("const PACKAGED = true;");

      // The grammar actually painted: the bold span carries the bold attribute
      // and the inline code span carries the theme's code ink — both emitted
      // only when tree-sitter answers.
      expect(run.raw).toContain("\x1b[1mtwo green lanes");
      expect(run.raw).toContain("\x1b[1mHeading marker");

      const codeInk = createThemeRegistry(BUILTIN_TUI_THEMES)
        .get(DEFAULT_TUI_THEME_SELECTION.themeId).colors.well.code;

      expect(inkBefore(run.raw, "parser.worker.js")).toBe(codeInk);

      // Nothing the render needed came from the network: every asset the
      // worker asked for was already in the unpack dir.
      expect(await networkAttempted(server.modelPort)).toBe(false);
    } finally {
      server.stop();
    }
  });

  // The regression this guards: an archive without the worker files renders
  // the same turn with every marker literal — the state before this fix.
  test("a packaged chat without the worker ships raw markdown", async () => {
    const server = await startMockLlmProcess();

    try {
      const install = scratchDir("cli-dist-noworker");
      const root = await unpackHostCli(install);
      const env = offlineChildEnv(join(install, "home"), server.proxyPort);

      // Only files the runtime can resolve: what the bundled cli.js imported
      // with type: "file" — a stray parser.worker.js beside it is not proof.
      const workers = readdirSync(root)
        .filter((name) => /^parser\.worker-\w+\.js$/.test(name))
        .map((name) => join(root, name));

      expect(workers.length, "no emitted parser.worker-*.js in the unpack dir").toBeGreaterThan(0);

      for (const worker of workers) renameSync(worker, `${worker}.off`);

      try {
        await provisionWorkspace(root, env, `http://127.0.0.1:${String(server.modelPort)}/v1`);

        const run = await chatSurface(root, env, "report");

        expect(run.waits.find((wait) => !wait.met)).toMatchObject({ until: "gone", text: "**" });
        expect(run.screen).toContain("**two green lanes**");
        expect(run.screen).toContain("### Heading marker");
        expect(run.screen).toContain("`parser.worker.js`");
      } finally {
        for (const worker of workers) renameSync(`${worker}.off`, worker);
      }
    } finally {
      server.stop();
    }
  });
});

/**
 * The worker release artifact is ~29 MB and Cloudflare's per-file asset limit
 * is 25 MiB, which the CLI distribution row above already measures for the
 * tarballs it publishes. Staging this one beside them would fail the deploy at
 * asset upload, so it is published into R2 and streamed by the Worker at the
 * same public path; only the manifest and the checksum stay assets.
 */
describe("worker release artifact", () => {
  const MAX_ASSET_BYTES = 25 * 1024 * 1024;

  const VERSION = "0.0.0+deploytest";

  const ARTIFACT = `kinu-worker-${VERSION}.tar.gz`;

  let dist: string;

  beforeAll(async () => {
    dist = scratchDir("worker-release-test");
    mkdirSync(join(dist, "kinu", "assets"), { recursive: true });
    mkdirSync(join(dist, "client", "assets"), { recursive: true });
    mkdirSync(join(dist, "client", "downloads"), { recursive: true });
    writeFileSync(join(dist, "kinu", "index.js"), "export default { fetch() { return new Response('k'); } };\n");
    writeFileSync(join(dist, "kinu", "index.js.map"), "{}\n");
    writeFileSync(join(dist, "kinu", "wrangler.json"), "{}\n");
    writeFileSync(join(dist, "kinu", "assets", "chunk.js"), "export const a = 1;\n");
    // What the real build writes beside the modules and a release must never
    // carry: the plugin's copy of this checkout's local-dev secrets, and the
    // build's own index. And one member the runtime does load: a compiled
    // WebAssembly module.
    writeFileSync(join(dist, "kinu", ".dev.vars"), "CREDENTIAL_ENCRYPTION_KEY='not-for-the-public'\n");
    mkdirSync(join(dist, "kinu", ".vite"), { recursive: true });
    writeFileSync(join(dist, "kinu", ".vite", "manifest.json"), "{}\n");
    writeFileSync(join(dist, "kinu", "assets", "esbuild-abc.wasm"), new Uint8Array([0, 0x61, 0x73, 0x6d]));
    writeFileSync(join(dist, "client", "index.html"), "<!doctype html><title>k</title>\n");
    writeFileSync(join(dist, "client", "assets", "app.js"), "console.log('app');\n");
    writeFileSync(join(dist, "client", "downloads", "kinu-cli-linux-x64.tar.gz"), "not really a tarball\n");

    const build = await runToExit(["bun", join(REPO_ROOT, "scripts", "build-worker-release.ts"), VERSION, "deploytest", dist], { cwd: REPO_ROOT, env: childEnv() });

    expect(build.exitCode, build.stderr).toBe(0);
  });

  test("the tarball is not under the assets directory at all", () => {
    expect(existsSync(join(dist, "client", "downloads", ARTIFACT))).toBe(false);
    expect(existsSync(join(dist, "worker-release", ARTIFACT))).toBe(true);
  });

  test("what does stay an asset is under Cloudflare's per-file limit", () => {
    for (const name of ["release.json", `${ARTIFACT}.sha256`]) {
      const published = join(dist, "client", "downloads", name);

      expect(existsSync(published)).toBe(true);
      expect(statSync(published).size).toBeLessThan(MAX_ASSET_BYTES);
    }
  });

  test("the published checksum is the artifact's", () => {
    const stated = readFileSync(join(dist, "client", "downloads", `${ARTIFACT}.sha256`), "utf8").trim().split(/\s+/)[0];
    const measured = createHash("sha256").update(readFileSync(join(dist, "worker-release", ARTIFACT))).digest("hex");

    expect(stated).toBe(measured);
  });

  test("the artifact carries the worker's modules and the client's assets, and neither the maps nor the downloads", async () => {
    const listed = await runToExit(["tar", "-tzf", join(dist, "worker-release", ARTIFACT)]);
    const entries = listed.stdout.split("\n").filter((line) => line.trim() !== "");

    expect(entries).toContain("worker/index.js");
    expect(entries).toContain("worker/assets/esbuild-abc.wasm");
    expect(entries).toContain("client/index.html");
    expect(entries.some((entry) => entry.endsWith(".map"))).toBe(false);
    // The build stamp rides along (it is what `/api/health` answers `build`
    // from); the CLI tarballs beside it at kinu.run do not.
    expect(entries.filter((entry) => entry.startsWith("client/downloads/") && !entry.endsWith("/")))
      .toEqual(["client/downloads/kinu-version.json"]);
    expect(entries).toContain("release.json");
  });

  // Measured 2026-09-21: release 0.2.0+7cb7078c8 carried both, and the
  // `.dev.vars` was this checkout's local-dev root key, published to anyone
  // who installs. A member is what the runtime loads; scaffolding is not.
  test("the artifact carries no local-dev secrets and no build index, and the manifest names only modules", async () => {
    const listed = await runToExit(["tar", "-tzf", join(dist, "worker-release", ARTIFACT)]);
    const entries = listed.stdout.split("\n").filter((line) => line.trim() !== "");

    expect(entries.some((entry) => entry.endsWith(".dev.vars"))).toBe(false);
    expect(entries.some((entry) => entry.includes("/.vite/"))).toBe(false);
    expect(entries.some((entry) => entry.endsWith("wrangler.json"))).toBe(false);

    const manifest = parseReleaseManifest(readFileSync(join(dist, "client", "downloads", "release.json"), "utf8"));

    expect([...manifest.worker.modules].sort()).toEqual(["assets/chunk.js", "assets/esbuild-abc.wasm", "index.js"]);
    expect(manifest.files.map((file) => file.path).filter((path) => path.startsWith("worker/")).sort())
      .toEqual(["worker/assets/chunk.js", "worker/assets/esbuild-abc.wasm", "worker/index.js"]);
  });

  /**
   * The order is part of the artifact, not an accident of the tar line. The
   * Cloudflare door installs this with one pass of the stream and holds the
   * module set to the end, because a version is one multipart request
   * (`packages/core/src/deploy/steps.ts`). Modules first would mean holding
   * them through every asset, which is the difference between a peak set by
   * the largest member and one set by the release.
   */
  test("every asset comes before every module", async () => {
    const listed = await runToExit(["tar", "-tzf", join(dist, "worker-release", ARTIFACT)]);
    const entries = listed.stdout.split("\n").filter((line) => line.trim() !== "");
    const lastAsset = entries.reduce((last, entry, at) => (entry.startsWith("client/") ? at : last), -1);
    const firstModule = entries.findIndex((entry) => entry.startsWith("worker/"));

    expect(lastAsset).toBeGreaterThan(-1);
    expect(firstModule).toBeGreaterThan(lastAsset);
  });
});

// ── The smoke test's reads of the version it deployed (deploy-smoke.sh) ──

const SMOKE = join(import.meta.dir, 'deploy-smoke.sh');

/** A route the way an edge answers it while a new version propagates: the nth answer comes from the nth version
 *  named (the last one thereafter), as the placeholder 503s or as a version answers 200; `null` names none. */
function edge(answers: readonly (string | null)[]) {
  let asked = 0;

  const server = Bun.serve({
    port: 0,
    fetch: () => {
      const version = answers[Math.min(asked, answers.length - 1)];

      asked += 1;

      return new Response(version === 'placeholder' ? '{"resetting":true}' : 'ok', {
        status: version === 'placeholder' ? 503 : 200,
        headers: version === null ? {} : { 'x-kinu-version': version },
      });
    },
  });

  return { url: `http://127.0.0.1:${String(server.port)}/downloads/kinu-worker.tar.gz`, asked: () => asked, stop: () => server.stop(true) };
}

const servers: { stop: () => void }[] = [];

afterAll(() => {
  for (const server of servers) server.stop();
});

/** `ours` and `not_ours` from deploy-smoke.sh, as deploy.sh calls them, against `url`, within a 6 s bound. */
async function smoke(url: string): Promise<{ readonly status: string; readonly by: string; readonly finding: string }> {
  const script = `source ${JSON.stringify(SMOKE)}
KINU_PROPAGATION_SECONDS=6
KINU_VERSION=cfcb250f
ours /dev/null -I --max-time 5 ${JSON.stringify(url)}
printf '%s\\n%s\\n%s' "$KINU_STATUS" "$KINU_ANSWERED_BY" "$(not_ours "the worker artifact route")"`;

  // Not spawnSync: the route answers from this process.
  const ran = Bun.spawn(['bash', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  const [status = '', by = '', finding = ''] = (await new Response(ran.stdout).text()).split('\n');

  await ran.exited;

  return { status, by, finding };
}

describe('the smoke test reads the version it deployed', () => {
  // 2026-10-08: the reset placeholder before b8340eebf answered the artifact route 503, 23 s after the deploy, between
  // answers the new version gave; the smoke read that 503 as the build's.
  test('asks again while a version it replaced answers, and judges its own version\'s answer', async () => {
    const route = edge(['placeholder', 'placeholder', 'cfcb250f']);

    servers.push(route);

    expect({ ...await smoke(route.url), asked: route.asked() }).toEqual({ status: '200', by: 'cfcb250f', finding: '', asked: 3 });
  });

  test('names the version still answering at its bound, rather than judging that version\'s answer as the build\'s', async () => {
    const route = edge(['placeholder']);

    servers.push(route);

    expect(await smoke(route.url)).toEqual({
      status: '503', by: 'placeholder', finding: 'the worker artifact route was still answered by version placeholder, not this deploy\'s cfcb250f, after 6s',
    });
  });

  test('judges at once an answer that names no version, as a failed connection or an edge error page is', async () => {
    const route = edge([null, 'cfcb250f']);

    servers.push(route);

    expect({ ...await smoke(route.url), asked: route.asked() }).toEqual({
      status: '200', by: '', finding: 'the worker artifact route answered 200 naming no version, so not as this deploy\'s version cfcb250f', asked: 1,
    });
  });
});

// ── The upload, and the one retry wrangler asks for (deploy-upload.sh) ──

/** Wrangler 4.145's last words on staging's reset deploy, 2026-10-09 (wrangler-2026-10-09_16-29-14_753.log, lines 4618
 *  and 4806): the version uploaded, then its container application could not be applied after five 404s. */
const RECORDED_PARTIAL_UPLOAD = 'Uploaded kinu-staging (31.90 sec)\n\n✘ [ERROR] The Worker version was deployed, but Wrangler could not '
  + 'finish applying its Durable Object-managed Container application settings. Re-run the same `wrangler deploy` command to retry '
  + 'and finish deployment.';

describe('the upload runs again once, and only when wrangler asks for it', () => {
  // The recovery wrangler defines for its own failure: the 2026-10-09 deploy that hit it stopped there, and its rerun
  // was refused by the account gate. Wrangler 4.149 reads the version back the same way (docs/DEPLOYMENT.md).
  test('the deploy replays the recorded wrangler recovery with identical arguments', async () => {
    const replayed = await runDeploy({ uploadRuns: [{ says: RECORDED_PARTIAL_UPLOAD, status: 1 }, { says: 'success', status: 0 }] });

    expect(replayed.uploads, replayed.stdout).toEqual([
      ['wrangler', 'deploy', '--tag', 'testsha', '--message', 'kinu staging testsha'],
      ['wrangler', 'deploy', '--tag', 'testsha', '--message', 'kinu staging testsha'],
    ]);
    expect(replayed.events).toContain('bun scripts/infra-verify.ts --phase=post-deploy');
  });

  test('a second refusal ends the upload: it is run twice, never a third time', async () => {
    const refused = await runDeploy({ uploadRuns: [
      { says: RECORDED_PARTIAL_UPLOAD, status: 1 }, { says: RECORDED_PARTIAL_UPLOAD, status: 1 }, { says: 'success', status: 0 },
    ] });

    expect(refused.uploads).toHaveLength(2);
    expect(refused.status).not.toBe(0);
    expect(refused.events).not.toContain('bun scripts/infra-verify.ts --phase=post-deploy');
  });

  test('any other failure is the upload\'s verdict, run once', async () => {
    const refused = '✘ [ERROR] A request to the Cloudflare API (/accounts/a/workers/scripts/kinu-staging/versions) failed.';

    const result = await runDeploy({ uploadRuns: [{ says: refused, status: 47 }, { says: 'success', status: 0 }] });

    expect(result.uploads).toHaveLength(1);
    expect(result.status).not.toBe(0);
    expect(result.events).not.toContain('bun scripts/infra-verify.ts --phase=post-deploy');
  });
});
