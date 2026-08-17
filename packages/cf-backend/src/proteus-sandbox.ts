/**
 * ProteusSandbox — a Durable Object that wraps @cloudflare/sandbox, plus the
 * egress posture every agent's container runs under.
 *
 * The container gives each Proteus agent a long-running Linux box with
 * shell / fs / port-expose. `getSandbox(env.Sandbox, agentId)` returns a handle
 * with `.exec`, `.readFile`, `.writeFile`, `.listFiles`, `.deleteFile`,
 * `.exposePort`, `.unexposePort`, `.listPorts`, and the rest — all inherited
 * and exposed over the DO RPC surface that `getSandbox(...)` consumes.
 *
 * ── The three fields below are the whole security posture ────────
 *
 * `enableInternet = false`
 *   Without it, any TCP port other than 80/443 leaves the container
 *   uninterecepted, because the platform never routes those through an
 *   outbound handler at all. Interception could then be described as "total"
 *   only by not counting the ports it cannot see. The cost is real and
 *   deliberate: only HTTP/S and DNS leave an agent's container, so
 *   git-over-SSH and raw database sockets are refused.
 *
 * `interceptHttps = true`
 *   MEASURED, NOT ASSUMED. The Sandbox SDK's docs state that "Sandboxes
 *   intercept HTTPS traffic by default — `interceptHttps` is set to `true` on
 *   the Sandbox class." That is FALSE for the entire stable line. In both
 *   `@cloudflare/sandbox` 0.11.0 and 0.12.7 the string `interceptHttps`
 *   appears exactly ONCE in the shipped bundle, and it is a read
 *   (`if (this.interceptHttps) this.envVars = { …SANDBOX_INTERCEPT_HTTPS: "1" }`),
 *   never an assignment — so the class inherits `interceptHttps = false` from
 *   `@cloudflare/containers` (`dist/lib/container.js`, identical default in
 *   0.3.6 and 0.3.7). Leaving it alone would mean every HTTPS request — which
 *   is every request that matters — bypassing interception entirely, and with
 *   `enableInternet = false` failing closed instead, so the agent would simply
 *   have no network. Setting it true does two things at once: it makes the SDK
 *   export `SANDBOX_INTERCEPT_HTTPS=1` into the container so the startup
 *   installs the ephemeral CA at
 *   `/etc/cloudflare/certs/cloudflare-containers-ca.crt`, and it makes the
 *   Container base call `interceptOutboundHttps('*', fetcher)`.
 *
 * `outboundHandlers`
 *   A registry of NAMED handlers, deliberately not a static `outbound`. A
 *   static handler receives no parameters, so it could only learn which
 *   workspace it serves from the container's own traffic — untrusted input
 *   deciding the one thing that must not be forgeable. Named handlers are
 *   bound to hosts at runtime by the owning DO with parameters it chose
 *   (`setOutboundHandler` / `setOutboundByHost`), which arrive as
 *   `ctx.params`.
 *
 * The class stays otherwise empty: everything else is the upstream base.
 */

import { Sandbox } from '@cloudflare/sandbox';
import {
  CONTAINER_EVENT_HOST,
  EGRESS_HANDLER,
  EVENT_HANDLER,
  handleContainerEgress,
  handleContainerEvent,
  parseEgressParams,
  type ProteusEgressParams,
} from './egress/outbound.js';

export class ProteusSandbox extends Sandbox<Env> {
  /** No raw sockets. See the header — this is what makes "every HTTP/S egress
   *  is intercepted" a claim about all egress rather than about the two ports
   *  the platform happens to route. */
  enableInternet = false;

  /** The SDK does not do this for us, whatever its docs say. See the header. */
  interceptHttps = true;

  /**
   * Bind this container's two egress handlers, with the secret bindings the
   * workspace has been granted.
   *
   * Called by the workspace Durable Object — which is where the grants live —
   * before the container is first used, and again whenever the owner's vault or
   * the workspace's grants change. Deliberately NOT done in `onStart`: the
   * Container base holds that hook inside a concurrency gate every request on
   * this object waits behind, and `gate:do-init` forbids awaiting there.
   *
   * The Container base persists this configuration to its own storage and
   * re-applies it before each `container.start()`, so this is once per change,
   * not once per request.
   */
  async configureEgress(params: ProteusEgressParams): Promise<void> {
    // Per-host before catch-all: per-host wins at request time, and binding it
    // second would leave a window where a container event took the egress path.
    await this.setOutboundByHost(CONTAINER_EVENT_HOST, EVENT_HANDLER, params);
    await this.setOutboundHandler(EGRESS_HANDLER, params);
  }
}

ProteusSandbox.outboundHandlers = {
  // `ctx.params` is whatever the owning DO passed to `setOutboundHandler` /
  // `setOutboundByHost`. It is trusted input — the container cannot influence
  // it — but it arrives typed `unknown`, so it is PARSED rather than asserted:
  // `parseEgressParams` returns undefined for anything that is not the shape,
  // and both handlers treat undefined as "not configured yet" and refuse. An
  // unconfigured container therefore cannot egress.
  //
  // SAFETY: `env as Env` is sound because the runtime object IS this Worker's
  // env — the SDK declares the parameter as the generated `Cloudflare.Env`,
  // which this project leaves empty and populates as `Env` in env.d.ts
  // instead, and `Env` is assignable to it. Nothing is narrowed that the
  // wrangler binding block does not already guarantee exists.
  [EGRESS_HANDLER]: (request, env, ctx) => handleContainerEgress(
    request, env as Env, parseEgressParams(ctx),
  ),
  // SAFETY: as above — the runtime object IS this Worker's env; the SDK just
  // names it by the generated `Cloudflare.Env` that this project leaves empty.
  [EVENT_HANDLER]: (request, env, ctx) => handleContainerEvent(
    request, env as Env, parseEgressParams(ctx),
  ),
};
