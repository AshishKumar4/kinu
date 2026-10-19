/**
 * A shared slate's server as the one principal it is (docs/SLATE-SHARING-NIMBUS.md §2): whoever's request it serves,
 * the owner's own included, it acts with what its shares lend it now, read at the very send. Authority is never read off
 * a request: a request's record is the host's, issued for one process of one sharing, and only says whom a call is for.
 * `lean/Kinu/SharingNimbus` states this boundary.
 */
import { Effect } from 'effect';
import { settleSync } from '../obs/effect';
import { KinuError } from '../obs/error';
import type { ApprovalSpend } from '../safety/approval-gate';
import type { JsonValue } from '../utils/json';
import { grantAdmits } from './capability-graph';
import { partCallRoot, plainData, preapprovedEffect, serverAuthority, type LiveShareAuthority, type ServerAuthority, type ToolContract } from './share-policy';
import type { ApprovalSpendOutcome } from '../safety/approval-gate';
import { slateEffectText, type SlateEffect } from '../safety/approval-kind';
import type { SlateEffectVerdict } from '../safety/deferred-approval';
import { sha256Hex } from '../safety/argument-digest';
import type { SlateInvocation } from './surface';
import type { SlateCaller } from './caller';

/** Where a shared server's effects wait for its owner, how a send takes the approval, and how its run settles it. */
export interface OwnerEffects {
  ask(id: string, effect: SlateEffect): SlateEffectVerdict;
  /** Synchronous: called where the call is sent. */
  take(id: string): ApprovalSpend | null;
  settle(spend: ApprovalSpend, outcome: ApprovalSpendOutcome): Promise<boolean>;
}

/**
 * Where a process came from, as the host minted it into its bindings: its incarnation, its slate's sharing then, and the
 * sharing of each shared slate it inherited its bound from (`SlateCaller.via`), sealed when it inherited it.
 */
export interface SlateLineage {
  readonly incarnation: string;
  readonly generation: number;
  readonly ancestors: Readonly<Record<string, number>>;
}

/** Who makes a call through a slate's binding, as the host minted it there: the caller, the slate, the surface, the lineage. */
export interface SlateCallFrom {
  readonly caller: SlateCaller;
  readonly id: string;
  /** `workspace`, or the reserved `__storage` or `__host`. */
  readonly name: string;
  readonly lineage: SlateLineage;
}

export interface SharedServerDeps {
  /** The slate's live shares as its authority reads them. */
  authoritiesOf(slate: string): LiveShareAuthority[];
  /** The slate's revision now (share-policy.ts `slateRevision`). */
  revision(slate: string): string | null;
  /** How many times the slate's sharing changed in this object's life. */
  generation(slate: string): number;
  /** The owner's queue of shared servers' effects: absent, every effect of a shared server is refused. */
  readonly ownerEffects?: OwnerEffects;
  /** What the owner's catalog knows of a connection's tool (share-policy.ts `ToolContract`); null where it knows none. */
  toolContract?(namespace: string, member: string): Promise<ToolContract | null>;
}

/** One call of a slate, as the shared servers it passes through weigh it. */
export interface ServerCall {
  /** The slate making the call. */
  readonly slate: string;
  /** The slates whose calls led here, the first the request entered by (`SlateInvocation.chain`). */
  readonly chain: readonly string[];
  readonly address: { readonly namespace: string; readonly member: string };
  /** Whether the call acts (any impact but observing). */
  readonly effect: boolean;
  readonly args: readonly JsonValue[];
  /** Whom the call is for, shown to the owner on an ask: never what it may do. */
  readonly on: string;
  /** The calling process's lineage and the record its call names, read again at the send (`lineage`). */
  readonly fence?: { readonly lineage: SlateLineage; readonly record: SlateInvocation | null };
}

/** What a gated call takes at its send: the owner's approval, when it needed one, or null. Throws to refuse. */
export interface ServerSend {
  /** Whether any shared server bounds the call (else it is its owner's own app, as it always was). */
  readonly bounded: boolean;
  admit(): ApprovalSpend | null;
}

/** A call's arguments as its tool is given them: the one argument, or all of them. */
function payloadOf(call: Pick<ServerCall, 'args'>): JsonValue {
  return plainData(call.args.length === 1 ? call.args[0] ?? null : [...call.args]);
}

/** Why a slate shared for each person's own access lends nothing, and who can change that. */
function ownAccessRefusal(slate: string, owner: string): KinuError {
  return new KinuError('denied', `Slate ${slate} is shared for each person's own access, so its server uses no one's connections. `
    + `${owner} can turn on My access in its share sheet; each person's own data shows in their own parts.`);
}

