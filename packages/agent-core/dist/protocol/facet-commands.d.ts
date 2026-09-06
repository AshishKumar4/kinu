import type { ActorRef } from "../actors/index.js";
import { CodecDeclaration, Revision } from "../core/index.js";
import { ContributionAttribution, InstalledSlot, PackageInstallationRef, SlotDeclaration, SlotEntry, SlotName, type FacetData, type SlotWithdrawalSet } from "../facets/index.js";
import type { CurrentLease, ProtocolCommand } from "./dispatcher.js";
import type { CommandEnvelope } from "./envelope.js";
import type { CommandPayloadCodec } from "./payload.js";
import { CommandCallerPolicy } from "./policy.js";
import type { ProtocolCommandExecution, ProtocolValueCodec } from "./registration.js";
export declare const FACET_SLOT_COMMANDS: Readonly<{
    install: "facet.slot.install";
    contribute: "facet.slot.contribute";
    withdraw: "facet.slot.withdraw";
}>;
export interface FacetSlotCommandBackend<Transaction, Read, Stamp extends WeakKey = WeakKey> {
    currentRevision(read: Read): Revision;
    permitsInstall(read: Read, slot: InstalledSlot): boolean;
    prepareContribution(read: Read, envelope: CommandEnvelope): {
        readonly reference: PackageInstallationRef;
        readonly stamp: Stamp;
    } | undefined;
    applyInstall(transaction: Transaction, envelope: CommandEnvelope, stamp: Stamp, slot: InstalledSlot): boolean;
    applyContribution(transaction: Transaction, envelope: CommandEnvelope, stamp: Stamp, entry: SlotEntry): boolean;
    permitsContribution(read: Read, entry: SlotEntry): boolean;
    permitsWithdrawal(read: Read, attribution: ContributionAttribution): boolean;
    withdrawalSet(read: Read, attribution: ContributionAttribution): SlotWithdrawalSet;
    applyWithdrawal(transaction: Transaction, attribution: ContributionAttribution): boolean;
    slot(read: Read, name: SlotName): InstalledSlot | undefined;
    advanceRevision(transaction: Transaction, expected: Revision): Revision;
}
export interface SlotContributionRequest {
    readonly slot: SlotName;
    readonly ordinal: number;
    readonly value: FacetData;
}
export interface FacetSlotCommandReply {
    readonly revision: Revision;
}
export declare class FacetSlotInstallCommand<Transaction, Read, Stamp extends WeakKey = WeakKey> implements ProtocolCommand<Transaction, Read, SlotDeclaration, FacetSlotCommandReply, InstalledSlot> {
    #private;
    private readonly backend;
    private readonly target;
    readonly declaration: CodecDeclaration;
    readonly command: "facet.slot.install";
    readonly caller: CommandCallerPolicy;
    readonly expectedRevision: "required";
    readonly lease: "forbidden";
    readonly payload: CommandPayloadCodec<SlotDeclaration>;
    readonly replyCodec: FacetSlotReplyCodec;
    readonly observationCodec: ProtocolValueCodec<InstalledSlot>;
    constructor(backend: FacetSlotCommandBackend<Transaction, Read, Stamp>, target: ActorRef);
    authorize(read: Read, envelope: CommandEnvelope, payload: SlotDeclaration): boolean;
    permitsLifecycle(_read: Read, envelope: CommandEnvelope, payload: SlotDeclaration): boolean;
    currentRevision(read: Read, _envelope: CommandEnvelope, _payload: SlotDeclaration): Revision;
    currentLease(_read: Read, _envelope: CommandEnvelope, _payload: SlotDeclaration, _at: Date): CurrentLease | undefined;
    execute(transaction: Transaction, envelope: CommandEnvelope, payload: SlotDeclaration, _at: Date): ProtocolCommandExecution<FacetSlotCommandReply, InstalledSlot>;
}
/**
 * SPEC §4.1 (C13-FACET-WITHDRAWAL-EXACT): the `administer`-impact retirement of one
 * contribution's records in a single control transaction of the owning Actor. The set is
 * computed by querying attribution, so this command carries only the withdrawing
 * `ContributionAttribution` — the exact FacetRef and PackagePin pair — and never an inverse
 * the Facet supplied.
 */
