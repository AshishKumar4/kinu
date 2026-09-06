import { Digest, JsonSchema, type JsonSchemaValidator } from "../core/index.js";
import { SlotDeclaration, type AuthoredCodeBackingId, type AuthoredCodeConsumer, type FacetData, type FacetManifest, type IsolationMode } from "../facets/index.js";
import { Blueprint } from "./blueprint.js";
import { PlatformCompatibility } from "./compatibility.js";
import { BlueprintDeclarationCodecPort } from "./declaration.js";
import { PackageLock, PackagePin } from "./package-lock.js";
import { type PackageRelease } from "./package.js";
import { ValidationAttestation } from "./attestation.js";
import { type PlacementSelection } from "./placement.js";
import type { DefinitionPinSet } from "./pins.js";
export declare const CORE_SLOT_NAMES: Set<string>;
export interface BlueprintValidatorOptions {
    readonly lock: PackageLock;
    readonly releases: readonly PackageRelease[];
    readonly target: PlatformCompatibility;
    readonly declarationCodecs?: BlueprintDeclarationCodecPort;
    readonly placement: PlacementSourcePort;
    readonly schemaValidator?: JsonSchemaValidator;
    readonly baseConfigSchema?: JsonSchema;
    readonly coreSlots?: readonly SlotDeclaration[];
}
export interface ValidatedPlacement {
    readonly packageId: PackagePin["id"]["value"];
    readonly facetId: FacetManifest["id"]["value"];
    readonly facetVersion: string;
    readonly selection: PlacementSelection;
}
export declare abstract class PlacementSourcePort {
    abstract substrateModes(release: PackageRelease, manifest: FacetManifest): readonly IsolationMode[];
    /**
     * The backing the profile declares for a §4.7 consumer the Blueprint does not map,
     * or nothing when the profile declares no default. It is abstract rather than
     * defaulted because "this profile serves no authored code" is a statement a profile
     * makes, not one the validator may assume on its behalf: the absence is what
     * `C13-FACET-CODE-AVAILABILITY` refuses a `code`-available Operation against.
     */
    abstract authoredCodeBackingDefault(consumer: AuthoredCodeConsumer): AuthoredCodeBackingId | undefined;
}
export interface ValidatedContribution {
    readonly contributor: string;
    readonly index: number;
    readonly slot: string;
    readonly value: FacetData;
    /**
     * The §4.2 source pin of the release the contribution was read from. Declaration
     * validation sets it for every manifest contribution; only the Blueprint's own
     * slot projections (plan.ts) go without one, because a Blueprint-declared slot is
     * read from no release.
     */
    readonly package?: PackagePin;
}
export declare class ValidatedBlueprint {
    #private;
    readonly digest: Digest;
    private constructor();
    static validate(blueprint: Blueprint, options: BlueprintValidatorOptions): ValidatedBlueprint;
    get blueprint(): Blueprint;
    get lock(): PackageLock;
    get configSchema(): JsonSchema;
    get declarations(): readonly ValidatedContribution[];
    get releases(): readonly PackageRelease[];
    get attestation(): ValidationAttestation;
    get placements(): readonly ValidatedPlacement[];
    bytes(): Uint8Array;
    /**
     * Refuse a pinned Package closure that is not this Blueprint's closure (SPEC §9.1).
     * `validate` has already proven `lock` is the deterministic resolution of the declared
     * dependency relation from the Blueprint's own `packages` list, so equality against
     * `lock.packages` is equality against the transitive closure resolved to exact
     * versions — a pinned closure needs no second derivation to be checkable. A pin set
     * that merely looks complete is refused by the member it diverges on: naming a Package
     * the closure does not resolve, and pinning a resolved Package at another release, are
     * different errors and get different refusals.
     */
    requirePinnedClosure(pins: DefinitionPinSet): void;
}
export declare class BlueprintValidator {
    private readonly options;
    constructor(options: BlueprintValidatorOptions);
    validate(blueprint: Blueprint): ValidatedBlueprint;
}
export declare function validateBlueprint(blueprint: Blueprint, options: BlueprintValidatorOptions): ValidatedBlueprint;
