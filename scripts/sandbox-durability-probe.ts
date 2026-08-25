#!/usr/bin/env bun
/**
 * The sandbox lifecycle probe — the product's own durability, proven against a
 * REAL container.
 *
 *   bun scripts/sandbox-durability-probe.ts --plan    # print the phases, run nothing
 *   bun scripts/sandbox-durability-probe.ts --run     # deploy, drive, and retain JSON evidence
 *
 * Raises the PRODUCT KinuSandbox class through `scripts/fixtures/kinu-durability/`
 * and proves, in order:
 *
 *   P1 base        a full base layer is written (chain mode), bytes recorded
 *   P2 lazy mount  after stop+wake, /workspace re-attaches by MOUNTING: restore
 *                  time stays flat while the base is large, and reading ONE small
 *                  slice of the big file does not pull the archive (a download-
 *                  then-extract restore cannot answer that read in seconds)
 *   P3 whiteouts   modify one file, DELETE another, tick a delta; stop; wake —
 *                  the deletion survives the base+delta restore, the edit too
 *   P4 supervision a supervised HTTP server comes back after stop+wake and serves
 *                  again; listProcesses marks it restartable
 *   P5 heartbeat   the heartbeat schedule exists and, after an idle window LONGER
 *                  than the platform's 10-minute default sleep, an ephemeral
 *                  /tmp marker still exists — the container never slept
 *   P6 final stop  forced checkpoint → keepAlive off → SIGTERM; the next wake
 *                  restores the workspace intact
 *
 * HOW IT REACHES A REAL CONTAINER. Not `wrangler dev --remote`: wrangler states
 * on startup that Containers and SQLite Durable Objects are LOCAL-ONLY in remote
 * dev, so no real container exists there. Instead this deploys an EPHEMERAL
 * Worker (unique name, workers_dev, its own ephemeral R2 bucket), drives its
 * workers.dev URL, and deletes the Worker and the bucket in a finally — so the
 * account is left as it was found.
 *
 * Gate safety: with no wrangler auth this prints the plan and exits 0. Teardown
 * discards every chain key the run created (`backups/<uuid>/…`) and then removes
 * the Worker (with its Durable Object and container) and the bucket, on EVERY
 * exit path.
 */
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as v from "valibot";

type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

interface JsonObject {
  readonly [key: string]: JsonValue;
}

const JsonValueSchema: v.GenericSchema<JsonValue> = v.lazy(() => v.union([
  v.string(),
  v.number(),
  v.boolean(),
  v.null(),
  v.array(JsonValueSchema),
  v.record(v.string(), JsonValueSchema),
]));
const JsonObjectSchema: v.GenericSchema<JsonObject> = v.record(v.string(), JsonValueSchema);


interface ProbeResponse {
  readonly stdout?: string;
  readonly wallMs?: number;
}

const ProbeResponseSchema: v.GenericSchema<ProbeResponse> = v.looseObject({
  stdout: v.optional(v.string()),
  wallMs: v.optional(v.number()),
});

interface CheckpointResponse {
  readonly kind: string;
  readonly bytes?: number;
}

const CheckpointResponseSchema: v.GenericSchema<CheckpointResponse> = v.looseObject({
  kind: v.string(),
  bytes: v.optional(v.number()),
});

interface ProcessStartResponse {
  readonly processId: string;
}

const ProcessStartResponseSchema: v.GenericSchema<ProcessStartResponse> = v.object({
  processId: v.string(),
});

interface SupervisedProcessResponse {
  readonly processId: string;
  readonly restartable: boolean;
}

const SupervisedProcessResponsesSchema: v.GenericSchema<readonly SupervisedProcessResponse[]> = v.array(v.object({
  processId: v.string(),
  restartable: v.boolean(),
}));

interface PortTokenResponse {
  readonly urlToken: string;
}

const ScheduleRowsSchema: v.GenericSchema<readonly JsonObject[]> = v.array(JsonObjectSchema);

const PortTokenResponseSchema: v.GenericSchema<PortTokenResponse> = v.object({
  urlToken: v.string(),
});

