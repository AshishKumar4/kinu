import { type JsonValue } from "../core/index.js";
import { SlateBackend, type EffectDispatch, type SlateCommitInput, type SlateDeployInput, type SlateForkInput, type SlatePublishInput, type SlateRollbackInput, type SlateUpdateInput } from "../facets/index.js";
import { SlateRuntime } from "../slates/index.js";
export type SlateRuntimePort = Pick<SlateRuntime, "update" | "commit" | "fork" | "publish" | "deploy" | "rollback">;
export declare class SlateRuntimeBackend extends SlateBackend {
    private readonly runtime;
    constructor(runtime: SlateRuntimePort);
    update(input: SlateUpdateInput): Promise<JsonValue>;
    commit(input: SlateCommitInput): Promise<JsonValue>;
    fork(input: SlateForkInput): Promise<JsonValue>;
    publish(input: SlatePublishInput): Promise<JsonValue>;
    deploy(input: SlateDeployInput, dispatch: EffectDispatch): Promise<JsonValue>;
    rollback(input: SlateRollbackInput): Promise<JsonValue>;
}
