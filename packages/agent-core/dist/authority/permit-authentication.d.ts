import { type ActorRef } from "../actors/index.js";
import { Digest } from "../core/index.js";
import { AuthorityPermit, AuthorityPermitExpectation } from "./permit.js";
export declare abstract class AuthorityPermitIssuedRecordSource {
    abstract issued(issuer: ActorRef, nonce: string, digest: Digest): Promise<Uint8Array | undefined>;
}
export declare class AuthenticatedAuthorityPermit {
    #private;
    constructor(issuer: symbol, permit: AuthorityPermit);
    matches(permit: AuthorityPermit): boolean;
}
export declare class AuthorityPermitAuthenticator {
    private readonly source;
    constructor(source: AuthorityPermitIssuedRecordSource);
    authenticate(candidate: AuthorityPermit, expected: AuthorityPermitExpectation): Promise<AuthenticatedAuthorityPermit>;
}
export declare function requireAuthenticatedAuthorityPermit(authentication: AuthenticatedAuthorityPermit, permit: AuthorityPermit): void;