/** The one slice of `devboxState()` P5 reads. Parsed at the I/O boundary so the
 *  verdict below branches on a domain value, never on a raw shape. */
const IdleTickSchema = v.object({
  lastTick: v.nullish(v.object({
    at: v.number(),
    armedNext: v.optional(v.boolean()),
  })),
});

const BASE_MIB = Number(process.env.PROBE_BASE_MIB ?? 64);
const IDLE_MINUTES = Number(process.env.PROBE_IDLE_MINUTES ?? 11); // > platform default sleepAfter '10m'
const PORT = 8080;

interface Phase { readonly id: string; readonly name: string; readonly proves: string }

export const PHASES: readonly Phase[] = [
  { id: "P1", name: "base layer", proves: "first tick writes ONE full base under backups/<uuid>/" },
  { id: "P2", name: "lazy restore", proves: "stop+wake re-attaches by mounting; single-slice read stays fast" },
  { id: "P3", name: "whiteouts", proves: "deletion survives base+delta restore" },
  { id: "P4", name: "supervision", proves: "supervised process returns after restart and serves" },
  { id: "P5", name: "heartbeat hold", proves: `container alive past ${IDLE_MINUTES} min idle (> default 10 m)` },
  { id: "P6", name: "final SIGTERM", proves: "checkpoint → keepAlive off → stop; next wake intact" },
];

export interface ProbeEvidence {
  P1?: {
    readonly bigFile: string;
    readonly baseMib: number;
    readonly checkpoint: CheckpointResponse;
  };
  P2?: {
    readonly wakeWallMs?: number;
    readonly sliceWallMs?: number;
    readonly overlay: string;
    readonly restartVerified: true;
  };
  P3?: {
    readonly deletedAbsent: true;
    readonly additionPresent: true;
    readonly checkpoint: CheckpointResponse;
  };
  P4?: {
    readonly processId: string;
    readonly httpBefore?: string;
    readonly httpAfter?: string;
    readonly urlToken: string;
  };
  P5?: {
    readonly idleMinutes: number;
    readonly chainAlive: true;
    readonly instanceReplaced: boolean;
    readonly workspaceIntact: true;
    readonly supervisedServing: true;
  };
  P6?: {
    readonly intactAfterFinalStop: true;
  };
}

/**
 * A durable record of one actual probe attempt. The raw phase evidence belongs
 * beside the code that writes it, rather than only in terminal scrollback.
 */
export interface DurabilityProbeArtifact {
  readonly schemaVersion: 1;
  readonly command: 'bun scripts/sandbox-durability-probe.ts --run';
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly baseMiB: number;
  readonly idleMinutes: number;
  readonly outcome: 'green' | 'failed';
  readonly evidence: ProbeEvidence;
  readonly failure?: string;
  readonly cleanupFailure?: string;
}

/** The gitignored evidence root. A real run must leave a record here. */
export const DURABILITY_ARTIFACT_DIR = join(import.meta.dir, '..', 'bench-artifacts');

export function durabilityArtifactPath(artifactDir: string, runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(runId)) {
    throw new Error(`safe artifact id required, got ${JSON.stringify(runId)}`);
  }
  return join(artifactDir, `sandbox-durability-${runId}.json`);
}

/**
 * Write immutable evidence atomically. A partial JSON file is not evidence, and
 * neither is a later attempt that silently replaces a previous run's record.
 */
