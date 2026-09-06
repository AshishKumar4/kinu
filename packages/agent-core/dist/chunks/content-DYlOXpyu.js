import { M as hasExactJsonKeys, T as compareCanonicalText, _ as ContentRef, f as RecordCodec, j as TextId, k as AgentCoreError, w as canonicalTupleKey, y as Digest } from "./core-BjYGo1CC.js";
import { d as ActorRef, f as ActorId, o as requireSynchronousResult } from "./actors-DJsP1nFM.js";
import { z as TenantId } from "./identity-CoqhjOFj.js";
//#region src/content/media.ts
var MAX_MEDIA_TYPE_LENGTH = 255;
var MediaHint = class {
	mediaType;
	constructor(mediaType) {
		this.mediaType = mediaType;
		if (mediaType.trim().length === 0 || mediaType.length > MAX_MEDIA_TYPE_LENGTH) throw new TypeError(`Media type must not be blank or exceed ${MAX_MEDIA_TYPE_LENGTH} characters`);
		Object.freeze(this);
	}
};
//#endregion
//#region src/content/range.ts
var ByteRange = class ByteRange {
	offset;
	length;
	static #whole = new ByteRange(0, void 0);
	constructor(offset, length) {
		this.offset = offset;
		this.length = length;
		if (new.target !== ByteRange) throw new TypeError("ByteRange cannot be subclassed");
		Object.freeze(this);
	}
	static all() {
		return ByteRange.#whole;
	}
	static from(offset) {
		return new ByteRange(requireNonnegative(offset, "Byte range offset"), void 0);
	}
	static slice(offset, length) {
		const validOffset = requireNonnegative(offset, "Byte range offset");
		const validLength = requireNonnegative(length, "Byte range length");
		requireSafeRangeEnd(validOffset + validLength);
		return new ByteRange(validOffset, validLength);
	}
	/**
	* The exact window this range names inside content of `size` bytes, refused rather
	* than clamped when it reaches past them. A store that carries its content in memory
	* has no use for this beyond `read`, but one that pushes a range down to a platform
	* that answers ranges itself — an R2 ranged `get`, an HTTP `Range` — needs the window
	* as data before it asks, and taking it from here is what keeps one refusal rule for
	* every substrate: the platform is only ever asked for bytes this range has already
	* proved are inside the content, so a platform that clamps an over-long range never
	* gets the chance to answer with fewer bytes than the caller asked for.
	*/
	resolve(size) {
		const total = requireNonnegative(size, "Content size");
		const end = this.length === void 0 ? total : this.offset + this.length;
		requireRange(this.offset <= total && end <= total);
		return {
			offset: this.offset,
			length: end - this.offset
		};
	}
	read(bytes) {
		const window = this.resolve(bytes.byteLength);
		return bytes.slice(window.offset, window.offset + window.length);
	}
};
Object.freeze(ByteRange.prototype);
function requireNonnegative(value, name) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
	return value;
}
function requireSafeRangeEnd(end) {
	if (!Number.isSafeInteger(end)) throw new TypeError("Byte range end must be a safe integer");
}
function requireRange(condition) {
	if (!condition) throw new AgentCoreError("content.invalid-range", "Byte range exceeds content bounds");
}
//#endregion
//#region src/content/retention.ts
var MAX_OWNER_KEY_LENGTH = 512;
var ContentOwnerEdgeCodec = class extends RecordCodec {
	constructor() {
		super([
			ContentOwnerEdge,
			ActorRef,
			TextId,
			ContentRef,
			Digest,
			ActorId,
			TenantId
		], "content.owner-edge", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(edge) {
		return {
			actor: {
				id: edge.actor.id.value,
				kind: edge.actor.kind
			},
			ownerKey: edge.ownerKey,
			ref: edge.ref.value,
			tenant: edge.tenant.value
		};
	}
	decodePayload(payload, _version) {
		const actor = isObject$2(payload) ? payload["actor"] : void 0;
		if (!isObject$2(payload) || !hasExactJsonKeys(payload, [
			"actor",
			"ownerKey",
			"ref",
			"tenant"
		]) || !isObject$2(actor) || !hasExactJsonKeys(actor, ["id", "kind"]) || !isContentString$1(actor["id"]) || !isActorKind$1(actor["kind"]) || !isContentString$1(payload["ownerKey"]) || !isContentString$1(payload["ref"]) || !isContentString$1(payload["tenant"])) throw invalidEdge("Content owner edge payload is malformed");
		try {
			return new ContentOwnerEdge(new TenantId(payload["tenant"]), new ActorRef(actor["kind"], new ActorId(actor["id"])), payload["ownerKey"], new ContentRef(payload["ref"]));
		} catch (error) {
			throw invalidEdge(`Content owner edge payload is invalid: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
};
function isContentString$1(value) {
	return typeof value === "string";
}
var ContentOwnerEdge = class ContentOwnerEdge {
	tenant;
	actor;
	ownerKey;
	ref;
	static get codec() {
		return contentOwnerEdgeCodecInstance;
	}
	constructor(tenant, actor, ownerKey, ref) {
		this.tenant = tenant;
		this.actor = actor;
		this.ownerKey = ownerKey;
		this.ref = ref;
		if (ownerKey.trim().length === 0 || ownerKey.length > MAX_OWNER_KEY_LENGTH) throw new TypeError(`Content owner key must not be blank or exceed ${MAX_OWNER_KEY_LENGTH} characters`);
		Object.freeze(this);
	}
	static encode(edge) {
		return ContentOwnerEdge.codec.encode(edge);
	}
	static decode(bytes) {
		return ContentOwnerEdge.codec.decode(bytes);
	}
	equals(other) {
		return this.tenant.equals(other.tenant) && this.actor.equals(other.actor) && this.ownerKey === other.ownerKey && this.ref.equals(other.ref);
	}
};
var contentOwnerEdgeCodecInstance = new ContentOwnerEdgeCodec();
/**
* The namespace one record kind's owner keys share. A store verifies its whole custody
* against exactly the namespaces of the kinds it owns, and the encoded tuple below always
* begins with the kind, so this prefix reaches every key of one kind and no key of another.
*/
function contentOwnerNamespace(kind) {
	return canonicalTupleKey("record", [kind]).slice(0, -1) + ",";
}
/**
* The owner key one durable record's field holds its ContentRef under. It is the repo's
* injective composite-key idiom — one canonical JSON tuple of the kind, the record's own
* key, and the field — so no record identity or field name can collide with another's key
* by containing a separator, and one Actor's record families stay distinct inside the
* single custody namespace §8.4 gives it.
*
* The format changed once, from a hand-built `record:<kind>:<len>:<key>:<field>`
* concatenation to this tuple encoding, inside the same wave that introduced it and before
* any durable store shipped an owner edge written under the old shape. No migration is owed:
* the two builds never meet over one stored set, and the §8.3 declaration gate refuses the
* older build's records on activation rather than decoding them.
*/
function contentOwnerKey(kind, key, field) {
	return canonicalTupleKey("record", [
		kind,
		key,
		field
	]);
}
/**
* The one implementation of that seam: it derives each record's owner edges and reconciles
* them through a `ContentRetention`, so a store's write path and the collection sweep read
* the same custody state. Retention is idempotent, so re-registering an unchanged record is
* a no-op rather than a conflict, and a field whose ContentRef moved releases the old edge
* before it retains the new one — the swap the §8.4 custody contract requires.
*/
var ContentRecordCustody = class {
	retention;
	now;
	constructor(retention, now = () => /* @__PURE__ */ new Date()) {
		this.retention = retention;
		this.now = now;
		Object.freeze(this);
	}
	retain(transaction, record, previous) {
		const after = this.edges(record);
		const before = previous === void 0 ? [] : this.edges(previous);
		if (before.length === 0 && after.length === 0) return;
		const operationAt = this.operationTime();
		for (const edge of before) if (!after.some((candidate) => candidate.equals(edge))) this.retention.release(transaction, edge, operationAt);
		for (const edge of after) this.retention.retain(transaction, edge, operationAt);
	}
	release(transaction, record) {
		const edges = this.edges(record);
		if (edges.length === 0) return;
		const operationAt = this.operationTime();
		for (const edge of edges) this.retention.release(transaction, edge, operationAt);
	}
	edges(record) {
		return record.fields.map(({ field, ref }) => new ContentOwnerEdge(this.retention.tenant, this.retention.actor, contentOwnerKey(record.kind, record.key, field), ref));
	}
	operationTime() {
		return requireOperationTime(this.now(), "Content custody time");
	}
};
Object.freeze(ContentRecordCustody.prototype);
Object.freeze(ContentRecordCustody);
var ContentRetention = class {
	tenant;
	actor;
	constructor(tenant, actor) {
		this.tenant = tenant;
		this.actor = actor;
	}
	verifyExactNamespace(transaction, ownerKeyPrefixes, expected) {
		if (ownerKeyPrefixes.length === 0 || ownerKeyPrefixes.some((prefix) => prefix.length === 0)) throw new AgentCoreError("protocol.invalid-state", "Content owner namespace prefixes must be nonempty");
		const expectedByKey = /* @__PURE__ */ new Map();
		for (const edge of expected) {
			this.requireOwner(edge);
			if (!ownerKeyPrefixes.some((prefix) => edge.ownerKey.startsWith(prefix))) throw new AgentCoreError("protocol.invalid-state", "Expected content owner edge is outside its namespace");
			if (expectedByKey.has(edge.ownerKey)) throw new AgentCoreError("codec.invalid", "Expected content custody contains a duplicate owner key");
			expectedByKey.set(edge.ownerKey, edge);
		}
		const actual = this.listOwnerEdges(transaction).filter((edge) => ownerKeyPrefixes.some((prefix) => edge.ownerKey.startsWith(prefix)));
		if (actual.length !== expectedByKey.size) throw invalidCustody();
		const actualKeys = /* @__PURE__ */ new Set();
		for (const edge of actual) {
			if (actualKeys.has(edge.ownerKey)) throw new AgentCoreError("codec.invalid", "Stored content custody contains a duplicate owner key");
			actualKeys.add(edge.ownerKey);
			if (!expectedByKey.get(edge.ownerKey)?.equals(edge)) throw invalidCustody();
		}
	}
	requireOwner(edge) {
		if (!edge.tenant.equals(this.tenant)) throw new AgentCoreError("protocol.invalid-state", "Content owner edge belongs to a different Tenant");
		if (!edge.actor.equals(this.actor)) throw new AgentCoreError("protocol.invalid-state", "Content owner edge belongs to a different Actor");
	}
};
function requireCollectionTime(value) {
	return requireOperationTime(value, "Content collection time");
}
function requireOperationTime(value, name = "Content operation time") {
	const time = value.getTime();
	if (!Number.isSafeInteger(time) || time < 0) throw new TypeError(`${name} must be a valid non-negative Date`);
	return new Date(time);
}
function isObject$2(value) {
	return value !== null && value !== void 0 && !Array.isArray(value) && typeof value === "object";
}
function isActorKind$1(value) {
	return value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate";
}
function invalidEdge(message) {
	return new AgentCoreError("codec.invalid", message);
}
function invalidCustody() {
	return new AgentCoreError("codec.invalid", "Stored content custody does not match its owning records");
}
//#endregion
//#region src/content/stat.ts
var ContentStatRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			ContentStat,
			TextId,
			ContentRef,
			Digest,
			MediaHint
		], "content.stat", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(stat) {
		return {
			digest: stat.digest.value,
			mediaType: stat.hint?.mediaType ?? null,
			ref: stat.ref.value,
			size: stat.size
		};
	}
	decodePayload(payload, _version) {
		const size = isObject$1(payload) ? payload["size"] : void 0;
		if (!isObject$1(payload) || !hasExactJsonKeys(payload, [
			"digest",
			"mediaType",
			"ref",
			"size"
		]) || !isContentString(payload["digest"]) || payload["mediaType"] !== null && !isContentString(payload["mediaType"]) || !isContentString(payload["ref"]) || !isContentSize(size) || !Number.isSafeInteger(size)) throw new AgentCoreError("codec.invalid", "Content stat payload is malformed");
		try {
			const mediaType = payload["mediaType"];
			return new ContentStat(new ContentRef(payload["ref"]), new Digest(payload["digest"]), size, isContentString(mediaType) ? new MediaHint(mediaType) : void 0);
		} catch (error) {
			throw new AgentCoreError("codec.invalid", `Content stat payload is invalid: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
};
function isContentString(value) {
	return typeof value === "string";
}
function isContentSize(value) {
	return typeof value === "number";
}
var ContentStat = class ContentStat {
	ref;
	digest;
	size;
	static get codec() {
		return contentStatCodecInstance;
	}
	hint;
	constructor(ref, digest, size, hint) {
		this.ref = ref;
		this.digest = digest;
		this.size = size;
		if (!Number.isSafeInteger(size) || size < 0) throw new TypeError("Content size must be a non-negative safe integer");
		if (!ref.digest.equals(digest)) throw new TypeError("Content reference and digest must match");
		this.hint = hint === void 0 ? void 0 : new MediaHint(hint.mediaType);
		Object.freeze(this);
	}
	static encode(stat) {
		return ContentStat.codec.encode(stat);
	}
	static decode(bytes) {
		return ContentStat.codec.decode(bytes);
	}
};
var contentStatCodecInstance = new ContentStatRecordCodec();
function isObject$1(value) {
	return value !== null && !Array.isArray(value) && typeof value === "object";
}
//#endregion
//#region src/content/store.ts
var ContentStore = class {};
//#endregion
//#region src/content/transient.ts
var TransientContentLeaseStateCodec = class extends RecordCodec {
	constructor() {
		super([
			TransientContentLeaseState,
			ActorRef,
			TextId,
			ContentRef,
			Digest,
			ActorId,
			TenantId
		], "content.transient-lease", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(lease) {
		return {
			acquiredAt: lease.acquiredAt.getTime(),
			actor: {
				id: lease.actor.id.value,
				kind: lease.actor.kind
			},
			closedAt: lease.closedAt?.getTime() ?? null,
			digest: lease.digest.value,
			envelopeDigest: lease.envelopeDigest.value,
			expiresAt: lease.expiresAt.getTime(),
			ref: lease.ref.value,
			tenant: lease.tenant.value
		};
	}
	decodePayload(payload, _version) {
		const actor = isObject(payload) ? payload["actor"] : void 0;
		if (!isObject(payload) || !hasExactJsonKeys(payload, [
			"acquiredAt",
			"actor",
			"closedAt",
			"digest",
			"envelopeDigest",
			"expiresAt",
			"ref",
			"tenant"
		]) || !isObject(actor) || !hasExactJsonKeys(actor, ["id", "kind"]) || !isLeaseString(actor["id"]) || !isActorKind(actor["kind"]) || !isLeaseTime(payload["acquiredAt"]) || payload["closedAt"] !== null && !isLeaseTime(payload["closedAt"]) || !isLeaseString(payload["digest"]) || !isLeaseString(payload["envelopeDigest"]) || !isLeaseTime(payload["expiresAt"]) || !isLeaseString(payload["ref"]) || !isLeaseString(payload["tenant"])) throw corruptLease("Transient content lease payload is malformed");
		try {
			return new TransientContentLeaseState(new TenantId(payload["tenant"]), new ActorRef(actor["kind"], new ActorId(actor["id"])), new Digest(payload["envelopeDigest"]), new ContentRef(payload["ref"]), new Digest(payload["digest"]), new Date(payload["acquiredAt"]), new Date(payload["expiresAt"]), payload["closedAt"] === null ? void 0 : new Date(payload["closedAt"]));
		} catch (error) {
			throw corruptLease(`Transient content lease payload is invalid: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
};
function isLeaseString(value) {
	return typeof value === "string";
}
function isLeaseTime(value) {
	return typeof value === "number";
}
var TransientContentLeaseState = class TransientContentLeaseState {
	tenant;
	actor;
	envelopeDigest;
	ref;
	digest;
	static get codec() {
		return transientContentLeaseStateCodecInstance;
	}
	#acquiredAt;
	#expiresAt;
	#closedAt;
	constructor(tenant, actor, envelopeDigest, ref, digest, acquiredAt, expiresAt, closedAt) {
		this.tenant = tenant;
		this.actor = actor;
		this.envelopeDigest = envelopeDigest;
		this.ref = ref;
		this.digest = digest;
		this.#acquiredAt = requireOperationTime(acquiredAt, "Lease acquisition time").getTime();
		this.#expiresAt = requireOperationTime(expiresAt, "Lease expiration time").getTime();
		this.#closedAt = closedAt === void 0 ? void 0 : requireOperationTime(closedAt, "Lease close time").getTime();
		if (this.#expiresAt <= this.#acquiredAt) throw new TypeError("Transient content lease expiration must follow acquisition");
		if (this.#closedAt !== void 0 && this.#closedAt < this.#acquiredAt) throw new TypeError("Transient content lease cannot close before acquisition");
		if (!ref.digest.equals(digest)) throw new TypeError("Transient content lease reference and digest must match");
		Object.freeze(this);
	}
	static encode(lease) {
		return TransientContentLeaseState.codec.encode(lease);
	}
	static decode(bytes) {
		return TransientContentLeaseState.codec.decode(bytes);
	}
	get acquiredAt() {
		return new Date(this.#acquiredAt);
	}
	get expiresAt() {
		return new Date(this.#expiresAt);
	}
	get closedAt() {
		return this.#closedAt === void 0 ? void 0 : new Date(this.#closedAt);
	}
	get inactiveAt() {
		if (this.#closedAt === void 0) return void 0;
		return new Date(Math.min(this.#closedAt, this.#expiresAt));
	}
	isActive(now) {
		const time = requireOperationTime(now, "Lease observation time").getTime();
		return this.#closedAt === void 0 && time < this.#expiresAt;
	}
	matches(binding) {
		return this.tenant.equals(binding.tenant) && this.actor.equals(binding.actor) && this.envelopeDigest.equals(binding.envelopeDigest) && this.ref.equals(binding.ref) && this.digest.equals(binding.digest) && this.#expiresAt === requireOperationTime(binding.expiresAt, "Lease binding expiration").getTime();
	}
	close(operationAt) {
		if (this.#closedAt !== void 0) return this;
		return new TransientContentLeaseState(this.tenant, this.actor, this.envelopeDigest, this.ref, this.digest, this.acquiredAt, this.expiresAt, operationAt);
	}
};
var transientContentLeaseStateCodecInstance = new TransientContentLeaseStateCodec();
var TransientContentLease = class {};
var TransientContentAccess = class {};
function isObject(value) {
	return value !== null && value !== void 0 && !Array.isArray(value) && typeof value === "object";
}
function isActorKind(value) {
	return value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate";
}
function corruptLease(message) {
	return new AgentCoreError("codec.invalid", message);
}
//#endregion
//#region src/content/memory.ts
var backends = /* @__PURE__ */ new WeakMap();
var transactionStates = /* @__PURE__ */ new WeakMap();
var activeTransactions = /* @__PURE__ */ new WeakSet();
var MemoryContentRetentionState = class MemoryContentRetentionState {
	constructor(tenant, actor) {
		transactionStates.set(this, {
			backend: emptyBackend({
				tenant,
				actor
			}),
			owner: void 0,
			active: true
		});
		Object.freeze(this);
	}
	static restore(tenant, actor, snapshot) {
		const backend = restoreBackend(snapshot);
		if (backend.binding === void 0 || !backend.binding.tenant.equals(tenant) || !backend.binding.actor.equals(actor)) throw corruptContent("Memory content snapshot belongs to a different Actor or Tenant");
		const state = new MemoryContentRetentionState(tenant, actor);
		transactionStates.set(state, {
			backend,
			owner: void 0,
			active: true
		});
		return state;
	}
	snapshot() {
		return snapshotBackend(requireTransactionState(this));
	}
	clone() {
		const backend = requireTransactionState(this);
		const binding = requireBinding(backend);
		return MemoryContentRetentionState.restore(binding.tenant, binding.actor, snapshotBackend(backend));
	}
};
var MemoryContentStore = class MemoryContentStore extends ContentStore {
	constructor(snapshot) {
		super();
		backends.set(this, snapshot === void 0 ? emptyBackend() : restoreBackend(snapshot));
	}
	static restore(snapshot) {
		return new MemoryContentStore(snapshot);
	}
	retention(tenant, actor) {
		bindBackend(backendFor(this), tenant, actor);
		return new MemoryContentRetention(this, tenant, actor);
	}
	transient(tenant, actor, now) {
		bindBackend(backendFor(this), tenant, actor);
		return new MemoryTransientContentAccess(this, tenant, actor, now);
	}
	transaction(operation, ..._guard) {
		if (activeTransactions.has(this)) throw invalidContentState("Nested Memory content transactions are not supported");
		activeTransactions.add(this);
		let transaction;
		try {
			const backend = backendFor(this);
			const binding = requireBinding(backend);
			transaction = MemoryContentRetentionState.restore(binding.tenant, binding.actor, snapshotBackend(backend));
			const restored = transactionStates.get(transaction);
			if (restored === void 0) throw corruptContent("Memory content transaction is unavailable");
			transactionStates.set(transaction, {
				backend: restored.backend,
				owner: this,
				active: true
			});
			const result = requireSynchronousResult(operation(transaction));
			const committed = restoreBackend(transaction.snapshot());
			requireSameBinding(committed, binding.tenant, binding.actor);
			backends.set(this, committed);
			return result;
		} finally {
			if (transaction !== void 0) {
				const completed = transactionStates.get(transaction);
				if (completed !== void 0) completed.active = false;
			}
			activeTransactions.delete(this);
		}
	}
	snapshot() {
		return snapshotBackend(backendFor(this));
	}
	async put(bytes, hint) {
		return insertMemoryContent(backendFor(this), bytes, hint);
	}
	async get(ref, range = ByteRange.all()) {
		const content = backendFor(this).content.get(ref.value);
		if (content === void 0) throw contentNotFound(ref);
		validateContent(content, ref);
		return range.read(content.bytes.slice()).slice();
	}
	async stat(ref) {
		const content = backendFor(this).content.get(ref.value);
		if (content === void 0) return void 0;
		validateContent(content, ref);
		return contentStat(ref, content);
	}
};
var MemoryContentRetention = class extends ContentRetention {
	owner;
	constructor(owner, tenant, actor) {
		super(tenant, actor);
		this.owner = owner;
		requireSameBinding(backendFor(owner), tenant, actor);
	}
	retain(transaction, edge, operationAtValue) {
		this.requireOwner(edge);
		requireOperationTime(operationAtValue);
		const state = this.requireState(transaction);
		const existingBytes = state.edges.get(edge.ownerKey);
		if (existingBytes !== void 0) {
			if (!decodeStoredEdge(existingBytes, edge.ownerKey, state).equals(edge)) throw ownerCollision(edge.ownerKey);
			return;
		}
		const content = state.content.get(edge.ref.value);
		if (content === void 0) throw contentNotFound(edge.ref);
		validateContent(content, edge.ref);
		state.edges.set(edge.ownerKey, ContentOwnerEdge.encode(edge));
		state.relations.set(edge.ref.value, null);
	}
	holds(transaction, ref) {
		return this.requireState(transaction).content.get(ref.value) !== void 0;
	}
	release(transaction, edge, operationAtValue) {
		this.requireOwner(edge);
		const operationAt = requireOperationTime(operationAtValue);
		const state = this.requireState(transaction);
		const existingBytes = state.edges.get(edge.ownerKey);
		if (existingBytes === void 0) return;
		if (!decodeStoredEdge(existingBytes, edge.ownerKey, state).equals(edge)) throw ownerCollision(edge.ownerKey);
		state.edges.delete(edge.ownerKey);
		if (!hasOwner(state, edge.ref.value)) {
			requireRelation(state, edge.ref);
			state.relations.set(edge.ref.value, operationAt.getTime());
		}
	}
	collect(transaction, policy, observedAtValue) {
		const state = this.requireState(transaction);
		const observedAt = requireCollectionTime(observedAtValue);
		validateBackend(state);
		const activeLeaseRefs = normalizeMemoryLeases(state, observedAt);
		const approved = [];
		for (const [value, unownedSince] of [...state.relations].sort(([left], [right]) => compareCanonicalText(left, right))) {
			if (unownedSince === null || hasOwner(state, value) || activeLeaseRefs.has(value)) continue;
			const ref = new ContentRef(value);
			const content = state.content.get(value);
			if (content === void 0) throw corruptContent("Related content is missing");
			if (policy.allowsCollection(transaction, {
				tenant: this.tenant,
				actor: this.actor,
				stat: contentStat(ref, content),
				unownedSince: new Date(unownedSince),
				observedAt: new Date(observedAt.getTime())
			}) === true) approved.push({
				ref,
				unownedSince
			});
		}
		const collected = [];
		for (const candidate of approved) {
			validateBackend(state);
			const active = normalizeMemoryLeases(state, observedAt);
			if (state.relations.get(candidate.ref.value) !== candidate.unownedSince || hasOwner(state, candidate.ref.value) || active.has(candidate.ref.value)) continue;
			deleteMemoryContent(state, candidate.ref);
			collected.push(candidate.ref);
		}
		return Object.freeze(collected);
	}
	listOwnerEdges(transaction) {
		const state = this.requireState(transaction);
		validateBackend(state);
		return Object.freeze([...state.edges.entries()].sort(([left], [right]) => compareCanonicalText(left, right)).map(([ownerKey, bytes]) => decodeStoredEdge(bytes, ownerKey, state)));
	}
	requireState(transaction) {
		const state = requireTransactionState(transaction, this.owner);
		requireSameBinding(state, this.tenant, this.actor);
		return state;
	}
};
var MemoryTransientContentAccess = class extends TransientContentAccess {
	store;
	tenant;
	actor;
	now;
	constructor(store, tenant, actor, now = () => /* @__PURE__ */ new Date()) {
		super();
		this.store = store;
		this.tenant = tenant;
		this.actor = actor;
		this.now = now;
		requireSameBinding(backendFor(store), tenant, actor);
	}
	async acquire(binding, bytes, hint) {
		this.requireLeaseBinding(binding);
		return this.store.transaction((transaction) => ({ lease: this.acquireInTransaction(transaction, binding, this.now(), bytes, hint) })).lease;
	}
	acquireInTransaction(transaction, binding, operationAtValue, bytes, hint) {
		this.requireLeaseBinding(binding);
		const state = this.requireState(transaction);
		const operationAt = requireOperationTime(operationAtValue, "Lease acquisition time");
		const existingBytes = state.leases.get(binding.envelopeDigest.value);
		let replaced;
		if (existingBytes !== void 0) {
			const existing = decodeMemoryLease(existingBytes, binding.envelopeDigest.value, state);
			if (existing.isActive(operationAt)) {
				if (!existing.matches(binding)) throw leaseCollision();
				if (bytes !== void 0) validateBindingBytes(binding, bytes);
				return this.lease(existing);
			}
			replaced = existing;
		}
		const candidate = new TransientContentLeaseState(this.tenant, this.actor, binding.envelopeDigest, binding.ref, binding.digest, operationAt, binding.expiresAt);
		const content = state.content.get(binding.ref.value);
		if (bytes === void 0) {
			if (content === void 0) return void 0;
			validateContent(content, binding.ref);
		} else {
			validateBindingBytes(binding, bytes);
			insertMemoryContent(state, bytes, hint);
		}
		const stored = state.content.get(binding.ref.value);
		if (stored === void 0) throw corruptContent("Leased content was not stored");
		validateContent(stored, binding.ref);
		if (replaced !== void 0 && !hasOwner(state, replaced.ref.value)) advanceUnownedSince(state, replaced.ref, inactiveBoundary(replaced, operationAt));
		const relation = state.relations.get(binding.ref.value);
		state.relations.set(binding.ref.value, hasOwner(state, binding.ref.value) ? null : relation === void 0 ? operationAt.getTime() : Math.max(requireTimestamp(relation), operationAt.getTime()));
		state.leases.set(binding.envelopeDigest.value, TransientContentLeaseState.encode(candidate));
		return this.lease(candidate);
	}
	readInTransaction(transaction, expected) {
		const state = this.requireState(transaction);
		const lease = this.requireGeneration(state, expected);
		const content = state.content.get(lease.ref.value);
		if (content === void 0) throw corruptContent("Leased content is missing");
		validateContent(content, lease.ref);
		return content.bytes.slice();
	}
	matchesInTransaction(transaction, expected, binding, now) {
		this.requireLeaseBinding(binding);
		const lease = this.requireGeneration(this.requireState(transaction), expected);
		return lease.matches(binding) && lease.isActive(now);
	}
	closeInTransaction(transaction, expected, operationAt) {
		const state = this.requireState(transaction);
		const lease = this.requireGeneration(state, expected);
		const closed = lease.close(operationAt);
		if (closed === lease) return;
		state.leases.set(lease.envelopeDigest.value, TransientContentLeaseState.encode(closed));
		if (!hasOwner(state, lease.ref.value)) advanceUnownedSince(state, lease.ref, inactiveBoundary(closed, closed.closedAt));
	}
	loadLease(state, key) {
		const bytes = state.leases.get(key.value);
		if (bytes === void 0) throw corruptContent("Transient content lease is missing");
		return decodeMemoryLease(bytes, key.value, state);
	}
	requireGeneration(state, expected) {
		const lease = this.loadLease(state, expected.envelopeDigest);
		if (!sameLeaseGeneration(lease, expected)) throw new AgentCoreError("protocol.invalid-state", "Transient content lease handle refers to a replaced generation");
		return lease;
	}
	lease(state) {
		return new MemoryTransientContentLease(this, this.store, state, this.now);
	}
	requireState(transaction) {
		const state = requireTransactionState(transaction, this.store);
		requireSameBinding(state, this.tenant, this.actor);
		return state;
	}
	requireLeaseBinding(binding) {
		if (!binding.tenant.equals(this.tenant)) throw invalidContentState("Transient content binding belongs to a different Tenant");
		if (!binding.actor.equals(this.actor)) throw invalidContentState("Transient content binding belongs to a different Actor");
	}
};
var MemoryTransientContentLease = class extends TransientContentLease {
	access;
	store;
	state;
	now;
	constructor(access, store, state, now) {
		super();
		this.access = access;
		this.store = store;
		this.state = state;
		this.now = now;
	}
	read() {
		return this.store.transaction((transaction) => this.access.readInTransaction(transaction, this.state));
	}
	matches(binding, now) {
		return this.store.transaction((transaction) => this.access.matchesInTransaction(transaction, this.state, binding, now));
	}
	async close() {
		this.store.transaction((transaction) => this.access.closeInTransaction(transaction, this.state, this.now()));
	}
};
function emptyBackend(binding) {
	return {
		content: /* @__PURE__ */ new Map(),
		edges: /* @__PURE__ */ new Map(),
		relations: /* @__PURE__ */ new Map(),
		leases: /* @__PURE__ */ new Map(),
		binding
	};
}
function backendFor(store) {
	const backend = backends.get(store);
	if (backend === void 0) throw corruptContent("Memory content backend is unavailable");
	return backend;
}
function requireTransactionState(state, owner) {
	const transaction = transactionStates.get(state);
	if (transaction === void 0 || !transaction.active) throw new AgentCoreError("actor.closed", "Memory content transaction is no longer active");
	if (owner !== void 0 && transaction.owner !== owner) throw invalidContentState("Memory content transaction belongs to a different store");
	return transaction.backend;
}
function bindBackend(backend, tenant, actor) {
	if (backend.binding !== void 0) {
		requireSameBinding(backend, tenant, actor);
		return;
	}
	backend.binding = {
		tenant,
		actor
	};
}
function requireBinding(backend) {
	if (backend.binding === void 0) throw invalidContentState("Memory content storage is not bound to an Actor and Tenant");
	return backend.binding;
}
function requireSameBinding(backend, tenant, actor) {
	const binding = requireBinding(backend);
	if (!binding.tenant.equals(tenant) || !binding.actor.equals(actor)) throw invalidContentState("Memory content storage is bound to a different Actor or Tenant");
}
function insertMemoryContent(backend, bytes, hint) {
	const detached = bytes.slice();
	const digest = Digest.sha256(detached);
	const ref = ContentRef.fromDigest(digest);
	const existing = backend.content.get(ref.value);
	if (existing === void 0) backend.content.set(ref.value, {
		bytes: detached,
		digest,
		hint: hint === void 0 ? void 0 : new MediaHint(hint.mediaType)
	});
	else validateContent(existing, ref, detached);
	return {
		ref,
		digest
	};
}
function snapshotBackend(backend) {
	validateBackend(backend);
	return Object.freeze({
		version: 1,
		binding: backend.binding === void 0 ? null : Object.freeze({
			tenant: backend.binding.tenant.value,
			actor: Object.freeze({
				kind: backend.binding.actor.kind,
				id: backend.binding.actor.id.value
			})
		}),
		content: Object.freeze([...backend.content.entries()].sort(([left], [right]) => compareCanonicalText(left, right)).map(([ref, content]) => Object.freeze({
			ref,
			digest: content.digest.value,
			bytes: content.bytes.slice(),
			mediaType: content.hint?.mediaType ?? null
		}))),
		edges: Object.freeze([...backend.edges.values()].sort(compareBytes).map((value) => value.slice())),
		relations: Object.freeze([...backend.relations.entries()].sort(([left], [right]) => compareCanonicalText(left, right)).map(([ref, unownedSince]) => Object.freeze({
			ref,
			unownedSince
		}))),
		leases: Object.freeze([...backend.leases.values()].sort(compareBytes).map((value) => value.slice()))
	});
}
function restoreBackend(snapshot) {
	try {
		if (!isContentSnapshotObject(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.content) || !Array.isArray(snapshot.edges) || !Array.isArray(snapshot.relations) || !Array.isArray(snapshot.leases)) throw corruptContent("Memory content snapshot is malformed");
		const backend = emptyBackend(snapshot.binding === null ? void 0 : {
			tenant: new TenantId(snapshot.binding.tenant),
			actor: new ActorRef(snapshot.binding.actor.kind, new ActorId(snapshot.binding.actor.id))
		});
		for (const stored of snapshot.content) {
			const ref = new ContentRef(stored.ref);
			const content = {
				bytes: stored.bytes.slice(),
				digest: new Digest(stored.digest),
				hint: stored.mediaType === null ? void 0 : new MediaHint(stored.mediaType)
			};
			if (backend.content.has(ref.value)) throw corruptContent("Duplicate content snapshot row");
			validateContent(content, ref);
			backend.content.set(ref.value, content);
		}
		for (const bytes of snapshot.edges) {
			if (!(bytes instanceof Uint8Array)) throw corruptContent("Malformed owner edge snapshot");
			const edge = ContentOwnerEdge.decode(bytes.slice());
			requireSnapshotBinding(backend, edge.tenant, edge.actor);
			if (backend.edges.has(edge.ownerKey)) throw corruptContent("Duplicate owner edge snapshot");
			backend.edges.set(edge.ownerKey, ContentOwnerEdge.encode(edge));
		}
		for (const relation of snapshot.relations) {
			const ref = new ContentRef(relation.ref);
			if (backend.relations.has(ref.value) || relation.unownedSince !== null && !validTimestamp(relation.unownedSince)) throw corruptContent("Malformed content relation snapshot");
			backend.relations.set(ref.value, relation.unownedSince);
		}
		for (const bytes of snapshot.leases) {
			if (!(bytes instanceof Uint8Array)) throw corruptContent("Malformed lease snapshot");
			const lease = TransientContentLeaseState.decode(bytes.slice());
			requireSnapshotBinding(backend, lease.tenant, lease.actor);
			if (backend.leases.has(lease.envelopeDigest.value)) throw corruptContent("Duplicate lease snapshot");
			backend.leases.set(lease.envelopeDigest.value, TransientContentLeaseState.encode(lease));
		}
		validateBackend(backend);
		return backend;
	} catch (error) {
		if (error instanceof AgentCoreError) throw error;
		throw corruptContent("Memory content snapshot is malformed");
	}
}
function isContentSnapshotObject(value) {
	return value !== null && typeof value === "object";
}
function validateBackend(backend) {
	if (backend.edges.size > 0 || backend.relations.size > 0 || backend.leases.size > 0) requireBinding(backend);
	for (const [value, content] of backend.content) validateContent(content, new ContentRef(value));
	for (const [ownerKey, bytes] of backend.edges) {
		const edge = decodeStoredEdge(bytes, ownerKey, backend);
		if (!backend.content.has(edge.ref.value) || backend.relations.get(edge.ref.value) !== null) throw corruptContent("Owned content relation is malformed");
	}
	for (const [value, unownedSince] of backend.relations) {
		new ContentRef(value);
		const owned = hasOwner(backend, value);
		if (!backend.content.has(value) || unownedSince !== null && !validTimestamp(unownedSince) || owned !== (unownedSince === null)) throw corruptContent("Content relation is malformed");
	}
	for (const [key, bytes] of backend.leases) decodeMemoryLease(bytes, key, backend);
}
function decodeStoredEdge(bytes, ownerKey, backend) {
	const edge = ContentOwnerEdge.decode(bytes.slice());
	requireSnapshotBinding(backend, edge.tenant, edge.actor);
	if (edge.ownerKey !== ownerKey) throw corruptContent("Owner edge does not match its key");
	return edge;
}
function decodeMemoryLease(bytes, key, backend) {
	const lease = TransientContentLeaseState.decode(bytes.slice());
	requireSnapshotBinding(backend, lease.tenant, lease.actor);
	if (lease.envelopeDigest.value !== key || !backend.content.has(lease.ref.value) || !backend.relations.has(lease.ref.value)) throw corruptContent("Transient content lease storage is malformed");
	return lease;
}
function normalizeMemoryLeases(backend, observedAt) {
	const active = /* @__PURE__ */ new Set();
	for (const [key, bytes] of backend.leases) {
		const lease = decodeMemoryLease(bytes, key, backend);
		if (lease.isActive(observedAt)) active.add(lease.ref.value);
		else if (!hasOwner(backend, lease.ref.value)) advanceUnownedSince(backend, lease.ref, inactiveBoundary(lease, observedAt));
	}
	return active;
}
function inactiveBoundary(lease, observedAt) {
	const closedAt = lease.closedAt;
	if (closedAt !== void 0) return new Date(Math.min(closedAt.getTime(), lease.expiresAt.getTime()));
	if (lease.isActive(observedAt)) throw corruptContent("Active lease has no inactive boundary");
	return lease.expiresAt;
}
function advanceUnownedSince(backend, ref, boundary) {
	const current = requireRelation(backend, ref);
	if (current === null) {
		if (hasOwner(backend, ref.value)) return;
		throw corruptContent("Unowned content has an owned relation");
	}
	backend.relations.set(ref.value, Math.max(current, boundary.getTime()));
}
function requireRelation(backend, ref) {
	const relation = backend.relations.get(ref.value);
	if (relation === void 0) throw corruptContent("Authenticated content relation is missing");
	return relation;
}
function hasOwner(backend, ref) {
	for (const [ownerKey, bytes] of backend.edges) if (decodeStoredEdge(bytes, ownerKey, backend).ref.value === ref) return true;
	return false;
}
function deleteMemoryContent(backend, ref) {
	const leaseKeys = [];
	for (const [key, bytes] of backend.leases) if (decodeMemoryLease(bytes, key, backend).ref.equals(ref)) leaseKeys.push(key);
	for (const key of leaseKeys) backend.leases.delete(key);
	backend.relations.delete(ref.value);
	backend.content.delete(ref.value);
}
function validateBindingBytes(binding, bytes) {
	const digest = Digest.sha256(bytes);
	if (!binding.ref.digest.equals(binding.digest) || !binding.digest.equals(digest)) throw new AgentCoreError("codec.invalid", "Transient content binding does not match bytes");
}
function requireSnapshotBinding(backend, tenant, actor) {
	try {
		requireSameBinding(backend, tenant, actor);
	} catch {
		throw corruptContent("Stored content state has foreign Actor or Tenant ownership");
	}
}
function contentStat(ref, content) {
	return new ContentStat(ref, content.digest, content.bytes.byteLength, content.hint);
}
function validateContent(content, expectedRef, expectedBytes) {
	const recomputed = Digest.sha256(content.bytes);
	if (!expectedRef.digest.equals(content.digest) || !content.digest.equals(recomputed) || expectedBytes !== void 0 && !equalBytes(content.bytes, expectedBytes)) throw corruptContent();
}
function requireTimestamp(value) {
	if (value === null || !validTimestamp(value)) throw corruptContent("Unowned timestamp is malformed");
	return value;
}
function validTimestamp(value) {
	return Number.isSafeInteger(value) && value >= 0;
}
function compareBytes(left, right) {
	return Buffer.compare(left, right);
}
function equalBytes(left, right) {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
function ownerCollision(ownerKey) {
	return contentCollision(`Content owner key is already retained: ${ownerKey}`);
}
function leaseCollision() {
	return contentCollision("Active transient lease key is bound to different content");
}
function sameLeaseGeneration(left, right) {
	return left.tenant.equals(right.tenant) && left.actor.equals(right.actor) && left.envelopeDigest.equals(right.envelopeDigest) && left.ref.equals(right.ref) && left.digest.equals(right.digest) && left.acquiredAt.getTime() === right.acquiredAt.getTime() && left.expiresAt.getTime() === right.expiresAt.getTime();
}
function contentCollision(message) {
	return invalidContentState(message);
}
function invalidContentState(message) {
	return new AgentCoreError("protocol.invalid-state", message);
}
function contentNotFound(ref) {
	return new AgentCoreError("content.not-found", `Content not found: ${ref.value}`);
}
function corruptContent(message = "Stored content or retention state is malformed") {
	return new AgentCoreError("codec.invalid", message);
}
//#endregion
export { ByteRange as _, TransientContentAccess as a, ContentStore as c, ContentRecordCustody as d, ContentRetention as f, requireOperationTime as g, requireCollectionTime as h, MemoryTransientContentAccess as i, ContentStat as l, contentOwnerNamespace as m, MemoryContentRetentionState as n, TransientContentLease as o, contentOwnerKey as p, MemoryContentStore as r, TransientContentLeaseState as s, MemoryContentRetention as t, ContentOwnerEdge as u, MediaHint as v };

//# sourceMappingURL=content-DYlOXpyu.js.map