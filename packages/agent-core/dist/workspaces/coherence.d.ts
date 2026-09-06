import { Digest, RecordCodec, type JsonValue } from "../core/index.js";
import { AgentCoreError } from "../errors.js";
import { GrantId } from "../authority/index.js";
import { BindingName, OperationRef, type Impact } from "../facets/index.js";
import { PrincipalRef, ScopeRef } from "../identity/index.js";
import { RunId } from "../execution-references/index.js";
import { EventId, RouteReservationId, SubscriptionId } from "../interaction-references/index.js";
import { CoherenceFindingId } from "./id.js";
import type { TenantRelation } from "./value.js";
/**
 * A standing declaration that one Principal observes one sibling Run's Events. It carries
 * no authority of its own: `grant` names the allow-Grant the §3.4 resolver must still
 * produce, which is what makes the set of declarations an enumeration of who watches whom
 * rather than a second authority plane.
 */
export interface CrossRunObservation {
    readonly subscription: SubscriptionId;
    readonly observer: PrincipalRef;
    readonly subject: RunId;
    readonly subjectScope: ScopeRef;
    readonly grant: GrantId;
    readonly crossTenantAuthority?: BindingName;
}
/**
 * One live allow-Grant the §3.4 resolver produced for the observing Principal: the Scope it
 * holds, the observed Runs its capability admits, and its impacts. Denies are already
 * applied by the resolver, so a fact reaching this policy is authority that survived §3.3
 * precedence.
 */
export interface ObservationAuthority {
    readonly grant: GrantId;
    readonly scope: ScopeRef;
    readonly runs: readonly RunId[];
    readonly impacts: readonly Impact[];
}
export type ObservationDecision = {
    readonly kind: "admitted";
    readonly grant: GrantId;
} | {
    readonly kind: "refused";
    readonly refusal: ObservationRefusal;
};
/** Why one cross-Run observation or intervention was refused. */
export declare abstract class ObservationRefusal {
    static get ambient(): ObservationRefusal;
    static get tenant(): ObservationRefusal;
    static impact(missing: Impact): ObservationRefusal;
    static intervention(missing: Impact): ObservationRefusal;
    abstract readonly reason: string;
    abstract explain(): string;
    denied(): AgentCoreError;
}
/**
 * Whether the Event-owning source Actor may append a RouteReservation for one cross-Run
 * observation. It runs before the reservation exists, so a refusal leaves nothing behind,
 * and the cross-tenant question is answered first because a tenant mismatch is a fact about
 * the route rather than about the observer's Grants.
 */
export declare function admitCrossRunObservation(observation: CrossRunObservation, presented: readonly ObservationAuthority[], tenants: TenantRelation): ObservationDecision;
/**
 * What an observer may attempt against the Run it observes. `observe` is the read the
 * observation already covers, so it is not an intervention and the type says so rather than
 * a guard rejecting it at runtime.
 */
export type InterventionImpact = Exclude<Impact, "observe">;
/**
 * Whether an observer may act on the Run it observes. The observation's own Grant is
 * excluded from the search whatever impacts it carries, so observation authority can never
 * be laundered into intervention authority by widening one capability.
 */
export declare function authorizeObservedIntervention(observation: CrossRunObservation, presented: readonly ObservationAuthority[], impact: InterventionImpact): ObservationDecision;
/** One effect intent an admitted cross-Run observation delivered. */
export interface ObservedIntent {
    readonly run: RunId;
    readonly event: EventId;
    readonly reservation: RouteReservationId;
    readonly operation: OperationRef;
    readonly argumentsDigest: Digest;
}
/** Two observed intents naming different Runs and the same Operation. */
export interface ObservedResemblance {
    readonly left: ObservedIntent;
    readonly right: ObservedIntent;
}
/**
 * Which reading of a resemblance set a finding asserts. Each case owns the evidence shape
 * it is the only admissible reading of, so the conclusion and the evidence deciding it
 * cannot drift apart.
 */
export declare abstract class CoherenceVerdict {
    static get duplicate(): CoherenceVerdict;
    static get distinct(): CoherenceVerdict;
    static fromData(value: JsonValue | undefined): CoherenceVerdict;
    abstract readonly label: string;
    abstract requireEvidence(witnesses: readonly ObservedResemblance[], discriminator: ObservedResemblance | undefined): void;
    equals(other: CoherenceVerdict): boolean;
}
export interface CoherenceFindingInit {
    readonly id: CoherenceFindingId;
    readonly observer: PrincipalRef;
    readonly scope: ScopeRef;
    readonly grant: GrantId;
    readonly subjects: readonly [RunId, RunId];
    readonly verdict: CoherenceVerdict;
    readonly witnesses: readonly ObservedResemblance[];
    readonly discriminator?: ObservedResemblance;
}
/** Everything a finding is about except the verdict its evidence decides. */
export type CoherenceFindingIdentity = Omit<CoherenceFindingInit, "discriminator" | "verdict" | "witnesses">;
/**
 * One observer's determination that two Runs are, or are not, doing the same work. The
 * record carries identifiers and digests only: it is checkable by a reader who can read the
 * observed Events through the same Grant, and it is no second copy of what those Runs hold.
 */
export declare class CoherenceFinding {
    static get codec(): RecordCodec<CoherenceFinding>;
    static encode(finding: CoherenceFinding): Uint8Array;
    static decode(bytes: Uint8Array): CoherenceFinding;
    readonly init: CoherenceFindingInit;
    constructor(init: CoherenceFindingInit);
    get id(): CoherenceFindingId;
    get observer(): PrincipalRef;
    get scope(): ScopeRef;
    get grant(): GrantId;
    get subjects(): readonly [RunId, RunId];
    get verdict(): CoherenceVerdict;
    get witnesses(): readonly ObservedResemblance[];
    get discriminator(): ObservedResemblance | undefined;
}
/**
 * The finding two Runs' observed intents support, or undefined when nothing resembles
 * anything and there is no determination to make. Pair order follows `observed`, so the
 * same observations always decide the same way.
 */
export declare function decideCoherenceFinding(identity: CoherenceFindingIdentity, observed: readonly ObservedIntent[]): CoherenceFinding | undefined;
