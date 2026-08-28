/**
 * Runtime-neutral contract between the fuse-probe Worker fixture, its driver
 * and its offline test suite. Nothing here may depend on a runtime-specific
 * global beyond standard Web/ES APIs (valibot, Response): this file is
 * typechecked BOTH by the workers-types fixture project and by the bun-typed
 * scripts project, so it must stay free of Buffer/Bun/node globals.
 *
 * Owned here (single source of truth):
 *   - SANDBOX_IMAGE / SANDBOX_IMAGE_VERSION — the image identity the whole
 *     probe is defined against; wrangler.jsonc mirrors the literal and the
 *     test suite pins the three together.
 *   - RunIdentitySchema / RunIdentity — what a fresh boot proved about its
 *     runtime.
 *   - ImageIdentityError — the typed infrastructure failure for a container
 *     reporting a different SANDBOX_VERSION.
 *   - CommandSchema / ProbeCommand, ProbeBox, handleProbeOp — the one-route-
 *     one-method JSON surface of the fixture Worker.
 *   - isAuthorized — the pure token gate every request passes first.
 */

import * as v from "valibot";

/** The image this probe is defined against. One source of truth: the fixture
 *  config must carry exactly this tag (pinned by the test suite), and the
 *  fixture Durable Object refuses to serve unless the running container
 *  reports a matching SANDBOX_VERSION. */
export const SANDBOX_IMAGE = "docker.io/cloudflare/sandbox:0.12.8";

/** The SANDBOX_VERSION the configured image must report, derived from the tag
 *  so the two cannot drift apart silently. */
export const SANDBOX_IMAGE_VERSION = SANDBOX_IMAGE.split(":").pop()!;

/** What a fresh boot proved about its own runtime. Captured by the fixture
 *  DO's onStart on every container start and held process-locally: identity is
 *  re-derived per boot instead of persisted, so a destroyed run leaves no
 *  state behind. */
export const RunIdentitySchema = v.looseObject({
  configuredImage: v.string(),
  expectedVersion: v.string(),
  actualVersion: v.string(),
  /** SHA-256 over the exact reported version bytes — the fingerprint of what
   *  the runtime claimed, not just a prose rendering of it. */
  actualVersionDigest: v.string(),
  bunVersion: v.optional(v.string()),
});
export type RunIdentity = v.InferOutput<typeof RunIdentitySchema>;

/** Typed infrastructure failure: the running container is not the image this
 *  deployment configured, so anything it could measure would describe a
 *  different platform than the artifact claims. */
export class ImageIdentityError extends Error {
  override readonly name = "ImageIdentityError";
  constructor(
    readonly configuredImage: string,
    readonly actualVersion: string | undefined,
  ) {
    super(
      `container SANDBOX_VERSION ${actualVersion ?? "unreported"} does not match `
      + `configured image ${configuredImage}`,
    );
  }
}

/** Pure token gate: an unset secret or any other header value refuses. */
export function isAuthorized(envToken: string | undefined, presented: string | null): boolean {
  return envToken !== undefined && presented === envToken;
}

/** Shared command body for the short synchronous fixture routes. */
export const CommandSchema = v.object({
  command: v.optional(v.string()),
  path: v.optional(v.string()),
  contentBase64: v.optional(v.string()),
  cwd: v.optional(v.string()),
  timeoutMs: v.optional(v.number()),
});
export type ProbeCommand = v.InferOutput<typeof CommandSchema>;

/** Stable driver-owned identity for one durable process record. */
export const OperationIdSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u, 'operationId must be a safe process identifier'),
);

/** `/start` accepts no ambient execution controls. A driver names both the
 * durable process record and the command it intends to run. */
export const StartProcessSchema = v.strictObject({
  operationId: OperationIdSchema,
  command: v.pipe(v.string(), v.minLength(1)),
});
export type StartProcessRequest = v.InferOutput<typeof StartProcessSchema>;

/** `/poll` is intentionally smaller than `/start`: a redrive can only observe
 * the process it named, never replace its command. */
export const PollProcessSchema = v.strictObject({
  operationId: OperationIdSchema,
});
export type PollProcessRequest = v.InferOutput<typeof PollProcessSchema>;

export type ProbeRequest = ProbeCommand | StartProcessRequest | PollProcessRequest;

/** Parsed JSON may be one of the three route bodies. Keeping this schema-
 * derived type at the boundary prevents an untyped request dictionary from
 * leaking into route dispatch. */
type ProbeRequestInput =
  | v.InferInput<typeof CommandSchema>
  | v.InferInput<typeof StartProcessSchema>
  | v.InferInput<typeof PollProcessSchema>;

/** Parse the body against the route's exact vocabulary. This is the request
 * boundary; malformed requests become JSON errors in the Worker. */
export function parseProbeRequest(pathname: string, input: ProbeRequestInput): ProbeRequest {
  switch (pathname) {
    case '/start': return v.parse(StartProcessSchema, input);
    case '/poll': return v.parse(PollProcessSchema, input);
    default: return v.parse(CommandSchema, input);
  }
}

