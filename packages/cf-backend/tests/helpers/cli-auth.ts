/**
 * The CLI sign-in's objects as the platform keeps them (`src/cli/auth-do.ts`): one per name over storage of its own,
 * the same object to every caller wherever it runs, reached through a stub as a binding hands one out.
 */
import { Database } from 'bun:sqlite';
import type { AgentContext } from 'agents';
import type { ObjectNamespace } from '@kinu.run/core';
import { CliAuthDO } from '../../src/cli/auth-do';
import type { CliAuthObject } from '../../src/cli/auth-store';
import { workerEnv } from './bindings';
import { makeCtx, stubOf } from './platform-context';

interface HeldObject {
  readonly object: CliAuthDO;
  readonly ctx: AgentContext;
}

export interface CliAuthObjects extends ObjectNamespace<string, CliAuthObject> {
  /** Every object reached so far, by name, with the state it runs over. */
  readonly held: ReadonlyMap<string, HeldObject>;
}

export function cliAuthObjects(): CliAuthObjects {
  const held = new Map<string, HeldObject>();

  const made = (name: string): HeldObject => {
    const ctx = makeCtx(new Database(':memory:'), name);

    return { object: new CliAuthDO(ctx, workerEnv()), ctx };
  };

  return {
    held,
    idFromName: (name) => name,
    get: (name) => {
      const entry = held.get(name) ?? made(name);

      held.set(name, entry);

      return stubOf(entry.object);
    },
  };
}
