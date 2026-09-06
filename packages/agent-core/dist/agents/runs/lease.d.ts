import { RecordCodec, type JsonValue } from "../../core/index.js";
import { PrincipalRef } from "../../identity/index.js";
import { TurnId } from "./id.js";
export interface LeaseToken {
    readonly turn: TurnId;
    readonly holder: PrincipalRef;
    readonly epoch: number;
}
export declare function leaseTokensEqual(left: LeaseToken, right: LeaseToken): boolean;
export interface TurnLeaseVerifier {
    permits(token: LeaseToken): boolean;
}
export declare abstract class TurnLease {
    #private;
    readonly turn: TurnId;
    readonly holder: PrincipalRef | undefined;
    readonly epoch: number;
    static get codec(): RecordCodec<TurnLease>;
    protected constructor(turn: TurnId, holder: PrincipalRef | undefined, epoch: number, expiresAt: Date | undefined);
    get expiresAt(): Date | undefined;
    protected get expiresAtTime(): number | undefined;
    abstract admits(token: LeaseToken, now: Date): boolean;
    abstract claim(holder: PrincipalRef, now: Date, expiresAt: Date): TurnLease;
    abstract renew(holder: PrincipalRef, epoch: number, now: Date, expiresAt: Date): TurnLease;
    abstract reclaim(holder: PrincipalRef, now: Date, expiresAt: Date): TurnLease;
    abstract fence(): TurnLease;
    static encode(lease: TurnLease): Uint8Array;
    static decode(bytes: Uint8Array): TurnLease;
    static restore(turn: TurnId, holder: PrincipalRef | undefined, epoch: number, expiresAt: Date | undefined): TurnLease;
    static unclaimed(turn: TurnId): TurnLease;
    static toData(lease: TurnLease): JsonValue;
    static fromData(payload: JsonValue): TurnLease;
}
export declare class ExactTurnLease extends TurnLease {
    constructor(turn: TurnId, holder: PrincipalRef | undefined, epoch: number, expiresAt: Date | undefined);
    admits(token: LeaseToken, now: Date): boolean;
    claim(holder: PrincipalRef, now: Date, expiresAt: Date): TurnLease;
    renew(holder: PrincipalRef, epoch: number, now: Date, expiresAt: Date): TurnLease;
    reclaim(holder: PrincipalRef, now: Date, expiresAt: Date): TurnLease;
    fence(): TurnLease;
}
export declare function leaseTokenToData(token: LeaseToken): JsonValue;
export declare function leaseTokenFromData(value: JsonValue, name?: string): LeaseToken;
