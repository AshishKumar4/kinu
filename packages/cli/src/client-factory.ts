import type { InvocationSurface } from '@kinu.run/core';
import { KinuError, settle } from '@kinu.run/core/obs';
import { Effect } from 'effect';
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
  /** `--no-auto-evolve`: turns the agent's learning setting off. */
  noAutoEvolve?: boolean;
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
    const refused = localLlmFlagRefusal(opts);

    if (refused !== null) return settle(Effect.fail(new KinuError('bad_input', refused)));
    const auth = requireAuthConfig();

    return await withLearningFlag(new CloudAgentClient({
      origin: auth.origin,
      token: auth.token,
      agentName: target.name,
      cloudName: target.cloudName,
      transcript: opts,
      // One task turn, then exit: the next prompt is a fresh task, not a verdict on the answer before it.
      oneShot: surface === 'one-shot',
    }), opts);
  }

  // Bind the planes to the recorded placement, not the invocation directory.
  const local = resolveLocalAgent(target.requestedName);

  return await withLearningFlag(await openLocalAgentClient(local.name, {
    model: opts.model,
    baseUrl: opts.baseUrl,
    auth: opts.auth,
    transcript: opts,
    surface,
    cwd: local.cwd,
  }), opts);
}

/** The agent's own learning setting, the one switch both backends honour; only the user's flag writes it. */
async function withLearningFlag(client: AgentClient, opts: AgentClientFlags): Promise<AgentClient> {
  if (opts.noAutoEvolve === true) await client.setEvolutionConfig({ learning: false });

  return client;
}

/** Why a cloud target refuses these flags, or null. */
function localLlmFlagRefusal(opts: AgentClientFlags): string | null {
  if (opts.model) {
    return '--model is a session override for local workspaces only.\n'
      + '  Change a cloud workspace with: kinu model <workspace> <spec> (or /model in chat).';
  }

  return opts.baseUrl || opts.auth ? '--base-url and --auth apply to local workspaces only.' : null;
}
