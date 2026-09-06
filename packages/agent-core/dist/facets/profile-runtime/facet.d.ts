import type { FacetManifest } from "../manifest.js";
import { OperationName, SurfaceId, type InterceptorId } from "../id.js";
import { Facet, type FacetLifecycleContext, type Interceptor, type Operation, type Surface } from "../runtime.js";
import type { ProfileRuntimeHostBinding } from "./runtime.js";
export declare abstract class ProfileFacetRuntime extends Facet {
}
export interface InternalProfileFacetRuntimeInit {
    readonly manifest: FacetManifest;
    readonly operations: readonly Operation[];
    readonly surfaces?: readonly Surface[];
    readonly interceptors?: readonly Interceptor[];
    readonly children?: readonly Facet[];
    readonly runtime: {
        readonly host: ProfileRuntimeHostBinding;
        readonly active: boolean;
        activate(): void;
        deactivate(): void;
    };
    readonly start?: (context: FacetLifecycleContext) => void | Promise<void>;
    readonly stop?: (context: FacetLifecycleContext) => void | Promise<void>;
}
export declare class InternalProfileFacetRuntime extends ProfileFacetRuntime {
    #private;
    private readonly init;
    constructor(init: InternalProfileFacetRuntimeInit);
    get ref(): ProfileRuntimeHostBinding["facet"];
    get manifest(): FacetManifest;
    get active(): boolean;
    operation(name: OperationName): Operation | undefined;
    surface(id: SurfaceId): Surface | undefined;
    interceptor(id: InterceptorId): Interceptor | undefined;
    children(): readonly Facet[];
    start(context: FacetLifecycleContext): Promise<void>;
    stop(context: FacetLifecycleContext): Promise<void>;
    private startOnce;
    private stopOnce;
}
