import { D as encodeCanonicalJson, E as decodeCanonicalJson, M as hasExactJsonKeys, P as isJsonObject, R as jsonDataParser, T as compareCanonicalText, _ as ContentRef, f as RecordCodec, g as Revision, h as SecretRef, i as SemVer, j as TextId, k as AgentCoreError, o as isMember, t as JsonSchema, w as canonicalTupleKey, y as Digest } from "./core-BjYGo1CC.js";
import { d as ActorRef, f as ActorId } from "./actors-DJsP1nFM.js";
import { C as FieldMove, F as PackagePin, I as PackageId, J as CapabilitySpec, O as PayloadMapping, P as ContributionAttribution, T as MappingRecord, at as FacetPackageId, b as IngressVerification, ct as OperationName, gt as canonicalFacetData, it as EventKind, k as ProvenanceMapping, lt as OperationRef, mt as SurfaceId, nt as BindingName, ot as FacetRef, v as EventPattern, vt as dataRecord, w as JsonPointer, x as canonicalTrustTiers, xt as isFacetDataMap, y as IngressDeclaration } from "./runtime-z1yMP0an.js";
import { c as ItemClaimId, i as TurnId, l as ReceiptId, r as RunId, s as EffectAttemptId, t as TaskId } from "./facets-D01bKQBL.js";
import { B as WorkspaceId, C as PrincipalRef, E as encodeScopeRef, F as ProjectId, P as PrincipalId, T as decodeScopeRef, w as ScopeRef, z as TenantId } from "./identity-CoqhjOFj.js";
import { I as GrantId, O as PathEpochEvidence, P as scopeKey, _ as TargetAuthorityPermitDenial, p as StoredAuthorityPermitAdmissionPort, v as TargetAuthorityPermitRequest, w as AuthorityPermit, y as TargetLeaseEvidence } from "./authority-BbHaDuhf.js";
import { F as TurnAdmissionReceiptFacts, I as TurnAdmissionRecordPort, L as TurnAdmissionVerifier, t as GatewayTurnInvocationPort, u as TurnGatewaySource } from "./runs-CRnZ9IFu.js";
import { a as RouteProjectionId, i as InvocationId, n as CorrelationId, o as RouteReservationId, r as EventId, s as SubscriptionId, t as AuditRecordId } from "./interaction-references-D9spp037.js";
import { lt as evaluatePolicy, ut as mergePolicySets } from "./definition-COokGikL.js";
import { $ as AuditRecord, A as DetachedEffectTarget, Et as structuralCodec, F as PreEffectReceipt, G as AlarmDetachedEffectDriver, J as DetachedEffectDeliveryPort, L as ReceiptCodec, Ot as AdmittedInvocationItem, P as AttemptReceipt, Q as ItemClaimCodec, Z as ItemClaim, at as EffectAttemptCodec, ct as InvocationContinuationCodec, d as ReplayOperationInvocationPort, f as CanonicalBatchInvocationPort, i as PreparedInvocationCodec, it as EffectAttempt, k as AttemptCancellationObservation, mt as requireArray$1, ot as AuthorityAdmissionReference, r as PreparedInvocation, s as InvocationPublicationDrainer, u as OperationPin, ut as ApprovalCodec, vt as requireExactObject, wt as requireString$1, x as InvocationLedger, yt as requireNonnegativeInteger } from "./invocations-Cpv8tzSW.js";
import { n as FacetRuntimeHost, y as OperationGatewayHost } from "./operations-BcSnYjIs.js";
import { g as requireOperationTime, p as contentOwnerKey, u as ContentOwnerEdge } from "./content-DYlOXpyu.js";
import { O as CommandCallerPolicy, a as AuthorityPermitIssuanceRequest, i as AuthorityPermitIssuanceReply } from "./public-B8XBKjQB.js";
import "./protocol-COrEPSqG.js";
import "./slates-BgbXLeOj.js";
import "fast-json-patch";
//#region src/composition/authority.ts
/**
* Why a stale mediated re-check refuses, stated once. The thrown error and the durable
* `deniedPreEffect` Receipt a stale observation writes (§3.4 rule 7) must say the same
* thing: a caller reading the error and an auditor reading the Receipt are looking at one
* refusal, and two independently spelled reasons would make that impossible to confirm.
*/
var MEDIATED_STALE_DENIAL_REASON = "Mediated authority intent is stale";
var ResolvedOperationAuthority = class {
	facet;
	#capabilities;
	constructor(facet, capabilities) {
		this.facet = facet;
		this.#capabilities = Object.freeze(capabilities.map((capability) => CapabilitySpec.fromData(capability.toData())));
		Object.freeze(this);
	}
	admits(descriptor, inputs) {
		return inputs.every((input) => {
			const arguments_ = capabilityArguments(input);
			return arguments_ !== void 0 && this.#capabilities.some((capability) => capability.matches({
				facet: this.facet.value,
				operation: descriptor.name.value,
				impact: descriptor.impact,
				arguments: arguments_
			}));
		});
	}
};
var OperationResolutionState = class {
	#resolvedAt;
	#originalLeaseExpiresAt;
	#resolutionDeadline;
	constructor(evidence, resolvedAt, originalLeaseExpiresAt, resolutionDeadline, authority) {
		if (authority !== operationResolutionAuthority) throw new TypeError("Operation resolution state is issued only by Tenant authority");
		this.principal = evidence.principal;
		this.binding = evidence.binding;
		this.pathEpochs = evidence.pathEpochs;
		this.watermark = evidence.watermark;
		this.lease = evidence.lease === void 0 ? void 0 : Object.freeze({
			turn: evidence.lease.turn,
			holder: evidence.lease.holder,
			epoch: evidence.lease.epoch
		});
		this.originalLease = evidence.originalLease;
		this.route = evidence.route;
		this.package = evidence.package;
		this.placement = evidence.placement;
		this.owner = evidence.owner;
		this.policies = Object.freeze([...evidence.policies]);
		this.turnOwnedSession = evidence.turnOwnedSession;
		this.sessionFilesystemTarget = evidence.sessionFilesystemTarget;
		this.turnActorAuthorityLocal = evidence.turnActorAuthorityLocal;
		this.directAuthority = evidence.directAuthority;
		this.#resolvedAt = resolvedAt.getTime();
		this.#originalLeaseExpiresAt = originalLeaseExpiresAt?.getTime();
		this.#resolutionDeadline = resolutionDeadline?.getTime();
		Object.freeze(this);
	}
	principal;
	binding;
	pathEpochs;
	watermark;
	lease;
	originalLease;
	route;
	package;
	placement;
	owner;
	policies;
	turnOwnedSession;
	sessionFilesystemTarget;
	turnActorAuthorityLocal;
	directAuthority;
	get resolvedAt() {
		return new Date(this.#resolvedAt);
	}
	get originalLeaseExpiresAt() {
		return this.#originalLeaseExpiresAt === void 0 ? void 0 : new Date(this.#originalLeaseExpiresAt);
	}
	get resolutionDeadline() {
		return this.#resolutionDeadline === void 0 ? void 0 : new Date(this.#resolutionDeadline);
	}
	admitsDirectAt(at) {
		return this.#resolutionDeadline !== void 0 && at.getTime() < this.#resolutionDeadline;
	}
};
var operationResolutionAuthority = Symbol("operation-resolution-authority");
var ResolutionStamp = class {
	principal;
	binding;
	pathEpochs;
	lease;
	inputDigest;
	operationDigest;
	#originalLeaseExpiresAt;
	#resolvedAt;
	#resolutionDeadline;
	constructor(principal, binding, pathEpochs, lease, originalLeaseExpiresAt, resolvedAt, resolutionDeadline, descriptor, inputs) {
		this.principal = principal;
		this.binding = binding;
		this.pathEpochs = pathEpochs;
		this.lease = lease;
		this.#originalLeaseExpiresAt = originalLeaseExpiresAt.getTime();
		this.#resolvedAt = resolvedAt.getTime();
		this.#resolutionDeadline = resolutionDeadline.getTime();
		this.operationDigest = Digest.sha256(encodeCanonicalJson(descriptor.toData()));
		this.inputDigest = Digest.sha256(encodeCanonicalJson(inputs.map((input) => canonicalFacetData(input))));
		Object.freeze(this);
	}
	get originalLeaseExpiresAt() {
		return new Date(this.#originalLeaseExpiresAt);
	}
	get resolvedAt() {
		return new Date(this.#resolvedAt);
	}
	get resolutionDeadline() {
		return new Date(this.#resolutionDeadline);
	}
	matches(descriptor, inputs) {
		return this.operationDigest.equals(Digest.sha256(encodeCanonicalJson(descriptor.toData()))) && this.inputDigest.equals(Digest.sha256(encodeCanonicalJson(inputs.map((input) => canonicalFacetData(input)))));
	}
};
var MediatedAuthorityIntent = class {
	principal;
	binding;
	pathEpochs;
	domain;
	packagePin;
	placement;
	owner;
	lease;
	route;
	policies;
	constructor(principal, binding, pathEpochs, domain, packagePin, placement, owner, lease, route, policies) {
		this.principal = principal;
		this.binding = binding;
		this.pathEpochs = pathEpochs;
		this.domain = domain;
		this.packagePin = packagePin;
		this.placement = placement;
		this.owner = owner;
		this.lease = lease;
		this.route = route;
		this.policies = Object.freeze([...policies]);
		Object.freeze(this);
	}
};
var TenantOperationAuthority = class {
	state;
	now;
	constructor(state, now) {
		this.state = state;
		this.now = now;
	}
	async resolve(caller, binding) {
		const resolution = this.state.resolve(caller, binding);
		if (resolution === void 0 || !resolution.binding.resolves) throw denied$1("Binding does not resolve for the authenticated Principal");
		const derived = deriveResolution(resolution, binding, this.now());
		return Object.freeze({
			facet: derived.binding.facet,
			resolution: derived
		});
	}
	tier(resolution, descriptor, hasInterceptors) {
		if (hasInterceptors || resolution.lease === void 0 || !resolution.turnActorAuthorityLocal || resolution.directAuthority === void 0 || mergePolicySets(resolution.policies).maxDirectRevocationWindowMs === void 0) return "mediated";
		return evaluatePolicy({
			impact: descriptor.impact,
			turnOwnedSession: resolution.turnOwnedSession,
			sessionFilesystemTarget: resolution.sessionFilesystemTarget,
			placement: resolution.placement.selected,
			policies: resolution.policies
		}).tier;
	}
	authorizeDirect(resolution, descriptor, inputs) {
		const at = this.now();
		const token = resolution.lease;
		const deadline = resolution.resolutionDeadline;
		const originalLeaseExpiresAt = resolution.originalLeaseExpiresAt;
		const watermark = this.state.currentWatermark(resolution.principal);
		if (token === void 0 || deadline === void 0 || originalLeaseExpiresAt === void 0 || !token.holder.equals(resolution.principal) || this.tier(resolution, descriptor, false) !== "direct" || !resolution.admitsDirectAt(at) || !watermark.holder.equals(resolution.principal) || !watermark.owner.equals(resolution.owner) || watermarkStale(watermark, resolution.pathEpochs) || this.state.currentLease(token)?.admits(token, at) !== true || resolution.directAuthority?.admits(descriptor, inputs) !== true) return;
		return new ResolutionStamp(resolution.principal, resolution.binding, resolution.pathEpochs, token, originalLeaseExpiresAt, resolution.resolvedAt, deadline, descriptor, inputs);
	}
	async authorizeMediated(resolution, descriptor, inputs) {
		const at = this.now();
		if (!sameBinding(this.state.currentBinding(resolution.binding.key), resolution.binding) || !this.state.currentPath(resolution.binding).equals(resolution.pathEpochs) || watermarkStale(this.state.currentWatermark(resolution.principal), resolution.pathEpochs) || resolution.lease !== void 0 && !resolution.lease.holder.equals(resolution.principal) || resolution.lease !== void 0 && this.state.currentLease(resolution.lease)?.admits(resolution.lease, at) !== true || !this.state.admits(resolution, descriptor, inputs, at)) {
			this.state.observeStale(resolution, descriptor, inputs);
			throw denied$1(MEDIATED_STALE_DENIAL_REASON);
		}
		return new MediatedAuthorityIntent(resolution.principal, resolution.binding, resolution.pathEpochs, resolution.binding.domain, resolution.package, resolution.placement, resolution.owner, resolution.lease, resolution.route, resolution.policies);
	}
	replayBinding(authorization, descriptor) {
		const execution = authorization.lease === void 0 ? {
			kind: "route",
			digest: Digest.sha256(encodeCanonicalJson({ route: authorization.route.value }))
		} : {
			kind: "lease",
			digest: Digest.sha256(encodeCanonicalJson({
				epoch: authorization.lease.epoch,
				holder: {
					principal: authorization.lease.holder.principalId.value,
					tenant: authorization.lease.holder.tenantId.value
				},
				turn: authorization.lease.turn.value
			}))
		};
		return Object.freeze({
			principal: authorization.principal,
			authorityIdentity: Digest.sha256(encodeCanonicalJson({
				binding: authorization.binding.toData(),
				domain: {
					kind: authorization.domain.kind,
					label: authorization.domain.label,
					secretPolicy: authorization.domain.secretPolicy
				},
				owner: {
					id: authorization.owner.id.value,
					kind: authorization.owner.kind
				},
				pathEpochs: authorization.pathEpochs.toData(),
				principal: {
					principal: authorization.principal.principalId.value,
					tenant: authorization.principal.tenantId.value
				}
			})),
			packageOperationPin: Digest.sha256(encodeCanonicalJson({
				descriptor: descriptor.toData(),
				facet: authorization.binding.facet.value,
				package: authorization.packagePin.toData(),
				placement: authorization.placement.toData()
			})),
			execution
		});
	}
	cutPointDomain(resolution) {
		return resolution.binding.domain;
	}
	contributorDomain(contributor) {
		return this.state.contributorDomain(contributor);
	}
	/**
	* The rights half of §4.4 rule 2 only: the contributor holds a Grant over an Operation
	* whose target declared the interception capability — tested as that declaration's
	* presence (§4.1, C13-FACET-CAPABILITY-ABSENCE), never as a stored flag's truth,
	* because the manifest has no negative form for the flag to hold. Protection-domain
	* confinement is rule 1, and the interceptor runner refuses a cross-domain contributor
	* before any authority question is asked — sharing a domain confers no rights, and
	* holding a Grant confers no domain.
	*/
	allowsInterception(resolution, contributor, declaration, target, descriptor) {
		return target.equals(resolution.binding.facet) && descriptor.interceptable !== void 0 && this.state.admitsInterception(resolution, contributor, declaration, descriptor);
	}
	release(resolution) {
		this.state.release(resolution);
	}
};
function deriveResolution(candidate, name, resolvedAt) {
	if (!Number.isFinite(resolvedAt.getTime())) throw denied$1("Authority resolver returned an invalid resolution time");
	if (!candidate.binding.name.equals(name) || !candidate.watermark.holder.equals(candidate.principal) || !candidate.watermark.owner.equals(candidate.owner) || candidate.lease === void 0 !== (candidate.originalLease === void 0) || candidate.lease === void 0 === (candidate.route === void 0) || candidate.lease !== void 0 && !candidate.lease.holder.equals(candidate.principal) || candidate.directAuthority !== void 0 && !candidate.directAuthority.facet.equals(candidate.binding.facet)) throw denied$1("Authority resolver returned substituted resolution evidence");
	let originalLeaseExpiresAt;
	let resolutionDeadline;
	if (candidate.lease !== void 0) {
		const originalLease = candidate.originalLease;
		originalLeaseExpiresAt = originalLease?.expiresAt;
		if (originalLease === void 0 || originalLeaseExpiresAt === void 0 || originalLease.admits(candidate.lease, resolvedAt) !== true) throw denied$1("Authority resolution requires the exact current Turn lease");
		const window = mergePolicySets(candidate.policies).maxDirectRevocationWindowMs;
		if (window !== void 0) {
			const windowDeadline = resolvedAt.getTime() + window;
			if (!Number.isSafeInteger(windowDeadline)) throw denied$1("Direct revocation deadline exceeds the safe time range");
			resolutionDeadline = new Date(Math.min(originalLeaseExpiresAt.getTime(), windowDeadline));
		}
	}
	return new OperationResolutionState(candidate, resolvedAt, originalLeaseExpiresAt, resolutionDeadline, operationResolutionAuthority);
}
function capabilityArguments(input) {
	const canonical = canonicalFacetData(input);
	return isFacetDataMap(canonical) ? canonical : void 0;
}
function sameBinding(current, expected) {
	return current !== void 0 && current.key === expected.key && current.generation === expected.generation && current.resolves && current.facet.equals(expected.facet);
}
function watermarkStale(watermark, path) {
	return path.path.some((entry) => watermark.epoch(entry.scope) > entry.epoch);
}
function denied$1(message) {
	return new AgentCoreError("authority.denied", message);
}
Object.freeze({
	validateBinding: "binding.validate",
	check: "authority.check",
	projectLeaseEvidence: "authority.permit.evidence.project",
	issuePermit: "authority.permit.issue"
});
var AnyActorCallerPolicy = class extends CommandCallerPolicy {
	admits(caller) {
		return caller.kind === "actor";
	}
};
new AnyActorCallerPolicy();
//#endregion
//#region src/workspaces/codec.ts
function requireObject(value, subject) {
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
	return value;
}
function requireFields(value, fields, subject) {
	if (!hasExactJsonKeys(value, fields)) throw new TypeError(`${subject} contains missing or unknown fields`);
}
/**
* The same exactness as `requireFields` for records whose optional fields are encoded by
* presence: every required key must appear, and no key outside the two lists may.
*/
function requireOptionalFields(value, required, optional, subject) {
	const admissible = /* @__PURE__ */ new Set([...required, ...optional]);
	const present = Object.keys(value);
	if (required.some((field) => !Object.hasOwn(value, field)) || present.some((key) => !admissible.has(key))) throw new TypeError(`${subject} contains missing or unknown fields`);
}
function requireString(value, subject) {
	if (!isStringValue$1(value)) throw new TypeError(`${subject} must be a string`);
	return value;
}
function requireNullableString(value, subject) {
	if (value === null) return void 0;
	return requireString(value, subject);
}
function requireInteger(value, subject) {
	if (!isNumberValue(value) || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${subject} must be a non-negative safe integer`);
	return value;
}
function isStringValue$1(value) {
	return typeof value === "string";
}
function isNumberValue(value) {
	return typeof value === "number";
}
function requireArray(value, subject) {
	if (!Array.isArray(value)) throw new TypeError(`${subject} must be an array`);
	return value;
}
function encodeActor(actor) {
	return {
		kind: actor.kind,
		id: actor.id.value
	};
}
function decodeActor(value, subject) {
	const object = requireObject(value, subject);
	requireFields(object, ["id", "kind"], subject);
	return new ActorRef(requireActorKind(object["kind"], `${subject} kind`), new ActorId(requireString(object["id"], `${subject} ID`)));
}
function encodeContent(ref, digest) {
	return {
		ref: ref.value,
		digest: digest.value
	};
}
function decodeContent(value, subject) {
	const object = requireObject(value, subject);
	requireFields(object, ["digest", "ref"], subject);
	const ref = new ContentRef(requireString(object["ref"], `${subject} reference`));
	const digest = new Digest(requireString(object["digest"], `${subject} digest`));
	if (!ref.digest.equals(digest)) throw new TypeError(`${subject} reference and digest do not match`);
	return {
		ref,
		digest
	};
}
function encodeRevision(revision) {
	return revision.value;
}
function decodeRevision(value, subject) {
	return new Revision(requireInteger(value, subject));
}
function encodeOptionalPrincipalRef(principal) {
	return principal === void 0 ? null : {
		tenant: principal.tenantId.value,
		principal: principal.principalId.value
	};
}
function decodeOptionalPrincipalRef(value, subject) {
	if (value === null) return void 0;
	const object = requireObject(value, subject);
	requireFields(object, ["principal", "tenant"], subject);
	return new PrincipalRef(new TenantId(requireString(object["tenant"], `${subject} Tenant`)), new PrincipalId(requireString(object["principal"], `${subject} ID`)));
}
function encodeScope(scope) {
	return encodeScopeRef(scope);
}
function decodeScope(value) {
	return decodeScopeRef(value);
}
function requireActorKind(value, subject) {
	if (value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate") return value;
	throw new TypeError(`${subject} is invalid`);
}
//#endregion
//#region src/workspaces/value.ts
var EventVerification = class {
	static verified() {
		return verifiedEvent;
	}
	static host() {
		return hostEvent;
	}
	equals(other) {
		return this.kind === other.kind;
	}
};
var VerifiedEvent = class extends EventVerification {
	kind = "verified";
};
var HostEvent = class extends EventVerification {
	kind = "host";
};
var verifiedEvent = Object.freeze(new VerifiedEvent());
var hostEvent = Object.freeze(new HostEvent());
var EventProvenanceCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			EventProvenance,
			EventVerification,
			VerifiedEvent,
			HostEvent,
			TextId,
			TenantId,
			PrincipalId,
			PrincipalRef
		], "workspace.event-provenance", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(provenance) {
		return provenance.toData();
	}
	decodePayload(payload, _version) {
		return EventProvenance.fromData(payload);
	}
};
var EventProvenance = class EventProvenance {
	static get codec() {
		return eventProvenanceCodecInstance;
	}
	verification;
	principal;
	channel;
	group;
	claims;
	constructor(init) {
		this.verification = init.verification.kind === "host" ? EventVerification.host() : EventVerification.verified();
		this.principal = init.principal;
		this.channel = validateOptionalCanonicalText(init.channel, "Provenance channel");
		this.group = validateOptionalCanonicalText(init.group, "Provenance group");
		this.claims = canonicalJson(init.claims ?? {});
		Object.freeze(this);
	}
	static encode(provenance) {
		return EventProvenance.codec.encode(provenance);
	}
	static decode(bytes) {
		return EventProvenance.codec.decode(bytes);
	}
	static fromData(value) {
		if (!isJsonObject(value) || !hasExactJsonKeys(value, [
			"channel",
			"claims",
			"group",
			"principal",
			"verification"
		])) throw new TypeError("Event provenance payload is malformed");
		const verification = value["verification"];
		const principal = value["principal"];
		const channel = value["channel"];
		const group = value["group"];
		if (verification !== "verified" && verification !== "host" || channel !== null && !isStringValue(channel) || group !== null && !isStringValue(group)) throw new TypeError("Event provenance fields are malformed");
		let provenance = {
			verification: verification === "host" ? EventVerification.host() : EventVerification.verified(),
			claims: value["claims"]
		};
		if (principal !== null) {
			const decoded = decodeOptionalPrincipalRef(principal, "Provenance Principal");
			if (decoded === void 0) throw new TypeError("Provenance Principal is malformed");
			provenance = {
				...provenance,
				principal: decoded
			};
		}
		if (channel !== null) provenance = {
			...provenance,
			channel
		};
		if (group !== null) provenance = {
			...provenance,
			group
		};
		return new EventProvenance(provenance);
	}
	toData() {
		return {
			verification: this.verification.kind,
			principal: encodeOptionalPrincipalRef(this.principal),
			channel: this.channel ?? null,
			group: this.group ?? null,
			claims: this.claims
		};
	}
};
var eventProvenanceCodecInstance = new EventProvenanceCodecV1();
function canonicalJson(value) {
	return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value)));
}
/**
* The value one RFC 6901 pointer names inside a document, or nothing when the document
* does not hold that position. Absence is the return rather than a throw because the two
* callers owe different refusals for it — a View mark that resolves nowhere is a malformed
* record, a decision placement that resolves nowhere is a rejected rendering — while the
* traversal itself is one fact about pointers. A JSON `null` the document does hold is a
* value and answers as one.
*/
function readJsonPointer(document, pointer) {
	let current = document;
	for (const token of new JsonPointer(pointer).tokens) if (Array.isArray(current)) {
		if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) return void 0;
		const index = Number(token);
		const entry = Number.isSafeInteger(index) ? current[index] : void 0;
		if (entry === void 0) return void 0;
		current = entry;
	} else if (isJsonObject(current) && Object.hasOwn(current, token)) {
		const entry = current[token];
		if (entry === void 0) return void 0;
		current = entry;
	} else return;
	return current;
}
function deepFreeze(value) {
	if (Array.isArray(value)) {
		for (const entry of value) deepFreeze(entry);
		return Object.freeze(value);
	}
	if (isJsonObject(value)) {
		for (const entry of Object.values(value)) deepFreeze(entry);
		return Object.freeze(value);
	}
	return value;
}
function isStringValue(value) {
	return typeof value === "string";
}
function validateOptionalCanonicalText(value, subject) {
	if (value === void 0) return void 0;
	if (value.length === 0 || value.trim() !== value) throw new TypeError(`${subject} must be a nonblank canonical string`);
	return value;
}
//#endregion
//#region src/workspaces/event.ts
var EventCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			Event,
			ActorRef,
			ContentRef,
			ScopeRef,
			TextId,
			EventVerification,
			EventProvenance,
			Digest,
			PrincipalRef,
			ActorId,
			FacetPackageId,
			EventKind,
			EventId,
			CorrelationId,
			TenantId,
			WorkspaceId,
			ProjectId,
			PrincipalId
		], "workspace.event", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(event) {
		return {
			id: event.id.value,
			scope: encodeScope(event.scope),
			source: encodeSource(event.source),
			category: event.kind.value,
			content: encodeContent(event.payload, event.payloadDigest),
			idempotencyKey: event.idempotencyKey,
			correlation: event.correlation.value,
			causation: event.causation?.value ?? null,
			provenance: encodeProvenance(event.provenance),
			trust: event.trust,
			visibility: event.visibility,
			initiator: encodeOptionalPrincipalRef(event.initiator)
		};
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "Event payload");
		requireFields(object, [
			"category",
			"causation",
			"content",
			"correlation",
			"id",
			"idempotencyKey",
			"initiator",
			"provenance",
			"scope",
			"source",
			"trust",
			"visibility"
		], "Event payload");
		const content = decodeContent(object["content"], "Event content");
		const causation = requireNullableString(object["causation"], "Event causation");
		const initiator = decodeOptionalPrincipalRef(object["initiator"], "Event initiator");
		let event = {
			id: new EventId(requireString(object["id"], "Event ID")),
			scope: decodeScope(object["scope"]),
			source: decodeSource(object["source"]),
			kind: new EventKind(requireString(object["category"], "Event category")),
			payload: content.ref,
			payloadDigest: content.digest,
			idempotencyKey: requireString(object["idempotencyKey"], "Event idempotency key"),
			correlation: new CorrelationId(requireString(object["correlation"], "Event correlation")),
			provenance: decodeProvenance(object["provenance"]),
			trust: decodeTrust$1(object["trust"]),
			visibility: decodeVisibility(object["visibility"])
		};
		if (causation !== void 0) event = {
			...event,
			causation: new EventId(causation)
		};
		if (initiator !== void 0) event = {
			...event,
			initiator
		};
		return new Event(event);
	}
};
/** The longest an Event idempotency key may be; the command envelope's bound. */
var MAX_IDEMPOTENCY_KEY_LENGTH = 512;
var Event = class Event {
	static get codec() {
		return eventCodecInstance;
	}
	static encode(event) {
		return Event.codec.encode(event);
	}
	static decode(bytes) {
		return Event.codec.decode(bytes);
	}
	id;
	scope;
	source;
	kind;
	payload;
	payloadDigest;
	idempotencyKey;
	correlation;
	causation;
	provenance;
	trust;
	visibility;
	initiator;
	constructor(init) {
		if (!init.payload.digest.equals(init.payloadDigest)) throw new TypeError("Event payload reference and digest must match");
		if (init.idempotencyKey.length === 0 || init.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH || init.idempotencyKey.trim() !== init.idempotencyKey) throw new TypeError(`Event idempotency key must be a canonical string of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
		if (init.trust === "self" && init.provenance.verification.kind !== "host") throw new TypeError("Self trust requires host provenance");
		if (init.trust === "owner" && init.initiator === void 0) throw new TypeError("Owner trust requires an authenticated initiator");
		if ((init.trust === "owner" || init.trust === "authenticated") && (init.provenance.principal === void 0 || init.initiator === void 0 || !init.provenance.principal.equals(init.initiator))) throw new TypeError("Authenticated trust requires the exact provenance Principal");
		if (init.provenance.principal !== void 0 && init.initiator !== void 0 && !init.provenance.principal.equals(init.initiator)) throw new TypeError("Event initiator cannot substitute another Principal");
		if (init.initiator !== void 0 && !init.initiator.tenantId.equals(init.scope.tenantId)) throw new TypeError("Event initiator Tenant must match the Event scope");
		this.id = init.id;
		this.scope = init.scope;
		this.source = copySource(init.source);
		this.kind = init.kind;
		this.payload = init.payload;
		this.payloadDigest = init.payloadDigest;
		this.idempotencyKey = init.idempotencyKey;
		this.correlation = init.correlation;
		this.causation = init.causation;
		let provenance = {
			verification: init.provenance.verification,
			claims: init.provenance.claims
		};
		if (init.provenance.principal !== void 0) provenance = {
			...provenance,
			principal: init.provenance.principal
		};
		if (init.provenance.channel !== void 0) provenance = {
			...provenance,
			channel: init.provenance.channel
		};
		if (init.provenance.group !== void 0) provenance = {
			...provenance,
			group: init.provenance.group
		};
		this.provenance = new EventProvenance(provenance);
		this.trust = init.trust;
		this.visibility = init.visibility;
		this.initiator = init.initiator;
		Object.freeze(this);
	}
};
var eventCodecInstance = new EventCodecV1();
function encodeSource(source) {
	return source.kind === "facet" ? {
		kind: source.kind,
		facet: source.facet.value
	} : {
		kind: source.kind,
		actor: encodeActor(source.actor)
	};
}
function decodeSource(value) {
	const object = requireObject(value, "Event source");
	if (object["kind"] === "facet") {
		requireFields(object, ["facet", "kind"], "Facet Event source");
		return {
			kind: "facet",
			facet: new FacetPackageId(requireString(object["facet"], "Event source Facet"))
		};
	}
	if (object["kind"] === "actor") {
		requireFields(object, ["actor", "kind"], "Actor Event source");
		return {
			kind: "actor",
			actor: decodeActor(object["actor"], "Event source Actor")
		};
	}
	throw new TypeError("Event source kind is invalid");
}
function copySource(source) {
	return source.kind === "facet" ? Object.freeze({
		kind: source.kind,
		facet: source.facet
	}) : Object.freeze({
		kind: source.kind,
		actor: new ActorRef(source.actor.kind, source.actor.id)
	});
}
function encodeProvenance(provenance) {
	return provenance.toData();
}
function decodeProvenance(value) {
	return EventProvenance.fromData(value);
}
function decodeTrust$1(value) {
	if (value === "owner" || value === "authenticated" || value === "external" || value === "self") return value;
	throw new TypeError("Event trust is invalid");
}
function decodeVisibility(value) {
	if (value === "workspace" || value === "private") return value;
	throw new TypeError("Event visibility is invalid");
}
//#endregion
//#region src/workspaces/id.ts
var ActionId = class extends TextId {
	constructor(value) {
		if (!isActionIdText(value) || value.length === 0 || value.trim() !== value) throw new TypeError("Action ID must be a nonblank canonical string");
		super(value, "Action ID");
		Object.freeze(this);
	}
};
function isActionIdText(value) {
	return typeof value === "string";
}
var CoherenceFindingId = class extends TextId {
	constructor(value) {
		super(value, "Coherence finding ID");
		Object.freeze(this);
	}
};
var ContentRetentionId = class extends TextId {
	constructor(value) {
		super(value, "Content retention ID");
		Object.freeze(this);
	}
};
var EventCursor = class extends TextId {
	constructor(value) {
		super(value, "Event cursor");
		Object.freeze(this);
	}
};
var IngressEndpointId = class extends TextId {
	constructor(value) {
		super(value, "Ingress endpoint ID");
		Object.freeze(this);
	}
};
var InboxReferenceId = class extends TextId {
	constructor(value) {
		super(value, "Inbox reference ID");
		Object.freeze(this);
	}
};
var RetainedRecordRef = class extends TextId {
	constructor(value) {
		super(value, "Retained record reference");
		Object.freeze(this);
	}
};
//#endregion
//#region src/workspaces/surface-epoch.ts
var exactEpochs = /* @__PURE__ */ new WeakSet();
/**
* SPEC §6.3: one registration generation of a static `SurfaceId`. A Surface keeps its id
* across releases, so the id alone cannot tell one registration's View stream from the
* stream of a later registration that reuses the id. The epoch does. The first stream of a
* Surface is epoch 1, and the stream that opens after a retirement is the next ordinal, so
* a retired stream stays readable at its own key forever while a new stream starts empty.
*/
var SurfaceEpoch = class SurfaceEpoch {
	#value;
	constructor(value) {
		if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Surface epoch must be a positive safe integer");
		this.#value = value;
		if (new.target === SurfaceEpoch) exactEpochs.add(this);
		Object.freeze(this);
	}
	static isExact(value) {
		return value !== null && typeof value === "object" && exactEpochs.has(value);
	}
	static first() {
		return new SurfaceEpoch(1);
	}
	get value() {
		return this.#value;
	}
	/** The canonical text form composite stream keys and error messages are built from. */
	get text() {
		return String(this.#value);
	}
	next() {
		if (this.#value === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("protocol.invalid-state", "Surface epoch cannot exceed the maximum safe integer");
		return new SurfaceEpoch(this.#value + 1);
	}
	equals(other) {
		return SurfaceEpoch.isExact(other) && this.#value === other.#value;
	}
};
function decodeSurfaceEpoch(value, subject) {
	return new SurfaceEpoch(requireInteger(value, subject));
}
//#endregion
//#region src/workspaces/view.ts
var ActionDescriptorCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			ActionDescriptor,
			TextId,
			JsonSchema,
			EventKind,
			ActionId
		], "workspace.action-descriptor", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(action) {
		return encodeAction(action);
	}
	decodePayload(payload, _version) {
		return decodeAction(payload);
	}
};
var ActionDescriptor = class ActionDescriptor {
	static get codec() {
		return actionDescriptorCodecInstance;
	}
	id;
	label;
	emits;
	arguments;
	constructor(init) {
		if (!(init.id instanceof ActionId)) throw new TypeError("Action ID must be an ActionId");
		requireCanonicalText(init.label, "Action label");
		this.id = init.id;
		this.label = init.label;
		this.emits = init.emits;
		this.arguments = init.arguments === void 0 ? void 0 : new JsonSchema(init.arguments.document);
		Object.freeze(this);
	}
	static encode(action) {
		return ActionDescriptor.codec.encode(action);
	}
	static decode(bytes) {
		return ActionDescriptor.codec.decode(bytes);
	}
};
var actionDescriptorCodecInstance = new ActionDescriptorCodecV1();
var ViewMarkCodecV1 = class extends RecordCodec {
	constructor() {
		super([ViewMark, JsonPointer], "workspace.view-mark", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(mark) {
		return encodeViewMark(mark);
	}
	decodePayload(payload, _version) {
		return decodeViewMark(payload);
	}
};
var ViewMark = class ViewMark {
	static get codec() {
		return viewMarkCodecInstance;
	}
	path;
	tier;
	constructor(path, tier) {
		new JsonPointer(path);
		this.path = path;
		this.tier = canonicalTrustTiers([tier])[0];
		Object.freeze(this);
	}
	static encode(mark) {
		return ViewMark.codec.encode(mark);
	}
	static decode(bytes) {
		return ViewMark.codec.decode(bytes);
	}
};
var viewMarkCodecInstance = new ViewMarkCodecV1();
var ViewCodecV3 = class extends RecordCodec {
	constructor() {
		super([
			View,
			Revision,
			SurfaceEpoch,
			TextId,
			ViewMark,
			JsonPointer,
			Digest,
			ActionDescriptor,
			ActionId,
			SurfaceId,
			EventCursor,
			JsonSchema,
			EventKind
		], "workspace.view", {
			major: 3,
			minor: 0
		});
	}
	encodePayload(view) {
		return {
			surface: view.surface.value,
			epoch: view.epoch.value,
			revision: encodeRevision(view.revision),
			body: view.body,
			actions: view.actions.map(encodeAction),
			cursor: view.cursor.value,
			...encodeViewProvenance(view),
			...encodeViewTermination(view)
		};
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "View payload");
		const provenance = decodeViewProvenance(object, "View payload");
		const termination = requireViewTermination(object, "View payload");
		requireViewFields(object, provenance, [
			"actions",
			"body",
			"cursor",
			"epoch",
			"revision",
			"surface"
		], "View payload");
		const init = {
			surface: new SurfaceId(requireString(object["surface"], "View Surface ID")),
			epoch: decodeSurfaceEpoch(object["epoch"], "View Surface epoch"),
			revision: decodeRevision(object["revision"], "View revision"),
			body: canonicalJson(object["body"]),
			actions: requireArray(object["actions"], "View actions").map(decodeAction),
			cursor: new EventCursor(requireString(object["cursor"], "View cursor"))
		};
		const decided = provenance === void 0 ? init : {
			...init,
			...provenance
		};
		return new View(termination === void 0 ? decided : {
			...decided,
			terminal: true
		});
	}
};
var View = class View {
	static get codec() {
		return viewCodecInstance;
	}
	static encode(view) {
		return View.codec.encode(view);
	}
	static decode(bytes) {
		return View.codec.decode(bytes);
	}
	surface;
	epoch;
	revision;
	body;
	actions;
	cursor;
	constructor(init) {
		if (!SurfaceEpoch.isExact(init.epoch)) throw new TypeError("View epoch must be a SurfaceEpoch");
		const actionIds = /* @__PURE__ */ new Set();
		const actions = init.actions.map(copyAction);
		for (const action of actions) {
			if (actionIds.has(action.id.value)) throw new TypeError("View action IDs must be unique");
			actionIds.add(action.id.value);
		}
		const body = canonicalJson(init.body);
		const provenance = requireViewProvenance(init);
		const termination = requireViewTermination(init, "View");
		const marks = provenance?.marks.map((mark) => new ViewMark(mark.path, mark.tier)) ?? [];
		marks.sort(compareViewMarks);
		for (const [index, mark] of marks.entries()) {
			if (marks[index - 1]?.path === mark.path) throw new TypeError("View mark paths must be unique");
			requireMarkedValue(body, mark.path);
		}
		this.surface = init.surface;
		this.epoch = init.epoch;
		this.revision = init.revision;
		this.body = body;
		this.actions = Object.freeze(actions);
		this.cursor = init.cursor;
		if (provenance !== void 0) {
			this.intentDigest = new Digest(provenance.intentDigest.value);
			this.marks = Object.freeze(marks);
		}
		if (termination !== void 0) this.terminal = true;
		Object.freeze(this);
	}
};
var viewCodecInstance = new ViewCodecV3();
var ViewDeltaCodecV2 = class extends RecordCodec {
	constructor() {
		super([
			ViewDelta,
			Revision,
			SurfaceEpoch,
			TextId,
			SurfaceId,
			EventCursor
		], "workspace.view-delta", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(delta) {
		return {
			surface: delta.surface.value,
			epoch: delta.epoch.value,
			baseRevision: encodeRevision(delta.baseRevision),
			revision: encodeRevision(delta.revision),
			patch: delta.patch,
			cursor: delta.cursor.value
		};
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "View delta payload");
		requireFields(object, [
			"baseRevision",
			"cursor",
			"epoch",
			"patch",
			"revision",
			"surface"
		], "View delta payload");
		return new ViewDelta({
			surface: new SurfaceId(requireString(object["surface"], "Delta Surface ID")),
			epoch: decodeSurfaceEpoch(object["epoch"], "Delta Surface epoch"),
			baseRevision: decodeRevision(object["baseRevision"], "Delta base revision"),
			revision: decodeRevision(object["revision"], "Delta revision"),
			patch: requireArray(object["patch"], "View patch").map(canonicalJson),
			cursor: new EventCursor(requireString(object["cursor"], "Delta cursor"))
		});
	}
};
var ViewDelta = class ViewDelta {
	static get codec() {
		return viewDeltaCodecInstance;
	}
	static encode(delta) {
		return ViewDelta.codec.encode(delta);
	}
	static decode(bytes) {
		return ViewDelta.codec.decode(bytes);
	}
	surface;
	epoch;
	baseRevision;
	revision;
	patch;
	cursor;
	constructor(init) {
		if (!SurfaceEpoch.isExact(init.epoch)) throw new TypeError("View delta epoch must be a SurfaceEpoch");
		if (!init.baseRevision.next().equals(init.revision)) throw new TypeError("View delta revision must immediately follow its base revision");
		this.surface = init.surface;
		this.epoch = init.epoch;
		this.baseRevision = init.baseRevision;
		this.revision = init.revision;
		this.patch = Object.freeze(init.patch.map(canonicalJson));
		this.cursor = init.cursor;
		Object.freeze(this);
	}
};
var viewDeltaCodecInstance = new ViewDeltaCodecV2();
Object.freeze([Object.freeze({
	op: "add",
	path: "/terminal",
	value: true
})]);
function encodeViewMark(mark) {
	return {
		path: mark.path,
		tier: mark.tier
	};
}
function requireViewProvenance(view) {
	const hasIntent = Object.hasOwn(view, "intentDigest");
	const hasMarks = Object.hasOwn(view, "marks");
	const intentDigest = view.intentDigest;
	const marks = view.marks;
	if (!hasIntent && !hasMarks) return void 0;
	if (!hasIntent || !hasMarks || intentDigest === void 0 || marks === void 0) throw new TypeError("Decision View provenance requires both intentDigest and marks");
	return {
		intentDigest,
		marks
	};
}
function encodeViewProvenance(view) {
	const provenance = requireViewProvenance(view);
	return provenance === void 0 ? {} : {
		intentDigest: provenance.intentDigest.value,
		marks: provenance.marks.map(encodeViewMark)
	};
}
/**
* SPEC §6.3: `terminal` marks the last View of a retired Surface by its presence, exactly
* as `intentDigest` marks a decision View. A present value that is not `true` is refused,
* so no path can spell "not terminal" as a value a later edit could flip.
*/
function requireViewTermination(source, subject) {
	if (!Object.hasOwn(source, "terminal")) return void 0;
	if (source.terminal !== true) throw new TypeError(`${subject} marks termination by presence, never by a value`);
	return true;
}
function encodeViewTermination(view) {
	return requireViewTermination(view, "View") === void 0 ? {} : { terminal: true };
}
function decodeViewMark(value) {
	const object = requireObject(value, "View mark");
	requireFields(object, ["path", "tier"], "View mark");
	const tier = requireString(object["tier"], "View mark trust tier");
	return new ViewMark(requireString(object["path"], "View mark path"), requireTrustTier(tier));
}
function decodeViewProvenance(object, subject) {
	const hasIntent = Object.hasOwn(object, "intentDigest");
	const hasMarks = Object.hasOwn(object, "marks");
	if (!hasIntent && !hasMarks) return void 0;
	if (!hasIntent || !hasMarks) throw new TypeError(`${subject} must carry both intentDigest and marks or omit both`);
	return {
		intentDigest: new Digest(requireString(object["intentDigest"], `${subject} intent digest`)),
		marks: requireArray(object["marks"], `${subject} marks`).map(decodeViewMark)
	};
}
function requireViewFields(object, provenance, fields, subject) {
	requireOptionalFields(object, provenance === void 0 ? fields : [
		...fields,
		"intentDigest",
		"marks"
	], ["terminal"], subject);
}
function requireTrustTier(value) {
	if (value === "owner" || value === "authenticated" || value === "external" || value === "self") return value;
	throw new TypeError("View mark trust tier is invalid");
}
function compareViewMarks(left, right) {
	return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}
function requireMarkedValue(body, pointer) {
	if (readJsonPointer(body, pointer) === void 0) throw new TypeError("View mark path does not resolve within the View body");
}
function encodeAction(action) {
	return {
		id: action.id.value,
		label: action.label,
		emits: action.emits.value,
		arguments: action.arguments?.document ?? null
	};
}
function decodeAction(value) {
	const object = requireObject(value, "View action");
	requireFields(object, [
		"arguments",
		"emits",
		"id",
		"label"
	], "View action");
	const argumentsDocument = object["arguments"];
	const action = {
		id: new ActionId(requireString(object["id"], "Action ID")),
		label: requireString(object["label"], "Action label"),
		emits: new EventKind(requireString(object["emits"], "Action Event kind"))
	};
	return new ActionDescriptor(argumentsDocument === null ? action : {
		...action,
		arguments: new JsonSchema(requireSchemaDocument(argumentsDocument))
	});
}
function copyAction(action) {
	const copy = {
		id: action.id,
		label: action.label,
		emits: action.emits
	};
	return new ActionDescriptor(action.arguments === void 0 ? copy : {
		...copy,
		arguments: action.arguments
	});
}
function requireSchemaDocument(value) {
	if (isBooleanValue(value) || isJsonObject(value)) return value;
	throw new TypeError("View action arguments must be a JSON Schema object or boolean");
}
function isBooleanValue(value) {
	return typeof value === "boolean";
}
function requireCanonicalText(value, subject) {
	if (value.length === 0 || value.trim() !== value) throw new TypeError(`${subject} must be a nonblank canonical string`);
}
//#endregion
//#region src/workspaces/decision-view.ts
/**
* SPEC §6.3: the position a Surface renders one value in. Rendering as **data** is a
* position and treatment a reasonable viewer reads as showing someone else's input — a
* quoted or clearly labeled field. **Platform voice** is any position a viewer would
* attribute to the platform itself: unquoted body copy, a headline, a button label
* synthesized from the value. A value the host did not originate is admitted at the first
* and refused at the second, and that refusal is the whole of the rendering conjunct: a
* codec that preserved marks would still let a Surface put a marked value in a headline.
*/
var ViewPosition = class {
	static get data() {
		return dataPosition;
	}
	static get platformVoice() {
		return platformVoicePosition;
	}
	equals(other) {
		return this === other;
	}
};
var DataPosition = class extends ViewPosition {
	admitsAttributed() {
		return true;
	}
	get label() {
		return "data";
	}
};
var PlatformVoicePosition = class extends ViewPosition {
	admitsAttributed() {
		return false;
	}
	get label() {
		return "platformVoice";
	}
};
var dataPosition = Object.freeze(new DataPosition());
var platformVoicePosition = Object.freeze(new PlatformVoicePosition());
//#endregion
//#region src/workspaces/ingress-endpoint.ts
/**
* Major 1 carries the target-bound declaration plus the §4.2 attribution of the Facet
* contribution that materialized it and the §4.1 retirement marker a withdrawal writes.
* Both optional halves are encoded by presence: an endpoint no Facet contributed carries
* no attribution key, and a live one carries no `retired` key.
*/
var IngressEndpointCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			IngressEndpoint,
			IngressEndpointId,
			ContributionAttribution,
			Revision,
			TextId,
			MappingRecord,
			FieldMove,
			IngressDeclaration,
			IngressVerification,
			ProvenanceMapping,
			SecretRef,
			JsonPointer,
			FacetPackageId,
			FacetRef,
			Digest,
			SemVer,
			PackageId,
			PackagePin,
			ScopeRef,
			TenantId,
			WorkspaceId,
			ProjectId
		], "workspace.ingress-endpoint", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(endpoint) {
		const contribution = endpoint.contribution;
		return dataRecord({
			id: endpoint.id.value,
			revision: encodeRevision(endpoint.revision),
			scope: encodeScope(endpoint.scope),
			declared: endpoint.declared.toData(),
			contribution: contribution === void 0 ? void 0 : {
				contributor: contribution.contributor.value,
				package: contribution.package.toData()
			},
			retired: endpoint.retired
		});
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "Ingress endpoint payload");
		requireOptionalFields(object, [
			"declared",
			"id",
			"revision",
			"scope"
		], ["contribution", "retired"], "Ingress endpoint payload");
		const contribution = object["contribution"];
		const retired = object["retired"];
		if (retired !== void 0 && retired !== true) throw new TypeError("Ingress endpoint retirement is encoded by presence");
		return new IngressEndpoint({
			id: new IngressEndpointId(requireString(object["id"], "Ingress endpoint ID")),
			revision: decodeRevision(object["revision"], "Ingress endpoint revision"),
			scope: decodeScope(object["scope"]),
			declared: IngressDeclaration.fromData(object["declared"]),
			contribution: contribution === void 0 ? void 0 : decodeContribution$1(contribution),
			retired: retired === void 0 ? void 0 : true
		});
	}
};
var IngressEndpoint = class IngressEndpoint {
	static get codec() {
		return ingressEndpointCodecInstance;
	}
	static encode(endpoint) {
		return IngressEndpoint.codec.encode(endpoint);
	}
	static decode(bytes) {
		return IngressEndpoint.codec.decode(bytes);
	}
	id;
	revision;
	scope;
	declared;
	contribution;
	retired;
	constructor(init) {
		if (!(init.scope instanceof ScopeRef)) throw new TypeError("Ingress endpoint must bind its target Scope");
		if (!(init.declared instanceof IngressDeclaration)) throw new TypeError("Ingress endpoint must carry a canonical declaration");
		if (init.contribution !== void 0 && !(init.contribution instanceof ContributionAttribution)) throw new TypeError("Ingress endpoint contribution must carry canonical attribution");
		if (init.retired !== void 0 && init.retired !== true) throw new TypeError("Ingress endpoint retirement is declared by presence");
		this.id = init.id;
		this.revision = init.revision;
		this.scope = init.scope;
		this.declared = IngressDeclaration.decode(IngressDeclaration.encode(init.declared));
		this.contribution = init.contribution;
		this.retired = init.retired;
		Object.freeze(this);
	}
	/**
	* SPEC §4.1 (C13-FACET-WITHDRAWAL-EXACT): the retirement revision a withdrawal writes
	* for an endpoint its Facet's `ingress` contribution materialized. The declared shape,
	* the target Scope, and the attribution are carried through unchanged.
	*/
	retire() {
		if (this.contribution === void 0) throw new AgentCoreError("protocol.invalid-state", "Only a contributed Ingress endpoint is retired by withdrawal");
		return new IngressEndpoint({
			id: this.id,
			revision: this.revision.next(),
			scope: this.scope,
			declared: this.declared,
			contribution: this.contribution,
			retired: true
		});
	}
};
function decodeContribution$1(value) {
	if (!isJsonObject(value)) throw new TypeError("Ingress endpoint contribution must be an object");
	return ContributionAttribution.decodeFields(value, "Ingress endpoint contribution");
}
var ingressEndpointCodecInstance = new IngressEndpointCodecV1();
//#endregion
//#region src/workspaces/coherence.ts
/** Why one cross-Run observation or intervention was refused. */
var ObservationRefusal = class {
	static get ambient() {
		return ambientRefusal;
	}
	static get tenant() {
		return tenantRefusal;
	}
	static impact(missing) {
		return new MissingObservationImpact(missing);
	}
	static intervention(missing) {
		return new InterventionWithoutGrant(missing);
	}
	denied() {
		return new AgentCoreError("authority.denied", this.explain());
	}
};
var AmbientObservation = class extends ObservationRefusal {
	reason = "ambient";
	explain() {
		return "Cross-Run observation names no live allow-Grant reaching the observed Run";
	}
};
var CrossTenantObservation = class extends ObservationRefusal {
	reason = "tenant";
	explain() {
		return "Cross-Run observation lacks the separate cross-tenant authority its route requires";
	}
};
var MissingObservationImpact = class extends ObservationRefusal {
	missing;
	reason = "impact";
	constructor(missing) {
		super();
		this.missing = missing;
		Object.freeze(this);
	}
	explain() {
		return `Cross-Run observation Grant does not carry ${this.missing} impact`;
	}
};
var InterventionWithoutGrant = class extends ObservationRefusal {
	missing;
	reason = "intervention";
	constructor(missing) {
		super();
		this.missing = missing;
		Object.freeze(this);
	}
	explain() {
		return `Acting on an observed Run requires a separate allow-Grant carrying ${this.missing} impact`;
	}
};
var ambientRefusal = Object.freeze(new AmbientObservation());
var tenantRefusal = Object.freeze(new CrossTenantObservation());
/**
* Which reading of a resemblance set a finding asserts. Each case owns the evidence shape
* it is the only admissible reading of, so the conclusion and the evidence deciding it
* cannot drift apart.
*/
var CoherenceVerdict = class {
	static get duplicate() {
		return duplicateVerdict;
	}
	static get distinct() {
		return distinctVerdict;
	}
	static fromData(value) {
		const label = requireString(value, "Coherence finding verdict");
		if (label === duplicateVerdict.label) return duplicateVerdict;
		if (label === distinctVerdict.label) return distinctVerdict;
		throw new TypeError("Coherence verdict is invalid");
	}
	equals(other) {
		return this === other;
	}
};
var DuplicateWork = class extends CoherenceVerdict {
	label = "duplicate";
	requireEvidence(witnesses, discriminator) {
		if (witnesses.length === 0 || discriminator !== void 0) throw new TypeError("A duplicate finding carries witnesses and no discriminator");
		if (!witnesses.every(argumentsEqual)) throw new TypeError("A duplicate witness must carry equal arguments digests");
	}
};
var DistinctWork = class extends CoherenceVerdict {
	label = "distinct";
	requireEvidence(witnesses, discriminator) {
		if (witnesses.length > 0 || discriminator === void 0) throw new TypeError("A distinct finding carries one discriminator and no witnesses");
		if (argumentsEqual(discriminator)) throw new TypeError("A distinct discriminator must carry differing arguments digests");
	}
};
var duplicateVerdict = Object.freeze(new DuplicateWork());
var distinctVerdict = Object.freeze(new DistinctWork());
var CoherenceFindingCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			CoherenceFinding,
			CoherenceVerdict,
			DuplicateWork,
			DistinctWork,
			ScopeRef,
			PrincipalRef,
			OperationRef,
			TextId,
			Digest,
			CoherenceFindingId,
			GrantId,
			RunId,
			EventId,
			RouteReservationId,
			OperationName,
			FacetPackageId,
			PrincipalId,
			TenantId,
			ProjectId,
			WorkspaceId
		], "workspace.coherence-finding", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(finding) {
		const payload = {
			id: finding.id.value,
			observer: encodeOptionalPrincipalRef(finding.observer),
			scope: encodeScope(finding.scope),
			grant: finding.grant.value,
			subjects: finding.subjects.map((run) => run.value),
			verdict: finding.verdict.label,
			witnesses: finding.witnesses.map(encodeResemblance)
		};
		return finding.discriminator === void 0 ? payload : {
			...payload,
			discriminator: encodeResemblance(finding.discriminator)
		};
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "Coherence finding payload");
		requireOptionalFields(object, [
			"grant",
			"id",
			"observer",
			"scope",
			"subjects",
			"verdict",
			"witnesses"
		], ["discriminator"], "Coherence finding payload");
		const init = {
			id: new CoherenceFindingId(requireString(object["id"], "Coherence finding ID")),
			observer: decodePrincipal(object["observer"], "Coherence finding observer"),
			scope: decodeScope(object["scope"]),
			grant: new GrantId(requireString(object["grant"], "Coherence finding Grant")),
			subjects: decodeSubjects(object["subjects"]),
			verdict: CoherenceVerdict.fromData(object["verdict"]),
			witnesses: requireArray(object["witnesses"], "Coherence finding witnesses").map((value) => decodeResemblance(value, "Coherence finding witness"))
		};
		const discriminator = object["discriminator"];
		return new CoherenceFinding(discriminator === void 0 ? init : {
			...init,
			discriminator: decodeResemblance(discriminator, "Coherence finding discriminator")
		});
	}
};
/**
* One observer's determination that two Runs are, or are not, doing the same work. The
* record carries identifiers and digests only: it is checkable by a reader who can read the
* observed Events through the same Grant, and it is no second copy of what those Runs hold.
*/
var CoherenceFinding = class CoherenceFinding {
	static get codec() {
		return coherenceFindingCodecInstance;
	}
	static encode(finding) {
		return CoherenceFinding.codec.encode(finding);
	}
	static decode(bytes) {
		return CoherenceFinding.codec.decode(bytes);
	}
	init;
	constructor(init) {
		const [first, second] = init.subjects;
		if (first.equals(second)) throw new TypeError("A coherence finding compares two different Runs");
		for (const resemblance of [...init.witnesses, ...init.discriminator === void 0 ? [] : [init.discriminator]]) requireResemblance(resemblance, init.subjects);
		init.verdict.requireEvidence(init.witnesses, init.discriminator);
		this.init = Object.freeze({
			...init,
			subjects: Object.freeze([first, second]),
			witnesses: Object.freeze([...init.witnesses])
		});
		Object.freeze(this);
	}
	get id() {
		return this.init.id;
	}
	get observer() {
		return this.init.observer;
	}
	get scope() {
		return this.init.scope;
	}
	get grant() {
		return this.init.grant;
	}
	get subjects() {
		return this.init.subjects;
	}
	get verdict() {
		return this.init.verdict;
	}
	get witnesses() {
		return this.init.witnesses;
	}
	get discriminator() {
		return this.init.discriminator;
	}
};
var coherenceFindingCodecInstance = new CoherenceFindingCodecV1();
function argumentsEqual(resemblance) {
	return resemblance.left.argumentsDigest.equals(resemblance.right.argumentsDigest);
}
function requireResemblance(resemblance, subjects) {
	const { left, right } = resemblance;
	if (!left.operation.equals(right.operation)) throw new TypeError("A resemblance names one Operation on both sides");
	if (!left.run.equals(subjects[0]) || !right.run.equals(subjects[1])) throw new TypeError("A resemblance names the finding's two subject Runs in order");
}
function encodeResemblance(resemblance) {
	return {
		left: encodeIntent(resemblance.left),
		right: encodeIntent(resemblance.right)
	};
}
function decodeResemblance(value, subject) {
	const object = requireObject(value, subject);
	requireFields(object, ["left", "right"], subject);
	return {
		left: decodeIntent(object["left"], `${subject} left`),
		right: decodeIntent(object["right"], `${subject} right`)
	};
}
function encodeIntent(intent) {
	return {
		run: intent.run.value,
		event: intent.event.value,
		reservation: intent.reservation.value,
		operation: intent.operation.value,
		argumentsDigest: intent.argumentsDigest.value
	};
}
function decodeIntent(value, subject) {
	const object = requireObject(value, subject);
	requireFields(object, [
		"argumentsDigest",
		"event",
		"operation",
		"reservation",
		"run"
	], subject);
	return {
		run: new RunId(requireString(object["run"], `${subject} Run`)),
		event: new EventId(requireString(object["event"], `${subject} Event`)),
		reservation: new RouteReservationId(requireString(object["reservation"], `${subject} reservation`)),
		operation: new OperationRef(requireString(object["operation"], `${subject} Operation`)),
		argumentsDigest: new Digest(requireString(object["argumentsDigest"], `${subject} arguments digest`))
	};
}
function decodeSubjects(value) {
	const runs = requireArray(value, "Coherence finding subjects");
	if (runs.length !== 2) throw new TypeError("A coherence finding names exactly two subject Runs");
	return [new RunId(requireString(runs[0], "Coherence finding first subject")), new RunId(requireString(runs[1], "Coherence finding second subject"))];
}
function decodePrincipal(value, subject) {
	const principal = decodeOptionalPrincipalRef(value, subject);
	if (principal === void 0) throw new TypeError(`${subject} is required`);
	return principal;
}
//#endregion
//#region src/workspaces/inbox.ts
var InboxEventReferenceCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			InboxEventReference,
			TextId,
			InboxReferenceId,
			EventId,
			TurnId
		], "workspace.inbox-reference", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(reference) {
		return {
			id: reference.id.value,
			turn: reference.turn.value,
			event: reference.event.value,
			sequence: reference.sequence,
			leaseEpoch: reference.leaseEpoch
		};
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "Inbox reference payload");
		requireFields(object, [
			"event",
			"id",
			"leaseEpoch",
			"sequence",
			"turn"
		], "Inbox reference payload");
		return new InboxEventReference({
			id: new InboxReferenceId(requireString(object["id"], "Inbox reference ID")),
			turn: new TurnId(requireString(object["turn"], "Inbox Turn ID")),
			event: new EventId(requireString(object["event"], "Inbox Event ID")),
			sequence: requireInteger(object["sequence"], "Inbox sequence"),
			leaseEpoch: requireInteger(object["leaseEpoch"], "Inbox lease epoch")
		});
	}
};
var InboxEventReference = class InboxEventReference {
	static get codec() {
		return inboxEventReferenceCodecInstance;
	}
	static encode(reference) {
		return InboxEventReference.codec.encode(reference);
	}
	static decode(bytes) {
		return InboxEventReference.codec.decode(bytes);
	}
	init;
	constructor(init) {
		if (!Number.isSafeInteger(init.sequence) || init.sequence < 0 || !Number.isSafeInteger(init.leaseEpoch) || init.leaseEpoch < 0) throw new TypeError("Inbox sequence and lease epoch must be non-negative safe integers");
		this.init = Object.freeze({ ...init });
		Object.freeze(this);
	}
	get id() {
		return this.init.id;
	}
	get turn() {
		return this.init.turn;
	}
	get event() {
		return this.init.event;
	}
	get sequence() {
		return this.init.sequence;
	}
	get leaseEpoch() {
		return this.init.leaseEpoch;
	}
};
var inboxEventReferenceCodecInstance = new InboxEventReferenceCodecV1();
//#endregion
//#region src/workspaces/retention.ts
var RetainedRecordKind = class {
	static event() {
		return retainedEvent;
	}
	static routeReservation() {
		return retainedReservation;
	}
	static routeProjection() {
		return retainedProjection;
	}
	static view() {
		return retainedView;
	}
	static viewDelta() {
		return retainedViewDelta;
	}
	equals(other) {
		return this.kind === other.kind;
	}
};
var RetainedEvent = class extends RetainedRecordKind {
	kind = "event";
};
var RetainedReservation = class extends RetainedRecordKind {
	kind = "routeReservation";
};
var RetainedProjection = class extends RetainedRecordKind {
	kind = "routeProjection";
};
var RetainedView = class extends RetainedRecordKind {
	kind = "view";
};
var RetainedViewDelta = class extends RetainedRecordKind {
	kind = "viewDelta";
};
var retainedEvent = Object.freeze(new RetainedEvent());
var retainedReservation = Object.freeze(new RetainedReservation());
var retainedProjection = Object.freeze(new RetainedProjection());
var retainedView = Object.freeze(new RetainedView());
var retainedViewDelta = Object.freeze(new RetainedViewDelta());
var ContentRetentionReferenceCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			ContentRetentionReference,
			ActorRef,
			ContentRef,
			RetainedRecordKind,
			RetainedEvent,
			RetainedReservation,
			RetainedProjection,
			RetainedView,
			RetainedViewDelta,
			TextId,
			Digest,
			RetainedRecordRef,
			ActorId,
			TenantId,
			ContentRetentionId
		], "workspace.content-retention-reference", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(reference) {
		return {
			id: reference.id.value,
			tenant: reference.tenant.value,
			actor: encodeActor(reference.actor),
			recordKind: reference.recordKind.kind,
			record: reference.record.value,
			content: encodeContent(reference.content, reference.digest)
		};
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "Content retention payload");
		requireFields(object, [
			"actor",
			"content",
			"id",
			"record",
			"recordKind",
			"tenant"
		], "Content retention payload");
		const content = decodeContent(object["content"], "Retained content");
		return new ContentRetentionReference({
			id: new ContentRetentionId(requireString(object["id"], "Content retention ID")),
			tenant: new TenantId(requireString(object["tenant"], "Content retention tenant")),
			actor: decodeActor(object["actor"], "Content retention Actor"),
			recordKind: decodeRecordKind(object["recordKind"]),
			record: new RetainedRecordRef(requireString(object["record"], "Retained record reference")),
			content: content.ref,
			digest: content.digest
		});
	}
};
var ContentRetentionReference = class ContentRetentionReference {
	static get codec() {
		return contentRetentionReferenceCodecInstance;
	}
	static encode(reference) {
		return ContentRetentionReference.codec.encode(reference);
	}
	static decode(bytes) {
		return ContentRetentionReference.codec.decode(bytes);
	}
	init;
	constructor(init) {
		if (!init.content.digest.equals(init.digest)) throw new TypeError("Retained ContentRef and digest must match");
		this.init = Object.freeze({
			...init,
			recordKind: decodeRecordKind(init.recordKind.kind)
		});
		Object.freeze(this);
	}
	get id() {
		return this.init.id;
	}
	get tenant() {
		return this.init.tenant;
	}
	get actor() {
		return this.init.actor;
	}
	get recordKind() {
		return this.init.recordKind;
	}
	get record() {
		return this.init.record;
	}
	get content() {
		return this.init.content;
	}
	get digest() {
		return this.init.digest;
	}
};
var contentRetentionReferenceCodecInstance = new ContentRetentionReferenceCodecV1();
/**
* The one implementation of that port over the §8.4 seam: the retained reference names its
* own record kind and identity, so its owner key is the same shape every other plane's
* custody derives, and the retention it writes is the retention the collection sweep reads.
*/
var WorkspaceContentRetention = class {
	retention;
	now;
	constructor(retention, now = () => /* @__PURE__ */ new Date()) {
		this.retention = retention;
		this.now = now;
		Object.freeze(this);
	}
	verify(transaction, reference) {
		return reference.tenant.equals(this.retention.tenant) && reference.actor.equals(this.retention.actor) && this.retention.holds(transaction, reference.content);
	}
	retain(transaction, reference) {
		this.retention.retain(transaction, this.edge(reference), this.operationTime());
	}
	release(transaction, reference) {
		this.retention.release(transaction, this.edge(reference), this.operationTime());
	}
	discard(_reference) {}
	edge(reference) {
		return new ContentOwnerEdge(reference.tenant, reference.actor, contentOwnerKey(RETAINED_RECORD_KINDS[reference.recordKind.kind], reference.record.value, "content"), reference.content);
	}
	operationTime() {
		return requireOperationTime(this.now(), "Workspace content retention time");
	}
};
Object.freeze(WorkspaceContentRetention.prototype);
Object.freeze(WorkspaceContentRetention);
/**
* The wire kind each retained record family is registered under, so one owner namespace per
* record kind matches what the record registry declares for that kind.
*/
var RETAINED_RECORD_KINDS = Object.freeze({
	event: "workspace.event",
	routeReservation: "workspace.route-reservation",
	routeProjection: "workspace.route-projection",
	view: "workspace.view",
	viewDelta: "workspace.view-delta"
});
function decodeRecordKind(value) {
	if (value === "event") return RetainedRecordKind.event();
	if (value === "routeReservation") return RetainedRecordKind.routeReservation();
	if (value === "routeProjection") return RetainedRecordKind.routeProjection();
	if (value === "view") return RetainedRecordKind.view();
	if (value === "viewDelta") return RetainedRecordKind.viewDelta();
	throw new TypeError("Retained record kind is invalid");
}
//#endregion
//#region src/workspaces/route.ts
var RouteReservationCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			RouteReservation,
			ActorRef,
			ContentRef,
			TextId,
			Digest,
			OperationRef,
			BindingName,
			InvocationId,
			ActorId,
			RouteProjectionId,
			EventId,
			RouteReservationId,
			AuditRecordId,
			TenantId,
			SubscriptionId,
			PrincipalId,
			FacetPackageId,
			OperationName,
			PrincipalRef
		], "workspace.route-reservation", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(route) {
		return {
			id: route.id.value,
			invocation: route.invocation.value,
			event: route.event.value,
			sourceAuditCause: route.sourceAuditCause.value,
			sourceActor: encodeActor(route.sourceActor),
			targetActor: encodeActor(route.targetActor),
			tenants: encodeTenants(route.tenants),
			subscription: route.subscription.value,
			dedupeKey: route.dedupeKey,
			operation: route.operation.value,
			authority: encodeAuthority(route.authority),
			projection: route.projection.value,
			projectionContent: encodeContent(route.projectionRef, route.projectionDigest),
			trust: route.trust,
			initiator: encodeOptionalPrincipalRef(route.initiator)
		};
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "Route reservation payload");
		requireFields(object, [
			"authority",
			"dedupeKey",
			"event",
			"id",
			"initiator",
			"invocation",
			"operation",
			"projection",
			"projectionContent",
			"sourceActor",
			"sourceAuditCause",
			"subscription",
			"targetActor",
			"tenants",
			"trust"
		], "Route reservation payload");
		const projection = decodeContent(object["projectionContent"], "Route projection content");
		const initiator = decodeOptionalPrincipalRef(object["initiator"], "Route initiator");
		let reservation = {
			id: new RouteReservationId(requireString(object["id"], "Route reservation ID")),
			invocation: new InvocationId(requireString(object["invocation"], "Route invocation ID")),
			event: new EventId(requireString(object["event"], "Route Event ID")),
			sourceAuditCause: new AuditRecordId(requireString(object["sourceAuditCause"], "Route source audit cause")),
			sourceActor: decodeActor(object["sourceActor"], "Route source Actor"),
			targetActor: decodeActor(object["targetActor"], "Route target Actor"),
			tenants: decodeTenants(object["tenants"]),
			subscription: new SubscriptionId(requireString(object["subscription"], "Route Subscription ID")),
			dedupeKey: requireString(object["dedupeKey"], "Route dedupe key"),
			operation: new OperationRef(requireString(object["operation"], "Route operation")),
			authority: decodeAuthority$1(object["authority"]),
			projection: new RouteProjectionId(requireString(object["projection"], "Route projection ID")),
			projectionRef: projection.ref,
			projectionDigest: projection.digest,
			trust: decodeTrust(object["trust"])
		};
		if (initiator !== void 0) reservation = {
			...reservation,
			initiator
		};
		return new RouteReservation(reservation);
	}
};
var RouteReservation = class RouteReservation {
	static get codec() {
		return routeReservationCodecInstance;
	}
	static encode(reservation) {
		return RouteReservation.codec.encode(reservation);
	}
	static decode(bytes) {
		return RouteReservation.codec.decode(bytes);
	}
	init;
	constructor(init) {
		if (!init.projectionRef.digest.equals(init.projectionDigest)) throw new TypeError("Route projection reference and digest must match");
		if (init.dedupeKey.length === 0 || init.dedupeKey.trim() !== init.dedupeKey) throw new TypeError("Route dedupe key must be a nonblank canonical string");
		if (init.authority.kind === "initiator" && init.initiator === void 0) throw new TypeError("Initiator routes require an authenticated Principal");
		if (init.initiator !== void 0 && !init.initiator.tenantId.equals(sourceTenant(init.tenants))) throw new TypeError("Route initiator Tenant must match the source Tenant");
		this.init = copyReservationInit(init);
		Object.freeze(this);
	}
	get id() {
		return this.init.id;
	}
	get invocation() {
		return this.init.invocation;
	}
	get event() {
		return this.init.event;
	}
	get sourceAuditCause() {
		return this.init.sourceAuditCause;
	}
	get sourceActor() {
		return this.init.sourceActor;
	}
	get targetActor() {
		return this.init.targetActor;
	}
	get tenants() {
		return this.init.tenants;
	}
	get subscription() {
		return this.init.subscription;
	}
	get dedupeKey() {
		return this.init.dedupeKey;
	}
	get operation() {
		return this.init.operation;
	}
	get authority() {
		return this.init.authority;
	}
	get projection() {
		return this.init.projection;
	}
	get projectionRef() {
		return this.init.projectionRef;
	}
	get projectionDigest() {
		return this.init.projectionDigest;
	}
	get trust() {
		return this.init.trust;
	}
	get initiator() {
		return this.init.initiator;
	}
};
var routeReservationCodecInstance = new RouteReservationCodecV1();
var RouteProjectionCodecV2 = class extends RecordCodec {
	constructor() {
		super([
			RouteProjection,
			ContentRef,
			TextId,
			Digest,
			RouteProjectionId,
			RouteReservationId
		], "workspace.route-projection", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(projection) {
		return {
			id: projection.id.value,
			reservation: projection.reservation.value,
			content: encodeContent(projection.content, projection.digest),
			authenticationDigest: projection.authenticationDigest?.value ?? null
		};
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "Route projection payload");
		requireFields(object, [
			"authenticationDigest",
			"content",
			"id",
			"reservation"
		], "Route projection payload");
		const content = decodeContent(object["content"], "Route projection content");
		const authenticationDigest = requireNullableString(object["authenticationDigest"], "Route projection authentication digest");
		const projection = {
			id: new RouteProjectionId(requireString(object["id"], "Route projection ID")),
			reservation: new RouteReservationId(requireString(object["reservation"], "Projection reservation ID")),
			content: content.ref,
			digest: content.digest
		};
		return new RouteProjection(authenticationDigest === void 0 ? projection : {
			...projection,
			authenticationDigest: new Digest(authenticationDigest)
		});
	}
};
var RouteProjection = class RouteProjection {
	static get codec() {
		return routeProjectionCodecInstance;
	}
	static encode(projection) {
		return RouteProjection.codec.encode(projection);
	}
	static decode(bytes) {
		return RouteProjection.codec.decode(bytes);
	}
	init;
	constructor(init) {
		if (!init.content.digest.equals(init.digest)) throw new TypeError("Projection content reference and digest must match");
		this.init = Object.freeze({ ...init });
		Object.freeze(this);
	}
	get id() {
		return this.init.id;
	}
	get reservation() {
		return this.init.reservation;
	}
	get content() {
		return this.init.content;
	}
	get digest() {
		return this.init.digest;
	}
	get authenticationDigest() {
		return this.init.authenticationDigest;
	}
	get authenticated() {
		return this.authenticationDigest !== void 0;
	}
	authenticate(digest) {
		if (this.authenticationDigest !== void 0) throw new AgentCoreError("protocol.invalid-state", "Route projection is already authenticated");
		return new RouteProjection({
			...this.init,
			authenticationDigest: digest
		});
	}
};
var routeProjectionCodecInstance = new RouteProjectionCodecV2();
var RouteDeliveryState = class {
	static delivered() {
		return deliveredRoute;
	}
	static rejected(reason) {
		return new RejectedRouteDelivery(reason);
	}
	equals(other) {
		return this.kind === other.kind && this.reason === other.reason;
	}
};
var DeliveredRouteDelivery = class extends RouteDeliveryState {
	kind = "delivered";
	reason = void 0;
};
var RejectedRouteDelivery = class extends RouteDeliveryState {
	reason;
	kind = "rejected";
	constructor(reason) {
		super();
		this.reason = reason;
		if (reason.length === 0 || reason.trim() !== reason) throw new TypeError("Route rejection reason must be canonical");
		Object.freeze(this);
	}
};
var deliveredRoute = Object.freeze(new DeliveredRouteDelivery());
var RouteDeliveryCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			RouteDelivery,
			RouteDeliveryState,
			TextId,
			RouteReservationId,
			AuditRecordId,
			DeliveredRouteDelivery,
			RejectedRouteDelivery
		], "workspace.route-delivery", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(delivery) {
		return {
			reservation: delivery.reservation.value,
			outcome: delivery.state.kind,
			targetAudit: delivery.targetAudit.value,
			reason: delivery.state.reason ?? null
		};
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "Route delivery payload");
		requireFields(object, [
			"outcome",
			"reason",
			"reservation",
			"targetAudit"
		], "Route delivery payload");
		const outcome = object["outcome"];
		if (outcome !== "delivered" && outcome !== "rejected") throw new TypeError("Route delivery outcome is invalid");
		const reason = requireNullableString(object["reason"], "Route delivery reason");
		if (outcome === "delivered" !== (reason === void 0)) throw new TypeError("Route delivery reason does not match its terminal outcome");
		return new RouteDelivery({
			reservation: new RouteReservationId(requireString(object["reservation"], "Delivery reservation ID")),
			state: outcome === "delivered" ? RouteDeliveryState.delivered() : RouteDeliveryState.rejected(reason),
			targetAudit: new AuditRecordId(requireString(object["targetAudit"], "Delivery target audit"))
		});
	}
};
var RouteDelivery = class RouteDelivery {
	static get codec() {
		return routeDeliveryCodecInstance;
	}
	static encode(delivery) {
		return RouteDelivery.codec.encode(delivery);
	}
	static decode(bytes) {
		return RouteDelivery.codec.decode(bytes);
	}
	reservation;
	state;
	targetAudit;
	constructor(init) {
		this.reservation = init.reservation;
		this.state = init.state.kind === "delivered" ? RouteDeliveryState.delivered() : RouteDeliveryState.rejected(init.state.reason);
		this.targetAudit = init.targetAudit;
		Object.freeze(this);
	}
};
var routeDeliveryCodecInstance = new RouteDeliveryCodecV1();
function copyReservationInit(init) {
	const tenants = init.tenants.kind === "same" ? Object.freeze({
		kind: init.tenants.kind,
		tenant: init.tenants.tenant
	}) : Object.freeze({
		kind: init.tenants.kind,
		source: init.tenants.source,
		target: init.tenants.target,
		authority: init.tenants.authority
	});
	const authority = Object.freeze({
		kind: init.authority.kind,
		binding: init.authority.binding
	});
	return Object.freeze({
		...init,
		tenants,
		authority
	});
}
function encodeAuthority(authority) {
	return {
		kind: authority.kind,
		binding: authority.binding.value
	};
}
function decodeAuthority$1(value) {
	const object = requireObject(value, "Route authority");
	requireFields(object, ["binding", "kind"], "Route authority");
	const kind = object["kind"];
	if (kind !== "initiator" && kind !== "delegated") throw new TypeError("Route authority kind is invalid");
	return {
		kind,
		binding: new BindingName(requireString(object["binding"], "Route binding"))
	};
}
function encodeTenants(relation) {
	return relation.kind === "same" ? {
		kind: relation.kind,
		tenant: relation.tenant.value
	} : {
		kind: relation.kind,
		source: relation.source.value,
		target: relation.target.value,
		authority: relation.authority.value
	};
}
function decodeTenants(value) {
	const object = requireObject(value, "Route tenant relation");
	if (object["kind"] === "same") {
		requireFields(object, ["kind", "tenant"], "Same-tenant relation");
		return {
			kind: "same",
			tenant: new TenantId(requireString(object["tenant"], "Route tenant"))
		};
	}
	if (object["kind"] === "cross") {
		requireFields(object, [
			"authority",
			"kind",
			"source",
			"target"
		], "Cross-tenant relation");
		return {
			kind: "cross",
			source: new TenantId(requireString(object["source"], "Route source tenant")),
			target: new TenantId(requireString(object["target"], "Route target tenant")),
			authority: new BindingName(requireString(object["authority"], "Cross-tenant authority"))
		};
	}
	throw new TypeError("Route tenant relation kind is invalid");
}
function sourceTenant(relation) {
	return relation.kind === "same" ? relation.tenant : relation.source;
}
function decodeTrust(value) {
	if (value === "owner" || value === "authenticated" || value === "external" || value === "self") return value;
	throw new TypeError("Route trust is invalid");
}
//#endregion
//#region src/workspaces/policy.ts
function validatePayloadMapping(mapping) {
	const paths = mapping.moves.map((move) => new JsonPointer(move.to).tokens);
	for (const [leftIndex, left] of paths.entries()) for (const right of paths.slice(leftIndex + 1)) if (isPrefix(left, right) || isPrefix(right, left)) throw new TypeError("Mapping targets must not duplicate or overlap");
}
function isPrefix(left, right) {
	return left.length <= right.length && left.every((part, index) => right[index] === part);
}
//#endregion
//#region src/workspaces/subscription.ts
/**
* Major 2 carries the §4.2 attribution of the Facet contribution that materialized the
* Subscription and the §4.1 retirement marker a withdrawal writes. Both are encoded by
* presence: a Subscription no Facet contributed carries no attribution key, and a live one
* carries no `retired` key.
*/
var SubscriptionCodecV2 = class extends RecordCodec {
	constructor() {
		super([
			Subscription,
			ContributionAttribution,
			Revision,
			TextId,
			MappingRecord,
			FieldMove,
			EventPattern,
			OperationRef,
			PayloadMapping,
			BindingName,
			SubscriptionId,
			FacetPackageId,
			OperationName,
			JsonPointer,
			FacetRef,
			Digest,
			SemVer,
			PackageId,
			PackagePin
		], "workspace.subscription", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(subscription) {
		return dataRecord({
			id: subscription.id.value,
			revision: encodeRevision(subscription.revision),
			source: subscription.source.toData(),
			target: subscription.target.value,
			mapping: subscription.mapping.toData(),
			dedupe: subscription.dedupe,
			authority: {
				kind: subscription.authority.kind,
				binding: subscription.authority.binding.value
			},
			contribution: encodeContribution(subscription.contribution),
			retired: subscription.retired
		});
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "Subscription payload");
		requireOptionalFields(object, [
			"authority",
			"dedupe",
			"id",
			"mapping",
			"revision",
			"source",
			"target"
		], ["contribution", "retired"], "Subscription payload");
		const authority = requireObject(object["authority"], "Subscription authority");
		requireFields(authority, ["binding", "kind"], "Subscription authority");
		const contribution = object["contribution"];
		const retired = object["retired"];
		if (retired !== void 0 && retired !== true) throw new TypeError("Subscription retirement is encoded by presence");
		return new Subscription({
			id: new SubscriptionId(requireString(object["id"], "Subscription ID")),
			revision: decodeRevision(object["revision"], "Subscription revision"),
			source: EventPattern.fromData(object["source"]),
			target: new OperationRef(requireString(object["target"], "Subscription target")),
			mapping: new PayloadMapping(requireArray(object["mapping"], "Subscription mapping").map(FieldMove.fromData)),
			dedupe: decodeDedupe(object["dedupe"]),
			authority: decodeAuthority(authority),
			contribution: contribution === void 0 ? void 0 : decodeContribution(contribution),
			retired: retired === void 0 ? void 0 : true
		});
	}
};
var Subscription = class Subscription {
	static get codec() {
		return subscriptionCodecInstance;
	}
	static encode(subscription) {
		return Subscription.codec.encode(subscription);
	}
	static decode(bytes) {
		return Subscription.codec.decode(bytes);
	}
	id;
	revision;
	source;
	target;
	mapping;
	dedupe;
	authority;
	contribution;
	retired;
	constructor(init) {
		validatePayloadMapping(init.mapping);
		if (init.retired !== void 0 && init.retired !== true) throw new TypeError("Subscription retirement is declared by presence");
		if (init.contribution !== void 0 && !(init.contribution instanceof ContributionAttribution)) throw new TypeError("Subscription contribution must carry canonical attribution");
		this.contribution = init.contribution;
		this.retired = init.retired;
		this.id = init.id;
		this.revision = init.revision;
		this.source = EventPattern.decode(EventPattern.encode(init.source));
		this.target = init.target;
		this.mapping = PayloadMapping.decode(PayloadMapping.encode(init.mapping));
		this.dedupe = init.dedupe;
		this.authority = Object.freeze({
			kind: init.authority.kind,
			binding: init.authority.binding
		});
		Object.freeze(this);
	}
	revise(init) {
		return new Subscription({
			...init,
			id: this.id,
			revision: this.revision.next()
		});
	}
	/**
	* SPEC §4.1 (C13-FACET-WITHDRAWAL-EXACT): the retirement revision a withdrawal writes
	* for a Subscription its Facet's `commands` or `automations` contribution materialized.
	*/
	retire() {
		if (this.contribution === void 0) throw new AgentCoreError("protocol.invalid-state", "Only a contributed Subscription is retired by withdrawal");
		return new Subscription({
			id: this.id,
			revision: this.revision.next(),
			source: this.source,
			target: this.target,
			mapping: this.mapping,
			dedupe: this.dedupe,
			authority: this.authority,
			contribution: this.contribution,
			retired: true
		});
	}
};
function encodeContribution(attribution) {
	return attribution === void 0 ? void 0 : {
		contributor: attribution.contributor.value,
		package: attribution.package.toData()
	};
}
function decodeContribution(value) {
	if (!isJsonObject(value)) throw new TypeError("Subscription contribution must be an object");
	return ContributionAttribution.decodeFields(value, "Subscription contribution");
}
var subscriptionCodecInstance = new SubscriptionCodecV2();
function decodeDedupe(value) {
	if (value === "none" || value === "event" || value === "causation" || value === "payload") return value;
	throw new TypeError("Subscription dedupe policy is invalid");
}
function decodeAuthority(value) {
	const kind = value["kind"];
	if (kind !== "initiator" && kind !== "delegated") throw new TypeError("Subscription authority kind is invalid");
	return {
		kind,
		binding: new BindingName(requireString(value["binding"], "Subscription binding"))
	};
}
//#endregion
//#region src/workspaces/withdrawal.ts
/**
* SPEC §4.1 (C13-FACET-WITHDRAWAL-DRAIN): the Workspace Actor's durable capture of one
* withdrawal's drain set. The transaction that begins a withdrawal stops admitting
* Invocations against the withdrawing Facet, so the admitted items are finite at that
* transaction and never grow; this record is that set, frozen, written in the same
* transaction that retires the records. A later completion attempt reads the captured items
* rather than querying again — a host can neither report completion by discarding a live
* item nor be held open by an item admitted after admission stopped — and a later admission
* reads the capture to refuse the release it names, which is what makes the stop survive a
* restart instead of living only inside the transaction that froze the set.
*
* The captured items carry no terminality. Whether an item has reached a terminal current
* Receipt is the Invocation plane's answer (§7.4), read at each completion attempt, so this
* record holds no second copy of Receipt state (§8.4).
*/
var WithdrawalDrainCapture = class WithdrawalDrainCapture {
	static get codec() {
		return withdrawalDrainCaptureCodecInstance;
	}
	static encode(capture) {
		return WithdrawalDrainCapture.codec.encode(capture);
	}
	static decode(bytes) {
		return WithdrawalDrainCapture.codec.decode(bytes);
	}
	/** The record key of the withdrawal of one exact contribution: FacetRef and PackagePin. */
	static keyFor(attribution) {
		return canonicalTupleKey("workspace.withdrawal-drain", [attribution.contributor.value, attribution.package.toData()]);
	}
	attribution;
	items;
	constructor(attribution, items) {
		if (!(attribution instanceof ContributionAttribution)) throw new TypeError("Withdrawal drain capture requires its contribution attribution");
		for (const item of items) if (item.constructor !== InvocationId) throw new TypeError("Withdrawal drain capture holds exact InvocationIds");
		this.attribution = attribution;
		this.items = Object.freeze([...new Map(items.map((item) => [item.value, item])).values()].sort((left, right) => compareCanonicalText(left.value, right.value)));
		Object.freeze(this);
	}
	get key() {
		return WithdrawalDrainCapture.keyFor(this.attribution);
	}
	/** True exactly when the captured set names this item, so nothing else can drain here. */
	captures(item) {
		return this.items.some((captured) => captured.equals(item));
	}
};
var WithdrawalDrainCaptureCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			WithdrawalDrainCapture,
			ContributionAttribution,
			InvocationId,
			TextId,
			FacetRef,
			FacetPackageId,
			PackageId,
			PackagePin,
			Digest,
			SemVer
		], "workspace.withdrawal-drain-capture", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(capture) {
		return {
			contribution: {
				contributor: capture.attribution.contributor.value,
				package: capture.attribution.package.toData()
			},
			items: capture.items.map((item) => item.value)
		};
	}
	decodePayload(payload, _version) {
		const object = requireObject(payload, "Withdrawal drain capture payload");
		requireFields(object, ["contribution", "items"], "Withdrawal drain capture payload");
		const contribution = object["contribution"];
		if (!isJsonObject(contribution)) throw new TypeError("Withdrawal drain capture contribution must be an object");
		return new WithdrawalDrainCapture(ContributionAttribution.decodeFields(contribution, "Withdrawal drain capture contribution"), requireArray(object["items"], "Withdrawal drain capture items").map((item, index) => new InvocationId(requireString(item, `Withdrawal drain item ${index}`))));
	}
};
var withdrawalDrainCaptureCodecInstance = new WithdrawalDrainCaptureCodecV1();
//#endregion
//#region src/workspaces/persistence.ts
var WORKSPACE_RECORD_KINDS = Object.freeze([
	"catalogEntry",
	"contentRetention",
	"event",
	"ingressEndpoint",
	"promptSection",
	"routeDelivery",
	"routeProjection",
	"routeReservation",
	"settingsLayer",
	"subscription",
	"surfaceRegistration",
	"view",
	"viewDelta",
	"withdrawalDrainCapture"
]);
var DELETABLE_WORKSPACE_RECORD_KINDS = Object.freeze([
	"contentRetention",
	"view",
	"viewDelta"
]);
function validateWorkspacePointerAdvance(pointer, expectedRecordKey) {
	validateWorkspacePointer(pointer);
	switch (pointer.namespace) {
		case "subscription.current":
		case "view.current":
		case "ingress.current": {
			const nextRevision = pointerRevision(pointer.recordKey, pointer.namespace);
			const expectedRevision = expectedRecordKey === void 0 ? void 0 : pointerRevision(expectedRecordKey, pointer.namespace);
			if (expectedRevision === void 0 && nextRevision !== 0 || expectedRevision !== void 0 && nextRevision !== expectedRevision + 1) throw revisionConflict("Workspace pointer must advance by exactly one revision");
			return;
		}
		case "catalog.current":
		case "prompt.current":
		case "settings.current":
		case "surface.registration": return;
		default: throw new AgentCoreError("protocol.invalid-state", "Workspace pointer namespace is invalid");
	}
}
function validateStoredWorkspaceRecord(record) {
	if (!isMember(WORKSPACE_RECORD_KINDS, record.kind)) throw new AgentCoreError("codec.invalid", "Workspace record kind is invalid");
	validateStorageText(record.id, 2048, "Workspace record key");
	if (!(record.bytes instanceof Uint8Array)) throw new AgentCoreError("codec.invalid", "Workspace record bytes are malformed");
}
function validateWorkspaceUnique(unique) {
	validateStorageText(unique.namespace, 512, "Workspace unique namespace");
	validateStorageText(unique.key, 2048, "Workspace unique key");
	validateStorageText(unique.recordKey, 2048, "Workspace unique record key");
}
function validateWorkspacePointer(pointer) {
	validateStorageText(pointer.namespace, 512, "Workspace pointer namespace");
	validateStorageText(pointer.key, 2048, "Workspace pointer key");
	validateStorageText(pointer.recordKey, 2048, "Workspace pointer record key");
}
function validateStorageText(value, maximum, subject) {
	if (value.length === 0 || value.length > maximum) throw new AgentCoreError("codec.invalid", `${subject} length is invalid`);
}
/** `["ingress-endpoint.record", <endpoint id>, <revision>]`. */
var INGRESS_POINTER_TUPLE_ARITY = 3;
/** `["view.revision", <Surface id>, <epoch>, <revision>]`. */
var VIEW_POINTER_TUPLE_ARITY = 4;
function pointerRevision(recordKey, namespace) {
	if (namespace === "ingress.current") {
		const tuple = decodeCanonicalJson(new TextEncoder().encode(recordKey));
		if (!Array.isArray(tuple) || tuple.length !== INGRESS_POINTER_TUPLE_ARITY || tuple[0] !== "ingress-endpoint.record") throw new AgentCoreError("codec.invalid", "Ingress endpoint pointer key is malformed");
		const parser = jsonDataParser((message) => new AgentCoreError("codec.invalid", message));
		parser.nonemptyString(tuple[1], "Ingress endpoint ID");
		return parser.safeInteger(tuple[2], "Ingress endpoint revision");
	}
	if (namespace === "view.current") {
		const tuple = decodeViewPointerTuple(recordKey);
		if (tuple.length !== VIEW_POINTER_TUPLE_ARITY || tuple[0] !== "view.revision") throw new AgentCoreError("codec.invalid", "View pointer record key is malformed");
		const parser = jsonDataParser((message) => new AgentCoreError("codec.invalid", message));
		parser.nonemptyString(tuple[1], "View Surface ID");
		parser.safeInteger(tuple[2], "View Surface epoch");
		return parser.safeInteger(tuple[3], "View revision");
	}
	const separator = recordKey.lastIndexOf("@");
	const revision = separator < 0 ? NaN : Number(recordKey.slice(separator + 1));
	if (!Number.isSafeInteger(revision) || revision < 0) throw new AgentCoreError("codec.invalid", "Workspace pointer record key is malformed");
	return revision;
}
/**
* A View pointer's record key, decoded as the canonical tuple it is. A key that is not
* canonical JSON and a key that is canonical JSON of the wrong shape are the same fact for a
* reader, so both report the one malformed-key message instead of leaking a parse error.
*/
function decodeViewPointerTuple(recordKey) {
	let decoded;
	try {
		decoded = decodeCanonicalJson(new TextEncoder().encode(recordKey));
	} catch {
		throw new AgentCoreError("codec.invalid", "View pointer record key is malformed");
	}
	if (!Array.isArray(decoded)) throw new AgentCoreError("codec.invalid", "View pointer record key is malformed");
	return decoded;
}
function revisionConflict(message) {
	return new AgentCoreError("protocol.revision-conflict", message);
}
//#endregion
//#region src/workspaces/plan.ts
var PlanChange = class {
	static declaredTask(task) {
		return new TaskDeclaration(task);
	}
	static declaredDependency(blocked, blockedBy) {
		return new DependencyDeclaration({
			blocked,
			blockedBy
		});
	}
	static retractedDependency(blocked, blockedBy) {
		return new DependencyRetraction({
			blocked,
			blockedBy
		});
	}
	static fromData(object) {
		const kind = requireString(object["kind"], "Plan fact kind");
		if (!isPlanFactKind(kind)) throw new AgentCoreError("codec.invalid", `Plan fact kind ${kind} is unknown`);
		return PLAN_CHANGE_DECODERS[kind](object);
	}
};
var TaskDeclaration = class extends PlanChange {
	task;
	kind = "plan.taskDeclared";
	constructor(task) {
		super();
		this.task = task;
		Object.freeze(this);
	}
	fold(plan) {
		if (plan.declares(this.task)) throw new AgentCoreError("plan.duplicate-task", `Task ${this.task.value} is already in the plan`);
		return plan.withTasks([...plan.tasks, this.task]);
	}
	toData() {
		return {
			kind: this.kind,
			task: this.task.value
		};
	}
};
var DependencyDeclaration = class extends PlanChange {
	edge;
	kind = "plan.dependencyDeclared";
	constructor(edge) {
		super();
		this.edge = edge;
		Object.freeze(this);
	}
	fold(plan) {
		for (const endpoint of [this.edge.blocked, this.edge.blockedBy]) if (!plan.declares(endpoint)) throw new AgentCoreError("plan.unknown-task", `Task ${endpoint.value} is not in the plan`);
		if (plan.dependsDirectly(this.edge)) throw new AgentCoreError("plan.duplicate-dependency", `Task ${this.edge.blocked.value} is already blocked by ${this.edge.blockedBy.value}`);
		if (this.edge.blocked.equals(this.edge.blockedBy) || plan.precedes(this.edge.blocked, this.edge.blockedBy)) throw new AgentCoreError("plan.cycle", `Blocking ${this.edge.blocked.value} by ${this.edge.blockedBy.value} closes a cycle`);
		return plan.withDependencies([...plan.dependencies, this.edge]);
	}
	toData() {
		return edgeData(this.kind, this.edge);
	}
};
var DependencyRetraction = class extends PlanChange {
	edge;
	kind = "plan.dependencyRetracted";
	constructor(edge) {
		super();
		this.edge = edge;
		Object.freeze(this);
	}
	fold(plan) {
		if (!plan.dependsDirectly(this.edge)) throw new AgentCoreError("plan.unknown-dependency", `Task ${this.edge.blocked.value} is not blocked by ${this.edge.blockedBy.value}`);
		return plan.withDependencies(plan.dependencies.filter((standing) => !sameEdge(standing, this.edge)));
	}
	toData() {
		return edgeData(this.kind, this.edge);
	}
};
var PlanFactCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			PlanFact,
			PlanChange,
			TaskDeclaration,
			DependencyDeclaration,
			DependencyRetraction,
			TextId,
			TaskId,
			TurnId
		], "workspace.plan-fact", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(fact) {
		return fact.toData();
	}
	decodePayload(payload, _version) {
		return PlanFact.fromData(payload);
	}
};
/**
* The decoded payload of one plan Event: what changed, and the Turn that appended it under
* its own lease (§6.1 `self` tier). Identifiers only — no capability, BindingName,
* ResourceCeiling, SecretRef, or Run reference is representable here, which is what keeps a
* discovery from handing its successor more than the discoverer held.
*/
var PlanFact = class PlanFact {
	change;
	origin;
	static get codec() {
		return planFactCodecInstance;
	}
	static encode(fact) {
		return PlanFact.codec.encode(fact);
	}
	static decode(bytes) {
		return PlanFact.codec.decode(bytes);
	}
	static fromData(value) {
		const object = requireObject(value, "Plan fact");
		return new PlanFact(PlanChange.fromData(object), new TurnId(requireString(object["origin"], "Plan origin Turn ID")));
	}
	constructor(change, origin) {
		this.change = change;
		this.origin = origin;
		Object.freeze(this);
	}
	get kind() {
		return this.change.kind;
	}
	fold(plan) {
		return this.change.fold(plan);
	}
	toData() {
		return {
			...this.change.toData(),
			origin: this.origin.value
		};
	}
};
var planFactCodecInstance = new PlanFactCodecV1();
var PLAN_CHANGE_DECODERS = {
	"plan.dependencyDeclared": (object) => PlanChange.declaredDependency(...decodeEdge(object, "Plan dependency declaration")),
	"plan.dependencyRetracted": (object) => PlanChange.retractedDependency(...decodeEdge(object, "Plan dependency retraction")),
	"plan.taskDeclared": (object) => {
		requireFields(object, [
			"kind",
			"origin",
			"task"
		], "Plan task declaration");
		return PlanChange.declaredTask(new TaskId(requireString(object["task"], "Plan Task ID")));
	}
};
function isPlanFactKind(value) {
	return Object.hasOwn(PLAN_CHANGE_DECODERS, value);
}
/** Three call sites read edge identity in lockstep: declare, retract, and the standing check. */
function sameEdge(left, right) {
	return left.blocked.equals(right.blocked) && left.blockedBy.equals(right.blockedBy);
}
function edgeData(kind, edge) {
	return {
		blocked: edge.blocked.value,
		blockedBy: edge.blockedBy.value,
		kind
	};
}
function decodeEdge(object, subject) {
	requireFields(object, [
		"blocked",
		"blockedBy",
		"kind",
		"origin"
	], subject);
	return [new TaskId(requireString(object["blocked"], `${subject} blocked Task ID`)), new TaskId(requireString(object["blockedBy"], `${subject} blocking Task ID`))];
}
//#endregion
//#region src/composition/detached-target.ts
/**
* The mediation composition's live target for work a Turn detached (SPEC §5.6,
* C13-TURN-HANDLE-DETACHMENT).
*
* A detached item outlives the Turn that issued it, so nothing here may hold a per-Turn
* closure. `execution` rebuilds the live half of one admitted item from durable records
* alone: the PreparedInvocation's pinned Operation resolved back against the Facet runtime
* the composition activated, and the prepared arguments as stored. The Turn's authorization
* is deliberately not rebuilt — §7.3 froze the whole intent at preparation and §7.4 admits
* the attempt once, so a rebuilt authorization would be a second authority decision where
* the rules require none, and a fabricated one at that.
*
* The controllers are the whole live resource this class owns, one per in-flight attempt and
* keyed by `EffectAttemptId` because that is the one identity a Run's cancellation message
* names. A restart empties the map by construction, which is why `cancel` answers `absent`
* rather than pretending a controller nobody observed was aborted.
*/
var DetachedMediationTarget = class extends DetachedEffectTarget {
	facets;
	transactions;
	persistence;
	content;
	#controllers = /* @__PURE__ */ new Map();
	constructor(facets, transactions, persistence, content) {
		super();
		this.facets = facets;
		this.transactions = transactions;
		this.persistence = persistence;
		this.content = content;
	}
	/**
	* Rebuilds the execution of one admitted item, refusing rather than approximating.
	*
	* The pin is verified against the live runtime before anything runs: the pinned facet
	* target must still be the Facet this composition activated, the pinned operation name
	* must still be declared, and the live descriptor must still hash to the pinned digest.
	* The descriptor is the authority for §7.4's `outputInvalid`, so a live Facet whose
	* declaration has drifted from the pin is a refusal — the item's reconciliation owns what
	* happens next, not a descriptor the Invocation never admitted under.
	*/
	async execution(item) {
		const prepared = this.transactions.transact((transaction) => this.persistence.prepared(transaction, item.invocation));
		if (prepared === void 0) throw new AgentCoreError("invocation.invalid", "A detached item names no stored PreparedInvocation");
		if (prepared.item(item.itemIndex).idempotencyKey !== item.itemKey) throw new AgentCoreError("invocation.invalid", "A detached item does not bind its PreparedInvocation item");
		const pin = prepared.header.operation;
		const operation = this.resolveOperation(pin);
		const inputs = Array.from({ length: prepared.itemCount }, (_unused, index) => prepared.item(index).arguments);
		const controller = this.controller(item.attempt);
		return Object.freeze({
			descriptor: operation.descriptor,
			execute: (itemIndex, context) => {
				const input = inputs[itemIndex];
				if (input === void 0) throw new AgentCoreError("invocation.invalid", "A detached execution requested an item its Invocation does not hold");
				return Promise.resolve(operation.execute(context, input));
			},
			resources: Object.freeze({
				signal: controller.signal,
				content: this.content,
				deadline: void 0,
				target: Object.freeze({ answering: () => this.facets.facet(new FacetRef(pin.target)) !== void 0 })
			}),
			targetAdmission: void 0
		});
	}
	/**
	* Aborts the one live controller this attempt runs under, or reports it absent.
	*
	* `absent` is the answer after a restart: no controller survived one, so no cancellation
	* reached an effect, and §7.4 leaves the outcome for reconciliation. Nothing here derives
	* `aborted` from the request — the running attempt a `reached` answer returns writes its
	* own Receipt through the ordinary classification path, because the signal it runs under
	* is the one just fired.
	*/
	cancel(attempt) {
		const controller = this.#controllers.get(attempt.value);
		if (controller === void 0) return Promise.resolve(AttemptCancellationObservation.absent);
		controller.abort();
		return Promise.resolve(AttemptCancellationObservation.reached);
	}
	/** The controller one attempt runs under, created on first use and keyed by its attempt. */
	controller(attempt) {
		const existing = this.#controllers.get(attempt.value);
		if (existing !== void 0) return existing;
		const created = new AbortController();
		this.#controllers.set(attempt.value, created);
		return created;
	}
	/** Drops every live controller the way a process restart does, leaving the records. */
	restart() {
		this.#controllers.clear();
	}
	resolveOperation(pin) {
		const runtime = this.facets.facet(new FacetRef(pin.target));
		if (runtime === void 0) throw new AgentCoreError("facet.inactive", `A detached item's pinned Facet ${pin.target} is no longer active`);
		const operation = runtime.operation(pin.operation.operation);
		if (operation === void 0) throw new AgentCoreError("operation.missing", `A detached item's pinned Operation ${pin.operation.value} is not declared`);
		if (!Digest.sha256(encodeCanonicalJson(operation.descriptor.toData())).equals(pin.descriptorDigest)) throw new AgentCoreError("invocation.invalid", "A detached item's live Operation descriptor differs from its pin");
		return operation;
	}
};
Object.freeze([
	"add",
	"remove",
	"replace",
	"move",
	"copy",
	"test"
]);
//#endregion
//#region src/composition/permit.ts
var authorityPermitReferenceCodec = structuralCodec((reference) => AuthorityPermit.fromData(reference).toData(), (value) => AuthorityPermit.fromData(value).toData());
var TargetAuthorityPermitDenialPort = class {
	tenant;
	owner;
	store;
	state;
	constructor(tenant, owner, store, state) {
		this.tenant = tenant;
		this.owner = owner;
		this.store = store;
		this.state = state;
		if (owner.kind === "tenant") throw new TypeError("Target authority denial owner must be a non-Tenant Actor");
	}
	deny(transaction, authentication) {
		const denialRecord = authentication.record();
		const { request, evidence } = denialRecord;
		const { expectation } = request;
		if (!expectation.tenant.equals(this.tenant) || !expectation.target.actor.equals(this.owner) || !expectation.principal.tenantId.equals(this.tenant) || !this.store.owner.equals(this.owner)) throw denied("Target authority denial evidence has the wrong owner");
		const retained = this.store.requested(transaction, request.nonce);
		if (retained === void 0 || !retained.digest().equals(request.digest())) throw denied("Target authority denial does not bind its exact retained request");
		this.store.deny(transaction, denialRecord);
		this.state.joinDeniedEpochs(transaction, expectation.principal, evidence.pathEpochs.path);
		this.state.invalidateResolution(transaction, expectation);
	}
};
var TargetLeaseEvidenceTransport = class {};
/** The source's own authenticated channel to its Tenant for lease-evidence projection. */
var TargetLeaseEvidenceProjectionTransport = class {};
/**
* Source-side host step. The attestation commits in the owning Actor's transaction;
* the Tenant projection is originated by the source host itself only after that
* transaction has closed, so no target ever forwards evidence bytes or speaks as the
* source, and no await spans the commit.
*/
var StoredProjectedTargetLeaseEvidence = class extends TargetLeaseEvidenceTransport {
	store;
	issuer;
	projection;
	now;
	constructor(store, issuer, projection, now) {
		super();
		this.store = store;
		this.issuer = issuer;
		this.projection = projection;
		this.now = now;
	}
	async attest(request) {
		let decoded;
		try {
			decoded = TargetAuthorityPermitRequest.decode(request);
		} catch {
			throw new AgentCoreError("codec.invalid", "Target lease evidence request is malformed");
		}
		const evidence = this.store.transaction((transaction) => this.issuer.attest(transaction, decoded, this.now()));
		if (evidence === void 0) return void 0;
		const projectedBytes = await this.projection.project(TargetLeaseEvidence.encode(evidence), evidence.key.idempotencyKey);
		let projected;
		try {
			projected = TargetLeaseEvidence.decode(projectedBytes);
		} catch {
			throw new AgentCoreError("codec.invalid", "Tenant projection reply is malformed");
		}
		if (!projected.digest().equals(evidence.digest())) throw denied("Tenant projection substituted source lease evidence");
		return Object.freeze({
			reference: evidence.reference(),
			deadline: evidence.deadline
		});
	}
};
var AuthorityPermitIssuanceTransport = class {};
var AuthenticatedAuthorityPermitDenial = class {
	#record;
	constructor(authority, request, evidence) {
		if (authority !== denialAuthenticationAuthority) throw new TypeError("Authority permit denial requires authenticated Tenant evidence");
		this.#record = TargetAuthorityPermitDenial.decode(TargetAuthorityPermitDenial.encode(new TargetAuthorityPermitDenial(request, evidence)));
		Object.freeze(this);
	}
	record() {
		return TargetAuthorityPermitDenial.decode(TargetAuthorityPermitDenial.encode(this.#record));
	}
};
var denialAuthenticationAuthority = Symbol("authority-permit-denial-authentication");
var IssuedAuthorityPermitPort = class {
	store;
	expectations;
	denial;
	authority;
	transport;
	nonce;
	now;
	lifetimeMilliseconds;
	attestation;
	constructor(store, expectations, denial, authority, transport, nonce, now, lifetimeMilliseconds, attestation = void 0) {
		this.store = store;
		this.expectations = expectations;
		this.denial = denial;
		this.authority = authority;
		this.transport = transport;
		this.nonce = nonce;
		this.now = now;
		this.lifetimeMilliseconds = lifetimeMilliseconds;
		this.attestation = attestation;
		if (!Number.isSafeInteger(lifetimeMilliseconds) || lifetimeMilliseconds <= 0) throw new TypeError("Authority permit lifetime must be a positive safe integer");
	}
	async issue(invocation, claim) {
		const nonce = this.nonce(invocation, claim);
		const candidate = this.store.transaction((transaction) => {
			const retained = this.store.requested(transaction, nonce);
			if (retained !== void 0) return {
				kind: "ready",
				request: retained
			};
			const createdAt = validTime(this.now(), "Authority permit request time");
			const claimExpiresAt = claim.expiresAt.getTime();
			if (claimExpiresAt <= createdAt) return { kind: "expired" };
			if (claimExpiresAt - createdAt > this.lifetimeMilliseconds) throw new TypeError("Item claim exceeds the authority permit lifetime");
			return {
				kind: "ready",
				request: new TargetAuthorityPermitRequest(this.expectations.forClaim(invocation, claim), this.authority.forClaim(invocation, claim, nonce), nonce, claim.expiresAt, void 0)
			};
		});
		if (candidate.kind !== "ready") return candidate;
		const provisional = candidate.request;
		const attestation = provisional.expectation.lease === void 0 || this.attestation === void 0 ? void 0 : await this.readSourceAttestation(provisional);
		if (attestation === void 0 && provisional.expectation.lease !== void 0 && this.attestation !== void 0) return {
			kind: "invalid",
			reason: "Source Actor did not attest the exact current lease"
		};
		const expiresAt = attestation === void 0 ? provisional.expiresAt : new Date(Math.min(provisional.expiresAt.getTime(), attestation.deadline.getTime()));
		const request = new TargetAuthorityPermitRequest(provisional.expectation, provisional.authority, provisional.nonce, expiresAt, attestation?.reference);
		let persisted;
		try {
			persisted = this.store.transaction((transaction) => {
				const retained = this.store.requested(transaction, nonce);
				if (retained !== void 0) {
					if (!retained.digest().equals(request.digest())) throw denied("Target permit request replay changed its source evidence");
					return retained;
				}
				return this.store.request(transaction, request);
			});
			requireRetainedRequest(persisted, invocation, claim, nonce, this.expectations, this.authority, attestation);
		} catch (error) {
			if (isInvalidIssuanceReply(error)) return {
				kind: "invalid",
				reason: error.message || "Authority permit response is invalid"
			};
			throw error;
		}
		if (validTime(this.now(), "Authority permit request observation time") >= persisted.expiresAt.getTime()) return { kind: "expired" };
		const payload = AuthorityPermitIssuanceRequest.encode(new AuthorityPermitIssuanceRequest(persisted));
		try {
			const replyBytes = await this.transport.issue(payload, nonce);
			const receivedAt = this.now();
			validTime(receivedAt, "Authority permit response time");
			const reply = AuthorityPermitIssuanceReply.decode(replyBytes);
			requireIssuanceEvidence(reply.evidence, persisted, receivedAt);
			if (reply.kind === "denied") return {
				kind: "denied",
				denial: new AuthenticatedAuthorityPermitDenial(denialAuthenticationAuthority, persisted, reply.evidence),
				reason: `Tenant authority denied permit issuance: ${reply.evidence.reason}`
			};
			const permit = reply.requirePermit();
			requireIssuedPermit(permit, persisted, receivedAt);
			return {
				kind: "issued",
				admission: new AuthorityAdmissionReference(permit.toData(), permit.digest())
			};
		} catch (error) {
			if (isInvalidIssuanceReply(error)) return {
				kind: "invalid",
				reason: error.message || "Authority permit response is invalid"
			};
			throw error;
		}
	}
	async readSourceAttestation(request) {
		if (this.attestation === void 0) return void 0;
		return this.attestation.attest(TargetAuthorityPermitRequest.encode(request));
	}
	deny(transaction, invocation, claim, denial) {
		const { request } = denial.record();
		if (!request.expectation.equals(this.expectations.forClaim(invocation, claim))) throw denied("Authenticated authority denial does not bind the retained target request");
		this.denial.deny(transaction, denial);
	}
};
function requireRetainedRequest(request, invocation, claim, nonce, expectations, authority, attestation) {
	const expectedExpiry = attestation === void 0 ? claim.expiresAt.getTime() : Math.min(claim.expiresAt.getTime(), attestation.deadline.getTime());
	if (request.nonce !== nonce || !request.expectation.equals(expectations.forClaim(invocation, claim)) || !request.authority.digest().equals(authority.forClaim(invocation, claim, nonce).digest()) || request.expiresAt.getTime() !== expectedExpiry || request.leaseEvidence === void 0 !== (attestation === void 0)) throw denied("Retained authority permit request does not bind the current claim");
}
function requireIssuanceEvidence(evidence, request, receivedAt) {
	const receivedAtTime = validTime(receivedAt, "Authority permit response time");
	if (!evidence.binds(request.authority) || !evidence.issuer.equals(request.expectation.issuer) || !evidence.issuerTenant.equals(request.expectation.tenant) || evidence.checkedAt.getTime() > receivedAtTime || receivedAtTime >= request.expiresAt.getTime()) throw denied("Authority permit transport substituted the Tenant decision");
}
function requireIssuedPermit(permit, request, receivedAt) {
	const receivedAtTime = validTime(receivedAt, "Authority permit response time");
	if (!permit.expectation.equals(request.expectation) || !permit.requestDigest.equals(request.digest()) || permit.nonce !== request.nonce || permit.expiresAt.getTime() !== request.expiresAt.getTime() || permit.issuedAt.getTime() > receivedAtTime || receivedAtTime >= permit.expiresAt.getTime()) throw denied("Authority permit transport substituted the target request");
}
var TargetAuthorityPermitAuthenticationPort = class {
	authenticator;
	expectations;
	constructor(authenticator, expectations) {
		this.authenticator = authenticator;
		this.expectations = expectations;
	}
	async authenticate(invocation, claim, admission) {
		let permit;
		try {
			permit = AuthorityPermit.fromData(admission.reference);
		} catch {
			throw denied("Authority permit reply is malformed");
		}
		if (!permit.digest().equals(admission.digest)) throw denied("Authority permit reply digest does not match its canonical record");
		return this.authenticator.authenticate(permit, this.expectations.forClaim(invocation, claim));
	}
};
var ConsumedAuthorityAdmissionPort = class {
	admission;
	expectations;
	now;
	constructor(admission, expectations, now) {
		this.admission = admission;
		this.expectations = expectations;
		this.now = now;
	}
	admits(transaction, admission, context, authentication) {
		const expected = this.expectations.forAdmission(transaction, context);
		let permit;
		try {
			permit = AuthorityPermit.fromData(admission.reference);
		} catch {
			return false;
		}
		if (expected === void 0 || authentication === void 0 || !permit.digest().equals(admission.digest)) return false;
		try {
			this.admission.consume(transaction, authentication, permit, expected, this.now());
		} catch (error) {
			if (!(error instanceof AgentCoreError) || error.code !== "authority.denied") throw error;
			return false;
		}
		return true;
	}
};
function isInvalidIssuanceReply(error) {
	return error instanceof AgentCoreError && (error.code === "authority.denied" || error.code === "codec.invalid" || error.code === "protocol.invalid-state");
}
function validTime(value, subject) {
	const time = value.getTime();
	if (!Number.isSafeInteger(time) || time < 0) throw new TypeError(`${subject} is invalid`);
	return time;
}
function denied(message) {
	return new AgentCoreError("authority.denied", message);
}
new TextDecoder("utf-8", { fatal: true });
//#endregion
//#region src/composition/mediation-identity.ts
/**
* Every mediation identifier is a domain-separated digest of the durable evidence that
* already determines it, never a counter or a random value. That is what makes the
* pipeline restartable: a worker that crashes between minting an identifier and
* persisting the record it names recomputes the same identifier from the same evidence,
* so the idempotent claim/attempt/receipt protocol in §7.3–§7.4 converges instead of
* forking a second identity for one item.
*
* Where two records legitimately coexist for one item, the evidence that distinguishes
* them is in the derivation: the attempt ordinal separates retries, the claim worker
* separates a recovered claim from the expired one it replaces (recovery already
* requires a different worker), and the outcome separates a superseded Receipt from the
* indeterminate one it replaces.
*/
var IDENTITY_DOMAIN = Object.freeze({
	invocation: "agent-core.identity.invocation.v1",
	directInvocation: "agent-core.identity.direct-invocation.v1",
	staleDenialInvocation: "agent-core.identity.stale-denial-invocation.v1",
	directItem: "agent-core.identity.direct-item.v1",
	idempotencySeed: "agent-core.identity.idempotency-seed.v1",
	correlation: "agent-core.identity.correlation.v1",
	claim: "agent-core.identity.item-claim.v1",
	attempt: "agent-core.identity.effect-attempt.v1",
	preEffectReceipt: "agent-core.identity.pre-effect-receipt.v1",
	attemptReceipt: "agent-core.identity.attempt-receipt.v1",
	invocationAudit: "agent-core.identity.invocation-audit.v1",
	attemptAudit: "agent-core.identity.attempt-audit.v1",
	receiptAudit: "agent-core.identity.receipt-audit.v1",
	supersessionAudit: "agent-core.identity.supersession-audit.v1"
});
var DerivedMediationIdentities = class {
	scope;
	constructor(scope) {
		this.scope = scope;
		if (scope.length === 0 || scope !== scope.trim()) throw new TypeError("Mediation identity scope must be canonical");
	}
	/**
	* The mediated InvocationId commits exactly the replay reservation identity (§7.3):
	* the same authenticated caller and OperationRequestKey over the same bound intent
	* mint the same Invocation, and any changed bound field mints a different one.
	*/
	invocation(request) {
		return new InvocationId(derive(IDENTITY_DOMAIN.invocation, {
			authorityIdentity: request.replayBinding.authorityIdentity.value,
			descriptor: Digest.sha256(encodeCanonicalJson(request.descriptor.toData())).value,
			execution: {
				digest: request.replayBinding.execution.digest.value,
				kind: request.replayBinding.execution.kind
			},
			facet: request.facet.value,
			packageOperationPin: request.replayBinding.packageOperationPin.value,
			payload: request.inputs.map((input) => Digest.sha256(encodeCanonicalJson(canonicalFacetData(input))).value),
			principal: {
				principal: request.replayBinding.principal.principalId.value,
				tenant: request.replayBinding.principal.tenantId.value
			},
			requestKey: request.requestKey.value,
			scope: this.scope,
			["shape"]: request.cardinality.kind === "single" ? { kind: "single" } : {
				itemCount: request.cardinality.itemCount,
				kind: "batch"
			}
		}));
	}
	/**
	* A direct Invocation creates no durable record (§7.3), but its Operation still runs
	* under an OperationContext that names one. Deriving it from the request key keeps
	* that identity stable across a retried direct dispatch and distinct from every
	* mediated Invocation, which is minted under a different domain.
	*/
	directInvocation(requestKey) {
		return new InvocationId(derive(IDENTITY_DOMAIN.directInvocation, {
			requestKey,
			scope: this.scope
		}));
	}
	/**
	* The Invocation a stale mediated observation denies (§3.4 rule 7, §7.4). It is minted
	* under its own domain because the mediated `invocation` derivation is unreachable
	* here: a stale re-check throws before `replayBinding` exists, so the replay reservation
	* that identity commits to has not been formed yet. What HAS been formed is the exact
	* resolution the caller presented, and every field below is part of what made this
	* intent distinct — so two different stale operations never collide, and the same stale
	* observation retried after a crash recomputes the same Receipt and AuditRecord ids
	* instead of forking a second denial for one refusal.
	*
	* The Binding generation and the resolution's own path epochs are in the evidence
	* deliberately: they are the STALE values the caller presented, not the current ones,
	* which is what makes the identity name this refusal rather than the state that
	* replaced it.
	*/
	staleDenialInvocation(resolution, descriptor, inputs) {
		return new InvocationId(derive(IDENTITY_DOMAIN.staleDenialInvocation, {
			binding: {
				generation: resolution.binding.generation,
				key: resolution.binding.key
			},
			descriptor: Digest.sha256(encodeCanonicalJson(descriptor.toData())).value,
			execution: executionReference(resolution),
			facet: resolution.binding.facet.value,
			owner: {
				id: resolution.owner.id.value,
				kind: resolution.owner.kind
			},
			path: resolution.pathEpochs.path.map((entry) => [scopeKey(entry.scope), entry.epoch]),
			payload: inputs.map((input) => Digest.sha256(encodeCanonicalJson(canonicalFacetData(input))).value),
			principal: {
				principal: resolution.principal.principalId.value,
				tenant: resolution.principal.tenantId.value
			},
			scope: this.scope
		}));
	}
	directItemKey(invocation, itemIndex) {
		return derive(IDENTITY_DOMAIN.directItem, {
			invocation: invocation.value,
			itemIndex
		});
	}
	idempotencySeed(invocation) {
		return derive(IDENTITY_DOMAIN.idempotencySeed, { invocation: invocation.value });
	}
	correlation(invocation) {
		return new CorrelationId(derive(IDENTITY_DOMAIN.correlation, { invocation: invocation.value }));
	}
	claim(invocation, itemIndex, attemptOrdinal, worker) {
		return new ItemClaimId(derive(IDENTITY_DOMAIN.claim, {
			attemptOrdinal,
			invocation: invocation.value,
			itemIndex,
			worker: worker.value
		}));
	}
	attempt(invocation, itemIndex, attemptOrdinal) {
		return new EffectAttemptId(derive(IDENTITY_DOMAIN.attempt, {
			attemptOrdinal,
			invocation: invocation.value,
			itemIndex
		}));
	}
	preEffectReceipt(invocation, itemIndex, outcome) {
		return new ReceiptId(derive(IDENTITY_DOMAIN.preEffectReceipt, {
			invocation: invocation.value,
			itemIndex,
			outcome
		}));
	}
	attemptReceipt(attempt, outcome) {
		return new ReceiptId(derive(IDENTITY_DOMAIN.attemptReceipt, {
			attempt: attempt.value,
			outcome
		}));
	}
	invocationAudit(invocation) {
		return new AuditRecordId(derive(IDENTITY_DOMAIN.invocationAudit, { invocation: invocation.value }));
	}
	attemptAudit(attempt) {
		return new AuditRecordId(derive(IDENTITY_DOMAIN.attemptAudit, { attempt: attempt.value }));
	}
	receiptAudit(receipt) {
		return new AuditRecordId(derive(IDENTITY_DOMAIN.receiptAudit, { receipt: receipt.value }));
	}
	supersessionAudit(previous, next) {
		return new AuditRecordId(derive(IDENTITY_DOMAIN.supersessionAudit, {
			next: next.value,
			previous: previous.value
		}));
	}
};
function derive(domain, evidence) {
	return `${domain}:${Digest.sha256(encodeCanonicalJson({
		domain,
		evidence
	})).value}`;
}
/**
* Which execution a resolution was issued against, as identity evidence. A Turn-leased
* resolution and a route-driven one are different intents even for the same Binding and
* arguments, and a resolution carrying neither is a third case rather than a missing
* field — stating all three keeps the absent one from digesting the same as a Turn whose
* token happened to be omitted.
*/
function executionReference(resolution) {
	if (resolution.lease !== void 0) return {
		epoch: resolution.lease.epoch,
		kind: "turn",
		turn: resolution.lease.turn.value
	};
	if (resolution.route !== void 0) return {
		kind: "route",
		route: resolution.route.value
	};
	return { kind: "none" };
}
//#endregion
//#region src/composition/mediation-execution.ts
/**
* The direct tier's OperationContext (§7.2). A direct Invocation creates no durable
* Invocation, Receipt, or replay record, so it carries no EffectAttempt and no target
* admission — asserting that here is what keeps a direct dispatch from presenting itself
* as mediated evidence. Its Invocation and item identities are derived from the request
* key so a repeated direct dispatch names the same call.
*/
var DerivedDirectOperationContext = class {
	identities;
	resources;
	constructor(identities, resources) {
		this.identities = identities;
		this.resources = resources;
	}
	context(requestKey, itemIndex, cardinality, authorization) {
		requireItemIndex(cardinality, itemIndex);
		const invocation = this.identities.directInvocation(requestKey.value);
		const execution = this.resources(authorization, itemIndex);
		return Object.freeze({
			invocation,
			itemIndex,
			idempotencyKey: this.identities.directItemKey(invocation, itemIndex),
			signal: execution.signal,
			content: execution.content
		});
	}
};
function requireItemIndex(cardinality, itemIndex) {
	const itemCount = cardinality.kind === "single" ? 1 : cardinality.itemCount;
	if (!Number.isSafeInteger(itemIndex) || itemIndex < 0 || itemIndex >= itemCount) throw new TypeError("Operation item index is outside its payload shape");
}
//#endregion
//#region src/composition/mediation-preparation.ts
function leaseReference(token) {
	return Object.freeze({
		turn: token.turn.value,
		tenant: token.holder.tenantId.value,
		principal: token.holder.principalId.value,
		epoch: token.epoch
	});
}
function leaseToken(reference) {
	return Object.freeze({
		turn: new TurnId(reference.turn),
		holder: new PrincipalRef(new TenantId(reference.tenant), new PrincipalId(reference.principal)),
		epoch: reference.epoch
	});
}
function sameLeaseReference(left, right) {
	return left.turn === right.turn && left.tenant === right.tenant && left.principal === right.principal && left.epoch === right.epoch;
}
function domainReference(domain) {
	return Object.freeze({
		kind: domain.kind,
		label: domain.label,
		secretPolicy: domain.secretPolicy
	});
}
function pathEpochReference(evidence) {
	return Object.freeze({ path: Object.freeze(requireArray$1(evidence.toData(), "path")) });
}
var leaseReferenceCodec = structuralCodec((value) => ({
	epoch: value.epoch,
	principal: value.principal,
	tenant: value.tenant,
	turn: value.turn
}), (value) => {
	const object = requireExactObject(value, [
		"epoch",
		"principal",
		"tenant",
		"turn"
	], "Invocation lease reference");
	return Object.freeze({
		turn: requireString$1(object, "turn"),
		tenant: requireString$1(object, "tenant"),
		principal: requireString$1(object, "principal"),
		epoch: requireNonnegativeInteger(object, "epoch")
	});
});
var authorityReferenceCodec = structuralCodec((value) => ({
	binding: value.binding,
	kind: value.kind,
	principal: value.principal,
	tenant: value.tenant
}), (value) => {
	const object = requireExactObject(value, [
		"binding",
		"kind",
		"principal",
		"tenant"
	], "Invocation authority reference");
	const kind = requireString$1(object, "kind");
	if (kind !== "initiator" && kind !== "delegated") throw malformed("Invocation authority kind is invalid");
	return Object.freeze({
		kind,
		tenant: requireString$1(object, "tenant"),
		principal: requireString$1(object, "principal"),
		binding: requireString$1(object, "binding")
	});
});
var domainReferenceCodec = structuralCodec((value) => ({
	kind: value.kind,
	label: value.label,
	secretPolicy: value.secretPolicy
}), (value) => {
	const object = requireExactObject(value, [
		"kind",
		"label",
		"secretPolicy"
	], "Protection domain reference");
	const kind = requireString$1(object, "kind");
	const secretPolicy = requireString$1(object, "secretPolicy");
	if (kind !== "frontend" && kind !== "backend" || secretPolicy !== "no-secrets" && secretPolicy !== "may-hold-secrets") throw malformed("Protection domain kind or secret policy is invalid");
	return Object.freeze({
		kind,
		label: requireString$1(object, "label"),
		secretPolicy
	});
});
var pathEpochReferenceCodec = structuralCodec((value) => PathEpochEvidence.fromData({ path: [...value.path] }).toData(), (value) => pathEpochReference(PathEpochEvidence.fromData(value)));
var mediationPreparedCodecs = Object.freeze({
	lease: leaseReferenceCodec,
	authority: authorityReferenceCodec,
	domain: domainReferenceCodec,
	pathEpochs: pathEpochReferenceCodec
});
function mediationInvocationCodecs(admission) {
	return Object.freeze({
		prepared: new PreparedInvocationCodec(mediationPreparedCodecs),
		approval: ApprovalCodec,
		continuation: new InvocationContinuationCodec(leaseReferenceCodec),
		claim: new ItemClaimCodec(leaseReferenceCodec),
		attempt: new EffectAttemptCodec(leaseReferenceCodec, admission),
		receipt: ReceiptCodec
	});
}
/**
* Freezes the whole effect intent before policy or approval (§7.3), from the authority
* resolution the gateway already produced and the activation pin of the Facet the host
* actually activated.
*
* A routed Invocation is not prepared here. Its InvocationId, authority, projection
* digest, and audit bridge belong to the authenticated RouteReservation, and
* `RoutedInvocationAdmissionPort` has already made that preparation durable; this port
* returns that exact record rather than deriving a second one that could disagree.
*/
var CanonicalMediationPreparation = class {
	identities;
	activations;
	transactions;
	persistence;
	constructor(identities, activations, transactions, persistence) {
		this.identities = identities;
		this.activations = activations;
		this.transactions = transactions;
		this.persistence = persistence;
	}
	prepare(request) {
		const intent = request.request.authorization;
		if (intent.route !== void 0) return this.routed(request);
		if (intent.lease === void 0) throw invalid("Mediated preparation requires an exact lease or a routed reservation");
		const invocation = request.invocation;
		return PreparedInvocation.create({
			id: invocation,
			operation: this.operationPin(request),
			domain: domainReference(intent.domain),
			actor: intent.owner,
			authority: Object.freeze({
				kind: "initiator",
				tenant: intent.principal.tenantId.value,
				principal: intent.principal.principalId.value,
				binding: intent.binding.name.value
			}),
			pathEpochs: pathEpochReference(intent.pathEpochs),
			lease: leaseReference(intent.lease),
			auditCause: this.identities.invocationAudit(invocation),
			idempotencySeed: this.identities.idempotencySeed(invocation)
		}, payload(request), mediationPreparedCodecs);
	}
	routed(request) {
		const existing = this.transactions.transact((transaction) => this.persistence.prepared(transaction, request.invocation));
		if (existing === void 0) throw invalid("Routed mediation requires the RouteReservation's durable PreparedInvocation");
		return existing;
	}
	operationPin(request) {
		const intent = request.request.authorization;
		const facet = request.request.facet;
		const activation = this.activations.pin(facet);
		if (activation === void 0) throw invalid(`Facet ${facet.value} has no activation pin to freeze into the intent`);
		const descriptor = request.request.descriptor;
		return OperationPin.create({
			operation: new OperationRef(`${facetPackage(facet).value}:${descriptor.name.value}`),
			target: facet.value,
			package: new PackageId(intent.packagePin.id.value),
			version: new SemVer(intent.packagePin.version.toString()),
			manifestDigest: intent.packagePin.manifestDigest,
			descriptorDigest: Digest.sha256(encodeCanonicalJson(descriptor.toData())),
			configurationDigest: activation.configurationDigest,
			runtimeDigest: activation.runtimeDigest,
			activationGeneration: activation.activationGeneration,
			registration: activation.registration,
			impact: descriptor.impact,
			approvalRequired: mergePolicySets(intent.policies).requiresApproval(descriptor.impact),
			placement: intent.placement
		});
	}
};
/**
* The ledger's preparation gate for locally prepared Invocations: the audit cause and
* idempotency seed must be the ones this Invocation's own identity derives, and a header
* carrying neither a lease nor a route cannot be prepared at all (§7.3).
*/
var DerivedPreparationAdmission = class {
	identities;
	constructor(identities) {
		this.identities = identities;
	}
	admits(_transaction, invocation) {
		const header = invocation.header;
		if (header.route !== void 0) return header.projectionDigest !== void 0;
		return header.lease !== void 0 && header.auditCause.equals(this.identities.invocationAudit(header.id)) && header.idempotencySeed === this.identities.idempotencySeed(header.id);
	}
};
function payload(request) {
	const [first, ...rest] = request.request.inputs;
	if (first === void 0) throw invalid("A mediated payload must be nonempty");
	if (request.request.cardinality.kind === "single") {
		if (rest.length !== 0) throw invalid("A single mediated payload carries one item");
		return {
			kind: "single",
			item: first
		};
	}
	return {
		kind: "batch",
		items: [first, ...rest]
	};
}
function facetPackage(facet) {
	const separator = facet.value.indexOf(":");
	if (separator <= 0) throw invalid(`Facet reference ${facet.value} names no Package`);
	return new FacetPackageId(facet.value.slice(0, separator));
}
function invalid(message) {
	return new AgentCoreError("invocation.invalid", message);
}
function malformed(message) {
	return new AgentCoreError("codec.invalid", message);
}
//#endregion
//#region src/composition/mediation-records.ts
/**
* The ledger's claim-owner gate: an EffectAttempt may only be admitted for the exact
* ItemClaim that names it, and only under the authority that claim was taken with. An
* executor claim attempts under its own exact lease token; a system claim attempts under
* no token at all, so a system worker cannot borrow an executor's fencing (§5.3, §7.3).
*/
var MediationClaimOwnerAdmission = class {
	admits(_transaction, claim, attempt) {
		return claim.id.equals(attempt.claim) && claim.invocation.equals(attempt.invocation) && claim.itemIndex === attempt.itemIndex && claim.attemptOrdinal === attempt.ordinal && (claim.owner.kind === "executor" ? attempt.token !== void 0 && sameLeaseReference(claim.owner.token, attempt.token) : attempt.token === void 0);
	}
};
/**
* Mints the durable evidence of §7.3–§7.4 — ItemClaims, EffectAttempts, Receipts, and
* the AuditRecords that chain them — for one Actor's mediation pipeline.
*
* The audit chain it produces is the one §7.4 requires and the ledger enforces:
* the Invocation root causes each EffectAttempt record, each attempt record causes its
* Receipt record, and a reconciled Receipt's supersession record is caused by the
* Receipt record it supersedes. A pre-effect denial has no attempt, so its Receipt
* record is caused by the Invocation root directly.
*/
var CanonicalMediationRecords = class {
	identity;
	identities;
	claimLifetimeMilliseconds;
	constructor(identity, identities, claimLifetimeMilliseconds) {
		this.identity = identity;
		this.identities = identities;
		this.claimLifetimeMilliseconds = claimLifetimeMilliseconds;
		if (!Number.isSafeInteger(claimLifetimeMilliseconds) || claimLifetimeMilliseconds <= 0) throw new TypeError("Item claim lifetime must be a positive safe integer");
	}
	invocationAudit(invocation) {
		return this.audit(invocation, invocation.header.auditCause, void 0, {
			kind: "invocation",
			id: invocation.header.id
		});
	}
	claim(invocation, itemIndex, previous, now) {
		const owner = this.owner(invocation);
		const expiresAt = new Date(now.getTime() + this.claimLifetimeMilliseconds);
		if (previous === void 0) return new ItemClaim(this.identities.claim(invocation.header.id, itemIndex, 0, owner.worker), invocation.header.id, itemIndex, 0, owner, expiresAt);
		return previous.recover(this.identities.claim(invocation.header.id, itemIndex, previous.attemptOrdinal, owner.worker), owner, expiresAt, now);
	}
	retryClaim(invocation, previous, now) {
		const owner = this.owner(invocation);
		const attemptOrdinal = previous.ordinal + 1;
		return new ItemClaim(this.identities.claim(invocation.header.id, previous.itemIndex, attemptOrdinal, owner.worker), invocation.header.id, previous.itemIndex, attemptOrdinal, owner, new Date(now.getTime() + this.claimLifetimeMilliseconds));
	}
	attempt(invocation, claim, admission, now) {
		return new EffectAttempt(this.identities.attempt(invocation.header.id, claim.itemIndex, claim.attemptOrdinal), invocation.header.id, claim.itemIndex, claim.attemptOrdinal, claim.id, invocation.header.lease, admission, now, invocation.item(claim.itemIndex).idempotencyKey, invocation.header.auditCause);
	}
	attemptAudit(invocation, attempt) {
		return this.audit(invocation, this.identities.attemptAudit(attempt.id), attempt.auditCause, {
			kind: "attempt",
			id: attempt.id
		});
	}
	/**
	* §7.4 gives the pre-effect variant two outcomes and they are different facts: a denial
	* before the effect and a cancellation before the effect derive different batch outcomes
	* (§7.5) and carry different Receipt ids. Only the admission point knows which one it
	* observed, so it states the outcome instead of leaving this factory to choose one.
	*/
	preEffectReceipt(invocation, claim, outcome, recordedAt, reason) {
		return new PreEffectReceipt(this.identities.preEffectReceipt(invocation.header.id, claim.itemIndex, outcome), invocation.header.id, claim.itemIndex, outcome, recordedAt, reason);
	}
	attemptReceipt(attempt, completion, recordedAt, result) {
		return new AttemptReceipt(this.identities.attemptReceipt(attempt.id, completion.outcome), attempt.id, completion, void 0, recordedAt, result);
	}
	reconciledReceipt(attempt, previous, completion, result, recordedAt) {
		return new AttemptReceipt(this.identities.attemptReceipt(attempt.id, completion.outcome), attempt.id, completion, previous.id, recordedAt, result);
	}
	receiptAudit(invocation, cause, receipt) {
		return this.audit(invocation, this.identities.receiptAudit(receipt.id), cause?.id ?? invocation.header.auditCause, {
			kind: "receipt",
			id: receipt.id,
			outcome: receipt.outcome
		});
	}
	receiptSupersessionAudit(invocation, previousAudit, previous, next) {
		return this.audit(invocation, this.identities.supersessionAudit(previous.id, next.id), previousAudit.id, {
			kind: "receiptSuperseded",
			previous: previous.id,
			next: next.id
		});
	}
	owner(invocation) {
		const lease = invocation.header.lease;
		return lease === void 0 ? {
			kind: "system",
			actor: invocation.header.actor,
			worker: this.identity.worker
		} : {
			kind: "executor",
			token: lease,
			worker: this.identity.worker
		};
	}
	audit(invocation, id, cause, kind) {
		if (!invocation.header.actor.equals(this.identity.actor)) throw new AgentCoreError("invocation.invalid", "Mediation records belong to the Actor that owns the Invocation");
		const audit = {
			id,
			actor: this.identity.actor,
			tenant: this.identity.tenant,
			correlation: this.identities.correlation(invocation.header.id),
			kind
		};
		return new AuditRecord(cause === void 0 ? audit : {
			...audit,
			cause
		});
	}
};
//#endregion
//#region src/composition/mediation.ts
/**
* The composition root for SPEC §7 mediation.
*
* A consumer supplies the substrate — transactions, invocation and evidence persistence,
* the authority state it resolves Bindings against, the activated Facet runtime, the
* authority permit plane, and its target admission policy — and receives a
* `TurnInvocationPort` it can hand straight to `TurnExecutorHost`, plus the publication
* outbox that carries Receipt observations onward.
*
* It deliberately exposes none of its parts. `OperationGatewayHost` and
* `FacetRuntimeHost` stay unexported because a consumer able to build a gateway by hand
* is equally able to assemble one whose tiering, interception, replay, or evidence
* wiring differs from the pipeline §7 describes, and nothing downstream would notice.
* One narrow constructor keeps that assembly in a single place and still leaves every
* genuine substrate decision with the consumer.
*
* The gateway and the invocation stack above it are built per Turn, because the Turn is
* what owns the cancellation signal an Operation runs under. Nothing durable is
* per-Turn: persistence, the ledger's ports, replay, and evidence are all shared, and
* the only per-instance state is in-flight item deduplication, which is per Invocation
* and therefore already per Turn — a mediated InvocationId commits the lease execution
* identity, so two Turns never name the same one.
*
* Detached execution is the one part that is deliberately not per Turn (SPEC §5.6). An item
* whose admission identity a Turn published outlives that Turn, so the target, the delivery
* seam, and the driver are built once for the process and carry no Turn's signal: cancelling
* such an item is the owning Run's message, never the issuing Turn's fence. Admission stays
* per Turn, because the Turn's own cancellation is exactly what decides which side of the
* §5.6 commit point an item falls on.
*/
var MediatedOperationPipeline = class MediatedOperationPipeline {
	invocations;
	outbox;
	#facets;
	#gateways;
	#reserved;
	#admissions;
	#deliveries;
	#detached;
	/**
	* Activates the pinned Facet runtime and assembles the pipeline around it. Activation
	* is the pipeline's because the gateway resolves Bindings against exactly the Facets
	* that correspondence validation admitted, and a half-activated runtime must never
	* become a mediation surface.
	*/
	static async activate(init) {
		const facets = new FacetRuntimeHost(init.manifests, init.roots);
		try {
			await facets.activate();
		} catch (error) {
			await facets.dispose();
			throw error;
		}
		return new MediatedOperationPipeline(init, facets);
	}
	constructor(init, facets) {
		this.#facets = facets;
		const identities = new DerivedMediationIdentities(init.scope);
		const ledger = new InvocationLedger(init.persistence, leaseReferenceCodec, new DerivedPreparationAdmission(identities), new FiniteInvocationTime(), new MediationClaimOwnerAdmission(), init.admission);
		const records = new CanonicalMediationRecords({
			actor: init.actor,
			tenant: init.tenant,
			worker: init.worker
		}, identities, init.claimLifetimeMilliseconds);
		this.outbox = new InvocationPublicationDrainer(init.transactions, init.evidence, init.events, init.commits, init.now);
		this.#admissions = new TurnAdmissionVerifier(new StoredAdmissionRecords(init.transactions, init.persistence, init.content));
		this.#reserved = new ReservedInvocations(init.scope, init.transactions, init.evidence);
		this.#gateways = new ComposedTurnGatewaySource(facets, new TenantOperationAuthority(init.authority, init.now), (signal) => scopedMediation(init, identities, ledger, records, facets, signal));
		this.invocations = new GatewayTurnInvocationPort(this.#gateways, this.#admissions);
		const executor = canonicalBatch(init, identities, ledger, records, facets, new AbortController().signal);
		this.#deliveries = new DetachedEffectDeliveryPort(init.transactions, init.persistence, init.detachedExecutions, ledger, records, init.evidence, new DetachedMediationTarget(facets, init.transactions, init.persistence, init.content), executor, init.now);
		this.#detached = new AlarmDetachedEffectDriver(this.#deliveries, new StoredDetachedEffectExecutions(init.transactions, init.persistence, init.detachedExecutions, ledger), init.detachedSchedule, init.detachedIntervalMilliseconds, init.now);
	}
	/**
	* Admits one item of a Turn's mediated call and detaches its execution (SPEC §5.6).
	*
	* It is the same call `invoke` makes — the same gateway under the same Turn scope, the
	* same bound Operation check, the same authority, tiering and interception — stopped one
	* step earlier: the Invocation plane records the item's admission and runs nothing. That
	* is the fact §5.6's handle names and the fact a Receipt cannot state, which is why the
	* handle comes back from the admitted item rather than from Receipt evidence.
	*
	* An item refused before its effect answers with the pre-effect Receipt instead. Nothing
	* was detached in that case, so there is no handle to publish and no obligation for the
	* Run to take on.
	*/
	async admitDetached(request) {
		const scoped = this.#gateways.host(Object.freeze({
			turn: request.turn,
			token: request.token,
			signal: request.signal
		}));
		const dispatch = {
			requestKey: request.requestKey,
			operation: request.operation.descriptor.name,
			payload: {
				kind: "single",
				input: canonicalFacetData(request.input)
			}
		};
		const admission = await scoped.gateway.admitDetached(request.operation.binding, dispatch, SOLE_ITEM_INDEX, new BoundOperationAdmission(this.#facets, request.operation, scoped.batch, this.#reserved));
		if (admission.kind === "terminal") return Object.freeze({
			kind: "terminal",
			receipt: admission.receipt
		});
		return Object.freeze({
			kind: "admitted",
			handle: this.#admissions.admit({
				run: request.turn.run,
				turn: request.turn.id,
				token: request.token
			}, admission.item)
		});
	}
	/**
	* Accepts one durable message the Run owes this Invocation owner about a published item
	* (SPEC §5.6, §6.1).
	*
	* The Run's record carries the Run and the cause; neither crosses this seam. The Run is
	* the sender and says nothing about local state, and the cause is a request rather than a
	* verdict — so what travels is the exact item the message names, and this host re-reads
	* its own PreparedInvocation, item key, EffectAttempt and Receipt before it does anything.
	* A message naming state this host does not have raises `invocation.invalid`, which is the
	* signal to leave the Run's copy unacknowledged and redeliver.
	*/
	async accept(delivery) {
		if (delivery.cause.kind === "admission") {
			if (this.#deliveries.release(delivery.invocation, delivery.itemIndex, delivery.itemKey, delivery.attempt).executable) this.#detached.arm();
			return;
		}
		await this.#deliveries.cancel(delivery.invocation, delivery.itemIndex, delivery.itemKey, delivery.attempt);
	}
	/**
	* Resumes detached execution from durable state, and reports when the next sweep is due.
	*
	* The HOST process owns restart. This pipeline holds no schedule of its own and revives
	* nothing on its own behalf: a host that has just started calls this once, and released
	* items whose sweep was lost to the restart are armed again from the records alone.
	*
	* The per-attempt AbortControllers are deliberately lost with the process. They are live
	* resources, and §8.3 keeps live resources off durable records, so there is nothing to
	* restore and nothing that pretends to be restored. That is exactly why a cancellation
	* arriving after a restart reports `absent`: no live effect was reached, so §7.4 leaves
	* the attempt `indeterminate` for reconciliation instead of recording an `aborted` failure
	* nobody observed.
	*/
	resumeDetachedEffects() {
		return this.#detached.repair();
	}
	/**
	* One detached-effect alarm firing. The host owns the alarm — this pipeline holds no timer
	* — so a firing arrives here, executes the items the records say are released and
	* unfinished, and leaves the schedule armed exactly while any remain.
	*/
	sweepDetachedEffects() {
		return this.#detached.sweep();
	}
	dispose() {
		return this.#facets.dispose();
	}
	async [Symbol.asyncDispose]() {
		await this.dispose();
	}
};
/** A Turn dispatches one item, so the detached branch always names the first and only one. */
var SOLE_ITEM_INDEX = 0;
function scopedMediation(init, identities, ledger, records, facets, signal) {
	const direct = {
		signal,
		content: init.content
	};
	const batch = canonicalBatch(init, identities, ledger, records, facets, signal);
	return Object.freeze({
		batch,
		operations: new ReplayOperationInvocationPort(init.scope, init.transactions, init.evidence, identities, new DerivedDirectOperationContext(identities, () => direct), batch)
	});
}
function canonicalBatch(init, identities, ledger, records, facets, signal) {
	/**
	* §7.4's `domainLost` is read off the domain hosting the target, so the witness is the
	* Facet runtime host's own hosting of that exact Facet — a disposed or replaced runtime
	* stops answering for it. The pipeline's scope signal is deliberately not used here: it
	* is the same signal `aborted` reads, and one signal cannot say which boundary closed.
	*/
	const attemptResources = (request) => Object.freeze({
		signal,
		content: init.content,
		deadline: void 0,
		target: Object.freeze({ answering: () => facets.facet(request.request.facet) !== void 0 })
	});
	return new CanonicalBatchInvocationPort(init.transactions, init.persistence, init.detachedExecutions, ledger, new CanonicalMediationPreparation(identities, init.activations, init.transactions, init.persistence), init.permits, init.authentication, records, new CancellationAwareFinalAdmission(init.finalAdmission, signal), init.evidence, { resources: attemptResources }, init.now);
}
var ComposedTurnGatewaySource = class extends TurnGatewaySource {
	facets;
	authority;
	mediation;
	constructor(facets, authority, mediation) {
		super();
		this.facets = facets;
		this.authority = authority;
		this.mediation = mediation;
	}
	async open(scope) {
		return this.host(scope).gateway;
	}
	/**
	* The same gateway `open` widens to the Turn contract, plus the batch port that Turn's
	* items commit through. The detached entry needs both: the concrete host, because
	* `OperationGateway` cannot name this pipeline's authorization type, and the exact batch
	* port whose final admission is gated on this Turn's own cancellation signal.
	*/
	host(scope) {
		const mediation = this.mediation(scope.signal);
		return Object.freeze({
			gateway: new OperationGatewayHost(Object.freeze({ token: scope.token }), this.facets, this.authority, mediation.operations),
			batch: mediation.batch
		});
	}
};
/**
* The Turn seam's detached admission (SPEC §5.6).
*
* The gateway has already resolved the Binding, chosen the tier, run the interceptors, and
* reserved the replay identity by the time this is called, so the request it presents carries
* the resolved Facet and the descriptor that Facet actually declares. Checking those against
* the Turn's bound Operation here is the same check `GatewayTurnInvocationPort` makes before a
* dispatch, made from the one resolution rather than from a second one: a Binding that now
* resolves elsewhere, or an Operation whose declared shape has moved, refuses before the item
* is admitted rather than detaching work under an intent the Turn never bound.
*/
var BoundOperationAdmission = class {
	facets;
	bound;
	batch;
	reserved;
	constructor(facets, bound, batch, reserved) {
		this.facets = facets;
		this.bound = bound;
		this.batch = batch;
		this.reserved = reserved;
	}
	admitDetached(request, itemIndex) {
		const runtime = this.facets.facet(request.facet);
		if (runtime === void 0 || !request.facet.equals(this.bound.facet) || !runtime.manifest.id.equals(this.bound.operation.facet) || !Digest.sha256(encodeCanonicalJson(request.descriptor.toData())).equals(Digest.sha256(encodeCanonicalJson(this.bound.descriptor.toData())))) throw new AgentCoreError("binding.invalid", "Resolved operation does not match the exact bound Turn Operation");
		return this.batch.admitDetachedItem(Object.freeze({
			invocation: this.reserved.invocation(request.requestKey),
			request
		}), itemIndex);
	}
};
/**
* The InvocationId the mediated preflight already reserved for one request key (§7.3). A
* detached admission mints nothing of its own: the reservation is what the replay plane
* committed one step earlier, and an admission that cannot find it names a request key this
* pipeline never prepared.
*/
var ReservedInvocations = class {
	scope;
	transactions;
	replays;
	constructor(scope, transactions, replays) {
		this.scope = scope;
		this.transactions = transactions;
		this.replays = replays;
	}
	invocation(requestKey) {
		const replay = this.transactions.transact((transaction) => this.replays.replay(transaction, this.scope, requestKey.value));
		if (replay?.invocation === void 0) throw new AgentCoreError("invocation.invalid", "A detached admission has no reserved prepared replay identity");
		return replay.invocation;
	}
};
/**
* The released detached items this host still owes a Receipt (SPEC §5.6).
*
* "Released and unfinished" is one predicate over two owners: the released half is the
* detachment record's state, and the unfinished half is the item's current Receipt, which §7.4
* owns and §8.4 keeps in exactly one place. A released record therefore outlives its item's
* Receipt, so a fixed window of records can be entirely finished work with unfinished work
* behind it. The window widens until it either fills the caller's limit or has seen every
* released record, which is what keeps a sweep from clearing its own schedule while work
* remains.
*/
var StoredDetachedEffectExecutions = class {
	transactions;
	persistence;
	detachedExecutions;
	ledger;
	constructor(transactions, persistence, detachedExecutions, ledger) {
		this.transactions = transactions;
		this.persistence = persistence;
		this.detachedExecutions = detachedExecutions;
		this.ledger = ledger;
	}
	released(limit) {
		return this.transactions.transact((transaction) => {
			let window = limit;
			for (;;) {
				const records = this.detachedExecutions.releasedDetachedExecutions(transaction, window);
				const items = records.flatMap((record) => this.unfinished(transaction, record.invocation, record.itemIndex, record.attempt));
				if (items.length >= limit || records.length < window) return Object.freeze(items.slice(0, limit));
				window *= 2;
			}
		});
	}
	/**
	* The admitted item one released record names, and nothing where the item has finished or
	* where the records it is derived from are gone. A missing PreparedInvocation or
	* EffectAttempt is not this query's error to raise: the sweep would then stall on one
	* unreadable row instead of executing the work behind it, and reconciliation is what
	* answers for an attempt whose records cannot be read.
	*/
	unfinished(transaction, invocation, itemIndex, attempt) {
		if (this.ledger.currentReceipt(transaction, invocation, itemIndex) !== void 0) return [];
		const prepared = this.persistence.prepared(transaction, invocation);
		const stage = this.persistence.attempt(transaction, attempt);
		if (prepared === void 0 || stage === void 0) return [];
		return [AdmittedInvocationItem.derive(prepared, stage)];
	}
};
/**
* Puts cancellation at the one synchronous boundary that either records an EffectAttempt or
* refuses it (SPEC §5.6, §7.4).
*
* Admission is the commit point a §5.6 handle names, so the two sides of it answer different
* questions: a Turn or Run lost before it leaves a `cancelledPreEffect` Receipt over an item
* with no attempt, and nothing is detached; the same fact after it reaches the attempt instead,
* where §7.4 names it `aborted`. Checking the signal here rather than earlier is what makes the
* boundary exact — no permit, consent decision, or handler between this check and the attempt
* append can turn a cancelled item into an admitted one.
*/
var CancellationAwareFinalAdmission = class {
	delegate;
	signal;
	constructor(delegate, signal) {
		this.delegate = delegate;
		this.signal = signal;
	}
	admit(transaction, request, context) {
		if (this.signal.aborted) return {
			kind: "cancelled",
			reason: "The owning Turn or Run was cancelled before effect admission"
		};
		return this.delegate.admit(transaction, request, context);
	}
};
/**
* Projects the §7.4 records a §5.6 admission handle is built from. It decides nothing: it
* reports what the stored Receipt and its EffectAttempt say and resolves the result content,
* and `TurnAdmissionVerifier` owns every rule about whether that evidence admits a handle.
*
* The three shapes it returns are the three questions the records answer, all read from data
* this one transaction already holds: a pre-effect Receipt carries its own outcome and reason
* and reached no attempt at all; an attempt Receipt that did not succeed carries its outcome
* and, since `invocation.receipt` major 2, its failure kind; only a succeeded one carries
* result content. Failure detail rides the non-admitting shapes as a refusal message and is
* unreachable from what the verifier admits, so no admission decision can come to read
* Receipt failure state (C13-RECEIPT-FAILURE-ORTHOGONAL).
*/
var StoredAdmissionRecords = class extends TurnAdmissionRecordPort {
	transactions;
	persistence;
	content;
	constructor(transactions, persistence, content) {
		super();
		this.transactions = transactions;
		this.persistence = persistence;
		this.content = content;
	}
	async receipt(receipt) {
		return this.transactions.transact((transaction) => {
			const stored = this.persistence.receipt(transaction, receipt);
			if (stored === void 0) return void 0;
			if (!(stored instanceof AttemptReceipt)) return TurnAdmissionReceiptFacts.preEffect(stored.outcome);
			const stage = this.persistence.attempt(transaction, stored.attempt);
			if (stage === void 0) return TurnAdmissionReceiptFacts.preEffect(`Receipt names EffectAttempt ${stored.attempt.value}, which is not stored`);
			const attempt = Object.freeze({
				id: stage.id,
				invocation: stage.invocation,
				itemIndex: stage.itemIndex,
				idempotencyKey: stage.idempotencyKey
			});
			if (stored.outcome !== "succeeded" || stored.result === void 0) return TurnAdmissionReceiptFacts.unsucceeded(attempt, stored.outcome);
			return TurnAdmissionReceiptFacts.succeeded(attempt, stored.result);
		});
	}
	result(ref) {
		return this.content.get(ref);
	}
};
/**
* The ledger admits only valid instants. Nothing in §7 constrains mediation time beyond
* that; a substrate with a narrower admissible window supplies its own port.
*/
var FiniteInvocationTime = class {
	admits(_transaction, time) {
		return Number.isFinite(time.getTime());
	}
};
//#endregion
//#region src/composition/permit-mediation.ts
/** One target Actor's transaction-bound mediation and distributed-permit state. */
var TargetPermitMediationAggregate = class {};
/** The production assembly that prevents independently wired target permit stores. */
async function activateTargetPermitMediation(init) {
	const target = init.aggregate;
	const denial = new TargetAuthorityPermitDenialPort(target.tenant, target.actor, target.permitDenials, target);
	const permits = new IssuedAuthorityPermitPort(target.permitRequests, init.expectations, denial, init.authorityRequests, init.issuanceTransport, init.permitNonce, init.now, init.permitLifetimeMilliseconds, init.sourceAttestation);
	const authentication = new TargetAuthorityPermitAuthenticationPort(init.authenticator, init.expectations);
	const admission = new ConsumedAuthorityAdmissionPort(new StoredAuthorityPermitAdmissionPort(target.permitAdmission), init.expectations, init.now);
	return MediatedOperationPipeline.activate({
		...init,
		actor: target.actor,
		tenant: target.tenant,
		transactions: target,
		persistence: target.persistence,
		evidence: target.evidence,
		permits,
		authentication,
		admission
	});
}
//#endregion
export { ResolutionStamp as C, MediatedAuthorityIntent as S, DELETABLE_WORKSPACE_RECORD_KINDS as _, leaseToken as a, validateWorkspacePointerAdvance as b, sameLeaseReference as c, StoredProjectedTargetLeaseEvidence as d, TargetAuthorityPermitAuthenticationPort as f, authorityPermitReferenceCodec as g, TargetLeaseEvidenceTransport as h, leaseReference as i, AuthorityPermitIssuanceTransport as l, TargetLeaseEvidenceProjectionTransport as m, activateTargetPermitMediation as n, mediationInvocationCodecs as o, TargetAuthorityPermitDenialPort as p, MediatedOperationPipeline as r, mediationPreparedCodecs as s, TargetPermitMediationAggregate as t, IssuedAuthorityPermitPort as u, WORKSPACE_RECORD_KINDS as v, ResolvedOperationAuthority as w, validateWorkspaceUnique as x, validateStoredWorkspaceRecord as y };

//# sourceMappingURL=composition-CxmTB6HT.js.map