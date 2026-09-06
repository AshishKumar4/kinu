import { Digest, type JsonSchemaDocument, type JsonValue } from "../../core/index.js";
import { Contributions, OperationDescriptor } from "../contribution.js";
import { type FacetData } from "../data.js";
import { PromptContribution } from "../prompt.js";
import { SlotDeclaration } from "../slot.js";
import { DetailedProfileError, ProfileControlContract, type EffectDispatch, type ProtectedProfileRuntimePort, type PublicProfileInput } from "../profile-runtime/index.js";
export interface McpSchemaBoundary {
    assertSchema(schema: JsonSchemaDocument): void;
}
export type McpToolDiscovery = {
    readonly name: string;
    readonly inputSchema: JsonSchemaDocument;
    readonly outputSchema: JsonSchemaDocument;
    readonly _meta?: Readonly<Record<string, JsonValue>>;
};
export type McpResourceDiscovery = {
    readonly name: string;
    readonly outputSchema: JsonSchemaDocument;
};
export type McpPromptDiscovery = {
    readonly title: string;
    readonly body: string;
};
export type McpDiscoveryDocument = {
    readonly revision: string;
    readonly tools: readonly McpToolDiscovery[];
    readonly resources: readonly McpResourceDiscovery[];
    readonly prompts: readonly McpPromptDiscovery[];
};
export interface McpDiscoveryResult {
    readonly operations: readonly OperationDescriptor[];
    readonly prompts: readonly McpPromptDiscovery[];
    readonly promptContribution: PromptContribution;
    readonly contributions: Contributions;
}
export interface McpFacetConfig {
    readonly remote: boolean;
    readonly maximumPrompts: number;
    readonly maximumPromptBytes: number;
}
export interface McpEmptyControlInput extends PublicProfileInput {
}
export interface McpCallInput extends PublicProfileInput {
    readonly operation: string;
    readonly arguments: JsonValue;
}
export declare const MCP_OPERATIONS: readonly OperationDescriptor[];
export declare const MCP_PROTOCOL_REVISION = "2025-11-25";
export declare const MCP_MAXIMUM_PROMPTS = 32;
export declare const MCP_MAXIMUM_PROMPT_BYTES = 262144;
export declare const MCP_IMPACT_ANNOTATION = "io.agent-core/impact";
export declare class McpDiscoveryRegistration {
    readonly document: McpDiscoveryDocument;
    readonly digest: Digest;
    constructor(document: McpDiscoveryDocument, expectedDigest?: Digest);
    static encode(registration: McpDiscoveryRegistration): Uint8Array;
    static decode(bytes: Uint8Array): McpDiscoveryRegistration;
    toData(): FacetData;
}
export declare abstract class McpDiscoveryRegistrationStore {
    abstract load(): McpDiscoveryRegistration | undefined;
    abstract save(registration: McpDiscoveryRegistration): void;
}
export declare class MemoryMcpDiscoveryRegistrationStore extends McpDiscoveryRegistrationStore {
    #private;
    constructor(snapshot?: Uint8Array);
    load(): McpDiscoveryRegistration | undefined;
    save(registration: McpDiscoveryRegistration): void;
    snapshot(): Uint8Array | undefined;
}
export declare class McpPromptMaterializationContract {
    readonly maximumPrompts: number;
    readonly maximumBytes: number;
    constructor(maximumPrompts: number, maximumBytes: number);
    materialize(prompts: readonly McpPromptDiscovery[]): PromptContribution;
}
export declare abstract class McpServerBackend {
    abstract start(): Promise<void>;
    abstract health(): Promise<boolean>;
    abstract stop(): Promise<void>;
    abstract discover(): Promise<McpDiscoveryDocument>;
    /**
     * Invokes a discovered tool carrying its canonical effect identity. The provider
     * MUST treat `dispatch.idempotencyKey` as the dedup key for the call and MUST be
     * able to answer a reconciliation query addressed by `dispatch.attempt` identity,
     * so a crash-after-send retry neither re-invokes the tool nor stays indeterminate
     * (SPEC §7.4).
     */
    abstract call(operation: string, input: JsonValue, dispatch: EffectDispatch): Promise<JsonValue>;
}
export declare class McpDiscoveryBackend {
    #private;
    private readonly config;
    private readonly schemas;
    constructor(config: McpFacetConfig, schemas: McpSchemaBoundary);
    discover(document: McpDiscoveryDocument): McpDiscoveryResult;
    validate(document: McpDiscoveryDocument): {
        readonly registration: McpDiscoveryRegistration;
        readonly result: McpDiscoveryResult;
    };
    restore(registration: McpDiscoveryRegistration): McpDiscoveryResult;
    private assertSchema;
}
export declare const MCP_CONTROL_CONTRACTS: Readonly<{
    start: ProfileControlContract<"mcp.start", McpEmptyControlInput, void>;
    health: ProfileControlContract<"mcp.health", McpEmptyControlInput, boolean>;
    stop: ProfileControlContract<"mcp.stop", McpEmptyControlInput, void>;
    discover: ProfileControlContract<"mcp.discover", McpEmptyControlInput, McpDiscoveryResult>;
}>;
export declare const MCP_PARENT_DECLARATION: Readonly<{
    lifecycle: readonly (ProfileControlContract<"mcp.health", McpEmptyControlInput, boolean> | ProfileControlContract<"mcp.start", McpEmptyControlInput, void> | ProfileControlContract<"mcp.stop", McpEmptyControlInput, void>)[];
    discovery: ProfileControlContract<"mcp.discover", McpEmptyControlInput, McpDiscoveryResult>;
}>;
export declare const MCP_PARENT_SLOT: SlotDeclaration;
export declare const MCP_PARENT_CONTRIBUTION: Readonly<{
    lifecycle: readonly string[];
    discovery: "mcp.discover";
    promptBounds: Readonly<{
        maximumPrompts: "config.maximumPrompts";
        maximumBytes: "config.maximumPromptBytes";
    }>;
}>;
export declare const MCP_CONTRIBUTIONS: Contributions;
export declare class McpFacet<Receipt> {
    #private;
    private readonly runtime;
    private readonly discovery;
    private readonly server;
    private readonly registrations;
    static readonly operations: readonly OperationDescriptor[];
    constructor(runtime: ProtectedProfileRuntimePort<Receipt>, discovery: McpDiscoveryBackend, server: McpServerBackend, registrations: McpDiscoveryRegistrationStore);
    start(input?: McpEmptyControlInput): Promise<void>;
    health(input?: McpEmptyControlInput): Promise<boolean>;
    stop(input?: McpEmptyControlInput): Promise<void>;
    discover(input?: McpEmptyControlInput): Promise<McpDiscoveryResult>;
    call(input: McpCallInput): Promise<JsonValue>;
    private install;
}
export type McpDiscoveryErrorCode = "revision.mismatch" | "schema.invalid" | "prompt.bound" | "name.duplicate" | "impact.invalid" | "registration.invalid" | "operation.missing";
export declare class McpDiscoveryError extends DetailedProfileError<McpDiscoveryErrorCode> {
    constructor(detailCode: McpDiscoveryErrorCode, message: string);
}
