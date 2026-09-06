import { D as encodeCanonicalJson, E as decodeCanonicalJson, F as isJsonString, M as hasExactJsonKeys, P as isJsonObject, R as jsonDataParser, T as compareCanonicalText, _ as ContentRef, d as CodecDeclaration, f as RecordCodec, g as Revision, i as SemVer, j as TextId, k as AgentCoreError, l as requireNonempty, o as isMember, t as JsonSchema, v as contentRetentionFields, y as Digest } from "./core-BjYGo1CC.js";
import { d as ActorRef, f as ActorId, o as requireSynchronousResult } from "./actors-DJsP1nFM.js";
import { I as PackageId, V as PlacementIntersection, _t as canonicalFacetDataMap, at as FacetPackageId, ct as OperationName, gt as canonicalFacetData, lt as OperationRef, xt as isFacetDataMap, z as PLACEMENT_PREFERENCE } from "./runtime-z1yMP0an.js";
import { a as ApprovalId, c as ItemClaimId, l as ReceiptId, n as RunCommitId, o as ClaimWorkerId, s as EffectAttemptId, u as WriteRecordId } from "./facets-D01bKQBL.js";
import { C as PrincipalRef, P as PrincipalId, z as TenantId } from "./identity-CoqhjOFj.js";
import { a as RouteProjectionId, i as InvocationId, n as CorrelationId, o as RouteReservationId, r as EventId, t as AuditRecordId } from "./interaction-references-D9spp037.js";
import { _t as preferredPlacement, st as POLICY_IMPACTS } from "./definition-COokGikL.js";
import { _ as ConfirmedOperationFailure, b as OperationRequestKey } from "./operations-BcSnYjIs.js";
//#region src/invocations/admitted-item.ts
/**
* One admitted item of one Invocation, named by exactly the four facts a later message about
* it must match: the Invocation, the item index, that item's idempotency key, and the exact
* EffectAttempt admission recorded (§7.3, §7.4).
*
* It is derived and disposable, never stored. §8.4 gives each record one owning Actor and
* forbids a second durable copy, so this value reads the PreparedInvocation and the
* EffectAttempt that already exist and holds nothing else. It deliberately carries no Receipt
* and no result: it names work that has been admitted, which is the one thing a Receipt
* cannot say, and a value that could carry an outcome would let a caller treat a finished
* item as an admitted one.
*/
var AdmittedInvocationItem = class AdmittedInvocationItem {
	invocation;
	itemIndex;
	itemKey;
	attempt;
	/**
	* Reads the item off the two records that own its facts, refusing an attempt that does not
	* belong to exactly this prepared item. Every caller obtains the value this way, so
	* "the attempt matches the item" is established once instead of at each use.
	*/
	static derive(prepared, attempt) {
		const item = prepared.item(attempt.itemIndex);
		if (!attempt.invocation.equals(prepared.header.id) || attempt.idempotencyKey !== item.idempotencyKey) throw new AgentCoreError("invocation.invalid", "EffectAttempt does not belong to its PreparedInvocation item");
		return new AdmittedInvocationItem({
			invocation: prepared.header.id,
			itemIndex: attempt.itemIndex,
			itemKey: item.idempotencyKey,
			attempt: attempt.id
		});
	}
	constructor(init) {
		if (init.attempt.constructor !== EffectAttemptId) throw new TypeError("Admitted Invocation item names its exact EffectAttempt");
		if (!Number.isSafeInteger(init.itemIndex) || init.itemIndex < 0) throw new TypeError("Admitted Invocation item index is invalid");
		if (init.itemKey.length === 0 || init.itemKey !== init.itemKey.trim()) throw new TypeError("Admitted Invocation item key must be canonical");
		this.invocation = init.invocation;
		this.itemIndex = init.itemIndex;
		this.itemKey = init.itemKey;
		this.attempt = init.attempt;
		Object.freeze(this);
	}
	/** True exactly when the four scalar facts a delivery carries name this item. */
	names(invocation, itemIndex, itemKey, attempt) {
		return this.invocation.equals(invocation) && this.itemIndex === itemIndex && this.itemKey === itemKey && this.attempt.equals(attempt);
	}
	equals(other) {
		return other instanceof AdmittedInvocationItem && other.names(this.invocation, this.itemIndex, this.itemKey, this.attempt);
	}
};
//#endregion
//#region src/invocations/codec.ts
var structuralCodecBrand = Symbol("agent-core.structural-codec");
var structuralCodecMarker = true;
var structuralCodecs = /* @__PURE__ */ new WeakSet();
/**
* Creates a codec from trusted canonical functions. The returned operations cannot be
* redirected; purity and determinism of supplied closures remain the SPEC section 14 trust
* boundary.
*/
function structuralCodec(encode, decode) {
	const codec = Object.freeze({
		[structuralCodecBrand]: structuralCodecMarker,
		decode: decode.bind(void 0),
		encode: encode.bind(void 0)
	});
	structuralCodecs.add(codec);
	return codec;
}
function copyStructuralCodec(codec) {
	if (!structuralCodecs.has(codec)) throw new TypeError("Structural codecs must be created by structuralCodec");
	return structuralCodec(codec.encode, codec.decode);
}
var parse = jsonDataParser((message) => new TypeError(message));
function requireObject(value, subject) {
	return parse.object(value, subject);
}
function requireExactObject(value, fields, subject) {
	return parse.exact(requireObject(value, subject), fields, subject);
}
function requireString(object, key, subject = key) {
	return parse.string(object[key], subject);
}
function requireNullableString(object, key, subject = key) {
	const value = object[key];
	if (value === null) return void 0;
	if (!isString(value)) throw new TypeError(`${subject} must be a string or null`);
	return value;
}
function requireSafeInteger(object, key, subject = key) {
	const value = object[key];
	if (!isSafeInteger(value)) throw new TypeError(`${subject} must be a safe integer`);
	return value;
}
function requireNonnegativeInteger(object, key) {
	const value = requireSafeInteger(object, key);
	if (value < 0) throw new TypeError(`${key} must be non-negative`);
	return value;
}
function requireDate(object, key) {
	const value = requireString(object, key);
	const date = new Date(value);
	if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new TypeError(`${key} must be a canonical ISO date`);
	return date;
}
function requireNullableDate(object, key) {
	if (object[key] === null) return void 0;
	return requireDate(object, key);
}
function requireDigest(object, key) {
	return new Digest(requireString(object, key));
}
function requireArray(object, key) {
	return parse.array(object[key], key);
}
function requireCanonicalText(value, subject) {
	if (value.length === 0 || value !== value.trim()) throw new TypeError(`${subject} must be nonblank canonical text`);
}
function validDate(value, subject) {
	const time = value.getTime();
	if (!Number.isFinite(time)) throw new TypeError(`${subject} must be a valid Date`);
	return time;
}
function sameJson(left, right) {
	const leftBytes = encodeCanonicalJson(left);
	const rightBytes = encodeCanonicalJson(right);
	return leftBytes.byteLength === rightBytes.byteLength && leftBytes.every((value, index) => value === rightBytes[index]);
}
function immutableReference(value) {
	return requireFrozenReference(value, /* @__PURE__ */ new WeakSet());
}
function requireFrozenReference(value, seen) {
	if (isCallable(value)) throw new TypeError("Structural references must not contain functions");
	if (!isReferenceObject(value)) return value;
	if (value instanceof Date || value instanceof Map || value instanceof Set || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) throw new TypeError("Structural references must use immutable codec values");
	if (value instanceof TextId) {
		if (Object.getPrototypeOf(Object.getPrototypeOf(value)) !== TextId.prototype) throw new TypeError("Structural identifier references must use exact context classes");
		return Object.freeze(value);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) throw new TypeError("Structural references must use data-only prototypes");
	if (seen.has(value)) throw new TypeError("Structural references must not contain cycles");
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		if (!isStringPropertyKey(key)) throw new TypeError("Structural references must not contain symbol keys");
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === void 0 || !("value" in descriptor)) throw new TypeError("Structural references must not contain accessors");
		requireFrozenReference(descriptor.value, seen);
	}
	seen.delete(value);
	return Object.freeze(value);
}
function isSafeInteger(value) {
	return Number.isSafeInteger(value);
}
function isString(value) {
	return typeof value === "string";
}
function isCallable(value) {
	return typeof value === "function";
}
function isReferenceObject(value) {
	return typeof value === "object" && value !== null;
}
function isStringPropertyKey(value) {
	return typeof value === "string";
}
//#endregion
//#region src/invocations/error.ts
var InvocationError = class extends AgentCoreError {
	failure;
	constructor(failure, message) {
		super("invocation.invalid", message);
		this.failure = failure;
		this.name = "InvocationError";
	}
};
function invocationError(failure, message) {
	return new InvocationError(failure, message);
}
//#endregion
//#region src/invocations/approval.ts
var Approval = class Approval {
	id;
	invocation;
	intentDigest;
	revision;
	#requestedAt;
	#expiresAt;
	#state;
	static encode(record) {
		return ApprovalCodec.encode(record);
	}
	static decode(bytes) {
		return ApprovalCodec.decode(bytes);
	}
	constructor(id, invocation, intentDigest, requestedAt, expiresAt, revision, state) {
		this.id = id;
		this.invocation = invocation;
		this.intentDigest = intentDigest;
		this.revision = revision;
		if (id.constructor !== ApprovalId || invocation.constructor !== InvocationId) throw new TypeError("Approval identifiers must use exact context classes");
		Object.freeze(intentDigest);
		this.#requestedAt = validDate(requestedAt, "Approval request time");
		this.#expiresAt = expiresAt === void 0 ? void 0 : validDate(expiresAt, "Approval expiry");
		if (this.#expiresAt !== void 0 && this.#expiresAt <= this.#requestedAt) throw new TypeError("Approval expiry must be after its request time");
		this.#state = copyState$1(state);
		validateState(this.#state, this.#requestedAt, this.#expiresAt, revision.value);
		Object.freeze(this);
	}
	static pending(id, invocation, intentDigest, requestedAt, expiresAt) {
		return new Approval(id, invocation, intentDigest, requestedAt, expiresAt, Revision.initial(), { kind: "pending" });
	}
	get requestedAt() {
		return new Date(this.#requestedAt);
	}
	get expiresAt() {
		return this.#expiresAt === void 0 ? void 0 : new Date(this.#expiresAt);
	}
	get state() {
		return copyState$1(this.#state);
	}
	approve(by, at) {
		this.requirePending("approve");
		this.requireBeforeExpiry(at);
		return this.transition({
			kind: "approved",
			by,
			at
		});
	}
	deny(by, at, reason) {
		this.requirePending("deny");
		this.requireBeforeExpiry(at);
		return this.transition({
			kind: "denied",
			by,
			at,
			reason
		});
	}
	expire(at) {
		this.requirePending("expire");
		const expiresAt = this.#expiresAt;
		const time = validDate(at, "Approval expiration time");
		if (expiresAt === void 0 || time < expiresAt) throw new AgentCoreError("invocation.invalid", "Approval cannot expire before its deadline");
		return this.transition({
			kind: "expired",
			at
		});
	}
	consume(firstAttempt, at) {
		if (this.state.kind !== "approved") throw new AgentCoreError("invocation.invalid", "Approval consumption requires approved state");
		this.requireBeforeExpiry(at);
		if (validDate(at, "Approval consumption time") < this.state.at.getTime()) throw invocationError("state.invalid-transition", "Approval consumption cannot precede approval");
		return this.transition({
			kind: "consumed",
			by: this.state.by,
			approvedAt: this.state.at,
			at,
			firstAttempt
		});
	}
	transition(state) {
		return new Approval(this.id, this.invocation, this.intentDigest, this.requestedAt, this.expiresAt, this.revision.next(), state);
	}
	requirePending(action) {
		if (this.state.kind !== "pending") throw new AgentCoreError("invocation.invalid", `Approval ${action} requires pending state`);
	}
	requireBeforeExpiry(at) {
		const time = validDate(at, "Approval decision time");
		if (time < this.#requestedAt) throw invocationError("state.invalid-transition", "Approval decision cannot precede request");
		if (this.#expiresAt !== void 0 && time >= this.#expiresAt) throw new AgentCoreError("invocation.invalid", "Approval decision is past its expiry");
	}
};
var ApprovalRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			Approval,
			Revision,
			TextId,
			Digest,
			ApprovalId,
			InvocationId,
			EffectAttemptId,
			PrincipalId
		], "invocation.approval", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(record) {
		return {
			expiresAt: record.expiresAt?.toISOString() ?? null,
			id: record.id.value,
			intentDigest: record.intentDigest.value,
			invocation: record.invocation.value,
			requestedAt: record.requestedAt.toISOString(),
			revision: record.revision.value,
			state: encodeState(record.state)
		};
	}
	decodePayload(payload, _version) {
		const object = requireExactObject(payload, [
			"expiresAt",
			"id",
			"intentDigest",
			"invocation",
			"requestedAt",
			"revision",
			"state"
		], "Approval");
		return new Approval(new ApprovalId(requireString(object, "id")), new InvocationId(requireString(object, "invocation")), requireDigest(object, "intentDigest"), requireDate(object, "requestedAt"), requireNullableDate(object, "expiresAt"), new Revision(requireNonnegativeInteger(object, "revision")), decodeState(object["state"]));
	}
};
function encodeState(state) {
	switch (state.kind) {
		case "pending": return { kind: state.kind };
		case "approved": return {
			at: state.at.toISOString(),
			by: state.by.value,
			kind: state.kind
		};
		case "denied": return {
			at: state.at.toISOString(),
			by: state.by.value,
			kind: state.kind,
			reason: state.reason
		};
		case "expired": return {
			at: state.at.toISOString(),
			kind: state.kind
		};
		case "consumed": return {
			approvedAt: state.approvedAt.toISOString(),
			at: state.at.toISOString(),
			by: state.by.value,
			firstAttempt: state.firstAttempt.value,
			kind: state.kind
		};
	}
}
function decodeState(value) {
	const kind = requireString(requireExactObjectForState(value), "kind");
	switch (kind) {
		case "pending":
			requireExactObject(value, ["kind"], "Pending approval state");
			return Object.freeze({ kind });
		case "approved": {
			const exact = requireExactObject(value, [
				"at",
				"by",
				"kind"
			], "Approved state");
			return copyState$1({
				kind,
				by: new PrincipalId(requireString(exact, "by")),
				at: requireDate(exact, "at")
			});
		}
		case "denied": {
			const exact = requireExactObject(value, [
				"at",
				"by",
				"kind",
				"reason"
			], "Denied state");
			return copyState$1({
				kind,
				by: new PrincipalId(requireString(exact, "by")),
				at: requireDate(exact, "at"),
				reason: requireString(exact, "reason")
			});
		}
		case "expired": return copyState$1({
			kind,
			at: requireDate(requireExactObject(value, ["at", "kind"], "Expired state"), "at")
		});
		case "consumed": {
			const exact = requireExactObject(value, [
				"approvedAt",
				"at",
				"by",
				"firstAttempt",
				"kind"
			], "Consumed state");
			return copyState$1({
				kind,
				by: new PrincipalId(requireString(exact, "by")),
				approvedAt: requireDate(exact, "approvedAt"),
				at: requireDate(exact, "at"),
				firstAttempt: new EffectAttemptId(requireString(exact, "firstAttempt"))
			});
		}
		default: throw new TypeError("Approval state kind is invalid");
	}
}
function requireExactObjectForState(value) {
	if (!isJsonObject(value) || requireNullableString(value, "kind") === void 0) throw new TypeError("Approval state is malformed");
	return value;
}
function copyState$1(state) {
	switch (state.kind) {
		case "pending": return Object.freeze({ kind: state.kind });
		case "approved": return Object.freeze({
			kind: state.kind,
			by: state.by,
			at: new Date(state.at)
		});
		case "denied": return Object.freeze({
			kind: state.kind,
			by: state.by,
			at: new Date(state.at),
			reason: state.reason
		});
		case "expired": return Object.freeze({
			kind: state.kind,
			at: new Date(state.at)
		});
		case "consumed": return Object.freeze({
			kind: state.kind,
			by: state.by,
			approvedAt: new Date(state.approvedAt),
			at: new Date(state.at),
			firstAttempt: state.firstAttempt
		});
	}
}
function validateState(state, requestedAt, expiresAt, revision) {
	if (state.kind === "pending") {
		if (revision !== 0) throw new TypeError("Pending Approval must have initial revision");
		return;
	}
	const time = validDate(state.at, "Approval state time");
	if (time < requestedAt) throw new TypeError("Approval state cannot precede request");
	if (state.kind === "expired") {
		if (revision !== 1 || expiresAt === void 0 || time < expiresAt) throw new TypeError("Expired Approval must be its first transition at or after expiry");
		return;
	}
	if (state.kind === "denied" && state.reason.trim().length === 0) throw new TypeError("Approval denial reason must not be blank");
	if (state.kind === "approved" || state.kind === "denied") {
		if (revision !== 1 || expiresAt !== void 0 && time >= expiresAt) throw new TypeError("Approval decision must be its first transition before expiry");
		return;
	}
	const approvedAt = validDate(state.approvedAt, "Approval time");
	if (revision !== 2 || approvedAt < requestedAt || approvedAt > time || expiresAt !== void 0 && (approvedAt >= expiresAt || time >= expiresAt)) throw new TypeError("Consumed Approval must follow an unexpired approved transition");
}
var ApprovalCodec = new ApprovalRecordCodec();
//#endregion
//#region src/invocations/continuation.ts
var InvocationContinuation = class {
	invocation;
	intentDigest;
	approval;
	firstAttempt;
	firstItemIndex;
	firstOrdinal;
	firstClaim;
	firstItemKey;
	#admittedAt;
	firstClaimOwner;
	constructor(invocation, intentDigest, approval, firstAttempt, firstItemIndex, firstOrdinal, firstClaim, firstClaimOwner, firstItemKey, admittedAt) {
		this.invocation = invocation;
		this.intentDigest = intentDigest;
		this.approval = approval;
		this.firstAttempt = firstAttempt;
		this.firstItemIndex = firstItemIndex;
		this.firstOrdinal = firstOrdinal;
		this.firstClaim = firstClaim;
		this.firstItemKey = firstItemKey;
		if (invocation.constructor !== InvocationId || approval.constructor !== ApprovalId || firstAttempt.constructor !== EffectAttemptId || firstClaim.constructor !== ItemClaimId) throw new TypeError("InvocationContinuation identifiers must use exact context classes");
		requireIndex$1(firstItemIndex, "Continuation first item index");
		requireIndex$1(firstOrdinal, "Continuation first ordinal");
		if (firstItemKey.trim().length === 0 || firstItemKey !== firstItemKey.trim()) throw new TypeError("Continuation first item key must be canonical");
		this.firstClaimOwner = copyOwner$1(firstClaimOwner);
		this.#admittedAt = validDate(admittedAt, "Continuation admission time");
		Object.freeze(intentDigest);
		Object.freeze(this);
	}
	static encode(record, lease) {
		return new InvocationContinuationCodec(lease).encode(record);
	}
	static decode(bytes, lease) {
		return new InvocationContinuationCodec(lease).decode(bytes);
	}
	get admittedAt() {
		return new Date(this.#admittedAt);
	}
};
var InvocationContinuationCodec = class extends RecordCodec {
	#lease;
	constructor(lease) {
		super([
			InvocationContinuation,
			ActorRef,
			TextId,
			Digest,
			ApprovalId,
			InvocationId,
			ActorId,
			ItemClaimId,
			ClaimWorkerId,
			EffectAttemptId
		], "invocation.continuation", {
			major: 1,
			minor: 0
		});
		this.#lease = copyStructuralCodec(lease);
		Object.freeze(this);
	}
	encodePayload(record) {
		return {
			admittedAt: record.admittedAt.toISOString(),
			approval: record.approval.value,
			firstAttempt: record.firstAttempt.value,
			firstClaim: record.firstClaim.value,
			firstClaimOwner: encodeOwner$1(record.firstClaimOwner, this.#lease),
			firstItemIndex: record.firstItemIndex,
			firstItemKey: record.firstItemKey,
			firstOrdinal: record.firstOrdinal,
			intentDigest: record.intentDigest.value,
			invocation: record.invocation.value
		};
	}
	decodePayload(payload, _version) {
		const object = requireExactObject(payload, [
			"admittedAt",
			"approval",
			"firstAttempt",
			"firstClaim",
			"firstClaimOwner",
			"firstItemIndex",
			"firstItemKey",
			"firstOrdinal",
			"intentDigest",
			"invocation"
		], "Invocation continuation");
		return new InvocationContinuation(new InvocationId(requireString(object, "invocation")), requireDigest(object, "intentDigest"), new ApprovalId(requireString(object, "approval")), new EffectAttemptId(requireString(object, "firstAttempt")), requireNonnegativeInteger(object, "firstItemIndex"), requireNonnegativeInteger(object, "firstOrdinal"), new ItemClaimId(requireString(object, "firstClaim")), decodeOwner$1(object["firstClaimOwner"], this.#lease), requireString(object, "firstItemKey"), requireDate(object, "admittedAt"));
	}
};
function encodeOwner$1(owner, lease) {
	return owner.kind === "executor" ? {
		kind: owner.kind,
		token: lease.encode(owner.token),
		worker: owner.worker.value
	} : {
		actor: {
			id: owner.actor.id.value,
			kind: owner.actor.kind
		},
		kind: owner.kind,
		worker: owner.worker.value
	};
}
function decodeOwner$1(value, lease) {
	const object = requireExactObject(value, requireObject(value, "Continuation claim owner")["kind"] === "executor" ? [
		"kind",
		"token",
		"worker"
	] : [
		"actor",
		"kind",
		"worker"
	], "Continuation claim owner");
	const kind = requireString(object, "kind");
	if (kind === "executor") return Object.freeze({
		kind,
		token: lease.decode(object["token"]),
		worker: new ClaimWorkerId(requireString(object, "worker"))
	});
	if (kind !== "system") throw new TypeError("Continuation claim owner kind is invalid");
	const actor = requireExactObject(object["actor"], ["id", "kind"], "Continuation Actor");
	return Object.freeze({
		kind,
		actor: new ActorRef(requireActorKind$3(requireString(actor, "kind")), new ActorId(requireString(actor, "id"))),
		worker: new ClaimWorkerId(requireString(object, "worker"))
	});
}
function copyOwner$1(owner) {
	return owner.kind === "executor" ? Object.freeze({
		kind: owner.kind,
		token: immutableReference(owner.token),
		worker: owner.worker
	}) : Object.freeze({
		kind: owner.kind,
		actor: owner.actor,
		worker: owner.worker
	});
}
function requireActorKind$3(value) {
	if (value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate") return value;
	throw new TypeError("Continuation Actor kind is invalid");
}
function requireIndex$1(value, subject) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${subject} must be a non-negative safe integer`);
}
//#endregion
//#region src/invocations/ports.ts
var AuthorityAdmissionReference = class {
	digest;
	reference;
	constructor(reference, digest) {
		this.digest = digest;
		this.reference = immutableReference(reference);
		Object.freeze(digest);
		Object.freeze(this);
	}
};
//#endregion
//#region src/invocations/attempt.ts
var EffectAttempt = class {
	id;
	invocation;
	itemIndex;
	ordinal;
	claim;
	admission;
	idempotencyKey;
	auditCause;
	#startedAt;
	token;
	static encode(record, lease, admission) {
		return new EffectAttemptCodec(lease, admission).encode(record);
	}
	static decode(bytes, lease, admission) {
		return new EffectAttemptCodec(lease, admission).decode(bytes);
	}
	constructor(id, invocation, itemIndex, ordinal, claim, token, admission, startedAt, idempotencyKey, auditCause) {
		this.id = id;
		this.invocation = invocation;
		this.itemIndex = itemIndex;
		this.ordinal = ordinal;
		this.claim = claim;
		this.admission = admission;
		this.idempotencyKey = idempotencyKey;
		this.auditCause = auditCause;
		if (id.constructor !== EffectAttemptId || invocation.constructor !== InvocationId || claim.constructor !== ItemClaimId || auditCause.constructor !== AuditRecordId) throw new TypeError("EffectAttempt identifiers must use exact context classes");
		if (!Number.isSafeInteger(itemIndex) || itemIndex < 0 || !Number.isSafeInteger(ordinal) || ordinal < 0) throw new TypeError("Effect attempt item and ordinal must be non-negative safe integers");
		this.#startedAt = validDate(startedAt, "Effect attempt start time");
		this.token = token === void 0 ? void 0 : immutableReference(token);
		if (idempotencyKey.length === 0) throw new TypeError("Effect attempt idempotency key is required");
		Object.freeze(this);
	}
	get startedAt() {
		return new Date(this.#startedAt);
	}
};
var EffectAttemptCodec = class extends RecordCodec {
	#lease;
	#admission;
	constructor(lease, admission) {
		super([
			EffectAttempt,
			AuthorityAdmissionReference,
			TextId,
			Digest,
			InvocationId,
			ItemClaimId,
			AuditRecordId,
			EffectAttemptId
		], "invocation.effect-attempt", {
			major: 1,
			minor: 0
		});
		this.#lease = copyStructuralCodec(lease);
		this.#admission = copyStructuralCodec(admission);
		Object.freeze(this);
	}
	encodePayload(record) {
		return {
			admission: {
				digest: record.admission.digest.value,
				reference: this.#admission.encode(record.admission.reference)
			},
			auditCause: record.auditCause.value,
			claim: record.claim.value,
			id: record.id.value,
			idempotencyKey: record.idempotencyKey,
			invocation: record.invocation.value,
			itemIndex: record.itemIndex,
			ordinal: record.ordinal,
			startedAt: record.startedAt.toISOString(),
			token: record.token === void 0 ? null : this.#lease.encode(record.token)
		};
	}
	decodePayload(payload, _version) {
		const object = requireExactObject(payload, [
			"admission",
			"auditCause",
			"claim",
			"id",
			"idempotencyKey",
			"invocation",
			"itemIndex",
			"ordinal",
			"startedAt",
			"token"
		], "Effect attempt");
		const token = object["token"];
		return new EffectAttempt(new EffectAttemptId(requireString(object, "id")), new InvocationId(requireString(object, "invocation")), requireNonnegativeInteger(object, "itemIndex"), requireNonnegativeInteger(object, "ordinal"), new ItemClaimId(requireString(object, "claim")), token === null ? void 0 : this.#lease.decode(token), decodeAdmission(object["admission"], this.#admission), requireDate(object, "startedAt"), requireString(object, "idempotencyKey"), new AuditRecordId(requireString(object, "auditCause")));
	}
};
function decodeAdmission(value, codec) {
	const object = requireExactObject(value, ["digest", "reference"], "Authority admission reference");
	return new AuthorityAdmissionReference(codec.decode(object["reference"]), new Digest(requireString(object, "digest")));
}
//#endregion
//#region src/invocations/audit.ts
/**
* SPEC §7.4 admits a cause-free write audit root only for a command the dispatcher
* refused, so this context has to know which outcomes are refusals. It reads that from a
* declared table rather than from the `rejected` prefix the labels happen to share: a
* stored record is untrusted input, and a prefix test would hand a cause-free root — the
* one shape that breaks the audit chain — to any outcome string spelled to look like a
* refusal. Keyed by `WriteAuditOutcome`, so an outcome SPEC §8.5 adds does not compile
* until this table classifies it, and an outcome no vocabulary declares is absent here and
* therefore never a refusal.
*/
var WRITE_AUDIT_DISPOSITIONS = Object.freeze({
	committed: "committed",
	duplicate: "committed",
	rejectedAuthentication: "refused",
	rejectedAuthority: "refused",
	rejectedLease: "refused",
	rejectedLifecycle: "refused",
	rejectedMalformed: "refused",
	rejectedRevision: "refused"
});
/** Whether a write audit records a refusal, read from the declared partition. */
function writeAuditRefused(outcome) {
	return WRITE_AUDIT_DISPOSITIONS[outcome] === "refused";
}
/** Whether a decoded value is an outcome the same table declares. */
function isWriteAuditOutcome(value) {
	return isJsonString(value) && Object.hasOwn(WRITE_AUDIT_DISPOSITIONS, value);
}
function auditEvidenceIdentity(actor, kind) {
	return Digest.sha256(encodeCanonicalJson({
		domain: "agent-core.audit-evidence.v1",
		actor: {
			kind: actor.kind,
			id: actor.id.value
		},
		evidence: encodeKind(kind)
	}));
}
var AuditRecordCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			AuditRecord,
			ActorRef,
			TextId,
			ApprovalId,
			ActorId,
			RouteProjectionId,
			RouteReservationId,
			ReceiptId,
			RunCommitId,
			CorrelationId,
			AuditRecordId,
			TenantId,
			WriteRecordId,
			EffectAttemptId,
			InvocationId,
			EventId
		], "audit-record", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(record) {
		return {
			id: record.id.value,
			actor: {
				kind: record.actor.kind,
				id: record.actor.id.value
			},
			tenant: record.tenant.value,
			correlation: record.correlation.value,
			cause: record.cause?.value ?? null,
			evidence: encodeKind(record.kind)
		};
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "Audit record payload");
		const actor = requireObject(object["actor"], "Audit actor");
		if (!hasExactJsonKeys(object, [
			"actor",
			"cause",
			"correlation",
			"evidence",
			"id",
			"tenant"
		]) || !hasExactJsonKeys(actor, ["id", "kind"])) throw new TypeError("Audit record payload contains missing or unknown fields");
		const cause = requireNullableString(object, "cause", "Audit cause");
		const init = {
			id: new AuditRecordId(requireString(object, "id")),
			actor: new ActorRef(requireActorKind$2(actor["kind"]), new ActorId(requireString(actor, "id"))),
			tenant: new TenantId(requireString(object, "tenant")),
			correlation: new CorrelationId(requireString(object, "correlation")),
			kind: decodeKind(object["evidence"])
		};
		return new AuditRecord(cause === void 0 ? init : {
			...init,
			cause: new AuditRecordId(cause)
		});
	}
};
var AuditRecord = class AuditRecord {
	static get codec() {
		return auditRecordCodecInstance;
	}
	static encode(record) {
		return AuditRecord.codec.encode(record);
	}
	static decode(bytes) {
		return AuditRecord.codec.decode(bytes);
	}
	id;
	actor;
	tenant;
	correlation;
	cause;
	kind;
	constructor(init) {
		if (init.kind.kind === "invocation" && init.cause !== void 0) throw new TypeError("Invocation audit roots cannot have a cause");
		this.id = init.id;
		this.actor = new ActorRef(init.actor.kind, new ActorId(init.actor.id.value));
		this.tenant = new TenantId(init.tenant.value);
		this.correlation = init.correlation;
		this.cause = init.cause;
		this.kind = copyKind(init.kind);
		Object.freeze(this);
	}
};
var auditRecordCodecInstance = new AuditRecordCodecV1();
function validateAuditAppend(record, records, rootAdmission, evidence) {
	if (records.get(record.id) !== void 0) throw invocationError("audit.append-conflict", "Audit records are append-only");
	validateAuditRelation(record, records, rootAdmission, evidence);
}
function validateAuditRelation(record, records, rootAdmission, evidence) {
	if (record.cause === void 0) {
		validateRoot(record, rootAdmission, evidence);
		return;
	}
	validateStoredAuditLinkage(record, records);
	if (rootAdmission !== void 0) throw invocationError("audit.invalid-root", "Audit root admission is invalid for a caused record");
	const cause = records.get(record.cause);
	if (!isSubstantiatedEdge(cause.kind, record.kind, evidence, cause.id)) throw invocationError("audit.evidence-mismatch", `Audit edge ${cause.kind.kind} -> ${record.kind.kind} is not permitted`);
}
function validateStoredAuditLinkage(record, records) {
	if (record.cause === void 0) {
		if (!(record.kind.kind === "invocation" || record.kind.kind === "routeProjected" || record.kind.kind === "write" && writeAuditRefused(record.kind.outcome))) throw invocationError("audit.invalid-root", "Stored audit root kind is invalid");
		return;
	}
	const cause = records.get(record.cause);
	if (cause === void 0) throw invocationError("audit.missing-cause", "Audit cause must exist before append");
	if (!record.actor.equals(cause.actor) || !record.tenant.equals(cause.tenant) || !record.correlation.equals(cause.correlation)) throw invocationError("audit.cause-mismatch", "Audit cause must share actor, tenant, and correlation");
	if (!isPermittedEdge(cause.kind, record.kind)) throw invocationError("audit.evidence-mismatch", `Audit edge ${cause.kind.kind} -> ${record.kind.kind} is not permitted`);
}
function validateRoot(record, admission, evidence) {
	if (record.kind.kind === "invocation" && admission === void 0) return;
	if (record.kind.kind === "write" && writeAuditRefused(record.kind.outcome) && admission?.kind === "commandRejection") return;
	if (record.kind.kind === "routeProjected" && admission?.kind === "routeProjection" && record.kind.projection.equals(admission.projection) && record.kind.reservation.equals(admission.reservation) && projectionMatches(record, evidence)) return;
	throw invocationError("audit.invalid-root", "Audit record is not an admitted root");
}
function isPermittedEdge(cause, next) {
	if (cause.kind === "routeProjected") return next.kind === "delivery";
	if (cause.kind === "invocation") return next.kind === "approval" || next.kind === "attempt" || next.kind === "receipt" || next.kind === "write";
	if (cause.kind === "approval") {
		if (cause.phase === "approved") return next.kind === "attempt";
		if (cause.phase === "denied" || cause.phase === "expired") return next.kind === "receipt";
		return false;
	}
	if (cause.kind === "attempt") return next.kind === "receipt";
	if (cause.kind === "receipt") return next.kind === "receiptSuperseded" || next.kind === "event" || next.kind === "commit";
	if (cause.kind === "receiptSuperseded") return next.kind === "event" || next.kind === "commit";
	if (cause.kind === "event") return next.kind === "routeReserved";
	return cause.kind === "delivery" && next.kind === "commit";
}
function isSubstantiatedEdge(cause, next, evidence, causeId) {
	if (cause.kind === "invocation" && next.kind === "write") {
		const write = evidence?.write(next.id);
		return write === void 0 ? evidence === void 0 : write.invocation.equals(cause.id) && write.outcome === next.outcome;
	}
	if (evidence === void 0) return false;
	if (cause.kind === "routeProjected" && next.kind === "delivery") {
		const delivery = evidence.delivery(next.reservation);
		return cause.reservation.equals(next.reservation) && delivery?.reservation.equals(next.reservation) === true;
	}
	if (cause.kind === "invocation" && next.kind === "approval") {
		const approval = evidence.approval(next.id, next.phase);
		return approval?.phase === next.phase && approval.invocation.equals(cause.id);
	}
	if (cause.kind === "invocation" && next.kind === "attempt") {
		const attempt = evidence.attempt(next.id);
		return attempt?.invocation.equals(cause.id) === true && attempt.auditCause.equals(causeId);
	}
	if (cause.kind === "invocation" && next.kind === "receipt") {
		const receipt = evidence.receipt(next.id);
		return isPreEffect(next.outcome) && receipt?.outcome === next.outcome && receipt.invocation.equals(cause.id) && receipt.attempt === void 0;
	}
	if (cause.kind === "approval" && next.kind === "attempt") {
		const approval = evidence.approval(cause.id, cause.phase);
		const attempt = evidence.attempt(next.id);
		return cause.phase === "approved" && approval?.phase === cause.phase && attempt !== void 0 && attempt.auditCause.equals(causeId) && approval.invocation.equals(attempt.invocation);
	}
	if (cause.kind === "approval" && next.kind === "receipt") {
		const approval = evidence.approval(cause.id, cause.phase);
		const receipt = evidence.receipt(next.id);
		const expected = cause.phase === "denied" ? "deniedPreEffect" : "cancelledPreEffect";
		return next.outcome === expected && approval?.phase === cause.phase && receipt?.outcome === expected && receipt.attempt === void 0 && approval?.invocation.equals(receipt.invocation) === true;
	}
	if (cause.kind === "attempt" && next.kind === "receipt") {
		const receipt = evidence.receipt(next.id);
		return !isPreEffect(next.outcome) && receipt?.attempt?.equals(cause.id) === true && receipt.outcome === next.outcome;
	}
	if (cause.kind === "receipt" && next.kind === "receiptSuperseded") {
		const previous = evidence.receipt(next.previous);
		const current = evidence.receipt(next.next);
		return cause.id.equals(next.previous) && cause.outcome === "indeterminate" && previous?.outcome === "indeterminate" && previous !== void 0 && current !== void 0 && current.previous?.equals(next.previous) === true && previous.attempt !== void 0 && current.attempt?.equals(previous.attempt) === true && (current.outcome === "succeeded" || current.outcome === "failed");
	}
	if ((cause.kind === "receipt" || cause.kind === "receiptSuperseded") && next.kind === "event") {
		const receipt = cause.kind === "receipt" ? cause.id : cause.next;
		return evidence.event(next.id)?.receipt?.equals(receipt) === true;
	}
	if ((cause.kind === "receipt" || cause.kind === "receiptSuperseded") && next.kind === "commit") {
		const receipt = cause.kind === "receipt" ? cause.id : cause.next;
		return evidence.commit(next.id)?.receipt?.equals(receipt) === true;
	}
	if (cause.kind === "event" && next.kind === "routeReserved") return evidence.route(next.id)?.event.equals(cause.id) === true;
	return cause.kind === "delivery" && next.kind === "commit" && evidence.commit(next.id)?.reservation?.equals(cause.reservation) === true;
}
function isPreEffect(outcome) {
	return outcome === "deniedPreEffect" || outcome === "cancelledPreEffect";
}
function projectionMatches(record, evidence) {
	if (record.kind.kind !== "routeProjected" || evidence === void 0) return false;
	const projection = evidence.projection(record.kind.projection, record.kind.reservation);
	return projection !== void 0 && projection.actor.equals(record.actor) && projection.tenant.equals(record.tenant);
}
var AuditRecordCodec = AuditRecord.codec;
function copyKind(kind) {
	switch (kind.kind) {
		case "approval": return Object.freeze({
			kind: kind.kind,
			id: new ApprovalId(kind.id.value),
			phase: kind.phase
		});
		case "receipt": return Object.freeze({
			kind: kind.kind,
			id: new ReceiptId(kind.id.value),
			outcome: kind.outcome
		});
		case "receiptSuperseded": return Object.freeze({
			kind: kind.kind,
			previous: new ReceiptId(kind.previous.value),
			next: new ReceiptId(kind.next.value)
		});
		case "write": return Object.freeze({
			kind: kind.kind,
			id: new WriteRecordId(kind.id.value),
			outcome: kind.outcome
		});
		case "routeProjected": return Object.freeze({
			kind: kind.kind,
			projection: kind.projection,
			reservation: kind.reservation
		});
		case "delivery": return Object.freeze({
			kind: kind.kind,
			reservation: kind.reservation
		});
		case "invocation": return Object.freeze({
			kind: kind.kind,
			id: kind.id
		});
		case "attempt": return Object.freeze({
			kind: kind.kind,
			id: new EffectAttemptId(kind.id.value)
		});
		case "routeReserved": return Object.freeze({
			kind: kind.kind,
			id: kind.id
		});
		case "event": return Object.freeze({
			kind: kind.kind,
			id: kind.id
		});
		case "commit": return Object.freeze({
			kind: kind.kind,
			id: new RunCommitId(kind.id.value)
		});
	}
}
function encodeKind(kind) {
	switch (kind.kind) {
		case "approval": return {
			kind: kind.kind,
			id: kind.id.value,
			phase: kind.phase
		};
		case "receipt": return {
			kind: kind.kind,
			id: kind.id.value,
			outcome: kind.outcome
		};
		case "receiptSuperseded": return {
			kind: kind.kind,
			previous: kind.previous.value,
			next: kind.next.value
		};
		case "write": return {
			kind: kind.kind,
			id: kind.id.value,
			outcome: kind.outcome
		};
		case "routeProjected": return {
			kind: kind.kind,
			projection: kind.projection.value,
			reservation: kind.reservation.value
		};
		case "delivery": return {
			kind: kind.kind,
			reservation: kind.reservation.value
		};
		default: return {
			kind: kind.kind,
			id: kind.id.value
		};
	}
}
function decodeKind(value) {
	const object = requireObject(value, "Audit evidence");
	const kind = requireString(object, "kind");
	switch (kind) {
		case "invocation":
			requireEvidenceKeys(object, ["id", "kind"]);
			return {
				kind,
				id: new InvocationId(requireString(object, "id"))
			};
		case "approval":
			requireEvidenceKeys(object, [
				"id",
				"kind",
				"phase"
			]);
			return {
				kind,
				id: new ApprovalId(requireString(object, "id")),
				phase: requireApprovalPhase(object["phase"])
			};
		case "attempt":
			requireEvidenceKeys(object, ["id", "kind"]);
			return {
				kind,
				id: new EffectAttemptId(requireString(object, "id"))
			};
		case "routeReserved":
			requireEvidenceKeys(object, ["id", "kind"]);
			return {
				kind,
				id: new RouteReservationId(requireString(object, "id"))
			};
		case "receipt":
			requireEvidenceKeys(object, [
				"id",
				"kind",
				"outcome"
			]);
			return {
				kind,
				id: new ReceiptId(requireString(object, "id")),
				outcome: requireReceiptOutcome(object["outcome"])
			};
		case "receiptSuperseded":
			requireEvidenceKeys(object, [
				"kind",
				"next",
				"previous"
			]);
			return {
				kind,
				previous: new ReceiptId(requireString(object, "previous")),
				next: new ReceiptId(requireString(object, "next"))
			};
		case "write":
			requireEvidenceKeys(object, [
				"id",
				"kind",
				"outcome"
			]);
			return {
				kind,
				id: new WriteRecordId(requireString(object, "id")),
				outcome: requireWriteOutcome(object["outcome"])
			};
		case "event":
			requireEvidenceKeys(object, ["id", "kind"]);
			return {
				kind,
				id: new EventId(requireString(object, "id"))
			};
		case "routeProjected":
			requireEvidenceKeys(object, [
				"kind",
				"projection",
				"reservation"
			]);
			return {
				kind,
				projection: new RouteProjectionId(requireString(object, "projection")),
				reservation: new RouteReservationId(requireString(object, "reservation"))
			};
		case "delivery":
			requireEvidenceKeys(object, ["kind", "reservation"]);
			return {
				kind,
				reservation: new RouteReservationId(requireString(object, "reservation"))
			};
		case "commit":
			requireEvidenceKeys(object, ["id", "kind"]);
			return {
				kind,
				id: new RunCommitId(requireString(object, "id"))
			};
		default: throw new TypeError(`Unknown audit evidence kind ${kind}`);
	}
}
function requireEvidenceKeys(object, expected) {
	if (!hasExactJsonKeys(object, expected)) throw new TypeError("Audit evidence contains missing or unknown fields");
}
function requireActorKind$2(value) {
	if (value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate") return value;
	throw new TypeError("Audit actor kind is invalid");
}
function requireApprovalPhase(value) {
	if (value === "pending" || value === "approved" || value === "denied" || value === "expired" || value === "consumed") return value;
	throw new TypeError("Audit approval phase is invalid");
}
function requireReceiptOutcome(value) {
	if (value === "deniedPreEffect" || value === "cancelledPreEffect" || value === "succeeded" || value === "failed" || value === "indeterminate") return value;
	throw new TypeError("Audit receipt outcome is invalid");
}
function requireWriteOutcome(value) {
	if (isWriteAuditOutcome(value)) return value;
	throw new TypeError("Audit write outcome is invalid");
}
//#endregion
//#region src/invocations/claim.ts
var ItemClaim = class ItemClaim {
	id;
	invocation;
	itemIndex;
	attemptOrdinal;
	#expiresAt;
	owner;
	static encode(record, lease) {
		return new ItemClaimCodec(lease).encode(record);
	}
	static decode(bytes, lease) {
		return new ItemClaimCodec(lease).decode(bytes);
	}
	constructor(id, invocation, itemIndex, attemptOrdinal, owner, expiresAt) {
		this.id = id;
		this.invocation = invocation;
		this.itemIndex = itemIndex;
		this.attemptOrdinal = attemptOrdinal;
		if (id.constructor !== ItemClaimId || invocation.constructor !== InvocationId) throw new TypeError("ItemClaim identifiers must use exact context classes");
		requireIndex(itemIndex, "Claim item index");
		requireIndex(attemptOrdinal, "Claim attempt ordinal");
		this.#expiresAt = validDate(expiresAt, "Claim expiry");
		this.owner = copyOwner(owner);
		Object.freeze(this);
	}
	get expiresAt() {
		return new Date(this.#expiresAt);
	}
	requireFuture(now) {
		if (this.#expiresAt <= validDate(now, "Claim time")) throw new AgentCoreError("invocation.invalid", "Item claim must have a future expiry");
	}
	recover(id, owner, expiresAt, now) {
		const nowTime = validDate(now, "Claim recovery time");
		if (this.#expiresAt > nowTime) throw new AgentCoreError("invocation.invalid", "Only an expired claim may be recovered");
		const replacement = new ItemClaim(id, this.invocation, this.itemIndex, this.attemptOrdinal, owner, expiresAt);
		replacement.requireFuture(now);
		if (sameWorker(this.owner, replacement.owner)) throw new AgentCoreError("invocation.invalid", "Claim recovery requires a different worker");
		return replacement;
	}
};
var ItemClaimCodec = class extends RecordCodec {
	#lease;
	constructor(lease) {
		super([
			ItemClaim,
			ActorRef,
			TextId,
			InvocationId,
			ActorId,
			ItemClaimId,
			ClaimWorkerId
		], "invocation.item-claim", {
			major: 1,
			minor: 0
		});
		this.#lease = copyStructuralCodec(lease);
		Object.freeze(this);
	}
	encodePayload(record) {
		return {
			attemptOrdinal: record.attemptOrdinal,
			expiresAt: record.expiresAt.toISOString(),
			id: record.id.value,
			invocation: record.invocation.value,
			itemIndex: record.itemIndex,
			owner: encodeOwner(record.owner, this.#lease)
		};
	}
	decodePayload(payload, _version) {
		const object = requireExactObject(payload, [
			"attemptOrdinal",
			"expiresAt",
			"id",
			"invocation",
			"itemIndex",
			"owner"
		], "Item claim");
		return new ItemClaim(new ItemClaimId(requireString(object, "id")), new InvocationId(requireString(object, "invocation")), requireNonnegativeInteger(object, "itemIndex"), requireNonnegativeInteger(object, "attemptOrdinal"), decodeOwner(object["owner"], this.#lease), requireDate(object, "expiresAt"));
	}
};
function encodeOwner(owner, lease) {
	return owner.kind === "executor" ? {
		kind: owner.kind,
		token: lease.encode(owner.token),
		worker: owner.worker.value
	} : {
		actor: {
			id: owner.actor.id.value,
			kind: owner.actor.kind
		},
		kind: owner.kind,
		worker: owner.worker.value
	};
}
function decodeOwner(value, lease) {
	const kind = requireString(requireObject(value, "Claim owner"), "kind");
	if (kind === "executor") {
		const exact = requireExactObject(value, [
			"kind",
			"token",
			"worker"
		], "Executor claim owner");
		return Object.freeze({
			kind,
			token: lease.decode(exact["token"]),
			worker: new ClaimWorkerId(requireString(exact, "worker"))
		});
	}
	if (kind === "system") {
		const exact = requireExactObject(value, [
			"actor",
			"kind",
			"worker"
		], "System claim owner");
		const actor = requireExactObject(exact["actor"], ["id", "kind"], "Claim owner Actor");
		return Object.freeze({
			kind,
			actor: new ActorRef(requireActorKind$1(requireString(actor, "kind")), new ActorId(requireString(actor, "id"))),
			worker: new ClaimWorkerId(requireString(exact, "worker"))
		});
	}
	throw new TypeError("Claim owner kind is invalid");
}
function copyOwner(owner) {
	return owner.kind === "executor" ? Object.freeze({
		kind: owner.kind,
		token: immutableReference(owner.token),
		worker: owner.worker
	}) : Object.freeze({
		kind: owner.kind,
		actor: owner.actor,
		worker: owner.worker
	});
}
function sameWorker(left, right) {
	return left.worker.equals(right.worker);
}
function requireIndex(value, subject) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${subject} must be a non-negative safe integer`);
}
function requireActorKind$1(value) {
	if (value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate") return value;
	throw new TypeError("Claim owner Actor kind is invalid");
}
//#endregion
//#region src/invocations/publication.ts
var PUBLICATION_ID_DOMAIN = "agent-core.invocation-publication.v1";
var InvocationPublicationOutbox = class InvocationPublicationOutbox {
	observation;
	revision;
	id;
	#state;
	constructor(observation, state, revision) {
		this.observation = observation;
		this.revision = revision;
		this.id = Digest.sha256(encodeCanonicalJson({
			domain: PUBLICATION_ID_DOMAIN,
			audit: observation.audit.value,
			invocation: observation.invocation.value,
			receipt: observation.receipt.value
		}));
		this.#state = copyState(state);
		const acknowledgements = Number(state.eventPublishedAt !== void 0) + Number(state.commitAppendedAt !== void 0);
		if (revision.value !== acknowledgements || state.kind === "published" !== (acknowledgements === 2)) throw new TypeError("Invocation publication revision does not match its state");
		Object.freeze(this.id);
		Object.freeze(this);
	}
	static pending(observation) {
		return new InvocationPublicationOutbox(observation, { kind: "pending" }, Revision.initial());
	}
	static encode(record) {
		return InvocationPublicationOutboxCodec.encode(record);
	}
	static decode(bytes) {
		return InvocationPublicationOutboxCodec.decode(bytes);
	}
	get state() {
		return copyState(this.#state);
	}
	eventPublished(at) {
		return this.acknowledge("event", at);
	}
	commitAppended(at) {
		return this.acknowledge("commit", at);
	}
	follows(current) {
		const previous = current.state;
		const next = this.#state;
		const addedEvent = previous.eventPublishedAt === void 0 && next.eventPublishedAt !== void 0;
		const addedCommit = previous.commitAppendedAt === void 0 && next.commitAppendedAt !== void 0;
		return this.id.equals(current.id) && this.revision.value === current.revision.value + 1 && addedEvent !== addedCommit && sameTime(previous.eventPublishedAt, next.eventPublishedAt, addedEvent) && sameTime(previous.commitAppendedAt, next.commitAppendedAt, addedCommit);
	}
	acknowledge(sink, at) {
		const state = this.#state;
		if (state.kind === "published" || (sink === "event" ? state.eventPublishedAt : state.commitAppendedAt) !== void 0) throw invocationError("state.invalid-transition", `Invocation ${sink} publication acknowledgement is immutable`);
		const eventPublishedAt = sink === "event" ? at : state.eventPublishedAt;
		const commitAppendedAt = sink === "commit" ? at : state.commitAppendedAt;
		return new InvocationPublicationOutbox(this.observation, eventPublishedAt !== void 0 && commitAppendedAt !== void 0 ? {
			kind: "published",
			eventPublishedAt,
			commitAppendedAt
		} : pendingState(eventPublishedAt, commitAppendedAt), this.revision.next());
	}
};
var InvocationPublicationOutboxCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			InvocationPublicationOutbox,
			Revision,
			TextId,
			Digest,
			InvocationId,
			ReceiptId,
			AuditRecordId
		], "invocation.publication-outbox", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(record) {
		const state = record.state;
		return {
			audit: record.observation.audit.value,
			id: record.id.value,
			invocation: record.observation.invocation.value,
			receipt: record.observation.receipt.value,
			revision: record.revision.value,
			state: {
				commitAppendedAt: state.commitAppendedAt?.toISOString() ?? null,
				eventPublishedAt: state.eventPublishedAt?.toISOString() ?? null,
				kind: state.kind
			}
		};
	}
	decodePayload(payload, _version) {
		const object = requireExactObject(payload, [
			"audit",
			"id",
			"invocation",
			"receipt",
			"revision",
			"state"
		], "Invocation publication outbox");
		const stateValue = object["state"];
		const state = requireExactObject(stateValue, [
			"commitAppendedAt",
			"eventPublishedAt",
			"kind"
		], "Invocation publication state");
		const kind = requireString(state, "kind");
		const eventPublishedAt = requireNullableDate(state, "eventPublishedAt");
		const commitAppendedAt = requireNullableDate(state, "commitAppendedAt");
		const record = new InvocationPublicationOutbox(Object.freeze({
			invocation: new InvocationId(requireString(object, "invocation")),
			receipt: new ReceiptId(requireString(object, "receipt")),
			audit: new AuditRecordId(requireString(object, "audit"))
		}), kind === "pending" ? pendingState(eventPublishedAt, commitAppendedAt) : kind === "published" && eventPublishedAt !== void 0 && commitAppendedAt !== void 0 ? {
			kind,
			eventPublishedAt,
			commitAppendedAt
		} : invalidState(), new Revision(requireNonnegativeInteger(object, "revision")));
		if (record.id.value !== requireString(object, "id")) throw new TypeError("Invocation publication ID does not match its observation");
		return record;
	}
};
/**
* A pending publication omits the sink it has not acknowledged yet, so the two
* fields must stay absent rather than present-and-undefined: the state is public
* and callers distinguish the two.
*/
function pendingState(eventPublishedAt, commitAppendedAt) {
	const state = { kind: "pending" };
	if (eventPublishedAt !== void 0) state.eventPublishedAt = eventPublishedAt;
	if (commitAppendedAt !== void 0) state.commitAppendedAt = commitAppendedAt;
	return Object.freeze(state);
}
function copyState(state) {
	const eventPublishedAt = copyDate(state.eventPublishedAt, "Event publication time");
	const commitAppendedAt = copyDate(state.commitAppendedAt, "Commit append time");
	return state.kind === "pending" ? pendingState(eventPublishedAt, commitAppendedAt) : Object.freeze({
		kind: state.kind,
		eventPublishedAt,
		commitAppendedAt
	});
}
function copyDate(value, subject) {
	return value === void 0 ? void 0 : new Date(validDate(value, subject));
}
function sameTime(previous, next, added) {
	return added ? previous === void 0 && next !== void 0 : previous?.getTime() === next?.getTime();
}
function invalidState() {
	throw invocationError("state.invalid-transition", "Invocation publication state is invalid");
}
var InvocationPublicationOutboxCodec = new InvocationPublicationOutboxCodecV1();
//#endregion
//#region src/invocations/detached-delivery.ts
/**
* What one Run admission message left behind.
*
* Every case means the message is discharged and may be acknowledged; a message that does not
* name this host's exact state is refused by throwing instead, because acknowledging it would
* discard the Run's only copy of a command nobody executed. `executable` is the one bit a
* caller acts on: it says a driver now has work that did not exist before.
*/
var DetachedEffectAdmissionOutcome = class {
	/** This message released the item; a driver must be armed. */
	static get released() {
		return releasedOutcome;
	}
	/** A duplicate of a message already applied; nothing changed. */
	static get alreadyReleased() {
		return alreadyReleasedOutcome;
	}
	/** The Run's cancellation reached this item first, so nothing releases it. */
	static get cancellationRequested() {
		return cancellationRequestedOutcome;
	}
	/** The item already has a current Receipt; there is nothing left to release. */
	static settled(receipt) {
		return new SettledAdmission(receipt);
	}
};
var ReleasedAdmission = class extends DetachedEffectAdmissionOutcome {
	kind = "released";
	executable = true;
	receipt = void 0;
};
var AlreadyReleasedAdmission = class extends DetachedEffectAdmissionOutcome {
	kind = "alreadyReleased";
	executable = false;
	receipt = void 0;
};
var CancellationRequestedAdmission = class extends DetachedEffectAdmissionOutcome {
	kind = "cancellationRequested";
	executable = false;
	receipt = void 0;
};
var SettledAdmission = class extends DetachedEffectAdmissionOutcome {
	receipt;
	kind = "settled";
	executable = false;
	constructor(receipt) {
		super();
		this.receipt = receipt;
		Object.freeze(this);
	}
};
var releasedOutcome = Object.freeze(new ReleasedAdmission());
var alreadyReleasedOutcome = Object.freeze(new AlreadyReleasedAdmission());
var cancellationRequestedOutcome = Object.freeze(new CancellationRequestedAdmission());
/**
* What one Run cancellation message reached.
*
* `reached` records nothing: the live effect ends through the ordinary path and its own
* classification names §7.4's `aborted`. `recorded` carries the `indeterminate` Receipt this
* host wrote because no live effect remained to abort, which is the honest outcome for an
* admitted attempt nobody observed and the one reconciliation resolves. `settled` is a
* redelivery for an item that already finished.
*/
var DetachedEffectCancellationOutcome = class {
	static get reached() {
		return reachedCancellation;
	}
	static recorded(receipt) {
		return new RecordedCancellation(receipt);
	}
	static settled(receipt) {
		return new SettledCancellation(receipt);
	}
};
var ReachedCancellation$1 = class extends DetachedEffectCancellationOutcome {
	kind = "reached";
	receipt = void 0;
};
var RecordedCancellation = class extends DetachedEffectCancellationOutcome {
	receipt;
	kind = "recorded";
	constructor(receipt) {
		super();
		this.receipt = receipt;
		Object.freeze(this);
	}
};
var SettledCancellation = class extends DetachedEffectCancellationOutcome {
	receipt;
	kind = "settled";
	constructor(receipt) {
		super();
		this.receipt = receipt;
		Object.freeze(this);
	}
};
var reachedCancellation = Object.freeze(new ReachedCancellation$1());
/**
* The Invocation owner's inbound seam for the Run's messages about one detached item
* (SPEC §5.6, §6.1), and the execution step a driver drives.
*
* It takes scalar facts rather than the Run's record: delivery is at-least-once across an
* Actor boundary with no shared transaction, so the Invocation owner accepts nothing on the
* sender's word. Every entry point re-reads its own state — the PreparedInvocation, that
* item's key, the latest EffectAttempt, and the current Receipt — and a message that does not
* name exactly that state is refused with a typed error rather than acknowledged.
*
* A cancellation is a request, never a verdict. This port asks the target to abort the exact
* attempt and records only what the target observed, so §7.4's `aborted` still comes from the
* cancellation that reached the effect and never from the fact that a Run asked.
*/
var DetachedEffectDeliveryPort = class {
	transactions;
	persistence;
	detachedExecutions;
	ledger;
	records;
	evidence;
	target;
	executor;
	now;
	constructor(transactions, persistence, detachedExecutions, ledger, records, evidence, target, executor, now) {
		this.transactions = transactions;
		this.persistence = persistence;
		this.detachedExecutions = detachedExecutions;
		this.ledger = ledger;
		this.records = records;
		this.evidence = evidence;
		this.target = target;
		this.executor = executor;
		this.now = now;
	}
	/**
	* Accepts the Run's admission message: the Run took the published item into its own
	* obligation, so the item may run. Releasing is idempotent, and a duplicate changes nothing
	* rather than starting a second effect.
	*/
	release(invocation, itemIndex, itemKey, attempt) {
		return this.transactions.transact((transaction) => {
			const state = this.state(transaction, invocation, itemIndex, itemKey, attempt);
			if (state.receipt !== void 0) return DetachedEffectAdmissionOutcome.settled(state.receipt);
			const next = state.detachment.state.release();
			if (next.equals(state.detachment.state)) return next.executable ? DetachedEffectAdmissionOutcome.alreadyReleased : DetachedEffectAdmissionOutcome.cancellationRequested;
			this.detachedExecutions.appendDetachedExecution(transaction, state.detachment.released());
			return DetachedEffectAdmissionOutcome.released;
		});
	}
	/**
	* Accepts the Run's cancellation message: the Run ended while this item was still owed, so
	* the target is asked to stop the exact attempt.
	*
	* The durable request is recorded first and the target is asked after that transaction
	* commits. There is no cross-Actor transaction to join, and a request that survives only in
	* memory would be lost by exactly the restart that also loses the live effect.
	*/
	async cancel(invocation, itemIndex, itemKey, attempt) {
		const requested = this.transactions.transact((transaction) => {
			const state = this.state(transaction, invocation, itemIndex, itemKey, attempt);
			if (state.receipt !== void 0) return state.receipt;
			if (!state.detachment.state.requestCancellation().equals(state.detachment.state)) this.detachedExecutions.appendDetachedExecution(transaction, state.detachment.cancellationRequested());
		});
		if (requested !== void 0) return DetachedEffectCancellationOutcome.settled(requested);
		const observation = await this.target.cancel(attempt);
		return this.record(invocation, itemIndex, itemKey, attempt, observation);
	}
	/**
	* Runs one released item. The target rebuilds the live request from durable records, so the
	* same call serves the host that admitted the item and a host that restarted since.
	*/
	async execute(item) {
		if (!(item instanceof AdmittedInvocationItem)) throw invalid$6("Detached execution requires its admitted item");
		const execution = await this.target.execution(item);
		return this.executor.executeAdmittedItem(item, execution);
	}
	/**
	* Writes down what the target observed, once its answer is in hand. An `absent` observation
	* carries `indeterminate` and nothing else can be honestly recorded: no live effect was
	* reached, so no cancellation reached the attempt, and §7.4 leaves the outcome unknown for
	* reconciliation to resolve.
	*/
	record(invocation, itemIndex, itemKey, attempt, observation) {
		const completion = observation.completion;
		if (completion === void 0) return DetachedEffectCancellationOutcome.reached;
		return this.transactions.transact((transaction) => {
			const state = this.state(transaction, invocation, itemIndex, itemKey, attempt);
			if (state.receipt !== void 0) return DetachedEffectCancellationOutcome.settled(state.receipt);
			const receipt = this.receipt(transaction, state, completion);
			return DetachedEffectCancellationOutcome.recorded(receipt);
		});
	}
	receipt(transaction, state, completion) {
		const receipt = this.records.attemptReceipt(state.attempt, completion, this.now(), void 0);
		const attemptAudit = this.records.attemptAudit(state.prepared, state.attempt);
		const audit = this.records.receiptAudit(state.prepared, attemptAudit, receipt);
		this.ledger.recordAttemptReceiptWithAudit(transaction, receipt, attemptAudit, audit, InvocationPublicationOutbox.pending(Object.freeze({
			invocation: state.item.invocation,
			receipt: receipt.id,
			audit: audit.id
		})), this.evidence);
		return receipt;
	}
	/**
	* The exact-state read every message is judged against. It refuses rather than reporting,
	* because each condition it checks means the message names work this host does not have:
	* an Invocation it never prepared, an item whose key does not match, an attempt that is not
	* the item's latest, or an item that was never detached in the first place.
	*/
	state(transaction, invocation, itemIndex, itemKey, attempt) {
		const prepared = this.persistence.prepared(transaction, invocation);
		if (prepared === void 0) throw invalid$6("Detached effect delivery names no PreparedInvocation");
		const latest = this.persistence.attemptsForItem(transaction, invocation, itemIndex).at(-1);
		if (latest === void 0 || !latest.id.equals(attempt)) throw invalid$6("Detached effect delivery does not name the item's latest EffectAttempt");
		const item = AdmittedInvocationItem.derive(prepared, latest);
		if (!item.names(invocation, itemIndex, itemKey, attempt)) throw invalid$6("Detached effect delivery does not name the exact admitted item");
		const detachment = this.detachedExecutions.detachedExecution(transaction, attempt);
		if (detachment === void 0 || !detachment.invocation.equals(invocation) || detachment.itemIndex !== itemIndex) throw invalid$6("Detached effect delivery names an item this host did not detach");
		const receipt = this.ledger.currentReceipt(transaction, invocation, itemIndex);
		const receipted = this.persistence.receiptsForAttempt(transaction, attempt).length !== 0;
		if (receipt === void 0 && receipted) throw invalid$6("Detached item has a Receipt its item does not carry");
		return {
			prepared,
			attempt: latest,
			item,
			detachment,
			receipt
		};
	}
};
function invalid$6(message) {
	return new AgentCoreError("invocation.invalid", message);
}
//#endregion
//#region src/invocations/detached-driver.ts
/**
* The named driver for detached execution: it owns the durable schedule that runs released
* items whose Turn has ended (§5.6).
*
* Everything it needs comes from durable records. A sweep re-queries the released items,
* executes each through a target that rebuilds its own live request, and re-arms while any
* remain — so a host that restarts mid-flight resumes by calling `repair` and never by holding
* a closure from the Turn that admitted the work. Direct calls to the execution step never
* establish scheduling; only `arm` and `sweep` touch the schedule.
*
* It shares `ReconciliationSchedulePort` with the reconciliation driver because a durable
* schedule is one substrate contract, not two. Each driver arms its own schedule instance; two
* drivers sharing one would settle each other's work.
*/
var AlarmDetachedEffectDriver = class {
	executions;
	items;
	schedule;
	intervalMs;
	now;
	batchLimit;
	constructor(executions, items, schedule, intervalMs, now, batchLimit = 32) {
		this.executions = executions;
		this.items = items;
		this.schedule = schedule;
		this.intervalMs = intervalMs;
		this.now = now;
		this.batchLimit = batchLimit;
		if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new AgentCoreError("protocol.invalid-state", "Detached effect driver interval must be a positive safe integer");
		if (!Number.isSafeInteger(batchLimit) || batchLimit <= 0) throw new AgentCoreError("protocol.invalid-state", "Detached effect driver batch limit must be a positive safe integer");
	}
	/** Arm the durable schedule if it is not already armed. Idempotent. */
	arm() {
		const existing = this.schedule.scheduled();
		if (existing !== void 0) return existing;
		const at = new Date(this.now().getTime() + this.intervalMs);
		this.schedule.schedule(at);
		return at;
	}
	/**
	* Reconstruct the schedule from durable detachment state. A release whose sweep was lost to
	* eviction, or a host that restarted between admission and execution, leaves released items
	* with no Receipt; call this during startup so the driver resumes without waiting for a new
	* delivery to arm it.
	*/
	repair() {
		if (this.items.released(1).length === 0) return void 0;
		return this.arm();
	}
	/**
	* One driver firing: re-query released items, execute each, and leave the schedule armed
	* exactly when released work remains.
	*
	* The schedule is settled after the work, never before: clearing first would strand every
	* outstanding item if the firing is evicted or throws.
	*/
	async sweep() {
		const queried = this.items.released(this.batchLimit);
		let executed = 0;
		try {
			for (const item of queried) {
				await this.executions.execute(item);
				executed += 1;
			}
		} finally {
			this.settleSchedule();
		}
		return Object.freeze({
			queried: queried.length,
			executed,
			remaining: this.items.released(1).length > 0
		});
	}
	settleSchedule() {
		if (this.items.released(1).length > 0) {
			this.schedule.schedule(new Date(this.now().getTime() + this.intervalMs));
			return;
		}
		this.schedule.clear();
	}
};
//#endregion
//#region src/invocations/detached-execution.ts
var DETACHED_EXECUTION_DOMAIN = "agent-core.invocation-detached-execution.v1";
Object.freeze([
	"awaitingPublication",
	"released",
	"cancellationRequested"
]);
/**
* Where one detached item's execution stands: waiting for the Run to publish its admission
* identity, released to run, or asked to stop (§5.6).
*
* Each case is a class carrying its own transitions, so a caller asks the state what happens
* next instead of reading a label and deciding. Delivery from the Run is at-least-once and
* unordered (§6.1), which is why every transition is idempotent and why a release after a
* cancellation request stays cancelled: the Run has already ended, and the admission message
* it wrote earlier says nothing that revives it. A transition that returns the same state is
* how a duplicate becomes a no-op rather than a second effect.
*
* There is no terminal case. §7.4 answers "did this item finish" from its current Receipt,
* and a second durable place to ask would be a state this record could hold while the Receipt
* disagreed (§8.4).
*/
var DetachedEffectExecutionState = class DetachedEffectExecutionState {
	/** The item is admitted; the Run has not yet taken it into its own obligation. */
	static get awaitingPublication() {
		return awaitingPublicationState;
	}
	/** The Run's admission message arrived; a driver may execute the item. */
	static get released() {
		return releasedState;
	}
	/** The Run asked for the item to stop; nothing releases it again. */
	static get cancellationRequested() {
		return cancellationRequestedState;
	}
	equals(other) {
		return other instanceof DetachedEffectExecutionState && other.kind === this.kind;
	}
};
/**
* The only door from a stored label back to a state. It is module-private and next to the
* codec because a decoder restores a transition its writer already made; nothing else may
* name a state it did not reach through the transitions above.
*/
function requireStateOfKind(kind) {
	const state = statesByKind[kind];
	if (state === void 0) throw new TypeError("Detached effect execution state kind is invalid");
	return state;
}
/** Proves the caller holds the admitted item this record is built over. */
function requireAdmittedItem(item) {
	if (!(item instanceof AdmittedInvocationItem)) throw new TypeError("Detached effect execution requires its admitted item");
	return item;
}
var AwaitingPublicationState = class extends DetachedEffectExecutionState {
	kind = "awaitingPublication";
	executable = false;
	release() {
		return releasedState;
	}
	requestCancellation() {
		return cancellationRequestedState;
	}
};
var ReleasedState = class extends DetachedEffectExecutionState {
	kind = "released";
	executable = true;
	release() {
		return releasedState;
	}
	requestCancellation() {
		return cancellationRequestedState;
	}
};
var CancellationRequestedState = class extends DetachedEffectExecutionState {
	kind = "cancellationRequested";
	executable = false;
	release() {
		return cancellationRequestedState;
	}
	requestCancellation() {
		return cancellationRequestedState;
	}
};
var awaitingPublicationState = Object.freeze(new AwaitingPublicationState());
var releasedState = Object.freeze(new ReleasedState());
var cancellationRequestedState = Object.freeze(new CancellationRequestedState());
var statesByKind = Object.freeze({
	awaitingPublication: awaitingPublicationState,
	released: releasedState,
	cancellationRequested: cancellationRequestedState
});
/**
* The Invocation owner's durable record that one admitted item's execution left the Turn that
* issued it (§5.6, C13-TURN-HANDLE-DETACHMENT).
*
* It exists because admission and execution are now separate: the EffectAttempt is durable
* before the target runs, and nothing else on disk would say that the item is waiting for the
* Run rather than running under a Turn. A per-Turn closure cannot carry that fact — the Turn
* ends, the host restarts, and the closure is gone — so the fact is a record and the driver
* rebuilds its work from it.
*
* It names the item and nothing more. The item key lives on the PreparedInvocation and the
* ordinal on the EffectAttempt, so this record keeps neither: §8.4 forbids the second copy,
* and every acceptance re-reads those owners anyway to decide whether a message is exact.
*/
var DetachedEffectExecution = class DetachedEffectExecution {
	static get codec() {
		return DetachedEffectExecutionCodec;
	}
	id;
	invocation;
	itemIndex;
	attempt;
	state;
	revision;
	/** The first state of a freshly admitted detached item. */
	static awaiting(candidate) {
		const item = requireAdmittedItem(candidate);
		return new DetachedEffectExecution({
			invocation: item.invocation,
			itemIndex: item.itemIndex,
			attempt: item.attempt,
			state: DetachedEffectExecutionState.awaitingPublication,
			revision: Revision.initial()
		});
	}
	static encode(record) {
		return DetachedEffectExecutionCodec.encode(record);
	}
	static decode(bytes) {
		return DetachedEffectExecutionCodec.decode(bytes);
	}
	constructor(init) {
		if (init.invocation.constructor !== InvocationId || init.attempt.constructor !== EffectAttemptId) throw new TypeError("Detached effect execution uses exact context identifiers");
		if (!Number.isSafeInteger(init.itemIndex) || init.itemIndex < 0) throw new TypeError("Detached effect execution item index is invalid");
		if (!(init.state instanceof DetachedEffectExecutionState)) throw new TypeError("Detached effect execution requires one closed state");
		if (init.revision.constructor !== Revision) throw new TypeError("Detached effect execution requires its exact revision");
		this.invocation = init.invocation;
		this.itemIndex = init.itemIndex;
		this.attempt = init.attempt;
		this.state = init.state;
		this.revision = init.revision;
		this.id = Digest.sha256(encodeCanonicalJson({
			attempt: this.attempt.value,
			domain: DETACHED_EXECUTION_DOMAIN,
			invocation: this.invocation.value,
			itemIndex: this.itemIndex
		}));
		Object.freeze(this.id);
		Object.freeze(this);
	}
	released() {
		return this.transition(this.state.release());
	}
	cancellationRequested() {
		return this.transition(this.state.requestCancellation());
	}
	/** True when `this` is exactly the next stored revision after `current`. */
	follows(current) {
		return this.id.equals(current.id) && this.revision.value === current.revision.value + 1 && !this.state.equals(current.state);
	}
	transition(state) {
		if (state.equals(this.state)) return this;
		return new DetachedEffectExecution({
			invocation: this.invocation,
			itemIndex: this.itemIndex,
			attempt: this.attempt,
			state,
			revision: this.revision.next()
		});
	}
};
var DetachedEffectExecutionCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			DetachedEffectExecution,
			DetachedEffectExecutionState,
			AwaitingPublicationState,
			ReleasedState,
			CancellationRequestedState,
			Digest,
			Revision,
			TextId,
			InvocationId,
			EffectAttemptId
		], "invocation.detached-effect-execution", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(record) {
		return {
			attempt: record.attempt.value,
			id: record.id.value,
			invocation: record.invocation.value,
			itemIndex: record.itemIndex,
			revision: record.revision.value,
			state: record.state.kind
		};
	}
	decodePayload(payload, _version) {
		const object = requireExactObject(payload, [
			"attempt",
			"id",
			"invocation",
			"itemIndex",
			"revision",
			"state"
		], "Detached effect execution");
		const record = new DetachedEffectExecution({
			invocation: new InvocationId(requireString(object, "invocation")),
			itemIndex: requireNonnegativeInteger(object, "itemIndex"),
			attempt: new EffectAttemptId(requireString(object, "attempt")),
			state: requireStateOfKind(requireString(object, "state")),
			revision: new Revision(requireNonnegativeInteger(object, "revision"))
		});
		if (record.id.value !== requireString(object, "id")) throw new TypeError("Detached effect execution ID does not match its own item");
		return record;
	}
};
var DetachedEffectExecutionCodec = new DetachedEffectExecutionCodecV1();
//#endregion
//#region src/invocations/detached-memory.ts
function createDetachedEffectExecutionMemoryState() {
	return { detachedExecutions: /* @__PURE__ */ new Map() };
}
function cloneDetachedEffectExecutionMemoryState(state) {
	return { detachedExecutions: new Map([...state.detachedExecutions].map(([key, bytes]) => [key, bytes.slice()])) };
}
/**
* The in-memory reference store for detached execution records (§8.4's memory implementation
* of one substrate seam). Records are held as codec bytes, so a suite that clones the state
* gets the same snapshot-and-restart behavior a substrate gives and cannot share a live object
* across the boundary.
*/
var MemoryDetachedEffectExecutionPersistence = class {
	detachedExecution(transaction, attempt) {
		const bytes = transaction.detachedExecutions.get(attempt.value);
		if (bytes === void 0) return void 0;
		const record = DetachedEffectExecution.decode(bytes.slice());
		if (!record.attempt.equals(attempt)) throw new AgentCoreError("codec.invalid", "Detached execution index does not match codec bytes");
		return record;
	}
	releasedDetachedExecutions(transaction, limit) {
		if (!Number.isSafeInteger(limit) || limit <= 0) throw new AgentCoreError("invocation.invalid", "Released detached execution query requires a positive limit");
		return Object.freeze([...transaction.detachedExecutions.values()].map((bytes) => DetachedEffectExecution.decode(bytes.slice())).filter((record) => record.state.executable).sort((left, right) => compareCanonicalText(left.attempt.value, right.attempt.value)).slice(0, limit));
	}
	appendDetachedExecution(transaction, record) {
		const current = this.detachedExecution(transaction, record.attempt);
		if (current === void 0 && record.revision.value !== 0 || current !== void 0 && !record.follows(current)) throw new AgentCoreError("invocation.invalid", "Detached execution revision is not the next transition");
		transaction.detachedExecutions.set(record.attempt.value, DetachedEffectExecution.encode(record));
	}
};
//#endregion
//#region src/invocations/receipt.ts
var ATTEMPT_RECEIPT_OUTCOMES = Object.freeze([
	"succeeded",
	"failed",
	"indeterminate"
]);
var ATTEMPT_FAILURE_KINDS = Object.freeze([
	"raised",
	"deadline",
	"aborted",
	"domainLost",
	"outputInvalid"
]);
/**
* §7.4's closed failure taxonomy for an attempted `failed` Receipt.
*
* Each case is reachable only through the fact that distinguishes it, so a host cannot
* record a kind it has not observed, and no call accepts two facts. `raised` is the one kind
* the invoked handler may author and it must present the handler's own confirmation; the
* host derives `deadline` from the bound it set, `aborted` from the cancellation it owns,
* `domainLost` from the domain hosting the target, and `outputInvalid` from the output shape
* the Operation declared — never from anything the target reports about itself, for the
* reason §7.1 gives.
*
* Only construction is guarded. `kind` is the wire label, but reading one proves nothing the
* caller did not already establish to obtain the value.
*
* A guard that refuses is answering "the fact you name is not established by what you
* presented", which is a determination about this attempt rather than a malformed argument,
* so it carries `invocation.invalid` like every other unsubstantiated Receipt claim. The
* exact-class checks belong to the same answer: evidence that is not the declared output
* shape, or not the cancellation the host owns, establishes nothing either.
*/
var AttemptFailureKind = class AttemptFailureKind {
	/** §7.4: the sole kind the invoked code is permitted to originate. */
	get authoredByHandler() {
		return this.kind === "raised";
	}
	/**
	* The invoked handler signalled failure itself.
	*
	* This is the one case with no host-side precondition to check, and the asymmetry is
	* §7.4's own: the other four are facts about boundaries the host owns and can therefore
	* be interrogated, while this one is the callee's answer and the host either holds it or
	* does not. Requiring evidence content here would be a witness for the adjacent question
	* — whether the handler produced content, not whether it signalled failure — and the two
	* come apart, since a reconciled external verdict is the callee's own report and carries
	* no §4.1 rejection. Naming this kind is therefore the seam's obligation: a caller must
	* have narrowed to a confirmed callee verdict, never to an unrecognized rejection.
	*/
	static get raised() {
		return raisedFailure;
	}
	/** A host-set bound on this attempt elapsed. */
	static deadline(bound, observedAt) {
		const elapsed = validDate(bound, "Attempt bound");
		if (validDate(observedAt, "Attempt bound observation") < elapsed) throw invalid$5("A deadline failure requires a bound that has elapsed");
		return deadlineFailure;
	}
	/** Cancellation of the Turn or Run that owns the item reached the attempt. */
	static aborted(cancellation) {
		if (!(cancellation instanceof AbortSignal) || !cancellation.aborted) throw invalid$5("An aborted failure requires cancellation that reached the attempt");
		return abortedFailure;
	}
	/** The protection domain hosting the target stopped answering. */
	static domainLost(target) {
		if (target.answering()) throw invalid$5("A domainLost failure requires a domain that stopped answering");
		return domainLostFailure;
	}
	/** The handler resolved with a value the Operation's declared output shape rejects. */
	static outputInvalid(output, value) {
		if (output.constructor !== JsonSchema) throw invalid$5("An outputInvalid failure requires the declared output shape");
		if (output.accepts(value)) throw invalid$5("An outputInvalid failure requires a rejected resolved value");
		return outputInvalidFailure;
	}
	/**
	* §7.4's derivation, or `undefined` when the host holds no determination and the outcome
	* is therefore `indeterminate`.
	*
	* The order is causal, not arbitrary. A confirmed verdict is the handler's own answer, so
	* the host is not guessing and asks nothing further. Otherwise a lost domain explains any
	* boundary of the host's that also closed; a cancelled Turn or Run explains an elapsed
	* bound but not a lost domain; and the host's own bound is named only when nothing else
	* accounts for the end of the wait. Falling through to `undefined` is the point rather
	* than a gap: an unexplained end is not a kind, because naming one would convert "I
	* cannot tell" into "I know why".
	*/
	static classify(observation) {
		if (observation.confirmed) return AttemptFailureKind.raised;
		if (!observation.target.answering()) return AttemptFailureKind.domainLost(observation.target);
		if (observation.cancellation.aborted) return AttemptFailureKind.aborted(observation.cancellation);
		if (observation.elapsedBound !== void 0) return AttemptFailureKind.deadline(observation.elapsedBound, observation.observedAt);
	}
	equals(other) {
		return other instanceof AttemptFailureKind && other.kind === this.kind;
	}
};
var RaisedFailure = class extends AttemptFailureKind {
	kind = "raised";
};
var DeadlineFailure = class extends AttemptFailureKind {
	kind = "deadline";
};
var AbortedFailure = class extends AttemptFailureKind {
	kind = "aborted";
};
var DomainLostFailure = class extends AttemptFailureKind {
	kind = "domainLost";
};
var OutputInvalidFailure = class extends AttemptFailureKind {
	kind = "outputInvalid";
};
var raisedFailure = Object.freeze(new RaisedFailure());
var deadlineFailure = Object.freeze(new DeadlineFailure());
var abortedFailure = Object.freeze(new AbortedFailure());
var domainLostFailure = Object.freeze(new DomainLostFailure());
var outputInvalidFailure = Object.freeze(new OutputInvalidFailure());
/**
* An attempted outcome carrying its failure kind inseparably.
*
* §7.4 requires a kind on exactly the `failed` outcome, so `succeeded` and `indeterminate`
* are values that accept no argument and `failed` is the only call that accepts one. A kind
* on a non-failed outcome, a `failed` outcome without one, and two kinds on one outcome are
* therefore not calls that exist rather than calls that are rejected. `indeterminate` in
* particular cannot carry one: naming a kind is a determination, and a host that has one has
* stopped not knowing.
*/
var AttemptCompletion = class {
	static get succeeded() {
		return succeededCompletion;
	}
	static get indeterminate() {
		return indeterminateCompletion;
	}
	static failed(failure) {
		if (!(failure instanceof AttemptFailureKind)) throw invalid$5("A failed attempt outcome requires one closed §7.4 failure kind");
		return new FailedCompletion(failure);
	}
};
var SucceededCompletion = class extends AttemptCompletion {
	outcome = "succeeded";
	failure = void 0;
};
var IndeterminateCompletion = class extends AttemptCompletion {
	outcome = "indeterminate";
	failure = void 0;
};
var FailedCompletion = class extends AttemptCompletion {
	failure;
	outcome = "failed";
	constructor(failure) {
		super();
		this.failure = failure;
		Object.freeze(this);
	}
};
var succeededCompletion = Object.freeze(new SucceededCompletion());
var indeterminateCompletion = Object.freeze(new IndeterminateCompletion());
var Receipt = class {
	#recordedAt;
	constructor(recordedAt, properties) {
		this.#recordedAt = validDate(recordedAt, "Receipt time");
		Object.assign(this, properties);
		Object.freeze(this);
	}
	static encode(record) {
		return ReceiptCodec.encode(record);
	}
	static decode(bytes) {
		return ReceiptCodec.decode(bytes);
	}
	get recordedAt() {
		return new Date(this.#recordedAt);
	}
};
var PreEffectReceipt = class extends Receipt {
	constructor(id, invocation, itemIndex, outcome, recordedAt, reason) {
		super(recordedAt, requirePreEffectReceipt(id, invocation, itemIndex, outcome, reason));
	}
};
var AttemptReceipt = class extends Receipt {
	constructor(id, attempt, completion, previous, recordedAt, result) {
		super(recordedAt, requireAttemptReceipt(id, attempt, completion, previous, result));
	}
};
/**
* The ContentRef an audited Receipt holds (§8.4). A Receipt is append-only, so its writer
* owes retention on write and never a release: the result bytes an attempt produced stay
* reachable for as long as the Receipt naming them does. A pre-effect Receipt records a
* refusal and names no content, and an indeterminate attempt is refused a result at
* construction, so both project nothing rather than an absent field.
*/
function receiptContentRetention(receipt) {
	return contentRetentionFields([["result", receipt instanceof AttemptReceipt ? receipt.result : void 0]]);
}
function requirePreEffectReceipt(id, invocation, itemIndex, outcome, reason) {
	if (id.constructor !== ReceiptId || invocation.constructor !== InvocationId) throw new TypeError("Pre-effect Receipt identifiers must use exact context classes");
	if (!Number.isSafeInteger(itemIndex) || itemIndex < 0) throw new TypeError("Receipt item index must be a non-negative safe integer");
	if (outcome !== "deniedPreEffect" && outcome !== "cancelledPreEffect") throw new TypeError("Pre-effect Receipt outcome is invalid");
	if (reason.trim().length === 0) throw new TypeError("Pre-effect Receipt reason is required");
	return {
		variant: "preEffect",
		id,
		invocation,
		itemIndex,
		outcome,
		reason
	};
}
function requireAttemptReceipt(id, attempt, completion, previous, result) {
	if (id.constructor !== ReceiptId || attempt.constructor !== EffectAttemptId || previous !== void 0 && previous.constructor !== ReceiptId) throw new TypeError("Attempt Receipt identifiers must use exact context classes");
	if (!(completion instanceof AttemptCompletion)) throw new TypeError("Attempt Receipt outcome is invalid");
	const { failure, outcome } = completion;
	requireAttemptOutcome(outcome);
	if (failure !== void 0 && !(failure instanceof AttemptFailureKind)) throw new TypeError("Attempt Receipt failure kind is invalid");
	if (failure === void 0 === (outcome === "failed")) throw new TypeError("An attempt failure kind is recorded on exactly a failed outcome");
	if (outcome === "indeterminate" && result !== void 0) throw new TypeError("Indeterminate Receipts cannot carry a result");
	return {
		variant: "attempt",
		id,
		attempt,
		outcome,
		failure,
		previous,
		result
	};
}
/**
* Version 2 of the serialized form. Version 1 had no failure field, so its `failed` payloads
* cannot be upcast: the kind is not derivable from bytes that never carried it, and choosing
* one would manufacture the determination §7.4 exists to withhold. Rejecting an unknown
* major with a typed error is what §8.3 requires of exactly that case, and no persisted
* version 1 bytes exist to reject — no declared migration names the Receipt record,
* `artifacts/conformance/live-evidence` holds test results and a deployment manifest rather
* than records, `artifacts/integration` references Receipts only as paths and selectors, and
* every Receipt fixture in the suite is built in process.
*/
var ReceiptCodecV2 = class extends RecordCodec {
	constructor() {
		super([
			Receipt,
			AttemptReceipt,
			PreEffectReceipt,
			AttemptCompletion,
			AttemptFailureKind,
			RaisedFailure,
			DeadlineFailure,
			AbortedFailure,
			DomainLostFailure,
			OutputInvalidFailure,
			SucceededCompletion,
			IndeterminateCompletion,
			FailedCompletion,
			TextId,
			ContentRef,
			Digest,
			InvocationId,
			ReceiptId,
			EffectAttemptId
		], "invocation.receipt", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(record) {
		if (record instanceof PreEffectReceipt) {
			if ("failure" in record) throw new TypeError("A pre-effect Receipt cannot carry an attempt failure kind");
			return {
				id: record.id.value,
				invocation: record.invocation.value,
				itemIndex: record.itemIndex,
				outcome: record.outcome,
				reason: record.reason,
				recordedAt: record.recordedAt.toISOString(),
				variant: record.variant
			};
		}
		if (record instanceof AttemptReceipt) return {
			attempt: record.attempt.value,
			failure: record.failure?.kind ?? null,
			id: record.id.value,
			outcome: record.outcome,
			previous: record.previous?.value ?? null,
			recordedAt: record.recordedAt.toISOString(),
			result: record.result?.value ?? null,
			variant: record.variant
		};
		throw new TypeError("Receipt implementation is invalid");
	}
	decodePayload(payload, _version) {
		const variant = requireString(requireObject(payload, "Receipt payload"), "variant");
		if (variant === "preEffect") {
			const object = requireExactObject(payload, [
				"id",
				"invocation",
				"itemIndex",
				"outcome",
				"reason",
				"recordedAt",
				"variant"
			], "Pre-effect Receipt");
			return new PreEffectReceipt(new ReceiptId(requireString(object, "id")), new InvocationId(requireString(object, "invocation")), requireSafeInteger(object, "itemIndex", "Receipt item index"), requirePreEffectOutcome(requireString(object, "outcome")), requireDate(object, "recordedAt"), requireString(object, "reason"));
		}
		if (variant === "attempt") {
			const object = requireExactObject(payload, [
				"attempt",
				"failure",
				"id",
				"outcome",
				"previous",
				"recordedAt",
				"result",
				"variant"
			], "Attempt Receipt");
			const previous = requireNullableString(object, "previous", "Attempt Receipt previous reference");
			const result = requireNullableString(object, "result", "Attempt Receipt result reference");
			return new AttemptReceipt(new ReceiptId(requireString(object, "id")), new EffectAttemptId(requireString(object, "attempt")), decodedCompletion(requireAttemptOutcome(requireString(object, "outcome")), requireNullableString(object, "failure", "Attempt Receipt failure kind")), previous === void 0 ? void 0 : new ReceiptId(previous), requireDate(object, "recordedAt"), result === void 0 ? void 0 : new ContentRef(result));
		}
		throw new TypeError("Receipt variant is invalid");
	}
};
/**
* The only place a failure kind is reconstructed from its wire label. A decoder restores a
* determination its writer already made and cannot re-observe the fact behind it, so this
* door stays inside the codec and is never a public constructor.
*/
function decodedCompletion(outcome, failure) {
	if (outcome === "failed") {
		if (failure === void 0) throw new TypeError("A failed Attempt Receipt must name one failure kind");
		if (!isMember(ATTEMPT_FAILURE_KINDS, failure)) throw new TypeError("Attempt Receipt failure kind is invalid");
		return AttemptCompletion.failed(failureKindsByLabel[failure]);
	}
	if (failure !== void 0) throw new TypeError("Only a failed Attempt Receipt may name a failure kind");
	return outcome === "succeeded" ? AttemptCompletion.succeeded : AttemptCompletion.indeterminate;
}
var failureKindsByLabel = Object.freeze({
	aborted: abortedFailure,
	deadline: deadlineFailure,
	domainLost: domainLostFailure,
	outputInvalid: outputInvalidFailure,
	raised: raisedFailure
});
function requirePreEffectOutcome(value) {
	if (value === "deniedPreEffect" || value === "cancelledPreEffect") return value;
	throw new TypeError("Pre-effect Receipt outcome is invalid");
}
function requireAttemptOutcome(value) {
	if (isMember(ATTEMPT_RECEIPT_OUTCOMES, value)) return value;
	throw new TypeError("Attempt Receipt outcome is invalid");
}
var ReceiptCodec = new ReceiptCodecV2();
function invalid$5(message) {
	return new AgentCoreError("invocation.invalid", message);
}
//#endregion
//#region src/invocations/detached-target.ts
/**
* What the target observed when it was asked to stop one exact attempt.
*
* This is an observation and never a verdict. §7.4 lets a host record `aborted` only for
* cancellation that reached the attempt, and the party that knows whether it reached one is
* the target holding the live effect — not the Run that asked and not this value. So the two
* cases carry the consequence for the Invocation owner rather than a failure kind, and there
* is no member from which `AttemptFailureKind.aborted` can be built:
*
* - `reached`: the target aborted the exact live effect. The running attempt ends through the
*   ordinary path, and its own classification names `aborted` because the signal it runs under
*   is the one that fired. Nothing is recorded here.
* - `absent`: the target holds no live effect for this attempt — the usual case after a
*   restart. The attempt was admitted and its outcome is unknown, which §7.4 already fixes as
*   `indeterminate`, so reconciliation resolves it. Manufacturing `aborted` here would claim a
*   fact about a controller nobody observed.
*/
var AttemptCancellationObservation = class AttemptCancellationObservation {
	/** The target aborted the exact live effect this attempt runs. */
	static get reached() {
		return reachedObservation;
	}
	/** The target holds no live effect for this attempt. */
	static get absent() {
		return absentObservation;
	}
	equals(other) {
		return other instanceof AttemptCancellationObservation && other.kind === this.kind;
	}
};
var ReachedCancellation = class extends AttemptCancellationObservation {
	kind = "reached";
	completion = void 0;
};
var AbsentCancellation = class extends AttemptCancellationObservation {
	kind = "absent";
	completion = AttemptCompletion.indeterminate;
};
var reachedObservation = Object.freeze(new ReachedCancellation());
var absentObservation = Object.freeze(new AbsentCancellation());
/**
* The live target of a detached item: it starts the work and it can stop it.
*
* Both members are on one contract because they name one live resource from two directions.
* The signal in the resources it returns is the same cancellation `cancel` fires, which is
* what makes "cancellation reached the attempt" true rather than advisory (§4.3's reachability
* requirement). An implementation that returned an unrelated signal would leave every reached
* cancellation classified as `indeterminate`.
*
* `execution` carries only what the execution step reads — the pinned Operation's declared
* shape and its handler — and never a whole `MediatedInvocationRequest`. A detached item
* outlives the Turn that issued it, so a per-Turn closure is exactly what this contract
* replaces: after a restart the durable records are all there is, and the parts of a live
* request that are not reconstructible (its request key, its full authority intent, its
* interceptor traces) must not be demanded here, because a target could satisfy that demand
* only by fabricating authority evidence. An implementation that cannot rebuild the handler
* refuses rather than returning one that runs a different effect.
*/
var DetachedEffectTarget = class {};
var answeringDomain = Object.freeze({ answering: () => true });
/**
* The in-memory reference target: one live controller per in-flight attempt, keyed by
* EffectAttemptId, and a `restart` that drops every one of them the way a host restart does.
*/
var MemoryDetachedEffectTarget = class extends DetachedEffectTarget {
	init;
	#controllers = /* @__PURE__ */ new Map();
	constructor(init) {
		super();
		this.init = init;
	}
	/** The controller this target hands to one attempt, created on first use. */
	controller(attempt) {
		const existing = this.#controllers.get(attempt.value);
		if (existing !== void 0) return existing;
		const created = new AbortController();
		this.#controllers.set(attempt.value, created);
		return created;
	}
	/** Drops every live controller, leaving only the durable records behind. */
	restart() {
		this.#controllers.clear();
	}
	execution(item) {
		const resources = Object.freeze({
			signal: this.controller(item.attempt).signal,
			content: this.init.content,
			deadline: this.init.deadline,
			target: this.init.target ?? answeringDomain
		});
		return Promise.resolve(Object.freeze({
			descriptor: this.init.descriptor,
			execute: (itemIndex, context) => Promise.resolve(this.init.execute(item, itemIndex, context)),
			resources,
			targetAdmission: this.init.targetAdmission
		}));
	}
	cancel(attempt) {
		if (attempt.constructor !== EffectAttemptId) throw new AgentCoreError("invocation.invalid", "Detached effect cancellation names its exact EffectAttempt");
		const controller = this.#controllers.get(attempt.value);
		if (controller === void 0) return Promise.resolve(AttemptCancellationObservation.absent);
		controller.abort();
		return Promise.resolve(AttemptCancellationObservation.reached);
	}
};
//#endregion
//#region src/invocations/export-manifest.ts
var INVOCATION_CONTEXT_EXPORTS = Object.freeze({
	runtime: Object.freeze([
		"AdmittedInvocationItem",
		"AlarmDetachedEffectDriver",
		"AlarmReconciliationDriver",
		"Approval",
		"ApprovalCodec",
		"ApprovalId",
		"AttemptCancellationObservation",
		"AttemptCompletion",
		"AttemptFailureKind",
		"AttemptReceipt",
		"AuditRecord",
		"AuditRecordCodec",
		"AuditRecordId",
		"AuthorityAdmissionReference",
		"CanonicalBatchInvocationPort",
		"ClaimWorkerId",
		"CorrelationId",
		"DetachedEffectAdmissionOutcome",
		"DetachedEffectCancellationOutcome",
		"DetachedEffectDeliveryPort",
		"DetachedEffectExecution",
		"DetachedEffectExecutionCodec",
		"DetachedEffectExecutionState",
		"DetachedEffectTarget",
		"EffectAttempt",
		"EffectAttemptCodec",
		"EffectAttemptId",
		"INVOCATION_COMMANDS",
		"InvocationCommandPayload",
		"InvocationContinuation",
		"InvocationContinuationCodec",
		"InvocationDrainQuery",
		"InvocationError",
		"InvocationId",
		"InvocationLedger",
		"InvocationPlacementPin",
		"InvocationProtectedOperationPort",
		"InvocationPublicationDrainer",
		"InvocationPublicationOutbox",
		"InvocationPublicationOutboxCodec",
		"InvocationReconciler",
		"ItemClaim",
		"ItemClaimCodec",
		"ItemClaimId",
		"MediatedReplayRecord",
		"MediatedReplayRecordCodec",
		"MemoryDetachedEffectExecutionPersistence",
		"MemoryDetachedEffectTarget",
		"MemoryInvocationMediationPersistence",
		"MemoryInvocationPersistence",
		"OperationPin",
		"PreEffectReceipt",
		"PreparedInvocation",
		"PreparedInvocationCodec",
		"PreparedInvocationHeader",
		"PreparedItem",
		"Receipt",
		"ReceiptCodec",
		"ReceiptId",
		"ReplayOperationInvocationPort",
		"RouteProjectionId",
		"RouteReservationId",
		"WriteRecordId",
		"auditEvidenceIdentity",
		"cloneDetachedEffectExecutionMemoryState",
		"cloneInvocationMediationMemoryState",
		"cloneInvocationMemoryState",
		"createDetachedEffectExecutionMemoryState",
		"createInvocationMediationMemoryState",
		"createInvocationMemoryState",
		"createInvocationProtocolCommands",
		"deriveBatchOutcome",
		"immutableReference",
		"invocationError",
		"receiptContentRetention",
		"requireArray",
		"requireCanonicalText",
		"requireDate",
		"requireDigest",
		"requireExactObject",
		"requireNonnegativeInteger",
		"requireNullableDate",
		"requireNullableString",
		"requireObject",
		"requireSafeInteger",
		"requireString",
		"sameJson",
		"structuralCodec",
		"terminalBatchOutcome",
		"validDate",
		"validateAuditAppend",
		"validateStoredAuditLinkage"
	]),
	types: Object.freeze([
		"AdmittedInvocationItemInit",
		"ApprovalState",
		"ApprovalAuditEvidence",
		"ApprovalAuditPhase",
		"AttemptAuditEvidence",
		"AuditAppendContext",
		"AttemptFailureKindName",
		"AttemptReceiptOutcome",
		"AttemptTargetDomain",
		"AuditEvidenceResolver",
		"AuditKind",
		"AuditRecordInit",
		"AuditRecordLookup",
		"AuditRootAdmission",
		"AuthorityAdmissionPort",
		"AuthorityAdmissionContext",
		"BatchOutcome",
		"CanonicalBatchAttemptResources",
		"CanonicalBatchAuthorityAuthenticationPort",
		"CanonicalBatchAuthorityPermitPort",
		"CanonicalBatchInvocationRequest",
		"CanonicalBatchInvocationResult",
		"CanonicalBatchInvoker",
		"CanonicalBatchItemAdmission",
		"CanonicalBatchItemExecution",
		"CanonicalBatchItemResult",
		"CanonicalBatchPreparationPort",
		"CanonicalBatchRecordPort",
		"CanonicalBatchResourcesPort",
		"CanonicalBatchTargetAdmission",
		"CommitAuditEvidence",
		"DeliveryAuditEvidence",
		"DetachedEffectExecutionInit",
		"DetachedEffectExecutionMemoryState",
		"DetachedEffectExecutionPersistence",
		"DetachedEffectExecutionSource",
		"DetachedEffectExecutionStateKind",
		"DetachedEffectSweepReport",
		"EffectReconciliationPort",
		"EventAuditEvidence",
		"InvocationAuditPersistence",
		"InvocationClaimOwnerPort",
		"InvocationCommandBackend",
		"InvocationCommandCallerPolicies",
		"InvocationCommandName",
		"InvocationCommandPayloadValue",
		"InvocationCommitPort",
		"InvocationEvidencePersistence",
		"InvocationEventPort",
		"InvocationFailure",
		"InvocationMemoryCodecs",
		"InvocationMemoryState",
		"InvocationMediationMemoryState",
		"InvocationPersistence",
		"InvocationPreparationPort",
		"InvocationReferencePorts",
		"InvocationReconciliationRecordPort",
		"InvocationReplayPersistence",
		"InvocationTimePort",
		"InvocationTransactionPort",
		"ItemClaimOwner",
		"MemoryDetachedEffectTargetInit",
		"OperationPinInit",
		"PlacementPinInit",
		"ProfileMediationIdentityPort",
		"PreEffectReceiptOutcome",
		"PreparedInvocationCodecs",
		"PreparedInvocationHeaderInit",
		"PreparedPayload",
		"ProjectionAuditEvidence",
		"ReceiptAuditEvidence",
		"ReceiptAuditOutcome",
		"ReceiptObservation",
		"ReceiptSupersessionEvidence",
		"ReconciliationResult",
		"RouteAuditEvidence",
		"StructuralCodec",
		"TerminalBatchOutcome",
		"UnpreparedPayload",
		"WriteAuditEvidence",
		"WriteAuditOutcome"
	])
});
//#endregion
//#region src/invocations/command.ts
var INVOCATION_COMMANDS = Object.freeze({
	prepareExecutor: "invocation.prepare.executor",
	prepareOwner: "invocation.prepare.owner",
	resolveApproval: "invocation.approval.resolve",
	claimExecutor: "invocation.item.claim.executor",
	claimSystem: "invocation.item.claim.system",
	recoverExecutor: "invocation.item.recover.executor",
	recoverSystem: "invocation.item.recover.system",
	attemptExecutor: "invocation.attempt.append.executor",
	attemptSystem: "invocation.attempt.append.system",
	preEffectReceipt: "invocation.receipt.preEffect",
	attemptReceipt: "invocation.receipt.attempt",
	reconcileReceipt: "invocation.receipt.reconcile"
});
/**
* §8.3: the Invocation records this command family writes under its own concrete codecs.
* The prepared, claim and attempt records are written through codecs the host parameterises
* with its own lease and authority reference shapes, so their versions are the host's to
* declare where it binds them; the approval and Receipt records are this family's own and
* are declared here. invocation.receipt sits at major 2 — the version that carries the §7.4
* failure kind — so a store written under major 1 is refused at this declaration rather
* than at the first Receipt a reader fails to decode.
*/
var INVOCATION_RECORD_CODECS = CodecDeclaration.of([ApprovalCodec, ReceiptCodec]);
function createInvocationProtocolCommands(backend, callers) {
	return Object.freeze(commandPolicies.map((policy) => new InvocationProtocolCommand(backend, policy.command, policy.lease, callers[policy.caller])));
}
var InvocationCommandPayload = Object.freeze({ encode(invocation, body) {
	return encodeCanonicalJson({
		body,
		invocation: invocation.value
	});
} });
var InvocationProtocolCommand = class {
	backend;
	command;
	lease;
	caller;
	/**
	* §8.3: the Invocation record set every one of these commands commits into. The family
	* shares one Actor and one ledger, so each command declares the whole set rather than
	* the record its own name suggests: a reader that cannot decode an EffectAttempt cannot
	* serve a Receipt command either.
	*/
	declaration = INVOCATION_RECORD_CODECS;
	expectedRevision = "forbidden";
	payload = new InvocationPayloadCodec();
	replyCodec;
	observationCodec;
	constructor(backend, command, lease, caller) {
		this.backend = backend;
		this.command = command;
		this.lease = lease;
		this.caller = caller;
		this.replyCodec = backend.replyCodec;
		this.observationCodec = backend.observationCodec;
	}
	authorize(read, envelope, payload) {
		return requireSynchronousResult(this.backend.authorize(this.command, read, envelope, requirePayload(payload)));
	}
	permitsLifecycle(read, envelope, payload) {
		return requireSynchronousResult(this.backend.permitsLifecycle(this.command, read, envelope, requirePayload(payload)));
	}
	currentRevision(_read, _envelope, _payload) {}
	currentLease(read, envelope, payload, at) {
		return requireSynchronousResult(this.backend.currentLease(this.command, read, envelope, requirePayload(payload), at));
	}
	execute(transaction, envelope, payload, at) {
		return requireSynchronousResult(this.backend.execute(this.command, transaction, envelope, requirePayload(payload), at));
	}
};
var InvocationPayloadCodec = class {
	decode(bytes) {
		const value = decodeCanonicalJson(bytes);
		let object;
		try {
			object = requireExactObject(value, ["body", "invocation"], "Invocation command payload");
		} catch {
			throw new TypeError("Invocation command payload is malformed");
		}
		const body = object["body"];
		if (!isFacetDataMap(body)) throw new TypeError("Invocation command payload is malformed");
		let invocation;
		try {
			invocation = requireString(object, "invocation");
		} catch {
			throw new TypeError("Invocation command payload is malformed");
		}
		const payload = Object.freeze({
			invocation: new InvocationId(invocation),
			body: canonicalFacetDataMap(body)
		});
		issuedPayloads.add(payload);
		return payload;
	}
};
function requirePayload(value) {
	if (!issuedPayloads.has(value)) throw new TypeError("Invocation command payload was not decoded");
	return value;
}
var issuedPayloads = /* @__PURE__ */ new WeakSet();
var commandPolicies = Object.freeze([
	{
		command: INVOCATION_COMMANDS.prepareExecutor,
		lease: "required",
		caller: "executor"
	},
	{
		command: INVOCATION_COMMANDS.prepareOwner,
		lease: "forbidden",
		caller: "owner"
	},
	{
		command: INVOCATION_COMMANDS.resolveApproval,
		lease: "forbidden",
		caller: "approver"
	},
	{
		command: INVOCATION_COMMANDS.claimExecutor,
		lease: "required",
		caller: "executor"
	},
	{
		command: INVOCATION_COMMANDS.claimSystem,
		lease: "forbidden",
		caller: "system"
	},
	{
		command: INVOCATION_COMMANDS.recoverExecutor,
		lease: "required",
		caller: "executor"
	},
	{
		command: INVOCATION_COMMANDS.recoverSystem,
		lease: "forbidden",
		caller: "system"
	},
	{
		command: INVOCATION_COMMANDS.attemptExecutor,
		lease: "required",
		caller: "executor"
	},
	{
		command: INVOCATION_COMMANDS.attemptSystem,
		lease: "forbidden",
		caller: "system"
	},
	{
		command: INVOCATION_COMMANDS.preEffectReceipt,
		lease: "forbidden",
		caller: "system"
	},
	{
		command: INVOCATION_COMMANDS.attemptReceipt,
		lease: "forbidden",
		caller: "system"
	},
	{
		command: INVOCATION_COMMANDS.reconcileReceipt,
		lease: "forbidden",
		caller: "system"
	}
]);
//#endregion
//#region src/invocations/outcome.ts
function deriveBatchOutcome(itemCount, receipts) {
	requireReceiptSlots(itemCount, receipts);
	if (!isCompleteReceipts(receipts)) return void 0;
	const outcomes = receipts.map((receipt) => receipt.outcome);
	if (outcomes.includes("indeterminate")) return "indeterminate";
	if (outcomes.every((outcome) => outcome === "succeeded")) return "succeeded";
	if (outcomes.includes("succeeded")) return "partiallySucceeded";
	if (outcomes.includes("failed")) return "failed";
	if (outcomes.includes("cancelledPreEffect")) return "cancelled";
	return "denied";
}
function isCompleteReceipts(receipts) {
	return receipts.every((receipt) => receipt !== void 0);
}
function requireReceiptSlots(itemCount, receipts) {
	if (!Number.isSafeInteger(itemCount) || itemCount <= 0 || receipts.length !== itemCount) throw new TypeError("Batch outcome requires one Receipt slot per nonempty invocation item");
}
function terminalBatchOutcome(outcome) {
	return outcome === void 0 || outcome === "indeterminate" ? void 0 : outcome;
}
//#endregion
//#region src/invocations/drain.ts
/**
* SPEC §4.1 (C13-FACET-WITHDRAWAL-DRAIN): the admitted-item query a Facet withdrawal's drain
* gate asks, answered from the Invocation plane's own durable records. `admitted` is a query
* over `PreparedInvocationHeader` whose `OperationPin.target` names the Facet — the frozen
* intent, never live activation state, so an item settles against the Facet the intent named
* and never against whatever later occupies that `FacetRef`. `terminal` is that item's
* current Receipt (§7.4): an item is terminal exactly when every one of its items has a
* current Receipt and the derived batch outcome is not `indeterminate`, because an
* indeterminate Receipt may still be superseded under C13-RECEIPT-FAILURE-KIND and a
* withdrawal that treated it as settled would report completion over unfinished effect.
*
* It carries no state of its own: the drain set is closed by the withdrawal transaction that
* stops admission and made durable by that transaction's Workspace-owned capture, not by a
* second index here.
*/
var InvocationDrainQuery = class {
	index;
	persistence;
	ledger;
	constructor(index, persistence, ledger) {
		this.index = index;
		this.persistence = persistence;
		this.ledger = ledger;
	}
	admitted(transaction, facet) {
		const named = this.index.preparedForTarget(transaction, facet.value).filter((item) => this.persistence.prepared(transaction, item)?.header.operation.target === facet.value);
		return Object.freeze([...new Map(named.map((item) => [item.value, item])).values()].sort((left, right) => compareCanonicalText(left.value, right.value)));
	}
	terminal(transaction, item) {
		return terminalBatchOutcome(this.ledger.batchOutcome(transaction, item)) !== void 0;
	}
};
//#endregion
//#region src/invocations/ledger.ts
var InvocationLedger = class {
	persistence;
	lease;
	preparation;
	time;
	claimOwner;
	authorityAdmission;
	constructor(persistence, lease, preparation, time, claimOwner, authorityAdmission) {
		this.persistence = persistence;
		this.lease = lease;
		this.preparation = preparation;
		this.time = time;
		this.claimOwner = claimOwner;
		this.authorityAdmission = authorityAdmission;
	}
	prepareUnchecked(transaction, record) {
		this.validatePreparation(transaction, record);
		this.persistence.insertPrepared(transaction, record);
	}
	prepareWithAudit(transaction, record, audit, evidence) {
		this.validatePreparation(transaction, record);
		this.requirePreparationAuditBinding(record, audit);
		if (audit.kind.kind === "invocation") evidence.appendAudit(transaction, audit);
		else this.requirePersistedAudit(transaction, audit, evidence);
		this.persistence.insertPrepared(transaction, record);
	}
	requirePreparedAudit(transaction, record, audit, evidence) {
		this.requirePreparationAuditBinding(record, audit);
		this.requirePersistedAudit(transaction, audit, evidence);
	}
	requirePersistedAuditRelation(transaction, audit, evidence) {
		validateAuditRelation(audit, { get: (id) => evidence.audit(transaction, id) }, void 0, this.auditEvidence(transaction, {}));
	}
	validatePreparation(transaction, record) {
		if (this.persistence.prepared(transaction, record.header.id) !== void 0) throw invalid$4("PreparedInvocation already exists");
		if (!requireSynchronousResult(this.preparation.admits(transaction, record))) throw invalid$4("PreparedInvocation owner, audit, route, or schema evidence is invalid");
	}
	requirePreparationAuditBinding(record, audit) {
		const route = record.header.route;
		const local = route === void 0 && audit.kind.kind === "invocation" && audit.kind.id.equals(record.header.id);
		const routed = route !== void 0 && audit.kind.kind === "routeProjected" && audit.kind.reservation.equals(route);
		if (!audit.id.equals(record.header.auditCause) || !audit.actor.equals(record.header.actor) || audit.cause !== void 0 || !local && !routed) throw invalid$4("Preparation AuditRecord does not bind the PreparedInvocation");
	}
	requirePersistedAudit(transaction, audit, evidence) {
		const persisted = evidence.audit(transaction, audit.id);
		if (persisted === void 0 || !sameAudit(persisted, audit)) throw invalid$4("PreparedInvocation does not have its exact preparation AuditRecord");
	}
	requestApproval(transaction, approval) {
		if (!this.requirePrepared(transaction, approval.invocation).intentDigest.equals(approval.intentDigest) || approval.revision.value !== 0 || approval.state.kind !== "pending" || this.persistence.approvalForInvocation(transaction, approval.invocation) !== void 0) throw invalid$4("Approval does not bind a fresh exact PreparedInvocation");
		this.persistence.appendApproval(transaction, approval);
	}
	appendApprovalRevision(transaction, next) {
		const current = this.persistence.approval(transaction, next.id);
		if (current === void 0 || next.revision.value !== current.revision.value + 1 || !next.invocation.equals(current.invocation) || !next.intentDigest.equals(current.intentDigest) || next.requestedAt.getTime() !== current.requestedAt.getTime() || next.expiresAt?.getTime() !== current.expiresAt?.getTime() || next.state.kind === "consumed" || !isLegalApprovalTransition(current, next)) throw invalid$4("Approval revision is not the next legal transition");
		this.persistence.appendApproval(transaction, next);
	}
	claimItem(transaction, claim, now) {
		this.requireTime(transaction, now);
		const prepared = this.requireItem(transaction, claim.invocation, claim.itemIndex);
		claim.requireFuture(now);
		if (this.currentUnattemptedClaim(transaction, claim.invocation, claim.itemIndex) !== void 0) throw invalid$4("Item already has an unattempted claim");
		const current = this.currentReceipt(transaction, claim.invocation, claim.itemIndex);
		if (current === void 0 && this.persistence.attemptsForItem(transaction, claim.invocation, claim.itemIndex).length !== 0) throw invalid$4("Item has an unresolved EffectAttempt");
		const ordinal = current === void 0 ? 0 : this.retryOrdinal(transaction, current);
		if (claim.attemptOrdinal !== ordinal) throw invalid$4("Item claim has the wrong attempt ordinal");
		this.validateClaimOwner(prepared, claim);
		this.persistence.appendClaim(transaction, claim);
	}
	recoverClaim(transaction, previousId, replacement, now) {
		this.requireTime(transaction, now);
		const previous = this.persistence.claim(transaction, previousId);
		const current = previous === void 0 ? void 0 : this.currentUnattemptedClaim(transaction, previous.invocation, previous.itemIndex);
		const receipt = previous === void 0 ? void 0 : this.currentReceipt(transaction, previous.invocation, previous.itemIndex);
		const failedAttempt = receipt instanceof AttemptReceipt && receipt.outcome === "failed" ? this.persistence.attempt(transaction, receipt.attempt) : void 0;
		const followsFailedAttempt = previous !== void 0 && failedAttempt !== void 0 && failedAttempt.ordinal + 1 === previous.attemptOrdinal && failedAttempt.invocation.equals(previous.invocation) && failedAttempt.itemIndex === previous.itemIndex;
		if (previous === void 0 || current === void 0 || !current.id.equals(previous.id) || this.persistence.attemptForClaim(transaction, previous.id) !== void 0 || receipt !== void 0 && !followsFailedAttempt) throw invalid$4("Only the exact current no-attempt claim may be recovered");
		if (!sameSchedulingIdentity(previous.recover(replacement.id, replacement.owner, replacement.expiresAt, now), replacement)) throw invalid$4("Recovered claim changed immutable scheduling identity");
		this.validateClaimOwner(this.requireItem(transaction, replacement.invocation, replacement.itemIndex), replacement);
		this.persistence.appendClaim(transaction, replacement);
	}
	admitAttempt(transaction, attempt, now, authentication) {
		const admitted = this.admitAttemptInternal(transaction, attempt, now, authentication);
		if (admitted === false) throw invalid$4("AuthorityAdmission does not authorize this exact EffectAttempt");
		return admitted;
	}
	/**
	* `false` reports an AuthorityAdmission denial, the one refusal a caller may record as
	* evidence instead of raising. Every other refusal is a caller error and throws here.
	*/
	admitAttemptInternal(transaction, attempt, now, authentication) {
		const nowTime = this.requireTime(transaction, now);
		const prepared = this.requireItem(transaction, attempt.invocation, attempt.itemIndex);
		const currentReceipt = this.currentReceipt(transaction, attempt.invocation, attempt.itemIndex);
		if (currentReceipt !== void 0 && this.retryOrdinal(transaction, currentReceipt) !== attempt.ordinal) throw invalid$4("EffectAttempt does not follow the final failed attempt ordinal");
		const claim = this.persistence.claim(transaction, attempt.claim);
		const currentClaim = this.currentUnattemptedClaim(transaction, attempt.invocation, attempt.itemIndex);
		if (claim === void 0 || currentClaim === void 0 || !claim.id.equals(currentClaim.id) || claim.attemptOrdinal !== attempt.ordinal || claim.expiresAt.getTime() <= nowTime || attempt.startedAt.getTime() > nowTime || this.persistence.attemptForClaim(transaction, claim.id) !== void 0 || attempt.idempotencyKey !== prepared.item(attempt.itemIndex).idempotencyKey) throw invalid$4("EffectAttempt does not match the live current claim");
		if (claim.owner.kind === "executor") {
			if (attempt.token === void 0 || !structuralEquals(this.lease, claim.owner.token, attempt.token) || prepared.header.lease === void 0 || !structuralEquals(this.lease, prepared.header.lease, attempt.token)) throw invalid$4("EffectAttempt token does not match its executor claim");
		} else if (attempt.token !== void 0) throw invalid$4("System EffectAttempt cannot carry an executor token");
		if (!requireSynchronousResult(this.claimOwner.admits(transaction, claim, attempt))) throw invalid$4("EffectAttempt caller does not own the current ItemClaim");
		if (!requireSynchronousResult(this.authorityAdmission.admits(transaction, attempt.admission, {
			invocation: attempt.invocation,
			itemIndex: attempt.itemIndex,
			ordinal: attempt.ordinal,
			lease: attempt.token,
			authority: prepared.header.authority,
			domain: prepared.header.domain,
			pathEpochs: prepared.header.pathEpochs,
			intentDigest: prepared.intentDigest,
			itemKey: attempt.idempotencyKey
		}, authentication))) return false;
		let consumed;
		const approval = this.persistence.approvalForInvocation(transaction, prepared.header.id);
		const continuation = this.persistence.continuation(transaction, prepared.header.id);
		if (prepared.header.operation.approvalRequired && approval === void 0) throw invalid$4("EffectAttempt requires Approval");
		if (approval === void 0 && continuation !== void 0) throw invalid$4("InvocationContinuation requires its exact Approval");
		if (approval !== void 0) {
			if (!approval.invocation.equals(prepared.header.id) || !approval.intentDigest.equals(prepared.intentDigest)) throw invalid$4("EffectAttempt Approval does not bind the PreparedInvocation");
			if (approval.state.kind === "approved") {
				if (continuation !== void 0) throw invalid$4("Approved Invocation cannot already have a continuation");
				if (approval.expiresAt !== void 0 && now.getTime() >= approval.expiresAt.getTime()) throw invalid$4("Approved continuation has expired");
				consumed = approval.consume(attempt.id, now);
				this.persistence.appendApproval(transaction, consumed);
				this.persistence.insertContinuation(transaction, new InvocationContinuation(prepared.header.id, prepared.intentDigest, approval.id, attempt.id, attempt.itemIndex, attempt.ordinal, claim.id, claim.owner, attempt.idempotencyKey, now));
			} else if (approval.state.kind === "consumed") this.requireContinuation(transaction, prepared, approval, continuation);
			else throw invalid$4("EffectAttempt requires an approved continuation");
		}
		this.persistence.appendAttempt(transaction, attempt);
		return consumed;
	}
	admitAttemptWithAudit(transaction, attempt, now, audit, evidence, authentication) {
		const consumed = this.admitAttempt(transaction, attempt, now, authentication);
		evidence.appendAudit(transaction, audit, { evidence: this.auditEvidence(transaction, { attempt }) });
		return consumed;
	}
	admitAttemptOrRecordAuthorityDenialWithAudit(transaction, attempt, now, attemptAudit, denial, evidence, authentication) {
		if (this.admitAttemptInternal(transaction, attempt, now, authentication) === false) {
			this.recordClaimedAuthorityDenialWithAudit(transaction, denial.claim, denial.receipt, denial.audit, denial.publication, evidence);
			return false;
		}
		evidence.appendAudit(transaction, attemptAudit, { evidence: this.auditEvidence(transaction, { attempt }) });
		return true;
	}
	recordClaimedAuthorityDenialWithAudit(transaction, claim, receipt, audit, publication, evidence) {
		this.recordClaimedPreEffectWithAudit(transaction, claim, receipt, audit, publication, evidence, "deniedPreEffect", "Authority denial");
	}
	/**
	* The other pre-effect outcome a claimed item can reach. §7.4 fixes an expiry,
	* cancellation, or loss of the required Turn before the effect as `cancelledPreEffect`
	* over an item with no EffectAttempt, and §5.6 puts that boundary exactly at admission.
	*
	* It is its own entry point rather than an outcome argument because the two are different
	* facts with different batch outcomes (§7.5), and a caller that could pass either could
	* pass the wrong one. The item's owner supplies the fact; the Receipt, its audit edge, and
	* its publication stay owned here.
	*/
	recordClaimedCancellationWithAudit(transaction, claim, receipt, audit, publication, evidence) {
		this.recordClaimedPreEffectWithAudit(transaction, claim, receipt, audit, publication, evidence, "cancelledPreEffect", "Pre-effect cancellation");
	}
	recordClaimedPreEffectWithAudit(transaction, claim, receipt, audit, publication, evidence, outcome, subject) {
		this.requireItem(transaction, claim.invocation, claim.itemIndex);
		const currentClaim = this.currentUnattemptedClaim(transaction, claim.invocation, claim.itemIndex);
		if (currentClaim === void 0 || !currentClaim.id.equals(claim.id) || this.persistence.attemptForClaim(transaction, claim.id) !== void 0 || this.currentReceipt(transaction, claim.invocation, claim.itemIndex) !== void 0 || receipt.outcome !== outcome || !receipt.invocation.equals(claim.invocation) || receipt.itemIndex !== claim.itemIndex || publication.state.kind !== "pending" || !publication.observation.invocation.equals(claim.invocation) || !publication.observation.receipt.equals(receipt.id) || !publication.observation.audit.equals(audit.id)) throw invalid$4(`${subject} evidence does not bind the current claimed item`);
		this.persistence.appendReceipt(transaction, receipt);
		evidence.appendAudit(transaction, audit, { evidence: this.auditEvidence(transaction, { receipt }) });
		evidence.appendPublication(transaction, publication);
	}
	recordAttemptReceiptWithAudit(transaction, receipt, attemptAudit, audit, publication, evidence) {
		const attempt = this.persistence.attempt(transaction, receipt.attempt);
		const persistedAttemptAudit = evidence.audit(transaction, attemptAudit.id);
		if (attempt === void 0 || !receipt.attempt.equals(attempt.id) || attemptAudit.kind.kind !== "attempt" || !attemptAudit.kind.id.equals(attempt.id) || attemptAudit.cause === void 0 || !attemptAudit.cause.equals(attempt.auditCause) || persistedAttemptAudit === void 0 || !sameAudit(persistedAttemptAudit, attemptAudit) || publication.state.kind !== "pending" || !publication.observation.invocation.equals(attempt.invocation) || !publication.observation.receipt.equals(receipt.id) || !publication.observation.audit.equals(audit.id)) throw invalid$4("Receipt AuditRecord or publication does not bind the attempted effect");
		this.recordAttemptReceipt(transaction, receipt);
		evidence.appendAudit(transaction, audit, { evidence: this.auditEvidence(transaction, { receipt }) });
		evidence.appendPublication(transaction, publication);
	}
	requireContinuation(transaction, prepared, approval, continuation) {
		if (approval.state.kind !== "consumed" || continuation === void 0 || !continuation.invocation.equals(prepared.header.id) || !continuation.intentDigest.equals(prepared.intentDigest) || !continuation.approval.equals(approval.id) || !continuation.firstAttempt.equals(approval.state.firstAttempt)) throw invalid$4("Consumed Approval has no matching InvocationContinuation");
		const first = this.persistence.attempt(transaction, continuation.firstAttempt);
		const claim = this.persistence.claim(transaction, continuation.firstClaim);
		if (first === void 0 || claim === void 0 || !first.invocation.equals(continuation.invocation) || first.itemIndex !== continuation.firstItemIndex || first.ordinal !== continuation.firstOrdinal || !first.claim.equals(continuation.firstClaim) || first.idempotencyKey !== continuation.firstItemKey || claim.itemIndex !== continuation.firstItemIndex || claim.attemptOrdinal !== continuation.firstOrdinal || !sameOwner(this.lease, claim.owner, continuation.firstClaimOwner) || prepared.item(continuation.firstItemIndex).idempotencyKey !== continuation.firstItemKey) throw invalid$4("InvocationContinuation first EffectAttempt identity is invalid");
	}
	recordPreEffect(transaction, receipt) {
		this.requireItem(transaction, receipt.invocation, receipt.itemIndex);
		if (this.persistence.attemptsForItem(transaction, receipt.invocation, receipt.itemIndex).length !== 0 || this.currentUnattemptedClaim(transaction, receipt.invocation, receipt.itemIndex) !== void 0 || this.currentReceipt(transaction, receipt.invocation, receipt.itemIndex) !== void 0) throw invalid$4("Pre-effect Receipt requires an untouched item");
		this.persistence.appendReceipt(transaction, receipt);
	}
	recordAttemptReceipt(transaction, receipt) {
		if (receipt.previous !== void 0) throw invalid$4("Initial AttemptReceipt cannot name previous");
		if (this.persistence.attempt(transaction, receipt.attempt) === void 0 || this.persistence.receiptsForAttempt(transaction, receipt.attempt).length !== 0) throw invalid$4("AttemptReceipt requires one existing unreceipted EffectAttempt");
		this.persistence.appendReceipt(transaction, receipt);
	}
	supersedeReceiptUnchecked(transaction, receipt) {
		const previous = receipt.previous === void 0 ? void 0 : this.persistence.receipt(transaction, receipt.previous);
		if (!(previous instanceof AttemptReceipt) || previous.outcome !== "indeterminate" || receipt.outcome === "indeterminate" || !receipt.attempt.equals(previous.attempt) || !this.currentReceiptForAttempt(transaction, receipt.attempt)?.id.equals(previous.id)) throw invalid$4("Only a current indeterminate Receipt may be superseded once");
		this.persistence.appendReceipt(transaction, receipt);
	}
	supersedeReceiptWithAudit(transaction, receipt, supersession, evidence) {
		const { finalReceiptAudit, supersessionAudit, publication } = supersession;
		this.requireTime(transaction, receipt.recordedAt);
		const attempt = this.persistence.attempt(transaction, receipt.attempt);
		if (attempt === void 0 || publication.state.kind !== "pending" || !publication.observation.invocation.equals(attempt.invocation) || !publication.observation.receipt.equals(receipt.id) || !publication.observation.audit.equals(supersessionAudit.id)) throw invalid$4("Receipt supersession evidence does not bind the attempted effect");
		const context = { evidence: this.auditEvidence(transaction, { receipt }) };
		evidence.appendAudit(transaction, supersessionAudit, context);
		this.supersedeReceiptUnchecked(transaction, receipt);
		evidence.appendAudit(transaction, finalReceiptAudit, context);
		evidence.appendPublication(transaction, publication);
	}
	currentReceipt(transaction, invocation, itemIndex) {
		const receipts = this.persistence.receiptsForItem(transaction, invocation, itemIndex);
		const attempts = this.persistence.attemptsForItem(transaction, invocation, itemIndex);
		const preEffect = receipts.filter((receipt) => receipt instanceof PreEffectReceipt);
		if (preEffect.length > 1 || preEffect.length === 1 && attempts.length !== 0) throw invalid$4("Item has contradictory pre-effect and attempted Receipt history");
		if (preEffect.length === 1) return preEffect[0];
		const greatest = attempts.at(-1);
		return greatest === void 0 ? void 0 : this.currentReceiptForAttempt(transaction, greatest.id);
	}
	batchOutcome(transaction, invocation) {
		const prepared = this.requirePrepared(transaction, invocation);
		return deriveBatchOutcome(prepared.itemCount, Array.from({ length: prepared.itemCount }, (_, index) => this.currentReceipt(transaction, invocation, index)));
	}
	requirePrepared(transaction, invocation) {
		const prepared = this.persistence.prepared(transaction, invocation);
		if (prepared === void 0) throw invalid$4("PreparedInvocation does not exist");
		return prepared;
	}
	requireItem(transaction, invocation, itemIndex) {
		const prepared = this.requirePrepared(transaction, invocation);
		prepared.item(itemIndex);
		return prepared;
	}
	currentUnattemptedClaim(transaction, invocation, itemIndex) {
		const latest = this.persistence.claimsForItem(transaction, invocation, itemIndex).at(-1);
		return latest === void 0 || this.persistence.attemptForClaim(transaction, latest.id) !== void 0 ? void 0 : latest;
	}
	currentReceiptForAttempt(transaction, attempt) {
		const receipts = this.persistence.receiptsForAttempt(transaction, attempt).filter((receipt) => receipt instanceof AttemptReceipt);
		if (receipts.length === 0) return void 0;
		const ids = new Set(receipts.map((receipt) => receipt.id.value));
		if (receipts.some((receipt) => receipt.previous !== void 0 && !ids.has(receipt.previous.value))) throw invalid$4("Attempt Receipt history has a missing predecessor");
		const previousIds = new Set(receipts.flatMap((receipt) => receipt.previous === void 0 ? [] : [receipt.previous.value]));
		const heads = receipts.filter((receipt) => !previousIds.has(receipt.id.value));
		if (heads.length !== 1) throw invalid$4("Attempt Receipt history does not have one current head");
		const byId = new Map(receipts.map((receipt) => [receipt.id.value, receipt]));
		const visited = /* @__PURE__ */ new Set();
		let cursor = heads[0];
		while (cursor !== void 0) {
			if (visited.has(cursor.id.value)) throw invalid$4("Attempt Receipt history contains a cycle");
			visited.add(cursor.id.value);
			cursor = cursor.previous === void 0 ? void 0 : byId.get(cursor.previous.value);
		}
		if (visited.size !== receipts.length) throw invalid$4("Attempt Receipt history contains a disconnected lineage");
		return heads[0];
	}
	retryOrdinal(transaction, receipt) {
		if (!(receipt instanceof AttemptReceipt) || receipt.outcome !== "failed") throw invalid$4("Only a final failed Receipt permits another attempt ordinal");
		const attempt = this.persistence.attempt(transaction, receipt.attempt);
		if (attempt === void 0 || attempt.ordinal === Number.MAX_SAFE_INTEGER) throw invalid$4("Prior EffectAttempt is unavailable or ordinal is exhausted");
		return attempt.ordinal + 1;
	}
	validateClaimOwner(prepared, claim) {
		if (prepared.header.lease === void 0) {
			if (claim.owner.kind !== "system" || !claim.owner.actor.equals(prepared.header.actor)) throw invalid$4("Lease-free invocation requires its exact owning Actor claim");
			return;
		}
		if (claim.owner.kind !== "executor" || !structuralEquals(this.lease, prepared.header.lease, claim.owner.token)) throw invalid$4("Executor claim must carry the exact PreparedInvocation lease");
	}
	requireTime(transaction, time) {
		const value = validDate(time, "Invocation transition time");
		if (!requireSynchronousResult(this.time.admits(transaction, time))) throw invalid$4("Invocation transition time is not trusted");
		return value;
	}
	auditEvidence(transaction, candidate) {
		return {
			approval: (id, phase) => {
				const approval = this.persistence.approval(transaction, id);
				return approval?.state.kind === phase ? {
					invocation: approval.invocation,
					phase
				} : void 0;
			},
			attempt: (id) => {
				const attempt = candidate.attempt !== void 0 && id.equals(candidate.attempt.id) ? candidate.attempt : this.persistence.attempt(transaction, id);
				return attempt === void 0 ? void 0 : {
					invocation: attempt.invocation,
					auditCause: attempt.auditCause
				};
			},
			receipt: (id) => {
				const receipt = candidate.receipt !== void 0 && id.equals(candidate.receipt.id) ? candidate.receipt : this.persistence.receipt(transaction, id);
				if (receipt === void 0) return void 0;
				if (receipt instanceof PreEffectReceipt) return {
					invocation: receipt.invocation,
					outcome: receipt.outcome
				};
				if (!(receipt instanceof AttemptReceipt)) return void 0;
				const attempt = this.persistence.attempt(transaction, receipt.attempt);
				if (attempt === void 0) return void 0;
				const evidence = {
					invocation: attempt.invocation,
					attempt: receipt.attempt,
					outcome: receipt.outcome
				};
				return receipt.previous === void 0 ? evidence : {
					...evidence,
					previous: receipt.previous
				};
			},
			event: () => void 0,
			route: () => void 0,
			projection: () => void 0,
			delivery: () => void 0,
			commit: () => void 0,
			write: () => void 0
		};
	}
};
function isLegalApprovalTransition(current, next) {
	if (current.state.kind === "pending") return next.state.kind === "approved" || next.state.kind === "denied" || next.state.kind === "expired";
	return false;
}
function sameSchedulingIdentity(left, right) {
	return left.invocation.equals(right.invocation) && left.itemIndex === right.itemIndex && left.attemptOrdinal === right.attemptOrdinal;
}
function structuralEquals(codec, left, right) {
	return sameJson(codec.encode(left), codec.encode(right));
}
function sameOwner(lease, left, right) {
	if (!left.worker.equals(right.worker)) return false;
	return left.kind === "executor" ? right.kind === "executor" && structuralEquals(lease, left.token, right.token) : right.kind === "system" && left.actor.equals(right.actor);
}
function sameAudit(left, right) {
	const leftBytes = AuditRecord.encode(left);
	const rightBytes = AuditRecord.encode(right);
	return leftBytes.length === rightBytes.length && leftBytes.every((value, index) => value === rightBytes[index]);
}
function invalid$4(message) {
	return new AgentCoreError("invocation.invalid", message);
}
//#endregion
//#region src/invocations/memory.ts
function createInvocationMemoryState() {
	return {
		prepared: /* @__PURE__ */ new Map(),
		approvals: /* @__PURE__ */ new Map(),
		approvalByInvocation: /* @__PURE__ */ new Map(),
		continuations: /* @__PURE__ */ new Map(),
		claims: /* @__PURE__ */ new Map(),
		claimOrder: [],
		attempts: /* @__PURE__ */ new Map(),
		attemptByClaim: /* @__PURE__ */ new Map(),
		receipts: /* @__PURE__ */ new Map(),
		receiptOrder: []
	};
}
function cloneInvocationMemoryState(state) {
	return {
		prepared: cloneByteMap(state.prepared),
		approvals: cloneByteMap(state.approvals),
		approvalByInvocation: new Map(state.approvalByInvocation),
		continuations: cloneByteMap(state.continuations),
		claims: cloneByteMap(state.claims),
		claimOrder: [...state.claimOrder],
		attempts: cloneByteMap(state.attempts),
		attemptByClaim: new Map(state.attemptByClaim),
		receipts: cloneByteMap(state.receipts),
		receiptOrder: [...state.receiptOrder]
	};
}
var MemoryInvocationPersistence = class {
	codecs;
	custody;
	constructor(codecs, custody) {
		this.codecs = codecs;
		this.custody = custody;
	}
	prepared(transaction, id) {
		const record = decode(transaction.prepared.get(id.value), this.codecs.prepared);
		if (record !== void 0 && !record.header.id.equals(id)) corruptMemory();
		return record;
	}
	insertPrepared(transaction, record) {
		insert(transaction.prepared, record.header.id.value, this.codecs.prepared.encode(record));
	}
	/**
	* The reference target index: the memory store holds one map of prepared records, so the
	* index is derived by reading their headers rather than kept beside them (§8.4 rule 2).
	*/
	preparedForTarget(transaction, target) {
		return Object.freeze([...transaction.prepared.entries()].map(([id, bytes]) => {
			const record = this.codecs.prepared.decode(bytes.slice());
			if (record.header.id.value !== id) corruptMemory();
			return record.header;
		}).filter((header) => header.operation.target === target).map((header) => header.id).sort((left, right) => compareCanonicalText(left.value, right.value)));
	}
	approval(transaction, id) {
		return approvalEntries(transaction.approvals, this.codecs.approval, id).at(-1);
	}
	approvalForInvocation(transaction, invocation) {
		const id = transaction.approvalByInvocation.get(invocation.value);
		if (id === void 0) {
			for (const bytes of transaction.approvals.values()) if (this.codecs.approval.decode(bytes).invocation.equals(invocation)) corruptMemory();
			return;
		}
		const record = this.approval(transaction, new ApprovalId(id));
		if (record === void 0 || !record.invocation.equals(invocation)) corruptMemory();
		return record;
	}
	approvalRevision(transaction, id, revision) {
		const record = decode(transaction.approvals.get(approvalKey(id.value, revision)), this.codecs.approval);
		if (record !== void 0 && (!record.id.equals(id) || record.revision.value !== revision)) corruptMemory();
		return record;
	}
	appendApproval(transaction, record) {
		const currentId = transaction.approvalByInvocation.get(record.invocation.value);
		if (currentId !== void 0 && currentId !== record.id.value) throw invocationError("store.duplicate-record", "An Invocation cannot have multiple Approvals");
		insert(transaction.approvals, approvalKey(record.id.value, record.revision.value), this.codecs.approval.encode(record));
		transaction.approvalByInvocation.set(record.invocation.value, record.id.value);
	}
	continuation(transaction, invocation) {
		const record = decode(transaction.continuations.get(invocation.value), this.codecs.continuation);
		if (record !== void 0 && !record.invocation.equals(invocation)) corruptMemory();
		return record;
	}
	insertContinuation(transaction, record) {
		insert(transaction.continuations, record.invocation.value, this.codecs.continuation.encode(record));
	}
	claim(transaction, id) {
		const record = decode(transaction.claims.get(id.value), this.codecs.claim);
		if (record !== void 0 && !record.id.equals(id)) corruptMemory();
		return record;
	}
	claimsForItem(transaction, invocation, itemIndex) {
		requireOrder(transaction.claimOrder, transaction.claims, "claim");
		return transaction.claimOrder.map((id) => this.claim(transaction, new ItemClaimId(id))).filter((claim) => claim.invocation.equals(invocation) && claim.itemIndex === itemIndex);
	}
	appendClaim(transaction, record) {
		insert(transaction.claims, record.id.value, this.codecs.claim.encode(record));
		transaction.claimOrder.push(record.id.value);
	}
	attempt(transaction, id) {
		requireAttemptIndexes(transaction, this.codecs.attempt);
		const record = decode(transaction.attempts.get(id.value), this.codecs.attempt);
		if (record !== void 0 && !record.id.equals(id)) corruptMemory();
		return record;
	}
	attemptForClaim(transaction, claim) {
		const id = transaction.attemptByClaim.get(claim.value);
		if (id === void 0) {
			for (const bytes of transaction.attempts.values()) if (this.codecs.attempt.decode(bytes).claim.equals(claim)) corruptMemory();
			return;
		}
		const record = this.attempt(transaction, new EffectAttemptId(id));
		if (record === void 0 || !record.claim.equals(claim)) corruptMemory();
		return record;
	}
	attemptsForItem(transaction, invocation, itemIndex) {
		return [...transaction.attempts.keys()].map((id) => this.attempt(transaction, new EffectAttemptId(id))).filter((attempt) => attempt.invocation.equals(invocation) && attempt.itemIndex === itemIndex).sort((left, right) => left.ordinal - right.ordinal);
	}
	appendAttempt(transaction, record) {
		if (transaction.attemptByClaim.has(record.claim.value)) throw invocationError("store.duplicate-record", "An ItemClaim cannot admit multiple EffectAttempts");
		if (this.attemptsForItem(transaction, record.invocation, record.itemIndex).some((attempt) => attempt.ordinal === record.ordinal)) throw invocationError("store.duplicate-record", "An item ordinal cannot have multiple EffectAttempts");
		insert(transaction.attempts, record.id.value, this.codecs.attempt.encode(record));
		transaction.attemptByClaim.set(record.claim.value, record.id.value);
	}
	receipt(transaction, id) {
		requireOrder(transaction.receiptOrder, transaction.receipts, "receipt");
		const record = decode(transaction.receipts.get(id.value), this.codecs.receipt);
		if (record !== void 0 && !record.id.equals(id)) corruptMemory();
		return record;
	}
	receiptsForItem(transaction, invocation, itemIndex) {
		const attempts = this.attemptsForItem(transaction, invocation, itemIndex);
		const attemptIds = new Set(attempts.map((attempt) => attempt.id.value));
		return transaction.receiptOrder.map((id) => this.receipt(transaction, new ReceiptId(id))).filter((receipt) => receipt instanceof PreEffectReceipt ? receipt.invocation.equals(invocation) && receipt.itemIndex === itemIndex : receipt instanceof AttemptReceipt && attemptIds.has(receipt.attempt.value));
	}
	receiptsForAttempt(transaction, attempt) {
		return transaction.receiptOrder.map((id) => this.receipt(transaction, new ReceiptId(id))).filter((receipt) => receipt instanceof AttemptReceipt && receipt.attempt.equals(attempt));
	}
	/**
	* §8.4: the Receipt's own result bytes are retained in the transaction that appends it.
	* An audited Receipt is append-only, so this store never releases what it retained here.
	*/
	appendReceipt(transaction, record) {
		insert(transaction.receipts, record.id.value, this.codecs.receipt.encode(record));
		transaction.receiptOrder.push(record.id.value);
		this.custody.retain(transaction, {
			kind: this.codecs.receipt.kind,
			key: record.id.value,
			fields: receiptContentRetention(record)
		});
	}
};
function approvalKey(id, revision) {
	return JSON.stringify([
		"agent-core.invocation.approval-key.v1",
		id,
		revision
	]);
}
function approvalEntries(approvals, codec, id) {
	return [...approvals.entries()].map(([key, bytes]) => {
		const record = codec.decode(bytes);
		if (key !== approvalKey(record.id.value, record.revision.value)) corruptMemory();
		return record;
	}).filter((record) => record.id.equals(id)).sort((left, right) => left.revision.value - right.revision.value);
}
function insert(map, key, bytes) {
	if (map.has(key)) throw invocationError("store.duplicate-record", "Invocation records are append-only");
	map.set(key, bytes.slice());
}
function decode(bytes, codec) {
	return bytes === void 0 ? void 0 : codec.decode(bytes.slice());
}
function cloneByteMap(value) {
	return new Map([...value].map(([key, bytes]) => [key, bytes.slice()]));
}
function corruptMemory() {
	throw new AgentCoreError("codec.invalid", "Memory invocation index does not match codec bytes");
}
function requireOrder(order, records, subject) {
	if (order.length !== records.size || new Set(order).size !== order.length || order.some((id) => !records.has(id))) throw new AgentCoreError("codec.invalid", `Memory invocation ${subject} order is corrupt`);
}
function requireAttemptIndexes(transaction, codec) {
	if (transaction.attemptByClaim.size !== transaction.attempts.size) corruptMemory();
	for (const [id, bytes] of transaction.attempts) {
		const attempt = codec.decode(bytes);
		if (attempt.id.value !== id || transaction.attemptByClaim.get(attempt.claim.value) !== id) corruptMemory();
	}
}
//#endregion
//#region src/invocations/replay.ts
var REPLAY_ID_DOMAIN = "agent-core.mediated-replay.v1";
var MediatedReplayRecord = class MediatedReplayRecord {
	scope;
	requestKey;
	facet;
	operation;
	descriptorDigest;
	principal;
	authorityIdentity;
	packageOperationPin;
	execution;
	cardinality;
	invocation;
	revision;
	id;
	items;
	constructor(scope, requestKey, facet, operation, descriptorDigest, principal, authorityIdentity, packageOperationPin, execution, cardinality, items, invocation, revision) {
		this.scope = scope;
		this.requestKey = requestKey;
		this.facet = facet;
		this.operation = operation;
		this.descriptorDigest = descriptorDigest;
		this.principal = principal;
		this.authorityIdentity = authorityIdentity;
		this.packageOperationPin = packageOperationPin;
		this.execution = execution;
		this.cardinality = cardinality;
		this.invocation = invocation;
		this.revision = revision;
		requireCanonical(scope, "Replay scope");
		requireCanonical(requestKey, "Replay request key");
		requireCanonical(facet, "Replay Facet reference");
		requireCanonical(operation, "Replay operation");
		if (principal.constructor !== PrincipalRef) throw new TypeError("Replay Principal must use the exact PrincipalRef class");
		if (execution.kind !== "lease" && execution.kind !== "route") throw new TypeError("Replay execution identity kind is invalid");
		this.principal = new PrincipalRef(principal.tenantId, principal.principalId);
		const itemCount = cardinality.kind === "single" ? 1 : cardinality.itemCount;
		if (!Number.isSafeInteger(itemCount) || itemCount <= 0 || items.length !== itemCount) throw new TypeError("Replay items must exactly match the nonempty payload shape");
		this.items = Object.freeze(items.map((item, index) => copyItem(item, index)));
		validatePhases(this.items, invocation, revision.value);
		this.id = replayId({
			scope,
			requestKey,
			facet,
			operation,
			descriptorDigest,
			principal,
			authorityIdentity,
			packageOperationPin,
			execution,
			cardinality,
			rawPayloadIdentities: this.items.map((item) => item.rawPayloadIdentity)
		});
		Object.freeze(descriptorDigest);
		Object.freeze(authorityIdentity);
		Object.freeze(packageOperationPin);
		Object.freeze(execution.digest);
		Object.freeze(execution);
		Object.freeze(this.id);
		Object.freeze(this);
	}
	static reserve(reservation) {
		const itemCount = reservation.cardinality.kind === "single" ? 1 : reservation.cardinality.itemCount;
		if (reservation.rawPayloadIdentities.length !== itemCount) throw invalidTransition("Replay reservation payload identities do not match its shape");
		return new MediatedReplayRecord(reservation.scope, reservation.requestKey, reservation.facet, reservation.operation, reservation.descriptorDigest, reservation.principal, reservation.authorityIdentity, reservation.packageOperationPin, reservation.execution, reservation.cardinality, reservation.rawPayloadIdentities.map((rawPayloadIdentity, itemIndex) => ({
			itemIndex,
			rawPayloadIdentity
		})), void 0, Revision.initial());
	}
	static encode(record) {
		return MediatedReplayRecordCodec.encode(record);
	}
	static decode(bytes) {
		return MediatedReplayRecordCodec.decode(bytes);
	}
	prepare(invocation, argumentsByItem, tracesByItem) {
		if (this.invocation !== void 0 || argumentsByItem.length !== this.items.length || tracesByItem.length !== this.items.length) throw invalidTransition("Replay preparation must complete one reserved payload exactly once");
		return this.transition(this.items.map((item, index) => ({
			...item,
			preparedArguments: canonicalData$2(argumentsByItem[index]),
			before: copyTraces(tracesByItem[index], "operation.before")
		})), invocation);
	}
	recordEffect(itemIndex, output, receipt) {
		const item = this.requirePreparedItem(itemIndex);
		if (item.effectOutput !== void 0 || item.receipt !== void 0) throw invalidTransition("Replay effect output is immutable");
		return this.replaceItem(itemIndex, {
			...item,
			effectOutput: canonicalData$2(output),
			receipt
		});
	}
	recordTerminal(itemIndex, receipt) {
		const item = this.requirePreparedItem(itemIndex);
		if (item.effectOutput !== void 0 || item.receipt !== void 0) throw invalidTransition("Replay terminal result is immutable");
		return this.replaceItem(itemIndex, {
			...item,
			receipt
		});
	}
	present(itemIndex, traces, presentation) {
		const item = this.requirePreparedItem(itemIndex);
		if (item.effectOutput === void 0 || item.receipt === void 0 || item.after !== void 0 || item.presentation !== void 0) throw invalidTransition("Replay presentation requires one unpresented effect output");
		return this.replaceItem(itemIndex, {
			...item,
			after: copyTraces(traces, "operation.after"),
			presentation: canonicalData$2(presentation)
		});
	}
	get complete() {
		return this.items.every((item) => item.receipt !== void 0 && (item.effectOutput === void 0 || item.presentation !== void 0));
	}
	requirePreparedItem(itemIndex) {
		if (!Number.isSafeInteger(itemIndex) || itemIndex < 0) throw new TypeError("Replay item index must be a non-negative safe integer");
		const item = this.items[itemIndex];
		if (this.invocation === void 0 || item?.preparedArguments === void 0 || item.before === void 0) throw new TypeError("Replay item has not completed preparation");
		return item;
	}
	replaceItem(itemIndex, item) {
		const items = [...this.items];
		items[itemIndex] = item;
		return this.transition(items, this.invocation);
	}
	transition(items, invocation) {
		return new MediatedReplayRecord(this.scope, this.requestKey, this.facet, this.operation, this.descriptorDigest, this.principal, this.authorityIdentity, this.packageOperationPin, this.execution, this.cardinality, items, invocation, this.revision.next());
	}
};
var MediatedReplayRecordCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			MediatedReplayRecord,
			Revision,
			TextId,
			Digest,
			TenantId,
			PrincipalId,
			InvocationId,
			PrincipalRef,
			ReceiptId
		], "invocation.mediated-replay", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(record) {
		return {
			authorityIdentity: record.authorityIdentity.value,
			descriptorDigest: record.descriptorDigest.value,
			execution: {
				digest: record.execution.digest.value,
				kind: record.execution.kind
			},
			facet: record.facet,
			id: record.id.value,
			invocation: record.invocation?.value ?? null,
			items: record.items.map(encodeItem$1),
			operation: record.operation,
			packageOperationPin: record.packageOperationPin.value,
			principal: {
				principal: record.principal.principalId.value,
				tenant: record.principal.tenantId.value
			},
			requestKey: record.requestKey,
			revision: record.revision.value,
			scope: record.scope,
			["shape"]: record.cardinality
		};
	}
	decodePayload(payload, _version) {
		const object = requireExactObject(payload, [
			"descriptorDigest",
			"authorityIdentity",
			"execution",
			"facet",
			"id",
			"invocation",
			"items",
			"operation",
			"packageOperationPin",
			"principal",
			"requestKey",
			"revision",
			"scope",
			"shape"
		], "Mediated replay");
		const invocation = requireNullableString(object, "invocation", "Replay invocation");
		const record = new MediatedReplayRecord(requireString(object, "scope"), requireString(object, "requestKey"), requireString(object, "facet"), requireString(object, "operation"), requireDigest(object, "descriptorDigest"), decodePrincipal(object["principal"]), requireDigest(object, "authorityIdentity"), requireDigest(object, "packageOperationPin"), decodeExecution(object["execution"]), decodeCardinality(object["shape"]), requireArray(object, "items").map(decodeItem$1), invocation === void 0 ? void 0 : new InvocationId(invocation), new Revision(requireNonnegativeInteger(object, "revision")));
		if (record.id.value !== requireString(object, "id")) throw new TypeError("Replay ID does not match its canonical reservation identity");
		return record;
	}
};
function replayId(reservation) {
	return Digest.sha256(encodeCanonicalJson({
		domain: REPLAY_ID_DOMAIN,
		authorityIdentity: reservation.authorityIdentity.value,
		descriptorDigest: reservation.descriptorDigest.value,
		execution: {
			digest: reservation.execution.digest.value,
			kind: reservation.execution.kind
		},
		facet: reservation.facet,
		operation: reservation.operation,
		packageOperationPin: reservation.packageOperationPin.value,
		principal: {
			principal: reservation.principal.principalId.value,
			tenant: reservation.principal.tenantId.value
		},
		rawPayloadIdentities: reservation.rawPayloadIdentities.map((digest) => digest.value),
		requestKey: reservation.requestKey,
		scope: reservation.scope,
		["shape"]: reservation.cardinality
	}));
}
function decodePrincipal(value) {
	const object = requireExactObject(value, ["principal", "tenant"], "Replay Principal");
	return new PrincipalRef(new TenantId(requireString(object, "tenant")), new PrincipalId(requireString(object, "principal")));
}
function decodeExecution(value) {
	const object = requireExactObject(value, ["digest", "kind"], "Replay execution identity");
	const kind = requireString(object, "kind");
	if (kind !== "lease" && kind !== "route") throw new TypeError("Replay execution identity kind is invalid");
	return Object.freeze({
		kind,
		digest: requireDigest(object, "digest")
	});
}
function copyItem(item, expectedIndex) {
	if (item.itemIndex !== expectedIndex) throw new TypeError("Replay item index must equal its position");
	const copied = {
		itemIndex: item.itemIndex,
		rawPayloadIdentity: new Digest(item.rawPayloadIdentity.value)
	};
	if (item.preparedArguments !== void 0) copied.preparedArguments = canonicalData$2(item.preparedArguments);
	if (item.before !== void 0) copied.before = copyTraces(item.before, "operation.before");
	if (item.effectOutput !== void 0) copied.effectOutput = canonicalData$2(item.effectOutput);
	if (item.receipt !== void 0) copied.receipt = item.receipt;
	if (item.after !== void 0) copied.after = copyTraces(item.after, "operation.after");
	if (item.presentation !== void 0) copied.presentation = canonicalData$2(item.presentation);
	return Object.freeze(copied);
}
function validatePhases(items, invocation, revision) {
	const prepared = items.every((item) => item.preparedArguments !== void 0 && item.before !== void 0);
	if (invocation !== void 0 !== prepared || invocation === void 0 && revision !== 0) throw new TypeError("Replay preparation phase is inconsistent");
	for (const item of items) if (item.effectOutput !== void 0 && item.receipt === void 0 || item.after === void 0 !== (item.presentation === void 0) || item.presentation !== void 0 && item.effectOutput === void 0) throw new TypeError("Replay item phases are inconsistent");
}
function copyTraces(traces, cutPoint) {
	return Object.freeze(traces.map((trace) => {
		if (trace.cutPoint !== cutPoint) throw new TypeError("Replay trace has the wrong cut point");
		return Object.freeze({
			interceptor: trace.interceptor,
			contributor: trace.contributor,
			cutPoint,
			before: new Digest(trace.before.value),
			after: new Digest(trace.after.value),
			outcome: trace.outcome
		});
	}));
}
function encodeItem$1(item) {
	return {
		after: item.after?.map(encodeTrace) ?? null,
		before: item.before?.map(encodeTrace) ?? null,
		effectOutput: item.effectOutput ?? null,
		itemIndex: item.itemIndex,
		phase: item.presentation !== void 0 ? "presented" : item.effectOutput !== void 0 ? "effect" : item.receipt !== void 0 ? "terminal" : item.preparedArguments !== void 0 ? "prepared" : "reserved",
		preparedArguments: item.preparedArguments ?? null,
		presentation: item.presentation ?? null,
		rawPayloadIdentity: item.rawPayloadIdentity.value,
		receipt: item.receipt?.value ?? null
	};
}
function decodeItem$1(value) {
	const object = requireExactObject(value, [
		"after",
		"before",
		"effectOutput",
		"itemIndex",
		"phase",
		"preparedArguments",
		"presentation",
		"rawPayloadIdentity",
		"receipt"
	], "Replay item");
	const receipt = requireReplayReceipt(object);
	const phase = requireString(object, "phase");
	if (phase !== "reserved" && phase !== "prepared" && phase !== "effect" && phase !== "terminal" && phase !== "presented") throw new TypeError("Replay item phase is invalid");
	const item = {
		itemIndex: requireNonnegativeInteger(object, "itemIndex"),
		rawPayloadIdentity: requireDigest(object, "rawPayloadIdentity")
	};
	if (phase !== "reserved") {
		item.preparedArguments = object["preparedArguments"];
		item.before = requireArray(object, "before").map(decodeTrace);
	}
	if (phase === "effect" || phase === "presented" || phase === "terminal") {
		if (receipt === void 0) throw new TypeError("Replay Receipt is malformed");
		item.receipt = new ReceiptId(receipt);
	}
	if (phase === "effect" || phase === "presented") item.effectOutput = object["effectOutput"];
	if (phase === "presented") {
		item.after = requireArray(object, "after").map(decodeTrace);
		item.presentation = object["presentation"];
	}
	return item;
}
function encodeTrace(trace) {
	return {
		after: trace.after.value,
		before: trace.before.value,
		contributor: trace.contributor,
		cutPoint: trace.cutPoint,
		interceptor: trace.interceptor,
		outcome: trace.outcome
	};
}
function decodeTrace(value) {
	const object = requireExactObject(value, [
		"after",
		"before",
		"contributor",
		"cutPoint",
		"interceptor",
		"outcome"
	], "Replay interceptor trace");
	const cutPoint = requireString(object, "cutPoint");
	const outcome = requireString(object, "outcome");
	if (cutPoint !== "operation.before" && cutPoint !== "operation.after" || outcome !== "unchanged" && outcome !== "rewritten") throw new TypeError("Replay interceptor trace is invalid");
	return {
		interceptor: requireString(object, "interceptor"),
		contributor: requireString(object, "contributor"),
		cutPoint,
		before: requireDigest(object, "before"),
		after: requireDigest(object, "after"),
		outcome
	};
}
function decodeCardinality(value) {
	if (requireObject(value, "Replay shape")["kind"] === "single") {
		requireExactObject(value, ["kind"], "Single replay shape");
		return Object.freeze({ kind: "single" });
	}
	const object = requireExactObject(value, ["itemCount", "kind"], "Batch replay shape");
	if (requireString(object, "kind") !== "batch") throw new TypeError("Replay shape is invalid");
	return Object.freeze({
		kind: "batch",
		itemCount: requireNonnegativeInteger(object, "itemCount")
	});
}
function requireReplayReceipt(object) {
	try {
		return requireNullableString(object, "receipt", "Replay Receipt");
	} catch {
		throw new TypeError("Replay Receipt is malformed");
	}
}
function requireCanonical(value, subject) {
	if (value.trim().length === 0 || value !== value.trim()) throw new TypeError(`${subject} must be canonical`);
}
function canonicalData$2(value) {
	return canonicalFacetData(value);
}
function invalidTransition(message) {
	return invocationError("state.invalid-transition", message);
}
var MediatedReplayRecordCodec = new MediatedReplayRecordCodecV1();
//#endregion
//#region src/invocations/mediation-memory.ts
function createInvocationMediationMemoryState() {
	return {
		replays: /* @__PURE__ */ new Map(),
		replayRevision: /* @__PURE__ */ new Map(),
		replayByRequest: /* @__PURE__ */ new Map(),
		audits: /* @__PURE__ */ new Map(),
		auditByEvidence: /* @__PURE__ */ new Map(),
		publications: /* @__PURE__ */ new Map()
	};
}
function cloneInvocationMediationMemoryState(state) {
	return {
		replays: cloneBytes(state.replays),
		replayRevision: new Map(state.replayRevision),
		replayByRequest: new Map(state.replayByRequest),
		audits: cloneBytes(state.audits),
		auditByEvidence: new Map(state.auditByEvidence),
		publications: cloneBytes(state.publications)
	};
}
var MemoryInvocationMediationPersistence = class {
	replay(transaction, scope, requestKey) {
		const id = transaction.replayByRequest.get(requestIdentity(scope, requestKey));
		return id === void 0 ? void 0 : this.replayById(transaction, new Digest(id));
	}
	replayById(transaction, id) {
		const revision = transaction.replayRevision.get(id.value);
		if (revision === void 0) return void 0;
		const bytes = transaction.replays.get(revisionKey(id.value, revision));
		if (bytes === void 0) corrupt("Replay revision index is corrupt");
		const record = MediatedReplayRecord.decode(bytes.slice());
		if (!record.id.equals(id) || record.revision.value !== revision) corrupt("Replay projection does not match codec bytes");
		return record;
	}
	appendReplay(transaction, record) {
		const request = requestIdentity(record.scope, record.requestKey);
		const currentId = transaction.replayByRequest.get(request);
		const currentRevision = transaction.replayRevision.get(record.id.value);
		if (record.revision.value === 0) {
			if (currentId !== void 0 || currentRevision !== void 0) duplicate("Replay reservation exists");
			transaction.replayByRequest.set(request, record.id.value);
		} else if (currentId !== record.id.value || currentRevision !== record.revision.value - 1) duplicate("Replay revision is not the next reserved transition");
		const key = revisionKey(record.id.value, record.revision.value);
		if (transaction.replays.has(key)) duplicate("Replay revision exists");
		transaction.replays.set(key, MediatedReplayRecord.encode(record));
		transaction.replayRevision.set(record.id.value, record.revision.value);
	}
	appendAudit(transaction, record, context) {
		if (transaction.audits.has(record.id.value)) duplicate("Audit record exists");
		validateAuditAppend(record, { get: (id) => this.audit(transaction, id) }, context?.rootAdmission, context?.evidence);
		const evidenceIdentity = auditEvidenceIdentity(record.actor, record.kind).value;
		if (this.findAuditByEvidence(transaction, record.actor, record.kind) !== void 0) duplicate("Audit evidence relation exists");
		transaction.audits.set(record.id.value, AuditRecord.encode(record));
		transaction.auditByEvidence.set(evidenceIdentity, record.id.value);
	}
	audit(transaction, id) {
		const bytes = transaction.audits.get(id.value);
		if (bytes === void 0) return void 0;
		const record = AuditRecord.decode(bytes.slice());
		if (!record.id.equals(id)) corrupt("Audit projection does not match codec bytes");
		return record;
	}
	findAuditByEvidence(transaction, actor, kind) {
		const identity = auditEvidenceIdentity(actor, kind);
		const id = transaction.auditByEvidence.get(identity.value);
		if (id === void 0) {
			for (const [storedId, bytes] of transaction.audits) {
				const record = AuditRecord.decode(bytes.slice());
				if (record.id.value !== storedId) corrupt("Audit projection does not match codec bytes");
				if (auditEvidenceIdentity(record.actor, record.kind).equals(identity)) corrupt("Audit record has a missing evidence projection");
			}
			return;
		}
		const bytes = transaction.audits.get(id);
		if (bytes === void 0) corrupt("Audit evidence projection points to a missing record");
		const record = AuditRecord.decode(bytes.slice());
		if (record.id.value !== id || !auditEvidenceIdentity(record.actor, record.kind).equals(identity)) corrupt("Audit evidence projection does not match codec bytes");
		return record;
	}
	publication(transaction, id) {
		const bytes = transaction.publications.get(id.value);
		if (bytes === void 0) return void 0;
		const record = InvocationPublicationOutbox.decode(bytes.slice());
		if (!record.id.equals(id)) corrupt("Publication projection does not match codec bytes");
		return record;
	}
	pendingPublications(transaction) {
		return Object.freeze([...transaction.publications.values()].map((bytes) => InvocationPublicationOutbox.decode(bytes.slice())).filter((record) => record.state.kind === "pending").sort((left, right) => compareCanonicalText(left.id.value, right.id.value)));
	}
	appendPublication(transaction, record) {
		const current = this.publication(transaction, record.id);
		if (current === void 0 && record.revision.value !== 0 || current !== void 0 && !record.follows(current)) duplicate("Publication revision is not the next transition");
		transaction.publications.set(record.id.value, InvocationPublicationOutbox.encode(record));
	}
};
var requestIdentityDecoder = new TextDecoder("utf-8", { fatal: true });
function requestIdentity(scope, requestKey) {
	return requestIdentityDecoder.decode(encodeCanonicalJson([scope, requestKey]));
}
function revisionKey(id, revision) {
	return `${id}\u0000${revision}`;
}
function cloneBytes(values) {
	return new Map([...values].map(([key, bytes]) => [key, bytes.slice()]));
}
function duplicate(message) {
	throw new AgentCoreError("invocation.invalid", message);
}
function corrupt(message) {
	throw new AgentCoreError("codec.invalid", message);
}
//#endregion
//#region src/invocations/canonical-batch.ts
/**
* The host's own bound closing on an attempt. It is module-private so the invoked handler
* cannot construct one: §7.4 lets the callee originate `raised` and nothing else, and a
* marker a callee could throw would hand it `deadline`.
*/
var AttemptBoundElapsed = class {
	bound;
	constructor(bound) {
		this.bound = bound;
		Object.freeze(this);
	}
};
var CanonicalBatchInvocationPort = class {
	transactions;
	persistence;
	detachedExecutions;
	ledger;
	preparation;
	permits;
	authentication;
	records;
	finalAdmission;
	evidence;
	resources;
	now;
	#activeItems = /* @__PURE__ */ new Map();
	constructor(transactions, persistence, detachedExecutions, ledger, preparation, permits, authentication, records, finalAdmission, evidence, resources, now) {
		this.transactions = transactions;
		this.persistence = persistence;
		this.detachedExecutions = detachedExecutions;
		this.ledger = ledger;
		this.preparation = preparation;
		this.permits = permits;
		this.authentication = authentication;
		this.records = records;
		this.finalAdmission = finalAdmission;
		this.evidence = evidence;
		this.resources = resources;
		this.now = now;
	}
	async invoke(request) {
		const prepared = this.prepare(request);
		const items = [];
		for (let itemIndex = 0; itemIndex < prepared.itemCount; itemIndex += 1) items.push(await this.invokeItem(request, prepared, itemIndex));
		return Object.freeze({
			invocation: request.invocation,
			items: Object.freeze(items)
		});
	}
	/**
	* Admits one item's effect and records that its execution has left the issuing Turn, in one
	* transaction (§5.6, C13-TURN-HANDLE-DETACHMENT).
	*
	* The EffectAttempt and the detachment record commit together because either alone is a
	* lie: an attempt with no detachment record is an item nothing will ever execute after a
	* restart, and a detachment record with no attempt names work that was never admitted.
	* Nothing runs here, so the caller can publish an admission identity over an item that has
	* an attempt and no Receipt — which is the fact §5.6's handle needs and the one a truthful
	* settlement view cannot obtain from a Receipt.
	*/
	async admitDetachedItem(request, itemIndex) {
		const prepared = this.prepare(request);
		prepared.item(itemIndex);
		return this.admitItem(request, prepared, itemIndex, true);
	}
	/**
	* Runs one admitted item against the live resources it was given, and records its Receipt.
	*
	* It re-reads its own state first and takes the item as durable facts rather than as a
	* closure, so the same step serves the Turn that admitted the item and a driver that
	* rebuilt it from records after a restart. A Receipt that already exists replays instead of
	* running the effect again (§7.3's idempotency), which is what makes a duplicated delivery
	* a no-op rather than a second external effect.
	*/
	async executeAdmittedItem(item, execution) {
		return this.once(item.invocation, item.itemIndex, async () => {
			const admitted = this.transactions.transact((transaction) => this.admittedItemState(transaction, item));
			if (admitted.receipt !== void 0) return this.resultForReceipt(item.itemIndex, admitted.receipt, () => execution.resources.content);
			return this.executeAttempt(item.itemIndex, admitted.prepared, admitted.attempt, execution);
		});
	}
	/** Records the PreparedInvocation once, or requires the stored one to be the same intent. */
	prepare(request) {
		requireRequestCardinality(request.request);
		const prepared = this.preparation.prepare(request);
		requirePreparedRequest(prepared, request);
		this.transactions.transact((transaction) => {
			const existing = this.persistence.prepared(transaction, request.invocation);
			if (existing === void 0) this.ledger.prepareWithAudit(transaction, prepared, this.records.invocationAudit(prepared), this.evidence);
			else if (!existing.intentDigest.equals(prepared.intentDigest)) throw invalid$3("Prepared Invocation changed under its canonical identity");
			else this.ledger.requirePreparedAudit(transaction, prepared, this.records.invocationAudit(prepared), this.evidence);
		});
		return prepared;
	}
	async invokeItem(request, prepared, itemIndex) {
		return this.once(prepared.header.id, itemIndex, () => this.invokeItemOnce(request, prepared, itemIndex));
	}
	/**
	* Runs one item's work at most once per process at a time. Two callers naming the same item
	* share the first one's promise, so a redelivery that arrives while the item is running
	* joins the run in flight instead of starting a second effect.
	*/
	async once(invocation, itemIndex, work) {
		let invocationItems = this.#activeItems.get(invocation.value);
		if (invocationItems === void 0) {
			invocationItems = /* @__PURE__ */ new Map();
			this.#activeItems.set(invocation.value, invocationItems);
		}
		const existing = invocationItems.get(itemIndex);
		if (existing !== void 0) return existing;
		const started = work();
		invocationItems.set(itemIndex, started);
		try {
			return await started;
		} finally {
			if (invocationItems.get(itemIndex) === started) {
				invocationItems.delete(itemIndex);
				if (invocationItems.size === 0) this.#activeItems.delete(invocation.value);
			}
		}
	}
	async invokeItemOnce(request, prepared, itemIndex) {
		const admission = await this.admitItem(request, prepared, itemIndex, false);
		if (admission.kind === "terminal") return this.resultForReceipt(itemIndex, admission.receipt, () => this.resources.resources(request, itemIndex).content);
		return this.executeAttempt(itemIndex, prepared, admission.attempt, {
			descriptor: request.request.descriptor,
			execute: (item, context) => request.request.execute(item, context),
			resources: this.resources.resources(request, itemIndex),
			targetAdmission: admission.targetAdmission
		});
	}
	/**
	* Everything up to and including the durable EffectAttempt append: claim, authority permit,
	* permit authentication, and the target's own final admission. `detached` decides only
	* whether the same transaction also records that the item's execution left the Turn.
	*/
	async admitItem(request, prepared, itemIndex, detached) {
		const state = this.claim(prepared, itemIndex);
		if (state.kind === "receipt") return terminal$1(itemIndex, state.receipt);
		if (state.kind === "attempt") {
			const readmitted = detached ? this.readmitDetached(prepared, state.attempt) : void 0;
			if (readmitted !== void 0) return readmitted;
			return terminal$1(itemIndex, this.finish(prepared, state.attempt, AttemptCompletion.indeterminate, void 0));
		}
		const permitResult = await this.permits.issue(prepared, state.claim);
		if (permitResult.kind === "expired") return this.admitItem(request, prepared, itemIndex, detached);
		if (permitResult.kind === "invalid") return terminal$1(itemIndex, this.denyClaim(prepared, state.claim, permitResult.reason));
		if (permitResult.kind === "denied") return terminal$1(itemIndex, this.denyClaim(prepared, state.claim, permitResult.reason, permitResult.denial));
		const { admission } = permitResult;
		let authentication;
		try {
			authentication = await this.authentication.authenticate(prepared, state.claim, admission);
		} catch (error) {
			if (!(error instanceof AgentCoreError) || error.code !== "authority.denied") throw error;
			return terminal$1(itemIndex, this.denyClaim(prepared, state.claim, error.message || "Authority permit authentication denied"));
		}
		const admittedAt = this.now();
		const admissionResult = this.transactions.transact((transaction) => {
			const currentClaim = this.persistence.claimsForItem(transaction, prepared.header.id, itemIndex).at(-1);
			if (currentClaim === void 0 || !currentClaim.id.equals(state.claim.id)) return { kind: "retry" };
			const receipt = this.ledger.currentReceipt(transaction, prepared.header.id, itemIndex);
			if (receipt !== void 0) {
				const failedAttempt = receipt instanceof AttemptReceipt && receipt.outcome === "failed" ? this.persistence.attempt(transaction, receipt.attempt) : void 0;
				if (failedAttempt === void 0 || failedAttempt.ordinal + 1 !== state.claim.attemptOrdinal) return {
					kind: "receipt",
					receipt
				};
			}
			const winner = this.persistence.attemptsForItem(transaction, prepared.header.id, itemIndex).at(-1);
			if (winner !== void 0 && winner.ordinal >= state.claim.attemptOrdinal) return {
				kind: "attempt",
				attempt: winner
			};
			const final = this.finalAdmission.admit(transaction, request, {
				invocation: prepared,
				claim: state.claim,
				authorityAdmission: admission,
				admittedAt
			});
			if (final.kind === "denied" || final.kind === "cancelled") {
				const outcome = final.kind === "cancelled" ? "cancelledPreEffect" : "deniedPreEffect";
				const receipt = this.records.preEffectReceipt(prepared, state.claim, outcome, admittedAt, final.reason);
				const audit = this.records.receiptAudit(prepared, void 0, receipt);
				const outbox = publication(prepared.header.id, receipt, audit);
				if (final.kind === "cancelled") this.ledger.recordClaimedCancellationWithAudit(transaction, state.claim, receipt, audit, outbox, this.evidence);
				else this.ledger.recordClaimedAuthorityDenialWithAudit(transaction, state.claim, receipt, audit, outbox, this.evidence);
				return {
					kind: "refused",
					receipt
				};
			}
			if (final.kind !== "admitted") throw invalid$3("Final admission result kind is invalid");
			const attempt = this.records.attempt(prepared, state.claim, admission, admittedAt);
			const attemptAudit = this.records.attemptAudit(prepared, attempt);
			const denialReceipt = this.records.preEffectReceipt(prepared, state.claim, "deniedPreEffect", admittedAt, "Authority permit is invalid at target admission");
			const denialAudit = this.records.receiptAudit(prepared, void 0, denialReceipt);
			if (!this.ledger.admitAttemptOrRecordAuthorityDenialWithAudit(transaction, attempt, admittedAt, attemptAudit, {
				claim: state.claim,
				receipt: denialReceipt,
				audit: denialAudit,
				publication: publication(prepared.header.id, denialReceipt, denialAudit)
			}, this.evidence, authentication)) return {
				kind: "refused",
				receipt: denialReceipt
			};
			const item = AdmittedInvocationItem.derive(prepared, attempt);
			if (detached) this.detachedExecutions.appendDetachedExecution(transaction, DetachedEffectExecution.awaiting(item));
			return {
				kind: "admitted",
				attempt,
				item,
				evidence: final.evidence
			};
		});
		if (admissionResult.kind === "refused") return terminal$1(itemIndex, admissionResult.receipt);
		if (admissionResult.kind === "receipt") return terminal$1(itemIndex, admissionResult.receipt);
		if (admissionResult.kind === "attempt") throw invalid$3("A concurrent EffectAttempt won target admission");
		if (admissionResult.kind === "retry") return this.admitItem(request, prepared, itemIndex, detached);
		return Object.freeze({
			kind: "admitted",
			item: admissionResult.item,
			attempt: admissionResult.attempt,
			targetAdmission: admissionResult.evidence
		});
	}
	/**
	* The already-admitted answer for a detached replay: an attempt this host detached earlier
	* and never receipted is the same admitted item, so re-admission returns it instead of
	* declaring the outcome unknown. Without a detachment record the attempt belongs to the
	* in-Turn path, and only that path's own rule applies.
	*/
	readmitDetached(prepared, attempt) {
		if (this.transactions.transact((transaction) => this.detachedExecutions.detachedExecution(transaction, attempt.id)) === void 0) return void 0;
		return Object.freeze({
			kind: "admitted",
			item: AdmittedInvocationItem.derive(prepared, attempt),
			attempt,
			targetAdmission: void 0
		});
	}
	/** The stored PreparedInvocation, EffectAttempt, and current Receipt one item names. */
	admittedItemState(transaction, item) {
		const prepared = this.persistence.prepared(transaction, item.invocation);
		if (prepared === void 0) throw invalid$3("Admitted item names no stored PreparedInvocation");
		const attempt = this.persistence.attempt(transaction, item.attempt);
		if (attempt === void 0 || !AdmittedInvocationItem.derive(prepared, attempt).equals(item)) throw invalid$3("Admitted item does not name the exact stored EffectAttempt");
		const receipt = this.ledger.currentReceipt(transaction, item.invocation, item.itemIndex);
		const receipted = this.persistence.receiptsForAttempt(transaction, item.attempt).length !== 0;
		if (receipt === void 0 && receipted) throw invalid$3("Admitted item has a Receipt its item does not carry");
		return {
			prepared,
			attempt,
			receipt
		};
	}
	async executeAttempt(itemIndex, prepared, attempt, execution) {
		const resources = execution.resources;
		const context = Object.freeze({
			invocation: prepared.header.id,
			itemIndex,
			idempotencyKey: prepared.item(itemIndex).idempotencyKey,
			attempt: Object.freeze({
				id: attempt.id,
				ordinal: attempt.ordinal,
				intentDigest: prepared.intentDigest
			}),
			targetAdmission: execution.targetAdmission,
			signal: resources.signal,
			content: resources.content
		});
		let output;
		try {
			output = canonicalData$1(await withinBound(execution.execute(itemIndex, context), resources.deadline, this.now));
		} catch (error) {
			const confirmed = error instanceof ConfirmedOperationFailure ? error : void 0;
			const failure = AttemptFailureKind.classify({
				confirmed: confirmed !== void 0,
				elapsedBound: error instanceof AttemptBoundElapsed ? error.bound : void 0,
				cancellation: resources.signal,
				target: resources.target,
				observedAt: this.now()
			});
			return terminal$1(itemIndex, this.finish(prepared, attempt, failure === void 0 ? AttemptCompletion.indeterminate : AttemptCompletion.failed(failure), confirmed?.evidence));
		}
		const declared = execution.descriptor.output;
		if (!declared.accepts(output)) return terminal$1(itemIndex, this.finish(prepared, attempt, AttemptCompletion.failed(AttemptFailureKind.outputInvalid(declared, output)), void 0));
		let result;
		try {
			result = (await resources.content.put(encodeCanonicalJson(output))).ref;
		} catch {
			return terminal$1(itemIndex, this.finish(prepared, attempt, AttemptCompletion.indeterminate, void 0));
		}
		const receipt = this.finish(prepared, attempt, AttemptCompletion.succeeded, result);
		return Object.freeze({
			kind: "succeeded",
			itemIndex,
			receipt,
			output
		});
	}
	claim(prepared, itemIndex) {
		const at = this.now();
		return this.transactions.transact((transaction) => {
			const receipt = this.ledger.currentReceipt(transaction, prepared.header.id, itemIndex);
			const attempt = this.persistence.attemptsForItem(transaction, prepared.header.id, itemIndex).at(-1);
			const current = this.persistence.claimsForItem(transaction, prepared.header.id, itemIndex).at(-1);
			if (receipt !== void 0) {
				if (!(receipt instanceof AttemptReceipt) || receipt.outcome !== "failed" || attempt === void 0 || !receipt.attempt.equals(attempt.id)) return {
					kind: "receipt",
					receipt
				};
				if (current !== void 0 && this.persistence.attemptForClaim(transaction, current.id) === void 0) {
					if (current.attemptOrdinal !== attempt.ordinal + 1) throw invalid$3("Failed Receipt has an inconsistent live retry claim");
					if (current.expiresAt.getTime() > at.getTime()) return {
						kind: "claim",
						claim: current
					};
					const replacement = this.records.claim(prepared, itemIndex, current, at);
					this.ledger.recoverClaim(transaction, current.id, replacement, at);
					return {
						kind: "claim",
						claim: replacement
					};
				}
				const retry = this.records.retryClaim(prepared, attempt, at);
				this.ledger.claimItem(transaction, retry, at);
				return {
					kind: "claim",
					claim: retry
				};
			}
			if (current !== void 0 && this.persistence.attemptForClaim(transaction, current.id) === void 0) {
				if (current.expiresAt.getTime() > at.getTime()) return {
					kind: "claim",
					claim: current
				};
				const replacement = this.records.claim(prepared, itemIndex, current, at);
				this.ledger.recoverClaim(transaction, current.id, replacement, at);
				return {
					kind: "claim",
					claim: replacement
				};
			}
			if (attempt !== void 0) return {
				kind: "attempt",
				attempt
			};
			const claim = this.records.claim(prepared, itemIndex, void 0, at);
			this.ledger.claimItem(transaction, claim, at);
			return {
				kind: "claim",
				claim
			};
		});
	}
	denyClaim(prepared, claim, reason, denial) {
		const recordedAt = this.now();
		const receipt = this.records.preEffectReceipt(prepared, claim, "deniedPreEffect", recordedAt, reason);
		const audit = this.records.receiptAudit(prepared, void 0, receipt);
		return this.transactions.transact((transaction) => {
			const current = this.ledger.currentReceipt(transaction, prepared.header.id, claim.itemIndex);
			if (current !== void 0) {
				if (current instanceof PreEffectReceipt) return current;
				throw invalid$3("Authority denial raced an attempted item Receipt");
			}
			const currentClaim = this.persistence.claimsForItem(transaction, prepared.header.id, claim.itemIndex).at(-1);
			if (currentClaim === void 0 || !currentClaim.id.equals(claim.id) || this.persistence.attemptForClaim(transaction, claim.id) !== void 0) throw invalid$3("Authority denial does not bind the exact current claim");
			if (denial !== void 0) this.permits.deny(transaction, prepared, claim, denial);
			this.ledger.recordClaimedAuthorityDenialWithAudit(transaction, claim, receipt, audit, publication(prepared.header.id, receipt, audit), this.evidence);
			return receipt;
		});
	}
	finish(prepared, attempt, completion, result) {
		const receipt = this.records.attemptReceipt(attempt, completion, this.now(), result);
		const attemptAudit = this.records.attemptAudit(prepared, attempt);
		const audit = this.records.receiptAudit(prepared, attemptAudit, receipt);
		this.transactions.transact((transaction) => {
			this.ledger.recordAttemptReceiptWithAudit(transaction, receipt, attemptAudit, audit, publication(prepared.header.id, receipt, audit), this.evidence);
		});
		return receipt;
	}
	/**
	* The result a stored Receipt already decides. The ContentStore arrives as a closure
	* because only a succeeded Receipt reads content: an in-Turn replay must not build attempt
	* resources for an item whose Receipt needs none, and a detached replay reads through the
	* store its target handed it.
	*/
	async resultForReceipt(itemIndex, receipt, content) {
		if (!(receipt instanceof AttemptReceipt) || receipt.outcome !== "succeeded") return terminal$1(itemIndex, receipt);
		if (receipt.result === void 0) throw invalid$3("Successful Operation Receipt has no canonical result content");
		const store = content();
		return Object.freeze({
			kind: "succeeded",
			itemIndex,
			receipt,
			output: canonicalFacetData(decodeCanonicalJson(await store.get(receipt.result)))
		});
	}
};
function requireRequestCardinality(request) {
	const expected = request.cardinality.kind === "single" ? 1 : request.cardinality.itemCount;
	if (!Number.isSafeInteger(expected) || expected <= 0 || request.inputs.length !== expected || request.interceptions.length !== expected) throw invalid$3("Canonical batch request must be a nonempty exact payload shape");
}
function requirePreparedRequest(prepared, request) {
	const expectedKind = request.request.cardinality.kind;
	if (!prepared.header.id.equals(request.invocation) || prepared.payload.kind !== expectedKind || prepared.itemCount !== request.request.inputs.length || prepared.header.operation.target !== request.request.facet.value || prepared.header.operation.impact !== request.request.descriptor.impact || !prepared.header.operation.descriptorDigest.equals(Digest.sha256(encodeCanonicalJson(request.request.descriptor.toData()))) || request.request.inputs.some((input, itemIndex) => !sameJson(input, prepared.item(itemIndex).arguments))) throw invalid$3("Prepared Invocation does not bind the exact canonical batch request");
}
function publication(invocation, receipt, audit) {
	return InvocationPublicationOutbox.pending(Object.freeze({
		invocation,
		receipt: receipt.id,
		audit: audit.id
	}));
}
/**
* The one terminal shape both the item result and the item admission carry, so an admission
* that ended before any effect and a result that ended the same way are the same value.
*/
function terminal$1(itemIndex, receipt) {
	return Object.freeze({
		kind: "terminal",
		itemIndex,
		receipt
	});
}
/**
* Awaits the handler under the host's own bound on this attempt, if the host set one.
*
* The bound is raced separately from the owning Turn or Run's cancellation on purpose. A
* single combined signal would tell the host that *something* closed and never which,
* collapsing §7.4's `deadline` and `aborted` into one indistinguishable fact. Racing the two
* separately is what lets the host name the boundary it actually observed.
*/
function withinBound(work, bound, now) {
	if (bound === void 0) return work;
	const elapsed = new Promise((_resolve, reject) => {
		const remaining = Math.max(0, bound.getTime() - now().getTime());
		const timer = setTimeout(() => reject(new AttemptBoundElapsed(bound)), remaining);
		const settle = () => clearTimeout(timer);
		work.then(settle, settle);
	});
	return Promise.race([work, elapsed]);
}
function canonicalData$1(value) {
	return canonicalFacetData(value);
}
function invalid$3(message) {
	return new AgentCoreError("invocation.invalid", message);
}
//#endregion
//#region src/invocations/operation-mediation.ts
var ReplayOperationInvocationPort = class {
	scope;
	transactions;
	persistence;
	identities;
	direct;
	mediated;
	constructor(scope, transactions, persistence, identities, direct, mediated) {
		this.scope = scope;
		this.transactions = transactions;
		this.persistence = persistence;
		this.identities = identities;
		this.direct = direct;
		this.mediated = mediated;
		if (scope.trim().length === 0 || scope !== scope.trim()) throw new TypeError("Invocation replay scope must be canonical");
	}
	directContext(requestKey, itemIndex, cardinality, authorization) {
		const context = this.direct.context(requestKey, itemIndex, cardinality, authorization);
		if (context.attempt !== void 0) throw invalid$2("Direct Operation context cannot carry an EffectAttempt");
		return context;
	}
	async prepareMediated(request, prepare) {
		const reserved = this.transactions.transact((transaction) => {
			const existing = this.persistence.replay(transaction, this.scope, request.requestKey.value);
			const reservation = replayReservation(this.scope, request);
			if (existing !== void 0) {
				if (!existing.id.equals(MediatedReplayRecord.reserve(reservation).id)) throw invalid$2("OperationRequestKey replay changed its bound intent");
				if (existing.complete) return {
					kind: "replay",
					result: replayResult(existing)
				};
				if (existing.invocation !== void 0) return {
					kind: "new",
					preparation: preparation(existing)
				};
				return;
			}
			this.persistence.appendReplay(transaction, MediatedReplayRecord.reserve(reservation));
		});
		if (reserved !== void 0) return reserved;
		const value = prepare();
		requirePreparation(value, request.inputs.length);
		return this.transactions.transact((transaction) => {
			const current = this.persistence.replay(transaction, this.scope, request.requestKey.value);
			if (current === void 0) throw invalid$2("Replay reservation disappeared before preparation");
			if (current.invocation !== void 0) return {
				kind: "new",
				preparation: preparation(current)
			};
			const prepared = current.prepare(this.identities.invocation(request), value.inputs, value.interceptions.map((item) => item.map(toInvocationTrace)));
			this.persistence.appendReplay(transaction, prepared);
			return {
				kind: "new",
				preparation: value
			};
		});
	}
	async invoke(request) {
		const replay = this.transactions.transact((transaction) => this.persistence.replay(transaction, this.scope, request.requestKey.value));
		if (replay?.invocation === void 0) throw invalid$2("Mediated invocation has no reserved prepared replay identity");
		if (request.replayBinding === void 0 || !replayBindingMatches(replay, request.replayBinding)) throw invalid$2("Mediated invocation changed its authenticated replay binding");
		if (replay.items.every((item) => item.effectOutput !== void 0 && item.receipt !== void 0)) return Object.freeze({
			outputs: Object.freeze(replay.items.map((item) => item.effectOutput)),
			evidence: replayEvidence(replay)
		});
		if (replay.items.every((item) => item.receipt !== void 0)) throw terminalInvocation();
		const result = await this.mediated.invoke({
			invocation: replay.invocation,
			request
		});
		if (!result.invocation.equals(replay.invocation) || result.items.length !== replay.items.length || result.items.some((item, itemIndex) => item.itemIndex !== itemIndex)) throw invalid$2("Canonical batch mediation returned substituted item evidence");
		const recorded = this.transactions.transact((transaction) => {
			let current = this.persistence.replayById(transaction, replay.id);
			if (current === void 0) throw invalid$2("Mediated replay reservation disappeared");
			for (let itemIndex = 0; itemIndex < current.items.length; itemIndex += 1) {
				const item = current.items[itemIndex];
				const resultItem = result.items[itemIndex];
				if (item.receipt === void 0) {
					current = resultItem.kind === "succeeded" ? current.recordEffect(itemIndex, resultItem.output, resultItem.receipt.id) : current.recordTerminal(itemIndex, resultItem.receipt.id);
					this.persistence.appendReplay(transaction, current);
				} else if (!item.receipt.equals(resultItem.receipt.id) || (resultItem.kind === "succeeded" ? item.effectOutput === void 0 || !sameData(item.effectOutput, resultItem.output) : item.effectOutput !== void 0)) throw invalid$2("Canonical batch replay changed a persisted effect output");
			}
			return current;
		});
		if (result.items.some((item) => item.kind !== "succeeded")) throw terminalInvocation();
		return Object.freeze({
			outputs: Object.freeze(recorded.items.map((item) => item.effectOutput)),
			evidence: replayEvidence(recorded)
		});
	}
	/**
	* The direct tier carries no interceptions to attribute: an applicable
	* `operation.before` or `operation.after` interceptor forces the mediated tier (§7.2),
	* and the gateway asks the same candidate set that runs them. Asserting that here keeps
	* the invariant from decaying into silently discarded attribution evidence.
	*/
	recordDirectInterceptions(evidence) {
		if (evidence.traces.some((traces) => traces.length > 0)) throw new AgentCoreError("protocol.invalid-state", "Direct invocation carries interception evidence, which only the mediated tier attributes");
	}
	async presentMediated(evidence, outputs, present, interceptions) {
		const invocation = evidenceInvocation(evidence);
		return this.transactions.transact((transaction) => {
			let replay = this.persistence.replay(transaction, this.scope, interceptions.requestKey.value);
			if (replay?.invocation === void 0 || !replay.invocation.equals(invocation) || replay.items.length !== outputs.length) throw invalid$2("Mediated presentation does not bind its replay evidence");
			for (let itemIndex = 0; itemIndex < replay.items.length; itemIndex += 1) {
				const item = replay.items[itemIndex];
				if (item.effectOutput === void 0 || !sameData(item.effectOutput, outputs[itemIndex])) throw invalid$2("Mediated presentation substituted an item output");
				if (item.presentation === void 0) {
					const presented = present(itemIndex, item.effectOutput);
					replay = replay.present(itemIndex, presented.traces.map(toInvocationTrace), presented.value);
					this.persistence.appendReplay(transaction, replay);
				}
			}
			return Object.freeze(replay.items.map((item) => item.presentation));
		});
	}
};
function replayReservation(scope, request) {
	return {
		scope,
		requestKey: request.requestKey.value,
		facet: request.facet.value,
		operation: request.descriptor.name.value,
		descriptorDigest: Digest.sha256(encodeCanonicalJson(request.descriptor.toData())),
		principal: request.replayBinding.principal,
		authorityIdentity: request.replayBinding.authorityIdentity,
		packageOperationPin: request.replayBinding.packageOperationPin,
		execution: request.replayBinding.execution,
		cardinality: request.cardinality,
		rawPayloadIdentities: request.inputs.map((input) => Digest.sha256(encodeCanonicalJson(canonicalData(input))))
	};
}
function replayBindingMatches(record, binding) {
	return record.principal.equals(binding.principal) && record.authorityIdentity.equals(binding.authorityIdentity) && record.packageOperationPin.equals(binding.packageOperationPin) && record.execution.kind === binding.execution.kind && record.execution.digest.equals(binding.execution.digest);
}
function preparation(record) {
	return Object.freeze({
		inputs: Object.freeze(record.items.map((item) => item.preparedArguments)),
		interceptions: Object.freeze(record.items.map((item, itemIndex) => Object.freeze(item.before.map((trace) => fromInvocationTrace(trace, itemIndex)))))
	});
}
function replayResult(record) {
	const presentations = record.items.map((item) => item.presentation);
	return Object.freeze({
		kind: "mediated",
		output: record.cardinality.kind === "single" ? presentations[0] : Object.freeze(presentations),
		evidence: replayEvidence(record)
	});
}
function replayEvidence(record) {
	if (record.invocation === void 0) throw invalid$2("Replay evidence requires an Invocation");
	return canonicalData({
		invocation: record.invocation.value,
		receipts: record.items.map((item) => item.receipt.value)
	});
}
function evidenceInvocation(evidence) {
	if (!isJsonObject(evidence)) throw invalid$2("Mediated evidence does not identify its Invocation");
	try {
		return new InvocationId(requireString(evidence, "invocation"));
	} catch {
		throw invalid$2("Mediated evidence does not identify its Invocation");
	}
}
function requirePreparation(value, itemCount) {
	if (value.inputs.length !== itemCount || value.interceptions.length !== itemCount) throw invalid$2("Mediated before phase changed the item count");
}
function toInvocationTrace(trace) {
	return Object.freeze({
		interceptor: trace.interceptor,
		contributor: trace.contributor,
		cutPoint: trace.cutPoint,
		before: trace.before,
		after: trace.after,
		outcome: trace.outcome
	});
}
function fromInvocationTrace(trace, itemIndex) {
	return Object.freeze({
		...trace,
		itemIndex
	});
}
function sameData(left, right) {
	return Digest.sha256(encodeCanonicalJson(canonicalData(left))).equals(Digest.sha256(encodeCanonicalJson(canonicalData(right))));
}
function canonicalData(value) {
	return canonicalFacetData(value);
}
function invalid$2(message) {
	return new AgentCoreError("invocation.invalid", message);
}
function terminalInvocation() {
	return new AgentCoreError("authority.denied", "Mediated Invocation completed without one successful output per item");
}
//#endregion
//#region src/invocations/operation-pin.ts
var MODES = PLACEMENT_PREFERENCE;
var IMPACTS = POLICY_IMPACTS;
var InvocationPlacementPin = class InvocationPlacementPin {
	manifest;
	policy;
	substrate;
	trust;
	constructor(init) {
		this.manifest = canonicalModes(init.manifest, "manifest");
		this.policy = canonicalModes(init.policy, "policy");
		this.substrate = canonicalModes(init.substrate, "substrate");
		this.trust = canonicalModes(init.trust, "trust");
		requireMode(init.selected);
		if (![
			this.manifest,
			this.policy,
			this.substrate,
			this.trust
		].every((modes) => modes.includes(init.selected))) throw new TypeError("Selected placement must occur in every admissible set");
		if (preferredPlacement(this.manifest, this.policy, this.substrate, this.trust) !== init.selected) throw new TypeError("Selected placement must follow the canonical preference order");
		this.selected = init.selected;
		Object.freeze(this);
	}
	selected;
	toData() {
		return {
			manifest: this.manifest,
			policy: this.policy,
			selected: this.selected,
			substrate: this.substrate,
			trust: this.trust
		};
	}
	static fromData(value) {
		const object = requireExactObject(value, [
			"manifest",
			"policy",
			"selected",
			"substrate",
			"trust"
		], "Invocation placement pin");
		return new InvocationPlacementPin({
			manifest: decodeModes(requireArray(object, "manifest")),
			policy: decodeModes(requireArray(object, "policy")),
			selected: requireMode(requireString(object, "selected")),
			substrate: decodeModes(requireArray(object, "substrate")),
			trust: decodeModes(requireArray(object, "trust"))
		});
	}
};
var OperationPin = class OperationPin {
	operation;
	target;
	packageId;
	version;
	manifestDigest;
	descriptorDigest;
	configurationDigest;
	runtimeDigest;
	activationGeneration;
	registration;
	impact;
	approvalRequired;
	placement;
	constructor(operation, target, packageId, version, manifestDigest, descriptorDigest, configurationDigest, runtimeDigest, activationGeneration, registration, impact, approvalRequired, placement) {
		this.operation = operation;
		this.target = target;
		this.packageId = packageId;
		this.version = version;
		this.manifestDigest = manifestDigest;
		this.descriptorDigest = descriptorDigest;
		this.configurationDigest = configurationDigest;
		this.runtimeDigest = runtimeDigest;
		this.activationGeneration = activationGeneration;
		this.registration = registration;
		this.impact = impact;
		this.approvalRequired = approvalRequired;
		this.placement = placement;
		for (const [value, subject] of [
			[target, "Operation target"],
			[packageId.value, "Package pin"],
			[version.toString(), "Package version"],
			[activationGeneration, "Activation generation"],
			[registration, "Operation registration"]
		]) requireCanonicalText(value, subject);
		requireImpact(impact);
		if (approvalRequired !== true && approvalRequired !== false) throw new TypeError("Operation approval requirement must be boolean");
		for (const digest of [
			manifestDigest,
			descriptorDigest,
			configurationDigest,
			runtimeDigest
		]) Object.freeze(digest);
		Object.freeze(this);
	}
	static create(init) {
		return new OperationPin(init.operation, init.target, init.package, init.version, init.manifestDigest, init.descriptorDigest, init.configurationDigest, init.runtimeDigest, init.activationGeneration, init.registration, init.impact, init.approvalRequired, init.placement);
	}
	toData() {
		return {
			activationGeneration: this.activationGeneration,
			approvalRequired: this.approvalRequired,
			configurationDigest: this.configurationDigest.value,
			descriptorDigest: this.descriptorDigest.value,
			impact: this.impact,
			manifestDigest: this.manifestDigest.value,
			operation: this.operation.value,
			package: this.packageId.value,
			placement: this.placement.toData(),
			registration: this.registration,
			runtimeDigest: this.runtimeDigest.value,
			target: this.target,
			version: this.version.toString()
		};
	}
	static fromData(value) {
		const object = requireExactObject(value, [
			"activationGeneration",
			"approvalRequired",
			"configurationDigest",
			"descriptorDigest",
			"impact",
			"manifestDigest",
			"operation",
			"package",
			"placement",
			"registration",
			"runtimeDigest",
			"target",
			"version"
		], "Operation pin");
		return new OperationPin(new OperationRef(requireString(object, "operation")), requireString(object, "target"), new PackageId(requireString(object, "package")), new SemVer(requireString(object, "version")), requireDigest(object, "manifestDigest"), requireDigest(object, "descriptorDigest"), requireDigest(object, "configurationDigest"), requireDigest(object, "runtimeDigest"), requireString(object, "activationGeneration"), requireString(object, "registration"), requireImpact(requireString(object, "impact")), requireBoolean(object["approvalRequired"]), InvocationPlacementPin.fromData(object["placement"]));
	}
};
function canonicalModes(values, subject) {
	if (values.length === 0 || new Set(values).size !== values.length) throw new TypeError(`${subject} placement modes must be nonempty and unique`);
	for (const value of values) requireMode(value);
	return Object.freeze(MODES.filter((mode) => values.includes(mode)));
}
function decodeModes(values) {
	return values.map((value) => {
		if (!isMember(MODES, value)) throw new TypeError("Isolation mode is invalid");
		return value;
	});
}
function requireMode(value) {
	if (!isMember(MODES, value)) throw new TypeError("Isolation mode is invalid");
	return value;
}
function requireImpact(value) {
	if (!isMember(IMPACTS, value)) throw new TypeError("Operation impact is invalid");
	return value;
}
function requireBoolean(value) {
	if (value !== true && value !== false) throw new TypeError("Approval requirement must be boolean");
	return value;
}
//#endregion
//#region src/invocations/profile-mediation.ts
var InvocationProtectedOperationPort = class {
	identities;
	invocations;
	constructor(identities, invocations) {
		this.identities = identities;
		this.invocations = invocations;
	}
	async invoke(request) {
		const invocation = this.identities.invocation(request);
		const result = await this.invocations.invoke({
			invocation,
			request: {
				requestKey: new OperationRequestKey(`profile:${invocation.value}`),
				facet: request.facet,
				descriptor: request.operation.descriptor,
				cardinality: { kind: "single" },
				inputs: [request.input],
				authorization: request,
				interceptions: [[]],
				execute: (_itemIndex, context) => request.operation.execute(context, request.input)
			}
		});
		const item = result.items[0];
		if (result.items.length !== 1 || item === void 0 || item.itemIndex !== 0) throw invalid$1("Profile mediation returned a substituted canonical item result");
		if (request.resultMode === "receipt") return Object.freeze({
			kind: "receipt",
			receipt: item.receipt
		});
		if (item.kind === "succeeded") return Object.freeze({
			kind: "output",
			output: item.output,
			receipt: item.receipt
		});
		throw terminal(item.receipt);
	}
};
function terminal(receipt) {
	if (receipt instanceof PreEffectReceipt) return new AgentCoreError("authority.denied", receipt.reason);
	if (receipt instanceof AttemptReceipt && receipt.outcome === "indeterminate") return invalid$1("Profile Operation outcome is indeterminate");
	return invalid$1("Profile Operation did not produce a successful output");
}
function invalid$1(message) {
	return new AgentCoreError("invocation.invalid", message);
}
//#endregion
//#region src/invocations/publisher.ts
var InvocationPublicationDrainer = class {
	transactions;
	persistence;
	events;
	commits;
	now;
	constructor(transactions, persistence, events, commits, now) {
		this.transactions = transactions;
		this.persistence = persistence;
		this.events = events;
		this.commits = commits;
		this.now = now;
	}
	async flush() {
		const pending = this.transactions.transact((transaction) => this.persistence.pendingPublications(transaction));
		for (const publication of pending) {
			let current = this.transactions.transact((transaction) => this.persistence.publication(transaction, publication.id));
			if (current?.state.kind !== "pending") continue;
			if (current.state.eventPublishedAt === void 0) {
				await this.events.publish(current.id, current.observation);
				current = this.acknowledge(current.id, "event");
			}
			if (current.state.kind === "pending" && current.state.commitAppendedAt === void 0) {
				await this.commits.append(current.id, current.observation);
				this.acknowledge(current.id, "commit");
			}
		}
	}
	acknowledge(id, sink) {
		return this.transactions.transact((transaction) => {
			const current = this.persistence.publication(transaction, id);
			if (current === void 0) throw new AgentCoreError("invocation.invalid", "Publication disappeared during acknowledgement");
			if (current.state.kind === "published") return current;
			if (sink === "event" && current.state.eventPublishedAt !== void 0 || sink === "commit" && current.state.commitAppendedAt !== void 0) return current;
			const next = sink === "event" ? current.eventPublished(this.now()) : current.commitAppended(this.now());
			this.persistence.appendPublication(transaction, next);
			return next;
		});
	}
};
//#endregion
//#region src/invocations/prepared.ts
var ITEM_KEY_DOMAIN = "agent-core.item.v1";
var HEADER_DIGEST_DOMAIN = "agent-core.prepared-header.v1";
var INTENT_DIGEST_DOMAIN = "agent-core.prepared-invocation.v1";
var PreparedInvocationHeader = class {
	id;
	operation;
	domain;
	actor;
	authority;
	pathEpochs;
	lease;
	route;
	projectionDigest;
	auditCause;
	idempotencySeed;
	constructor(id, operation, domain, actor, authority, pathEpochs, lease, route, projectionDigest, auditCause, idempotencySeed) {
		this.id = id;
		this.operation = operation;
		this.domain = domain;
		this.actor = actor;
		this.authority = authority;
		this.pathEpochs = pathEpochs;
		this.lease = lease;
		this.route = route;
		this.projectionDigest = projectionDigest;
		this.auditCause = auditCause;
		this.idempotencySeed = idempotencySeed;
		if (id.constructor !== InvocationId || auditCause.constructor !== AuditRecordId || route !== void 0 && route.constructor !== RouteReservationId) throw new TypeError("Prepared invocation identifiers must use exact context classes");
		requireCanonicalText(idempotencySeed, "Invocation idempotency seed");
		if (route === void 0 !== (projectionDigest === void 0)) throw new TypeError("Route and projection digest must be present together");
		if (projectionDigest !== void 0) Object.freeze(projectionDigest);
		Object.freeze(this);
	}
};
var PreparedItem = class {
	idempotencyKey;
	arguments;
	constructor(argumentsValue, idempotencyKey) {
		this.idempotencyKey = idempotencyKey;
		requireCanonicalText(idempotencyKey, "Invocation item key");
		this.arguments = canonicalFacetData(argumentsValue);
		Object.freeze(this);
	}
};
var PreparedInvocation = class PreparedInvocation {
	header;
	payload;
	intentDigest;
	constructor(header, payload, intentDigest) {
		this.header = header;
		this.payload = payload;
		this.intentDigest = intentDigest;
		Object.freeze(intentDigest);
		Object.freeze(this);
	}
	static encode(record, codecs) {
		return new PreparedInvocationCodec(codecs).encode(record);
	}
	static decode(bytes, codecs) {
		return new PreparedInvocationCodec(codecs).decode(bytes);
	}
	static create(init, payload, codecs) {
		requireNonemptyPayload(payload);
		const header = canonicalHeader(init, codecs);
		const headerData = encodeHeader(header, codecs);
		const headerDigest = structuralDigest(HEADER_DIGEST_DOMAIN, headerData);
		const payloadCardinality = payload.kind === "single" ? { kind: "single" } : {
			itemCount: payload.items.length,
			kind: "batch"
		};
		const items = (payload.kind === "single" ? [payload.item] : payload.items).map((argumentsValue, itemIndex) => {
			const canonicalArguments = canonicalFacetData(argumentsValue);
			const argumentDigest = Digest.sha256(encodeCanonicalJson(canonicalArguments));
			return new PreparedItem(canonicalArguments, `${ITEM_KEY_DOMAIN}:${Digest.sha256(encodeCanonicalJson([
				ITEM_KEY_DOMAIN,
				headerDigest.value,
				payloadCardinality,
				itemIndex,
				argumentDigest.value,
				header.idempotencySeed
			])).value}`);
		});
		const preparedPayload = payload.kind === "single" ? Object.freeze({
			kind: "single",
			item: items[0]
		}) : Object.freeze({
			kind: "batch",
			items: requireNonempty(Object.freeze(items), "Prepared invocation batch")
		});
		const intentData = {
			domain: INTENT_DIGEST_DOMAIN,
			header: headerData,
			payload: encodePayload(preparedPayload)
		};
		return new PreparedInvocation(header, preparedPayload, Digest.sha256(encodeCanonicalJson(intentData)));
	}
	get itemCount() {
		return this.payload.kind === "single" ? 1 : this.payload.items.length;
	}
	item(index) {
		if (!Number.isSafeInteger(index) || index < 0) throw invocationError("state.invalid-transition", "Invocation item index must be a non-negative safe integer");
		const item = this.payload.kind === "single" ? index === 0 ? this.payload.item : void 0 : this.payload.items[index];
		if (item === void 0) throw invocationError("state.invalid-transition", "Invocation item index is out of range");
		return item;
	}
};
var PreparedInvocationCodec = class extends RecordCodec {
	#codecs;
	constructor(codecs) {
		super([
			PreparedInvocation,
			ActorRef,
			Digest,
			InvocationPlacementPin,
			OperationPin,
			PreparedItem,
			TextId,
			SemVer,
			OperationRef,
			InvocationId,
			ActorId,
			PackageId,
			AuditRecordId,
			FacetPackageId,
			PreparedInvocationHeader,
			RouteReservationId,
			OperationName,
			PlacementIntersection
		], "invocation.prepared", {
			major: 1,
			minor: 0
		});
		this.#codecs = Object.freeze({
			authority: copyStructuralCodec(codecs.authority),
			domain: copyStructuralCodec(codecs.domain),
			lease: copyStructuralCodec(codecs.lease),
			pathEpochs: copyStructuralCodec(codecs.pathEpochs)
		});
		Object.freeze(this);
	}
	encodePayload(record) {
		return {
			header: encodeHeader(record.header, this.#codecs),
			intentDigest: record.intentDigest.value,
			payload: encodePayload(record.payload)
		};
	}
	decodePayload(payload, _version) {
		const object = requireExactObject(payload, [
			"header",
			"intentDigest",
			"payload"
		], "Prepared invocation");
		const header = decodeHeader(object["header"], this.#codecs);
		const encodedPayload = decodePayload(object["payload"]);
		const argumentsPayload = encodedPayload.kind === "single" ? {
			kind: "single",
			item: encodedPayload.item.arguments
		} : {
			kind: "batch",
			items: requireNonempty(encodedPayload.items.map((item) => item.arguments), "Prepared invocation batch")
		};
		const record = PreparedInvocation.create({
			id: header.id,
			operation: header.operation,
			domain: header.domain,
			actor: header.actor,
			authority: header.authority,
			pathEpochs: header.pathEpochs,
			lease: header.lease,
			route: header.route,
			projectionDigest: header.projectionDigest,
			auditCause: header.auditCause,
			idempotencySeed: header.idempotencySeed
		}, argumentsPayload, this.#codecs);
		if (!record.intentDigest.equals(requireDigest(object, "intentDigest")) || !sameJson(encodePayload(record.payload), encodePayload(encodedPayload))) throw new TypeError("Prepared invocation identity does not match its canonical derivation");
		return record;
	}
};
function canonicalHeader(init, codecs) {
	const actor = new ActorRef(init.actor.kind, new ActorId(init.actor.id.value));
	Object.freeze(actor.id);
	Object.freeze(actor);
	return new PreparedInvocationHeader(init.id, OperationPin.fromData(init.operation.toData()), immutableReference(codecs.domain.decode(codecs.domain.encode(init.domain))), actor, immutableReference(codecs.authority.decode(codecs.authority.encode(init.authority))), immutableReference(codecs.pathEpochs.decode(codecs.pathEpochs.encode(init.pathEpochs))), init.lease === void 0 ? void 0 : immutableReference(codecs.lease.decode(codecs.lease.encode(init.lease))), init.route, init.projectionDigest === void 0 ? void 0 : new Digest(init.projectionDigest.value), init.auditCause, init.idempotencySeed);
}
function encodeHeader(header, codecs) {
	return {
		actor: {
			id: header.actor.id.value,
			kind: header.actor.kind
		},
		auditCause: header.auditCause.value,
		authority: codecs.authority.encode(header.authority),
		domain: codecs.domain.encode(header.domain),
		id: header.id.value,
		idempotencySeed: header.idempotencySeed,
		lease: header.lease === void 0 ? null : codecs.lease.encode(header.lease),
		operation: header.operation.toData(),
		pathEpochs: codecs.pathEpochs.encode(header.pathEpochs),
		projectionDigest: header.projectionDigest?.value ?? null,
		route: header.route?.value ?? null
	};
}
function decodeHeader(value, codecs) {
	const object = requireExactObject(value, [
		"actor",
		"auditCause",
		"authority",
		"domain",
		"id",
		"idempotencySeed",
		"lease",
		"operation",
		"pathEpochs",
		"projectionDigest",
		"route"
	], "Prepared invocation header");
	const actor = requireExactObject(object["actor"], ["id", "kind"], "Prepared invocation actor");
	const lease = object["lease"];
	const route = requireNullableString(object, "route");
	const projectionDigest = requireNullableString(object, "projectionDigest");
	if (route === void 0 !== (projectionDigest === void 0)) throw new TypeError("Prepared invocation route evidence is malformed");
	return new PreparedInvocationHeader(new InvocationId(requireString(object, "id")), OperationPin.fromData(object["operation"]), codecs.domain.decode(object["domain"]), new ActorRef(requireActorKind(requireString(actor, "kind")), new ActorId(requireString(actor, "id"))), codecs.authority.decode(object["authority"]), codecs.pathEpochs.decode(object["pathEpochs"]), lease === null ? void 0 : codecs.lease.decode(lease), route === void 0 ? void 0 : new RouteReservationId(route), projectionDigest === void 0 ? void 0 : new Digest(projectionDigest), new AuditRecordId(requireString(object, "auditCause")), requireString(object, "idempotencySeed"));
}
function encodePayload(payload) {
	return payload.kind === "single" ? {
		item: encodeItem(payload.item),
		kind: "single"
	} : {
		items: payload.items.map(encodeItem),
		kind: "batch"
	};
}
function encodeItem(item) {
	return {
		arguments: item.arguments,
		idempotencyKey: item.idempotencyKey
	};
}
function decodePayload(value) {
	const object = requireObject(value, "Prepared invocation payload");
	const kind = object["kind"];
	if (kind === "single") {
		const exact = requireExactObject(object, ["item", "kind"], "Single invocation payload");
		return Object.freeze({
			kind,
			item: decodeItem(exact["item"])
		});
	}
	if (kind === "batch") {
		const values = requireArray(requireExactObject(object, ["items", "kind"], "Batch invocation payload"), "items");
		return Object.freeze({
			kind,
			items: requireNonempty(Object.freeze(values.map(decodeItem)), "Prepared invocation batch")
		});
	}
	throw new TypeError("Prepared invocation payload kind is invalid");
}
function decodeItem(value) {
	const object = requireExactObject(value, ["arguments", "idempotencyKey"], "Prepared item");
	return new PreparedItem(object["arguments"], requireString(object, "idempotencyKey"));
}
function structuralDigest(domain, value) {
	return Digest.sha256(encodeCanonicalJson({
		domain,
		value
	}));
}
function requireNonemptyPayload(payload) {
	if (payload.kind === "batch" && payload.items.length === 0) throw new TypeError("Prepared invocation batch must be nonempty");
}
function requireActorKind(value) {
	if (value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate") return value;
	throw new TypeError("Prepared invocation Actor kind is invalid");
}
//#endregion
//#region src/invocations/reconciliation-driver.ts
/**
* The named reconciliation driver (C13-EFFECT-RECONCILIATION-DRIVER): owns the
* durable schedule that drives InvocationReconciler. A sweep re-queries the
* indeterminate attempts, reconciles each, and re-arms the schedule while any
* remain unresolved; direct calls to the reconciler never establish
* scheduling — only arm() and sweep() touch the schedule.
*/
var AlarmReconciliationDriver = class {
	reconciler;
	attempts;
	schedule;
	intervalMs;
	now;
	batchLimit;
	constructor(reconciler, attempts, schedule, intervalMs, now, batchLimit = 32) {
		this.reconciler = reconciler;
		this.attempts = attempts;
		this.schedule = schedule;
		this.intervalMs = intervalMs;
		this.now = now;
		this.batchLimit = batchLimit;
		if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new AgentCoreError("protocol.invalid-state", "Reconciliation driver interval must be a positive safe integer");
		if (!Number.isSafeInteger(batchLimit) || batchLimit <= 0) throw new AgentCoreError("protocol.invalid-state", "Reconciliation driver batch limit must be a positive safe integer");
	}
	/** Arm the durable schedule if it is not already armed. Idempotent. */
	arm() {
		const existing = this.schedule.scheduled();
		if (existing !== void 0) return existing;
		const at = new Date(this.now().getTime() + this.intervalMs);
		this.schedule.schedule(at);
		return at;
	}
	/**
	* Reconstruct the schedule from durable attempt state. A sweep interrupted by
	* eviction or a failing reconciliation leaves attempts indeterminate; call this
	* during startup so the driver resumes without waiting for new work to arm it.
	*/
	repair() {
		if (this.attempts.indeterminate(1).length === 0) return void 0;
		return this.arm();
	}
	/**
	* One driver firing: re-query indeterminate attempts, reconcile each, and leave
	* the schedule armed exactly when unresolved attempts remain. An attempt whose
	* provider outcome is still unknown stays indeterminate and keeps it armed.
	*
	* The schedule is settled after the work, never before: clearing first would
	* strand every outstanding attempt if the firing is evicted or throws.
	*/
	async sweep() {
		const queried = this.attempts.indeterminate(this.batchLimit);
		let reconciled = 0;
		try {
			for (const attemptId of queried) {
				const receipt = await this.reconciler.reconcile(attemptId);
				if (receipt !== void 0 && receipt.outcome !== "indeterminate") reconciled += 1;
			}
		} finally {
			this.settleSchedule();
		}
		const remaining = this.attempts.indeterminate(1).length > 0;
		return Object.freeze({
			queried: queried.length,
			reconciled,
			remaining
		});
	}
	settleSchedule() {
		if (this.attempts.indeterminate(1).length > 0) {
			this.schedule.schedule(new Date(this.now().getTime() + this.intervalMs));
			return;
		}
		this.schedule.clear();
	}
};
//#endregion
//#region src/invocations/reconciliation.ts
var InvocationReconciler = class {
	transactions;
	persistence;
	ledger;
	provider;
	records;
	evidence;
	now;
	constructor(transactions, persistence, ledger, provider, records, evidence, now) {
		this.transactions = transactions;
		this.persistence = persistence;
		this.ledger = ledger;
		this.provider = provider;
		this.records = records;
		this.evidence = evidence;
		this.now = now;
	}
	async reconcile(attemptId) {
		const current = this.transactions.transact((transaction) => this.current(transaction, attemptId));
		if (current.receipt.outcome !== "indeterminate") return current.receipt;
		const result = await this.provider.query(current.attempt, current.invocation.intentDigest);
		if (result.kind === "unknown") return void 0;
		return this.transactions.transact((transaction) => {
			const refreshed = this.current(transaction, attemptId);
			if (refreshed.receipt.outcome !== "indeterminate") {
				if (!matches(refreshed.receipt, result)) throw invalid("Reconciliation provider contradicted the persisted final Receipt");
				return refreshed.receipt;
			}
			const receipt = this.records.reconciledReceipt(refreshed.attempt, refreshed.receipt, result.kind === "succeeded" ? AttemptCompletion.succeeded : AttemptCompletion.failed(result.failure), result.result, this.now());
			if (!matches(receipt, result)) throw invalid("Reconciliation Receipt does not match the authoritative result");
			const supersession = this.supersession(refreshed.invocation, refreshed.attemptAudit, refreshed.receiptAudit, refreshed.receipt, receipt);
			this.ledger.supersedeReceiptWithAudit(transaction, receipt, supersession, this.evidence);
			return receipt;
		});
	}
	current(transaction, attemptId) {
		const attempt = this.persistence.attempt(transaction, attemptId);
		if (attempt === void 0) throw invalid("Reconciliation EffectAttempt does not exist");
		const invocation = this.persistence.prepared(transaction, attempt.invocation);
		if (invocation === void 0) throw invalid("Reconciliation EffectAttempt has no PreparedInvocation");
		const receipt = this.ledger.currentReceipt(transaction, attempt.invocation, attempt.itemIndex);
		if (!(receipt instanceof AttemptReceipt) || !receipt.attempt.equals(attempt.id)) throw invalid("Reconciliation requires the current attempted Receipt");
		const attemptCause = this.evidence.audit(transaction, attempt.auditCause);
		if (attemptCause === void 0) throw invalid("Reconciliation EffectAttempt has no persisted audit cause");
		this.ledger.requirePersistedAuditRelation(transaction, attemptCause, this.evidence);
		const attemptAudit = requireCausedAudit(this.evidence.findAuditByEvidence(transaction, invocation.header.actor, {
			kind: "attempt",
			id: attempt.id
		}), attemptCause, "Reconciliation EffectAttempt has no exact audit evidence");
		this.ledger.requirePersistedAuditRelation(transaction, attemptAudit, this.evidence);
		const receiptAudit = requireCausedAudit(this.evidence.findAuditByEvidence(transaction, invocation.header.actor, {
			kind: "receipt",
			id: receipt.id,
			outcome: receipt.outcome
		}), attemptAudit, "Reconciliation Receipt has no exact audit evidence");
		this.ledger.requirePersistedAuditRelation(transaction, receiptAudit, this.evidence);
		if (receipt.outcome !== "indeterminate") this.requireCompleteEvidence(transaction, invocation, attempt, attemptAudit, receipt, receiptAudit);
		return {
			attempt,
			attemptAudit,
			invocation,
			receipt,
			receiptAudit
		};
	}
	supersession(invocation, attemptAudit, previousAudit, previous, next) {
		const finalReceiptAudit = this.records.receiptAudit(invocation, attemptAudit, next);
		const supersessionAudit = this.records.receiptSupersessionAudit(invocation, previousAudit, previous, next);
		return {
			finalReceiptAudit,
			supersessionAudit,
			publication: InvocationPublicationOutbox.pending({
				invocation: invocation.header.id,
				receipt: next.id,
				audit: supersessionAudit.id
			})
		};
	}
	requireCompleteEvidence(transaction, invocation, attempt, attemptAudit, receipt, finalReceiptAudit) {
		const previous = receipt.previous === void 0 ? void 0 : this.persistence.receipt(transaction, receipt.previous);
		if (!(previous instanceof AttemptReceipt) || previous.outcome !== "indeterminate") throw invalid("Final reconciliation Receipt has no indeterminate predecessor");
		const previousAudit = requireCausedAudit(this.evidence.findAuditByEvidence(transaction, invocation.header.actor, {
			kind: "receipt",
			id: previous.id,
			outcome: previous.outcome
		}), attemptAudit, "Final reconciliation Receipt has no exact predecessor audit");
		this.ledger.requirePersistedAuditRelation(transaction, previousAudit, this.evidence);
		const supersessionAudit = requireCausedAudit(this.evidence.findAuditByEvidence(transaction, invocation.header.actor, {
			kind: "receiptSuperseded",
			previous: previous.id,
			next: receipt.id
		}), previousAudit, "Final reconciliation Receipt has no exact supersession audit");
		this.ledger.requirePersistedAuditRelation(transaction, supersessionAudit, this.evidence);
		const publicationIdentity = InvocationPublicationOutbox.pending({
			invocation: attempt.invocation,
			receipt: receipt.id,
			audit: supersessionAudit.id
		});
		const publication = this.evidence.publication(transaction, publicationIdentity.id);
		if (publication === void 0 || !publication.observation.invocation.equals(attempt.invocation) || !publication.observation.receipt.equals(receipt.id) || !publication.observation.audit.equals(supersessionAudit.id) || !finalReceiptAudit.actor.equals(attemptAudit.actor) || !finalReceiptAudit.tenant.equals(attemptAudit.tenant) || !finalReceiptAudit.correlation.equals(attemptAudit.correlation)) throw invalid("Final reconciliation Receipt has no exact publication evidence");
	}
};
function matches(receipt, result) {
	return receipt.outcome === result.kind && sameFailure(receipt.failure, result) && sameContent(receipt.result, result.result);
}
/**
* The minted Receipt must name the kind reconciliation observed, not merely a kind. A record
* port that substituted one would rewrite the host's determination while every outcome-level
* check stayed green.
*/
function sameFailure(failure, result) {
	return result.kind === "failed" ? failure !== void 0 && failure.equals(result.failure) : failure === void 0;
}
function sameContent(left, right) {
	return left === void 0 ? right === void 0 : right !== void 0 && left.equals(right);
}
function requireCausedAudit(actual, cause, message) {
	if (actual === void 0 || actual.cause?.equals(cause.id) !== true || !actual.actor.equals(cause.actor) || !actual.tenant.equals(cause.tenant) || !actual.correlation.equals(cause.correlation)) throw invalid(message);
	return actual;
}
function invalid(message) {
	return new AgentCoreError("invocation.invalid", message);
}
//#endregion
export { AuditRecord as $, DetachedEffectTarget as A, cloneDetachedEffectExecutionMemoryState as B, deriveBatchOutcome as C, requireSafeInteger as Ct, createInvocationProtocolCommands as D, validDate as Dt, InvocationCommandPayload as E, structuralCodec as Et, PreEffectReceipt as F, AlarmDetachedEffectDriver as G, DetachedEffectExecution as H, Receipt as I, DetachedEffectDeliveryPort as J, DetachedEffectAdmissionOutcome as K, ReceiptCodec as L, AttemptCompletion as M, AttemptFailureKind as N, INVOCATION_CONTEXT_EXPORTS as O, AdmittedInvocationItem as Ot, AttemptReceipt as P, ItemClaimCodec as Q, receiptContentRetention as R, InvocationDrainQuery as S, requireObject as St, INVOCATION_COMMANDS as T, sameJson as Tt, DetachedEffectExecutionCodec as U, createDetachedEffectExecutionMemoryState as V, DetachedEffectExecutionState as W, InvocationPublicationOutboxCodec as X, InvocationPublicationOutbox as Y, ItemClaim as Z, MediatedReplayRecordCodec as _, requireDigest as _t, PreparedInvocationHeader as a, EffectAttemptCodec as at, createInvocationMemoryState as b, requireNullableDate as bt, InvocationProtectedOperationPort as c, InvocationContinuationCodec as ct, ReplayOperationInvocationPort as d, InvocationError as dt, AuditRecordCodec as et, CanonicalBatchInvocationPort as f, invocationError as ft, MediatedReplayRecord as g, requireDate as gt, createInvocationMediationMemoryState as h, requireCanonicalText as ht, PreparedInvocationCodec as i, EffectAttempt as it, MemoryDetachedEffectTarget as j, AttemptCancellationObservation as k, InvocationPlacementPin as l, Approval as lt, cloneInvocationMediationMemoryState as m, requireArray as mt, AlarmReconciliationDriver as n, validateAuditAppend as nt, PreparedItem as o, AuthorityAdmissionReference as ot, MemoryInvocationMediationPersistence as p, immutableReference as pt, DetachedEffectCancellationOutcome as q, PreparedInvocation as r, validateStoredAuditLinkage as rt, InvocationPublicationDrainer as s, InvocationContinuation as st, InvocationReconciler as t, auditEvidenceIdentity as tt, OperationPin as u, ApprovalCodec as ut, MemoryInvocationPersistence as v, requireExactObject as vt, terminalBatchOutcome as w, requireString as wt, InvocationLedger as x, requireNullableString as xt, cloneInvocationMemoryState as y, requireNonnegativeInteger as yt, MemoryDetachedEffectExecutionPersistence as z };

//# sourceMappingURL=invocations-Cpv8tzSW.js.map