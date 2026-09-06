import { TextId } from "../../core/index.js";
export { RunCommitId, RunId, TurnId } from "../../execution-references/index.js";
export declare class AcceptanceId extends TextId {
    constructor(value: string);
}
export declare class RunBranchId extends TextId {
    constructor(value: string);
}
export declare class RunCheckpointId extends TextId {
    constructor(value: string);
}
export declare class TurnInboxEntryId extends TextId {
    constructor(value: string);
}
export declare class SpawnReservationId extends TextId {
    constructor(value: string);
}
