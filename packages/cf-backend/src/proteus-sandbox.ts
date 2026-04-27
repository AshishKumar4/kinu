/**
 * Minimal ProteusSandbox — a Durable Object that wraps @cloudflare/sandbox.
 *
 * This gives each Proteus agent a long-running Linux container with
 * shell / fs / port-expose. `getSandbox(env.SANDBOX, agentId)` returns a
 * handle with `.exec`, `.readFile`, `.writeFile`, `.listFiles`,
 * `.deleteFile`, `.exposePort`, `.unexposePort`, `.listPorts`, etc.
 *
 * No observability, no backup, no opencode — that's opt-in. We subclass only
 * so wrangler can bind a `class_name` and attach a Container image.
 */

import { Sandbox } from "@cloudflare/sandbox";

export class ProteusSandbox extends Sandbox<Env> {
  // Empty body: we rely entirely on the upstream Sandbox base class.
  // Every public method (exec, readFile, writeFile, listFiles, deleteFile,
  // exposePort, unexposePort, listPorts, readFileStream, etc.) is inherited
  // and exposed over the DO RPC surface that `getSandbox(...)` consumes.
}
