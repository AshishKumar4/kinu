export interface AgentToolCallResult {
  name: string;
  args: unknown;
  result?: string;
}

export interface AgentTurnResult {
  text: string;
  toolCalls: AgentToolCallResult[];
  steps: number;
}

export type AgentClientEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-result'; toolName: string; result: string }
  | { type: 'step-finish'; stepIndex: number };

export interface AgentClientSendOptions {
  cwd?: string;
  onEvent?: (event: AgentClientEvent) => void;
}

export interface AgentClient {
  send(prompt: string, opts?: AgentClientSendOptions): Promise<AgentTurnResult>;
  stop(): void;
  close(): void;
}

export interface AgentUiMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  parts: Array<Record<string, unknown>>;
}

export function uiMessageText(message: AgentUiMessage): string {
  return message.parts
    .flatMap((part) => part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])
    .join('');
}

export function createUserUiMessage(text: string): AgentUiMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { input: value };
}
