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

/** Shared secret-bearing command body every fixture route accepts. */
export const CommandSchema = v.object({
  command: v.optional(v.string()),
  path: v.optional(v.string()),
  contentBase64: v.optional(v.string()),
  cwd: v.optional(v.string()),
  timeoutMs: v.optional(v.number()),
});
export type ProbeCommand = v.InferOutput<typeof CommandSchema>;

/** Exec options the /exec route forwards verbatim. */
export interface ProbeExecOptions {
  timeout?: number;
  cwd?: string;
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
  writeFile(path: string, content: string, options?: { encoding?: string }): Promise<ProbeWriteReceipt | void>;
  stop(signal?: "SIGTERM" | "SIGINT" | "SIGKILL"): Promise<void>;
  destroy(): Promise<void>;
  prepare(): Promise<RunIdentity>;
}

/** One route, one SDK method. `/prepare` proves runtime identity outside
 *  Durable Object startup; `/destroy` tears down and `/stop` is restart-only. */
export function handleProbeOp(pathname: string, box: ProbeBox, command: ProbeCommand): Promise<Response> {
  switch (pathname) {
    case "/exec": {
      return (async () => {
        const started = Date.now();
        const options: ProbeExecOptions = { timeout: command.timeoutMs ?? 30_000 };
        const res = await box.exec(command.command ?? "", options);
        return Response.json({ ...res, wallMs: Date.now() - started });
      })();
    }
    case "/put":
      return box.writeFile(command.path ?? "", command.contentBase64 ?? "", { encoding: "base64" })
        .then(() => Response.json({ ok: true }));
    case "/stop":
      return box.stop("SIGTERM").then(() => Response.json({ ok: true }));
    case "/destroy":
      return box.destroy().then(() => Response.json({ ok: true }));
    case "/prepare":
      return box.prepare().then((identity) => Response.json(identity));
    default:
      return Promise.resolve(Response.json({ error: "unknown op" }, { status: 404 }));
  }
}