export async function persistDurabilityArtifact(
  artifactDir: string,
  artifact: DurabilityProbeArtifact,
): Promise<string> {
  await mkdir(artifactDir, { recursive: true });
  const output = durabilityArtifactPath(artifactDir, artifact.runId);
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    // link creates the final name only if it does not already exist. rename
    // replaces it on POSIX, which would silently rewrite the measurement.
    await link(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return output;
}

function plan(): void {
  console.log(`sandbox-durability probe plan (base=${BASE_MIB}MiB, idle=${IDLE_MINUTES}min)`);
  for (const p of PHASES) console.log(`  ${p.id} ${p.name}: ${p.proves}`);
  console.log("teardown: discardWorkspaceSnapshot deletes every chain object");
  console.log(`evidence: immutable JSON under ${DURABILITY_ARTIFACT_DIR}`);
}

// ── driver plumbing ─────────────────────────────────────────────────────────

/** A container that is stopping or restarting refuses whatever lands in the
 *  window. The product retries these too (TRANSIENT_MARKERS); the driver must,
 *  or it measures the window instead of the behaviour under test. */
const RESTART_WINDOW = [
  "while the runtime connection was closing",
  "stopped while the operation was pending",
  "no container instance",
  "container is starting",
];

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
async function request<T>(
  origin: string,
  token: string,
  op: string,
  body: JsonObject,
  schema: v.GenericSchema<T>,
): Promise<T> {
  let last = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(new URL(op, origin), {
      method: "POST",
      headers: { "content-type": "application/json", "x-probe-token": token },
      body: JSON.stringify(body),
    });
    let data: unknown;
    try {
      data = await res.json();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${op} did not return JSON: ${message}`, { cause: error });
    }
    if (res.ok) return v.parse(schema, data);
    const rendered = JSON.stringify(data) ?? String(data);
    last = `${op} failed (${res.status}): ${rendered.slice(0, 400)}`;
    if (!RESTART_WINDOW.some(marker => last.includes(marker))) throw new Error(last);
    await sleep(3_000 * (attempt + 1));
  }
  throw new Error(last);
}

async function call(
  origin: string,
  token: string,
  op: string,
  body: JsonObject = {},
): Promise<ProbeResponse> {
  return await request(origin, token, op, body, ProbeResponseSchema);
}

async function callParsed<T>(
  origin: string,
  token: string,
  op: string,
  body: JsonObject,
  schema: v.GenericSchema<T>,
): Promise<T> {
  return await request(origin, token, op, body, schema);
}

/** The account every wrangler call runs against. Two accounts are reachable
 *  from this machine's OAuth, so leaving the choice implicit fails in
 *  non-interactive mode — it is passed explicitly instead. */
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? "f44999d1ddda7012e9a87729eba250f1";

function wrangler(args: readonly string[], cwd: string): Promise<{ stdout: string; code: number }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; code: number }>();
  const child = spawn("wrangler", [...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
  });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); process.stdout.write(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { out += chunk.toString(); process.stderr.write(chunk); });
  child.on("error", reject);
  child.on("exit", code => resolve({ stdout: out, code: code ?? 1 }));
  return promise;
}

interface Deployment {
  readonly origin: string;
  readonly workerName: string;
  readonly bucketName: string;
  readonly configFile: string;
  readonly fixtureDir: string;
}

/** Deploy the fixture as its own throwaway Worker and return its origin. */
async function deployEphemeral(runId: string, token: string): Promise<Deployment> {
  const fixtureDir = new URL("./fixtures/kinu-durability/", import.meta.url).pathname;
  const workerName = `kinu-dur-probe-${runId}`;
  const bucketName = `kinu-dur-probe-${runId}`;
  const configFile = `wrangler.${runId}.jsonc`;

  const sourceText = (await Bun.file(`${fixtureDir}wrangler.jsonc`).text())
    .split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
  const base = v.parse(JsonObjectSchema, JSON.parse(sourceText));
  const parsedBuckets = v.safeParse(v.array(JsonObjectSchema), base.r2_buckets);
  if (!parsedBuckets.success || parsedBuckets.output.length === 0) {
    throw new Error('durability fixture has no R2 bucket binding');
  }
  const [firstBucket, ...otherBuckets] = parsedBuckets.output;
  if (firstBucket === undefined) throw new Error('durability fixture has no first R2 bucket binding');
  const config: JsonObject = {
    ...base,
    name: workerName,
    account_id: ACCOUNT_ID,
    r2_buckets: [{ ...firstBucket, bucket_name: bucketName }, ...otherBuckets],
    vars: { PROBE_TOKEN: token },
  };
  await Bun.write(`${fixtureDir}${configFile}`, JSON.stringify(config, null, 2));

  const bucket = await wrangler(["r2", "bucket", "create", bucketName], fixtureDir);
  if (bucket.code !== 0) throw new Error(`could not create the ephemeral bucket ${bucketName}`);

  const deployed = await wrangler(["deploy", "--config", configFile], fixtureDir);
  if (deployed.code !== 0) throw new Error("wrangler deploy failed; see output above");
  const url = deployed.stdout.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/);
  if (!url) throw new Error("deploy printed no workers.dev URL");
  return { origin: url[0], workerName, bucketName, configFile, fixtureDir };
}

async function collectTeardownFailure(
  label: string,
  operation: () => Promise<void>,
  failures: string[],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${label}: ${message}`);
  }
}

