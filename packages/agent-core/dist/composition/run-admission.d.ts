import { RunAdmissionValidationPort, type RunAdmissionReservation, type RunRepository } from "../agents/index.js";
export declare class DurableRunAdmissionPort<Transaction> extends RunAdmissionValidationPort<Transaction> {
    private readonly repository;
    constructor(repository: RunRepository<Transaction>);
    accepts(transaction: Transaction, reservation: RunAdmissionReservation): boolean;
}
