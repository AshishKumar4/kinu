/**
 * The Agent Client Protocol adapter — Proteus spoken to Zed, JetBrains,
 * neovim, Marimo and anything else that drives an ACP agent.
 *
 * This is a translation layer and nothing more. An ACP session IS an
 * AgentClient (the same one `proteus chat` drives), so delegation, crafted
 * tools, checkpoints and evolution all ride the normal turn pipeline; the only
 * thing here is the mapping between ACP's shapes and the client's event
 * stream. There is deliberately no second agent loop.
 */

import {
  agent,
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
  RequestError,
  type AgentApp,
  type AgentContext,
  type PermissionOption,
  type SessionId,
  type SessionNotification,
  type StopReason,
  type ToolKind,
} from '@agentclientprotocol/sdk';
import type { ShellApprovalOutcome, ShellApprovalRequest } from '@proteus/core';
import type { AgentClient, AgentClientEvent } from '../agent-client.js';
import { toAgentPrompt } from './prompt.js';

/** Opens the AgentClient backing one ACP session. The command supplies the
 *  real factory; tests supply a stub. */
export type AcpClientFactory = (opts: { cwd: string }) => Promise<AgentClient>;

export interface AcpAgentDeps {
  openClient: AcpClientFactory;
  /** Agent name reported in `initialize`. */
  name: string;
  version: string;
}

/** Proteus's builtin tools, mapped to the kind ACP clients use to pick an icon
 *  and a presentation. Crafted and MCP tools fall through to 'other'. */
const TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  run: 'execute',
  execute_tools: 'execute',
  memory: 'think',
  report: 'think',
  experience: 'think',
  agents: 'think',
  skills: 'read',
  web: 'fetch',
  product_change: 'edit',
};

/** `file` is the one builtin whose kind depends on the call rather than the
 *  name: a read and a write present differently in an ACP client. */
function toolKind(name: string, args: unknown): ToolKind {
  if (name === 'file') {
    const action = args && typeof args === 'object' ? (args as { action?: unknown }).action : undefined;
    return action === 'read' ? 'read' : 'edit';
  }
  return TOOL_KINDS[name] ?? 'other';
}

/** A one-line summary of what a call is doing — the tool call's ACP title.
 *  `run` gets its command because that is the thing a user is deciding about. */
function toolTitle(name: string, args: Record<string, unknown>): string {
  const command = args.command;
  if (name === 'run' && typeof command === 'string') return command;
  const action = args.action;
  if (typeof action === 'string') return `${name}: ${action}`;
  return name;
}

/** The permission choices offered for a gated command, in the order clients
 *  display them. */
const PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Allow and don\'t ask again', kind: 'allow_always' },
  { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
  { optionId: 'deny_always', name: 'Reject and don\'t ask again', kind: 'reject_always' },
];

const OUTCOME_BY_OPTION: Readonly<Record<string, ShellApprovalOutcome>> = {
  allow: 'allow',
  allow_always: 'allow_always',
  deny: 'deny',
  deny_always: 'deny_always',
};

/** One live ACP session: the Proteus client plus the per-turn state the
 *  translation needs. */
class AcpSession {
  readonly id: SessionId;
  readonly client: AgentClient;
  readonly cwd: string;
  /** Set while a session/prompt is in flight; cleared when it settles. */
  private cancelled = false;
  private detachApproval: (() => void) | null = null;

  constructor(id: SessionId, client: AgentClient, cwd: string) {
    this.id = id;
    this.client = client;
    this.cwd = cwd;
  }

  markCancelled(): void { this.cancelled = true; }
  beginTurn(): void { this.cancelled = false; }
  get wasCancelled(): boolean { return this.cancelled; }

  /** Route gated shell commands to the editor's permission UI for as long as
   *  this session is connected. Local sessions only — a cloud turn runs in the
   *  DO, which has no synchronous path back to this process. */
  installApprovalChannel(ask: (req: ShellApprovalRequest) => Promise<ShellApprovalOutcome | null>): void {
    this.detachApproval = this.client.localControls?.setShellApprovalHandler(ask) ?? null;
  }

  async close(): Promise<void> {
    this.detachApproval?.();
    this.detachApproval = null;
    await this.client.close();
  }
}

/** Build the ACP agent app. Connect it to a stream (stdio) or, in tests,
 *  directly to a ClientApp. */
