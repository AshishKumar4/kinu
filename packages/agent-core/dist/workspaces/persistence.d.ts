import type { ActorRef } from "../actors/index.js";
import type { AuditRecordId } from "../interaction-references/index.js";
import { CatalogEntry, PromptSection, SettingsLayer, SurfaceRegistration, type CatalogEntryId, type ContributionAttribution, type PromptSectionId, type SettingsLayerId, type SurfaceId } from "../facets/index.js";
import { type AuthenticatedContribution } from "../definition/index.js";
import { JsonSchema, Revision } from "../core/index.js";
import type { TenantId } from "../identity/index.js";
import type { EventId, RouteProjectionId, RouteReservationId, SubscriptionId } from "../interaction-references/index.js";
import { Event } from "./event.js";
import { ContentRetentionReference, RetainedRecordKind, type ContentRetentionPort } from "./retention.js";
import { IngressEndpoint, type IngressEndpointMaterializationInit } from "./ingress-endpoint.js";
import { type EventCursor, type IngressEndpointId } from "./id.js";
import { AuthenticatedRouteProjection, RouteDelivery, RouteProjection, RouteReservation } from "./route.js";
import { Subscription, type SubscriptionInit } from "./subscription.js";
import { SurfaceEpoch } from "./surface-epoch.js";
import { View, ViewDelta, type JsonPatchEngine } from "./view.js";
import { WithdrawalDrainCapture } from "./withdrawal.js";
export declare const WORKSPACE_RECORD_KINDS: readonly ["catalogEntry", "contentRetention", "event", "ingressEndpoint", "promptSection", "routeDelivery", "routeProjection", "routeReservation", "settingsLayer", "subscription", "surfaceRegistration", "view", "viewDelta", "withdrawalDrainCapture"];
export type WorkspaceRecordKind = (typeof WORKSPACE_RECORD_KINDS)[number];
export declare const DELETABLE_WORKSPACE_RECORD_KINDS: readonly ["contentRetention", "view", "viewDelta"];
export type DeletableWorkspaceRecordKind = (typeof DELETABLE_WORKSPACE_RECORD_KINDS)[number];
/**
 * A trusted materializer supplies route behavior. The store derives the initial revision,
 * authenticated contribution attribution, and live state itself.
 */
