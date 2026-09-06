import { D as encodeCanonicalJson, E as decodeCanonicalJson, F as isJsonString, L as isObjectRecord, M as hasExactJsonKeys, N as hasExactKeys, R as jsonDataParser, _ as ContentRef, b as decodeBase64, d as CodecDeclaration, f as RecordCodec, g as Revision, h as SecretRef, i as SemVer, j as TextId, k as AgentCoreError, x as encodeBase64, y as Digest } from "./core-BjYGo1CC.js";
import { a as MemoryActorStore, d as ActorRef, f as ActorId, l as isActorActivationStore, n as ActorCommitUnknownError, o as requireSynchronousResult, r as ACTOR_STATE_SNAPSHOT, t as Actor } from "./actors-DJsP1nFM.js";
import { F as PackagePin, I as PackageId, at as FacetPackageId, ct as OperationName, lt as OperationRef, nt as BindingName, ot as FacetRef, s as ProtectionDomain } from "./runtime-z1yMP0an.js";
import { c as ItemClaimId, i as TurnId, o as ClaimWorkerId, r as RunId, u as WriteRecordId } from "./facets-D01bKQBL.js";
import { B as WorkspaceId, C as PrincipalRef, F as ProjectId, P as PrincipalId, R as TeamId, v as GuestVerificationScheme, w as ScopeRef, z as TenantId } from "./identity-CoqhjOFj.js";
import { A as Binding, C as AuthorityCheckRequest, I as GrantId, M as BindingLifecycle, O as PathEpochEvidence, S as AuthorityCheckEvidence, T as AuthorityPermitExpectation, b as TargetLeaseEvidenceKey, j as BindingCredentialCustody, k as ScopeEpoch, o as MemoryTenantControlStore, u as BindingValidationEvidence, v as TargetAuthorityPermitRequest, w as AuthorityPermit, x as TargetLeaseEvidenceReference } from "./authority-BbHaDuhf.js";
import { i as InvocationId, n as CorrelationId, t as AuditRecordId } from "./interaction-references-D9spp037.js";
import { H as MaterializationPlan } from "./definition-COokGikL.js";
import { $ as AuditRecord, et as AuditRecordCodec, nt as validateAuditAppend, rt as validateStoredAuditLinkage, tt as auditEvidenceIdentity } from "./invocations-Cpv8tzSW.js";
//#region src/protocol/payload.ts
var CommandPayloadMalformedError = class extends AgentCoreError {
	constructor(message = "Command payload is malformed") {
		super("protocol.invalid-envelope", message);
		this.name = "CommandPayloadMalformedError";
	}
};
var PayloadLeaseBinding = class {
	tenant;
	actor;
	envelopeDigest;
	ref;
	digest;
	#expiresAt;
	constructor(tenant, actor, envelopeDigest, ref, digest, expiresAt) {
		this.tenant = tenant;
		this.actor = actor;
		this.envelopeDigest = envelopeDigest;
		this.ref = ref;
		this.digest = digest;
		const expiresAtTime = expiresAt.getTime();
		if (!Number.isFinite(expiresAtTime)) throw new TypeError("Payload lease expiry must be valid");
		this.#expiresAt = expiresAtTime;
		Object.freeze(this);
	}
	get expiresAt() {
		return new Date(this.#expiresAt);
	}
	matches(tenant, actor, envelopeDigest, ref, digest) {
		return this.tenant.equals(tenant) && this.actor.equals(actor) && this.envelopeDigest.equals(envelopeDigest) && this.ref.equals(ref) && this.digest.equals(digest);
	}
};
var preparedPayloadIssuer = Symbol("prepared-command-payload-issuer");
var preparedPayloadStates = /* @__PURE__ */ new WeakMap();
var PreparedCommandPayload = class {
	constructor(issuer, state) {
		if (issuer !== preparedPayloadIssuer) throw invalidPreparedPayloadIssuer();
		preparedPayloadStates.set(this, Object.freeze({ ...state }));
		Object.freeze(this);
	}
	get lease() {
		return requirePreparedState(this).lease;
	}
	get binding() {
		return requirePreparedState(this).binding;
	}
	get malformedReason() {
		return requirePreparedState(this).malformedReason;
	}
};
function issueLeasedCommandPayload(lease, binding) {
	return new PreparedCommandPayload(preparedPayloadIssuer, {
		lease,
		binding
	});
}
function issueMalformedCommandPayload(malformedReason) {
	return new PreparedCommandPayload(preparedPayloadIssuer, { malformedReason });
}
function inspectPreparedCommandPayload(value) {
	return value instanceof PreparedCommandPayload ? preparedPayloadStates.get(value) : void 0;
}
function requirePreparedState(value) {
	const state = preparedPayloadStates.get(value);
	if (state === void 0) throw invalidPreparedPayloadIssuer();
	return state;
}
function invalidPreparedPayloadIssuer() {
	return new AgentCoreError("protocol.invalid-state", "Prepared command payload has an invalid issuer");
}
//#endregion
//#region src/protocol/policy.ts
var CommandCallerPolicy = class {
	static principal() {
		return principalCallerPolicy;
	}
	static actor(kind) {
		return new ActorCommandCallerPolicy(kind);
	}
};
var PrincipalCommandCallerPolicy = class extends CommandCallerPolicy {
	admits(caller) {
		return caller.kind === "principal";
	}
};
var ActorCommandCallerPolicy = class extends CommandCallerPolicy {
	kind;
	constructor(kind) {
		super();
		this.kind = kind;
	}
	admits(caller) {
		return caller.kind === "actor" && caller.actor.kind === this.kind;
	}
};
var principalCallerPolicy = new PrincipalCommandCallerPolicy();
//#endregion
//#region src/protocol/codec.ts
/**
* Boundary parsers for the protocol's durable records, matching the per-context
* codec modules the other bounded contexts carry. Every helper answers a decode
* question by returning the decoded value, so callers never re-state a fact the
* parser already established.
*/
var parse = jsonDataParser((message) => new TypeError(message));
function requireObject(value, subject) {
	return parse.object(value, subject);
}
function requireStringValue(value, subject) {
	return parse.string(value, subject);
}
function requireString(object, key, subject = key) {
	return requireStringValue(object[key], subject);
}
function requireNonemptyString(value, subject) {
	return parse.nonemptyString(value, subject);
}
function requireNullableString(object, key, subject = key) {
	return parse.nullableString(object[key], subject);
}
function requireNonnegativeInteger(value, subject) {
	return parse.safeInteger(value, subject);
}
function requireKeys(object, required, optional, subject) {
	const admitted = /* @__PURE__ */ new Set([...required, ...optional]);
	if (required.some((key) => !(key in object)) || Object.keys(object).some((key) => !admitted.has(key))) throw new TypeError(`${subject} contains missing or unknown fields`);
}
//#endregion
//#region src/protocol/bootstrap.ts
var TenantBootstrapAnchorCodec = class extends RecordCodec {
	constructor() {
		super([
			TenantBootstrapAnchorRecord,
			TextId,
			ActorId,
			TenantId,
			PrincipalId
		], "protocol.tenant-bootstrap-anchor", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(anchor) {
		return {
			actorId: anchor.actorId.value,
			principalId: anchor.principalId.value,
			tenantId: anchor.tenantId.value,
			tenantKind: anchor.tenantKind,
			trustAnchor: encodeBase64(anchor.trustAnchor)
		};
	}
	decodePayload(payload) {
		try {
			const object = requireObject(payload, "Tenant bootstrap anchor payload");
			requireKeys(object, [
				"actorId",
				"principalId",
				"tenantId",
				"tenantKind",
				"trustAnchor"
			], [], "Tenant bootstrap anchor payload");
			const tenantKind = object["tenantKind"];
			if (!isTenantKind(tenantKind)) throw new TypeError("Tenant bootstrap anchor payload is malformed");
			return new TenantBootstrapAnchorRecord({
				actorId: new ActorId(requireString(object, "actorId")),
				principalId: new PrincipalId(requireString(object, "principalId")),
				tenantId: new TenantId(requireString(object, "tenantId")),
				tenantKind,
				trustAnchor: decodeBase64(requireString(object, "trustAnchor"))
			});
		} catch (error) {
			if (error instanceof TypeError) throw new TypeError("Tenant bootstrap anchor payload is malformed");
			throw error;
		}
	}
};
var TenantBootstrapAnchorRecord = class TenantBootstrapAnchorRecord {
	static get codec() {
		return tenantBootstrapAnchorRecordCodecInstance;
	}
	actorId;
	tenantId;
	principalId;
	tenantKind;
	#trustAnchor;
	constructor(anchor) {
		if (!(anchor.actorId instanceof ActorId) || !(anchor.trustAnchor instanceof Uint8Array) || anchor.trustAnchor.byteLength === 0) throw new TypeError("Tenant bootstrap anchor is malformed");
		this.actorId = anchor.actorId;
		this.tenantId = anchor.tenantId;
		this.principalId = anchor.principalId;
		this.#trustAnchor = anchor.trustAnchor.slice();
		this.tenantKind = anchor.tenantKind ?? "personal";
		Object.freeze(this);
	}
	static encode(anchor) {
		return TenantBootstrapAnchorRecord.codec.encode(anchor);
	}
	static decode(bytes) {
		return TenantBootstrapAnchorRecord.codec.decode(bytes);
	}
	get trustAnchor() {
		return this.#trustAnchor.slice();
	}
};
var tenantBootstrapAnchorRecordCodecInstance = new TenantBootstrapAnchorCodec();
var TenantBootstrapCommand = class {
	backend;
	target;
	/**
	* §8.3: the anchor this command writes to prove a Tenant was bootstrapped exactly once.
	*/
	declaration = CodecDeclaration.of([TenantBootstrapAnchorRecord.codec]);
	command = "tenant.bootstrap";
	caller = CommandCallerPolicy.principal();
	expectedRevision = "required";
	lease = "forbidden";
	payload = emptyBootstrapPayloadCodec;
	replyCodec = bootstrapReplyCodec;
	observationCodec = bootstrapObservationCodec;
	constructor(backend, target) {
		this.backend = backend;
		this.target = target;
		if (target.actor.kind !== "tenant") throw new AgentCoreError("protocol.invalid-state", "Tenant bootstrap must target a Tenant Actor");
	}
	authorize(read, envelope) {
		const anchor = this.backend.anchor(read);
		return anchor !== void 0 && anchorMatchesTarget(anchor, this.target) && envelope.caller.kind === "principal" && envelope.caller.principal.equals(principalFor(anchor));
	}
	permitsLifecycle(read) {
		const anchor = this.backend.anchor(read);
		return anchor !== void 0 && anchorMatchesTarget(anchor, this.target) && this.backend.eligible(read, anchor);
	}
	currentRevision(read) {
		const anchor = this.backend.anchor(read);
		return anchor === void 0 ? void 0 : this.backend.currentRevision(read, anchor);
	}
	currentLease(_read, _envelope, _payload, _at) {}
	execute(transaction, envelope, _payload, at) {
		const anchor = this.backend.anchorInTransaction(transaction);
		const expectedRevision = envelope.expectedRevision;
		if (anchor === void 0 || expectedRevision === void 0 || !anchorMatchesTarget(anchor, this.target) || envelope.caller.kind !== "principal" || !envelope.caller.principal.equals(principalFor(anchor))) throw new AgentCoreError("protocol.invalid-state", "Tenant bootstrap anchor disappeared during dispatch");
		const verifiedAnchor = new TenantBootstrapAnchorRecord(anchor);
		this.backend.bootstrapTenant(transaction, verifiedAnchor, expectedRevision);
		const reply = Object.freeze({
			owner: principalFor(verifiedAnchor),
			tenant: verifiedAnchor.tenantId
		});
		return {
			outcome: "committed",
			reply,
			observation: Object.freeze({
				...reply,
				at: new Date(at)
			})
		};
	}
};
function tenantBootstrapPayload() {
	return encodeCanonicalJson({});
}
var EmptyBootstrapPayloadCodec = class {
	decode(bytes) {
		const value = decodeCanonicalJson(bytes);
		try {
			requireKeys(requireObject(value, "Tenant bootstrap payload"), [], [], "Tenant bootstrap payload");
		} catch {
			throw new CommandPayloadMalformedError("Tenant bootstrap payload must be an empty object");
		}
		return Object.freeze({});
	}
};
var emptyBootstrapPayloadCodec = new EmptyBootstrapPayloadCodec();
function createTenantBootstrapCommand(store, target) {
	return new TenantBootstrapCommand(store, target);
}
var TenantBootstrapReplyCodec = class {
	encode(reply) {
		return encodeCanonicalJson({
			owner: {
				principal: reply.owner.principalId.value,
				tenant: reply.owner.tenantId.value
			},
			tenant: reply.tenant.value
		});
	}
	decode(bytes) {
		const object = requireObject(decodeCanonicalJson(bytes), "Tenant bootstrap reply");
		if (!hasExactJsonKeys(object, ["owner", "tenant"])) throw new TypeError("Tenant bootstrap reply is malformed");
		const owner = requireObject(object["owner"], "Tenant bootstrap owner");
		if (!hasExactJsonKeys(owner, ["principal", "tenant"])) throw new TypeError("Tenant bootstrap owner is malformed");
		return Object.freeze({
			owner: new PrincipalRef(new TenantId(requireNonemptyString(owner["tenant"], "Tenant bootstrap owner Tenant")), new PrincipalId(requireNonemptyString(owner["principal"], "Tenant bootstrap owner"))),
			tenant: new TenantId(requireNonemptyString(object["tenant"], "Tenant bootstrap Tenant"))
		});
	}
};
var TenantBootstrapObservationCodec = class {
	encode(observation) {
		return encodeCanonicalJson({
			at: observation.at.toISOString(),
			reply: encodeBase64(bootstrapReplyCodec.encode(observation))
		});
	}
	decode(bytes) {
		const object = requireObject(decodeCanonicalJson(bytes), "Tenant bootstrap observation");
		if (!hasExactJsonKeys(object, ["at", "reply"])) throw new TypeError("Tenant bootstrap observation is malformed");
		const at = new Date(requireNonemptyString(object["at"], "Tenant bootstrap observation time"));
		if (!Number.isFinite(at.getTime())) throw new TypeError("Tenant bootstrap observation time is invalid");
		return Object.freeze({
			...bootstrapReplyCodec.decode(decodeBase64(requireNonemptyString(object["reply"], "Tenant bootstrap observation reply"))),
			at
		});
	}
};
var bootstrapReplyCodec = new TenantBootstrapReplyCodec();
var bootstrapObservationCodec = new TenantBootstrapObservationCodec();
function anchorMatchesTarget(anchor, target) {
	return anchor.actorId.equals(target.actor.id) && anchor.tenantId.equals(target.tenantId);
}
function principalFor(anchor) {
	return new PrincipalRef(anchor.tenantId, anchor.principalId);
}
function isTenantKind(value) {
	return value === "personal" || value === "organization" || value === "service";
}
//#endregion
//#region src/protocol/envelope.ts
var CommandEnvelopeCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			CommandEnvelope,
			ActorRef,
			Revision,
			TextId,
			ContentRef,
			Digest,
			ActorId,
			AuditRecordId,
			TenantId,
			TurnId,
			PrincipalId,
			PrincipalRef
		], "command-envelope", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(envelope) {
		const encoded = {
			command: envelope.command,
			caller: encodeCommandCaller(envelope.caller),
			idempotencyKey: envelope.idempotencyKey,
			payload: envelope.payload.value,
			payloadDigest: envelope.payloadDigest.value
		};
		if (envelope.expectedRevision !== void 0) encoded["expectedRevision"] = envelope.expectedRevision.value;
		if (envelope.lease !== void 0) encoded["lease"] = {
			turn: envelope.lease.turn.value,
			holder: {
				principal: envelope.lease.holder.principalId.value,
				tenant: envelope.lease.holder.tenantId.value
			},
			epoch: envelope.lease.epoch
		};
		if (envelope.callerCause !== void 0) encoded["callerCause"] = envelope.callerCause.value;
		return encoded;
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "Command envelope payload");
		requireKeys(object, [
			"command",
			"caller",
			"idempotencyKey",
			"payload",
			"payloadDigest"
		], [
			"expectedRevision",
			"lease",
			"callerCause"
		], "Command envelope");
		const expectedRevision = object["expectedRevision"];
		const lease = object["lease"];
		const callerCause = object["callerCause"];
		return new CommandEnvelope({
			command: requireString(object, "command"),
			caller: decodeCommandCaller(object["caller"]),
			idempotencyKey: requireString(object, "idempotencyKey"),
			expectedRevision: expectedRevision === void 0 ? void 0 : new Revision(requireNonnegativeInteger(expectedRevision, "expectedRevision")),
			lease: lease === void 0 ? void 0 : decodeLease(lease),
			callerCause: callerCause === void 0 ? void 0 : new AuditRecordId(requireStringValue(callerCause, "callerCause")),
			payload: new ContentRef(requireString(object, "payload")),
			payloadDigest: new Digest(requireString(object, "payloadDigest"))
		});
	}
};
/** The longest a command name may be; see `MAX_TEXT_VALUE_LENGTH` in core. */
var MAX_COMMAND_NAME_LENGTH = 256;
/**
* The longest an idempotency key may be. Twice the identifier bound, because a key is
* composed from a caller's own identifiers rather than being one.
*/
var MAX_IDEMPOTENCY_KEY_LENGTH$1 = 512;
var CommandEnvelope = class CommandEnvelope {
	static get codec() {
		return commandEnvelopeCodecInstance;
	}
	command;
	caller;
	idempotencyKey;
	expectedRevision;
	lease;
	callerCause;
	payload;
	payloadDigest;
	constructor(init) {
		if (!isString$1(init.command) || init.command.length === 0 || init.command.length > MAX_COMMAND_NAME_LENGTH) throw new TypeError(`Command name must contain between 1 and ${MAX_COMMAND_NAME_LENGTH} characters`);
		if (!isString$1(init.idempotencyKey) || init.idempotencyKey.length === 0 || init.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH$1) throw new TypeError(`Command idempotency key must contain between 1 and ${MAX_IDEMPOTENCY_KEY_LENGTH$1} characters`);
		this.command = init.command;
		this.caller = copyCommandCaller(init.caller);
		this.idempotencyKey = init.idempotencyKey;
		this.expectedRevision = init.expectedRevision;
		this.lease = init.lease === void 0 ? void 0 : copyLeaseToken(init.lease);
		this.callerCause = init.callerCause;
		this.payload = init.payload;
		this.payloadDigest = init.payloadDigest;
		Object.freeze(this);
	}
	static encode(envelope) {
		return CommandEnvelope.codec.encode(envelope);
	}
	static decode(bytes) {
		return CommandEnvelope.codec.decode(bytes);
	}
};
var commandEnvelopeCodecInstance = new CommandEnvelopeCodecV1();
var CommandEnvelopeCodec = CommandEnvelope.codec;
function commandCallersEqual(left, right) {
	if (left.kind === "principal" && right.kind === "principal") return left.principal.equals(right.principal);
	return left.kind === "actor" && right.kind === "actor" && left.actor.equals(right.actor);
}
function copyCommandCaller(caller) {
	requireCommandCallerContainer(caller);
	if (commandCallerHasKind(caller, "principal")) {
		requirePlainObjectKeys(caller, ["kind", "principal"], "Command caller");
		if (caller.principal instanceof PrincipalRef) return Object.freeze({
			kind: "principal",
			principal: new PrincipalRef(caller.principal.tenantId, caller.principal.principalId)
		});
	} else if (commandCallerHasKind(caller, "actor")) {
		requirePlainObjectKeys(caller, ["kind", "actor"], "Command caller");
		if (caller.actor instanceof ActorRef) return Object.freeze({
			kind: "actor",
			actor: new ActorRef(requireActorKind$1(caller.actor.kind), new ActorId(caller.actor.id.value))
		});
	}
	throw new TypeError("Command caller is invalid");
}
function requireCommandCallerContainer(caller) {
	if (caller === null || Object.getPrototypeOf(caller) !== Object.prototype) throw new TypeError("Command caller must be a plain object with exact fields");
	const descriptor = Object.getOwnPropertyDescriptor(caller, "kind");
	if (descriptor === void 0 || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("Command caller must contain enumerable data fields");
}
function encodeCommandCaller(caller) {
	return caller.kind === "principal" ? {
		kind: caller.kind,
		principal: {
			id: caller.principal.principalId.value,
			tenant: caller.principal.tenantId.value
		}
	} : {
		kind: caller.kind,
		actor: {
			kind: caller.actor.kind,
			id: caller.actor.id.value
		}
	};
}
function decodeCommandCaller(value) {
	const object = requireObject(value, "Command caller");
	const kind = requireString(object, "kind");
	if (kind === "principal") {
		requireKeys(object, ["kind", "principal"], [], "Command envelope");
		const principal = requireObject(object["principal"], "Command caller principal");
		requireKeys(principal, ["id", "tenant"], [], "Command envelope");
		return {
			kind,
			principal: new PrincipalRef(new TenantId(requireString(principal, "tenant")), new PrincipalId(requireString(principal, "id")))
		};
	}
	if (kind === "actor") {
		requireKeys(object, ["kind", "actor"], [], "Command envelope");
		const actor = requireObject(object["actor"], "Command caller actor");
		requireKeys(actor, ["kind", "id"], [], "Command envelope");
		return {
			kind,
			actor: new ActorRef(requireActorKind$1(actor["kind"]), new ActorId(requireString(actor, "id")))
		};
	}
	throw new TypeError("Command caller kind is invalid");
}
function decodeLease(value) {
	const object = requireObject(value, "Lease token");
	requireKeys(object, [
		"turn",
		"holder",
		"epoch"
	], [], "Command envelope");
	return {
		turn: new TurnId(requireString(object, "turn")),
		holder: decodePrincipalRef(object["holder"], "Lease holder"),
		epoch: requireNonnegativeInteger(object["epoch"], "epoch")
	};
}
function copyLeaseToken(lease) {
	requirePlainObjectKeys(lease, [
		"turn",
		"holder",
		"epoch"
	], "Lease token");
	if (!(lease.turn instanceof TurnId) || !(lease.holder instanceof PrincipalRef) || !Number.isSafeInteger(lease.epoch) || lease.epoch < 0) throw new TypeError("Lease token requires a TurnId turn, PrincipalRef holder, and non-negative epoch");
	return Object.freeze({
		turn: new TurnId(lease.turn.value),
		holder: new PrincipalRef(lease.holder.tenantId, lease.holder.principalId),
		epoch: lease.epoch
	});
}
function decodePrincipalRef(value, name) {
	const object = requireObject(value, name);
	requireKeys(object, ["principal", "tenant"], [], "Command envelope");
	return new PrincipalRef(new TenantId(requireString(object, "tenant")), new PrincipalId(requireString(object, "principal")));
}
function commandCallerHasKind(caller, kind) {
	if (caller === null || Object.getPrototypeOf(caller) !== Object.prototype) return false;
	const descriptor = Object.getOwnPropertyDescriptor(caller, "kind");
	if (descriptor === void 0 || !("value" in descriptor) || !descriptor.enumerable) return false;
	return descriptor.value === kind;
}
function requirePlainObjectKeys(value, fields, name) {
	if (value === null || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${name} must be a plain object with exact fields`);
	const keys = Reflect.ownKeys(value);
	if (keys.length !== fields.length || fields.some((field) => !keys.includes(field))) throw new TypeError(`${name} must be a plain object with exact fields`);
	for (const field of fields) {
		const descriptor = Object.getOwnPropertyDescriptor(value, field);
		if (descriptor === void 0 || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError(`${name} must contain enumerable data fields`);
	}
}
function requireActorKind$1(value) {
	if (value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate") return value;
	throw new TypeError("Command caller actor kind is invalid");
}
function isString$1(value) {
	return typeof value === "string";
}
//#endregion
//#region src/protocol/authentication.ts
var authenticationIssuer = Symbol("command-authentication-issuer");
var issuedAuthentications = /* @__PURE__ */ new WeakSet();
var CommandAuthentication = class {
	#envelopeDigest;
	#caller;
	#tenant;
	constructor(issuer, envelopeDigest, caller, tenant) {
		if (issuer !== authenticationIssuer) throw new AgentCoreError("protocol.invalid-envelope", "Command authentication has an invalid issuer");
		this.#envelopeDigest = envelopeDigest;
		this.#caller = copyCommandCaller(caller);
		this.#tenant = tenant;
		issuedAuthentications.add(this);
		Object.freeze(this);
	}
	matches(envelopeDigest, envelope, tenant) {
		return this.#envelopeDigest.equals(envelopeDigest) && commandCallersEqual(this.#caller, envelope.caller) && this.#tenant.equals(tenant);
	}
};
function commandAuthenticationMatches(authentication, envelopeDigest, envelope, tenant) {
	if (!(authentication instanceof CommandAuthentication)) return false;
	if (!issuedAuthentications.has(authentication)) return false;
	return CommandAuthentication.prototype.matches.call(authentication, envelopeDigest, envelope, tenant);
}
var CommandAuthenticator = class {
	tenant;
	constructor(tenant) {
		this.tenant = tenant;
	}
	async authenticate(transport, envelope, envelopeDigest) {
		const caller = await this.authenticateTransport(transport, envelope);
		return caller === void 0 ? void 0 : issueAuthentication(envelopeDigest, caller, this.tenant);
	}
};
function issueAuthentication(envelopeDigest, caller, tenant) {
	return new CommandAuthentication(authenticationIssuer, envelopeDigest, caller, tenant);
}
//#endregion
//#region src/protocol/write.ts
/**
* SPEC §8.5 partitions its outcome vocabulary: a write either records a decision the
* dispatcher committed — `committed`, or `duplicate` for a replayed idempotent command —
* or records the command's refusal. The partition is declared here as data rather than
* read off the `rejected` prefix in each label's spelling, because a prefix test answers
* from how a name is written: renaming one case would silently change the dispatcher's
* behavior, and any string that begins the same way — a corrupted stored record, a forged
* envelope — would classify as a refusal without ever having been admitted to the
* vocabulary. Keyed by `CommandOutcome`, so a new outcome does not compile until this
* table states which half it belongs to.
*/
/** The longest an idempotency key a write may echo; the envelope bound it was decoded from. */
var MAX_IDEMPOTENCY_KEY_LENGTH = 512;
var COMMAND_OUTCOME_DISPOSITIONS = Object.freeze({
	committed: "committed",
	duplicate: "committed",
	rejectedAuthentication: "refused",
	rejectedAuthority: "refused",
	rejectedLease: "refused",
	rejectedLifecycle: "refused",
	rejectedMalformed: "refused",
	rejectedRevision: "refused"
});
/** Whether an outcome records the command's refusal, read from the declared partition. */
function commandOutcomeRefused(outcome) {
	return COMMAND_OUTCOME_DISPOSITIONS[outcome] === "refused";
}
/** Whether a decoded value is an outcome SPEC §8.5 declares, decided from the same table. */
function isCommandOutcome(value) {
	return isJsonString(value) && Object.hasOwn(COMMAND_OUTCOME_DISPOSITIONS, value);
}
var WriteRecordCodecV2 = class extends RecordCodec {
	constructor() {
		super([
			WriteRecord,
			ActorRef,
			TextId,
			Digest,
			ActorId,
			AuditRecordId,
			TenantId,
			WriteRecordId,
			PrincipalId,
			PrincipalRef
		], "write-record", {
			major: 2,
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
			envelopeDigest: record.envelopeDigest.value,
			caller: record.caller === void 0 ? null : encodeCommandCaller(record.caller),
			command: record.command ?? null,
			idempotencyKey: record.idempotencyKey ?? null,
			at: record.at.toISOString(),
			outcome: record.outcome,
			audit: record.audit.value,
			duplicateOf: record.duplicateOf?.value ?? null,
			reply: encodeBase64(record.reply),
			observation: record.observation === void 0 ? null : encodeBase64(record.observation)
		};
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "Write record payload");
		const actor = requireObject(object["actor"], "Write record actor");
		if (!hasExactJsonKeys(object, [
			"actor",
			"at",
			"audit",
			"caller",
			"command",
			"duplicateOf",
			"envelopeDigest",
			"id",
			"idempotencyKey",
			"observation",
			"outcome",
			"reply"
		]) || !hasExactJsonKeys(actor, ["id", "kind"])) throw new TypeError("Write record payload contains missing or unknown fields");
		const caller = object["caller"];
		const command = requireNullableString(object, "command", "Write record command");
		const duplicateOf = requireNullableString(object, "duplicateOf", "Write record duplicate");
		const idempotencyKey = requireNullableString(object, "idempotencyKey", "Write record idempotency key");
		const observation = requireNullableString(object, "observation", "Write record observation");
		return new WriteRecord({
			id: new WriteRecordId(requireString(object, "id")),
			actor: new ActorRef(requireActorKind(actor["kind"]), new ActorId(requireString(actor, "id"))),
			envelopeDigest: new Digest(requireString(object, "envelopeDigest")),
			caller: caller === null ? void 0 : decodeCommandCaller(caller),
			command,
			idempotencyKey,
			at: new Date(requireString(object, "at")),
			outcome: requireOutcome(object["outcome"]),
			audit: new AuditRecordId(requireString(object, "audit")),
			duplicateOf: duplicateOf === void 0 ? void 0 : new WriteRecordId(duplicateOf),
			reply: decodeBase64(requireString(object, "reply")),
			observation: observation === void 0 ? void 0 : decodeBase64(observation)
		});
	}
};
var WriteRecord = class WriteRecord {
	#atTime;
	#reply;
	#observation;
	static get codec() {
		return writeRecordCodecInstance;
	}
	id;
	actor;
	envelopeDigest;
	caller;
	command;
	idempotencyKey;
	outcome;
	audit;
	duplicateOf;
	constructor(init) {
		const atTime = init.at.getTime();
		if (!Number.isFinite(atTime)) throw new TypeError("Write record time must be valid");
		if (init.outcome === "duplicate" && init.duplicateOf === void 0) throw new TypeError("Duplicate write records must identify the original write");
		if (init.outcome !== "duplicate" && init.duplicateOf !== void 0) throw new TypeError("Only duplicate write records may identify an original write");
		if ((init.caller === void 0 || init.command === void 0) && init.outcome !== "rejectedMalformed") throw new TypeError("Only malformed writes may omit decoded envelope fields");
		if (init.idempotencyKey !== void 0 && (init.idempotencyKey.length === 0 || init.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH)) throw new TypeError(`Write idempotency key must contain between 1 and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
		if (init.outcome !== "rejectedMalformed" && init.outcome !== "rejectedAuthentication" && init.idempotencyKey === void 0 || init.outcome === "rejectedAuthentication" && init.idempotencyKey !== void 0) throw new TypeError("Write idempotency key does not match its outcome");
		if (init.idempotencyKey !== void 0 && (init.caller === void 0 || init.command === void 0)) throw new TypeError("Write idempotency keys require decoded envelope fields");
		if (init.observation !== void 0 && init.outcome !== "committed") throw new TypeError("Only committed writes may contain an observation");
		this.id = init.id;
		this.actor = init.actor;
		this.envelopeDigest = init.envelopeDigest;
		this.caller = init.caller === void 0 ? void 0 : copyCommandCaller(init.caller);
		this.command = init.command;
		this.idempotencyKey = init.idempotencyKey;
		this.#atTime = atTime;
		this.outcome = init.outcome;
		this.audit = init.audit;
		this.duplicateOf = init.duplicateOf;
		this.#reply = init.reply.slice();
		this.#observation = init.observation?.slice();
		Object.freeze(this);
	}
	static encode(record) {
		return WriteRecord.codec.encode(record);
	}
	static decode(bytes) {
		return WriteRecord.codec.decode(bytes);
	}
	get at() {
		return new Date(this.#atTime);
	}
	get reply() {
		return this.#reply.slice();
	}
	get observation() {
		return this.#observation?.slice();
	}
};
var writeRecordCodecInstance = new WriteRecordCodecV2();
var WriteRecordCodec = WriteRecord.codec;
function writeReservesIdentity(record) {
	return record.idempotencyKey !== void 0 && record.outcome !== "duplicate" && record.outcome !== "rejectedAuthentication";
}
function requireActorKind(value) {
	if (value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate") return value;
	throw new TypeError("Write record actor kind is invalid");
}
function requireOutcome(value) {
	if (isCommandOutcome(value)) return value;
	throw new TypeError("Write record outcome is invalid");
}
//#endregion
//#region src/protocol/dispatcher.ts
var CommandCommitUnknownError = class extends ActorCommitUnknownError {
	retrySameKey;
	constructor(message = "The command transaction commit result is unknown", retrySameKey = false) {
		super(message);
		this.retrySameKey = retrySameKey;
		const canonical = new ActorCommitUnknownError(message);
		Object.setPrototypeOf(canonical, new.target.prototype);
		Object.defineProperties(canonical, {
			name: {
				configurable: true,
				value: "CommandCommitUnknownError"
			},
			retrySameKey: {
				enumerable: true,
				value: retrySameKey
			}
		});
		return canonical;
	}
};
var CommandPreparationUnavailableError = class extends AgentCoreError {
	constructor(message = "Prepared command content is unavailable") {
		super("protocol.invalid-state", message);
		this.name = "CommandPreparationUnavailableError";
	}
};
/**
* The codec versions a dispatcher owns besides the stable recovery carrier. Actor adds that
* carrier itself, so no subclass can omit or manually version bootstrap state. Every
* registered command adds the kinds its own execution writes, so the declaration a reader
* compares against covers the whole record set the §8.3 gate protects — not just the write
* and audit records the dispatcher writes itself.
*/
var DISPATCHER_CODECS = CodecDeclaration.of([AuditRecord.codec, WriteRecord.codec]);
var CommandDispatcher = class extends Actor {
	#store;
	#persistence;
	#ids;
	#actor;
	#tenant;
	#readOnly;
	#commands;
	#limits;
	#now;
	constructor(init) {
		const context = validateCommandActorContext(init.actor, init.store);
		const commands = /* @__PURE__ */ new Map();
		for (const command of init.commands) {
			if (command.command.length === 0 || commands.has(command.command)) throw new TypeError("Protocol command names must be non-empty and unique");
			commands.set(command.command, command);
		}
		validateLimit(init.limits.envelopeBytes, "envelope");
		validateLimit(init.limits.payloadBytes, "payload");
		super(context, CodecDeclaration.merge([DISPATCHER_CODECS, ...init.commands.map((command) => command.declaration)]), (transaction) => init.persistence.repair?.(transaction));
		this.#store = init.store;
		this.#persistence = init.persistence;
		this.#ids = init.ids;
		this.#actor = init.actor;
		this.#tenant = init.tenant;
		this.#readOnly = init.readOnly;
		this.#commands = commands;
		this.#limits = { ...init.limits };
		this.#now = init.now ?? (() => /* @__PURE__ */ new Date());
	}
	get actor() {
		return this.#actor;
	}
	get tenant() {
		return this.#tenant;
	}
	get limits() {
		return { ...this.#limits };
	}
	decodeForPreparation(rawEnvelope) {
		return this.decode(rawEnvelope);
	}
	decodeForAuthentication(rawEnvelope) {
		return this.decode(rawEnvelope);
	}
	admit(rawEnvelope, authentication) {
		const submitted = rawEnvelope.slice();
		return this.execute((transaction) => {
			try {
				const result = this.admitInTransaction(transaction, submitted, authentication);
				if (result.kind === "completed") return result;
				return {
					kind: "prepare",
					dispatch: (payload) => this.dispatchPrepared(submitted, authentication, payload)
				};
			} catch (error) {
				if (isForgedCommitUnknown(error)) throw invalidCommitUnknownOrigin();
				throw error;
			}
		});
	}
	admitInTransaction(transaction, rawEnvelope, authentication) {
		const envelopeDigest = Digest.sha256(rawEnvelope);
		const validated = this.validate(rawEnvelope, envelopeDigest, authentication);
		if (validated instanceof DecisionBeforePreparation) {
			const at = this.timestamp();
			const duplicate = validated.decision.reservesIdentity && validated.identity !== void 0 ? this.#persistence.findWrite(transaction, validated.identity) : void 0;
			return {
				kind: "completed",
				result: this.persistDecision(transaction, validated.envelope, validated.identity, envelopeDigest, duplicate === void 0 ? validated.decision : duplicateDecision(duplicate), at)
			};
		}
		const duplicate = this.#persistence.findWrite(transaction, validated.identity);
		if (duplicate !== void 0) return {
			kind: "completed",
			result: this.persistDecision(transaction, validated.envelope, validated.identity, envelopeDigest, duplicateDecision(duplicate), this.timestamp())
		};
		if (this.hasInvalidCallerCause(transaction, validated.envelope)) return {
			kind: "completed",
			result: this.persistDecision(transaction, validated.envelope, validated.identity, envelopeDigest, rejected("rejectedMalformed", false, true), this.timestamp())
		};
		return { kind: "prepare" };
	}
	dispatchPrepared(rawEnvelope, authentication, payload) {
		return this.execute((transaction) => {
			try {
				return this.dispatchPreparedInTransaction(transaction, rawEnvelope, authentication, payload);
			} catch (error) {
				if (isForgedCommitUnknown(error)) throw invalidCommitUnknownOrigin();
				throw error;
			}
		});
	}
	dispatchPreparedInTransaction(transaction, rawEnvelope, authentication, prepared) {
		const at = this.timestamp();
		const envelopeDigest = Digest.sha256(rawEnvelope);
		const validated = this.validate(rawEnvelope, envelopeDigest, authentication);
		if (validated instanceof DecisionBeforePreparation) {
			const duplicate = validated.decision.reservesIdentity && validated.identity !== void 0 ? this.#persistence.findWrite(transaction, validated.identity) : void 0;
			return this.persistDecision(transaction, validated.envelope, validated.identity, envelopeDigest, duplicate === void 0 ? validated.decision : duplicateDecision(duplicate), at);
		}
		const duplicate = this.#persistence.findWrite(transaction, validated.identity);
		if (duplicate !== void 0) return this.persistDecision(transaction, validated.envelope, validated.identity, envelopeDigest, duplicateDecision(duplicate), at);
		const preparedDecision = this.prepareDecision(transaction, validated, prepared, envelopeDigest, at);
		if (preparedDecision === invalidPayload) return this.persistDecision(transaction, validated.envelope, validated.identity, envelopeDigest, rejected("rejectedMalformed", validated.envelope.callerCause !== void 0, true), at);
		if (this.hasInvalidCallerCause(transaction, validated.envelope)) return this.persistDecision(transaction, validated.envelope, validated.identity, envelopeDigest, rejected("rejectedMalformed", false, true), at);
		return this.persistDecision(transaction, validated.envelope, validated.identity, envelopeDigest, preparedDecision.decide(), at);
	}
	validate(rawEnvelope, envelopeDigest, authentication) {
		const envelope = this.decode(rawEnvelope);
		if (envelope === void 0) return new DecisionBeforePreparation(void 0, void 0, rejected("rejectedMalformed"));
		const identity = {
			caller: envelope.caller,
			idempotencyKey: envelope.idempotencyKey
		};
		if (!commandAuthenticationMatches(authentication, envelopeDigest, envelope, this.#tenant)) return new DecisionBeforePreparation(envelope, identity, rejected("rejectedAuthentication"));
		if (envelope.caller.kind === "principal" && !envelope.caller.principal.tenantId.equals(this.#tenant)) return new DecisionBeforePreparation(envelope, identity, rejected("rejectedAuthentication"));
		const command = this.#commands.get(envelope.command);
		if (command === void 0 || !revisionFieldIsValid(command.expectedRevision, envelope.expectedRevision)) return new DecisionBeforePreparation(envelope, identity, rejected("rejectedMalformed", false, true));
		if (!command.caller.admits(envelope.caller)) return new DecisionBeforePreparation(envelope, identity, rejected("rejectedAuthentication"));
		return {
			envelope,
			command,
			identity
		};
	}
	decode(rawEnvelope) {
		if (rawEnvelope.byteLength > this.#limits.envelopeBytes) return void 0;
		try {
			return CommandEnvelopeCodec.decode(rawEnvelope);
		} catch {
			return;
		}
	}
	prepareDecision(transaction, request, prepared, envelopeDigest, now) {
		const state = inspectPreparedCommandPayload(prepared);
		if (state === void 0) return invalidPayload;
		const { lease, binding } = state;
		if (lease === void 0 || binding === void 0 || !binding.matches(this.#tenant, this.#actor, envelopeDigest, request.envelope.payload, request.envelope.payloadDigest)) return invalidPayload;
		if (!lease.matches(binding, now)) return invalidPayload;
		const bytes = lease.read();
		if (bytes.byteLength > this.#limits.payloadBytes || !request.envelope.payload.digest.equals(request.envelope.payloadDigest) || !Digest.sha256(bytes).equals(request.envelope.payloadDigest)) return invalidPayload;
		const payload = (() => {
			try {
				return requireSynchronousResult(request.command.payload.decode(bytes.slice()));
			} catch (error) {
				if (error instanceof CommandPayloadMalformedError) return invalidPayload;
				throw error;
			}
		})();
		if (payload === invalidPayload) return invalidPayload;
		const { command, envelope } = request;
		return { decide: () => {
			if (!this.booleanGate(transaction, (read) => command.authorize(read, envelope, payload))) return rejected("rejectedAuthority", true);
			if (!this.booleanGate(transaction, (read) => command.permitsLifecycle(read, envelope, payload))) return rejected("rejectedLifecycle", true);
			if (envelope.expectedRevision !== void 0) {
				const current = requireSynchronousResult(command.currentRevision(this.readForGate(transaction), envelope, payload));
				if (current === void 0 || !current.equals(envelope.expectedRevision)) return rejected("rejectedRevision", true);
			}
			if (command.lease === "forbidden") {
				if (envelope.lease !== void 0) return rejected("rejectedLease", true);
			} else if (envelope.lease === void 0) {
				if (command.lease !== "optional") return rejected("rejectedLease", true);
			} else {
				const current = requireSynchronousResult(command.currentLease(this.readForGate(transaction), envelope, payload, now));
				const expiresAt = current?.expiresAt?.getTime();
				if (current === void 0 || !current.turn.equals(envelope.lease.turn) || current.holder === void 0 || !current.holder.equals(envelope.lease.holder) || current.epoch !== envelope.lease.epoch || expiresAt === void 0 || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return rejected("rejectedLease", true);
			}
			const execution = requireSynchronousResult(command.execute(transaction, envelope, payload, now));
			if (execution instanceof Uint8Array) return {
				outcome: "committed",
				reply: execution.slice(),
				callerCauseEligible: true,
				reservesIdentity: true
			};
			if (!isObjectRecord(execution) || !("reply" in execution) || command.replyCodec === void 0) requireTypedCommandExecution();
			const reply = requireSynchronousResult(command.replyCodec.encode(execution.reply));
			if (execution.observation === void 0) return {
				outcome: execution.outcome,
				reply,
				callerCauseEligible: true,
				reservesIdentity: true
			};
			if (command.observationCodec === void 0) requireObservationCodec();
			return {
				outcome: execution.outcome,
				reply,
				observation: requireSynchronousResult(command.observationCodec.encode(execution.observation)),
				callerCauseEligible: true,
				reservesIdentity: true
			};
		} };
	}
	persistDecision(transaction, envelope, identity, envelopeDigest, decision, at) {
		const writeId = this.#ids.writeRecordId(transaction);
		const auditId = this.#ids.auditRecordId(transaction);
		const cause = !decision.callerCauseEligible || envelope?.callerCause === void 0 ? void 0 : this.usableCause(transaction, envelope.callerCause);
		let auditCause = cause?.id;
		if (auditCause === void 0 && !commandOutcomeRefused(decision.outcome)) {
			const root = new AuditRecord({
				id: this.#ids.auditRecordId(transaction),
				actor: this.#actor,
				tenant: this.#tenant,
				correlation: this.#ids.correlationId(transaction),
				kind: {
					kind: "invocation",
					id: this.#ids.invocationId(transaction)
				}
			});
			this.appendAudit(transaction, root);
			auditCause = root.id;
		}
		const correlation = cause?.correlation ?? (auditCause === void 0 ? this.#ids.correlationId(transaction) : this.requireAudit(transaction, auditCause).correlation);
		const auditInit = {
			id: auditId,
			actor: this.#actor,
			tenant: this.#tenant,
			correlation,
			kind: {
				kind: "write",
				id: writeId,
				outcome: decision.outcome
			}
		};
		const audit = new AuditRecord(auditCause === void 0 ? auditInit : {
			...auditInit,
			cause: auditCause
		});
		const admission = auditCause === void 0 ? { kind: "commandRejection" } : void 0;
		this.appendAudit(transaction, audit, admission);
		const hasCanonicalIdentity = identity !== void 0 && decision.reservesIdentity;
		const writeInit = {
			id: writeId,
			actor: this.#actor,
			envelopeDigest,
			at,
			outcome: decision.outcome,
			audit: audit.id,
			reply: decision.reply
		};
		if (envelope !== void 0) {
			writeInit.caller = envelope.caller;
			writeInit.command = envelope.command;
		}
		if (hasCanonicalIdentity) writeInit.idempotencyKey = identity.idempotencyKey;
		if (decision.duplicateOf !== void 0) writeInit.duplicateOf = decision.duplicateOf;
		if (decision.observation !== void 0) writeInit.observation = decision.observation;
		const write = new WriteRecord(writeInit);
		this.#persistence.appendWrite(transaction, write);
		const result = {
			kind: "commandOutcome",
			outcome: decision.outcome,
			reply: write.reply,
			write
		};
		return write.observation === void 0 ? result : {
			...result,
			observation: write.observation
		};
	}
	hasInvalidCallerCause(transaction, envelope) {
		return envelope.callerCause !== void 0 && this.usableCause(transaction, envelope.callerCause) === void 0;
	}
	usableCause(transaction, id) {
		const cause = this.#persistence.findAudit(transaction, id);
		return cause !== void 0 && cause.kind.kind === "invocation" && cause.cause === void 0 && cause.actor.equals(this.#actor) && cause.tenant.equals(this.#tenant) ? cause : void 0;
	}
	requireAudit(transaction, id) {
		const record = this.#persistence.findAudit(transaction, id);
		if (record === void 0) throw new AgentCoreError("protocol.invalid-state", "Appended audit root is not readable in its transaction");
		return record;
	}
	appendAudit(transaction, record, admission) {
		this.#persistence.appendAudit(transaction, record, admission === void 0 ? void 0 : { rootAdmission: admission });
	}
	readForGate(transaction) {
		return this.#store.read(transaction, this.#readOnly, ...[]);
	}
	booleanGate(transaction, evaluate) {
		return requireSynchronousResult(evaluate(this.readForGate(transaction))) === true;
	}
	timestamp() {
		const at = new Date(this.#now());
		if (!Number.isFinite(at.getTime())) throw new AgentCoreError("protocol.invalid-state", "Command timestamp must be valid");
		return at;
	}
};
var DecisionBeforePreparation = class {
	envelope;
	identity;
	decision;
	constructor(envelope, identity, decision) {
		this.envelope = envelope;
		this.identity = identity;
		this.decision = decision;
	}
};
var invalidPayload = Symbol("invalid command payload");
function duplicateDecision(duplicate) {
	return {
		outcome: "duplicate",
		reply: duplicate.reply,
		duplicateOf: duplicate.id,
		callerCauseEligible: true,
		reservesIdentity: true
	};
}
function rejected(outcome, callerCauseEligible = false, reservesIdentity = callerCauseEligible) {
	return {
		outcome,
		reply: encodeCanonicalJson({ outcome }),
		callerCauseEligible,
		reservesIdentity
	};
}
function requireTypedCommandExecution() {
	throw new TypeError("Typed command execution requires a reply codec");
}
function requireObservationCodec() {
	throw new TypeError("Typed command observation requires an observation codec");
}
function validateCommandActorContext(actor, store) {
	try {
		if (isActorActivationStore(store)) return {
			actor,
			store
		};
	} catch {}
	throw new TypeError("Command dispatcher requires an Actor activation store");
}
function revisionFieldIsValid(policy, revision) {
	return policy === "required" ? revision !== void 0 : policy !== "forbidden" || revision === void 0;
}
function isForgedCommitUnknown(cause) {
	return cause instanceof CommandCommitUnknownError;
}
function invalidCommitUnknownOrigin() {
	return new AgentCoreError("protocol.invalid-state", "Commit uncertainty cannot originate inside an Actor transaction");
}
function validateLimit(value, name) {
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Command ${name} byte limit must be a positive safe integer`);
}
//#endregion
//#region src/protocol/ingress.ts
var CommandIngress = class {
	#dispatcher;
	#content;
	#authenticator;
	#leaseForMilliseconds;
	#now;
	constructor(init) {
		const leaseForMilliseconds = init.leaseForMilliseconds;
		if (!Number.isSafeInteger(leaseForMilliseconds) || leaseForMilliseconds === void 0 || leaseForMilliseconds <= 0) throw new TypeError("Command payload lease duration must be a positive safe integer");
		this.#dispatcher = init.dispatcher;
		this.#content = init.content;
		if (!(init.authenticator instanceof CommandAuthenticator)) throw new TypeError("Command ingress requires a transport authenticator");
		this.#authenticator = init.authenticator;
		this.#leaseForMilliseconds = leaseForMilliseconds;
		this.#now = init.now ?? (() => /* @__PURE__ */ new Date());
	}
	async accept(rawEnvelope, transport, submittedBytes) {
		const submittedEnvelope = rawEnvelope.slice();
		const submittedPayload = submittedBytes?.slice();
		const speculativeEnvelope = this.#dispatcher.decodeForPreparation(submittedEnvelope);
		const authenticationEnvelope = this.#dispatcher.decodeForAuthentication(submittedEnvelope);
		let authentication;
		try {
			authentication = authenticationEnvelope === void 0 ? void 0 : await this.#authenticator.authenticate(transport, authenticationEnvelope, Digest.sha256(submittedEnvelope));
		} catch (error) {
			return {
				...preDispatchDisposition("admissionPreflight", void 0, false),
				cause: error
			};
		}
		let admission;
		try {
			admission = await this.#dispatcher.admit(submittedEnvelope, authentication);
		} catch (error) {
			return {
				...preDispatchDisposition("admissionPreflight", commitUnknown(error) ? error : void 0, true),
				cause: error
			};
		}
		if (admission.kind === "completed") return admission.result;
		let prepared;
		try {
			prepared = speculativeEnvelope === void 0 ? issueMalformedCommandPayload("absent") : await this.prepare(submittedEnvelope, speculativeEnvelope, submittedPayload);
		} catch (error) {
			return {
				...preDispatchDisposition("admissionPreflight", void 0, false),
				cause: error
			};
		}
		try {
			return await admission.dispatch(prepared);
		} catch (error) {
			return {
				...preDispatchDisposition("dispatch", commitUnknown(error) ? error : void 0, true),
				cause: error
			};
		} finally {
			try {
				await inspectPreparedCommandPayload(prepared)?.lease?.close();
			} catch {}
		}
	}
	async prepare(rawEnvelope, envelope, submittedBytes) {
		const binding = new PayloadLeaseBinding(this.#dispatcher.tenant, this.#dispatcher.actor, Digest.sha256(rawEnvelope), envelope.payload, envelope.payloadDigest, leaseExpiry(this.#now(), this.#leaseForMilliseconds));
		if (!envelope.payload.digest.equals(envelope.payloadDigest)) return issueMalformedCommandPayload("referenceMismatch");
		if (submittedBytes !== void 0) {
			if (submittedBytes.byteLength > this.#dispatcher.limits.payloadBytes) return issueMalformedCommandPayload("tooLarge");
			if (!Digest.sha256(submittedBytes).equals(envelope.payloadDigest)) return issueMalformedCommandPayload("submittedMismatch");
		}
		const lease = await this.#content.acquire(binding, submittedBytes);
		return lease === void 0 ? issueMalformedCommandPayload("missing") : issueLeasedCommandPayload(lease, binding);
	}
};
function preDispatchDisposition(phase, uncertain, transactionAttempted) {
	const unknown = transactionAttempted && uncertain !== void 0;
	const retrySameKey = unknown && uncertain.retrySameKey;
	return {
		kind: "preDispatchFailure",
		phase,
		commit: unknown ? "unknown" : transactionAttempted ? "rolledBack" : "notAttempted",
		retry: retrySameKey ? "retrySameKey" : "mayRetry"
	};
}
function commitUnknown(cause) {
	return cause instanceof CommandCommitUnknownError;
}
function leaseExpiry(now, duration) {
	const nowTime = now.getTime();
	const expiresAt = nowTime + duration;
	if (!Number.isFinite(nowTime) || !Number.isSafeInteger(expiresAt)) throw new AgentCoreError("protocol.invalid-state", "Command payload lease expiry is invalid");
	return new Date(expiresAt);
}
//#endregion
//#region src/protocol/persistence.ts
var ProtocolRecordStorage = class {};
var ProtocolPersistenceAdapter = class {
	repair(transaction) {
		const storage = this.storage(transaction);
		storage.synchronizeIdentityProjection(this.validateStoredGraph(storage));
	}
	findWrite(transaction, identity) {
		const storage = this.storage(transaction);
		const originals = this.originalIdentityEntries(storage);
		storage.synchronizeIdentityProjection(originals);
		const key = identityProjectionKey(projectIdentity(identity));
		const match = originals.find((entry) => identityProjectionKey(entry.identity) === key);
		if (match === void 0) return void 0;
		const write = this.loadWrite(storage, match.writeId.value);
		if (write === void 0) throw corruptProtocol("Command identity points to a missing write record");
		this.requireReciprocalAudit(storage, write);
		return write;
	}
	findWriteById(transaction, id) {
		const storage = this.storage(transaction);
		const write = this.loadWrite(storage, id.value);
		if (write !== void 0) {
			this.requireReciprocalAudit(storage, write);
			this.validateStoredDuplicate(storage, write);
		}
		return write;
	}
	findAudit(transaction, id) {
		const storage = this.storage(transaction);
		const audit = this.loadAudit(storage, id.value);
		if (audit?.kind.kind === "write") {
			const write = this.loadWrite(storage, audit.kind.id.value);
			if (write === void 0) throw corruptProtocol("Write audit points to a missing write record");
			validateReciprocalRecords(audit, write);
			this.validateStoredWriteAuditCause(storage, audit);
			this.validateStoredDuplicate(storage, write);
		}
		return audit;
	}
	findAuditByEvidence(transaction, actor, kind) {
		const storage = this.storage(transaction);
		const identity = auditEvidenceIdentity(actor, kind).value;
		const stored = storage.findAuditByEvidence(identity);
		if (stored === void 0) return void 0;
		if (stored.evidenceIdentity !== identity) throw corruptRecord("Stored audit evidence lookup returned a mismatched projection");
		return this.decodeStoredAudit(stored, stored.id);
	}
	appendAudit(transaction, record, context) {
		const storage = this.storage(transaction);
		const bytes = AuditRecordCodec.encode(record);
		const decoded = AuditRecordCodec.decode(bytes);
		if (storage.findAudit(decoded.id.value) !== void 0) throw corruptProtocol("Audit records are append-only");
		validateAuditAppend(decoded, { get: (id) => this.findAudit(transaction, id) }, context?.rootAdmission, context?.evidence);
		const identity = auditEvidenceIdentity(decoded.actor, decoded.kind).value;
		if (storage.findAuditByEvidence(identity) !== void 0) throw corruptProtocol("Audit evidence relation is already recorded");
		storage.insertAudit(projectAudit(decoded, bytes));
	}
	appendWrite(transaction, record) {
		const storage = this.storage(transaction);
		const bytes = WriteRecordCodec.encode(record);
		const decoded = WriteRecordCodec.decode(bytes);
		if (storage.findWrite(decoded.id.value) !== void 0) throw corruptProtocol("Write records are append-only");
		const audit = this.loadAudit(storage, decoded.audit.value);
		if (audit === void 0) throw corruptProtocol("Write audit must exist before append");
		validateReciprocalRecords(audit, decoded);
		const identity = identityForWrite(decoded);
		if (decoded.outcome === "duplicate") {
			this.validateDuplicate(transaction, decoded, identity);
			storage.insertWrite(projectWrite(decoded, bytes), void 0);
			return;
		}
		if (writeReservesIdentity(decoded)) {
			if (identity === void 0) throw corruptProtocol("An original write requires its canonical command identity");
			if (this.findWrite(transaction, identity) !== void 0) throw corruptProtocol("Command identity is already reserved");
		} else if (identity !== void 0) throw corruptProtocol("Unindexable writes cannot contain an idempotency key");
		storage.insertWrite(projectWrite(decoded, bytes), identity === void 0 ? void 0 : projectIdentity(identity));
	}
	validateDuplicate(transaction, duplicate, identity) {
		if (identity === void 0) throw corruptProtocol("Duplicate writes require their original command identity");
		const original = this.findWrite(transaction, identity);
		if (original === void 0 || !duplicate.duplicateOf?.equals(original.id) || !duplicate.actor.equals(original.actor) || !bytesEqual(duplicate.reply, original.reply)) throw corruptProtocol("Duplicate write must identify the reserved original write");
	}
	validateStoredDuplicate(storage, write) {
		const original = validateDuplicateLineage(write, { get: (id) => this.loadWrite(storage, id.value) });
		if (original !== void 0) this.requireReciprocalAudit(storage, original);
	}
	originalIdentityEntries(storage) {
		const writes = [];
		for (const stored of storage.scanWrites()) writes.push(this.decodeStoredWrite(stored, stored.id));
		return identityEntries(writes);
	}
	validateStoredGraph(storage) {
		const audits = /* @__PURE__ */ new Map();
		const auditLookup = { get: (id) => audits.get(id.value) };
		const evidence = /* @__PURE__ */ new Set();
		for (const stored of storage.scanAudits()) {
			if (audits.has(stored.id)) throw corruptProtocol("Stored protocol contains duplicate audit identifiers");
			const audit = this.decodeStoredAudit(stored, stored.id);
			const identity = auditEvidenceIdentity(audit.actor, audit.kind).value;
			if (evidence.has(identity)) throw corruptProtocol("Stored protocol contains duplicate audit evidence relations");
			evidence.add(identity);
			audits.set(stored.id, audit);
		}
		for (const audit of audits.values()) try {
			validateStoredAuditLinkage(audit, auditLookup);
		} catch (error) {
			if (error instanceof AgentCoreError) throw corruptProtocol(`Stored audit graph is invalid: ${error.message}`);
			throw error;
		}
		const writes = /* @__PURE__ */ new Map();
		const writeLookup = { get: (id) => writes.get(id.value) };
		for (const stored of storage.scanWrites()) {
			if (writes.has(stored.id)) throw corruptProtocol("Stored protocol contains duplicate write identifiers");
			writes.set(stored.id, this.decodeStoredWrite(stored, stored.id));
		}
		for (const write of writes.values()) {
			const audit = audits.get(write.audit.value);
			if (audit === void 0) throw corruptProtocol("Write record points to a missing audit record");
			validateReciprocalRecords(audit, write);
			validateWriteAuditCause(audit, auditLookup);
			validateDuplicateLineage(write, writeLookup);
		}
		for (const audit of audits.values()) {
			if (audit.kind.kind !== "write") continue;
			const write = writes.get(audit.kind.id.value);
			if (write === void 0) throw corruptProtocol("Write audit points to a missing write record");
			validateReciprocalRecords(audit, write);
			validateWriteAuditCause(audit, auditLookup);
		}
		return identityEntries(writes.values());
	}
	loadAudit(storage, id) {
		const stored = storage.findAudit(id);
		return stored === void 0 ? void 0 : this.decodeStoredAudit(stored, id);
	}
	decodeStoredAudit(stored, id) {
		const record = AuditRecordCodec.decode(copyBytes(stored.bytes, "audit"));
		const projection = projectAudit(record, stored.bytes);
		if (stored.id !== id || stored.id !== projection.id || stored.evidenceIdentity !== projection.evidenceIdentity || stored.evidenceKind !== projection.evidenceKind || !optionalWriteIdsEqual(stored.writeId, projection.writeId) || stored.writeOutcome !== projection.writeOutcome) throw corruptRecord("Stored audit key or projection does not match its codec bytes");
		return record;
	}
	loadWrite(storage, id) {
		const stored = storage.findWrite(id);
		return stored === void 0 ? void 0 : this.decodeStoredWrite(stored, id);
	}
	decodeStoredWrite(stored, id) {
		const record = WriteRecordCodec.decode(copyBytes(stored.bytes, "write"));
		const projection = projectWrite(record, stored.bytes);
		if (stored.id !== id || stored.id !== projection.id || !stored.auditId.equals(projection.auditId) || stored.outcome !== projection.outcome) throw corruptRecord("Stored write key or projection does not match its codec bytes");
		return record;
	}
	requireReciprocalAudit(storage, write) {
		const audit = this.loadAudit(storage, write.audit.value);
		if (audit === void 0) throw corruptProtocol("Write record points to a missing audit record");
		validateReciprocalRecords(audit, write);
		this.validateStoredWriteAuditCause(storage, audit);
		return audit;
	}
	validateStoredWriteAuditCause(storage, audit) {
		validateWriteAuditCause(audit, { get: (id) => this.loadAudit(storage, id.value) });
	}
};
function protocolIdentityProjection(identity) {
	return projectIdentity(identity);
}
function protocolIdentityProjectionsEqual(left, right) {
	return left.idempotencyKey === right.idempotencyKey && left.caller.kind === right.caller.kind && left.caller.id === right.caller.id && (left.caller.kind !== "principal" || right.caller.kind === "principal" && left.caller.tenantId.equals(right.caller.tenantId)) && (left.caller.kind !== "actor" || right.caller.kind === "actor" && left.caller.actorKind === right.caller.actorKind);
}
function identityEntries(writes) {
	const entries = [];
	const identities = /* @__PURE__ */ new Map();
	for (const write of writes) {
		if (!writeReservesIdentity(write)) continue;
		const identity = identityForWrite(write);
		if (identity === void 0) throw corruptProtocol("An original write is missing its canonical command identity");
		const projected = projectIdentity(identity);
		const key = identityProjectionKey(projected);
		if (identities.has(key)) throw corruptProtocol("Conflicting original writes reserve one command identity");
		identities.set(key, write.id.value);
		entries.push({
			writeId: write.id,
			identity: projected
		});
	}
	return entries;
}
function identityProjectionKey(identity) {
	return JSON.stringify(identity.caller.kind === "principal" ? [
		identity.caller.kind,
		identity.caller.tenantId.value,
		identity.caller.id,
		identity.idempotencyKey
	] : [
		identity.caller.kind,
		identity.caller.actorKind,
		identity.caller.id,
		identity.idempotencyKey
	]);
}
function validateWriteAuditCause(audit, audits) {
	if (audit.kind.kind !== "write") throw corruptProtocol("Write audit evidence kind is invalid");
	if (audit.cause === void 0) {
		if (!commandOutcomeRefused(audit.kind.outcome)) throw corruptProtocol("Only rejected writes may have a cause-free audit root");
		return;
	}
	const cause = audits.get(audit.cause);
	if (cause === void 0 || cause.kind.kind !== "invocation" || cause.cause !== void 0 || !cause.actor.equals(audit.actor) || !cause.tenant.equals(audit.tenant) || !cause.correlation.equals(audit.correlation)) throw corruptProtocol("Write audit cause is not a matching local Invocation root");
}
/**
* The original a duplicate write names, or undefined when the write is not a duplicate
* and so names none. Returning it is what lets the storage-backed caller carry on to the
* reciprocal audit without repeating the lineage rules or reloading the record.
*/
function validateDuplicateLineage(write, writes) {
	if (write.outcome !== "duplicate") return void 0;
	const original = write.duplicateOf === void 0 ? void 0 : writes.get(write.duplicateOf);
	const originalIdentity = original === void 0 ? void 0 : identityForWrite(original);
	const duplicateIdentity = identityForWrite(write);
	if (original === void 0 || !writeReservesIdentity(original) || originalIdentity === void 0 || duplicateIdentity === void 0 || !identitiesEqual(originalIdentity, duplicateIdentity) || !write.actor.equals(original.actor) || !bytesEqual(write.reply, original.reply)) throw corruptProtocol("Duplicate write does not name a valid original write");
	return original;
}
function projectIdentity(identity) {
	return {
		caller: projectCaller(identity.caller),
		idempotencyKey: identity.idempotencyKey
	};
}
function projectCaller(caller) {
	return caller.kind === "principal" ? {
		kind: caller.kind,
		tenantId: caller.principal.tenantId,
		id: caller.principal.principalId.value
	} : {
		kind: caller.kind,
		actorKind: caller.actor.kind,
		id: caller.actor.id.value
	};
}
function projectAudit(record, bytes) {
	const evidenceIdentity = auditEvidenceIdentity(record.actor, record.kind).value;
	return record.kind.kind === "write" ? {
		id: record.id.value,
		evidenceIdentity,
		evidenceKind: record.kind.kind,
		writeId: record.kind.id,
		writeOutcome: record.kind.outcome,
		bytes: bytes.slice()
	} : {
		id: record.id.value,
		evidenceIdentity,
		evidenceKind: record.kind.kind,
		bytes: bytes.slice()
	};
}
function projectWrite(record, bytes) {
	return {
		id: record.id.value,
		auditId: record.audit,
		outcome: record.outcome,
		bytes: bytes.slice()
	};
}
function identityForWrite(write) {
	return write.caller === void 0 || write.idempotencyKey === void 0 ? void 0 : {
		caller: write.caller,
		idempotencyKey: write.idempotencyKey
	};
}
function identitiesEqual(left, right) {
	return left.idempotencyKey === right.idempotencyKey && commandCallersEqual(left.caller, right.caller);
}
function validateReciprocalRecords(audit, write) {
	if (audit.kind.kind !== "write" || !audit.kind.id.equals(write.id) || audit.kind.outcome !== write.outcome || !write.audit.equals(audit.id) || !write.actor.equals(audit.actor)) throw corruptProtocol("Write record and audit record are not reciprocal");
}
function bytesEqual(left, right) {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
function optionalWriteIdsEqual(left, right) {
	return left === void 0 ? right === void 0 : right !== void 0 && left.equals(right);
}
function copyBytes(value, record) {
	if (!(value instanceof Uint8Array)) throw corruptRecord(`Stored ${record} bytes are malformed`);
	return value.slice();
}
function corruptRecord(message) {
	return new AgentCoreError("codec.invalid", message);
}
function corruptProtocol(message) {
	return new AgentCoreError("protocol.invalid-state", message);
}
//#endregion
//#region src/protocol/memory.ts
var MemoryProtocolRecords = class MemoryProtocolRecords extends ProtocolRecordStorage {
	#audits = /* @__PURE__ */ new Map();
	#auditsByEvidence = /* @__PURE__ */ new Map();
	#writes = /* @__PURE__ */ new Map();
	constructor(snapshot) {
		super();
		if (snapshot !== void 0 && (!isObjectRecord(snapshot) || !Array.isArray(snapshot.audits) || !Array.isArray(snapshot.writes))) throw corruptSnapshot("Memory protocol snapshot is malformed");
		for (const audit of snapshot?.audits ?? []) {
			const stored = copyAudit(audit);
			if (this.#audits.has(stored.id)) throw corruptSnapshot("Memory protocol snapshot contains duplicate audit records");
			if (this.#auditsByEvidence.has(stored.evidenceIdentity)) throw corruptSnapshot("Memory protocol snapshot contains duplicate audit evidence relations");
			this.#audits.set(stored.id, stored);
			this.#auditsByEvidence.set(stored.evidenceIdentity, stored.id);
		}
		for (const write of snapshot?.writes ?? []) {
			const stored = copyWrite(write);
			if (this.#writes.has(stored.id)) throw corruptSnapshot("Memory protocol snapshot contains duplicate write records");
			this.#writes.set(stored.id, stored);
		}
		Object.freeze(this);
	}
	findAudit(id) {
		const record = this.#audits.get(id);
		return record === void 0 ? void 0 : copyAudit(record);
	}
	findAuditByEvidence(identity) {
		const id = this.#auditsByEvidence.get(identity);
		if (id === void 0) return void 0;
		const record = this.#audits.get(id);
		if (record === void 0) throw corruptSnapshot("Memory protocol audit evidence points to a missing record");
		return copyAudit(record);
	}
	findWrite(id) {
		const record = this.#writes.get(id);
		return record === void 0 ? void 0 : copyWrite(record);
	}
	scanAudits() {
		return [...this.#audits.values()].map(copyAudit);
	}
	scanWrites() {
		return [...this.#writes.values()].map(copyWrite);
	}
	insertAudit(record) {
		const stored = copyAudit(record);
		if (this.#audits.has(stored.id)) throw invalidProtocolState("Audit records are append-only");
		if (this.#auditsByEvidence.has(stored.evidenceIdentity)) throw invalidProtocolState("Audit evidence relation is append-only");
		this.#audits.set(stored.id, stored);
		this.#auditsByEvidence.set(stored.evidenceIdentity, stored.id);
	}
	insertWrite(record, _identity) {
		const stored = copyWrite(record);
		if (this.#writes.has(stored.id)) throw invalidProtocolState("Write records are append-only");
		this.#writes.set(stored.id, stored);
	}
	synchronizeIdentityProjection(_entries) {}
	clone() {
		return new MemoryProtocolRecords(this.snapshot());
	}
	snapshot() {
		const writes = [...this.#writes.values()].map(copyWrite);
		return {
			audits: [...this.#audits.values()].map(copyAudit),
			writes,
			identities: derivedIdentities(writes)
		};
	}
	[ACTOR_STATE_SNAPSHOT]() {
		return this.snapshot();
	}
};
var MemoryProtocolPersistence = class extends ProtocolPersistenceAdapter {
	records;
	constructor(records) {
		super();
		this.records = records;
	}
	storage(transaction) {
		return this.records(transaction);
	}
};
function derivedIdentities(writes) {
	return writes.flatMap((stored) => {
		const write = WriteRecordCodec.decode(stored.bytes);
		if (!writeReservesIdentity(write) || write.caller === void 0 || write.idempotencyKey === void 0) return [];
		return [{
			writeId: write.id,
			identity: {
				caller: write.caller.kind === "principal" ? {
					kind: write.caller.kind,
					tenantId: write.caller.principal.tenantId,
					id: write.caller.principal.principalId.value
				} : {
					kind: write.caller.kind,
					actorKind: write.caller.actor.kind,
					id: write.caller.actor.id.value
				},
				idempotencyKey: write.idempotencyKey
			}
		}];
	});
}
var parseAuditSnapshot = jsonDataParser(() => corruptSnapshot("Memory protocol snapshot contains a malformed audit record"));
var parseWriteSnapshot = jsonDataParser(() => corruptSnapshot("Memory protocol snapshot contains a malformed write record"));
function copyAudit(record) {
	if (!isObjectRecord(record) || !(record.bytes instanceof Uint8Array)) throw corruptSnapshot("Memory protocol snapshot contains a malformed audit record");
	parseAuditSnapshot.string(record.id, "id");
	parseAuditSnapshot.string(record.evidenceIdentity, "evidenceIdentity");
	parseAuditSnapshot.string(record.evidenceKind, "evidenceKind");
	const writeId = record.writeId;
	if (writeId !== void 0 && !(writeId instanceof WriteRecordId)) throw corruptSnapshot("Memory protocol snapshot contains a malformed audit record");
	const writeOutcome = record.writeOutcome;
	if (writeOutcome !== void 0) parseAuditSnapshot.string(writeOutcome, "writeOutcome");
	const copied = {
		id: record.id,
		evidenceIdentity: record.evidenceIdentity,
		evidenceKind: record.evidenceKind,
		bytes: record.bytes.slice()
	};
	if (writeId !== void 0) copied.writeId = new WriteRecordId(writeId.value);
	if (writeOutcome !== void 0) copied.writeOutcome = writeOutcome;
	return copied;
}
function copyWrite(record) {
	if (!isObjectRecord(record) || !(record.auditId instanceof AuditRecordId) || !(record.bytes instanceof Uint8Array)) throw corruptSnapshot("Memory protocol snapshot contains a malformed write record");
	parseWriteSnapshot.string(record.id, "id");
	parseWriteSnapshot.string(record.outcome, "outcome");
	return {
		id: record.id,
		auditId: new AuditRecordId(record.auditId.value),
		outcome: record.outcome,
		bytes: record.bytes.slice()
	};
}
function corruptSnapshot(message) {
	return new AgentCoreError("codec.invalid", message);
}
function invalidProtocolState(message) {
	return new AgentCoreError("protocol.invalid-state", message);
}
//#endregion
//#region src/protocol/bootstrap-memory.ts
var MemoryTenantBootstrap = class {
	#store;
	#ingress;
	tenantId;
	constructor(init) {
		const restored = snapshotValue(init.snapshot);
		const initial = restored?.state ?? {
			control: MemoryTenantControlStore.create(init.anchor).snapshot(),
			protocol: new MemoryProtocolRecords(),
			nextId: 0
		};
		const storedAnchor = MemoryTenantControlStore.restore(initial.control).bootstrapAnchor();
		if (!anchorsEqual(storedAnchor, init.anchor)) throw new AgentCoreError("protocol.invalid-state", "Memory Tenant bootstrap anchor changed across restart");
		const target = {
			actor: init.actor,
			tenantId: storedAnchor.tenantId
		};
		this.tenantId = target.tenantId;
		try {
			this.#store = restored === void 0 ? new MemoryActorStore(initial, cloneState) : MemoryActorStore.restore(restored, cloneState);
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw new AgentCoreError("codec.invalid", "Memory Tenant bootstrap snapshot is malformed");
		}
		const persistence = new MemoryProtocolPersistence((state) => state.protocol);
		const backend = {
			anchor: (_read) => storedAnchor,
			anchorInTransaction: (transaction) => MemoryTenantControlStore.restore(transaction.control).bootstrapAnchor(),
			eligible: (read) => read.eligible,
			currentRevision: (read) => read.revision,
			bootstrapTenant: (transaction, anchor, expectedRevision) => {
				const control = MemoryTenantControlStore.restore(transaction.control);
				control.bootstrapTenant(anchor, expectedRevision);
				transaction.control = control.snapshot();
			}
		};
		try {
			const dispatcher = new CommandDispatcher({
				store: this.#store,
				persistence,
				ids: {
					writeRecordId: (transaction) => new WriteRecordId(nextId(transaction, "write")),
					auditRecordId: (transaction) => new AuditRecordId(nextId(transaction, "audit")),
					correlationId: (transaction) => new CorrelationId(nextId(transaction, "correlation")),
					invocationId: (transaction) => new InvocationId(nextId(transaction, "invocation"))
				},
				actor: init.actor,
				tenant: storedAnchor.tenantId,
				readOnly: (state) => {
					const control = MemoryTenantControlStore.restore(state.control);
					return Object.freeze({
						eligible: control.isBootstrapEligible(),
						revision: Revision.initial()
					});
				},
				commands: [createTenantBootstrapCommand(backend, target)],
				limits: {
					envelopeBytes: 16384,
					payloadBytes: 16384
				}
			});
			this.#ingress = new CommandIngress({
				dispatcher,
				content: init.content,
				authenticator: init.authenticator,
				leaseForMilliseconds: 6e4
			});
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw new AgentCoreError("protocol.invalid-state", "Tenant bootstrap Actor state is invalid");
		}
	}
	accept(envelope, transport, submittedBytes) {
		return this.#ingress.accept(envelope, transport, submittedBytes);
	}
	async dispatch(envelope, transport, submittedBytes) {
		const result = await this.accept(envelope, transport, submittedBytes);
		if (result.kind === "preDispatchFailure") throw result.cause;
		return result;
	}
	snapshot() {
		return Object.freeze({
			version: 1,
			opaque: this.#store.snapshot()
		});
	}
};
function snapshotValue(snapshot) {
	if (snapshot === void 0) return void 0;
	if (!isObjectRecord(snapshot) || !hasExactKeys(snapshot, ["opaque", "version"]) || snapshot.version !== 1 || !isRestoredActorSnapshot(snapshot.opaque)) throw new AgentCoreError("codec.invalid", "Memory Tenant bootstrap snapshot is malformed");
	try {
		cloneState(snapshot.opaque.state);
	} catch (error) {
		if (error instanceof AgentCoreError) throw error;
		throw new AgentCoreError("codec.invalid", "Memory Tenant bootstrap snapshot is malformed");
	}
	return snapshot.opaque;
}
function isRestoredActorSnapshot(value) {
	if (!isObjectRecord(value) || !isObjectRecord(value["state"])) return false;
	const carrier = value["recordSetDeclaration"];
	const legacy = hasExactKeys(value, [
		"actor",
		"recoveryState",
		"state",
		"version"
	]) && value["version"] === 1;
	const current = hasExactKeys(value, [
		"actor",
		"recordSetDeclaration",
		"recoveryState",
		"state",
		"version"
	]) && value["version"] === 2 && (carrier === null || carrier instanceof Uint8Array);
	if (!legacy && !current || !isSnapshotActor(value["actor"]) || value["recoveryState"] !== null && !(value["recoveryState"] instanceof Uint8Array)) throw new AgentCoreError("codec.invalid", "Memory Actor snapshot is malformed");
	return true;
}
function isSnapshotActor(value) {
	if (value === null) return true;
	if (!isObjectRecord(value) || !hasExactKeys(value, ["id", "kind"]) || !isString(value["id"])) return false;
	const kind = value["kind"];
	return kind === "tenant" || kind === "workspace" || kind === "run" || kind === "environment" || kind === "slate";
}
function isString(value) {
	return typeof value === "string";
}
function createMemoryTenantBootstrap(init) {
	return new MemoryTenantBootstrap(init);
}
function cloneState(state) {
	if (!Number.isSafeInteger(state.nextId) || state.nextId < 0) throw new AgentCoreError("codec.invalid", "Memory Tenant bootstrap snapshot is malformed");
	return {
		control: MemoryTenantControlStore.restore(state.control).snapshot(),
		protocol: state.protocol.clone(),
		nextId: state.nextId
	};
}
function nextId(state, prefix) {
	if (!Number.isSafeInteger(state.nextId) || state.nextId < 0 || state.nextId === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("protocol.invalid-state", "Memory bootstrap protocol ID is exhausted");
	state.nextId += 1;
	return `${prefix}-${state.nextId}`;
}
function anchorsEqual(left, right) {
	return left.actorId.equals(right.actorId) && left.tenantId.equals(right.tenantId) && left.principalId.equals(right.principalId) && (left.tenantKind ?? "personal") === (right.tenantKind ?? "personal") && left.trustAnchor.byteLength === right.trustAnchor.byteLength && left.trustAnchor.every((value, index) => value === right.trustAnchor[index]);
}
//#endregion
//#region src/protocol/authority-evidence.ts
var parseReply = jsonDataParser(() => new AgentCoreError("codec.invalid", "Authority protocol reply is malformed"));
var parseRequest = jsonDataParser(() => new AgentCoreError("codec.invalid", "Authority protocol payload is malformed"));
var AuthorityCheckReplyCodec = class extends RecordCodec {
	constructor() {
		super([
			AuthorityCheckReply,
			ActorRef,
			TextId,
			AuthorityCheckEvidence,
			PathEpochEvidence,
			ScopeEpoch,
			ScopeRef,
			Digest,
			ActorId,
			TenantId,
			ProjectId,
			WorkspaceId,
			GrantId
		], "protocol.authority-check-reply", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(reply) {
		return { evidence: reply.evidence.toData() };
	}
	decodePayload(payload) {
		return new AuthorityCheckReply(AuthorityCheckEvidence.fromData(singleField(payload, "evidence")));
	}
};
var BindingValidationReplyCodec = class extends RecordCodec {
	constructor() {
		super([
			BindingValidationReply,
			ActorRef,
			GuestVerificationScheme,
			ScopeRef,
			TextId,
			PathEpochEvidence,
			BindingValidationEvidence,
			ScopeEpoch,
			Digest,
			ActorId,
			TeamId,
			TenantId,
			WorkspaceId,
			GrantId,
			ProjectId,
			PrincipalId,
			PrincipalRef
		], "protocol.binding-validation-reply", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(reply) {
		return { evidence: reply.evidence.toData() };
	}
	decodePayload(payload) {
		return new BindingValidationReply(BindingValidationEvidence.fromData(singleField(payload, "evidence")));
	}
};
var AuthorityPermitIssuanceRequestCodec = class extends RecordCodec {
	constructor() {
		super([
			AuthorityPermitIssuanceRequest,
			ActorRef,
			GuestVerificationScheme,
			Revision,
			ScopeRef,
			TextId,
			SemVer,
			AuthorityCheckRequest,
			AuthorityPermitExpectation,
			Binding,
			BindingLifecycle,
			TargetAuthorityPermitRequest,
			TargetLeaseEvidenceKey,
			TargetLeaseEvidenceReference,
			BindingCredentialCustody,
			PathEpochEvidence,
			PackagePin,
			ScopeEpoch,
			FacetRef,
			ProtectionDomain,
			Digest,
			OperationRef,
			SecretRef,
			PrincipalRef,
			RunId,
			BindingName,
			InvocationId,
			ActorId,
			FacetPackageId,
			PackageId,
			TeamId,
			ItemClaimId,
			OperationName,
			ClaimWorkerId,
			TenantId,
			WorkspaceId,
			TurnId,
			GrantId,
			ProjectId,
			PrincipalId
		], "protocol.authority-permit-issuance-request", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(request) {
		return { request: request.targetRequest.toData() };
	}
	decodePayload(payload) {
		const object = parseRequest.exact(parseRequest.object(payload, "Authority protocol payload"), ["request"], "Authority protocol payload");
		return new AuthorityPermitIssuanceRequest(TargetAuthorityPermitRequest.fromData(object["request"]));
	}
};
var AuthorityPermitIssuanceReplyCodec = class extends RecordCodec {
	constructor() {
		super([
			AuthorityPermitIssuanceReply,
			ActorRef,
			Revision,
			TextId,
			SemVer,
			AuthorityPermitExpectation,
			AuthorityCheckEvidence,
			AuthorityPermit,
			PathEpochEvidence,
			PackagePin,
			ScopeEpoch,
			FacetRef,
			ScopeRef,
			Digest,
			OperationRef,
			PrincipalRef,
			RunId,
			BindingName,
			InvocationId,
			ActorId,
			PackageId,
			ItemClaimId,
			ClaimWorkerId,
			TenantId,
			TurnId,
			ProjectId,
			PrincipalId,
			FacetPackageId,
			ProtectionDomain,
			OperationName,
			WorkspaceId,
			GrantId
		], "protocol.authority-permit-issuance-reply", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(reply) {
		return {
			evidence: reply.evidence.toData(),
			kind: reply.kind,
			permit: reply.kind === "issued" ? reply.requirePermit().toData() : null
		};
	}
	decodePayload(payload) {
		const object = parseReply.exact(parseReply.object(payload, "Authority permit issuance reply"), [
			"evidence",
			"kind",
			"permit"
		], "Authority permit issuance reply");
		const evidence = AuthorityCheckEvidence.fromData(object["evidence"]);
		if (object["kind"] === "denied" && object["permit"] === null) return AuthorityPermitIssuanceReply.denied(evidence);
		if (object["kind"] === "issued" && object["permit"] !== null) return AuthorityPermitIssuanceReply.issued(evidence, AuthorityPermit.fromData(object["permit"]));
		throw new AgentCoreError("codec.invalid", "Authority permit issuance reply is malformed");
	}
};
var AuthorityCheckReply = class AuthorityCheckReply {
	evidence;
	static get codec() {
		return authorityCheckReplyCodecInstance;
	}
	constructor(evidence) {
		this.evidence = evidence;
		Object.freeze(this);
	}
	static encode(reply) {
		return AuthorityCheckReply.codec.encode(reply);
	}
	static decode(bytes) {
		return AuthorityCheckReply.codec.decode(bytes);
	}
};
var authorityCheckReplyCodecInstance = new AuthorityCheckReplyCodec();
var BindingValidationReply = class BindingValidationReply {
	evidence;
	static get codec() {
		return bindingValidationReplyCodecInstance;
	}
	constructor(evidence) {
		this.evidence = evidence;
		Object.freeze(this);
	}
	static encode(reply) {
		return BindingValidationReply.codec.encode(reply);
	}
	static decode(bytes) {
		return BindingValidationReply.codec.decode(bytes);
	}
};
var bindingValidationReplyCodecInstance = new BindingValidationReplyCodec();
var AuthorityPermitIssuanceRequest = class AuthorityPermitIssuanceRequest {
	targetRequest;
	static get codec() {
		return authorityPermitIssuanceRequestCodecInstance;
	}
	constructor(targetRequest) {
		this.targetRequest = targetRequest;
		Object.freeze(this);
	}
	static encode(request) {
		return AuthorityPermitIssuanceRequest.codec.encode(request);
	}
	static decode(bytes) {
		return AuthorityPermitIssuanceRequest.codec.decode(bytes);
	}
};
var authorityPermitIssuanceRequestCodecInstance = new AuthorityPermitIssuanceRequestCodec();
var AuthorityPermitIssuanceReply = class AuthorityPermitIssuanceReply {
	kind;
	evidence;
	permit;
	static get codec() {
		return authorityPermitIssuanceReplyCodecInstance;
	}
	constructor(kind, evidence, permit) {
		this.kind = kind;
		this.evidence = evidence;
		this.permit = permit;
		if (kind === "issued" !== (permit !== void 0) || kind === "issued" !== evidence.allowed) throw new TypeError("Authority permit issuance reply does not match its decision");
		Object.freeze(this);
	}
	static issued(evidence, permit) {
		return new AuthorityPermitIssuanceReply("issued", evidence, permit);
	}
	static denied(evidence) {
		return new AuthorityPermitIssuanceReply("denied", evidence, void 0);
	}
	requirePermit() {
		if (this.permit === void 0) throw new AgentCoreError("protocol.invalid-state", "Denied authority permit reply carries no permit");
		return this.permit;
	}
	static encode(reply) {
		return AuthorityPermitIssuanceReply.codec.encode(reply);
	}
	static decode(bytes) {
		return AuthorityPermitIssuanceReply.codec.decode(bytes);
	}
};
var authorityPermitIssuanceReplyCodecInstance = new AuthorityPermitIssuanceReplyCodec();
function singleField(payload, field) {
	const value = parseReply.exact(parseReply.object(payload, "Authority protocol reply"), [field], "Authority protocol reply")[field];
	if (value === void 0) throw new AgentCoreError("codec.invalid", "Authority protocol reply is malformed");
	return value;
}
//#endregion
//#region src/protocol/materialization-commands.ts
var MATERIALIZATION_COMMANDS = Object.freeze({ applyLocal: "materialization.applyLocal" });
/**
* §8.3: the record this command's own execution decodes and commits against — the plan it
* canonicalizes before applying. The records a local apply writes behind
* `MaterializationCommandBackend` belong to the applying Actor's own store, which declares
* them itself; what a reader of *this* command must be able to decode is the plan. W4's
* treeMerge cutover moved definition.materialization-plan from major 1 to 2, and a store
* written before it is now refused at this declaration rather than at first decode.
*/
var MATERIALIZATION_RECORD_CODECS = CodecDeclaration.of([MaterializationPlan.codec]);
var MaterializationApplyLocalCommand = class {
	backend;
	target;
	controller;
	tenant;
	declaration = MATERIALIZATION_RECORD_CODECS;
	command = MATERIALIZATION_COMMANDS.applyLocal;
	caller;
	expectedRevision = "required";
	lease = "forbidden";
	payload;
	constructor(backend, target, controller, tenant) {
		this.backend = backend;
		this.target = target;
		this.controller = controller;
		this.tenant = tenant;
		if (controller.kind !== "tenant") throw new AgentCoreError("protocol.invalid-state", "Materialization controller must be a Tenant Actor");
		this.caller = new ExactActorCallerPolicy(controller);
		this.payload = new MaterializationApplyLocalPayloadCodec();
	}
	authorize(_read, envelope, payload) {
		const planId = requireApplyLocalPayload(payload).planId;
		const plan = this.backend.loadPlan(_read, planId);
		return callerIsTarget(envelope.caller, this.controller) && plan !== void 0 && storedPlanTargets(plan, planId, this.target, this.tenant);
	}
	permitsLifecycle(read, _envelope, payload) {
		const decoded = requireApplyLocalPayload(payload);
		const plan = this.backend.loadPlan(read, decoded.planId);
		const canonical = plan === void 0 ? void 0 : canonicalTargetPlan(plan, decoded.planId, this.target, this.tenant);
		return canonical !== void 0 && this.backend.permitsApply(read, this.target, canonical);
	}
	currentRevision(read, _envelope, payload) {
		const decoded = requireApplyLocalPayload(payload);
		const plan = this.backend.loadPlan(read, decoded.planId);
		const canonical = plan === void 0 ? void 0 : canonicalTargetPlan(plan, decoded.planId, this.target, this.tenant);
		return canonical === void 0 ? void 0 : this.backend.currentRevision(read, this.target, canonical);
	}
	currentLease(_read, _envelope, _payload, _at) {}
	execute(transaction, _envelope, payload, at) {
		const planId = requireApplyLocalPayload(payload).planId;
		const plan = this.backend.loadPlanForApply(transaction, planId);
		if (plan === void 0) throw new AgentCoreError("protocol.invalid-state", "Persisted local materialization plan is missing or has a foreign target");
		const canonical = requireCanonicalTargetPlan(plan, planId, this.target, this.tenant);
		return this.backend.applyLocal(transaction, this.target, canonical, at);
	}
};
var MaterializationCommandPayload = Object.freeze({ applyLocal(planId) {
	return encodeCanonicalJson({ planId: planId.value });
} });
var ExactActorCallerPolicy = class extends CommandCallerPolicy {
	target;
	constructor(target) {
		super();
		this.target = target;
	}
	admits(caller) {
		return callerIsTarget(caller, this.target);
	}
};
var MaterializationApplyLocalPayloadCodec = class {
	decode(bytes) {
		let decoded;
		try {
			decoded = decodeCanonicalJson(bytes);
		} catch {
			throw new CommandPayloadMalformedError("Local materialization payload must be canonical JSON");
		}
		const object = requirePayloadObject(decoded);
		if (!hasExactJsonKeys(object, ["planId"])) throw new CommandPayloadMalformedError("Local materialization payload contains missing or unknown fields");
		let planId;
		try {
			planId = requireStringValue(object["planId"], "Local materialization plan ID");
		} catch {
			throw new CommandPayloadMalformedError("Local materialization plan ID must be a digest");
		}
		try {
			return Object.freeze({ planId: new Digest(planId) });
		} catch {
			throw new CommandPayloadMalformedError("Local materialization plan ID must be a digest");
		}
	}
};
function requireApplyLocalPayload(payload) {
	if (!isObjectRecord(payload) || !(payload["planId"] instanceof Digest)) throw new TypeError("Local materialization payload was not decoded");
	return Object.freeze({ planId: new Digest(payload["planId"].value) });
}
function canonicalTargetPlan(plan, id, target, tenant) {
	try {
		return requireCanonicalTargetPlan(plan, id, target, tenant);
	} catch {
		return;
	}
}
function storedPlanTargets(plan, id, target, tenant) {
	return plan.id.equals(id) && plan.actors.length === 1 && plan.actors[0].actor.equals(target) && plan.origin.tenantId.equals(tenant);
}
function requireCanonicalTargetPlan(plan, id, target, tenant) {
	const canonical = MaterializationPlan.decode(MaterializationPlan.encode(plan));
	if (!canonical.id.equals(id) || canonical.actors.length !== 1 || !canonical.actors[0].actor.equals(target) || !canonical.origin.tenantId.equals(tenant)) throw new AgentCoreError("protocol.invalid-state", "Persisted local materialization plan is missing or has a foreign target");
	return canonical;
}
function requirePayloadObject(value) {
	try {
		return requireObject(value, "Local materialization payload");
	} catch {
		throw new CommandPayloadMalformedError("Local materialization payload must be an object");
	}
}
function callerIsTarget(caller, target) {
	return caller.kind === "actor" && caller.actor.equals(target);
}
//#endregion
export { TenantBootstrapAnchorRecord as C, requireObject as D, requireNonnegativeInteger as E, CommandCallerPolicy as O, CommandEnvelopeCodec as S, tenantBootstrapPayload as T, CommandPreparationUnavailableError as _, AuthorityPermitIssuanceRequest as a, CommandAuthenticator as b, MemoryProtocolPersistence as c, ProtocolRecordStorage as d, protocolIdentityProjection as f, CommandDispatcher as g, CommandCommitUnknownError as h, AuthorityPermitIssuanceReply as i, PayloadLeaseBinding as k, MemoryProtocolRecords as l, CommandIngress as m, MaterializationApplyLocalCommand as n, MemoryTenantBootstrap as o, protocolIdentityProjectionsEqual as p, MaterializationCommandPayload as r, createMemoryTenantBootstrap as s, MATERIALIZATION_COMMANDS as t, ProtocolPersistenceAdapter as u, WriteRecord as v, createTenantBootstrapCommand as w, CommandEnvelope as x, WriteRecordCodec as y };

//# sourceMappingURL=public-B8XBKjQB.js.map