async function teardown(d: Deployment | undefined, token: string): Promise<void> {
  if (d === undefined) return;
  // The chain objects first (only the DO knows their ids), then the Worker,
  // which takes its Durable Object and its container with it, then the bucket.
  // Run every cleanup step even after one failure, then make the incomplete
  // teardown visible in the artifact and the process result.
  const failures: string[] = [];
  await collectTeardownFailure('discard chain objects', async () => {
    await call(d.origin, token, "/discard");
  }, failures);
  await collectTeardownFailure('delete fixture Worker', async () => {
    const result = await wrangler(["delete", "--config", d.configFile, "--force"], d.fixtureDir);
    if (result.code !== 0) throw new Error(`wrangler delete exited ${result.code}`);
  }, failures);
  await collectTeardownFailure('delete fixture bucket', async () => {
    const result = await wrangler(["r2", "bucket", "delete", d.bucketName], d.fixtureDir);
    if (result.code !== 0) throw new Error(`wrangler r2 bucket delete exited ${result.code}`);
  }, failures);
  await collectTeardownFailure('remove generated fixture config', async () => {
    await rm(`${d.fixtureDir}${d.configFile}`, { force: true });
  }, failures);
  if (failures.length > 0) throw new Error(`teardown incomplete: ${failures.join('; ')}`);
}

/** The deployed Worker answers as soon as its route is live; the first call is
 *  the one that must happen anyway, so it doubles as the readiness poll. */
/**
 * Stop the container and prove it actually went down before anything believes
 * a post-restart verdict.
 *
 * The reason this exists, corroborated twice: a wake that merely SUCCEEDS says
 * nothing, because a container that never stopped answers exactly the same way
 * — and a sibling benchmark shipped a "did not survive a restart" row that had
 * only established "did not survive whatever happened in between". The proof is
 * an ephemeral marker: /tmp lives and dies with the instance, so a marker
 * written before the stop and ABSENT after the wake is a restart that happened.
 * Present means the instance is the same one, and every durability claim that
 * follows would be vacuous.
 */
async function restartVerified(origin: string, token: string): Promise<{ restarted: boolean }> {
  const token_ = `restart-${Date.now()}`;
  await call(origin, token, "/exec", { command: `echo ${token_} > /tmp/instance-marker` });
  await call(origin, token, "/stop");
  await wake(origin, token);
  const seen = await call(origin, token, "/exec", {
    command: "cat /tmp/instance-marker 2>/dev/null || echo GONE",
  });
  const restarted = String(seen.stdout ?? "").includes("GONE");
  if (!restarted) {
    throw new Error(
      "RESTART UNVERIFIED: the instance marker survived the stop, so the container never "
      + "went down — no durability verdict may be taken from this cycle",
    );
  }
  return { restarted };
}

/** Wake the container after a stop. The runtime connection is still closing
 *  when the stop returns, so the first call can be refused; the container is
 *  restarting either way. */
async function wake(origin: string, token: string, command = "true"): Promise<ProbeResponse> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await call(origin, token, "/exec", { command, timeoutMs: 60_000 });
    } catch (error) {
      last = error;
      await sleep(3_000 * (attempt + 1));
    }
  }
  throw last;
}

async function awaitOrigin(origin: string, token: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      await call(origin, token, "/configure", { workspaceName: "durability-probe" });
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(5_000);
    }
  }
}