export class SharedServers {
  constructor(private readonly deps: SharedServerDeps, private readonly owner: () => Promise<string> = async () => 'Its owner') {}

  /** What the slate's server acts with now. */
  authorityOf(slate: string): ServerAuthority {
    return serverAuthority(this.deps.authoritiesOf(slate), this.deps.revision(slate) ?? '');
  }

  /**
   * Refused when the calling process was started under other sharing of its slate than now, or the request record it
   * names was issued to another process or under other sharing of any slate on its way: a server started, or a request
   * made, before a share began or ended never acts after it.
   */
  lineage(slate: string, lineage: SlateLineage, record: SlateInvocation | null): KinuError | null {
    if (lineage.generation !== this.deps.generation(slate)) {
      return new KinuError('denied', `Slate ${slate}'s server was started before its sharing changed, and acts no more`);
    }

    // Every shared slate it inherited its bound from, as sealed then: one sharing otherwise ends the bound it ran under.
    const ancestor = Object.entries(lineage.ancestors).find(([each, generation]) => this.deps.generation(each) !== generation);

    if (ancestor !== undefined) return new KinuError('denied', `Slate ${ancestor[0]}'s sharing changed since slate ${slate} was started under it, and it acts no more`);

    if (record === null) return null;

    if (record.incarnation !== lineage.incarnation) return new KinuError('denied', `Slate ${slate} named a request issued to another of its servers`);
    const moved = Object.entries(record.generations).find(([each, generation]) => this.deps.generation(each) !== generation);

    return moved === undefined ? null : new KinuError('denied', `Slate ${moved[0]}'s sharing changed since this request began`);
  }

  /**
   * A call weighed by every shared server on its way, as they stand now: refused where any lends nothing or does not
   * reach it; an effect asks the owner (unless they pre-approved it), and runs on their exact approval of it. The send
   * it may make, which weighs it all again, synchronously, where the call acts.
   */
  gate(call: ServerCall): Effect.Effect<ServerSend, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const owner = yield* Effect.promise(async () => this.owner());
      const first = this.weigh(call, owner);

      // Unbounded now is no standing permission: its send reads again that nothing shared bounds it.
      if (first.kind === 'unbounded') return { bounded: false, admit: () => settleSync(this.stillUnbounded(call)) };

      if (first.kind === 'refused') return yield* first.error;

      // An effect's resource, as its tool's own contract names it: what its approval and a pre-approval are of.
      const contract = call.effect ? yield* Effect.promise(async () => this.deps.toolContract?.(call.address.namespace, call.address.member) ?? null) : null;
      const root = partCallRoot(contract, payloadOf(call));
      const weighed = this.weigh(call, owner, root);

      if (weighed.kind !== 'bounded') return yield* new KinuError('denied', `Slate ${call.slate}'s sharing changed before this call was made`);
      const approval = weighed.preapproved || !call.effect ? null : yield* this.ask(call, weighed.origin, root);

