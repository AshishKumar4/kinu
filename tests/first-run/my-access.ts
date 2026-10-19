/**
 * A live share turned to "my access" as its owner's share sheet does it (docs/SLATE-SHARING-NIMBUS.md §2): the reach
 * the slate's graph answers now, then the owner's word at that revision through the app's own route. Every share
 * starts on each viewer's own access, so a row that needs the owner's lent to a viewer turns it on here.
 */
import * as v from 'valibot';
import { LIVE_SHARE_MODE_PATH, LiveShareCreatedSchema, OwnedLiveShareSchema, SlateReachSchema, type JsonValue, type OwnedLiveShare } from '@kinu.run/core';

const Answered = v.object({ ok: v.literal(true), value: v.unknown() });

/** What the owner's word answered: the share as it stands after, or the refusal's status and words. */
export type MyAccess = { readonly on: OwnedLiveShare } | { readonly refused: { readonly status: number; readonly body: string } };

export async function turnOnMyAccess(input: {
  readonly origin: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly workspace: string;
  readonly share: string;
  /** The slate's graph as its owner reads it: `session.slateOp({ op: 'graph', id })`. */
  readonly graph: JsonValue;
  readonly approved: readonly { readonly slate: string; readonly namespace: string; readonly member: string }[];
}): Promise<MyAccess> {
  const reach = v.parse(SlateReachSchema, v.parse(Answered, input.graph).value);

  const response = await fetch(`${input.origin}${LIVE_SHARE_MODE_PATH}`, {
    method: 'POST', headers: { ...input.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: input.workspace, share: input.share, mode: 'owner', revision: reach.revision, approved: input.approved }),
  });

  const body = await response.text();

  return response.ok ? { on: v.parse(OwnedLiveShareSchema, JSON.parse(body)) } : { refused: { status: response.status, body: body.slice(0, 300) } };
}

/** Each share a `share` slate op answered, turned to "my access" approving nothing beyond what observes: whether every
 *  one is now, and each answer. A share the op refused lends nothing. */
export async function lendShares(input: {
  readonly origin: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly workspace: string;
  readonly slateOp: (operation: JsonValue) => Promise<JsonValue>;
  readonly shares: readonly { readonly answer: JsonValue; readonly slate: string }[];
}): Promise<{ readonly lent: boolean; readonly answers: readonly (MyAccess | null)[] }> {
  const answers = await Promise.all(input.shares.map(async ({ answer, slate }) => {
    const made = v.safeParse(v.object({ ok: v.literal(true), value: LiveShareCreatedSchema }), answer);

    return made.success ? turnOnMyAccess({ ...input, share: made.output.value.share.id, graph: await input.slateOp({ op: 'graph', id: slate }), approved: [] }) : null;
  }));

  return { lent: answers.every((each) => each !== null && 'on' in each && each.on.mode === 'owner'), answers };
}
