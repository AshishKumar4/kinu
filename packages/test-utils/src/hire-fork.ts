import { isRuntimeContext } from './runtime-context';
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

/** The conversation a request carries: without the system prompt or Kinu's runtime context. */
export function hireConversation(request: ScriptedTurnOptions) {
  return request.prompt.filter((message) => message.role !== 'system').map((message) => ({
    role: message.role,
    content: message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''),
  })).filter((message) => message.role !== 'user' || !isRuntimeContext(message.content));
}

export const HIRE_FORK_FOLLOWUP_REQUEST = 'Send the next audit assignment.';

export const HIRE_FORK_FOLLOWUP = 'Check the next release ledger.';

export const HIRE_CHILD_CONTEXT = 'CHILD-ONLY-CONTEXT: the first audit is complete.';

/** What the model says when it calls nothing: the child's two answers, or the
 *  parent's acknowledgement. */
function spokenAnswer(child: boolean, followsUp: boolean): string {
  if (!child) return HIRE_FORK_ACK;

  return followsUp ? 'The next audit is complete.' : HIRE_CHILD_CONTEXT;
}

export function hireRetentionModel() {
  const childRequests: ScriptedTurnOptions[] = [];

  const model = scriptedTurnModel({ doGenerate: (options) => {
    const users = hireConversation(options).filter((message) => message.role === 'user');
    const followsUp = users.some((message) => message.content.includes(HIRE_FORK_FOLLOWUP));

    const child = followsUp || users.some((message) => message.content === HIRE_FORK_MISSION
      || message.content.includes(`task: ${HIRE_FORK_MISSION}`));

    const called = (name: string, action: string) => options.prompt.some((message) => message.role === 'assistant'
      && message.content.some((part) => part.type === 'tool-call' && part.toolName === name
        && JSON.stringify(part.input).includes(`"action":"${action}"`)));

    const parentFollowup = users.some((message) => message.content === HIRE_FORK_FOLLOWUP_REQUEST);
    let call: { id: string; name: string; input: object } | undefined;

    if (child) {
      childRequests.push(options);

      if (!followsUp && !called('memory', 'remember')) call = {
        id: 'child-context', name: 'memory',
        input: { action: 'remember', key: 'CHILD-ONLY-TOOL-CONTEXT', value: 'The first audit finding.' },
      };
    } else if (parentFollowup && !called('agents', 'msg')) {
      call = { id: 'msg-reader', name: 'agents',
        input: { action: 'msg', agent: 'forked-reader', message: HIRE_FORK_FOLLOWUP } };
    } else if (!parentFollowup && users.some((message) => message.content === HIRE_FORK_REQUEST) && !called('agents', 'hire')) {
      call = { id: 'hire-reader', name: 'agents', input: {
        action: 'hire', role: 'researcher', agent: 'forked-reader',
        mission: HIRE_FORK_MISSION, lifetime: 'durable', context: 'inherit',
      } };
    }

    return {
      content: call ? [{ type: 'tool-call', toolCallId: call.id, toolName: call.name, input: JSON.stringify(call.input) }]
        : [{ type: 'text', text: spokenAnswer(child, followsUp) }],
      finishReason: { unified: call ? 'tool-calls' : 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [],
    };
  } });

  return { model, childRequests };
}
