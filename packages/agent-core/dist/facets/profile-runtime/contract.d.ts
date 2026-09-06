import type { JsonSchema } from "../../core/index.js";
import { OperationDescriptor } from "../contribution.js";
import type { FacetData } from "../data.js";
import type { EventDeclaration } from "../event.js";
import type { ProfileWireCodec } from "./wire.js";
export interface PublicProfileInput {
    readonly authority?: never;
    readonly trust?: never;
    readonly lease?: never;
    readonly impact?: never;
    readonly invocationId?: never;
    readonly receiptId?: never;
    readonly provenance?: never;
}
export type ProfileOperationResultMode = "output" | "receipt";
export declare class ProfileOperationContract<Name extends string, Input, Output, ResultMode extends ProfileOperationResultMode = "output"> {
    readonly name: Name;
    readonly descriptor: OperationDescriptor;
    readonly inputCodec: ProfileWireCodec<Input>;
    readonly outputCodec: ProfileWireCodec<Output>;
    readonly resultMode: ResultMode;
    readonly __input: Input;
    readonly __output: Output;
    constructor(name: Name, descriptor: OperationDescriptor, inputCodec: ProfileWireCodec<Input>, outputCodec: ProfileWireCodec<Output>, resultMode: ResultMode);
    encodeInput(input: Input): FacetData;
    decodeInput(data: FacetData): Input;
    encodeOutput(output: Output): FacetData;
    decodeOutput(data: FacetData): Output;
    alias<Alias extends string>(name: Alias): ProfileOperationContract<Alias, Input, Output, ResultMode>;
}
export declare class ProfileEventContract<Kind extends string, Payload extends PublicProfileInput> {
    readonly kind: Kind;
    readonly declaration: EventDeclaration;
    readonly payloadCodec: ProfileWireCodec<Payload>;
    readonly __payload: Payload;
    constructor(kind: Kind, declaration: EventDeclaration, payloadCodec: ProfileWireCodec<Payload>);
    encodePayload(payload: Payload): FacetData;
    decodePayload(data: FacetData): Payload;
}
export declare class ProfileControlContract<Name extends string, Input extends PublicProfileInput, Output> {
    readonly name: Name;
    readonly input: JsonSchema;
    readonly output: JsonSchema;
    readonly inputCodec: ProfileWireCodec<Input>;
    readonly outputCodec: ProfileWireCodec<Output>;
    readonly __input: Input;
    readonly __output: Output;
    constructor(name: Name, input: JsonSchema, output: JsonSchema, inputCodec: ProfileWireCodec<Input>, outputCodec: ProfileWireCodec<Output>);
    encodeInput(input: Input): FacetData;
    decodeInput(data: FacetData): Input;
    encodeOutput(output: Output): FacetData;
    decodeOutput(data: FacetData): Output;
}
export type AnyProfileOperationContract = Pick<ProfileOperationContract<string, unknown, unknown, ProfileOperationResultMode>, "name" | "descriptor" | "resultMode">;
export type ProfileOperationInput<Contract> = Contract extends ProfileOperationContract<string, infer Input, unknown, ProfileOperationResultMode> ? Input : never;
export type ProfileOperationOutput<Contract> = Contract extends ProfileOperationContract<string, unknown, infer Output, ProfileOperationResultMode> ? Output : never;
export type ProfileOperationResult<Contract, Receipt> = Contract extends ProfileOperationContract<string, unknown, infer Output, infer ResultMode> ? ResultMode extends "receipt" ? Receipt : Output : never;
export type ProfileEventPayload<Contract> = Contract extends ProfileEventContract<string, infer Payload> ? Payload : never;
export type ProfileControlInput<Contract> = Contract extends ProfileControlContract<string, infer Input, unknown> ? Input : never;
export type ProfileControlOutput<Contract> = Contract extends ProfileControlContract<string, PublicProfileInput, infer Output> ? Output : never;
export type ProfileHandler<Input, Output, Context = void> = (input: Input, context: Context) => Output | Promise<Output>;
