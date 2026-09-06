import { j as TextId } from "./core-BjYGo1CC.js";
import { i as InvocationId } from "./interaction-references-D9spp037.js";
//#region src/slates/id.ts
var SlateId = class extends TextId {
	constructor(value) {
		super(value, "Slate ID");
	}
};
var SlateVersionId = class extends TextId {
	constructor(value) {
		super(value, "Slate version ID");
	}
};
var SlatePublicationId = class extends TextId {
	constructor(value) {
		super(value, "Slate publication ID");
	}
};
var SlateDeploymentId = class extends TextId {
	constructor(value) {
		super(value, "Slate deployment ID");
	}
};
var SlateResourceId = class extends TextId {
	constructor(value) {
		super(value, "Slate resource ID");
	}
};
var SlatePreviewId = class extends TextId {
	constructor(value) {
		super(value, "Slate preview ID");
	}
};
//#endregion
//#region src/slates/seams.ts
var SlateMutationSeam = class {};
var SlateEffectContext = class {
	invocationId;
	itemIndex;
	attemptOrdinal;
	idempotencyKey;
	constructor(invocationId, itemIndex, attemptOrdinal, idempotencyKey) {
		this.invocationId = invocationId;
		this.itemIndex = itemIndex;
		this.attemptOrdinal = attemptOrdinal;
		this.idempotencyKey = idempotencyKey;
		if (!(invocationId instanceof InvocationId)) throw new TypeError("Slate effect Invocation ID is invalid");
		if (!Number.isSafeInteger(itemIndex) || itemIndex < 0) throw new TypeError("Slate effect item index must be a non-negative safe integer");
		if (!Number.isSafeInteger(attemptOrdinal) || attemptOrdinal < 0) throw new TypeError("Slate effect attempt ordinal must be a non-negative safe integer");
		if (!isIdempotencyKey(idempotencyKey) || idempotencyKey.trim().length === 0 || idempotencyKey !== idempotencyKey.trim()) throw new TypeError("Slate effect idempotency key must be canonical");
		Object.freeze(this);
	}
	sameItem(other) {
		return this.invocationId.equals(other.invocationId) && this.itemIndex === other.itemIndex && this.idempotencyKey === other.idempotencyKey;
	}
};
function isIdempotencyKey(value) {
	return typeof value === "string";
}
var SlateInvocationSeam = class {};
var SlatePreviewValidationSeam = class {};
//#endregion
//#region src/slates/provider.ts
var SlateProvider = class {};
//#endregion
export { SlatePreviewValidationSeam as a, SlatePreviewId as c, SlateVersionId as d, SlateMutationSeam as i, SlatePublicationId as l, SlateEffectContext as n, SlateDeploymentId as o, SlateInvocationSeam as r, SlateId as s, SlateProvider as t, SlateResourceId as u };

//# sourceMappingURL=provider-574-Qv7K.js.map