import type { FacetRef } from "../facets/index.js";
import type { InvocationId } from "../interaction-references/index.js";
import type { InvocationLedger } from "./ledger.js";
import type { InvocationPersistence } from "./persistence.js";
/**
 * SPEC §8.4 rule 2: the Invocation plane's rebuildable index from a frozen target to the
 * Invocations whose intent named it. It maps a target to identifiers and nothing else, so it
 * is disposable: the query below reads each named `PreparedInvocationHeader` back and keeps
 * only the ones whose `OperationPin` really names the Facet, which is what keeps the index
 * from becoming a second, authoritative copy of admission state.
 */
export interface PreparedInvocationTargetIndex<Transaction> {
    preparedForTarget(transaction: Transaction, target: string): readonly InvocationId[];
}
/**
 * SPEC §4.1 (C13-FACET-WITHDRAWAL-DRAIN): the admitted-item query a Facet withdrawal's drain
 * gate asks, answered from the Invocation plane's own durable records. `admitted` is a query
 * over `PreparedInvocationHeader` whose `OperationPin.target` names the Facet — the frozen
 * intent, never live activation state, so an item settles against the Facet the intent named
 * and never against whatever later occupies that `FacetRef`. `terminal` is that item's
 * current Receipt (§7.4): an item is terminal exactly when every one of its items has a
 * current Receipt and the derived batch outcome is not `indeterminate`, because an
 * indeterminate Receipt may still be superseded under C13-RECEIPT-FAILURE-KIND and a
 * withdrawal that treated it as settled would report completion over unfinished effect.
 *
 * It carries no state of its own: the drain set is closed by the withdrawal transaction that
 * stops admission and made durable by that transaction's Workspace-owned capture, not by a
 * second index here.
 */
export declare class InvocationDrainQuery<Transaction, Lease, Authority, Domain, PathEpochs, Admission> {
    private readonly index;
    private readonly persistence;
    private readonly ledger;
    constructor(index: PreparedInvocationTargetIndex<Transaction>, persistence: InvocationPersistence<Transaction, Lease, Authority, Domain, PathEpochs, Admission>, ledger: InvocationLedger<Transaction, Lease, Authority, Domain, PathEpochs, Admission>);
    admitted(transaction: Transaction, facet: FacetRef): readonly InvocationId[];
    terminal(transaction: Transaction, item: InvocationId): boolean;
}
