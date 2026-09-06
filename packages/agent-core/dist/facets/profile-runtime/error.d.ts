import { AgentCoreError, type AgentCoreErrorCode } from "../../errors.js";
export declare class DetailedProfileError<DetailCode extends string = string> extends AgentCoreError {
    readonly detailCode: DetailCode;
    readonly detail: Readonly<{
        code: DetailCode;
    }>;
    constructor(code: AgentCoreErrorCode, detailCode: DetailCode, message: string);
}
