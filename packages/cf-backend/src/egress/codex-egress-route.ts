import { asFetchFunction } from '@kinu.run/core';
import type { CodexEgress } from './codex-egress';

export type CodexEgressNamespace = Pick<DurableObjectNamespace<CodexEgress>, 'idFromName' | 'get'>;

export function codexEgressFetch(namespace: CodexEgressNamespace, ownerUserId: string): typeof fetch {
  const stub = namespace.get(namespace.idFromName(ownerUserId));

  return asFetchFunction(async (input, init) => stub.forward(ownerUserId, new Request(input, init)));
}
