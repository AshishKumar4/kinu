import type { GuestTrust, Membership, Project, Role, ShareOffer, Team, Workspace } from "../identity/index.js";
import type { Binding } from "./binding.js";
import type { ScopeEpoch } from "./epoch.js";
import { Grant } from "./grant.js";
import type { AuthorityReadStore } from "./service.js";
/** Whether a record already existed when the transaction that wrote it opened. */
export type AuthorityRecordPresence = "created" | "replaced";
/** The records of one kind a transaction wrote, keyed by the store's own record key. */
export declare class AuthorityRecordChanges<Record> {
    #private;
    record(key: string, value: Record, presence: AuthorityRecordPresence): void;
    written(): readonly Record[];
    replaced(): readonly Record[];
    isCreated(key: string): boolean;
}
/**
 * What one transaction wrote. Principals and the Tenant record are absent because no
 * cross-record invariant reads their content — only that they exist, which a write can
 * only make more true.
 */
export declare class AuthorityChangeSet {
    readonly teams: AuthorityRecordChanges<Team>;
    readonly projects: AuthorityRecordChanges<Project>;
    readonly workspaces: AuthorityRecordChanges<Workspace>;
    readonly guestTrusts: AuthorityRecordChanges<GuestTrust>;
    readonly roles: AuthorityRecordChanges<Role>;
    readonly memberships: AuthorityRecordChanges<Membership>;
    readonly grants: AuthorityRecordChanges<Grant>;
    readonly bindings: AuthorityRecordChanges<Binding>;
    readonly shareOffers: AuthorityRecordChanges<ShareOffer>;
    /** Nothing points at a Scope epoch, so stores record every epoch write as replaced. */
    readonly epochs: AuthorityRecordChanges<ScopeEpoch>;
}
/**
 * Re-derives every invariant that spans more than one Tenant authority record: Scope
 * canonicality, subject and Role existence, guest trust evidence, Binding-to-Grant
 * closure, attenuation acyclicity, share offer redemption evidence, and Role Grant
 * materialization equality. Both the Memory store and the SQLite ledger call it, so one
 * implementation decides what a consistent Tenant is on either backing.
 *
 * Passing the transaction's `changed` records audits those records and the ones whose
 * validity their change can break; passing nothing sweeps the whole store, which is what
 * opening or restoring a store does.
 */
export declare function assertAuthorityClosure(store: AuthorityReadStore, changed?: AuthorityChangeSet): void;
