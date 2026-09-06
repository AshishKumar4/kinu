import { Digest } from "../core/index.js";
import type { TurnId } from "../execution-references/index.js";
import { InterceptorDeclaration, type FacetData, type FacetRef, type OperationCutPoint, type ProtectionDomain, type TurnBoundCutPoint } from "../facets/index.js";
import type { FacetRuntimeHost } from "./lifecycle.js";
import type { ValidatedFacet } from "./correspondence.js";
import type { Operation } from "./runtime.js";
export interface InterceptorTrace {
    readonly itemIndex: number;
    readonly interceptor: string;
    readonly contributor: string;
    readonly cutPoint: OperationCutPoint;
    readonly before: Digest;
    readonly after: Digest;
    readonly outcome: "unchanged" | "rewritten";
}
export interface InterceptionResult {
    readonly value: FacetData;
    readonly traces: readonly InterceptorTrace[];
}
export interface InterceptorAuthorityPort<Resolution> {
    /** The protection domain this dispatch — and so every cut point in it — runs in. */
    cutPointDomain(resolution: Resolution): ProtectionDomain;
    /**
     * The protection domain the contributing Facet's code runs in, or undefined when the
     * Facet is placed in no domain this host can name.
     */
    contributorDomain(contributor: FacetRef): ProtectionDomain | undefined;
    allowsInterception(resolution: Resolution, contributor: FacetRef, declaration: InterceptorDeclaration, target: FacetRef, operation: Operation["descriptor"]): boolean;
}
export declare class OperationInterceptorRunner<Resolution> {
    private readonly host;
    private readonly authority;
    constructor(host: FacetRuntimeHost, authority: InterceptorAuthorityPort<Resolution>);
    hasApplicable(resolution: Resolution, target: ValidatedFacet, operation: Operation): boolean;
    run(cutPoint: OperationCutPoint, resolution: Resolution, target: ValidatedFacet, operation: Operation, itemIndex: number, input: FacetData): InterceptionResult;
    private candidates;
}
/** One Turn-bound interception, attributed exactly as an operation one is (SPEC §4.4 rule 5). */
export interface TurnInterceptorTrace {
    readonly interceptor: string;
    readonly contributor: string;
    readonly cutPoint: TurnBoundCutPoint;
    readonly before: Digest;
    readonly after: Digest;
    readonly outcome: "unchanged" | "rewritten";
}
/**
 * A stop a `turn.step` gate requested: who requested it, and why. It is a refusal the Turn
 * acts on rather than a status the interceptor wrote, because an Interceptor holds no lease
 * and is no CommitWriter (§5.2), so it can end nothing itself.
 */
export interface TurnStopRequest {
    readonly interceptor: string;
    readonly contributor: string;
    readonly reason: string;
}
export interface TurnInterceptionResult {
    readonly value: FacetData;
    readonly traces: readonly TurnInterceptorTrace[];
    /** Present only when a `turn.step` gate requested a stop. */
    readonly stop: TurnStopRequest | undefined;
}
/**
 * Domain facts a Turn-bound cut point needs. There is no target Facet and no Operation
 * here, so rule 2's opt-in has nothing to scope and rule 1's protection domain is the
 * whole of the boundary: a Facet fires at a Turn's cut points because it was placed in
 * that Turn's domain, and for no other reason.
 */
export interface TurnInterceptorDomainPort {
    turnDomain(turn: TurnId): ProtectionDomain;
    contributorDomain(contributor: FacetRef): ProtectionDomain | undefined;
}
/**
 * What a rewrite at one cut point may do to the value in flight. It is applied to every
 * interceptor's answer rather than to the final value, because the clauses it enforces are
 * per-rewriter — a `turn.step` annotation must name the interceptor that appended it, and a
 * malformed answer must not reach the next interceptor as if it were well formed. Refusal
 * is a throw; the runner turns it into a scoped block naming that interceptor.
 */
export type TurnRewriteRule = (before: FacetData, after: FacetData, interceptor: InterceptorDeclaration) => void;
/**
 * The seam the executor reaches the Turn-bound cut points through (SPEC §4.4, §5.6). It is
 * value-agnostic on purpose: the records a prompt section or a step context is made of
 * belong to the execution layer, so the projection to and from `FacetData` stays there and
 * this port carries only the schedule.
 */
export declare abstract class TurnCutPointPort {
    abstract run(cutPoint: TurnBoundCutPoint, turn: TurnId, value: FacetData, admit: TurnRewriteRule): TurnInterceptionResult;
}
export declare class TurnInterceptorRunner extends TurnCutPointPort {
    private readonly host;
    private readonly domains;
    constructor(host: FacetRuntimeHost, domains: TurnInterceptorDomainPort);
    run(cutPoint: TurnBoundCutPoint, turn: TurnId, input: FacetData, admit: TurnRewriteRule): TurnInterceptionResult;
    private candidates;
}