export function createAcpAgent(deps: AcpAgentDeps): AgentApp {
  const sessions = new Map<string, AcpSession>();

  const requireSession = (sessionId: string): AcpSession => {
    const session = sessions.get(sessionId);
    if (!session) throw RequestError.resourceNotFound(sessionId);
    return session;
  };

  const notify = (client: AgentContext, sessionId: SessionId, update: SessionNotification['update']): void => {
    // Notifications are fire-and-forget; a client that has gone away must not
    // take down the turn that is still running.
    void client.notify(CLIENT_METHODS.session_update, { sessionId, update }).catch(() => {});
  };

  /** Translate one AgentClient event into its ACP session/update, or null when
   *  it has no ACP counterpart (step boundaries, broadcasts). */
  const toUpdate = (event: AgentClientEvent): SessionNotification['update'] | null => {
    switch (event.type) {
      case 'text-delta':
        return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.delta } };
      case 'tool-call':
        return {
          sessionUpdate: 'tool_call',
          toolCallId: event.toolCallId,
          title: toolTitle(event.toolName, event.args),
          kind: toolKind(event.toolName, event.args),
          // Proteus emits the call at dispatch, so it is already running.
          status: 'in_progress',
          rawInput: event.args,
        };
      case 'tool-result':
        return {
          sessionUpdate: 'tool_call_update',
          toolCallId: event.toolCallId,
          status: event.success ? 'completed' : 'failed',
          content: [{ type: 'content', content: { type: 'text', text: event.result } }],
        };
      // The agent's own evolution commentary is thinking, not its answer.
      case 'evolution':
        return {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: `${event.event}: ${event.message}` },
        };
      case 'error':
        return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n\n${event.message}` } };
      default:
        return null;
    }
  };

  return agent({ name: deps.name })
    .onRequest(AGENT_METHODS.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: deps.name, version: deps.version },
      agentCapabilities: {
        // History lives in the workspace db, so a session can be replayed.
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        // Closing releases the workspace db handle and the MCP servers.
        sessionCapabilities: { close: {} },
      },
      // Proteus authenticates through `proteus auth`, not through the editor.
      authMethods: [],
    }))

    .onRequest(AGENT_METHODS.session_new, async (ctx) => {
      const cwd = ctx.params.cwd;
      const client = await deps.openClient({ cwd });
      await client.connect();
      const session = new AcpSession(client.cliSession.id as SessionId, client, cwd);
      sessions.set(session.id, session);

      session.installApprovalChannel(async (req) => {
        const outcome = await ctx.client.request(CLIENT_METHODS.session_request_permission, {
          sessionId: session.id,
          toolCall: {
            toolCallId: `approval-${crypto.randomUUID()}`,
            title: req.command,
            kind: 'execute' as const,
            status: 'pending' as const,
            content: [{
              type: 'content' as const,
              content: { type: 'text' as const, text: req.review.hits.map((h) => h.explanation).join('\n') },
            }],
          },
          options: [...PERMISSION_OPTIONS],
        });
        // 'cancelled' — the turn is going away; deny so the tool stops here.
        if (outcome.outcome.outcome !== 'selected') return 'deny';
        return OUTCOME_BY_OPTION[outcome.outcome.optionId] ?? 'deny';
      });

      return { sessionId: session.id };
    })

    .onRequest(AGENT_METHODS.session_load, async (ctx) => {
      const session = requireSession(ctx.params.sessionId);
      // The client asked to see the conversation: replay it as the same chunk
      // updates a live turn would have produced.
      for (const message of await session.client.history()) {
        if (message.role === 'user') {
          notify(ctx.client, session.id, {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: message.content },
          });
        } else if (message.role === 'assistant') {
          notify(ctx.client, session.id, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: message.content },
          });
        }
      }
      return {};
    })

    .onRequest(AGENT_METHODS.session_prompt, async (ctx) => {
      const session = requireSession(ctx.params.sessionId);
      session.beginTurn();

      const unsubscribe = session.client.subscribe((event) => {
        const update = toUpdate(event);
        if (update) notify(ctx.client, session.id, update);
      });
      try {
        await session.client.send(
          toAgentPrompt(ctx.params.prompt),
          { cwd: session.cwd },
        );
      } finally {
        unsubscribe();
      }
      // stop() resolves the turn early, so a cancelled turn still lands here —
      // the flag is what distinguishes it from a natural finish.
      return { stopReason: (session.wasCancelled ? 'cancelled' : 'end_turn') satisfies StopReason };
    })

    .onNotification(AGENT_METHODS.session_cancel, (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) return;
      session.markCancelled();
      session.client.stop();
    })

    .onRequest(AGENT_METHODS.session_close, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) return {};
      sessions.delete(session.id);
      await session.close();
      return {};
    });
}
