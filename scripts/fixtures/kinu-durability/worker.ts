/**
 * BENCHMARK FIXTURE — not product surface, not deployed by `bun run deploy`,
 * reachable only by `scripts/sandbox-durability-probe.ts`, which deploys an
 * ephemeral Worker from the wrangler config beside this file (`wrangler dev
 * --remote` cannot host a real container).
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
import { DEFAULT_DEVBOX_STRATEGY } from "@kinu.run/devbox";
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
          // The route is named for the exposure, not the token: it mints the
          // durable token BEFORE the exposure that uses it, because a preview
          // URL survives a recycle byte for byte only when its token exists first.
          const { urlToken } = await sandbox.portToken(
            command.port ?? 0, command.name,
          );
          return json({ ok: true, urlToken });
        }
        case "/heartbeatSchedules":
          return json(await sandbox.listSchedules("devboxHeartbeat"));
        case "/state":
          return json(await sandbox.devboxState());
        // The package's decided default, so the probe's P0 compares what the
        // deployed product reports against the deployed decision, not a
        // restatement of either.
        case "/strategyDecision":
          return json({ decided: DEFAULT_DEVBOX_STRATEGY });
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
