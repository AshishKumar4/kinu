/** ACP adapter: an ACP session is an AgentClient, so this only maps ACP shapes to the client's event
 * stream. There is deliberately no second agent loop. */

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
import type { JsonObject, ShellApprovalOutcome, ShellApprovalRequest } from '@kinu.run/core';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';
import type { AgentClient, AgentClientEvent } from '../agent-client';
import { toAgentPrompt } from './prompt';
import * as v from 'valibot';

export type AcpClientFactory = (opts: { cwd: string }) => Promise<AgentClient>;

export interface AcpAgentDeps {
  openClient: AcpClientFactory;
  name: string;
  version: string;
}

/** Crafted and MCP tools fall through to 'other'. `skills`, `release` and `experience` are never live
 *  tool names (they surface as `eval` or are owner-only RPC). */
const TOOL_KINDS = new Map<string, ToolKind>([
  ['shell', 'execute'],
  ['eval', 'execute'],
  ['memory', 'think'],
  ['tasks', 'think'],
  ['report', 'think'],
  ['agents', 'think'],
  ['web', 'fetch'],
]);

/** `file` is the one builtin whose kind depends on the call rather than the
 *  name: a read and a write present differently in an ACP client. */
function toolKind(name: string, args: JsonObject): ToolKind {
  if (name === 'file') {
    return args.action === 'read' ? 'read' : 'edit';
  }

  return TOOL_KINDS.get(name) ?? 'other';
}

function toolTitle(name: string, args: JsonObject): string {
  const command = args.command;
  const parsedCommand = v.safeParse(v.string(), command);

  if (name === 'shell' && parsedCommand.success) return parsedCommand.output;
  const action = args.action;
  const parsedAction = v.safeParse(v.string(), action);

  if (parsedAction.success) return `${name}: ${parsedAction.output}`;

  return name;
}

/** "Don't ask again" grants exactly the asked rules on the asked executor (`wrapShellApprovalHandler`),
 *  never whole-agent `allow_all`. There is deliberately no persistent reject. */
function permissionOptions(req: ShellApprovalRequest): PermissionOption[] {
  const rules = req.review.hits.filter((h) => h.decision === 'gate').map((h) => h.rule).join(', ');

  return [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    {
      optionId: 'allow_always',
      name: `Allow, and stop asking about ${rules} on ${req.executor}`,
      kind: 'allow_always',
    },
    { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
  ];
}

/** Untrusted client input: an optionId not offered must resolve to nothing. */
const OUTCOME_BY_OPTION = new Map<string, ShellApprovalOutcome>([
  ['allow', 'allow'],
  ['allow_always', 'allow_always'],
  ['deny', 'deny'],
]);

class AcpSession {
  readonly id: SessionId;
  readonly client: AgentClient;
  readonly cwd: string;
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

  /** Local sessions only: a cloud turn runs in the DO, with no synchronous path back to this process. */
  installApprovalChannel(ask: (req: ShellApprovalRequest) => Promise<ShellApprovalOutcome | null>): void {
    this.detachApproval = this.client.localControls?.setShellApprovalHandler(ask) ?? null;
  }

  async close(): Promise<void> {
    this.detachApproval?.();
    this.detachApproval = null;
    await this.client.close();
  }
}

export function createAcpAgent(deps: AcpAgentDeps): AgentApp {
  const sessions = new Map<string, AcpSession>();

  const requireSession = (sessionId: string): AcpSession => {
    const session = sessions.get(sessionId);

    if (!session) throw RequestError.resourceNotFound(sessionId);

    return session;
  };

  const notify = async (
    client: AgentContext,
    sessionId: SessionId,
    update: SessionNotification['update'],
  ): Promise<void> => {
    try {
      await client.notify(CLIENT_METHODS.session_update, { sessionId, update });
    } catch (cause) {
      // An undelivered update must not fail its turn; report on stderr because stdout carries the protocol.
      diagnostics.failure(
        'acp.session_update_undelivered',
        toKinuError({ doing: 'delivering an acp session/update notification', cause, otherwise: 'io' }),
        { sessionId },
      );
    }
  };

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
          // Kinu emits the call at dispatch, so it is already running.
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
      case 'turn-start':
      case 'turn-end':
      case 'step-finish':
      case 'broadcast':
      case 'run-event':
      case 'background':
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
        sessionCapabilities: { close: {} },
      },
      // Kinu authenticates through `kinu auth`, not through the editor.
      authMethods: [],
    }))

    .onRequest(AGENT_METHODS.session_new, async (ctx) => {
      const cwd = ctx.params.cwd;
      const client = await deps.openClient({ cwd });
      await client.connect();
      const session = new AcpSession(client.cliSession.id, client, cwd);
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
          options: permissionOptions(req),
        });

        // 'cancelled' — the turn is going away; deny so the tool stops here.
        if (outcome.outcome.outcome !== 'selected') return 'deny';

        return OUTCOME_BY_OPTION.get(outcome.outcome.optionId) ?? 'deny';
      });

      return { sessionId: session.id };
    })

    .onRequest(AGENT_METHODS.session_load, async (ctx) => {
      const session = requireSession(ctx.params.sessionId);

      for (const message of await session.client.history()) {
        if (message.role === 'user') {
          await notify(ctx.client, session.id, {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: message.content },
          });
        } else if (message.role === 'assistant') {
          await notify(ctx.client, session.id, {
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

      const pendingNotifications: Promise<void>[] = [];

      const unsubscribe = session.client.subscribe((event) => {
        const update = toUpdate(event);

        if (update) pendingNotifications.push(notify(ctx.client, session.id, update));
      });

      try {
        await session.client.send(
          toAgentPrompt(ctx.params.prompt),
          { cwd: session.cwd },
        );
      } finally {
        unsubscribe();
        await Promise.all(pendingNotifications);
      }

      // stop() resolves the turn early; the flag distinguishes a cancel from a natural finish.
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
