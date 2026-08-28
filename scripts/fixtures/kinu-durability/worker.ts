/**
 * BENCHMARK FIXTURE — not product surface, not deployed by `bun run deploy`,
 * reachable only by `scripts/sandbox-durability-probe.ts` running
 * `wrangler dev --remote` (or `wrangler deploy`) against the wrangler config
 * beside this file.
 *
 * It exports the PRODUCT `KinuSandbox` class plus the SDK's `ContainerProxy`
 * (outbound interception — and therefore the R2-binding chain mounts — does
 * not exist without it). A Worker that HOLDS the `Sandbox` binding needs no
 * HTTP route of its own: it calls the Durable Object's public methods on the
 * stub. No `@callable`, no product rpc-surface change.
 *
 * The token-guarded JSON API is a thin forwarder: every operation maps onto a
 * public KinuSandbox / SDK method, so what the probe measures is the product's
 * own lifecycle against a real container, process, port and R2 binding — not a
 * fake process, port or storage implementation.
 */

import * as v from "valibot";

import { ContainerProxy, getSandbox } from "@cloudflare/sandbox";
import type { KinuSandbox } from "../../../packages/cf-backend/src/kinu-sandbox";

export { KinuSandbox } from "../../../packages/cf-backend/src/kinu-sandbox";
export { ContainerProxy };

interface ProbeEnv {
  readonly Sandbox: DurableObjectNamespace<KinuSandbox>;
  /** The ephemeral probe bucket. Binding name matches the product's, because
   *  KinuSandbox.mountBackupStore resolves it by name. */
  readonly BACKUP_BUCKET: R2Bucket;
  /** Shared secret the driver presents. Absent ⇒ every request refused. */
  readonly PROBE_TOKEN?: string;
}

const SANDBOX_ID = "probe-workspace";

/**
 * The driver's JSON command surface, parsed once at the boundary so every
 * route reads typed fields and an absent field stays absent.
 */
const CommandSchema = v.object({
  workspaceName: v.optional(v.string()),
  path: v.optional(v.string()),
  content: v.optional(v.string()),
  command: v.optional(v.string()),
  cwd: v.optional(v.string()),
  timeoutMs: v.optional(v.number()),
  port: v.optional(v.number()),
  name: v.optional(v.string()),
  keepAlive: v.optional(v.boolean()),
});
type ProbeCommand = v.InferOutput<typeof CommandSchema>;

/** One probe reply: the sandbox method's own result, serialized verbatim. */
function json<T>(data: T, status = 200): Response {
  return Response.json(data, { status });
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (env.PROBE_TOKEN === undefined || request.headers.get("x-probe-token") !== env.PROBE_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }
    void url;

    const sandbox = getSandbox(env.Sandbox, SANDBOX_ID, { normalizeId: true, transport: "rpc" });
    let command: ProbeCommand;
    try {
      command = v.parse(CommandSchema, await request.json());
    } catch (error) {
      return json({
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }, 400);
    }

    try {
      switch (url.pathname) {
        case "/configure": {
          // Minimal egress binding — no granted bindings, so no secret material
          // exists anywhere in this probe. Required BEFORE the first container
          // use; installs the product interception the chain mounts need.
          await sandbox.configureEgress({
            workspaceName: command.workspaceName ?? "durability-probe",
            ownerUserId: "",
            bindings: [],
          });
          return json({ ok: true });
        }
        case "/writeFile": {
          await sandbox.writeFile(command.path ?? "", command.content ?? "", { encoding: "base64" });
          return json({ ok: true });
        }
        case "/exec": {
          const started = Date.now();
          const timeoutMs = command.timeoutMs ?? 30_000;
          // Supervised processes own their process id, not the exec session.
          // The SDK runs this health command independently, so there is no
          // session-routing control to expose in the probe protocol.
          const res = await sandbox.exec(
            command.command ?? "",
            command.cwd === undefined ? { timeout: timeoutMs } : { timeout: timeoutMs, cwd: command.cwd },
          );
          return json({ ...res, wallMs: Date.now() - started });
        }
        case "/tick": {
          // One periodic checkpoint tick, driven synchronously by the driver.
          return json(await sandbox.checkpointNow("tick"));
        }
        case "/finalCheckpoint":
          return json(await sandbox.checkpointNow("quiesce"));
        case "/startProcess": {
          const started = await sandbox.startSupervised(
            command.command ?? "",
            command.cwd,
          );
          return json(started);
        }
        case "/listProcesses":
          return json(await sandbox.listSupervised());
        case "/notePortExposed": {
          // The Devbox method was `notePortExposed`, recorded AFTER an
          // exposure and minting its own token. It is `portToken` now: the
          // durable token must exist BEFORE the exposure that uses it, which
          // is what makes a preview URL survive a recycle byte for byte.
          const { urlToken } = await sandbox.portToken(
            command.port ?? 0, command.name,
          );
          return json({ ok: true, urlToken });
        }
        case "/heartbeatSchedules":
          return json(await sandbox.listSchedules("devboxHeartbeat"));
        case "/state":
          return json(await sandbox.devboxState());
        case "/setKeepAlive": {
          await sandbox.setKeepAlive(command.keepAlive ?? false);
          return json({ ok: true });
        }
        case "/stop": {
          await sandbox.stop("SIGTERM");
          return json({ ok: true });
        }
        case "/discard": {
          await sandbox.discardState();
          return json({ ok: true });
        }
        default:
          return json({ error: `unknown op ${url.pathname}` }, 404);
      }
    } catch (error) {
      return json({
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }, 500);
    }
  },
};