export type SubscriptionMaterializationInit = Omit<SubscriptionInit, "contribution" | "retired" | "revision">;
export interface StoredWorkspaceRecord {
    readonly kind: WorkspaceRecordKind;
    readonly id: string;
    readonly bytes: Uint8Array;
}
export interface StoredWorkspaceUnique {
    readonly namespace: string;
    readonly key: string;
    readonly recordKey: string;
}
export interface StoredWorkspacePointer {
    readonly namespace: string;
    readonly key: string;
    readonly recordKey: string;
}
export interface WorkspaceRecordStorage {
    findRecord(kind: WorkspaceRecordKind, id: string): StoredWorkspaceRecord | undefined;
    listRecords(kind: WorkspaceRecordKind): readonly StoredWorkspaceRecord[];
    insertRecord(record: StoredWorkspaceRecord): void;
    deleteRecords(kind: DeletableWorkspaceRecordKind, ids: readonly string[]): void;
    findUnique(namespace: string, key: string): StoredWorkspaceUnique | undefined;
    insertUnique(unique: StoredWorkspaceUnique): void;
    findPointer(namespace: string, key: string): StoredWorkspacePointer | undefined;
    compareAndSetPointer(pointer: StoredWorkspacePointer, expectedRecordKey: string | undefined): void;
    deletePointer(namespace: string, key: string, expectedRecordKey: string): void;
}
export declare class WorkspacePersistence<Transaction> {
    private readonly storage;
    private readonly retention;
    private readonly actor;
    private readonly tenant;
    constructor(storage: (transaction: Transaction) => WorkspaceRecordStorage, retention: ContentRetentionPort<Transaction>, actor: ActorRef, tenant: TenantId);
    findCatalogEntry(transaction: Transaction, id: CatalogEntryId): CatalogEntry | undefined;
    catalogEntryAt(transaction: Transaction, origin: CatalogEntry["origin"]): CatalogEntry | undefined;
    listCatalogEntries(transaction: Transaction): readonly CatalogEntry[];
    listContributedCatalogEntries(transaction: Transaction, attribution: ContributionAttribution): readonly CatalogEntry[];
    putCatalogEntry(transaction: Transaction, entry: CatalogEntry): boolean;
    retireCatalogEntry(transaction: Transaction, id: CatalogEntryId): void;
    findPromptSection(transaction: Transaction, id: PromptSectionId): PromptSection | undefined;
    promptSectionAt(transaction: Transaction, origin: PromptSection["origin"]): PromptSection | undefined;
    listPromptSections(transaction: Transaction): readonly PromptSection[];
    listContributedPromptSections(transaction: Transaction, attribution: ContributionAttribution): readonly PromptSection[];
    putPromptSection(transaction: Transaction, section: PromptSection): boolean;
    retirePromptSection(transaction: Transaction, id: PromptSectionId): void;
    assembledPromptSections(transaction: Transaction): readonly PromptSection[];
    findSettingsLayer(transaction: Transaction, id: SettingsLayerId): SettingsLayer | undefined;
    settingsLayerAt(transaction: Transaction, origin: SettingsLayer["origin"]): SettingsLayer | undefined;
    listSettingsLayers(transaction: Transaction): readonly SettingsLayer[];
    listContributedSettingsLayers(transaction: Transaction, attribution: ContributionAttribution): readonly SettingsLayer[];
    putSettingsLayer(transaction: Transaction, layer: SettingsLayer): boolean;
    retireSettingsLayer(transaction: Transaction, id: SettingsLayerId): void;
    composedSettingsSchema(transaction: Transaction, base: JsonSchema): JsonSchema;
    findSurfaceRegistration(transaction: Transaction, surface: SurfaceId): SurfaceRegistration | undefined;
    /**
     * SPEC §6.3/§4.1: a View stream belongs to one registration generation, so no revision
     * of it becomes durable without the registration that authorizes it. Retirement
     * terminates the stream before it drops the pointer, so retirement's own terminal
     * revision is written while the registration still stands.
     */
    private requireSurfaceRegistration;
    listSurfaceRegistrations(transaction: Transaction): readonly SurfaceRegistration[];
    listContributedSurfaceRegistrations(transaction: Transaction, attribution: ContributionAttribution): readonly SurfaceRegistration[];
    putSurfaceRegistration(transaction: Transaction, registration: SurfaceRegistration): boolean;
    /**
     * SPEC §6.3/§4.1: the one place a Surface is retired. It terminates the Surface's View
     * stream and then drops the registration pointer. That order is load-bearing: every
     * durable View write requires a current registration, so terminating first is what
     * admits retirement's own terminal revision and refuses every ordinary write after it.
     * The registration record and the terminal View both survive, so the retired generation
     * stays readable forever, and the next registration of the same Surface ID opens a
     * stream at the next epoch.
     */
    retireSurfaceRegistration(transaction: Transaction, surface: SurfaceId): void;
    /**
     * The final ViewDelta of a Surface's current epoch: the patch that adds `terminal`. Its
     * cursor is the base View's own cursor, because this patch consumes no Event and a new
     * position would be a false statement. A Surface that was registered but never rendered
     * has no stream, no base revision, and no cursor, so retirement leaves no View behind.
     */
    private terminateViewStream;
    /**
     * The terminal View names exactly the content its base named, so its retention evidence
     * is the base's evidence re-issued against the new revision key. Without it, compacting
     * the base revision would release content the terminal View still refers to.
     */
    private carriedRetentions;
    /**
     * SPEC §4.1 (C13-FACET-WITHDRAWAL-DRAIN): freezes one withdrawal's drain set durably,
     * in the caller's own transaction — the transaction that retires the records and stops
     * admission. The capture is write-once per exact contribution: a replay of the same
     * withdrawal reads the frozen set back instead of re-freezing a later query, so the set
     * can never grow, and a replay that offers a different set is a corruption rather than
     * an update. The stored capture is returned, which is the set every later completion
     * attempt and every later admission answer from.
     */
    captureWithdrawalDrain(transaction: Transaction, capture: WithdrawalDrainCapture): WithdrawalDrainCapture;
    /** The frozen drain set of one exact contribution's withdrawal, or nothing if none began. */
    findWithdrawalDrain(transaction: Transaction, attribution: ContributionAttribution): WithdrawalDrainCapture | undefined;
    /**
     * Every withdrawal a Facet's releases have begun. An admission carries the release its
     * intent froze rather than the whole attribution, so the gate that refuses a withdrawn
     * release reads the Facet's captures and matches the pin itself (§4.1, §7.3).
     */
    listWithdrawalDrains(transaction: Transaction, contributor: ContributionAttribution["contributor"]): readonly WithdrawalDrainCapture[];
    currentIngressEndpoint(transaction: Transaction, id: IngressEndpointId): IngressEndpoint | undefined;
    listIngressEndpoints(transaction: Transaction): readonly IngressEndpoint[];
    listContributedIngressEndpoints(transaction: Transaction, attribution: ContributionAttribution): readonly IngressEndpoint[];
    createIngressEndpoint(transaction: Transaction, endpoint: IngressEndpoint): void;
    materializeIngressEndpoint(transaction: Transaction, contribution: AuthenticatedContribution, init: IngressEndpointMaterializationInit): IngressEndpoint;
    putManagedIngressEndpoint(transaction: Transaction, endpoint: IngressEndpoint): boolean;
    replaceIngressEndpoint(transaction: Transaction, endpoint: IngressEndpoint, expected: IngressEndpoint): void;
    retireIngressEndpoint(transaction: Transaction, id: IngressEndpointId): void;
    private putNewIngressEndpoint;
    private writeIngressEndpoint;
    private requireOwnTenant;
    private requireLiveIngressPathFree;
    findEvent(transaction: Transaction, id: EventId): Event | undefined;
    findEventByIdentity(transaction: Transaction, idempotencyKey: string): Event | undefined;
    appendEvent(transaction: Transaction, event: Event, retention: ContentRetentionReference): void;
    currentSubscription(transaction: Transaction, id: SubscriptionId): Subscription | undefined;
    listSubscriptions(transaction: Transaction): readonly Subscription[];
    /**
     * SPEC §4.1 (C13-FACET-WITHDRAWAL-EXACT): the live Subscriptions the exact
     * `ContributionAttribution` — the FacetRef and PackagePin pair of §4.2 — materialized,
     * found by querying the whole attribution. A different release of the same Facet is a
     * different contribution, so its Subscriptions are outside this query's result.
     */
    listContributedSubscriptions(transaction: Transaction, attribution: ContributionAttribution): readonly Subscription[];
    retireSubscription(transaction: Transaction, subscription: Subscription): void;
    /**
     * SPEC §4.1: the terminal rejected RouteDelivery the owning Actor writes for a
     * reservation appended against a Subscription the withdrawal retired and never admitted
     * by its target. Without it that reservation could never reach a terminal delivery,
     * because §6.2 gives it no other route to one.
     */
    appendWithdrawalRejection(transaction: Transaction, reservation: RouteReservation, audit: AuditRecordId, reason: string): RouteDelivery;
    /**
     * Writes a caller-created Subscription or a revision of an existing one. Attribution
     * never enters through initial generic creation: only materializeSubscription receives
     * the one-use capability that authenticated package installation provenance minted.
     */
    saveSubscription(transaction: Transaction, subscription: Subscription, expectedRevision: Revision | undefined): void;
    /**
     * The sole attributed creation seam. It consumes the capability during the synchronous
     * authenticated provenance callback and constructs the revision-zero record itself.
     */
    materializeSubscription(transaction: Transaction, contribution: AuthenticatedContribution, init: SubscriptionMaterializationInit): Subscription;
    putManagedSubscription(transaction: Transaction, attribution: ContributionAttribution, init: SubscriptionMaterializationInit): Subscription;
    private createSubscription;
    private writeSubscription;
    findReservation(transaction: Transaction, id: RouteReservationId): RouteReservation | undefined;
    findReservationByDedupe(transaction: Transaction, subscription: SubscriptionId, dedupeKey: string): RouteReservation | undefined;
    appendReservation(transaction: Transaction, reservation: RouteReservation, retention: ContentRetentionReference): void;
    listReservations(transaction: Transaction): readonly RouteReservation[];
    listReservationsForEvent(transaction: Transaction, event: EventId): readonly RouteReservation[];
    findProjection(transaction: Transaction, id: RouteProjectionId): RouteProjection | undefined;
    findProjectionByReservation(transaction: Transaction, reservation: RouteReservationId): RouteProjection | undefined;
    appendProjection(transaction: Transaction, authentication: AuthenticatedRouteProjection, retention: ContentRetentionReference): RouteProjection;
    findDelivery(transaction: Transaction, reservation: RouteReservationId): RouteDelivery | undefined;
    appendDelivery(transaction: Transaction, delivery: RouteDelivery): void;
    /**
     * The epoch a View written now belongs to. It is derived from the durable View records
     * rather than from a counter: an epoch that ever opened a stream keeps at least its
     * current View, because compaction is scoped to one stream, never deletes above its
     * floor, and refuses to delete a terminal View. So the highest stored epoch is the last
     * stream this Surface had, and the next stream opens after that one terminates.
     */
    currentSurfaceEpoch(transaction: Transaction, surface: string): SurfaceEpoch;
    currentView(transaction: Transaction, surface: string, epoch: SurfaceEpoch): View | undefined;
    findView(transaction: Transaction, surface: string, epoch: SurfaceEpoch, revision: Revision): View | undefined;
    /**
     * SPEC §6.3: the revision one opaque EventCursor names in one View stream. The cursor is
     * never parsed. Its position is the stored record that carries it, so a View and the
     * ViewDelta that produced it place the same cursor and the position survives while
     * either record does. Retirement's own delta repeats its base cursor, because that patch
     * consumes no Event, so one cursor can name two revisions of one stream. The lower one
     * is the answer, because replay from it skips no revision a client can still be missing.
     * A cursor no record of this stream carries has no position here, and a cursor issued by
     * another stream is the same fact for this reader.
     */
    findCursorRevision(transaction: Transaction, surface: string, epoch: SurfaceEpoch, cursor: EventCursor): Revision | undefined;
    saveView(transaction: Transaction, view: View, expectedRevision: Revision | undefined, retentions: readonly ContentRetentionReference[]): void;
    appendViewDelta(transaction: Transaction, delta: ViewDelta, patches: JsonPatchEngine, viewRetentions: readonly ContentRetentionReference[], deltaRetentions: readonly ContentRetentionReference[]): View;
    /**
     * The one write path every revision after the initial View takes, whether a Facet
     * published the patch or retirement authored it. Every one of them requires the
     * registration that authorizes the stream, which retirement still holds while it
     * terminates. Both the delta and the View it produces become durable together, and the
     * stream pointer advances to the new revision under compare-and-set.
     */
    private advanceView;
    private retainFor;
    listViewDeltas(transaction: Transaction, surface: string, epoch: SurfaceEpoch, after: Revision): readonly ViewDelta[];
    compactView(transaction: Transaction, surface: string, epoch: SurfaceEpoch, retainFrom: Revision): void;
    listRetentionsFor(transaction: Transaction, recordKind: RetainedRecordKind, recordKey: string): readonly ContentRetentionReference[];
    private currentRecord;
    private listCurrentRecords;
    private appendOrVerify;
    private append;
    /**
     * §8.4: a durable record may name content only if this Actor's content plane holds it,
     * and naming it registers the owner edge that keeps collection away from it. Both halves
     * happen inside the writer's transaction, so a faulted append leaves neither the record
     * nor the hold. Retirement releases through `releaseRetentions`; withdrawal, which
     * retires no record, releases nothing.
     */
    private retainNamedContent;
    private requireEventIndex;
    private requireReservationIndex;
    private releaseRetentions;
    private load;
    private requireLoad;
    private decodeStored;
}
export declare function validateWorkspacePointerAdvance(pointer: StoredWorkspacePointer, expectedRecordKey: string | undefined): void;
export declare function validateStoredWorkspaceRecord(record: StoredWorkspaceRecord): void;
export declare function validateWorkspaceUnique(unique: StoredWorkspaceUnique): void;
export declare function validateWorkspacePointer(pointer: StoredWorkspacePointer): void;
