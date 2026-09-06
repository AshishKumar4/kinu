import type { Digest } from "../core/index.js";
import type { TenantId } from "../identity/index.js";
import { type CommandCaller, type CommandEnvelope } from "./envelope.js";
export declare class CommandAuthentication {
    #private;
    constructor(issuer: symbol, envelopeDigest: Digest, caller: CommandCaller, tenant: TenantId);
    matches(envelopeDigest: Digest, envelope: CommandEnvelope, tenant: TenantId): boolean;
}
export declare function commandAuthenticationMatches(authentication: CommandAuthentication | undefined, envelopeDigest: Digest, envelope: CommandEnvelope, tenant: TenantId): boolean;
export declare abstract class CommandAuthenticator<Transport> {
    private readonly tenant;
    protected constructor(tenant: TenantId);
    authenticate(transport: Transport, envelope: CommandEnvelope, envelopeDigest: Digest): Promise<CommandAuthentication | undefined>;
    protected abstract authenticateTransport(transport: Transport, envelope: CommandEnvelope): CommandCaller | undefined | Promise<CommandCaller | undefined>;
}
