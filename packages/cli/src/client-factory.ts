import { requireAuthConfig } from './config.js';
import type { AgentTarget } from './agent-target.js';
import type { AgentClient } from './agent-client.js';
import type { CliSessionOptions } from './session.js';
import { CloudAgentClient } from './cloud-agent-client.js';
import { openLocalAgentClient } from './local-agent-client.js';

export interface AgentClientFlags {
  model?: string;
  baseUrl?: string;
  auth?: string;
  noAutoEvolve?: boolean;
}

/**
 * Build the AgentClient for a resolved target. --model/--base-url/--auth are
 * session-scoped local LLM overrides and never mutate an agent durably; cloud
 * turns run in the DO with the agent's stored model, so the flags are rejected
 * there with a pointer to the explicit durable command.
 */
export function createAgentClient(target: AgentTarget, opts: AgentClientFlags & CliSessionOptions): AgentClient {
  if (target.mode === 'cloud') {
    rejectLocalLlmFlags(opts);
    const auth = requireAuthConfig();
    return new CloudAgentClient({
      origin: auth.origin,
      token: auth.token,
      agentName: target.name,
      cloudName: target.cloudName,
      session: opts,
    });
  }
  return openLocalAgentClient(target.localName, {
    model: opts.model,
    baseUrl: opts.baseUrl,
    auth: opts.auth,
    noAutoEvolve: opts.noAutoEvolve,
    session: opts,
  });
}

function rejectLocalLlmFlags(opts: AgentClientFlags): void {
  if (opts.model) {
    throw new Error(
      '--model is a session-scoped override for local agents and does not apply to cloud agents.\n' +
      '  Change the cloud agent durably with: proteus model <agent> <spec> (or /model in chat).',
    );
  }
  if (opts.baseUrl || opts.auth) {
    throw new Error('--base-url and --auth configure local model access and do not apply to cloud agents.');
  }
}
