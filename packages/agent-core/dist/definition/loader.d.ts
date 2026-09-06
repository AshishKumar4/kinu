import type { ContentStore } from "../content/index.js";
import type { PackageCodeModule } from "./code-manifest.js";
import type { PackageRelease } from "./package.js";
import type { PackagePin } from "./package-lock.js";
import type { IsolationMode } from "../facets/index.js";
import { type BlueprintValidatorOptions, type ValidatedBlueprint } from "./validator.js";
import type { Blueprint } from "./blueprint.js";
export interface VerifiedPackageModule {
    readonly pin: PackagePin;
    readonly release: PackageRelease;
    readonly module: PackageCodeModule;
    readonly bytes: Uint8Array;
    readonly selected: IsolationMode;
}
export declare abstract class PackageModuleEvaluator<Loaded> {
    abstract evaluate(module: VerifiedPackageModule): Promise<Loaded>;
    abstract dispose(module: LoadedPackageModule<Loaded>): void | Promise<void>;
}
export declare abstract class PackageModuleInspector {
    abstract imports(module: PackageCodeModule, bytes: Uint8Array): Promise<readonly string[]>;
}
export declare abstract class PackageCorrespondencePort<Loaded> {
    abstract validate(release: PackageRelease, modules: readonly LoadedPackageModule<Loaded>[]): Promise<void>;
}
export interface LoadedPackageModule<Loaded> {
    readonly release: PackageRelease;
    readonly module: PackageCodeModule;
    readonly value: Loaded;
}
export interface LoadedBlueprint<Loaded> {
    readonly validated: ValidatedBlueprint;
    readonly modules: readonly LoadedPackageModule<Loaded>[];
    dispose(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
}
export interface BlueprintLoaderOptions<Loaded> extends BlueprintValidatorOptions {
    readonly content: Pick<ContentStore, "get">;
    readonly inspector: PackageModuleInspector;
    readonly evaluator: PackageModuleEvaluator<Loaded>;
    readonly correspondence: PackageCorrespondencePort<Loaded>;
}
export declare class BlueprintLoader<Loaded> {
    #private;
    constructor(options: BlueprintLoaderOptions<Loaded>);
    load(blueprint: Blueprint): Promise<LoadedBlueprint<Loaded>>;
}
