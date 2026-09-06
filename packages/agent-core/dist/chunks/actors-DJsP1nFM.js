import { L as isObjectRecord, M as hasExactJsonKeys, N as hasExactKeys, P as isJsonObject, d as CodecDeclaration, f as RecordCodec, g as Revision, j as TextId, k as AgentCoreError, u as CodecCompatibility } from "./core-BjYGo1CC.js";
import { types } from "node:util";
//#region src/actors/id.ts
var exactActorIds = /* @__PURE__ */ new WeakSet();
var ActorId = class ActorId extends TextId {
	constructor(value) {
		super(value, "Actor ID");
		if (new.target === ActorId) exactActorIds.add(this);
		Object.freeze(this);
	}
};
function isExactActorId(value) {
	return isObjectRecord(value) && exactActorIds.has(value);
}
//#endregion
//#region src/actors/types.ts
var ActorRef = class {
	kind;
	id;
	constructor(kind, id) {
		if (!isActorKind$2(kind) || !isExactActorId(id)) throw new TypeError("Actor reference requires a valid kind and exact Actor ID");
		this.kind = kind;
		this.id = id;
		Object.freeze(this);
	}
	equals(other) {
		return this.kind === other.kind && this.id.equals(other.id);
	}
};
function isActorKind$2(value) {
	return value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate";
}
var ActorFence = class {
	actor;
	epoch;
	constructor(actor, epoch) {
		this.actor = actor;
		this.epoch = epoch;
		if (!Number.isSafeInteger(epoch) || epoch < 0) throw new TypeError("Actor fence epoch must be a non-negative safe integer");
		Object.freeze(this);
	}
	matches(actor, epoch) {
		return this.actor.equals(actor) && this.epoch === epoch;
	}
};
//#endregion
//#region src/actors/context.ts
function isActorActivationStore(store) {
	return "activateActor" in store && typeof store.activateActor === "function";
}
function createActorContext(actor, store) {
	validateActorContext(actor, store);
	return Object.freeze({
		actor,
		store
	});
}
function validateActorContext(actor, store) {
	if (!(actor instanceof ActorRef)) throw new TypeError("Actor context requires an ActorRef");
	if (!isActorActivationStore(store)) throw new TypeError("Actor context requires atomic activation storage");
}
//#endregion
//#region src/actors/fence.ts
/**
* The stable Actor bootstrap carrier. It intentionally stays at 1.0 and names only the
* fields needed to construct and fence an Actor. Codec declarations live in the separate
* store carrier that Actor reads before it starts its record-owning work: putting them here
* would make the very record needed for construction unreadable on a rollback.
*/
var ActorRecoveryStateCodec = class extends RecordCodec {
	constructor() {
		super([
			ActorRecoveryState,
			ActorRef,
			TextId,
			ActorId
		], "actor.recovery-state", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(state) {
		return {
			actor: {
				kind: state.actor.kind,
				id: state.actor.id.value
			},
			epoch: state.epoch,
			recoveries: state.recoveries
		};
	}
	decodePayload(payload) {
		if (!isActorRecoveryStatePayload(payload)) throw malformedRecoveryState();
		try {
			return new ActorRecoveryState(new ActorRef(payload.actor.kind, new ActorId(payload.actor.id)), payload.epoch, payload.recoveries);
		} catch {
			throw malformedRecoveryState();
		}
	}
};
var ActorRecoveryState = class ActorRecoveryState {
	actor;
	epoch;
	recoveries;
	static get codec() {
		return actorRecoveryStateCodecInstance;
	}
	constructor(actor, epoch, recoveries) {
		this.actor = actor;
		this.epoch = epoch;
		this.recoveries = recoveries;
		if (!Number.isSafeInteger(epoch) || epoch < 0) throw new TypeError("Actor recovery epoch must be a non-negative safe integer");
		if (!Number.isSafeInteger(recoveries) || recoveries < 1) throw new TypeError("Actor recovery count must be a positive safe integer");
		Object.freeze(this);
	}
	static initial(actor) {
		return new ActorRecoveryState(actor, 0, 1);
	}
	static encode(state) {
		return ActorRecoveryState.codec.encode(state);
	}
	static decode(bytes) {
		return ActorRecoveryState.codec.decode(bytes);
	}
	get fence() {
		return new ActorFence(this.actor, this.epoch);
	}
	recover() {
		return new ActorRecoveryState(this.actor, increment(this.epoch, "Actor fence epoch"), increment(this.recoveries, "Actor recovery count"));
	}
	advance() {
		return new ActorRecoveryState(this.actor, increment(this.epoch, "Actor fence epoch"), this.recoveries);
	}
};
var actorRecoveryStateCodecInstance = new ActorRecoveryStateCodec();
function isActorRecoveryStatePayload(payload) {
	if (!isJsonObject(payload)) return false;
	const actor = payload["actor"];
	const epoch = payload["epoch"];
	const recoveries = payload["recoveries"];
	return hasExactJsonKeys(payload, [
		"actor",
		"epoch",
		"recoveries"
	]) && isActor(actor) && isFenceEpoch(epoch) && isRecoveryCount(recoveries);
}
function isActor(value) {
	if (!isJsonObject(value)) return false;
	return hasExactJsonKeys(value, ["kind", "id"]) && isActorKind$1(value["kind"]) && isActorIdValue(value["id"]);
}
function isFenceEpoch(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isRecoveryCount(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
function isActorIdValue(value) {
	return typeof value === "string";
}
function isActorKind$1(value) {
	return value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate";
}
function malformedRecoveryState() {
	return new AgentCoreError("codec.invalid", "Actor recovery state payload is malformed");
}
function increment(value, name) {
	if (value === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("actor.closed", `${name} is exhausted`);
	return value + 1;
}
//#endregion
//#region src/actors/store.ts
var ASYNC_TRANSACTION_MESSAGE = "Actor transaction callbacks must be synchronous";
var ACTOR_STATE_SNAPSHOT = Symbol("actor-state-snapshot");
var ActorActivation = class ActorActivation {
	kind;
	recovery;
	constructor(kind, recovery) {
		this.kind = kind;
		this.recovery = recovery;
		Object.freeze(this);
	}
	static created(recovery) {
		requireCreatedRecovery(recovery);
		return new ActorActivation("created", recovery);
	}
	static recovered(recovery) {
		requireRecoveredRecovery(recovery);
		return new ActorActivation("recovered", recovery);
	}
};
function requireCreatedRecovery(recovery) {
	if (recovery.epoch !== 0 || recovery.recoveries !== 1) throw new TypeError("Created Actor activation requires initial recovery state");
}
function requireRecoveredRecovery(recovery) {
	if (recovery.recoveries < 2) throw new TypeError("Recovered Actor activation requires recovered state");
}
var MemoryActorStore = class MemoryActorStore {
	clone;
	#value;
	#recovery;
	#recordSetDeclaration;
	#activeTransaction;
	#activeDraft;
	#activeRecovery;
	#activeRecordSetDeclaration;
	#activeActor;
	#actor;
	constructor(value, clone) {
		this.clone = clone;
		this.#value = copyDetached(value, clone);
	}
	static restore(snapshot, clone) {
		requireSnapshot(snapshot);
		const store = new MemoryActorStore(snapshot.state, clone);
		if (snapshot.actor === null) {
			if (snapshot.recoveryState !== null || snapshot.recordSetDeclaration !== void 0 && snapshot.recordSetDeclaration !== null) throw corruptSnapshot("Unbound Actor snapshots cannot contain bootstrap state");
			return store;
		}
		const actor = new ActorRef(snapshot.actor.kind, new ActorId(snapshot.actor.id));
		store.#actor = actor;
		if (snapshot.recordSetDeclaration !== void 0 && snapshot.recordSetDeclaration !== null) store.#recordSetDeclaration = snapshot.recordSetDeclaration.slice();
		if (snapshot.recoveryState !== null) {
			const recovery = ActorRecoveryState.codec.decode(snapshot.recoveryState.slice());
			if (!recovery.actor.equals(actor)) throw corruptSnapshot("Actor snapshot recovery state belongs to a different Actor");
			store.#recovery = recovery;
		}
		if (store.#recordSetDeclaration !== void 0 && store.#recovery === void 0) throw corruptSnapshot("Actor snapshot declaration requires recovery state");
		return store;
	}
	bindActor(actor) {
		const bound = this.#activeTransaction === void 0 ? this.#actor : this.#activeActor;
		if (bound !== void 0 && !bound.equals(actor)) throw new AgentCoreError("protocol.invalid-state", "An ActorStore cannot be shared by different Actors");
		if (this.#activeTransaction === void 0) this.#actor = actor;
		else this.#activeActor = actor;
	}
	activateActor(actor, start) {
		const existing = this.#actor !== void 0;
		return this.transaction((transaction) => {
			this.bindActor(actor);
			const previous = this.loadRecoveryState(transaction, actor);
			if (existing && previous === void 0) throw missingRecoveryState();
			if (!existing && previous !== void 0) throw corruptSnapshot("Unbound Actor storage cannot contain recovery state");
			const next = previous === void 0 ? ActorRecoveryState.initial(actor) : previous.recover();
			this.saveRecoveryState(transaction, next);
			requireSynchronousResult(start(transaction, previous === void 0 ? ActorActivation.created(next) : ActorActivation.recovered(next)));
			return next;
		});
	}
	transaction(operation, ..._guard) {
		if (this.#activeTransaction !== void 0) throw new AgentCoreError("protocol.invalid-state", "Nested actor transactions are not supported");
		const draft = copyDetached(this.#value, this.clone);
		const recoveryDraft = this.#recovery === void 0 ? void 0 : ActorRecoveryState.codec.decode(ActorRecoveryState.codec.encode(this.#recovery));
		const declarationDraft = this.#recordSetDeclaration?.slice();
		let active = true;
		const scope = new Proxy(draft, {
			defineProperty(target, property, descriptor) {
				requireActiveScope(active);
				return Reflect.defineProperty(target, property, descriptor);
			},
			deleteProperty(target, property) {
				requireActiveScope(active);
				return Reflect.deleteProperty(target, property);
			},
			get(target, property, receiver) {
				requireActiveScope(active);
				const member = inspectProperty(target, property);
				if (member.kind === "missing") return void 0;
				if (member.kind === "accessor") return member.descriptor.get?.call(receiver);
				return member.value;
			},
			getOwnPropertyDescriptor(target, property) {
				requireActiveScope(active);
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
			getPrototypeOf(target) {
				requireActiveScope(active);
				return Reflect.getPrototypeOf(target);
			},
			has(target, property) {
				requireActiveScope(active);
				return Reflect.has(target, property);
			},
			isExtensible(target) {
				requireActiveScope(active);
				return Reflect.isExtensible(target);
			},
			ownKeys(target) {
				requireActiveScope(active);
				return Reflect.ownKeys(target);
			},
			preventExtensions(target) {
				requireActiveScope(active);
				return Reflect.preventExtensions(target);
			},
			set(target, property, value, receiver) {
				requireActiveScope(active);
				return Reflect.set(target, property, value, receiver);
			},
			setPrototypeOf(target, prototype) {
				requireActiveScope(active);
				return Reflect.setPrototypeOf(target, prototype);
			}
		});
		this.#activeTransaction = scope;
		this.#activeDraft = draft;
		this.#activeRecovery = recoveryDraft;
		this.#activeRecordSetDeclaration = declarationDraft;
		this.#activeActor = this.#actor;
		try {
			const result = requireSynchronousResult(operation(scope));
			const committed = copyDetached(draft, this.clone);
			this.#value = committed;
			this.#recovery = this.#activeRecovery;
			this.#recordSetDeclaration = this.#activeRecordSetDeclaration;
			this.#actor = this.#activeActor;
			return result;
		} finally {
			this.#activeTransaction = void 0;
			this.#activeDraft = void 0;
			this.#activeRecovery = void 0;
			this.#activeRecordSetDeclaration = void 0;
			this.#activeActor = void 0;
			active = false;
		}
	}
	read(transaction, operation, ..._guard) {
		if (transaction !== this.#activeTransaction || this.#activeDraft === void 0) throw staleTransaction("Actor reads require the active transaction");
		return requireSynchronousResult(operation(readonlyView(copyDetached(this.#activeDraft, this.clone))));
	}
	loadRecoveryState(transaction, actor) {
		this.requireActor(transaction, actor);
		return this.#activeRecovery;
	}
	saveRecoveryState(transaction, state) {
		this.requireActor(transaction, state.actor);
		this.#activeRecovery = state;
	}
	loadRecordSetDeclaration(transaction, actor) {
		this.requireActor(transaction, actor);
		return this.#activeRecordSetDeclaration?.slice();
	}
	saveRecordSetDeclaration(transaction, actor, declaration) {
		this.requireActor(transaction, actor);
		if (!(declaration instanceof Uint8Array)) throw new AgentCoreError("codec.invalid", "Actor record set declaration must be bytes");
		this.#activeRecordSetDeclaration = declaration.slice();
	}
	snapshot() {
		const state = copyDetached(this.#value, this.clone);
		return Object.freeze({
			version: 2,
			state,
			actor: this.#actor === void 0 ? null : Object.freeze({
				kind: this.#actor.kind,
				id: this.#actor.id.value
			}),
			recoveryState: this.#recovery === void 0 ? null : ActorRecoveryState.codec.encode(this.#recovery).slice(),
			recordSetDeclaration: this.#recordSetDeclaration?.slice() ?? null
		});
	}
	requireActor(transaction, actor) {
		if (transaction !== this.#activeTransaction || this.#activeActor === void 0) throw staleTransaction("Actor recovery state requires an active transaction");
		if (!this.#activeActor.equals(actor)) throw new AgentCoreError("protocol.invalid-state", "Actor recovery state belongs to a different Actor");
	}
};
function requireSynchronousResult(result) {
	if (isThenableCandidate(result)) {
		let owner = result;
		while (owner !== null) {
			if (types.isProxy(owner) || Object.hasOwn(owner, "then")) {
				if (types.isPromise(result)) result.catch(noop$1);
				throw new TypeError(ASYNC_TRANSACTION_MESSAGE);
			}
			owner = Reflect.getPrototypeOf(owner);
		}
	}
	return result;
}
function isThenableCandidate(value) {
	return typeof value === "object" && value !== null || typeof value === "function";
}
function noop$1() {}
function requireSnapshot(value) {
	const legacy = isActorStateObject(value) && hasExactKeys(value, [
		"actor",
		"recoveryState",
		"state",
		"version"
	]) && value.version === 1;
	const current = isActorStateObject(value) && hasExactKeys(value, [
		"actor",
		"recordSetDeclaration",
		"recoveryState",
		"state",
		"version"
	]) && value.version === 2 && (value.recordSetDeclaration === null || value.recordSetDeclaration instanceof Uint8Array);
	if (!legacy && !current || !isActorStateObject(value.state) || !isSnapshotActor(value.actor) || value.recoveryState !== null && !(value.recoveryState instanceof Uint8Array)) throw corruptSnapshot("Memory Actor snapshot is malformed");
}
function isSnapshotActor(value) {
	return value === null || isActorStateObject(value) && hasExactKeys(value, ["id", "kind"]) && isActorId(value.id) && isActorKind(value.kind);
}
function isActorId(value) {
	return typeof value === "string";
}
function isActorKind(value) {
	return value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate";
}
function immutableRead() {
	throw new AgentCoreError("protocol.invalid-state", "Actor read views are immutable");
}
function requireActiveScope(active) {
	if (!active) throw new AgentCoreError("actor.closed", "Actor transaction is no longer active");
}
function staleTransaction(message) {
	return new AgentCoreError("actor.stale-callback", message);
}
function readonlyView(value) {
	return readonlyValue(value, {
		seen: /* @__PURE__ */ new WeakMap(),
		buffers: /* @__PURE__ */ new WeakMap()
	});
}
function readonlyValue(value, context) {
	if (!isActorStateObject(value)) return value;
	const previous = context.seen.get(value);
	let view;
	if (previous !== void 0) view = previous;
	else if (value instanceof Date) view = readonlyDate(value, context);
	else if (value instanceof Map) view = readonlyMap(value, context);
	else if (value instanceof Set) view = readonlySet(value, context);
	else if (value instanceof ArrayBuffer) view = readonlyArrayBuffer(value, context);
	else if (ArrayBuffer.isView(value)) view = readonlyArrayBufferView(value, context);
	else if (isImmutableLeaf(value)) {
		context.seen.set(value, value);
		view = value;
	} else if (value instanceof TextId) view = readonlyTextId(value, context);
	else {
		const prototype = Reflect.getPrototypeOf(value);
		view = prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null ? readonlyClass(value, context) : readonlyPlain(value, context);
	}
	return view;
}
function readonlyTextId(value, context) {
	const proxy = new Proxy(value, {
		defineProperty: immutableRead,
		deleteProperty: immutableRead,
		get(target, property) {
			if (property === "value") return target.value;
			if (property === "equals") return TextId.prototype.equals.bind(target);
			if (property === "toString") return TextId.prototype.toString.bind(target);
			const member = inspectProperty(target, property);
			if (member.kind === "missing") return void 0;
			if (member.kind === "accessor" || isFunctionValue(member.value)) return immutableRead();
			return readonlyValue(member.value, context);
		},
		set: immutableRead
	});
	context.seen.set(value, proxy);
	return proxy;
}
function readonlyPlain(value, context) {
	const prototype = Reflect.getPrototypeOf(value);
	const target = Array.isArray(value) ? arrayWithLength(value.length) : createActorStateTarget(prototype);
	const proxy = new Proxy(target, immutableHandler());
	context.seen.set(value, proxy);
	copyReadonlyProperties(value, target, context, Array.isArray(value));
	Object.freeze(target);
	return proxy;
}
function arrayWithLength(length) {
	const value = [];
	value.length = length;
	return value;
}
function immutableHandler() {
	return {
		defineProperty: immutableRead,
		deleteProperty: immutableRead,
		get(target, property) {
			const member = inspectProperty(target, property);
			if (member.kind === "accessor") return immutableRead();
			return member.kind === "data" ? member.value : void 0;
		},
		set: immutableRead
	};
}
function readonlyDate(value, context) {
	const proxy = new Proxy(value, {
		defineProperty: immutableRead,
		deleteProperty: immutableRead,
		get(target, property) {
			if (property === Symbol.toPrimitive) return (hint) => hint === "number" ? target.getTime() : hint === "string" ? target.toString() : target.toISOString();
			const member = inspectProperty(target, property);
			if (member.kind === "missing") return void 0;
			const accessed = member.kind === "accessor" ? member.descriptor.get?.call(target) : member.value;
			if (!isFunctionValue(accessed)) return accessed;
			return isStringProperty(property) && SAFE_DATE_MEMBERS.has(property) ? accessed.bind(target) : immutableRead;
		},
		set: immutableRead
	});
	context.seen.set(value, proxy);
	return proxy;
}
function readonlyClass(value, context) {
	const target = createActorStateTarget(Reflect.getPrototypeOf(value));
	const proxy = new Proxy(target, {
		defineProperty: immutableRead,
		deleteProperty: immutableRead,
		get(target, property) {
			const member = inspectProperty(target, property);
			if (member.kind === "accessor") return immutableRead();
			if (member.kind === "missing" || !isFunctionValue(member.value)) return member.kind === "data" ? member.value : void 0;
			return immutableRead;
		},
		set: immutableRead
	});
	context.seen.set(value, proxy);
	copyReadonlyProperties(value, target, context, false);
	Object.freeze(target);
	return proxy;
}
function copyReadonlyProperties(source, target, context, skipArrayLength) {
	for (const property of Reflect.ownKeys(source)) {
		if (skipArrayLength && property === "length") continue;
		const descriptor = Object.getOwnPropertyDescriptor(source, property);
		if (descriptor === void 0) throw new TypeError("Memory Actor state changed while creating a read view");
		const descriptorValue = "value" in descriptor ? descriptor.value : void 0;
		Object.defineProperty(target, property, "value" in descriptor ? {
			...descriptor,
			value: isFunctionValue(descriptorValue) ? immutableRead : readonlyValue(descriptorValue, context),
			writable: false
		} : descriptor);
	}
}
function createActorStateTarget(prototype) {
	return Object.create(prototype);
}
function readonlyMap(value, context) {
	const copy = /* @__PURE__ */ new Map();
	const proxy = new Proxy(copy, collectionHandler(/* @__PURE__ */ new Set([
		"clear",
		"delete",
		"forEach",
		"set",
		"valueOf"
	])));
	context.seen.set(value, proxy);
	for (const [key, entry] of value) copy.set(readonlyValue(key, context), readonlyValue(entry, context));
	return proxy;
}
function readonlySet(value, context) {
	const copy = /* @__PURE__ */ new Set();
	const proxy = new Proxy(copy, collectionHandler(/* @__PURE__ */ new Set([
		"add",
		"clear",
		"delete",
		"forEach",
		"valueOf"
	])));
	context.seen.set(value, proxy);
	for (const entry of value) copy.add(readonlyValue(entry, context));
	return proxy;
}
function collectionHandler(mutators) {
	return {
		defineProperty: immutableRead,
		deleteProperty: immutableRead,
		get(target, property) {
			if (isStringProperty(property) && mutators.has(property)) return immutableRead;
			const member = inspectProperty(target, property);
			if (member.kind === "missing") return void 0;
			const accessed = member.kind === "accessor" ? member.descriptor.get?.call(target) : member.value;
			return isFunctionValue(accessed) ? accessed.bind(target) : accessed;
		},
		set: immutableRead
	};
}
function readonlyArrayBuffer(value, context) {
	const copy = clonedBuffer(value, context);
	const proxy = new Proxy(copy, {
		defineProperty: immutableRead,
		deleteProperty: immutableRead,
		get(target, property) {
			const member = inspectProperty(target, property);
			if (member.kind === "missing") return void 0;
			const accessed = member.kind === "accessor" ? member.descriptor.get?.call(target) : member.value;
			if (!isFunctionValue(accessed)) return accessed;
			return property === "slice" ? accessed.bind(target) : immutableRead;
		},
		set: immutableRead
	});
	context.seen.set(value, proxy);
	return proxy;
}
function readonlyArrayBufferView(value, context) {
	const sourceBuffer = value.buffer;
	const copy = cloneView(value, clonedBuffer(sourceBuffer, context));
	const proxy = new Proxy(copy, {
		defineProperty: immutableRead,
		deleteProperty: immutableRead,
		get(target, property) {
			if (property === "buffer") return readonlyValue(sourceBuffer, context);
			const member = inspectProperty(target, property);
			if (member.kind === "missing") return void 0;
			const accessed = member.kind === "accessor" ? member.descriptor.get?.call(target) : member.value;
			if (!isFunctionValue(accessed)) return accessed;
			if (!isStringProperty(property)) return immutableRead;
			return (target instanceof DataView ? SAFE_DATA_VIEW_MEMBERS.has(property) : SAFE_TYPED_ARRAY_METHODS.has(property)) ? accessed.bind(target) : immutableRead;
		},
		set: immutableRead
	});
	context.seen.set(value, proxy);
	return proxy;
}
function clonedBuffer(value, context) {
	const previous = context.buffers.get(value);
	if (previous !== void 0) return previous;
	const copy = value.slice(0);
	context.buffers.set(value, copy);
	return copy;
}
function cloneView(value, buffer) {
	if (value instanceof DataView) return new DataView(buffer, value.byteOffset, value.byteLength);
	const constructor = value.constructor;
	const { BYTES_PER_ELEMENT } = value;
	return new constructor(buffer, value.byteOffset, value.byteLength / BYTES_PER_ELEMENT);
}
function corruptSnapshot(message) {
	return new AgentCoreError("codec.invalid", message);
}
function missingRecoveryState() {
	return new AgentCoreError("codec.invalid", "Existing Actor storage is missing recovery state");
}
function copyDetached(value, clone) {
	if (!isActorStateObject(value)) throw new TypeError("Memory Actor state must be an object");
	const sourceGraph = new ActorStateGraph(value);
	sourceGraph.validate();
	const copy = clone(value);
	if (!isActorStateObject(copy)) throw new TypeError("Memory Actor clones must return an object");
	const copyGraph = new ActorStateGraph(copy);
	copyGraph.validate();
	copyGraph.requireDetachedFrom(sourceGraph.mutableObjects());
	return copy;
}
function isImmutableLeaf(value) {
	return Revision.isExact(value);
}
var ActorStateGraph = class {
	root;
	constructor(root) {
		this.root = root;
	}
	mutableObjects() {
		const objects = /* @__PURE__ */ new Set();
		for (const value of this.values()) if (!isImmutableLeaf(value) && isActorStateObject(value)) objects.add(value);
		return objects;
	}
	requireDetachedFrom(sourceObjects) {
		for (const value of this.values()) {
			if (isImmutableLeaf(value) || !isActorStateObject(value)) continue;
			if (sourceObjects.has(value)) throw new TypeError("Memory Actor clones must detach all mutable state");
		}
	}
	validate() {
		for (const value of this.values()) {
			if (isFunctionValue(value)) throw new TypeError("Memory Actor state cannot contain functions");
			const SharedBuffer = globalThis.SharedArrayBuffer;
			if (SharedBuffer !== void 0 && (value instanceof SharedBuffer || ArrayBuffer.isView(value) && value.buffer instanceof SharedBuffer)) throw new TypeError("Memory Actor state cannot contain shared memory");
			if (!isActorStateObject(value)) continue;
			for (const property of Reflect.ownKeys(value)) {
				const descriptor = Object.getOwnPropertyDescriptor(value, property);
				if (descriptor !== void 0 && !("value" in descriptor)) throw new TypeError("Memory Actor state cannot contain accessor properties");
			}
			const prototype = Reflect.getPrototypeOf(value);
			if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null && !(value instanceof Date) && !(value instanceof TextId) && !(value instanceof Revision) && !(value instanceof Map) && !(value instanceof Set) && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
				if (!Object.isFrozen(value) || !isActorCloneOwnedState(value)) throw new TypeError("Memory Actor custom state objects must be frozen and clone-owned");
			}
		}
	}
	*values() {
		const expanded = /* @__PURE__ */ new Set();
		const pending = [this.root];
		while (pending.length > 0) {
			const value = pending.pop();
			if (isActorStateObject(value)) {
				if (expanded.has(value)) continue;
				expanded.add(value);
			}
			yield value;
			if (isImmutableLeaf(value) || !isActorStateObject(value)) continue;
			if (ArrayBuffer.isView(value)) pending.push(value.buffer);
			else if (value instanceof Map) for (const [key, entry] of value) pending.push(key, entry);
			else if (value instanceof Set) pending.push(...value);
			const ownsState = isActorCloneOwnedState(value);
			if (ownsState) pending.push(value[ACTOR_STATE_SNAPSHOT]());
			for (const property of Reflect.ownKeys(value)) {
				const descriptor = Object.getOwnPropertyDescriptor(value, property);
				if (descriptor === void 0 || !("value" in descriptor)) continue;
				if (property === ACTOR_STATE_SNAPSHOT && ownsState) continue;
				const propertyValue = descriptor.value;
				pending.push(propertyValue);
			}
		}
	}
};
function isActorStateObject(value) {
	return value !== null && typeof value === "object";
}
function isFunctionValue(value) {
	return typeof value === "function";
}
function isActorCloneOwnedState(value) {
	return isActorStateObject(value) && ACTOR_STATE_SNAPSHOT in value && typeof value[ACTOR_STATE_SNAPSHOT] === "function";
}
function inspectProperty(target, property) {
	let owner = target;
	while (owner !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, property);
		if (descriptor !== void 0) {
			if (!("value" in descriptor)) return {
				kind: "accessor",
				descriptor
			};
			return {
				kind: "data",
				value: descriptor.value
			};
		}
		owner = Reflect.getPrototypeOf(owner);
	}
	return { kind: "missing" };
}
function isStringProperty(value) {
	return typeof value === "string";
}
var SAFE_TYPED_ARRAY_METHODS = /* @__PURE__ */ new Set([
	"at",
	"entries",
	"includes",
	"indexOf",
	"join",
	"keys",
	"lastIndexOf",
	"slice",
	"toLocaleString",
	"toString",
	"values"
]);
/**
* The `Date` members a read view may hand out, and the `DataView` members it may bind.
*
* Both were `startsWith("set")` and `startsWith("get")` tests, which decided whether a
* member mutates by reading how it is spelled. That answer is right only because
* ECMA-262 happens to name every `Date` mutator `setX` and every `DataView` writer
* `setX`, which is a convention about the standard library rather than anything this
* codebase declares: a member added under another name — a host extension, an Annex B
* alias, a future `withX` — would be admitted by the prefix rule and would mutate the
* snapshot a read view exists to protect. Enumerating the members instead makes the
* decision a lookup in declared data and makes the unknown case fail closed. Annex B's
* `getYear` and `toGMTString` are named because they read; their `set` counterparts are
* absent because they write.
*/
var SAFE_DATE_MEMBERS = /* @__PURE__ */ new Set([
	"getDate",
	"getDay",
	"getFullYear",
	"getHours",
	"getMilliseconds",
	"getMinutes",
	"getMonth",
	"getSeconds",
	"getTime",
	"getTimezoneOffset",
	"getUTCDate",
	"getUTCDay",
	"getUTCFullYear",
	"getUTCHours",
	"getUTCMilliseconds",
	"getUTCMinutes",
	"getUTCMonth",
	"getUTCSeconds",
	"getYear",
	"toDateString",
	"toGMTString",
	"toISOString",
	"toJSON",
	"toLocaleDateString",
	"toLocaleString",
	"toLocaleTimeString",
	"toString",
	"toTimeString",
	"toUTCString",
	"valueOf"
]);
var SAFE_DATA_VIEW_MEMBERS = /* @__PURE__ */ new Set([
	"getBigInt64",
	"getBigUint64",
	"getFloat16",
	"getFloat32",
	"getFloat64",
	"getInt16",
	"getInt32",
	"getInt8",
	"getUint16",
	"getUint32",
	"getUint8"
]);
//#endregion
//#region src/actors/actor.ts
var ACTOR_COMMIT_UNKNOWN_ERROR_CODE = Object.freeze({
	requested: "actor.commit-unknown",
	fallback: "actor.closed"
});
var actorCommitUnknownErrors = /* @__PURE__ */ new WeakSet();
var ActorCommitUnknownError = class extends AgentCoreError {
	static codeDependency = ACTOR_COMMIT_UNKNOWN_ERROR_CODE;
	constructor(message = "The Actor transaction commit result is unknown") {
		super(ACTOR_COMMIT_UNKNOWN_ERROR_CODE.fallback, message);
		this.name = "ActorCommitUnknownError";
		actorCommitUnknownErrors.add(this);
	}
};
var Actor = class {
	#context;
	#mailbox = Promise.resolve();
	#closed = false;
	#closing = false;
	#closePromise;
	#fence;
	#compatibility = CodecCompatibility.compatible;
	#bootstrapFailure;
	/**
	* Subclasses declare only the record codecs they own. Actor unions the stable recovery
	* carrier itself, so no subclass can omit it or choose its version. The stored
	* declaration sits in a separate raw carrier that the store returns before `start`
	* decodes domain records; an incompatible or malformed future carrier therefore leaves
	* construction possible and refuses every operation instead.
	*/
	constructor(context, declaration, start) {
		this.#context = createActorContext(context.actor, context.store);
		const store = this.#context.store;
		const completeDeclaration = requireActorDeclaration(declaration);
		this.#fence = store.activateActor(context.actor, (transaction, activation) => {
			const carrier = store.loadRecordSetDeclaration(transaction, context.actor);
			let stored = CodecDeclaration.empty;
			if (carrier !== void 0) try {
				stored = CodecDeclaration.fromBytes(carrier);
			} catch (error) {
				if (!(error instanceof AgentCoreError)) throw error;
				this.#bootstrapFailure = error;
				return;
			}
			this.#compatibility = stored.compatibilityWith(completeDeclaration);
			this.#compatibility.admit(() => {
				if (!stored.equals(completeDeclaration)) store.saveRecordSetDeclaration(transaction, context.actor, CodecDeclaration.toBytes(completeDeclaration));
				requireSynchronousResult(start(transaction, activation));
			});
		}).fence;
	}
	get id() {
		return this.#context.actor.id;
	}
	get ref() {
		return this.#context.actor;
	}
	execute(command, ...guard) {
		return this.enqueueCommand(void 0, command, ...guard);
	}
	executeFenced(fence, command, ...guard) {
		return this.enqueueCommand(fence, command, ...guard);
	}
	currentFence() {
		return this.enqueue(() => {
			this.ensureActive();
			return this.mutate(void 0, () => this.#fence);
		});
	}
	close() {
		if (this.#closePromise !== void 0) return this.#closePromise;
		if (this.#closed) {
			this.#closePromise = Promise.resolve();
			return this.#closePromise;
		}
		this.#closing = true;
		this.#closePromise = this.enqueue(() => {
			if (this.#closed) return;
			try {
				this.advanceCurrentFence();
			} catch (error) {
				if (!isStaleFence(error)) throw error;
			} finally {
				this.#closed = true;
			}
		});
		return this.#closePromise;
	}
	advanceFence() {
		try {
			this.ensureAccepting();
		} catch (error) {
			return Promise.reject(error);
		}
		return this.enqueue(() => {
			this.ensureActive();
			this.advanceCurrentFence();
			return this.#fence;
		});
	}
	advanceCurrentFence() {
		const advanced = this.transact((transaction) => {
			const state = this.requireCurrentState(transaction).advance();
			this.#context.store.saveRecoveryState(transaction, state);
			return state.fence;
		});
		this.#fence = advanced;
	}
	mutate(expectedFence, operation, ..._guard) {
		const completed = this.transact((transaction) => {
			const state = this.requireCurrentState(transaction);
			if (expectedFence !== void 0 && !expectedFence.matches(this.ref, state.epoch)) throw staleFence();
			const result = requireSynchronousResult(operation(transaction));
			return {
				fence: state.fence,
				result
			};
		});
		this.#fence = completed.fence;
		return completed.result;
	}
	requireCurrentState(transaction) {
		const state = this.#context.store.loadRecoveryState(transaction, this.ref);
		if (state === void 0 || !this.#fence.matches(this.ref, state.epoch)) throw staleFence();
		return state;
	}
	enqueueCommand(fence, command, ...guard) {
		try {
			this.ensureAccepting();
		} catch (error) {
			return Promise.reject(error);
		}
		return this.enqueue(() => {
			this.ensureActive();
			return this.mutate(fence, command, ...guard);
		});
	}
	enqueue(operation) {
		const execution = this.#mailbox.then(operation);
		this.#mailbox = execution.then(noop, noop);
		return execution;
	}
	transact(operation, ...guard) {
		let operationCompleted = false;
		try {
			return this.#context.store.transaction((transaction) => {
				try {
					const result = operation(transaction);
					operationCompleted = true;
					return result;
				} catch (error) {
					if (isActorCommitUnknown(error)) throw new AgentCoreError("protocol.invalid-state", "Commit uncertainty cannot originate inside an Actor transaction");
					throw error;
				}
			}, ...guard);
		} catch (error) {
			if (operationCompleted && isActorCommitUnknown(error)) this.#closed = true;
			throw error;
		}
	}
	ensureAccepting() {
		if (this.#closed || this.#closing) throw new AgentCoreError("actor.closed", "Actor is closed");
	}
	ensureActive() {
		if (this.#closed) throw new AgentCoreError("actor.closed", "Actor is closed");
		if (this.#bootstrapFailure !== void 0) throw this.#bootstrapFailure;
		this.#compatibility.requireCompatible();
	}
};
function staleFence() {
	return new AgentCoreError("actor.stale-callback", "Actor command fence is stale");
}
function noop() {}
function isStaleFence(error) {
	return error instanceof AgentCoreError && error.code === "actor.stale-callback";
}
function isActorCommitUnknown(error) {
	return isObjectRecord(error) && actorCommitUnknownErrors.has(error);
}
/**
* The Actor's complete declaration, from the one a subclass owns. A subclass declaring the
* stable recovery carrier is refused rather than merged, because Actor owns that carrier's
* version and a subclass choosing it is the one way the bootstrap could go unreadable.
*/
function requireActorDeclaration(declaration) {
	if (declaration.versionOf(ActorRecoveryState.codec.kind) !== void 0) throw new TypeError("Actor subclasses must not declare the stable recovery carrier");
	return CodecDeclaration.of([ActorRecoveryState.codec, ...declaration.declared]);
}
//#endregion
export { MemoryActorStore as a, createActorContext as c, ActorRef as d, ActorId as f, ActorActivation as i, isActorActivationStore as l, ActorCommitUnknownError as n, requireSynchronousResult as o, ACTOR_STATE_SNAPSHOT as r, ActorRecoveryState as s, Actor as t, ActorFence as u };

//# sourceMappingURL=actors-DJsP1nFM.js.map