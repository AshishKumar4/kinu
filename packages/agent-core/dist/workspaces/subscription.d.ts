import { RecordCodec, Revision } from "../core/index.js";
import { ContributionAttribution, EventPattern, OperationRef, PayloadMapping, type DedupePolicy } from "../facets/index.js";
import { SubscriptionId } from "../interaction-references/index.js";
import type { RouteAuthority } from "./value.js";
export interface SubscriptionInit {
    readonly id: SubscriptionId;
    readonly revision: Revision;
    readonly source: EventPattern;
    readonly target: OperationRef;
    readonly mapping: PayloadMapping;
    readonly dedupe: DedupePolicy;
    readonly authority: RouteAuthority;
    /**
     * SPEC §4.2 (C13-FACET-CONTRIBUTION-ATTRIBUTION): present exactly when a Facet's
     * `commands` or `automations` contribution materialized this Subscription, absent when
     * a caller created it directly. Its presence is what puts the Subscription in that
     * Facet's §4.1 withdrawal set.
     */
    readonly contribution?: ContributionAttribution | undefined;
    /**
     * SPEC §4.1: present only on the revision a withdrawal writes, on the same terms as
     * `terminal` on a retired Surface's last View (§6.3). A retired Subscription resolves
     * no further reservation.
     */
    readonly retired?: true | undefined;
}
export declare class Subscription {
    static get codec(): RecordCodec<Subscription>;
    static encode(subscription: Subscription): Uint8Array;
    static decode(bytes: Uint8Array): Subscription;
    readonly id: SubscriptionId;
    readonly revision: Revision;
    readonly source: EventPattern;
    readonly target: OperationRef;
    readonly mapping: PayloadMapping;
    readonly dedupe: DedupePolicy;
    readonly authority: RouteAuthority;
    readonly contribution: ContributionAttribution | undefined;
    readonly retired: true | undefined;
    constructor(init: SubscriptionInit);
    revise(init: Omit<SubscriptionInit, "id" | "revision">): Subscription;
    /**
     * SPEC §4.1 (C13-FACET-WITHDRAWAL-EXACT): the retirement revision a withdrawal writes
     * for a Subscription its Facet's `commands` or `automations` contribution materialized.
     */
    retire(): Subscription;
}