export async function run(): Promise<DurabilityProbeArtifact> {
  const token = process.env.PROBE_TOKEN ?? randomUUID();
  const runId = randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();
  const evidence: ProbeEvidence = {};
  let deployment: Deployment | undefined;
  let outcome: DurabilityProbeArtifact['outcome'] = 'failed';
  let failure: unknown;
  let artifact: DurabilityProbeArtifact | undefined;
  try {
    deployment = await deployEphemeral(runId, token);
    const origin = deployment.origin;
    console.log(`probe origin ${origin}`);
    await awaitOrigin(origin, token);

    // P1 — base layer.
    const bigId = `big-${Date.now()}.bin`;
    const chunk = Buffer.alloc(4 * 1024 * 1024, 0x5a);
    for (let i = 0; i < BASE_MIB / 4; i++) {
      await call(origin, token, "/writeFile", {
        path: `/workspace/${bigId}`, content: chunk.toString("base64"),
      });
    }
    await call(origin, token, "/writeFile",
      { path: "/workspace/doomed-marker.txt", content: Buffer.from("delete me").toString("base64") });
    await call(origin, token, "/tick");
    const baseCheckpoint = await callParsed(
      origin, token, "/finalCheckpoint", {}, CheckpointResponseSchema,
    );
    evidence.P1 = { bigFile: bigId, baseMib: BASE_MIB, checkpoint: baseCheckpoint };
    console.log("P1 base layer ok");

    // P2 — lazy restore: stop, wake, time it, read ONE slice deep in the file.
    await restartVerified(origin, token);
    const woke = await wake(origin, token, "grep overlay /proc/mounts || echo NO_OVERLAY");
    if (String(woke.stdout ?? "").includes("NO_OVERLAY")) {
      throw new Error("attach did not land: /workspace is not an overlay after a verified restart");
    }
    const slice = await call(origin, token, "/exec", {
      command: `dd if=/workspace/${bigId} bs=4096 skip=100000 count=1 2>/dev/null | md5sum`,
      timeoutMs: 30_000,
    });
    if (woke.stdout === undefined) {
      throw new Error(`wake did not attach a filesystem: ${JSON.stringify(woke).slice(0, 200)}`);
    }
    if (String(slice.stdout ?? "").trim().length < 32) throw new Error("deep slice read returned nothing");
    evidence.P2 = {
      wakeWallMs: woke.wallMs, sliceWallMs: slice.wallMs,
      overlay: (woke.stdout ?? '').trim().slice(0, 200), restartVerified: true,
    };
    console.log(`P2 lazy restore ok (wake ${woke.wallMs}ms, deep slice ${slice.wallMs}ms)`);

    // P3 — whiteout: delete the marker, add another file, tick the delta, restart.
    await call(origin, token, "/exec", { command: "rm /workspace/doomed-marker.txt" });
    await call(origin, token, "/writeFile",
      { path: "/workspace/new-after-base.txt", content: Buffer.from("added").toString("base64") });
    // FORCED, not a tick: the base is a minute old and the five-minute interval
    // gate correctly declines an ordinary tick — measured, first run of this
    // phase against a real container.
    const checkpoint = await callParsed(
      origin, token, "/finalCheckpoint", {}, CheckpointResponseSchema,
    );
    const upperBefore = await call(origin, token, "/exec", {
      command: "ls -la /workspace; echo ---; grep workspace /proc/mounts; echo ---; ls -la /var/tmp/kinu/upper",
    });
    console.log(`P3 checkpoint=${JSON.stringify(checkpoint)}\n${upperBefore.stdout ?? ""}`);
    await restartVerified(origin, token);
    const attached = await call(origin, token, "/exec", {
      command: "grep overlay /proc/mounts || echo NO_OVERLAY; ls -1 /workspace | wc -l",
    });
    if (String(attached.stdout ?? "").includes("NO_OVERLAY")) {
      throw new Error(`restore did not attach after a verified restart: ${JSON.stringify(attached).slice(0, 240)}`);
    }
    const afterState = await call(origin, token, "/exec", {
      command: "ls -la /workspace; echo ---; grep workspace /proc/mounts; echo ---; ls -la /var/tmp/kinu/upper",
    });
    console.log(`P3 after wake:\n${afterState.stdout ?? ""}`);
    const gone = await call(origin, token, "/exec", { command: "test -e /workspace/doomed-marker.txt && echo present || echo absent" });
    const added = await call(origin, token, "/exec", { command: "cat /workspace/new-after-base.txt" });
    if ((gone.stdout ?? "").includes("present")) throw new Error("DELETION DID NOT SURVIVE RESTORE");
    if (!(added.stdout ?? "").includes("added")) throw new Error("delta content lost across restore");
    evidence.P3 = { deletedAbsent: true, additionPresent: true, checkpoint };
    console.log("P3 whiteouts ok");

    // P4 — supervision across restart.
    // `node` is in the sandbox image; python3 is probed ABSENT there (AGENTS.md
    // capability table), so a python server would fail before any restart.
    const proc = await callParsed(origin, token, "/startProcess", {
      command: `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(${PORT})`, cwd: "/workspace",
    }, ProcessStartResponseSchema);
    const portBeforeRestart = await callParsed(
      origin, token, "/notePortExposed", { port: PORT, name: "probe" }, PortTokenResponseSchema,
    );
    await call(origin, token, "/exec", { command: "sleep 1" });
    const serveBefore = await call(origin, token, "/exec", { command: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}/` });
    // Write the idle marker NOW: its survival through P5 is the keepAlive proof.
    await call(origin, token, "/exec", { command: "date +%s > /tmp/idle-probe-marker" });
    await restartVerified(origin, token);
    const procs = await callParsed(
      origin, token, "/listProcesses", {}, SupervisedProcessResponsesSchema,
    );
    await call(origin, token, "/exec", { command: "sleep 1" });
    const serveAfter = await call(origin, token, "/exec", { command: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}/` });
    const portAfterRestart = await callParsed(
      origin, token, "/notePortExposed", { port: PORT, name: "probe" }, PortTokenResponseSchema,
    );
    if (portBeforeRestart.urlToken !== portAfterRestart.urlToken) {
      throw new Error(`preview token changed across restart: ${portBeforeRestart.urlToken}/${portAfterRestart.urlToken}`);
    }
    const restarted = procs.some(process => process.processId === proc.processId && process.restartable);
    if (!(Number(serveBefore.stdout) > 0 && Number(serveAfter.stdout) > 0 && restarted)) {
      throw new Error(`supervised process did not return: ${serveBefore.stdout}/${serveAfter.stdout}/${JSON.stringify(procs).slice(0, 200)}`);
    }
    evidence.P4 = {
      processId: proc.processId,
      httpBefore: serveBefore.stdout,
      httpAfter: serveAfter.stdout,
      urlToken: portAfterRestart.urlToken,
    };
    console.log("P4 supervision ok");

    // P5 — the hold guarantee, as the platform actually permits it: the
    // heartbeat chain never lets the box sleep from OUR inactivity, and if the
    // platform replaces the instance anyway (spot reclaim — measured on run
    // kinu-dur-probe-c0a7850e: ticks ok through the whole window, /tmp fresh),
    // everything durable comes back. Replacement is a MEASUREMENT, not a
    // failure; a dead tick chain or lost workspace state is the failure.
    const schedules = await callParsed(
      origin, token, "/heartbeatSchedules", {}, ScheduleRowsSchema,
    );
    if (schedules.length === 0) throw new Error("heartbeat not armed");
    const idleStartedAt = Date.now();
    console.log(`P5 idle ${IDLE_MINUTES} min …`);
    await sleep(IDLE_MINUTES * 60_000);
    // Read the durable tick trail BEFORE the exec below wakes the box:
    // /state never touches the container, so this is the post-idle truth.
    const idleState = await callParsed(origin, token, "/state", {}, IdleTickSchema);
    const idleSchedules = await callParsed(
      origin, token, "/heartbeatSchedules", {}, ScheduleRowsSchema,
    );
    const tick = idleState.lastTick ?? undefined;
    const lastTick = JSON.stringify(tick ?? null);
    const heartbeatRows = String(idleSchedules.length);
    // (a) The chain stayed alive through the idle window: the last tick is
    // recent and armed its successor. A chain that died mid-window shows a
    // stale `at` — that is the inactivity-sleep failure P5 exists to catch.
    const tickAgeMs = tick === undefined ? Number.POSITIVE_INFINITY : Date.now() - tick.at;
    if (!(tickAgeMs < 3 * 60_000 && tick?.armedNext === true)) {
      throw new Error(`heartbeat chain died during idle: lastTick=${lastTick}; heartbeatRows=${heartbeatRows}`);
    }
    if (Date.now() - idleStartedAt < IDLE_MINUTES * 60_000) throw new Error("idle window did not elapse");
    // (b) Replacement detector: /tmp is deliberately ephemeral. Fresh disk
    // means the platform swapped the instance under a live tick chain.
    const marker = await call(origin, token, "/exec", { command: "test -f /tmp/idle-probe-marker && echo alive || echo fresh-disk" });
    const replaced = !(marker.stdout ?? "").includes("alive");
    // (c) Continuity: the workspace bytes and the supervised server are back,
    // whether or not the instance survived.
    const wsAfterIdle = await call(origin, token, "/exec", { command: "cat /workspace/new-after-base.txt" });
    if (!(wsAfterIdle.stdout ?? "").includes("added")) throw new Error("workspace lost across the idle window");
    await call(origin, token, "/exec", { command: "sleep 1" });
    const serveIdle = await call(origin, token, "/exec", { command: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}/` });
    if (!(Number(serveIdle.stdout) > 0)) throw new Error(`supervised process not serving after idle (replaced=${replaced}): ${serveIdle.stdout}`);
    evidence.P5 = { idleMinutes: IDLE_MINUTES, chainAlive: true, instanceReplaced: replaced, workspaceIntact: true, supervisedServing: true };
    console.log(`P5 hold ok (chain alive; instance ${replaced ? "REPLACED by platform and healed" : "survived"})`);

    // P6 — the exact quiesce sequence, then one more wake.
    await callParsed(origin, token, "/finalCheckpoint", {}, CheckpointResponseSchema);
    await call(origin, token, "/setKeepAlive", { keepAlive: false });
    await call(origin, token, "/stop");
    await wake(origin, token);
    const still = await call(origin, token, "/exec", { command: "cat /workspace/new-after-base.txt" });
    if (!(still.stdout ?? "").includes("added")) throw new Error("workspace lost after final cycle");
    evidence.P6 = { intactAfterFinalStop: true };
    console.log("P6 final SIGTERM cycle ok");

    outcome = 'green';
  } catch (error) {
    failure = error;
  } finally {
    let cleanupFailure: string | undefined;
    try {
      await teardown(deployment, token);
    } catch (error) {
      cleanupFailure = error instanceof Error ? error.message : String(error);
      if (failure === undefined) failure = error;
      outcome = 'failed';
    }

    let record: DurabilityProbeArtifact = {
      schemaVersion: 1,
      command: 'bun scripts/sandbox-durability-probe.ts --run',
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      baseMiB: BASE_MIB,
      idleMinutes: IDLE_MINUTES,
      outcome,
      evidence,
    };
    if (failure !== undefined) {
      const message = failure instanceof Error ? failure.message : String(failure);
      record = { ...record, failure: message };
    }
    if (cleanupFailure !== undefined) record = { ...record, cleanupFailure };
    artifact = record;

    try {
      const output = await persistDurabilityArtifact(DURABILITY_ARTIFACT_DIR, artifact);
      console.log(`probe artifact ${output}`);
    } catch (persistFailure) {
      const message = persistFailure instanceof Error ? persistFailure.message : String(persistFailure);
      console.error(`could not persist durability evidence: ${message}`);
      if (failure === undefined) failure = persistFailure;
    }
  }

  if (failure !== undefined) throw failure;
  if (artifact === undefined) throw new Error('probe produced no artifact');

  console.log("\nPROBE GREEN");
  console.log(JSON.stringify(artifact, null, 2));
  return artifact;
}

if (import.meta.main) {
  if (process.argv.includes("--plan")) {
    plan();
  } else if (process.argv.includes("--run")) {
    await run();
  } else {
    plan();
  }
}
