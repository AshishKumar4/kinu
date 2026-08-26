/**
 * BENCHMARK FIXTURE — not product surface and not deployed by `bun run
 * deploy`. `scripts/bench-fuse-probe.ts` publishes it as an EPHEMERAL
 * deployment, drives its workers.dev origin, and destroys the runtime, the
 * container application and the Worker in a finally.
 *
 * The Durable Object is FuseProbeBox, a thin subclass of the UPSTREAM
 * `@cloudflare/sandbox` Sandbox — deliberately NOT KinuSandbox: KinuSandbox
 * arms a snapshot tick whose archive work would land inside this probe's
 * latency measurements. The reasoning is fixtures/r2-bench/worker.ts's,
 * unchanged. FuseProbeBox adds only lifecycle proof:
 *
 *   - onStart runs the SDK hook only. Container probes cannot run inside its
 *     blockConcurrencyWhile window without risking a forced DO reset.
 *   - `/prepare` verifies the image and bun after startup, before measurement.
 *     A mismatch throws ImageIdentityError.
 *   - destroy() is the one disposable method: the SDK's own teardown
 *     (mounts, tunnels, container instance) followed by clearing this
 *     ephemeral DO's storage, so nothing outlives the run.
 *
 * The token-guarded JSON API is a thin forwarder: every route maps onto one
 * SDK method via handleProbeOp from ./worker-contract, so what the probe
 * measures is the platform, not this file. Routes: `/exec`, `/put`, `/prepare`,
 * `/stop` (restart only), and `/destroy` (teardown).
 * Everything measured lives in probe.ts, which the driver uploads through
 * `/put` and runs through `/exec`. Lifecycle wiring is pinned by source-text
 * assertions in bench-fuse-probe.test.ts plus the fixture workers-types tsc;
 * route behaviour is tested against pure contract fakes.
 */

import * as v from "valibot";

import { Sandbox, getSandbox } from "@cloudflare/sandbox";

import {
  CommandSchema,
  ImageIdentityError,
  SANDBOX_IMAGE,
  SANDBOX_IMAGE_VERSION,
  handleProbeOp,
  isAuthorized,
} from "./worker-contract";
import type { ProbeCommand, RunIdentity } from "./worker-contract";

export { Sandbox } from "@cloudflare/sandbox";
export { ContainerProxy } from "@cloudflare/sandbox";
export { FuseProbeBox };
export { ImageIdentityError } from "./worker-contract";

/** SHA-256 hex via WebCrypto. The bun-native sha256Hex in core.ts uses
 *  Bun.CryptoHasher, which does not exist on workerd where this file runs. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface ProbeEnv {
  Sandbox: DurableObjectNamespace<FuseProbeBox>;
  /** Shared secret the driver presents. Absent ⇒ every request refused. */
  FUSE_PROBE_TOKEN?: string;
}

const SANDBOX_ID = "fuse-probe";

class FuseProbeBox extends Sandbox<ProbeEnv> {
  override async onStart(): Promise<void> {
    // Container startup runs under Durable Object blockConcurrencyWhile.
    // Keep it bounded; the explicit prepare RPC performs container probes.
    await super.onStart();
  }

  async prepare(): Promise<RunIdentity> {
    const actualVersion = await this.containerVersion();
    if (actualVersion !== SANDBOX_IMAGE_VERSION) {
      throw new ImageIdentityError(SANDBOX_IMAGE, actualVersion);
    }
    const bunVersion = await this.bunVersion();
    return {
      configuredImage: SANDBOX_IMAGE,
      expectedVersion: SANDBOX_IMAGE_VERSION,
      actualVersion,
      actualVersionDigest: await sha256Hex(actualVersion),
      bunVersion,
    };
  }

  /** The SANDBOX_VERSION the container itself reports. A transport failure
   *  propagates as itself; only a wrong or unreported VERSION is an identity
   *  mismatch ("unknown" is what an image answers when the variable is unset). */
  protected async containerVersion(): Promise<string> {
    return this.client.utils.getVersion();
  }

  /** The probe runs entirely under bun, so a boot that cannot execute bun is
   *  not ready to serve, whatever else came up. */
  protected async bunVersion(): Promise<string> {
    const result = await this.exec("bun --version", { timeout: 30_000 });
    const version = result.stdout.trim();
    if (!result.success || version.length === 0) {
      throw new Error(`bun is not runnable in the container (exitCode ${result.exitCode}): ${result.stderr.slice(0, 200)}`);
    }
    return version;
  }

  override async destroy(): Promise<void> {
    try {
      // Mounts, tunnels, port tokens and the container instance are the SDK's
      // own teardown; nothing here re-implements them.
      await super.destroy();
    } finally {
      // This DO is ephemeral: cleared storage means a replayed teardown pass
      // finds nothing, and no run leaves rows behind even if the teardown
      // above failed partway.
      await this.ctx.storage.deleteAll();
    }
  }
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    if (!isAuthorized(env.FUSE_PROBE_TOKEN, request.headers.get("x-fuse-probe-token"))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const pathname = new URL(request.url).pathname;
    if (request.method === 'GET' && pathname === '/health') {
      return Response.json({ ok: true });
    }
    // getSandbox returns the typed FuseProbeBox RPC surface.
    const sandbox = getSandbox(env.Sandbox, SANDBOX_ID, { normalizeId: true, transport: "rpc" });
    let command: ProbeCommand;
    try {
      command = v.parse(CommandSchema, await request.json());
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
        { status: 400 },
      );
    }

    try {
      return await handleProbeOp(pathname, sandbox, command);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
        { status: 500 },
      );
    }
  },
};
