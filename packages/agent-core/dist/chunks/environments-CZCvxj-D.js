import { _ as ContentRef, f as RecordCodec, g as Revision, j as TextId, k as AgentCoreError, y as Digest } from "./core-BjYGo1CC.js";
import { _ as requireOptionalString, c as EnvironmentSessionId, d as ProviderId, f as advanceRevision, g as requireObject, h as requireInstance, i as ProviderDescriptor, l as EnvironmentSnapshotId, m as requireExact, p as increment, s as EnvironmentId, u as PortExposureId, v as requireSafeInteger, y as requireString } from "./provider-DK9Ak8da.js";
//#region src/environments/environment.ts
var EnvironmentCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			Environment,
			Revision,
			TextId,
			EnvironmentId
		], "environment.head", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(environment) {
		return {
			id: environment.id.value,
			activeRevision: environment.activeRevision.value,
			generation: environment.generation,
			recordRevision: environment.recordRevision.value
		};
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "Environment head");
		requireExact(object, [
			"activeRevision",
			"generation",
			"id",
			"recordRevision"
		], "Environment head");
		return new Environment(new EnvironmentId(requireString(object["id"], "Environment ID")), new Revision(requireSafeInteger(object["activeRevision"], "Environment active revision")), requireSafeInteger(object["generation"], "Environment generation"), new Revision(requireSafeInteger(object["recordRevision"], "Environment record revision")));
	}
};
var EnvironmentRevisionCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			EnvironmentRevisionRecord,
			Revision,
			TextId,
			ContentRef,
			Digest,
			EnvironmentId,
			ProviderId,
			ProviderDescriptor
		], "environment.revision", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(record) {
		return {
			environmentId: record.environmentId.value,
			revision: record.revision.value,
			generation: record.generation,
			provider: {
				id: record.provider.id.value,
				version: record.provider.version,
				configuration: record.provider.configuration.value
			}
		};
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "Environment revision");
		requireExact(object, [
			"environmentId",
			"generation",
			"provider",
			"revision"
		], "Environment revision");
		const provider = requireObject(object["provider"], "Environment provider");
		requireExact(provider, [
			"configuration",
			"id",
			"version"
		], "Environment provider");
		return new EnvironmentRevisionRecord(new EnvironmentId(requireString(object["environmentId"], "Environment ID")), new Revision(requireSafeInteger(object["revision"], "Environment revision")), requireSafeInteger(object["generation"], "Environment generation"), new ProviderDescriptor(new ProviderId(requireString(provider["id"], "Provider ID")), requireString(provider["version"], "Provider version"), new ContentRef(requireString(provider["configuration"], "Provider configuration"))));
	}
};
var Environment = class Environment {
	id;
	activeRevision;
	generation;
	recordRevision;
	static get codec() {
		return environmentCodecInstance;
	}
	constructor(id, activeRevision, generation, recordRevision) {
		this.id = id;
		this.activeRevision = activeRevision;
		this.generation = generation;
		this.recordRevision = recordRevision;
		requireInstance(id, EnvironmentId, "Environment ID");
		requireInstance(activeRevision, Revision, "Environment active revision");
		requireInstance(recordRevision, Revision, "Environment record revision");
		if (!Number.isSafeInteger(generation) || generation < 0) throw new TypeError("Environment generation must be a non-negative safe integer");
		Object.freeze(this);
	}
	static encode(environment) {
		return Environment.codec.encode(environment);
	}
	static decode(bytes) {
		return Environment.codec.decode(bytes);
	}
	rotate(revision) {
		const nextRevision = advanceRevision(this.activeRevision, "Environment revision");
		const nextGeneration = increment(this.generation, "Environment generation");
		if (!revision.environmentId.equals(this.id) || !revision.revision.equals(nextRevision) || revision.generation !== nextGeneration) throw new AgentCoreError("operation.invalid-input", "Environment rotation must advance the exact revision and generation");
		return new Environment(this.id, revision.revision, revision.generation, advanceRevision(this.recordRevision, "Environment record revision"));
	}
};
var environmentCodecInstance = new EnvironmentCodecV1();
var EnvironmentRevisionRecord = class EnvironmentRevisionRecord {
	environmentId;
	revision;
	generation;
	provider;
	static get codec() {
		return environmentRevisionRecordCodecInstance;
	}
	constructor(environmentId, revision, generation, provider) {
		this.environmentId = environmentId;
		this.revision = revision;
		this.generation = generation;
		this.provider = provider;
		requireInstance(environmentId, EnvironmentId, "Environment ID");
		requireInstance(revision, Revision, "Environment revision");
		requireInstance(provider, ProviderDescriptor, "Environment provider");
		if (!Number.isSafeInteger(generation) || generation < 0) throw new TypeError("Environment generation must be a non-negative safe integer");
		Object.freeze(this);
	}
	static encode(record) {
		return EnvironmentRevisionRecord.codec.encode(record);
	}
	static decode(bytes) {
		return EnvironmentRevisionRecord.codec.decode(bytes);
	}
};
var environmentRevisionRecordCodecInstance = new EnvironmentRevisionCodecV1();
//#endregion
//#region src/environments/exposure.ts
var MAX_PORT = 65535;
var PortExposureState = class {
	static get exposing() {
		return exposingPortState;
	}
	static get exposed() {
		return exposedPortState;
	}
	static get failed() {
		return failedPortState;
	}
	static get revoking() {
		return revokingPortState;
	}
	static get revoked() {
		return revokedPortState;
	}
	exposed() {
		return this.invalid("complete exposure");
	}
	fail() {
		return this.invalid("fail exposure");
	}
	beginRevoke() {
		return this.invalid("revoke");
	}
	revoked() {
		return this.invalid("complete revocation");
	}
	invalid(operation) {
		throw new AgentCoreError("environment.invalid-session", `Cannot ${operation} in ${this.name} port exposure state`);
	}
};
var ExposingPortState = class extends PortExposureState {
	name = "exposing";
	exposed() {
		return PortExposureState.exposed;
	}
	fail() {
		return PortExposureState.failed;
	}
	beginRevoke() {
		return PortExposureState.revoking;
	}
};
var ExposedPortState = class extends PortExposureState {
	name = "exposed";
	exposed() {
		return this;
	}
	beginRevoke() {
		return PortExposureState.revoking;
	}
};
var FailedPortState = class extends PortExposureState {
	name = "failed";
	fail() {
		return this;
	}
	beginRevoke() {
		return PortExposureState.revoking;
	}
};
var RevokingPortState = class extends PortExposureState {
	name = "revoking";
	beginRevoke() {
		return this;
	}
	revoked() {
		return PortExposureState.revoked;
	}
};
var RevokedPortState = class extends PortExposureState {
	name = "revoked";
	beginRevoke() {
		return this;
	}
	revoked() {
		return this;
	}
};
var exposingPortState = freezeState$1(new ExposingPortState());
var exposedPortState = freezeState$1(new ExposedPortState());
var failedPortState = freezeState$1(new FailedPortState());
var revokingPortState = freezeState$1(new RevokingPortState());
var revokedPortState = freezeState$1(new RevokedPortState());
var PortExposureCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			PortExposure,
			PortExposureState,
			Revision,
			TextId,
			PortExposureId,
			EnvironmentSessionId,
			EnvironmentId
		], "environment.port-exposure", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(exposure) {
		return {
			id: exposure.id.value,
			environmentId: exposure.environmentId.value,
			sessionId: exposure.sessionId.value,
			environmentRevision: exposure.environmentRevision.value,
			generation: exposure.generation,
			sessionEpoch: exposure.sessionEpoch,
			port: exposure.port,
			state: exposure.state.name,
			url: exposure.url ?? null,
			recordRevision: exposure.recordRevision.value
		};
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "Port exposure");
		requireExact(object, [
			"environmentId",
			"environmentRevision",
			"generation",
			"id",
			"port",
			"recordRevision",
			"sessionEpoch",
			"sessionId",
			"state",
			"url"
		], "Port exposure");
		return new PortExposure(new PortExposureId(requireString(object["id"], "Port exposure ID")), new EnvironmentId(requireString(object["environmentId"], "Environment ID")), new EnvironmentSessionId(requireString(object["sessionId"], "Environment session ID")), new Revision(requireSafeInteger(object["environmentRevision"], "Environment revision")), requireSafeInteger(object["generation"], "Environment generation"), requireSafeInteger(object["sessionEpoch"], "Environment session epoch"), requireSafeInteger(object["port"], "Port exposure port"), decodePortState(requireString(object["state"], "Port exposure state")), requireOptionalString(object["url"], "Port exposure URL"), new Revision(requireSafeInteger(object["recordRevision"], "Port exposure record revision")));
	}
};
var PortExposure = class PortExposure {
	id;
	environmentId;
	sessionId;
	environmentRevision;
	generation;
	sessionEpoch;
	port;
	state;
	url;
	recordRevision;
	static get codec() {
		return portExposureCodecInstance;
	}
	constructor(id, environmentId, sessionId, environmentRevision, generation, sessionEpoch, port, state, url, recordRevision) {
		this.id = id;
		this.environmentId = environmentId;
		this.sessionId = sessionId;
		this.environmentRevision = environmentRevision;
		this.generation = generation;
		this.sessionEpoch = sessionEpoch;
		this.port = port;
		this.state = state;
		this.url = url;
		this.recordRevision = recordRevision;
		requireInstance(id, PortExposureId, "Port exposure ID");
		requireInstance(environmentId, EnvironmentId, "Environment ID");
		requireInstance(sessionId, EnvironmentSessionId, "Environment session ID");
		requireInstance(environmentRevision, Revision, "Environment revision");
		requireInstance(state, PortExposureState, "Port exposure state");
		requireInstance(recordRevision, Revision, "Port exposure record revision");
		if (!Number.isSafeInteger(generation) || generation < 0) throw new TypeError("Port exposure generation must be a non-negative safe integer");
		if (!Number.isSafeInteger(sessionEpoch) || sessionEpoch < 0) throw new TypeError("Port exposure session epoch must be a non-negative safe integer");
		if (!Number.isSafeInteger(port) || port < 1 || port > MAX_PORT) throw new TypeError("Port exposure port must be between 1 and 65535");
		if (url !== void 0 && !isExposureUrl(url)) throw new TypeError("Port exposure URL must be a string");
		if (state.name === "exposed" && url === void 0 || state.name !== "exposed" && state.name !== "revoking" && url !== void 0) throw new TypeError("Only exposed or revoking ports may have a URL");
		if (url !== void 0) validatePublicUrl(url);
		Object.freeze(this);
	}
	static encode(exposure) {
		return PortExposure.codec.encode(exposure);
	}
	static decode(bytes) {
		return PortExposure.codec.decode(bytes);
	}
	exposed(url) {
		const state = this.state.exposed();
		if (state === this.state) return this;
		try {
			validatePublicUrl(url);
		} catch (error) {
			if (error instanceof TypeError) throw new AgentCoreError("operation.invalid-output", error.message);
			throw error;
		}
		return this.transition(state, url);
	}
	fail() {
		return this.transition(this.state.fail(), void 0);
	}
	beginRevoke() {
		return this.transition(this.state.beginRevoke(), this.url);
	}
	revoked() {
		return this.transition(this.state.revoked(), void 0);
	}
	transition(state, url) {
		if (state === this.state) return this;
		return new PortExposure(this.id, this.environmentId, this.sessionId, this.environmentRevision, this.generation, this.sessionEpoch, this.port, state, url, advanceRevision(this.recordRevision, "Port exposure record revision"));
	}
};
var portExposureCodecInstance = new PortExposureCodecV1();
function isExposureUrl(value) {
	return typeof value === "string";
}
function decodePortState(value) {
	switch (value) {
		case "exposing": return PortExposureState.exposing;
		case "exposed": return PortExposureState.exposed;
		case "failed": return PortExposureState.failed;
		case "revoking": return PortExposureState.revoking;
		case "revoked": return PortExposureState.revoked;
		default: throw new TypeError("Port exposure state is invalid");
	}
}
function validatePublicUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError("Port exposure URL must be absolute");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:" || url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) throw new TypeError("Port exposure URL must not contain credentials or bearer material");
}
function freezeState$1(state) {
	Object.freeze(state);
	return state;
}
//#endregion
//#region src/environments/snapshot.ts
var EnvironmentSnapshotState = class {
	static get creating() {
		return creatingSnapshotState;
	}
	static get ready() {
		return readySnapshotState;
	}
	static get failed() {
		return failedSnapshotState;
	}
	ready() {
		return this.invalid("complete");
	}
	fail() {
		return this.invalid("fail");
	}
	invalid(operation) {
		throw new AgentCoreError("environment.invalid-session", `Cannot ${operation} an Environment snapshot in ${this.name} state`);
	}
};
var CreatingSnapshotState = class extends EnvironmentSnapshotState {
	name = "creating";
	ready() {
		return EnvironmentSnapshotState.ready;
	}
	fail() {
		return EnvironmentSnapshotState.failed;
	}
};
var ReadySnapshotState = class extends EnvironmentSnapshotState {
	name = "ready";
	ready() {
		return this;
	}
};
var FailedSnapshotState = class extends EnvironmentSnapshotState {
	name = "failed";
	fail() {
		return this;
	}
};
var creatingSnapshotState = freezeState(new CreatingSnapshotState());
var readySnapshotState = freezeState(new ReadySnapshotState());
var failedSnapshotState = freezeState(new FailedSnapshotState());
var EnvironmentSnapshotCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			EnvironmentSnapshot,
			EnvironmentSnapshotState,
			Revision,
			TextId,
			ContentRef,
			Digest,
			EnvironmentSessionId,
			EnvironmentId,
			EnvironmentSnapshotId
		], "environment.snapshot", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(snapshot) {
		return {
			id: snapshot.id.value,
			environmentId: snapshot.environmentId.value,
			sessionId: snapshot.sessionId.value,
			environmentRevision: snapshot.environmentRevision.value,
			generation: snapshot.generation,
			sessionEpoch: snapshot.sessionEpoch,
			state: snapshot.state.name,
			content: snapshot.content?.value ?? null,
			recordRevision: snapshot.recordRevision.value
		};
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "Environment snapshot");
		requireExact(object, [
			"content",
			"environmentId",
			"environmentRevision",
			"generation",
			"id",
			"recordRevision",
			"sessionEpoch",
			"sessionId",
			"state"
		], "Environment snapshot");
		const content = requireOptionalString(object["content"], "Environment snapshot content");
		return new EnvironmentSnapshot(new EnvironmentSnapshotId(requireString(object["id"], "Environment snapshot ID")), new EnvironmentId(requireString(object["environmentId"], "Environment ID")), new EnvironmentSessionId(requireString(object["sessionId"], "Environment session ID")), new Revision(requireSafeInteger(object["environmentRevision"], "Environment revision")), requireSafeInteger(object["generation"], "Environment generation"), requireSafeInteger(object["sessionEpoch"], "Environment session epoch"), decodeSnapshotState(requireString(object["state"], "Environment snapshot state")), content === void 0 ? void 0 : new ContentRef(content), new Revision(requireSafeInteger(object["recordRevision"], "Environment snapshot record revision")));
	}
};
var EnvironmentSnapshot = class EnvironmentSnapshot {
	id;
	environmentId;
	sessionId;
	environmentRevision;
	generation;
	sessionEpoch;
	state;
	content;
	recordRevision;
	static get codec() {
		return environmentSnapshotCodecInstance;
	}
	constructor(id, environmentId, sessionId, environmentRevision, generation, sessionEpoch, state, content, recordRevision) {
		this.id = id;
		this.environmentId = environmentId;
		this.sessionId = sessionId;
		this.environmentRevision = environmentRevision;
		this.generation = generation;
		this.sessionEpoch = sessionEpoch;
		this.state = state;
		this.content = content;
		this.recordRevision = recordRevision;
		requireInstance(id, EnvironmentSnapshotId, "Environment snapshot ID");
		requireInstance(environmentId, EnvironmentId, "Environment ID");
		requireInstance(sessionId, EnvironmentSessionId, "Environment session ID");
		requireInstance(environmentRevision, Revision, "Environment revision");
		requireInstance(state, EnvironmentSnapshotState, "Environment snapshot state");
		if (content !== void 0) requireInstance(content, ContentRef, "Environment snapshot content");
		requireInstance(recordRevision, Revision, "Environment snapshot record revision");
		if (!Number.isSafeInteger(generation) || generation < 0) throw new TypeError("Environment snapshot generation must be a non-negative safe integer");
		if (!Number.isSafeInteger(sessionEpoch) || sessionEpoch < 0) throw new TypeError("Environment snapshot session epoch must be a non-negative safe integer");
		if (state.name === "ready" !== (content !== void 0)) throw new TypeError("Only a ready Environment snapshot has content");
		Object.freeze(this);
	}
	static encode(snapshot) {
		return EnvironmentSnapshot.codec.encode(snapshot);
	}
	static decode(bytes) {
		return EnvironmentSnapshot.codec.decode(bytes);
	}
	ready(content) {
		return this.transition(this.state.ready(), content);
	}
	fail() {
		return this.transition(this.state.fail(), void 0);
	}
	transition(state, content) {
		if (state === this.state) return this;
		return new EnvironmentSnapshot(this.id, this.environmentId, this.sessionId, this.environmentRevision, this.generation, this.sessionEpoch, state, content, advanceRevision(this.recordRevision, "Environment snapshot record revision"));
	}
};
var environmentSnapshotCodecInstance = new EnvironmentSnapshotCodecV1();
function decodeSnapshotState(value) {
	switch (value) {
		case "creating": return EnvironmentSnapshotState.creating;
		case "ready": return EnvironmentSnapshotState.ready;
		case "failed": return EnvironmentSnapshotState.failed;
		default: throw new TypeError("Environment snapshot state is invalid");
	}
}
function freezeState(state) {
	Object.freeze(state);
	return state;
}
//#endregion

//# sourceMappingURL=environments-CZCvxj-D.js.map