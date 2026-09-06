import { L as isObjectRecord, R as jsonDataParser, _ as ContentRef, f as RecordCodec, g as Revision, j as TextId, k as AgentCoreError } from "./core-BjYGo1CC.js";
//#region src/environments/data.ts
var parse = jsonDataParser((message) => new TypeError(message));
function requireInstance(value, constructor, name) {
	if (!(value instanceof constructor)) throw new TypeError(`${name} is invalid`);
}
function requireObject(value, name) {
	return parse.object(value, name);
}
function requireExact(object, keys, name) {
	parse.exact(object, keys, name, "has invalid fields");
}
function requireString(value, name) {
	return parse.string(value, name);
}
function requireSafeInteger(value, name) {
	return parse.safeInteger(value, name);
}
function requireOptionalString(value, name) {
	return parse.nullableString(value, name);
}
function increment(value, name) {
	if (value === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("protocol.invalid-state", `${name} is exhausted`);
	return value + 1;
}
function advanceRevision(revision, name) {
	if (revision.value === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("protocol.invalid-state", `${name} is exhausted`);
	return revision.next();
}
//#endregion
//#region src/environments/id.ts
var EnvironmentId = class extends TextId {
	constructor(value) {
		super(value, "Environment ID");
	}
};
var ProviderId = class extends TextId {
	constructor(value) {
		super(value, "Provider ID");
	}
};
var EnvironmentSessionId = class extends TextId {
	constructor(value) {
		super(value, "Environment session ID");
	}
};
var EnvironmentSnapshotId = class extends TextId {
	constructor(value) {
		super(value, "Environment snapshot ID");
	}
};
var PortExposureId = class extends TextId {
	constructor(value) {
		super(value, "Port exposure ID");
	}
};
//#endregion
//#region src/environments/session.ts
var EnvironmentSessionState = class {
	static get reserved() {
		return reservedSessionState;
	}
	static get opening() {
		return openingSessionState;
	}
	static get open() {
		return openSessionState;
	}
	static get lost() {
		return lostSessionState;
	}
	static get failed() {
		return failedSessionState;
	}
	static get closing() {
		return closingSessionState;
	}
	static get closed() {
		return closedSessionState;
	}
	beginOpen() {
		return this.invalid("open");
	}
	opened() {
		return this.invalid("complete open");
	}
	failOpen() {
		return this.invalid("fail open");
	}
	lost() {
		return this.invalid("mark lost");
	}
	beginClose() {
		return this.invalid("close");
	}
	closed() {
		return this.invalid("complete close");
	}
	assertUsable() {
		throw new AgentCoreError("environment.invalid-session", "Environment session is not open");
	}
	invalid(operation) {
		throw new AgentCoreError("environment.invalid-session", `Cannot ${operation} an Environment session in ${this.name} state`);
	}
};
var ReservedSessionState = class extends EnvironmentSessionState {
	name = "reserved";
	beginOpen() {
		return EnvironmentSessionState.opening;
	}
	beginClose() {
		return EnvironmentSessionState.closing;
	}
};
var OpeningSessionState = class extends EnvironmentSessionState {
	name = "opening";
	beginOpen() {
		return this;
	}
	opened() {
		return EnvironmentSessionState.open;
	}
	failOpen() {
		return EnvironmentSessionState.failed;
	}
	beginClose() {
		return EnvironmentSessionState.closing;
	}
};
var OpenSessionState = class extends EnvironmentSessionState {
	name = "open";
	beginOpen() {
		return this;
	}
	opened() {
		return this;
	}
	lost() {
		return EnvironmentSessionState.lost;
	}
	beginClose() {
		return EnvironmentSessionState.closing;
	}
	assertUsable() {}
};
var LostSessionState = class extends EnvironmentSessionState {
	name = "lost";
	lost() {
		return this;
	}
	beginClose() {
		return EnvironmentSessionState.closing;
	}
	assertUsable() {
		throw new AgentCoreError("environment.stale-session", "Environment session provider resource was lost");
	}
};
var FailedSessionState = class extends EnvironmentSessionState {
	name = "failed";
	failOpen() {
		return this;
	}
	beginClose() {
		return EnvironmentSessionState.closing;
	}
};
var ClosingSessionState = class extends EnvironmentSessionState {
	name = "closing";
	beginClose() {
		return this;
	}
	closed() {
		return EnvironmentSessionState.closed;
	}
};
var ClosedSessionState = class extends EnvironmentSessionState {
	name = "closed";
	beginClose() {
		return this;
	}
	closed() {
		return this;
	}
	assertUsable() {
		throw new AgentCoreError("environment.closed-session", "Environment session is closed");
	}
};
var reservedSessionState = freezeState(new ReservedSessionState());
var openingSessionState = freezeState(new OpeningSessionState());
var openSessionState = freezeState(new OpenSessionState());
var lostSessionState = freezeState(new LostSessionState());
var failedSessionState = freezeState(new FailedSessionState());
var closingSessionState = freezeState(new ClosingSessionState());
var closedSessionState = freezeState(new ClosedSessionState());
var EnvironmentSessionCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			EnvironmentSession,
			EnvironmentSessionState,
			Revision,
			TextId,
			EnvironmentSessionId,
			EnvironmentId,
			EnvironmentSnapshotId
		], "environment.session", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(session) {
		return {
			id: session.id.value,
			environmentId: session.environmentId.value,
			environmentRevision: session.environmentRevision.value,
			generation: session.generation,
			epoch: session.epoch,
			state: session.state.name,
			restoreFrom: session.restoreFrom?.value ?? null,
			recordRevision: session.recordRevision.value
		};
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "Environment session");
		requireExact(object, [
			"environmentId",
			"environmentRevision",
			"epoch",
			"generation",
			"id",
			"recordRevision",
			"restoreFrom",
			"state"
		], "Environment session");
		const restoreFrom = requireOptionalString(object["restoreFrom"], "Environment snapshot ID");
		return new EnvironmentSession(new EnvironmentSessionId(requireString(object["id"], "Environment session ID")), new EnvironmentId(requireString(object["environmentId"], "Environment ID")), new Revision(requireSafeInteger(object["environmentRevision"], "Environment revision")), requireSafeInteger(object["generation"], "Environment generation"), requireSafeInteger(object["epoch"], "Environment session epoch"), decodeSessionState(requireString(object["state"], "Environment session state")), restoreFrom === void 0 ? void 0 : new EnvironmentSnapshotId(restoreFrom), new Revision(requireSafeInteger(object["recordRevision"], "Environment session record revision")));
	}
};
var EnvironmentSessionCapability = class {
	environmentId;
	sessionId;
	environmentRevision;
	epoch;
	constructor(environmentId, sessionId, environmentRevision, epoch) {
		this.environmentId = environmentId;
		this.sessionId = sessionId;
		this.environmentRevision = environmentRevision;
		this.epoch = epoch;
		requireInstance(environmentId, EnvironmentId, "Environment ID");
		requireInstance(sessionId, EnvironmentSessionId, "Environment session ID");
		requireInstance(environmentRevision, Revision, "Environment revision");
		if (!Number.isSafeInteger(epoch) || epoch < 0) throw new TypeError("Environment session capability epoch must be a non-negative safe integer");
		Object.freeze(this);
	}
};
var EnvironmentSession = class EnvironmentSession {
	id;
	environmentId;
	environmentRevision;
	generation;
	epoch;
	state;
	restoreFrom;
	recordRevision;
	static get codec() {
		return environmentSessionCodecInstance;
	}
	constructor(id, environmentId, environmentRevision, generation, epoch, state, restoreFrom, recordRevision) {
		this.id = id;
		this.environmentId = environmentId;
		this.environmentRevision = environmentRevision;
		this.generation = generation;
		this.epoch = epoch;
		this.state = state;
		this.restoreFrom = restoreFrom;
		this.recordRevision = recordRevision;
		requireInstance(id, EnvironmentSessionId, "Environment session ID");
		requireInstance(environmentId, EnvironmentId, "Environment ID");
		requireInstance(environmentRevision, Revision, "Environment revision");
		requireInstance(state, EnvironmentSessionState, "Environment session state");
		if (restoreFrom !== void 0) requireInstance(restoreFrom, EnvironmentSnapshotId, "Environment restore snapshot ID");
		requireInstance(recordRevision, Revision, "Environment session record revision");
		if (!Number.isSafeInteger(generation) || generation < 0) throw new TypeError("Environment session generation must be a non-negative safe integer");
		if (!Number.isSafeInteger(epoch) || epoch < 0) throw new TypeError("Environment session epoch must be a non-negative safe integer");
		Object.freeze(this);
	}
	static encode(session) {
		return EnvironmentSession.codec.encode(session);
	}
	static decode(bytes) {
		return EnvironmentSession.codec.decode(bytes);
	}
	get capability() {
		return new EnvironmentSessionCapability(this.environmentId, this.id, this.environmentRevision, this.epoch);
	}
	beginOpen() {
		return this.transition(this.state.beginOpen());
	}
	opened() {
		return this.transition(this.state.opened());
	}
	failOpen() {
		return this.transition(this.state.failOpen());
	}
	lost() {
		const state = this.state.lost();
		if (state === this.state) return this;
		return new EnvironmentSession(this.id, this.environmentId, this.environmentRevision, this.generation, increment(this.epoch, "Environment session epoch"), state, this.restoreFrom, advanceRevision(this.recordRevision, "Environment session record revision"));
	}
	beginClose() {
		const state = this.state.beginClose();
		if (state === this.state) return this;
		return new EnvironmentSession(this.id, this.environmentId, this.environmentRevision, this.generation, increment(this.epoch, "Environment session epoch"), state, this.restoreFrom, advanceRevision(this.recordRevision, "Environment session record revision"));
	}
	closed() {
		return this.transition(this.state.closed());
	}
	assertUsable() {
		this.state.assertUsable();
	}
	transition(state) {
		if (state === this.state) return this;
		return new EnvironmentSession(this.id, this.environmentId, this.environmentRevision, this.generation, this.epoch, state, this.restoreFrom, advanceRevision(this.recordRevision, "Environment session record revision"));
	}
};
var environmentSessionCodecInstance = new EnvironmentSessionCodecV1();
function decodeSessionState(value) {
	switch (value) {
		case "reserved": return EnvironmentSessionState.reserved;
		case "opening": return EnvironmentSessionState.opening;
		case "open": return EnvironmentSessionState.open;
		case "lost": return EnvironmentSessionState.lost;
		case "failed": return EnvironmentSessionState.failed;
		case "closing": return EnvironmentSessionState.closing;
		case "closed": return EnvironmentSessionState.closed;
		default: throw new TypeError("Environment session state is invalid");
	}
}
function freezeState(state) {
	Object.freeze(state);
	return state;
}
//#endregion
//#region src/environments/provider.ts
var MAX_PROVIDER_VERSION_LENGTH = 128;
var ProviderDescriptor = class {
	id;
	version;
	configuration;
	constructor(id, version, configuration) {
		this.id = id;
		this.version = version;
		this.configuration = configuration;
		requireInstance(id, ProviderId, "Provider ID");
		requireInstance(configuration, ContentRef, "Provider configuration");
		requireProviderVersion(version);
		Object.freeze(this);
	}
	equals(other) {
		return this.id.equals(other.id) && this.version === other.version && this.configuration.equals(other.configuration);
	}
};
var ProviderActionOutcome = Object.freeze({
	succeeded: Object.freeze({ name: "succeeded" }),
	failed: Object.freeze({ name: "failed" }),
	indeterminate: Object.freeze({ name: "indeterminate" })
});
var ProviderResourceOutcome = Object.freeze({
	ready(value) {
		return Object.freeze({
			name: "ready",
			value
		});
	},
	absent: Object.freeze({ name: "absent" }),
	failed: Object.freeze({ name: "failed" }),
	indeterminate: Object.freeze({ name: "indeterminate" })
});
var ProviderReadyValueParser = class {
	static get contentRef() {
		return contentRefReadyValueParser;
	}
	static get liveSession() {
		return liveSessionReadyValueParser;
	}
	static get exposureUrl() {
		return stringReadyValueParser;
	}
};
var EnvironmentProvider = class {};
var EnvironmentProviderRegistry = class {};
function dataProperty(value, key) {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!isDataDescriptor(descriptor)) return void 0;
		const record = descriptor;
		return Object.freeze({
			value: record["value"],
			enumerable: record["enumerable"]
		});
	} catch {
		return;
	}
}
function isDataDescriptor(value) {
	return value !== void 0 && (value.enumerable === true || value.enumerable === false) && Object.hasOwn(value, "value") && value.get === void 0 && value.set === void 0;
}
function isObjectValueSource(source) {
	return isObjectRecord(source.value);
}
function isArrayValueSource(source) {
	return Array.isArray(source.value);
}
function isCleanupValueSource(source) {
	return typeof source.value === "function";
}
function isStringValueSource(source) {
	return typeof source.value === "string";
}
function isArrayLengthSource(source) {
	return typeof source.value === "number" && Number.isSafeInteger(source.value) && source.value >= 0;
}
var ContentRefReadyValueParser = class extends ProviderReadyValueParser {
	parse(source) {
		if (!(source.value instanceof ContentRef)) throw new TypeError("Content reference is invalid");
		return new ContentRef(source.value.value);
	}
};
var contentRefReadyValueParser = new ContentRefReadyValueParser();
var StringReadyValueParser = class extends ProviderReadyValueParser {
	parse(source) {
		if (!isStringValueSource(source)) throw new TypeError("Provider value must be a string");
		return source.value;
	}
};
var stringReadyValueParser = new StringReadyValueParser();
var liveSessionAdapters = /* @__PURE__ */ new WeakMap();
var LiveSessionReadyValueParser = class extends ProviderReadyValueParser {
	parse(source) {
		if (!isObjectValueSource(source)) throw new TypeError("Provider session must be an object");
		const existing = liveSessionAdapters.get(source.value);
		if (existing !== void 0) return existing;
		const childrenSource = dataProperty(source.value, "children");
		const releaseSource = dataProperty(source.value, "release");
		if (childrenSource === void 0 || releaseSource === void 0 || !isCleanupValueSource(releaseSource)) throw new TypeError("Provider session is malformed");
		const children = snapshotSessionChildren(childrenSource);
		if (children === void 0) throw new TypeError("Provider session children are malformed");
		const receiver = source;
		const release = releaseSource.value;
		const session = Object.freeze({
			children,
			release: () => invokeProviderCleanup(release, receiver)
		});
		liveSessionAdapters.set(receiver.value, session);
		return session;
	}
};
var liveSessionReadyValueParser = new LiveSessionReadyValueParser();
function snapshotSessionChildren(source) {
	if (!isArrayValueSource(source)) return void 0;
	const arraySource = source;
	try {
		const lengthSource = dataProperty(arraySource.value, "length");
		if (lengthSource === void 0 || !isArrayLengthSource(lengthSource)) return void 0;
		const length = lengthSource.value;
		const keys = Reflect.ownKeys(source.value);
		if (keys.length !== length + 1 || !keys.includes("length") || !Array.from({ length }, (_, index) => String(index)).every((key) => keys.includes(key))) return;
		const children = [];
		for (let index = 0; index < length; index += 1) {
			const childSource = dataProperty(arraySource.value, String(index));
			if (childSource === void 0 || !isObjectValueSource(childSource)) return void 0;
			const disposeSource = dataProperty(childSource.value, "dispose");
			if (disposeSource === void 0 || !isCleanupValueSource(disposeSource)) return void 0;
			const receiver = childSource;
			const dispose = disposeSource.value;
			children.push(Object.freeze({ dispose: () => invokeProviderCleanup(dispose, receiver) }));
		}
		return Object.freeze(children);
	} catch {
		return;
	}
}
function invokeProviderCleanup(operation, receiver) {
	return Promise.resolve(Function.prototype.call.call(operation, receiver.value)).then(() => void 0);
}
function requireProviderVersion(value) {
	try {
		if (value.trim().length > 0 && value.length <= MAX_PROVIDER_VERSION_LENGTH) return;
	} catch {}
	throw new TypeError(`Provider version must contain between 1 and ${MAX_PROVIDER_VERSION_LENGTH} characters`);
}
//#endregion
export { requireOptionalString as _, ProviderResourceOutcome as a, EnvironmentSessionId as c, ProviderId as d, advanceRevision as f, requireObject as g, requireInstance as h, ProviderDescriptor as i, EnvironmentSnapshotId as l, requireExact as m, EnvironmentProviderRegistry as n, EnvironmentSessionCapability as o, increment as p, ProviderActionOutcome as r, EnvironmentId as s, EnvironmentProvider as t, PortExposureId as u, requireSafeInteger as v, requireString as y };

//# sourceMappingURL=provider-DK9Ak8da.js.map