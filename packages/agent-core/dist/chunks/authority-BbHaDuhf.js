import { C as canonicalJsonEqual, D as encodeCanonicalJson, O as frozenCanonicalJson, R as jsonDataParser, T as compareCanonicalText, b as decodeBase64, f as RecordCodec, g as Revision, h as SecretRef, i as SemVer, j as TextId, k as AgentCoreError, o as isMember, s as isNonempty, w as canonicalTupleKey, x as encodeBase64, y as Digest } from "./core-BjYGo1CC.js";
import { d as ActorRef, f as ActorId } from "./actors-DJsP1nFM.js";
import { F as PackagePin, I as PackageId, J as CapabilitySpec, Y as isCapabilityEffect, at as FacetPackageId, ct as OperationName, lt as OperationRef, nt as BindingName, ot as FacetRef, s as ProtectionDomain } from "./runtime-z1yMP0an.js";
import { c as ItemClaimId, i as TurnId, o as ClaimWorkerId, r as RunId } from "./facets-D01bKQBL.js";
import { A as Tenant, B as WorkspaceId, C as PrincipalRef, E as encodeScopeRef, F as ProjectId, N as MembershipId, O as Project, P as PrincipalId, R as TeamId, S as requireSubjectTenant, T as decodeScopeRef, a as ShareOffer, b as decodeSubjectRef, d as BUILT_IN_ROLES, h as Role, i as GuestTrust, j as Principal, k as Team, n as MemoryIdentityRepository, p as OWNER_ROLE, r as Workspace, u as Membership, v as GuestVerificationScheme, w as ScopeRef, x as encodeSubjectRef, y as SubjectRef, z as TenantId } from "./identity-CoqhjOFj.js";
import { K as TargetLeaseEvidenceRecord } from "./runs-CRnZ9IFu.js";
import { i as InvocationId } from "./interaction-references-D9spp037.js";
import { st as POLICY_IMPACTS } from "./definition-COokGikL.js";
//#region src/authority/data.ts
var parse = jsonDataParser((message) => new TypeError(message));
function requireObject(value, name) {
	return parse.object(value, name);
}
function requireExact(object, keys, name) {
	parse.exact(object, keys, name);
}
function requireString(object, key, name = key) {
	return parse.string(object[key], name);
}
function requireBoolean(object, key, name = key) {
	return parse.boolean(object[key], name);
}
function requireSafeInteger(object, key, name = key) {
	return parse.safeInteger(object[key], name);
}
function requireArray(value, name) {
	return parse.array(value, name);
}
function canonicalJson(value) {
	return frozenCanonicalJson(value);
}
function bytesEqual(left, right) {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
//#endregion
//#region src/authority/id.ts
var GrantId = class GrantId extends TextId {
	constructor(value) {
		super(value, "Grant ID");
		Object.freeze(this);
	}
	static forRole(membership, ruleOrdinal) {
		validateRoleRuleOrdinal(ruleOrdinal);
		const membershipId = validateIdentityIdValue(membership, "Membership ID");
		return new GrantId(`role:${Digest.sha256(encodeCanonicalJson({
			membership: membershipId,
			ruleOrdinal
		})).value}`);
	}
};
function validateRoleRuleOrdinal(ruleOrdinal) {
	if (!Number.isSafeInteger(ruleOrdinal) || ruleOrdinal < 0) throw new TypeError("Role rule ordinal must be a non-negative safe integer");
}
/** The longest an identity identifier may be; see `MAX_TEXT_VALUE_LENGTH` in core. */
var MAX_IDENTITY_ID_LENGTH = 256;
function validateIdentityIdValue(value, name) {
	const result = isIdentityIdText(value) ? value : value.value;
	if (result.length === 0 || result.length > MAX_IDENTITY_ID_LENGTH) throw new TypeError(`${name} must contain between 1 and ${MAX_IDENTITY_ID_LENGTH} characters`);
	return result;
}
function isIdentityIdText(value) {
	return typeof value === "string";
}
//#endregion
//#region src/authority/key.ts
function authorityKey(kind, components) {
	return canonicalTupleKey("agent-core.authority-key.v1", [kind, ...components]);
}
//#endregion
//#region src/authority/reference.ts
function scopeKey(scope) {
	return authorityKey("scope", [encodeScopeRef(scope)]);
}
function subjectKey(subject) {
	return authorityKey("subject", [encodeSubjectRef(subject)]);
}
function encodeAuthorityScope(scope) {
	return encodeScopeRef(scope);
}
function decodeAuthorityScope(value) {
	return decodeScopeRef(value);
}
function encodeAuthoritySubject(subject) {
	return encodeSubjectRef(subject);
}
function decodeAuthoritySubject(value) {
	return decodeSubjectRef(value);
}
//#endregion
//#region src/authority/binding.ts
var BindingCredentialCustody = class BindingCredentialCustody {
	secret;
	endpoint;
	constructor(secret, endpoint) {
		if (secret.constructor !== SecretRef) throw new TypeError("Binding credential custody requires an exact SecretRef");
		this.secret = new SecretRef(secret.source, secret.provider, secret.id);
		this.endpoint = requireCanonicalEndpoint(endpoint);
		Object.freeze(this);
	}
	matches(secret, endpoint) {
		return this.secret.equals(secret) && this.endpoint === endpoint;
	}
	toData() {
		return {
			endpoint: this.endpoint,
			secret: {
				id: this.secret.id,
				provider: this.secret.provider,
				source: this.secret.source
			}
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Binding credential custody");
		requireExact(object, ["endpoint", "secret"], "Binding credential custody");
		const secret = requireObject(object["secret"], "Binding credential SecretRef");
		requireExact(secret, [
			"id",
			"provider",
			"source"
		], "Binding credential SecretRef");
		return new BindingCredentialCustody(new SecretRef(requireString(secret, "source", "SecretRef source"), requireString(secret, "provider", "SecretRef provider"), requireString(secret, "id", "SecretRef ID")), requireString(object, "endpoint", "Binding credential endpoint"));
	}
};
var BindingLifecycle = class {
	static from(state) {
		return state === "active" ? activeBinding : inactiveBinding;
	}
};
var ActiveBindingLifecycle = class extends BindingLifecycle {
	name = "active";
	activate() {
		return this;
	}
	deactivate() {
		return inactiveBinding;
	}
};
var InactiveBindingLifecycle = class extends BindingLifecycle {
	name = "inactive";
	activate() {
		return activeBinding;
	}
	deactivate() {
		return this;
	}
};
var activeBinding = Object.freeze(new ActiveBindingLifecycle());
var inactiveBinding = Object.freeze(new InactiveBindingLifecycle());
var BindingCodec = class extends RecordCodec {
	constructor() {
		super([
			Binding,
			BindingCredentialCustody,
			BindingLifecycle,
			GuestVerificationScheme,
			Revision,
			ScopeRef,
			TextId,
			FacetRef,
			SecretRef,
			BindingName,
			TeamId,
			TenantId,
			WorkspaceId,
			GrantId,
			ProjectId,
			PrincipalId,
			FacetPackageId,
			ProtectionDomain,
			PrincipalRef
		], "authority.binding", {
			major: 3,
			minor: 0
		});
	}
	encodePayload(record) {
		return record.toData();
	}
	decodePayload(payload) {
		return Binding.fromData(payload);
	}
};
var Binding = class Binding {
	scope;
	name;
	grantId;
	facet;
	generation;
	revision;
	static get codec() {
		return bindingCodecInstance;
	}
	domain;
	subject;
	credentialCustody;
	#lifecycle;
	constructor(scope, subject, domain, name, grantId, facet, generation, state, revision, credentialCustody = []) {
		this.scope = scope;
		this.name = name;
		this.grantId = grantId;
		this.facet = facet;
		this.generation = generation;
		this.revision = revision;
		if (scope.kind !== "workspace") throw new TypeError("Bindings require a Workspace Scope");
		if (!Number.isSafeInteger(generation) || generation < 0) throw new TypeError("Binding generation must be a non-negative safe integer");
		this.#lifecycle = BindingLifecycle.from(requireBindingState(state));
		requireSubjectTenant(subject, scope.tenantId, "Binding");
		this.subject = decodeAuthoritySubject(encodeAuthoritySubject(subject));
		this.domain = immutableDomain(domain);
		this.credentialCustody = canonicalCredentialCustody(credentialCustody, scope);
		Object.freeze(this);
	}
	static active(scope, subject, domain, name, grantId, facet, credentialCustody = []) {
		return new Binding(scope, subject, domain, name, grantId, facet, 0, "active", Revision.initial(), credentialCustody);
	}
	static encode(record) {
		return Binding.codec.encode(record);
	}
	static decode(bytes) {
		return Binding.codec.decode(bytes);
	}
	/**
	* Binding identity is exactly its addressing coordinates, so a caller holding those
	* can look one up without first fabricating a record around a Grant and Facet it
	* does not yet know.
	*/
	static keyFor(scope, subject, domain, name) {
		return authorityKey("binding", [
			encodeAuthorityScope(scope),
			encodeAuthoritySubject(subject),
			encodeDomain(domain),
			name.value
		]);
	}
	get key() {
		return Binding.keyFor(this.scope, this.subject, this.domain, this.name);
	}
	get resolves() {
		return this.state === "active";
	}
	get state() {
		return this.#lifecycle.name;
	}
	replace(grantId, facet, credentialCustody = this.credentialCustody) {
		return this.transition(this.#lifecycle.activate(), grantId, facet, credentialCustody);
	}
	deactivate() {
		const next = this.#lifecycle.deactivate();
		return next === this.#lifecycle ? this : this.transition(next, this.grantId, this.facet, this.credentialCustody);
	}
	hasCredentialCustody(secret, endpoint) {
		return this.credentialCustody.some((custody) => custody.matches(secret, endpoint));
	}
	assertCanReplace(next) {
		if (this.key !== next.key || scopeKey(this.scope) !== scopeKey(next.scope) || subjectKey(this.subject) !== subjectKey(next.subject) || next.generation !== this.generation + 1 || next.revision.value !== this.revision.value + 1) throw new AgentCoreError("binding.invalid", "Binding updates require immutable identity and the next generation and revision");
	}
	toData() {
		return {
			credentialCustody: this.credentialCustody.map((custody) => custody.toData()),
			domain: encodeDomain(this.domain),
			facet: this.facet.value,
			generation: this.generation,
			grantId: this.grantId.value,
			name: this.name.value,
			revision: this.revision.value,
			scope: encodeAuthorityScope(this.scope),
			state: this.state,
			subject: encodeAuthoritySubject(this.subject)
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Binding");
		requireExact(object, [
			"domain",
			"credentialCustody",
			"facet",
			"generation",
			"grantId",
			"name",
			"revision",
			"scope",
			"state",
			"subject"
		], "Binding");
		return new Binding(decodeAuthorityScope(object["scope"]), decodeAuthoritySubject(object["subject"]), decodeDomain(object["domain"]), new BindingName(requireString(object, "name", "Binding name")), new GrantId(requireString(object, "grantId", "Grant ID")), new FacetRef(requireString(object, "facet", "Facet reference")), requireSafeInteger(object, "generation", "Binding generation"), requireBindingState(object["state"]), new Revision(requireSafeInteger(object, "revision", "Binding revision")), requireArray(object["credentialCustody"], "Binding credential custody").map(BindingCredentialCustody.fromData));
	}
	transition(state, grantId, facet, credentialCustody) {
		if (this.generation === Number.MAX_SAFE_INTEGER || this.revision.value === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("binding.invalid", "Binding generation is exhausted");
		return new Binding(this.scope, this.subject, this.domain, this.name, grantId, facet, this.generation + 1, state.name, this.revision.next(), credentialCustody);
	}
};
var bindingCodecInstance = new BindingCodec();
function canonicalCredentialCustody(values, scope) {
	const canonical = values.map((value) => {
		if (value.constructor !== BindingCredentialCustody) throw new TypeError("Binding credential custody requires exact BindingCredentialCustody values");
		if (value.secret.source !== scope.tenantId.value) throw new TypeError("Binding credential source must equal its canonical Tenant ID");
		return new BindingCredentialCustody(value.secret, value.endpoint);
	});
	canonical.sort(compareCredentialCustody);
	let previous;
	for (const value of canonical) {
		if (previous !== void 0 && compareCredentialCustody(previous, value) === 0) throw new TypeError("Binding credential custody facts must be unique");
		previous = value;
	}
	return Object.freeze(canonical);
}
function compareCredentialCustody(left, right) {
	for (const [leftPart, rightPart] of [
		[left.secret.source, right.secret.source],
		[left.secret.provider, right.secret.provider],
		[left.secret.id, right.secret.id],
		[left.endpoint, right.endpoint]
	]) {
		if (leftPart < rightPart) return -1;
		if (leftPart > rightPart) return 1;
	}
	return 0;
}
function requireCanonicalEndpoint(value) {
	let endpoint;
	try {
		endpoint = new URL(value);
	} catch {
		throw new TypeError("Binding credential endpoint must be a canonical absolute URL");
	}
	if (endpoint.href !== value || endpoint.username.length > 0 || endpoint.password.length > 0) throw new TypeError("Binding credential endpoint must be a canonical absolute URL");
	return value;
}
function encodeDomain(domain) {
	return {
		kind: domain.kind,
		label: domain.label,
		secretPolicy: domain.secretPolicy
	};
}
function domainKey(domain) {
	return authorityKey("domain", [encodeDomain(domain)]);
}
function immutableDomain(domain) {
	return Object.freeze(new ProtectionDomain(domain.kind, domain.label, domain.secretPolicy));
}
function decodeDomain(value) {
	const object = requireObject(value, "Protection domain");
	requireExact(object, [
		"kind",
		"label",
		"secretPolicy"
	], "Protection domain");
	const kind = object["kind"];
	const secretPolicy = object["secretPolicy"];
	if (kind !== "frontend" && kind !== "backend") throw new TypeError("Protection domain kind is invalid");
	if (secretPolicy !== "no-secrets" && secretPolicy !== "may-hold-secrets") throw new TypeError("Protection domain secret policy is invalid");
	return new ProtectionDomain(kind, requireString(object, "label", "Protection domain label"), secretPolicy);
}
function requireBindingState(value) {
	if (value === "active" || value === "inactive") return value;
	throw new TypeError("Binding state is invalid");
}
//#endregion
//#region src/authority/epoch.ts
var ScopeEpochCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			ScopeEpoch,
			ScopeRef,
			TextId,
			TenantId,
			WorkspaceId,
			ProjectId
		], "authority.scope-epoch", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(record) {
		return record.toData();
	}
	decodePayload(payload, _version) {
		return ScopeEpoch.fromData(payload);
	}
};
var PathEpochEvidenceCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			PathEpochEvidence,
			ScopeEpoch,
			ScopeRef,
			TextId,
			ProjectId,
			TenantId,
			WorkspaceId
		], "authority.path-epoch-evidence", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(record) {
		return record.toData();
	}
	decodePayload(payload) {
		return PathEpochEvidence.fromData(payload);
	}
};
var InvalidationWatermarkCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			InvalidationWatermark,
			ActorRef,
			Revision,
			TextId,
			ScopeEpoch,
			ActorId,
			TenantId,
			WorkspaceId,
			ProjectId,
			PrincipalId,
			PrincipalRef,
			ScopeRef
		], "authority.invalidation-watermark", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(record) {
		return record.toData();
	}
	decodePayload(payload) {
		return InvalidationWatermark.fromData(payload);
	}
};
var ScopeEpoch = class ScopeEpoch {
	scope;
	epoch;
	static get codec() {
		return scopeEpochCodecInstance;
	}
	constructor(scope, epoch) {
		this.scope = scope;
		this.epoch = epoch;
		if (!Number.isSafeInteger(epoch) || epoch < 0) throw new TypeError("Scope epoch must be a non-negative safe integer");
		Object.freeze(this);
	}
	static initial(scope) {
		return new ScopeEpoch(scope, 0);
	}
	static encode(record) {
		return ScopeEpoch.codec.encode(record);
	}
	static decode(bytes) {
		return ScopeEpoch.codec.decode(bytes);
	}
	next() {
		if (this.epoch === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("protocol.invalid-state", `Authority epoch is exhausted for ${scopeKey(this.scope)}`);
		return new ScopeEpoch(this.scope, this.epoch + 1);
	}
	equals(other) {
		return scopeKey(this.scope) === scopeKey(other.scope) && this.epoch === other.epoch;
	}
	toData() {
		return {
			epoch: this.epoch,
			scope: encodeAuthorityScope(this.scope)
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Scope epoch");
		requireExact(object, ["epoch", "scope"], "Scope epoch");
		return new ScopeEpoch(decodeAuthorityScope(object["scope"]), requireSafeInteger(object, "epoch", "Scope epoch"));
	}
};
var scopeEpochCodecInstance = new ScopeEpochCodecV1();
var PathEpochEvidence = class PathEpochEvidence {
	static get codec() {
		return pathEpochEvidenceCodecInstance;
	}
	path;
	constructor(path) {
		validatePath(path);
		this.path = Object.freeze([...path]);
		Object.freeze(this);
	}
	static encode(record) {
		return PathEpochEvidence.codec.encode(record);
	}
	static decode(bytes) {
		return PathEpochEvidence.codec.decode(bytes);
	}
	get target() {
		return this.path[this.path.length - 1];
	}
	equals(other) {
		return this.path.length === other.path.length && this.path.every((entry, index) => entry.equals(other.path[index]));
	}
	staleScopes(current) {
		if (this.path.length !== current.path.length) return Object.freeze(current.path.map((entry) => entry.scope));
		return Object.freeze(current.path.filter((entry, index) => {
			const previous = this.path[index];
			return scopeKey(entry.scope) !== scopeKey(previous.scope) || entry.epoch !== previous.epoch;
		}).map((entry) => entry.scope));
	}
	toData() {
		return { path: this.path.map((entry) => entry.toData()) };
	}
	static fromData(value) {
		const object = requireObject(value, "Path epoch evidence");
		requireExact(object, ["path"], "Path epoch evidence");
		const path = requireArray(object["path"], "Path epoch evidence").map(ScopeEpoch.fromData);
		if (!isNonempty(path)) throw new TypeError("Path epoch evidence must not be empty");
		return new PathEpochEvidence(path);
	}
};
var pathEpochEvidenceCodecInstance = new PathEpochEvidenceCodecV1();
var InvalidationWatermark = class InvalidationWatermark {
	ownerTenant;
	owner;
	holder;
	revision;
	static get codec() {
		return invalidationWatermarkCodecInstance;
	}
	delivered;
	constructor(ownerTenant, owner, holder, delivered, revision) {
		this.ownerTenant = ownerTenant;
		this.owner = owner;
		this.holder = holder;
		this.revision = revision;
		const unique = /* @__PURE__ */ new Map();
		for (const entry of delivered) {
			if (!entry.scope.tenantId.equals(ownerTenant)) throw new TypeError("Watermark entries must belong to the owning Tenant");
			const key = scopeKey(entry.scope);
			if (unique.has(key)) throw new TypeError("Watermark Scope entries must be unique");
			unique.set(key, entry);
		}
		this.delivered = Object.freeze([...unique.values()].sort((left, right) => compareCanonicalText(scopeKey(left.scope), scopeKey(right.scope))));
		Object.freeze(this);
	}
	static empty(ownerTenant, owner, holder) {
		return new InvalidationWatermark(ownerTenant, owner, holder, [], Revision.initial());
	}
	static encode(record) {
		return InvalidationWatermark.codec.encode(record);
	}
	static decode(bytes) {
		return InvalidationWatermark.codec.decode(bytes);
	}
	/**
	* A scope this watermark does not carry answers 0, which makes an entry recorded at
	* epoch 0 and an absent entry indistinguishable to every reader. `dominates` depends on
	* that: it compares epochs only, so dropping an epoch-0 entry preserves domination
	* without losing anything observable. A reader that needed to tell "delivered at 0" from
	* "never delivered" would break the guard, and would have to carry that distinction
	* itself rather than infer it from membership.
	*/
	epoch(scope) {
		return this.delivered.find((entry) => scopeKey(entry.scope) === scopeKey(scope))?.epoch ?? 0;
	}
	join(entries) {
		const joined = new Map(this.delivered.map((entry) => [scopeKey(entry.scope), entry]));
		let changed = false;
		for (const entry of entries) {
			if (!entry.scope.tenantId.equals(this.ownerTenant)) throw new AgentCoreError("protocol.invalid-state", "Watermark join entries must belong to the owning Tenant");
			const key = scopeKey(entry.scope);
			const previous = joined.get(key);
			if (previous === void 0 || entry.epoch > previous.epoch) {
				joined.set(key, entry);
				changed = true;
			}
		}
		if (changed && this.revision.value === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("protocol.invalid-state", "Invalidation watermark revision is exhausted");
		return changed ? new InvalidationWatermark(this.ownerTenant, this.owner, this.holder, [...joined.values()], this.revision.next()) : this;
	}
	dominates(other) {
		return this.ownerTenant.equals(other.ownerTenant) && this.owner.equals(other.owner) && this.holder.equals(other.holder) && other.delivered.every((entry) => this.epoch(entry.scope) >= entry.epoch);
	}
	toData() {
		return {
			delivered: this.delivered.map((entry) => entry.toData()),
			holder: {
				principal: this.holder.principalId.value,
				tenant: this.holder.tenantId.value
			},
			owner: {
				id: this.owner.id.value,
				kind: this.owner.kind
			},
			ownerTenant: this.ownerTenant.value,
			revision: this.revision.value
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Invalidation watermark");
		requireExact(object, [
			"delivered",
			"holder",
			"owner",
			"ownerTenant",
			"revision"
		], "Invalidation watermark");
		const holder = requireObject(object["holder"], "Watermark holder");
		const owner = requireObject(object["owner"], "Watermark owner");
		requireExact(holder, ["principal", "tenant"], "Watermark holder");
		requireExact(owner, ["id", "kind"], "Watermark owner");
		return new InvalidationWatermark(new TenantId(requireString(object, "ownerTenant", "Watermark owner Tenant")), new ActorRef(requireActorKind$4(owner["kind"]), new ActorId(requireString(owner, "id", "Watermark owner ID"))), new PrincipalRef(new TenantId(requireString(holder, "tenant", "Watermark holder Tenant")), new PrincipalId(requireString(holder, "principal", "Watermark holder Principal"))), requireArray(object["delivered"], "Watermark entries").map(ScopeEpoch.fromData), new Revision(requireSafeInteger(object, "revision", "Watermark revision")));
	}
};
var invalidationWatermarkCodecInstance = new InvalidationWatermarkCodecV1();
/**
* The deepest authority path: the longest exact Scope chain the enumeration below admits,
* `tenant,project,workspace`. Named rather than written as a literal, because its source
* is that enumeration and not a chosen ceiling — adding a Scope kind to the chain set is
* what may move it.
*/
var MAX_AUTHORITY_PATH_SCOPES = 3;
function validatePath(path) {
	if (path.length < 1 || path.length > MAX_AUTHORITY_PATH_SCOPES) throw new TypeError("Authority path must contain one to three Scopes");
	const kinds = path.map((entry) => entry.scope.kind).join(",");
	if (kinds !== "tenant" && kinds !== "tenant,project" && kinds !== "tenant,workspace" && kinds !== "tenant,project,workspace") throw new TypeError("Authority path must be an exact Tenant-to-target Scope chain");
	if (new Set(path.map((entry) => scopeKey(entry.scope))).size !== path.length) throw new TypeError("Authority path Scopes must be unique");
	const target = path[path.length - 1].scope;
	if (path.some((entry) => !entry.scope.tenantId.equals(target.tenantId))) throw new TypeError("Authority path Scopes must share one Tenant");
	if (target.kind === "workspace" && target.projectId !== void 0) {
		const project = path.find((entry) => entry.scope.kind === "project")?.scope;
		if (project?.projectId === void 0 || !project.projectId.equals(target.projectId)) throw new TypeError("Authority path must include the Workspace's exact Project");
	}
	const exact = target.path;
	if (exact.length !== path.length || exact.some((scope, index) => !scope.equals(path[index].scope))) throw new TypeError("Authority path must equal the target Scope's canonical ancestry");
}
function requireActorKind$4(value) {
	if (value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate") return value;
	throw new TypeError("Watermark owner Actor kind is invalid");
}
//#endregion
//#region src/authority/grant.ts
var GrantState = class {
	static get active() {
		return activeGrantState;
	}
	static get revoked() {
		return revokedGrantState;
	}
	get isActive() {
		return this.name === "active";
	}
};
var ActiveGrantState = class extends GrantState {
	name = "active";
	revoke() {
		return GrantState.revoked;
	}
};
var RevokedGrantState = class extends GrantState {
	name = "revoked";
	revoke() {
		return this;
	}
};
var activeGrantState = Object.freeze(new ActiveGrantState());
var revokedGrantState = Object.freeze(new RevokedGrantState());
var GrantCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			Grant,
			GrantState,
			ActiveGrantState,
			RevokedGrantState,
			GuestVerificationScheme,
			ScopeRef,
			TextId,
			CapabilitySpec,
			TeamId,
			MembershipId,
			TenantId,
			WorkspaceId,
			GrantId,
			ProjectId,
			PrincipalId,
			PrincipalRef
		], "authority.grant", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(grant) {
		return grant.toData();
	}
	decodePayload(payload, _version) {
		return Grant.fromData(payload);
	}
};
var Grant = class Grant {
	id;
	scope;
	effect;
	capability;
	static get codec() {
		return grantCodecInstance;
	}
	state;
	attenuationOf;
	origin;
	subject;
	constructor(id, scope, subject, effect, capability, origin, attenuationOf, state = GrantState.active) {
		this.id = id;
		this.scope = scope;
		this.effect = effect;
		this.capability = capability;
		if (!isCapabilityEffect(effect)) throw new TypeError("Grant effect is invalid");
		if (effect === "deny" && attenuationOf !== void 0) throw new TypeError("Deny Grants cannot be attenuated or delegated");
		validateOrigin(origin);
		requireSubjectTenant(subject, scope.tenantId, "Grant");
		this.subject = decodeAuthoritySubject(encodeAuthoritySubject(subject));
		this.origin = Object.freeze({ ...origin });
		this.attenuationOf = attenuationOf;
		this.state = state;
		Object.freeze(this);
	}
	static create(init) {
		return new Grant(init.id, init.scope, init.subject, init.effect, init.capability, init.origin, init.attenuationOf, init.state);
	}
	static encode(grant) {
		return Grant.codec.encode(grant);
	}
	static decode(bytes) {
		return Grant.codec.decode(bytes);
	}
	get isLive() {
		return this.state.isActive;
	}
	revoke() {
		return new Grant(this.id, this.scope, this.subject, this.effect, this.capability, this.origin, this.attenuationOf, this.state.revoke());
	}
	canAttenuate(child) {
		return this.effect === "allow" && (!child.isLive || this.isLive) && this.capability.covers(child.capability) && child.scope.path.some((scope) => scope.equals(this.scope)) && this.scope.path.length <= child.scope.path.length;
	}
	assertCanReplace(next) {
		if (scopeKey(this.scope) !== scopeKey(next.scope) || subjectKey(this.subject) !== subjectKey(next.subject) || this.attenuationOf?.value !== next.attenuationOf?.value || !sameOriginIdentity(this.origin, next.origin)) throw new AgentCoreError("protocol.invalid-state", "Grant subject, Scope, origin, and attenuation lineage are immutable");
		if (!this.isLive && next.isLive) throw new AgentCoreError("protocol.invalid-state", "Revoked Grants cannot reactivate");
		if (this.origin.kind === "direct" && !bytesEqual(Grant.encode(this.revoke()), Grant.encode(next))) throw new AgentCoreError("protocol.invalid-state", "Direct Grants are immutable except for revocation");
	}
	toData() {
		return {
			attenuationOf: this.attenuationOf?.value ?? null,
			capability: this.capability.toData(),
			effect: this.effect,
			id: this.id.value,
			origin: encodeOrigin(this.origin),
			scope: encodeAuthorityScope(this.scope),
			state: this.state.name,
			subject: encodeAuthoritySubject(this.subject)
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Grant");
		requireExact(object, [
			"attenuationOf",
			"capability",
			"effect",
			"id",
			"origin",
			"scope",
			"state",
			"subject"
		], "Grant");
		const attenuation = object["attenuationOf"];
		if (attenuation !== null && !isGrantIdValue$1(attenuation)) throw new TypeError("Grant attenuation parent must be a string or null");
		return new Grant(new GrantId(requireString(object, "id", "Grant ID")), decodeAuthorityScope(object["scope"]), decodeAuthoritySubject(object["subject"]), requireEffect(object["effect"]), CapabilitySpec.fromData(object["capability"]), decodeOrigin(object["origin"]), attenuation === null ? void 0 : new GrantId(attenuation), requireState(object["state"]));
	}
};
var grantCodecInstance = new GrantCodecV1();
function isGrantIdValue$1(value) {
	return typeof value === "string";
}
function encodeOrigin(origin) {
	return origin.kind === "direct" ? { kind: origin.kind } : {
		guest: origin.guest,
		kind: origin.kind,
		membershipId: origin.membershipId.value,
		roleName: origin.roleName,
		ruleOrdinal: origin.ruleOrdinal
	};
}
function decodeOrigin(value) {
	const object = requireObject(value, "Grant origin");
	const kind = requireString(object, "kind", "Grant origin kind");
	if (kind === "direct") {
		requireExact(object, ["kind"], "Direct Grant origin");
		return { kind };
	}
	if (kind === "role") {
		requireExact(object, [
			"guest",
			"kind",
			"membershipId",
			"roleName",
			"ruleOrdinal"
		], "Role Grant origin");
		return {
			kind,
			membershipId: new MembershipId(requireString(object, "membershipId", "Membership ID")),
			roleName: requireString(object, "roleName", "Role name"),
			ruleOrdinal: requireSafeInteger(object, "ruleOrdinal", "Role rule ordinal"),
			guest: requireBoolean(object, "guest", "Role guest flag")
		};
	}
	throw new TypeError("Grant origin kind is invalid");
}
/** The longest a materializing Role's name may be; see `MAX_TEXT_VALUE_LENGTH` in core. */
var MAX_ROLE_NAME_LENGTH = 256;
function validateOrigin(origin) {
	if (origin.kind === "direct") return;
	if (!(origin.membershipId instanceof MembershipId) || origin.roleName.length === 0 || origin.roleName.length > MAX_ROLE_NAME_LENGTH || !Number.isSafeInteger(origin.ruleOrdinal) || origin.ruleOrdinal < 0) throw new TypeError("Role Grant origin is invalid");
}
function sameOriginIdentity(left, right) {
	if (left.kind !== right.kind) return false;
	if (left.kind === "direct" || right.kind === "direct") return true;
	return left.membershipId.equals(right.membershipId) && left.ruleOrdinal === right.ruleOrdinal && left.guest === right.guest;
}
function requireEffect(value) {
	if (isCapabilityEffect(value)) return value;
	throw new TypeError("Grant effect is invalid");
}
function requireState(value) {
	if (value === "active") return GrantState.active;
	if (value === "revoked") return GrantState.revoked;
	throw new TypeError("Grant state is invalid");
}
//#endregion
//#region src/authority/permit.ts
var EXPECTATION_FIELDS = Object.freeze([
	"argumentsDigest",
	"authority",
	"binding",
	"claim",
	"claimOwner",
	"facet",
	"impact",
	"intentDigest",
	"invocation",
	"itemIndex",
	"itemKey",
	"lease",
	"operation",
	"package",
	"pathEpochs",
	"principal",
	"reservation",
	"source",
	"target",
	"tenant",
	"issuer",
	"attemptOrdinal"
]);
var AuthorityPermitExpectation = class AuthorityPermitExpectation {
	tenant;
	issuer;
	source;
	target;
	principal;
	binding;
	facet;
	operation;
	package;
	impact;
	invocation;
	reservation;
	itemIndex;
	attemptOrdinal;
	claim;
	claimOwner;
	itemKey;
	argumentsDigest;
	intentDigest;
	pathEpochs;
	authority;
	lease;
	constructor(init) {
		requireIndex(init.target.fence, "Authority permit target fence");
		requireIndex(init.binding.generation.value, "Authority permit Binding generation");
		requireIndex(init.itemIndex, "Authority permit item index");
		requireIndex(init.attemptOrdinal, "Authority permit attempt ordinal");
		requireIndex(init.reservation.registryEpoch, "Authority permit reservation epoch");
		requireNonblank(init.itemKey, "Authority permit item key");
		if (init.issuer.kind !== "tenant") throw new TypeError("Authority permits must be issued by a Tenant Actor");
		if (!init.tenant.equals(init.principal.tenantId) || !init.tenant.equals(init.pathEpochs.path[0].scope.tenantId)) throw new TypeError("Authority permit Tenant must qualify its principal and path");
		if (!init.authority.principal.equals(init.principal) || !init.authority.binding.equals(init.binding.name)) throw new TypeError("Authority permit source must match its principal and Binding");
		const obligation = init.reservation.obligation;
		if (obligation.kind !== "invocationItem" || !obligation.invocation.equals(init.invocation) || obligation.itemIndex !== init.itemIndex || obligation.itemKey !== init.itemKey) throw new TypeError("Authority permit reservation must match its exact invocation item");
		if (init.lease !== void 0 && !init.lease.holder.equals(init.principal)) throw new TypeError("Authority permit lease holder must match its qualified principal");
		if (!POLICY_IMPACTS.includes(init.impact)) throw new TypeError("Authority permit impact is invalid");
		this.tenant = init.tenant;
		this.issuer = copyActor(init.issuer);
		this.source = copyActor(init.source);
		this.target = copyTarget(init.target);
		this.principal = new PrincipalRef(init.principal.tenantId, init.principal.principalId);
		this.binding = Object.freeze({
			name: init.binding.name,
			generation: new Revision(init.binding.generation.value)
		});
		this.facet = init.facet;
		this.operation = init.operation;
		this.package = PackagePin.fromData(init.package.toData());
		this.impact = init.impact;
		this.invocation = init.invocation;
		this.reservation = copyReservation(init.reservation);
		this.itemIndex = init.itemIndex;
		this.attemptOrdinal = init.attemptOrdinal;
		this.claim = init.claim;
		this.claimOwner = copyClaimOwner(init.claimOwner);
		this.itemKey = init.itemKey;
		this.argumentsDigest = init.argumentsDigest;
		this.intentDigest = init.intentDigest;
		this.pathEpochs = PathEpochEvidence.fromData(init.pathEpochs.toData());
		this.authority = copyAuthority(init.authority);
		this.lease = init.lease === void 0 ? void 0 : copyLease(init.lease);
		Object.freeze(this);
	}
	equals(other) {
		return canonicalJsonEqual(this.toData(), other.toData());
	}
	toData() {
		return {
			argumentsDigest: this.argumentsDigest.value,
			attemptOrdinal: this.attemptOrdinal,
			authority: encodeAuthority(this.authority),
			binding: {
				generation: this.binding.generation.value,
				name: this.binding.name.value
			},
			claim: this.claim.value,
			claimOwner: encodeClaimOwner(this.claimOwner),
			facet: this.facet.value,
			impact: this.impact,
			intentDigest: this.intentDigest.value,
			invocation: this.invocation.value,
			itemIndex: this.itemIndex,
			itemKey: this.itemKey,
			issuer: encodeActor(this.issuer),
			lease: this.lease === void 0 ? null : encodeLease(this.lease),
			operation: this.operation.value,
			package: this.package.toData(),
			pathEpochs: this.pathEpochs.toData(),
			principal: encodePrincipal(this.principal),
			reservation: encodeReservation(this.reservation),
			source: encodeActor(this.source),
			target: {
				actor: encodeActor(this.target.actor),
				domain: encodeDomain(this.target.domain),
				fence: this.target.fence
			},
			tenant: this.tenant.value
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Authority permit expectation");
		requireExact(object, EXPECTATION_FIELDS, "Authority permit expectation");
		const binding = requireObject(object["binding"], "Authority permit Binding");
		const target = requireObject(object["target"], "Authority permit target");
		requireExact(binding, ["generation", "name"], "Authority permit Binding");
		requireExact(target, [
			"actor",
			"domain",
			"fence"
		], "Authority permit target");
		const lease = object["lease"];
		let init = {
			tenant: new TenantId(requireString(object, "tenant")),
			issuer: decodeActor(object["issuer"]),
			source: decodeActor(object["source"]),
			target: {
				actor: decodeActor(target["actor"]),
				fence: requireSafeInteger(target, "fence"),
				domain: decodeDomain(target["domain"])
			},
			principal: decodePrincipal(object["principal"]),
			binding: {
				name: new BindingName(requireString(binding, "name")),
				generation: new Revision(requireSafeInteger(binding, "generation"))
			},
			facet: new FacetRef(requireString(object, "facet")),
			operation: new OperationRef(requireString(object, "operation")),
			package: PackagePin.fromData(object["package"]),
			impact: requireImpact$1(object["impact"]),
			invocation: new InvocationId(requireString(object, "invocation")),
			reservation: decodeReservation(object["reservation"]),
			itemIndex: requireSafeInteger(object, "itemIndex"),
			attemptOrdinal: requireSafeInteger(object, "attemptOrdinal"),
			claim: new ItemClaimId(requireString(object, "claim")),
			claimOwner: decodeClaimOwner(object["claimOwner"]),
			itemKey: requireString(object, "itemKey"),
			argumentsDigest: new Digest(requireString(object, "argumentsDigest")),
			intentDigest: new Digest(requireString(object, "intentDigest")),
			pathEpochs: PathEpochEvidence.fromData(object["pathEpochs"]),
			authority: decodeAuthority(object["authority"])
		};
		if (lease !== null) init = {
			...init,
			lease: decodeLease(lease)
		};
		return new AuthorityPermitExpectation(init);
	}
};
var AuthorityPermitCodec = class extends RecordCodec {
	constructor() {
		super([
			AuthorityPermit,
			ActorRef,
			AuthorityPermitExpectation,
			Revision,
			TextId,
			SemVer,
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
			WorkspaceId
		], "authority.permit", {
			major: 3,
			minor: 0
		});
	}
	encodePayload(permit) {
		return permit.toData();
	}
	decodePayload(payload, _version) {
		return AuthorityPermit.fromData(payload);
	}
};
var AuthorityPermit = class AuthorityPermit {
	static get codec() {
		return authorityPermitCodecInstance;
	}
	#issuedAt;
	#expiresAt;
	expectation;
	nonce;
	requestDigest;
	constructor(init) {
		this.expectation = new AuthorityPermitExpectation(init);
		this.nonce = requireNonblank(init.nonce, "Authority permit nonce");
		if (!(init.requestDigest instanceof Digest)) throw new TypeError("Authority permit request digest is invalid");
		this.requestDigest = new Digest(init.requestDigest.value);
		this.#issuedAt = validTime$1(init.issuedAt, "Authority permit issuance time");
		this.#expiresAt = validTime$1(init.expiresAt, "Authority permit expiry");
		if (this.#expiresAt <= this.#issuedAt) throw new TypeError("Authority permit expiry must be after issuance");
		Object.freeze(this);
	}
	static encode(permit) {
		return AuthorityPermit.codec.encode(permit);
	}
	static decode(bytes) {
		return AuthorityPermit.codec.decode(bytes);
	}
	get tenant() {
		return this.expectation.tenant;
	}
	get issuer() {
		return this.expectation.issuer;
	}
	get source() {
		return this.expectation.source;
	}
	get target() {
		return this.expectation.target;
	}
	get principal() {
		return this.expectation.principal;
	}
	get binding() {
		return this.expectation.binding;
	}
	get facet() {
		return this.expectation.facet;
	}
	get operation() {
		return this.expectation.operation;
	}
	get package() {
		return this.expectation.package;
	}
	get impact() {
		return this.expectation.impact;
	}
	get invocation() {
		return this.expectation.invocation;
	}
	get reservation() {
		return this.expectation.reservation;
	}
	get itemIndex() {
		return this.expectation.itemIndex;
	}
	get attemptOrdinal() {
		return this.expectation.attemptOrdinal;
	}
	get claim() {
		return this.expectation.claim;
	}
	get claimOwner() {
		return this.expectation.claimOwner;
	}
	get itemKey() {
		return this.expectation.itemKey;
	}
	get argumentsDigest() {
		return this.expectation.argumentsDigest;
	}
	get intentDigest() {
		return this.expectation.intentDigest;
	}
	get pathEpochs() {
		return this.expectation.pathEpochs;
	}
	get authority() {
		return this.expectation.authority;
	}
	get lease() {
		return this.expectation.lease;
	}
	get issuedAt() {
		return new Date(this.#issuedAt);
	}
	get expiresAt() {
		return new Date(this.#expiresAt);
	}
	digest() {
		return Digest.sha256(AuthorityPermit.encode(this));
	}
	assertConsumable(expected, now) {
		const time = validTime$1(now, "Authority permit consumption time");
		if (!this.expectation.equals(expected)) throw denied$3("Authority permit does not match the exact target admission");
		if (this.#issuedAt > time || time >= this.#expiresAt) throw denied$3("Authority permit is not valid at the target admission time");
	}
	toData() {
		return {
			...this.expectation.toData(),
			expiresAt: this.#expiresAt,
			issuedAt: this.#issuedAt,
			nonce: this.nonce,
			requestDigest: this.requestDigest.value
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Authority permit");
		requireExact(object, [
			...EXPECTATION_FIELDS,
			"expiresAt",
			"issuedAt",
			"nonce",
			"requestDigest"
		], "Authority permit");
		const expectationData = EXPECTATION_FIELDS.reduce((data, field) => ({
			...data,
			[field]: object[field]
		}), {});
		return new AuthorityPermit({
			...AuthorityPermitExpectation.fromData(expectationData),
			nonce: requireString(object, "nonce"),
			requestDigest: new Digest(requireString(object, "requestDigest")),
			issuedAt: new Date(requireSafeInteger(object, "issuedAt")),
			expiresAt: new Date(requireSafeInteger(object, "expiresAt"))
		});
	}
};
var authorityPermitCodecInstance = new AuthorityPermitCodec();
function copyTarget(target) {
	return Object.freeze({
		actor: copyActor(target.actor),
		fence: target.fence,
		domain: decodeDomain(encodeDomain(target.domain))
	});
}
function copyReservation(reservation) {
	requireNonblank(reservation.obligation.itemKey, "Authority permit reservation item key");
	requireIndex(reservation.obligation.itemIndex, "Authority permit reservation item index");
	return Object.freeze({
		run: reservation.run,
		registryEpoch: reservation.registryEpoch,
		obligation: Object.freeze({
			kind: "invocationItem",
			invocation: reservation.obligation.invocation,
			itemIndex: reservation.obligation.itemIndex,
			itemKey: reservation.obligation.itemKey
		})
	});
}
function encodeReservation(reservation) {
	return {
		obligation: {
			invocation: reservation.obligation.invocation.value,
			itemIndex: reservation.obligation.itemIndex,
			itemKey: reservation.obligation.itemKey,
			kind: reservation.obligation.kind
		},
		registryEpoch: reservation.registryEpoch,
		run: reservation.run.value
	};
}
function decodeReservation(value) {
	const object = requireObject(value, "Authority permit reservation");
	const obligation = requireObject(object["obligation"], "Authority permit obligation");
	requireExact(object, [
		"obligation",
		"registryEpoch",
		"run"
	], "Authority permit reservation");
	requireExact(obligation, [
		"invocation",
		"itemIndex",
		"itemKey",
		"kind"
	], "Authority permit obligation");
	if (obligation["kind"] !== "invocationItem") throw new TypeError("Authority permit requires an invocation-item reservation");
	return Object.freeze({
		run: new RunId(requireString(object, "run")),
		registryEpoch: requireSafeInteger(object, "registryEpoch"),
		obligation: Object.freeze({
			kind: "invocationItem",
			invocation: new InvocationId(requireString(obligation, "invocation")),
			itemIndex: requireSafeInteger(obligation, "itemIndex"),
			itemKey: requireString(obligation, "itemKey")
		})
	});
}
function copyClaimOwner(owner) {
	return owner.kind === "executor" ? Object.freeze({
		kind: owner.kind,
		token: copyLease(owner.token),
		worker: owner.worker
	}) : Object.freeze({
		kind: owner.kind,
		actor: copyActor(owner.actor),
		worker: owner.worker
	});
}
function encodeClaimOwner(owner) {
	return owner.kind === "executor" ? {
		kind: owner.kind,
		token: encodeLease(owner.token),
		worker: owner.worker.value
	} : {
		actor: encodeActor(owner.actor),
		kind: owner.kind,
		worker: owner.worker.value
	};
}
function decodeClaimOwner(value) {
	const object = requireObject(value, "Authority permit claim owner");
	const kind = requireString(object, "kind");
	if (kind === "executor") {
		requireExact(object, [
			"kind",
			"token",
			"worker"
		], "Authority permit claim owner");
		return Object.freeze({
			kind,
			token: decodeLease(object["token"]),
			worker: new ClaimWorkerId(requireString(object, "worker"))
		});
	}
	if (kind === "system") {
		requireExact(object, [
			"actor",
			"kind",
			"worker"
		], "Authority permit claim owner");
		return Object.freeze({
			kind,
			actor: decodeActor(object["actor"]),
			worker: new ClaimWorkerId(requireString(object, "worker"))
		});
	}
	throw new TypeError("Authority permit claim owner kind is invalid");
}
function copyAuthority(authority) {
	return Object.freeze({
		kind: authority.kind,
		principal: new PrincipalRef(authority.principal.tenantId, authority.principal.principalId),
		binding: authority.binding
	});
}
function encodeAuthority(authority) {
	return {
		binding: authority.binding.value,
		kind: authority.kind,
		principal: encodePrincipal(authority.principal)
	};
}
function decodeAuthority(value) {
	const object = requireObject(value, "Authority permit source");
	requireExact(object, [
		"binding",
		"kind",
		"principal"
	], "Authority permit source");
	const kind = object["kind"];
	if (kind !== "initiator" && kind !== "delegated") throw new TypeError("Authority permit source kind is invalid");
	return Object.freeze({
		kind,
		principal: decodePrincipal(object["principal"]),
		binding: new BindingName(requireString(object, "binding"))
	});
}
function encodePrincipal(principal) {
	return {
		principal: principal.principalId.value,
		tenant: principal.tenantId.value
	};
}
function decodePrincipal(value) {
	const object = requireObject(value, "Authority permit principal");
	requireExact(object, ["principal", "tenant"], "Authority permit principal");
	return new PrincipalRef(new TenantId(requireString(object, "tenant")), new PrincipalId(requireString(object, "principal")));
}
function copyLease(lease) {
	requireIndex(lease.epoch, "Authority permit lease epoch");
	if (!(lease.turn instanceof TurnId) || !(lease.holder instanceof PrincipalRef)) throw new TypeError("Authority permit lease must carry an exact qualified holder");
	return Object.freeze({
		turn: lease.turn,
		holder: lease.holder,
		epoch: lease.epoch
	});
}
function encodeLease(lease) {
	return {
		epoch: lease.epoch,
		holder: encodePrincipal(lease.holder),
		turn: lease.turn.value
	};
}
function decodeLease(value) {
	const object = requireObject(value, "Authority permit lease");
	requireExact(object, [
		"epoch",
		"holder",
		"turn"
	], "Authority permit lease");
	return Object.freeze({
		turn: new TurnId(requireString(object, "turn")),
		holder: decodePrincipal(object["holder"]),
		epoch: requireSafeInteger(object, "epoch")
	});
}
function encodeActor(actor) {
	return {
		id: actor.id.value,
		kind: actor.kind
	};
}
function copyActor(actor) {
	return new ActorRef(actor.kind, new ActorId(actor.id.value));
}
function decodeActor(value) {
	const object = requireObject(value, "Authority permit Actor");
	requireExact(object, ["id", "kind"], "Authority permit Actor");
	return new ActorRef(requireActorKind$3(object["kind"]), new ActorId(requireString(object, "id")));
}
function requireActorKind$3(value) {
	if (value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate") return value;
	throw new TypeError("Authority permit Actor kind is invalid");
}
function requireImpact$1(value) {
	if (isMember(POLICY_IMPACTS, value)) return value;
	throw new TypeError("Authority permit impact is invalid");
}
function requireIndex(value, subject) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${subject} must be a non-negative safe integer`);
}
function requireNonblank(value, subject) {
	if (value.trim().length === 0 || value !== value.trim()) throw new TypeError(`${subject} must be a nonblank canonical string`);
	return value;
}
function validTime$1(value, subject) {
	const time = value.getTime();
	if (!Number.isSafeInteger(time) || time < 0) throw new TypeError(`${subject} must be a valid non-negative Date`);
	return time;
}
function denied$3(message) {
	return new AgentCoreError("authority.denied", message);
}
//#endregion
//#region src/authority/evidence.ts
var AuthorityCheckRequestCodec = class extends RecordCodec {
	constructor() {
		super([
			AuthorityCheckRequest,
			ActorRef,
			GuestVerificationScheme,
			Revision,
			ScopeRef,
			TextId,
			Binding,
			BindingLifecycle,
			BindingCredentialCustody,
			PathEpochEvidence,
			ScopeEpoch,
			FacetRef,
			Digest,
			SecretRef,
			BindingName,
			ActorId,
			TeamId,
			TenantId,
			WorkspaceId,
			GrantId,
			ProjectId,
			PrincipalId,
			FacetPackageId,
			ProtectionDomain,
			PrincipalRef
		], "authority.check-request", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(record) {
		return record.toData();
	}
	decodePayload(payload) {
		return AuthorityCheckRequest.fromData(payload);
	}
};
var AuthorityCheckRequest = class AuthorityCheckRequest {
	static get codec() {
		return authorityCheckRequestCodecInstance;
	}
	intent;
	constructor(init) {
		requireSafeNonnegative(init.ownerFence, "Authority owner fence");
		requireSafeNonnegative(init.itemIndex, "Authority item index");
		requireSafeNonnegative(init.attemptOrdinal, "Authority attempt ordinal");
		if (init.nonce.length === 0 || init.nonce !== init.nonce.trim()) throw new TypeError("Authority check nonce must be canonical and nonblank");
		if (init.intent.operation.length === 0 || init.intent.operation !== init.intent.operation.trim()) throw new TypeError("Authority operation must be canonical and nonblank");
		this.ownerTenant = init.ownerTenant;
		this.owner = init.owner;
		this.ownerFence = init.ownerFence;
		this.principal = init.principal;
		this.binding = init.binding;
		const canonicalArguments = canonicalJson(init.intent.arguments);
		if (!Digest.sha256(encodeCanonicalJson(canonicalArguments)).equals(init.intent.argumentsDigest)) throw new TypeError("Authority argument digest does not match canonical arguments");
		this.intent = Object.freeze({
			...init.intent,
			arguments: canonicalArguments
		});
		this.expectedPath = init.expectedPath;
		this.invocationDigest = init.invocationDigest;
		this.itemIndex = init.itemIndex;
		this.attemptOrdinal = init.attemptOrdinal;
		this.nonce = init.nonce;
		Object.freeze(this);
	}
	ownerTenant;
	owner;
	ownerFence;
	principal;
	binding;
	invocationDigest;
	expectedPath;
	itemIndex;
	attemptOrdinal;
	nonce;
	digest() {
		return Digest.sha256(encodeCanonicalJson(this.toData()));
	}
	static encode(record) {
		return AuthorityCheckRequest.codec.encode(record);
	}
	static decode(bytes) {
		return AuthorityCheckRequest.codec.decode(bytes);
	}
	toData() {
		return {
			attemptOrdinal: this.attemptOrdinal,
			binding: this.binding.toData(),
			expectedPath: this.expectedPath.toData(),
			intent: encodeIntent(this.intent),
			invocationDigest: this.invocationDigest.value,
			itemIndex: this.itemIndex,
			nonce: this.nonce,
			owner: {
				id: this.owner.id.value,
				kind: this.owner.kind
			},
			ownerFence: this.ownerFence,
			ownerTenant: this.ownerTenant.value,
			principal: {
				principal: this.principal.principalId.value,
				tenant: this.principal.tenantId.value
			}
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Authority check request");
		requireExact(object, [
			"attemptOrdinal",
			"binding",
			"expectedPath",
			"intent",
			"invocationDigest",
			"itemIndex",
			"nonce",
			"owner",
			"ownerFence",
			"ownerTenant",
			"principal"
		], "Authority check request");
		const owner = requireObject(object["owner"], "Authority check owner");
		const principal = requireObject(object["principal"], "Authority check Principal");
		requireExact(owner, ["id", "kind"], "Authority check owner");
		requireExact(principal, ["principal", "tenant"], "Authority check Principal");
		return new AuthorityCheckRequest({
			ownerTenant: new TenantId(requireString(object, "ownerTenant")),
			owner: new ActorRef(requireActorKind$2(owner["kind"]), new ActorId(requireString(owner, "id"))),
			ownerFence: requireSafeInteger(object, "ownerFence"),
			principal: new PrincipalRef(new TenantId(requireString(principal, "tenant")), new PrincipalId(requireString(principal, "principal"))),
			binding: Binding.fromData(object["binding"]),
			intent: decodeIntent(object["intent"]),
			expectedPath: PathEpochEvidence.fromData(object["expectedPath"]),
			invocationDigest: new Digest(requireString(object, "invocationDigest")),
			itemIndex: requireSafeInteger(object, "itemIndex"),
			attemptOrdinal: requireSafeInteger(object, "attemptOrdinal"),
			nonce: requireString(object, "nonce")
		});
	}
};
var authorityCheckRequestCodecInstance = new AuthorityCheckRequestCodec();
var AuthorityCheckEvidenceCodec = class extends RecordCodec {
	constructor() {
		super([
			AuthorityCheckEvidence,
			ActorRef,
			TextId,
			PathEpochEvidence,
			ScopeEpoch,
			ScopeRef,
			Digest,
			ActorId,
			TenantId,
			ProjectId,
			WorkspaceId,
			GrantId
		], "authority.check-evidence", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(record) {
		return record.toData();
	}
	decodePayload(payload) {
		return AuthorityCheckEvidence.fromData(payload);
	}
};
var AuthorityCheckEvidence = class AuthorityCheckEvidence {
	issuerTenant;
	issuer;
	requestDigest;
	bindingKey;
	bindingGeneration;
	decision;
	reason;
	pathEpochs;
	static get codec() {
		return authorityCheckEvidenceCodecInstance;
	}
	#checkedAt;
	matchedAllow;
	matchedDeny;
	constructor(issuerTenant, issuer, requestDigest, bindingKey, bindingGeneration, decision, reason, matchedAllow, matchedDeny, pathEpochs, checkedAt) {
		this.issuerTenant = issuerTenant;
		this.issuer = issuer;
		this.requestDigest = requestDigest;
		this.bindingKey = bindingKey;
		this.bindingGeneration = bindingGeneration;
		this.decision = decision;
		this.reason = reason;
		this.pathEpochs = pathEpochs;
		requireSafeNonnegative(bindingGeneration, "Authority Binding generation");
		if (decision === "allow" !== (reason === "allowed")) throw new TypeError("Only allowed authority evidence may carry the allowed reason");
		this.matchedAllow = canonicalGrantIds(matchedAllow);
		this.matchedDeny = canonicalGrantIds(matchedDeny);
		if (decision === "allow") {
			if (this.matchedAllow.length === 0 || this.matchedDeny.length > 0) throw new TypeError("Allowed authority evidence requires allow evidence and no deny evidence");
		} else if (reason === "matchingDeny") {
			if (this.matchedAllow.length > 0 || this.matchedDeny.length === 0) throw new TypeError("Matching-deny evidence requires only deny Grants");
		} else if (this.matchedAllow.length > 0 || this.matchedDeny.length > 0) throw new TypeError("Non-matching authority denials cannot carry matched Grants");
		if (!issuerTenant.equals(pathEpochs.target.scope.tenantId)) throw new TypeError("Authority evidence issuer Tenant must match its path");
		if (bindingKey.length === 0) throw new TypeError("Authority evidence Binding key must be nonblank");
		this.#checkedAt = validDate(checkedAt, "Authority check time");
		if (issuer.kind !== "tenant") throw new TypeError("Authority check evidence must be issued by a Tenant Actor");
		Object.freeze(this);
	}
	static encode(record) {
		return AuthorityCheckEvidence.codec.encode(record);
	}
	static decode(bytes) {
		return AuthorityCheckEvidence.codec.decode(bytes);
	}
	get checkedAt() {
		return new Date(this.#checkedAt);
	}
	get allowed() {
		return this.decision === "allow";
	}
	binds(request) {
		return this.requestDigest.equals(request.digest()) && this.bindingKey === request.binding.key && this.bindingGeneration === request.binding.generation;
	}
	toData() {
		return {
			bindingGeneration: this.bindingGeneration,
			bindingKey: this.bindingKey,
			checkedAt: this.#checkedAt,
			decision: this.decision,
			issuer: {
				id: this.issuer.id.value,
				kind: this.issuer.kind
			},
			issuerTenant: this.issuerTenant.value,
			matchedAllow: this.matchedAllow.map((id) => id.value),
			matchedDeny: this.matchedDeny.map((id) => id.value),
			pathEpochs: this.pathEpochs.toData(),
			reason: this.reason,
			requestDigest: this.requestDigest.value
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Authority check evidence");
		requireExact(object, [
			"bindingGeneration",
			"bindingKey",
			"checkedAt",
			"decision",
			"issuer",
			"issuerTenant",
			"matchedAllow",
			"matchedDeny",
			"pathEpochs",
			"reason",
			"requestDigest"
		], "Authority check evidence");
		const issuer = requireObject(object["issuer"], "Authority evidence issuer");
		requireExact(issuer, ["id", "kind"], "Authority evidence issuer");
		const decision = requireDecision(object["decision"]);
		return new AuthorityCheckEvidence(new TenantId(requireString(object, "issuerTenant")), new ActorRef(requireActorKind$2(issuer["kind"]), new ActorId(requireString(issuer, "id"))), new Digest(requireString(object, "requestDigest")), requireString(object, "bindingKey"), requireSafeInteger(object, "bindingGeneration"), decision, requireReason(object["reason"]), decodeGrantIds(object["matchedAllow"], "Matched allow Grants"), decodeGrantIds(object["matchedDeny"], "Matched deny Grants"), PathEpochEvidence.fromData(object["pathEpochs"]), new Date(requireSafeInteger(object, "checkedAt")));
	}
};
var authorityCheckEvidenceCodecInstance = new AuthorityCheckEvidenceCodec();
function encodeIntent(intent) {
	return {
		arguments: intent.arguments,
		argumentsDigest: intent.argumentsDigest.value,
		facet: intent.facet.value,
		impact: intent.impact,
		operation: intent.operation
	};
}
function decodeIntent(value) {
	const object = requireObject(value, "Authority operation intent");
	requireExact(object, [
		"arguments",
		"argumentsDigest",
		"facet",
		"impact",
		"operation"
	], "Authority operation intent");
	const argumentsValue = requireObject(object["arguments"], "Authority operation arguments");
	return Object.freeze({
		facet: new FacetRef(requireString(object, "facet")),
		operation: requireString(object, "operation"),
		impact: requireImpact(object["impact"]),
		arguments: canonicalJson(argumentsValue),
		argumentsDigest: new Digest(requireString(object, "argumentsDigest"))
	});
}
function canonicalGrantIds(ids) {
	const ordered = [...ids].sort((left, right) => compareCanonicalText(left.value, right.value));
	if (new Set(ordered.map((id) => id.value)).size !== ordered.length) throw new TypeError("Authority Grant evidence must be unique");
	return Object.freeze(ordered);
}
function decodeGrantIds(value, subject) {
	return requireArray(value, subject).map((entry, index) => {
		if (!isGrantIdValue(entry)) throw new TypeError(`${subject} entry ${index} must be a string`);
		return new GrantId(entry);
	});
}
function isGrantIdValue(value) {
	return typeof value === "string";
}
function requireActorKind$2(value) {
	if (value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate") return value;
	throw new TypeError("Authority Actor kind is invalid");
}
function requireImpact(value) {
	if (value === "observe" || value === "mutate" || value === "externalSend" || value === "execute" || value === "delegate" || value === "administer") return value;
	throw new TypeError("Authority impact is invalid");
}
function requireDecision(value) {
	if (value === "allow" || value === "deny") return value;
	throw new TypeError("Authority decision is invalid");
}
function requireReason(value) {
	if (isMember([
		"allowed",
		"missingPrincipal",
		"inactivePrincipal",
		"invalidBinding",
		"missingGrant",
		"revokedGrant",
		"invalidDelegation",
		"guestElevation",
		"guestVerificationExpired",
		"noMatchingAllow",
		"matchingDeny",
		"stalePath"
	], value)) return value;
	throw new TypeError("Authority decision reason is invalid");
}
function requireSafeNonnegative(value, subject) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${subject} is invalid`);
}
function validDate(value, subject) {
	const time = value.getTime();
	if (!Number.isSafeInteger(time) || time < 0) throw new TypeError(`${subject} is invalid`);
	return time;
}
//#endregion
//#region src/authority/target-lease-evidence.ts
/** The stable source-delivery identity for one immutable lease attestation. */
var TargetLeaseEvidenceKey = class TargetLeaseEvidenceKey {
	source;
	idempotencyKey;
	constructor(source, idempotencyKey) {
		if (idempotencyKey.length === 0 || idempotencyKey !== idempotencyKey.trim()) throw new TypeError("Target lease evidence idempotency key must be canonical and nonblank");
		this.source = new ActorRef(source.kind, new ActorId(source.id.value));
		this.idempotencyKey = idempotencyKey;
		Object.freeze(this);
	}
	equals(other) {
		return this.source.equals(other.source) && this.idempotencyKey === other.idempotencyKey;
	}
	toData() {
		return {
			idempotencyKey: this.idempotencyKey,
			source: {
				id: this.source.id.value,
				kind: this.source.kind
			}
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Target lease evidence key");
		requireExact(object, ["idempotencyKey", "source"], "Target lease evidence key");
		const source = requireObject(object["source"], "Target lease evidence source");
		requireExact(source, ["id", "kind"], "Target lease evidence source");
		return new TargetLeaseEvidenceKey(new ActorRef(requireActorKind$1(source["kind"]), new ActorId(requireString(source, "id", "Target lease evidence source ID"))), requireString(object, "idempotencyKey", "Target lease evidence idempotency key"));
	}
};
/** The exact immutable source evidence a target request names. */
var TargetLeaseEvidenceReference = class TargetLeaseEvidenceReference {
	key;
	digest;
	constructor(key, digest) {
		this.key = TargetLeaseEvidenceKey.fromData(key.toData());
		this.digest = new Digest(digest.value);
		Object.freeze(this);
	}
	equals(other) {
		return this.key.equals(other.key) && this.digest.equals(other.digest);
	}
	toData() {
		return {
			...this.key.toData(),
			digest: this.digest.value
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Target lease evidence reference");
		requireExact(object, [
			"digest",
			"idempotencyKey",
			"source"
		], "Target lease evidence reference");
		return new TargetLeaseEvidenceReference(TargetLeaseEvidenceKey.fromData({
			idempotencyKey: object["idempotencyKey"],
			source: object["source"]
		}), new Digest(requireString(object, "digest", "Target lease evidence digest")));
	}
};
var TargetLeaseEvidenceCodec = class extends RecordCodec {
	constructor() {
		super([
			TargetLeaseEvidence,
			TargetLeaseEvidenceReference,
			TargetLeaseEvidenceKey,
			ActorRef,
			ActorId,
			Digest,
			InvalidationWatermark,
			Revision,
			ScopeEpoch,
			ScopeRef,
			ProtectionDomain,
			RunId,
			TenantId,
			WorkspaceId,
			ProjectId,
			TextId,
			TurnId,
			PrincipalId,
			PrincipalRef
		], "authority.target-lease-evidence", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(record) {
		return record.toData();
	}
	decodePayload(payload) {
		return TargetLeaseEvidence.fromData(payload);
	}
};
/**
* A source-Actor's immutable attestation that one exact Turn lease authorizes one target
* permit-request identity. It snapshots evidence and never represents current lease state.
*/
var TargetLeaseEvidence = class TargetLeaseEvidence {
	static get codec() {
		return targetLeaseEvidenceCodecInstance;
	}
	#deadline;
	key;
	tenant;
	run;
	lease;
	target;
	requestIdentity;
	watermark;
	constructor(init) {
		if (!init.lease.holder.tenantId.equals(init.tenant)) throw new TypeError("Target lease evidence lease holder must belong to its Tenant");
		if (!init.watermark.ownerTenant.equals(init.tenant) || !init.watermark.owner.equals(init.key.source) || !init.watermark.holder.equals(init.lease.holder)) throw new TypeError("Target lease evidence watermark has the wrong source identity");
		if (!Number.isSafeInteger(init.target.fence) || init.target.fence < 0) throw new TypeError("Target lease evidence target fence is invalid");
		this.#deadline = validTime(init.deadline, "Target lease evidence deadline");
		this.key = TargetLeaseEvidenceKey.fromData(init.key.toData());
		this.tenant = new TenantId(init.tenant.value);
		this.run = new RunId(init.run.value);
		this.lease = Object.freeze({
			turn: new TurnId(init.lease.turn.value),
			holder: new PrincipalRef(init.lease.holder.tenantId, init.lease.holder.principalId),
			epoch: requireEpoch(init.lease.epoch)
		});
		this.target = Object.freeze({
			actor: new ActorRef(init.target.actor.kind, new ActorId(init.target.actor.id.value)),
			fence: init.target.fence,
			domain: new ProtectionDomain(init.target.domain.kind, init.target.domain.label, init.target.domain.secretPolicy)
		});
		this.requestIdentity = new Digest(init.requestIdentity.value);
		this.watermark = InvalidationWatermark.fromData(init.watermark.toData());
		Object.freeze(this);
	}
	reference() {
		return new TargetLeaseEvidenceReference(this.key, this.digest());
	}
	get deadline() {
		return new Date(this.#deadline);
	}
	digest() {
		return Digest.sha256(TargetLeaseEvidence.encode(this));
	}
	isCurrentAt(now) {
		return validTime(now, "Target lease evidence observation time") < this.#deadline;
	}
	matches(binding) {
		return this.key.equals(binding.key) && this.tenant.equals(binding.tenant) && this.run.equals(binding.run) && this.lease.turn.equals(binding.lease.turn) && this.lease.holder.equals(binding.lease.holder) && this.lease.epoch === binding.lease.epoch && this.target.actor.equals(binding.target.actor) && this.target.fence === binding.target.fence && this.target.domain.equals(binding.target.domain) && this.requestIdentity.equals(binding.requestIdentity);
	}
	toData() {
		return {
			deadline: this.#deadline,
			key: this.key.toData(),
			lease: {
				epoch: this.lease.epoch,
				holder: {
					principal: this.lease.holder.principalId.value,
					tenant: this.lease.holder.tenantId.value
				},
				turn: this.lease.turn.value
			},
			requestIdentity: this.requestIdentity.value,
			run: this.run.value,
			target: {
				actor: {
					id: this.target.actor.id.value,
					kind: this.target.actor.kind
				},
				domain: {
					kind: this.target.domain.kind,
					label: this.target.domain.label,
					secretPolicy: this.target.domain.secretPolicy
				},
				fence: this.target.fence
			},
			tenant: this.tenant.value,
			watermark: this.watermark.toData()
		};
	}
	static encode(record) {
		return TargetLeaseEvidence.codec.encode(record);
	}
	static decode(bytes) {
		return TargetLeaseEvidence.codec.decode(bytes);
	}
	static fromData(value) {
		const object = requireObject(value, "Target lease evidence");
		requireExact(object, [
			"deadline",
			"key",
			"lease",
			"requestIdentity",
			"run",
			"target",
			"tenant",
			"watermark"
		], "Target lease evidence");
		const lease = requireObject(object["lease"], "Target lease evidence lease");
		const holder = requireObject(lease["holder"], "Target lease evidence holder");
		const target = requireObject(object["target"], "Target lease evidence target");
		const targetActor = requireObject(target["actor"], "Target lease evidence target Actor");
		const domain = requireObject(target["domain"], "Target lease evidence target domain");
		requireExact(lease, [
			"epoch",
			"holder",
			"turn"
		], "Target lease evidence lease");
		requireExact(holder, ["principal", "tenant"], "Target lease evidence holder");
		requireExact(target, [
			"actor",
			"domain",
			"fence"
		], "Target lease evidence target");
		requireExact(targetActor, ["id", "kind"], "Target lease evidence target Actor");
		requireExact(domain, [
			"kind",
			"label",
			"secretPolicy"
		], "Target lease evidence target domain");
		return new TargetLeaseEvidence({
			key: TargetLeaseEvidenceKey.fromData(object["key"]),
			tenant: new TenantId(requireString(object, "tenant", "Target lease evidence Tenant")),
			run: new RunId(requireString(object, "run", "Target lease evidence Run")),
			lease: Object.freeze({
				turn: new TurnId(requireString(lease, "turn", "Target lease evidence Turn")),
				holder: new PrincipalRef(new TenantId(requireString(holder, "tenant", "Target lease evidence holder Tenant")), new PrincipalId(requireString(holder, "principal", "Target lease evidence holder Principal"))),
				epoch: requireSafeInteger(lease, "epoch", "Target lease evidence lease epoch")
			}),
			target: {
				actor: new ActorRef(requireActorKind$1(targetActor["kind"]), new ActorId(requireString(targetActor, "id", "Target lease evidence target Actor ID"))),
				fence: requireSafeInteger(target, "fence", "Target lease evidence target fence"),
				domain: new ProtectionDomain(requireDomainKind(domain["kind"]), requireString(domain, "label", "Target lease evidence target domain label"), requireSecretPolicy(domain["secretPolicy"]))
			},
			requestIdentity: new Digest(requireString(object, "requestIdentity", "Target lease evidence request identity")),
			deadline: new Date(requireSafeInteger(object, "deadline", "Target lease evidence deadline")),
			watermark: InvalidationWatermark.fromData(object["watermark"])
		});
	}
};
var targetLeaseEvidenceCodecInstance = new TargetLeaseEvidenceCodec();
function requireEpoch(value) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Target lease evidence lease epoch is invalid");
	return value;
}
function requireActorKind$1(value) {
	if (value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate") return value;
	throw new TypeError("Target lease evidence Actor kind is invalid");
}
function requireDomainKind(value) {
	if (value === "frontend" || value === "backend") return value;
	throw new TypeError("Target lease evidence target domain kind is invalid");
}
function requireSecretPolicy(value) {
	if (value === "no-secrets" || value === "may-hold-secrets") return value;
	throw new TypeError("Target lease evidence target domain secret policy is invalid");
}
function validTime(value, subject) {
	const time = value.getTime();
	if (!Number.isSafeInteger(time) || time < 0) throw new TypeError(`${subject} must be a valid non-negative Date`);
	return time;
}
//#endregion
//#region src/authority/permit-request.ts
var TargetAuthorityPermitRequestCodec = class extends RecordCodec {
	constructor() {
		super([
			TargetAuthorityPermitRequest,
			ActorRef,
			GuestVerificationScheme,
			Revision,
			ScopeRef,
			TextId,
			SemVer,
			AuthorityCheckRequest,
			AuthorityPermitExpectation,
			TargetLeaseEvidenceReference,
			TargetLeaseEvidenceKey,
			Binding,
			BindingLifecycle,
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
		], "authority.target-permit-request", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(request) {
		return request.toData();
	}
	decodePayload(payload) {
		return TargetAuthorityPermitRequest.fromData(payload);
	}
};
/** The target-owned immutable request from which its Tenant may issue one permit. */
var TargetAuthorityPermitRequest = class TargetAuthorityPermitRequest {
	expectation;
	authority;
	nonce;
	static get codec() {
		return targetAuthorityPermitRequestCodecInstance;
	}
	#expiresAt;
	constructor(expectation, authority, nonce, expiresAt, leaseEvidence = void 0) {
		this.expectation = expectation;
		this.authority = authority;
		this.nonce = nonce;
		if (nonce.length === 0 || nonce !== nonce.trim()) throw new TypeError("Target authority permit request nonce must be canonical and nonblank");
		const expiresAtTime = expiresAt.getTime();
		if (!Number.isSafeInteger(expiresAtTime) || expiresAtTime < 0) throw new TypeError("Target authority permit request expiry is invalid");
		requireRequestIdentity(expectation, authority, nonce);
		requireAuthorityBinding(expectation, authority);
		requireAuthorityIntent(expectation, authority);
		if (leaseEvidence !== void 0 && (!leaseEvidence.key.source.equals(expectation.source) || leaseEvidence.key.idempotencyKey !== nonce)) throw new TypeError("Target authority permit request lease evidence does not match its source identity");
		this.#expiresAt = expiresAtTime;
		this.leaseEvidence = leaseEvidence === void 0 ? void 0 : TargetLeaseEvidenceReference.fromData(leaseEvidence.toData());
		Object.freeze(this);
	}
	leaseEvidence;
	get expiresAt() {
		return new Date(this.#expiresAt);
	}
	identity() {
		return TargetAuthorityPermitRequest.identityFor(this.expectation, this.authority, this.nonce, this.expiresAt);
	}
	digest() {
		return Digest.sha256(encodeCanonicalJson(this.toData()));
	}
	toData() {
		return {
			authority: this.authority.toData(),
			expectation: this.expectation.toData(),
			expiresAt: this.#expiresAt,
			leaseEvidence: this.leaseEvidence?.toData() ?? null,
			nonce: this.nonce
		};
	}
	static identityFor(expectation, authority, nonce, expiresAt) {
		return Digest.sha256(encodeCanonicalJson({
			authority: authority.toData(),
			expectation: expectation.toData(),
			expiresAt: expiresAt.getTime(),
			nonce
		}));
	}
	static fromData(value) {
		const object = requireObject(value, "Target authority permit request");
		requireExact(object, [
			"authority",
			"expectation",
			"expiresAt",
			"leaseEvidence",
			"nonce"
		], "Target authority permit request");
		const leaseEvidence = object["leaseEvidence"];
		return new TargetAuthorityPermitRequest(AuthorityPermitExpectation.fromData(object["expectation"]), AuthorityCheckRequest.fromData(object["authority"]), requireString(object, "nonce", "Target authority permit request nonce"), new Date(requireSafeInteger(object, "expiresAt", "Target authority permit request expiry")), leaseEvidence === null ? void 0 : TargetLeaseEvidenceReference.fromData(leaseEvidence));
	}
	static encode(request) {
		return TargetAuthorityPermitRequest.codec.encode(request);
	}
	static decode(bytes) {
		return TargetAuthorityPermitRequest.codec.decode(bytes);
	}
};
var targetAuthorityPermitRequestCodecInstance = new TargetAuthorityPermitRequestCodec();
function requireRequestIdentity(expectation, authority, nonce) {
	if (!authority.ownerTenant.equals(expectation.tenant) || !authority.owner.equals(expectation.target.actor) || authority.ownerFence !== expectation.target.fence || !authority.principal.equals(expectation.principal) || authority.itemIndex !== expectation.itemIndex || authority.attemptOrdinal !== expectation.attemptOrdinal || authority.nonce !== nonce || expectation.issuer.equals(expectation.target.actor)) throw new TypeError("Target authority permit request does not match its exact target identity");
}
function requireAuthorityBinding(expectation, authority) {
	const binding = authority.binding;
	if (!binding.name.equals(expectation.binding.name) || binding.generation !== expectation.binding.generation.value || !binding.facet.equals(expectation.facet) || !binding.domain.equals(expectation.target.domain) || !binding.scope.equals(expectation.pathEpochs.target.scope) || !authority.expectedPath.equals(expectation.pathEpochs)) throw new TypeError("Target authority permit request does not match its exact Binding and path");
}
function requireAuthorityIntent(expectation, authority) {
	const intent = authority.intent;
	const operation = expectation.operation;
	if (!intent.facet.equals(expectation.facet) || !operation.facet.equals(expectation.facet.packageId) || intent.operation !== operation.operation.value || intent.impact !== expectation.impact || !intent.argumentsDigest.equals(expectation.argumentsDigest) || !authority.invocationDigest.equals(expectation.intentDigest)) throw new TypeError("Target authority permit request does not match its exact authority intent");
}
//#endregion
//#region src/authority/permit-denial.ts
var TargetAuthorityPermitDenialCodec = class extends RecordCodec {
	constructor() {
		super([
			TargetAuthorityPermitDenial,
			ActorRef,
			GuestVerificationScheme,
			Revision,
			ScopeRef,
			TextId,
			SemVer,
			AuthorityCheckRequest,
			AuthorityPermitExpectation,
			Binding,
			AuthorityCheckEvidence,
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
		], "authority.target-permit-denial", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(denial) {
		return denial.toData();
	}
	decodePayload(payload) {
		return TargetAuthorityPermitDenial.fromData(payload);
	}
};
/** The exact denied Tenant decision for one target-owned permit request. */
var TargetAuthorityPermitDenial = class TargetAuthorityPermitDenial {
	request;
	evidence;
	static get codec() {
		return targetAuthorityPermitDenialCodecInstance;
	}
	constructor(request, evidence) {
		this.request = request;
		this.evidence = evidence;
		if (evidence.allowed || !evidence.binds(request.authority) || !evidence.issuer.equals(request.expectation.issuer) || !evidence.issuerTenant.equals(request.expectation.tenant) || evidence.checkedAt.getTime() >= request.expiresAt.getTime()) throw new TypeError("Target authority permit denial requires exact timely denied Tenant evidence");
		Object.freeze(this);
	}
	digest() {
		return Digest.sha256(encodeCanonicalJson(this.toData()));
	}
	toData() {
		return {
			evidence: this.evidence.toData(),
			request: this.request.toData()
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Target authority permit denial");
		requireExact(object, ["evidence", "request"], "Target authority permit denial");
		return new TargetAuthorityPermitDenial(TargetAuthorityPermitRequest.fromData(object["request"]), AuthorityCheckEvidence.fromData(object["evidence"]));
	}
	static encode(denial) {
		return TargetAuthorityPermitDenial.codec.encode(denial);
	}
	static decode(bytes) {
		return TargetAuthorityPermitDenial.codec.decode(bytes);
	}
};
var targetAuthorityPermitDenialCodecInstance = new TargetAuthorityPermitDenialCodec();
//#endregion
//#region src/authority/permit-authentication.ts
var authenticationIssuer = Symbol("authority-permit-authentication-issuer");
var issuedAuthentications = /* @__PURE__ */ new WeakSet();
var AuthorityPermitIssuedRecordSource = class {};
var AuthenticatedAuthorityPermit = class {
	#permit;
	constructor(issuer, permit) {
		if (issuer !== authenticationIssuer) throw denied$2("Authority permit authentication has an invalid issuer");
		this.#permit = AuthorityPermit.decode(AuthorityPermit.encode(permit));
		issuedAuthentications.add(this);
		Object.freeze(this);
	}
	matches(permit) {
		return bytesEqual(AuthorityPermit.encode(this.#permit), AuthorityPermit.encode(permit));
	}
};
var AuthorityPermitAuthenticator = class {
	source;
	constructor(source) {
		this.source = source;
	}
	async authenticate(candidate, expected) {
		if (!candidate.expectation.equals(expected)) throw denied$2("Authority permit does not match the target expectation");
		const canonicalBytes = await this.source.issued(expected.issuer, candidate.nonce, candidate.digest());
		if (canonicalBytes === void 0) throw denied$2("Authority permit has no authenticated issuer record");
		let canonical;
		try {
			canonical = AuthorityPermit.decode(canonicalBytes);
		} catch {
			throw denied$2("Authority permit issuer record is malformed");
		}
		if (!canonical.expectation.equals(expected) || !bytesEqual(AuthorityPermit.encode(canonical), AuthorityPermit.encode(candidate))) throw denied$2("Authority permit differs from its authenticated issuer record");
		return new AuthenticatedAuthorityPermit(authenticationIssuer, canonical);
	}
};
function requireAuthenticatedAuthorityPermit(authentication, permit) {
	if (!issuedAuthentications.has(authentication) || !AuthenticatedAuthorityPermit.prototype.matches.call(authentication, permit)) throw denied$2("Authority permit lacks authenticated issuer evidence");
}
function denied$2(message) {
	return new AgentCoreError("authority.denied", message);
}
//#endregion
//#region src/authority/permit-store.ts
var AuthorityPermitIssuer = class {
	store;
	constructor(store) {
		this.store = store;
	}
	issue(transaction, request, evidence, issuedAt) {
		const issuedAtTime = issuedAt.getTime();
		if (!Number.isSafeInteger(issuedAtTime) || issuedAtTime < 0) throw new TypeError("Authority permit issuance time is invalid");
		this.requireProjectedLeaseEvidence(transaction, request, issuedAt);
		if (request.expiresAt.getTime() <= issuedAtTime) throw denied$1("Authority permit request expiry must be after issuance");
		if (!evidence.allowed || !evidence.binds(request.authority) || !evidence.issuer.equals(request.expectation.issuer) || !evidence.issuerTenant.equals(request.expectation.tenant) || evidence.checkedAt.getTime() !== issuedAtTime || !evidence.pathEpochs.equals(request.expectation.pathEpochs)) throw new AgentCoreError("protocol.invalid-state", "Authority permit issuance requires exact allowed Tenant evidence");
		const existing = this.store.issued(transaction, request.nonce);
		if (existing !== void 0) {
			if (!existing.expectation.equals(request.expectation) || !existing.requestDigest.equals(request.digest()) || existing.expiresAt.getTime() !== request.expiresAt.getTime()) throw denied$1("Authority permit nonce is bound to another issuance expectation");
			return existing;
		}
		return this.store.issue(transaction, new AuthorityPermit({
			...request.expectation,
			nonce: request.nonce,
			requestDigest: request.digest(),
			issuedAt,
			expiresAt: request.expiresAt
		}));
	}
	requireProjectedLeaseEvidence(transaction, request, issuedAt) {
		const reference = request.leaseEvidence;
		const lease = request.expectation.lease;
		if (lease === void 0) {
			if (reference !== void 0) throw new AgentCoreError("protocol.invalid-state", "Unleased authority permit request carries lease evidence");
			return;
		}
		if (reference === void 0) return;
		const projected = this.store.projectedEvidence(transaction, reference);
		if (projected === void 0 || !projected.digest().equals(reference.digest) || !projected.matches({
			key: reference.key,
			tenant: request.expectation.tenant,
			run: request.expectation.reservation.run,
			lease,
			target: request.expectation.target,
			requestIdentity: request.identity()
		}) || !projected.isCurrentAt(issuedAt) || request.expiresAt.getTime() > projected.deadline.getTime() || request.expectation.pathEpochs.path.some((entry) => projected.watermark.epoch(entry.scope) > entry.epoch)) throw denied$1("Authority permit source lease evidence is stale or substituted");
	}
};
var AuthorityPermitAdmissionPort = class {};
var StoredAuthorityPermitAdmissionPort = class extends AuthorityPermitAdmissionPort {
	store;
	constructor(store) {
		super();
		this.store = store;
	}
	consume(transaction, authentication, permit, expected, now) {
		this.store.consume(transaction, authentication, permit, expected, now);
	}
};
function denied$1(message) {
	return new AgentCoreError("authority.denied", message);
}
//#endregion
//#region src/authority/binding-evidence.ts
var BindingValidationRequestCodec = class extends RecordCodec {
	constructor() {
		super([
			BindingValidationRequest,
			ActorRef,
			ScopeRef,
			TextId,
			FacetRef,
			BindingName,
			ActorId,
			TenantId,
			WorkspaceId,
			GrantId,
			ProjectId,
			FacetPackageId,
			ProtectionDomain
		], "authority.binding-validation-request", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(record) {
		return record.toData();
	}
	decodePayload(payload) {
		return BindingValidationRequest.fromData(payload);
	}
};
var BindingValidationRequest = class BindingValidationRequest {
	static get codec() {
		return bindingValidationRequestCodecInstance;
	}
	domain;
	constructor(init) {
		if (init.workspaceActor.kind !== "workspace" || init.scope.kind !== "workspace") throw new TypeError("Binding validation requires a Workspace Actor and Scope");
		if (!Number.isSafeInteger(init.workspaceFence) || init.workspaceFence < 0) throw new TypeError("Binding validation fence is invalid");
		if (init.nonce.length === 0 || init.nonce !== init.nonce.trim()) throw new TypeError("Binding validation nonce must be canonical and nonblank");
		this.ownerTenant = init.ownerTenant;
		this.workspaceActor = init.workspaceActor;
		this.workspaceFence = init.workspaceFence;
		this.scope = init.scope;
		this.domain = Object.freeze(new ProtectionDomain(init.domain.kind, init.domain.label, init.domain.secretPolicy));
		this.name = init.name;
		this.grantId = init.grantId;
		this.facet = init.facet;
		this.nonce = init.nonce;
		Object.freeze(this);
	}
	ownerTenant;
	workspaceActor;
	workspaceFence;
	scope;
	name;
	grantId;
	facet;
	nonce;
	digest() {
		return Digest.sha256(encodeCanonicalJson(this.toData()));
	}
	static encode(record) {
		return BindingValidationRequest.codec.encode(record);
	}
	static decode(bytes) {
		return BindingValidationRequest.codec.decode(bytes);
	}
	toData() {
		return {
			domain: encodeDomain(this.domain),
			facet: this.facet.value,
			grantId: this.grantId.value,
			name: this.name.value,
			nonce: this.nonce,
			ownerTenant: this.ownerTenant.value,
			scope: encodeAuthorityScope(this.scope),
			workspaceActor: {
				id: this.workspaceActor.id.value,
				kind: this.workspaceActor.kind
			},
			workspaceFence: this.workspaceFence
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Binding validation request");
		requireExact(object, [
			"domain",
			"facet",
			"grantId",
			"name",
			"nonce",
			"ownerTenant",
			"scope",
			"workspaceActor",
			"workspaceFence"
		], "Binding validation request");
		const workspaceActor = requireObject(object["workspaceActor"], "Binding Workspace Actor");
		requireExact(workspaceActor, ["id", "kind"], "Binding Workspace Actor");
		return new BindingValidationRequest({
			ownerTenant: new TenantId(requireString(object, "ownerTenant")),
			workspaceActor: new ActorRef(requireActorKind(workspaceActor["kind"]), new ActorId(requireString(workspaceActor, "id"))),
			workspaceFence: requireSafeInteger(object, "workspaceFence"),
			scope: decodeAuthorityScope(object["scope"]),
			domain: decodeDomain(object["domain"]),
			name: new BindingName(requireString(object, "name")),
			grantId: new GrantId(requireString(object, "grantId")),
			facet: new FacetRef(requireString(object, "facet")),
			nonce: requireString(object, "nonce")
		});
	}
};
var bindingValidationRequestCodecInstance = new BindingValidationRequestCodec();
var BindingValidationEvidenceCodec = class extends RecordCodec {
	constructor() {
		super([
			BindingValidationEvidence,
			ActorRef,
			GuestVerificationScheme,
			ScopeRef,
			TextId,
			PathEpochEvidence,
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
		], "authority.binding-validation-evidence", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(record) {
		return record.toData();
	}
	decodePayload(payload) {
		return BindingValidationEvidence.fromData(payload);
	}
};
var BindingValidationEvidence = class BindingValidationEvidence {
	issuerTenant;
	issuer;
	requestDigest;
	scope;
	grantId;
	pathEpochs;
	static get codec() {
		return bindingValidationEvidenceCodecInstance;
	}
	#checkedAt;
	subject;
	constructor(issuerTenant, issuer, requestDigest, scope, subject, grantId, pathEpochs, checkedAt) {
		this.issuerTenant = issuerTenant;
		this.issuer = issuer;
		this.requestDigest = requestDigest;
		this.scope = scope;
		this.grantId = grantId;
		this.pathEpochs = pathEpochs;
		const time = checkedAt.getTime();
		if (!Number.isSafeInteger(time) || time < 0) throw new TypeError("Binding validation time is invalid");
		if (scope.kind !== "workspace" || !scope.equals(pathEpochs.target.scope)) throw new TypeError("Binding validation path must end at its Workspace Scope");
		if (issuer.kind !== "tenant") throw new TypeError("Binding validation evidence must be issued by a Tenant Actor");
		if (!issuerTenant.equals(scope.tenantId)) throw new TypeError("Binding validation issuer Tenant must match its Scope");
		requireSubjectTenant(subject, issuerTenant, "Binding validation evidence");
		this.subject = decodeAuthoritySubject(encodeAuthoritySubject(subject));
		this.#checkedAt = time;
		Object.freeze(this);
	}
	static encode(record) {
		return BindingValidationEvidence.codec.encode(record);
	}
	static decode(bytes) {
		return BindingValidationEvidence.codec.decode(bytes);
	}
	get checkedAt() {
		return new Date(this.#checkedAt);
	}
	binds(request) {
		return this.requestDigest.equals(request.digest()) && this.issuerTenant.equals(request.ownerTenant) && this.scope.equals(request.scope) && this.grantId.equals(request.grantId);
	}
	toData() {
		return {
			checkedAt: this.#checkedAt,
			grantId: this.grantId.value,
			issuer: {
				id: this.issuer.id.value,
				kind: this.issuer.kind
			},
			issuerTenant: this.issuerTenant.value,
			pathEpochs: this.pathEpochs.toData(),
			requestDigest: this.requestDigest.value,
			scope: encodeAuthorityScope(this.scope),
			subject: encodeAuthoritySubject(this.subject)
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Binding validation evidence");
		requireExact(object, [
			"checkedAt",
			"grantId",
			"issuer",
			"issuerTenant",
			"pathEpochs",
			"requestDigest",
			"scope",
			"subject"
		], "Binding validation evidence");
		const issuer = requireObject(object["issuer"], "Binding validation issuer");
		requireExact(issuer, ["id", "kind"], "Binding validation issuer");
		return new BindingValidationEvidence(new TenantId(requireString(object, "issuerTenant")), new ActorRef(requireActorKind(issuer["kind"]), new ActorId(requireString(issuer, "id"))), new Digest(requireString(object, "requestDigest")), decodeAuthorityScope(object["scope"]), decodeAuthoritySubject(object["subject"]), new GrantId(requireString(object, "grantId")), PathEpochEvidence.fromData(object["pathEpochs"]), new Date(requireSafeInteger(object, "checkedAt")));
	}
};
var bindingValidationEvidenceCodecInstance = new BindingValidationEvidenceCodec();
function requireActorKind(value) {
	if (value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate") return value;
	throw new TypeError("Binding validation Actor kind is invalid");
}
//#endregion
//#region src/authority/materializer.ts
var RoleGrantMaterialization = class {
	desiredRecords;
	changedRecords;
	affectedScopes;
	constructor(desiredRecords, changedRecords, affectedScopes) {
		this.desiredRecords = canonicalGrants(desiredRecords);
		this.changedRecords = canonicalGrants(changedRecords);
		this.affectedScopes = Object.freeze([...affectedScopes].sort((left, right) => compareCanonicalText(scopeKey(left), scopeKey(right))));
		Object.freeze(this);
	}
	get semanticNoop() {
		return this.changedRecords.length === 0;
	}
};
var RoleGrantMaterializer = class {
	materialize(input) {
		if (!input.membership.role.equals(input.role.name)) throw new AgentCoreError("protocol.invalid-state", "Membership role and materialized Role must match");
		if (input.membership.subject.kind === "foreign" && input.membership.subject.verifiedVia.value === "handshake") throw new AgentCoreError("authority.denied", "Handshake is a guest bootstrap scheme and cannot materialize Grants");
		const membershipId = input.membership.id;
		const owned = input.existing.filter((grant) => grant.origin.kind === "role" && grant.origin.membershipId.equals(membershipId));
		if (new Set(owned.map((grant) => grant.id.value)).size !== owned.length) throw new AgentCoreError("protocol.invalid-state", "Role materialization input contains duplicate Grant IDs");
		const desiredActiveRecords = input.membership.isActive ? materializeActive(input.membership, input.role) : [];
		const ownedById = new Map(owned.map((grant) => [grant.id.value, grant]));
		const desiredActive = desiredActiveRecords.map((record) => {
			return ownedById.get(record.id.value)?.isLive === false ? record.revoke() : record;
		});
		const activeIds = new Set(desiredActive.map((grant) => grant.id.value));
		const obsolete = owned.filter((grant) => !activeIds.has(grant.id.value)).map((grant) => grant.revoke());
		const desiredRecords = [...desiredActive, ...obsolete];
		const previousById = new Map(owned.map((grant) => [grant.id.value, grant]));
		const changedRecords = desiredRecords.filter((record) => {
			const previous = previousById.get(record.id.value);
			return previous === void 0 || !bytesEqual(Grant.encode(previous), Grant.encode(record));
		});
		const affected = /* @__PURE__ */ new Map();
		for (const changed of changedRecords) affected.set(scopeKey(changed.scope), changed.scope);
		return new RoleGrantMaterialization(desiredRecords, changedRecords, [...affected.values()]);
	}
};
function materializeActive(membership, role) {
	const guest = membership.subject.kind === "foreign";
	if (guest && membership.guestVerification === void 0) return [];
	const records = [];
	role.rules.forEach((rule, ruleOrdinal) => {
		const capability = roleCapability(rule);
		if (guest && rule.effect === "allow" && capability.grantsElevation()) return;
		records.push(new Grant(GrantId.forRole(membership.id, ruleOrdinal), membership.scope, membership.subject, rule.effect, capability, {
			kind: "role",
			membershipId: membership.id,
			roleName: role.name.value,
			ruleOrdinal,
			guest
		}));
	});
	return records;
}
function roleCapability(rule) {
	return rule.capability;
}
function canonicalGrants(grants) {
	const ordered = [...grants].sort((left, right) => compareCanonicalText(left.id.value, right.id.value));
	if (new Set(ordered.map((grant) => grant.id.value)).size !== ordered.length) throw new AgentCoreError("protocol.invalid-state", "Role materialization output Grant IDs must be unique");
	return Object.freeze(ordered);
}
//#endregion
//#region src/authority/planner.ts
var EpochPlan = class {
	next;
	bumped;
	affectedScopes;
	constructor(next, bumped) {
		this.next = canonicalEpochs(next);
		this.bumped = canonicalEpochs(bumped);
		this.affectedScopes = Object.freeze(this.bumped.map((entry) => entry.scope));
		Object.freeze(this);
	}
};
var EpochPlanner = class {
	plan(current, mutations) {
		const currentByScope = /* @__PURE__ */ new Map();
		for (const entry of current) {
			const key = scopeKey(entry.scope);
			if (currentByScope.has(key)) throw new AgentCoreError("protocol.invalid-state", "Current Scope epochs must be unique");
			currentByScope.set(key, entry);
		}
		const affected = /* @__PURE__ */ new Map();
		for (const mutation of mutations) for (const scope of mutationScopes(mutation)) affected.set(scopeKey(scope), scope);
		const bumped = [];
		for (const [key, scope] of affected) {
			const next = (currentByScope.get(key) ?? ScopeEpoch.initial(scope)).next();
			currentByScope.set(key, next);
			bumped.push(next);
		}
		return new EpochPlan([...currentByScope.values()], bumped);
	}
};
function mutationScopes(mutation) {
	switch (mutation.kind) {
		case "grant": return [mutation.scope];
		case "membership":
		case "role":
		case "teamClosure":
		case "principalClosure":
		case "guestVerification":
		case "topology":
		case "lifecycle":
		case "policy":
		case "trust":
		case "bindingTransition": return mutation.affectedScopes;
		default: return assertNever(mutation);
	}
}
function canonicalEpochs(entries) {
	const ordered = [...entries].sort((left, right) => compareCanonicalText(scopeKey(left.scope), scopeKey(right.scope)));
	if (new Set(ordered.map((entry) => scopeKey(entry.scope))).size !== ordered.length) throw new AgentCoreError("protocol.invalid-state", "Epoch plan Scopes must be unique");
	return Object.freeze(ordered);
}
function assertNever(value) {
	throw new AgentCoreError("protocol.invalid-state", `Unknown authority mutation ${String(value)}`);
}
//#endregion
//#region src/authority/closure.ts
/** The records of one kind a transaction wrote, keyed by the store's own record key. */
var AuthorityRecordChanges = class {
	#written = /* @__PURE__ */ new Map();
	#replaced = /* @__PURE__ */ new Set();
	record(key, value, presence) {
		if (!this.#written.has(key) && presence === "replaced") this.#replaced.add(key);
		this.#written.set(key, value);
	}
	written() {
		return [...this.#written.values()];
	}
	replaced() {
		return [...this.#written].filter(([key]) => this.#replaced.has(key)).map(([, value]) => value);
	}
	isCreated(key) {
		return this.#written.has(key) && !this.#replaced.has(key);
	}
};
/**
* What one transaction wrote. Principals and the Tenant record are absent because no
* cross-record invariant reads their content — only that they exist, which a write can
* only make more true.
*/
var AuthorityChangeSet = class {
	teams = new AuthorityRecordChanges();
	projects = new AuthorityRecordChanges();
	workspaces = new AuthorityRecordChanges();
	guestTrusts = new AuthorityRecordChanges();
	roles = new AuthorityRecordChanges();
	memberships = new AuthorityRecordChanges();
	grants = new AuthorityRecordChanges();
	bindings = new AuthorityRecordChanges();
	shareOffers = new AuthorityRecordChanges();
	/** Nothing points at a Scope epoch, so stores record every epoch write as replaced. */
	epochs = new AuthorityRecordChanges();
};
/**
* Re-derives every invariant that spans more than one Tenant authority record: Scope
* canonicality, subject and Role existence, guest trust evidence, Binding-to-Grant
* closure, attenuation acyclicity, share offer redemption evidence, and Role Grant
* materialization equality. Both the Memory store and the SQLite ledger call it, so one
* implementation decides what a consistent Tenant is on either backing.
*
* Passing the transaction's `changed` records audits those records and the ones whose
* validity their change can break; passing nothing sweeps the whole store, which is what
* opening or restoring a store does.
*/
function assertAuthorityClosure(store, changed) {
	new AuthorityClosure(store, changed).assert();
}
/**
* The audit, plus the store lists it had to read to run. Each list is fetched at most
* once and only when an incremental audit needs to search for records that point at a
* changed one — which is why a transaction that only creates records reads no lists.
*/
var AuthorityClosure = class {
	store;
	changed;
	#materializer = new RoleGrantMaterializer();
	#allGrants;
	#allBindings;
	#allMemberships;
	constructor(store, changed) {
		this.store = store;
		this.changed = changed;
	}
	assert() {
		for (const team of this.#auditedTeams()) this.#assertTeam(team);
		for (const project of this.#auditedProjects()) this.#requireLocalTenant(project.tenantId, "Project");
		for (const workspace of this.#auditedWorkspaces()) this.#assertWorkspace(workspace);
		for (const trust of this.#auditedGuestTrusts()) this.#requireLocalTenant(trust.hostTenant, "Guest trust");
		for (const membership of this.#auditedMemberships()) this.#assertMembership(membership);
		for (const grant of this.#auditedGrants()) this.#assertGrant(grant);
		for (const binding of this.#auditedBindings()) this.#assertBinding(binding);
		for (const offer of this.#auditedShareOffers()) this.#assertShareOffer(offer);
		for (const epoch of this.#auditedEpochs()) this.#requireCanonicalScope(epoch.scope);
		for (const membership of this.#materializedMemberships()) this.#assertMaterialization(membership);
	}
	#assertTeam(team) {
		this.#requireLocalTenant(team.tenantId, "Team");
		for (const principal of team.principals) if (this.store.principal(principal) === void 0) throw corruptAuthorityClosure("Team references a missing Principal");
	}
	#assertWorkspace(workspace) {
		this.#requireLocalTenant(workspace.tenantId, "Workspace");
		if (workspace.projectId !== void 0 && this.store.project(workspace.projectId) === void 0) throw corruptAuthorityClosure("Workspace references a missing Project");
	}
	#assertMembership(membership) {
		this.#requireCanonicalScope(membership.scope);
		if (this.store.role(membership.role) === void 0) throw corruptAuthorityClosure("Membership references a missing Role");
		if (membership.subject.kind === "principal" && this.store.principal(membership.subject.principal.principalId) === void 0) throw corruptAuthorityClosure("Membership references a missing Principal");
		if (membership.subject.kind === "team" && this.store.team(membership.subject.teamId) === void 0) throw corruptAuthorityClosure("Membership references a missing Team");
		if (membership.subject.kind !== "foreign") return;
		const verification = membership.guestVerification;
		const trust = verification === void 0 ? void 0 : this.store.guestTrust(verification.trustId);
		if (verification === void 0 || trust === void 0 || !trust.hostTenant.equals(this.store.tenantId) || !trust.homeTenant.equals(membership.subject.homeTenant) || membership.state === "active" && (trust.revision.value !== verification.trustRevision.value || trust.verifier.kind !== verification.verifiedVia.value || !trust.isActive)) throw corruptAuthorityClosure("Guest Membership references invalid trust evidence");
	}
	#assertGrant(grant) {
		this.#requireCanonicalScope(grant.scope);
		if (grant.subject.kind === "principal" && this.store.principal(grant.subject.principal.principalId) === void 0) throw corruptAuthorityClosure("Grant references a missing Principal");
		if (grant.subject.kind === "team" && this.store.team(grant.subject.teamId) === void 0) throw corruptAuthorityClosure("Grant references a missing Team");
		if (grant.origin.kind === "role") {
			const membership = this.store.membership(grant.origin.membershipId);
			if (membership === void 0 || membership.role.value !== grant.origin.roleName || subjectKey(membership.subject) !== subjectKey(grant.subject)) throw corruptAuthorityClosure("Role Grant references invalid Membership evidence");
		}
		const seen = /* @__PURE__ */ new Set([grant.id.value]);
		let child = grant;
		while (child.attenuationOf !== void 0) {
			if (seen.has(child.attenuationOf.value)) throw corruptAuthorityClosure("Delegated Grant attenuation contains a cycle");
			seen.add(child.attenuationOf.value);
			const parent = this.store.grant(child.attenuationOf);
			if (parent === void 0 || !parent.canAttenuate(child)) throw corruptAuthorityClosure("Delegated Grant references invalid parent authority");
			child = parent;
		}
	}
	#assertBinding(binding) {
		this.#requireCanonicalScope(binding.scope);
		const grant = this.store.grant(binding.grantId);
		if (grant === void 0 || grant.effect !== "allow" || subjectKey(grant.subject) !== subjectKey(binding.subject) || !binding.scope.path.some((scope) => scope.equals(grant.scope))) throw corruptAuthorityClosure("Binding references invalid Tenant authority");
	}
	/**
	* An offer names a canonical Scope and an existing Role, and every redemption it
	* records names the Membership that redemption minted at that exact Scope for exactly
	* the holder it records. A Membership may later revise its Role or lifecycle, so the
	* offer never constrains either; its subject and Scope are the immutable evidence an
	* offer retains. A Membership is never deleted, so only writing the offer can break
	* these — which is why no other written kind pulls offers into an incremental audit.
	*/
	#assertShareOffer(offer) {
		this.#requireCanonicalScope(offer.scope);
		if (this.store.role(offer.role) === void 0) throw corruptAuthorityClosure("Share offer references a missing Role");
		for (const redemption of offer.redemptions) {
			const membership = this.store.membership(redemption.membership);
			if (membership === void 0 || !membership.scope.equals(offer.scope) || subjectKey(membership.subject) !== subjectKey(redemption.subject)) throw corruptAuthorityClosure("Share offer redemption references invalid Membership evidence");
		}
	}
	#assertMaterialization(membership) {
		const role = this.store.role(membership.role);
		if (role === void 0) throw corruptAuthorityClosure("Membership references a missing Role");
		const owned = this.#ownedRoleGrants(membership);
		const expected = this.#materializer.materialize({
			membership,
			role,
			existing: owned
		}).desiredRecords;
		if (expected.length !== owned.length || expected.some((record) => {
			const actual = owned.find((candidate) => candidate.id.equals(record.id));
			return actual === void 0 || !bytesEqual(Grant.encode(actual), Grant.encode(record));
		})) throw corruptAuthorityClosure("Role Grant materialization does not match Membership evidence");
	}
	/**
	* Every Grant the Membership owns. A Membership created inside the transaction can
	* only be named by Grants the same transaction wrote: the closure held before it
	* opened, and a Role Grant is only valid while its Membership exists.
	*/
	#ownedRoleGrants(membership) {
		return (this.changed?.memberships.isCreated(membership.id.value) === true ? this.changed.grants.written() : this.#grants()).filter((grant) => grant.origin.kind === "role" && grant.origin.membershipId.equals(membership.id));
	}
	#auditedTeams() {
		return this.changed === void 0 ? this.store.teams() : this.changed.teams.written();
	}
	#auditedProjects() {
		return this.changed === void 0 ? this.store.projects() : this.changed.projects.written();
	}
	#auditedWorkspaces() {
		return this.changed === void 0 ? this.store.workspaces() : this.changed.workspaces.written();
	}
	#auditedGuestTrusts() {
		return this.changed === void 0 ? this.store.guestTrusts() : this.changed.guestTrusts.written();
	}
	#auditedShareOffers() {
		return this.changed === void 0 ? this.store.shareOffers() : this.changed.shareOffers.written();
	}
	#auditedEpochs() {
		return this.changed === void 0 ? this.store.epochs() : this.changed.epochs.written();
	}
	/** Written Memberships, plus the guest Memberships a replaced trust can invalidate. */
	#auditedMemberships() {
		if (this.changed === void 0) return this.#memberships();
		const rotated = new Set(this.changed.guestTrusts.replaced().map((trust) => trust.id.value));
		return distinct([...this.changed.memberships.written(), ...rotated.size === 0 ? [] : this.#memberships().filter((membership) => membership.guestVerification !== void 0 && rotated.has(membership.guestVerification.trustId.value))], (membership) => membership.id.value);
	}
	/** Written Grants, plus every Grant attenuating from a replaced one. */
	#auditedGrants() {
		if (this.changed === void 0) return this.#grants();
		const written = this.changed.grants.written();
		const replaced = this.changed.grants.replaced();
		if (replaced.length === 0) return written;
		const children = /* @__PURE__ */ new Map();
		for (const grant of this.#grants()) {
			if (grant.attenuationOf === void 0) continue;
			const siblings = children.get(grant.attenuationOf.value) ?? [];
			siblings.push(grant);
			children.set(grant.attenuationOf.value, siblings);
		}
		const descendants = [];
		const visited = new Set(replaced.map((grant) => grant.id.value));
		let frontier = replaced;
		while (frontier.length > 0) {
			const next = [];
			for (const parent of frontier) for (const child of children.get(parent.id.value) ?? []) {
				if (visited.has(child.id.value)) continue;
				visited.add(child.id.value);
				descendants.push(child);
				next.push(child);
			}
			frontier = next;
		}
		return distinct([...written, ...descendants], (grant) => grant.id.value);
	}
	/** Written Bindings, plus every Binding naming a replaced Grant. */
	#auditedBindings() {
		if (this.changed === void 0) return this.#bindings();
		const replaced = new Set(this.changed.grants.replaced().map((grant) => grant.id.value));
		return distinct([...this.changed.bindings.written(), ...replaced.size === 0 ? [] : this.#bindings().filter((binding) => replaced.has(binding.grantId.value))], (binding) => binding.key);
	}
	/**
	* Written Memberships, the Memberships that own a written Role Grant, and every
	* Membership a replaced Role re-materializes.
	*/
	#materializedMemberships() {
		if (this.changed === void 0) return this.#memberships();
		const owners = [];
		for (const grant of this.changed.grants.written()) {
			if (grant.origin.kind !== "role") continue;
			const membership = this.store.membership(grant.origin.membershipId);
			if (membership !== void 0) owners.push(membership);
		}
		const roles = new Set(this.changed.roles.replaced().map((role) => role.name.value));
		return distinct([
			...this.changed.memberships.written(),
			...owners,
			...roles.size === 0 ? [] : this.#memberships().filter((membership) => roles.has(membership.role.value))
		], (membership) => membership.id.value);
	}
	#grants() {
		this.#allGrants ??= this.store.grants();
		return this.#allGrants;
	}
	#bindings() {
		this.#allBindings ??= this.store.bindings();
		return this.#allBindings;
	}
	#memberships() {
		this.#allMemberships ??= this.store.memberships();
		return this.#allMemberships;
	}
	/** A record owned by another Tenant is a boundary fault, not a decoding one. */
	#requireLocalTenant(tenantId, subject) {
		if (!tenantId.equals(this.store.tenantId)) throw new AgentCoreError("protocol.invalid-state", `${subject} belongs to another Tenant`);
	}
	#requireCanonicalScope(scope) {
		this.#requireLocalTenant(scope.tenantId, "Authority Scope");
		if (scope.kind === "project" && (scope.projectId === void 0 || this.store.project(scope.projectId) === void 0)) throw corruptAuthorityClosure("Authority Project Scope is not canonical");
		if (scope.kind !== "workspace") return;
		const workspace = scope.workspaceId === void 0 ? void 0 : this.store.workspace(scope.workspaceId);
		if (workspace === void 0 || !workspace.scope.equals(scope)) throw corruptAuthorityClosure("Authority Workspace Scope is not canonical");
	}
};
function distinct(records, key) {
	return [...new Map(records.map((record) => [key(record), record])).values()];
}
function corruptAuthorityClosure(message) {
	return new AgentCoreError("codec.invalid", message);
}
//#endregion
//#region src/authority/service.ts
function createTenantControlBootstrapPlan(anchor, expectedRevision) {
	if (expectedRevision.value !== Revision.initial().value) throw new AgentCoreError("protocol.revision-conflict", "Tenant bootstrap requires the initial authorization revision");
	if (!(anchor.actorId instanceof ActorId) || !(anchor.trustAnchor instanceof Uint8Array) || anchor.trustAnchor.byteLength === 0) throw new AgentCoreError("protocol.invalid-state", "Tenant bootstrap anchor is malformed");
	const tenantScope = ScopeRef.tenant(anchor.tenantId);
	const owner = new Principal(anchor.principalId, "user", "active");
	const tenant = new Tenant(anchor.tenantId, anchor.tenantKind ?? "personal", "active", expectedRevision);
	const ownerMembership = new Membership(deterministicOwnerMembershipId(anchor), tenantScope, SubjectRef.principal(new PrincipalRef(anchor.tenantId, anchor.principalId)), OWNER_ROLE.name, "active", Revision.initial());
	const materialization = new RoleGrantMaterializer().materialize({
		membership: ownerMembership,
		role: OWNER_ROLE,
		existing: []
	});
	const epochPlan = new EpochPlanner().plan([], [{
		kind: "membership",
		affectedScopes: [tenantScope]
	}]);
	return Object.freeze({
		tenant,
		owner,
		ownerMembership,
		roles: BUILT_IN_ROLES,
		grants: materialization.desiredRecords,
		epochs: epochPlan.bumped
	});
}
function deterministicOwnerMembershipId(anchor) {
	return new MembershipId(`bootstrap:${Digest.sha256(encodeCanonicalJson({
		actorId: anchor.actorId.value,
		principalId: anchor.principalId.value,
		tenantId: anchor.tenantId.value,
		trustAnchor: encodeBase64(anchor.trustAnchor)
	})).value}`);
}
//#endregion
//#region src/authority/memory.ts
/** Version 2 added Tenant-owned canonical Binding records; version 1 snapshots predate them. */
var SNAPSHOT_VERSION = 2;
var IDENTITY_SNAPSHOT_VERSION = 1;
/** Actor-local reference store. It is intentionally absent from the authority package surface. */
var MemoryTenantControlStore = class MemoryTenantControlStore {
	#identity;
	#grants;
	#bindings;
	#epochs;
	#anchor;
	#changes = new AuthorityChangeSet();
	#marker;
	#writable = false;
	#transactionActive = false;
	tenantId;
	constructor(snapshot) {
		requireSnapshot(snapshot);
		this.#anchor = copyAnchorSnapshot(snapshot.anchor);
		this.tenantId = this.#anchor.tenantId;
		this.#marker = snapshot.marker === null ? null : copyMarkerSnapshot(snapshot.marker);
		const identity = new MemoryIdentityRepository(snapshot.identity).snapshot();
		this.#identity = new Map(identity.records.map((record) => [identityKey(record.kind, record.id), copyIdentityRecord(record)]));
		this.#grants = loadRecords(snapshot.grants, Grant.decode, (record) => record.id.value, "Grant");
		this.#bindings = loadRecords(snapshot.bindings, Binding.decode, (record) => record.key, "Binding");
		this.#epochs = loadRecords(snapshot.epochs, ScopeEpoch.decode, (record) => scopeKey(record.scope), "Scope epoch");
		this.assertRestoredState();
	}
	static create(anchor) {
		return new MemoryTenantControlStore(Object.freeze({
			version: SNAPSHOT_VERSION,
			anchor: anchorSnapshot(anchor),
			marker: null,
			identity: Object.freeze({
				version: IDENTITY_SNAPSHOT_VERSION,
				records: Object.freeze([])
			}),
			grants: Object.freeze([]),
			bindings: Object.freeze([]),
			epochs: Object.freeze([])
		}));
	}
	static restore(snapshot) {
		return new MemoryTenantControlStore(snapshot);
	}
	bootstrapAnchor() {
		return Object.freeze({
			actorId: this.#anchor.actorId,
			tenantId: this.#anchor.tenantId,
			principalId: this.#anchor.principalId,
			tenantKind: this.#anchor.tenantKind,
			trustAnchor: this.#anchor.trustAnchor.slice()
		});
	}
	bootstrapMarker() {
		if (this.#marker === null) return void 0;
		return Object.freeze({
			tenantId: this.#marker.tenantId,
			ownerPrincipalId: this.#marker.ownerPrincipalId,
			revision: new Revision(this.#marker.revision)
		});
	}
	isBootstrapEligible() {
		return this.#marker === null && this.#identity.size === 0 && this.#grants.size === 0 && this.#bindings.size === 0 && this.#epochs.size === 0;
	}
	bootstrap(plan) {
		if (!this.isBootstrapEligible()) throw new AgentCoreError("protocol.invalid-state", "Tenant control is not bootstrap eligible");
		this.commit((candidate) => candidate.applyBootstrap(plan));
	}
	bootstrapTenant(anchor, expectedRevision) {
		if (!anchorsEqual(this.bootstrapAnchor(), anchor)) throw new AgentCoreError("protocol.invalid-state", "Tenant bootstrap request does not match its immutable anchor");
		this.bootstrap(createTenantControlBootstrapPlan(anchor, expectedRevision));
	}
	transaction(operation) {
		if (this.#marker === null) throw new AgentCoreError("protocol.invalid-state", "Tenant authority mutations require completed bootstrap");
		return this.commit(operation);
	}
	snapshot() {
		return Object.freeze({
			version: SNAPSHOT_VERSION,
			anchor: copyAnchorSnapshot(this.#anchor),
			marker: this.#marker === null ? null : copyMarkerSnapshot(this.#marker),
			identity: this.identitySnapshot(),
			grants: snapshotRecords(this.#grants),
			bindings: snapshotRecords(this.#bindings),
			epochs: snapshotRecords(this.#epochs)
		});
	}
	identitySnapshot() {
		return Object.freeze({
			version: IDENTITY_SNAPSHOT_VERSION,
			records: Object.freeze([...this.#identity.values()].sort((left, right) => compareCanonicalText(identityKey(left.kind, left.id), identityKey(right.kind, right.id))).map(copyIdentityRecord))
		});
	}
	tenant(id) {
		return this.identityRecord("tenant", id.value, Tenant.decode);
	}
	principal(id) {
		return this.identityRecord("principal", id.value, Principal.decode);
	}
	team(id) {
		return this.identityRecord("team", id.value, Team.decode);
	}
	teams() {
		return this.identityRecords("team", Team.decode);
	}
	project(id) {
		return this.identityRecord("project", id.value, Project.decode);
	}
	projects() {
		return this.identityRecords("project", Project.decode);
	}
	putProject(project) {
		this.requireWrite();
		if (!project.tenantId.equals(this.tenantId)) throw new AgentCoreError("protocol.invalid-state", "Project belongs to another Tenant");
		const previous = this.project(project.id);
		if (previous === void 0) {
			if (project.revision.value !== 0) throw new AgentCoreError("protocol.invalid-state", "New Projects require revision zero");
		} else if (project.revision.value !== previous.revision.value + 1) throw new AgentCoreError("protocol.revision-conflict", "Project updates require the next revision");
		this.putIdentity("project", project.id.value, Project.encode(project));
		this.#changes.projects.record(project.id.value, project, presence(previous));
	}
	workspace(id) {
		return this.identityRecord("workspace", id.value, Workspace.decode);
	}
	workspaces() {
		return this.identityRecords("workspace", Workspace.decode);
	}
	putWorkspace(workspace) {
		this.requireWrite();
		if (!workspace.tenantId.equals(this.tenantId)) throw new AgentCoreError("protocol.invalid-state", "Workspace belongs to another Tenant");
		if (this.workspace(workspace.id) !== void 0) throw new AgentCoreError("protocol.invalid-state", "Workspace topology is immutable");
		if (workspace.revision.value !== 0) throw new AgentCoreError("protocol.invalid-state", "New Workspaces require revision zero");
		this.putIdentity("workspace", workspace.id.value, Workspace.encode(workspace));
		this.#changes.workspaces.record(workspace.id.value, workspace, "created");
	}
	guestTrust(id) {
		return this.identityRecord("guestTrust", id.value, GuestTrust.decode);
	}
	guestTrusts() {
		return this.identityRecords("guestTrust", GuestTrust.decode);
	}
	putGuestTrust(trust) {
		this.requireWrite();
		if (!trust.hostTenant.equals(this.tenantId)) throw new AgentCoreError("protocol.invalid-state", "Guest trust belongs to another Tenant");
		const previous = this.guestTrust(trust.id);
		if (previous === void 0) {
			if (trust.revision.value !== 0 || !trust.isActive) throw new AgentCoreError("protocol.invalid-state", "New guest trust requires revision zero and active state");
		} else if (!previous.hostTenant.equals(trust.hostTenant) || !previous.homeTenant.equals(trust.homeTenant)) throw new AgentCoreError("protocol.revision-conflict", "Guest trust identity changed");
		else {
			if (bytesEqual(GuestTrust.encode(previous), GuestTrust.encode(trust))) return;
			previous.assertCanReplace(trust);
		}
		this.putIdentity("guestTrust", trust.id.value, GuestTrust.encode(trust));
		this.#changes.guestTrusts.record(trust.id.value, trust, presence(previous));
	}
	role(name) {
		return this.identityRecord("role", name.value, Role.decode);
	}
	roles() {
		return this.identityRecords("role", Role.decode);
	}
	membership(id) {
		return this.identityRecord("membership", id.value, Membership.decode);
	}
	memberships() {
		return this.identityRecords("membership", Membership.decode);
	}
	shareOffer(id) {
		return this.identityRecord("shareOffer", id.value, ShareOffer.decode);
	}
	shareOffers() {
		return this.identityRecords("shareOffer", ShareOffer.decode);
	}
	grant(id) {
		return decodeRecord(this.#grants, id.value, Grant.decode, (record) => record.id.value, "Grant");
	}
	grants() {
		return decodeRecords(this.#grants, Grant.decode, (record) => record.id.value, "Grant");
	}
	binding(key) {
		return decodeRecord(this.#bindings, key, Binding.decode, (record) => record.key, "Binding");
	}
	bindings() {
		return decodeRecords(this.#bindings, Binding.decode, (record) => record.key, "Binding");
	}
	epoch(scope) {
		return decodeRecord(this.#epochs, scopeKey(scope), ScopeEpoch.decode, (record) => scopeKey(record.scope), "Scope epoch") ?? ScopeEpoch.initial(scope);
	}
	epochs() {
		return decodeRecords(this.#epochs, ScopeEpoch.decode, (record) => scopeKey(record.scope), "Scope epoch");
	}
	putPrincipal(principal) {
		this.requireWrite();
		const previous = this.principal(principal.id);
		if (previous !== void 0) {
			if (previous.kind !== principal.kind) throw new AgentCoreError("protocol.invalid-state", "Principal kind is immutable");
			if (previous.status === "disabled" && principal.status !== "disabled") throw new AgentCoreError("protocol.invalid-state", "Disabled Principals cannot be reactivated");
		}
		this.putIdentity("principal", principal.id.value, Principal.encode(principal));
	}
	putTeam(team) {
		this.requireWrite();
		if (!team.tenantId.equals(this.tenantId)) throw new AgentCoreError("protocol.invalid-state", "Team belongs to another Tenant");
		const previous = this.team(team.id);
		if (previous === void 0) {
			if (team.revision.value !== 0) throw new AgentCoreError("protocol.invalid-state", "New Teams require revision zero");
		} else if (!previous.tenantId.equals(team.tenantId) || team.revision.value !== previous.revision.value + 1) throw new AgentCoreError("protocol.revision-conflict", "Team updates require the stored Tenant identity and next revision");
		this.putIdentity("team", team.id.value, Team.encode(team));
		this.#changes.teams.record(team.id.value, team, presence(previous));
	}
	putRole(role) {
		this.requireWrite();
		const previous = this.role(role.name);
		this.putIdentity("role", role.name.value, Role.encode(role));
		this.#changes.roles.record(role.name.value, role, presence(previous));
	}
	putMembership(membership) {
		this.requireWrite();
		requireCanonicalScope(this, membership.scope);
		const previous = this.membership(membership.id);
		if (previous === void 0) {
			if (membership.revision.value !== 0 || membership.state !== "active") throw new AgentCoreError("protocol.invalid-state", "New Memberships must be active at revision zero");
		} else if (!previous.scope.equals(membership.scope) || subjectKey(previous.subject) !== subjectKey(membership.subject) || membership.revision.value !== previous.revision.value + 1) throw new AgentCoreError("protocol.revision-conflict", "Membership subject and Scope are immutable and updates require the next revision");
		else if (previous.state === "revoked" && membership.state !== "revoked") throw new AgentCoreError("protocol.invalid-state", "Revoked Memberships cannot reactivate");
		else if (previous.state === "suspended" && membership.state === "active") throw new AgentCoreError("protocol.invalid-state", "Suspended Memberships require replacement rather than reactivation");
		this.putIdentity("membership", membership.id.value, Membership.encode(membership));
		this.#changes.memberships.record(membership.id.value, membership, presence(previous));
	}
	putShareOffer(offer) {
		this.requireWrite();
		requireCanonicalScope(this, offer.scope);
		const previous = this.shareOffer(offer.id);
		if (previous === void 0) {
			if (offer.revision.value !== 0 || !offer.isOpen || offer.redemptions.length !== 0) throw new AgentCoreError("protocol.invalid-state", "New share offers must be open and unredeemed at revision zero");
		} else {
			if (bytesEqual(ShareOffer.encode(previous), ShareOffer.encode(offer))) return;
			previous.assertCanReplace(offer);
		}
		this.putIdentity("shareOffer", offer.id.value, ShareOffer.encode(offer));
		this.#changes.shareOffers.record(offer.id.value, offer, presence(previous));
	}
	putGrant(record) {
		this.requireWrite();
		requireCanonicalScope(this, record.scope);
		const previous = this.grant(record.id);
		if (previous !== void 0) {
			if (bytesEqual(Grant.encode(previous), Grant.encode(record))) return;
			previous.assertCanReplace(record);
		}
		putCanonical(this.#grants, record.id.value, Grant.encode(record), Grant.decode, (value) => value.id.value, "Grant");
		this.#changes.grants.record(record.id.value, record, presence(previous));
	}
	putBinding(record) {
		this.requireWrite();
		requireCanonicalScope(this, record.scope);
		const previous = this.binding(record.key);
		if (previous === void 0) {
			if (record.generation !== 0 || record.revision.value !== 0) throw new AgentCoreError("protocol.revision-conflict", "New Bindings require generation and revision zero");
		} else {
			if (bytesEqual(Binding.encode(previous), Binding.encode(record))) return;
			previous.assertCanReplace(record);
		}
		putCanonical(this.#bindings, record.key, Binding.encode(record), Binding.decode, (value) => value.key, "Binding");
		this.#changes.bindings.record(record.key, record, presence(previous));
	}
	putEpoch(record) {
		this.requireWrite();
		requireCanonicalScope(this, record.scope);
		const key = scopeKey(record.scope);
		const previous = this.epoch(record.scope);
		if (record.epoch === previous.epoch) return;
		if (record.epoch !== previous.epoch + 1) throw new AgentCoreError("protocol.revision-conflict", "Scope epoch writes must advance exactly once");
		putCanonical(this.#epochs, key, ScopeEpoch.encode(record), ScopeEpoch.decode, (value) => scopeKey(value.scope), "Scope epoch");
		this.#changes.epochs.record(key, record, "replaced");
	}
	applyBootstrap(plan) {
		const anchor = this.bootstrapAnchor();
		if (!plan.tenant.id.equals(anchor.tenantId) || !plan.owner.id.equals(anchor.principalId) || plan.tenant.kind !== anchor.tenantKind || plan.tenant.authorizationRevision.value !== Revision.initial().value || plan.ownerMembership.scope.kind !== "tenant" || !plan.ownerMembership.scope.tenantId.equals(anchor.tenantId) || plan.ownerMembership.subject.kind !== "principal" || !plan.ownerMembership.subject.principal.principalId.equals(anchor.principalId) || !plan.ownerMembership.isActive || plan.ownerMembership.revision.value !== Revision.initial().value) throw new AgentCoreError("protocol.invalid-state", "Tenant bootstrap plan does not match its immutable anchor");
		if (new Set(plan.roles.map((role) => role.name.value)).size !== plan.roles.length || !plan.roles.some((role) => role.name.equals(plan.ownerMembership.role))) throw new AgentCoreError("protocol.invalid-state", "Tenant bootstrap Roles are invalid");
		this.putIdentity("tenant", plan.tenant.id.value, Tenant.encode(plan.tenant));
		this.putPrincipal(plan.owner);
		for (const role of plan.roles) this.putRole(role);
		this.putMembership(plan.ownerMembership);
		for (const grant of plan.grants) this.putGrant(grant);
		for (const epoch of plan.epochs) this.putEpoch(epoch);
		this.#marker = Object.freeze({
			tenantId: anchor.tenantId,
			ownerPrincipalId: anchor.principalId,
			revision: plan.tenant.authorizationRevision.value
		});
	}
	commit(operation) {
		if (this.#transactionActive) throw new AgentCoreError("protocol.invalid-state", "Nested Memory Tenant control transactions are not supported");
		this.#transactionActive = true;
		let candidate;
		try {
			candidate = MemoryTenantControlStore.restore(this.snapshot());
			candidate.#writable = true;
			const result = operation(candidate);
			if (isPromiseLike(result)) {
				if (result instanceof Promise) result.catch(() => void 0);
				throw new AgentCoreError("protocol.invalid-state", "Memory Tenant control transactions must be synchronous");
			}
			candidate.#writable = false;
			candidate.assertRestoredState(candidate.#changes);
			this.replace(candidate);
			return result;
		} finally {
			if (candidate !== void 0) candidate.#writable = false;
			this.#transactionActive = false;
		}
	}
	identityRecord(kind, id, decode) {
		const stored = this.#identity.get(identityKey(kind, id));
		return stored === void 0 ? void 0 : decode(stored.bytes.slice());
	}
	identityRecords(kind, decode) {
		return Object.freeze([...this.#identity.values()].filter((record) => record.kind === kind).sort((left, right) => compareCanonicalText(left.id, right.id)).map((record) => decode(record.bytes.slice())));
	}
	putIdentity(kind, id, bytes) {
		this.requireWrite();
		const record = copyIdentityRecord({
			kind,
			id,
			bytes
		});
		new MemoryIdentityRepository({
			version: IDENTITY_SNAPSHOT_VERSION,
			records: [record]
		});
		this.#identity.set(identityKey(kind, id), record);
	}
	requireWrite() {
		if (!this.#writable) throw new AgentCoreError("protocol.invalid-state", "Tenant control records can only change inside an owned transaction");
	}
	assertRestoredState(changed) {
		if (this.#marker === null) {
			if (!this.isBootstrapEligible()) throw corruptMemoryTenantControl("Unmarked Tenant control snapshot is not empty");
			return;
		}
		if (!this.#marker.tenantId.equals(this.#anchor.tenantId) || !this.#marker.ownerPrincipalId.equals(this.#anchor.principalId) || this.#marker.revision !== Revision.initial().value) throw corruptMemoryTenantControl("Tenant control marker does not match its anchor");
		const tenant = this.tenant(this.tenantId);
		const owner = this.principal(this.#anchor.principalId);
		const bootstrap = createTenantControlBootstrapPlan(this.bootstrapAnchor(), Revision.initial());
		if (tenant === void 0 || owner === void 0 || tenant.kind !== this.#anchor.tenantKind || tenant.authorizationRevision.value < this.#marker.revision || this.identityRecords("tenant", Tenant.decode).length !== 1 || this.membership(bootstrap.ownerMembership.id) === void 0 || bootstrap.roles.some((role) => this.role(role.name) === void 0) || bootstrap.grants.some((grant) => this.grant(grant.id) === void 0) || this.epoch(bootstrap.epochs[0].scope).epoch < bootstrap.epochs[0].epoch) throw corruptMemoryTenantControl("Bootstrapped Tenant identity closure is incomplete");
		assertAuthorityClosure(this, changed);
	}
	replace(candidate) {
		this.#identity = new Map([...candidate.#identity].map(([key, record]) => [key, copyIdentityRecord(record)]));
		this.#grants = copyMap(candidate.#grants);
		this.#bindings = copyMap(candidate.#bindings);
		this.#epochs = copyMap(candidate.#epochs);
		this.#marker = candidate.#marker === null ? null : copyMarkerSnapshot(candidate.#marker);
	}
};
function requireSnapshot(snapshot) {
	if (!isSnapshotObject(snapshot)) throw corruptMemoryTenantControl("Memory Tenant control snapshot is malformed");
	if (snapshot.version !== SNAPSHOT_VERSION) throw corruptMemoryTenantControl(`Memory Tenant control snapshots require version ${SNAPSHOT_VERSION}`);
	if (!hasExactKeys(snapshot, [
		"anchor",
		"bindings",
		"epochs",
		"grants",
		"identity",
		"marker",
		"version"
	]) || !Array.isArray(snapshot.grants) || !Array.isArray(snapshot.bindings) || !Array.isArray(snapshot.epochs) || snapshot.marker !== null && !isSnapshotObject(snapshot.marker)) throw corruptMemoryTenantControl("Memory Tenant control snapshot is malformed");
}
function anchorSnapshot(anchor) {
	return copyAnchorSnapshot({
		actorId: anchor.actorId,
		tenantId: anchor.tenantId,
		principalId: anchor.principalId,
		tenantKind: anchor.tenantKind ?? "personal",
		trustAnchor: anchor.trustAnchor
	});
}
function copyAnchorSnapshot(anchor) {
	if (!isSnapshotObject(anchor) || !hasExactKeys(anchor, [
		"actorId",
		"principalId",
		"tenantId",
		"tenantKind",
		"trustAnchor"
	]) || !(anchor.actorId instanceof ActorId) || !(anchor.tenantId instanceof TenantId) || !(anchor.principalId instanceof PrincipalId) || !(anchor.trustAnchor instanceof Uint8Array) || anchor.trustAnchor.byteLength === 0) throw corruptMemoryTenantControl("Memory Tenant control bootstrap anchor is malformed");
	requireTenantKind(anchor.tenantKind);
	return Object.freeze({
		...anchor,
		actorId: new ActorId(anchor.actorId.value),
		tenantId: new TenantId(anchor.tenantId.value),
		principalId: new PrincipalId(anchor.principalId.value),
		trustAnchor: anchor.trustAnchor.slice()
	});
}
function copyMarkerSnapshot(marker) {
	if (!isSnapshotObject(marker) || !hasExactKeys(marker, [
		"ownerPrincipalId",
		"revision",
		"tenantId"
	]) || !(marker.tenantId instanceof TenantId) || !(marker.ownerPrincipalId instanceof PrincipalId) || !Number.isSafeInteger(marker.revision) || marker.revision < 0) throw corruptMemoryTenantControl("Memory Tenant control bootstrap marker is malformed");
	return Object.freeze({
		...marker,
		tenantId: new TenantId(marker.tenantId.value),
		ownerPrincipalId: new PrincipalId(marker.ownerPrincipalId.value)
	});
}
function copyIdentityRecord(record) {
	return Object.freeze({
		kind: record.kind,
		id: record.id,
		bytes: record.bytes.slice()
	});
}
function loadRecords(records, decode, key, name) {
	const map = /* @__PURE__ */ new Map();
	for (const stored of records) {
		if (!isSnapshotObject(stored) || !hasExactKeys(stored, ["bytes", "id"]) || !isStoredRecordId(stored.id) || stored.id.length === 0 || !(stored.bytes instanceof Uint8Array)) throw corruptMemoryTenantControl(`Memory Tenant control ${name} snapshot record is malformed`);
		if (map.has(stored.id)) throw corruptMemoryTenantControl(`Memory Tenant control snapshot contains duplicate ${name} records`);
		const bytes = stored.bytes.slice();
		if (key(decode(bytes)) !== stored.id) throw corruptMemoryTenantControl(`${name} snapshot key does not match codec bytes`);
		map.set(stored.id, bytes);
	}
	return map;
}
function snapshotRecords(map) {
	return Object.freeze([...map.entries()].sort(([left], [right]) => compareCanonicalText(left, right)).map(([id, bytes]) => Object.freeze({
		id,
		bytes: bytes.slice()
	})));
}
function decodeRecord(map, id, decode, key, name) {
	const bytes = map.get(id);
	if (bytes === void 0) return void 0;
	const record = decode(bytes.slice());
	if (key(record) !== id) throw corruptMemoryTenantControl(`${name} key does not match codec bytes`);
	return record;
}
function decodeRecords(map, decode, key, name) {
	return Object.freeze([...map.keys()].sort().map((id) => decodeRecord(map, id, decode, key, name)));
}
function putCanonical(map, id, bytes, decode, key, name) {
	if (key(decode(bytes)) !== id) throw corruptMemoryTenantControl(`${name} key does not match codec bytes`);
	map.set(id, bytes.slice());
}
function identityKey(kind, id) {
	return `${kind}\u0000${id}`;
}
function copyMap(map) {
	return new Map([...map].map(([key, bytes]) => [key, bytes.slice()]));
}
function requireCanonicalScope(store, scope) {
	requireLocalTenant(store.tenantId, scope.tenantId, "Authority Scope");
	if (scope.kind === "project" && (scope.projectId === void 0 || store.project(scope.projectId) === void 0)) throw corruptMemoryTenantControl("Authority Project Scope is not canonical");
	if (scope.kind === "workspace") {
		const workspace = scope.workspaceId === void 0 ? void 0 : store.workspace(scope.workspaceId);
		if (workspace === void 0 || !workspace.scope.equals(scope)) throw corruptMemoryTenantControl("Authority Workspace Scope is not canonical");
	}
}
function presence(previous) {
	return previous === void 0 ? "created" : "replaced";
}
function requireLocalTenant(expected, actual, subject) {
	if (!actual.equals(expected)) throw new AgentCoreError("protocol.invalid-state", `${subject} belongs to another Tenant`);
}
function anchorsEqual(left, right) {
	return left.actorId.equals(right.actorId) && left.tenantId.equals(right.tenantId) && left.principalId.equals(right.principalId) && (left.tenantKind ?? "personal") === (right.tenantKind ?? "personal") && bytesEqual(left.trustAnchor, right.trustAnchor);
}
function requireTenantKind(value) {
	if (value !== "personal" && value !== "organization" && value !== "service") throw corruptMemoryTenantControl("Memory Tenant control bootstrap Tenant kind is invalid");
}
function corruptMemoryTenantControl(message) {
	return new AgentCoreError("codec.invalid", message);
}
function hasExactKeys(value, keys) {
	const actual = Object.keys(value).sort();
	return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}
function isSnapshotObject(value) {
	return value !== null && typeof value === "object";
}
function isStoredRecordId(value) {
	return typeof value === "string";
}
function isPromiseLike(value) {
	return typeof value === "object" && value !== null || typeof value === "function" ? "then" in value : false;
}
//#endregion
//#region src/authority/watermark-store.ts
function watermarkKey(watermark) {
	return authorityKey("principal", [
		watermark.ownerTenant.value,
		watermark.owner.kind,
		watermark.owner.id.value,
		watermark.holder.tenantId.value,
		watermark.holder.principalId.value
	]);
}
//#endregion
//#region src/authority/target-lease-evidence-store.ts
var TargetLeaseEvidenceSourcePort = class {};
/** Records source-verified immutable evidence in the exact source Actor transaction. */
var TargetLeaseEvidenceIssuer = class {
	store;
	source;
	constructor(store, source) {
		this.store = store;
		this.source = source;
	}
	attest(transaction, request, now) {
		const expectation = request.expectation;
		const token = expectation.lease;
		if (token === void 0 || !expectation.source.equals(this.store.owner)) return;
		const existing = this.store.evidence(transaction, request.nonce);
		if (existing !== void 0) return this.replay(existing, request, token, now, transaction);
		const current = this.source.current(transaction, expectation.source, expectation.reservation.run, token);
		const expiresAt = current?.lease.expiresAt;
		if (current === void 0 || !current.run.equals(expectation.reservation.run) || expiresAt === void 0 || !current.lease.admits(token, now) || !current.invocationIntent.equals(expectation.intentDigest) || !request.authority.invocationDigest.equals(expectation.intentDigest) || current.watermark.ownerTenant.equals(expectation.tenant) !== true || current.watermark.owner.equals(expectation.source) !== true || current.watermark.holder.equals(token.holder) !== true || expectation.pathEpochs.path.some((entry) => current.watermark.epoch(entry.scope) > entry.epoch)) return;
		const deadline = new Date(Math.min(expiresAt.getTime(), request.expiresAt.getTime()));
		if (deadline.getTime() <= now.getTime()) return void 0;
		const evidence = new TargetLeaseEvidence({
			key: new TargetLeaseEvidenceKey(expectation.source, request.nonce),
			tenant: expectation.tenant,
			run: expectation.reservation.run,
			lease: token,
			target: expectation.target,
			requestIdentity: TargetAuthorityPermitRequest.identityFor(expectation, request.authority, request.nonce, deadline),
			deadline,
			watermark: current.watermark
		});
		return this.store.record(transaction, evidence);
	}
	/**
	* A committed record whose response was lost replays unchanged while the exact
	* request still binds it and every live condition held at issuance still holds:
	* the original deadline has not passed, the current lease admits its token even
	* after a same-token renewal, and the current watermark has not invalidated the
	* path. The original deadline is never regenerated — renewal cannot extend an
	* attestation that already exists.
	*/
	replay(existing, request, token, now, transaction) {
		const expectation = request.expectation;
		if (!existing.matches({
			key: existing.key,
			tenant: expectation.tenant,
			run: expectation.reservation.run,
			lease: token,
			target: expectation.target,
			requestIdentity: TargetAuthorityPermitRequest.identityFor(expectation, request.authority, request.nonce, existing.deadline)
		})) throw denied("Target lease evidence key is bound to another source attestation");
		const current = this.source.current(transaction, expectation.source, expectation.reservation.run, token);
		if (current === void 0 || !current.run.equals(expectation.reservation.run) || !current.lease.admits(token, now) || !current.invocationIntent.equals(expectation.intentDigest) || current.watermark.ownerTenant.equals(expectation.tenant) !== true || current.watermark.owner.equals(expectation.source) !== true || current.watermark.holder.equals(token.holder) !== true || expectation.pathEpochs.path.some((entry) => current.watermark.epoch(entry.scope) > entry.epoch) || !existing.isCurrentAt(now)) return;
		return existing;
	}
};
/**
* Immutable target lease evidence persisted through the source Run Actor's own
* canonical run storage, keyed by idempotency key. The Turn lease, holder
* watermark, and delegation intent are read only through `facts` — the canonical
* RunRepository, watermark owner, and intent owner — inside whichever Run-Actor
* transaction the caller opens on that same storage. One implementation serves
* every substrate; no substrate keeps its own copy of any source fact.
*/
var RunTargetLeaseEvidenceStore = class {
	tenant;
	owner;
	storage;
	facts;
	constructor(tenant, owner, storage, facts) {
		this.tenant = tenant;
		this.owner = owner;
		this.storage = storage;
		this.facts = facts;
		if (!storage.tenant.equals(this.tenant) || !storage.owner.equals(this.owner)) throw denied("Target lease evidence storage belongs to another source Actor");
	}
	/** The read side over this exact owner's canonical source state; the store itself. */
	source = this;
	transaction(operation, ...guard) {
		return this.storage.transaction(operation, ...guard);
	}
	current(transaction, source, run, token) {
		if (!source.equals(this.owner)) return void 0;
		const loadedTurn = this.facts.turn(transaction, new TurnId(token.turn.value));
		if (loadedTurn === void 0 || !loadedTurn.run.equals(run)) return void 0;
		const intent = this.facts.invocationIntent(transaction, new RunId(loadedTurn.run.value));
		if (intent === void 0) return void 0;
		return Object.freeze({
			run: new RunId(loadedTurn.run.value),
			lease: loadedTurn.lease,
			watermark: this.facts.watermark(transaction, token.holder),
			invocationIntent: new Digest(intent.value)
		});
	}
	evidence(transaction, idempotencyKey) {
		const record = this.storage.get(transaction, "targetLeaseEvidence", idempotencyKey);
		if (record === void 0) return void 0;
		const wrapper = TargetLeaseEvidenceRecord.decode(record.bytes.slice());
		if (wrapper.key !== idempotencyKey || !isStoredTargetLeaseEvidenceKey(wrapper.evidence)) throw corrupt();
		const decoded = TargetLeaseEvidence.decode(decodeBase64(wrapper.evidence));
		if (decoded.key.idempotencyKey !== idempotencyKey || !decoded.key.source.equals(this.owner)) throw corrupt();
		return decoded;
	}
	record(transaction, evidence) {
		if (!evidence.key.source.equals(this.owner)) throw denied("Target lease evidence belongs to another source Actor");
		const existing = this.evidence(transaction, evidence.key.idempotencyKey);
		if (existing !== void 0) {
			if (!existing.digest().equals(evidence.digest())) throw denied("Target lease evidence key is bound to another source attestation");
			return existing;
		}
		this.storage.insert(transaction, {
			kind: "targetLeaseEvidence",
			key: evidence.key.idempotencyKey,
			revision: null,
			bytes: TargetLeaseEvidenceRecord.encode(new TargetLeaseEvidenceRecord({
				key: evidence.key.idempotencyKey,
				evidence: encodeBase64(TargetLeaseEvidence.encode(evidence))
			}))
		});
		return evidence;
	}
};
function denied(message) {
	return new AgentCoreError("authority.denied", message);
}
/**
* Stored evidence payloads are canonical authority bytes wrapped in the run-plane
* record codec as base64; the marker keeps a stray plain-hex string from decoding
* into an unrelated authority record downstream.
*/
function isStoredTargetLeaseEvidenceKey(payload) {
	return payload.length > 0 && payload.length % 4 === 0;
}
function corrupt() {
	return new AgentCoreError("codec.invalid", "Stored target lease evidence is malformed");
}
//#endregion
//#region src/authority/permit-runtime.ts
var TenantAuthorityTransactionPort = class {};
//#endregion
export { Binding as A, AuthorityCheckRequest as C, InvalidationWatermark as D, Grant as E, subjectKey as F, GrantId as I, BindingLifecycle as M, domainKey as N, PathEpochEvidence as O, scopeKey as P, AuthorityCheckEvidence as S, AuthorityPermitExpectation as T, TargetAuthorityPermitDenial as _, watermarkKey as a, TargetLeaseEvidenceKey as b, AuthorityChangeSet as c, AuthorityPermitAdmissionPort as d, AuthorityPermitIssuer as f, requireAuthenticatedAuthorityPermit as g, AuthorityPermitIssuedRecordSource as h, TargetLeaseEvidenceSourcePort as i, BindingCredentialCustody as j, ScopeEpoch as k, assertAuthorityClosure as l, AuthorityPermitAuthenticator as m, RunTargetLeaseEvidenceStore as n, MemoryTenantControlStore as o, StoredAuthorityPermitAdmissionPort as p, TargetLeaseEvidenceIssuer as r, createTenantControlBootstrapPlan as s, TenantAuthorityTransactionPort as t, BindingValidationEvidence as u, TargetAuthorityPermitRequest as v, AuthorityPermit as w, TargetLeaseEvidenceReference as x, TargetLeaseEvidence as y };

//# sourceMappingURL=authority-BbHaDuhf.js.map