import { scriptedTurnModel, type ScriptedTurnOptions } from './turn-model';

export const HIRE_FORK_PARENT = 'The release ledger uses integer cents. Preserve that constraint.';

export const HIRE_FORK_ACK = 'I will preserve integer cents throughout the release audit.';

export const HIRE_FORK_REQUEST = 'Delegate the release audit now.';

export const HIRE_FORK_MISSION = 'Audit the release ledger for rounding errors.';

export const HIRE_FORK_ANSWER = 'The release ledger balances in integer cents.';

export const HIRE_FORK_PREFIX = [
  { role: 'user', content: HIRE_FORK_PARENT },
  { role: 'assistant', content: HIRE_FORK_ACK },
  { role: 'user', content: HIRE_FORK_REQUEST },
] satisfies Array<{ role: 'user' | 'assistant'; content: string }>;

export function hireForkModel(context?: 'fresh' | 'inherit', lifetime: 'durable' | 'task' = 'durable') {
  const childRequests: ScriptedTurnOptions[] = [];
  const hireInput = { action: 'hire', role: 'researcher', mission: HIRE_FORK_MISSION, lifetime };

  if (lifetime === 'durable') Object.assign(hireInput, { agent: 'forked-reader' });

  if (context !== undefined) Object.assign(hireInput, { context });

  const model = scriptedTurnModel({ doGenerate: (options) => {
    const users = options.prompt.filter((message) => message.role === 'user');

    const child = users.some((message) => message.content.some((part) => part.type === 'text'
      && (part.text === HIRE_FORK_MISSION || part.text.includes(`task: ${HIRE_FORK_MISSION}`))));

    const hire = !child && users.some((message) => message.content.some((part) => part.type === 'text' && part.text === HIRE_FORK_REQUEST))
      && !options.prompt.some((message) => message.role === 'tool');

    if (child) childRequests.push(options);

    return {
      content: hire ? [{ type: 'tool-call', toolCallId: 'hire-reader', toolName: 'agents', input: JSON.stringify(hireInput) }]
        : [{ type: 'text', text: child ? HIRE_FORK_ANSWER : HIRE_FORK_ACK }],
      finishReason: { unified: hire ? 'tool-calls' : 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [],
    };
  } });

  return { model, childRequests };
}

export function hireConversation(request: ScriptedTurnOptions) {
  return request.prompt.filter((message) => message.role !== 'system').map((message) => ({
    role: message.role,
    content: message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''),
  }));
}
