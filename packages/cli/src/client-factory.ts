import type { InvocationSurface } from '@kinu.run/core';
import { requireAuthConfig, resolveLocalAgent } from './config';
import type { AgentTarget } from './agent-target';
import type { AgentClient } from './agent-client';
import type { CliSessionOptions } from './session';
import { CloudAgentClient } from './cloud-agent-client';
import { openLocalAgentClient } from './local-agent-client';

export interface AgentClientFlags {
  model?: string;
  baseUrl?: string;
  auth?: string;
  noAutoEvolve?: boolean;
  /** This process runs ONE task turn and exits (`kinu exec`/`kinu run`)
   *  rather than holding a conversation. Not a capability switch — it is a
   *  statement of fact the outcome ledger needs: the next invocation's prompt
   *  is a fresh task, not a verdict on the previous answer. Applies to both
   *  backends (local: session option; cloud: stamped on the chat request). */
  oneShot?: boolean;
}

/**
 * Build the AgentClient for a resolved target. --model/--base-url/--auth are
 * session-scoped local LLM overrides and never mutate an agent durably; cloud
 * turns run in the DO with the agent's stored model, so the flags are rejected
 * there with a pointer to the explicit durable command.
 *
 * `surface` is not a user flag: it is which command is driving. A one-shot run
 * exits after its answer, which changes how long work may run before it is
 * moved to the background and how long teardown waits for it.
 */
export async function createAgentClient(
  target: AgentTarget,
  opts: AgentClientFlags & CliSessionOptions,
  surface: InvocationSurface = 'interactive',
): Promise<AgentClient> {
  if (target.mode === 'cloud') {
    rejectLocalLlmFlags(opts);
    const auth = requireAuthConfig();
    return new CloudAgentClient({
      origin: auth.origin,
      token: auth.token,
      agentName: target.name,
      cloudName: target.cloudName,
      transcript: opts,
      oneShot: opts.oneShot,
    });
  }
  // The one local resolution: the database, and the project directory every
  // peer agent in this virtual workspace shares. Binding the planes to the
  // recorded placement is what stops them following the invocation directory.
  const local = resolveLocalAgent(target.requestedName);
  return openLocalAgentClient(local.name, {
    model: opts.model,
    baseUrl: opts.baseUrl,
    auth: opts.auth,
    noAutoEvolve: opts.noAutoEvolve,
    oneShot: opts.oneShot,
    transcript: opts,
    surface,
    cwd: local.cwd,
  });
}

function rejectLocalLlmFlags(opts: AgentClientFlags): void {
  if (opts.model) {
    throw new Error(
      '--model is a session-scoped override for local workspaces and does not apply to cloud workspaces.\n' +
      '  Change the cloud workspace durably with: kinu model <workspace> <spec> (or /model in chat).',
    );
  }
  if (opts.baseUrl || opts.auth) {
    throw new Error('--base-url and --auth configure local model access and do not apply to cloud workspaces.');
  }
  if (opts.noAutoEvolve) {
    throw new Error('--no-auto-evolve applies to local workspaces; cloud turns run under the workspace\'s own evolution settings.');
  }
}
