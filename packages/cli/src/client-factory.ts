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
  /** One task turn, then exit. The outcome ledger needs it: the next prompt is a fresh task, not a verdict on
   *  the previous answer. */
  oneShot?: boolean;
}

/**
 * --model/--base-url/--auth are session-scoped local overrides; cloud turns use the stored model, so they are
 * rejected there. `surface` names the driving command: one-shot runs change background and teardown timing.
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

  // Bind the planes to the recorded placement, not the invocation directory.
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
      '--model is a session override for local workspaces only.\n' +
      '  Change a cloud workspace with: kinu model <workspace> <spec> (or /model in chat).',
    );
  }

  if (opts.baseUrl || opts.auth) {
    throw new Error('--base-url and --auth apply to local workspaces only.');
  }

  if (opts.noAutoEvolve) {
    throw new Error('--no-auto-evolve applies to local workspaces; cloud turns run under the workspace\'s own evolution settings.');
  }
}