export declare class FacetSlotWithdrawCommand<Transaction, Read> implements ProtocolCommand<Transaction, Read, ContributionAttribution, FacetSlotCommandReply> {
    private readonly backend;
    private readonly target;
    readonly declaration: CodecDeclaration;
    readonly command: "facet.slot.withdraw";
    readonly caller: CommandCallerPolicy;
    readonly expectedRevision: "required";
    readonly lease: "forbidden";
    readonly payload: SlotWithdrawalPayloadCodec;
    readonly replyCodec: FacetSlotReplyCodec;
    constructor(backend: FacetSlotCommandBackend<Transaction, Read>, target: ActorRef);
    authorize(read: Read, envelope: CommandEnvelope, payload: ContributionAttribution): boolean;
    permitsLifecycle(read: Read, _envelope: CommandEnvelope, payload: ContributionAttribution): boolean;
    currentRevision(read: Read, _envelope: CommandEnvelope, _payload: ContributionAttribution): Revision;
    currentLease(_read: Read, _envelope: CommandEnvelope, _payload: ContributionAttribution, _at: Date): CurrentLease | undefined;
    execute(transaction: Transaction, envelope: CommandEnvelope, payload: ContributionAttribution, _at: Date): ProtocolCommandExecution<FacetSlotCommandReply, never>;
}
export declare class FacetSlotContributeCommand<Transaction, Read, Stamp extends WeakKey = WeakKey> implements ProtocolCommand<Transaction, Read, SlotContributionRequest, FacetSlotCommandReply, SlotEntry> {
    #private;
    private readonly backend;
    private readonly target;
    readonly declaration: CodecDeclaration;
    readonly command: "facet.slot.contribute";
    readonly caller: CommandCallerPolicy;
    readonly expectedRevision: "required";
    readonly lease: "forbidden";
    readonly payload: CommandPayloadCodec<SlotContributionRequest>;
    readonly replyCodec: FacetSlotReplyCodec;
    readonly observationCodec: ProtocolValueCodec<SlotEntry>;
    constructor(backend: FacetSlotCommandBackend<Transaction, Read, Stamp>, target: ActorRef);
    authorize(read: Read, envelope: CommandEnvelope, payload: SlotContributionRequest): boolean;
    permitsLifecycle(read: Read, envelope: CommandEnvelope, payload: SlotContributionRequest): boolean;
    currentRevision(read: Read, _envelope: CommandEnvelope, _payload: SlotContributionRequest): Revision;
    currentLease(_read: Read, _envelope: CommandEnvelope, _payload: SlotContributionRequest, _at: Date): CurrentLease | undefined;
    execute(transaction: Transaction, envelope: CommandEnvelope, payload: SlotContributionRequest, _at: Date): ProtocolCommandExecution<FacetSlotCommandReply, SlotEntry>;
}
export declare const FacetSlotCommandPayload: Readonly<{
    install(declaration: SlotDeclaration): Uint8Array;
    withdraw(attribution: ContributionAttribution): Uint8Array;
    contribute(request: SlotContributionRequest): Uint8Array;
}>;
declare class FacetSlotReplyCodec implements ProtocolValueCodec<FacetSlotCommandReply> {
    encode(reply: FacetSlotCommandReply): Uint8Array;
    decode(bytes: Uint8Array): FacetSlotCommandReply;
}
declare class SlotWithdrawalPayloadCodec implements CommandPayloadCodec<ContributionAttribution> {
    decode(bytes: Uint8Array): ContributionAttribution;
}
export {};
