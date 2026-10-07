/** The delegation operations by name and impact; their fields join by wiring (`delegation/agents-operations.ts`). */
import type { Impact } from './operation';

/** Every operation the native `agents` tool may offer, in its order. */
export const AGENTS_OPS = ['swarm', 'hire', 'assign', 'hireWorkspace', 'message', 'reply', 'list', 'dismiss'] as const;

export type AgentsOp = (typeof AGENTS_OPS)[number];

/** What each operation does, whatever the wiring offers. */
export const AGENTS_IMPACTS = {
  swarm: 'delegate', hire: 'delegate', assign: 'delegate', hireWorkspace: 'delegate',
  message: 'externalSend', reply: 'externalSend', list: 'observe', dismiss: 'delegate',
} as const satisfies Record<AgentsOp, Impact>;
