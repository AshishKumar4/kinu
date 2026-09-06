import { TextId, type JsonValue } from "../core/index.js";
import type { TenantId } from "../identity/index.js";
export { PackageId } from "../definition-references/index.js";
export declare class MaterializationGenerationId extends TextId {
    constructor(value: string);
}
export declare class DeploymentKey extends TextId {
    constructor(value: string);
}
export declare class DeploymentId extends TextId {
    constructor(value: string);
    static derive(tenant: TenantId, key: DeploymentKey): DeploymentId;
}
/**
 * SPEC §4.1: the identity of one typed failed install. The digest covers exactly the
 * record's declared fields, so a decoded failure proves its own identity and two hosts
 * that record the same failure of the same contribution against the same Scope write one
 * row rather than two.
 */
export declare class FacetInstallFailureId extends TextId {
    constructor(value: string);
    static derive(declaredFields: JsonValue): FacetInstallFailureId;
}
