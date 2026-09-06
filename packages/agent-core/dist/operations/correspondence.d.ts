import { FacetManifest, InterceptorDeclaration, OperationName, SurfaceId } from "../facets/index.js";
import { Operation } from "./runtime.js";
import type { Facet, FacetLifecycleContext, Interceptor, Surface } from "./runtime.js";
declare const validatedFacetToken: Readonly<{}>;
export declare class ValidatedFacet {
    private readonly source;
    private readonly operationMap;
    private readonly surfaceMap;
    private readonly interceptorMap;
    readonly ref: Facet["ref"];
    readonly manifest: FacetManifest;
    constructor(token: typeof validatedFacetToken, source: Facet, ref: Facet["ref"], manifest: FacetManifest, operationMap: ReadonlyMap<string, Operation>, surfaceMap: ReadonlyMap<string, Surface>, interceptorMap: ReadonlyMap<string, Interceptor>);
    operation(name: OperationName): Operation | undefined;
    surface(id: SurfaceId): Surface | undefined;
    interceptor(id: InterceptorDeclaration["id"]): Interceptor | undefined;
    start(context: FacetLifecycleContext): Promise<void>;
    stop(context: FacetLifecycleContext): Promise<void>;
}
export interface ValidatedFacetRuntime {
    readonly facets: readonly ValidatedFacet[];
}
export declare class FacetCorrespondenceValidator {
    static require(candidate: ValidatedFacet): ValidatedFacet;
    validate(expectedManifests: readonly FacetManifest[], roots: readonly Facet[]): ValidatedFacetRuntime;
}
export {};
