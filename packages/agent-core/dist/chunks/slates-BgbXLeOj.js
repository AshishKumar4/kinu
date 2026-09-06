import { D as encodeCanonicalJson, L as isObjectRecord, R as jsonDataParser, T as compareCanonicalText, _ as ContentRef, a as CompatRange, f as RecordCodec, g as Revision, j as TextId, k as AgentCoreError, v as contentRetentionFields, y as Digest } from "./core-BjYGo1CC.js";
import { o as requireSynchronousResult } from "./actors-DJsP1nFM.js";
import { L as BindingRequirement, at as FacetPackageId, nt as BindingName } from "./runtime-z1yMP0an.js";
import { l as ReceiptId } from "./facets-D01bKQBL.js";
import { B as WorkspaceId } from "./identity-CoqhjOFj.js";
import { c as EnvironmentSessionId, o as EnvironmentSessionCapability, s as EnvironmentId, u as PortExposureId } from "./provider-DK9Ak8da.js";
import "./environments-CZCvxj-D.js";
import { i as InvocationId } from "./interaction-references-D9spp037.js";
import { c as SlatePreviewId, d as SlateVersionId, l as SlatePublicationId, n as SlateEffectContext, o as SlateDeploymentId, s as SlateId, u as SlateResourceId } from "./provider-574-Qv7K.js";
//#region src/slates/codec.ts
var parse = jsonDataParser((message) => new TypeError(message));
function requireExactObject(value, fields, subject) {
	return parse.exact(parse.object(value, subject), fields, subject);
}
function requireStringValue(value, subject) {
	return parse.string(value, subject);
}
function nullableString(value, subject) {
	return parse.nullableString(value, subject);
}
function requireIntegerValue(value, subject) {
	return parse.safeInteger(value, subject);
}
function workspaceId(value) {
	return new WorkspaceId(requireStringValue(value, "Slate workspace ID"));
}
function slateId(value) {
	return new SlateId(requireStringValue(value, "Slate ID"));
}
function versionId(value) {
	return new SlateVersionId(requireStringValue(value, "Slate version ID"));
}
function publicationId(value) {
	return new SlatePublicationId(requireStringValue(value, "Slate publication ID"));
}
function deploymentId(value) {
	return new SlateDeploymentId(requireStringValue(value, "Slate deployment ID"));
}
function resourceId(value) {
	return new SlateResourceId(requireStringValue(value, "Slate resource ID"));
}
function previewId(value) {
	return new SlatePreviewId(requireStringValue(value, "Slate preview ID"));
}
function contentRef(value, subject) {
	return new ContentRef(requireStringValue(value, subject));
}
function invocationId(value) {
	return new InvocationId(requireStringValue(value, "Slate invocation ID"));
}
function receiptId(value) {
	return new ReceiptId(requireStringValue(value, "Slate receipt ID"));
}
function sessionId(value) {
	return new EnvironmentSessionId(requireStringValue(value, "Slate preview session ID"));
}
function environmentId(value) {
	return new EnvironmentId(requireStringValue(value, "Slate preview environment ID"));
}
function exposureId(value) {
	return new PortExposureId(requireStringValue(value, "Slate preview exposure ID"));
}
function revision(value) {
	return new Revision(requireIntegerValue(value, "Slate revision"));
}
function requireText$1(value, subject, maximum = 512) {
	if (value.trim().length === 0 || value.length > maximum) throw new TypeError(`${subject} must not be blank or exceed ${maximum} characters`);
	return value;
}
function digest(value, subject) {
	return new Digest(requireStringValue(value, subject));
}
/**
* The canonical form of a declared capability set: sorted by `BindingName` and unique by
* it, because the namespace loaded code addresses holds one entry per name (SPEC §4.7).
* A name declared twice would leave which entry a consumer must bind undecided, so it is
* a shape violation rather than a duplicate to be collapsed.
*/
function canonicalBindingRequirements(value, subject) {
	if (!Array.isArray(value)) throw new TypeError(`${subject} must be an array of binding requirements`);
	const names = /* @__PURE__ */ new Set();
	for (const requirement of value) {
		if (!(requirement instanceof BindingRequirement)) throw new TypeError(`${subject} must contain only binding requirements`);
		if (names.has(requirement.name.value)) throw new TypeError(`${subject} declares ${requirement.name.value} more than once`);
		names.add(requirement.name.value);
	}
	return Object.freeze([...value].sort((left, right) => left.name.value < right.name.value ? -1 : 1));
}
function bindingRequirements(value, subject) {
	return canonicalBindingRequirements(parse.array(value, subject).map((entry) => BindingRequirement.fromData(entry)), subject);
}
//#endregion
//#region src/slates/slate.ts
var SlateCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			Slate,
			Revision,
			TextId,
			ContentRef,
			Digest,
			SlateVersionId,
			SlateId,
			WorkspaceId,
			SlatePublicationId,
			SlateDeploymentId
		], "slate", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(slate) {
		return slate.toData();
	}
	decodePayload(payload) {
		return Slate.fromData(payload);
	}
};
var Slate = class Slate {
	static get codec() {
		return slateCodecInstance;
	}
	id;
	workspaceId;
	source;
	headVersionId;
	latestPublicationId;
	activeDeploymentId;
	forkedFrom;
	revision;
	constructor(init) {
		if (!(init.id instanceof SlateId) || !(init.workspaceId instanceof WorkspaceId) || !(init.source instanceof ContentRef) || !(init.revision instanceof Revision)) throw new TypeError("Slate identity, ownership, source, and revision are required");
		if (init.headVersionId !== void 0 && !(init.headVersionId instanceof SlateVersionId)) throw new TypeError("Slate head version ID is invalid");
		if (init.activeDeploymentId !== void 0 && !(init.activeDeploymentId instanceof SlateDeploymentId)) throw new TypeError("Slate active deployment ID is invalid");
		if (init.latestPublicationId !== void 0 && !(init.latestPublicationId instanceof SlatePublicationId)) throw new TypeError("Slate latest publication ID is invalid");
		if (init.forkedFrom !== void 0 && (!(init.forkedFrom.slateId instanceof SlateId) || !(init.forkedFrom.versionId instanceof SlateVersionId) || init.forkedFrom.slateId.equals(init.id))) throw new TypeError("Slate fork reference is invalid");
		this.id = init.id;
		this.workspaceId = init.workspaceId;
		this.source = init.source;
		this.headVersionId = init.headVersionId;
		this.latestPublicationId = init.latestPublicationId;
		this.activeDeploymentId = init.activeDeploymentId;
		this.forkedFrom = init.forkedFrom === void 0 ? void 0 : Object.freeze({
			slateId: init.forkedFrom.slateId,
			versionId: init.forkedFrom.versionId
		});
		this.revision = new Revision(init.revision.value);
		Object.freeze(this);
	}
	static initial(id, workspaceId_, source) {
		return new Slate({
			id,
			workspaceId: workspaceId_,
			source,
			revision: Revision.initial()
		});
	}
	update(source) {
		if (this.source.equals(source)) throw new AgentCoreError("operation.invalid-input", "Slate update must change its source");
		return this.revise({ source });
	}
	commit(version) {
		if (this.headVersionId?.equals(version) === true) throw new AgentCoreError("protocol.duplicate", "Slate version is already the current head");
		return this.revise({ headVersionId: version });
	}
	publish(publication) {
		if (this.latestPublicationId?.equals(publication) === true) throw new AgentCoreError("protocol.duplicate", "Slate publication is already current");
		return this.revise({ latestPublicationId: publication });
	}
	selectDeployment(deployment) {
		if (deployment === void 0 && this.activeDeploymentId === void 0) throw new AgentCoreError("operation.invalid-input", "Slate has no active deployment to clear");
		if (deployment !== void 0 && this.activeDeploymentId?.equals(deployment) === true) throw new AgentCoreError("protocol.duplicate", "Slate deployment is already active");
		return this.revise({ activeDeploymentId: deployment });
	}
	static encode(slate) {
		return Slate.codec.encode(slate);
	}
	static decode(bytes) {
		return Slate.codec.decode(bytes);
	}
	toData() {
		return {
			activeDeploymentId: this.activeDeploymentId?.value ?? null,
			forkedFrom: this.forkedFrom === void 0 ? null : {
				slateId: this.forkedFrom.slateId.value,
				versionId: this.forkedFrom.versionId.value
			},
			headVersionId: this.headVersionId?.value ?? null,
			id: this.id.value,
			latestPublicationId: this.latestPublicationId?.value ?? null,
			revision: this.revision.value,
			source: this.source.value,
			workspaceId: this.workspaceId.value
		};
	}
	static fromData(payload) {
		const object = requireExactObject(payload, [
			"activeDeploymentId",
			"forkedFrom",
			"headVersionId",
			"id",
			"latestPublicationId",
			"revision",
			"source",
			"workspaceId"
		], "Slate payload");
		const fork = object["forkedFrom"];
		const decodedFork = fork === null ? void 0 : requireExactObject(fork, ["slateId", "versionId"], "Slate fork reference");
		const head = nullableString(object["headVersionId"], "Slate head version ID");
		const latestPublication = nullableString(object["latestPublicationId"], "Slate latest publication ID");
		const active = nullableString(object["activeDeploymentId"], "Slate active deployment ID");
		let slate = {
			id: slateId(object["id"]),
			workspaceId: workspaceId(object["workspaceId"]),
			source: contentRef(object["source"], "Slate source"),
			revision: revision(object["revision"])
		};
		if (head !== void 0) slate = {
			...slate,
			headVersionId: versionId(head)
		};
		if (latestPublication !== void 0) slate = {
			...slate,
			latestPublicationId: publicationId(latestPublication)
		};
		if (active !== void 0) slate = {
			...slate,
			activeDeploymentId: deploymentId(active)
		};
		if (decodedFork !== void 0) slate = {
			...slate,
			forkedFrom: {
				slateId: slateId(decodedFork["slateId"]),
				versionId: versionId(decodedFork["versionId"])
			}
		};
		return new Slate(slate);
	}
	revise(changes) {
		const hasActive = Object.prototype.hasOwnProperty.call(changes, "activeDeploymentId");
		const headVersionId = changes.headVersionId ?? this.headVersionId;
		const latestPublicationId = changes.latestPublicationId ?? this.latestPublicationId;
		const activeDeploymentId = hasActive ? changes.activeDeploymentId : this.activeDeploymentId;
		let revised = {
			id: this.id,
			workspaceId: this.workspaceId,
			source: changes.source ?? this.source,
			revision: nextSlateRevision(this.revision)
		};
		if (headVersionId !== void 0) revised = {
			...revised,
			headVersionId
		};
		if (latestPublicationId !== void 0) revised = {
			...revised,
			latestPublicationId
		};
		if (activeDeploymentId !== void 0) revised = {
			...revised,
			activeDeploymentId
		};
		if (this.forkedFrom !== void 0) revised = {
			...revised,
			forkedFrom: this.forkedFrom
		};
		return new Slate(revised);
	}
};
var slateCodecInstance = new SlateCodecV1();
function nextSlateRevision(revision_) {
	if (revision_.value === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("protocol.invalid-state", "Slate revision is exhausted");
	return revision_.next();
}
/**
* The Slate head's working source (§8.4). Every revision of a Slate is kept, so a head
* that advances retains its new source without releasing the source the prior revision
* still names.
*/
function slateContentRetention(value) {
	return contentRetentionFields([["source", value.source]]);
}
//#endregion
//#region src/slates/version.ts
var SlateVersionCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			SlateVersion,
			TextId,
			ContentRef,
			Digest,
			SlateVersionId,
			SlateId,
			WorkspaceId
		], "slate.version", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(version) {
		return version.toData();
	}
	decodePayload(payload) {
		return SlateVersion.fromData(payload);
	}
};
var SlateVersion = class SlateVersion {
	id;
	workspaceId;
	slateId;
	source;
	parentVersionId;
	static get codec() {
		return slateVersionCodecInstance;
	}
	constructor(id, workspaceId, slateId, source, parentVersionId) {
		this.id = id;
		this.workspaceId = workspaceId;
		this.slateId = slateId;
		this.source = source;
		this.parentVersionId = parentVersionId;
		if (!(id instanceof SlateVersionId) || !(workspaceId instanceof WorkspaceId) || !(slateId instanceof SlateId) || !(source instanceof ContentRef) || parentVersionId !== void 0 && !(parentVersionId instanceof SlateVersionId)) throw new TypeError("Slate version is malformed");
		if (parentVersionId?.equals(id) === true) throw new TypeError("Slate version cannot be its own parent");
		Object.freeze(this);
	}
	static encode(version) {
		return SlateVersion.codec.encode(version);
	}
	static decode(bytes) {
		return SlateVersion.codec.decode(bytes);
	}
	toData() {
		return {
			id: this.id.value,
			parentVersionId: this.parentVersionId?.value ?? null,
			slateId: this.slateId.value,
			source: this.source.value,
			workspaceId: this.workspaceId.value
		};
	}
	static fromData(payload) {
		const object = requireExactObject(payload, [
			"id",
			"parentVersionId",
			"slateId",
			"source",
			"workspaceId"
		], "Slate version payload");
		const parent = nullableString(object["parentVersionId"], "Slate parent version ID");
		return new SlateVersion(versionId(object["id"]), workspaceId(object["workspaceId"]), slateId(object["slateId"]), contentRef(object["source"], "Slate version source"), parent === void 0 ? void 0 : versionId(parent));
	}
};
var slateVersionCodecInstance = new SlateVersionCodecV1();
/**
* A committed version's frozen source (§8.4). Versions are immutable, so this retention is
* owed on write and never released while the version stands.
*/
function slateVersionContentRetention(value) {
	return contentRetentionFields([["source", value.source]]);
}
//#endregion
//#region src/slates/publication.ts
var SlatePublicationCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			SlatePublication,
			TextId,
			ContentRef,
			Digest,
			SlateVersionId,
			SlateId,
			SlatePublicationId,
			WorkspaceId,
			BindingName,
			BindingRequirement,
			FacetPackageId,
			CompatRange
		], "slate.publication", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(publication) {
		return publication.toData();
	}
	decodePayload(payload) {
		return SlatePublication.fromData(payload);
	}
};
var SlatePublication = class SlatePublication {
	id;
	workspaceId;
	slateId;
	versionId;
	materialization;
	static get codec() {
		return slatePublicationCodecInstance;
	}
	constructor(id, workspaceId, slateId, versionId, materialization, bindings) {
		this.id = id;
		this.workspaceId = workspaceId;
		this.slateId = slateId;
		this.versionId = versionId;
		this.materialization = materialization;
		if (!(id instanceof SlatePublicationId) || !(workspaceId instanceof WorkspaceId) || !(slateId instanceof SlateId) || !(versionId instanceof SlateVersionId) || !(materialization instanceof ContentRef)) throw new TypeError("Slate publication is malformed");
		this.bindings = canonicalBindingRequirements(bindings, "Slate publication bindings");
		Object.freeze(this);
	}
	/**
	* The capabilities this published Slate needs bound before it can run, declared by
	* name at publish. A declaration, never a grant: it is what a skeleton export carries
	* so a forker can read what the Slate requires before anything of theirs runs.
	*/
	bindings;
	static encode(publication) {
		return SlatePublication.codec.encode(publication);
	}
	static decode(bytes) {
		return SlatePublication.codec.decode(bytes);
	}
	toData() {
		return {
			bindings: this.bindings.map((requirement) => requirement.toData()),
			id: this.id.value,
			materialization: this.materialization.value,
			slateId: this.slateId.value,
			versionId: this.versionId.value,
			workspaceId: this.workspaceId.value
		};
	}
	static fromData(payload) {
		const object = requireExactObject(payload, [
			"bindings",
			"id",
			"materialization",
			"slateId",
			"versionId",
			"workspaceId"
		], "Slate publication payload");
		return new SlatePublication(publicationId(object["id"]), workspaceId(object["workspaceId"]), slateId(object["slateId"]), versionId(object["versionId"]), contentRef(object["materialization"], "Slate publication materialization"), bindingRequirements(object["bindings"], "Slate publication bindings"));
	}
};
var slatePublicationCodecInstance = new SlatePublicationCodecV1();
/**
* The immutable publication bundle a deployment is cut from (§8.4).
*/
function slatePublicationContentRetention(value) {
	return contentRetentionFields([["materialization", value.materialization]]);
}
//#endregion
//#region src/slates/skeleton.ts
var SlateSkeletonCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			SlateSkeleton,
			BindingRequirement,
			Digest,
			TextId,
			BindingName,
			FacetPackageId,
			CompatRange
		], "slate.skeleton", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(skeleton) {
		return skeleton.toData();
	}
	decodePayload(payload) {
		return SlateSkeleton.fromData(payload);
	}
};
/**
* The credential-free export of a published Slate: the shape a forker receives and the
* capabilities that shape needs, and nothing else (SPEC §4.6).
*
* The two admissible field types are what makes the absence structural rather than
* reviewed. `sourceDigest` is a `Digest` and not a `ContentRef` on purpose: a record that
* named a `ContentRef` would be a retainer of that content in whichever Tenant's
* ContentStore read it (§8.2), so a skeleton admitted into a Scope that does not hold the
* bytes would name content nothing there retains. A digest is inert identity — it lets an
* importer prove the bytes they were handed are the ones the publisher declared, and
* resolves to nothing on its own. `bindings` are `BindingRequirement`s, which are
* declarations of a needed capability and never grants of one.
*/
var SlateSkeleton = class SlateSkeleton {
	static get codec() {
		return slateSkeletonCodecInstance;
	}
	sourceDigest;
	bindings;
	constructor(sourceDigest, bindings) {
		if (!(sourceDigest instanceof Digest)) throw new TypeError("Slate skeleton source digest must be a Digest");
		this.sourceDigest = sourceDigest;
		this.bindings = canonicalBindingRequirements(bindings, "Slate skeleton bindings");
		Object.freeze(this);
	}
	static encode(skeleton) {
		return SlateSkeleton.codec.encode(skeleton);
	}
	static decode(bytes) {
		return SlateSkeleton.codec.decode(bytes);
	}
	toData() {
		return {
			bindings: this.bindings.map((requirement) => requirement.toData()),
			sourceDigest: this.sourceDigest.value
		};
	}
	static fromData(payload) {
		const object = requireExactObject(payload, ["bindings", "sourceDigest"], "Slate skeleton payload");
		return new SlateSkeleton(digest(object["sourceDigest"], "Slate skeleton source digest"), bindingRequirements(object["bindings"], "Slate skeleton bindings"));
	}
};
var slateSkeletonCodecInstance = new SlateSkeletonCodecV1();
//#endregion
//#region src/slates/deployment.ts
var SlateDeploymentCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			SlateDeployment,
			TextId,
			ContentRef,
			Digest,
			InvocationId,
			SlateId,
			SlatePublicationId,
			SlateDeploymentId,
			ReceiptId,
			WorkspaceId
		], "slate.deployment", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(deployment) {
		return deployment.toData();
	}
	decodePayload(payload) {
		return SlateDeployment.fromData(payload);
	}
};
var SlateDeployment = class SlateDeployment {
	id;
	workspaceId;
	slateId;
	publicationId;
	materialization;
	invocationId;
	receiptId;
	static get codec() {
		return slateDeploymentCodecInstance;
	}
	target;
	constructor(id, workspaceId, slateId, publicationId, target, materialization, invocationId, receiptId) {
		this.id = id;
		this.workspaceId = workspaceId;
		this.slateId = slateId;
		this.publicationId = publicationId;
		this.materialization = materialization;
		this.invocationId = invocationId;
		this.receiptId = receiptId;
		if (!(id instanceof SlateDeploymentId) || !(workspaceId instanceof WorkspaceId) || !(slateId instanceof SlateId) || !(publicationId instanceof SlatePublicationId) || !(materialization instanceof ContentRef) || !(invocationId instanceof InvocationId) || !(receiptId instanceof ReceiptId)) throw new TypeError("Slate deployment is malformed");
		this.target = requireText$1(target, "Slate deployment target");
		Object.freeze(this);
	}
	static encode(deployment) {
		return SlateDeployment.codec.encode(deployment);
	}
	static decode(bytes) {
		return SlateDeployment.codec.decode(bytes);
	}
	toData() {
		return {
			id: this.id.value,
			invocationId: this.invocationId.value,
			materialization: this.materialization.value,
			publicationId: this.publicationId.value,
			receiptId: this.receiptId.value,
			slateId: this.slateId.value,
			target: this.target,
			workspaceId: this.workspaceId.value
		};
	}
	static fromData(payload) {
		const object = requireExactObject(payload, [
			"id",
			"invocationId",
			"materialization",
			"publicationId",
			"receiptId",
			"slateId",
			"target",
			"workspaceId"
		], "Slate deployment payload");
		return new SlateDeployment(deploymentId(object["id"]), workspaceId(object["workspaceId"]), slateId(object["slateId"]), publicationId(object["publicationId"]), requireTextValue(object["target"]), contentRef(object["materialization"], "Slate deployment materialization"), invocationId(object["invocationId"]), receiptId(object["receiptId"]));
	}
};
var slateDeploymentCodecInstance = new SlateDeploymentCodecV1();
function requireTextValue(value) {
	if (!isTextValue(value)) throw new TypeError("Slate deployment target must be a string");
	return value;
}
function isTextValue(value) {
	return typeof value === "string";
}
/**
* The materialization a deployment installed (§8.4).
*/
function slateDeploymentContentRetention(value) {
	return contentRetentionFields([["materialization", value.materialization]]);
}
//#endregion
//#region src/slates/resource.ts
var SlateResourceCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			SlateResource,
			TextId,
			ContentRef,
			Digest,
			SlateResourceId,
			InvocationId,
			SlateId,
			SlateDeploymentId,
			ReceiptId,
			WorkspaceId
		], "slate.resource", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(resource) {
		return resource.toData();
	}
	decodePayload(payload) {
		return SlateResource.fromData(payload);
	}
};
var SlateResource = class SlateResource {
	id;
	workspaceId;
	slateId;
	deploymentId;
	source;
	materialization;
	invocationId;
	receiptId;
	static get codec() {
		return slateResourceCodecInstance;
	}
	name;
	constructor(id, workspaceId, slateId, deploymentId, name, source, materialization, invocationId, receiptId) {
		this.id = id;
		this.workspaceId = workspaceId;
		this.slateId = slateId;
		this.deploymentId = deploymentId;
		this.source = source;
		this.materialization = materialization;
		this.invocationId = invocationId;
		this.receiptId = receiptId;
		if (!(id instanceof SlateResourceId) || !(workspaceId instanceof WorkspaceId) || !(slateId instanceof SlateId) || !(deploymentId instanceof SlateDeploymentId) || !(source instanceof ContentRef) || !(materialization instanceof ContentRef) || !(invocationId instanceof InvocationId) || !(receiptId instanceof ReceiptId)) throw new TypeError("Slate resource is malformed");
		this.name = requireText$1(name, "Slate resource name", 256);
		Object.freeze(this);
	}
	static encode(resource) {
		return SlateResource.codec.encode(resource);
	}
	static decode(bytes) {
		return SlateResource.codec.decode(bytes);
	}
	toData() {
		return {
			deploymentId: this.deploymentId.value,
			id: this.id.value,
			invocationId: this.invocationId.value,
			materialization: this.materialization.value,
			name: this.name,
			receiptId: this.receiptId.value,
			slateId: this.slateId.value,
			source: this.source.value,
			workspaceId: this.workspaceId.value
		};
	}
	static fromData(payload) {
		const object = requireExactObject(payload, [
			"deploymentId",
			"id",
			"invocationId",
			"materialization",
			"name",
			"receiptId",
			"slateId",
			"source",
			"workspaceId"
		], "Slate resource payload");
		return new SlateResource(resourceId(object["id"]), workspaceId(object["workspaceId"]), slateId(object["slateId"]), deploymentId(object["deploymentId"]), requireStringValue(object["name"], "Slate resource name"), contentRef(object["source"], "Slate resource source"), contentRef(object["materialization"], "Slate resource materialization"), invocationId(object["invocationId"]), receiptId(object["receiptId"]));
	}
};
var slateResourceCodecInstance = new SlateResourceCodecV1();
/**
* A provisioned resource's source and its materialization (§8.4). Both are named by the
* record, so both are held for as long as the resource row stands.
*/
function slateResourceContentRetention(value) {
	return contentRetentionFields([["source", value.source], ["materialization", value.materialization]]);
}
//#endregion
//#region src/slates/preview.ts
var SlatePreviewCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			SlatePreview,
			Revision,
			TextId,
			ContentRef,
			Digest,
			SlateId,
			PortExposureId,
			EnvironmentSessionId,
			EnvironmentId,
			SlatePreviewId,
			WorkspaceId,
			SlateVersionId,
			EnvironmentSessionCapability
		], "slate.preview", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(preview) {
		return preview.toData();
	}
	decodePayload(payload) {
		return SlatePreview.fromData(payload);
	}
};
var SlatePreview = class SlatePreview {
	id;
	workspaceId;
	slateId;
	exposureId;
	source;
	versionId;
	static get codec() {
		return slatePreviewCodecInstance;
	}
	constructor(id, workspaceId, slateId, capability, exposureId, source, versionId) {
		this.id = id;
		this.workspaceId = workspaceId;
		this.slateId = slateId;
		this.exposureId = exposureId;
		this.source = source;
		this.versionId = versionId;
		if (!(id instanceof SlatePreviewId) || !(workspaceId instanceof WorkspaceId) || !(slateId instanceof SlateId) || !(capability instanceof EnvironmentSessionCapability) || !(capability.environmentId instanceof EnvironmentId) || !(capability.sessionId instanceof EnvironmentSessionId) || !(capability.environmentRevision instanceof Revision) || !(exposureId instanceof PortExposureId) || !(source instanceof ContentRef) || versionId !== void 0 && !(versionId instanceof SlateVersionId)) throw new TypeError("Slate preview is malformed");
		this.environmentId = capability.environmentId;
		this.sessionId = capability.sessionId;
		this.environmentRevision = new Revision(capability.environmentRevision.value);
		this.sessionEpoch = capability.epoch;
		Object.freeze(this);
	}
	environmentId;
	sessionId;
	environmentRevision;
	sessionEpoch;
	get capability() {
		return new EnvironmentSessionCapability(this.environmentId, this.sessionId, this.environmentRevision, this.sessionEpoch);
	}
	static encode(preview) {
		return SlatePreview.codec.encode(preview);
	}
	static decode(bytes) {
		return SlatePreview.codec.decode(bytes);
	}
	toData() {
		return {
			environmentId: this.environmentId.value,
			environmentRevision: this.environmentRevision.value,
			exposureId: this.exposureId.value,
			id: this.id.value,
			sessionEpoch: this.sessionEpoch,
			sessionId: this.sessionId.value,
			slateId: this.slateId.value,
			source: this.source.value,
			versionId: this.versionId?.value ?? null,
			workspaceId: this.workspaceId.value
		};
	}
	static fromData(payload) {
		const object = requireExactObject(payload, [
			"environmentId",
			"environmentRevision",
			"exposureId",
			"id",
			"sessionEpoch",
			"sessionId",
			"slateId",
			"source",
			"versionId",
			"workspaceId"
		], "Slate preview payload");
		const version = nullableString(object["versionId"], "Slate preview version ID");
		return new SlatePreview(previewId(object["id"]), workspaceId(object["workspaceId"]), slateId(object["slateId"]), new EnvironmentSessionCapability(environmentId(object["environmentId"]), sessionId(object["sessionId"]), new Revision(requireIntegerValue(object["environmentRevision"], "Slate preview environment revision")), requireIntegerValue(object["sessionEpoch"], "Slate preview session epoch")), exposureId(object["exposureId"]), contentRef(object["source"], "Slate preview source"), version === void 0 ? void 0 : versionId(version));
	}
};
var slatePreviewCodecInstance = new SlatePreviewCodecV1();
/**
* The exact source a preview was built from (§8.4).
*/
function slatePreviewContentRetention(value) {
	return contentRetentionFields([["source", value.source]]);
}
//#endregion
//#region src/slates/intent.ts
function freezeSlateMutationRequest(request) {
	canonicalSlateMutationRequest(request);
	const copy = { ...request };
	return Object.freeze(copy);
}
function freezeSlateInvocationRequest(request) {
	canonicalSlateInvocationRequest(request);
	const copy = { ...request };
	return Object.freeze(copy);
}
function canonicalSlateMutationRequest(request) {
	return encodeCanonicalJson(mutationData(request));
}
function canonicalSlateInvocationRequest(request) {
	return encodeCanonicalJson(invocationData(request));
}
function sameSlateInvocationRequest(left, right) {
	return equalBytes(canonicalSlateInvocationRequest(left), canonicalSlateInvocationRequest(right));
}
function mutationData(request) {
	if (request.impact !== "mutate") throw invalidInput("Slate mutation impact must be mutate");
	const base = mutationBase(request);
	switch (request.operation) {
		case "create":
			requireKeys(request, [...baseKeys, "source"]);
			requireInstance(request.source, ContentRef, "Slate source");
			return {
				...base,
				source: request.source.value
			};
		case "update":
			requireKeys(request, [
				...baseKeys,
				"expectedRevision",
				"source"
			]);
			requireInstance(request.source, ContentRef, "Slate source");
			requireInstance(request.expectedRevision, Revision, "Expected Slate revision");
			return {
				...base,
				expectedRevision: request.expectedRevision.value,
				source: request.source.value
			};
		case "commit":
			requireKeys(request, [
				...baseKeys,
				"expectedRevision",
				"parentVersionId",
				"source",
				"versionId"
			]);
			requireInstance(request.versionId, SlateVersionId, "Slate version ID");
			requireOptionalInstance(request.parentVersionId, SlateVersionId, "Parent Slate version ID");
			requireInstance(request.source, ContentRef, "Slate source");
			requireInstance(request.expectedRevision, Revision, "Expected Slate revision");
			return {
				...base,
				expectedRevision: request.expectedRevision.value,
				parentVersionId: request.parentVersionId?.value ?? null,
				source: request.source.value,
				versionId: request.versionId.value
			};
		case "fork":
			requireKeys(request, [
				...baseKeys,
				"expectedSourceRevision",
				"source",
				"sourceSlateId",
				"sourceVersionId"
			]);
			requireInstance(request.sourceSlateId, SlateId, "Source Slate ID");
			requireInstance(request.sourceVersionId, SlateVersionId, "Source Slate version ID");
			requireInstance(request.source, ContentRef, "Slate source");
			requireInstance(request.expectedSourceRevision, Revision, "Expected source Slate revision");
			return {
				...base,
				expectedSourceRevision: request.expectedSourceRevision.value,
				source: request.source.value,
				sourceSlateId: request.sourceSlateId.value,
				sourceVersionId: request.sourceVersionId.value
			};
		case "instantiate":
			requireKeys(request, [
				...baseKeys,
				"skeletonDigest",
				"source"
			]);
			requireInstance(request.source, ContentRef, "Slate source");
			requireInstance(request.skeletonDigest, Digest, "Slate skeleton digest");
			return {
				...base,
				skeletonDigest: request.skeletonDigest.value,
				source: request.source.value
			};
		case "publish":
			requireKeys(request, [
				...baseKeys,
				"bindings",
				"expectedRevision",
				"materialization",
				"publicationId",
				"source",
				"versionId"
			]);
			requireInstance(request.publicationId, SlatePublicationId, "Slate publication ID");
			requireInstance(request.versionId, SlateVersionId, "Slate version ID");
			requireInstance(request.source, ContentRef, "Slate source");
			requireInstance(request.materialization, ContentRef, "Slate publication materialization");
			requireInstance(request.expectedRevision, Revision, "Expected Slate revision");
			return {
				...base,
				bindings: canonicalBindingRequirements(request.bindings, "Slate publication bindings").map((requirement) => requirement.toData()),
				expectedRevision: request.expectedRevision.value,
				materialization: request.materialization.value,
				publicationId: request.publicationId.value,
				source: request.source.value,
				versionId: request.versionId.value
			};
		case "deploy.reserve":
			requireKeys(request, [...deployKeys, "invocationId"]);
			requireInstance(request.invocationId, InvocationId, "Slate invocation ID");
			return {
				...deployData(request),
				invocationId: request.invocationId.value
			};
		case "deploy.finalize":
			requireKeys(request, [
				...deployKeys,
				"invocationId",
				"materialization",
				"receiptId"
			]);
			requireInstance(request.invocationId, InvocationId, "Slate invocation ID");
			requireInstance(request.receiptId, ReceiptId, "Slate receipt ID");
			requireInstance(request.materialization, ContentRef, "Slate deployment materialization");
			return {
				...deployData(request),
				invocationId: request.invocationId.value,
				materialization: request.materialization.value,
				receiptId: request.receiptId.value
			};
		case "resource.reserve":
			requireKeys(request, [...resourceKeys, "invocationId"]);
			requireInstance(request.invocationId, InvocationId, "Slate invocation ID");
			return {
				...resourceData(request),
				invocationId: request.invocationId.value
			};
		case "resource.finalize":
			requireKeys(request, [
				...resourceKeys,
				"invocationId",
				"materialization",
				"receiptId"
			]);
			requireInstance(request.invocationId, InvocationId, "Slate invocation ID");
			requireInstance(request.receiptId, ReceiptId, "Slate receipt ID");
			requireInstance(request.materialization, ContentRef, "Slate resource materialization");
			return {
				...resourceData(request),
				invocationId: request.invocationId.value,
				materialization: request.materialization.value,
				receiptId: request.receiptId.value
			};
		case "preview.link":
			requireKeys(request, [
				...baseKeys,
				"environmentId",
				"environmentRevision",
				"expectedRevision",
				"exposureId",
				"previewId",
				"sessionEpoch",
				"sessionId",
				"source",
				"versionId"
			]);
			requireInstance(request.previewId, SlatePreviewId, "Slate preview ID");
			requireInstance(request.source, ContentRef, "Slate preview source");
			requireOptionalInstance(request.versionId, SlateVersionId, "Slate preview version ID");
			requireInstance(request.environmentId, EnvironmentId, "Environment ID");
			requireInstance(request.sessionId, EnvironmentSessionId, "Environment session ID");
			requireInstance(request.environmentRevision, Revision, "Environment revision");
			requireInstance(request.exposureId, PortExposureId, "Port exposure ID");
			requireInstance(request.expectedRevision, Revision, "Expected Slate revision");
			requireEpoch(request.sessionEpoch);
			return {
				...base,
				environmentId: request.environmentId.value,
				environmentRevision: request.environmentRevision.value,
				expectedRevision: request.expectedRevision.value,
				exposureId: request.exposureId.value,
				previewId: request.previewId.value,
				sessionEpoch: request.sessionEpoch,
				sessionId: request.sessionId.value,
				source: request.source.value,
				versionId: request.versionId?.value ?? null
			};
		case "rollback":
			requireKeys(request, [
				...baseKeys,
				"deploymentId",
				"expectedActiveDeploymentId",
				"expectedRevision"
			]);
			requireInstance(request.deploymentId, SlateDeploymentId, "Slate deployment ID");
			requireOptionalInstance(request.expectedActiveDeploymentId, SlateDeploymentId, "Expected active Slate deployment ID");
			requireInstance(request.expectedRevision, Revision, "Expected Slate revision");
			return {
				...base,
				deploymentId: request.deploymentId.value,
				expectedActiveDeploymentId: request.expectedActiveDeploymentId?.value ?? null,
				expectedRevision: request.expectedRevision.value
			};
	}
}
function invocationData(request) {
	if (request.operation === "deploy") {
		requireKeys(request, deployKeys);
		return deployData(request);
	}
	requireKeys(request, resourceKeys);
	return resourceData(request);
}
var baseKeys = [
	"impact",
	"operation",
	"slateId",
	"workspaceId"
];
var deployKeys = [
	...baseKeys,
	"deploymentId",
	"expectedActiveDeploymentId",
	"publicationId",
	"publicationMaterialization",
	"target"
];
var resourceKeys = [
	...baseKeys,
	"deploymentId",
	"deploymentMaterialization",
	"resourceId",
	"resourceName",
	"resourceSource"
];
function mutationBase(request) {
	requireBase(request);
	return {
		impact: request.impact,
		operation: request.operation,
		slateId: request.slateId.value,
		workspaceId: request.workspaceId.value
	};
}
function deployData(request) {
	if (request.operation === "deploy" && request.impact !== "externalSend") throw invalidInput("Slate deploy invocation impact must be externalSend");
	requireBase(request);
	requireInstance(request.deploymentId, SlateDeploymentId, "Slate deployment ID");
	requireInstance(request.publicationId, SlatePublicationId, "Slate publication ID");
	requireInstance(request.publicationMaterialization, ContentRef, "Slate publication materialization");
	requireOptionalInstance(request.expectedActiveDeploymentId, SlateDeploymentId, "Expected active Slate deployment ID");
	requireText(request.target, "Slate deployment target", 512);
	return {
		impact: request.impact,
		operation: request.operation,
		workspaceId: request.workspaceId.value,
		slateId: request.slateId.value,
		deploymentId: request.deploymentId.value,
		publicationId: request.publicationId.value,
		publicationMaterialization: request.publicationMaterialization.value,
		target: request.target,
		expectedActiveDeploymentId: request.expectedActiveDeploymentId?.value ?? null
	};
}
function resourceData(request) {
	if (request.operation === "resource.materialize" && request.impact !== "externalSend") throw invalidInput("Slate resource invocation impact must be externalSend");
	requireBase(request);
	requireInstance(request.resourceId, SlateResourceId, "Slate resource ID");
	requireInstance(request.deploymentId, SlateDeploymentId, "Slate deployment ID");
	requireInstance(request.deploymentMaterialization, ContentRef, "Slate deployment materialization");
	requireText(request.resourceName, "Slate resource name", 256);
	requireInstance(request.resourceSource, ContentRef, "Slate resource source");
	return {
		impact: request.impact,
		operation: request.operation,
		workspaceId: request.workspaceId.value,
		slateId: request.slateId.value,
		resourceId: request.resourceId.value,
		deploymentId: request.deploymentId.value,
		deploymentMaterialization: request.deploymentMaterialization.value,
		resourceName: request.resourceName,
		resourceSource: request.resourceSource.value
	};
}
function requireKeys(value, expected) {
	if (Reflect.ownKeys(value).length !== expected.length || expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) throw invalidInput("Slate intent contains missing or unknown fields");
}
function requireEpoch(value) {
	if (!Number.isSafeInteger(value) || value < 0) throw invalidInput("Slate preview session epoch must be a non-negative safe integer");
}
function requireBase(value) {
	requireInstance(value.workspaceId, WorkspaceId, "Slate Workspace ID");
	requireInstance(value.slateId, SlateId, "Slate ID");
}
function requireInstance(value, constructor, subject) {
	if (!(value instanceof constructor)) throw invalidInput(`${subject} is invalid`);
}
function requireOptionalInstance(value, constructor, subject) {
	if (value !== void 0) requireInstance(value, constructor, subject);
}
function requireText(value, subject, maximum) {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) throw invalidInput(`${subject} must not be blank or exceed ${maximum} characters`);
}
function equalBytes(left, right) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
function invalidInput(message) {
	return new AgentCoreError("operation.invalid-input", message);
}
//#endregion
//#region src/slates/store.ts
var SlateDeploymentReservationCodec = class extends RecordCodec {
	constructor() {
		super([
			SlateDeploymentReservation,
			TextId,
			ContentRef,
			Digest,
			InvocationId,
			SlateId,
			SlatePublicationId,
			SlateDeploymentId,
			WorkspaceId
		], "slate.deployment-reservation", {
			major: 1,
			minor: 1
		});
	}
	encodePayload(reservation) {
		return reservation.toData();
	}
	decodePayload(payload) {
		return SlateDeploymentReservation.fromData(payload);
	}
};
var SlateDeploymentReservation = class SlateDeploymentReservation {
	static get codec() {
		return slateDeploymentReservationCodecInstance;
	}
	target;
	static encode(reservation) {
		return SlateDeploymentReservation.codec.encode(reservation);
	}
	static decode(bytes) {
		return SlateDeploymentReservation.codec.decode(bytes);
	}
	constructor(init) {
		if (!(init.id instanceof SlateDeploymentId) || !(init.workspaceId instanceof WorkspaceId) || !(init.slateId instanceof SlateId) || !(init.publicationId instanceof SlatePublicationId) || !(init.publicationMaterialization instanceof ContentRef) || !(init.invocationId instanceof InvocationId) || init.expectedActiveDeploymentId !== void 0 && !(init.expectedActiveDeploymentId instanceof SlateDeploymentId)) throw new TypeError("Slate deployment reservation is malformed");
		this.id = init.id;
		this.workspaceId = init.workspaceId;
		this.slateId = init.slateId;
		this.publicationId = init.publicationId;
		this.publicationMaterialization = init.publicationMaterialization;
		this.target = requireText$1(init.target, "Slate deployment target");
		this.externalKey = requireText$1(init.externalKey, "Slate deployment external key");
		this.invocationId = init.invocationId;
		this.expectedActiveDeploymentId = init.expectedActiveDeploymentId;
		Object.freeze(this);
	}
	id;
	workspaceId;
	slateId;
	publicationId;
	publicationMaterialization;
	invocationId;
	externalKey;
	expectedActiveDeploymentId;
	toData() {
		return {
			expectedActiveDeploymentId: this.expectedActiveDeploymentId?.value ?? null,
			externalKey: this.externalKey,
			id: this.id.value,
			invocationId: this.invocationId.value,
			publicationId: this.publicationId.value,
			publicationMaterialization: this.publicationMaterialization.value,
			slateId: this.slateId.value,
			target: this.target,
			workspaceId: this.workspaceId.value
		};
	}
	static fromData(payload) {
		const object = requireExactObject(payload, [
			"expectedActiveDeploymentId",
			"externalKey",
			"id",
			"invocationId",
			"publicationId",
			"publicationMaterialization",
			"slateId",
			"target",
			"workspaceId"
		], "Slate deployment reservation payload");
		const expected = nullableString(object["expectedActiveDeploymentId"], "Expected active deployment ID");
		let reservation = {
			id: deploymentId(object["id"]),
			workspaceId: workspaceId(object["workspaceId"]),
			slateId: slateId(object["slateId"]),
			publicationId: publicationId(object["publicationId"]),
			publicationMaterialization: contentRef(object["publicationMaterialization"], "Slate publication materialization"),
			target: requireStringValue(object["target"], "Slate deployment target"),
			externalKey: requireStringValue(object["externalKey"], "Slate deployment external key"),
			invocationId: invocationId(object["invocationId"])
		};
		if (expected !== void 0) reservation = {
			...reservation,
			expectedActiveDeploymentId: deploymentId(expected)
		};
		return new SlateDeploymentReservation(reservation);
	}
};
var slateDeploymentReservationCodecInstance = new SlateDeploymentReservationCodec();
var SlateResourceReservationCodec = class extends RecordCodec {
	constructor() {
		super([
			SlateResourceReservation,
			TextId,
			ContentRef,
			Digest,
			SlateResourceId,
			InvocationId,
			SlateId,
			SlateDeploymentId,
			WorkspaceId
		], "slate.resource-reservation", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(reservation) {
		return reservation.toData();
	}
	decodePayload(payload) {
		return SlateResourceReservation.fromData(payload);
	}
};
var SlateResourceReservation = class SlateResourceReservation {
	static get codec() {
		return slateResourceReservationCodecInstance;
	}
	name;
	static encode(reservation) {
		return SlateResourceReservation.codec.encode(reservation);
	}
	static decode(bytes) {
		return SlateResourceReservation.codec.decode(bytes);
	}
	constructor(init) {
		if (!(init.id instanceof SlateResourceId) || !(init.workspaceId instanceof WorkspaceId) || !(init.slateId instanceof SlateId) || !(init.deploymentId instanceof SlateDeploymentId) || !(init.deploymentMaterialization instanceof ContentRef) || !(init.source instanceof ContentRef) || !(init.invocationId instanceof InvocationId)) throw new TypeError("Slate resource reservation is malformed");
		this.id = init.id;
		this.workspaceId = init.workspaceId;
		this.slateId = init.slateId;
		this.deploymentId = init.deploymentId;
		this.deploymentMaterialization = init.deploymentMaterialization;
		this.name = requireText$1(init.name, "Slate resource name", 256);
		this.source = init.source;
		this.invocationId = init.invocationId;
		Object.freeze(this);
	}
	id;
	workspaceId;
	slateId;
	deploymentId;
	deploymentMaterialization;
	source;
	invocationId;
	toData() {
		return {
			deploymentId: this.deploymentId.value,
			deploymentMaterialization: this.deploymentMaterialization.value,
			id: this.id.value,
			invocationId: this.invocationId.value,
			name: this.name,
			slateId: this.slateId.value,
			source: this.source.value,
			workspaceId: this.workspaceId.value
		};
	}
	static fromData(payload) {
		const object = requireExactObject(payload, [
			"deploymentId",
			"deploymentMaterialization",
			"id",
			"invocationId",
			"name",
			"slateId",
			"source",
			"workspaceId"
		], "Slate resource reservation payload");
		return new SlateResourceReservation({
			id: resourceId(object["id"]),
			workspaceId: workspaceId(object["workspaceId"]),
			slateId: slateId(object["slateId"]),
			deploymentId: deploymentId(object["deploymentId"]),
			deploymentMaterialization: contentRef(object["deploymentMaterialization"], "Slate deployment materialization"),
			name: requireStringValue(object["name"], "Slate resource name"),
			source: contentRef(object["source"], "Slate resource source"),
			invocationId: invocationId(object["invocationId"])
		});
	}
};
var slateResourceReservationCodecInstance = new SlateResourceReservationCodec();
var EMPTY_SNAPSHOT = {
	slates: [],
	versions: [],
	publications: [],
	deployments: [],
	resources: [],
	previews: [],
	deploymentReservations: [],
	resourceReservations: []
};
var SlateStore = class {};
var MemorySlateStore = class MemorySlateStore extends SlateStore {
	#slates = /* @__PURE__ */ new Map();
	#latest = /* @__PURE__ */ new Map();
	#versions = /* @__PURE__ */ new Map();
	#publications = /* @__PURE__ */ new Map();
	#deployments = /* @__PURE__ */ new Map();
	#resources = /* @__PURE__ */ new Map();
	#previews = /* @__PURE__ */ new Map();
	#deploymentReservations = /* @__PURE__ */ new Map();
	#resourceReservations = /* @__PURE__ */ new Map();
	#custody;
	constructor(custody, snapshot = EMPTY_SNAPSHOT) {
		super();
		this.#custody = custody;
		this.install(snapshot);
	}
	/**
	* A draft holds its custody registrations back until the draft's records commit, so a
	* faulted operation leaves neither a Slate row nor an owner edge behind.
	*/
	transaction(operation) {
		const buffered = new BufferedSlateCustody();
		const draft = new MemorySlateStore(buffered, this.snapshot());
		const result = requireSynchronousResult(operation(draft));
		this.restore(draft.snapshot());
		buffered.flush(this.#custody, this);
		return result;
	}
	getSlate(id) {
		const latest = this.#latest.get(id.value);
		return latest === void 0 ? void 0 : this.getSlateRevision(id, new Revision(latest));
	}
	listSlates(workspaceId_) {
		return Object.freeze([...this.#latest.keys()].sort((left, right) => compareCanonicalText(left, right)).map((id) => this.getSlate(new SlateId(id))).filter((slate) => workspaceId_ === void 0 || slate.workspaceId.equals(workspaceId_)));
	}
	getSlateRevision(id, revision_) {
		const row = this.#slates.get(slateRevisionKey(id.value, revision_.value));
		if (row === void 0) return void 0;
		const slate = Slate.decode(copyBytes(row.bytes));
		verifySlateProjection(row, slate);
		return slate;
	}
	listSlateHistory(id) {
		return Object.freeze([...this.#slates.values()].filter((row) => row.id === id.value).sort((left, right) => left.revision - right.revision).map((row) => {
			const slate = Slate.decode(copyBytes(row.bytes));
			verifySlateProjection(row, slate);
			return slate;
		}));
	}
	compareAndSetSlate(expected, next) {
		const current = this.getSlate(next.id);
		if (expected === void 0) {
			if (current !== void 0) return false;
			if (next.revision.value !== 0) throw invalidState("A new Slate must start at revision zero");
		} else {
			if (current === void 0 || !current.revision.equals(expected)) return false;
			if (expected.value === Number.MAX_SAFE_INTEGER || next.revision.value !== expected.value + 1) throw invalidState("A Slate CAS must append the next revision");
			if (!next.workspaceId.equals(current.workspaceId)) throw invalidState("Slate workspace ownership is immutable");
			if (!sameFork(current.forkedFrom, next.forkedFrom)) throw invalidState("Slate fork origin is immutable");
		}
		this.verifySlateClosure(next);
		const bytes = Slate.encode(next);
		const canonical = Slate.decode(bytes);
		const row = projectSlate(canonical, bytes);
		const key = slateRevisionKey(row.id, row.revision);
		this.register(Slate.codec.kind, key, slateContentRetention(canonical));
		const existing = this.#slates.get(key);
		if (existing !== void 0) requireSameBytes(existing.bytes, row.bytes, `Slate ${key}`);
		else this.#slates.set(key, copySlateRow(row));
		this.#latest.set(row.id, row.revision);
		return true;
	}
	addVersion(version) {
		this.requireOwned(version.workspaceId, version.slateId);
		if (version.parentVersionId !== void 0) {
			const parent = this.getVersion(version.parentVersionId);
			if (parent === void 0 || !parent.slateId.equals(version.slateId) || !parent.workspaceId.equals(version.workspaceId)) throw invalidVersion("Slate version parent must exist in the same Slate");
		}
		this.register(SlateVersion.codec.kind, version.id.value, slateVersionContentRetention(version));
		putRecord(this.#versions, version.id.value, version, SlateVersion.codec);
	}
	getVersion(id) {
		return getRecord(this.#versions, id.value, SlateVersion.codec);
	}
	listVersions(slateId_) {
		return listRecords(this.#versions, SlateVersion.codec).filter((version) => version.slateId.equals(slateId_));
	}
	addPublication(publication) {
		this.requireOwned(publication.workspaceId, publication.slateId);
		const version = this.getVersion(publication.versionId);
		if (version === void 0 || !version.slateId.equals(publication.slateId)) throw invalidVersion("Slate publication version must exist in the same Slate");
		this.register(SlatePublication.codec.kind, publication.id.value, slatePublicationContentRetention(publication));
		putRecord(this.#publications, publication.id.value, publication, SlatePublication.codec);
	}
	getPublication(id) {
		return getRecord(this.#publications, id.value, SlatePublication.codec);
	}
	listPublications(slateId_) {
		return listRecords(this.#publications, SlatePublication.codec).filter((publication) => publication.slateId.equals(slateId_));
	}
	addDeployment(deployment) {
		this.requireOwned(deployment.workspaceId, deployment.slateId);
		const reservation = this.getDeploymentReservation(deployment.id);
		if (reservation === void 0 || !sameDeploymentReservation(reservation, deployment)) throw invalidState("Slate deployment must match its frozen reservation");
		this.register(SlateDeployment.codec.kind, deployment.id.value, slateDeploymentContentRetention(deployment));
		putRecord(this.#deployments, deployment.id.value, deployment, SlateDeployment.codec);
	}
	getDeployment(id) {
		return getRecord(this.#deployments, id.value, SlateDeployment.codec);
	}
	listDeployments(slateId_) {
		return listRecords(this.#deployments, SlateDeployment.codec).filter((deployment) => deployment.slateId.equals(slateId_));
	}
	addResource(resource) {
		this.requireOwned(resource.workspaceId, resource.slateId);
		const reservation = this.getResourceReservation(resource.id);
		if (reservation === void 0 || !sameResourceReservation(reservation, resource)) throw invalidState("Slate resource must match its frozen reservation");
		if (this.getDeployment(resource.deploymentId) === void 0) throw invalidState("Slate resource deployment must exist");
		this.register(SlateResource.codec.kind, resource.id.value, slateResourceContentRetention(resource));
		putRecord(this.#resources, resource.id.value, resource, SlateResource.codec);
	}
	getResource(id) {
		return getRecord(this.#resources, id.value, SlateResource.codec);
	}
	listResources(deploymentId_) {
		return listRecords(this.#resources, SlateResource.codec).filter((resource) => resource.deploymentId.equals(deploymentId_));
	}
	addPreview(preview) {
		const slate = this.requireOwned(preview.workspaceId, preview.slateId);
		if (preview.versionId === void 0) {
			if (!preview.source.equals(slate.source)) throw new AgentCoreError("protocol.revision-conflict", "Working Slate preview source must match the current source");
		} else {
			const version = this.getVersion(preview.versionId);
			if (version === void 0 || !version.slateId.equals(preview.slateId) || !version.source.equals(preview.source)) throw invalidVersion("Versioned Slate preview must reference its exact source");
		}
		this.register(SlatePreview.codec.kind, preview.id.value, slatePreviewContentRetention(preview));
		putRecord(this.#previews, preview.id.value, preview, SlatePreview.codec);
	}
	getPreview(id) {
		return getRecord(this.#previews, id.value, SlatePreview.codec);
	}
	listPreviews(slateId_) {
		return listRecords(this.#previews, SlatePreview.codec).filter((preview) => preview.slateId.equals(slateId_));
	}
	reserveDeployment(reservation) {
		this.requireOwned(reservation.workspaceId, reservation.slateId);
		const publication = this.getPublication(reservation.publicationId);
		if (publication === void 0 || !publication.slateId.equals(reservation.slateId) || !publication.materialization.equals(reservation.publicationMaterialization)) throw new AgentCoreError("slate.unpublished", "Slate deployment publication must exist in the same Slate");
		this.register(SlateDeploymentReservation.codec.kind, reservation.id.value, contentRetentionFields([["publicationMaterialization", reservation.publicationMaterialization]]));
		putReservation(this.#deploymentReservations, reservation.id.value, reservation, SlateDeploymentReservation.codec);
	}
	getDeploymentReservation(id) {
		return getRecord(this.#deploymentReservations, id.value, SlateDeploymentReservation.codec);
	}
	findDeploymentReservationByExternalKey(externalKey) {
		for (const key of this.#deploymentReservations.keys()) {
			const reservation = getRecord(this.#deploymentReservations, key, SlateDeploymentReservation.codec);
			if (reservation?.externalKey === externalKey) return reservation;
		}
	}
	reserveResource(reservation) {
		this.requireOwned(reservation.workspaceId, reservation.slateId);
		const deployment = this.getDeployment(reservation.deploymentId);
		if (deployment === void 0 || !deployment.slateId.equals(reservation.slateId) || !deployment.materialization.equals(reservation.deploymentMaterialization)) throw invalidState("Slate resource deployment must exist in the same Slate");
		this.register(SlateResourceReservation.codec.kind, reservation.id.value, contentRetentionFields([["deploymentMaterialization", reservation.deploymentMaterialization], ["source", reservation.source]]));
		putReservation(this.#resourceReservations, reservation.id.value, reservation, SlateResourceReservation.codec);
	}
	getResourceReservation(id) {
		return getRecord(this.#resourceReservations, id.value, SlateResourceReservation.codec);
	}
	snapshot() {
		return Object.freeze({
			slates: frozenRows(this.#slates.values(), copySlateRow),
			versions: frozenRows(this.#versions.values(), copyRecordRow),
			publications: frozenRows(this.#publications.values(), copyRecordRow),
			deployments: frozenRows(this.#deployments.values(), copyRecordRow),
			resources: frozenRows(this.#resources.values(), copyRecordRow),
			previews: frozenRows(this.#previews.values(), copyRecordRow),
			deploymentReservations: frozenRows(this.#deploymentReservations.values(), copyReservationRow),
			resourceReservations: frozenRows(this.#resourceReservations.values(), copyReservationRow)
		});
	}
	/**
	* A clone reads the same durable state and therefore holds the same custody: a copy is
	* a second reader of one Slate Actor's records, never a second retainer.
	*/
	clone() {
		return new MemorySlateStore(this.#custody, this.snapshot());
	}
	/**
	* Registers a record's ContentRefs before its row is installed. Slate records are
	* immutable once written and every revision is kept, so this store never releases:
	* a superseded head keeps the source its own revision still names.
	*/
	register(kind, key, fields) {
		if (fields.length === 0) return;
		this.#custody.retain(this, {
			kind,
			key,
			fields
		});
	}
	restore(snapshot) {
		this.#slates.clear();
		this.#latest.clear();
		this.#versions.clear();
		this.#publications.clear();
		this.#deployments.clear();
		this.#resources.clear();
		this.#previews.clear();
		this.#deploymentReservations.clear();
		this.#resourceReservations.clear();
		this.install(snapshot);
	}
	install(snapshot) {
		this.installSlateRows(snapshot.slates);
		installRows(this.#versions, snapshot.versions, "Slate versions");
		installRows(this.#publications, snapshot.publications, "Slate publications");
		installRows(this.#deployments, snapshot.deployments, "Slate deployments");
		installRows(this.#resources, snapshot.resources, "Slate resources");
		installRows(this.#previews, snapshot.previews, "Slate previews");
		installRows(this.#deploymentReservations, snapshot.deploymentReservations, "Slate deployment reservations");
		installRows(this.#resourceReservations, snapshot.resourceReservations, "Slate resource reservations");
		this.verifyAll();
	}
	requireOwned(workspaceId_, slateId_) {
		const slate = this.getSlate(slateId_);
		if (slate === void 0 || !slate.workspaceId.equals(workspaceId_)) throw invalidState("Slate record must be owned by its Slate workspace");
		return slate;
	}
	verifySlateClosure(slate) {
		if (slate.forkedFrom !== void 0) {
			const source = this.getVersion(slate.forkedFrom.versionId);
			if (source === void 0 || !source.slateId.equals(slate.forkedFrom.slateId) || !source.workspaceId.equals(slate.workspaceId) || !source.source.equals(slate.source)) throw invalidVersion("Slate fork must reference an existing exact source version");
		}
		if (slate.headVersionId !== void 0) {
			const head = this.getVersion(slate.headVersionId);
			if (head === void 0 || !head.slateId.equals(slate.id) || !head.workspaceId.equals(slate.workspaceId)) throw invalidVersion("Slate head must reference an owned version");
		}
		if (slate.activeDeploymentId !== void 0) {
			const deployment = this.getDeployment(slate.activeDeploymentId);
			if (deployment === void 0 || !deployment.slateId.equals(slate.id) || !deployment.workspaceId.equals(slate.workspaceId)) throw invalidState("Slate active deployment must be a successful owned deployment");
		}
		if (slate.latestPublicationId !== void 0) {
			const publication = this.getPublication(slate.latestPublicationId);
			if (publication === void 0 || !publication.slateId.equals(slate.id) || !publication.workspaceId.equals(slate.workspaceId)) throw new AgentCoreError("slate.unpublished", "Slate latest publication must be an owned publication");
		}
	}
	installSlateRows(rows) {
		for (const source of rows) {
			const row = copySlateRow(source);
			const key = slateRevisionKey(row.id, row.revision);
			if (this.#slates.has(key)) throw duplicate("Slate snapshot contains duplicate history");
			this.#slates.set(key, row);
			const latest = this.#latest.get(row.id);
			if (latest === void 0 || row.revision > latest) this.#latest.set(row.id, row.revision);
		}
	}
	verifyAll() {
		for (const row of this.#slates.values()) verifySlateProjection(row, Slate.decode(row.bytes));
		verifyRecordRows(this.#versions, SlateVersion.codec);
		verifyRecordRows(this.#publications, SlatePublication.codec);
		verifyRecordRows(this.#deployments, SlateDeployment.codec);
		verifyRecordRows(this.#resources, SlateResource.codec);
		verifyRecordRows(this.#previews, SlatePreview.codec);
		verifyReservationRows(this.#deploymentReservations, SlateDeploymentReservation.codec);
		verifyReservationRows(this.#resourceReservations, SlateResourceReservation.codec);
		for (const [id, latest] of this.#latest) {
			const history = this.listSlateHistory(new SlateId(id));
			if (history.length === 0 || history[0].revision.value !== 0 || history.at(-1).revision.value !== latest || history.some((slate, index) => slate.revision.value !== index)) throw corrupt("Slate history is not a contiguous immutable replay");
		}
		for (const id of this.#latest.keys()) {
			const history = this.listSlateHistory(new SlateId(id));
			for (const [index, slate] of history.entries()) {
				this.verifySlateClosure(slate);
				if (index > 0) verifySlateTransition(history[index - 1], slate);
			}
		}
		for (const version of listRecords(this.#versions, SlateVersion.codec)) {
			this.requireOwned(version.workspaceId, version.slateId);
			if (version.parentVersionId !== void 0 && this.getVersion(version.parentVersionId) === void 0) throw corrupt("Slate version has a dangling parent");
		}
		for (const publication of listRecords(this.#publications, SlatePublication.codec)) {
			this.requireOwned(publication.workspaceId, publication.slateId);
			const version = this.getVersion(publication.versionId);
			if (version === void 0 || !version.slateId.equals(publication.slateId) || !version.workspaceId.equals(publication.workspaceId)) throw corrupt("Slate publication has a dangling version");
		}
		for (const reservation of [...this.#deploymentReservations.keys()].map((id) => this.getDeploymentReservation(new SlateDeploymentId(id)))) {
			this.requireOwned(reservation.workspaceId, reservation.slateId);
			const publication = this.getPublication(reservation.publicationId);
			if (publication === void 0 || !publication.slateId.equals(reservation.slateId) || !publication.materialization.equals(reservation.publicationMaterialization)) throw corrupt("Slate deployment reservation has a dangling publication");
		}
		for (const deployment of listRecords(this.#deployments, SlateDeployment.codec)) {
			this.requireOwned(deployment.workspaceId, deployment.slateId);
			const reservation = this.getDeploymentReservation(deployment.id);
			if (reservation === void 0 || !sameDeploymentReservation(reservation, deployment)) throw corrupt("Slate deployment does not match its reservation");
		}
		for (const resource of listRecords(this.#resources, SlateResource.codec)) {
			this.requireOwned(resource.workspaceId, resource.slateId);
			const reservation = this.getResourceReservation(resource.id);
			if (reservation === void 0 || !sameResourceReservation(reservation, resource)) throw corrupt("Slate resource does not match its reservation");
			if (this.getDeployment(resource.deploymentId) === void 0) throw corrupt("Slate resource has a dangling deployment");
		}
		for (const reservation of [...this.#resourceReservations.keys()].map((id) => this.getResourceReservation(new SlateResourceId(id)))) {
			this.requireOwned(reservation.workspaceId, reservation.slateId);
			const deployment = this.getDeployment(reservation.deploymentId);
			if (deployment === void 0 || !deployment.materialization.equals(reservation.deploymentMaterialization)) throw corrupt("Slate resource reservation has a dangling deployment");
		}
		for (const preview of listRecords(this.#previews, SlatePreview.codec)) {
			this.requireOwned(preview.workspaceId, preview.slateId);
			const version = preview.versionId === void 0 ? void 0 : this.getVersion(preview.versionId);
			if (preview.versionId !== void 0 && (version === void 0 || !version.slateId.equals(preview.slateId) || !version.source.equals(preview.source))) throw corrupt("Slate preview has a dangling or inexact source reference");
		}
	}
};
/**
* A draft's custody, held until the draft's records commit. The Slate store's transaction
* is a draft copy that the caller's store adopts only on success, so registrations made
* against the draft reach the real custody at exactly the moment the records do, and a
* faulted operation discards both together.
*/
var BufferedSlateCustody = class {
	#retained = [];
	#released = [];
	retain(_store, record, previous) {
		this.#retained.push({
			record,
			previous
		});
	}
	release(_store, record) {
		this.#released.push(record);
	}
	flush(custody, store) {
		for (const { record, previous } of this.#retained) custody.retain(store, record, previous);
		for (const record of this.#released) custody.release(store, record);
	}
};
Object.freeze(BufferedSlateCustody.prototype);
Object.freeze(BufferedSlateCustody);
function verifySlateTransition(previous, next) {
	if (!previous.id.equals(next.id) || !previous.workspaceId.equals(next.workspaceId) || !sameFork(previous.forkedFrom, next.forkedFrom)) throw corrupt("Slate identity, workspace ownership, and fork origin are immutable");
}
function sameFork(left, right) {
	return left === void 0 ? right === void 0 : right !== void 0 && left.slateId.equals(right.slateId) && left.versionId.equals(right.versionId);
}
function projectSlate(slate, bytes) {
	return {
		id: slate.id.value,
		workspaceId: slate.workspaceId,
		revision: slate.revision.value,
		bytes: copyBytes(bytes)
	};
}
function verifySlateProjection(row, slate) {
	if (row.id !== slate.id.value || !(row.workspaceId instanceof WorkspaceId) || !row.workspaceId.equals(slate.workspaceId) || row.revision !== slate.revision.value) throw corrupt("Stored Slate projection does not match its codec bytes");
}
function putRecord(rows, key, record, codec) {
	const bytes = codec.encode(record);
	const canonical = codec.decode(bytes);
	const row = {
		id: canonical.id.value,
		workspaceId: canonical.workspaceId,
		slateId: canonical.slateId,
		bytes: copyBytes(bytes)
	};
	const existing = rows.get(key);
	if (existing !== void 0) {
		requireSameBytes(existing.bytes, row.bytes, `Slate record ${key}`);
		return;
	}
	rows.set(key, copyRecordRow(row));
}
function putReservation(rows, key, record, codec) {
	const bytes = codec.encode(record);
	const canonical = codec.decode(bytes);
	const row = {
		id: canonical.id.value,
		workspaceId: canonical.workspaceId,
		slateId: canonical.slateId,
		invocationId: canonical.invocationId,
		bytes: copyBytes(bytes)
	};
	const existing = rows.get(key);
	if (existing !== void 0) {
		requireSameBytes(existing.bytes, row.bytes, `Slate reservation ${key}`);
		return;
	}
	rows.set(key, copyReservationRow(row));
}
function getRecord(rows, key, codec) {
	const row = rows.get(key);
	if (row === void 0) return void 0;
	const record = codec.decode(copyBytes(row.bytes));
	verifyCommonProjection(row, record);
	return record;
}
function listRecords(rows, codec) {
	return Object.freeze([...rows.values()].sort((left, right) => compareCanonicalText(left.id, right.id)).map((row) => {
		const record = codec.decode(copyBytes(row.bytes));
		verifyCommonProjection(row, record);
		return record;
	}));
}
function verifyRecordRows(rows, codec) {
	for (const [key, row] of rows) {
		if (key !== row.id) throw corrupt("Stored Slate record key does not match its projection");
		verifyCommonProjection(row, codec.decode(row.bytes));
	}
}
function verifyReservationRows(rows, codec) {
	for (const [key, row] of rows) {
		if (key !== row.id) throw corrupt("Stored Slate reservation key does not match its projection");
		const record = codec.decode(row.bytes);
		verifyCommonProjection(row, record);
		if (!(row.invocationId instanceof InvocationId) || record.invocationId.value !== row.invocationId.value) throw corrupt("Stored Slate reservation invocation does not match its codec bytes");
	}
}
function verifyCommonProjection(row, record) {
	if (!(row.workspaceId instanceof WorkspaceId) || !(row.slateId instanceof SlateId) || record.id.value !== row.id || record.workspaceId.value !== row.workspaceId.value || record.slateId.value !== row.slateId.value) throw corrupt("Stored Slate projection does not match its codec bytes");
}
function sameDeploymentReservation(reservation, deployment) {
	return reservation.id.equals(deployment.id) && reservation.workspaceId.equals(deployment.workspaceId) && reservation.slateId.equals(deployment.slateId) && reservation.publicationId.equals(deployment.publicationId) && reservation.target === deployment.target && reservation.invocationId.equals(deployment.invocationId);
}
function sameResourceReservation(reservation, resource) {
	return reservation.id.equals(resource.id) && reservation.workspaceId.equals(resource.workspaceId) && reservation.slateId.equals(resource.slateId) && reservation.deploymentId.equals(resource.deploymentId) && reservation.name === resource.name && reservation.source.equals(resource.source) && reservation.invocationId.equals(resource.invocationId);
}
function installRows(target, rows, subject) {
	for (const source of rows) {
		if (target.has(source.id)) throw duplicate(`${subject} snapshot contains duplicate IDs`);
		target.set(source.id, copyAnyRow(source));
	}
}
function copyAnyRow(row) {
	return {
		...row,
		bytes: copyBytes(row.bytes)
	};
}
function frozenRows(rows, copy) {
	return Object.freeze([...rows].sort((left, right) => compareCanonicalText(left.id, right.id) || ("revision" in left && "revision" in right ? left.revision - right.revision : 0)).map((row) => Object.freeze(copy(row))));
}
function copySlateRow(row) {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		revision: row.revision,
		bytes: copyBytes(row.bytes)
	};
}
function copyRecordRow(row) {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		slateId: row.slateId,
		bytes: copyBytes(row.bytes)
	};
}
function copyReservationRow(row) {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		slateId: row.slateId,
		invocationId: row.invocationId,
		bytes: copyBytes(row.bytes)
	};
}
function copyBytes(bytes) {
	return new Uint8Array(bytes);
}
function requireSameBytes(left, right, subject) {
	if (left.length !== right.length || left.some((value, index) => value !== right[index])) throw duplicate(`${subject} is immutable`);
}
function slateRevisionKey(id, revision_) {
	return `${id}\u0000${revision_}`;
}
function corrupt(message) {
	return invalidState(message);
}
function invalidState(message) {
	return new AgentCoreError("protocol.invalid-state", message);
}
function invalidVersion(message) {
	return new AgentCoreError("slate.invalid-version", message);
}
function duplicate(message) {
	return new AgentCoreError("protocol.duplicate", message);
}
//#endregion
//#region src/slates/runtime.ts
var SlateIdSource = class {};
var MemorySlateIdSource = class extends SlateIdSource {
	prefix;
	#next = 0;
	constructor(prefix = "slate") {
		super();
		this.prefix = prefix;
		if (prefix.trim().length === 0) throw new TypeError("Slate ID prefix must not be blank");
	}
	allocateSlateId() {
		return new SlateId(this.value("slate"));
	}
	allocateVersionId() {
		return new SlateVersionId(this.value("version"));
	}
	allocatePublicationId() {
		return new SlatePublicationId(this.value("publication"));
	}
	allocateDeploymentId() {
		return new SlateDeploymentId(this.value("deployment"));
	}
	allocateResourceId() {
		return new SlateResourceId(this.value("resource"));
	}
	allocatePreviewId() {
		return new SlatePreviewId(this.value("preview"));
	}
	value(kind) {
		const value = `${this.prefix}-${kind}-${this.#next}`;
		this.#next += 1;
		return value;
	}
};
var SlateRuntime = class {
	store;
	provider;
	mutations;
	invocations;
	previewValidation;
	ids;
	constructor(store, provider, mutations, invocations, previewValidation, ids) {
		this.store = store;
		this.provider = provider;
		this.mutations = mutations;
		this.invocations = invocations;
		this.previewValidation = previewValidation;
		this.ids = ids;
	}
	async create(workspaceId, source) {
		const request = freezeSlateMutationRequest({
			operation: "create",
			impact: "mutate",
			workspaceId,
			slateId: this.ids.allocateSlateId(),
			source
		});
		return this.mutate(request, (store) => {
			const slate = Slate.initial(request.slateId, request.workspaceId, request.source);
			if (!store.compareAndSetSlate(void 0, slate)) throw new AgentCoreError("protocol.duplicate", `Slate ${request.slateId.value} already exists`);
			return slate;
		});
	}
	async update(id, source, expectedRevision) {
		const current = this.requireSlate(this.store, id);
		const request = freezeSlateMutationRequest({
			operation: "update",
			impact: "mutate",
			workspaceId: current.workspaceId,
			slateId: current.id,
			source,
			expectedRevision: expectedRevision ?? current.revision
		});
		return this.mutate(request, (store) => {
			const next = this.requireExpectedSlate(store, request.slateId, request.expectedRevision).update(request.source);
			if (!store.compareAndSetSlate(request.expectedRevision, next)) throw revisionConflict(request.slateId);
			return next;
		});
	}
	async commit(id, expectedRevision) {
		const current = this.requireSlate(this.store, id);
		const request = freezeSlateMutationRequest({
			operation: "commit",
			impact: "mutate",
			workspaceId: current.workspaceId,
			slateId: current.id,
			versionId: this.ids.allocateVersionId(),
			source: current.source,
			parentVersionId: current.headVersionId,
			expectedRevision: expectedRevision ?? current.revision
		});
		return this.mutate(request, (store) => {
			const slate = this.requireExpectedSlate(store, request.slateId, request.expectedRevision);
			if (!slate.source.equals(request.source) || !sameOptionalVersion(slate.headVersionId, request.parentVersionId)) throw revisionConflict(request.slateId);
			const version = new SlateVersion(request.versionId, request.workspaceId, request.slateId, request.source, request.parentVersionId);
			store.addVersion(version);
			if (!store.compareAndSetSlate(request.expectedRevision, slate.commit(request.versionId))) throw revisionConflict(request.slateId);
			return version;
		});
	}
	async fork(sourceVersionId, workspaceId) {
		const version = this.requireVersion(this.store, sourceVersionId);
		const sourceSlate = this.requireSlate(this.store, version.slateId);
		if (!version.workspaceId.equals(workspaceId)) throw new AgentCoreError("operation.invalid-input", "Slate forks must remain in the source Workspace");
		const request = freezeSlateMutationRequest({
			operation: "fork",
			impact: "mutate",
			workspaceId,
			slateId: this.ids.allocateSlateId(),
			sourceSlateId: version.slateId,
			sourceVersionId: version.id,
			source: version.source,
			expectedSourceRevision: sourceSlate.revision
		});
		return this.mutate(request, (store) => {
			const exactSource = this.requireExpectedSlate(store, request.sourceSlateId, request.expectedSourceRevision);
			const exactVersion = this.requireVersion(store, request.sourceVersionId);
			if (!exactSource.workspaceId.equals(request.workspaceId) || !exactVersion.workspaceId.equals(request.workspaceId) || !exactVersion.slateId.equals(request.sourceSlateId) || !exactVersion.source.equals(request.source)) throw revisionConflict(request.slateId);
			const fork = new Slate({
				id: request.slateId,
				workspaceId: request.workspaceId,
				source: request.source,
				forkedFrom: {
					slateId: request.sourceSlateId,
					versionId: request.sourceVersionId
				},
				revision: Revision.initial()
			});
			if (!store.compareAndSetSlate(void 0, fork)) throw new AgentCoreError("protocol.duplicate", `Slate ${request.slateId.value} already exists`);
			return fork;
		});
	}
	/**
	* The credential-free export of a published Slate (SPEC §4.6). This reads records and
	* mints nothing, so its impact is `observe` and it needs no mutation intent. What it
	* projects is exactly the publication's declared requirements plus the content
	* identity of the version that was published — never the Workspace, never the Slate
	* id, and never a resolvable reference, because a skeleton names no Scope it came from
	* and confers no reach into one.
	*/
	exportSkeleton(publicationId) {
		const publication = this.requirePublication(this.store, publicationId);
		return new SlateSkeleton(this.requireVersion(this.store, publication.versionId).source.digest, publication.bindings);
	}
	/**
	* Admits a skeleton into `workspaceId` as a new Slate. Separate from `fork` because a
	* fork's `forkedFrom` is lineage inside one Workspace and an instantiate crosses a
	* Scope boundary: conflating them would let a lineage edge name a version the
	* admitting Scope does not hold, which is what `verifySlateClosure` rejects.
	*
	* `source` is the importer's own ContentRef for the bytes they were handed, so the
	* only retainer edge this creates is inside their own Scope. The digest comparison is
	* what makes the skeleton's content identity load-bearing rather than decorative.
	*
	* Every requirement the skeleton declares comes back unsatisfied, because admitting a
	* declaration grants nothing. The importer supplies Bindings through §3.4 and §4.1 as
	* for any other Facet; this Operation opens no path of its own.
	*/
	async instantiate(skeleton, workspaceId, source) {
		if (!(skeleton instanceof SlateSkeleton)) throw new AgentCoreError("operation.invalid-input", "Slate instantiate requires a Slate skeleton");
		if (!(source instanceof ContentRef) || !source.digest.equals(skeleton.sourceDigest)) throw new AgentCoreError("operation.invalid-input", "Slate instantiate source must be the content the skeleton declares");
		const request = freezeSlateMutationRequest({
			operation: "instantiate",
			impact: "mutate",
			workspaceId,
			slateId: this.ids.allocateSlateId(),
			source,
			skeletonDigest: Digest.sha256(SlateSkeleton.encode(skeleton))
		});
		const slate = await this.mutate(request, (store) => {
			const instantiated = Slate.initial(request.slateId, request.workspaceId, request.source);
			if (!store.compareAndSetSlate(void 0, instantiated)) throw new AgentCoreError("protocol.duplicate", `Slate ${request.slateId.value} already exists`);
			return instantiated;
		});
		return Object.freeze({
			slate,
			unsatisfied: skeleton.bindings
		});
	}
	async publish(versionId, materialization, bindings) {
		const version = this.requireVersion(this.store, versionId);
		const slate = this.requireSlate(this.store, version.slateId);
		const request = freezeSlateMutationRequest({
			operation: "publish",
			impact: "mutate",
			workspaceId: version.workspaceId,
			slateId: version.slateId,
			publicationId: this.ids.allocatePublicationId(),
			versionId: version.id,
			source: version.source,
			materialization,
			bindings: canonicalBindingRequirements(bindings, "Slate publication bindings"),
			expectedRevision: slate.revision
		});
		return this.mutate(request, (store) => {
			const current = this.requireExpectedSlate(store, request.slateId, request.expectedRevision);
			const exactVersion = this.requireVersion(store, request.versionId);
			if (!exactVersion.source.equals(request.source) || !exactVersion.workspaceId.equals(request.workspaceId)) throw revisionConflict(request.slateId);
			const publication = new SlatePublication(request.publicationId, request.workspaceId, request.slateId, request.versionId, request.materialization, request.bindings);
			store.addPublication(publication);
			if (!store.compareAndSetSlate(request.expectedRevision, current.publish(request.publicationId))) throw revisionConflict(request.slateId);
			return publication;
		});
	}
	async deploy(publicationId, target, externalKey) {
		if (!isExternalKey(externalKey) || externalKey.trim() !== externalKey || externalKey.length === 0) throw new AgentCoreError("operation.invalid-input", "Slate deployment external key must be canonical");
		const existing = this.store.findDeploymentReservationByExternalKey(externalKey);
		if (existing !== void 0) {
			if (!existing.publicationId.equals(publicationId) || existing.target !== target) throw new AgentCoreError("protocol.invalid-state", "Slate deployment effect identity was reused for a different request");
			return this.reconcileDeployment(existing.id);
		}
		const publication = this.requirePublication(this.store, publicationId);
		const slate = this.requireSlate(this.store, publication.slateId);
		const request = freezeSlateInvocationRequest({
			operation: "deploy",
			impact: "externalSend",
			workspaceId: slate.workspaceId,
			slateId: slate.id,
			deploymentId: this.ids.allocateDeploymentId(),
			publicationId: publication.id,
			publicationMaterialization: publication.materialization,
			target,
			expectedActiveDeploymentId: slate.activeDeploymentId
		});
		const invocationId = await this.invocations.prepare(request);
		const reserve = freezeSlateMutationRequest({
			...request,
			operation: "deploy.reserve",
			impact: "mutate",
			invocationId
		});
		await this.mutate(reserve, (store) => store.reserveDeployment(deploymentReservation(reserve, externalKey)));
		const result = await this.invocations.invoke(request, invocationId, async (context) => this.provider.deploy(deploymentProviderRequest(request, invocationId, context)));
		return this.finalizeDeployment(request, invocationId, result);
	}
	async reconcileDeployment(id) {
		const completed = this.store.getDeployment(id);
		if (completed !== void 0) return {
			outcome: "succeeded",
			deployment: completed,
			receiptId: completed.receiptId,
			activated: this.requireSlate(this.store, completed.slateId).activeDeploymentId?.equals(id) === true
		};
		const reservation = this.store.getDeploymentReservation(id);
		if (reservation === void 0) throw new AgentCoreError("operation.invalid-input", `Slate deployment ${id.value} is unknown`);
		const request = deploymentInvocationRequest(reservation);
		const result = await this.invocations.reconcile(request, reservation.invocationId, async (context) => this.provider.reconcileDeployment(deploymentProviderRequest(request, reservation.invocationId, context)));
		return this.finalizeDeployment(request, reservation.invocationId, result);
	}
	async materializeResource(deploymentId, name, source) {
		const deployment = this.requireDeployment(this.store, deploymentId);
		const request = freezeSlateInvocationRequest({
			operation: "resource.materialize",
			impact: "externalSend",
			workspaceId: deployment.workspaceId,
			slateId: deployment.slateId,
			resourceId: this.ids.allocateResourceId(),
			deploymentId: deployment.id,
			deploymentMaterialization: deployment.materialization,
			resourceName: name,
			resourceSource: source
		});
		const invocationId = await this.invocations.prepare(request);
		const reserve = freezeSlateMutationRequest({
			...request,
			operation: "resource.reserve",
			impact: "mutate",
			invocationId
		});
		await this.mutate(reserve, (store) => store.reserveResource(resourceReservation(reserve)));
		const result = await this.invocations.invoke(request, invocationId, async (context) => this.provider.materializeResource(resourceProviderRequest(request, invocationId, context)));
		return this.finalizeResource(request, invocationId, result);
	}
	async reconcileResource(id) {
		const completed = this.store.getResource(id);
		if (completed !== void 0) return {
			outcome: "succeeded",
			resource: completed,
			receiptId: completed.receiptId
		};
		const reservation = this.store.getResourceReservation(id);
		if (reservation === void 0) throw new AgentCoreError("operation.invalid-input", `Slate resource ${id.value} is unknown`);
		const request = resourceInvocationRequest(reservation);
		const result = await this.invocations.reconcile(request, reservation.invocationId, async (context) => this.provider.reconcileResource(resourceProviderRequest(request, reservation.invocationId, context)));
		return this.finalizeResource(request, reservation.invocationId, result);
	}
	async linkPreview(slateId, capability, exposureId, versionId) {
		const slate = this.requireSlate(this.store, slateId);
		const version = versionId === void 0 ? void 0 : this.requireVersion(this.store, versionId);
		if (version !== void 0 && !version.slateId.equals(slate.id)) throw new AgentCoreError("slate.invalid-version", "Slate preview version belongs to another Slate");
		const request = freezeSlateMutationRequest({
			operation: "preview.link",
			impact: "mutate",
			workspaceId: slate.workspaceId,
			slateId: slate.id,
			previewId: this.ids.allocatePreviewId(),
			source: version?.source ?? slate.source,
			versionId: version?.id,
			environmentId: capability.environmentId,
			sessionId: capability.sessionId,
			environmentRevision: capability.environmentRevision,
			sessionEpoch: capability.epoch,
			exposureId,
			expectedRevision: slate.revision
		});
		await this.previewValidation.validate(request);
		return this.mutate(request, (store) => {
			this.requireExpectedSlate(store, request.slateId, request.expectedRevision);
			const preview = previewFromIntent(request);
			store.addPreview(preview);
			return preview;
		});
	}
	async rollback(slateId, deploymentId, expectedActiveDeploymentId) {
		const current = this.requireSlate(this.store, slateId);
		const deployment = this.requireDeployment(this.store, deploymentId);
		if (!deployment.slateId.equals(slateId)) throw new AgentCoreError("operation.invalid-input", "Rollback deployment belongs to another Slate");
		const request = freezeSlateMutationRequest({
			operation: "rollback",
			impact: "mutate",
			workspaceId: current.workspaceId,
			slateId: current.id,
			deploymentId: deployment.id,
			expectedActiveDeploymentId: expectedActiveDeploymentId ?? current.activeDeploymentId,
			expectedRevision: current.revision
		});
		return this.mutate(request, (store) => {
			const latest = this.requireExpectedSlate(store, request.slateId, request.expectedRevision);
			if (!sameOptionalDeployment(latest.activeDeploymentId, request.expectedActiveDeploymentId)) throw revisionConflict(request.slateId);
			const next = latest.selectDeployment(request.deploymentId);
			if (!store.compareAndSetSlate(request.expectedRevision, next)) throw revisionConflict(request.slateId);
			return next;
		});
	}
	async finalizeDeployment(invocation, invocationId, result) {
		const outcome = canonicalInvocationResult(result, "deployment");
		if (outcome.outcome !== "succeeded") return {
			outcome: outcome.outcome,
			deploymentId: invocation.deploymentId,
			receiptId: outcome.receiptId
		};
		const request = freezeSlateMutationRequest({
			...invocation,
			operation: "deploy.finalize",
			impact: "mutate",
			invocationId,
			receiptId: outcome.receiptId,
			materialization: outcome.value.materialization
		});
		const activated = await this.mutate(request, (store) => {
			const deployment = deploymentFromIntent(request);
			store.addDeployment(deployment);
			const latest = this.requireSlate(store, request.slateId);
			if (!sameOptionalDeployment(latest.activeDeploymentId, request.expectedActiveDeploymentId)) return false;
			return store.compareAndSetSlate(latest.revision, latest.selectDeployment(request.deploymentId));
		});
		return {
			outcome: "succeeded",
			deployment: deploymentFromIntent(request),
			receiptId: request.receiptId,
			activated
		};
	}
	async finalizeResource(invocation, invocationId, result) {
		const outcome = canonicalInvocationResult(result, "resource");
		if (outcome.outcome !== "succeeded") return {
			outcome: outcome.outcome,
			resourceId: invocation.resourceId,
			receiptId: outcome.receiptId
		};
		const request = freezeSlateMutationRequest({
			...invocation,
			operation: "resource.finalize",
			impact: "mutate",
			invocationId,
			receiptId: outcome.receiptId,
			materialization: outcome.value.materialization
		});
		await this.mutate(request, (store) => store.addResource(resourceFromIntent(request)));
		return {
			outcome: "succeeded",
			resource: resourceFromIntent(request),
			receiptId: request.receiptId
		};
	}
	async mutate(request, mutation) {
		if (!Object.isFrozen(request)) throw new AgentCoreError("operation.invalid-input", "Slate mutation intent must be frozen");
		return this.mutations.mutate(request, () => this.store.transaction(mutation));
	}
	requireSlate(store, id) {
		const slate = store.getSlate(id);
		if (slate === void 0) throw new AgentCoreError("operation.invalid-input", `Slate ${id.value} is unknown`);
		return slate;
	}
	requireExpectedSlate(store, id, expected) {
		const slate = this.requireSlate(store, id);
		if (!slate.revision.equals(expected)) throw revisionConflict(id);
		return slate;
	}
	requireVersion(store, id) {
		const version = store.getVersion(id);
		if (version === void 0) throw new AgentCoreError("slate.invalid-version", `Slate version ${id.value} is unknown`);
		return version;
	}
	requirePublication(store, id) {
		const publication = store.getPublication(id);
		if (publication === void 0) throw new AgentCoreError("slate.unpublished", `Slate publication ${id.value} is unknown`);
		return publication;
	}
	requireDeployment(store, id) {
		const deployment = store.getDeployment(id);
		if (deployment === void 0) throw new AgentCoreError("operation.invalid-input", `Slate deployment ${id.value} is unknown`);
		return deployment;
	}
};
function deploymentReservation(request, externalKey) {
	let reservation = {
		externalKey,
		id: request.deploymentId,
		workspaceId: request.workspaceId,
		slateId: request.slateId,
		publicationId: request.publicationId,
		publicationMaterialization: request.publicationMaterialization,
		target: request.target,
		invocationId: request.invocationId
	};
	if (request.expectedActiveDeploymentId !== void 0) reservation = {
		...reservation,
		expectedActiveDeploymentId: request.expectedActiveDeploymentId
	};
	return new SlateDeploymentReservation(reservation);
}
function resourceReservation(request) {
	return new SlateResourceReservation({
		id: request.resourceId,
		workspaceId: request.workspaceId,
		slateId: request.slateId,
		deploymentId: request.deploymentId,
		deploymentMaterialization: request.deploymentMaterialization,
		name: request.resourceName,
		source: request.resourceSource,
		invocationId: request.invocationId
	});
}
function deploymentInvocationRequest(reservation) {
	return freezeSlateInvocationRequest({
		operation: "deploy",
		impact: "externalSend",
		workspaceId: reservation.workspaceId,
		slateId: reservation.slateId,
		deploymentId: reservation.id,
		publicationId: reservation.publicationId,
		publicationMaterialization: reservation.publicationMaterialization,
		target: reservation.target,
		expectedActiveDeploymentId: reservation.expectedActiveDeploymentId
	});
}
function resourceInvocationRequest(reservation) {
	return freezeSlateInvocationRequest({
		operation: "resource.materialize",
		impact: "externalSend",
		workspaceId: reservation.workspaceId,
		slateId: reservation.slateId,
		resourceId: reservation.id,
		deploymentId: reservation.deploymentId,
		deploymentMaterialization: reservation.deploymentMaterialization,
		resourceName: reservation.name,
		resourceSource: reservation.source
	});
}
function deploymentProviderRequest(request, invocationId, effectContext) {
	requireEffectContext(effectContext, invocationId);
	return Object.freeze({
		...request,
		invocationId,
		effectContext,
		idempotencyKey: effectContext.idempotencyKey
	});
}
function resourceProviderRequest(request, invocationId, effectContext) {
	requireEffectContext(effectContext, invocationId);
	return Object.freeze({
		...request,
		invocationId,
		effectContext,
		idempotencyKey: effectContext.idempotencyKey
	});
}
function deploymentFromIntent(request) {
	return new SlateDeployment(request.deploymentId, request.workspaceId, request.slateId, request.publicationId, request.target, request.materialization, request.invocationId, request.receiptId);
}
function resourceFromIntent(request) {
	return new SlateResource(request.resourceId, request.workspaceId, request.slateId, request.deploymentId, request.resourceName, request.resourceSource, request.materialization, request.invocationId, request.receiptId);
}
function previewFromIntent(request) {
	return new SlatePreview(request.previewId, request.workspaceId, request.slateId, new EnvironmentSessionCapability(request.environmentId, request.sessionId, request.environmentRevision, request.sessionEpoch), request.exposureId, request.source, request.versionId);
}
function requireEffectContext(context, invocationId) {
	if (!(context instanceof SlateEffectContext) || !Object.isFrozen(context) || !context.invocationId.equals(invocationId)) throw new AgentCoreError("invocation.invalid", "Slate effect context does not match its Invocation");
}
function canonicalInvocationResult(result, subject) {
	if (!isObjectRecord(result)) throw malformedInvocationResult();
	const keys = ownStringKeys(result);
	const outcomeSource = ownDataProperty(result, "outcome");
	const receiptSource = ownDataProperty(result, "receiptId");
	if (keys === void 0 || outcomeSource === void 0 || receiptSource === void 0) throw malformedInvocationResult();
	const outcome = outcomeSource.value;
	if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "indeterminate") throw malformedInvocationResult();
	let receiptId;
	try {
		if (!(receiptSource.value instanceof ReceiptId)) throw malformedInvocationResult();
		receiptId = new ReceiptId(receiptSource.value.value);
	} catch {
		throw malformedInvocationResult();
	}
	if (outcome !== "succeeded") {
		if (!hasExactKeys(keys, ["outcome", "receiptId"])) throw malformedInvocationResult();
		return Object.freeze({
			outcome,
			receiptId
		});
	}
	const valueSource = ownDataProperty(result, "value");
	if (valueSource === void 0 || !hasExactKeys(keys, [
		"outcome",
		"receiptId",
		"value"
	])) throw malformedInvocationResult();
	return Object.freeze({
		outcome,
		receiptId,
		value: canonicalProviderResult(valueSource, subject)
	});
}
function canonicalProviderResult(source, subject) {
	if (!isObjectRecord(source.value)) throw malformedProviderResult(subject);
	const keys = ownStringKeys(source.value);
	const materializationSource = ownDataProperty(source.value, "materialization");
	if (keys === void 0 || materializationSource === void 0 || !hasExactKeys(keys, ["materialization"])) throw malformedProviderResult(subject);
	try {
		if (!(materializationSource.value instanceof ContentRef)) throw malformedProviderResult(subject);
		return Object.freeze({ materialization: new ContentRef(materializationSource.value.value) });
	} catch {
		throw malformedProviderResult(subject);
	}
}
function ownStringKeys(value) {
	try {
		const keys = Reflect.ownKeys(value);
		return keys.every(isStringKey) ? keys : void 0;
	} catch {
		return;
	}
}
function ownDataProperty(value, key) {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return isSlateResultDataProperty(descriptor) ? descriptor : void 0;
	} catch {
		return;
	}
}
function isSlateResultDataProperty(value) {
	return isObjectRecord(value) && value["enumerable"] === true && Object.hasOwn(value, "value") && value["get"] === void 0 && value["set"] === void 0;
}
function isStringKey(value) {
	return typeof value === "string";
}
function hasExactKeys(actual, expected) {
	return actual.length === expected.length && expected.every((key) => actual.includes(key));
}
function malformedInvocationResult() {
	return new AgentCoreError("invocation.invalid", "Slate invocation result is malformed");
}
function malformedProviderResult(subject) {
	return new AgentCoreError("operation.invalid-output", `Slate provider ${subject} result is malformed`);
}
function isExternalKey(value) {
	return typeof value === "string";
}
function sameOptionalDeployment(left, right) {
	return left === void 0 ? right === void 0 : right !== void 0 && left.equals(right);
}
function sameOptionalVersion(left, right) {
	return left === void 0 ? right === void 0 : right !== void 0 && left.equals(right);
}
function revisionConflict(id) {
	return new AgentCoreError("protocol.revision-conflict", `Slate ${id.value} revision or active deployment changed`);
}
//#endregion
export { slateVersionContentRetention as C, SlateVersion as S, slateContentRetention as T, SlateDeployment as _, SlateDeploymentReservation as a, SlatePublication as b, canonicalSlateInvocationRequest as c, freezeSlateMutationRequest as d, sameSlateInvocationRequest as f, slateResourceContentRetention as g, SlateResource as h, MemorySlateStore as i, canonicalSlateMutationRequest as l, slatePreviewContentRetention as m, SlateIdSource as n, SlateResourceReservation as o, SlatePreview as p, SlateRuntime as r, SlateStore as s, MemorySlateIdSource as t, freezeSlateInvocationRequest as u, slateDeploymentContentRetention as v, Slate as w, slatePublicationContentRetention as x, SlateSkeleton as y };

//# sourceMappingURL=slates-BgbXLeOj.js.map