      return { bounded: true, admit: () => settleSync(this.sendNow(call, weighed.origin, approval, root)) } satisfies ServerSend;
    });
  }

  /**
   * Why the call is beyond the shared servers on its way now (lends nothing, or does not reach it); null if within. A
   * fenced call (`ServerCall.fence`) is first held to the sharing its process and request began under.
   */
  beyond(call: Pick<ServerCall, 'slate' | 'chain' | 'address' | 'fence'>, owner = 'Its owner'): KinuError | null {
    const stale = call.fence === undefined ? null : this.lineage(call.slate, call.fence.lineage, call.fence.record);

    if (stale !== null) return stale;
    const weighed = this.weigh({ ...call, effect: false, args: [], on: '' }, owner);

    return weighed.kind === 'refused' ? weighed.error : null;
  }

  /** {@link beyond}, naming the owner who can change it where the server lends nothing. */
  bounded(call: Pick<ServerCall, 'slate' | 'chain' | 'address' | 'fence'>): Effect.Effect<KinuError | null> {
    return Effect.map(Effect.promise(async () => this.owner()), (owner) => this.beyond(call, owner));
  }

  /** What a call reaches inside itself, weighed by every shared server on its way now: it throws to refuse. */
  within(call: Pick<ServerCall, 'slate' | 'chain' | 'address' | 'fence'>): void {
    const beyond = this.beyond(call);

    return settleSync(beyond === null ? Effect.void : Effect.fail(beyond));
  }

  /** The send of a call nothing shared bounded, read again where it acts: still its process's, and still unbounded. */
  private stillUnbounded(call: ServerCall): Effect.Effect<null, KinuError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.fenced(call);
      const now = this.weigh(call, 'Its owner');

      if (now.kind === 'refused') return yield* now.error;

      return now.kind === 'unbounded' ? null : yield* new KinuError('denied', `Slate ${call.slate}'s sharing changed before this call was made`);
    });
  }

  /** The calling process and its request still of the sharing they began under (`lineage`). */
  private fenced(call: ServerCall): Effect.Effect<void, KinuError> {
    const stale = call.fence === undefined ? null : this.lineage(call.slate, call.fence.lineage, call.fence.record);

    return stale === null ? Effect.void : Effect.fail(stale);
  }

  /** The send weighed again where it acts: the same server still bounds it as it did, and the approval it needs is taken now. */
  private sendNow(call: ServerCall, origin: string, approval: string | null, root: Readonly<Record<string, string>>): Effect.Effect<ApprovalSpend | null, KinuError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.fenced(call);
      const now = this.weigh(call, 'Its owner', root);

      if (now.kind === 'refused') return yield* now.error;

      if (now.kind !== 'bounded' || now.origin !== origin) return yield* new KinuError('denied', `Slate ${origin}'s sharing changed before this call was made`);

      if (!call.effect || now.preapproved) return null;

      if (approval === null) return yield* new KinuError('denied', `${call.address.member} on ${call.address.namespace} waits for the owner to approve it`);
      const spend = this.deps.ownerEffects?.take(approval) ?? null;

      return spend ?? (yield* new KinuError('denied', "The owner's approval of this call was taken back before it was made"));
    });
  }

  /** The shared servers bounding a call now: none; the first that refuses it, and why; or the first, the one that asks. */
  private weigh(call: ServerCall, owner: string, root: Readonly<Record<string, string>> | null = null)
    : { readonly kind: 'unbounded' } | { readonly kind: 'refused'; readonly error: KinuError } | { readonly kind: 'bounded'; readonly origin: string; readonly preapproved: boolean } {
    const servers = [...new Set([...call.chain, call.slate])].map((slate) => ({ slate, authority: this.authorityOf(slate) }))
      .filter((each) => each.authority.kind !== 'owner');

    const [origin] = servers;

    if (origin === undefined) return { kind: 'unbounded' };

    for (const { slate, authority } of servers) {
      if (authority.kind === 'none') return { kind: 'refused', error: this.lendsNothing(slate, owner) };

      if (authority.kind === 'grant' && grantAdmits(authority.grant, call.slate, call.address.namespace, call.address.member) === null) {
        return { kind: 'refused', error: new KinuError('denied', `Slate ${slate} is shared with the owner's access, which does not reach ${call.address.namespace}.${call.address.member}`) };
      }
    }

    const revision = this.deps.revision(origin.slate) ?? '';

    const preapproved = root !== null && origin.authority.kind === 'grant'
      && preapprovedEffect(origin.authority.grant, { slate: call.slate, ...call.address, root }, revision);

    return { kind: 'bounded', origin: origin.slate, preapproved };
  }

  /** Why the shared server `slate` lends nothing now: shared for each person's own access, or changed since approved. */
  private lendsNothing(slate: string, owner: string): KinuError {
    const shares = this.deps.authoritiesOf(slate);

    const edited = shares.find((share) => share.editedBy !== undefined)?.editedBy;

    if (shares.some((share) => share.mode === 'own')) return ownAccessRefusal(slate, owner);

    return edited === undefined
      ? new KinuError('denied', `Slate ${slate} changed since its owner approved what it reaches: it acts on their access again once they approve it`)
      : new KinuError('denied', `${edited}'s change to slate ${slate} is awaiting ${owner}'s review: it acts on their access again once they approve it`);
  }

  /** The owner asked about one exact effect of the shared server `origin`: its approval's id, or the refusal it waits on. */
  private ask(call: ServerCall, origin: string, root: Readonly<Record<string, string>>): Effect.Effect<string, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const queue = this.deps.ownerEffects;

      if (queue === undefined) return yield* new KinuError('denied', 'This shared slate cannot ask its owner to approve a call now');
      const payload = payloadOf(call);
      const { namespace: server, member: tool } = call.address;

      const effect: SlateEffect = {
        slate: origin, caller: call.slate, revision: this.deps.revision(origin) ?? '', server, tool, root: { ...root }, payload, viewer: call.on,
      };

      const id = sha256Hex(slateEffectText(effect), 32);
      const verdict = queue.ask(id, effect);

      switch (verdict.outcome) {
        case 'approved': return id;
        case 'denied': return yield* new KinuError('denied', `The owner declined this call: ${tool} on ${server}`);
        case 'asked': return yield* new KinuError('denied', `This call waits for the owner to approve it: ${tool} on ${server}`);
      }
    });
  }
}
