import { C as canonicalJsonEqual, R as jsonDataParser, T as compareCanonicalText, c as isStringArray, f as RecordCodec, g as Revision, h as SecretRef, j as TextId, k as AgentCoreError, l as requireNonempty, w as canonicalTupleKey, y as Digest } from "./core-BjYGo1CC.js";
import { J as CapabilitySpec, Y as isCapabilityEffect } from "./runtime-z1yMP0an.js";
import "./facets-D01bKQBL.js";
//#region src/identity/id.ts
var PrincipalId = class extends TextId {
	constructor(value) {
		super(value, "Principal ID");
	}
};
var TeamId = class extends TextId {
	constructor(value) {
		super(value, "Team ID");
	}
};
var TenantId = class extends TextId {
	constructor(value) {
		super(value, "Tenant ID");
	}
};
var ProjectId = class extends TextId {
	constructor(value) {
		super(value, "Project ID");
	}
};
var WorkspaceId = class extends TextId {
	constructor(value) {
		super(value, "Workspace ID");
	}
};
var MembershipId = class extends TextId {
	constructor(value) {
		super(value, "Membership ID");
	}
};
var ShareOfferId = class extends TextId {
	constructor(value) {
		super(value, "Share offer ID");
	}
};
var GuestTrustId = class extends TextId {
	constructor(value) {
		super(value, "Guest trust ID");
	}
};
var RoleName = class extends TextId {
	constructor(value) {
		super(value, "Role name");
		if (value.trim() !== value || value.trim().length === 0) throw new TypeError("Role name must be a nonblank canonical string");
	}
};
//#endregion
//#region src/identity/codec.ts
var parse = jsonDataParser(invalid);
function requireIdentityObject(value, subject) {
	return parse.object(value, subject);
}
function requireIdentityFields(value, fields, subject) {
	parse.exact(value, fields, subject);
}
function requireIdentityString(value, subject) {
	return parse.string(value, subject);
}
function requireIdentityArray(value, subject) {
	return parse.array(value, subject);
}
function requireIdentityRevision(value, subject) {
	return new Revision(parse.safeInteger(value, subject));
}
function compareIdentityText(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}
function invalid(message) {
	return new AgentCoreError("codec.invalid", message);
}
//#endregion
//#region src/identity/principal.ts
var PrincipalLifecycle = class {
	static from(status) {
		return status === "active" ? activePrincipal : disabledPrincipal;
	}
};
var ActivePrincipalLifecycle = class extends PrincipalLifecycle {
	status = "active";
	disable() {
		return disabledPrincipal;
	}
};
var DisabledPrincipalLifecycle = class extends PrincipalLifecycle {
	status = "disabled";
	disable() {
		return this;
	}
};
var activePrincipal = Object.freeze(new ActivePrincipalLifecycle());
var disabledPrincipal = Object.freeze(new DisabledPrincipalLifecycle());
var PrincipalRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			Principal,
			PrincipalLifecycle,
			TextId,
			PrincipalId
		], "identity.principal", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(principal) {
		return {
			id: principal.id.value,
			kind: principal.kind,
			status: principal.status
		};
	}
	decodePayload(payload) {
		const object = requireIdentityObject(payload, "Principal payload");
		requireIdentityFields(object, [
			"id",
			"kind",
			"status"
		], "Principal payload");
		return new Principal(new PrincipalId(requireIdentityString(object["id"], "Principal ID")), requirePrincipalKind(object["kind"]), requirePrincipalStatus(object["status"]));
	}
};
var Principal = class Principal {
	id;
	kind;
	static get codec() {
		return principalCodecInstance;
	}
	#lifecycle;
	constructor(id, kind, status) {
		this.id = id;
		this.kind = kind;
		requirePrincipalKind(kind);
		this.#lifecycle = PrincipalLifecycle.from(requirePrincipalStatus(status));
		Object.freeze(this);
	}
	static encode(principal) {
		return Principal.codec.encode(principal);
	}
	static decode(bytes) {
		return Principal.codec.decode(bytes);
	}
	get canAct() {
		return this.#lifecycle.status === "active";
	}
	get status() {
		return this.#lifecycle.status;
	}
	disable() {
		const next = this.#lifecycle.disable();
		return next === this.#lifecycle ? this : new Principal(this.id, this.kind, next.status);
	}
};
var principalCodecInstance = new PrincipalRecordCodec();
function requirePrincipalKind(value) {
	if (value === "user" || value === "service" || value === "agent") return value;
	throw new TypeError("Principal kind is invalid");
}
function requirePrincipalStatus(value) {
	if (value === "active" || value === "disabled") return value;
	throw new TypeError("Principal status is invalid");
}
//#endregion
//#region src/identity/tenant.ts
var TenantLifecycle = class {
	static from(status) {
		if (status === "active") return activeTenant;
		if (status === "suspended") return suspendedTenant;
		return deletedTenant;
	}
};
var MutableTenantLifecycle = class extends TenantLifecycle {
	status;
	constructor(status) {
		super();
		this.status = status;
	}
	transition(next) {
		return TenantLifecycle.from(next);
	}
};
var DeletedTenantLifecycle = class extends TenantLifecycle {
	status = "deleted";
	transition(next) {
		if (next !== "deleted") throw new AgentCoreError("protocol.invalid-state", "Deleted Tenants are terminal");
		return this;
	}
};
var activeTenant = Object.freeze(new MutableTenantLifecycle("active"));
var suspendedTenant = Object.freeze(new MutableTenantLifecycle("suspended"));
var deletedTenant = Object.freeze(new DeletedTenantLifecycle());
var TenantRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			Tenant,
			Revision,
			TenantLifecycle,
			TextId,
			TenantId
		], "identity.tenant", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(tenant) {
		return {
			authorizationRevision: tenant.authorizationRevision.value,
			id: tenant.id.value,
			kind: tenant.kind,
			status: tenant.status
		};
	}
	decodePayload(payload) {
		const object = requireIdentityObject(payload, "Tenant payload");
		requireIdentityFields(object, [
			"authorizationRevision",
			"id",
			"kind",
			"status"
		], "Tenant payload");
		return new Tenant(new TenantId(requireIdentityString(object["id"], "Tenant ID")), requireTenantKind(object["kind"]), requireTenantStatus(object["status"]), requireIdentityRevision(object["authorizationRevision"], "Tenant authorization revision"));
	}
};
var Tenant = class Tenant {
	id;
	kind;
	authorizationRevision;
	static get codec() {
		return tenantCodecInstance;
	}
	#lifecycle;
	constructor(id, kind, status, authorizationRevision) {
		this.id = id;
		this.kind = kind;
		this.authorizationRevision = authorizationRevision;
		requireTenantKind(kind);
		this.#lifecycle = TenantLifecycle.from(requireTenantStatus(status));
		Object.freeze(this);
	}
	static encode(tenant) {
		return Tenant.codec.encode(tenant);
	}
	static decode(bytes) {
		return Tenant.codec.decode(bytes);
	}
	get acceptsMutation() {
		return this.#lifecycle.status === "active";
	}
	get status() {
		return this.#lifecycle.status;
	}
	revise(status) {
		if (status !== "active" && status !== "suspended" && status !== "deleted") throw new AgentCoreError("protocol.invalid-state", "Tenant status is invalid");
		if (this.authorizationRevision.value === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("protocol.invalid-state", "Tenant revision is exhausted");
		const lifecycle = this.#lifecycle.transition(status);
		return lifecycle === this.#lifecycle ? this : new Tenant(this.id, this.kind, lifecycle.status, this.authorizationRevision.next());
	}
};
var tenantCodecInstance = new TenantRecordCodec();
function requireTenantKind(value) {
	if (value === "personal" || value === "organization" || value === "service") return value;
	throw new TypeError("Tenant kind is invalid");
}
function requireTenantStatus(value) {
	if (value === "active" || value === "suspended" || value === "deleted") return value;
	throw new TypeError("Tenant status is invalid");
}
//#endregion
//#region src/identity/team.ts
var TeamRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			Team,
			Revision,
			TextId,
			TeamId,
			TenantId,
			PrincipalId
		], "identity.team", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(team) {
		return {
			id: team.id.value,
			name: team.name,
			principals: team.principals.map((principal) => principal.value),
			revision: team.revision.value,
			tenant: team.tenantId.value
		};
	}
	decodePayload(payload) {
		const object = requireIdentityObject(payload, "Team payload");
		requireIdentityFields(object, [
			"id",
			"name",
			"principals",
			"revision",
			"tenant"
		], "Team payload");
		const principals = object["principals"];
		if (!isStringArray(principals)) throw invalid("Team principals must be an array of Principal IDs");
		return new Team(new TeamId(requireIdentityString(object["id"], "Team ID")), new TenantId(requireIdentityString(object["tenant"], "Team tenant")), requireIdentityString(object["name"], "Team name"), principals.map((principal) => new PrincipalId(principal)), requireIdentityRevision(object["revision"], "Team revision"));
	}
};
/** The longest a Team name may be; see `MAX_TEXT_VALUE_LENGTH` in core. */
var MAX_TEAM_NAME_LENGTH = 256;
var Team = class Team {
	id;
	tenantId;
	revision;
	static get codec() {
		return teamCodecInstance;
	}
	name;
	principals;
	constructor(id, tenantId, name, principals, revision) {
		this.id = id;
		this.tenantId = tenantId;
		this.revision = revision;
		this.name = requireName(name, "Team name");
		const ordered = [...principals].sort((left, right) => compareIdentityText(left.value, right.value));
		if (new Set(ordered.map((principal) => principal.value)).size !== ordered.length) throw new TypeError("Team principals must be unique");
		this.principals = Object.freeze(ordered);
		Object.freeze(this);
	}
	static encode(team) {
		return Team.codec.encode(team);
	}
	static decode(bytes) {
		return Team.codec.decode(bytes);
	}
	has(principal) {
		return this.principals.some((candidate) => candidate.equals(principal));
	}
	revise(name, principals) {
		if (name.trim() !== name || name.length === 0 || name.length > MAX_TEAM_NAME_LENGTH || new Set(principals.map((principal) => principal.value)).size !== principals.length) throw new AgentCoreError("protocol.invalid-state", "Team revision is invalid");
		if (this.revision.value === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("protocol.invalid-state", "Team revision is exhausted");
		return new Team(this.id, this.tenantId, name, principals, this.revision.next());
	}
};
var teamCodecInstance = new TeamRecordCodec();
function requireName(value, subject) {
	if (value.trim() !== value || value.length === 0 || value.length > MAX_TEAM_NAME_LENGTH) throw new TypeError(`${subject} must contain between 1 and ${MAX_TEAM_NAME_LENGTH} canonical characters`);
	return value;
}
//#endregion
//#region src/identity/project.ts
var ProjectRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			Project,
			Revision,
			TextId,
			TenantId,
			ProjectId
		], "identity.project", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(project) {
		return {
			id: project.id.value,
			name: project.name,
			revision: project.revision.value,
			tenant: project.tenantId.value
		};
	}
	decodePayload(payload) {
		const object = requireIdentityObject(payload, "Project payload");
		requireIdentityFields(object, [
			"id",
			"name",
			"revision",
			"tenant"
		], "Project payload");
		return new Project(new ProjectId(requireIdentityString(object["id"], "Project ID")), new TenantId(requireIdentityString(object["tenant"], "Project tenant")), requireIdentityString(object["name"], "Project name"), requireIdentityRevision(object["revision"], "Project revision"));
	}
};
/** The longest a Project name may be; see `MAX_TEXT_VALUE_LENGTH` in core. */
var MAX_PROJECT_NAME_LENGTH = 256;
var Project = class Project {
	id;
	tenantId;
	revision;
	static get codec() {
		return projectCodecInstance;
	}
	name;
	constructor(id, tenantId, name, revision) {
		this.id = id;
		this.tenantId = tenantId;
		this.revision = revision;
		if (name.trim() !== name || name.length === 0 || name.length > MAX_PROJECT_NAME_LENGTH) throw new TypeError(`Project name must contain between 1 and ${MAX_PROJECT_NAME_LENGTH} canonical characters`);
		this.name = name;
		Object.freeze(this);
	}
	static encode(project) {
		return Project.codec.encode(project);
	}
	static decode(bytes) {
		return Project.codec.decode(bytes);
	}
	rename(name) {
		if (name.trim() !== name || name.length === 0 || name.length > MAX_PROJECT_NAME_LENGTH) throw new AgentCoreError("protocol.invalid-state", `Project name must contain between 1 and ${MAX_PROJECT_NAME_LENGTH} canonical characters`);
		if (this.revision.value === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("protocol.invalid-state", "Project revision is exhausted");
		return new Project(this.id, this.tenantId, name, this.revision.next());
	}
};
var projectCodecInstance = new ProjectRecordCodec();
//#endregion
//#region src/identity/scope.ts
var ScopeRef = class ScopeRef {
	kind;
	tenantId;
	projectId;
	workspaceId;
	constructor(kind, tenantId, projectId, workspaceId) {
		this.kind = kind;
		this.tenantId = tenantId;
		this.projectId = projectId;
		this.workspaceId = workspaceId;
		Object.freeze(this);
	}
	static tenant(tenantId) {
		return new ScopeRef("tenant", tenantId, void 0, void 0);
	}
	static project(tenantId, projectId) {
		return new ScopeRef("project", tenantId, projectId, void 0);
	}
	static workspace(tenantId, projectOrWorkspace, workspace) {
		return workspace === void 0 ? new ScopeRef("workspace", tenantId, void 0, requireWorkspace(projectOrWorkspace)) : new ScopeRef("workspace", tenantId, requireProject(projectOrWorkspace), workspace);
	}
	get path() {
		return scopePath(this);
	}
	equals(other) {
		return this.kind === other.kind && this.tenantId.equals(other.tenantId) && optionalIdEquals(this.projectId, other.projectId) && optionalIdEquals(this.workspaceId, other.workspaceId);
	}
};
function encodeScopeRef(scope) {
	if (scope.kind === "tenant") return {
		kind: scope.kind,
		tenant: scope.tenantId.value
	};
	if (scope.kind === "project") {
		if (scope.projectId === void 0) throw new TypeError("Project scope requires a Project ID");
		return {
			kind: scope.kind,
			project: scope.projectId.value,
			tenant: scope.tenantId.value
		};
	}
	if (scope.workspaceId === void 0) throw new TypeError("Workspace scope requires a Workspace ID");
	return {
		kind: scope.kind,
		project: scope.projectId?.value ?? null,
		tenant: scope.tenantId.value,
		workspace: scope.workspaceId.value
	};
}
function decodeScopeRef(value) {
	const object = requireIdentityObject(value, "Scope reference");
	const kind = object["kind"];
	if (kind === "tenant") {
		requireIdentityFields(object, ["kind", "tenant"], "Tenant scope reference");
		return ScopeRef.tenant(new TenantId(requireIdentityString(object["tenant"], "Scope tenant")));
	}
	if (kind === "project") {
		requireIdentityFields(object, [
			"kind",
			"project",
			"tenant"
		], "Project scope reference");
		return ScopeRef.project(new TenantId(requireIdentityString(object["tenant"], "Scope tenant")), new ProjectId(requireIdentityString(object["project"], "Scope project")));
	}
	if (kind === "workspace") {
		requireIdentityFields(object, [
			"kind",
			"project",
			"tenant",
			"workspace"
		], "Workspace scope reference");
		const tenant = new TenantId(requireIdentityString(object["tenant"], "Scope tenant"));
		const workspace = new WorkspaceId(requireIdentityString(object["workspace"], "Scope workspace"));
		const project = object["project"];
		if (project === null) return ScopeRef.workspace(tenant, workspace);
		return ScopeRef.workspace(tenant, new ProjectId(requireIdentityString(project, "Scope project")), workspace);
	}
	throw invalid("Scope reference kind is invalid");
}
function scopePath(scope) {
	if (scope.kind === "tenant") return Object.freeze([scope]);
	const tenant = ScopeRef.tenant(scope.tenantId);
	if (scope.kind === "project") return Object.freeze([tenant, scope]);
	if (scope.projectId === void 0) return Object.freeze([tenant, scope]);
	return Object.freeze([
		tenant,
		ScopeRef.project(scope.tenantId, scope.projectId),
		scope
	]);
}
function requireProject(value) {
	if (!(value instanceof ProjectId)) throw new TypeError("Workspace project must be a Project ID");
	return value;
}
function requireWorkspace(value) {
	if (!(value instanceof WorkspaceId)) throw new TypeError("Workspace scope requires a Workspace ID");
	return value;
}
function optionalIdEquals(left, right) {
	return left === void 0 ? right === void 0 : right !== void 0 && left.equals(right);
}
//#endregion
//#region src/identity/principal-ref.ts
var PrincipalRefCodec = class extends RecordCodec {
	constructor() {
		super([
			PrincipalRef,
			TextId,
			TenantId,
			PrincipalId
		], "identity.principal-ref", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(reference) {
		return {
			principal: reference.principalId.value,
			tenant: reference.tenantId.value
		};
	}
	decodePayload(payload) {
		const object = requireIdentityObject(payload, "Principal reference");
		requireIdentityFields(object, ["principal", "tenant"], "Principal reference");
		return new PrincipalRef(new TenantId(requireIdentityString(object["tenant"], "Principal Tenant")), new PrincipalId(requireIdentityString(object["principal"], "Principal ID")));
	}
};
var PrincipalRef = class PrincipalRef {
	tenantId;
	principalId;
	static get codec() {
		return principalRefCodecInstance;
	}
	constructor(tenantId, principalId) {
		this.tenantId = tenantId;
		this.principalId = principalId;
		Object.freeze(this);
	}
	static encode(reference) {
		return PrincipalRef.codec.encode(reference);
	}
	static decode(bytes) {
		return PrincipalRef.codec.decode(bytes);
	}
	equals(other) {
		return this.tenantId.equals(other.tenantId) && this.principalId.equals(other.principalId);
	}
};
var principalRefCodecInstance = new PrincipalRefCodec();
//#endregion
//#region src/identity/subject.ts
var GuestVerificationScheme = class GuestVerificationScheme {
	value;
	static token = new GuestVerificationScheme("token");
	static callback = new GuestVerificationScheme("callback");
	static handshake = new GuestVerificationScheme("handshake");
	/** The closed vocabulary §3.3 fixes, in the order it introduces the schemes. */
	static all = Object.freeze([
		GuestVerificationScheme.token,
		GuestVerificationScheme.callback,
		GuestVerificationScheme.handshake
	]);
	constructor(value) {
		this.value = value;
		Object.freeze(this);
	}
	static from(value) {
		return parseGuestVerificationScheme(value);
	}
	equals(other) {
		return this === other;
	}
	toString() {
		return this.value;
	}
};
function parseGuestVerificationScheme(value) {
	const scheme = GuestVerificationScheme.all.find((candidate) => candidate.value === value);
	if (scheme === void 0) throw new TypeError("Guest verification scheme is invalid");
	return scheme;
}
var SubjectRef = Object.freeze({
	principal(principal) {
		return Object.freeze({
			kind: "principal",
			principal
		});
	},
	team(teamId) {
		return Object.freeze({
			kind: "team",
			teamId
		});
	},
	foreign(homeTenant, principalId, verifiedVia) {
		return Object.freeze({
			kind: "foreign",
			homeTenant,
			principalId,
			verifiedVia
		});
	}
});
/**
* A Principal subject names a Principal of one Tenant, so any record that carries both a
* subject and the Tenant that owns it rejects a foreign qualification structurally rather
* than inheriting the Tenant from wherever the record happened to be stored. Cross-Tenant
* subjects are `ForeignPrincipalRef` and carry their own home Tenant (§3.3).
*/
function requireSubjectTenant(subject, tenantId, record) {
	if (subject.kind === "principal" && !subject.principal.tenantId.equals(tenantId)) throw new TypeError(`${record} Principal subject belongs to another Tenant`);
}
function encodeSubjectRef(subject) {
	if (subject.kind === "principal") return {
		kind: subject.kind,
		principal: subject.principal.principalId.value,
		tenant: subject.principal.tenantId.value
	};
	if (subject.kind === "team") return {
		kind: subject.kind,
		team: subject.teamId.value
	};
	return {
		homeTenant: subject.homeTenant.value,
		kind: subject.kind,
		principal: subject.principalId.value,
		verifiedVia: subject.verifiedVia.value
	};
}
function decodeSubjectRef(value) {
	const object = requireIdentityObject(value, "Subject reference");
	const kind = object["kind"];
	if (kind === "principal") {
		requireIdentityFields(object, [
			"kind",
			"principal",
			"tenant"
		], "Principal subject reference");
		return SubjectRef.principal(new PrincipalRef(new TenantId(requireIdentityString(object["tenant"], "Subject Tenant")), new PrincipalId(requireIdentityString(object["principal"], "Subject principal"))));
	}
	if (kind === "team") {
		requireIdentityFields(object, ["kind", "team"], "Team subject reference");
		return SubjectRef.team(new TeamId(requireIdentityString(object["team"], "Subject team")));
	}
	if (kind === "foreign") {
		requireIdentityFields(object, [
			"homeTenant",
			"kind",
			"principal",
			"verifiedVia"
		], "Foreign subject reference");
		return SubjectRef.foreign(new TenantId(requireIdentityString(object["homeTenant"], "Foreign home Tenant")), new PrincipalId(requireIdentityString(object["principal"], "Foreign principal")), decodeVerificationScheme(object["verifiedVia"]));
	}
	throw invalid("Subject reference kind is invalid");
}
function decodeVerificationScheme(value) {
	if (value === "token" || value === "callback" || value === "handshake") return GuestVerificationScheme.from(value);
	throw invalid("Guest verification scheme is invalid");
}
//#endregion
//#region src/identity/role.ts
var OWNER_NAME = "owner";
var EDITOR_NAME = "editor";
var READER_NAME = "reader";
var ALL_IMPACTS = Object.freeze([
	"observe",
	"mutate",
	"externalSend",
	"execute",
	"delegate",
	"administer"
]);
var RoleRule = class {
	effect;
	capability;
	constructor(effect, capability) {
		this.effect = effect;
		if (!isCapabilityEffect(effect)) throw new TypeError("Role rule effect is invalid");
		if (!(capability instanceof CapabilitySpec)) throw new TypeError("Role rule capability must be a CapabilitySpec");
		this.capability = capability;
		Object.freeze(this);
	}
};
var RoleRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			Role,
			TextId,
			RoleName,
			RoleRule,
			CapabilitySpec
		], "identity.role", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(role) {
		return {
			name: role.name.value,
			rules: role.rules.map((rule) => ({
				capability: rule.capability.toData(),
				effect: rule.effect
			}))
		};
	}
	decodePayload(payload) {
		const object = requireIdentityObject(payload, "Role payload");
		requireIdentityFields(object, ["name", "rules"], "Role payload");
		const rules = object["rules"];
		if (!Array.isArray(rules)) throw invalid("Role rules must be an array");
		return new Role(new RoleName(requireIdentityString(object["name"], "Role name")), rules.map(decodeRoleRule));
	}
};
var Role = class Role {
	name;
	static get codec() {
		return roleCodecInstance;
	}
	rules;
	constructor(name, rules) {
		this.name = name;
		this.rules = Object.freeze(rules.map((rule) => new RoleRule(rule.effect, rule.capability)));
		Object.freeze(this);
	}
	static encode(role) {
		return Role.codec.encode(role);
	}
	static decode(bytes) {
		return Role.codec.decode(bytes);
	}
};
var roleCodecInstance = new RoleRecordCodec();
var OWNER_ROLE = builtInRole(OWNER_NAME, ALL_IMPACTS);
var EDITOR_ROLE = builtInRole(EDITOR_NAME, ALL_IMPACTS.filter((impact) => impact !== "administer"));
var READER_ROLE = builtInRole(READER_NAME, ["observe"]);
var BUILT_IN_ROLES = Object.freeze([
	OWNER_ROLE,
	EDITOR_ROLE,
	READER_ROLE
]);
function findBuiltInRole(name) {
	const value = isRoleNameValue(name) ? name : name.value;
	return BUILT_IN_ROLES.find((role) => role.name.value === value);
}
function isRoleNameValue(value) {
	return typeof value === "string";
}
function builtInRole(name, impacts) {
	return new Role(new RoleName(name), [new RoleRule("allow", new CapabilitySpec({
		argumentConstraints: {},
		facetPattern: "*",
		impacts: requireNonempty(Object.freeze([...impacts]), "Built-in Role impacts"),
		operations: []
	}))]);
}
function decodeRoleRule(value) {
	const object = requireIdentityObject(value, "Role rule");
	requireIdentityFields(object, ["capability", "effect"], "Role rule");
	const effect = object["effect"];
	if (!isCapabilityEffect(effect)) throw invalid("Role rule effect is invalid");
	return new RoleRule(effect, CapabilitySpec.fromData(object["capability"]));
}
//#endregion
//#region src/identity/guest-verification.ts
var GuestVerificationCodec = class extends RecordCodec {
	constructor() {
		super([
			GuestVerification,
			GuestVerificationScheme,
			Revision,
			TextId,
			Digest,
			GuestTrustId,
			TenantId,
			PrincipalId,
			PrincipalRef
		], "identity.guest-verification", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(verification) {
		return verification.toData();
	}
	decodePayload(payload) {
		return restoreGuestVerification(payload);
	}
};
var constructionToken = Symbol("guest-verification-construction");
var freshVerifications = /* @__PURE__ */ new WeakSet();
var restoredVerifications = /* @__PURE__ */ new WeakSet();
var GuestVerification = class {
	principal;
	trustId;
	trustRevision;
	verifiedVia;
	evidenceDigest;
	static get codec() {
		return guestVerificationCodec;
	}
	#verifiedAt;
	#expiresAt;
	constructor(principal, trustId, trustRevision, verifiedVia, evidenceDigest, verifiedAt, expiresAt, token) {
		this.principal = principal;
		this.trustId = trustId;
		this.trustRevision = trustRevision;
		this.verifiedVia = verifiedVia;
		this.evidenceDigest = evidenceDigest;
		if (token !== constructionToken) throw new TypeError("Guest verification must be minted or restored by the host");
		if (verifiedVia.equals(GuestVerificationScheme.handshake)) throw new TypeError("Guest verification is never minted via the handshake scheme");
		this.#verifiedAt = validDate(verifiedAt, "Guest verification time");
		this.#expiresAt = validDate(expiresAt, "Guest verification expiry");
		if (this.#expiresAt <= this.#verifiedAt) throw new TypeError("Guest verification must expire after verification");
		Object.freeze(this);
	}
	static encode(verification) {
		return guestVerificationCodec.encode(verification);
	}
	static decode(bytes) {
		return guestVerificationCodec.decode(bytes);
	}
	get verifiedAt() {
		return new Date(this.#verifiedAt);
	}
	get expiresAt() {
		return new Date(this.#expiresAt);
	}
	get isHostMinted() {
		return freshVerifications.has(this);
	}
	admits(subject, now) {
		const checkedAt = now.getTime();
		if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) throw new AgentCoreError("protocol.invalid-state", "Guest verification check time is invalid");
		return this.principal.tenantId.equals(subject.homeTenant) && this.principal.principalId.equals(subject.principalId) && this.verifiedVia.equals(subject.verifiedVia) && this.#verifiedAt <= checkedAt && checkedAt < this.#expiresAt;
	}
	toData() {
		return {
			evidenceDigest: this.evidenceDigest.value,
			expiresAt: this.#expiresAt,
			principal: {
				principal: this.principal.principalId.value,
				tenant: this.principal.tenantId.value
			},
			trust: this.trustId.value,
			trustRevision: this.trustRevision.value,
			verifiedAt: this.#verifiedAt,
			verifiedVia: this.verifiedVia.value
		};
	}
};
var guestVerificationCodec = new GuestVerificationCodec();
function restoreGuestVerification(payload) {
	const object = requireIdentityObject(payload, "Guest verification");
	requireIdentityFields(object, [
		"evidenceDigest",
		"expiresAt",
		"principal",
		"trust",
		"trustRevision",
		"verifiedAt",
		"verifiedVia"
	], "Guest verification");
	const principal = requireIdentityObject(object["principal"], "Verified guest Principal");
	requireIdentityFields(principal, ["principal", "tenant"], "Verified guest Principal");
	const verification = new GuestVerification(new PrincipalRef(new TenantId(requireIdentityString(principal["tenant"], "Guest Tenant")), new PrincipalId(requireIdentityString(principal["principal"], "Guest Principal"))), new GuestTrustId(requireIdentityString(object["trust"], "Guest trust ID")), requireIdentityRevision(object["trustRevision"], "Guest trust revision"), requireMintedScheme(object["verifiedVia"]), new Digest(requireIdentityString(object["evidenceDigest"], "Guest evidence digest")), requireDate(object["verifiedAt"], "Guest verification time"), requireDate(object["expiresAt"], "Guest verification expiry"), constructionToken);
	restoredVerifications.add(verification);
	return verification;
}
function isFreshGuestVerification(verification) {
	return freshVerifications.has(verification);
}
function isRestoredGuestVerification(verification) {
	return restoredVerifications.has(verification);
}
function requireMintedScheme(value) {
	if (value === "token" || value === "callback") return GuestVerificationScheme.from(value);
	throw new TypeError("Guest verification is only minted via the token or callback scheme");
}
function requireDate(value, subject) {
	if (!isGuestVerificationTime(value)) throw new TypeError(`${subject} must be a safe integer`);
	return new Date(value);
}
function isGuestVerificationTime(value) {
	return typeof value === "number" && Number.isSafeInteger(value);
}
function validDate(value, subject) {
	const time = value.getTime();
	if (!Number.isSafeInteger(time) || time < 0) throw new TypeError(`${subject} is invalid`);
	return time;
}
//#endregion
//#region src/identity/member.ts
var MembershipLifecycle = class {
	static from(state) {
		if (state === "active") return activeMembership;
		if (state === "suspended") return suspendedMembership;
		return revokedMembership;
	}
};
var ActiveMembershipLifecycle = class extends MembershipLifecycle {
	state = "active";
	transition(next) {
		return MembershipLifecycle.from(next);
	}
};
var SuspendedMembershipLifecycle = class extends MembershipLifecycle {
	state = "suspended";
	transition(next) {
		if (next === "active") throw new AgentCoreError("protocol.invalid-state", "Suspended Memberships require replacement rather than reactivation");
		return MembershipLifecycle.from(next);
	}
};
var RevokedMembershipLifecycle = class extends MembershipLifecycle {
	state = "revoked";
	transition(next) {
		if (next !== "revoked") throw new AgentCoreError("protocol.invalid-state", "A revoked Membership cannot be reactivated");
		return this;
	}
};
var activeMembership = Object.freeze(new ActiveMembershipLifecycle());
var suspendedMembership = Object.freeze(new SuspendedMembershipLifecycle());
var revokedMembership = Object.freeze(new RevokedMembershipLifecycle());
var MembershipRestorationAuthority = class {};
var restoredMembershipToken = Object.freeze(new MembershipRestorationAuthority());
var MembershipRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			Membership,
			GuestVerificationScheme,
			MembershipLifecycle,
			Revision,
			ScopeRef,
			TextId,
			GuestVerification,
			Digest,
			GuestTrustId,
			TeamId,
			RoleName,
			MembershipId,
			TenantId,
			WorkspaceId,
			ProjectId,
			PrincipalId,
			PrincipalRef
		], "identity.membership", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(membership) {
		return {
			id: membership.id.value,
			guestVerification: membership.guestVerification?.toData() ?? null,
			revision: membership.revision.value,
			role: membership.role.value,
			scope: encodeScopeRef(membership.scope),
			state: membership.state,
			subject: encodeSubjectRef(membership.subject)
		};
	}
	decodePayload(payload) {
		const object = requireIdentityObject(payload, "Membership payload");
		requireIdentityFields(object, [
			"guestVerification",
			"id",
			"revision",
			"role",
			"scope",
			"state",
			"subject"
		], "Membership payload");
		const guestVerification = object["guestVerification"];
		return new Membership(new MembershipId(requireIdentityString(object["id"], "Membership ID")), decodeScopeRef(object["scope"]), decodeSubjectRef(object["subject"]), new RoleName(requireIdentityString(object["role"], "Membership role")), requireMembershipState(object["state"]), requireIdentityRevision(object["revision"], "Membership revision"), guestVerification === null ? void 0 : restoreGuestVerification(guestVerification), restoredMembershipToken);
	}
};
var Membership = class Membership {
	id;
	scope;
	role;
	revision;
	guestVerification;
	static get codec() {
		return membershipCodecInstance;
	}
	#lifecycle;
	subject;
	constructor(id, scope, subject, role, state, revision, guestVerification, internalToken) {
		this.id = id;
		this.scope = scope;
		this.role = role;
		this.revision = revision;
		this.guestVerification = guestVerification;
		this.#lifecycle = MembershipLifecycle.from(requireMembershipState(state));
		requireSubjectTenant(subject, scope.tenantId, "Membership");
		this.subject = decodeSubjectRef(encodeSubjectRef(subject));
		if (subject.kind === "foreign" !== (guestVerification !== void 0)) {
			if (guestVerification !== void 0) throw new TypeError("Only foreign Memberships may carry guest verification");
		}
		if (subject.kind === "foreign" && guestVerification !== void 0 && !guestVerification.admits(subject, guestVerification.verifiedAt)) throw new TypeError("Membership guest verification does not match its subject");
		if (guestVerification !== void 0 && !isFreshGuestVerification(guestVerification) && !(internalToken === restoredMembershipToken && isRestoredGuestVerification(guestVerification))) throw new TypeError("Membership guest verification lacks host provenance");
		Object.freeze(this);
	}
	static encode(membership) {
		return Membership.codec.encode(membership);
	}
	static decode(bytes) {
		return Membership.codec.decode(bytes);
	}
	get isActive() {
		return this.#lifecycle.state === "active";
	}
	get state() {
		return this.#lifecycle.state;
	}
	revise(role, state) {
		if (state !== "active" && state !== "suspended" && state !== "revoked") throw new AgentCoreError("protocol.invalid-state", "Membership state is invalid");
		const lifecycle = this.#lifecycle.transition(state);
		if (this.revision.value === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("protocol.invalid-state", "Membership revision is exhausted");
		return new Membership(this.id, this.scope, this.subject, role, lifecycle.state, this.revision.next(), this.guestVerification, isRestoredGuestVerification(this.guestVerification) ? restoredMembershipToken : void 0);
	}
	withGuestVerification(verification) {
		if (this.subject.kind !== "foreign" || this.guestVerification !== void 0 || !isFreshGuestVerification(verification) || !verification.admits(this.subject, verification.verifiedAt)) throw new AgentCoreError("authority.denied", "Guest verification does not match an unverified foreign Membership");
		return new Membership(this.id, this.scope, this.subject, this.role, this.state, this.revision, verification);
	}
	suspend() {
		return this.revise(this.role, "suspended");
	}
	activate() {
		return this.revise(this.role, "active");
	}
	revoke() {
		return this.revise(this.role, "revoked");
	}
};
var membershipCodecInstance = new MembershipRecordCodec();
function requireMembershipState(value) {
	if (value === "active" || value === "suspended" || value === "revoked") return value;
	throw new TypeError("Membership state is invalid");
}
//#endregion
//#region src/identity/share-offer.ts
/**
* Recorded redemptions live inside the offer record, so the bound that limits them also
* bounds the record. An unbounded offer would be the ambient bearer artifact §3.3 refuses.
*/
var MAX_SHARE_OFFER_BOUND = 1024;
var ShareOfferRedemptionDenied = class extends AgentCoreError {
	refusal;
	constructor(refusal, message) {
		super("authority.denied", message);
		this.refusal = refusal;
		this.name = "ShareOfferRedemptionDenied";
	}
};
function shareOfferDenied(refusal, message) {
	return new ShareOfferRedemptionDenied(refusal, message);
}
var ShareOfferLifecycle = class {
	static from(state) {
		return state === "open" ? openShareOffer : revokedShareOffer;
	}
};
var OpenShareOfferLifecycle = class extends ShareOfferLifecycle {
	state = "open";
	revoke() {
		return revokedShareOffer;
	}
	requireIssuable() {}
};
var RevokedShareOfferLifecycle = class extends ShareOfferLifecycle {
	state = "revoked";
	revoke() {
		return this;
	}
	requireIssuable() {
		throw shareOfferDenied("revoked", "A revoked share offer issues no Membership");
	}
};
var openShareOffer = Object.freeze(new OpenShareOfferLifecycle());
var revokedShareOffer = Object.freeze(new RevokedShareOfferLifecycle());
/**
* Identifies the holder a redemption is keyed on. Canonical tuple encoding preserves every
* component boundary, including identifiers containing NUL. A foreign holder's
* `verifiedVia` is deliberately excluded: re-verification changes evidence, not identity.
*/
function shareOfferHolderKey(holder) {
	return holder.kind === "principal" ? canonicalTupleKey("agent-core.share-offer-holder.v1", [
		"principal",
		holder.principal.tenantId.value,
		holder.principal.principalId.value
	]) : canonicalTupleKey("agent-core.share-offer-holder.v1", [
		"foreign",
		holder.homeTenant.value,
		holder.principalId.value
	]);
}
/** One recorded redemption: which holder redeemed, which Membership it minted, and when. */
var ShareOfferRedemption = class ShareOfferRedemption {
	membership;
	subject;
	holderKey;
	#redeemedAt;
	constructor(subject, membership, redeemedAt) {
		this.membership = membership;
		this.subject = requireShareOfferHolder(subject);
		this.holderKey = shareOfferHolderKey(this.subject);
		this.#redeemedAt = validShareOfferTime(redeemedAt, "Share offer redemption time");
		Object.freeze(this);
	}
	get redeemedAt() {
		return new Date(this.#redeemedAt);
	}
	toData() {
		return {
			membership: this.membership.value,
			redeemedAt: this.#redeemedAt,
			subject: encodeSubjectRef(this.subject)
		};
	}
	static fromData(value) {
		const object = requireIdentityObject(value, "Share offer redemption");
		requireIdentityFields(object, [
			"membership",
			"redeemedAt",
			"subject"
		], "Share offer redemption");
		return new ShareOfferRedemption(decodeSubjectRef(object["subject"]), new MembershipId(requireIdentityString(object["membership"], "Redeemed Membership ID")), requireShareOfferDate(object["redeemedAt"], "Share offer redemption time"));
	}
};
/**
* A redemption either issues the offer's one Membership for a holder or replays the
* redemption already recorded for that holder. A replay names the recorded Membership and
* mints nothing: that Membership may since have been revised or revoked, and the offer is not
* the record that answers for it.
*/
var ShareOfferRedemptionOutcome = class {
	static issued(offer, membership) {
		return Object.freeze(new IssuedShareOfferRedemption(offer, membership));
	}
	static replayed(offer, recorded) {
		return Object.freeze(new ReplayedShareOfferRedemption(offer, recorded));
	}
};
var IssuedShareOfferRedemption = class extends ShareOfferRedemptionOutcome {
	offer;
	membership;
	isReplay = false;
	constructor(offer, membership) {
		super();
		this.offer = offer;
		this.membership = membership;
	}
	get membershipId() {
		return this.membership.id;
	}
};
var ReplayedShareOfferRedemption = class extends ShareOfferRedemptionOutcome {
	offer;
	isReplay = true;
	membership = void 0;
	membershipId;
	constructor(offer, recorded) {
		super();
		this.offer = offer;
		this.membershipId = recorded.membership;
	}
};
var ShareOfferRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			ShareOffer,
			ShareOfferRedemption,
			ShareOfferId,
			MembershipId,
			RoleName,
			Digest,
			Revision,
			ShareOfferLifecycle,
			OpenShareOfferLifecycle,
			RevokedShareOfferLifecycle,
			TextId,
			ScopeRef,
			PrincipalRef,
			GuestVerificationScheme,
			TenantId,
			WorkspaceId,
			ProjectId,
			PrincipalId,
			TeamId
		], "identity.share-offer", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(offer) {
		return {
			bound: offer.bound,
			createdAt: offer.createdAt.getTime(),
			expiresAt: offer.expiresAt.getTime(),
			id: offer.id.value,
			redemptions: offer.redemptions.map((redemption) => redemption.toData()),
			revision: offer.revision.value,
			role: offer.role.value,
			roleDigest: offer.roleDigest.value,
			scope: encodeScopeRef(offer.scope),
			secretDigest: offer.secretDigest.value,
			state: offer.state
		};
	}
	decodePayload(payload) {
		const object = requireIdentityObject(payload, "Share offer payload");
		requireIdentityFields(object, [
			"bound",
			"createdAt",
			"expiresAt",
			"id",
			"redemptions",
			"revision",
			"role",
			"roleDigest",
			"scope",
			"secretDigest",
			"state"
		], "Share offer payload");
		return new ShareOffer(new ShareOfferId(requireIdentityString(object["id"], "Share offer ID")), decodeScopeRef(object["scope"]), new RoleName(requireIdentityString(object["role"], "Share offer role")), new Digest(requireIdentityString(object["roleDigest"], "Share offer Role digest")), new Digest(requireIdentityString(object["secretDigest"], "Share offer secret digest")), requireShareOfferDate(object["createdAt"], "Share offer creation time"), requireShareOfferDate(object["expiresAt"], "Share offer expiry"), requireShareOfferBound(object["bound"]), requireIdentityArray(object["redemptions"], "Share offer redemptions").map(ShareOfferRedemption.fromData), requireShareOfferState(object["state"]), requireIdentityRevision(object["revision"], "Share offer revision"));
	}
};
/**
* A **ShareOffer** is a bearer artifact created before its subject is known — the record
* behind handing someone a link. It is deferred Membership issuance and never a second
* authority path: it carries no capability, no Grant and no lineage, and until a redemption is
* recorded it confers nothing at all.
*/
var ShareOffer = class ShareOffer {
	id;
	scope;
	role;
	roleDigest;
	secretDigest;
	revision;
	static get codec() {
		return shareOfferCodecInstance;
	}
	bound;
	redemptions;
	#lifecycle;
	#createdAt;
	#expiresAt;
	constructor(id, scope, role, roleDigest, secretDigest, createdAt, expiresAt, bound, redemptions, state, revision) {
		this.id = id;
		this.scope = scope;
		this.role = role;
		this.roleDigest = roleDigest;
		this.secretDigest = secretDigest;
		this.revision = revision;
		if (roleDigest.constructor !== Digest) throw new TypeError("Share offer requires an exact Role content Digest");
		if (secretDigest.constructor !== Digest) throw new TypeError("Share offer requires an exact bearer secret Digest");
		this.#lifecycle = ShareOfferLifecycle.from(requireShareOfferState(state));
		this.#createdAt = validShareOfferTime(createdAt, "Share offer creation time");
		this.#expiresAt = validShareOfferTime(expiresAt, "Share offer expiry");
		if (this.#expiresAt <= this.#createdAt) throw new TypeError("Share offer must expire after it is created");
		this.bound = requireShareOfferBound(bound);
		this.redemptions = canonicalRedemptions(redemptions, scope, this.bound, this.#createdAt, this.#expiresAt);
		Object.freeze(this);
	}
	static encode(offer) {
		return ShareOffer.codec.encode(offer);
	}
	static decode(bytes) {
		return ShareOffer.codec.decode(bytes);
	}
	get state() {
		return this.#lifecycle.state;
	}
	get isOpen() {
		return this.#lifecycle.state === "open";
	}
	get isExhausted() {
		return this.redemptions.length >= this.bound;
	}
	get createdAt() {
		return new Date(this.#createdAt);
	}
	get expiresAt() {
		return new Date(this.#expiresAt);
	}
	/**
	* Revocation stops every not-yet-recorded redemption. It never retracts a Membership a
	* recorded redemption already minted — that Membership is revoked as a Membership, on the
	* one enforcement plane, which is why nothing surviving a redemption is ambient (§3.4).
	*/
	revoke() {
		return this.transition(this.#lifecycle.revoke(), this.redemptions);
	}
	/**
	* `undefined` answers exactly one question — this holder has not redeemed — so the
	* parameter is a `ShareOfferHolder` rather than a `SubjectRef`: a Team cannot be asked at
	* all, instead of being answered with the same value as an unredeemed holder. A caller
	* that defeats the type is refused rather than silently told "not redeemed".
	*/
	recordedFor(holder) {
		const key = shareOfferHolderKey(requireShareOfferHolder(holder));
		return this.redemptions.find((redemption) => redemption.holderKey === key);
	}
	/**
	* Fail-closed order is load-bearing. The presented secret is checked first, so a wrong
	* secret learns nothing about the offer's state. A recorded holder then replays, ahead of
	* the lifecycle, window and bound checks, because a duplicate delivery of an
	* already-committed redemption mints nothing and must not be answered by minting a second
	* Membership. Only issuance is gated on the offer being open, unexpired and unexhausted.
	*/
	redeem(request) {
		const secret = requireBearerSecret(request.secret);
		const now = validShareOfferTime(request.now, "Share offer redemption time");
		const subject = shareOfferHolder(request.subject);
		if (subject === void 0) throw shareOfferDenied("team-subject", "A share offer is redeemed by a Principal holder, never by a Team");
		if (!Digest.sha256(secret).equals(this.secretDigest)) throw shareOfferDenied("secret-mismatch", "Share offer bearer secret does not match its record");
		const recorded = this.recordedFor(subject);
		if (recorded !== void 0) return ShareOfferRedemptionOutcome.replayed(this, recorded);
		this.#lifecycle.requireIssuable();
		if (now < this.#createdAt) throw shareOfferDenied("not-yet-open", "Share offer is presented before it was created");
		if (now >= this.#expiresAt) throw shareOfferDenied("expired", "Share offer expired before this redemption");
		if (this.isExhausted) throw shareOfferDenied("bound-reached", "Share offer has reached its redemption bound");
		const membership = new Membership(request.membership, this.scope, subject, this.role, "active", new Revision(0), request.guestVerification);
		return ShareOfferRedemptionOutcome.issued(this.transition(this.#lifecycle, [...this.redemptions, new ShareOfferRedemption(subject, membership.id, new Date(now))]), membership);
	}
	/**
	* What a store may accept over a stored offer. The offer's terms — Scope, Role, exact
	* Role content digest, bearer secret digest, window and bound — are immutable, revision
	* advances exactly once, a revoked offer is terminal, and recorded redemptions are
	* append-only and immutable: changing any prior redemption field would rewrite the
	* evidence of the Membership it minted, which §3.3 forbids.
	*/
	assertCanReplace(next) {
		if (!this.id.equals(next.id) || !this.scope.equals(next.scope) || !this.role.equals(next.role) || !this.roleDigest.equals(next.roleDigest) || !this.secretDigest.equals(next.secretDigest) || this.#createdAt !== next.#createdAt || this.#expiresAt !== next.#expiresAt || this.bound !== next.bound || next.revision.value !== this.revision.value + 1) throw new AgentCoreError("protocol.revision-conflict", "Share offer terms are immutable and updates require the next revision");
		if (!this.isOpen) throw new AgentCoreError("protocol.invalid-state", "Revoked share offers are terminal");
		if (next.redemptions.length < this.redemptions.length || this.redemptions.some((recorded, index) => {
			const successor = next.redemptions[index];
			return successor === void 0 || !sameRedemption(recorded, successor);
		})) throw new AgentCoreError("protocol.invalid-state", "Share offer redemptions are append-only");
	}
	transition(lifecycle, redemptions) {
		if (this.revision.value === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("protocol.invalid-state", "Share offer revision is exhausted");
		return new ShareOffer(this.id, this.scope, this.role, this.roleDigest, this.secretDigest, this.createdAt, this.expiresAt, this.bound, redemptions, lifecycle.state, this.revision.next());
	}
};
/**
* A holder key intentionally leaves a foreign holder's verification scheme out: it decides
* bearer idempotency, not evidence identity. A successor record must retain the complete
* redemption instead, including the scheme and the exact redemption instant.
*/
function sameRedemption(left, right) {
	if (!left.membership.equals(right.membership) || left.redeemedAt.getTime() !== right.redeemedAt.getTime()) return false;
	const recorded = left.subject;
	const successor = right.subject;
	if (recorded.kind === "principal") return successor.kind === "principal" && recorded.principal.equals(successor.principal);
	return successor.kind === "foreign" && recorded.homeTenant.equals(successor.homeTenant) && recorded.principalId.equals(successor.principalId) && recorded.verifiedVia.equals(successor.verifiedVia);
}
function canonicalRedemptions(values, scope, bound, createdAt, expiresAt) {
	if (values.length > bound) throw new TypeError("Share offer records more redemptions than its bound admits");
	const holders = /* @__PURE__ */ new Set();
	const canonical = values.map((value) => {
		if (value.constructor !== ShareOfferRedemption) throw new TypeError("Share offer requires exact ShareOfferRedemption values");
		requireSubjectTenant(value.subject, scope.tenantId, "Share offer redemption");
		const redeemedAt = value.redeemedAt.getTime();
		if (redeemedAt < createdAt || redeemedAt >= expiresAt) throw new TypeError("Share offer redemption falls outside its redemption window");
		if (holders.has(value.holderKey)) throw new TypeError("Share offer records one holder twice");
		holders.add(value.holderKey);
		return new ShareOfferRedemption(value.subject, value.membership, value.redeemedAt);
	});
	return Object.freeze(canonical);
}
/** The holder a subject denotes, or nothing when the subject is a Team and cannot hold one. */
function shareOfferHolder(subject) {
	const holder = decodeSubjectRef(encodeSubjectRef(subject));
	return holder.kind === "team" ? void 0 : holder;
}
/** A record's own subject is a shape constraint, so a Team here is malformed rather than denied. */
function requireShareOfferHolder(subject) {
	const holder = shareOfferHolder(subject);
	if (holder === void 0) throw new TypeError("A share offer redemption records a Principal holder, never a Team");
	return holder;
}
function requireBearerSecret(value) {
	if (!(value instanceof Uint8Array)) throw new TypeError("Share offer redemption requires bearer secret bytes");
	return value;
}
function requireShareOfferState(value) {
	if (value === "open" || value === "revoked") return value;
	throw new TypeError("Share offer state is invalid");
}
function requireShareOfferBound(value) {
	if (!isShareOfferInteger(value) || value < 1 || value > MAX_SHARE_OFFER_BOUND) throw new TypeError(`Share offer bound must be an integer between 1 and ${MAX_SHARE_OFFER_BOUND}`);
	return value;
}
function requireShareOfferDate(value, subject) {
	if (!isShareOfferInteger(value)) throw new TypeError(`${subject} must be a safe integer`);
	return new Date(value);
}
function isShareOfferInteger(value) {
	return typeof value === "number" && Number.isSafeInteger(value);
}
function validShareOfferTime(value, subject) {
	const time = value.getTime();
	if (!Number.isSafeInteger(time) || time < 0) throw new TypeError(`${subject} is invalid`);
	return time;
}
var shareOfferCodecInstance = new ShareOfferRecordCodec();
//#endregion
//#region src/identity/guest-trust.ts
var GuestTrustLifecycle = class {
	static from(state) {
		return state === "active" ? activeGuestTrust : revokedGuestTrust;
	}
};
var ActiveGuestTrustLifecycle = class extends GuestTrustLifecycle {
	name = "active";
	rotate() {
		return this;
	}
	revoke() {
		return revokedGuestTrust;
	}
};
var RevokedGuestTrustLifecycle = class extends GuestTrustLifecycle {
	name = "revoked";
	rotate() {
		throw new AgentCoreError("protocol.invalid-state", "Revoked guest trust cannot rotate");
	}
	revoke() {
		return this;
	}
};
var activeGuestTrust = Object.freeze(new ActiveGuestTrustLifecycle());
var revokedGuestTrust = Object.freeze(new RevokedGuestTrustLifecycle());
var GuestTrustRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			GuestTrust,
			GuestTrustLifecycle,
			Revision,
			SecretRef,
			TextId,
			Digest,
			GuestTrustId,
			TenantId
		], "identity.guest-trust", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(trust) {
		return {
			handshakeDigest: trust.handshakeDigest?.value ?? null,
			homeTenant: trust.homeTenant.value,
			hostTenant: trust.hostTenant.value,
			id: trust.id.value,
			revision: trust.revision.value,
			state: trust.state,
			verifier: encodeVerifier(trust.verifier)
		};
	}
	decodePayload(payload) {
		const object = requireIdentityObject(payload, "Guest trust payload");
		requireIdentityFields(object, [
			"handshakeDigest",
			"homeTenant",
			"hostTenant",
			"id",
			"revision",
			"state",
			"verifier"
		], "Guest trust payload");
		const handshakeDigest = object["handshakeDigest"];
		if (handshakeDigest !== null && !isHandshakeDigest(handshakeDigest)) throw new TypeError("Guest trust handshake digest must be a string or null");
		return new GuestTrust(new GuestTrustId(requireIdentityString(object["id"], "Guest trust ID")), new TenantId(requireIdentityString(object["hostTenant"], "Guest host Tenant")), new TenantId(requireIdentityString(object["homeTenant"], "Guest home Tenant")), decodeVerifier(object["verifier"]), requireTrustState(object["state"]), requireIdentityRevision(object["revision"], "Guest trust revision"), handshakeDigest === null ? void 0 : new Digest(handshakeDigest));
	}
};
function isHandshakeDigest(value) {
	return typeof value === "string";
}
var GuestTrust = class GuestTrust {
	id;
	hostTenant;
	homeTenant;
	revision;
	handshakeDigest;
	static get codec() {
		return guestTrustCodecInstance;
	}
	verifier;
	#lifecycle;
	constructor(id, hostTenant, homeTenant, verifier, state, revision, handshakeDigest) {
		this.id = id;
		this.hostTenant = hostTenant;
		this.homeTenant = homeTenant;
		this.revision = revision;
		this.handshakeDigest = handshakeDigest;
		if (hostTenant.equals(homeTenant)) throw new TypeError("Guest trust requires distinct host and home Tenants");
		this.verifier = copyVerifier(verifier);
		this.#lifecycle = GuestTrustLifecycle.from(requireTrustState(state));
		Object.freeze(this);
	}
	static encode(trust) {
		return GuestTrust.codec.encode(trust);
	}
	static decode(bytes) {
		return GuestTrust.codec.decode(bytes);
	}
	get isActive() {
		return this.#lifecycle.name === "active";
	}
	get state() {
		return this.#lifecycle.name;
	}
	rotate(verifier) {
		this.#lifecycle.rotate();
		if (this.revision.value === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("protocol.invalid-state", "Guest trust revision is exhausted");
		try {
			return new GuestTrust(this.id, this.hostTenant, this.homeTenant, verifier, this.state, this.revision.next(), this.handshakeDigest);
		} catch (error) {
			if (error instanceof TypeError) throw new AgentCoreError("protocol.invalid-state", error.message);
			throw error;
		}
	}
	revoke() {
		const next = this.#lifecycle.revoke();
		if (next !== this.#lifecycle && this.revision.value === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("protocol.invalid-state", "Guest trust revision is exhausted");
		return next === this.#lifecycle ? this : new GuestTrust(this.id, this.hostTenant, this.homeTenant, this.verifier, "revoked", this.revision.next(), this.handshakeDigest);
	}
	assertCanReplace(next) {
		if (!this.id.equals(next.id) || !this.hostTenant.equals(next.hostTenant) || !this.homeTenant.equals(next.homeTenant) || this.handshakeDigest?.value !== next.handshakeDigest?.value || next.revision.value !== this.revision.value + 1) throw new AgentCoreError("protocol.revision-conflict", "Guest trust updates require immutable identity and the next revision");
		if (!this.isActive) throw new AgentCoreError("protocol.invalid-state", "Revoked guest trust is terminal");
		if (next.state === "revoked" && !canonicalJsonEqual(encodeVerifier(this.verifier), encodeVerifier(next.verifier))) throw new AgentCoreError("protocol.invalid-state", "Guest trust revocation must preserve verifier configuration");
	}
};
var guestTrustCodecInstance = new GuestTrustRecordCodec();
function encodeVerifier(verifier) {
	return verifier.kind === "token" ? {
		issuer: verifier.issuer,
		key: {
			id: verifier.key.id,
			provider: verifier.key.provider,
			source: verifier.key.source
		},
		kind: verifier.kind
	} : {
		endpoint: verifier.endpoint,
		kind: verifier.kind
	};
}
function decodeVerifier(value) {
	const object = requireIdentityObject(value, "Guest trust verifier");
	if (object["kind"] === "token") {
		requireIdentityFields(object, [
			"issuer",
			"key",
			"kind"
		], "Token guest trust verifier");
		const key = requireIdentityObject(object["key"], "Guest trust key");
		requireIdentityFields(key, [
			"id",
			"provider",
			"source"
		], "Guest trust key");
		return copyVerifier({
			kind: "token",
			issuer: requireIdentityString(object["issuer"], "Guest token issuer"),
			key: new SecretRef(requireIdentityString(key["source"], "Guest key source"), requireIdentityString(key["provider"], "Guest key provider"), requireIdentityString(key["id"], "Guest key ID"))
		});
	}
	if (object["kind"] === "callback") {
		requireIdentityFields(object, ["endpoint", "kind"], "Callback guest trust verifier");
		return copyVerifier({
			kind: "callback",
			endpoint: requireIdentityString(object["endpoint"], "Guest callback endpoint")
		});
	}
	throw new TypeError("Guest trust verifier kind is invalid");
}
function copyVerifier(verifier) {
	if (verifier.kind === "token") {
		if (verifier.issuer.trim() !== verifier.issuer || verifier.issuer.length === 0) throw new TypeError("Guest token issuer must be canonical and nonblank");
		return Object.freeze({
			kind: verifier.kind,
			issuer: verifier.issuer,
			key: Object.freeze(new SecretRef(verifier.key.source, verifier.key.provider, verifier.key.id))
		});
	}
	let endpoint;
	try {
		endpoint = new URL(verifier.endpoint);
	} catch {
		throw new TypeError("Guest callback endpoint must be an absolute HTTPS URL");
	}
	if (endpoint.protocol !== "https:" || endpoint.toString() !== verifier.endpoint) throw new TypeError("Guest callback endpoint must be a canonical HTTPS URL");
	return Object.freeze({
		kind: verifier.kind,
		endpoint: verifier.endpoint
	});
}
function requireTrustState(value) {
	if (value === "active" || value === "revoked") return value;
	throw new TypeError("Guest trust state is invalid");
}
//#endregion
//#region src/identity/workspace.ts
var WorkspaceRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			Workspace,
			Revision,
			TextId,
			TenantId,
			WorkspaceId,
			ProjectId
		], "identity.workspace", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(workspace) {
		return {
			id: workspace.id.value,
			project: workspace.projectId?.value ?? null,
			revision: workspace.revision.value,
			tenant: workspace.tenantId.value
		};
	}
	decodePayload(payload) {
		const object = requireIdentityObject(payload, "Workspace payload");
		requireIdentityFields(object, [
			"id",
			"project",
			"revision",
			"tenant"
		], "Workspace payload");
		const project = object["project"];
		if (project !== null && !isProjectIdValue(project)) throw new TypeError("Workspace Project must be a string or null");
		return new Workspace(new WorkspaceId(requireIdentityString(object["id"], "Workspace ID")), new TenantId(requireIdentityString(object["tenant"], "Workspace Tenant")), project === null ? void 0 : new ProjectId(project), requireIdentityRevision(object["revision"], "Workspace revision"));
	}
};
function isProjectIdValue(value) {
	return typeof value === "string";
}
var Workspace = class Workspace {
	id;
	tenantId;
	projectId;
	revision;
	static get codec() {
		return workspaceCodecInstance;
	}
	constructor(id, tenantId, projectId, revision) {
		this.id = id;
		this.tenantId = tenantId;
		this.projectId = projectId;
		this.revision = revision;
		if (revision.value !== 0) throw new TypeError("Workspace topology requires immutable revision zero");
		Object.freeze(this);
	}
	static encode(workspace) {
		return Workspace.codec.encode(workspace);
	}
	static decode(bytes) {
		return Workspace.codec.decode(bytes);
	}
	get scope() {
		return this.projectId === void 0 ? ScopeRef.workspace(this.tenantId, this.id) : ScopeRef.workspace(this.tenantId, this.projectId, this.id);
	}
};
var workspaceCodecInstance = new WorkspaceRecordCodec();
//#endregion
//#region src/identity/repository.ts
var IdentityRepository = class {};
var MemoryIdentityRepository = class extends IdentityRepository {
	#records = /* @__PURE__ */ new Map();
	constructor(snapshot = emptySnapshot()) {
		super();
		requireSnapshot(snapshot);
		for (const stored of snapshot.records) {
			const record = copyRecord(stored);
			const key = recordKey(record.kind, record.id);
			if (this.#records.has(key)) throw corruptIdentitySnapshot("Memory identity snapshot contains duplicate records");
			verifyRecord(record);
			this.#records.set(key, record);
		}
	}
	loadPrincipal(id) {
		return this.load("principal", id.value, Principal.decode);
	}
	loadTenant(id) {
		return this.load("tenant", id.value, Tenant.decode);
	}
	loadTeam(id) {
		return this.load("team", id.value, Team.decode);
	}
	loadProject(id) {
		return this.load("project", id.value, Project.decode);
	}
	loadWorkspace(id) {
		return this.load("workspace", id.value, Workspace.decode);
	}
	loadGuestTrust(id) {
		return this.load("guestTrust", id.value, GuestTrust.decode);
	}
	loadRole(name) {
		return this.load("role", name.value, Role.decode);
	}
	loadMembership(id) {
		return this.load("membership", id.value, Membership.decode);
	}
	loadShareOffer(id) {
		return this.load("shareOffer", id.value, ShareOffer.decode);
	}
	snapshot() {
		return Object.freeze({
			version: 1,
			records: Object.freeze([...this.#records.values()].sort((left, right) => compareCanonicalText(recordKey(left.kind, left.id), recordKey(right.kind, right.id))).map(copyRecord))
		});
	}
	load(kind, id, decode) {
		const record = this.#records.get(recordKey(kind, id));
		return record === void 0 ? void 0 : decode(record.bytes.slice());
	}
};
function emptySnapshot() {
	return Object.freeze({
		version: 1,
		records: Object.freeze([])
	});
}
function requireSnapshot(snapshot) {
	if (!isIdentitySnapshotCandidate(snapshot) || !hasExactKeys(snapshot, ["records", "version"]) || snapshot.version !== 1 || !Array.isArray(snapshot.records)) throw corruptIdentitySnapshot("Memory identity snapshot is malformed");
}
function verifyRecord(record) {
	if ((record.kind === "principal" ? Principal.decode(record.bytes).id.value : record.kind === "tenant" ? Tenant.decode(record.bytes).id.value : record.kind === "team" ? Team.decode(record.bytes).id.value : record.kind === "project" ? Project.decode(record.bytes).id.value : record.kind === "workspace" ? Workspace.decode(record.bytes).id.value : record.kind === "guestTrust" ? GuestTrust.decode(record.bytes).id.value : record.kind === "role" ? Role.decode(record.bytes).name.value : record.kind === "shareOffer" ? ShareOffer.decode(record.bytes).id.value : Membership.decode(record.bytes).id.value) !== record.id) throw corruptIdentitySnapshot("Stored identity key does not match its codec record");
}
function copyRecord(record) {
	if (!isStoredIdentityRecord(record) || !hasExactKeys(record, [
		"bytes",
		"id",
		"kind"
	]) || record.id.length === 0 || !(record.bytes instanceof Uint8Array)) throw corruptIdentitySnapshot("Memory identity snapshot record is malformed");
	return Object.freeze({
		kind: record.kind,
		id: record.id,
		bytes: record.bytes.slice()
	});
}
function isRecordKind(value) {
	return value === "membership" || value === "guestTrust" || value === "principal" || value === "project" || value === "role" || value === "shareOffer" || value === "team" || value === "tenant" || value === "workspace";
}
function recordKey(kind, id) {
	return `${kind}\u0000${id}`;
}
function corruptIdentitySnapshot(message) {
	return new AgentCoreError("codec.invalid", message);
}
function hasExactKeys(value, keys) {
	const actual = Object.keys(value).sort();
	return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}
function isIdentitySnapshotCandidate(value) {
	return value !== null && typeof value === "object";
}
function isStoredIdentityRecord(value) {
	return value !== null && typeof value === "object" && "kind" in value && typeof value.kind === "string" && isRecordKind(value.kind) && "id" in value && typeof value.id === "string" && "bytes" in value && value.bytes instanceof Uint8Array;
}
//#endregion
export { Tenant as A, WorkspaceId as B, PrincipalRef as C, scopePath as D, encodeScopeRef as E, ProjectId as F, RoleName as I, ShareOfferId as L, GuestTrustId as M, MembershipId as N, Project as O, PrincipalId as P, TeamId as R, requireSubjectTenant as S, decodeScopeRef as T, findBuiltInRole as _, ShareOffer as a, decodeSubjectRef as b, ShareOfferRedemptionOutcome as c, BUILT_IN_ROLES as d, EDITOR_ROLE as f, RoleRule as g, Role as h, GuestTrust as i, Principal as j, Team as k, shareOfferHolderKey as l, READER_ROLE as m, MemoryIdentityRepository as n, ShareOfferRedemption as o, OWNER_ROLE as p, Workspace as r, ShareOfferRedemptionDenied as s, IdentityRepository as t, Membership as u, GuestVerificationScheme as v, ScopeRef as w, encodeSubjectRef as x, SubjectRef as y, TenantId as z };

//# sourceMappingURL=identity-CoqhjOFj.js.map