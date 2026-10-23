/** One `/api/user` route as an account page calls it, for the first-run rows that read and write the account itself. */
import * as v from 'valibot';
import type { JsonObject } from '@kinu.run/core';
import type { PublicSessionPlan } from '../../evals/src/session';
import { webHeaders } from '../../evals/src/workspace-roster';

/** What the route answered: its parsed body, or null; and what it said, for the subgoal's detail. */
export interface Answer<T> {
  readonly value: T | null;
  readonly detail: string;
}

/** One `/api/user` route, as its page calls it. */
export interface UserRoute<S extends v.GenericSchema> {
  readonly schema: S;
  readonly method: 'GET' | 'PATCH' | 'POST' | 'DELETE';
  readonly path: string;
  readonly body?: JsonObject;
  /** The case's budget: a request it outlives is abandoned. */
  readonly signal?: AbortSignal;
}

/** One `/api/user` route as its page calls it, as the account `plan` resolved, parsed as the page parses it. */
export async function accountRoute<S extends v.GenericSchema>(plan: PublicSessionPlan, route: UserRoute<S>): Promise<Answer<v.InferOutput<S>>> {
  const { schema, method, path, body, signal } = route;

  const response = await fetch(new URL(`/api/user${path}`, plan.origin), {
    method,
    headers: { ...webHeaders(plan.identity), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  const text = await response.text();
  const parsed = response.ok ? v.safeParse(schema, JSON.parse(text)) : null;

  return parsed !== null && parsed.success
    ? { value: parsed.output, detail: `${method} ${path} answered ${text.slice(0, 300)}` }
    : { value: null, detail: `${method} ${path} answered ${String(response.status)}: ${text.slice(0, 300)}` };
}
