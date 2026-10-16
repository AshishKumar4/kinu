/**
 * Who a shared slate's calls act as (docs/SLATE-SHARING-NIMBUS.md §2–§3), as pure decisions the host applies on every
 * call: what the shared server may use, whether a personal part's call may use its viewer's connection, and the one
 * effect each approval admits. `lean/Kinu/SharingNimbus` states and proves these.
 */
import type { JsonValue } from '../utils/json';
import { sha256Hex, stableStringify } from '../safety/argument-digest';
import type { ShareGrant } from './sharing';
import type { ShareMode, SlateConsent } from './share-modes';
import type { ConsentAsk, EffectAsk } from './personal-parts';

/** One live share of the slate, as the server's authority reads it. */
export interface LiveShareAuthority {
  readonly mode: ShareMode;
  readonly grant: ShareGrant;
  /** `owner` mode: the revision whose reach the owner approved; null in `own` mode. */
  readonly grantRevision: string | null;
}

/**
 * What the slate's server acts with, whoever called it: the owner's own authority while it is shared with no one;
 * nothing while any share is `own`; else the members every `owner` share grants at this revision, and nothing once one
 * of them was approved for another revision (an edit suspends it until the owner approves again).
 */
export type ServerAuthority =
  | { readonly kind: 'owner' }
  | { readonly kind: 'none' }
  | { readonly kind: 'grant'; readonly grant: ShareGrant };

export function serverAuthority(shares: readonly LiveShareAuthority[], revision: string): ServerAuthority {
  if (shares.length === 0) return { kind: 'owner' };

  if (shares.some((share) => share.mode === 'own' || share.grantRevision !== revision)) return { kind: 'none' };
  const [first, ...rest] = shares.map((share) => share.grant);
  const key = (member: ShareGrant['members'][number]) => JSON.stringify([member.slate, member.namespace, member.member]);
  const members = (first?.members ?? []).filter((member) => rest.every((grant) => grant.members.some((other) => key(other) === key(member))));

  return { kind: 'grant', grant: { slates: first?.slates ?? [], members, fork: false } };
}

/** One call a personal part's run makes with its viewer's connection. */
export interface PartCall {
  readonly server: string;
  readonly root: Readonly<Record<string, string>>;
  readonly tool: string;
  /**
   * Whether the call stays where it was consented: a tool its server marks read-only and closed-world
   * (`openWorldHint: false`), so what its arguments carry reaches that server alone. Anything else (a send, a URL
   * fetch, any tool that may reach other destinations) discloses what it carries, and dispatches only once its viewer
   * approves that exact payload.
   */
  readonly contained: boolean;
}

/** Whether a tool's call stays with its own server: read-only and closed-world by its server's own marks. */
export function containedTool(descriptor: { readonly readOnly?: true; readonly closedWorld?: true }): boolean {
  return descriptor.readOnly === true && descriptor.closedWorld === true;
}

export type PartCallVerdict =
  | { readonly kind: 'run' }
  | { readonly kind: 'needs-consent'; readonly ask: ConsentAsk }
  | { readonly kind: 'needs-approval' };

function sameRoot(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Whether the viewer's consent for this slate lets this call run at this revision: the tool among those they allowed,
 * on that root, for this very revision (an edit asks again). A call that is not contained needs their consent to ask
 * (`effects`), and then runs only once they approve it, its payload and destination shown: a read as much as a send.
 */
export function partCallVerdict(consent: SlateConsent | null, call: PartCall, revision: string, approved: boolean): PartCallVerdict {
  const held = consent !== null && consent.server === call.server && sameRoot(consent.root, call.root) && consent.revision === revision;

  if (!held || !consent.tools.includes(call.tool) || (!call.contained && !consent.effects)) {
    const tools = held ? [...new Set([...consent.tools, call.tool])] : [call.tool];

    return { kind: 'needs-consent', ask: { server: call.server, root: call.root, tools, effects: !call.contained || (held && consent.effects), revision } };
  }

  return !call.contained && !approved ? { kind: 'needs-approval' } : { kind: 'run' };
}

/** A disclosing call as its approval names it: the slate, its revision, its destination (server, tool, root) and its exact payload. */
export interface EffectCall {
  readonly workspace: string;
  readonly slate: string;
  readonly revision: string;
  readonly server: string;
  readonly tool: string;
  readonly root: Readonly<Record<string, string>>;
  readonly payload: JsonValue;
}

/**
 * The effects one viewer's personal parts asked to run, each named by its exact call, approved or not, and taken once:
 * one approval admits that one effect with that payload. Held in memory by the viewer's account; they live and die
 * with the transient runs that ask them.
 */
export class EffectApprovals {
  private readonly asked = new Map<string, { readonly call: EffectCall; approved: boolean }>();

  static idOf(call: EffectCall): string {
    return sha256Hex(stableStringify({ ...call, root: { ...call.root } }), 32);
  }

  ask(call: EffectCall): EffectAsk {
    const id = EffectApprovals.idOf(call);

    if (!this.asked.has(id)) this.asked.set(id, { call, approved: false });

    return { id, server: call.server, tool: call.tool, root: call.root, payload: call.payload };
  }

  /** The viewer's decision: approved, it waits for its run; declined, it is forgotten. */
  decide(id: string, approve: boolean): boolean {
    const asked = this.asked.get(id);

    if (asked === undefined) return false;

    if (approve) asked.approved = true;
    else this.asked.delete(id);

    return true;
  }

  /** Whether `call` was approved, which uses the approval up. */
  take(call: EffectCall): boolean {
    const id = EffectApprovals.idOf(call);

    if (this.asked.get(id)?.approved !== true) return false;
    this.asked.delete(id);

    return true;
  }
}
