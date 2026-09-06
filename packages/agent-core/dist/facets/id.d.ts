import { TextId } from "../core/index.js";
export declare class FacetPackageId extends TextId {
    constructor(value: string);
}
export declare class FacetRef extends TextId {
    readonly packageId: FacetPackageId;
    constructor(value: string);
}
export declare class BindingName extends TextId {
    constructor(value: string);
}
export declare class AuthoredCodeBackingId extends TextId {
    constructor(value: string);
}
export declare class OperationName extends TextId {
    constructor(value: string);
}
export declare class OperationRef extends TextId {
    readonly facet: FacetPackageId;
    readonly operation: OperationName;
    constructor(value: string);
}
export declare class EventKind extends TextId {
    constructor(value: string);
}
export declare class SurfaceId extends TextId {
    constructor(value: string);
}
export declare class SlotName extends TextId {
    constructor(value: string);
}
export declare class InterceptorId extends TextId {
    constructor(value: string);
}
export declare class SlotEntryId extends TextId {
    constructor(value: string);
}
export declare class PromptSectionId extends TextId {
    constructor(value: string);
}
export declare class SettingsLayerId extends TextId {
    constructor(value: string);
}
export declare class CatalogEntryId extends TextId {
    constructor(value: string);
}
