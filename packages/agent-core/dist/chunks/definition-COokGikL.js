import { D as encodeCanonicalJson, E as decodeCanonicalJson, I as isJsonValue, L as isObjectRecord, M as hasExactJsonKeys, P as isJsonObject, R as jsonDataParser, T as compareCanonicalText, _ as ContentRef, a as CompatRange, f as RecordCodec, g as Revision, h as SecretRef, i as SemVer, j as TextId, k as AgentCoreError, l as requireNonempty, o as isMember, r as strictJsonSchemaValidator, s as isNonempty, t as JsonSchema, v as contentRetentionFields, w as canonicalTupleKey, y as Digest } from "./core-BjYGo1CC.js";
import { d as ActorRef, f as ActorId } from "./actors-DJsP1nFM.js";
import { C as FieldMove, F as PackagePin, G as OperationDescriptor, H as preferredPlacement$1, I as PackageId, K as SurfaceDescriptor, L as BindingRequirement, N as SlotDeclaration, O as PayloadMapping, P as ContributionAttribution, R as FacetManifest, T as MappingRecord, U as Contribution, V as PlacementIntersection, W as Contributions, X as matchesGlob, _ as EventDeclaration, _t as canonicalFacetDataMap, at as FacetPackageId, c as Prompt, ct as OperationName, d as InterceptorDeclaration, et as requireAuthoredCodeConsumer, f as Command, g as BoundOperationRef, gt as canonicalFacetData, h as Automation, l as PromptContribution, lt as OperationRef, nt as BindingName, o as PackageInstallationRef, ot as FacetRef, p as commandAutomation, pt as SlotName, q as enforcementFloor, tt as AuthoredCodeBackingId, v as EventPattern, w as JsonPointer, y as IngressDeclaration, z as PLACEMENT_PREFERENCE } from "./runtime-z1yMP0an.js";
import "./facets-D01bKQBL.js";
import { z as TenantId } from "./identity-CoqhjOFj.js";
import { Range, satisfies } from "semver";
//#region src/definition/id.ts
var MaterializationGenerationId = class extends TextId {
	constructor(value) {
		super(value, "Materialization generation ID");
		if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError("Materialization generation ID must be a SHA-256 digest");
		Object.freeze(this);
	}
};
var DeploymentKey = class extends TextId {
	constructor(value) {
		super(value, "Deployment key");
		if (value.length === 0 || value !== value.trim()) throw new TypeError("Deployment key must be a nonblank canonical string");
		Object.freeze(this);
	}
};
var DeploymentId = class DeploymentId extends TextId {
	constructor(value) {
		super(value, "Deployment ID");
		if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError("Deployment ID must be a SHA-256 digest");
		Object.freeze(this);
	}
	static derive(tenant, key) {
		return new DeploymentId(Digest.sha256(encodeCanonicalJson({
			domain: "agent-core.deployment.v1",
			key: key.value,
			tenant: tenant.value
		})).value);
	}
};
/**
* SPEC §4.1: the identity of one typed failed install. The digest covers exactly the
* record's declared fields, so a decoded failure proves its own identity and two hosts
* that record the same failure of the same contribution against the same Scope write one
* row rather than two.
*/
var FacetInstallFailureId = class FacetInstallFailureId extends TextId {
	constructor(value) {
		super(value, "Facet install failure ID");
		if (!FACET_INSTALL_FAILURE_ID.test(value)) throw new TypeError("Facet install failure ID must be a prefixed SHA-256 digest");
		Object.freeze(this);
	}
	static derive(declaredFields) {
		return new FacetInstallFailureId(`${FACET_INSTALL_FAILURE_PREFIX}${Digest.sha256(encodeCanonicalJson(declaredFields)).value}`);
	}
};
var FACET_INSTALL_FAILURE_PREFIX = "facet-install-failure:";
var FACET_INSTALL_FAILURE_ID = new RegExp(`^${FACET_INSTALL_FAILURE_PREFIX}[a-f0-9]{64}$`, "u");
//#endregion
//#region src/definition/origin.ts
var ManagedOriginCodec = class extends RecordCodec {
	constructor() {
		super([
			ManagedOrigin,
			TextId,
			Digest,
			TenantId,
			DeploymentId
		], "definition.managed-origin", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(origin) {
		return origin.toData();
	}
	decodePayload(payload) {
		return ManagedOrigin.fromData(payload);
	}
};
var ManagedOrigin = class ManagedOrigin {
	static get codec() {
		return managedOriginCodecInstance;
	}
	blueprintDigest;
	tenantId;
	deploymentId;
	attestationDigest;
	packageLockDigest;
	configDigest;
	generation;
	constructor(init) {
		if (!Number.isSafeInteger(init.generation) || init.generation < 0) throw new TypeError("Managed origin generation must be a non-negative safe integer");
		this.tenantId = new TenantId(init.tenantId.value);
		this.deploymentId = new DeploymentId(init.deploymentId.value);
		this.attestationDigest = init.attestationDigest;
		this.blueprintDigest = init.blueprintDigest;
		this.packageLockDigest = init.packageLockDigest;
		this.configDigest = init.configDigest;
		this.generation = init.generation;
		Object.freeze(this);
	}
	static encode(origin) {
		return ManagedOrigin.codec.encode(origin);
	}
	static decode(bytes) {
		return ManagedOrigin.codec.decode(bytes);
	}
	static fromData(payload) {
		const object = requireObject$13(payload, "Managed origin");
		requireFields$7(object, [
			"attestationDigest",
			"blueprintDigest",
			"configDigest",
			"deploymentId",
			"generation",
			"packageLockDigest",
			"tenantId"
		], "Managed origin");
		return new ManagedOrigin({
			tenantId: new TenantId(requireString$9(object["tenantId"], "Managed origin Tenant ID")),
			deploymentId: new DeploymentId(requireString$9(object["deploymentId"], "Managed origin deployment ID")),
			attestationDigest: new Digest(requireString$9(object["attestationDigest"], "Managed origin attestation digest")),
			blueprintDigest: new Digest(requireString$9(object["blueprintDigest"], "Blueprint digest")),
			packageLockDigest: new Digest(requireString$9(object["packageLockDigest"], "Package lock digest")),
			configDigest: new Digest(requireString$9(object["configDigest"], "Config digest")),
			generation: requireNumber(object["generation"], "Managed origin generation")
		});
	}
	equals(other) {
		return this.tenantId.equals(other.tenantId) && this.deploymentId.equals(other.deploymentId) && this.attestationDigest.equals(other.attestationDigest) && this.blueprintDigest.equals(other.blueprintDigest) && this.packageLockDigest.equals(other.packageLockDigest) && this.configDigest.equals(other.configDigest) && this.generation === other.generation;
	}
	toData() {
		return {
			attestationDigest: this.attestationDigest.value,
			blueprintDigest: this.blueprintDigest.value,
			configDigest: this.configDigest.value,
			deploymentId: this.deploymentId.value,
			generation: this.generation,
			packageLockDigest: this.packageLockDigest.value,
			tenantId: this.tenantId.value
		};
	}
};
var managedOriginCodecInstance = new ManagedOriginCodec();
function requireObject$13(value, subject) {
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
	return value;
}
function requireFields$7(value, fields, subject) {
	if (!hasExactJsonKeys(value, fields)) throw new TypeError(`${subject} contains missing or unknown fields`);
}
function requireString$9(value, subject) {
	if (!isStringValue$11(value)) throw new TypeError(`${subject} must be a string`);
	return value;
}
function requireNumber(value, subject) {
	if (!isNumberValue$6(value)) throw new TypeError(`${subject} must be a number`);
	return value;
}
function isStringValue$11(value) {
	return typeof value === "string";
}
function isNumberValue$6(value) {
	return typeof value === "number";
}
//#endregion
//#region src/definition/install-outcome.ts
var parse = jsonDataParser((message) => new TypeError(message));
/**
* SPEC §4.1: where an activation stopped. `start` means the Facet's own `start` hook did
* not complete, and nothing was materialized, because a contribution's records are written
* only after every start succeeds. `materialization` means start completed and the
* record-write transaction failed.
*
* The distinction is a per-case method rather than a caller-side branch on a label,
* because exactly one thing turns on it: only a materialization-phase failure can have
* left attributed records the §4.1 withdrawal set must retire. The two cases are frozen
* singletons and equality is identity, so nothing can mint a third phase or hold two
* unequal copies of one meaning.
*/
var FacetInstallPhase = class {
	static get start() {
		return startPhase;
	}
	static get materialization() {
		return materializationPhase;
	}
	static fromData(value) {
		const declared = FACET_INSTALL_PHASES.find((candidate) => candidate.label === value);
		if (declared === void 0) throw new TypeError(`Facet install phase must be one of ${FACET_INSTALL_PHASES.map((phase) => phase.label).join(", ")}`);
		return declared;
	}
	toData() {
		return this.label;
	}
	equals(other) {
		return this === other;
	}
};
var StartPhase = class extends FacetInstallPhase {
	label = "start";
	get materializedRecords() {
		return false;
	}
};
var MaterializationPhase = class extends FacetInstallPhase {
	label = "materialization";
	get materializedRecords() {
		return true;
	}
};
var startPhase = Object.freeze(new StartPhase());
var materializationPhase = Object.freeze(new MaterializationPhase());
var FACET_INSTALL_PHASES = Object.freeze([startPhase, materializationPhase]);
var FacetInstallFailureCodec = class extends RecordCodec {
	constructor() {
		super([
			FacetInstallFailure,
			ContributionAttribution,
			ManagedOrigin,
			FacetInstallPhase,
			FacetInstallFailureId,
			FacetPackageId,
			FacetRef,
			TextId,
			Digest,
			TenantId,
			DeploymentId,
			PackageId,
			PackagePin,
			SemVer
		], "definition.facet-install-failure", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(failure) {
		return failure.toData();
	}
	decodePayload(payload) {
		return FacetInstallFailure.fromData(payload);
	}
};
/**
* SPEC §4.1: the typed failed install a host records instead of a live Facet. It is
* durable definition-plane evidence, not a diagnostic: a failed Facet is inactive,
* obstructs nothing, and is not retried against the same unchanged Scope, and this record
* is what makes that last clause answerable after the process that failed is gone.
*
* `materialization` is the exact `ManagedOrigin` the installation authenticated under, so
* the Scope is named by Tenant, deployment, attestation, Blueprint, PackageLock, config
* and generation. A later generation is a different origin, which is why a retry under it
* is admitted rather than refused by an older failure.
*/
var FacetInstallFailure = class FacetInstallFailure {
	static get codec() {
		return facetInstallFailureCodecInstance;
	}
	id;
	attribution;
	/** The Facet package whose activation failed. */
	packageFacet;
	manifestDigest;
	materialization;
	phase;
	reason;
	constructor(init) {
		if (!(init.attribution instanceof ContributionAttribution)) throw new TypeError("A failed install carries its contribution attribution");
		if (!(init.packageFacet instanceof FacetPackageId)) throw new TypeError("A failed install names the Facet package that failed");
		if (!(init.manifestDigest instanceof Digest) || !(init.materialization instanceof ManagedOrigin)) throw new TypeError("A failed install carries its manifest digest and its managed origin");
		if (!(init.phase instanceof FacetInstallPhase)) throw new TypeError("A failed install names the phase its activation stopped in");
		if (init.reason.length === 0 || init.reason !== init.reason.trim()) throw new TypeError("Facet install failure reason must be a nonblank canonical string");
		this.attribution = init.attribution;
		this.packageFacet = init.packageFacet;
		this.manifestDigest = init.manifestDigest;
		this.materialization = init.materialization;
		this.phase = init.phase;
		this.reason = init.reason;
		const id = FacetInstallFailureId.derive(declaredFields(init));
		if (init.id !== void 0 && !init.id.equals(id)) throw new TypeError("Facet install failure ID does not match its canonical contents");
		this.id = id;
		Object.freeze(this);
	}
	static encode(failure) {
		return FacetInstallFailure.codec.encode(failure);
	}
	static decode(bytes) {
		return FacetInstallFailure.codec.decode(bytes);
	}
	static fromData(payload) {
		const object = parse.exact(parse.object(payload, "Facet install failure"), [
			"contributor",
			"id",
			"manifestDigest",
			"materialization",
			"package",
			"packageFacet",
			"phase",
			"reason"
		], "Facet install failure");
		return new FacetInstallFailure({
			attribution: ContributionAttribution.decodeFields(object, "Facet install failure"),
			packageFacet: new FacetPackageId(parse.string(object["packageFacet"], "Facet install failure Facet package")),
			manifestDigest: new Digest(parse.string(object["manifestDigest"], "Facet install failure manifest digest")),
			materialization: ManagedOrigin.fromData(object["materialization"]),
			phase: FacetInstallPhase.fromData(object["phase"]),
			reason: parse.string(object["reason"], "Facet install failure reason"),
			id: new FacetInstallFailureId(parse.string(object["id"], "Facet install failure ID"))
		});
	}
	/**
	* SPEC §4.1: does this failure refuse a retry of the same contribution against the same
	* unchanged Scope? Both halves are exact — the contributing FacetRef with its source
	* PackagePin, and the complete managed origin — so nothing about a changed Scope reads
	* as the one that already failed.
	*/
	refuses(attribution, materialization) {
		return this.attribution.equals(attribution) && this.materialization.equals(materialization);
	}
	toData() {
		return {
			...declaredFields(this),
			id: this.id.value
		};
	}
};
var facetInstallFailureCodecInstance = new FacetInstallFailureCodec();
/** Exactly the fields the record declares, which are exactly the fields its id digests. */
function declaredFields(init) {
	return {
		...init.attribution.encodeFields(),
		manifestDigest: init.manifestDigest.value,
		materialization: init.materialization.toData(),
		packageFacet: init.packageFacet.value,
		phase: init.phase.toData(),
		reason: init.reason
	};
}
//#endregion
//#region src/definition/code-manifest.ts
var PackageCodeModule = class PackageCodeModule {
	specifier;
	content;
	media;
	imports;
	constructor(init) {
		this.specifier = canonicalSpecifier(init.specifier, "Code module specifier");
		const imports = [...init.imports ?? []].map((value) => canonicalSpecifier(value, "Code module import")).sort(compareCanonicalText);
		requireUnique$1(imports, "Code module imports must be unique");
		this.content = new ContentRef(init.content.value);
		this.media = canonicalMedia(init.media);
		this.imports = Object.freeze(imports);
		Object.freeze(this);
	}
	static fromData(value) {
		const object = requireObject$12(value, "Code module");
		requireFields$6(object, [
			"content",
			"imports",
			"media",
			"specifier"
		], "Code module");
		return new PackageCodeModule({
			specifier: requireString$8(object["specifier"], "Code module specifier"),
			content: new ContentRef(requireString$8(object["content"], "Code module content")),
			media: { mediaType: requireString$8(object["media"], "Code module media") },
			imports: requireArray$5(object["imports"], "Code module imports").map((entry) => requireString$8(entry, "Code module import"))
		});
	}
	toData() {
		return {
			content: this.content.value,
			imports: this.imports,
			media: this.media.mediaType,
			specifier: this.specifier
		};
	}
};
var PackageCodeEntrypoint = class PackageCodeEntrypoint {
	facet;
	version;
	module;
	exportName;
	constructor(init) {
		this.facet = new FacetPackageId(init.facet.value);
		this.version = new SemVer(init.version.toString());
		this.module = canonicalSpecifier(init.module, "Code entrypoint module");
		this.exportName = canonicalExportName(init.exportName ?? "default");
		Object.freeze(this);
	}
	static fromData(value) {
		const object = requireObject$12(value, "Code entrypoint");
		requireFields$6(object, [
			"exportName",
			"facet",
			"module",
			"version"
		], "Code entrypoint");
		return new PackageCodeEntrypoint({
			facet: new FacetPackageId(requireString$8(object["facet"], "Code entrypoint Facet")),
			version: new SemVer(requireString$8(object["version"], "Code entrypoint version")),
			module: requireString$8(object["module"], "Code entrypoint module"),
			exportName: requireString$8(object["exportName"], "Code entrypoint export")
		});
	}
	toData() {
		return {
			exportName: this.exportName,
			facet: this.facet.value,
			module: this.module,
			version: this.version.toString()
		};
	}
};
var PackageCodeManifestCodec = class extends RecordCodec {
	constructor() {
		super([
			PackageCodeManifest,
			PackageCodeEntrypoint,
			PackageCodeModule,
			TextId,
			Digest,
			SemVer,
			FacetPackageId,
			ContentRef
		], "definition.package-code-manifest", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(manifest) {
		return manifest.toData();
	}
	decodePayload(payload) {
		return PackageCodeManifest.fromData(payload);
	}
};
var PackageCodeManifest = class PackageCodeManifest {
	static get codec() {
		return packageCodeManifestCodecInstance;
	}
	modules;
	entrypoints;
	compatibilityDate;
	digest;
	constructor(init) {
		const modules = init.modules.map((module) => PackageCodeModule.fromData(module.toData())).sort((left, right) => compareCanonicalText(left.specifier, right.specifier));
		const entrypoints = init.entrypoints.map((entrypoint) => PackageCodeEntrypoint.fromData(entrypoint.toData())).sort(compareEntrypoints);
		if (!(isNonempty(modules) && isNonempty(entrypoints))) throw new TypeError("Package code manifest requires modules and entrypoints");
		requireUnique$1(modules.map((module) => module.specifier), "Code module specifiers must be unique");
		requireUnique$1(entrypoints.map((entrypoint) => facetKey(entrypoint.facet, entrypoint.version)), "Code entrypoints must be unique by Facet and version");
		const moduleNames = new Set(modules.map((module) => module.specifier));
		for (const module of modules) for (const imported of module.imports) if (!moduleNames.has(imported)) throw new TypeError(`Code module ${module.specifier} imports missing module ${imported}`);
		for (const entrypoint of entrypoints) if (!moduleNames.has(entrypoint.module)) throw new TypeError(`Code entrypoint references missing module ${entrypoint.module}`);
		const reachable = reachableModules(modules, entrypoints);
		if (modules.some((module) => !reachable.has(module.specifier))) throw new TypeError("Package code manifest contains a module outside its entrypoint closure");
		const compatibilityDate = canonicalCompatibilityDate(init.compatibilityDate);
		const data = codeData(modules, entrypoints, compatibilityDate);
		const digest = Digest.sha256(encodeCanonicalJson(data));
		if (init.digest !== void 0 && !init.digest.equals(digest)) throw new TypeError("Package code digest does not match its canonical module closure");
		this.modules = Object.freeze(modules);
		this.entrypoints = Object.freeze(entrypoints);
		this.compatibilityDate = compatibilityDate;
		this.digest = digest;
		Object.freeze(this);
	}
	static encode(manifest) {
		return PackageCodeManifest.codec.encode(manifest);
	}
	static decode(bytes) {
		return PackageCodeManifest.codec.decode(bytes);
	}
	static fromData(value) {
		const object = requireObject$12(value, "Package code manifest");
		requireFields$6(object, [
			"compatibilityDate",
			"digest",
			"entrypoints",
			"modules"
		], "Package code manifest");
		const modules = requireArray$5(object["modules"], "Package code modules").map(PackageCodeModule.fromData);
		const entrypoints = requireArray$5(object["entrypoints"], "Package code entrypoints").map(PackageCodeEntrypoint.fromData);
		if (!isNonempty(modules) || !isNonempty(entrypoints)) throw new TypeError("Package code manifest requires modules and entrypoints");
		return new PackageCodeManifest({
			modules,
			entrypoints,
			compatibilityDate: requireString$8(object["compatibilityDate"], "Package code compatibility date"),
			digest: new Digest(requireString$8(object["digest"], "Package code digest"))
		});
	}
	module(specifier) {
		return this.modules.find((module) => module.specifier === specifier);
	}
	toData() {
		return {
			compatibilityDate: this.compatibilityDate,
			digest: this.digest.value,
			entrypoints: this.entrypoints.map((entrypoint) => entrypoint.toData()),
			modules: this.modules.map((module) => module.toData())
		};
	}
};
var packageCodeManifestCodecInstance = new PackageCodeManifestCodec();
function codeData(modules, entrypoints, compatibilityDate) {
	return {
		compatibilityDate,
		domain: "agent-core.package-code.v1",
		entrypoints: entrypoints.map((entrypoint) => entrypoint.toData()),
		modules: modules.map((module) => module.toData())
	};
}
function canonicalMedia(value) {
	const mediaType = requireMediaType(value);
	if (mediaType !== mediaType.trim().toLowerCase() || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mediaType)) throw new TypeError("Code module media must be a canonical media type without parameters");
	return Object.freeze({ mediaType });
}
function canonicalCompatibilityDate(value) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (match === null) throw new TypeError("Package code compatibility date must be YYYY-MM-DD");
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(Date.UTC(year, month - 1, day));
	if (year === 0 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new TypeError("Package code compatibility date must be a valid calendar date");
	return value;
}
function reachableModules(modules, entrypoints) {
	const reachable = new Set(entrypoints.map((entrypoint) => entrypoint.module));
	let previousSize = -1;
	while (reachable.size !== previousSize) {
		previousSize = reachable.size;
		for (const module of modules) {
			if (!reachable.has(module.specifier)) continue;
			for (const imported of module.imports) reachable.add(imported);
		}
	}
	return reachable;
}
function compareEntrypoints(left, right) {
	return compareCanonicalText(left.facet.value, right.facet.value) || compareCanonicalText(left.version.toString(), right.version.toString());
}
function facetKey(facet, version) {
	return `${facet.value}\0${version.toString()}`;
}
function canonicalSpecifier(value, subject) {
	if (value.length === 0 || value !== value.trim() || value.includes("\\")) throw new TypeError(`${subject} must be a nonblank canonical string`);
	return value;
}
function canonicalExportName(value) {
	if (!/^(?:default|[A-Za-z_$][A-Za-z0-9_$]*)$/.test(value)) throw new TypeError("Code entrypoint export must be a JavaScript identifier or default");
	return value;
}
function requireObject$12(value, subject) {
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
	return value;
}
function requireFields$6(value, fields, subject) {
	if (!hasExactJsonKeys(value, fields)) throw new TypeError(`${subject} contains missing or unknown fields`);
}
function requireString$8(value, subject) {
	if (!isStringValue$10(value)) throw new TypeError(`${subject} must be a string`);
	return value;
}
function requireMediaType(value) {
	const mediaType = readMediaType(value);
	if (mediaType === void 0) throw new TypeError("Code module media must be a MediaHint");
	return mediaType;
}
function readMediaType(value) {
	try {
		if (!isObjectRecord(value)) return void 0;
		const descriptor = Object.getOwnPropertyDescriptor(value, "mediaType");
		return isMediaTypeDataProperty(descriptor) ? descriptor["value"] : void 0;
	} catch {
		return;
	}
}
function isMediaTypeDataProperty(value) {
	return isObjectRecord(value) && typeof value["value"] === "string" && value["get"] === void 0 && value["set"] === void 0;
}
function isStringValue$10(value) {
	return typeof value === "string";
}
function requireArray$5(value, subject) {
	if (!Array.isArray(value)) throw new TypeError(`${subject} must be an array`);
	return value;
}
function requireUnique$1(values, message) {
	if (new Set(values).size !== values.length) throw new TypeError(message);
}
//#endregion
//#region src/definition/compatibility.ts
var PlatformCompatibilityCodec = class extends RecordCodec {
	constructor() {
		super([PlatformCompatibility, SemVer], "definition.platform-compatibility", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(target) {
		return target.toData();
	}
	decodePayload(payload) {
		return PlatformCompatibility.fromData(payload);
	}
};
var PlatformCompatibility = class PlatformCompatibility {
	static get codec() {
		return platformCompatibilityCodecInstance;
	}
	spec;
	host;
	constructor(init) {
		this.spec = new SemVer(init.spec.toString());
		this.host = new SemVer(init.host.toString());
		Object.freeze(this);
	}
	static encode(target) {
		return PlatformCompatibility.codec.encode(target);
	}
	static decode(bytes) {
		return PlatformCompatibility.codec.decode(bytes);
	}
	static fromData(value) {
		const object = requireObject$11(value);
		if (!hasExactJsonKeys(object, ["host", "spec"]) || !isCompatibilityText(object["host"]) || !isCompatibilityText(object["spec"])) throw new TypeError("Platform compatibility contains missing or unknown fields");
		return new PlatformCompatibility({
			spec: new SemVer(object["spec"]),
			host: new SemVer(object["host"])
		});
	}
	equals(other) {
		return this.spec.equals(other.spec) && this.host.equals(other.host);
	}
	toData() {
		return {
			host: this.host.toString(),
			spec: this.spec.toString()
		};
	}
};
var platformCompatibilityCodecInstance = new PlatformCompatibilityCodec();
function isCompatibilityText(value) {
	return typeof value === "string";
}
function requireObject$11(value) {
	if (!isJsonObject(value)) throw new TypeError("Platform compatibility must be an object");
	return value;
}
function canonicalCompatibilityRange(value, subject) {
	if (value.length === 0 || value !== value.trim()) throw new TypeError(`${subject} must be a nonblank canonical range`);
	try {
		return new Range(value).range || "*";
	} catch {
		throw new TypeError(`${subject} must be a valid semantic version range`);
	}
}
function compatibilityAdmits(range, target) {
	const spec = canonicalCompatibilityRange(range.spec, "Spec compatibility range");
	const host = canonicalCompatibilityRange(range.host, "Host compatibility range");
	return satisfies(target.spec.toString(), spec) && satisfies(target.host.toString(), host);
}
//#endregion
//#region src/definition/package.ts
var PackageDependency = class PackageDependency {
	id;
	range;
	constructor(id, range) {
		this.id = id;
		this.range = canonicalPackageRange(range);
		Object.freeze(this);
	}
	static fromData(value) {
		const object = requireObject$10(value, "Package dependency");
		requireFields$5(object, ["id", "range"], "Package dependency");
		const range = requireString$7(object["range"], "Package dependency range");
		const dependency = new PackageDependency(new PackageId(requireString$7(object["id"], "Package dependency ID")), range);
		if (dependency.range !== range) throw new TypeError("Package dependency range must be canonical");
		return dependency;
	}
	toData() {
		return {
			id: this.id.value,
			range: this.range
		};
	}
};
var PackageReleaseCodec = class extends RecordCodec {
	constructor() {
		super([
			PackageRelease,
			PackageDependency,
			TextId,
			PackageCodeManifest,
			SemVer,
			CompatRange,
			JsonSchema,
			PackageCodeModule,
			PackageCodeEntrypoint,
			FacetManifest,
			Digest,
			PackageId,
			BindingName,
			SlotName,
			FacetPackageId,
			ContentRef,
			Contributions,
			Contribution,
			BindingRequirement
		], "definition.package-release", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(release) {
		return release.toData();
	}
	decodePayload(payload) {
		return PackageRelease.fromData(payload);
	}
};
var PackageRelease = class PackageRelease {
	static get codec() {
		return packageReleaseCodecInstance;
	}
	id;
	version;
	compatibility;
	dependencies;
	manifests;
	manifestDigest;
	codeDigest;
	codeManifest;
	provenance;
	configSchema;
	constructor(init) {
		const dependencies = [...init.dependencies].map((dependency) => new PackageDependency(dependency.id, dependency.range)).sort((left, right) => compareCanonicalText(left.id.value, right.id.value));
		requireUnique(dependencies.map((dependency) => dependency.id.value), "Package dependency IDs must be unique");
		const manifests = [...init.manifests].sort(compareManifests$1);
		if (!isNonempty(manifests)) throw new TypeError("Package release must contain at least one manifest");
		requireUnique(manifests.map((manifest) => `${manifest.id.value}\0${manifest.version.toString()}`), "Package manifests must be unique by ID and version");
		const manifestDigest = Digest.sha256(encodeCanonicalJson(manifests.map((manifest) => manifest.toData())));
		if (init.manifestDigest !== void 0 && !init.manifestDigest.equals(manifestDigest)) throw new TypeError("Package manifest digest does not match its canonical manifests");
		if (!isJsonValue(init.provenance) || !isJsonObject(init.provenance)) throw new TypeError("Package provenance must be a canonical data object");
		const codeManifest = PackageCodeManifest.decode(PackageCodeManifest.encode(init.codeManifest));
		const manifestKeys = manifests.map((manifest) => `${manifest.id.value}\0${manifest.version.toString()}`);
		const entrypointKeys = codeManifest.entrypoints.map((entrypoint) => `${entrypoint.facet.value}\0${entrypoint.version.toString()}`);
		if (manifestKeys.length !== entrypointKeys.length || manifestKeys.some((key, index) => key !== entrypointKeys[index])) throw new TypeError("Package code entrypoints must exactly match Package Facet manifests");
		if (init.codeDigest !== void 0 && !init.codeDigest.equals(codeManifest.digest)) throw new TypeError("Package code digest does not match its canonical code manifest");
		this.id = init.id;
		this.version = init.version;
		this.compatibility = new CompatRange(canonicalCompatibilityRange(init.compatibility.spec, "Package spec compatibility"), canonicalCompatibilityRange(init.compatibility.host, "Package host compatibility"));
		this.dependencies = Object.freeze(dependencies);
		this.manifests = Object.freeze(manifests);
		this.manifestDigest = manifestDigest;
		this.codeDigest = codeManifest.digest;
		this.codeManifest = codeManifest;
		this.provenance = canonicalFacetDataMap(init.provenance);
		this.configSchema = init.configSchema;
		Object.freeze(this);
	}
	static encode(release) {
		return PackageRelease.codec.encode(release);
	}
	static decode(bytes) {
		return PackageRelease.codec.decode(bytes);
	}
	static fromData(payload) {
		const object = requireObject$10(payload, "Package release");
		requireOptionalFields(object, [
			"codeDigest",
			"codeManifest",
			"compatibility",
			"dependencies",
			"id",
			"manifestDigest",
			"manifests",
			"provenance",
			"version"
		], ["configSchema"], "Package release");
		const compatibility = requireObject$10(object["compatibility"], "Package compatibility");
		requireFields$5(compatibility, ["host", "spec"], "Package compatibility");
		const provenance = object["provenance"];
		if (!isJsonObject(provenance)) throw new TypeError("Package provenance must be a canonical data object");
		const configSchema = object["configSchema"] === void 0 ? void 0 : new JsonSchema(requireSchema(object["configSchema"]));
		const manifests = requireArray$4(object["manifests"], "Package manifests").map(FacetManifest.fromData);
		if (!isNonempty(manifests)) throw new TypeError("Package release must contain at least one manifest");
		let release = {
			id: new PackageId(requireString$7(object["id"], "Package ID")),
			version: new SemVer(requireString$7(object["version"], "Package version")),
			compatibility: new CompatRange(requireString$7(compatibility["spec"], "Package spec compatibility"), requireString$7(compatibility["host"], "Package host compatibility")),
			dependencies: requireArray$4(object["dependencies"], "Package dependencies").map(PackageDependency.fromData),
			manifests,
			codeManifest: PackageCodeManifest.fromData(object["codeManifest"]),
			manifestDigest: new Digest(requireString$7(object["manifestDigest"], "Manifest digest")),
			codeDigest: new Digest(requireString$7(object["codeDigest"], "Code digest")),
			provenance
		};
		if (configSchema !== void 0) release = {
			...release,
			configSchema
		};
		return new PackageRelease(release);
	}
	toData() {
		let data = {
			codeDigest: this.codeDigest.value,
			codeManifest: this.codeManifest.toData(),
			compatibility: {
				host: this.compatibility.host,
				spec: this.compatibility.spec
			},
			dependencies: this.dependencies.map((dependency) => dependency.toData()),
			id: this.id.value,
			manifestDigest: this.manifestDigest.value,
			manifests: this.manifests.map((manifest) => manifest.toData()),
			provenance: this.provenance,
			version: this.version.toString()
		};
		if (this.configSchema !== void 0) data = {
			...data,
			configSchema: this.configSchema.document
		};
		return data;
	}
};
var packageReleaseCodecInstance = new PackageReleaseCodec();
var MetadataSnapshotCodec = class extends RecordCodec {
	constructor() {
		super([
			MetadataSnapshot,
			Revision,
			TextId,
			PackageRelease,
			SemVer,
			Digest,
			PackageId,
			PackageCodeManifest,
			BindingName,
			CompatRange,
			SlotName,
			JsonSchema,
			FacetPackageId,
			PackageCodeModule,
			ContentRef,
			Contributions,
			PackageCodeEntrypoint,
			Contribution,
			BindingRequirement,
			PackageDependency,
			FacetManifest
		], "definition.metadata-snapshot", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(snapshot) {
		return snapshot.toData();
	}
	decodePayload(payload) {
		return MetadataSnapshot.fromData(payload);
	}
};
var MetadataSnapshot = class MetadataSnapshot {
	static get codec() {
		return metadataSnapshotCodecInstance;
	}
	revision;
	digest;
	releases;
	constructor(init) {
		const releases = canonicalReleases(init.releases);
		const digest = snapshotDigest(init.revision, releases);
		if (init.digest !== void 0 && !init.digest.equals(digest)) throw new TypeError("Metadata snapshot digest does not match its canonical contents");
		this.revision = init.revision;
		this.digest = digest;
		this.releases = Object.freeze(releases);
		Object.freeze(this);
	}
	static encode(snapshot) {
		return MetadataSnapshot.codec.encode(snapshot);
	}
	static decode(bytes) {
		return MetadataSnapshot.codec.decode(bytes);
	}
	static fromData(payload) {
		const object = requireObject$10(payload, "Metadata snapshot");
		requireFields$5(object, [
			"digest",
			"releases",
			"revision"
		], "Metadata snapshot");
		return new MetadataSnapshot({
			revision: new Revision(requireNonnegativeInteger$3(object["revision"], "Snapshot revision")),
			digest: new Digest(requireString$7(object["digest"], "Snapshot digest")),
			releases: requireArray$4(object["releases"], "Snapshot releases").map(PackageRelease.fromData)
		});
	}
	releasesFor(id) {
		return this.releases.filter((release) => release.id.equals(id));
	}
	toData() {
		return {
			digest: this.digest.value,
			releases: this.releases.map((release) => release.toData()),
			revision: this.revision.value
		};
	}
};
var metadataSnapshotCodecInstance = new MetadataSnapshotCodec();
function canonicalPackageRange(value) {
	if (value.length === 0 || value !== value.trim()) throw new TypeError("Package dependency range must be a nonblank canonical string");
	try {
		return new Range(value).range || "*";
	} catch {
		throw new TypeError("Package dependency range must be a valid semantic version range");
	}
}
function canonicalReleases(input) {
	const releases = [...input].sort(compareReleases);
	const unique = [];
	for (const release of releases) {
		const previous = unique.at(-1);
		if (previous === void 0 || releaseKey$1(previous) !== releaseKey$1(release)) {
			unique.push(release);
			continue;
		}
		if (!bytesEqual$2(PackageRelease.encode(previous), PackageRelease.encode(release))) throw new TypeError(`Conflicting metadata for package release ${release.id.value}@${release.version}`);
	}
	return unique;
}
function snapshotDigest(revision, releases) {
	return Digest.sha256(encodeCanonicalJson({
		releases: releases.map((release) => release.toData()),
		revision: revision.value
	}));
}
function compareReleases(left, right) {
	return compareCanonicalText(left.id.value, right.id.value) || compareCanonicalText(left.version.toString(), right.version.toString());
}
function releaseKey$1(release) {
	return `${release.id.value}\0${release.version.toString()}`;
}
function compareManifests$1(left, right) {
	return compareCanonicalText(left.id.value, right.id.value) || compareCanonicalText(left.version.toString(), right.version.toString());
}
function requireUnique(values, message) {
	if (new Set(values).size !== values.length) throw new TypeError(message);
}
function requireObject$10(value, subject) {
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
	return value;
}
function requireFields$5(value, fields, subject) {
	if (!hasExactJsonKeys(value, fields)) throw new TypeError(`${subject} contains missing or unknown fields`);
}
function requireOptionalFields(value, required, optional, subject) {
	const admitted = /* @__PURE__ */ new Set([...required, ...optional]);
	if (required.some((field) => !(field in value)) || Object.keys(value).some((field) => !admitted.has(field))) throw new TypeError(`${subject} contains missing or unknown fields`);
}
function requireString$7(value, subject) {
	if (!isStringValue$9(value)) throw new TypeError(`${subject} must be a string`);
	return value;
}
function requireArray$4(value, subject) {
	if (!Array.isArray(value)) throw new TypeError(`${subject} must be an array`);
	return value;
}
function requireNonnegativeInteger$3(value, subject) {
	if (!isNumberValue$5(value) || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${subject} must be a non-negative safe integer`);
	return value;
}
function requireSchema(value) {
	if (isBooleanValue(value)) return value;
	return requireObject$10(value, "Package config schema");
}
function isStringValue$9(value) {
	return typeof value === "string";
}
function isNumberValue$5(value) {
	return typeof value === "number";
}
function isBooleanValue(value) {
	return typeof value === "boolean";
}
function bytesEqual$2(left, right) {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
/**
* The module bytes one immutable release names (§8.4). The declared field path walks the
* release's own code manifest, so the projection and the record registry read the same
* shape: one entry per module, in the manifest's canonical specifier order.
*/
function packageReleaseContentRetention(release) {
	return contentRetentionFields(release.codeManifest.modules.map((module, index) => [`codeManifest.modules[${index}].content`, module.content]));
}
/**
* Every module byte range a metadata snapshot reaches through its releases (§8.4). A
* snapshot is immutable and Tenant-owned, so it retains on write and releases only when the
* Tenant's package plane drops the snapshot itself.
*/
function metadataSnapshotContentRetention(snapshot) {
	return contentRetentionFields(snapshot.releases.flatMap((release, releaseIndex) => release.codeManifest.modules.map((module, moduleIndex) => [`releases[${releaseIndex}].codeManifest.modules[${moduleIndex}].content`, module.content])));
}
//#endregion
//#region src/definition/package-lock.ts
var PackageLockCodec = class extends RecordCodec {
	constructor() {
		super([
			PackageLock,
			PackagePin,
			Revision,
			TextId,
			SemVer,
			PlatformCompatibility,
			PackageDependency,
			Digest,
			PackageId
		], "definition.package-lock", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(lock) {
		return lock.toData();
	}
	decodePayload(payload) {
		return PackageLock.fromData(payload);
	}
};
var PackageLock = class PackageLock {
	static get codec() {
		return packageLockCodecInstance;
	}
	snapshotRevision;
	snapshotDigest;
	target;
	roots;
	packages;
	digest;
	constructor(init) {
		const roots = [...init.roots].map((root) => new PackageDependency(root.id, root.range)).sort((left, right) => compareCanonicalText(left.id.value, right.id.value));
		if (new Set(roots.map((root) => root.id.value)).size !== roots.length) throw new TypeError("Package lock roots must contain unique Package IDs");
		const packages = [...init.packages].sort((left, right) => compareCanonicalText(left.id.value, right.id.value));
		if (new Set(packages.map((pin) => pin.id.value)).size !== packages.length) throw new TypeError("Package lock must contain at most one version per package ID");
		this.snapshotRevision = init.snapshotRevision;
		this.snapshotDigest = init.snapshotDigest;
		this.target = PlatformCompatibility.fromData(init.target.toData());
		this.roots = Object.freeze(roots);
		this.packages = Object.freeze(packages);
		this.digest = Digest.sha256(PackageLock.encode(this));
		Object.freeze(this);
	}
	static encode(lock) {
		return PackageLock.codec.encode(lock);
	}
	static decode(bytes) {
		return PackageLock.codec.decode(bytes);
	}
	static fromData(payload) {
		const object = requireObject$9(payload, "Package lock");
		requireFields$4(object, [
			"packages",
			"roots",
			"snapshotDigest",
			"snapshotRevision",
			"target"
		], "Package lock");
		return new PackageLock({
			target: PlatformCompatibility.fromData(object["target"]),
			roots: requireArray$3(object["roots"], "Package lock roots").map(PackageDependency.fromData),
			snapshotRevision: new Revision(requireNonnegativeInteger$2(object["snapshotRevision"], "Package lock snapshot revision")),
			snapshotDigest: new Digest(requireString$6(object["snapshotDigest"], "Package lock snapshot digest")),
			packages: requireArray$3(object["packages"], "Package lock packages").map(PackagePin.fromData)
		});
	}
	toData() {
		return {
			packages: this.packages.map((pin) => pin.toData()),
			roots: this.roots.map((root) => root.toData()),
			snapshotDigest: this.snapshotDigest.value,
			snapshotRevision: this.snapshotRevision.value,
			target: this.target.toData()
		};
	}
};
var packageLockCodecInstance = new PackageLockCodec();
function requireObject$9(value, subject) {
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
	return value;
}
function requireFields$4(value, fields, subject) {
	if (!hasExactJsonKeys(value, fields)) throw new TypeError(`${subject} contains missing or unknown fields`);
}
function requireString$6(value, subject) {
	if (!isStringValue$8(value)) throw new TypeError(`${subject} must be a string`);
	return value;
}
function requireArray$3(value, subject) {
	if (!Array.isArray(value)) throw new TypeError(`${subject} must be an array`);
	return value;
}
function requireNonnegativeInteger$2(value, subject) {
	if (!isNumberValue$4(value) || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${subject} must be a non-negative safe integer`);
	return value;
}
function isStringValue$8(value) {
	return typeof value === "string";
}
function isNumberValue$4(value) {
	return typeof value === "number";
}
//#endregion
//#region src/definition/error.ts
function definitionError(code, message) {
	return new AgentCoreError(code, message);
}
function invalidDefinition(message) {
	return definitionError("operation.invalid-input", message);
}
function invalidDefinitionState(message) {
	return definitionError("protocol.invalid-state", message);
}
function definitionRevisionConflict(message) {
	return definitionError("protocol.revision-conflict", message);
}
//#endregion
//#region src/definition/resolver.ts
var PackageResolver = class {
	resolve(snapshot, roots, target) {
		const constraints = rootConstraints(roots);
		const result = search(snapshot, /* @__PURE__ */ new Map(), constraints, target);
		if (!result.complete) throw invalidDefinition(result.failure);
		return new PackageLock({
			target,
			roots,
			snapshotRevision: snapshot.revision,
			snapshotDigest: snapshot.digest,
			packages: [...result.selected.values()].map((release) => new PackagePin(release.id, release.version, release.manifestDigest, release.codeDigest))
		});
	}
};
function resolvePackageLock(snapshot, roots, target) {
	return new PackageResolver().resolve(snapshot, roots, target);
}
function search(snapshot, selected, constraints, target) {
	for (const [id, release] of selected) {
		const ranges = constraints.get(id) ?? [];
		if (!admittedByAll(release, ranges)) return failedConflict(id, ranges);
	}
	const next = [...constraints].filter(([id]) => !selected.has(id)).sort(([left], [right]) => compareCanonicalText(left, right))[0];
	if (next === void 0) return {
		complete: true,
		selected
	};
	const [id, ranges] = next;
	const releases = snapshot.releasesFor(new PackageId(id));
	if (releases.length === 0) return {
		complete: false,
		failure: `Missing package ${id}`
	};
	const candidates = releases.filter((release) => admittedByAll(release, ranges) && compatibleWith(release, target)).sort(compareCandidates);
	if (candidates.length === 0) return failedConflict(id, ranges);
	let firstFailure;
	for (const candidate of candidates) {
		const nextSelected = new Map(selected);
		nextSelected.set(id, candidate);
		const result = search(snapshot, nextSelected, addDependencies(constraints, candidate.dependencies), target);
		if (result.complete) return result;
		firstFailure ??= result.failure;
	}
	return {
		complete: false,
		failure: firstFailure
	};
}
function compatibleWith(release, target) {
	return compatibilityAdmits(release.compatibility, target) && release.manifests.every((manifest) => compatibilityAdmits(manifest.compat, target));
}
function rootConstraints(roots) {
	const constraints = /* @__PURE__ */ new Map();
	for (const root of roots) {
		const dependency = new PackageDependency(root.id, root.range);
		if (constraints.has(dependency.id.value)) throw invalidDefinition(`Duplicate root package ID ${dependency.id.value}`);
		constraints.set(dependency.id.value, [dependency.range]);
	}
	return constraints;
}
function addDependencies(constraints, dependencies) {
	const next = new Map(constraints);
	for (const dependency of dependencies) next.set(dependency.id.value, [...next.get(dependency.id.value) ?? [], dependency.range]);
	return next;
}
function admittedByAll(release, ranges) {
	const value = release.version.toString();
	return ranges.every((range) => satisfies(value, range, { includePrerelease: true }) && (release.version.prerelease.length === 0 || explicitlyAdmitsPrerelease(value, range)));
}
function explicitlyAdmitsPrerelease(value, rangeValue) {
	const candidate = new Range(`=${value}`).set[0][0].semver;
	return new Range(rangeValue).set.some((comparators) => comparators.every((comparator) => comparator.test(candidate)) && comparators.some((comparator) => comparator.value !== "" && comparator.semver.prerelease.length > 0 && comparator.semver.major === candidate.major && comparator.semver.minor === candidate.minor && comparator.semver.patch === candidate.patch));
}
function compareCandidates(left, right) {
	return right.version.compare(left.version) || compareCanonicalText(left.version.toString(), right.version.toString());
}
function failedConflict(id, ranges) {
	return {
		complete: false,
		failure: `No version of package ${id} satisfies ${[...new Set(ranges)].sort(compareCanonicalText).join(" && ")}`
	};
}
//#endregion
//#region src/definition/config.ts
var SECRET_TAG = "$secret";
var SETTINGS_SLOT = new SlotName("settings");
var ConfigCodec = class extends RecordCodec {
	constructor() {
		super([Config, SecretRef], "definition.config", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(config) {
		return { value: config.value };
	}
	decodePayload(payload) {
		const object = requireObject$8(payload, "Config payload");
		if (!hasExactJsonKeys(object, ["value"])) throw new TypeError("Config payload contains missing or unknown fields");
		return Config.fromData(requireObject$8(object["value"], "Config value"));
	}
};
var Config = class Config {
	static get codec() {
		return configCodecInstance;
	}
	value;
	constructor(value) {
		this.value = canonicalConfig(value);
		Object.freeze(this);
	}
	static empty() {
		return emptyConfig;
	}
	static encode(config) {
		return Config.codec.encode(config);
	}
	static decode(bytes) {
		return Config.codec.decode(bytes);
	}
	static fromData(value) {
		return new Config(value);
	}
	toData() {
		return this.value;
	}
};
var configCodecInstance = new ConfigCodec();
var SECRET_REF_SCHEMA = new JsonSchema({
	additionalProperties: false,
	properties: { [SECRET_TAG]: {
		additionalProperties: false,
		properties: {
			id: {
				minLength: 1,
				type: "string"
			},
			provider: {
				minLength: 1,
				type: "string"
			},
			source: {
				minLength: 1,
				type: "string"
			}
		},
		required: [
			"id",
			"provider",
			"source"
		],
		type: "object"
	} },
	required: [SECRET_TAG],
	type: "object"
});
var BASE_CONFIG_SCHEMA = new JsonSchema({ type: "object" });
function encodeSecretRef(reference) {
	const data = { [SECRET_TAG]: {
		id: reference.id,
		provider: reference.provider,
		source: reference.source
	} };
	freezeJson(data);
	return data;
}
function decodeSecretRef(value) {
	const object = requireObject$8(value, "Secret reference");
	if (!hasExactJsonKeys(object, [SECRET_TAG])) throw new TypeError("Secret reference must use the tagged representation");
	const reference = requireObject$8(object[SECRET_TAG], "Secret reference value");
	if (!hasExactJsonKeys(reference, [
		"id",
		"provider",
		"source"
	])) throw new TypeError("Secret reference contains missing or unknown fields");
	return new SecretRef(requireString$5(reference["source"], "Secret reference source"), requireString$5(reference["provider"], "Secret reference provider"), requireString$5(reference["id"], "Secret reference ID"));
}
function isSecretRefData(value) {
	try {
		decodeSecretRef(value);
		return true;
	} catch {
		return false;
	}
}
function canonicalConfig(value) {
	const canonical = canonicalConfigMap(value);
	freezeJson(canonical);
	return canonical;
}
function composeConfigSchema(base, releases) {
	const ordered = [...releases].sort((left, right) => compareCanonicalText(left.id.value, right.id.value));
	validateUniquePackageReleases(ordered);
	const properties = {};
	for (const release of ordered) {
		const fragments = packageConfigFragments(release);
		properties[release.id.value] = fragments.length > 1 ? { allOf: fragments } : fragments.reduce((_empty, fragment) => fragment, {});
	}
	return new JsonSchema({ allOf: [base.document, {
		additionalProperties: false,
		properties,
		required: ordered.map((release) => release.id.value),
		type: "object"
	}] });
}
function packageConfigFragments(release) {
	const fragments = [];
	if (release.configSchema !== void 0) fragments.push(release.configSchema.document);
	for (const manifest of release.manifests) {
		if (manifest.configSchema !== void 0) fragments.push(manifest.configSchema.document);
		for (const fragment of manifest.contributions.get(SETTINGS_SLOT) ?? []) fragments.push(requireSchemaDocument(fragment, "Settings contribution"));
	}
	return fragments;
}
function canonicalConfigValue(value) {
	if (value instanceof SecretRef) return encodeSecretRef(value);
	if (isConfigScalar(value)) return value;
	if (isConfigNumber(value)) {
		if (!Number.isFinite(value)) throw new TypeError("Config numbers must be finite");
		return Object.is(value, -0) ? 0 : value;
	}
	if (isConfigArray(value)) return value.map(canonicalConfigValue);
	return canonicalConfigMap(value);
}
function canonicalConfigMap(value) {
	if (!hasPlainConfigPrototype(value)) throw new TypeError("Config values must be canonical JSON data or SecretRef values");
	const normalized = Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareCanonicalText(left, right)).map(([key, entry]) => [key, canonicalConfigValue(entry)]));
	if (SECRET_TAG in value) return encodeSecretRef(decodeSecretRef(normalized));
	return normalized;
}
function validateUniquePackageReleases(releases) {
	if (new Set(releases.map((release) => release.id.value)).size !== releases.length) throw new TypeError("Config schemas require one release per package ID");
}
function requireSchemaDocument(value, subject) {
	if (isBooleanSchema(value)) return value;
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be a JSON Schema object or boolean`);
	return new JsonSchema(value).document;
}
function freezeJson(value) {
	if (Array.isArray(value)) {
		for (const entry of value) freezeJson(entry);
		Object.freeze(value);
		return;
	}
	if (isJsonObject(value)) {
		for (const entry of Object.values(value)) freezeJson(entry);
		Object.freeze(value);
	}
}
function requireObject$8(value, subject) {
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
	return value;
}
function requireString$5(value, subject) {
	if (!isStringValue$7(value)) throw new TypeError(`${subject} must be a string`);
	return value;
}
function hasPlainConfigPrototype(value) {
	return Object.getPrototypeOf(value) === Object.prototype;
}
function isConfigScalar(value) {
	return value === null || typeof value === "boolean" || typeof value === "string";
}
function isConfigNumber(value) {
	return typeof value === "number";
}
function isConfigArray(value) {
	return Array.isArray(value);
}
function isBooleanSchema(value) {
	return typeof value === "boolean";
}
function isStringValue$7(value) {
	return typeof value === "string";
}
var emptyConfig = new Config({});
//#endregion
//#region src/definition/placement.ts
/**
* Which backing serves which §4.7 consumer, as `policies.placement` declares it
* (§9.2). The mapping is partial on purpose: a consumer the Blueprint does not name
* uses the substrate profile's declared default backing rather than an arbitrary one.
* Backings differ operationally and never in authority, so this record is a hosting
* choice and carries no capability.
*/
var AuthoredCodeBackingPolicy = class AuthoredCodeBackingPolicy {
	#backings;
	constructor(backings) {
		this.#backings = new Map([...backings].sort(([left], [right]) => compareCanonicalText(left, right)));
		Object.freeze(this);
	}
	static get unmapped() {
		return unmappedBackingPolicy;
	}
	static fromData(payload) {
		if (payload === void 0) return unmappedBackingPolicy;
		const object = requireObject$7(payload, "Agent-authored code backing policy");
		return new AuthoredCodeBackingPolicy(new Map(Object.entries(object).map(([consumer, backing]) => [requireAuthoredCodeConsumer(consumer, "Agent-authored code backing consumer"), new AuthoredCodeBackingId(requireCanonicalString(backing, `Agent-authored code backing for ${consumer}`))])));
	}
	/**
	* The backing that serves `consumer`: the declared mapping when the Blueprint names
	* one, and otherwise the profile's declared default. There is no third outcome —
	* an unmapped consumer never reaches an arbitrary offered backing.
	*/
	backingFor(consumer, profileDefault) {
		return this.#backings.get(consumer) ?? profileDefault;
	}
	get isEmpty() {
		return this.#backings.size === 0;
	}
	get consumers() {
		return Object.freeze([...this.#backings.keys()]);
	}
	toData() {
		return Object.fromEntries([...this.#backings].map(([consumer, backing]) => [consumer, backing.value]));
	}
};
var PlacementUnavailableError = class extends AgentCoreError {
	constructor(message) {
		super("operation.invalid-input", message);
		this.name = "PlacementUnavailableError";
	}
};
var PlacementPolicyCodec = class extends RecordCodec {
	constructor() {
		super([
			PlacementPolicy,
			AuthoredCodeBackingPolicy,
			AuthoredCodeBackingId,
			TextId
		], "definition.placement-policy", {
			major: 2,
			minor: 1
		});
	}
	encodePayload(policy) {
		return policy.toData();
	}
	decodePayload(payload) {
		return PlacementPolicy.fromData(payload);
	}
};
var PlacementPolicy = class PlacementPolicy {
	static get codec() {
		return placementPolicyCodecInstance;
	}
	allowed;
	trusted;
	backings;
	constructor(allowed, trusted, backings = AuthoredCodeBackingPolicy.unmapped) {
		this.allowed = canonicalModes(allowed, "Placement policy");
		if (!Array.isArray(trusted)) throw new TypeError("Placement policy trust patterns must be an array");
		this.trusted = canonicalGlobs(trusted);
		this.backings = backings;
		Object.freeze(this);
	}
	static all() {
		return allPlacementPolicy;
	}
	static encode(policy) {
		return PlacementPolicy.codec.encode(policy);
	}
	static decode(bytes) {
		return PlacementPolicy.codec.decode(bytes);
	}
	static fromData(payload) {
		const object = requireObject$7(payload, "Placement policy");
		if (!hasExactJsonKeys(object, ["allowed", "trusted"]) && !hasExactJsonKeys(object, [
			"allowed",
			"backings",
			"trusted"
		])) throw new TypeError("Placement policy contains missing or unknown fields");
		return new PlacementPolicy(requireModeArray(object["allowed"], "Placement policy modes"), requireGlobArray(object["trusted"], "Placement policy trust pattern"), AuthoredCodeBackingPolicy.fromData(object["backings"]));
	}
	admits(mode) {
		return this.allowed.includes(mode);
	}
	trusts(packageId) {
		return this.trusted.some((pattern) => matchesGlob(pattern, packageId.value));
	}
	trustedModes(packageId) {
		return trustPlacementModes(this.trusts(packageId));
	}
	backingFor(consumer, profileDefault) {
		return this.backings.backingFor(consumer, profileDefault);
	}
	toData() {
		let data = {
			allowed: this.allowed,
			trusted: this.trusted
		};
		if (!this.backings.isEmpty) data = {
			...data,
			backings: this.backings.toData()
		};
		return data;
	}
};
var placementPolicyCodecInstance = new PlacementPolicyCodec();
var PlacementInput = class {
	manifest;
	policy;
	substrate;
	trust;
	constructor(init) {
		this.manifest = canonicalModes(init.manifest, "Manifest placement source");
		this.policy = canonicalModes(init.policy, "Policy placement source");
		this.substrate = canonicalModes(init.substrate, "Substrate placement source");
		this.trust = canonicalModes(init.trust, "Trust placement source");
		Object.freeze(this);
	}
};
var PlacementSelection = class {
	selected;
	manifest;
	policy;
	substrate;
	trust;
	constructor(input, selected) {
		this.selected = selected;
		if (!input.manifest.includes(selected) || !input.policy.includes(selected) || !input.substrate.includes(selected) || !input.trust.includes(selected)) throw new TypeError("Selected placement must belong to every admissible source");
		this.manifest = input.manifest;
		this.policy = input.policy;
		this.substrate = input.substrate;
		this.trust = input.trust;
		Object.freeze(this);
	}
};
function preferredPlacement(manifest, policy, substrate, trust) {
	const served = preferredPlacement$1(manifest, policy, substrate, trust);
	return served.kind === "some" ? served.value : void 0;
}
function selectPlacement(input) {
	const recorded = input instanceof PlacementInput ? input : new PlacementInput(input);
	const selected = preferredPlacement(recorded.manifest, recorded.policy, recorded.substrate, recorded.trust);
	if (selected === void 0) throw new PlacementUnavailableError("No isolation mode is admitted by every placement source");
	return new PlacementSelection(recorded, selected);
}
function trustPlacementModes(trustedPackage) {
	return trustedPackage ? trustedPlacementModes : untrustedPlacementModes;
}
function canonicalModes(modes, subject) {
	const snapshot = [...modes];
	if (snapshot.length === 0) throw new PlacementUnavailableError(`${subject} must not be empty`);
	if (snapshot.some((mode) => !PLACEMENT_PREFERENCE.includes(mode))) throw new TypeError(`${subject} contains an unknown isolation mode`);
	if (new Set(snapshot).size !== snapshot.length) throw new TypeError(`${subject} modes must be unique`);
	const canonical = PLACEMENT_PREFERENCE.filter((mode) => snapshot.includes(mode));
	return Object.freeze(requireNonempty(canonical, subject));
}
function canonicalGlobs(patterns) {
	for (const pattern of patterns) requireCanonicalString(pattern, "Placement policy trust pattern");
	if (new Set(patterns).size !== patterns.length) throw new TypeError("Placement policy trust patterns must be unique");
	return Object.freeze([...patterns].sort(compareCanonicalText));
}
function requireObject$7(value, subject) {
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
	return value;
}
function requireGlobArray(value, subject) {
	if (!Array.isArray(value)) throw new TypeError(`${subject} must be an array`);
	return value.map((pattern) => requireCanonicalString(pattern, subject));
}
function requireCanonicalString(value, subject) {
	if (!isStringValue$6(value) || value.length === 0 || value !== value.trim()) throw new TypeError(`${subject} must be a nonblank canonical string`);
	return value;
}
function isStringValue$6(value) {
	return typeof value === "string";
}
function requireModeArray(value, subject) {
	if (!Array.isArray(value)) throw new TypeError(`${subject} must be an array`);
	return value.map((mode) => parseIsolationMode(mode, subject));
}
function parseIsolationMode(value, subject) {
	if (isMember(PLACEMENT_PREFERENCE, value)) return value;
	throw new TypeError(`${subject} contains an unknown isolation mode`);
}
var trustedPlacementModes = Object.freeze(requireNonempty([...PLACEMENT_PREFERENCE], "Placement"));
var untrustedPlacementModes = Object.freeze(["dynamic", "provider"]);
var unmappedBackingPolicy = new AuthoredCodeBackingPolicy(/* @__PURE__ */ new Map());
var allPlacementPolicy = new PlacementPolicy(PLACEMENT_PREFERENCE, ["*"]);
//#endregion
//#region src/definition/generated/tree-merge/AgentCore/Extract/TreeMerge.ts
/**
* How a merge resolves the tree its two parents share (SPEC §5.2.1): take one side's tree
* wholesale, or take per path the side that changed it relative to the common ancestor.
*/
var TreeMergePolicy = class TreeMergePolicy {
	static get ours() {
		return oursTreeMergePolicy;
	}
	static get theirs() {
		return theirsTreeMergePolicy;
	}
	static get perPath() {
		return perPathTreeMergePolicy;
	}
	static from(kind) {
		switch (kind) {
			case "ours": return TreeMergePolicy.ours;
			case "theirs": return TreeMergePolicy.theirs;
			case "perPath": return TreeMergePolicy.perPath;
		}
	}
	static fromData(value) {
		switch (value) {
			case "ours": return TreeMergePolicy.ours;
			case "theirs": return TreeMergePolicy.theirs;
			case "perPath": return TreeMergePolicy.perPath;
			default: throw new TypeError("TreeMergePolicy data must name a constructor");
		}
	}
	toData() {
		return this.kind;
	}
	equals(other) {
		return this === other;
	}
};
var OursTreeMergePolicy = class extends TreeMergePolicy {
	kind = "ours";
	constructor() {
		super();
		Object.freeze(this);
	}
	side() {
		return {
			kind: "some",
			value: "ours"
		};
	}
	surfacesConflicts() {
		return false;
	}
};
var TheirsTreeMergePolicy = class extends TreeMergePolicy {
	kind = "theirs";
	constructor() {
		super();
		Object.freeze(this);
	}
	side() {
		return {
			kind: "some",
			value: "theirs"
		};
	}
	surfacesConflicts() {
		return false;
	}
};
var PerPathTreeMergePolicy = class extends TreeMergePolicy {
	kind = "perPath";
	constructor() {
		super();
		Object.freeze(this);
	}
	side() {
		return { kind: "none" };
	}
	surfacesConflicts() {
		return true;
	}
};
var oursTreeMergePolicy = new OursTreeMergePolicy();
var theirsTreeMergePolicy = new TheirsTreeMergePolicy();
var perPathTreeMergePolicy = new PerPathTreeMergePolicy();
//#endregion
//#region src/definition/policy.ts
var POLICY_IMPACTS = Object.freeze([
	"observe",
	"mutate",
	"externalSend",
	"execute",
	"delegate",
	"administer"
]);
/** The declared policy, or nothing where the Blueprint declares none (SPEC §9.2). */
function treeMergePolicyFromData(value) {
	if (value === void 0 || value === null) return void 0;
	return TreeMergePolicy.fromData(value);
}
var PolicySetCodec = class extends RecordCodec {
	constructor() {
		super([
			PolicySet,
			AuthoredCodeBackingPolicy,
			PlacementPolicy,
			AuthoredCodeBackingId,
			TextId,
			TreeMergePolicy
		], "definition.policy-set", {
			major: 3,
			minor: 0
		});
	}
	encodePayload(policy) {
		return policy.toData();
	}
	decodePayload(payload) {
		return PolicySet.fromData(payload);
	}
};
var PolicySet = class PolicySet {
	static get codec() {
		return policySetCodecInstance;
	}
	tiers;
	approvals;
	placement;
	maxDirectRevocationWindowMs;
	/**
	* Present only when the Blueprint declares it. Absence is the declaration that this
	* platform's branches own disjoint Environments, so a merge needing a side is refused.
	*/
	treeMerge;
	constructor(init) {
		this.tiers = canonicalTiers(init.tiers ?? {});
		this.approvals = canonicalApprovals(init.approvals ?? []);
		if (!(init.placement instanceof PlacementPolicy)) throw new TypeError("Policy set requires an explicit placement policy");
		this.placement = init.placement;
		this.maxDirectRevocationWindowMs = validateDirectRevocationWindow(init.maxDirectRevocationWindowMs);
		this.treeMerge = init.treeMerge;
		Object.freeze(this);
	}
	static empty() {
		return emptyPolicySet;
	}
	static encode(policy) {
		return PolicySet.codec.encode(policy);
	}
	static decode(bytes) {
		return PolicySet.codec.decode(bytes);
	}
	static fromData(payload) {
		const object = requireObject$6(payload, "Policy set");
		if (!hasExactJsonKeys(object, [
			"approvals",
			"maxDirectRevocationWindowMs",
			"placement",
			"tiers",
			"treeMerge"
		])) throw new TypeError("Policy set contains missing or unknown fields");
		const treeMerge = treeMergePolicyFromData(object["treeMerge"]);
		return new PolicySet({
			tiers: requireTiers(object["tiers"]),
			approvals: requireImpactArray(object["approvals"], "Policy approvals"),
			...decodeOptionalDirectRevocationWindow(object["maxDirectRevocationWindowMs"]),
			placement: PlacementPolicy.fromData(object["placement"]),
			...treeMerge && { treeMerge }
		});
	}
	tierFor(impact) {
		return this.tiers[impact];
	}
	requiresApproval(impact) {
		return this.approvals.includes(impact);
	}
	toData() {
		return {
			approvals: this.approvals,
			maxDirectRevocationWindowMs: this.maxDirectRevocationWindowMs ?? null,
			placement: this.placement.toData(),
			tiers: this.tiers,
			treeMerge: this.treeMerge?.toData() ?? null
		};
	}
};
var policySetCodecInstance = new PolicySetCodec();
function evaluatePolicy(input) {
	requireMode(input.placement);
	const policy = mergePolicySets(input.policies ?? []);
	const approvalRequired = policy.requiresApproval(input.impact);
	const floor = enforcementFloor(input.impact, input.turnOwnedSession, input.sessionFilesystemTarget);
	const requested = policy.tierFor(input.impact) ?? "direct";
	const tier = floor === "mediated" || requested === "mediated" || input.placement !== "bundled" || approvalRequired ? "mediated" : "direct";
	return Object.freeze({
		approvalRequired,
		tier
	});
}
function mergePolicySets(policies) {
	if (policies.length === 0) return PolicySet.empty();
	const tiers = {};
	const approvals = /* @__PURE__ */ new Set();
	let placement = [...PLACEMENT_PREFERENCE];
	let maxDirectRevocationWindowMs;
	for (const policy of policies) {
		for (const impact of POLICY_IMPACTS) {
			const tier = policy.tierFor(impact);
			if (tier !== void 0 && (tiers[impact] === void 0 || tier === "mediated")) tiers[impact] = tier;
		}
		for (const impact of policy.approvals) approvals.add(impact);
		placement = placement.filter((mode) => policy.placement.admits(mode));
		if (policy.maxDirectRevocationWindowMs !== void 0) maxDirectRevocationWindowMs = maxDirectRevocationWindowMs === void 0 ? policy.maxDirectRevocationWindowMs : Math.min(maxDirectRevocationWindowMs, policy.maxDirectRevocationWindowMs);
	}
	let merged = {
		tiers,
		approvals: POLICY_IMPACTS.filter((impact) => approvals.has(impact)),
		placement: new PlacementPolicy(placement, ["*"])
	};
	if (maxDirectRevocationWindowMs !== void 0) merged = {
		...merged,
		maxDirectRevocationWindowMs
	};
	return new PolicySet(merged);
}
function validateDirectRevocationWindow(value) {
	if (value === void 0) return void 0;
	return requireDirectRevocationWindow(value);
}
function requireDirectRevocationWindow(value) {
	if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value)) throw new TypeError("Maximum direct revocation window must be a finite non-negative safe integer");
	return value;
}
function decodeOptionalDirectRevocationWindow(value) {
	if (value === null) return {};
	if (!isNumberValue$3(value)) throw new TypeError("Maximum direct revocation window is invalid");
	return { maxDirectRevocationWindowMs: requireDirectRevocationWindow(value) };
}
function canonicalTiers(tiers) {
	if (Object.keys(tiers).some((key) => !isMember(POLICY_IMPACTS, key))) throw new TypeError("Policy tiers contain an unknown impact");
	const canonical = {};
	for (const impact of POLICY_IMPACTS) {
		const tier = tiers[impact];
		if (tier !== void 0) canonical[impact] = requireTier(tier);
	}
	return Object.freeze(canonical);
}
function canonicalApprovals(approvals) {
	for (const impact of approvals) requireImpact(impact, "Policy approval impact");
	if (new Set(approvals).size !== approvals.length) throw new TypeError("Policy approval impacts must be unique");
	return Object.freeze(POLICY_IMPACTS.filter((impact) => approvals.includes(impact)));
}
function requireTiers(value) {
	const object = requireObject$6(value, "Policy tiers");
	const tiers = {};
	for (const [impact, tier] of Object.entries(object)) tiers[requireImpact(impact, "Policy tier impact")] = requireTier(tier);
	return tiers;
}
function requireImpactArray(value, subject) {
	if (!Array.isArray(value)) throw new TypeError(`${subject} must be an array`);
	return value.map((impact) => requireImpact(impact, subject));
}
function requireImpact(value, subject) {
	if (isMember(POLICY_IMPACTS, value)) return value;
	throw new TypeError(`${subject} is invalid`);
}
function requireTier(value) {
	if (value === "direct" || value === "mediated") return value;
	throw new TypeError("Policy enforcement tier is invalid");
}
function requireMode(value) {
	if (isMember(PLACEMENT_PREFERENCE, value)) return value;
	throw new TypeError("Policy placement is invalid");
}
function isNumberValue$3(value) {
	return typeof value === "number";
}
function requireObject$6(value, subject) {
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
	return value;
}
var emptyPolicySet = new PolicySet({ placement: PlacementPolicy.all() });
//#endregion
//#region src/definition/blueprint.ts
var PackageInstallCodec = class extends RecordCodec {
	constructor() {
		super([
			PackageInstall,
			TextId,
			Config,
			PackageDependency,
			SecretRef,
			PackageId
		], "definition.package-install", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(install) {
		return install.toData();
	}
	decodePayload(payload) {
		return PackageInstall.fromData(payload);
	}
};
var PackageInstall = class PackageInstall {
	static get codec() {
		return packageInstallCodecInstance;
	}
	request;
	config;
	constructor(init) {
		this.request = new PackageDependency(init.request.id, init.request.range);
		this.config = init.config instanceof Config ? Config.decode(Config.encode(init.config)) : new Config(init.config ?? {});
		Object.freeze(this);
	}
	static encode(install) {
		return PackageInstall.codec.encode(install);
	}
	static decode(bytes) {
		return PackageInstall.codec.decode(bytes);
	}
	static fromData(value) {
		const object = requireObject$5(value, "Package install");
		requireFields$3(object, ["config", "request"], [], "Package install");
		return new PackageInstall({
			request: PackageDependency.fromData(object["request"]),
			config: Config.fromData(requireObject$5(object["config"], "Package config"))
		});
	}
	toData() {
		return {
			config: this.config.toData(),
			request: this.request.toData()
		};
	}
};
var packageInstallCodecInstance = new PackageInstallCodec();
var BlueprintMeta = class BlueprintMeta {
	name;
	version;
	constructor(name, version) {
		this.name = name;
		this.version = version;
		requireNonblank(name, "Blueprint name");
		Object.freeze(this);
	}
	static fromData(value) {
		const object = requireObject$5(value, "Blueprint metadata");
		requireFields$3(object, ["name", "version"], [], "Blueprint metadata");
		return new BlueprintMeta(requireString$4(object["name"], "Blueprint name"), new SemVer(requireString$4(object["version"], "Blueprint version")));
	}
	toData() {
		return {
			name: this.name,
			version: this.version.toString()
		};
	}
};
var BlueprintCodec = class extends RecordCodec {
	constructor() {
		super([
			Blueprint,
			BlueprintMeta,
			SemVer,
			PolicySet,
			TreeMergePolicy,
			PackageInstall,
			AuthoredCodeBackingPolicy,
			PlacementPolicy,
			PackageId,
			AuthoredCodeBackingId,
			Config,
			TextId,
			SecretRef,
			PackageDependency
		], "definition.blueprint", {
			major: 3,
			minor: 0
		});
	}
	encodePayload(blueprint) {
		return blueprint.toData();
	}
	decodePayload(payload) {
		return Blueprint.fromData(payload);
	}
};
var Blueprint = class Blueprint {
	static get codec() {
		return blueprintCodecInstance;
	}
	meta;
	packages;
	policies;
	scopes;
	agents;
	slots;
	subscriptions;
	environments;
	surfaces;
	constructor(init) {
		const packages = [...init.packages].map((install) => PackageInstall.decode(PackageInstall.encode(install))).sort((left, right) => compareCanonicalText(left.request.id.value, right.request.id.value));
		if (new Set(packages.map((install) => install.request.id.value)).size !== packages.length) throw new TypeError("Blueprint root package IDs must be unique");
		this.meta = new BlueprintMeta(init.meta.name, init.meta.version);
		this.packages = Object.freeze(packages);
		if (!(init.policies instanceof PolicySet)) throw new TypeError("Blueprint policies must be a PolicySet");
		this.policies = PolicySet.decode(PolicySet.encode(init.policies));
		this.scopes = optionalCanonicalDeclarationMap(init.scopes, "Blueprint scope scaffold");
		this.agents = Object.freeze(init.agents.map((value) => canonicalDeclarationMap(value, "Blueprint agent")));
		this.slots = optionalCanonicalDeclarationArray(init.slots, "Blueprint slot");
		this.subscriptions = optionalCanonicalDeclarationArray(init.subscriptions, "Blueprint subscription");
		this.environments = optionalCanonicalDeclarationArray(init.environments, "Blueprint environment");
		this.surfaces = optionalCanonicalDeclarationMap(init.surfaces, "Blueprint surface layout");
		Object.freeze(this);
	}
	static encode(blueprint) {
		return Blueprint.codec.encode(blueprint);
	}
	static decode(bytes) {
		return Blueprint.codec.decode(bytes);
	}
	static fromData(value) {
		const object = requireObject$5(value, "Blueprint");
		requireFields$3(object, [
			"agents",
			"meta",
			"packages",
			"policies"
		], [
			"environments",
			"scopes",
			"slots",
			"subscriptions",
			"surfaces"
		], "Blueprint");
		let blueprint = {
			meta: BlueprintMeta.fromData(object["meta"]),
			packages: requireArray$2(object["packages"], "Blueprint packages").map(PackageInstall.fromData),
			policies: PolicySet.fromData(object["policies"]),
			agents: requireObjectArray(object["agents"], "Blueprint agents")
		};
		if (object["scopes"] !== void 0) blueprint = {
			...blueprint,
			scopes: requireObject$5(object["scopes"], "Blueprint scope scaffold")
		};
		if (object["slots"] !== void 0) blueprint = {
			...blueprint,
			slots: requireObjectArray(object["slots"], "Blueprint slots")
		};
		if (object["subscriptions"] !== void 0) blueprint = {
			...blueprint,
			subscriptions: requireObjectArray(object["subscriptions"], "Blueprint subscriptions")
		};
		if (object["environments"] !== void 0) blueprint = {
			...blueprint,
			environments: requireObjectArray(object["environments"], "Blueprint environments")
		};
		if (object["surfaces"] !== void 0) blueprint = {
			...blueprint,
			surfaces: requireObject$5(object["surfaces"], "Blueprint surface layout")
		};
		return new Blueprint(blueprint);
	}
	root(id) {
		const value = isPackageIdText(id) ? id : id.value;
		return this.packages.find((install) => install.request.id.value === value);
	}
	toData() {
		let data = {
			meta: this.meta.toData(),
			packages: this.packages.map((install) => install.toData()),
			policies: this.policies.toData(),
			agents: this.agents
		};
		if (this.scopes !== void 0) data = {
			...data,
			scopes: this.scopes
		};
		if (this.slots !== void 0) data = {
			...data,
			slots: this.slots
		};
		if (this.subscriptions !== void 0) data = {
			...data,
			subscriptions: this.subscriptions
		};
		if (this.environments !== void 0) data = {
			...data,
			environments: this.environments
		};
		if (this.surfaces !== void 0) data = {
			...data,
			surfaces: this.surfaces
		};
		return data;
	}
};
var blueprintCodecInstance = new BlueprintCodec();
function canonicalDeclarationMap(value, subject) {
	const canonical = canonicalFacetData(isDeclaration(value) ? value.toData() : value);
	if (!isJsonObject(canonical)) throw new TypeError(`${subject} must be an object declaration`);
	return canonical;
}
function optionalCanonicalDeclarationMap(value, subject) {
	return value === void 0 ? void 0 : canonicalDeclarationMap(value, subject);
}
function optionalCanonicalDeclarationArray(values, subject) {
	return values === void 0 ? void 0 : Object.freeze(values.map((value) => canonicalDeclarationMap(value, subject)));
}
function isDeclaration(value) {
	return value !== null && typeof value === "object" && "toData" in value && typeof value.toData === "function";
}
function requireObject$5(value, subject) {
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
	return value;
}
function requireObjectArray(value, subject) {
	return requireArray$2(value, subject).map((entry, index) => requireObject$5(entry, `${subject} entry ${index}`));
}
function requireArray$2(value, subject) {
	if (!Array.isArray(value)) throw new TypeError(`${subject} must be an array`);
	return value;
}
function requireFields$3(value, required, optional, subject) {
	const admitted = /* @__PURE__ */ new Set([...required, ...optional]);
	if (required.some((field) => !(field in value)) || Object.keys(value).some((field) => !admitted.has(field))) throw new TypeError(`${subject} contains missing or unknown fields`);
}
function requireString$4(value, subject) {
	if (!isStringValue$5(value)) throw new TypeError(`${subject} must be a string`);
	return value;
}
function isPackageIdText(value) {
	return typeof value === "string";
}
function isStringValue$5(value) {
	return typeof value === "string";
}
function requireNonblank(value, subject) {
	if (value.length === 0 || value !== value.trim()) throw new TypeError(`${subject} must be a nonblank canonical string`);
}
//#endregion
//#region src/definition/declaration.ts
var BlueprintDeclarationCodecPort = class {
	#codecs;
	constructor(codecs) {
		const map = /* @__PURE__ */ new Map();
		for (const codec of codecs) {
			if (map.has(codec.field)) throw new TypeError(`Duplicate Blueprint declaration codec for ${codec.field}`);
			map.set(codec.field, codec);
		}
		this.#codecs = map;
		Object.freeze(this);
	}
	canonicalize(field, value) {
		const codec = this.#codecs.get(field);
		if (codec === void 0) throw invalidDefinition(`Missing owner-published Blueprint declaration codec for ${field}`);
		return canonicalData$2(codec.canonicalize(canonicalData$2(value)));
	}
};
function canonicalData$2(value) {
	return decodeCanonicalJson(encodeCanonicalJson(value));
}
//#endregion
//#region src/definition/credential-custody.ts
/**
* One custody fact a Tenant-owned consumer's own record carries: the SecretRef the
* Tenant accepted and the exact target endpoint it authorized it for.
*/
var CredentialCustodyFact = class CredentialCustodyFact {
	secret;
	endpoint;
	constructor(secret, endpoint) {
		if (secret.constructor !== SecretRef) throw new TypeError("A credential custody fact requires an exact SecretRef");
		this.secret = new SecretRef(secret.source, secret.provider, secret.id);
		this.endpoint = requireExactEndpoint(endpoint);
		Object.freeze(this);
	}
	/**
	* The form a consumer's own durable record carries the fact in. It is exactly the
	* pairing §3.5 names — one SecretRef and one target endpoint — so a Binding's stored
	* custody and a Blueprint-declared Environment's are the same fact written down twice
	* rather than two custody vocabularies.
	*/
	static fromData(value, subject) {
		const object = requireCustodyObject(value, subject);
		if (!hasExactJsonKeys(object, ["endpoint", "secret"])) throw invalidDefinition(`${subject} contains missing or unknown fields`);
		const secret = requireCustodyObject(object["secret"], `${subject} SecretRef`);
		if (!hasExactJsonKeys(secret, [
			"id",
			"provider",
			"source"
		])) throw invalidDefinition(`${subject} SecretRef contains missing or unknown fields`);
		return new CredentialCustodyFact(new SecretRef(requireCustodyText(secret["source"], `${subject} SecretRef source`), requireCustodyText(secret["provider"], `${subject} SecretRef provider`), requireCustodyText(secret["id"], `${subject} SecretRef ID`)), requireCustodyText(object["endpoint"], `${subject} endpoint`));
	}
	get key() {
		return canonicalTupleKey("definition.credential-custody-fact.v1", [
			this.secret.source,
			this.secret.provider,
			this.secret.id,
			this.endpoint
		]);
	}
};
/**
* A resolution's outcome. Three shapes for three questions, because a custody refusal
* and a provider that does not answer are different facts with different consequences:
* §3.5 makes a confirmed custody refusal an ordinary failed attempt, while a provider
* outcome the seam does not hold settles nothing and stays indeterminate. A single
* absent-value result would answer both with one representation.
*
* `presented` carries nothing by construction: the credential went into transport and
* never to the caller, which is the isolation §3.5 asks substrates for.
*/
var CredentialResolution = class {
	static get presented() {
		return presentedResolution;
	}
	/** The provider's own answer, which the seam either holds or does not. */
	static get indeterminate() {
		return indeterminateResolution;
	}
	static refused(reason) {
		return new RefusedResolution(reason);
	}
};
var PresentedResolution = class extends CredentialResolution {
	outcome = "presented";
	refusal = void 0;
};
var IndeterminateResolution = class extends CredentialResolution {
	outcome = "indeterminate";
	refusal = void 0;
};
var RefusedResolution = class extends CredentialResolution {
	refusal;
	outcome = "refused";
	constructor(refusal) {
		super();
		this.refusal = refusal;
		Object.freeze(this);
	}
};
var presentedResolution = Object.freeze(new PresentedResolution());
var indeterminateResolution = Object.freeze(new IndeterminateResolution());
/**
* The declared custody a Blueprint-managed record carries, refused as a set rather than a
* list: one (SecretRef, endpoint) pair written twice is an inexact custody value, and §3.5
* makes exactness the rule wherever custody is written.
*/
function declaredCustodyFacts(desired, subject) {
	const declared = requireCustodyObject(desired, subject)[CUSTODY_DECLARATION_FIELD];
	if (declared === void 0) return [];
	if (!Array.isArray(declared) || declared.length === 0) throw invalidDefinition(`${subject} must be a nonempty list when it is declared`);
	const facts = declared.map((value) => CredentialCustodyFact.fromData(value, subject));
	const keys = /* @__PURE__ */ new Set();
	for (const fact of facts) {
		if (keys.has(fact.key)) throw invalidDefinition(`${subject} repeats one SecretRef and endpoint pair`);
		keys.add(fact.key);
	}
	return Object.freeze(facts);
}
/**
* A target endpoint is compared, never interpreted. §3.5 makes exactness the rule and
* leaves the endpoint's form to whoever records custody — a Binding already requires a
* canonical absolute URL, and an Environment's injection target need not be one at all —
* so restating that policy here would be a second copy of a rule this seam does not own.
* Comparing tokens is also fail-closed: two spellings of one endpoint refuse rather than
* resolve.
*/
function requireExactEndpoint(value) {
	if (value.length === 0 || value !== value.trim()) throw new TypeError("A credential target endpoint must be a nonblank exact token");
	return value;
}
var CUSTODY_DECLARATION_FIELD = "credentials";
function requireCustodyObject(value, subject) {
	if (!isJsonObject(value)) throw invalidDefinition(`${subject} must be an object`);
	return value;
}
function requireCustodyText(value, subject) {
	if (!isCustodyText(value) || value.length === 0 || value !== value.trim()) throw invalidDefinition(`${subject} must be a nonblank canonical string`);
	return value;
}
function isCustodyText(value) {
	return typeof value === "string";
}
//#endregion
//#region src/definition/materialization-kind.ts
/**
* Named so the stored-record decode path can tell "this build does not know this
* materialization kind" (forward compatible; the store may be reset and rebuilt) from
* "these bytes are corrupt". Both surface as codec.invalid, so a substring test on the
* message was the only thing carrying the distinction -- and RecordCodec.decode wraps a
* TypeError into a new message, so that test survived only by textual coincidence. An
* AgentCoreError subclass is rethrown by that wrapper unchanged.
*/
var UnknownMaterializationKindError = class extends AgentCoreError {
	constructor(recordKind) {
		super("codec.invalid", `Unsupported materialization record kind ${recordKind}`);
		this.name = "UnknownMaterializationKindError";
	}
};
/**
* The synthetic contributor the planner projects Blueprint-declared slots under
* (SPEC §9.3). A Blueprint declares slots from its own document (§9.2), not from a
* Package release, so slot-entry records under this contributor carry no source pin,
* and no Facet may claim the name: declaration validation refuses a manifest whose id
* would collide with it.
*/
var BLUEPRINT_CONTRIBUTOR = "blueprint";
var materializationKinds = Object.freeze({
	"agent-profile": declarationMapValidator("Agent profile"),
	environment: validateEnvironmentDeclaration,
	"facet-install": validateFacetInstall,
	"facet-placement": validateFacetPlacement,
	"policy-set": (desired) => PolicySet.fromData(desired).toData(),
	"scope-scaffold": declarationMapValidator("Scope scaffold"),
	"slot-entry": validateSlotEntry,
	subscription: (desired) => Automation.fromData(desired).toData(),
	"surface-layout": declarationMapValidator("Surface layout")
});
var materializationKindNames = Object.freeze(Object.keys(materializationKinds));
function supportedMaterializationKinds() {
	return materializationKindNames;
}
function validateMaterializationKind(recordKind, desired) {
	requireMaterializationKindValidator(recordKind)(desired);
}
function canonicalMaterializationDesired(recordKind, desired) {
	return requireMaterializationKindValidator(recordKind)(desired);
}
function requireMaterializationKindValidator(recordKind) {
	if (!Object.hasOwn(materializationKinds, recordKind)) throw new UnknownMaterializationKindError(recordKind);
	return materializationKinds[recordKind];
}
function validateFacetPlacement(desired) {
	const object = requireObject$4(desired, "Facet placement");
	if (!hasExactJsonKeys(object, [
		"facet",
		"manifest",
		"policy",
		"selected",
		"substrate",
		"trust"
	])) throw new TypeError("Facet placement contains missing or unknown fields");
	requireCanonicalName$3(object["facet"], "Placement facet");
	const input = new PlacementInput({
		manifest: requireModes(object["manifest"], "Manifest placement source"),
		policy: requireModes(object["policy"], "Policy placement source"),
		substrate: requireModes(object["substrate"], "Substrate placement source"),
		trust: requireModes(object["trust"], "Trust placement source")
	});
	requireCanonicalModes(object["manifest"], input.manifest, "Manifest placement source");
	requireCanonicalModes(object["policy"], input.policy, "Policy placement source");
	requireCanonicalModes(object["substrate"], input.substrate, "Substrate placement source");
	requireCanonicalModes(object["trust"], input.trust, "Trust placement source");
	if (selectPlacement(input).selected !== object["selected"]) throw new TypeError("Facet placement selection does not match its four-source intersection");
	return desired;
}
function validateFacetInstall(desired) {
	const object = requireObject$4(desired, "Facet install");
	if (!hasExactJsonKeys(object, [
		"facetId",
		"facetVersion",
		"packageId"
	])) throw new TypeError("Facet install contains missing or unknown fields");
	requireCanonicalName$3(object["facetId"], "Facet install facet ID");
	requireCanonicalName$3(object["facetVersion"], "Facet install facet version");
	requireCanonicalName$3(object["packageId"], "Facet install package ID");
	return desired;
}
function validateSlotEntry(desired) {
	const object = requireObject$4(desired, "Slot entry");
	const pinned = object["contributor"] !== BLUEPRINT_CONTRIBUTOR;
	if (!hasExactJsonKeys(object, pinned ? [
		"contributor",
		"index",
		"package",
		"slot",
		"value"
	] : [
		"contributor",
		"index",
		"slot",
		"value"
	])) throw new TypeError("Slot entry contains missing or unknown fields");
	requireCanonicalName$3(object["contributor"], "Slot entry contributor");
	requireCanonicalName$3(object["slot"], "Slot entry slot");
	requireNonnegativeInteger$1(object["index"], "Slot entry index");
	if (pinned) PackagePin.fromData(object["package"]);
	return desired;
}
function declarationMapValidator(subject) {
	return (desired) => {
		const object = requireObject$4(desired, subject);
		if (Object.keys(object).length === 0) throw invalidDefinition(`${subject} declaration must not be empty`);
		return desired;
	};
}
/**
* §3.5, §9.2: an Environment is one of the consumers that accepts a SecretRef, and the
* Tenant records that acceptance where it declares the Environment. The declaration's
* `credentials` entries are therefore the Environment's custody record — each an exact
* (SecretRef, endpoint) pair — validated here so an unpaired or malformed acceptance is
* refused before any Package code loads rather than at the resolution seam.
*/
function validateEnvironmentDeclaration(desired) {
	const object = requireObject$4(desired, "Environment");
	if (Object.keys(object).length === 0) throw invalidDefinition("Environment declaration must not be empty");
	declaredCustodyFacts(object, "Environment credential custody");
	return desired;
}
function requireObject$4(value, subject) {
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
	return value;
}
function requireCanonicalName$3(value, subject) {
	if (!isStringValue$4(value) || value.length === 0 || value !== value.trim()) throw new TypeError(`${subject} must be a nonblank canonical string`);
}
function requireNonnegativeInteger$1(value, subject) {
	if (!isNumberValue$2(value) || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${subject} must be a non-negative safe integer`);
}
function requireModes(value, subject) {
	if (!Array.isArray(value)) throw new TypeError(`${subject} must be an array`);
	return value.map((mode) => parseIsolationMode(mode, subject));
}
function isStringValue$4(value) {
	return typeof value === "string";
}
function isNumberValue$2(value) {
	return typeof value === "number";
}
function requireCanonicalModes(value, canonical, subject) {
	if (!Array.isArray(value) || value.length !== canonical.length || value.some((mode, index) => mode !== canonical[index])) throw new TypeError(`${subject} must use canonical placement order`);
}
//#endregion
//#region src/definition/attestation.ts
var ValidationAttestationCodec = class extends RecordCodec {
	constructor() {
		super([
			ValidationAttestation,
			TextId,
			SemVer,
			PlatformCompatibility,
			Digest
		], "definition.validation-attestation", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(attestation) {
		return attestation.toData();
	}
	decodePayload(payload) {
		return ValidationAttestation.fromData(payload);
	}
};
var ValidationAttestation = class ValidationAttestation {
	static get codec() {
		return validationAttestationCodecInstance;
	}
	static currentValidatorVersion = "definition-validator.v1";
	id;
	definitionDigest;
	blueprintDigest;
	packageLockDigest;
	snapshotDigest;
	configSchemaDigest;
	declarationDigest;
	placementDigest;
	target;
	validatorVersion;
	constructor(init) {
		const validatorVersion = requireCanonicalName$2(init.validatorVersion ?? ValidationAttestation.currentValidatorVersion, "Validator version");
		const data = attestationData({
			...init,
			validatorVersion
		});
		const id = Digest.sha256(encodeCanonicalJson(data));
		if (init.id !== void 0 && !init.id.equals(id)) throw new TypeError("Validation attestation ID does not match its canonical contents");
		this.id = id;
		this.definitionDigest = init.definitionDigest;
		this.blueprintDigest = init.blueprintDigest;
		this.packageLockDigest = init.packageLockDigest;
		this.snapshotDigest = init.snapshotDigest;
		this.configSchemaDigest = init.configSchemaDigest;
		this.declarationDigest = init.declarationDigest;
		this.placementDigest = init.placementDigest;
		this.target = PlatformCompatibility.fromData(init.target.toData());
		this.validatorVersion = validatorVersion;
		Object.freeze(this);
	}
	static encode(attestation) {
		return ValidationAttestation.codec.encode(attestation);
	}
	static decode(bytes) {
		return ValidationAttestation.codec.decode(bytes);
	}
	static fromData(value) {
		const object = requireObject$3(value, "Validation attestation");
		if (!hasExactJsonKeys(object, [
			"blueprintDigest",
			"configSchemaDigest",
			"declarationDigest",
			"definitionDigest",
			"id",
			"packageLockDigest",
			"placementDigest",
			"snapshotDigest",
			"target",
			"validatorVersion"
		])) throw new TypeError("Validation attestation contains missing or unknown fields");
		return new ValidationAttestation({
			id: digest(object["id"], "Validation attestation ID"),
			definitionDigest: digest(object["definitionDigest"], "Definition digest"),
			blueprintDigest: digest(object["blueprintDigest"], "Blueprint digest"),
			packageLockDigest: digest(object["packageLockDigest"], "Package lock digest"),
			snapshotDigest: digest(object["snapshotDigest"], "Snapshot digest"),
			configSchemaDigest: digest(object["configSchemaDigest"], "Config schema digest"),
			declarationDigest: digest(object["declarationDigest"], "Declaration digest"),
			placementDigest: digest(object["placementDigest"], "Placement digest"),
			target: PlatformCompatibility.fromData(object["target"]),
			validatorVersion: requireString$3(object["validatorVersion"], "Validator version")
		});
	}
	toData() {
		return {
			blueprintDigest: this.blueprintDigest.value,
			configSchemaDigest: this.configSchemaDigest.value,
			declarationDigest: this.declarationDigest.value,
			definitionDigest: this.definitionDigest.value,
			id: this.id.value,
			packageLockDigest: this.packageLockDigest.value,
			placementDigest: this.placementDigest.value,
			snapshotDigest: this.snapshotDigest.value,
			target: this.target.toData(),
			validatorVersion: this.validatorVersion
		};
	}
};
var validationAttestationCodecInstance = new ValidationAttestationCodec();
function attestationData(init) {
	return {
		blueprintDigest: init.blueprintDigest.value,
		configSchemaDigest: init.configSchemaDigest.value,
		declarationDigest: init.declarationDigest.value,
		definitionDigest: init.definitionDigest.value,
		packageLockDigest: init.packageLockDigest.value,
		placementDigest: init.placementDigest.value,
		snapshotDigest: init.snapshotDigest.value,
		target: init.target.toData(),
		validatorVersion: init.validatorVersion
	};
}
function digest(value, subject) {
	return new Digest(requireString$3(value, subject));
}
function requireObject$3(value, subject) {
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
	return value;
}
function requireString$3(value, subject) {
	if (!isStringValue$3(value)) throw new TypeError(`${subject} must be a string`);
	return value;
}
function isStringValue$3(value) {
	return typeof value === "string";
}
function requireCanonicalName$2(value, subject) {
	if (value.length === 0 || value !== value.trim()) throw new TypeError(`${subject} must be a nonblank canonical string`);
	return value;
}
//#endregion
//#region src/definition/validator.ts
var CORE_SLOT_NAMES = /* @__PURE__ */ new Set([
	"automations",
	"commands",
	"events",
	"ingress",
	"interceptors",
	"operations",
	"prompt",
	"settings",
	"slots",
	"surfaces"
]);
var SLOT_DECLARATIONS = new SlotName("slots");
var OPERATION_DECLARATIONS = new SlotName("operations");
var AUTHORED_CODE_OPERATION_CONSUMER = "programmaticToolCall";
var PlacementSourcePort = class {};
var ValidatedBlueprint = class ValidatedBlueprint {
	#blueprint;
	#lock;
	#configSchema;
	#declarations;
	#releases;
	#attestation;
	#placements;
	#bytes;
	digest;
	constructor(init) {
		this.#blueprint = init.blueprint;
		this.#lock = init.lock;
		this.#configSchema = init.configSchema;
		this.#declarations = Object.freeze(init.declarations.map((declaration) => Object.freeze({
			contributor: declaration.contributor,
			index: declaration.index,
			slot: declaration.slot,
			value: canonicalFacetData(declaration.value),
			...declaration.package && { package: declaration.package }
		})));
		this.#bytes = encodeCanonicalJson({
			blueprint: init.blueprint.toData(),
			lock: init.lock.toData(),
			releases: init.releases.map((release) => release.toData())
		});
		this.digest = Digest.sha256(this.#bytes);
		this.#releases = Object.freeze([...init.releases]);
		this.#attestation = init.attestation;
		this.#placements = Object.freeze([...init.placements]);
		Object.freeze(this);
	}
	static validate(blueprint, options) {
		const releases = exactLockedReleases(blueprint, options.lock, options.releases);
		if (!options.lock.target.equals(options.target)) throw invalidDefinition("PackageLock compatibility target does not match the current platform");
		const configSchema = composeConfigSchema(options.baseConfigSchema ?? BASE_CONFIG_SCHEMA, releases);
		const settings = settingsData(blueprint, releases);
		const schemaValidator = options.schemaValidator ?? strictJsonSchemaValidator;
		if (!configSchema.accepts(settings, schemaValidator)) throw invalidDefinition("Blueprint package config does not match the composed config schema");
		validateOwnerDeclarations(blueprint, options.declarationCodecs);
		const declarations = validateDeclarations(blueprint, releases, schemaValidator, options.coreSlots ?? [], options.placement);
		validateReliance(releases, options.target);
		const placements = validatePlacements(blueprint, releases, options.placement);
		const blueprintDigest = Digest.sha256(Blueprint.encode(blueprint));
		const declarationDigest = Digest.sha256(encodeCanonicalJson(declarations.map((declaration) => ({
			contributor: declaration.contributor,
			index: declaration.index,
			slot: declaration.slot,
			value: declaration.value,
			...declaration.package && { package: declaration.package.toData() }
		}))));
		const configSchemaDigest = Digest.sha256(encodeCanonicalJson(configSchema.document));
		const attestation = new ValidationAttestation({
			definitionDigest: Digest.sha256(encodeCanonicalJson({
				blueprint: blueprint.toData(),
				lock: options.lock.toData(),
				releases: releases.map((release) => release.toData())
			})),
			blueprintDigest,
			packageLockDigest: options.lock.digest,
			snapshotDigest: options.lock.snapshotDigest,
			configSchemaDigest,
			declarationDigest,
			placementDigest: Digest.sha256(encodeCanonicalJson(placements.map((placement) => ({
				facetId: placement.facetId,
				facetVersion: placement.facetVersion,
				packageId: placement.packageId,
				selection: placementData(placement.selection)
			})))),
			target: options.target
		});
		return new ValidatedBlueprint({
			blueprint,
			lock: options.lock,
			configSchema,
			declarations,
			releases,
			attestation,
			placements
		});
	}
	get blueprint() {
		return this.#blueprint;
	}
	get lock() {
		return this.#lock;
	}
	get configSchema() {
		return this.#configSchema;
	}
	get declarations() {
		return this.#declarations;
	}
	get releases() {
		return this.#releases;
	}
	get attestation() {
		return this.#attestation;
	}
	get placements() {
		return this.#placements;
	}
	bytes() {
		return this.#bytes.slice();
	}
	/**
	* Refuse a pinned Package closure that is not this Blueprint's closure (SPEC §9.1).
	* `validate` has already proven `lock` is the deterministic resolution of the declared
	* dependency relation from the Blueprint's own `packages` list, so equality against
	* `lock.packages` is equality against the transitive closure resolved to exact
	* versions — a pinned closure needs no second derivation to be checkable. A pin set
	* that merely looks complete is refused by the member it diverges on: naming a Package
	* the closure does not resolve, and pinning a resolved Package at another release, are
	* different errors and get different refusals.
	*/
	requirePinnedClosure(pins) {
		const declaredVersion = this.#blueprint.meta.version;
		if (!pins.blueprint.version.equals(declaredVersion) || !pins.blueprint.digest.equals(this.#attestation.blueprintDigest)) throw invalidDefinition(`Pinned Blueprint ${pins.blueprint.version.toString()} is not the validated Blueprint ${declaredVersion.toString()}`);
		const closure = this.#lock.packages;
		for (const pin of pins.packages) {
			const declared = closure.find((candidate) => candidate.id.equals(pin.id));
			if (declared === void 0) throw invalidDefinition(`Pinned Package ${pin.id.value} is outside the declared closure`);
			if (!declared.equals(pin)) throw invalidDefinition(`Pinned Package ${pin.id.value} is pinned at a release the declared closure does not resolve`);
		}
		const absent = closure.find((declared) => !pins.packages.some((pin) => pin.id.equals(declared.id)));
		if (absent !== void 0) throw invalidDefinition(`Declared closure member ${absent.id.value} is absent from the pinned closure`);
		if (pins.packages.length !== closure.length) throw invalidDefinition("Pinned Package closure repeats a Package ID");
	}
};
function validatePlacements(blueprint, releases, source) {
	const placements = releases.flatMap((release) => release.manifests.map((manifest) => {
		const selected = selectPlacement(new PlacementInput({
			manifest: manifest.isolation,
			policy: blueprint.policies.placement.allowed,
			substrate: source.substrateModes(release, manifest),
			trust: blueprint.policies.placement.trustedModes(release.id)
		}));
		return Object.freeze({
			packageId: release.id.value,
			facetId: manifest.id.value,
			facetVersion: manifest.version.toString(),
			selection: selected
		});
	}));
	return Object.freeze(placements);
}
function placementData(selection) {
	return {
		manifest: selection.manifest,
		policy: selection.policy,
		selected: selection.selected,
		substrate: selection.substrate,
		trust: selection.trust
	};
}
var BlueprintValidator = class {
	options;
	constructor(options) {
		this.options = options;
		Object.freeze(this);
	}
	validate(blueprint) {
		return ValidatedBlueprint.validate(blueprint, this.options);
	}
};
function validateBlueprint(blueprint, options) {
	return ValidatedBlueprint.validate(blueprint, options);
}
function exactLockedReleases(blueprint, lock, releases) {
	const snapshot = new MetadataSnapshot({
		revision: lock.snapshotRevision,
		digest: lock.snapshotDigest,
		releases
	});
	const resolved = resolvePackageLock(snapshot, blueprint.packages.map((install) => install.request), lock.target);
	if (!bytesEqual$1(PackageLock.encode(resolved), PackageLock.encode(lock))) throw invalidDefinition("PackageLock does not match deterministic resolution of its metadata snapshot");
	return Object.freeze(lock.packages.map((pin) => {
		const release = snapshot.releases.find((candidate) => matchesPin(candidate, pin));
		if (release === void 0) throw invalidDefinition(`Package metadata does not match lock pin ${pin.id.value}`);
		return release;
	}));
}
function releasePin(release) {
	return new PackagePin(release.id, release.version, release.manifestDigest, release.codeDigest);
}
function matchesPin(release, pin) {
	return release.id.equals(pin.id) && release.version.equals(pin.version) && release.manifestDigest.equals(pin.manifestDigest) && release.codeDigest.equals(pin.codeDigest);
}
function settingsData(blueprint, releases) {
	const roots = new Map(blueprint.packages.map((install) => [install.request.id.value, install.config.toData()]));
	return Object.fromEntries(releases.map((release) => [release.id.value, roots.get(release.id.value) ?? {}]));
}
function validateDeclarations(blueprint, releases, schemaValidator, coreSlots, placement) {
	const slots = /* @__PURE__ */ new Map();
	for (const slot of coreSlots) addSlot(slots, slot, "Core slot");
	for (const data of blueprint.slots ?? []) {
		const slot = SlotDeclaration.fromData(data);
		rejectCoreSlotRedefinition(slot);
		addSlot(slots, slot, "Blueprint slot");
	}
	const manifests = releases.flatMap((release) => release.manifests.map((manifest) => ({
		manifest,
		pin: releasePin(release)
	}))).sort((left, right) => compareManifests(left.manifest, right.manifest));
	for (const { manifest } of manifests) if (manifest.id.value === "blueprint") throw invalidDefinition(`Facet id ${BLUEPRINT_CONTRIBUTOR} is reserved for Blueprint-declared slots`);
	for (const { manifest } of manifests) for (const value of manifest.contributions.get(SLOT_DECLARATIONS) ?? []) {
		const slot = SlotDeclaration.fromData(value);
		rejectCoreSlotRedefinition(slot);
		addSlot(slots, slot, `Package ${manifest.id.value} slot`);
	}
	const declarations = [];
	for (const { manifest, pin } of manifests) for (const contribution of manifest.contributions.entries) for (const [index, value] of contribution.entries.entries()) {
		validateCoreContribution(contribution.slot.value, value);
		const slot = slots.get(contribution.slot.value);
		if (!CORE_SLOT_NAMES.has(contribution.slot.value) && slot === void 0) throw invalidDefinition(`Contribution targets undeclared slot ${contribution.slot.value}`);
		if (slot !== void 0 && !slot.entrySchema.accepts(value, schemaValidator)) throw invalidDefinition(`Contribution does not match slot ${contribution.slot.value}`);
		declarations.push({
			contributor: manifest.id.value,
			index,
			slot: contribution.slot.value,
			value,
			package: pin
		});
	}
	const facets = manifests.map(({ manifest }) => manifest);
	validateCommandSurfaceSlots(facets, slots);
	validateAuthoredCodeAvailability(blueprint, facets, placement);
	declarations.sort(compareDeclarations);
	return Object.freeze(declarations);
}
function validateCoreContribution(slot, value) {
	switch (slot) {
		case "automations":
			Automation.fromData(value);
			break;
		case "commands":
			Command.fromData(value);
			break;
		case "events":
			EventDeclaration.fromData(value);
			break;
		case "ingress":
			IngressDeclaration.fromData(value);
			break;
		case "interceptors":
			InterceptorDeclaration.fromData(value);
			break;
		case "operations":
			OperationDescriptor.fromData(value);
			break;
		case "prompt":
			validatePromptContribution(value);
			break;
		case "surfaces":
			SurfaceDescriptor.fromData(value);
			break;
	}
}
function validatePromptContribution(value) {
	if (!Array.isArray(value)) throw invalidDefinition("Prompt contribution must be an array");
	new PromptContribution(value.map(Prompt.fromData));
}
function validateCommandSurfaceSlots(manifests, slots) {
	for (const manifest of manifests) for (const value of manifest.contributions.get(new SlotName("commands")) ?? []) {
		const command = Command.fromData(value);
		for (const surface of command.surfaces) if (!CORE_SLOT_NAMES.has(surface.value) && !slots.has(surface.value)) throw invalidDefinition(`Command ${command.name} targets undeclared surface slot ${surface.value}`);
	}
}
/**
* SPEC §4.7 / C13-FACET-CODE-AVAILABILITY: an Operation the model is offered and an
* isolate cannot reach is a catalog that was already wrong when it was assembled, so a
* `code`- or `both`-available Operation is refused here rather than at the first
* submission that needs it.
*
* Whether the platform serves programmatic tool calling is one fact about the Blueprint
* and the profile, not one per Operation, so it is decided once. When it is served the
* declarations need no walk at all; when it is not, the walk names the first Operation
* that depends on it in canonical manifest order.
*/
function validateAuthoredCodeAvailability(blueprint, manifests, placement) {
	if (blueprint.policies.placement.backings.consumers.includes(AUTHORED_CODE_OPERATION_CONSUMER) || placement.authoredCodeBackingDefault(AUTHORED_CODE_OPERATION_CONSUMER) !== void 0) return;
	for (const manifest of manifests) for (const value of manifest.contributions.get(OPERATION_DECLARATIONS) ?? []) {
		const descriptor = OperationDescriptor.fromData(value);
		if (descriptor.availability.reachableByAuthoredCode) throw invalidDefinition(`Facet ${manifest.id.value} Operation ${descriptor.name.value} declares ${descriptor.availability.label} availability to agent-authored code, but no backing serves the ${AUTHORED_CODE_OPERATION_CONSUMER} consumer`);
	}
}
function addSlot(slots, slot, subject) {
	slot.entrySchema.assertValid();
	if (slots.has(slot.name.value)) throw invalidDefinition(`${subject} duplicates slot ${slot.name.value}`);
	slots.set(slot.name.value, slot);
}
function rejectCoreSlotRedefinition(slot) {
	if (CORE_SLOT_NAMES.has(slot.name.value)) throw invalidDefinition(`Core slot ${slot.name.value} cannot be redefined`);
}
function validateOwnerDeclarations(blueprint, codecs) {
	const declarations = [
		["scopes", blueprint.scopes === void 0 ? [] : [blueprint.scopes]],
		["agents", blueprint.agents],
		["slots", blueprint.slots ?? []],
		["subscriptions", blueprint.subscriptions ?? []],
		["environments", blueprint.environments ?? []],
		["surfaces", blueprint.surfaces === void 0 ? [] : [blueprint.surfaces]]
	];
	for (const [field, values] of declarations) for (const value of values) {
		if (codecs === void 0) throw invalidDefinition(`Blueprint ${field} requires an owner-published declaration codec`);
		if (!bytesEqual$1(encodeCanonicalJson(codecs.canonicalize(field, value)), encodeCanonicalJson(value))) throw invalidDefinition(`Blueprint ${field} declaration is not canonical for its owner codec`);
	}
}
/**
* SPEC §4.1 / C13-FACET-DEPENDENCY-ORDER: reliance is computable before any package code
* loads from the installed manifests' `BindingRequirement`s, so a reliance cycle rejects
* the Blueprint here rather than deadlocking a live reconciliation.
*
* Two boundaries fix what this may decide. Reliance is over `FacetPackageId`s and the
* Package dependency relation is over `PackageId`s: §9.1 permits a cyclic Package
* dependency, and a host MUST NOT derive either relation from the other, so a requirement
* naming a Facet this closure does not install is not a defect — the provider it resolves
* to is a live `FacetRef` on the §3.4 Grant plane, which is why an unsatisfied requirement
* is gated at `start` and never guessed at from the closure. What is decidable from data
* alone is whether a requirement's own declared spec/host range admits the platform the
* Blueprint is validated for, and whether the requirements the installed manifests declare
* close a cycle among themselves.
*
* Every requirement's range is decided before any cycle is reported, so one closure always
* yields one refusal.
*/
function validateReliance(releases, target) {
	const manifests = releases.flatMap((release) => release.manifests).sort(compareManifests);
	for (const manifest of manifests) for (const requirement of manifest.bindings) if (!compatibilityAdmits(requirement.compat, target)) throw invalidDefinition(`Facet ${manifest.id.value} requires Binding ${requirement.name.value} from Facet ${requirement.facet.value} at spec ${requirement.compat.spec} host ${requirement.compat.host}, which the validated platform spec ${target.spec.toString()} host ${target.host.toString()} does not admit`);
	const cycle = findRelianceCycle(relianceGraph(manifests));
	if (cycle !== void 0) throw invalidDefinition(`Facet reliance cycle ${[...cycle, ...cycle.slice(0, 1)].join(" -> ")}`);
}
function relianceGraph(manifests) {
	const graph = /* @__PURE__ */ new Map();
	for (const manifest of manifests) {
		const edges = graph.get(manifest.id.value) ?? [];
		for (const requirement of manifest.bindings) if (!edges.includes(requirement.facet.value)) edges.push(requirement.facet.value);
		graph.set(manifest.id.value, edges.sort(compareCanonicalText));
	}
	return graph;
}
function findRelianceCycle(graph) {
	const settled = /* @__PURE__ */ new Set();
	const walking = /* @__PURE__ */ new Set();
	const path = [];
	const visit = (node) => {
		if (walking.has(node)) return canonicalCycle(path.slice(path.indexOf(node)));
		if (settled.has(node)) return void 0;
		walking.add(node);
		path.push(node);
		for (const next of graph.get(node) ?? []) {
			const cycle = visit(next);
			if (cycle !== void 0) return cycle;
		}
		path.pop();
		walking.delete(node);
		settled.add(node);
	};
	for (const node of graph.keys()) {
		const cycle = visit(node);
		if (cycle !== void 0) return cycle;
	}
}
function canonicalCycle(cycle) {
	const lowest = cycle.reduce((left, right) => compareCanonicalText(right, left) < 0 ? right : left);
	const start = cycle.indexOf(lowest);
	return [...cycle.slice(start), ...cycle.slice(0, start)];
}
function compareManifests(left, right) {
	return compareCanonicalText(left.id.value, right.id.value) || compareCanonicalText(left.version.toString(), right.version.toString());
}
function compareDeclarations(left, right) {
	return compareCanonicalText(left.contributor, right.contributor) || compareCanonicalText(left.slot, right.slot) || left.index - right.index;
}
function bytesEqual$1(left, right) {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
//#endregion
//#region src/definition/loader.ts
var PackageModuleEvaluator = class {};
var PackageModuleInspector = class {};
var PackageCorrespondencePort = class {};
var BlueprintLoader = class {
	#validator;
	#content;
	#inspector;
	#evaluator;
	#correspondence;
	constructor(options) {
		this.#validator = new BlueprintValidator(options);
		this.#content = options.content;
		this.#inspector = options.inspector;
		this.#evaluator = options.evaluator;
		this.#correspondence = options.correspondence;
	}
	async load(blueprint) {
		const validated = this.#validator.validate(blueprint);
		const verified = [];
		for (const release of validated.releases) {
			const pin = exactPin(validated, release);
			for (const module of release.codeManifest.modules) {
				const loaded = await this.#content.get(module.content);
				if (!(loaded instanceof Uint8Array)) throw invalidDefinition(`Loaded module bytes do not match ${module.content.value}`);
				const bytes = loaded.slice();
				verifyContent(module.content, bytes);
				verifyImports(module, await this.#inspector.imports(module, bytes.slice()));
				verified.push(Object.freeze({
					pin,
					release,
					module,
					bytes,
					selected: selectedMode(validated, release, module)
				}));
			}
		}
		const modules = [];
		try {
			for (const module of verified) {
				const value = await this.#evaluator.evaluate(Object.freeze({
					...module,
					bytes: module.bytes.slice()
				}));
				modules.push(Object.freeze({
					release: module.release,
					module: module.module,
					value
				}));
			}
			for (const release of validated.releases) await this.#correspondence.validate(release, modules.filter((module) => module.release === release));
		} catch (error) {
			await disposeModules(this.#evaluator, modules, { error });
		}
		return new ScopedLoadedBlueprint(validated, modules, this.#evaluator);
	}
};
var ScopedLoadedBlueprint = class {
	validated;
	evaluator;
	modules;
	#disposed = false;
	constructor(validated, modules, evaluator) {
		this.validated = validated;
		this.evaluator = evaluator;
		this.modules = Object.freeze([...modules]);
		Object.freeze(this);
	}
	async dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		await disposeModules(this.evaluator, this.modules);
	}
	async [Symbol.asyncDispose]() {
		await this.dispose();
	}
};
function selectedMode(validated, release, module) {
	const reachableFacets = new Set(release.codeManifest.entrypoints.filter((entrypoint) => entrypointReachesModule(release, entrypoint.module, module.specifier)).map((entrypoint) => entrypoint.facet.value));
	const candidates = validated.placements.filter((placement) => placement.packageId === release.id.value && reachableFacets.has(placement.facetId)).map((placement) => placement.selection.selected);
	const modes = [...new Set(candidates)];
	if (modes.length !== 1) throw invalidDefinition(`Package module ${module.specifier} spans incompatible placement modes`);
	return modes[0];
}
function entrypointReachesModule(release, entrypoint, target) {
	const pending = [entrypoint];
	const visited = /* @__PURE__ */ new Set();
	while (pending.length > 0) {
		const specifier = pending.pop();
		if (specifier === target) return true;
		if (visited.has(specifier)) continue;
		visited.add(specifier);
		pending.push(...release.codeManifest.module(specifier).imports);
	}
	return false;
}
function verifyImports(module, imports) {
	const canonical = [...imports].sort(compareCanonicalText);
	if (new Set(canonical).size !== canonical.length || canonical.length !== module.imports.length || canonical.some((value, index) => value !== module.imports[index])) throw invalidDefinition(`Inspected imports do not match code manifest for ${module.specifier}`);
}
function verifyContent(reference, bytes) {
	if (!(bytes instanceof Uint8Array) || !Digest.sha256(bytes).equals(reference.digest)) throw invalidDefinition(`Loaded module bytes do not match ${reference.value}`);
}
function exactPin(validated, release) {
	const pin = validated.lock.packages.find((candidate) => candidate.id.equals(release.id));
	if (pin === void 0 || !pin.version.equals(release.version) || !pin.manifestDigest.equals(release.manifestDigest) || !pin.codeDigest.equals(release.codeDigest)) throw invalidDefinition(`Package release ${release.id.value} does not match its exact pin`);
	return pin;
}
async function disposeModules(evaluator, modules, preserved) {
	let failure = preserved?.error;
	let failed = preserved !== void 0;
	for (const module of [...modules].reverse()) try {
		await evaluator.dispose(module);
	} catch (error) {
		if (!failed) failure = error;
		failed = true;
	}
	if (failed) throw failure;
}
//#endregion
//#region src/definition/plan.ts
var PLACEMENT_RECORD_KIND = "facet-placement";
var DesiredProjection = class DesiredProjection {
	logicalKey;
	recordKind;
	desired;
	desiredDigest;
	constructor(init) {
		const logicalKey = init.logicalKey;
		const recordKind = init.recordKind;
		const expectedDigest = init.desiredDigest;
		requireCanonicalName$1(logicalKey, "Desired projection logical key");
		requireCanonicalName$1(recordKind, "Desired projection record kind");
		const desired = canonicalData$1(canonicalMaterializationDesired(recordKind, canonicalData$1(init.desired)));
		const desiredDigest = digestData$1({
			desired,
			recordKind
		});
		if (expectedDigest !== void 0 && !expectedDigest.equals(desiredDigest)) throw new TypeError("Desired projection digest does not match its canonical contents");
		this.logicalKey = logicalKey;
		this.recordKind = recordKind;
		this.desired = desired;
		this.desiredDigest = desiredDigest;
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireObject$2(payload, "Desired projection");
		requireFields$2(object, [
			"desired",
			"desiredDigest",
			"logicalKey",
			"recordKind"
		], "Desired projection");
		return new DesiredProjection({
			logicalKey: requireString$2(object["logicalKey"], "Desired projection logical key"),
			recordKind: requireString$2(object["recordKind"], "Desired projection record kind"),
			desired: requireValue$1(object["desired"], "Desired projection value"),
			desiredDigest: new Digest(requireString$2(object["desiredDigest"], "Desired projection digest"))
		});
	}
	toData() {
		return {
			desired: this.desired,
			desiredDigest: this.desiredDigest.value,
			logicalKey: this.logicalKey,
			recordKind: this.recordKind
		};
	}
};
function placementProjection(logicalKey, facet, selection) {
	requireCanonicalName$1(facet, "Placement facet");
	const selected = preferredPlacement(selection.manifest, selection.policy, selection.substrate, selection.trust);
	validatePlacementSelection(selected, selection.selected);
	return new DesiredProjection({
		logicalKey,
		recordKind: PLACEMENT_RECORD_KIND,
		desired: {
			facet,
			manifest: selection.manifest,
			policy: selection.policy,
			selected,
			substrate: selection.substrate,
			trust: selection.trust
		}
	});
}
function policyProjection(logicalKey, policy) {
	return new DesiredProjection({
		logicalKey,
		recordKind: "policy-set",
		desired: policy.toData()
	});
}
function facetInstallProjection(logicalKey, install) {
	return new DesiredProjection({
		logicalKey,
		recordKind: "facet-install",
		desired: {
			facetId: install.facetId,
			facetVersion: install.facetVersion,
			packageId: install.packageId
		}
	});
}
function slotEntryProjection(logicalKey, entry) {
	return new DesiredProjection({
		logicalKey,
		recordKind: "slot-entry",
		desired: {
			contributor: entry.contributor,
			index: entry.index,
			slot: entry.slot,
			value: entry.value,
			...entry.package && { package: entry.package.toData() }
		}
	});
}
function subscriptionProjection(logicalKey, template) {
	return new DesiredProjection({
		logicalKey,
		recordKind: "subscription",
		desired: template
	});
}
function declarationProjection(recordKind, logicalKey, declaration) {
	return new DesiredProjection({
		logicalKey,
		recordKind,
		desired: declaration
	});
}
var ActorPlanCodec = class extends RecordCodec {
	constructor() {
		super([
			ActorPlan,
			ActorRef,
			CredentialCustodyFact,
			DesiredProjection,
			SecretRef,
			TextId,
			ManagedOrigin,
			Digest,
			ActorId,
			TenantId,
			DeploymentId,
			BindingName,
			PolicySet,
			TreeMergePolicy,
			FacetPackageId,
			PlacementInput,
			PlacementSelection,
			PlacementIntersection,
			OperationName,
			OperationRef,
			AuthoredCodeBackingPolicy,
			BoundOperationRef,
			MappingRecord,
			FieldMove,
			Automation,
			EventPattern,
			PayloadMapping,
			PlacementPolicy,
			AuthoredCodeBackingId,
			JsonPointer,
			SemVer,
			PackageId,
			PackagePin
		], "definition.actor-plan", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(plan) {
		return plan.toData();
	}
	decodePayload(payload) {
		return ActorPlan.fromData(payload);
	}
};
var ActorPlan = class ActorPlan {
	static get codec() {
		return actorPlanCodecInstance;
	}
	id;
	actor;
	origin;
	projections;
	constructor(init) {
		for (const projection of init.projections) validateProjection(projection);
		const projections = canonicalProjections(init.projections);
		const id = actorPlanId(init.actor, init.origin, projections);
		if (init.id !== void 0 && !init.id.equals(id)) throw new TypeError("Actor plan ID does not match its canonical contents");
		this.id = id;
		this.actor = copyActorRef$1(init.actor);
		this.origin = init.origin;
		this.projections = Object.freeze(projections);
		Object.freeze(this);
	}
	static encode(plan) {
		return ActorPlan.codec.encode(plan);
	}
	static decode(bytes) {
		return ActorPlan.codec.decode(bytes);
	}
	static fromData(payload) {
		const object = requireObject$2(payload, "Actor plan");
		requireFields$2(object, [
			"actor",
			"id",
			"origin",
			"projections"
		], "Actor plan");
		const projections = requireArray$1(object["projections"], "Actor plan projections").map(DesiredProjection.fromData);
		return new ActorPlan({
			id: new Digest(requireString$2(object["id"], "Actor plan ID")),
			actor: actorRefFromData$1(requireValue$1(object["actor"], "Actor plan actor")),
			origin: ManagedOrigin.fromData(requireValue$1(object["origin"], "Actor plan origin")),
			projections
		});
	}
	toData() {
		return {
			actor: actorRefData$1(this.actor),
			id: this.id.value,
			origin: this.origin.toData(),
			projections: this.projections.map((projection) => projection.toData())
		};
	}
};
var actorPlanCodecInstance = new ActorPlanCodec();
var MaterializationPlanCodec = class extends RecordCodec {
	constructor() {
		super([
			MaterializationPlan,
			CredentialCustodyFact,
			SecretRef,
			TextId,
			ManagedOrigin,
			ActorPlan,
			DesiredProjection,
			Digest,
			ActorRef,
			ActorId,
			TenantId,
			DeploymentId,
			BindingName,
			PolicySet,
			TreeMergePolicy,
			FacetPackageId,
			PlacementInput,
			PlacementSelection,
			PlacementIntersection,
			OperationName,
			OperationRef,
			AuthoredCodeBackingPolicy,
			BoundOperationRef,
			MappingRecord,
			FieldMove,
			Automation,
			EventPattern,
			PayloadMapping,
			PlacementPolicy,
			AuthoredCodeBackingId,
			JsonPointer,
			SemVer,
			PackageId,
			PackagePin
		], "definition.materialization-plan", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(plan) {
		return plan.toData();
	}
	decodePayload(payload) {
		return MaterializationPlan.fromData(payload);
	}
};
var MaterializationPlan = class MaterializationPlan {
	static get codec() {
		return materializationPlanCodecInstance;
	}
	id;
	origin;
	actors;
	constructor(init) {
		for (const actor of init.actors) validateActorPlan(actor);
		const actors = canonicalActorPlans(init.actors);
		if (actors.some((actorPlan) => !actorPlan.origin.equals(init.origin))) throw new TypeError("Every Actor plan must have the materialization plan origin");
		const id = materializationPlanId(init.origin, actors);
		if (init.id !== void 0 && !init.id.equals(id)) throw new TypeError("Materialization plan ID does not match its canonical contents");
		this.id = id;
		this.origin = init.origin;
		this.actors = Object.freeze(actors);
		Object.freeze(this);
	}
	get blueprintDigest() {
		return this.origin.blueprintDigest;
	}
	get packageLockDigest() {
		return this.origin.packageLockDigest;
	}
	get configDigest() {
		return this.origin.configDigest;
	}
	get generation() {
		return this.origin.generation;
	}
	static encode(plan) {
		return MaterializationPlan.codec.encode(plan);
	}
	static decode(bytes) {
		return MaterializationPlan.codec.decode(bytes);
	}
	static fromData(payload) {
		const object = requireObject$2(payload, "Materialization plan");
		requireFields$2(object, [
			"actors",
			"id",
			"origin"
		], "Materialization plan");
		const actors = requireArray$1(object["actors"], "Materialization plan Actors").map(ActorPlan.fromData);
		return new MaterializationPlan({
			id: new Digest(requireString$2(object["id"], "Materialization plan ID")),
			origin: ManagedOrigin.fromData(requireValue$1(object["origin"], "Materialization plan origin")),
			actors
		});
	}
	toData() {
		return {
			actors: this.actors.map((actor) => actor.toData()),
			id: this.id.value,
			origin: this.origin.toData()
		};
	}
};
var materializationPlanCodecInstance = new MaterializationPlanCodec();
var MaterializationTopologyPort = class {};
function planMaterialization(input) {
	if (!(input.validatedBlueprint instanceof ValidatedBlueprint)) throw invalidDefinition("Materialization planning requires a ValidatedBlueprint");
	const projections = attestedProjections(input.validatedBlueprint);
	const lock = input.validatedBlueprint.lock;
	const deploymentId = DeploymentId.derive(input.tenantId, input.deploymentKey);
	const origin = new ManagedOrigin({
		tenantId: input.tenantId,
		deploymentId,
		attestationDigest: input.validatedBlueprint.attestation.id,
		blueprintDigest: Digest.sha256(Blueprint.encode(input.validatedBlueprint.blueprint)),
		packageLockDigest: lock.digest,
		configDigest: digestData$1(validatedConfig(input.validatedBlueprint)),
		generation: input.generation
	});
	const grouped = /* @__PURE__ */ new Map();
	for (const projection of projections) {
		const actor = input.topology.actorFor(input.validatedBlueprint, projection);
		if (!(actor instanceof ActorRef)) throw invalidDefinition("Materialization topology must return an ActorRef");
		const key = `${actor.kind}\0${actor.id.value}`;
		const group = grouped.get(key) ?? {
			actor,
			projections: []
		};
		group.projections.push(projection);
		grouped.set(key, group);
	}
	return new MaterializationPlan({
		origin,
		actors: [...grouped.values()].map((group) => new ActorPlan({
			actor: group.actor,
			origin,
			projections: group.projections
		}))
	});
}
function attestedProjections(validated) {
	const blueprint = validated.blueprint;
	const projections = [policyProjection("policy:platform", blueprint.policies)];
	for (const placement of validated.placements) {
		projections.push(placementProjection(`placement:${placement.packageId}:${placement.facetId}`, placement.facetId, placement.selection));
		projections.push(facetInstallProjection(`install:${placement.packageId}:${placement.facetId}`, {
			facetId: placement.facetId,
			facetVersion: placement.facetVersion,
			packageId: placement.packageId
		}));
	}
	const contributeAuthority = slotContributeAuthority(validated);
	const commandNamesBySurface = /* @__PURE__ */ new Map();
	for (const declaration of validated.declarations) {
		requireSlotContributeAuthority(declaration, contributeAuthority);
		projections.push(slotEntryProjection(`contribution:${declaration.contributor}:${declaration.slot}:${declaration.index}`, declaration));
		if (declaration.slot === "commands") projections.push(commandSubscriptionProjection(declaration, commandNamesBySurface));
		else if (declaration.slot === "automations") projections.push(subscriptionProjection(`subscription:automation:${declaration.contributor}:${declaration.index}`, declaration.value));
	}
	(blueprint.subscriptions ?? []).forEach((template, index) => {
		projections.push(subscriptionProjection(`subscription:blueprint:${index}`, template));
	});
	(blueprint.slots ?? []).forEach((slot, index) => {
		projections.push(slotEntryProjection(`contribution:${BLUEPRINT_CONTRIBUTOR}:slots:${index}`, {
			contributor: BLUEPRINT_CONTRIBUTOR,
			index,
			slot: "slots",
			value: slot
		}));
	});
	if (blueprint.scopes !== void 0) projections.push(declarationProjection("scope-scaffold", "scope:platform", blueprint.scopes));
	blueprint.agents.forEach((agent, index) => {
		projections.push(declarationProjection("agent-profile", `agent:${index}`, agent));
	});
	(blueprint.environments ?? []).forEach((environment, index) => {
		projections.push(declarationProjection("environment", `environment:${index}`, environment));
	});
	if (blueprint.surfaces !== void 0) projections.push(declarationProjection("surface-layout", "surface:platform", blueprint.surfaces));
	return Object.freeze(projections.sort(compareProjections));
}
function commandSubscriptionProjection(declaration, commandNamesBySurface) {
	const command = Command.fromData(declaration.value);
	for (const surface of command.surfaces) {
		const commandNames = commandNamesBySurface.get(surface.value) ?? /* @__PURE__ */ new Set();
		if (commandNames.has(command.name)) throw invalidDefinition(`Command ${command.name} is not unique in surface slot ${surface.value}`);
		commandNames.add(command.name);
		commandNamesBySurface.set(surface.value, commandNames);
	}
	return subscriptionProjection(`subscription:command:${declaration.contributor}:${command.name}`, commandAutomation(command).toData());
}
function slotContributeAuthority(validated) {
	const map = /* @__PURE__ */ new Map();
	const add = (data) => {
		const slot = SlotDeclaration.fromData(data);
		map.set(slot.name.value, slot.authority.contribute);
	};
	for (const data of validated.blueprint.slots ?? []) add(data);
	for (const declaration of validated.declarations) if (declaration.slot === "slots") add(declaration.value);
	return map;
}
function requireSlotContributeAuthority(declaration, authority) {
	if (CORE_SLOT_NAMES.has(declaration.slot)) return;
	const contribute = authority.get(declaration.slot);
	if (contribute === void 0) return;
	if (!contribute.some((selector) => matchesGlob(selector, declaration.contributor))) throw invalidDefinition(`Contributor ${declaration.contributor} may not contribute to slot ${declaration.slot}`);
}
function compareProjections(left, right) {
	return compareCanonicalText(left.recordKind, right.recordKind) || compareCanonicalText(left.logicalKey, right.logicalKey);
}
function validatedConfig(validated) {
	const roots = new Map(validated.blueprint.packages.map((install) => [install.request.id.value, install.config.toData()]));
	return Object.fromEntries(validated.lock.packages.map((pin) => [pin.id.value, roots.get(pin.id.value) ?? {}]));
}
function canonicalProjections(input) {
	const projections = [...input].sort((left, right) => compareCanonicalText(left.logicalKey, right.logicalKey));
	const unique = [];
	for (const projection of projections) {
		const previous = unique.at(-1);
		if (previous === void 0 || previous.logicalKey !== projection.logicalKey) {
			unique.push(projection);
			continue;
		}
		if (!bytesEqual(encodeCanonicalJson(previous.toData()), encodeCanonicalJson(projection.toData()))) throw new TypeError(`Conflicting desired projections for logical key ${projection.logicalKey}`);
	}
	return unique;
}
function validateProjection(projection) {
	validateMaterializationKind(projection.recordKind, projection.desired);
}
function validateActorPlan(plan) {
	for (const projection of plan.projections) validateProjection(projection);
}
function canonicalActorPlans(input) {
	const actors = [...input].sort((left, right) => compareActorRefs(left.actor, right.actor));
	const unique = [];
	for (const actor of actors) {
		const previous = unique.at(-1);
		if (previous === void 0 || compareActorRefs(previous.actor, actor.actor) !== 0) {
			unique.push(actor);
			continue;
		}
		if (!bytesEqual(ActorPlan.encode(previous), ActorPlan.encode(actor))) throw new TypeError(`Conflicting Actor plans for ${actor.actor.kind}:${actor.actor.id.value}`);
	}
	return unique;
}
function actorPlanId(actor, origin, projections) {
	return digestData$1({
		actor: actorRefData$1(actor),
		origin: origin.toData(),
		projections: projections.map((projection) => projection.toData())
	});
}
function materializationPlanId(origin, actors) {
	return digestData$1({
		actors: actors.map((actor) => actor.toData()),
		origin: origin.toData()
	});
}
function validatePlacementSelection(selected, expected) {
	if (selected !== expected) throw new TypeError("Placement selection does not match its four-source intersection");
}
function copyActorRef$1(actor) {
	return Object.freeze(new ActorRef(actor.kind, new ActorId(actor.id.value)));
}
function actorRefData$1(actor) {
	return {
		id: actor.id.value,
		kind: actor.kind
	};
}
function actorRefFromData$1(payload) {
	const object = requireObject$2(payload, "Actor reference");
	requireFields$2(object, ["id", "kind"], "Actor reference");
	return new ActorRef(requireActorKind$1(object["kind"]), new ActorId(requireString$2(object["id"], "Actor ID")));
}
function requireActorKind$1(value) {
	if (value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate") return value;
	throw new TypeError("Actor kind is invalid");
}
function canonicalData$1(value) {
	return freezeData$1(decodeCanonicalJson(encodeCanonicalJson(value)));
}
function freezeData$1(value) {
	if (Array.isArray(value)) {
		for (const entry of value) freezeData$1(entry);
		return Object.freeze(value);
	}
	if (isJsonObject(value)) {
		for (const entry of Object.values(value)) freezeData$1(entry);
		return Object.freeze(value);
	}
	return value;
}
function digestData$1(value) {
	return Digest.sha256(encodeCanonicalJson(value));
}
function requireCanonicalName$1(value, subject) {
	if (value.length === 0 || value !== value.trim()) throw new TypeError(`${subject} must be a nonblank canonical string`);
}
function requireObject$2(value, subject) {
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
	return value;
}
function requireFields$2(value, fields, subject) {
	if (!hasExactJsonKeys(value, fields)) throw new TypeError(`${subject} contains missing or unknown fields`);
}
function requireString$2(value, subject) {
	if (!isStringValue$2(value)) throw new TypeError(`${subject} must be a string`);
	return value;
}
function isStringValue$2(value) {
	return typeof value === "string";
}
function requireArray$1(value, subject) {
	if (!Array.isArray(value)) throw new TypeError(`${subject} must be an array`);
	return value;
}
function requireValue$1(value, subject) {
	if (value === void 0) throw new TypeError(`${subject} is required`);
	return value;
}
function compareActorRefs(left, right) {
	return compareCanonicalText(left.kind, right.kind) || compareCanonicalText(left.id.value, right.id.value);
}
function bytesEqual(left, right) {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
//#endregion
//#region src/definition/generation.ts
var ManagedStateRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			ManagedStateRecord,
			ActorRef,
			CredentialCustodyFact,
			SecretRef,
			TextId,
			ManagedOrigin,
			Digest,
			ActorId,
			TenantId,
			DeploymentId,
			MaterializationGenerationId,
			BindingName,
			PolicySet,
			TreeMergePolicy,
			FacetPackageId,
			PlacementInput,
			PlacementSelection,
			PlacementIntersection,
			OperationName,
			OperationRef,
			AuthoredCodeBackingPolicy,
			BoundOperationRef,
			MappingRecord,
			FieldMove,
			Automation,
			EventPattern,
			PayloadMapping,
			PlacementPolicy,
			AuthoredCodeBackingId,
			JsonPointer,
			SemVer,
			PackageId,
			PackagePin
		], "definition.managed-state", {
			major: 3,
			minor: 0
		});
	}
	encodePayload(record) {
		return record.toData();
	}
	decodePayload(payload) {
		return ManagedStateRecord.fromData(payload);
	}
};
var ManagedStateRecord = class ManagedStateRecord {
	static get codec() {
		return managedStateRecordCodecInstance;
	}
	static supportedRecordKinds() {
		return supportedMaterializationKinds();
	}
	id;
	resourceId;
	actor;
	origin;
	generationId;
	logicalKey;
	recordKind;
	desired;
	desiredDigest;
	constructor(init) {
		const logicalKey = init.logicalKey;
		const recordKind = init.recordKind;
		const generationId = init.generationId;
		const expectedDigest = init.desiredDigest;
		const expectedId = init.id;
		requireCanonicalName(logicalKey, "Managed state logical key");
		requireCanonicalName(recordKind, "Managed state record kind");
		const actor = copyActorRef(init.actor);
		const desired = canonicalData(canonicalMaterializationDesired(recordKind, canonicalData(init.desired)));
		const desiredDigest = digestData({
			desired,
			recordKind
		});
		if (expectedDigest !== void 0 && !expectedDigest.equals(desiredDigest)) throw new TypeError("Managed state digest does not match its canonical contents");
		const resourceId = managedResourceId(actor, init.origin, logicalKey, recordKind);
		if (init.resourceId !== void 0 && !init.resourceId.equals(resourceId)) throw new TypeError("Managed resource ID does not match its stable identity");
		const id = managedStateRecordId(actor, generationId, resourceId, desiredDigest);
		if (expectedId !== void 0 && !expectedId.equals(id)) throw new TypeError("Managed state ID does not match its canonical contents");
		this.id = id;
		this.resourceId = resourceId;
		this.actor = actor;
		this.origin = init.origin;
		this.generationId = generationId;
		this.logicalKey = logicalKey;
		this.recordKind = recordKind;
		this.desired = desired;
		this.desiredDigest = desiredDigest;
		Object.freeze(this);
	}
	static fromProjection(actor, origin, generationId, projection) {
		return new ManagedStateRecord({
			actor,
			origin,
			generationId,
			logicalKey: projection.logicalKey,
			recordKind: projection.recordKind,
			desired: projection.desired,
			desiredDigest: projection.desiredDigest
		});
	}
	static encode(record) {
		return ManagedStateRecord.codec.encode(record);
	}
	static decode(bytes) {
		return ManagedStateRecord.codec.decode(bytes);
	}
	static fromData(payload) {
		const object = requireObject$1(payload, "Managed state");
		requireFields$1(object, [
			"actor",
			"desired",
			"desiredDigest",
			"generationId",
			"id",
			"logicalKey",
			"origin",
			"recordKind",
			"resourceId"
		], "Managed state");
		return new ManagedStateRecord({
			actor: actorRefFromData(requireValue(object["actor"], "Managed state actor")),
			desired: requireValue(object["desired"], "Managed state desired value"),
			desiredDigest: digestFromData(object["desiredDigest"], "Managed state desired digest"),
			generationId: materializationGenerationIdFromData(object["generationId"], "Managed state generation ID"),
			id: digestFromData(object["id"], "Managed state ID"),
			resourceId: digestFromData(object["resourceId"], "Managed resource ID"),
			logicalKey: requireString$1(object["logicalKey"], "Managed state logical key"),
			origin: ManagedOrigin.fromData(requireValue(object["origin"], "Managed state origin")),
			recordKind: requireString$1(object["recordKind"], "Managed state record kind")
		});
	}
	toData() {
		return {
			actor: actorRefData(this.actor),
			desired: this.desired,
			desiredDigest: this.desiredDigest.value,
			generationId: this.generationId.value,
			id: this.id.value,
			logicalKey: this.logicalKey,
			origin: this.origin.toData(),
			recordKind: this.recordKind,
			resourceId: this.resourceId.value
		};
	}
};
var managedStateRecordCodecInstance = new ManagedStateRecordCodec();
var MaterializationGenerationCodec = class extends RecordCodec {
	constructor() {
		super([
			MaterializationGeneration,
			ActorRef,
			TextId,
			ManagedOrigin,
			Digest,
			ActorId,
			TenantId,
			DeploymentId,
			MaterializationGenerationId
		], "definition.materialization-generation", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(generation) {
		return generation.toData();
	}
	decodePayload(payload) {
		return MaterializationGeneration.fromData(payload);
	}
};
var MaterializationGeneration = class MaterializationGeneration {
	static get codec() {
		return materializationGenerationCodecInstance;
	}
	id;
	actor;
	origin;
	actorPlanId;
	managedRecordIds;
	constructor(init) {
		const actor = copyActorRef(init.actor);
		const managedRecordIds = canonicalDigests(init.managedRecordIds, "generation managed state");
		const id = materializationGenerationId(actor, init.origin, init.actorPlanId);
		if (init.id !== void 0 && !init.id.equals(id)) throw new TypeError("Materialization generation ID does not match its canonical contents");
		this.id = id;
		this.actor = actor;
		this.origin = init.origin;
		this.actorPlanId = init.actorPlanId;
		this.managedRecordIds = Object.freeze(managedRecordIds);
		Object.freeze(this);
	}
	static fromActorPlan(plan) {
		const id = materializationGenerationId(plan.actor, plan.origin, plan.id);
		const managedRecordIds = plan.projections.map((projection) => managedStateRecordId(plan.actor, id, managedResourceId(plan.actor, plan.origin, projection.logicalKey, projection.recordKind), projection.desiredDigest));
		return new MaterializationGeneration({
			actor: plan.actor,
			origin: plan.origin,
			actorPlanId: plan.id,
			managedRecordIds,
			id
		});
	}
	static encode(generation) {
		return MaterializationGeneration.codec.encode(generation);
	}
	static decode(bytes) {
		return MaterializationGeneration.codec.decode(bytes);
	}
	static fromData(payload) {
		const object = requireObject$1(payload, "Materialization generation");
		requireFields$1(object, [
			"actor",
			"actorPlanId",
			"id",
			"managedRecordIds",
			"origin"
		], "Materialization generation");
		const managedRecordIds = requireArray(object["managedRecordIds"], "Materialization generation managed state IDs").map((value, index) => digestFromData(value, `Materialization generation managed state ID ${index}`));
		return new MaterializationGeneration({
			actor: actorRefFromData(requireValue(object["actor"], "Materialization generation actor")),
			actorPlanId: digestFromData(object["actorPlanId"], "Materialization generation Actor plan ID"),
			id: materializationGenerationIdFromData(object["id"], "Materialization generation ID"),
			managedRecordIds,
			origin: ManagedOrigin.fromData(requireValue(object["origin"], "Materialization generation origin"))
		});
	}
	toData() {
		return {
			actor: actorRefData(this.actor),
			actorPlanId: this.actorPlanId.value,
			id: this.id.value,
			managedRecordIds: this.managedRecordIds.map((id) => id.value),
			origin: this.origin.toData()
		};
	}
};
var materializationGenerationCodecInstance = new MaterializationGenerationCodec();
var MaterializationGenerationPointerCodec = class extends RecordCodec {
	constructor() {
		super([
			MaterializationGenerationPointer,
			ActorRef,
			Revision,
			TextId,
			ActorId,
			DeploymentId,
			MaterializationGenerationId
		], "definition.materialization-generation-pointer", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(pointer) {
		return pointer.toData();
	}
	decodePayload(payload) {
		return MaterializationGenerationPointer.fromData(payload);
	}
};
var MaterializationGenerationPointer = class MaterializationGenerationPointer {
	static get codec() {
		return materializationGenerationPointerCodecInstance;
	}
	actor;
	deploymentId;
	generationId;
	revision;
	constructor(init) {
		this.actor = copyActorRef(init.actor);
		this.deploymentId = new DeploymentId(init.deploymentId.value);
		this.generationId = init.generationId;
		this.revision = new Revision(init.revision.value);
		Object.freeze(this);
	}
	static initial(actor, deploymentId, generationId) {
		return new MaterializationGenerationPointer({
			actor,
			deploymentId,
			generationId,
			revision: Revision.initial()
		});
	}
	activate(generationId) {
		return new MaterializationGenerationPointer({
			actor: this.actor,
			deploymentId: this.deploymentId,
			generationId,
			revision: this.revision.next()
		});
	}
	static encode(pointer) {
		return MaterializationGenerationPointer.codec.encode(pointer);
	}
	static decode(bytes) {
		return MaterializationGenerationPointer.codec.decode(bytes);
	}
	static fromData(payload) {
		const object = requireObject$1(payload, "Materialization generation pointer");
		requireFields$1(object, [
			"actor",
			"deploymentId",
			"generationId",
			"revision"
		], "Materialization generation pointer");
		return new MaterializationGenerationPointer({
			actor: actorRefFromData(requireValue(object["actor"], "Generation pointer actor")),
			deploymentId: new DeploymentId(requireString$1(object["deploymentId"], "Generation pointer deployment ID")),
			generationId: materializationGenerationIdFromData(object["generationId"], "Generation pointer generation ID"),
			revision: new Revision(requireNonnegativeInteger(object["revision"], "Generation pointer revision"))
		});
	}
	toData() {
		return {
			actor: actorRefData(this.actor),
			deploymentId: this.deploymentId.value,
			generationId: this.generationId.value,
			revision: this.revision.value
		};
	}
};
var materializationGenerationPointerCodecInstance = new MaterializationGenerationPointerCodec();
function materializationGenerationId(actor, origin, actorPlanId) {
	return new MaterializationGenerationId(digestData({
		actor: actorRefData(actor),
		actorPlanId: actorPlanId.value,
		attestationDigest: origin.attestationDigest.value,
		blueprintDigest: origin.blueprintDigest.value,
		configDigest: origin.configDigest.value,
		deploymentId: origin.deploymentId.value,
		generation: origin.generation,
		packageLockDigest: origin.packageLockDigest.value,
		tenantId: origin.tenantId.value
	}).value);
}
function managedResourceId(actor, origin, logicalKey, recordKind) {
	requireCanonicalName(logicalKey, "Managed resource logical key");
	requireCanonicalName(recordKind, "Managed resource record kind");
	return digestData({
		actor: actorRefData(actor),
		deploymentId: origin.deploymentId.value,
		domain: "agent-core.managed-resource.v1",
		logicalKey,
		recordKind,
		tenantId: origin.tenantId.value
	});
}
function managedStateRecordId(actor, generationId, resourceId, desiredDigest) {
	return digestData({
		actor: actorRefData(actor),
		desiredDigest: desiredDigest.value,
		generationId: generationId.value,
		resourceId: resourceId.value
	});
}
function canonicalDigests(input, subject) {
	const digests = [...input].sort((left, right) => compareCanonicalText(left.value, right.value));
	if (new Set(digests.map((digest) => digest.value)).size !== digests.length) throw new TypeError(`Materialization ${subject} IDs must be unique`);
	return digests;
}
function actorRefData(actor) {
	return {
		id: actor.id.value,
		kind: actor.kind
	};
}
function actorRefFromData(payload) {
	const object = requireObject$1(payload, "Actor reference");
	requireFields$1(object, ["id", "kind"], "Actor reference");
	return new ActorRef(requireActorKind(object["kind"]), new ActorId(requireString$1(object["id"], "Actor ID")));
}
function copyActorRef(actor) {
	return Object.freeze(new ActorRef(actor.kind, new ActorId(actor.id.value)));
}
function requireActorKind(value) {
	if (value === "tenant" || value === "workspace" || value === "run" || value === "environment" || value === "slate") return value;
	throw new TypeError("Actor kind is invalid");
}
function canonicalData(value) {
	return freezeData(decodeCanonicalJson(encodeCanonicalJson(value)));
}
function freezeData(value) {
	if (Array.isArray(value)) {
		for (const entry of value) freezeData(entry);
		return Object.freeze(value);
	}
	if (isJsonObject(value)) {
		for (const entry of Object.values(value)) freezeData(entry);
		return Object.freeze(value);
	}
	return value;
}
function digestData(value) {
	return Digest.sha256(encodeCanonicalJson(value));
}
function digestFromData(value, subject) {
	return new Digest(requireString$1(value, subject));
}
function materializationGenerationIdFromData(value, subject) {
	return new MaterializationGenerationId(requireString$1(value, subject));
}
function requireCanonicalName(value, subject) {
	if (value.length === 0 || value !== value.trim()) throw new TypeError(`${subject} must be a nonblank canonical string`);
}
function requireObject$1(value, subject) {
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
	return value;
}
function requireFields$1(value, fields, subject) {
	if (!hasExactJsonKeys(value, fields)) throw new TypeError(`${subject} contains missing or unknown fields`);
}
function requireString$1(value, subject) {
	if (!isStringValue$1(value)) throw new TypeError(`${subject} must be a string`);
	return value;
}
function requireArray(value, subject) {
	if (!Array.isArray(value)) throw new TypeError(`${subject} must be an array`);
	return value;
}
function requireNonnegativeInteger(value, subject) {
	if (!isNumberValue$1(value) || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${subject} must be a non-negative safe integer`);
	return value;
}
function isStringValue$1(value) {
	return typeof value === "string";
}
function isNumberValue$1(value) {
	return typeof value === "number";
}
function requireValue(value, subject) {
	if (value === void 0) throw new TypeError(`${subject} is required`);
	return value;
}
//#endregion
//#region src/definition/installation.ts
/**
* One-use authority to materialize a record from an authenticated package contribution.
* It carries no public fields: only PackageInstallationProvenancePort can mint one after
* its prepare/apply proof succeeds.
*/
var AuthenticatedContributionToken = class AuthenticatedContributionToken {
	#brand = void 0;
	static consume(candidate) {
		if (!(candidate instanceof AuthenticatedContributionToken)) return void 0;
		const attribution = authenticatedContributions.get(candidate);
		if (attribution === void 0 || candidate.#brand !== void 0) return void 0;
		authenticatedContributions.delete(candidate);
		return attribution;
	}
};
var authenticatedContributions = /* @__PURE__ */ new WeakMap();
function authenticatedContribution(attribution) {
	const token = new AuthenticatedContributionToken();
	authenticatedContributions.set(token, attribution);
	return token;
}
/**
* Consumes the capability so one successful provenance check authorizes one materialization.
* A structurally forged token has no WeakMap entry and is not authority.
*/
function consumeAuthenticatedContribution(candidate) {
	return AuthenticatedContributionToken.consume(candidate);
}
var PackageInstallationProvenancePort = class {
	#prepared = /* @__PURE__ */ new WeakMap();
	reference(state, context) {
		const installation = this.authenticatedInstallation(state, context);
		if (installation === void 0) return void 0;
		requireInstallation(installation);
		return new PackageInstallationRef(new ContributionAttribution(installation.facet, installation.package), installation.packageFacet);
	}
	prepareContribution(state, context) {
		const installation = this.authenticatedInstallation(state, context);
		if (installation === void 0) return void 0;
		requireInstallation(installation);
		const prepared = copyInstallation(installation);
		const stamp = Object.freeze({});
		const reference = new PackageInstallationRef(new ContributionAttribution(prepared.facet, prepared.package), prepared.packageFacet);
		this.#prepared.set(stamp, prepared);
		return Object.freeze({
			manifestDigest: new Digest(prepared.manifestDigest.value),
			materialization: ManagedOrigin.decode(ManagedOrigin.encode(prepared.materialization)),
			reference,
			stamp
		});
	}
	discardPreparedContribution(stamp) {
		this.#prepared.delete(stamp);
	}
	resolveContributionForApply(state, context, stamp) {
		const expected = this.#prepared.get(stamp);
		if (expected === void 0) return void 0;
		this.#prepared.delete(stamp);
		const installation = this.authenticatedInstallation(state, context);
		if (installation === void 0) return void 0;
		requireInstallation(installation);
		if (!sameInstallation(expected, installation)) return void 0;
		return new PackageInstallationRef(new ContributionAttribution(installation.facet, installation.package), installation.packageFacet);
	}
	/**
	* Binds an opaque materialization capability to this synchronous prepare/apply span.
	* The callback must consume it before returning; finally revokes an unconsumed token,
	* so it cannot cross an await, restart, or RPC boundary as durable authority.
	*/
	withAuthenticatedContribution(state, context, stamp, materialize) {
		const installation = this.resolveContributionForApply(state, context, stamp);
		if (installation === void 0) return void 0;
		const contribution = authenticatedContribution(installation.attribution);
		try {
			return materialize(contribution);
		} finally {
			authenticatedContributions.delete(contribution);
		}
	}
};
function requireInstallation(installation) {
	if (!(installation.package instanceof PackagePin) || !(installation.manifestDigest instanceof Digest) || !(installation.materialization instanceof ManagedOrigin)) throw new TypeError("Authenticated package installation requires canonical pin, manifest, and materialization provenance");
}
function copyInstallation(installation) {
	return Object.freeze({
		package: PackagePin.fromData(installation.package.toData()),
		packageFacet: new FacetPackageId(installation.packageFacet.value),
		manifestDigest: new Digest(installation.manifestDigest.value),
		facet: new FacetRef(installation.facet.value),
		materialization: ManagedOrigin.fromData(installation.materialization.toData())
	});
}
function sameInstallation(left, right) {
	return left.package.equals(right.package) && left.packageFacet.equals(right.packageFacet) && left.facet.equals(right.facet) && left.manifestDigest.equals(right.manifestDigest) && left.materialization.equals(right.materialization);
}
//#endregion
//#region src/definition/reconciliation.ts
var PIN_HOLDER_KINDS = Object.freeze({
	run: true,
	turn: true,
	session: true,
	"tree-checkpoint": true,
	snapshot: true
});
var PackagePinHolder = class PackagePinHolder {
	kind;
	id;
	constructor(kind, id) {
		if (PIN_HOLDER_KINDS[kind] !== true) throw new TypeError("A Package pin holder must be one of the SPEC 5.2 pin holders");
		if (id.length === 0 || id !== id.trim()) throw new TypeError("A Package pin holder requires a nonblank canonical identity");
		this.kind = kind;
		this.id = id;
		Object.freeze(this);
	}
	get key() {
		return canonicalTupleKey("definition.package-pin-holder.v1", [this.kind, this.id]);
	}
	equals(other) {
		return other.constructor === PackagePinHolder && other.key === this.key;
	}
};
/**
* What the pin-holding planes answer about one Package release. Three shapes for three
* answers, because a release nothing pins, a release named holders retain, and a question
* the integration could not answer have three different consequences: the first proceeds,
* the second defers as a §9.3 pending obligation naming each holder, and the third is a
* divergence no obligation expresses — a rejected reconciliation rather than a removal
* left pending on an unstated reason.
*/
var RunPinEvidence = class {
	static clear() {
		return clearPinEvidence;
	}
	/** The exact holders retaining the release, which is why the removal defers. */
	static retained(holders) {
		return new RetainedPinEvidence(holders);
	}
	/** An answer the integration could not complete, which states no obligation at all. */
	static inconclusive(kind, reason) {
		return new InconclusivePinEvidence(kind, reason);
	}
	get permitsChange() {
		return this.kind === "clear";
	}
};
var ClearPinEvidence = class extends RunPinEvidence {
	get kind() {
		return "clear";
	}
	get holders() {
		return noPinHolders;
	}
	get conclusive() {
		return true;
	}
	deferral() {
		return ReconciliationDeferral.clear();
	}
};
var RetainedPinEvidence = class extends RunPinEvidence {
	holders;
	constructor(holders) {
		super();
		if (holders.length === 0) throw new TypeError("Blocked RunPins evidence must name the holders that retain it");
		const keys = /* @__PURE__ */ new Set();
		for (const holder of holders) {
			if (holder.constructor !== PackagePinHolder) throw new TypeError("RunPins evidence requires exact Package pin holders");
			if (keys.has(holder.key)) throw new TypeError("RunPins holders must be unique");
			keys.add(holder.key);
		}
		this.holders = Object.freeze([...holders].sort((left, right) => compareCanonicalText(left.key, right.key)));
		Object.freeze(this);
	}
	get kind() {
		return "blocked";
	}
	get conclusive() {
		return true;
	}
	deferral(held, release) {
		return ReconciliationDeferral.holding(this.holders.map((holder) => new PackageRetentionObligation(held, release, holder)));
	}
};
var InconclusivePinEvidence = class extends RunPinEvidence {
	reason;
	kind;
	constructor(kind, reason) {
		super();
		this.reason = reason;
		if (kind !== "unknown" && kind !== "stale" && kind !== "partial") throw new TypeError("Inconclusive RunPins evidence has its own evidence kinds");
		if (reason.length === 0 || reason !== reason.trim()) throw new TypeError("Inconclusive RunPins evidence must explain why");
		this.kind = kind;
		Object.freeze(this);
	}
	get holders() {
		return noPinHolders;
	}
	get conclusive() {
		return false;
	}
	deferral() {
		return ReconciliationDeferral.unanswerable(`${this.kind} RunPins evidence: ${this.reason}`);
	}
};
/**
* SPEC §9.3: the exact Blueprint-managed record a deferral holds, and the change held
* there. Every obligation names one, because the record it holds is the first of the
* three facts a pending obligation states.
*/
var DeferredManagedRecord = class {
	resourceId;
	logicalKey;
	recordKind;
	change;
	constructor(change) {
		this.resourceId = change.current.resourceId;
		this.logicalKey = change.current.logicalKey;
		this.recordKind = change.current.recordKind;
		this.change = change.kind;
		Object.freeze(this);
	}
	get key() {
		return canonicalTupleKey("definition.deferred-managed-record.v1", [this.change, this.resourceId.value]);
	}
};
var ReconciliationObligation = class {
	held;
	constructor(held) {
		this.held = held;
		if (held.constructor !== DeferredManagedRecord) throw new TypeError("A pending obligation must name the exact record it holds");
	}
	get key() {
		return canonicalTupleKey("definition.reconciliation-obligation.v1", [
			this.kind,
			this.held.key,
			this.record
		]);
	}
};
/** SPEC §4.1, §9.3: a withdrawal held by the reliance guard. */
var RelianceHoldObligation = class extends ReconciliationObligation {
	dependent;
	constructor(held, dependent) {
		super(held);
		this.dependent = dependent;
		Object.freeze(this);
	}
	get kind() {
		return "reliance";
	}
	get record() {
		return this.dependent.value;
	}
	get reason() {
		return `active Facet ${this.dependent.value} relies on the withdrawing Facet`;
	}
	get condition() {
		return "no active Facet relies on the withdrawing Facet";
	}
};
/** SPEC §4.1, §9.3: one admitted Invocation item draining against a withdrawing Facet. */
var InvocationDrainObligation = class extends ReconciliationObligation {
	item;
	constructor(held, item) {
		super(held);
		this.item = item;
		Object.freeze(this);
	}
	get kind() {
		return "drain";
	}
	get record() {
		return this.item.value;
	}
	get reason() {
		return `admitted Invocation item ${this.item.value} is draining against the withdrawing Facet`;
	}
	get condition() {
		return "that item holds a terminal current Receipt";
	}
};
/** SPEC §4.1, §6.2, §9.3: one RouteReservation a retired Subscription leaves unadmitted. */
var RouteReservationObligation = class extends ReconciliationObligation {
	reservation;
	constructor(held, reservation) {
		super(held);
		this.reservation = reservation;
		Object.freeze(this);
	}
	get kind() {
		return "reservation";
	}
	get record() {
		return this.reservation.value;
	}
	get reason() {
		return `retired Subscriptions leave RouteReservation ${this.reservation.value} unadmitted`;
	}
	get condition() {
		return "its owning Actor has written its terminal rejected RouteDelivery";
	}
};
/** SPEC §5.2, §9.3: a Package release one named pin holder retains. */
var PackageRetentionObligation = class extends ReconciliationObligation {
	release;
	holder;
	constructor(held, release, holder) {
		super(held);
		this.release = release;
		this.holder = holder;
		if (holder.constructor !== PackagePinHolder) throw new TypeError("A Package retention obligation names one exact pin holder");
		Object.freeze(this);
	}
	get kind() {
		return "retention";
	}
	get record() {
		return canonicalTupleKey("definition.package-retention-record.v1", [this.release.id.value, this.release.version.toString()]);
	}
	get reason() {
		return `${this.holder.key} pins that Package release`;
	}
	get condition() {
		return "no Run, Turn, Session, tree checkpoint, or Snapshot pins that release or a Run explicitly migrates";
	}
	/**
	* SPEC §5.2 lists five holders and each retains the release on its own, so two holders
	* of one release are two pending obligations rather than one obligation deduplicated
	* down to whichever holder was seen first.
	*/
	get key() {
		return canonicalTupleKey("definition.package-retention-obligation.v1", [
			this.kind,
			this.held.key,
			this.record,
			this.holder.key
		]);
	}
};
/**
* SPEC §9.3: what a managed-resource owner answers about one change. Clear proceeds,
* holding defers under named obligations, and unanswerable is the divergence a host cannot
* express — which `planReconciliation` rejects rather than admitting as pending work.
*/
var ReconciliationDeferral = class {
	static clear() {
		return clearDeferral;
	}
	static holding(obligations) {
		return new HoldingDeferral(obligations);
	}
	static unanswerable(reason) {
		return new UnanswerableDeferral(reason);
	}
};
var ClearDeferral = class extends ReconciliationDeferral {
	get obligations() {
		return noObligations;
	}
	get answerable() {
		return true;
	}
	get reason() {}
};
var HoldingDeferral = class extends ReconciliationDeferral {
	obligations;
	constructor(obligations) {
		super();
		if (obligations.length === 0) throw new TypeError("A held reconciliation must name at least one obligation");
		this.obligations = Object.freeze([...obligations]);
		Object.freeze(this);
	}
	get answerable() {
		return true;
	}
	get reason() {}
};
var UnanswerableDeferral = class extends ReconciliationDeferral {
	reason;
	constructor(reason) {
		super();
		this.reason = reason;
		if (reason.length === 0 || reason !== reason.trim()) throw new TypeError("An unanswerable reconciliation states what it could not answer");
		Object.freeze(this);
	}
	get obligations() {
		return noObligations;
	}
	get answerable() {
		return false;
	}
};
/**
* SPEC §9.3: the pending set a reconciliation outcome carries. Convergence is that set
* being empty and is derived here rather than reported beside it, so no host states a
* converged Scope while an obligation stands.
*/
var PendingObligationSet = class {
	static get empty() {
		return emptyPendingSet;
	}
	obligations;
	constructor(obligations) {
		const byKey = /* @__PURE__ */ new Map();
		for (const obligation of obligations) {
			if (!(obligation instanceof ReconciliationObligation)) throw new TypeError("A pending set holds typed reconciliation obligations");
			byKey.set(obligation.key, obligation);
		}
		this.obligations = Object.freeze([...byKey.values()].sort((left, right) => compareCanonicalText(left.key, right.key)));
		Object.freeze(this);
	}
	get converged() {
		return this.obligations.length === 0;
	}
	ofKind(kind) {
		return this.obligations.filter((obligation) => obligation.kind === kind);
	}
};
var ManagedResourcePort = class {};
/**
* SPEC §9.3: one manually created resource the operator explicitly adopted. A manual edit
* is adopted only as a change to the Blueprint, so the adopted record names the declaring
* record's identity and the exact state the operator inspected; an adoption the desired
* generation does not declare would mark an unattributed record Blueprint-managed and is
* rejected instead.
*/
var AdoptedManagedRecord = class {
	resourceId;
	observed;
	constructor(resourceId, observed) {
		this.resourceId = resourceId;
		this.observed = observed;
		if (resourceId.constructor !== Digest || observed.constructor !== Digest) throw new TypeError("A managed record adoption requires exact digests");
		Object.freeze(this);
	}
};
/**
* SPEC §9.3: the reconciliation outcome. It carries its own pending set, so `converged` is
* that set being empty rather than a second answer a host supplies beside it.
*/
var ReconciliationPlan = class {
	pending;
	actions;
	constructor(actions, pending) {
		this.pending = pending;
		if (pending.constructor !== PendingObligationSet) throw new TypeError("A reconciliation outcome carries its own pending set");
		this.actions = Object.freeze([...actions]);
		Object.freeze(this);
	}
	get converged() {
		return this.pending.converged;
	}
};
function planReconciliation(transaction, resources, owner, previous, desired, adoptions = []) {
	const previousByResource = uniqueRecords(previous, "previous generation");
	const desiredByResource = uniqueRecords(desired, "desired generation");
	const currentByResource = uniqueSnapshots(resources.list(transaction, owner));
	const unclaimedAdoptions = uniqueAdoptions(adoptions, desiredByResource);
	const actions = [];
	const obligations = [];
	for (const record of desiredByResource.values()) {
		const current = resources.get(transaction, record.resourceId);
		const expected = previousByResource.get(record.resourceId.value);
		if (current === void 0) {
			if (expected !== void 0) throw invalidDefinitionState(`Managed resource ${record.resourceId.value} drifted missing`);
			actions.push({
				kind: "create",
				desired: record
			});
			continue;
		}
		requireSnapshotIdentity(current, record, owner);
		if (expected === void 0) {
			const adoption = unclaimedAdoptions.get(record.resourceId.value);
			if (adoption === void 0) throw invalidDefinitionState(`Managed resource ${record.resourceId.value} is occupied outside the active generation`);
			unclaimedAdoptions.delete(record.resourceId.value);
			if (!adoption.observed.equals(current.desiredDigest)) throw invalidDefinitionState(`Managed resource ${record.resourceId.value} adoption names a state it no longer holds`);
			if (!current.desiredDigest.equals(record.desiredDigest)) collectObligations(resources, transaction, {
				kind: "update",
				current,
				desired: record
			}, obligations);
			actions.push({
				kind: "adopt",
				current,
				desired: record
			});
			continue;
		}
		if (!current.desiredDigest.equals(expected.desiredDigest)) throw invalidDefinitionState(`Managed resource ${record.resourceId.value} drifted from its active generation`);
		if (current.desiredDigest.equals(record.desiredDigest)) {
			actions.push({
				kind: "noop",
				current,
				desired: record
			});
			continue;
		}
		const change = {
			kind: "update",
			current,
			desired: record
		};
		collectObligations(resources, transaction, change, obligations);
		actions.push(change);
	}
	for (const expected of previousByResource.values()) {
		if (desiredByResource.has(expected.resourceId.value)) continue;
		const current = resources.get(transaction, expected.resourceId);
		if (current === void 0) throw invalidDefinitionState(`Managed resource ${expected.resourceId.value} drifted missing before removal`);
		requireSnapshotIdentity(current, expected, owner);
		if (!current.desiredDigest.equals(expected.desiredDigest)) throw invalidDefinitionState(`Managed resource ${current.resourceId.value} cannot be removed after drift`);
		const change = {
			kind: "remove",
			current
		};
		collectObligations(resources, transaction, change, obligations);
		actions.push(change);
	}
	for (const current of currentByResource.values()) if (!previousByResource.has(current.resourceId.value) && !desiredByResource.has(current.resourceId.value)) throw invalidDefinitionState(`Managed resource ${current.resourceId.value} is absent from generation closure`);
	for (const orphan of unclaimedAdoptions.values()) throw invalidDefinitionState(`Managed resource ${orphan.resourceId.value} holds no manual edit to adopt`);
	actions.sort(compareActions);
	return new ReconciliationPlan(actions, new PendingObligationSet(obligations));
}
function applyReconciliation(transaction, resources, plan) {
	if (!plan.converged) return;
	for (const action of plan.actions) {
		if (action.kind === "noop") continue;
		if (action.kind === "create") {
			resources.create(transaction, action.desired);
			requireAppliedSnapshot(requirePersisted(resources.get(transaction, action.desired.resourceId), action.desired), action.desired);
		} else if (action.kind === "update" || action.kind === "adopt") {
			resources.update(transaction, action.current, action.desired);
			requireAppliedSnapshot(requirePersisted(resources.get(transaction, action.desired.resourceId), action.desired), action.desired);
		} else {
			resources.remove(transaction, action.current);
			if (resources.get(transaction, action.current.resourceId) !== void 0) throw invalidDefinitionState(`Managed resource ${action.current.resourceId.value} removal did not persist`);
		}
	}
}
function requirePersisted(snapshot, desired) {
	if (snapshot === void 0) throw invalidDefinitionState(`Managed resource ${desired.resourceId.value} mutation did not persist`);
	return snapshot;
}
function uniqueRecords(records, subject) {
	const result = /* @__PURE__ */ new Map();
	for (const record of records) {
		if (result.has(record.resourceId.value)) throw invalidDefinitionState(`${subject} contains duplicate managed resource identity`);
		result.set(record.resourceId.value, record);
	}
	return result;
}
function uniqueSnapshots(snapshots) {
	const result = /* @__PURE__ */ new Map();
	for (const snapshot of snapshots) {
		if (result.has(snapshot.resourceId.value)) throw invalidDefinitionState("Managed resource port returned duplicate identity");
		result.set(snapshot.resourceId.value, snapshot);
	}
	return result;
}
function uniqueAdoptions(adoptions, declared) {
	const result = /* @__PURE__ */ new Map();
	for (const adoption of adoptions) {
		if (adoption.constructor !== AdoptedManagedRecord) throw invalidDefinitionState("A manual edit is adopted only by an exact adoption");
		if (result.has(adoption.resourceId.value)) throw invalidDefinitionState(`Managed resource ${adoption.resourceId.value} is adopted more than once`);
		if (!declared.has(adoption.resourceId.value)) throw invalidDefinitionState(`Managed resource ${adoption.resourceId.value} cannot be adopted without a declaring Blueprint`);
		result.set(adoption.resourceId.value, adoption);
	}
	return result;
}
function requireSnapshotIdentity(snapshot, desired, owner) {
	if (!snapshot.resourceId.equals(desired.resourceId) || !snapshot.actor.equals(owner.actor) || !snapshot.tenantId.equals(owner.tenantId) || !snapshot.deploymentId.equals(owner.deploymentId) || snapshot.logicalKey !== desired.logicalKey || snapshot.recordKind !== desired.recordKind) throw invalidDefinitionState(`Managed resource ${desired.resourceId.value} has foreign ownership or identity`);
}
function requireAppliedSnapshot(snapshot, desired) {
	requireSnapshotIdentity(snapshot, desired, {
		actor: desired.actor,
		tenantId: desired.origin.tenantId,
		deploymentId: desired.origin.deploymentId
	});
	if (!snapshot.desiredDigest.equals(desired.desiredDigest)) throw invalidDefinitionState(`Managed resource ${desired.resourceId.value} did not persist desired state`);
}
/**
* SPEC §9.3: a deferral is admitted only as a pending obligation naming its record,
* reason, and discharging condition. An owner that cannot state one has a divergence this
* document gives no deferral for, so the reconciliation is rejected here rather than
* accepted and left indefinitely pending.
*/
function collectObligations(resources, transaction, change, obligations) {
	const deferral = resources.deferrals(transaction, change);
	if (!(deferral instanceof ReconciliationDeferral)) throw invalidDefinitionState("Managed resource port returned a malformed deferral");
	if (!deferral.answerable) throw invalidDefinitionState(`Managed resource ${change.current.resourceId.value} divergence is not expressible as a pending obligation: ${deferral.reason ?? ""}`);
	for (const obligation of deferral.obligations) {
		if (!obligation.held.resourceId.equals(change.current.resourceId)) throw invalidDefinitionState(`Managed resource ${change.current.resourceId.value} deferral names another record`);
		obligations.push(obligation);
	}
}
function compareActions(left, right) {
	const order = {
		create: 0,
		adopt: 1,
		update: 2,
		noop: 3,
		remove: 4
	};
	return order[left.kind] - order[right.kind] || compareCanonicalText(actionId(left), actionId(right));
}
function actionId(action) {
	return action.kind === "create" ? action.desired.resourceId.value : action.current.resourceId.value;
}
var noPinHolders = Object.freeze([]);
var noObligations = Object.freeze([]);
var clearPinEvidence = Object.freeze(new ClearPinEvidence());
var clearDeferral = Object.freeze(new ClearDeferral());
var emptyPendingSet = new PendingObligationSet([]);
//#endregion
//#region src/definition/rollout.ts
var DeploymentRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			DeploymentRecord,
			Revision,
			TextId,
			Digest,
			DeploymentId,
			DeploymentKey,
			TenantId
		], "definition.deployment", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(record) {
		return record.toData();
	}
	decodePayload(payload) {
		return DeploymentRecord.fromData(payload);
	}
};
var DeploymentRecord = class DeploymentRecord {
	id;
	tenantId;
	key;
	activePlanId;
	pendingRolloutId;
	nextGeneration;
	revision;
	static get codec() {
		return deploymentRecordCodecInstance;
	}
	constructor(id, tenantId, key, activePlanId, pendingRolloutId, nextGeneration, revision) {
		this.id = id;
		this.tenantId = tenantId;
		this.key = key;
		this.activePlanId = activePlanId;
		this.pendingRolloutId = pendingRolloutId;
		this.nextGeneration = nextGeneration;
		this.revision = revision;
		if (!id.equals(DeploymentId.derive(tenantId, key))) throw new TypeError("Deployment ID does not match its Tenant-scoped key");
		requireSafeGeneration(nextGeneration, "Deployment next generation");
		Object.freeze(this);
	}
	static initial(tenantId, key) {
		return new DeploymentRecord(DeploymentId.derive(tenantId, key), tenantId, key, void 0, void 0, 1, Revision.initial());
	}
	begin(rolloutId, generation) {
		if (this.pendingRolloutId !== void 0) throw invalidDefinitionState("Deployment already has a pending materialization rollout");
		if (generation !== this.nextGeneration) throw definitionRevisionConflict("Materialization rollout generation was not allocated by its deployment");
		return new DeploymentRecord(this.id, this.tenantId, this.key, this.activePlanId, rolloutId, increment(generation, "Deployment generation"), this.revision.next());
	}
	compensate(failedRolloutId, compensationRolloutId, generation) {
		if (this.pendingRolloutId?.equals(failedRolloutId) !== true) throw invalidDefinitionState("Deployment compensation does not match its failed pending rollout");
		if (generation !== this.nextGeneration) throw definitionRevisionConflict("Compensation generation was not allocated by its deployment");
		return new DeploymentRecord(this.id, this.tenantId, this.key, this.activePlanId, compensationRolloutId, increment(generation, "Deployment generation"), this.revision.next());
	}
	complete(rolloutId, planId) {
		if (this.pendingRolloutId?.equals(rolloutId) !== true) throw invalidDefinitionState("Deployment completion does not match its pending rollout");
		return new DeploymentRecord(this.id, this.tenantId, this.key, planId, void 0, this.nextGeneration, this.revision.next());
	}
	static encode(record) {
		return DeploymentRecord.codec.encode(record);
	}
	static decode(bytes) {
		return DeploymentRecord.codec.decode(bytes);
	}
	static fromData(value) {
		const object = requireObject(value, "Deployment");
		requireFields(object, [
			"activePlanId",
			"id",
			"key",
			"nextGeneration",
			"pendingRolloutId",
			"revision",
			"tenantId"
		], "Deployment");
		return new DeploymentRecord(new DeploymentId(requireString(object["id"], "Deployment ID")), new TenantId(requireString(object["tenantId"], "Deployment Tenant ID")), new DeploymentKey(requireString(object["key"], "Deployment key")), optionalDigest(object["activePlanId"], "Deployment active plan"), optionalDigest(object["pendingRolloutId"], "Deployment pending rollout"), requireInteger(object["nextGeneration"], "Deployment next generation"), new Revision(requireInteger(object["revision"], "Deployment revision")));
	}
	toData() {
		return {
			activePlanId: this.activePlanId?.value ?? null,
			id: this.id.value,
			key: this.key.value,
			nextGeneration: this.nextGeneration,
			pendingRolloutId: this.pendingRolloutId?.value ?? null,
			revision: this.revision.value,
			tenantId: this.tenantId.value
		};
	}
};
var deploymentRecordCodecInstance = new DeploymentRecordCodec();
var MaterializationRolloutCodec = class extends RecordCodec {
	constructor() {
		super([
			MaterializationRollout,
			TextId,
			ManagedOrigin,
			CredentialCustodyFact,
			MaterializationPlan,
			SecretRef,
			ActorPlan,
			DesiredProjection,
			Digest,
			ActorRef,
			ActorId,
			TenantId,
			DeploymentId,
			BindingName,
			PolicySet,
			TreeMergePolicy,
			FacetPackageId,
			PlacementInput,
			PlacementSelection,
			PlacementIntersection,
			OperationName,
			OperationRef,
			AuthoredCodeBackingPolicy,
			BoundOperationRef,
			MappingRecord,
			FieldMove,
			Automation,
			EventPattern,
			PayloadMapping,
			PlacementPolicy,
			AuthoredCodeBackingId,
			JsonPointer,
			SemVer,
			PackageId,
			PackagePin
		], "definition.materialization-rollout", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(record) {
		return record.toData();
	}
	decodePayload(payload) {
		return MaterializationRollout.fromData(payload);
	}
};
var MaterializationRollout = class MaterializationRollout {
	static get codec() {
		return materializationRolloutCodecInstance;
	}
	id;
	plan;
	previousPlanId;
	compensates;
	constructor(init) {
		const plan = MaterializationPlan.decode(MaterializationPlan.encode(init.plan));
		const id = Digest.sha256(encodeCanonicalJson({
			compensates: init.compensates?.value ?? null,
			domain: "agent-core.materialization-rollout.v1",
			planId: plan.id.value,
			previousPlanId: init.previousPlanId?.value ?? null
		}));
		if (init.id !== void 0 && !init.id.equals(id)) throw new TypeError("Materialization rollout ID does not match its canonical contents");
		this.id = id;
		this.plan = plan;
		this.previousPlanId = init.previousPlanId;
		this.compensates = init.compensates;
		Object.freeze(this);
	}
	static encode(record) {
		return MaterializationRollout.codec.encode(record);
	}
	static decode(bytes) {
		return MaterializationRollout.codec.decode(bytes);
	}
	static fromData(value) {
		const object = requireObject(value, "Materialization rollout");
		requireFields(object, [
			"compensates",
			"id",
			"plan",
			"previousPlanId"
		], "Materialization rollout");
		const previousPlanId = optionalDigest(object["previousPlanId"], "Previous plan ID");
		const compensates = optionalDigest(object["compensates"], "Compensated rollout ID");
		return createMaterializationRollout(MaterializationPlan.fromData(object["plan"]), previousPlanId, compensates, digestValue(object["id"], "Materialization rollout ID"));
	}
	toData() {
		return {
			compensates: this.compensates?.value ?? null,
			id: this.id.value,
			plan: this.plan.toData(),
			previousPlanId: this.previousPlanId?.value ?? null
		};
	}
};
var materializationRolloutCodecInstance = new MaterializationRolloutCodec();
var MaterializationOutboxEntryCodec = class extends RecordCodec {
	constructor() {
		super([
			MaterializationOutboxEntry,
			ActorRef,
			Revision,
			TextId,
			Digest,
			ActorId
		], "definition.materialization-outbox", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(record) {
		return record.toData();
	}
	decodePayload(payload) {
		return MaterializationOutboxEntry.fromData(payload);
	}
};
var MaterializationOutboxEntry = class MaterializationOutboxEntry {
	rolloutId;
	target;
	actorPlanId;
	status;
	attempts;
	replyDigest;
	revision;
	static get codec() {
		return materializationOutboxEntryCodecInstance;
	}
	id;
	idempotencyKey;
	constructor(rolloutId, target, actorPlanId, status, attempts, replyDigest, revision, id) {
		this.rolloutId = rolloutId;
		this.target = target;
		this.actorPlanId = actorPlanId;
		this.status = status;
		this.attempts = attempts;
		this.replyDigest = replyDigest;
		this.revision = revision;
		if (!Number.isSafeInteger(attempts) || attempts < 0) throw new TypeError("Materialization outbox attempts must be a non-negative safe integer");
		if (status === "pending" !== (replyDigest === void 0)) throw new TypeError("Only acknowledged materialization outbox entries carry a reply digest");
		const requiredRevision = status === "pending" ? attempts : attempts + 1;
		if (!Number.isSafeInteger(requiredRevision) || revision.value !== requiredRevision) throw new TypeError("Materialization outbox revision does not match its durable transition history");
		const derived = Digest.sha256(encodeCanonicalJson({
			actorPlanId: actorPlanId.value,
			domain: "agent-core.materialization-outbox.v1",
			rolloutId: rolloutId.value,
			target: actorData(target)
		}));
		if (id !== void 0 && !id.equals(derived)) throw new TypeError("Materialization outbox ID does not match its canonical contents");
		this.id = derived;
		this.idempotencyKey = derived.value;
		Object.freeze(this);
	}
	static pending(rolloutId, plan) {
		return new MaterializationOutboxEntry(rolloutId, plan.actor, plan.id, "pending", 0, void 0, Revision.initial());
	}
	attempted() {
		if (this.status !== "pending") return this;
		return new MaterializationOutboxEntry(this.rolloutId, this.target, this.actorPlanId, this.status, increment(this.attempts, "Materialization outbox attempts"), void 0, this.revision.next(), this.id);
	}
	acknowledge(replyDigest) {
		if (this.status === "acknowledged") {
			if (!this.replyDigest.equals(replyDigest)) throw invalidDefinitionState("Materialization outbox acknowledgement is immutable");
			return this;
		}
		return new MaterializationOutboxEntry(this.rolloutId, this.target, this.actorPlanId, "acknowledged", this.attempts, replyDigest, this.revision.next(), this.id);
	}
	static encode(record) {
		return MaterializationOutboxEntry.codec.encode(record);
	}
	static decode(bytes) {
		return MaterializationOutboxEntry.codec.decode(bytes);
	}
	static fromData(value) {
		const object = requireObject(value, "Materialization outbox");
		requireFields(object, [
			"actorPlanId",
			"attempts",
			"id",
			"replyDigest",
			"revision",
			"rolloutId",
			"status",
			"target"
		], "Materialization outbox");
		const status = requireString(object["status"], "Materialization outbox status");
		if (status !== "pending" && status !== "acknowledged") throw new TypeError("Materialization outbox status is invalid");
		return new MaterializationOutboxEntry(digestValue(object["rolloutId"], "Materialization outbox rollout ID"), requireActor(object["target"]), digestValue(object["actorPlanId"], "Materialization outbox Actor plan ID"), status, requireInteger(object["attempts"], "Materialization outbox attempts"), optionalDigest(object["replyDigest"], "Materialization outbox reply digest"), new Revision(requireInteger(object["revision"], "Materialization outbox revision")), digestValue(object["id"], "Materialization outbox ID"));
	}
	toData() {
		return {
			actorPlanId: this.actorPlanId.value,
			attempts: this.attempts,
			id: this.id.value,
			replyDigest: this.replyDigest?.value ?? null,
			revision: this.revision.value,
			rolloutId: this.rolloutId.value,
			status: this.status,
			target: actorData(this.target)
		};
	}
};
var materializationOutboxEntryCodecInstance = new MaterializationOutboxEntryCodec();
var MaterializationControlStore = class {};
var MaterializationPlanAdmissionPort = class {};
var MaterializationRolloutController = class {
	store;
	admission;
	constructor(store, admission) {
		this.store = store;
		this.admission = admission;
	}
	begin(plan, key, previous, compensates, attestation) {
		return this.store.transaction((transaction) => {
			if (attestation !== void 0) {
				requirePlanAttestation(plan, attestation);
				this.store.insertAttestation(transaction, attestation);
			}
			const persistedAttestation = required(this.store.loadAttestation(transaction, plan.origin.attestationDigest), "validation attestation");
			requirePlanAttestation(plan, persistedAttestation);
			if (!this.admission.permits(plan, persistedAttestation)) throw invalidDefinitionState("Materialization plan topology is not admitted by its validation authority");
			const existing = this.store.loadDeployment(transaction, plan.origin.deploymentId);
			const deployment = existing ?? DeploymentRecord.initial(plan.origin.tenantId, key);
			if (!deployment.id.equals(plan.origin.deploymentId) || !deployment.tenantId.equals(plan.origin.tenantId) || !deployment.key.equals(key)) throw invalidDefinition("Materialization plan targets a different deployment");
			if (existing === void 0 && !this.store.compareAndSetDeployment(transaction, void 0, deployment)) throw definitionRevisionConflict("Deployment changed while initializing materialization rollout");
			const active = deployment.activePlanId === void 0 ? void 0 : required(this.store.loadPlan(transaction, deployment.activePlanId), "active plan");
			if (previous !== void 0 && (deployment.activePlanId === void 0 || !previous.id.equals(deployment.activePlanId))) throw invalidDefinitionState("Materialization predecessor does not match the active plan");
			let completePlan = unionTargetPlan(active, plan);
			let rollout = createMaterializationRollout(completePlan, active?.id, compensates);
			if (deployment.pendingRolloutId !== void 0) {
				const pending = required(this.store.loadRollout(transaction, deployment.pendingRolloutId), "pending rollout");
				if (pending.id.equals(rollout.id)) return pending;
				if (compensates !== void 0 && pending.compensates?.equals(compensates) === true) {
					if (createMaterializationRollout(unionTargetPlan(pending.plan, completePlan), active?.id, pending.compensates).id.equals(pending.id)) return pending;
				}
				if (compensates?.equals(pending.id) !== true) throw invalidDefinitionState("Deployment already has a different pending rollout");
				completePlan = unionTargetPlan(pending.plan, completePlan);
				rollout = createMaterializationRollout(completePlan, active?.id, pending.id);
			}
			if (compensates !== void 0 && this.store.loadRollout(transaction, compensates) === void 0) throw invalidDefinitionState("Compensation references an unknown rollout");
			const next = compensates === void 0 ? deployment.begin(rollout.id, completePlan.generation) : deployment.compensate(compensates, rollout.id, completePlan.generation);
			this.store.insertRollout(transaction, rollout);
			for (const actorPlan of completePlan.actors) this.store.insertOutbox(transaction, MaterializationOutboxEntry.pending(rollout.id, actorPlan));
			if (!this.store.compareAndSetDeployment(transaction, deployment.revision, next)) throw definitionRevisionConflict("Deployment changed while beginning materialization rollout");
			return rollout;
		});
	}
	acknowledge(entryId, receipt) {
		return this.store.transaction((transaction) => {
			const entry = required(this.store.loadOutbox(transaction, entryId), "outbox entry");
			if (receipt.outcome !== "applied" || !receipt.outboxId.equals(entry.id) || !receipt.rolloutId.equals(entry.rolloutId) || !receipt.actorPlanId.equals(entry.actorPlanId)) throw invalidDefinitionState("Materialization acknowledgement does not match its target apply receipt");
			const acknowledged = entry.acknowledge(receipt.replyDigest);
			if (acknowledged === entry) return entry;
			if (!this.store.compareAndSetOutbox(transaction, entry.revision, acknowledged)) throw definitionRevisionConflict("Materialization outbox changed while acknowledging delivery");
			return acknowledged;
		});
	}
	complete(rolloutId) {
		return this.store.transaction((transaction) => {
			const rollout = required(this.store.loadRollout(transaction, rolloutId), "rollout");
			const entries = this.store.listOutbox(transaction, rolloutId);
			requireExactOutboxClosure(rollout, entries);
			if (entries.some((entry) => entry.status !== "acknowledged")) throw invalidDefinitionState("Materialization rollout cannot complete with pending targets");
			const deployment = required(this.store.loadDeployment(transaction, rollout.plan.origin.deploymentId), "deployment");
			if (deployment.pendingRolloutId === void 0 && deployment.activePlanId?.equals(rollout.plan.id) === true) return deployment;
			const complete = deployment.complete(rolloutId, rollout.plan.id);
			if (!this.store.compareAndSetDeployment(transaction, deployment.revision, complete)) throw definitionRevisionConflict("Deployment changed while completing materialization rollout");
			return complete;
		});
	}
};
function requirePlanAttestation(plan, attestation) {
	if (!attestation.id.equals(plan.origin.attestationDigest) || !attestation.blueprintDigest.equals(plan.origin.blueprintDigest) || !attestation.packageLockDigest.equals(plan.origin.packageLockDigest)) throw invalidDefinitionState("Materialization plan does not match its persisted validation attestation");
}
function expectedOutboxEntries(rollout) {
	return Object.freeze(rollout.plan.actors.map((actorPlan) => MaterializationOutboxEntry.pending(rollout.id, actorPlan)).sort((left, right) => compareCanonicalText(left.id.value, right.id.value)));
}
function requireExactOutboxClosure(rollout, entries) {
	const expected = expectedOutboxEntries(rollout);
	const actual = [...entries].sort((left, right) => compareCanonicalText(left.id.value, right.id.value));
	if (expected.length !== actual.length || expected.some((entry, index) => {
		const candidate = actual[index];
		return !candidate.id.equals(entry.id) || !candidate.rolloutId.equals(entry.rolloutId) || !candidate.target.equals(entry.target) || !candidate.actorPlanId.equals(entry.actorPlanId);
	})) throw invalidDefinitionState("Materialization rollout outbox does not match its exact target closure");
}
function isLegalOutboxTransition(current, next) {
	const attempted = current.attempted();
	if (MaterializationOutboxEntry.encode(attempted).every((value, index) => value === MaterializationOutboxEntry.encode(next)[index])) return true;
	return next.status === "acknowledged" && current.status === "pending" && next.attempts === current.attempts && next.revision.equals(current.revision.next()) && next.id.equals(current.id) && next.rolloutId.equals(current.rolloutId) && next.actorPlanId.equals(current.actorPlanId) && next.target.equals(current.target);
}
function isLegalDeploymentTransition(current, next) {
	if (current === void 0) return next.revision.value === 0 && next.nextGeneration === 1 && next.activePlanId === void 0 && next.pendingRolloutId === void 0;
	if (!next.id.equals(current.id) || !next.tenantId.equals(current.tenantId) || !next.key.equals(current.key) || !next.revision.equals(current.revision.next())) return false;
	if (current.pendingRolloutId === void 0) return next.pendingRolloutId !== void 0 && sameOptionalDigest(next.activePlanId, current.activePlanId) && next.nextGeneration === current.nextGeneration + 1;
	const completion = next.pendingRolloutId === void 0 && next.activePlanId !== void 0 && next.nextGeneration === current.nextGeneration;
	const compensation = next.pendingRolloutId !== void 0 && !next.pendingRolloutId.equals(current.pendingRolloutId) && sameOptionalDigest(next.activePlanId, current.activePlanId) && next.nextGeneration === current.nextGeneration + 1;
	return completion || compensation;
}
function sameOptionalDigest(left, right) {
	return left === void 0 ? right === void 0 : right !== void 0 && left.equals(right);
}
function forwardRollbackPlan(active, failed, origin) {
	if (!active.origin.deploymentId.equals(failed.origin.deploymentId) || !active.origin.deploymentId.equals(origin.deploymentId) || !active.origin.tenantId.equals(origin.tenantId) || origin.generation <= failed.generation) throw invalidDefinition("Forward rollback must advance the same Tenant deployment");
	const activeByActor = new Map(active.actors.map((plan) => [actorKey(plan.actor), plan]));
	return new MaterializationPlan({
		origin,
		actors: canonicalActors([...active.actors, ...failed.actors]).map((actor) => {
			return new ActorPlan({
				actor,
				origin,
				projections: activeByActor.get(actorKey(actor))?.projections ?? []
			});
		})
	});
}
function unionTargetPlan(previous, desired) {
	if (previous === void 0) return desired;
	if (!previous.origin.deploymentId.equals(desired.origin.deploymentId) || !previous.origin.tenantId.equals(desired.origin.tenantId)) throw invalidDefinition("Materialization rollout plans belong to different deployments");
	const desiredByActor = new Map(desired.actors.map((plan) => [actorKey(plan.actor), plan]));
	const actors = canonicalActors([...previous.actors, ...desired.actors]).map((actor) => desiredByActor.get(actorKey(actor)) ?? new ActorPlan({
		actor,
		origin: desired.origin,
		projections: []
	}));
	return new MaterializationPlan({
		origin: desired.origin,
		actors
	});
}
function canonicalActors(plans) {
	return [...new Map(plans.map((plan) => [actorKey(plan.actor), plan.actor])).values()].sort((left, right) => compareCanonicalText(actorKey(left), actorKey(right)));
}
function actorData(actor) {
	return {
		id: actor.id.value,
		kind: actor.kind
	};
}
function requireActor(value) {
	const object = requireObject(value, "Materialization target Actor");
	requireFields(object, ["id", "kind"], "Materialization target Actor");
	const kind = requireString(object["kind"], "Materialization target Actor kind");
	if (kind !== "tenant" && kind !== "workspace" && kind !== "run" && kind !== "environment" && kind !== "slate") throw new TypeError("Materialization target Actor kind is invalid");
	return new ActorRef(kind, new ActorId(requireString(object["id"], "Materialization target Actor ID")));
}
function actorKey(actor) {
	return `${actor.kind}\0${actor.id.value}`;
}
function requireObject(value, subject) {
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
	return value;
}
function requireFields(object, fields, subject) {
	if (!hasExactJsonKeys(object, fields)) throw new TypeError(`${subject} contains missing or unknown fields`);
}
function requireString(value, subject) {
	if (!isStringValue(value)) throw new TypeError(`${subject} must be a string`);
	return value;
}
function requireInteger(value, subject) {
	if (!isNumberValue(value) || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${subject} must be a non-negative safe integer`);
	return value;
}
function createMaterializationRollout(plan, previousPlanId, compensates, id) {
	let init = { plan };
	if (previousPlanId !== void 0) init = {
		...init,
		previousPlanId
	};
	if (compensates !== void 0) init = {
		...init,
		compensates
	};
	if (id !== void 0) init = {
		...init,
		id
	};
	return new MaterializationRollout(init);
}
function isStringValue(value) {
	return typeof value === "string";
}
function isNumberValue(value) {
	return typeof value === "number";
}
function optionalDigest(value, subject) {
	return value === null ? void 0 : digestValue(value, subject);
}
function digestValue(value, subject) {
	return new Digest(requireString(value, subject));
}
function requireSafeGeneration(value, subject) {
	if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${subject} must be a positive safe integer`);
}
function increment(value, subject) {
	if (value === Number.MAX_SAFE_INTEGER) throw definitionRevisionConflict(`${subject} cannot advance`);
	return value + 1;
}
function required(value, subject) {
	if (value === void 0) throw invalidDefinitionState(`Missing materialization ${subject}`);
	return value;
}
//#endregion
//#region src/definition/pins.ts
var RunPinsReservationPort = class {};
var DefinitionSourceRevisionPort = class {};
var FailClosedRunPinsReservationPort = class extends RunPinsReservationPort {
	reserve() {
		throw invalidDefinitionState("RunPins reservation integration is unavailable");
	}
	release() {
		return false;
	}
	removalEvidence() {
		return RunPinEvidence.inconclusive("unknown", "runpins-integration-unavailable");
	}
	verifyMigration() {
		return false;
	}
};
/**
* SPEC §5.2 and §9.3 retention, held in memory: a Package release stays resolvable while
* any Run, Turn, Session, tree checkpoint, or Snapshot pins it, and removal proceeds only
* once the last holder of any kind has released. The evidence names every retaining
* holder, so a removal defers on a Turn, a Session, a tree checkpoint, or a Snapshot with
* no Run in the picture at all.
*/
var RecordedRunPinsReservationPort = class extends RunPinsReservationPort {
	#reservations = /* @__PURE__ */ new Map();
	#byIdempotencyKey = /* @__PURE__ */ new Map();
	#migrations = /* @__PURE__ */ new Set();
	reserve(_transaction, request) {
		if (request.holder.constructor !== PackagePinHolder) throw invalidDefinitionState("A RunPins reservation names one exact pin holder");
		const recorded = this.#byIdempotencyKey.get(request.idempotencyKey);
		if (recorded !== void 0) {
			const existing = this.#reservations.get(recorded);
			if (existing === void 0 || !existing.holder.equals(request.holder)) throw invalidDefinitionState("A RunPins idempotency key belongs to another pin holder");
			return existing.reference;
		}
		const reference = {
			id: Digest.sha256(reservationKey(request.holder.key, request.idempotencyKey)),
			revision: request.sourceRevision
		};
		this.#reservations.set(reference.id.value, {
			reference,
			holder: request.holder,
			releases: Object.freeze(request.pins.packages.map(releaseKey))
		});
		this.#byIdempotencyKey.set(request.idempotencyKey, reference.id.value);
		return reference;
	}
	release(_transaction, reservation, migration) {
		if (this.#reservations.get(reservation.id.value) === void 0) return false;
		if (migration !== void 0) {
			if (migration.fromPinsDigest.equals(migration.toPinsDigest)) return false;
			this.#migrations.add(migrationKey(migration));
		}
		this.#reservations.delete(reservation.id.value);
		for (const [key, id] of this.#byIdempotencyKey) if (id === reservation.id.value) this.#byIdempotencyKey.delete(key);
		return true;
	}
	removalEvidence(_transaction, pins) {
		const removed = new Set(pins.packages.map(releaseKey));
		const holders = /* @__PURE__ */ new Map();
		for (const reservation of this.#reservations.values()) {
			if (!reservation.releases.some((release) => removed.has(release))) continue;
			holders.set(reservation.holder.key, reservation.holder);
		}
		return holders.size === 0 ? RunPinEvidence.clear() : RunPinEvidence.retained([...holders.values()]);
	}
	verifyMigration(_transaction, evidence) {
		return this.#migrations.has(migrationKey(evidence));
	}
};
function reservationKey(holderKey, idempotencyKey) {
	return new TextEncoder().encode(canonicalTupleKey("definition.run-pin-reservation.v1", [holderKey, idempotencyKey]));
}
function releaseKey(pin) {
	return canonicalTupleKey("definition.package-pin-release.v1", [
		pin.id.value,
		pin.version.toString(),
		pin.manifestDigest.value,
		pin.codeDigest.value
	]);
}
function migrationKey(evidence) {
	return canonicalTupleKey("definition.run-pin-migration.v1", [
		evidence.run.id.value,
		evidence.commitId.value,
		evidence.receiptId.value,
		evidence.auditId.value,
		evidence.fromPinsDigest.value,
		evidence.toPinsDigest.value,
		evidence.revision.value
	]);
}
//#endregion
export { ValidatedBlueprint as $, applyReconciliation as A, PackageLock as At, ActorPlan as B, PackageCodeEntrypoint as Bt, PendingObligationSet as C, canonicalConfig as Ct, RelianceHoldObligation as D, isSecretRefData as Dt, ReconciliationPlan as E, encodeSecretRef as Et, MaterializationGeneration as F, metadataSnapshotContentRetention as Ft, planMaterialization as G, ManagedOrigin as Gt, MaterializationPlan as H, PackageCodeModule as Ht, MaterializationGenerationPointer as I, packageReleaseContentRetention as It, PackageCorrespondencePort as J, FacetInstallFailureId as Jt, policyProjection as K, DeploymentId as Kt, managedResourceId as L, PlatformCompatibility as Lt, PackageInstallationProvenancePort as M, PackageDependency as Mt, consumeAuthenticatedContribution as N, PackageRelease as Nt, RouteReservationObligation as O, PackageResolver as Ot, ManagedStateRecord as P, canonicalPackageRange as Pt, PlacementSourcePort as Q, managedStateRecordId as R, canonicalCompatibilityRange as Rt, PackageRetentionObligation as S, SECRET_REF_SCHEMA as St, ReconciliationObligation as T, decodeSecretRef as Tt, MaterializationTopologyPort as U, FacetInstallFailure as Ut, DesiredProjection as V, PackageCodeManifest as Vt, placementProjection as W, FacetInstallPhase as Wt, PackageModuleInspector as X, PackageModuleEvaluator as Y, MaterializationGenerationId as Yt, BlueprintValidator as Z, AdoptedManagedRecord as _, preferredPlacement as _t, DeploymentRecord as a, BlueprintMeta as at, ManagedResourcePort as b, BASE_CONFIG_SCHEMA as bt, MaterializationPlanAdmissionPort as c, PolicySet as ct, expectedOutboxEntries as d, TreeMergePolicy as dt, validateBlueprint as et, forwardRollbackPlan as f, AuthoredCodeBackingPolicy as ft, requirePlanAttestation as g, PlacementUnavailableError as gt, requireExactOutboxClosure as h, PlacementSelection as ht, RunPinsReservationPort as i, Blueprint as it, planReconciliation as j, MetadataSnapshot as jt, RunPinEvidence as k, resolvePackageLock as kt, MaterializationRollout as l, evaluatePolicy as lt, isLegalOutboxTransition as m, PlacementPolicy as mt, FailClosedRunPinsReservationPort as n, UnknownMaterializationKindError as nt, MaterializationControlStore as o, PackageInstall as ot, isLegalDeploymentTransition as p, PlacementInput as pt, BlueprintLoader as q, DeploymentKey as qt, RecordedRunPinsReservationPort as r, BlueprintDeclarationCodecPort as rt, MaterializationOutboxEntry as s, POLICY_IMPACTS as st, DefinitionSourceRevisionPort as t, ValidationAttestation as tt, MaterializationRolloutController as u, mergePolicySets as ut, DeferredManagedRecord as v, selectPlacement as vt, ReconciliationDeferral as w, composeConfigSchema as wt, PackagePinHolder as x, Config as xt, InvocationDrainObligation as y, trustPlacementModes as yt, materializationGenerationId as z, compatibilityAdmits as zt };

//# sourceMappingURL=definition-COokGikL.js.map