/** Exec options the synchronous setup and read-only stages forward verbatim. */
export interface ProbeExecOptions {
  timeout?: number;
  cwd?: string;
}

export interface ProbeProcess {
  readonly id: string;
  readonly status: string;
  readonly exitCode?: number;
  getLogs(): Promise<{ stdout: string; stderr: string }>;
}

export interface ProbeProcessStartOptions {
  processId: string;
  autoCleanup: false;
}

/** What a successful write proves. Structural on purpose: the SDK's richer
 *  write result satisfies this without a cast, and the route ignores it. */
export interface ProbeWriteReceipt {
  success: boolean;
  path: string;
  timestamp: string;
}

/** The slice of the sandbox surface the routes forward. Structural on
 *  purpose: the dispatch is testable against fakes without a container. */
export interface ProbeBox {
  exec(command: string, options?: ProbeExecOptions): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  startProcess(command: string, options: ProbeProcessStartOptions): Promise<ProbeProcess>;
  getProcess(processId: string): Promise<ProbeProcess | null>;
  writeFile(path: string, content: string, options?: { encoding?: string }): Promise<ProbeWriteReceipt | void>;
  stop(signal?: "SIGTERM" | "SIGINT" | "SIGKILL"): Promise<void>;
  destroy(): Promise<void>;
  prepare(): Promise<RunIdentity>;
}

/** Destroy a probe's disposable runtime without leaving a process behind.
 * Every process is signalled even if another signal fails; container teardown
 * and durable-storage clearance then run before the accumulated failure is
 * returned to the driver. */
export async function destroyProbeRuntime(
  listProcesses: () => Promise<readonly { readonly id: string }[]>,
  killProcess: (processId: string) => Promise<void>,
  destroySandbox: () => Promise<void>,
  clearStorage: () => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  let processes: readonly { readonly id: string }[] = [];
  try {
    processes = await listProcesses();
  } catch (error) {
    failures.push(error);
  }
  for (const process of processes) {
    try {
      await killProcess(process.id);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await destroySandbox();
  } catch (error) {
    failures.push(error);
  }
  try {
    await clearStorage();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'failed to terminate every fuse probe process before destroy');
  }
}


function startRequest(request: ProbeRequest): StartProcessRequest {
  if ('operationId' in request && 'command' in request) return request;
  throw new Error('start request did not pass StartProcessSchema');
}

function pollRequest(request: ProbeRequest): PollProcessRequest {
  if ('operationId' in request && !('command' in request)) return request;
  throw new Error('poll request did not pass PollProcessSchema');
}

function commandRequest(request: ProbeRequest): ProbeCommand {
  if (!('operationId' in request)) return request;
  throw new Error('synchronous route did not pass CommandSchema');
}

async function processResponse(
  operationId: string,
  process: ProbeProcess,
  started?: boolean,
): Promise<Response> {
  const settled = process.status !== 'starting' && process.status !== 'running';
  const state = {
    operationId,
    status: process.status,
    exitCode: settled ? process.exitCode ?? null : null,
    started,
  };
  if (!settled) return Response.json(state);
  return Response.json({ ...state, ...(await process.getLogs()) });
}

/** Route process control through durable Sandbox process records. `/start`
 * redrives by operation id; `/poll` observes a settled record and returns its
 * complete logs. */
export function handleProbeOp(pathname: string, box: ProbeBox, command: ProbeRequest): Promise<Response> {
  switch (pathname) {
    case '/start': {
      const request = startRequest(command);
      return box.getProcess(request.operationId).then(async (existing) => {
        if (existing !== null) return processResponse(request.operationId, existing, false);
        const process = await box.startProcess(request.command, {
          processId: request.operationId,
          autoCleanup: false,
        });
        return processResponse(request.operationId, process, true);
      });
    }
    case '/poll': {
      const request = pollRequest(command);
      return box.getProcess(request.operationId).then(async (process) => {
        if (process === null) {
          return Response.json({ error: `process ${request.operationId} not found` }, { status: 404 });
        }
        return processResponse(request.operationId, process);
      });
    }
    case '/exec': {
      const request = commandRequest(command);
      return (async () => {
        const started = Date.now();
        const options: ProbeExecOptions = { timeout: request.timeoutMs ?? 30_000 };
        const res = await box.exec(request.command ?? '', options);
        return Response.json({ ...res, wallMs: Date.now() - started });
      })();
    }
    case '/put': {
      const request = commandRequest(command);
      return box.writeFile(request.path ?? '', request.contentBase64 ?? '', { encoding: 'base64' })
        .then(() => Response.json({ ok: true }));
    }
    case '/stop':
      return box.stop('SIGTERM').then(() => Response.json({ ok: true }));
    case '/destroy':
      return box.destroy().then(() => Response.json({ ok: true }));
    case '/prepare':
      return box.prepare().then((identity) => Response.json(identity));
    default:
      return Promise.resolve(Response.json({ error: 'unknown op' }, { status: 404 }));
  }
}
