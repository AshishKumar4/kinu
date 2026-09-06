import { D as encodeCanonicalJson, E as decodeCanonicalJson, M as hasExactJsonKeys, P as isJsonObject, T as compareCanonicalText, _ as ContentRef, b as decodeBase64, d as CodecDeclaration, f as RecordCodec, g as Revision, i as SemVer, j as TextId, k as AgentCoreError, o as isMember, t as JsonSchema, v as contentRetentionFields, x as encodeBase64, y as Digest } from "./core-BjYGo1CC.js";
import { o as requireSynchronousResult } from "./actors-DJsP1nFM.js";
import { $ as OperationAvailability, F as PackagePin, G as OperationDescriptor, I as PackageId, V as PlacementIntersection, at as FacetPackageId, ct as OperationName, gt as canonicalFacetData, lt as OperationRef, nt as BindingName, ot as FacetRef, st as InterceptorId, z as PLACEMENT_PREFERENCE } from "./runtime-z1yMP0an.js";
import { a as ApprovalId, i as TurnId, l as ReceiptId, n as RunCommitId, r as RunId, s as EffectAttemptId } from "./facets-D01bKQBL.js";
import { C as PrincipalRef, P as PrincipalId, z as TenantId } from "./identity-CoqhjOFj.js";
import { s as EnvironmentId } from "./provider-DK9Ak8da.js";
import "./environments-CZCvxj-D.js";
import { i as InvocationId, o as RouteReservationId, r as EventId, t as AuditRecordId } from "./interaction-references-D9spp037.js";
import { _t as preferredPlacement } from "./definition-COokGikL.js";
import { P as AttemptReceipt } from "./invocations-Cpv8tzSW.js";
import { c as ContentStore, g as requireOperationTime, m as contentOwnerNamespace, p as contentOwnerKey, r as MemoryContentStore, u as ContentOwnerEdge } from "./content-DYlOXpyu.js";
//#region src/agents/id.ts
var AgentId = class extends TextId {
	constructor(value) {
		super(value, "Agent ID");
	}
};
var AgentProfileId = class extends TextId {
	constructor(value) {
		super(value, "Agent profile ID");
	}
};
var AgentPolicyId = class extends TextId {
	constructor(value) {
		super(value, "Agent policy ID");
	}
};
var ModelPolicyId = class extends TextId {
	constructor(value) {
		super(value, "Model policy ID");
	}
};
//#endregion
//#region src/agents/record-data.ts
var CodecRecord = class {
	static encode = function(value) {
		return this.codec.encode(value);
	};
	static decode = function(bytes) {
		return this.codec.decode(bytes);
	};
};
function requireObject(value, subject) {
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
	return value;
}
function requireExactFields(value, required, optional, subject) {
	const expected = /* @__PURE__ */ new Set([...required, ...optional]);
	const keys = Object.keys(value);
	if (required.some((key) => !(key in value)) || keys.some((key) => !expected.has(key))) throw new TypeError(`${subject} contains missing or unknown fields`);
}
function isString(value) {
	return typeof value === "string";
}
function isNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}
function requireString(value, subject) {
	if (!isString(value) || value.length === 0) throw new TypeError(`${subject} must be a non-empty string`);
	return value;
}
function requireOptionalString(value, subject) {
	return value === void 0 || value === null ? void 0 : requireString(value, subject);
}
function requireInteger(value, subject) {
	if (!isNumber(value) || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${subject} must be a non-negative safe integer`);
	return value;
}
function requireTimestamp(value, subject) {
	const timestamp = requireInteger(value, subject);
	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime())) throw new TypeError(`${subject} must be a valid timestamp`);
	return date;
}
function requireArray(value, subject) {
	if (!isArray(value)) throw new TypeError(`${subject} must be an array`);
	return value;
}
function isArray(value) {
	return Array.isArray(value);
}
function revisionData(revision) {
	return revision.value;
}
function revisionFromData(value, subject) {
	return new Revision(requireInteger(value, subject));
}
function digestFromData(value, subject) {
	return new Digest(requireString(value, subject));
}
function bytesEqual(left, right) {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
//#endregion
//#region src/agents/source.ts
var RevisionRecord = class extends CodecRecord {
	id;
	revision;
	content;
	digest;
	constructor(fields) {
		super();
		this.id = fields.id;
		this.revision = fields.revision;
		this.content = fields.content;
		this.digest = fields.digest;
	}
	baseData(id) {
		return {
			content: this.content.value,
			digest: this.digest.value,
			id,
			revision: revisionData(this.revision)
		};
	}
};
var AgentRevisionRecord = class AgentRevisionRecord extends RevisionRecord {
	static get codec() {
		return AgentRevisionRecordCodec;
	}
	profile;
	policy;
	model;
	environment;
	constructor(init) {
		super(init);
		this.profile = init.profile;
		this.policy = init.policy;
		this.model = init.model;
		this.environment = init.environment;
		Object.freeze(this);
	}
	toData() {
		return {
			...this.baseData(this.id.value),
			environment: this.environment.value,
			model: this.model.value,
			policy: this.policy.value,
			profile: this.profile.value
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Agent revision");
		requireExactFields(object, [
			"content",
			"digest",
			"environment",
			"id",
			"model",
			"policy",
			"profile",
			"revision"
		], [], "Agent revision");
		return new AgentRevisionRecord({
			id: new AgentId(requireString(object["id"], "Agent revision ID")),
			revision: revisionFromData(object["revision"], "Agent revision"),
			content: new ContentRef(requireString(object["content"], "Agent revision content")),
			digest: digestFromData(object["digest"], "Agent revision digest"),
			profile: new AgentProfileId(requireString(object["profile"], "Agent profile")),
			policy: new AgentPolicyId(requireString(object["policy"], "Agent policy")),
			model: new ModelPolicyId(requireString(object["model"], "Model policy")),
			environment: new EnvironmentId(requireString(object["environment"], "Environment source"))
		});
	}
};
var AgentPolicyRevisionRecord = class AgentPolicyRevisionRecord extends RevisionRecord {
	static get codec() {
		return AgentPolicyRevisionRecordCodec;
	}
	constructor(init) {
		super(init);
		Object.freeze(this);
	}
	toData() {
		return this.baseData(this.id.value);
	}
	static fromData(value) {
		return new AgentPolicyRevisionRecord(policyFields(value));
	}
};
var ModelPolicyRevisionRecord = class ModelPolicyRevisionRecord extends RevisionRecord {
	static get codec() {
		return ModelPolicyRevisionRecordCodec;
	}
	constructor(init) {
		super(init);
		Object.freeze(this);
	}
	toData() {
		return this.baseData(this.id.value);
	}
	static fromData(value) {
		const fields = sourceFields(value, "Model policy revision");
		return new ModelPolicyRevisionRecord({
			...fields,
			id: new ModelPolicyId(fields.id)
		});
	}
};
var SourceCodec = class extends RecordCodec {
	#decodeValue;
	constructor(recordClasses, kind, decodeValue) {
		super(recordClasses, kind, {
			major: 1,
			minor: 0
		});
		this.#decodeValue = decodeValue.bind(void 0);
		Object.freeze(this);
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return this.#decodeValue(value);
	}
};
var AgentRevisionRecordCodec = new SourceCodec([
	AgentRevisionRecord,
	RevisionRecord,
	ContentRef,
	Digest,
	Revision,
	TextId,
	AgentId,
	ModelPolicyId,
	EnvironmentId,
	AgentPolicyId,
	AgentProfileId,
	CodecRecord
], "agent.revision", AgentRevisionRecord.fromData);
var AgentPolicyRevisionRecordCodec = new SourceCodec([
	AgentPolicyRevisionRecord,
	RevisionRecord,
	ContentRef,
	Digest,
	Revision,
	TextId,
	AgentPolicyId,
	CodecRecord
], "agent.policy-revision", AgentPolicyRevisionRecord.fromData);
var ModelPolicyRevisionRecordCodec = new SourceCodec([
	ModelPolicyRevisionRecord,
	RevisionRecord,
	ContentRef,
	Digest,
	Revision,
	TextId,
	ModelPolicyId,
	CodecRecord
], "agent.model-revision", ModelPolicyRevisionRecord.fromData);
var RunSourceRevisionPort = class {};
function sourceFields(value, subject) {
	const object = requireObject(value, subject);
	requireExactFields(object, [
		"content",
		"digest",
		"id",
		"revision"
	], [], subject);
	return {
		id: requireString(object["id"], `${subject} ID`),
		revision: revisionFromData(object["revision"], subject),
		content: new ContentRef(requireString(object["content"], `${subject} content`)),
		digest: digestFromData(object["digest"], `${subject} digest`)
	};
}
function policyFields(value) {
	const fields = sourceFields(value, "Agent policy revision");
	return {
		...fields,
		id: new AgentPolicyId(fields.id)
	};
}
//#endregion
//#region src/agents/runs/id.ts
var AcceptanceId = class extends TextId {
	constructor(value) {
		super(value, "Acceptance ID");
	}
};
var RunBranchId = class extends TextId {
	constructor(value) {
		super(value, "Run branch ID");
	}
};
var RunCheckpointId = class extends TextId {
	constructor(value) {
		super(value, "Run checkpoint ID");
	}
};
var TurnInboxEntryId = class extends TextId {
	constructor(value) {
		super(value, "Turn inbox entry ID");
	}
};
var SpawnReservationId = class extends TextId {
	constructor(value) {
		super(value, "Spawn reservation ID");
	}
};
//#endregion
//#region src/agents/runs/acceptance.ts
var AcceptanceCriterion = class AcceptanceCriterion extends CodecRecord {
	static get codec() {
		return AcceptanceCriterionCodec;
	}
	id;
	operation;
	constructor(init) {
		super();
		if (init.id.constructor !== AcceptanceId || init.operation.constructor !== OperationRef) throw new TypeError("Acceptance criterion identifiers must use exact context classes");
		this.id = init.id;
		this.operation = init.operation;
		Object.freeze(this);
	}
	toData() {
		return {
			id: this.id.value,
			operation: this.operation.value
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Acceptance criterion");
		requireExactFields(object, ["id", "operation"], [], "Acceptance criterion");
		return new AcceptanceCriterion({
			id: new AcceptanceId(requireString(object["id"], "Acceptance criterion ID")),
			operation: new OperationRef(requireString(object["operation"], "Acceptance criterion Operation"))
		});
	}
};
var AcceptanceCriterionRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			AcceptanceCriterion,
			TextId,
			OperationRef,
			AcceptanceId,
			FacetPackageId,
			CodecRecord,
			OperationName
		], "run.acceptance-criterion", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return AcceptanceCriterion.fromData(value);
	}
};
var AcceptanceCriterionCodec = new AcceptanceCriterionRecordCodec();
var AcceptanceVerdict = class AcceptanceVerdict extends CodecRecord {
	static get codec() {
		return AcceptanceVerdictCodec;
	}
	acceptance;
	subject;
	receipt;
	constructor(init) {
		super();
		if (init.acceptance.constructor !== AcceptanceId || init.subject.constructor !== Digest || init.receipt.constructor !== ReceiptId) throw new TypeError("Acceptance verdict identifiers must use exact context classes");
		this.acceptance = init.acceptance;
		this.subject = init.subject;
		this.receipt = init.receipt;
		Object.freeze(this);
	}
	toData() {
		return {
			acceptance: this.acceptance.value,
			receipt: this.receipt.value,
			subject: this.subject.value
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Acceptance verdict");
		requireExactFields(object, [
			"acceptance",
			"receipt",
			"subject"
		], [], "Acceptance verdict");
		return new AcceptanceVerdict({
			acceptance: new AcceptanceId(requireString(object["acceptance"], "Acceptance verdict criterion")),
			subject: digestFromData(object["subject"], "Acceptance verdict subject"),
			receipt: new ReceiptId(requireString(object["receipt"], "Acceptance verdict Receipt"))
		});
	}
};
var AcceptanceVerdictRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			AcceptanceVerdict,
			TextId,
			Digest,
			AcceptanceId,
			ReceiptId,
			CodecRecord
		], "run.acceptance-verdict", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return AcceptanceVerdict.fromData(value);
	}
};
var AcceptanceVerdictCodec = new AcceptanceVerdictRecordCodec();
//#endregion
//#region src/agents/runs/admission.ts
var RunAdmissionRegistry = class RunAdmissionRegistry extends CodecRecord {
	static get codec() {
		return RunAdmissionRegistryCodec;
	}
	run;
	epoch;
	open;
	reserved;
	completed;
	constructor(init) {
		super();
		if (init.run.constructor !== RunId) throw new TypeError("Run admission registry requires an exact Run ID");
		requireEpoch(init.epoch, "Run admission registry epoch");
		if (init.open !== true && init.open !== false) throw new TypeError("Run admission registry open state is invalid");
		if (!init.open && init.epoch === 0) throw new TypeError("Closed Run admission registry must have an advanced epoch");
		const reserved = canonicalObligations(init.reserved, "Reserved Run obligation");
		const reservedByKey = new Map(reserved.map((value) => [runObligationKey(value), value]));
		const completed = canonicalObligations(init.completed, "Completed Run obligation").map((value) => {
			const canonical = reservedByKey.get(runObligationKey(value));
			if (canonical === void 0) throw new TypeError("Completed Run obligations must be reserved");
			return canonical;
		});
		this.run = init.run;
		this.epoch = init.epoch;
		this.open = init.open;
		this.reserved = reserved;
		this.completed = Object.freeze(completed);
		Object.freeze(this);
	}
	static initial(run) {
		return new RunAdmissionRegistry({
			run,
			epoch: 0,
			open: true,
			reserved: [],
			completed: []
		});
	}
	reserve(obligation) {
		if (!this.open) throw invalid("Run admission registry is closed");
		const candidate = copyRunObligation(obligation);
		const key = runObligationKey(candidate);
		const existing = this.reserved.find((value) => runObligationKey(value) === key);
		const registry = existing === void 0 ? new RunAdmissionRegistry({
			run: this.run,
			epoch: this.epoch,
			open: true,
			reserved: [...this.reserved, candidate],
			completed: this.completed
		}) : this;
		return Object.freeze({
			registry,
			reservation: Object.freeze({
				run: this.run,
				registryEpoch: this.epoch,
				obligation: existing ?? candidate
			})
		});
	}
	accepts(reservation) {
		if (!this.open || !this.run.equals(reservation.run) || this.epoch !== reservation.registryEpoch) return false;
		try {
			const key = runObligationKey(reservation.obligation);
			return this.reserved.some((value) => runObligationKey(value) === key);
		} catch (error) {
			if (error instanceof InvalidRunObligation) return false;
			throw error;
		}
	}
	reservation(obligation) {
		const key = runObligationKey(obligation);
		const reserved = this.reserved.find((value) => runObligationKey(value) === key);
		if (reserved === void 0) return void 0;
		return Object.freeze({
			run: this.run,
			registryEpoch: this.open ? this.epoch : this.epoch - 1,
			obligation: reserved
		});
	}
	complete(reservation) {
		const key = this.completionKey(reservation);
		if (key === void 0) throw invalid("Only an exact reserved Run obligation can complete");
		if (this.completed.some((value) => runObligationKey(value) === key)) return this;
		const obligation = this.reserved.find((value) => runObligationKey(value) === key);
		return new RunAdmissionRegistry({
			run: this.run,
			epoch: this.epoch,
			open: this.open,
			reserved: this.reserved,
			completed: [...this.completed, obligation]
		});
	}
	close() {
		if (!this.open) return this;
		if (this.epoch === Number.MAX_SAFE_INTEGER) throw invalid("Run admission registry epoch is exhausted");
		return new RunAdmissionRegistry({
			run: this.run,
			epoch: this.epoch + 1,
			open: false,
			reserved: this.reserved,
			completed: this.completed
		});
	}
	frontier() {
		const completed = new Set(this.completed.map(runObligationKey));
		return Object.freeze(this.reserved.filter((value) => !completed.has(runObligationKey(value))).map(copyRunObligation));
	}
	toData() {
		return {
			completed: this.completed.map(runObligationData),
			epoch: this.epoch,
			open: this.open,
			reserved: this.reserved.map(runObligationData),
			run: this.run.value
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Run admission registry");
		requireExactFields(object, [
			"completed",
			"epoch",
			"open",
			"reserved",
			"run"
		], [], "Run admission registry");
		const open = object["open"];
		if (open !== true && open !== false) throw new TypeError("Run admission registry open state is invalid");
		return new RunAdmissionRegistry({
			run: new RunId(requireString(object["run"], "Run admission registry Run")),
			epoch: requireInteger(object["epoch"], "Run admission registry epoch"),
			open,
			reserved: requireArray(object["reserved"], "Reserved Run obligations").map(decodeRunObligation),
			completed: requireArray(object["completed"], "Completed Run obligations").map(decodeRunObligation)
		});
	}
	completionKey(reservation) {
		const reservationEpoch = this.open ? this.epoch : this.epoch - 1;
		if (!this.run.equals(reservation.run) || reservation.registryEpoch !== reservationEpoch) return;
		try {
			const key = runObligationKey(reservation.obligation);
			return this.reserved.some((value) => runObligationKey(value) === key) ? key : void 0;
		} catch (error) {
			if (error instanceof InvalidRunObligation) return void 0;
			throw error;
		}
	}
};
/**
* Major 2 spells the open-state key SPEC §5.6's way. A major-1 payload holds the same
* boolean under `accepting`, so nothing is lost — but this decoder is exact by construction
* (§8.3), and admitting two spellings of one field is a shim that would outlive the rename.
* So the old major earns the typed rejection `assertCompatibleRecordVersion` already gives
* it, and MIGRATE-RUN-ADMISSION-OPEN owns the rewrite.
*/
var RunAdmissionRegistryRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			RunAdmissionRegistry,
			TextId,
			RunId,
			CodecRecord,
			ApprovalId,
			InvocationId,
			AcceptanceId,
			RouteReservationId,
			RunCommitId,
			EffectAttemptId
		], "run.admission-registry", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return RunAdmissionRegistry.fromData(value);
	}
};
var RunAdmissionRegistryCodec = new RunAdmissionRegistryRecordCodec();
var RunAdmissionValidationPort = class {};
function runObligationKey(obligation) {
	const data = runObligationData(copyRunObligation(obligation));
	return JSON.stringify(data);
}
function copyRunObligation(obligation) {
	switch (obligation.kind) {
		case "approval":
			if (obligation.approval.constructor !== ApprovalId) requireExactIdentity("Approval");
			return Object.freeze({
				kind: obligation.kind,
				approval: obligation.approval
			});
		case "invocationItem":
			if (obligation.invocation.constructor !== InvocationId) requireExactIdentity("Invocation");
			requireObligationEpoch(obligation.itemIndex, "Run invocation item index");
			if (obligation.itemKey.length === 0) throw new InvalidRunObligation("Run invocation item key must be non-empty");
			return Object.freeze({
				kind: obligation.kind,
				invocation: obligation.invocation,
				itemIndex: obligation.itemIndex,
				itemKey: obligation.itemKey
			});
		case "route":
			if (obligation.reservation.constructor !== RouteReservationId) requireExactIdentity("Route reservation");
			return Object.freeze({
				kind: obligation.kind,
				reservation: obligation.reservation
			});
		case "reconciliation":
			if (obligation.attempt.constructor !== EffectAttemptId) requireExactIdentity("Effect attempt");
			return Object.freeze({
				kind: obligation.kind,
				attempt: obligation.attempt
			});
		case "systemCommit":
			if (obligation.commit.constructor !== RunCommitId) requireExactIdentity("Run commit");
			return Object.freeze({
				kind: obligation.kind,
				commit: obligation.commit
			});
		case "acceptance":
			if (obligation.acceptance.constructor !== AcceptanceId) requireExactIdentity("Acceptance");
			return Object.freeze({
				kind: obligation.kind,
				acceptance: obligation.acceptance
			});
		default: throw new InvalidRunObligation("Run obligation kind is invalid");
	}
}
function runObligationData(obligation) {
	switch (obligation.kind) {
		case "approval": return {
			approval: obligation.approval.value,
			kind: obligation.kind
		};
		case "invocationItem": return {
			invocation: obligation.invocation.value,
			itemIndex: obligation.itemIndex,
			itemKey: obligation.itemKey,
			kind: obligation.kind
		};
		case "route": return {
			kind: obligation.kind,
			reservation: obligation.reservation.value
		};
		case "reconciliation": return {
			attempt: obligation.attempt.value,
			kind: obligation.kind
		};
		case "systemCommit": return {
			commit: obligation.commit.value,
			kind: obligation.kind
		};
		case "acceptance": return {
			acceptance: obligation.acceptance.value,
			kind: obligation.kind
		};
	}
}
function decodeRunObligation(value) {
	const object = requireObject(value, "Run obligation");
	const kind = requireString(object["kind"], "Run obligation kind");
	switch (kind) {
		case "approval":
			requireExactFields(object, ["approval", "kind"], [], "Approval obligation");
			return copyRunObligation({
				kind,
				approval: new ApprovalId(requireString(object["approval"], "Approval obligation"))
			});
		case "invocationItem":
			requireExactFields(object, [
				"invocation",
				"itemIndex",
				"itemKey",
				"kind"
			], [], "Invocation item obligation");
			return copyRunObligation({
				kind,
				invocation: new InvocationId(requireString(object["invocation"], "Invocation item obligation")),
				itemIndex: requireInteger(object["itemIndex"], "Invocation item obligation index"),
				itemKey: requireString(object["itemKey"], "Invocation item obligation key")
			});
		case "route":
			requireExactFields(object, ["kind", "reservation"], [], "Route obligation");
			return copyRunObligation({
				kind,
				reservation: new RouteReservationId(requireString(object["reservation"], "Route obligation"))
			});
		case "reconciliation":
			requireExactFields(object, ["attempt", "kind"], [], "Reconciliation obligation");
			return copyRunObligation({
				kind,
				attempt: new EffectAttemptId(requireString(object["attempt"], "Reconciliation obligation"))
			});
		case "systemCommit":
			requireExactFields(object, ["commit", "kind"], [], "System commit obligation");
			return copyRunObligation({
				kind,
				commit: new RunCommitId(requireString(object["commit"], "System commit obligation"))
			});
		case "acceptance":
			requireExactFields(object, ["acceptance", "kind"], [], "Acceptance obligation");
			return copyRunObligation({
				kind,
				acceptance: new AcceptanceId(requireString(object["acceptance"], "Acceptance obligation"))
			});
		default: throw new TypeError("Run obligation kind is invalid");
	}
}
function canonicalObligations(values, subject) {
	if (!Array.isArray(values)) throw new TypeError(`${subject}s must be an array`);
	const result = values.map(copyRunObligation).sort((left, right) => compareCanonicalText(runObligationKey(left), runObligationKey(right)));
	if (new Set(result.map(runObligationKey)).size !== result.length) throw new TypeError(`${subject}s must have unique canonical identities`);
	return Object.freeze(result);
}
/**
* The refusal `copyRunObligation` raises when an obligation's own shape is what fails.
*
* Two registry queries answer "not reserved" for an obligation the SPEC's vocabulary does
* not describe, and they used to reach that answer by catching every `TypeError` the key
* derivation could raise. That swept up an open class: a bug reading an identity, a future
* refusal added under the derivation, any `TypeError` at all became an ordinary registry
* miss. Naming the shape refusal separates the two — a shape violation is still a
* `TypeError` carrying the same message, so nothing observable about a malformed obligation
* changes, while a failure that is not about the obligation's shape now leaves the query
* instead of being answered by it.
*/
var InvalidRunObligation = class extends TypeError {};
function requireEpoch(value, subject) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${subject} must be a non-negative safe integer`);
}
function requireObligationEpoch(value, subject) {
	if (!Number.isSafeInteger(value) || value < 0) throw new InvalidRunObligation(`${subject} must be a non-negative safe integer`);
}
function requireExactIdentity(subject) {
	throw new InvalidRunObligation(`${subject} obligation requires an exact canonical ID`);
}
function invalid(message) {
	return new AgentCoreError("run.invalid-state", message);
}
//#endregion
//#region src/agents/runs/ceiling.ts
var RESOURCE_DIMENSIONS = Object.freeze([
	"costMicros",
	"depth",
	"tokens",
	"wallClockMs"
]);
function requireResourceDimension(value, subject) {
	if (isMember(RESOURCE_DIMENSIONS, value)) return value;
	throw new TypeError(`${subject} is not a declared resource dimension`);
}
var ResourceCeiling = class ResourceCeiling {
	#limits;
	constructor(limits) {
		const declared = {};
		for (const dimension of RESOURCE_DIMENSIONS) {
			const limit = limits[dimension];
			if (limit === void 0) continue;
			if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError(`Resource ceiling ${dimension} must be a non-negative safe integer`);
			declared[dimension] = limit;
		}
		if (Object.keys(declared).length === 0) throw new TypeError("Resource ceiling must declare at least one dimension");
		this.#limits = Object.freeze(declared);
		Object.freeze(this);
	}
	get entries() {
		return RESOURCE_DIMENSIONS.flatMap((dimension) => {
			const limit = this.#limits[dimension];
			return limit === void 0 ? [] : [[dimension, limit]];
		});
	}
	get declared() {
		return this.entries.map(([dimension]) => dimension);
	}
	limit(dimension) {
		return this.#limits[dimension];
	}
	equals(other) {
		return RESOURCE_DIMENSIONS.every((dimension) => this.limit(dimension) === other.limit(dimension));
	}
	toData() {
		const data = {};
		for (const [dimension, limit] of this.entries) data[dimension] = limit;
		return data;
	}
	static fromData(value) {
		const object = requireObject(value, "Resource ceiling");
		requireExactFields(object, [], [...RESOURCE_DIMENSIONS], "Resource ceiling");
		const limits = {};
		for (const dimension of RESOURCE_DIMENSIONS) {
			if (object[dimension] === void 0) continue;
			limits[dimension] = requireInteger(object[dimension], `Resource ceiling ${dimension}`);
		}
		return new ResourceCeiling(limits);
	}
};
function spent(usage, dimension, inherited) {
	return dimension === "depth" ? inherited ? 1 : 0 : usage[dimension];
}
function narrow(remaining, ceiling, usage, inherited) {
	for (const [dimension, limit] of ceiling?.entries ?? []) {
		const left = Math.max(0, limit - spent(usage, dimension, inherited));
		const current = remaining[dimension];
		if (current === void 0 || left < current) remaining[dimension] = left;
	}
}
function narrowResources(parentRemainder, declared, usage) {
	const remaining = {};
	narrow(remaining, declared, usage, false);
	narrow(remaining, parentRemainder, usage, true);
	return Object.keys(remaining).length === 0 ? void 0 : new ResourceCeiling(remaining);
}
function widensResourceCeiling(parentRemainder, child) {
	if (parentRemainder === void 0) return false;
	return child.entries.some(([dimension, limit]) => {
		const allowance = parentRemainder.limit(dimension);
		return allowance !== void 0 && limit > allowance;
	});
}
function exhaustedResource(remainder) {
	return remainder?.declared.find((dimension) => remainder.limit(dimension) === 0);
}
var SpawnAttenuation = class SpawnAttenuation extends CodecRecord {
	static get codec() {
		return SpawnAttenuationCodec;
	}
	ceiling;
	constructor(init = {}) {
		super();
		if (init.ceiling !== void 0 && init.ceiling.constructor !== ResourceCeiling) throw new TypeError("Spawn attenuation ceiling must use the exact context class");
		this.ceiling = init.ceiling;
		Object.freeze(this);
	}
	toData() {
		return { ceiling: this.ceiling === void 0 ? null : this.ceiling.toData() };
	}
	static fromData(value) {
		const object = requireObject(value, "Spawn attenuation");
		requireExactFields(object, ["ceiling"], [], "Spawn attenuation");
		const ceiling = object["ceiling"];
		return new SpawnAttenuation(ceiling === null ? {} : { ceiling: ResourceCeiling.fromData(ceiling) });
	}
};
var SpawnAttenuationRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			SpawnAttenuation,
			ResourceCeiling,
			CodecRecord
		], "run.spawn-attenuation", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return SpawnAttenuation.fromData(value);
	}
};
var SpawnAttenuationCodec = new SpawnAttenuationRecordCodec();
//#endregion
//#region src/agents/runs/cost.ts
/**
* The currency one Run lineage records every realized cost in (SPEC §5.2). The rate source
* is out of scope, so this platform compares codes for equality and never interprets them.
* The code is opaque text for that reason, and identity is by type and value like every
* other `TextId`.
*/
var Currency = class extends TextId {
	constructor(value) {
		super(value, "Currency");
	}
};
/**
* One model call's realized cost, as the call incurred it (SPEC §5.2). `micros` is integer
* millionths of the currency's major unit.
*
* There is no estimated form of this value, and that absence is the rule rather than an
* omission: a host with no realized cost to record declares the `costMicros` dimension
* nowhere, so a host that has nothing to report has nothing to build here either. The value
* travels from the executor seam to the Run's running total unchanged, so a rate table can
* produce the number a host reports but can never stand in for a cost the call incurred.
*/
var RealizedCost = class RealizedCost {
	micros;
	currency;
	constructor(micros, currency) {
		if (!Number.isSafeInteger(micros) || micros < 0) throw new TypeError("Realized cost must be a non-negative safe integer of micros");
		if (!(currency instanceof Currency)) throw new TypeError("Realized cost must name its currency");
		this.micros = micros;
		this.currency = currency;
		Object.freeze(this);
	}
	equals(other) {
		return this.micros === other.micros && this.currency.equals(other.currency);
	}
	toData() {
		return {
			currency: this.currency.value,
			micros: this.micros
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Realized cost");
		requireExactFields(object, ["currency", "micros"], [], "Realized cost");
		return new RealizedCost(requireInteger(object["micros"], "Realized cost micros"), new Currency(requireString(object["currency"], "Realized cost currency")));
	}
};
//#endregion
//#region src/agents/runs/lease.ts
function leaseTokensEqual(left, right) {
	return left.turn.equals(right.turn) && left.holder.equals(right.holder) && left.epoch === right.epoch;
}
var TurnLeaseCodec = class extends RecordCodec {
	constructor() {
		super([
			TurnLease,
			TextId,
			TenantId,
			TurnId,
			PrincipalId,
			ExactTurnLease,
			PrincipalRef
		], "turn-lease", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(lease) {
		return TurnLease.toData(lease);
	}
	decodePayload(payload) {
		return TurnLease.fromData(payload);
	}
};
var TurnLease = class TurnLease {
	turn;
	holder;
	epoch;
	static get codec() {
		return turnLeaseCodecInstance;
	}
	#expiresAtTime;
	constructor(turn, holder, epoch, expiresAt) {
		this.turn = turn;
		this.holder = holder;
		this.epoch = epoch;
		if (!Number.isSafeInteger(epoch) || epoch < 0) throw new TypeError("Turn lease epoch must be a non-negative safe integer");
		if (expiresAt !== void 0 && !Number.isFinite(expiresAt.getTime())) throw new TypeError("Turn lease expiration must be a valid Date");
		if (holder !== void 0 && expiresAt === void 0) throw new TypeError("Held Turn leases require an expiration");
		if (holder !== void 0 && !(holder instanceof PrincipalRef)) throw new TypeError("Turn lease holder must be a tenant-qualified PrincipalRef");
		this.#expiresAtTime = expiresAt?.getTime();
		Object.freeze(this);
	}
	get expiresAt() {
		return this.#expiresAtTime === void 0 ? void 0 : new Date(this.#expiresAtTime);
	}
	get expiresAtTime() {
		return this.#expiresAtTime;
	}
	static encode(lease) {
		return TurnLease.codec.encode(lease);
	}
	static decode(bytes) {
		return TurnLease.codec.decode(bytes);
	}
	static restore(turn, holder, epoch, expiresAt) {
		return new ExactTurnLease(turn, holder, epoch, expiresAt);
	}
	static unclaimed(turn) {
		return new ExactTurnLease(turn, void 0, 0, void 0);
	}
	static toData(lease) {
		return {
			turn: lease.turn.value,
			holder: lease.holder === void 0 ? null : principalRefToData(lease.holder),
			epoch: lease.epoch,
			expiresAt: lease.expiresAt?.getTime() ?? null
		};
	}
	static fromData(payload) {
		if (!isTurnLeasePayload(payload)) throw new AgentCoreError("codec.invalid", "Turn lease payload is malformed");
		return TurnLease.restore(new TurnId(payload.turn), payload.holder === null ? void 0 : principalRefFromData(payload.holder), payload.epoch, payload.expiresAt === null ? void 0 : new Date(payload.expiresAt));
	}
};
var ExactTurnLease = class ExactTurnLease extends TurnLease {
	constructor(turn, holder, epoch, expiresAt) {
		super(turn, holder, epoch, expiresAt);
	}
	admits(token, now) {
		const expiresAtTime = this.expiresAtTime;
		return token.turn instanceof TurnId && token.holder instanceof PrincipalRef && this.turn.equals(token.turn) && this.holder !== void 0 && this.holder.equals(token.holder) && this.epoch === token.epoch && expiresAtTime !== void 0 && expiresAtTime > now.getTime();
	}
	claim(holder, now, expiresAt) {
		ensureFutureExpiration(expiresAt, now);
		if (this.holder !== void 0) throw new AgentCoreError("lease.invalid", "Turn lease claim requires an unheld lease");
		return new ExactTurnLease(this.turn, holder, nextEpoch(this.epoch), expiresAt);
	}
	renew(holder, epoch, now, expiresAt) {
		ensureFutureExpiration(expiresAt, now);
		const currentExpiresAtTime = this.expiresAtTime;
		const currentToken = {
			turn: this.turn,
			holder,
			epoch
		};
		if (!this.admits(currentToken, now) || currentExpiresAtTime === void 0) throw new AgentCoreError("lease.invalid", "Turn lease renewal requires the exact current token");
		if (expiresAt.getTime() <= currentExpiresAtTime) throw new AgentCoreError("lease.invalid", "Turn lease renewal requires a later expiration");
		return new ExactTurnLease(this.turn, this.holder, this.epoch, expiresAt);
	}
	reclaim(holder, now, expiresAt) {
		ensureFutureExpiration(expiresAt, now);
		const expiresAtTime = this.expiresAtTime;
		if (this.holder === void 0 || expiresAtTime === void 0 || expiresAtTime > now.getTime()) throw new AgentCoreError("lease.invalid", "Turn lease reclaim requires an expired held lease");
		return new ExactTurnLease(this.turn, holder, nextEpoch(this.epoch), expiresAt);
	}
	fence() {
		return new ExactTurnLease(this.turn, void 0, nextEpoch(this.epoch), this.expiresAt);
	}
};
var turnLeaseCodecInstance = new TurnLeaseCodec();
function isTurnLeasePayload(payload) {
	if (!isJsonObject(payload)) return false;
	const holder = payload["holder"];
	const epoch = payload["epoch"];
	const expiresAt = payload["expiresAt"];
	return hasExactJsonKeys(payload, [
		"epoch",
		"expiresAt",
		"holder",
		"turn"
	]) && isString(payload["turn"]) && (holder === null || holder !== void 0 && isPrincipalRefData(holder)) && isNumber(epoch) && Number.isSafeInteger(epoch) && epoch >= 0 && (expiresAt === null || isNumber(expiresAt));
}
function leaseTokenToData(token) {
	if (!(token.turn instanceof TurnId) || !(token.holder instanceof PrincipalRef) || !Number.isSafeInteger(token.epoch) || token.epoch < 0) throw new AgentCoreError("codec.invalid", "Lease token is malformed");
	return {
		epoch: token.epoch,
		holder: principalRefToData(token.holder),
		turn: token.turn.value
	};
}
function leaseTokenFromData(value, name = "Lease token") {
	if (!isJsonObject(value)) throw new AgentCoreError("codec.invalid", `${name} must be an object`);
	if (!hasExactJsonKeys(value, [
		"epoch",
		"holder",
		"turn"
	])) throw new AgentCoreError("codec.invalid", `${name} fields are invalid`);
	const turn = value["turn"];
	const epoch = value["epoch"];
	if (!isString(turn) || !isNumber(epoch) || !Number.isSafeInteger(epoch) || epoch < 0) throw new AgentCoreError("codec.invalid", `${name} is malformed`);
	return Object.freeze({
		turn: new TurnId(turn),
		holder: principalRefFromData(value["holder"]),
		epoch
	});
}
function principalRefToData(holder) {
	return {
		principal: holder.principalId.value,
		tenant: holder.tenantId.value
	};
}
function principalRefFromData(value) {
	if (!isPrincipalRefData(value)) throw new AgentCoreError("codec.invalid", "Lease holder is malformed");
	return new PrincipalRef(new TenantId(value.tenant), new PrincipalId(value.principal));
}
function isPrincipalRefData(value) {
	return isJsonObject(value) && hasExactJsonKeys(value, ["principal", "tenant"]) && isString(value["principal"]) && isString(value["tenant"]);
}
function ensureFutureExpiration(expiresAt, now) {
	if (!Number.isFinite(expiresAt.getTime()) || !Number.isFinite(now.getTime())) throw new AgentCoreError("lease.invalid", "Turn lease times must be valid Dates");
	if (expiresAt.getTime() <= now.getTime()) throw new AgentCoreError("lease.invalid", "Turn lease expiration must be after the lease time");
}
function nextEpoch(epoch) {
	if (epoch === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("lease.invalid", "Turn lease epoch is exhausted");
	return epoch + 1;
}
//#endregion
//#region src/agents/runs/lease-verifier.ts
var MemoryTurnLeaseVerifier = class {
	now;
	#leases = /* @__PURE__ */ new Map();
	constructor(leases = [], now = () => /* @__PURE__ */ new Date()) {
		this.now = now;
		for (const lease of leases) this.save(lease);
	}
	save(lease) {
		this.#leases.set(lease.turn.value, TurnLease.decode(TurnLease.encode(lease)));
	}
	permits(token) {
		return this.#leases.get(token.turn.value)?.admits(token, this.now()) === true;
	}
};
var RepositoryTurnLeaseVerifier = class {
	repository;
	now;
	constructor(repository, now = () => /* @__PURE__ */ new Date()) {
		this.repository = repository;
		this.now = now;
	}
	permits(token) {
		return this.repository.transaction((transaction) => this.repository.loadTurn(transaction, token.turn)?.lease.admits(token, this.now()) === true);
	}
};
//#endregion
//#region src/agents/runs/pins.ts
var BlueprintPin = class BlueprintPin {
	name;
	version;
	digest;
	constructor(name, version, digest) {
		this.name = name;
		this.version = version;
		this.digest = digest;
		if (name.trim().length === 0) throw new TypeError("Blueprint pin name must not be blank");
		Object.freeze(this);
	}
	toData() {
		return {
			digest: this.digest.value,
			name: this.name,
			version: this.version.toString()
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Blueprint pin");
		requireExactFields(object, [
			"digest",
			"name",
			"version"
		], [], "Blueprint pin");
		return new BlueprintPin(requireString(object["name"], "Blueprint pin name"), new SemVer(requireString(object["version"], "Blueprint pin version")), digestFromData(object["digest"], "Blueprint pin digest"));
	}
};
var RunPins = class RunPins extends CodecRecord {
	static get codec() {
		return RunPinsCodec;
	}
	blueprint;
	packages;
	agent;
	effectivePolicy;
	modelPolicy;
	environment;
	digest;
	constructor(init) {
		super();
		const packages = [...init.packages].map((pin) => PackagePin.fromData(pin.toData())).sort((left, right) => compareCanonicalText(left.id.value, right.id.value));
		if (packages.length === 0 || new Set(packages.map((pin) => pin.id.value)).size !== packages.length) throw new TypeError("Run pins package closure must be nonempty with unique Package IDs");
		this.blueprint = BlueprintPin.fromData(init.blueprint.toData());
		this.packages = Object.freeze(packages);
		this.agent = requireSourcePin(init.agent, AgentId, "Agent pin");
		this.effectivePolicy = requireSourcePin(init.effectivePolicy, AgentPolicyId, "Effective policy pin");
		this.modelPolicy = requireSourcePin(init.modelPolicy, ModelPolicyId, "Model policy pin");
		this.environment = requireSourcePin(init.environment, EnvironmentId, "Environment pin");
		this.digest = Digest.sha256(encodeCanonicalJson(this.toData()));
		Object.freeze(this);
	}
	equals(other) {
		return bytesEqual(RunPinsCodec.encode(this), RunPinsCodec.encode(other));
	}
	/**
	* The dimensions in which this pin set differs from another, with the exact identities
	* that differ in each. Derived from the two records whenever it is asked for and stored
	* nowhere: a merge names both of its parents, so both pin records are already durable,
	* and recording their difference would be a second copy of what the graph holds. Empty
	* exactly when `equals` holds.
	*/
	divergence(other) {
		const divergence = [];
		for (const dimension of RunPinDimension.all) {
			const identities = dimension.divergentIdentities(this, other);
			if (identities.length > 0) divergence.push(Object.freeze({
				dimension,
				identities
			}));
		}
		return Object.freeze(divergence);
	}
	toData() {
		return {
			agent: pinData(this.agent),
			blueprint: this.blueprint.toData(),
			effectivePolicy: pinData(this.effectivePolicy),
			environment: pinData(this.environment),
			modelPolicy: pinData(this.modelPolicy),
			packages: this.packages.map((pin) => pin.toData())
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Run pins");
		requireExactFields(object, [
			"agent",
			"blueprint",
			"effectivePolicy",
			"environment",
			"modelPolicy",
			"packages"
		], [], "Run pins");
		return new RunPins({
			blueprint: BlueprintPin.fromData(object["blueprint"]),
			packages: requireArray(object["packages"], "Run pin packages").map(PackagePin.fromData),
			agent: pinFromData(object["agent"], AgentId, "Agent pin"),
			effectivePolicy: pinFromData(object["effectivePolicy"], AgentPolicyId, "Effective policy pin"),
			modelPolicy: pinFromData(object["modelPolicy"], ModelPolicyId, "Model policy pin"),
			environment: pinFromData(object["environment"], EnvironmentId, "Environment pin")
		});
	}
};
var RunPinsRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			RunPins,
			BlueprintPin,
			Revision,
			TextId,
			SemVer,
			PackagePin,
			Digest,
			AgentId,
			CodecRecord,
			ModelPolicyId,
			EnvironmentId,
			AgentPolicyId,
			PackageId
		], "run.pins", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return RunPins.fromData(value);
	}
};
var RunPinsCodec = new RunPinsRecordCodec();
/**
* The closed set of dimensions RunPins carries. A merge requires equal pins on both parents,
* and a refusal saying only that two pin sets were unequal leaves the caller to search for the
* disagreement the platform already found — so each case owns the comparison for its own
* dimension and names what differs. `all` is the one place the dimensions are enumerated, so a
* pin field nobody taught to compare is visible here rather than silently equal.
*/
var RunPinDimension = class {
	static get blueprint() {
		return blueprintDimension;
	}
	static get packages() {
		return packagesDimension;
	}
	static get agent() {
		return agentDimension;
	}
	static get effectivePolicy() {
		return effectivePolicyDimension;
	}
	static get modelPolicy() {
		return modelPolicyDimension;
	}
	static get environment() {
		return environmentDimension;
	}
	/** Every dimension, in the order a refusal names them. */
	static get all() {
		return allDimensions;
	}
	equals(other) {
		return this === other;
	}
};
var BlueprintDimension = class extends RunPinDimension {
	label = "blueprint";
	divergentIdentities(left, right) {
		const first = left.blueprint;
		const second = right.blueprint;
		if (first.name === second.name && first.version.equals(second.version) && first.digest.equals(second.digest)) return [];
		return distinctIdentities([first.name, second.name]);
	}
};
var SourceDimension = class extends RunPinDimension {
	label;
	select;
	constructor(label, select) {
		super();
		this.label = label;
		this.select = select;
	}
	divergentIdentities(left, right) {
		const first = this.select(left);
		const second = this.select(right);
		if (first.id.value === second.id.value && first.revision.equals(second.revision) && first.digest.equals(second.digest)) return [];
		return distinctIdentities([first.id.value, second.id.value]);
	}
};
var PackagesDimension = class extends RunPinDimension {
	label = "packages";
	divergentIdentities(left, right) {
		const remaining = new Map(right.packages.map((pin) => [pin.id.value, pin]));
		const divergent = [];
		for (const pin of left.packages) {
			const other = remaining.get(pin.id.value);
			if (other === void 0 || !pin.equals(other)) divergent.push(pin.id.value);
			remaining.delete(pin.id.value);
		}
		return distinctIdentities([...divergent, ...remaining.keys()]);
	}
};
function distinctIdentities(values) {
	return Object.freeze([...new Set(values)].sort(compareCanonicalText));
}
var blueprintDimension = new BlueprintDimension();
var packagesDimension = new PackagesDimension();
var agentDimension = new SourceDimension("agent", (pins) => pins.agent);
var effectivePolicyDimension = new SourceDimension("effectivePolicy", (pins) => pins.effectivePolicy);
var modelPolicyDimension = new SourceDimension("modelPolicy", (pins) => pins.modelPolicy);
var environmentDimension = new SourceDimension("environment", (pins) => pins.environment);
var allDimensions = Object.freeze([
	blueprintDimension,
	packagesDimension,
	agentDimension,
	effectivePolicyDimension,
	modelPolicyDimension,
	environmentDimension
]);
var RunConfigurationSnapshot = class RunConfigurationSnapshot extends CodecRecord {
	static get codec() {
		return RunConfigurationSnapshotCodec;
	}
	pins;
	id;
	constructor(init) {
		super();
		this.pins = RunPins.fromData(init.pins.toData());
		this.id = Digest.sha256(encodeCanonicalJson(this.toData()));
		Object.freeze(this);
	}
	toData() {
		return { pins: this.pins.toData() };
	}
	static fromData(value) {
		const object = requireObject(value, "Run configuration snapshot");
		requireExactFields(object, ["pins"], [], "Run configuration snapshot");
		return new RunConfigurationSnapshot({ pins: RunPins.fromData(object["pins"]) });
	}
};
var RunConfigurationCodec = class extends RecordCodec {
	constructor() {
		super([
			RunConfigurationSnapshot,
			BlueprintPin,
			Revision,
			TextId,
			SemVer,
			RunPins,
			PackagePin,
			Digest,
			AgentId,
			CodecRecord,
			ModelPolicyId,
			EnvironmentId,
			AgentPolicyId,
			PackageId
		], "run.configuration-snapshot", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return RunConfigurationSnapshot.fromData(value);
	}
};
var RunConfigurationSnapshotCodec = new RunConfigurationCodec();
function requireSourcePin(pin, idType, subject) {
	if (!(pin.id instanceof idType) || !(pin.revision instanceof Revision) || !(pin.digest instanceof Digest)) throw new TypeError(`${subject} must contain the canonical ID, Revision, and Digest`);
	return Object.freeze({
		id: pin.id,
		revision: pin.revision,
		digest: pin.digest
	});
}
function pinData(pin) {
	return {
		digest: pin.digest.value,
		id: pin.id.value,
		revision: revisionData(pin.revision)
	};
}
function pinFromData(value, idType, subject) {
	const object = requireObject(value, subject);
	requireExactFields(object, [
		"digest",
		"id",
		"revision"
	], [], subject);
	return requireSourcePin({
		id: new idType(requireString(object["id"], `${subject} ID`)),
		revision: revisionFromData(object["revision"], `${subject} revision`),
		digest: digestFromData(object["digest"], `${subject} digest`)
	}, idType, subject);
}
//#endregion
//#region src/agents/runs/commit.ts
/** Every Run commit kind, in the order the record vocabulary lists them. */
var RUN_COMMIT_KINDS = [
	"root",
	"message",
	"checkpoint",
	"invocation",
	"eventDelivery",
	"result",
	"merge",
	"verdict",
	"undo",
	"migration",
	"rewrite",
	"modelInput"
];
/** The kinds a Turn's own lease may append. */
var TURN_AUTHORED_KINDS = [
	"message",
	"modelInput",
	"checkpoint",
	"result",
	"verdict"
];
/** The kinds a system writer may append on control evidence. */
var CONTROL_AUTHORED_KINDS = [
	"merge",
	"undo",
	"migration",
	"rewrite"
];
/**
* The two ordered parents of a merge commit (§5.2): the head the merge lands on, and the head
* of the distinct lineage it joins in. Distinctness is a property of this value rather than a
* length a later reader measures, so a merge that joins one lineage to itself is not a record
* a caller can build or a decoder can restore.
*/
var MergeParents = class {
	target;
	source;
	/** The pair in the order the merge declared, which is the commit's own parent list. */
	ordered;
	constructor(target, source) {
		this.target = target;
		this.source = source;
		if (target.constructor !== RunCommitId || source.constructor !== RunCommitId) throw new TypeError("Merge parents must use exact context classes");
		if (target.equals(source)) throw new TypeError("Merge parents must name two distinct commits");
		this.ordered = Object.freeze([target, source]);
		Object.freeze(this);
	}
};
var RunCommit = class RunCommit extends CodecRecord {
	static get codec() {
		return RunCommitCodec;
	}
	id;
	run;
	branch;
	kind;
	parents;
	/** Present on exactly a merge commit, where it is the record's own parent order. */
	mergeParents;
	pins;
	writer;
	subjectTurn;
	content;
	selects;
	shadows;
	requests;
	treeCheckpoint;
	resolution;
	treeResolution;
	invocation;
	receipt;
	reservation;
	migration;
	proposalDigest;
	constructor(init) {
		super();
		this.id = init.id;
		this.run = init.run;
		this.branch = init.branch;
		this.kind = init.kind;
		this.mergeParents = requireMergeParents(init);
		this.parents = this.mergeParents?.ordered ?? Object.freeze([...init.parents]);
		this.pins = RunPins.fromData(init.pins.toData());
		this.writer = copyWriter(init.writer);
		this.subjectTurn = init.subjectTurn;
		this.content = init.content;
		this.selects = init.selects;
		this.shadows = init.shadows === void 0 ? void 0 : Object.freeze([...init.shadows]);
		this.requests = init.requests === void 0 ? void 0 : Object.freeze([...init.requests]);
		this.treeCheckpoint = init.treeCheckpoint;
		this.resolution = init.resolution === void 0 ? void 0 : copyResolution(init.resolution);
		this.treeResolution = init.treeResolution === void 0 ? void 0 : copyTreeResolution(init.treeResolution);
		this.invocation = init.invocation;
		this.receipt = init.receipt;
		this.reservation = init.reservation;
		this.migration = init.migration === void 0 ? void 0 : Object.freeze({
			from: RunPins.fromData(init.migration.from.toData()),
			to: RunPins.fromData(init.migration.to.toData())
		});
		validateClosedKind(this);
		this.proposalDigest = Digest.sha256(encodeCanonicalJson(this.proposalData()));
		Object.freeze(this);
	}
	isTurnAuthored(kind, token) {
		if (this.writer.kind !== "turn") return false;
		return this.kind === kind && this.subjectTurn?.equals(token.turn) === true && leaseTokensEqual(this.writer.token, token);
	}
	toData() {
		return {
			...this.proposalData(),
			writer: writerData(this.writer)
		};
	}
	proposalData() {
		return {
			branch: this.branch.value,
			id: this.id.value,
			kind: this.kind,
			parents: this.parents.map((parent) => parent.value),
			pins: this.pins.toData(),
			run: this.run.value,
			subjectTurn: this.subjectTurn?.value ?? null,
			content: this.content?.value ?? null,
			selects: this.selects?.value ?? null,
			shadows: this.shadows?.map((shadowed) => shadowed.value) ?? null,
			requests: this.requests?.map((invocation) => invocation.value) ?? null,
			treeCheckpoint: this.treeCheckpoint?.value ?? null,
			resolution: this.resolution === void 0 ? null : resolutionData(this.resolution),
			treeResolution: this.treeResolution === void 0 ? null : treeResolutionData(this.treeResolution),
			invocation: this.invocation?.value ?? null,
			receipt: this.receipt?.value ?? null,
			reservation: this.reservation?.value ?? null,
			migration: this.migration === void 0 ? null : {
				from: this.migration.from.toData(),
				to: this.migration.to.toData()
			}
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Run commit");
		requireExactFields(object, [
			"branch",
			"content",
			"id",
			"invocation",
			"kind",
			"migration",
			"parents",
			"pins",
			"receipt",
			"reservation",
			"requests",
			"resolution",
			"run",
			"selects",
			"shadows",
			"subjectTurn",
			"treeCheckpoint",
			"treeResolution",
			"writer"
		], [], "Run commit");
		const migration = object["migration"];
		const resolution = object["resolution"];
		const treeResolution = object["treeResolution"];
		return new RunCommit({
			id: new RunCommitId(requireString(object["id"], "Run commit ID")),
			run: new RunId(requireString(object["run"], "Run commit Run")),
			branch: new RunBranchId(requireString(object["branch"], "Run commit branch")),
			kind: requireCommitKind(object["kind"]),
			parents: requireArray(object["parents"], "Run commit parents").map((parent) => new RunCommitId(requireString(parent, "Run commit parent"))),
			pins: RunPins.fromData(object["pins"]),
			writer: requireCommitWriter(object["writer"]),
			subjectTurn: optionalId(object["subjectTurn"], (value) => new TurnId(value), "Run subject Turn"),
			content: optionalId(object["content"], (value) => new ContentRef(value), "Run content"),
			selects: optionalId(object["selects"], (value) => new RunCommitId(value), "Run selection"),
			shadows: optionalIds(object["shadows"], (value) => new RunCommitId(value), "Rewrite shadow"),
			requests: optionalIds(object["requests"], (value) => new InvocationId(value), "Message request"),
			treeCheckpoint: optionalId(object["treeCheckpoint"], (value) => new ContentRef(value), "Tree checkpoint"),
			resolution: resolution === null ? void 0 : requireMergeResolution(resolution),
			treeResolution: treeResolution === null ? void 0 : requireTreeMergeResolution(treeResolution),
			invocation: optionalId(object["invocation"], (value) => new InvocationId(value), "Run Invocation"),
			receipt: optionalId(object["receipt"], (value) => new ReceiptId(value), "Run Receipt"),
			reservation: optionalId(object["reservation"], (value) => new RouteReservationId(value), "Run reservation"),
			migration: migration === null || migration === void 0 ? void 0 : migrationFromData(migration)
		});
	}
};
function runCommitContentRetention(value) {
	return contentRetentionFields([
		["content", value.content],
		["treeCheckpoint", value.treeCheckpoint],
		["treeResolution.base", value.treeResolution?.base]
	]);
}
var CommitCodec = class extends RecordCodec {
	constructor() {
		super([
			RunCommit,
			MergeParents,
			Revision,
			TextId,
			SemVer,
			RunPins,
			PackagePin,
			BlueprintPin,
			ContentRef,
			Digest,
			RunId,
			RouteReservationId,
			ReceiptId,
			RunCommitId,
			AuditRecordId,
			TenantId,
			TurnId,
			RunBranchId,
			PrincipalId,
			InvocationId,
			AgentId,
			CodecRecord,
			ModelPolicyId,
			EnvironmentId,
			AgentPolicyId,
			PrincipalRef,
			PackageId
		], "run.commit", {
			major: 3,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return RunCommit.fromData(value);
	}
};
var RunCommitCodec = new CommitCodec();
/**
* §5.2's abandoned rewrite stands on an attempt that ended without installing anything, and
* §7.4's closed failure kind on that attempt's Receipt is what says why it ended. The kind is
* read off the durable Receipt rather than restated beside the evidence, so a host cannot
* name a kind the Receipt contradicts and no member of the taxonomy needs listing here. A
* Receipt that is absent, that reached no EffectAttempt, or whose attempt records no failure
* says nothing an abandoned rewrite may stand on, and each is refused on its own terms.
*/
function requireAbandonedFailureKind(stored) {
	if (stored === void 0) throw deniedEvidence("Abandoned rewrite evidence names no stored Receipt");
	if (!(stored instanceof AttemptReceipt)) throw deniedEvidence("Abandoned rewrite evidence names a Receipt that reached no EffectAttempt");
	const failure = stored.failure;
	if (failure === void 0) throw deniedEvidence("Abandoned rewrite evidence names a Receipt that records no failed attempt");
	return failure;
}
function validateCommitWriter(transaction, commit, evidence) {
	if (commit.writer.kind === "root") {
		if (commit.kind !== "root") throw invalidWriter("Root writer may append only the root commit");
		return;
	}
	if (commit.writer.kind === "turn") {
		if (!TURN_AUTHORED_KINDS.includes(commit.kind) || !commit.subjectTurn?.equals(commit.writer.token.turn)) throw invalidWriter("Turn writer is incompatible with the Run commit");
		return;
	}
	const cause = commit.writer.cause;
	if (cause.kind === "receipt") {
		const found = requireSynchronousResult(evidence.receipt(transaction, cause.receipt, cause.audit));
		if (commit.kind !== "invocation" || found === void 0 || !found.run.equals(commit.run) || !found.audit.equals(cause.audit) || !found.receipt.equals(cause.receipt) || !commit.receipt?.equals(found.receipt) || !commit.invocation?.equals(found.invocation) || !optionalIdsEqual(commit.subjectTurn, found.subjectTurn)) throw deniedEvidence("Receipt writer evidence does not match the Run commit");
		return;
	}
	if (cause.kind === "delivery") {
		const found = requireSynchronousResult(evidence.delivery(transaction, cause.reservation, cause.audit));
		if (commit.kind !== "eventDelivery" || found === void 0 || !found.run.equals(commit.run) || !found.audit.equals(cause.audit) || !found.reservation.equals(cause.reservation) || !commit.reservation?.equals(found.reservation) || !optionalIdsEqual(commit.subjectTurn, found.subjectTurn)) throw deniedEvidence("Delivery writer evidence does not match the Run commit");
		return;
	}
	const found = requireSynchronousResult(commit.kind === "rewrite" && commit.shadows?.length === 0 ? evidence.abandonedRewrite(transaction, cause.receipt, cause.audit) : evidence.control(transaction, cause.receipt, cause.audit));
	if (!CONTROL_AUTHORED_KINDS.includes(commit.kind) || found === void 0 || !found.run.equals(commit.run) || !found.audit.equals(cause.audit) || !found.receipt.equals(cause.receipt) || found.proposalDigest !== commit.proposalDigest.value || !commit.receipt?.equals(found.receipt)) throw deniedEvidence("Control writer evidence does not bind the complete Run commit proposal");
	if (found.kind === "abandonedRewrite") requireAbandonedFailureKind(requireSynchronousResult(evidence.storedReceipt(transaction, found.receipt)));
	if (commit.resolution?.kind === "synthesize") {
		const synthesis = requireSynchronousResult(evidence.synthesis(transaction, commit.resolution.receipt));
		if (synthesis === void 0 || !synthesis.run.equals(commit.run) || !synthesis.receipt.equals(commit.resolution.receipt) || !leaseTokensEqual(synthesis.token, commit.resolution.token) || !commit.content?.equals(synthesis.content)) throw deniedEvidence("Synthesis evidence does not match the exact token and content");
	}
}
/**
* A merge's parents are the one parent list this record proves rather than sizes: exactly two
* commits, in the order the merge declared, naming two lineages. Every other kind keeps the
* plain list whose arity its own closed shape reads.
*/
function requireMergeParents(init) {
	if (init.kind !== "merge") return void 0;
	const [target, source, ...beyond] = init.parents;
	if (target === void 0 || source === void 0 || beyond.length > 0) throw new TypeError("Merge commit fields are invalid");
	return new MergeParents(target, source);
}
function validateClosedKind(commit) {
	const forbidden = (...values) => values.every((value) => value === void 0);
	const requests = commit.requests;
	if (requests !== void 0 && (commit.kind !== "message" || requests.length === 0 || new Set(requests.map((invocation) => invocation.value)).size !== requests.length)) throw new TypeError("Only a message commit names a distinct nonempty request set");
	if (commit.shadows !== void 0 && commit.kind !== "rewrite") throw new TypeError("Only a rewrite commit shadows commit identities");
	if (commit.kind === "root") {
		if (commit.writer.kind !== "root" || commit.parents.length !== 0 || commit.subjectTurn !== void 0 || !forbidden(commit.selects, commit.resolution, commit.treeResolution, commit.invocation, commit.receipt, commit.reservation, commit.migration)) throw new TypeError("Root commit fields are invalid");
		return;
	}
	if (commit.kind === "merge") {
		if (commit.writer.kind !== "system" || commit.writer.cause.kind !== "control" || commit.resolution === void 0 || commit.content === void 0 || commit.receipt === void 0 || !forbidden(commit.selects, commit.invocation, commit.reservation, commit.migration)) throw new TypeError("Merge commit fields are invalid");
		if (commit.treeResolution === void 0 !== (commit.treeCheckpoint === void 0)) throw new TypeError("Tree resolution and checkpoint must occur together");
		const resolution = commit.resolution;
		if (resolution.kind === "pick" && !commit.parents.some((parent) => parent.equals(resolution.parent))) throw new TypeError("Merge pick must name one ordered parent");
		const tree = commit.treeResolution;
		if (tree !== void 0 && (tree.policy === "ours" && !tree.side.equals(commit.parents[0]) || tree.policy === "theirs" && !tree.side.equals(commit.parents[1]) || tree.policy === "perPath" && tree.resolutions.some((path) => !commit.parents.some((parent) => parent.equals(path.side))))) throw new TypeError("Tree resolution sides must name ordered merge parents");
		return;
	}
	if (commit.parents.length !== 1) throw new TypeError("Unary Run commits require one parent");
	if (commit.kind === "invocation") {
		if (commit.writer.kind !== "system" || commit.writer.cause.kind !== "receipt" || commit.invocation === void 0 || commit.receipt === void 0 || !forbidden(commit.content, commit.selects, commit.resolution, commit.treeResolution, commit.reservation, commit.migration)) throw new TypeError("Invocation commit fields are invalid");
		return;
	}
	if (commit.kind === "eventDelivery") {
		if (commit.writer.kind !== "system" || commit.writer.cause.kind !== "delivery" || commit.reservation === void 0 || !forbidden(commit.content, commit.selects, commit.resolution, commit.treeResolution, commit.invocation, commit.receipt, commit.migration)) throw new TypeError("Event delivery commit fields are invalid");
		return;
	}
	if (commit.kind === "undo") {
		requireControl(commit);
		if (commit.selects === void 0 || !forbidden(commit.content, commit.subjectTurn, commit.resolution, commit.treeResolution, commit.invocation, commit.reservation, commit.migration)) throw new TypeError("Undo commit fields are invalid");
		return;
	}
	if (commit.kind === "migration") {
		requireControl(commit);
		if (commit.migration === void 0 || !commit.pins.equals(commit.migration.to) || !forbidden(commit.content, commit.subjectTurn, commit.selects, commit.resolution, commit.treeResolution, commit.invocation, commit.reservation)) throw new TypeError("Migration commit fields are invalid");
		return;
	}
	if (commit.kind === "rewrite") {
		requireControl(commit);
		const shadows = commit.shadows;
		if (shadows === void 0 || shadows.length === 0 !== (commit.content === void 0) || shadows.some((shadowed) => shadowed.equals(commit.id)) || new Set(shadows.map((shadowed) => shadowed.value)).size !== shadows.length || !forbidden(commit.subjectTurn, commit.selects, commit.treeCheckpoint, commit.resolution, commit.treeResolution, commit.invocation, commit.reservation, commit.migration)) throw new TypeError("Rewrite commit fields are invalid");
		return;
	}
	if (commit.writer.kind !== "turn" || commit.subjectTurn === void 0 || commit.content === void 0 || !forbidden(commit.selects, commit.resolution, commit.treeResolution, commit.invocation, commit.receipt, commit.reservation, commit.migration)) throw new TypeError("Turn-authored commit fields are invalid");
}
function requireControl(commit) {
	if (commit.writer.kind !== "system" || commit.writer.cause.kind !== "control" || commit.receipt === void 0) throw new TypeError("Control commit requires exact control evidence");
}
function copyWriter(writer) {
	if (writer.kind === "root") return Object.freeze({ kind: "root" });
	if (writer.kind === "turn") return Object.freeze({
		kind: "turn",
		token: copyToken(writer.token)
	});
	const cause = Object.freeze({ ...writer.cause });
	return Object.freeze({
		kind: "system",
		cause
	});
}
function writerData(writer) {
	if (writer.kind === "root") return { kind: "root" };
	if (writer.kind === "turn") return {
		kind: "turn",
		token: tokenData$1(writer.token)
	};
	const cause = writer.cause;
	return cause.kind === "delivery" ? {
		kind: "system",
		cause: {
			kind: cause.kind,
			audit: cause.audit.value,
			reservation: cause.reservation.value
		}
	} : {
		kind: "system",
		cause: {
			kind: cause.kind,
			audit: cause.audit.value,
			receipt: cause.receipt.value
		}
	};
}
function requireCommitWriter(value) {
	const object = requireObject(value, "Commit writer");
	const kind = requireString(object["kind"], "Commit writer kind");
	if (kind === "root") {
		requireExactFields(object, ["kind"], [], "Root writer");
		return { kind };
	}
	if (kind === "turn") {
		requireExactFields(object, ["kind", "token"], [], "Turn writer");
		return {
			kind,
			token: requireLeaseToken(object["token"])
		};
	}
	if (kind !== "system") throw new TypeError("Commit writer kind is invalid");
	requireExactFields(object, ["cause", "kind"], [], "System writer");
	const cause = requireObject(object["cause"], "System cause");
	const causeKind = requireString(cause["kind"], "System cause kind");
	if (causeKind === "delivery") {
		requireExactFields(cause, [
			"audit",
			"kind",
			"reservation"
		], [], "Delivery cause");
		return {
			kind,
			cause: {
				kind: causeKind,
				audit: new AuditRecordId(requireString(cause["audit"], "Delivery audit")),
				reservation: new RouteReservationId(requireString(cause["reservation"], "Delivery reservation"))
			}
		};
	}
	if (causeKind === "receipt" || causeKind === "control") {
		requireExactFields(cause, [
			"audit",
			"kind",
			"receipt"
		], [], "Receipt cause");
		return {
			kind,
			cause: {
				kind: causeKind,
				audit: new AuditRecordId(requireString(cause["audit"], "Receipt audit")),
				receipt: new ReceiptId(requireString(cause["receipt"], "Receipt evidence"))
			}
		};
	}
	throw new TypeError("System cause kind is invalid");
}
function copyResolution(value) {
	return value.kind === "pick" ? Object.freeze({
		kind: value.kind,
		parent: value.parent
	}) : value.kind === "concat" ? Object.freeze({ kind: value.kind }) : Object.freeze({
		kind: value.kind,
		token: copyToken(value.token),
		receipt: value.receipt
	});
}
function resolutionData(value) {
	return value.kind === "pick" ? {
		kind: value.kind,
		parent: value.parent.value
	} : value.kind === "concat" ? { kind: value.kind } : {
		kind: value.kind,
		token: tokenData$1(value.token),
		receipt: value.receipt.value
	};
}
function requireMergeResolution(value) {
	const object = requireObject(value, "Merge resolution");
	const kind = requireString(object["kind"], "Merge resolution kind");
	if (kind === "pick") {
		requireExactFields(object, ["kind", "parent"], [], "Pick resolution");
		return {
			kind,
			parent: new RunCommitId(requireString(object["parent"], "Picked parent"))
		};
	}
	if (kind === "concat") {
		requireExactFields(object, ["kind"], [], "Concat resolution");
		return { kind };
	}
	if (kind === "synthesize") {
		requireExactFields(object, [
			"kind",
			"receipt",
			"token"
		], [], "Synthesis resolution");
		return {
			kind,
			token: requireLeaseToken(object["token"]),
			receipt: new ReceiptId(requireString(object["receipt"], "Synthesis Receipt"))
		};
	}
	throw new TypeError("Merge resolution kind is invalid");
}
function copyTreeResolution(value) {
	if (value.policy !== "perPath") return Object.freeze({ ...value });
	const paths = value.resolutions.map((path) => Object.freeze({ ...path }));
	if (new Set(paths.map((path) => path.path)).size !== paths.length) throw new TypeError("Tree path resolutions must be unique");
	return Object.freeze({
		...value,
		resolutions: Object.freeze(paths)
	});
}
function treeResolutionData(value) {
	return value.policy === "perPath" ? {
		policy: value.policy,
		base: value.base.value,
		environment: value.environment,
		resolutions: value.resolutions.map((path) => ({
			path: path.path,
			side: path.side.value
		}))
	} : {
		policy: value.policy,
		base: value.base.value,
		environment: value.environment,
		side: value.side.value
	};
}
function requireTreeMergeResolution(value) {
	const object = requireObject(value, "Tree resolution");
	const policy = requireString(object["policy"], "Tree resolution policy");
	const base = new ContentRef(requireString(object["base"], "Tree merge base"));
	const environment = requireString(object["environment"], "Tree merge Environment");
	if (policy === "ours" || policy === "theirs") {
		requireExactFields(object, [
			"base",
			"environment",
			"policy",
			"side"
		], [], "Tree side resolution");
		return {
			policy,
			base,
			environment,
			side: new RunCommitId(requireString(object["side"], "Tree side"))
		};
	}
	if (policy !== "perPath") throw new TypeError("Tree resolution policy is invalid");
	requireExactFields(object, [
		"base",
		"environment",
		"policy",
		"resolutions"
	], [], "Per-path resolution");
	return {
		policy,
		base,
		environment,
		resolutions: requireArray(object["resolutions"], "Path resolutions").map((entry) => {
			const path = requireObject(entry, "Path resolution");
			requireExactFields(path, ["path", "side"], [], "Path resolution");
			return {
				path: requireString(path["path"], "Resolved path"),
				side: new RunCommitId(requireString(path["side"], "Resolved side"))
			};
		})
	};
}
function migrationFromData(value) {
	const object = requireObject(value, "Run migration");
	requireExactFields(object, ["from", "to"], [], "Run migration");
	return {
		from: RunPins.fromData(object["from"]),
		to: RunPins.fromData(object["to"])
	};
}
function tokenData$1(token) {
	return leaseTokenToData(token);
}
function requireLeaseToken(value) {
	return leaseTokenFromData(value);
}
function copyToken(token) {
	if (!(token.turn instanceof TurnId)) throw new TypeError("Lease token turn must be a TurnId");
	if (!(token.holder instanceof PrincipalRef)) throw new TypeError("Lease token holder must be a PrincipalRef");
	if (!Number.isSafeInteger(token.epoch) || token.epoch < 0) throw new TypeError("Lease token epoch must be a non-negative safe integer");
	return Object.freeze({
		turn: token.turn,
		holder: token.holder,
		epoch: token.epoch
	});
}
function optionalIdsEqual(left, right) {
	return left === void 0 ? right === void 0 : right !== void 0 && left.equals(right);
}
function invalidWriter(message) {
	return new AgentCoreError("run.invalid-state", message);
}
function deniedEvidence(message) {
	return new AgentCoreError("authority.denied", message);
}
function requireCommitKind(value) {
	if (isMember(RUN_COMMIT_KINDS, value)) return value;
	throw new TypeError("Run commit kind is invalid");
}
function optionalId(value, create, subject) {
	const decoded = requireOptionalString(value, subject);
	return decoded === void 0 ? void 0 : create(decoded);
}
function optionalIds(value, create, subject) {
	if (value === void 0 || value === null) return void 0;
	return requireArray(value, subject).map((entry) => create(requireString(entry, subject)));
}
//#endregion
//#region src/agents/runs/transcript.ts
/**
* Which commit a branch head is current at: an undo marker answers with its selection,
* every other head with itself. It sits beside the transcript derivation because every
* caller that asks what a model reads MUST resolve the head first — §5.6 assembles from
* the effective state and not from the raw head, which may be an undo marker.
*/
function effectiveCommitOf(load, head) {
	const commit = load(head);
	if (commit === void 0) throw new AgentCoreError("codec.invalid", `Run commit ${head.value} does not exist`);
	if (commit.kind !== "undo") return commit;
	const selects = commit.selects;
	if (selects === void 0) throw new AgentCoreError("run.invalid-state", "Undo commit names no selection");
	const selected = load(selects);
	if (selected === void 0) throw new AgentCoreError("codec.invalid", `Run commit ${selects.value} does not exist`);
	return selected;
}
/**
* The ancestors of `base` including itself, every parent before its child, and a merge's
* first-parent ancestry before the commits only its second parent reaches. Parent order is
* recorded, so this order is a property of the graph rather than of the walk.
*/
function orderedAncestry(base, load) {
	const ordered = [];
	const walked = /* @__PURE__ */ new Set();
	const pending = [{
		commit: base,
		expanded: false
	}];
	for (let frame = pending.pop(); frame !== void 0; frame = pending.pop()) {
		if (frame.expanded) {
			ordered.push(frame.commit);
			continue;
		}
		if (walked.has(frame.commit.id.value)) continue;
		walked.add(frame.commit.id.value);
		pending.push({
			commit: frame.commit,
			expanded: true
		});
		for (const parent of [...frame.commit.parents].reverse()) {
			const record = load(parent);
			if (record === void 0 || !record.run.equals(frame.commit.run)) throw new AgentCoreError("codec.invalid", "Run ancestry contains a missing or foreign parent");
			pending.push({
				commit: record,
				expanded: false
			});
		}
	}
	return Object.freeze(ordered);
}
/**
* The model-visible sequence a call reads at `base`: that commit's ancestry in commit
* order with every shadowed commit omitted and each installed rewrite read where the
* earliest commit it shadows stood. `base` is the effective state, already resolved
* through any undo selection, so a rewrite appended later is a descendant and cannot
* enter the derivation.
*/
function effectiveTranscript(base, load) {
	const ancestry = orderedAncestry(base, load);
	const shadowedBy = /* @__PURE__ */ new Map();
	for (const commit of ancestry) {
		if (commit.kind !== "rewrite") continue;
		for (const shadowed of commit.shadows ?? []) {
			const owner = shadowedBy.get(shadowed.value);
			if (owner !== void 0) throw new AgentCoreError("run.invalid-state", `Run commit ${shadowed.value} is shadowed by both ${owner.id.value} and ${commit.id.value}`);
			shadowedBy.set(shadowed.value, commit);
		}
	}
	const transcript = [];
	const emitted = /* @__PURE__ */ new Set();
	for (const commit of ancestry) {
		const replacement = readInsteadOf(commit, shadowedBy);
		if (replacement !== void 0) {
			if (emitted.has(replacement.id.value)) continue;
			emitted.add(replacement.id.value);
			transcript.push(replacement);
			continue;
		}
		if (commit.kind === "rewrite") {
			if ((commit.shadows?.length ?? 0) > 0 && !emitted.has(commit.id.value)) throw new AgentCoreError("run.invalid-state", `Rewrite ${commit.id.value} shadows no commit its own ancestry reaches`);
			continue;
		}
		emitted.add(commit.id.value);
		transcript.push(commit);
	}
	return Object.freeze(transcript);
}
/**
* The first Invocation whose request and `invocation` commit the cut separated. Judged on
* identity rather than on how many of each survived: a cut that drops one request and one
* unrelated result leaves any count balanced and strands both surviving halves.
*/
function unbalancedCut(before, after) {
	const retained = new Set(after.map((commit) => commit.id.value));
	const pairs = /* @__PURE__ */ new Map();
	const order = [];
	for (const commit of before) {
		for (const invocation of commit.requests ?? []) pairedWith(pairs, order, invocation).requests.push(commit.id);
		if (commit.kind === "invocation" && commit.invocation !== void 0) pairedWith(pairs, order, commit.invocation).answers.push(commit.id);
	}
	for (const pair of order) {
		if (pair.requests.length === 0 || pair.answers.length === 0) continue;
		const request = pair.requests.find((commit) => retained.has(commit.value));
		const answer = pair.answers.find((commit) => retained.has(commit.value));
		if (request !== void 0 && answer === void 0) return Object.freeze({
			kind: "unanswered",
			invocation: pair.invocation,
			commit: request
		});
		if (request === void 0 && answer !== void 0) return Object.freeze({
			kind: "orphaned",
			invocation: pair.invocation,
			commit: answer
		});
	}
}
function pairedWith(pairs, order, invocation) {
	const existing = pairs.get(invocation.value);
	if (existing !== void 0) return existing;
	const pair = {
		invocation,
		requests: [],
		answers: []
	};
	pairs.set(invocation.value, pair);
	order.push(pair);
	return pair;
}
/**
* The rewrite whose content stands where `commit` did, following a chain when a later
* rewrite shadows an earlier one. Undefined when the commit is read as itself.
*/
function readInsteadOf(commit, shadowedBy) {
	let current = shadowedBy.get(commit.id.value);
	if (current === void 0) return void 0;
	const walked = /* @__PURE__ */ new Set([commit.id.value]);
	for (;;) {
		if (walked.has(current.id.value)) throw new AgentCoreError("run.invalid-state", `Run rewrite ${current.id.value} shadows its own replacement`);
		walked.add(current.id.value);
		const next = shadowedBy.get(current.id.value);
		if (next === void 0) return current;
		current = next;
	}
}
//#endregion
//#region src/agents/runs/placement.ts
var PlacementPin = class PlacementPin {
	facet;
	manifest;
	policy;
	substrate;
	trust;
	selected;
	constructor(init) {
		this.facet = init.facet;
		this.manifest = canonicalModes(init.manifest, "Manifest modes");
		this.policy = canonicalModes(init.policy, "Policy modes");
		this.substrate = canonicalModes(init.substrate, "Substrate modes");
		this.trust = canonicalModes(init.trust, "Trust modes");
		if (![
			this.manifest,
			this.policy,
			this.substrate,
			this.trust
		].every((modes) => modes.includes(init.selected))) throw new TypeError("Placement selection must belong to every source set");
		const selected = preferredPlacement(this.manifest, this.policy, this.substrate, this.trust);
		if (selected !== init.selected) throw new TypeError("Placement selection must use the fixed preference order");
		this.selected = selected;
		Object.freeze(this);
	}
	toData() {
		return {
			facet: this.facet.value,
			manifest: this.manifest,
			policy: this.policy,
			selected: this.selected,
			substrate: this.substrate,
			trust: this.trust
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Placement pin");
		requireExactFields(object, [
			"facet",
			"manifest",
			"policy",
			"selected",
			"substrate",
			"trust"
		], [], "Placement pin");
		return new PlacementPin({
			facet: new FacetRef(requireString(object["facet"], "Placement Facet")),
			manifest: modesFromData(object["manifest"], "Manifest modes"),
			policy: modesFromData(object["policy"], "Policy modes"),
			substrate: modesFromData(object["substrate"], "Substrate modes"),
			trust: modesFromData(object["trust"], "Trust modes"),
			selected: requireIsolationMode(object["selected"], "Selected mode")
		});
	}
};
var TurnPlacementSnapshot = class TurnPlacementSnapshot extends CodecRecord {
	static get codec() {
		return TurnPlacementSnapshotCodec;
	}
	turn;
	pins;
	placements;
	digest;
	constructor(turn, pins, placements) {
		super();
		const canonical = [...placements].map((placement) => PlacementPin.fromData(placement.toData())).sort((left, right) => compareCanonicalText(left.facet.value, right.facet.value));
		if (new Set(canonical.map((placement) => placement.facet.value)).size !== canonical.length) throw new TypeError("Turn placement Facet references must be unique");
		this.turn = turn;
		this.pins = RunPinsCodec.decode(RunPinsCodec.encode(pins));
		this.placements = Object.freeze(canonical);
		this.digest = Digest.sha256(encodeCanonicalJson(this.toData()));
		Object.freeze(this);
	}
	/**
	* The Turn's FacetSet (SPEC §4.1, §5.3): the canonical-ordered, unique FacetRef
	* membership of the Turn's one composition view. The constructor already canonicalizes
	* and deduplicates `placements`, so this reads the captured record rather than holding a
	* second membership list beside it. A second list is what would make the Turn compose
	* two views, and §5.3 fixes it to one, which is why this is a derivation and never a
	* stored field.
	*/
	get facetSet() {
		return Object.freeze(this.placements.map((placement) => placement.facet));
	}
	/**
	* Whether the Turn composes this Facet, answered from the captured set. Every membership
	* question goes through here, so no caller can answer one from the Scope's current
	* install records and get a different answer for the same Turn.
	*/
	composes(facet) {
		return this.placements.some((placement) => placement.facet.equals(facet));
	}
	toData() {
		return {
			pins: this.pins.toData(),
			placements: this.placements.map((placement) => placement.toData()),
			turn: this.turn.value
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Turn placement snapshot");
		requireExactFields(object, [
			"pins",
			"placements",
			"turn"
		], [], "Turn placement snapshot");
		return new TurnPlacementSnapshot(new TurnId(requireString(object["turn"], "Placement Turn")), RunPins.fromData(object["pins"]), requireArray(object["placements"], "Placement entries").map(PlacementPin.fromData));
	}
};
var PlacementSnapshotCodec = class extends RecordCodec {
	constructor() {
		super([
			TurnPlacementSnapshot,
			PlacementPin,
			Revision,
			TextId,
			SemVer,
			RunPins,
			PackagePin,
			BlueprintPin,
			Digest,
			TurnId,
			AgentId,
			CodecRecord,
			ModelPolicyId,
			EnvironmentId,
			AgentPolicyId,
			FacetRef,
			FacetPackageId,
			PackageId,
			PlacementIntersection
		], "turn.placement-snapshot", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return TurnPlacementSnapshot.fromData(value);
	}
};
var TurnPlacementSnapshotCodec = new PlacementSnapshotCodec();
function canonicalModes(modes, subject) {
	if (modes.length === 0 || new Set(modes).size !== modes.length) throw new TypeError(`${subject} must be nonempty and unique`);
	if (modes.some((mode) => !PLACEMENT_PREFERENCE.includes(mode))) throw new TypeError(`${subject} contains an unknown mode`);
	return Object.freeze(PLACEMENT_PREFERENCE.filter((mode) => modes.includes(mode)));
}
function modesFromData(value, subject) {
	return requireArray(value, subject).map((entry) => requireIsolationMode(entry, subject));
}
function requireIsolationMode(value, subject) {
	if (isMember(PLACEMENT_PREFERENCE, value)) return value;
	throw new TypeError(`${subject} contains an unknown isolation mode`);
}
//#endregion
//#region src/agents/runs/outcome.ts
var TERMINAL_OUTCOMES = Object.freeze([
	"succeeded",
	"failed",
	"cancelled"
]);
function requireTerminalOutcome$1(value, subject) {
	if (isMember(TERMINAL_OUTCOMES, value)) return value;
	throw new TypeError(`${subject} is invalid`);
}
//#endregion
//#region src/agents/runs/settlement.ts
var SettlementObligation = class SettlementObligation extends CodecRecord {
	static get codec() {
		return SettlementObligationCodec;
	}
	registryEpoch;
	obligations;
	requiredAudits;
	constructor(init) {
		super();
		if (!Number.isSafeInteger(init.registryEpoch) || init.registryEpoch < 0) throw new TypeError("Settlement registry epoch must be a non-negative safe integer");
		const obligations = [...init.obligations].map(copyRunObligation).sort((left, right) => compareCanonicalText(runObligationKey(left), runObligationKey(right)));
		if (new Set(obligations.map(runObligationKey)).size !== obligations.length) throw new TypeError("Settlement obligations must have unique canonical identities");
		this.registryEpoch = init.registryEpoch;
		this.obligations = Object.freeze(obligations);
		this.requiredAudits = deriveRequiredAudits(obligations);
		Object.freeze(this);
	}
	toData() {
		return {
			obligations: this.obligations.map(runObligationData),
			registryEpoch: this.registryEpoch
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Settlement obligation");
		requireExactFields(object, ["obligations", "registryEpoch"], [], "Settlement obligation");
		return new SettlementObligation({
			registryEpoch: requireInteger(object["registryEpoch"], "Settlement registry epoch"),
			obligations: requireArray(object["obligations"], "Settlement obligations").map(decodeRunObligation)
		});
	}
};
var SettlementObligationRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			SettlementObligation,
			CodecRecord,
			ApprovalId,
			InvocationId,
			AcceptanceId,
			RouteReservationId,
			RunCommitId,
			TextId,
			EffectAttemptId
		], "run.settlement-obligation", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return SettlementObligation.fromData(value);
	}
};
var SettlementObligationCodec = new SettlementObligationRecordCodec();
var TerminalSnapshot = class TerminalSnapshot extends CodecRecord {
	run;
	turn;
	preterminal;
	terminalCommit;
	outcome;
	obligation;
	exhausted;
	static get codec() {
		return TerminalSnapshotCodec;
	}
	#recordedAt;
	constructor(run, turn, preterminal, terminalCommit, outcome, obligation, recordedAt, exhausted = void 0) {
		super();
		this.run = run;
		this.turn = turn;
		this.preterminal = preterminal;
		this.terminalCommit = terminalCommit;
		this.outcome = outcome;
		this.obligation = obligation;
		this.exhausted = exhausted;
		if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "cancelled") throw new TypeError("Run outcome is invalid");
		if (exhausted !== void 0 && outcome !== "cancelled") throw new TypeError("Resource exhaustion terminalizes a Run as cancelled");
		if (!Number.isFinite(recordedAt.getTime())) throw new TypeError("Terminal time is invalid");
		this.#recordedAt = recordedAt.getTime();
		Object.freeze(this);
	}
	get recordedAt() {
		return new Date(this.#recordedAt);
	}
	toData() {
		return {
			exhausted: this.exhausted ?? null,
			obligation: this.obligation.toData(),
			outcome: this.outcome,
			preterminal: this.preterminal.value,
			recordedAt: this.#recordedAt,
			run: this.run.value,
			terminalCommit: this.terminalCommit.value,
			turn: this.turn.value
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Terminal snapshot");
		requireExactFields(object, [
			"exhausted",
			"obligation",
			"outcome",
			"preterminal",
			"recordedAt",
			"run",
			"terminalCommit",
			"turn"
		], [], "Terminal snapshot");
		return new TerminalSnapshot(new RunId(requireString(object["run"], "Terminal Run")), new TurnId(requireString(object["turn"], "Terminal Turn")), new RunCommitId(requireString(object["preterminal"], "Preterminal commit")), new RunCommitId(requireString(object["terminalCommit"], "Terminal commit")), requireTerminalOutcome$1(object["outcome"], "Run outcome"), SettlementObligation.fromData(object["obligation"]), requireTimestamp(object["recordedAt"], "Terminal timestamp"), object["exhausted"] === null ? void 0 : requireResourceDimension(object["exhausted"], "Terminal exhausted dimension"));
	}
};
var TerminalSnapshotRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			TerminalSnapshot,
			TextId,
			SettlementObligation,
			RunId,
			RunCommitId,
			TurnId,
			CodecRecord,
			ApprovalId,
			InvocationId,
			AcceptanceId,
			RouteReservationId,
			EffectAttemptId
		], "run.terminal-snapshot", {
			major: 3,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return TerminalSnapshot.fromData(value);
	}
};
var TerminalSnapshotCodec = new TerminalSnapshotRecordCodec();
var SettlementEvidencePort = class {};
function isSettled(transaction, obligation, evidence) {
	return obligation.obligations.every((value) => {
		switch (value.kind) {
			case "approval": return requireSynchronousResult(evidence.approvalResolved(transaction, value.approval)) === true;
			case "invocationItem": return requireSynchronousResult(evidence.invocationItemTerminal(transaction, value.invocation, value.itemIndex, value.itemKey)) === true;
			case "route": return requireSynchronousResult(evidence.routeTerminal(transaction, value.reservation)) === true;
			case "reconciliation": return requireSynchronousResult(evidence.reconciliationSuperseded(transaction, value.attempt)) === true;
			case "systemCommit": return requireSynchronousResult(evidence.commitExists(transaction, value.commit)) === true;
			case "acceptance": return requireSynchronousResult(evidence.acceptanceSatisfied(transaction, value.acceptance)) === true;
		}
	}) && obligation.requiredAudits.every((value) => requireSynchronousResult(evidence.auditSatisfied(transaction, value)) === true);
}
/**
* The required-audit set is a structural projection of the closed registry frontier: every
* captured obligation that terminates in a Receipt, route delivery, or system commit implies
* exactly one audit obligation. Deriving it here — rather than accepting it from the caller —
* makes an incomplete audit set unrepresentable, so a Run can never settle with an
* audit-bearing obligation left unaudited. Async evidence arriving later is fine: the derived
* obligation simply stays unsatisfied until `isSettled` re-evaluates it against the port.
*/
function deriveRequiredAudits(obligations) {
	const audits = obligations.flatMap((obligation) => {
		switch (obligation.kind) {
			case "invocationItem": return [Object.freeze({
				kind: "receipt",
				invocation: obligation.invocation,
				itemIndex: obligation.itemIndex,
				itemKey: obligation.itemKey
			})];
			case "route": return [Object.freeze({
				kind: "delivery",
				reservation: obligation.reservation
			})];
			case "systemCommit": return [Object.freeze({
				kind: "commit",
				id: obligation.commit
			})];
			default: return [];
		}
	});
	return Object.freeze(audits.sort((left, right) => compareCanonicalText(left.kind, right.kind)));
}
//#endregion
//#region src/agents/runs/invocation-delivery.ts
var DELIVERY_DOMAIN = "agent-core.run-invocation-delivery.v1";
/**
* Why the Run addresses the Invocation owner about one published item (SPEC §5.6).
*
* The two cases are separate classes because they carry different facts, not because a
* reader has to remember what a label means. An admission names nothing else: the Run has
* taken the item into its own obligation and the Invocation owner may start the work.
* A cancellation names the terminal commit the Run ended on, so the owner can read the
* exact terminalization the request came from rather than trust that one happened.
*
* Neither case carries a failure kind, and there is no field one could travel in. §7.4
* builds `aborted` only from cancellation that reached the attempt, and the Run is not the
* party that observes that: it observes its own end. A request from here is therefore a
* request, and the Invocation owner's own target observation is what classifies the
* attempt. A Run that shipped a verdict would be asserting a fact about a live controller
* it cannot see, including after a restart that left no controller at all.
*/
var RunInvocationDeliveryCause = class RunInvocationDeliveryCause {
	/** The Run took the published item into its own obligation. */
	static get admission() {
		return admissionCause;
	}
	/** The Run ended at this exact terminal commit while the item was still owed. */
	static cancellation(terminalCommit) {
		return new CancellationCause(terminalCommit);
	}
	equals(other) {
		if (!(other instanceof RunInvocationDeliveryCause) || other.kind !== this.kind) return false;
		const mine = this.terminalCommit;
		return mine === void 0 ? other.terminalCommit === void 0 : other.terminalCommit?.equals(mine) === true;
	}
	static fromData(value) {
		const object = requireObject(value, "Run invocation delivery cause");
		const kind = requireString(object["kind"], "Run invocation delivery cause kind");
		if (kind === "admission") {
			requireExactFields(object, ["kind"], [], "Run invocation admission cause");
			return RunInvocationDeliveryCause.admission;
		}
		if (kind === "cancellation") {
			requireExactFields(object, ["kind", "terminalCommit"], [], "Run invocation cancellation cause");
			return RunInvocationDeliveryCause.cancellation(new RunCommitId(requireString(object["terminalCommit"], "Run invocation cancellation commit")));
		}
		throw new TypeError("Run invocation delivery cause kind is invalid");
	}
};
/**
* Exported for one reason: a codec that embeds a delivery seals every class its encoded graph
* reaches, and the project's codec rule admits only explicitly named classes. Nothing
* constructs these directly — the factories on the base class are the way in.
*/
var AdmissionCause = class extends RunInvocationDeliveryCause {
	kind = "admission";
	terminalCommit = void 0;
	toData() {
		return { kind: this.kind };
	}
};
var CancellationCause = class extends RunInvocationDeliveryCause {
	terminalCommit;
	kind = "cancellation";
	constructor(terminalCommit) {
		super();
		this.terminalCommit = terminalCommit;
		if (terminalCommit.constructor !== RunCommitId) throw new TypeError("Run invocation cancellation names its exact terminal commit");
		Object.freeze(this);
	}
	toData() {
		return {
			kind: this.kind,
			terminalCommit: this.terminalCommit.value
		};
	}
};
var admissionCause = Object.freeze(new AdmissionCause());
/**
* One message the Run owes the Invocation owner about one published item (SPEC §5.6, §6.1).
*
* There is no cross-Actor transaction, so a message that existed only in the response to
* the Run transaction would be lost by a lost response: terminalization cannot run twice on
* a terminal Run, and publication cannot be replayed from a Turn that has ended. The
* message is therefore a durable record the Run keeps until the owner acknowledges it, and
* delivery is at-least-once with the record as the replay source.
*
* The identity is derived from every field, so the same publication or the same
* terminalization produces the same message rather than a second one, and a forged
* acknowledgement cannot discharge a message the Run never wrote. It names the exact
* `EffectAttempt` because that is what the owner re-reads its own state against: an item
* whose attempt has moved on is a different attempt, and this message says nothing about it.
*/
var RunInvocationDelivery = class RunInvocationDelivery extends CodecRecord {
	static get codec() {
		return RunInvocationDeliveryCodec;
	}
	id;
	run;
	invocation;
	itemIndex;
	itemKey;
	attempt;
	cause;
	constructor(init) {
		super();
		if (init.run.constructor !== RunId || init.invocation.constructor !== InvocationId || init.attempt.constructor !== EffectAttemptId) throw new TypeError("Run invocation delivery identifiers use exact context classes");
		if (!Number.isSafeInteger(init.itemIndex) || init.itemIndex < 0) throw new TypeError("Run invocation delivery item index is invalid");
		if (init.itemKey.length === 0 || init.itemKey !== init.itemKey.trim()) throw new TypeError("Run invocation delivery item key must be canonical");
		if (!(init.cause instanceof RunInvocationDeliveryCause)) throw new TypeError("Run invocation delivery requires its exact cause");
		this.run = init.run;
		this.invocation = init.invocation;
		this.itemIndex = init.itemIndex;
		this.itemKey = init.itemKey;
		this.attempt = init.attempt;
		this.cause = init.cause;
		this.id = Digest.sha256(encodeCanonicalJson({
			attempt: this.attempt.value,
			cause: this.cause.toData(),
			domain: DELIVERY_DOMAIN,
			invocation: this.invocation.value,
			itemIndex: this.itemIndex,
			itemKey: this.itemKey,
			run: this.run.value
		}));
		Object.freeze(this.id);
		Object.freeze(this);
	}
	/** Every field decides the identity, so equal identity is equal content. */
	equals(other) {
		return other instanceof RunInvocationDelivery && other.id.equals(this.id);
	}
	toData() {
		return {
			attempt: this.attempt.value,
			cause: this.cause.toData(),
			id: this.id.value,
			invocation: this.invocation.value,
			itemIndex: this.itemIndex,
			itemKey: this.itemKey,
			run: this.run.value
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Run invocation delivery");
		requireExactFields(object, [
			"attempt",
			"cause",
			"id",
			"invocation",
			"itemIndex",
			"itemKey",
			"run"
		], [], "Run invocation delivery");
		const record = new RunInvocationDelivery({
			run: new RunId(requireString(object["run"], "Run invocation delivery Run")),
			invocation: new InvocationId(requireString(object["invocation"], "Run invocation delivery Invocation")),
			itemIndex: requireInteger(object["itemIndex"], "Run invocation delivery item index"),
			itemKey: requireString(object["itemKey"], "Run invocation delivery item key"),
			attempt: new EffectAttemptId(requireString(object["attempt"], "Run invocation delivery EffectAttempt")),
			cause: RunInvocationDeliveryCause.fromData(object["cause"] ?? null)
		});
		if (record.id.value !== requireString(object["id"], "Run invocation delivery ID")) throw new TypeError("Run invocation delivery ID does not match its own content");
		return record;
	}
};
var RunInvocationDeliveryRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			RunInvocationDelivery,
			RunInvocationDeliveryCause,
			AdmissionCause,
			CancellationCause,
			CodecRecord,
			Digest,
			TextId,
			RunId,
			RunCommitId,
			InvocationId,
			EffectAttemptId
		], "run.invocation-delivery", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return RunInvocationDelivery.fromData(value);
	}
};
var RunInvocationDeliveryCodec = new RunInvocationDeliveryRecordCodec();
/**
* The Run's pending messages in one canonical order, with no message twice.
*
* The order is by derived identity rather than by arrival, because arrival order is not a
* fact the record keeps and two hosts replaying the same outbox must read the same
* sequence. Acknowledged messages are removed instead of marked: the message is a command,
* and what durably records that the command existed is the Run's own admission obligation
* and terminal snapshot, plus the Invocation owner's Receipt. Keeping discharged commands
* would grow the Run record without bound and add a second place to ask whether an item
* was addressed.
*/
function canonicalDeliveries(deliveries) {
	const ordered = [...deliveries].sort((left, right) => compareCanonicalText(left.id.value, right.id.value));
	let previous;
	for (const delivery of ordered) {
		if (previous?.id.equals(delivery.id) === true) throw new TypeError("Run invocation delivery outbox holds one message twice");
		previous = delivery;
	}
	return Object.freeze(ordered);
}
//#endregion
//#region src/agents/runs/run.ts
var RunLifecycle = class {
	static get active() {
		return activeRun;
	}
	static terminal(exhausted) {
		return new TerminalRun(exhausted);
	}
};
var ActiveRun = class extends RunLifecycle {
	kind = "active";
	exhausted = void 0;
};
var TerminalRun = class extends RunLifecycle {
	exhausted;
	kind = "terminal";
	constructor(exhausted = void 0) {
		super();
		this.exhausted = exhausted;
		Object.freeze(this);
	}
};
var Run = class Run extends CodecRecord {
	static get codec() {
		return RunCodec;
	}
	id;
	agent;
	configuration;
	configurations;
	root;
	initialBranch;
	parent;
	lifecycle;
	terminal;
	tokensConsumed;
	costConsumed;
	deliveries;
	revision;
	constructor(init) {
		super();
		this.id = init.id;
		this.agent = init.agent;
		this.configuration = init.configuration;
		const configurations = [...init.configurations ?? [init.configuration]];
		if (configurations.length === 0 || !configurations[0].equals(init.configuration) || new Set(configurations.map((value) => value.value)).size !== configurations.length) throw new TypeError("Run configuration history must begin with one unique genesis snapshot");
		this.configurations = Object.freeze(configurations);
		this.root = init.root;
		this.initialBranch = init.initialBranch;
		this.parent = init.parent;
		this.terminal = init.terminal;
		const tokensConsumed = init.tokensConsumed ?? 0;
		if (!Number.isSafeInteger(tokensConsumed) || tokensConsumed < 0) throw new TypeError("Run token total must be a non-negative safe integer");
		this.tokensConsumed = tokensConsumed;
		if (init.costConsumed !== void 0 && init.costConsumed.constructor !== RealizedCost) throw new TypeError("Run cost total must use the exact context class");
		this.costConsumed = init.costConsumed;
		this.deliveries = canonicalDeliveries(init.deliveries ?? []);
		for (const delivery of this.deliveries) if (!delivery.run.equals(init.id)) throw new TypeError("Run invocation delivery belongs to a different Run");
		this.lifecycle = init.terminal === void 0 ? RunLifecycle.active : RunLifecycle.terminal(init.terminal.exhausted);
		this.revision = init.revision;
		if (this.terminal !== void 0 && !this.terminal.run.equals(this.id)) throw new TypeError("Terminal snapshot belongs to a different Run");
		Object.freeze(this);
	}
	/**
	* Terminalizes the Run and, in the same transition, takes on the cancellation messages
	* its still-owed published items are owed (SPEC §5.2, §5.6). The messages arrive here
	* rather than through a later call because a terminal Run admits no second
	* terminalization: a message appended afterwards could be lost by exactly the response
	* loss it exists to survive.
	*/
	terminalize(snapshot, cancellations = []) {
		if (!snapshot.run.equals(this.id)) throw new AgentCoreError("run.invalid-state", "Terminal snapshot belongs to another Run");
		if (this.lifecycle.kind !== "active") throw new AgentCoreError("run.invalid-state", "Terminal Runs cannot transition");
		for (const delivery of cancellations) if (delivery.cause.kind !== "cancellation" || delivery.cause.terminalCommit?.equals(snapshot.terminalCommit) !== true) throw new AgentCoreError("run.invalid-state", "A Run cancellation message names the exact terminal commit it ended on");
		return this.transition({
			terminal: snapshot,
			deliveries: [...this.deliveries, ...cancellations]
		});
	}
	/**
	* Takes on the message a published item's Invocation owner is owed once the Run holds
	* that item as its own obligation (SPEC §5.6). Publishing the same handle again is the
	* same message, so it changes nothing rather than owing the owner a second one.
	*/
	publishDelivery(delivery) {
		if (this.lifecycle.kind !== "active") throw new AgentCoreError("run.invalid-state", "Terminal Runs publish no further admission");
		if (!delivery.run.equals(this.id)) throw new AgentCoreError("run.invalid-state", "Run invocation delivery belongs to another Run");
		if (delivery.cause.kind !== "admission") throw new AgentCoreError("run.invalid-state", "Publishing a handle owes its owner an admission message");
		if (this.deliveries.some((pending) => pending.id.equals(delivery.id))) return this;
		return this.transition({ deliveries: [...this.deliveries, delivery] });
	}
	/**
	* Discharges one message its Invocation owner has acknowledged (SPEC §5.6, §6.1).
	*
	* Delivery is at-least-once, so a repeated acknowledgement is the ordinary case rather
	* than an error: the first one removed the message, and a second finds nothing to
	* remove and says so by changing nothing. A message of another Run is refused, because
	* that is a caller addressing state it does not hold rather than a duplicate.
	*
	* A terminal Run accepts this. A discharged message changes no lifecycle, and a
	* cancellation message exists only on a Run that has already ended.
	*/
	acknowledgeDelivery(delivery) {
		if (!delivery.run.equals(this.id)) throw new AgentCoreError("run.invalid-state", "Run invocation delivery belongs to another Run");
		const remaining = this.deliveries.filter((pending) => !pending.id.equals(delivery.id));
		if (remaining.length === this.deliveries.length) return this;
		return this.transition({ deliveries: remaining });
	}
	revise() {
		if (this.lifecycle.kind !== "active") throw new AgentCoreError("run.invalid-state", "Terminal Runs reject ordinary mutations");
		return this.transition();
	}
	recordEvidence() {
		if (this.lifecycle.kind !== "terminal") throw new AgentCoreError("run.invalid-state", "Only terminal Runs record captured evidence");
		return this.transition();
	}
	/**
	* One model call's consumption, accumulated where that call commits (SPEC §5.1, §5.2).
	* `tokens` and `costMicros` are the two ceiling dimensions with no derivation, and both
	* advance in this one transition, so a reader never sees a Run whose token total says a
	* call happened while its cost total says it did not.
	*
	* A host with no realized cost passes none, which leaves `costMicros` unbounded rather
	* than recording a zero that reads as a measured total. When a cost is present, the
	* caller supplies every currency the Run's lineage already records cost in, and this path
	* refuses to disagree with any of them: a comparison between amounts in two currencies is
	* not a comparison, and a ceiling is nothing but that comparison. The rule is about the
	* lineage and not about the order its Runs recorded in — a currency an ancestor or a
	* descendant already holds binds this cost the same way, whichever recorded first — and a
	* refusal moves neither total. A lineage that holds no currency adopts this cost's, and
	* every later cost in it answers to that.
	*/
	recordModelUsage(tokens, cost, lineageCurrencies) {
		if (this.lifecycle.kind !== "active") throw new AgentCoreError("run.invalid-state", "Terminal Runs consume no further resources");
		const consumed = this.tokensConsumed + requireTokenUsage(tokens);
		if (cost === void 0) return this.transition({ tokensConsumed: consumed });
		const held = this.costConsumed === void 0 ? lineageCurrencies : [this.costConsumed.currency, ...lineageCurrencies];
		const divergent = [...new Set(held.filter((currency) => !currency.equals(cost.currency)).map((currency) => currency.value))].sort(compareCanonicalText);
		if (divergent.length > 0) throw new AgentCoreError("run.invalid-state", `Run lineage records cost in ${divergent.join(", ")}, not ${cost.currency.value}`);
		return this.transition({
			tokensConsumed: consumed,
			costConsumed: new RealizedCost((this.costConsumed?.micros ?? 0) + cost.micros, cost.currency)
		});
	}
	recordConfiguration(configuration) {
		if (this.lifecycle.kind !== "active") throw new AgentCoreError("run.invalid-state", "Terminal Runs reject configuration migration");
		if (this.configurations.some((value) => value.equals(configuration))) return this;
		return this.transition({ configurations: [...this.configurations, configuration] });
	}
	toData() {
		return {
			agent: this.agent.value,
			configuration: this.configuration.value,
			configurations: this.configurations.map((value) => value.value),
			id: this.id.value,
			initialBranch: this.initialBranch.value,
			parent: this.parent?.value ?? null,
			revision: revisionData(this.revision),
			root: this.root.value,
			deliveries: this.deliveries.map((delivery) => delivery.toData()),
			terminal: this.terminal === void 0 ? null : this.terminal.toData(),
			costConsumed: this.costConsumed === void 0 ? null : this.costConsumed.toData(),
			tokensConsumed: this.tokensConsumed
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Run");
		requireExactFields(object, [
			"agent",
			"configuration",
			"configurations",
			"costConsumed",
			"deliveries",
			"id",
			"initialBranch",
			"parent",
			"revision",
			"root",
			"terminal",
			"tokensConsumed"
		], [], "Run");
		const parent = requireOptionalString(object["parent"], "Parent Run");
		return new Run({
			id: new RunId(requireString(object["id"], "Run ID")),
			agent: new AgentId(requireString(object["agent"], "Run Agent")),
			configuration: digestFromData(object["configuration"], "Run configuration"),
			configurations: requireArray(object["configurations"], "Run configurations").map((entry) => digestFromData(entry, "Run configuration history")),
			root: new RunCommitId(requireString(object["root"], "Run root")),
			initialBranch: new RunBranchId(requireString(object["initialBranch"], "Initial branch")),
			parent: parent === void 0 ? void 0 : new RunId(parent),
			terminal: object["terminal"] === null ? void 0 : TerminalSnapshot.fromData(object["terminal"]),
			deliveries: requireArray(object["deliveries"], "Run invocation deliveries").map((entry) => RunInvocationDelivery.fromData(entry)),
			tokensConsumed: requireInteger(object["tokensConsumed"], "Run token total"),
			costConsumed: object["costConsumed"] === null ? void 0 : RealizedCost.fromData(object["costConsumed"] ?? null),
			revision: revisionFromData(object["revision"], "Run revision")
		});
	}
	transition(changes = {}) {
		return new Run({
			id: this.id,
			agent: this.agent,
			configuration: this.configuration,
			configurations: changes.configurations ?? this.configurations,
			root: this.root,
			initialBranch: this.initialBranch,
			parent: this.parent,
			terminal: changes.terminal ?? this.terminal,
			tokensConsumed: changes.tokensConsumed ?? this.tokensConsumed,
			costConsumed: changes.costConsumed ?? this.costConsumed,
			deliveries: changes.deliveries ?? this.deliveries,
			revision: nextRunRevision(this.revision)
		});
	}
};
var RunRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			Run,
			Revision,
			TextId,
			SettlementObligation,
			TerminalSnapshot,
			Digest,
			RunLifecycle,
			RunId,
			AgentId,
			RunCommitId,
			TurnId,
			RunBranchId,
			RunInvocationDelivery,
			RunInvocationDeliveryCause,
			AdmissionCause,
			CancellationCause,
			CodecRecord,
			TerminalRun,
			ApprovalId,
			InvocationId,
			AcceptanceId,
			RouteReservationId,
			EffectAttemptId,
			RealizedCost,
			Currency
		], "run.record", {
			major: 4,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return Run.fromData(value);
	}
};
var RunCodec = new RunRecordCodec();
var RunBranch = class RunBranch extends CodecRecord {
	id;
	run;
	name;
	head;
	revision;
	rewrite;
	static get codec() {
		return RunBranchCodec;
	}
	constructor(id, run, name, head, revision, rewrite) {
		super();
		this.id = id;
		this.run = run;
		this.name = name;
		this.head = head;
		this.revision = revision;
		this.rewrite = rewrite;
		if (name.trim().length === 0) throw new TypeError("Run branch name must not be blank");
		if (rewrite?.equals(head) === true) throw new TypeError("Run branch cannot reserve a rewrite it already holds as head");
		Object.freeze(this);
	}
	/** Advancing onto the reserved rewrite closes the reservation, by identity. */
	advance(head) {
		return new RunBranch(this.id, this.run, this.name, head, nextRunRevision(this.revision), this.rewrite?.equals(head) === true ? void 0 : this.rewrite);
	}
	reserveRewrite(commit) {
		if (this.rewrite !== void 0) throw new AgentCoreError("run.invalid-state", "Run branch already holds an uncompleted rewrite reservation");
		return new RunBranch(this.id, this.run, this.name, this.head, nextRunRevision(this.revision), commit);
	}
	toData() {
		return {
			head: this.head.value,
			id: this.id.value,
			name: this.name,
			revision: revisionData(this.revision),
			rewrite: this.rewrite?.value ?? null,
			run: this.run.value
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Run branch");
		requireExactFields(object, [
			"head",
			"id",
			"name",
			"revision",
			"rewrite",
			"run"
		], [], "Run branch");
		const rewrite = requireOptionalString(object["rewrite"], "Run branch rewrite");
		return new RunBranch(new RunBranchId(requireString(object["id"], "Run branch ID")), new RunId(requireString(object["run"], "Run branch Run")), requireString(object["name"], "Run branch name"), new RunCommitId(requireString(object["head"], "Run branch head")), revisionFromData(object["revision"], "Run branch revision"), rewrite === void 0 ? void 0 : new RunCommitId(rewrite));
	}
};
var BranchCodec = class extends RecordCodec {
	constructor() {
		super([
			RunBranch,
			Revision,
			TextId,
			RunId,
			RunCommitId,
			RunBranchId,
			CodecRecord
		], "run.branch", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return RunBranch.fromData(value);
	}
};
var RunBranchCodec = new BranchCodec();
var activeRun = Object.freeze(new ActiveRun());
function requireTokenUsage(tokens) {
	if (!Number.isSafeInteger(tokens) || tokens < 0) throw new TypeError("Run token usage must be a non-negative safe integer");
	return tokens;
}
/**
* SPEC §8.5 gives a revision its own rejection outcome (`rejectedRevision`) beside the
* lifecycle one, and a revision that cannot advance is a fact about the revision rather than
* about the Run's state — so the ceiling is `protocol.revision-conflict`, exactly what
* `Revision.next` raises for the same condition. This wrapper exists only to name whose
* revision ran out; it never reports the condition differently from the one owner of
* revision advancement.
*/
function nextRunRevision(revision) {
	if (revision.value === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("protocol.revision-conflict", "Run revision is exhausted");
	return revision.next();
}
//#endregion
//#region src/agents/runs/generated/turn-status/AgentCore/Extract/TurnStatus.ts
/**
* Where a Turn is in its lifecycle (SPEC §5.3). `queued` and `suspended` are the two statuses
* a lease may be claimed from; `running` is the only status that may complete; the three
* terminal statuses admit no further move.
*/
var TurnStatus = class TurnStatus {
	static get queued() {
		return queuedTurnStatus;
	}
	static get running() {
		return runningTurnStatus;
	}
	static get suspended() {
		return suspendedTurnStatus;
	}
	static get succeeded() {
		return succeededTurnStatus;
	}
	static get failed() {
		return failedTurnStatus;
	}
	static get cancelled() {
		return cancelledTurnStatus;
	}
	static from(kind) {
		switch (kind) {
			case "queued": return TurnStatus.queued;
			case "running": return TurnStatus.running;
			case "suspended": return TurnStatus.suspended;
			case "succeeded": return TurnStatus.succeeded;
			case "failed": return TurnStatus.failed;
			case "cancelled": return TurnStatus.cancelled;
		}
	}
	static fromData(value) {
		switch (value) {
			case "queued": return TurnStatus.queued;
			case "running": return TurnStatus.running;
			case "suspended": return TurnStatus.suspended;
			case "succeeded": return TurnStatus.succeeded;
			case "failed": return TurnStatus.failed;
			case "cancelled": return TurnStatus.cancelled;
			default: throw new TypeError("TurnStatus data must name a constructor");
		}
	}
	toData() {
		return this.kind;
	}
	equals(other) {
		return this === other;
	}
};
var QueuedTurnStatus = class extends TurnStatus {
	kind = "queued";
	constructor() {
		super();
		Object.freeze(this);
	}
	cancelUnheld() {
		return {
			kind: "some",
			value: TurnStatus.cancelled
		};
	}
	claim() {
		return {
			kind: "some",
			value: TurnStatus.running
		};
	}
	completes() {
		return false;
	}
	suspend() {
		return { kind: "none" };
	}
	terminal() {
		return false;
	}
};
var RunningTurnStatus = class extends TurnStatus {
	kind = "running";
	constructor() {
		super();
		Object.freeze(this);
	}
	cancelUnheld() {
		return { kind: "none" };
	}
	claim() {
		return { kind: "none" };
	}
	completes() {
		return true;
	}
	suspend() {
		return {
			kind: "some",
			value: TurnStatus.suspended
		};
	}
	terminal() {
		return false;
	}
};
var SuspendedTurnStatus = class extends TurnStatus {
	kind = "suspended";
	constructor() {
		super();
		Object.freeze(this);
	}
	cancelUnheld() {
		return {
			kind: "some",
			value: TurnStatus.cancelled
		};
	}
	claim() {
		return {
			kind: "some",
			value: TurnStatus.running
		};
	}
	completes() {
		return false;
	}
	suspend() {
		return { kind: "none" };
	}
	terminal() {
		return false;
	}
};
var SucceededTurnStatus = class extends TurnStatus {
	kind = "succeeded";
	constructor() {
		super();
		Object.freeze(this);
	}
	cancelUnheld() {
		return { kind: "none" };
	}
	claim() {
		return { kind: "none" };
	}
	completes() {
		return false;
	}
	suspend() {
		return { kind: "none" };
	}
	terminal() {
		return true;
	}
};
var FailedTurnStatus = class extends TurnStatus {
	kind = "failed";
	constructor() {
		super();
		Object.freeze(this);
	}
	cancelUnheld() {
		return { kind: "none" };
	}
	claim() {
		return { kind: "none" };
	}
	completes() {
		return false;
	}
	suspend() {
		return { kind: "none" };
	}
	terminal() {
		return true;
	}
};
var CancelledTurnStatus = class extends TurnStatus {
	kind = "cancelled";
	constructor() {
		super();
		Object.freeze(this);
	}
	cancelUnheld() {
		return { kind: "none" };
	}
	claim() {
		return { kind: "none" };
	}
	completes() {
		return false;
	}
	suspend() {
		return { kind: "none" };
	}
	terminal() {
		return true;
	}
};
var queuedTurnStatus = new QueuedTurnStatus();
var runningTurnStatus = new RunningTurnStatus();
var suspendedTurnStatus = new SuspendedTurnStatus();
var succeededTurnStatus = new SucceededTurnStatus();
var failedTurnStatus = new FailedTurnStatus();
var cancelledTurnStatus = new CancelledTurnStatus();
/**
* The status a Turn reaches by ending with this outcome.
*/
function ofTerminalOutcome(outcome) {
	if (outcome === "succeeded") return TurnStatus.succeeded;
	if (outcome === "failed") return TurnStatus.failed;
	return TurnStatus.cancelled;
}
function requireTerminalOutcome(value, name) {
	if (value === "succeeded" || value === "failed" || value === "cancelled") return value;
	throw new TypeError(`${name} must name a TerminalOutcome`);
}
Object.freeze({ fromData(value) {
	return requireTerminalOutcome(value, "TerminalOutcome");
} });
//#endregion
//#region src/agents/runs/turn.ts
function admittedStatus(next, refusal) {
	if (next.kind === "some") return next.value;
	throw invalidTurn$2(refusal);
}
function completedStatus(status, outcome) {
	if (!status.completes()) throw invalidTurn$2(`Cannot complete a ${status.kind} Turn`);
	return ofTerminalOutcome(outcome);
}
var Turn = class Turn extends CodecRecord {
	static get codec() {
		return TurnCodec;
	}
	id;
	run;
	branch;
	startHead;
	effectiveInput;
	pins;
	placement;
	input;
	status;
	lease;
	checkpoint;
	result;
	cacheLineage;
	revision;
	constructor(init) {
		super();
		this.id = init.id;
		this.run = init.run;
		this.branch = init.branch;
		this.startHead = init.startHead;
		this.effectiveInput = init.effectiveInput;
		this.pins = RunPins.fromData(init.pins.toData());
		this.placement = init.placement;
		this.input = init.input;
		this.status = init.status ?? TurnStatus.queued;
		this.lease = init.lease ?? TurnLease.unclaimed(init.id);
		this.checkpoint = init.checkpoint;
		this.result = init.result;
		this.cacheLineage = init.cacheLineage === void 0 ? void 0 : Object.freeze({
			turn: init.cacheLineage.turn,
			promptPrefix: init.cacheLineage.promptPrefix
		});
		this.revision = init.revision;
		if (!this.lease.turn.equals(this.id)) throw new TypeError("Turn lease belongs to another Turn");
		if (this.status.kind === "queued" && (this.lease.holder !== void 0 || this.lease.epoch !== 0 || this.lease.expiresAt !== void 0)) throw new TypeError("Queued Turns require an unheld epoch-zero lease");
		if (this.status.kind === "running" && this.lease.holder === void 0) throw new TypeError("Running Turns require a held lease");
		if ((this.status.kind === "suspended" || this.status.terminal()) && this.lease.holder !== void 0) throw new TypeError("Suspended and terminal Turns must be unheld");
		if (this.status.kind === "suspended" && this.checkpoint === void 0) throw new TypeError("Suspended Turns require a checkpoint");
		if ((this.status.kind === "succeeded" || this.status.kind === "failed") && this.result === void 0) throw new TypeError("Succeeded and failed Turns require a result");
		Object.freeze(this);
	}
	claim(holder, now, expiresAt) {
		return this.transition({
			status: admittedStatus(this.status.claim(), `Cannot claim a ${this.status.kind} Turn`),
			lease: this.lease.claim(holder, now, expiresAt)
		});
	}
	renew(token, now, expiresAt) {
		if (this.status.kind !== "running") throw invalidTurn$2("Only running Turns can renew");
		this.requireToken(token, now);
		return this.transition({ lease: this.lease.renew(token.holder, token.epoch, now, expiresAt) });
	}
	reclaim(holder, now, expiresAt) {
		if (this.status.kind !== "running") throw invalidTurn$2("Only running Turns can be reclaimed");
		return this.transition({ lease: this.lease.reclaim(holder, now, expiresAt) });
	}
	suspend(token, checkpoint, now) {
		this.requireToken(token, now);
		return this.transition({
			status: admittedStatus(this.status.suspend(), `Cannot suspend a ${this.status.kind} Turn`),
			lease: this.lease.fence(),
			checkpoint
		});
	}
	complete(token, outcome, result, now) {
		this.requireToken(token, now);
		return this.transition({
			status: completedStatus(this.status, outcome),
			lease: this.lease.fence(),
			result
		});
	}
	cancelUnheld() {
		return this.transition({
			status: admittedStatus(this.status.cancelUnheld(), `Cannot cancel a ${this.status.kind} Turn without a token`),
			lease: this.lease.fence()
		});
	}
	forceCancel() {
		if (this.status.terminal() && this.lease.holder === void 0) return this;
		return this.transition({
			status: TurnStatus.cancelled,
			lease: this.lease.fence()
		});
	}
	revise() {
		return this.transition({});
	}
	requireToken(token, now) {
		if (this.status.kind !== "running" || !this.lease.admits(token, now)) throw new AgentCoreError("lease.invalid", "Turn mutation requires the exact current lease token");
	}
	toData() {
		return {
			branch: this.branch.value,
			cacheLineage: this.cacheLineage === void 0 ? null : {
				promptPrefix: this.cacheLineage.promptPrefix.value,
				turn: this.cacheLineage.turn.value
			},
			checkpoint: this.checkpoint?.value ?? null,
			effectiveInput: this.effectiveInput.value,
			id: this.id.value,
			input: this.input.value,
			lease: TurnLease.toData(this.lease),
			pins: this.pins.toData(),
			placement: this.placement.value,
			result: this.result?.value ?? null,
			revision: revisionData(this.revision),
			run: this.run.value,
			startHead: this.startHead.value,
			status: this.status.kind
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Turn");
		requireExactFields(object, [
			"branch",
			"cacheLineage",
			"checkpoint",
			"effectiveInput",
			"id",
			"input",
			"lease",
			"pins",
			"placement",
			"result",
			"revision",
			"run",
			"startHead",
			"status"
		], [], "Turn");
		const checkpoint = requireOptionalString(object["checkpoint"], "Turn checkpoint");
		const result = requireOptionalString(object["result"], "Turn result");
		const cacheLineage = object["cacheLineage"] === null ? void 0 : cacheLineageFromData(object["cacheLineage"]);
		return new Turn({
			id: new TurnId(requireString(object["id"], "Turn ID")),
			run: new RunId(requireString(object["run"], "Turn Run")),
			branch: new RunBranchId(requireString(object["branch"], "Turn branch")),
			startHead: new RunCommitId(requireString(object["startHead"], "Turn start head")),
			effectiveInput: new RunCommitId(requireString(object["effectiveInput"], "Turn effective input")),
			pins: RunPins.fromData(object["pins"]),
			placement: digestFromData(object["placement"], "Turn placement"),
			input: new ContentRef(requireString(object["input"], "Turn input")),
			status: requireTurnStatus(object["status"]),
			lease: TurnLease.fromData(object["lease"]),
			checkpoint: checkpoint === void 0 ? void 0 : new RunCheckpointId(checkpoint),
			result: result === void 0 ? void 0 : new ContentRef(result),
			cacheLineage,
			revision: revisionFromData(object["revision"], "Turn revision")
		});
	}
	transition(changes) {
		const status = changes.status ?? this.status;
		const lease = changes.lease ?? this.lease;
		const checkpoint = changes.checkpoint ?? this.checkpoint;
		const result = changes.result ?? this.result;
		return new Turn({
			id: this.id,
			run: this.run,
			branch: this.branch,
			startHead: this.startHead,
			effectiveInput: this.effectiveInput,
			pins: this.pins,
			placement: this.placement,
			input: this.input,
			status,
			lease,
			checkpoint,
			result,
			cacheLineage: this.cacheLineage,
			revision: nextTurnRevision(this.revision)
		});
	}
};
function turnContentRetention(value) {
	return contentRetentionFields([["input", value.input], ["result", value.result]]);
}
var TurnRecordCodec = class extends RecordCodec {
	constructor() {
		super([
			Turn,
			Revision,
			TextId,
			TurnStatus,
			QueuedTurnStatus,
			RunningTurnStatus,
			SuspendedTurnStatus,
			SucceededTurnStatus,
			FailedTurnStatus,
			CancelledTurnStatus,
			SemVer,
			TurnLease,
			RunPins,
			PackagePin,
			BlueprintPin,
			ContentRef,
			Digest,
			RunId,
			RunCommitId,
			TenantId,
			TurnId,
			RunBranchId,
			PrincipalId,
			AgentId,
			CodecRecord,
			RunCheckpointId,
			ModelPolicyId,
			EnvironmentId,
			ExactTurnLease,
			AgentPolicyId,
			PrincipalRef,
			PackageId
		], "turn.record", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return Turn.fromData(value);
	}
};
var TurnCodec = new TurnRecordCodec();
var RunCheckpoint = class RunCheckpoint extends CodecRecord {
	id;
	turn;
	commit;
	state;
	inboxCursor;
	tree;
	static get codec() {
		return RunCheckpointCodec;
	}
	constructor(id, turn, commit, state, inboxCursor, tree) {
		super();
		this.id = id;
		this.turn = turn;
		this.commit = commit;
		this.state = state;
		this.inboxCursor = inboxCursor;
		this.tree = tree;
		if (!Number.isSafeInteger(inboxCursor) || inboxCursor < 0) throw new TypeError("Checkpoint inbox cursor must be non-negative");
		Object.freeze(this);
	}
	toData() {
		return {
			commit: this.commit.value,
			id: this.id.value,
			inboxCursor: this.inboxCursor,
			state: this.state.value,
			tree: this.tree?.value ?? null,
			turn: this.turn.value
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Run checkpoint");
		requireExactFields(object, [
			"commit",
			"id",
			"inboxCursor",
			"state",
			"tree",
			"turn"
		], [], "Run checkpoint");
		const tree = requireOptionalString(object["tree"], "Checkpoint tree");
		return new RunCheckpoint(new RunCheckpointId(requireString(object["id"], "Checkpoint ID")), new TurnId(requireString(object["turn"], "Checkpoint Turn")), new RunCommitId(requireString(object["commit"], "Checkpoint commit")), new ContentRef(requireString(object["state"], "Checkpoint state")), requireInteger(object["inboxCursor"], "Checkpoint inbox cursor"), tree === void 0 ? void 0 : new ContentRef(tree));
	}
};
function runCheckpointContentRetention(value) {
	return contentRetentionFields([["state", value.state], ["tree", value.tree]]);
}
var CheckpointCodec = class extends RecordCodec {
	constructor() {
		super([
			RunCheckpoint,
			TextId,
			ContentRef,
			Digest,
			RunCommitId,
			RunCheckpointId,
			TurnId,
			CodecRecord
		], "run.checkpoint", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return RunCheckpoint.fromData(value);
	}
};
var RunCheckpointCodec = new CheckpointCodec();
var TurnInboxEntry = class TurnInboxEntry extends CodecRecord {
	id;
	turn;
	sequence;
	event;
	payload;
	payloadDigest;
	idempotencyKey;
	static get codec() {
		return TurnInboxEntryCodec;
	}
	#recordedAt;
	constructor(id, turn, sequence, event, payload, payloadDigest, idempotencyKey, cancellationToken, recordedAt) {
		super();
		this.id = id;
		this.turn = turn;
		this.sequence = sequence;
		this.event = event;
		this.payload = payload;
		this.payloadDigest = payloadDigest;
		this.idempotencyKey = idempotencyKey;
		if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError("Inbox sequence is invalid");
		if (event.length === 0 || idempotencyKey.length === 0) throw new TypeError("Inbox event and key are required");
		if (event === "turn.cancel" !== (cancellationToken !== void 0)) throw new TypeError("Only turn.cancel entries carry an exact cancellation token");
		if (cancellationToken !== void 0 && (!(cancellationToken.turn instanceof TurnId) || !(cancellationToken.holder instanceof PrincipalRef) || !cancellationToken.turn.equals(turn) || !Number.isSafeInteger(cancellationToken.epoch) || cancellationToken.epoch < 0)) throw new TypeError("Inbox cancellation token must name the exact Turn and valid epoch");
		if (!payload.digest.equals(payloadDigest)) throw new TypeError("Inbox payload digest must match its ContentRef");
		this.cancellationToken = cancellationToken === void 0 ? void 0 : Object.freeze({
			turn: cancellationToken.turn,
			holder: cancellationToken.holder,
			epoch: cancellationToken.epoch
		});
		this.#recordedAt = recordedAt.getTime();
		if (!Number.isFinite(this.#recordedAt)) throw new TypeError("Inbox timestamp is invalid");
		Object.freeze(this);
	}
	cancellationToken;
	get recordedAt() {
		return new Date(this.#recordedAt);
	}
	toData() {
		return {
			cancellationToken: this.cancellationToken === void 0 ? null : tokenData(this.cancellationToken),
			event: this.event,
			id: this.id.value,
			idempotencyKey: this.idempotencyKey,
			payload: this.payload.value,
			payloadDigest: this.payloadDigest.value,
			recordedAt: this.#recordedAt,
			sequence: this.sequence,
			turn: this.turn.value
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Turn inbox entry");
		requireExactFields(object, [
			"cancellationToken",
			"event",
			"id",
			"idempotencyKey",
			"payload",
			"payloadDigest",
			"recordedAt",
			"sequence",
			"turn"
		], [], "Turn inbox entry");
		return new TurnInboxEntry(new TurnInboxEntryId(requireString(object["id"], "Inbox entry ID")), new TurnId(requireString(object["turn"], "Inbox Turn")), requireInteger(object["sequence"], "Inbox sequence"), requireString(object["event"], "Inbox event"), new ContentRef(requireString(object["payload"], "Inbox payload")), digestFromData(object["payloadDigest"], "Inbox payload digest"), requireString(object["idempotencyKey"], "Inbox idempotency key"), object["cancellationToken"] === null ? void 0 : tokenFromData(object["cancellationToken"]), requireTimestamp(object["recordedAt"], "Inbox timestamp"));
	}
};
function turnInboxEntryContentRetention(value) {
	return contentRetentionFields([["payload", value.payload]]);
}
var InboxCodec = class extends RecordCodec {
	constructor() {
		super([
			TurnInboxEntry,
			TextId,
			ContentRef,
			Digest,
			TurnInboxEntryId,
			TenantId,
			TurnId,
			PrincipalId,
			CodecRecord,
			PrincipalRef
		], "turn.inbox-entry", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return TurnInboxEntry.fromData(value);
	}
};
var TurnInboxEntryCodec = new InboxCodec();
function cacheLineageFromData(value) {
	const object = requireObject(value, "Turn cache lineage");
	requireExactFields(object, ["promptPrefix", "turn"], [], "Turn cache lineage");
	return Object.freeze({
		turn: new TurnId(requireString(object["turn"], "Cache lineage Turn")),
		promptPrefix: digestFromData(object["promptPrefix"], "Cache lineage prompt prefix")
	});
}
function tokenData(token) {
	return leaseTokenToData(token);
}
function tokenFromData(value) {
	return leaseTokenFromData(value, "Cancellation token");
}
function requireTurnStatus(value) {
	if (value === "queued" || value === "running" || value === "suspended") return TurnStatus.from(value);
	return TurnStatus.from(requireTerminalOutcome$1(value, "Turn status"));
}
function invalidTurn$2(message) {
	return new AgentCoreError("turn.invalid-state", message);
}
function nextTurnRevision(revision) {
	if (revision.value === Number.MAX_SAFE_INTEGER) throw invalidTurn$2("Turn revision is exhausted");
	return revision.next();
}
//#endregion
//#region src/agents/runs/spawn.ts
var SpawnReservation = class SpawnReservation extends CodecRecord {
	id;
	parentRun;
	parentTurn;
	childRun;
	configuration;
	rootContent;
	invocation;
	receipt;
	attenuation;
	static get codec() {
		return SpawnReservationCodec;
	}
	#recordedAt;
	constructor(id, parentRun, parentTurn, childRun, token, configuration, rootContent, invocation, receipt, attenuation, recordedAt) {
		super();
		this.id = id;
		this.parentRun = parentRun;
		this.parentTurn = parentTurn;
		this.childRun = childRun;
		this.configuration = configuration;
		this.rootContent = rootContent;
		this.invocation = invocation;
		this.receipt = receipt;
		this.attenuation = attenuation;
		if (!(token.turn instanceof TurnId) || !token.turn.equals(parentTurn)) throw new TypeError("Spawn reservation token must name the spawning Turn");
		if (!(token.holder instanceof PrincipalRef) || !Number.isSafeInteger(token.epoch) || token.epoch < 0) throw new TypeError("Spawn reservation token epoch is invalid");
		if (parentRun.equals(childRun)) throw new TypeError("Spawn child Run must be distinct");
		this.token = Object.freeze({
			turn: token.turn,
			holder: token.holder,
			epoch: token.epoch
		});
		this.#recordedAt = recordedAt.getTime();
		if (!Number.isFinite(this.#recordedAt)) throw new TypeError("Spawn reservation time is invalid");
		Object.freeze(this);
	}
	token;
	get recordedAt() {
		return new Date(this.#recordedAt);
	}
	toData() {
		return {
			attenuation: this.attenuation.value,
			childRun: this.childRun.value,
			configuration: this.configuration.value,
			id: this.id.value,
			invocation: this.invocation.value,
			parentRun: this.parentRun.value,
			parentTurn: this.parentTurn.value,
			receipt: this.receipt.value,
			recordedAt: this.#recordedAt,
			rootContent: this.rootContent.value,
			token: leaseTokenToData(this.token)
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Spawn reservation");
		requireExactFields(object, [
			"attenuation",
			"childRun",
			"configuration",
			"id",
			"invocation",
			"parentRun",
			"parentTurn",
			"receipt",
			"recordedAt",
			"rootContent",
			"token"
		], [], "Spawn reservation");
		return new SpawnReservation(new SpawnReservationId(requireString(object["id"], "Spawn reservation ID")), new RunId(requireString(object["parentRun"], "Spawn parent Run")), new TurnId(requireString(object["parentTurn"], "Spawn parent Turn")), new RunId(requireString(object["childRun"], "Spawn child Run")), leaseTokenFromData(object["token"], "Spawn token"), digestFromData(object["configuration"], "Spawn configuration"), new ContentRef(requireString(object["rootContent"], "Spawn root content")), new InvocationId(requireString(object["invocation"], "Spawn Invocation")), new ReceiptId(requireString(object["receipt"], "Spawn Receipt")), digestFromData(object["attenuation"], "Spawn attenuation"), requireTimestamp(object["recordedAt"], "Spawn reservation timestamp"));
	}
};
function spawnReservationContentRetention(value) {
	return contentRetentionFields([["rootContent", value.rootContent]]);
}
var SpawnCodec = class extends RecordCodec {
	constructor() {
		super([
			SpawnReservation,
			TextId,
			ContentRef,
			Digest,
			RunId,
			InvocationId,
			ReceiptId,
			TenantId,
			SpawnReservationId,
			TurnId,
			PrincipalId,
			CodecRecord,
			PrincipalRef
		], "run.spawn-reservation", {
			major: 2,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return SpawnReservation.fromData(value);
	}
};
var SpawnReservationCodec = new SpawnCodec();
var RunSpawnPort = class {};
//#endregion
//#region src/agents/runs/forced-cancellation.ts
var ForcedCancellationCodec = class extends RecordCodec {
	constructor() {
		super([
			ForcedTurnCancellation,
			TextId,
			RunId,
			EventId,
			ReceiptId,
			AuditRecordId,
			TurnId,
			CodecRecord
		], "run.forced-turn-cancellation", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return ForcedTurnCancellation.fromData(value);
	}
};
var ForcedTurnCancellation = class ForcedTurnCancellation extends CodecRecord {
	static get codec() {
		return forcedTurnCancellationCodecInstance;
	}
	static encode(value) {
		return this.codec.encode(value);
	}
	static decode(bytes) {
		return this.codec.decode(bytes);
	}
	run;
	terminalTurn;
	turn;
	priorLeaseEpoch;
	fencedLeaseEpoch;
	controlReceipt;
	controlAudit;
	cancellationEvent;
	cancellationAudit;
	constructor(init) {
		super();
		if (init.run.constructor !== RunId || init.terminalTurn.constructor !== TurnId || init.turn.constructor !== TurnId || init.controlReceipt.constructor !== ReceiptId || init.controlAudit.constructor !== AuditRecordId || init.cancellationEvent.constructor !== EventId || init.cancellationAudit.constructor !== AuditRecordId) throw new TypeError("Forced cancellation identifiers must use exact context classes");
		if (init.terminalTurn.equals(init.turn)) throw new TypeError("Forced cancellation requires a distinct sibling Turn");
		if (!Number.isSafeInteger(init.priorLeaseEpoch) || init.priorLeaseEpoch < 0 || !Number.isSafeInteger(init.fencedLeaseEpoch) || init.fencedLeaseEpoch !== init.priorLeaseEpoch + 1) throw new TypeError("Forced cancellation requires one exact lease fence increment");
		this.run = init.run;
		this.terminalTurn = init.terminalTurn;
		this.turn = init.turn;
		this.priorLeaseEpoch = init.priorLeaseEpoch;
		this.fencedLeaseEpoch = init.fencedLeaseEpoch;
		this.controlReceipt = init.controlReceipt;
		this.controlAudit = init.controlAudit;
		this.cancellationEvent = init.cancellationEvent;
		this.cancellationAudit = init.cancellationAudit;
		Object.freeze(this);
	}
	toData() {
		return {
			cancellationAudit: this.cancellationAudit.value,
			cancellationEvent: this.cancellationEvent.value,
			controlAudit: this.controlAudit.value,
			controlReceipt: this.controlReceipt.value,
			fencedLeaseEpoch: this.fencedLeaseEpoch,
			priorLeaseEpoch: this.priorLeaseEpoch,
			run: this.run.value,
			terminalTurn: this.terminalTurn.value,
			turn: this.turn.value
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Forced Turn cancellation");
		requireExactFields(object, [
			"cancellationAudit",
			"cancellationEvent",
			"controlAudit",
			"controlReceipt",
			"fencedLeaseEpoch",
			"priorLeaseEpoch",
			"run",
			"terminalTurn",
			"turn"
		], [], "Forced Turn cancellation");
		return new ForcedTurnCancellation({
			run: new RunId(requireString(object["run"], "Forced cancellation Run")),
			terminalTurn: new TurnId(requireString(object["terminalTurn"], "Forced cancellation terminal Turn")),
			turn: new TurnId(requireString(object["turn"], "Forced cancellation sibling Turn")),
			priorLeaseEpoch: requireInteger(object["priorLeaseEpoch"], "Forced cancellation prior lease epoch"),
			fencedLeaseEpoch: requireInteger(object["fencedLeaseEpoch"], "Forced cancellation fenced lease epoch"),
			controlReceipt: new ReceiptId(requireString(object["controlReceipt"], "Forced cancellation control Receipt")),
			controlAudit: new AuditRecordId(requireString(object["controlAudit"], "Forced cancellation control Audit")),
			cancellationEvent: new EventId(requireString(object["cancellationEvent"], "Forced cancellation Event")),
			cancellationAudit: new AuditRecordId(requireString(object["cancellationAudit"], "Forced cancellation Audit"))
		});
	}
};
var forcedTurnCancellationCodecInstance = new ForcedCancellationCodec();
var ForcedTurnCancellationCodec = ForcedTurnCancellation.codec;
//#endregion
//#region src/agents/runs/store.ts
var RUN_RECORD_KINDS = Object.freeze([
	"configuration",
	"run",
	"branch",
	"commit",
	"turn",
	"placement",
	"checkpoint",
	"inbox",
	"spawn",
	"admission",
	"forcedCancellation",
	"acceptance",
	"verdict",
	"targetLeaseEvidence"
]);
var OpaqueRunTransaction = class {
	#opaque = true;
	constructor() {
		this.#opaque;
		Object.freeze(this);
	}
};
Object.freeze(OpaqueRunTransaction.prototype);
Object.freeze(OpaqueRunTransaction);
var ownedRunStorageBackends = /* @__PURE__ */ new WeakSet();
function ownRunStorageBackend(backend) {
	ownedRunStorageBackends.add(backend);
	return backend;
}
var RunStoragePort = class {
	tenant;
	owner;
	#backend;
	#clock;
	#transactionActive = false;
	constructor(tenant, owner, content, backend, clock = () => /* @__PURE__ */ new Date()) {
		this.tenant = tenant;
		this.owner = owner;
		if (!ownedRunStorageBackends.delete(backend)) throw new TypeError("Run storage backends must be created by the owning context");
		const contentFacade = Object.freeze(new RunContentStore(content, () => {
			if (this.#transactionActive) throw contentWriteDuringTransaction();
		}));
		Object.defineProperty(this, "content", {
			configurable: false,
			enumerable: true,
			value: contentFacade,
			writable: false
		});
		this.#backend = backend;
		this.#clock = clock;
		this.verifyContentCustody();
	}
	static createTransaction() {
		return new OpaqueRunTransaction();
	}
	transaction(operation, ...guard) {
		const alreadyActive = this.#transactionActive;
		this.#transactionActive = true;
		try {
			return this.#backend.transaction(operation, ...guard);
		} finally {
			this.#transactionActive = alreadyActive;
		}
	}
	get(transaction, kind, key) {
		return this.#backend.get(transaction, kind, key);
	}
	list(transaction, kind) {
		return this.#backend.list(transaction, kind);
	}
	insert(transaction, record) {
		this.mutate(transaction, () => {
			const previous = this.#backend.get(transaction, record.kind, record.key);
			this.#backend.validate(record);
			const before = previous === void 0 ? [] : contentOwnerEdges(this, previous);
			const after = contentOwnerEdges(this, record);
			this.#backend.insert(transaction, record);
			this.reconcileContentCustody(transaction, before, after);
		});
	}
	replace(transaction, record, expectedRevision) {
		this.mutate(transaction, () => {
			const previous = this.#backend.get(transaction, record.kind, record.key);
			this.#backend.validate(record);
			if (previous?.revision !== expectedRevision || record.revision !== expectedRevision + 1) throw new AgentCoreError("protocol.revision-conflict", "Run record revision changed");
			const before = previous === void 0 ? [] : contentOwnerEdges(this, previous);
			const after = contentOwnerEdges(this, record);
			this.#backend.replace(transaction, record, expectedRevision);
			this.reconcileContentCustody(transaction, before, after);
		});
	}
	insertParent(transaction, edge) {
		this.mutate(transaction, () => this.#backend.insertParent(transaction, edge));
	}
	parents(transaction, commit) {
		return this.#backend.parents(transaction, commit);
	}
	verifyContentCustody() {
		this.transaction((transaction) => {
			const expected = RUN_RECORD_KINDS.flatMap((kind) => this.#backend.list(transaction, kind).flatMap((record) => contentOwnerEdges(this, record)));
			this.#backend.verify(transaction, RUN_CONTENT_OWNER_PREFIXES, expected);
		});
	}
	mutate(transaction, operation) {
		try {
			operation();
		} catch (error) {
			this.#backend.poison(transaction, error instanceof Error ? error : nonErrorCustodyFailure());
		}
	}
	reconcileContentCustody(transaction, before, after) {
		const removed = before.filter((edge) => !after.some((candidate) => candidate.equals(edge)));
		if (removed.length === 0 && after.length === 0) return;
		const operationAt = requireOperationTime(this.#clock(), "Run content retention time");
		for (const edge of removed) this.#backend.release(transaction, edge, operationAt);
		for (const edge of after) this.#backend.retain(transaction, edge, operationAt);
	}
};
Object.freeze(RunStoragePort.prototype);
Object.freeze(RunStoragePort);
var RunContentStore = class extends ContentStore {
	#get;
	#put;
	#requireWrite;
	#stat;
	constructor(store, requireWrite) {
		super();
		this.#get = store.get.bind(store);
		this.#put = store.put.bind(store);
		this.#requireWrite = requireWrite;
		this.#stat = store.stat.bind(store);
	}
	put(bytes, hint) {
		this.#requireWrite();
		return this.#put(bytes, hint);
	}
	async get(ref, range) {
		return this.#get(ref, range);
	}
	async stat(ref) {
		return this.#stat(ref);
	}
};
Object.freeze(RunContentStore.prototype);
Object.freeze(RunContentStore);
var RunRepository = class {
	storage;
	constructor(storage) {
		this.storage = storage;
		Object.freeze(this);
	}
	get content() {
		return this.storage.content;
	}
	transaction(operation, ...guard) {
		return this.storage.transaction(operation, ...guard);
	}
	loadExecutionScope(tx, token, now) {
		const turn = requireStored(this.loadTurn(tx, token.turn), "Turn executor target does not exist");
		turn.requireToken(token, now);
		const run = requireStored(this.loadRun(tx, turn.run), "Turn executor Run does not exist");
		const branch = requireStored(this.loadBranch(tx, turn.branch), "Turn executor branch does not exist");
		const head = requireStored(this.loadCommit(tx, branch.head), "Turn executor branch head does not exist");
		const startHead = requireStored(this.loadCommit(tx, turn.startHead), "Turn executor start head does not exist");
		const effectiveCommit = requireStored(this.loadCommit(tx, turn.effectiveInput), "Turn executor effective input does not exist");
		const placement = requireStored(this.loadPlacement(tx, turn.id), "Turn executor placement does not exist");
		const checkpoint = turn.checkpoint === void 0 ? void 0 : requireStored(this.loadCheckpoint(tx, turn.checkpoint), "Turn executor checkpoint does not exist");
		const checkpointCommit = checkpoint === void 0 ? void 0 : requireStored(this.loadCommit(tx, checkpoint.commit), "Turn executor checkpoint commit does not exist");
		const unpairedTransition = this.listCommits(tx).some((commit) => (commit.kind === "checkpoint" || commit.kind === "result") && commit.writer.kind === "turn" && commit.writer.token.turn.equals(token.turn) && commit.writer.token.holder.equals(token.holder) && commit.writer.token.epoch === token.epoch && this.isAncestor(tx, commit.id, branch.head));
		if (run.lifecycle.kind !== "active" || turn.status.kind !== "running" || !branch.run.equals(run.id) || !head.run.equals(run.id) || !head.branch.equals(branch.id) || !head.pins.equals(turn.pins) || !startHead.run.equals(run.id) || !startHead.branch.equals(branch.id) || !startHead.pins.equals(turn.pins) || !effectiveCommit.run.equals(run.id) || !effectiveCommit.branch.equals(branch.id) || !effectiveCommit.pins.equals(turn.pins) || !placement.turn.equals(turn.id) || !placement.digest.equals(turn.placement) || !placement.pins.equals(turn.pins) || !this.isAncestor(tx, turn.startHead, branch.head) || !this.isAncestor(tx, turn.effectiveInput, turn.startHead) || unpairedTransition || checkpoint !== void 0 && (checkpointCommit === void 0 || !checkpoint.turn.equals(turn.id) || checkpointCommit.kind !== "checkpoint" || !checkpointCommit.run.equals(run.id) || !checkpointCommit.branch.equals(branch.id) || !checkpointCommit.subjectTurn?.equals(turn.id) || !checkpointCommit.pins.equals(turn.pins) || !checkpointCommit.content?.equals(checkpoint.state) || !optionalContentRefsEqual(checkpointCommit.treeCheckpoint, checkpoint.tree) || !this.isAncestor(tx, checkpoint.commit, branch.head))) throw invalidExecutionScope();
		return Object.freeze({
			run,
			turn,
			branch,
			head,
			effectiveCommit,
			placement,
			checkpoint
		});
	}
	insertConfiguration(tx, value) {
		this.insert(tx, "configuration", value.id.value, value, RunConfigurationSnapshotCodec);
	}
	loadConfiguration(tx, key) {
		return this.load(tx, "configuration", key, RunConfigurationSnapshotCodec, (value) => value.id.value);
	}
	insertRun(tx, value) {
		this.insert(tx, "run", value.id.value, value, RunCodec, value.revision);
	}
	replaceRun(tx, expected, value) {
		this.replace(tx, "run", value.id.value, value, RunCodec, expected, value.revision);
	}
	loadRun(tx, id) {
		return this.load(tx, "run", id.value, RunCodec, (value) => value.id.value, (value) => value.revision);
	}
	listRuns(tx) {
		return this.list(tx, "run", RunCodec, (value) => value.id.value, (value) => value.revision);
	}
	insertBranch(tx, value) {
		this.insert(tx, "branch", value.id.value, value, RunBranchCodec, value.revision);
	}
	replaceBranch(tx, expected, value) {
		this.replace(tx, "branch", value.id.value, value, RunBranchCodec, expected, value.revision);
	}
	loadBranch(tx, id) {
		return this.load(tx, "branch", id.value, RunBranchCodec, (value) => value.id.value, (value) => value.revision);
	}
	listBranches(tx) {
		return this.list(tx, "branch", RunBranchCodec, (value) => value.id.value, (value) => value.revision);
	}
	insertCommit(tx, value) {
		this.insert(tx, "commit", value.id.value, value, RunCommitCodec);
		value.parents.forEach((parent, ordinal) => this.storage.insertParent(tx, {
			commit: value.id.value,
			ordinal,
			parent: parent.value
		}));
	}
	loadCommit(tx, id) {
		const commit = this.load(tx, "commit", id.value, RunCommitCodec, (value) => value.id.value);
		if (commit !== void 0) this.validateParents(tx, commit);
		return commit;
	}
	listCommits(tx) {
		const commits = this.list(tx, "commit", RunCommitCodec, (value) => value.id.value);
		commits.forEach((commit) => this.validateParents(tx, commit));
		return commits;
	}
	insertTurn(tx, value) {
		this.insert(tx, "turn", value.id.value, value, TurnCodec, value.revision);
	}
	replaceTurn(tx, expected, value) {
		this.replace(tx, "turn", value.id.value, value, TurnCodec, expected, value.revision);
	}
	loadTurn(tx, id) {
		return this.load(tx, "turn", id.value, TurnCodec, (value) => value.id.value, (value) => value.revision);
	}
	listTurns(tx) {
		return this.list(tx, "turn", TurnCodec, (value) => value.id.value, (value) => value.revision);
	}
	insertPlacement(tx, value) {
		this.insert(tx, "placement", value.turn.value, value, TurnPlacementSnapshotCodec);
	}
	loadPlacement(tx, id) {
		return this.load(tx, "placement", id.value, TurnPlacementSnapshotCodec, (value) => value.turn.value);
	}
	insertCheckpoint(tx, value) {
		this.insert(tx, "checkpoint", value.id.value, value, RunCheckpointCodec);
	}
	loadCheckpoint(tx, id) {
		return this.load(tx, "checkpoint", id.value, RunCheckpointCodec, (value) => value.id.value);
	}
	insertInbox(tx, value) {
		this.insert(tx, "inbox", value.id.value, value, TurnInboxEntryCodec);
	}
	loadInbox(tx, id) {
		return this.load(tx, "inbox", id.value, TurnInboxEntryCodec, (value) => value.id.value);
	}
	listInbox(tx, turn) {
		return this.list(tx, "inbox", TurnInboxEntryCodec, (value) => value.id.value).filter((entry) => entry.turn.equals(turn)).sort((left, right) => left.sequence - right.sequence);
	}
	insertSpawn(tx, value) {
		this.insert(tx, "spawn", value.id.value, value, SpawnReservationCodec);
	}
	loadSpawn(tx, id) {
		return this.load(tx, "spawn", id.value, SpawnReservationCodec, (value) => value.id.value);
	}
	loadSpawnForChild(tx, child) {
		const reservations = this.list(tx, "spawn", SpawnReservationCodec, (value) => value.id.value).filter((value) => value.childRun.equals(child));
		if (reservations.length > 1) throw new AgentCoreError("run.invalid-state", "Run has more than one spawn reservation");
		return reservations[0];
	}
	insertAdmission(tx, value) {
		this.insert(tx, "admission", value.run.value, value, RunAdmissionRegistryCodec, new Revision(admissionRevision(value)));
	}
	replaceAdmission(tx, expected, value) {
		if (!expected.run.equals(value.run)) throw new AgentCoreError("run.invalid-state", "Run admission registry identity changed");
		this.replace(tx, "admission", value.run.value, value, RunAdmissionRegistryCodec, new Revision(admissionRevision(expected)), new Revision(admissionRevision(value)));
	}
	loadAdmission(tx, id) {
		return this.load(tx, "admission", id.value, RunAdmissionRegistryCodec, (value) => value.run.value, (value) => new Revision(admissionRevision(value)));
	}
	insertForcedCancellation(tx, value) {
		this.insert(tx, "forcedCancellation", value.turn.value, value, ForcedTurnCancellationCodec);
	}
	loadForcedCancellation(tx, turn) {
		return this.load(tx, "forcedCancellation", turn.value, ForcedTurnCancellationCodec, (value) => value.turn.value);
	}
	listForcedCancellations(tx, run) {
		return this.list(tx, "forcedCancellation", ForcedTurnCancellationCodec, (value) => value.turn.value).filter((value) => value.run.equals(run));
	}
	insertAcceptanceCriterion(tx, value) {
		this.insert(tx, "acceptance", value.id.value, value, AcceptanceCriterionCodec);
	}
	loadAcceptanceCriterion(tx, id) {
		return this.load(tx, "acceptance", id.value, AcceptanceCriterionCodec, (value) => value.id.value);
	}
	insertAcceptanceVerdict(tx, value) {
		this.insert(tx, "verdict", acceptanceVerdictKey(value), value, AcceptanceVerdictCodec);
	}
	loadAcceptanceVerdict(tx, acceptance, subject) {
		return this.load(tx, "verdict", `${acceptance.value}:${subject.value}`, AcceptanceVerdictCodec, acceptanceVerdictKey);
	}
	isAncestor(tx, ancestor, descendant) {
		const target = this.loadCommit(tx, ancestor);
		const child = this.loadCommit(tx, descendant);
		if (target === void 0 || child === void 0 || !target.run.equals(child.run)) return false;
		const pending = [child];
		const visited = /* @__PURE__ */ new Set();
		while (pending.length > 0) {
			const current = pending.pop();
			if (current.id.equals(ancestor)) return true;
			if (visited.has(current.id.value)) continue;
			visited.add(current.id.value);
			for (const parent of current.parents) {
				const record = this.loadCommit(tx, parent);
				if (record === void 0 || !record.run.equals(child.run)) throw new AgentCoreError("codec.invalid", "Run ancestry contains a missing or foreign parent");
				pending.push(record);
			}
		}
		return false;
	}
	insert(tx, kind, key, value, codec, revision) {
		const bytes = codec.encode(value);
		const canonical = codec.decode(bytes);
		const record = Object.freeze({
			kind,
			key,
			revision: revision?.value ?? null,
			bytes: codec.encode(canonical)
		});
		this.storage.insert(tx, record);
	}
	replace(tx, kind, key, value, codec, expected, revision) {
		const bytes = codec.encode(codec.decode(codec.encode(value)));
		const record = Object.freeze({
			kind,
			key,
			revision: revision.value,
			bytes
		});
		this.storage.replace(tx, record, expected.value);
	}
	load(tx, kind, key, codec, keyOf, revisionOf) {
		const stored = this.storage.get(tx, kind, key);
		if (stored === void 0) return void 0;
		const value = codec.decode(stored.bytes);
		if (keyOf(value) !== stored.key || (revisionOf?.(value).value ?? null) !== stored.revision) throw new AgentCoreError("codec.invalid", "Stored Run projection does not match codec bytes");
		return value;
	}
	list(tx, kind, codec, keyOf, revisionOf) {
		return this.storage.list(tx, kind).map((row) => {
			const value = codec.decode(row.bytes);
			if (keyOf(value) !== row.key || (revisionOf?.(value).value ?? null) !== row.revision) throw new AgentCoreError("codec.invalid", "Stored Run list projection does not match codec bytes");
			return value;
		});
	}
	validateParents(tx, commit) {
		const edges = this.storage.parents(tx, commit.id.value);
		if (edges.length !== commit.parents.length || edges.some((edge, ordinal) => edge.ordinal !== ordinal || edge.parent !== commit.parents[ordinal]?.value)) throw new AgentCoreError("codec.invalid", "Stored Run parents do not match commit bytes");
	}
};
Object.freeze(RunRepository.prototype);
Object.freeze(RunRepository);
/**
* One immutable target lease attestation stored under its idempotency key. The
* canonical bytes are opaque to the runs plane: the authority plane owns their
* shape, the runs plane owns the durable, co-transacted storage.
*/
var TargetLeaseEvidenceRecord = class TargetLeaseEvidenceRecord extends CodecRecord {
	key;
	evidence;
	constructor(init) {
		super();
		if (init.key.length === 0 || init.key !== init.key.trim()) throw new TypeError("Stored lease evidence key must be canonical and nonblank");
		if (init.evidence.length === 0) throw new TypeError("Stored lease evidence bytes must not be empty");
		this.key = init.key;
		this.evidence = init.evidence;
		Object.freeze(this);
	}
	static get codec() {
		return targetLeaseEvidenceRecordCodec;
	}
	toData() {
		return {
			evidence: this.evidence,
			key: this.key
		};
	}
	static fromData(payload) {
		const object = requireObject(payload, "Stored lease evidence record");
		requireExactFields(object, ["evidence", "key"], [], "Stored lease evidence record");
		const key = object["key"];
		const evidence = object["evidence"];
		if (!isString(key) || !isString(evidence)) throw new TypeError("Stored lease evidence fields must be strings");
		return new TargetLeaseEvidenceRecord({
			evidence,
			key
		});
	}
};
var TargetLeaseEvidenceRecordCodec = class extends RecordCodec {
	constructor() {
		super([TargetLeaseEvidenceRecord, CodecRecord], "runs.target-lease-evidence", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(record) {
		return record.toData();
	}
	decodePayload(payload) {
		return TargetLeaseEvidenceRecord.fromData(payload);
	}
};
var targetLeaseEvidenceRecordCodec = new TargetLeaseEvidenceRecordCodec();
var RUN_RECORD_DESCRIPTORS = Object.freeze({
	configuration: recordDescriptor(RunConfigurationSnapshotCodec, (value) => value.id.value),
	run: recordDescriptor(RunCodec, (value) => value.id.value, (value) => value.revision.value),
	branch: recordDescriptor(RunBranchCodec, (value) => value.id.value, (value) => value.revision.value),
	commit: contentRecordDescriptor(RunCommitCodec, (value) => value.id.value, runCommitContentRetention),
	turn: contentRecordDescriptor(TurnCodec, (value) => value.id.value, turnContentRetention, (value) => value.revision.value),
	placement: recordDescriptor(TurnPlacementSnapshotCodec, (value) => value.turn.value),
	checkpoint: contentRecordDescriptor(RunCheckpointCodec, (value) => value.id.value, runCheckpointContentRetention),
	inbox: contentRecordDescriptor(TurnInboxEntryCodec, (value) => value.id.value, turnInboxEntryContentRetention),
	spawn: contentRecordDescriptor(SpawnReservationCodec, (value) => value.id.value, spawnReservationContentRetention),
	admission: recordDescriptor(RunAdmissionRegistryCodec, (value) => value.run.value, admissionRevision),
	forcedCancellation: recordDescriptor(ForcedTurnCancellationCodec, (value) => value.turn.value),
	acceptance: recordDescriptor(AcceptanceCriterionCodec, (value) => value.id.value),
	targetLeaseEvidence: recordDescriptor(targetLeaseEvidenceRecordCodec, (value) => value.key),
	verdict: recordDescriptor(AcceptanceVerdictCodec, acceptanceVerdictKey)
});
var RUN_CONTENT_OWNER_PREFIXES = Object.freeze([...new Set(RUN_RECORD_KINDS.map((kind) => contentOwnerNamespace(RUN_RECORD_DESCRIPTORS[kind].ownerKind)))]);
/**
* The record set a Run protocol command's execution writes, at the codec versions this
* build writes them under (§8.3). It is derived from the same descriptor table the storage
* reads and writes through, so a codec major that moves here moves in exactly one place and
* a reader compares against the set it will actually decode.
*/
var RUN_RECORD_CODECS = CodecDeclaration.of(RUN_RECORD_KINDS.map((kind) => RUN_RECORD_DESCRIPTORS[kind].codec));
function recordDescriptor(codec, key, revision = () => null) {
	return createRecordDescriptor(codec, key, revision);
}
function contentRecordDescriptor(codec, key, projection, revision = () => null) {
	return createRecordDescriptor(codec, key, revision, projection);
}
function createRecordDescriptor(codec, key, revision, projection) {
	return Object.freeze({
		codec,
		key,
		revision,
		ownerKind: codec.kind,
		decodeContent(bytes) {
			if (projection === void 0) return void 0;
			const value = codec.decode(bytes);
			return {
				key: key(value),
				revision: revision(value),
				ownerKind: codec.kind,
				fields: projection(value)
			};
		}
	});
}
function contentOwnerEdges(storage, record) {
	const decoded = RUN_RECORD_DESCRIPTORS[record.kind].decodeContent(record.bytes);
	if (decoded === void 0) return [];
	if (decoded.key !== record.key || decoded.revision !== record.revision) throw new AgentCoreError("codec.invalid", "Stored Run content projection does not match codec bytes");
	return Object.freeze(decoded.fields.map(({ field, ref }) => new ContentOwnerEdge(storage.tenant, storage.owner, contentOwnerKey(decoded.ownerKind, decoded.key, field), ref)));
}
function admissionRevision(value) {
	return value.reserved.length + value.completed.length + (value.open ? 0 : 1);
}
function acceptanceVerdictKey(value) {
	return `${value.acceptance.value}:${value.subject.value}`;
}
function nonErrorCustodyFailure() {
	return new AgentCoreError("protocol.invalid-state", "Run content custody failed with a non-Error value");
}
function contentWriteDuringTransaction() {
	return new AgentCoreError("run.invalid-state", "Run content writes are not allowed during a Run storage transaction");
}
function requireStored(value, message) {
	if (value === void 0) throw new AgentCoreError("turn.invalid-state", message);
	return value;
}
function optionalContentRefsEqual(left, right) {
	return left === void 0 ? right === void 0 : right !== void 0 && left.equals(right);
}
function invalidExecutionScope() {
	return new AgentCoreError("turn.invalid-state", "Turn executor scope does not match canonical Run state");
}
//#endregion
//#region src/agents/runs/memory.ts
var MemoryRunStorage = class MemoryRunStorage extends RunStoragePort {
	#snapshot;
	constructor(tenant, owner, snapshot, now) {
		if (owner.kind !== "workspace" && owner.kind !== "run") throw new TypeError("Run storage must belong to a Workspace or dedicated Run Actor");
		const state = snapshot === void 0 ? emptyState() : restoreSnapshot(snapshot);
		const contentStore = new MemoryContentStore(snapshot?.content);
		const backend = new MemoryRunStorageBackend(contentStore, contentStore.retention(tenant, owner), state, () => MemoryRunStorage.createTransaction());
		super(tenant, owner, contentStore, ownRunStorageBackend(backend), now);
		this.#snapshot = () => backend.snapshot();
		if (new.target === MemoryRunStorage) Object.freeze(this);
	}
	snapshot() {
		return this.#snapshot();
	}
};
Object.freeze(MemoryRunStorage.prototype);
Object.freeze(MemoryRunStorage);
var MemoryRunStorageBackend = class {
	contentStore;
	retention;
	createTransaction;
	#active;
	#state;
	constructor(contentStore, retention, state, createTransaction) {
		this.contentStore = contentStore;
		this.retention = retention;
		this.createTransaction = createTransaction;
		this.#state = state;
	}
	transaction(operation, ..._guard) {
		const current = this.#active;
		if (current !== void 0) {
			current.failure ??= invalidStorage("Nested Run storage transactions are not supported");
			throw current.failure;
		}
		const draft = cloneState(this.#state);
		const transaction = this.createTransaction();
		const outcome = this.contentStore.transaction((content) => {
			const active = {
				transaction,
				content,
				runs: draft,
				failure: void 0
			};
			this.#active = active;
			try {
				const result = requireSynchronousRunResult(operation(transaction));
				if (active.failure !== void 0) throw active.failure;
				return {
					result,
					runs: cloneState(draft)
				};
			} finally {
				this.#active = void 0;
			}
		});
		this.#state = outcome.runs;
		return outcome.result;
	}
	get(transaction, kind, key) {
		const value = this.require(transaction).runs.records.get(recordKey(kind, key));
		return value === void 0 ? void 0 : copyRecord(value);
	}
	list(transaction, kind) {
		return [...this.require(transaction).runs.records.values()].filter((record) => record.kind === kind).sort((left, right) => compareCanonicalText(left.key, right.key)).map(copyRecord);
	}
	validate(record) {
		validateRecord(record);
	}
	poison(transaction, failure) {
		const state = this.require(transaction);
		state.failure ??= failure;
		throw state.failure;
	}
	insert(transaction, record) {
		const key = recordKey(record.kind, record.key);
		const records = this.require(transaction).runs.records;
		const existing = records.get(key);
		if (existing !== void 0) {
			if (sameRecord(existing, record)) return;
			throw invalidStorage("Run records are immutable unless replaced by revision CAS");
		}
		records.set(key, copyRecord(record));
	}
	replace(transaction, record, expectedRevision) {
		const key = recordKey(record.kind, record.key);
		const records = this.require(transaction).runs.records;
		if (records.get(key)?.revision !== expectedRevision || record.revision !== expectedRevision + 1) throw new AgentCoreError("protocol.revision-conflict", "Run record revision changed");
		records.set(key, copyRecord(record));
	}
	insertParent(transaction, edge) {
		if (!Number.isSafeInteger(edge.ordinal) || edge.ordinal < 0 || edge.ordinal > 1) throw corruptStorage("Run parent ordinal must be zero or one");
		const key = parentKey(edge.commit, edge.ordinal);
		const parents = this.require(transaction).runs.parents;
		const existing = parents.get(key);
		if (existing !== void 0) {
			if (existing.parent === edge.parent) return;
			throw invalidStorage("Run commit parent edges are immutable");
		}
		parents.set(key, Object.freeze({ ...edge }));
	}
	parents(transaction, commit) {
		return [...this.require(transaction).runs.parents.values()].filter((edge) => edge.commit === commit).sort((left, right) => left.ordinal - right.ordinal).map((edge) => Object.freeze({ ...edge }));
	}
	retain(transaction, edge, operationAt) {
		const active = this.require(transaction);
		this.retention.retain(active.content, edge, operationAt);
	}
	release(transaction, edge, operationAt) {
		const active = this.require(transaction);
		this.retention.release(active.content, edge, operationAt);
	}
	verify(transaction, ownerPrefixes, expected) {
		const active = this.require(transaction);
		this.retention.verifyExactNamespace(active.content, ownerPrefixes, expected);
	}
	snapshot() {
		return Object.freeze({
			version: 2,
			records: Object.freeze([...this.#state.records.values()].sort((left, right) => compareCanonicalText(recordKey(left.kind, left.key), recordKey(right.kind, right.key))).map(copyRecord)),
			parents: Object.freeze([...this.#state.parents.values()].sort((left, right) => compareCanonicalText(parentKey(left.commit, left.ordinal), parentKey(right.commit, right.ordinal))).map((edge) => Object.freeze({ ...edge }))),
			content: this.contentStore.snapshot()
		});
	}
	require(transaction) {
		const active = this.#active;
		if (active === void 0 || active.transaction !== transaction) throw new AgentCoreError("protocol.invalid-state", "Memory Run transaction is inactive or belongs to a different store");
		if (active.failure !== void 0) throw active.failure;
		return active;
	}
};
function emptyState() {
	return {
		records: /* @__PURE__ */ new Map(),
		parents: /* @__PURE__ */ new Map()
	};
}
function cloneState(state) {
	return {
		records: new Map([...state.records].map(([key, value]) => [key, copyRecord(value)])),
		parents: new Map([...state.parents].map(([key, value]) => [key, Object.freeze({ ...value })]))
	};
}
function restoreSnapshot(snapshot) {
	if (snapshot.version !== 2 || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.parents) || snapshot.content === void 0) throw corruptStorage("Memory Run storage snapshot is malformed");
	const state = emptyState();
	for (const record of snapshot.records) {
		validateRecord(record);
		const key = recordKey(record.kind, record.key);
		if (state.records.has(key)) throw corruptStorage("Memory Run snapshot contains duplicate records");
		state.records.set(key, copyRecord(record));
	}
	for (const edge of snapshot.parents) {
		if (edge.commit.length === 0 || edge.parent.length === 0 || !Number.isSafeInteger(edge.ordinal) || edge.ordinal < 0 || edge.ordinal > 1) throw corruptStorage("Memory Run snapshot contains a malformed parent edge");
		const key = parentKey(edge.commit, edge.ordinal);
		if (state.parents.has(key)) throw corruptStorage("Memory Run snapshot contains duplicate parents");
		state.parents.set(key, Object.freeze({ ...edge }));
	}
	return state;
}
function validateRecord(record) {
	if (!RUN_RECORD_KINDS.includes(record.kind) || record.key.length === 0 || !(record.bytes instanceof Uint8Array) || record.revision !== null && (!Number.isSafeInteger(record.revision) || record.revision < 0)) throw corruptStorage("Stored Run record is malformed");
}
function copyRecord(record) {
	return Object.freeze({
		...record,
		bytes: record.bytes.slice()
	});
}
function sameRecord(left, right) {
	return left.revision === right.revision && left.bytes.byteLength === right.bytes.byteLength && left.bytes.every((value, index) => value === right.bytes[index]);
}
function recordKey(kind, key) {
	return `${kind}\u0000${key}`;
}
function parentKey(commit, ordinal) {
	return `${commit}\u0000${ordinal}`;
}
function requireSynchronousRunResult(result) {
	try {
		return requireSynchronousResult(result);
	} catch (error) {
		if (error instanceof TypeError) throw invalidStorage("Run storage transactions must be synchronous");
		throw error;
	}
}
function invalidStorage(message) {
	return new AgentCoreError("run.invalid-state", message);
}
function corruptStorage(message) {
	return new AgentCoreError("codec.invalid", message);
}
//#endregion
//#region src/agents/runs/evidence.ts
var RunEvidencePort = class {};
var RunMergePort = class {};
//#endregion
//#region src/agents/runs/runtime.ts
var RunRuntime = class {
	repository;
	sources;
	evidence;
	settlement;
	spawn;
	merge;
	cutPoints;
	constructor(repository, sources, evidence, settlement, spawn, merge, cutPoints) {
		this.repository = repository;
		this.sources = sources;
		this.evidence = evidence;
		this.settlement = settlement;
		this.spawn = spawn;
		this.merge = merge;
		this.cutPoints = cutPoints;
	}
	createRun(genesis) {
		this.repository.transaction((tx) => this.createRunInTransaction(tx, genesis));
	}
	spawnRun(reservation, genesis, now) {
		this.repository.transaction((tx) => this.spawnRunInTransaction(tx, reservation, genesis, now));
	}
	spawnRunInTransaction(tx, reservation, genesis, now) {
		const existing = this.repository.loadSpawn(tx, reservation.id);
		if (existing !== void 0) {
			const child = this.repository.loadRun(tx, reservation.childRun);
			if (bytesEqual(SpawnReservationCodec.encode(existing), SpawnReservationCodec.encode(reservation)) && child !== void 0 && child.configuration.equals(reservation.configuration)) return;
			throw new AgentCoreError("run.invalid-state", "Spawn reservation identity conflicts");
		}
		const parent = this.requireActiveRun(tx, reservation.parentRun);
		const turn = requireValue(this.repository.loadTurn(tx, reservation.parentTurn), "Spawning Turn does not exist");
		turn.requireToken(reservation.token, now);
		if (!turn.run.equals(parent.id) || !genesis.run.id.equals(reservation.childRun) || !genesis.run.parent?.equals(parent.id) || !genesis.configuration.id.equals(reservation.configuration) || !genesis.root.content?.equals(reservation.rootContent) || requireSynchronousResult(this.spawn.verify(tx, reservation)) !== true) throw new AgentCoreError("authority.denied", "Spawn reservation is not an exact attenuated child genesis");
		this.requireNarrowingCeiling(tx, reservation, parent, now);
		this.repository.insertSpawn(tx, reservation);
		this.createRunInTransaction(tx, genesis);
	}
	createRunInTransaction(tx, genesis) {
		if (!genesis.run.configuration.equals(genesis.configuration.id) || !genesis.run.root.equals(genesis.root.id) || !genesis.run.initialBranch.equals(genesis.branch.id) || !genesis.root.run.equals(genesis.run.id) || !genesis.root.branch.equals(genesis.branch.id) || !genesis.branch.run.equals(genesis.run.id) || !genesis.branch.head.equals(genesis.root.id) || genesis.run.lifecycle.kind !== "active" || genesis.run.revision.value !== 0 || genesis.branch.revision.value !== 0 || genesis.root.kind !== "root" || genesis.root.writer.kind !== "root" || !genesis.root.pins.equals(genesis.configuration.pins)) throw invalidRun("Run genesis records do not form one canonical root");
		if (!genesis.run.agent.equals(genesis.configuration.pins.agent.id)) throw invalidRun("Run Agent does not match its configuration snapshot");
		if (requireSynchronousResult(this.sources.verify(tx, genesis.configuration)) !== true || requireSynchronousResult(this.sources.verifyPackageClosure(tx, genesis.configuration)) !== true) throw invalidRun("Run configuration does not resolve exact authoritative source revisions");
		if (this.repository.loadRun(tx, genesis.run.id) !== void 0 || this.repository.loadCommit(tx, genesis.root.id) !== void 0 || this.repository.loadBranch(tx, genesis.branch.id) !== void 0 || this.repository.loadAdmission(tx, genesis.run.id) !== void 0) throw new AgentCoreError("run.invalid-state", "Run genesis identifiers already exist");
		this.repository.insertConfiguration(tx, genesis.configuration);
		this.repository.insertRun(tx, genesis.run);
		this.repository.insertCommit(tx, genesis.root);
		this.repository.insertBranch(tx, genesis.branch);
		let registry = RunAdmissionRegistry.initial(genesis.run.id);
		for (const criterion of genesis.acceptanceCriteria ?? []) {
			if (this.repository.loadAcceptanceCriterion(tx, criterion.id) !== void 0) throw new AgentCoreError("run.invalid-state", "Run genesis identifiers already exist");
			const reserved = registry.reserve({
				kind: "acceptance",
				acceptance: criterion.id
			});
			if (reserved.registry === registry) throw invalidRun("Acceptance criteria must declare unique identities");
			registry = reserved.registry;
			this.repository.insertAcceptanceCriterion(tx, criterion);
		}
		this.repository.insertAdmission(tx, registry);
	}
	reserveRunObligation(run, obligation) {
		return this.repository.transaction((tx) => this.reserveRunObligationInTransaction(tx, run, obligation));
	}
	reserveRunObligationInTransaction(tx, run, obligation) {
		this.requireActiveRun(tx, run);
		requireNonAcceptanceObligation(obligation, "Acceptance criteria are reserved when the Run declares them at open");
		const registry = this.requireAdmission(tx, run);
		const reserved = registry.reserve(obligation);
		if (reserved.registry !== registry) this.repository.replaceAdmission(tx, registry, reserved.registry);
		return reserved.reservation;
	}
	completeRunObligation(reservation) {
		this.repository.transaction((tx) => this.completeRunObligationInTransaction(tx, reservation));
	}
	completeRunObligationInTransaction(tx, reservation) {
		requireNonAcceptanceObligation(reservation.obligation, "An acceptance obligation discharges only through a recorded verdict");
		const registry = this.requireAdmission(tx, reservation.run);
		const completed = registry.complete(reservation);
		if (completed !== registry) this.repository.replaceAdmission(tx, registry, completed);
	}
	acceptsRunAdmission(reservation) {
		return this.repository.transaction((tx) => this.acceptsRunAdmissionInTransaction(tx, reservation));
	}
	acceptsRunAdmissionInTransaction(tx, reservation) {
		return this.repository.loadAdmission(tx, reservation.run)?.accepts(reservation) === true;
	}
	recordAcceptanceVerdict(run, verdict) {
		this.repository.transaction((tx) => this.recordAcceptanceVerdictInTransaction(tx, run, verdict));
	}
	recordAcceptanceVerdictInTransaction(tx, runId, verdict) {
		requireValue(this.repository.loadRun(tx, runId), "Run does not exist");
		const criterion = requireValue(this.repository.loadAcceptanceCriterion(tx, verdict.acceptance), "Acceptance criterion does not exist");
		if (this.requireAdmission(tx, runId).reservation({
			kind: "acceptance",
			acceptance: verdict.acceptance
		}) === void 0) throw invalidRun("Acceptance verdict requires this Run's reserved criterion");
		const evidence = requireSynchronousResult(this.evidence.acceptance(tx, verdict.receipt));
		if (evidence === void 0 || !evidence.receipt.equals(verdict.receipt)) throw new AgentCoreError("authority.denied", "Acceptance verdict requires its exact attempted verifier Receipt");
		if (!evidence.operation.equals(criterion.operation)) throw new AgentCoreError("authority.denied", "Acceptance verdict requires a Receipt from the criterion's declared verifier");
		const existing = this.repository.loadAcceptanceVerdict(tx, verdict.acceptance, verdict.subject);
		if (existing !== void 0 && !existing.receipt.equals(verdict.receipt)) throw invalidRun("Acceptance subject already holds a recorded verdict");
		this.repository.insertAcceptanceVerdict(tx, verdict);
	}
	acceptanceAttemptAdmissible(run, acceptance) {
		return this.repository.transaction((tx) => this.acceptanceAttemptAdmissibleInTransaction(tx, run, acceptance));
	}
	acceptanceAttemptAdmissibleInTransaction(tx, runId, acceptance) {
		const run = requireValue(this.repository.loadRun(tx, runId), "Run does not exist");
		if (this.requireAdmission(tx, runId).reservation({
			kind: "acceptance",
			acceptance
		}) === void 0) return false;
		const subject = this.headTreeDigestInTransaction(tx, run);
		if (subject === void 0) return false;
		return this.repository.loadAcceptanceVerdict(tx, acceptance, subject) === void 0;
	}
	acceptanceSatisfied(run, acceptance) {
		return this.repository.transaction((tx) => this.acceptanceSatisfiedInTransaction(tx, run, acceptance));
	}
	acceptanceSatisfiedInTransaction(tx, runId, acceptance) {
		const run = requireValue(this.repository.loadRun(tx, runId), "Run does not exist");
		const subject = this.headTreeDigestInTransaction(tx, run);
		if (subject === void 0) return false;
		const verdict = this.repository.loadAcceptanceVerdict(tx, acceptance, subject);
		if (verdict === void 0) return false;
		const evidence = requireSynchronousResult(this.evidence.acceptance(tx, verdict.receipt));
		return evidence !== void 0 && evidence.outcome === "succeeded";
	}
	createBranch(runId, branch, expectedRunRevision) {
		this.repository.transaction((tx) => this.createBranchInTransaction(tx, runId, branch, expectedRunRevision));
	}
	createBranchInTransaction(tx, runId, branch, expectedRunRevision) {
		const run = this.requireActiveRun(tx, runId);
		requireRevision(run.revision, expectedRunRevision);
		const head = this.repository.loadCommit(tx, branch.head);
		if (!branch.run.equals(runId) || branch.revision.value !== 0 || branch.rewrite !== void 0 || head === void 0 || !head.run.equals(runId) || this.repository.listBranches(tx).some((existing) => existing.run.equals(runId) && existing.name === branch.name) || this.repository.loadBranch(tx, branch.id) !== void 0) throw invalidRun("Run branch creation is invalid");
		const source = requireValue(this.repository.loadBranch(tx, head.branch), "Run branch head names a branch that does not exist");
		requireBalancedCut(this.transcriptAt(tx, source.head), this.transcriptAt(tx, head.id), "Run branch creation");
		this.repository.insertBranch(tx, branch);
		this.repository.replaceRun(tx, run.revision, run.revise());
	}
	appendTurnCommit(commit, expectedBranchRevision, now) {
		this.repository.transaction((tx) => this.appendTurnCommitInTransaction(tx, commit, expectedBranchRevision, now));
	}
	appendTurnCommitInTransaction(tx, commit, expectedBranchRevision, now) {
		if (commit.kind !== "message" && commit.kind !== "verdict" && commit.kind !== "modelInput" || commit.writer.kind !== "turn") throw invalidRun("Non-transition Turn append requires a message, verdict, or model input commit");
		this.appendInTransaction(tx, commit, expectedBranchRevision, now);
	}
	appendSystemEvidenceCommit(commit, expectedBranchRevision, now) {
		this.repository.transaction((tx) => this.appendSystemEvidenceCommitInTransaction(tx, commit, expectedBranchRevision, now));
	}
	appendSystemEvidenceCommitInTransaction(tx, commit, expectedBranchRevision, now) {
		if (commit.kind !== "invocation" && commit.kind !== "eventDelivery" || commit.writer.kind !== "system") throw invalidRun("System evidence append requires an invocation or delivery commit");
		this.appendInTransaction(tx, commit, expectedBranchRevision, now);
	}
	mergeRun(commit, expectedBranchRevision, now) {
		this.repository.transaction((tx) => this.mergeRunInTransaction(tx, commit, expectedBranchRevision, now));
	}
	mergeRunInTransaction(tx, commit, expectedBranchRevision, now) {
		if (commit.kind !== "merge" || commit.writer.kind !== "system") throw invalidRun("Run merge requires a system-authored merge commit");
		this.appendInTransaction(tx, commit, expectedBranchRevision, now);
	}
	undoRun(commit, expectedBranchRevision, now) {
		this.repository.transaction((tx) => this.undoRunInTransaction(tx, commit, expectedBranchRevision, now));
	}
	undoRunInTransaction(tx, commit, expectedBranchRevision, now) {
		if (commit.kind !== "undo" || commit.writer.kind !== "system") throw invalidRun("Run undo requires a system-authored undo commit");
		this.appendInTransaction(tx, commit, expectedBranchRevision, now);
	}
	/**
	* Opens a rewrite bracket: reserves the planned rewrite's RunCommitId as a systemCommit
	* obligation and records it on the branch, which is what makes a second uncompleted
	* rewrite attempt on that branch rejected rather than raced.
	*/
	reserveRunRewrite(runId, branchId, planned, expectedBranchRevision) {
		return this.repository.transaction((tx) => this.reserveRunRewriteInTransaction(tx, runId, branchId, planned, expectedBranchRevision));
	}
	reserveRunRewriteInTransaction(tx, runId, branchId, planned, expectedBranchRevision) {
		const branch = requireValue(this.repository.loadBranch(tx, branchId), "Run branch does not exist");
		requireRevision(branch.revision, expectedBranchRevision);
		if (!branch.run.equals(runId)) throw invalidRun("Run branch belongs to another Run");
		if (this.repository.loadCommit(tx, planned) !== void 0) throw invalidRun("A rewrite reserves a planned commit that does not exist yet");
		const reservation = this.reserveRunObligationInTransaction(tx, runId, {
			kind: "systemCommit",
			commit: planned
		});
		this.repository.replaceBranch(tx, branch.revision, branch.reserveRewrite(planned));
		return reservation;
	}
	/**
	* Closes a rewrite bracket by appending exactly the reserved commit, installed with the
	* commits it shadows or abandoned on that attempt's failed Receipt. Both forms complete
	* the obligation, so an attempt that produced nothing neither blocks settlement nor
	* disappears from the log.
	*/
	rewriteRun(commit, expectedBranchRevision, now) {
		this.repository.transaction((tx) => this.rewriteRunInTransaction(tx, commit, expectedBranchRevision, now));
	}
	rewriteRunInTransaction(tx, commit, expectedBranchRevision, now) {
		if (commit.kind !== "rewrite" || commit.writer.kind !== "system") throw invalidRun("Run rewrite requires a system-authored rewrite commit");
		if (requireValue(this.repository.loadBranch(tx, commit.branch), "Run branch does not exist").rewrite?.equals(commit.id) !== true) throw invalidRun("A rewrite closes only the exact RunCommitId its branch reserved");
		const shadows = commit.shadows ?? [];
		if (shadows.length > 0) {
			const reduced = this.transcriptAt(tx, requireValue(commit.parents[0], "Rewrite commit has no parent"));
			const visible = new Set(reduced.map((entry) => entry.id.value));
			for (const shadowed of shadows) if (!visible.has(shadowed.value)) throw invalidRun(`Rewrite shadows ${shadowed.value}, which its effective transcript does not contain`);
			requireBalancedCut(reduced, this.transcriptAt(tx, commit.id, commit), "Rewrite shadow set");
		}
		this.appendInTransaction(tx, commit, expectedBranchRevision, now);
		this.completeRunObligationInTransaction(tx, {
			run: commit.run,
			registryEpoch: this.requireAdmission(tx, commit.run).epoch,
			obligation: {
				kind: "systemCommit",
				commit: commit.id
			}
		});
	}
	migrateRun(commit, target, expectedBranchRevision, now) {
		this.repository.transaction((tx) => this.migrateRunInTransaction(tx, commit, target, expectedBranchRevision, now));
	}
	migrateRunInTransaction(tx, commit, target, expectedBranchRevision, now) {
		const run = this.requireActiveRun(tx, commit.run);
		if (commit.kind !== "migration" || !commit.migration?.to.equals(target.pins) || !target.pins.agent.id.equals(run.agent) || requireSynchronousResult(this.sources.verify(tx, target)) !== true || requireSynchronousResult(this.sources.verifyPackageClosure(tx, target)) !== true) throw invalidRun("Migration target does not resolve an exact authoritative configuration");
		this.repository.insertConfiguration(tx, target);
		this.appendInTransaction(tx, commit, expectedBranchRevision, now);
		const migrated = requireValue(this.repository.loadRun(tx, run.id), "Migrated Run does not exist");
		const withConfiguration = migrated.recordConfiguration(target.id);
		if (withConfiguration !== migrated) this.repository.replaceRun(tx, migrated.revision, withConfiguration);
	}
	appendCapturedEvidence(commit, expectedBranchRevision, now) {
		this.repository.transaction((tx) => this.appendCapturedEvidenceInTransaction(tx, commit, expectedBranchRevision, now));
	}
	appendCapturedEvidenceInTransaction(tx, commit, expectedBranchRevision, now) {
		const run = requireValue(this.repository.loadRun(tx, commit.run), "Run does not exist");
		if (run.lifecycle.kind !== "terminal" || run.terminal === void 0 || !run.terminal.obligation.obligations.some((obligation) => obligation.kind === "systemCommit" && obligation.commit.equals(commit.id)) || commit.writer.kind !== "system" || commit.kind !== "invocation" && commit.kind !== "eventDelivery") throw new AgentCoreError("run.invalid-state", "Post-terminal commit is not a captured obligation");
		this.appendInTransaction(tx, commit, expectedBranchRevision, now, true);
	}
	createTurn(genesis, expectedBranchRevision) {
		this.repository.transaction((tx) => this.createTurnInTransaction(tx, genesis, expectedBranchRevision));
	}
	createTurnInTransaction(tx, genesis, expectedBranchRevision) {
		const run = this.requireActiveRun(tx, genesis.turn.run);
		const branch = requireValue(this.repository.loadBranch(tx, genesis.turn.branch), "Turn branch does not exist");
		requireRevision(branch.revision, expectedBranchRevision);
		const head = requireValue(this.repository.loadCommit(tx, branch.head), "Turn branch head is missing");
		this.requireConfigurationForPins(tx, run, head.pins);
		if (!branch.run.equals(run.id) || genesis.turn.status.kind !== "queued" || genesis.turn.revision.value !== 0 || genesis.turn.lease.holder !== void 0 || genesis.turn.lease.epoch !== 0 || genesis.turn.lease.expiresAt !== void 0 || genesis.turn.checkpoint !== void 0 || genesis.turn.result !== void 0 || !genesis.turn.startHead.equals(branch.head) || !genesis.turn.pins.equals(head.pins) || !genesis.placement.turn.equals(genesis.turn.id) || !genesis.placement.pins.equals(genesis.turn.pins) || !genesis.placement.digest.equals(genesis.turn.placement) || !effectiveCommitOf(this.commitLoader(tx), branch.head).id.equals(genesis.turn.effectiveInput) || this.repository.loadTurn(tx, genesis.turn.id) !== void 0) throw invalidTurn$1("Turn genesis does not match its branch and placement snapshot");
		this.repository.insertPlacement(tx, genesis.placement);
		this.repository.insertTurn(tx, genesis.turn);
		this.repository.replaceRun(tx, run.revision, run.revise());
	}
	claimTurn(turnId, expected, holder, now, expiresAt) {
		return this.repository.transaction((tx) => this.claimTurnInTransaction(tx, turnId, expected, holder, now, expiresAt));
	}
	claimTurnInTransaction(tx, turnId, expected, holder, now, expiresAt) {
		return this.updateTurnInTransaction(tx, turnId, expected, (turn) => turn.claim(holder, now, expiresAt));
	}
	renewTurn(turnId, expected, token, now, expiresAt) {
		return this.repository.transaction((tx) => this.renewTurnInTransaction(tx, turnId, expected, token, now, expiresAt));
	}
	renewTurnInTransaction(tx, turnId, expected, token, now, expiresAt) {
		return this.updateTurnInTransaction(tx, turnId, expected, (turn) => turn.renew(token, now, expiresAt));
	}
	reclaimTurn(turnId, expected, holder, now, expiresAt, cancellation) {
		return this.repository.transaction((tx) => this.reclaimTurnInTransaction(tx, turnId, expected, holder, now, expiresAt, cancellation));
	}
	reclaimTurnInTransaction(tx, turnId, expected, holder, now, expiresAt, cancellation) {
		return this.updateTurnInTransaction(tx, turnId, expected, (turn) => {
			const displaced = currentToken(turn);
			this.appendCancellation(tx, turn, cancellation, displaced);
			return turn.reclaim(holder, now, expiresAt);
		});
	}
	cancelUnheldTurn(turnId, expected) {
		return this.repository.transaction((tx) => this.cancelUnheldTurnInTransaction(tx, turnId, expected));
	}
	cancelUnheldTurnInTransaction(tx, turnId, expected) {
		return this.updateTurnInTransaction(tx, turnId, expected, (turn) => turn.cancelUnheld());
	}
	deliverEvent(turnId, expected, token, entry, now) {
		this.repository.transaction((tx) => this.deliverEventInTransaction(tx, turnId, expected, token, entry, now));
	}
	deliverEventInTransaction(tx, turnId, expected, token, entry, now) {
		const turn = requireValue(this.repository.loadTurn(tx, turnId), "Turn does not exist");
		requireRevision(turn.revision, expected);
		turn.requireToken(token, now);
		if (entry.event === "turn.cancel") this.appendCancellation(tx, turn, entry, token);
		else {
			const inbox = this.repository.listInbox(tx, turnId);
			if (!entry.turn.equals(turnId) || entry.sequence !== inbox.length || inbox.some((existing) => existing.idempotencyKey === entry.idempotencyKey)) throw invalidTurn$1("Inbox entry does not have the next Turn sequence");
			this.repository.insertInbox(tx, this.submitted(turn, entry));
		}
		this.repository.replaceTurn(tx, turn.revision, turn.revise());
	}
	/**
	* SPEC §4.4's `input.submitted`, fired at the one place a submission reaches a running
	* Turn (§5.6's `turn.deliverEvent`) and before that submission becomes durable inbox
	* history — so a block refuses it outright and leaves no entry behind.
	*
	* The value in flight is the submission envelope, and a rewrite may transform only the
	* payload. An Interceptor is synchronous (rule 1) while content resolves through an
	* asynchronous ContentStore (§8.2), so transforming means naming content the interceptor
	* has already stored rather than editing bytes in hand; the substitution inherits
	* exactly the retention obligation the original submission carried, and nothing here
	* verified the original either. The event name and the idempotency key are delivery
	* identity: changing the name would forge a different submission, and changing the key
	* would defeat the at-least-once dedupe this inbox is ordered by (§6.1).
	*/
	submitted(turn, entry) {
		const payload = new ContentRef(requireString(requireObject(this.cutPoints.run("input.submitted", turn.id, {
			event: entry.event,
			idempotencyKey: entry.idempotencyKey,
			payload: entry.payload.value
		}, admitSubmission).value, "Submitted input")["payload"], "Submitted input payload"));
		return payload.equals(entry.payload) ? entry : new TurnInboxEntry(entry.id, entry.turn, entry.sequence, entry.event, payload, payload.digest, entry.idempotencyKey, void 0, entry.recordedAt);
	}
	suspendTurn(request) {
		this.repository.transaction((tx) => this.suspendTurnInTransaction(tx, request));
	}
	suspendTurnInTransaction(tx, request) {
		const turn = this.requireTurnAndBranch(tx, request.turn, request.expectedTurnRevision, request.expectedBranchRevision);
		if (!request.checkpoint.turn.equals(turn.id) || !request.checkpoint.commit.equals(request.commit.id) || request.commit.kind !== "checkpoint" || !request.commit.subjectTurn?.equals(turn.id) || request.commit.writer.kind !== "turn" || !leaseTokensEqual(request.commit.writer.token, request.token) || !request.commit.content?.equals(request.checkpoint.state) || !optionalRefsEqual(request.commit.treeCheckpoint, request.checkpoint.tree) || request.checkpoint.inboxCursor > this.repository.listInbox(tx, turn.id).length) throw invalidTurn$1("Suspend checkpoint and commit do not match the Turn");
		this.appendInTransaction(tx, request.commit, request.expectedBranchRevision, request.now);
		this.repository.insertCheckpoint(tx, request.checkpoint);
		this.repository.replaceTurn(tx, turn.revision, turn.suspend(request.token, request.checkpoint.id, request.now));
	}
	completeTurn(request) {
		this.repository.transaction((tx) => this.completeTurnInTransaction(tx, request));
	}
	completeTurnInTransaction(tx, request) {
		const turn = this.requireTurnAndBranch(tx, request.turn, request.expectedTurnRevision, request.expectedBranchRevision);
		if (request.commit.kind !== "result" || request.commit.content === void 0 || !request.commit.subjectTurn?.equals(turn.id) || request.commit.writer.kind !== "turn" || !leaseTokensEqual(request.commit.writer.token, request.token)) throw invalidTurn$1("Turn completion requires a result commit");
		this.appendInTransaction(tx, request.commit, request.expectedBranchRevision, request.now);
		this.repository.replaceTurn(tx, turn.revision, turn.complete(request.token, request.outcome, request.commit.content, request.now));
	}
	cancelHeldTurn(request, cancellation) {
		this.repository.transaction((tx) => this.cancelHeldTurnInTransaction(tx, request, cancellation));
	}
	cancelHeldTurnInTransaction(tx, request, cancellation) {
		if (request.outcome !== "cancelled") throw invalidTurn$1("Held cancellation requires a cancelled result");
		const turn = this.requireTurnAndBranch(tx, request.turn, request.expectedTurnRevision, request.expectedBranchRevision);
		this.appendCancellation(tx, turn, cancellation, request.token);
		this.completeTurnInTransaction(tx, request);
	}
	timeoutTurn(turnId, expected, cancellation, now) {
		return this.repository.transaction((tx) => this.timeoutTurnInTransaction(tx, turnId, expected, cancellation, now));
	}
	timeoutTurnInTransaction(tx, turnId, expected, cancellation, now) {
		return this.updateTurnInTransaction(tx, turnId, expected, (turn) => {
			const expiresAt = turn.lease.expiresAt?.getTime();
			if (turn.status.kind !== "running" || expiresAt === void 0 || expiresAt > now.getTime()) throw new AgentCoreError("turn.invalid-state", "Turn timeout requires an expired running lease");
			const displaced = currentToken(turn);
			this.appendCancellation(tx, turn, cancellation, displaced);
			return turn.forceCancel();
		});
	}
	terminalizeRun(request) {
		return this.repository.transaction((tx) => this.terminalizeRunInTransaction(tx, request));
	}
	terminalizeRunInTransaction(tx, request) {
		const run = this.requireActiveRun(tx, request.run);
		requireRevision(run.revision, request.expectedRunRevision);
		const turn = this.requireTurnAndBranch(tx, request.turn, request.expectedTurnRevision, request.expectedBranchRevision);
		turn.requireToken(request.token, request.now);
		if (!turn.run.equals(run.id) || request.commit.kind !== "result" || !request.commit.subjectTurn?.equals(turn.id)) throw invalidRun("Terminal result does not match the finishing Turn");
		if (request.exhausted !== void 0 && this.remainingInTransaction(tx, run, request.now)?.limit(request.exhausted) !== 0) throw invalidRun("Terminal exhaustion names a dimension with allowance left");
		const cancellation = request.cancellation;
		if (request.outcome === "cancelled" !== (cancellation !== void 0)) throw invalidRun("A cancelled Run names the cancellation that reached its published items, and no other outcome names one");
		if (cancellation !== void 0 && !cancellation.aborted) throw invalidRun("A cancelled Run names cancellation that has already reached its published items");
		const forcedSiblings = this.forceCancelSiblings(tx, request, run, turn);
		const preterminal = requireValue(this.repository.loadBranch(tx, turn.branch), "Terminal branch is missing").head;
		const registry = this.requireAdmission(tx, run.id);
		this.validateTerminalSiblings(tx, run.id, turn.id, forcedSiblings);
		const closedRegistry = registry.close();
		if (closedRegistry === registry) throw invalidRun("Run admission registry is already closed");
		this.repository.replaceAdmission(tx, registry, closedRegistry);
		const obligation = new SettlementObligation({
			registryEpoch: closedRegistry.epoch,
			obligations: closedRegistry.frontier()
		});
		this.appendInTransaction(tx, request.commit, request.expectedBranchRevision, request.now);
		const completed = turn.complete(request.token, request.outcome, request.commit.content, request.now);
		this.repository.replaceTurn(tx, turn.revision, completed);
		const snapshot = new TerminalSnapshot(run.id, turn.id, preterminal, request.commit.id, request.outcome, obligation, request.now, request.exhausted);
		const cancellations = cancellation === void 0 ? [] : this.cancellationDeliveriesInTransaction(tx, run.id, obligation, request.commit.id);
		const currentRun = requireValue(this.repository.loadRun(tx, run.id), "Run disappeared during terminalization");
		this.repository.replaceRun(tx, currentRun.revision, currentRun.terminalize(snapshot, cancellations));
		return Object.freeze({ snapshot });
	}
	/**
	* The messages cancelling this Run owes the Invocation owners of the items its Turns
	* published (SPEC §5.6).
	*
	* Publication is what detaches an item from the Turn that issued it, and it detaches the
	* item to a Run: the issuing Run for an `InvocationId` handle, the child Run for a
	* `RunRef`. So this reads each captured item's handle back and asks the handle whose
	* cancellation it answers to. Cancelling this Run reaches the items it owns and stops
	* there — a child Run is its own settlement unit — and cancelling a Turn reaches none of
	* them, because a published item's owner is a RunId and a TurnId never equals one.
	*
	* Only an item still owed a Receipt is addressed. An item whose current Receipt is
	* already terminal was finished before the cancellation arrived, and §7.4 admits no
	* second Receipt over it, so addressing it would ask for a record that already exists.
	*
	* An item no Turn published is reached by neither: it is still awaited, so the Turn owns
	* it and `C13-FACET-CANCELLATION-REACH` is the rule that ends it. That is why an
	* unresolved handle is silence here rather than a refusal — §5.6 draws exactly this line
	* between an awaited item and a published one.
	*
	* Every message is a request naming the exact attempt, never a failure kind. The Run
	* knows that it ended; only the Invocation owner's own target can observe whether
	* cancellation reached the attempt, which is what §7.4 builds `aborted` from.
	*/
	cancellationDeliveriesInTransaction(tx, run, obligation, terminalCommit) {
		const addressed = [];
		for (const captured of obligation.obligations) {
			if (captured.kind !== "invocationItem") continue;
			if (requireSynchronousResult(this.settlement.invocationItemTerminal(tx, captured.invocation, captured.itemIndex, captured.itemKey)) === true) continue;
			const delivery = requireSynchronousResult(this.evidence.publishedHandle(tx, captured.invocation, captured.itemIndex, captured.itemKey))?.cancellationDelivery(run, terminalCommit);
			if (delivery === void 0) continue;
			addressed.push(delivery);
		}
		return Object.freeze(addressed);
	}
	/**
	* Reserves the Run obligation a published handle detaches its item into and takes on the
	* message its Invocation owner is owed, in one transaction (SPEC §5.2, §5.6). An item
	* detached to a child Run reserves the obligation and owes this Run's owner nothing.
	*/
	publishAdmissionInTransaction(tx, handle) {
		const reservation = this.reserveRunObligationInTransaction(tx, handle.run, handle.obligation());
		const delivery = handle.admissionDelivery();
		if (delivery !== void 0) {
			const run = this.requireActiveRun(tx, handle.run);
			const owed = run.publishDelivery(delivery);
			if (owed !== run) this.repository.replaceRun(tx, run.revision, owed);
		}
		return reservation;
	}
	/** The messages this Run still owes Invocation owners, in canonical order (SPEC §5.6). */
	pendingInvocationDeliveries(run) {
		return this.repository.transaction((tx) => this.pendingInvocationDeliveriesInTransaction(tx, run));
	}
	pendingInvocationDeliveriesInTransaction(tx, run) {
		return requireValue(this.repository.loadRun(tx, run), "Run does not exist").deliveries;
	}
	/**
	* Discharges one message its Invocation owner has acknowledged (SPEC §5.6, §6.1).
	*
	* The caller presents the message rather than an expected Run revision, and that is the
	* point: delivery is at-least-once, so the ordinary retry is an owner whose
	* acknowledgement response was lost and which therefore knows no current revision. The
	* transaction reads the Run itself, so the compare-and-set is against the state the
	* discharge actually applies to. A message of another Run is refused; a message already
	* discharged changes nothing and is not an error.
	*/
	acknowledgeInvocationDelivery(delivery) {
		this.repository.transaction((tx) => this.acknowledgeInvocationDeliveryInTransaction(tx, delivery));
	}
	acknowledgeInvocationDeliveryInTransaction(tx, delivery) {
		const run = requireValue(this.repository.loadRun(tx, delivery.run), "Run does not exist");
		const discharged = run.acknowledgeDelivery(delivery);
		if (discharged === run) return;
		this.repository.replaceRun(tx, run.revision, discharged);
	}
	/**
	* Accumulated where a model call commits (SPEC §5.1, §5.2). `tokens` and `costMicros`
	* are the two ceiling dimensions with no derivation from records the Run already keeps,
	* so both advance here, in one transaction, or neither does. A host with no realized
	* cost to report passes none and leaves the dimension unbounded; it never passes an
	* estimate, and there is no field an estimate could travel in.
	*/
	recordModelUsage(runId, tokens, cost) {
		return this.repository.transaction((tx) => this.recordModelUsageInTransaction(tx, runId, tokens, cost));
	}
	recordModelUsageInTransaction(tx, runId, tokens, cost) {
		const run = this.requireActiveRun(tx, runId);
		const updated = run.recordModelUsage(tokens, cost, cost === void 0 ? [] : this.lineageCurrenciesInTransaction(tx, run));
		this.repository.replaceRun(tx, run.revision, updated);
		return updated;
	}
	/**
	* Every currency the Runs sharing this Run's lineage already record cost in (SPEC §5.2).
	*
	* A lineage runs from the root down through the spawn chain, so a Run shares a lineage
	* with its ancestors and with its descendants, and a cost recorded here is a cost in every
	* one of their lineages. Both directions therefore bind: reading only ancestors admitted a
	* parent's second currency whenever a child had recorded first, because the child's walk
	* found nothing above it and the parent's found nothing below. Siblings share no lineage —
	* neither is the other's ancestor — so neither constrains the other, and a parent that
	* would sit in both of their lineages is refused instead.
	*
	* The answer is derived from the durable Run records the spawn lineage already keeps, so a
	* mixed-currency lineage is refused at the recording path rather than stored a second time
	* or surfacing later as a remainder nobody can compare.
	*/
	lineageCurrenciesInTransaction(tx, run) {
		const held = [];
		const record = (candidate) => {
			const currency = candidate.costConsumed?.currency;
			if (currency !== void 0 && !held.some((value) => value.equals(currency))) held.push(currency);
		};
		record(run);
		const walked = /* @__PURE__ */ new Set([run.id.value]);
		let ancestor = run.parent === void 0 ? void 0 : this.repository.loadRun(tx, run.parent);
		while (ancestor !== void 0 && !walked.has(ancestor.id.value)) {
			walked.add(ancestor.id.value);
			record(ancestor);
			ancestor = ancestor.parent === void 0 ? void 0 : this.repository.loadRun(tx, ancestor.parent);
		}
		const stored = this.repository.listRuns(tx);
		const descendants = /* @__PURE__ */ new Set([run.id.value]);
		let growing = true;
		while (growing) {
			growing = false;
			for (const candidate of stored) {
				const parent = candidate.parent;
				if (parent === void 0 || descendants.has(candidate.id.value) || !descendants.has(parent.value)) continue;
				descendants.add(candidate.id.value);
				record(candidate);
				growing = true;
			}
		}
		return Object.freeze(held);
	}
	remainingResources(runId, now) {
		return this.repository.transaction((tx) => this.remainingResourcesInTransaction(tx, runId, now));
	}
	remainingResourcesInTransaction(tx, runId, now) {
		const run = requireValue(this.repository.loadRun(tx, runId), "Run does not exist");
		return this.remainingInTransaction(tx, run, now);
	}
	exhaustedResource(runId, now) {
		return exhaustedResource(this.remainingResources(runId, now));
	}
	settled(runId) {
		return this.repository.transaction((tx) => this.settledInTransaction(tx, runId));
	}
	settledInTransaction(tx, runId) {
		const run = requireValue(this.repository.loadRun(tx, runId), "Run does not exist");
		return run.terminal !== void 0 && isSettled(tx, run.terminal.obligation, this.settlement);
	}
	effectiveCommit(runId, branchId) {
		return this.repository.transaction((tx) => this.effectiveBranchCommitInTransaction(tx, runId, branchId));
	}
	effectiveBranchCommitInTransaction(tx, runId, branchId) {
		const branch = requireValue(this.repository.loadBranch(tx, branchId), "Run branch does not exist");
		if (!branch.run.equals(runId)) throw invalidRun("Run branch belongs to another Run");
		return effectiveCommitOf(this.commitLoader(tx), branch.head).id;
	}
	/**
	* The model-visible sequence a call reads. With `base` omitted it derives at the
	* branch's effective state; with `base` given it derives at exactly that commit, which
	* is how a reconstruction stays fixed by ancestry rather than by when it runs.
	*/
	effectiveTranscript(runId, branchId, base) {
		return this.repository.transaction((tx) => this.effectiveTranscriptInTransaction(tx, runId, branchId, base));
	}
	effectiveTranscriptInTransaction(tx, runId, branchId, base) {
		const branch = requireValue(this.repository.loadBranch(tx, branchId), "Run branch does not exist");
		if (!branch.run.equals(runId)) throw invalidRun("Run branch belongs to another Run");
		if (base === void 0) return this.transcriptAt(tx, branch.head);
		if (!this.repository.isAncestor(tx, base, branch.head)) throw invalidRun("Transcript base is not an ancestor of the branch head");
		return effectiveTranscript(requireValue(this.repository.loadCommit(tx, base), "Transcript base does not exist"), this.commitLoader(tx));
	}
	appendInTransaction(tx, commit, expectedBranchRevision, now, allowTerminal = false) {
		const run = requireValue(this.repository.loadRun(tx, commit.run), "Run does not exist");
		if (!allowTerminal && run.lifecycle.kind !== "active") throw new AgentCoreError("run.invalid-state", "Terminal Runs reject ordinary commits");
		const branch = requireValue(this.repository.loadBranch(tx, commit.branch), "Run branch does not exist");
		requireRevision(branch.revision, expectedBranchRevision);
		if (!branch.run.equals(run.id) || this.repository.loadCommit(tx, commit.id) !== void 0) throw invalidRun("Run commit target is invalid");
		if (commit.kind === "merge") this.validateMerge(tx, commit, branch);
		else if (commit.parents.length !== 1 || !commit.parents[0].equals(branch.head)) throw new AgentCoreError("protocol.revision-conflict", "Run commit parent is not the current branch head");
		const parent = requireValue(this.repository.loadCommit(tx, commit.parents[0]), "Run commit parent does not exist");
		if (!parent.run.equals(run.id)) throw invalidRun("Run commit parent belongs to another Run");
		if (commit.kind === "migration") {
			if (!commit.migration?.from.equals(parent.pins)) throw invalidRun("Migration from pins do not match the parent");
			if (this.repository.listTurns(tx).some((turn) => turn.run.equals(run.id) && turn.branch.equals(branch.id) && !isTerminalTurn(turn))) throw new AgentCoreError("run.invalid-state", "Migration rejects an admitted Turn on its branch");
		} else if (!commit.pins.equals(parent.pins)) throw invalidRun("Non-migration Run commit must inherit parent pins");
		if (commit.writer.kind === "turn") {
			const turn = requireValue(this.repository.loadTurn(tx, commit.writer.token.turn), "Commit Turn does not exist");
			if (!turn.run.equals(run.id) || !turn.branch.equals(branch.id) || !turn.pins.equals(commit.pins)) throw invalidRun("Turn writer does not belong to the commit lineage");
			turn.requireToken(commit.writer.token, now);
		}
		if (commit.kind === "undo" && !this.repository.isAncestor(tx, commit.selects, branch.head)) throw invalidRun("Undo selection must be an ancestor of the current head");
		if (commit.kind === "undo") requireBalancedCut(this.transcriptAt(tx, branch.head), this.transcriptAt(tx, requireValue(commit.selects, "Undo commit names no selection")), "Undo selection");
		if (commit.kind === "undo" && this.repository.listTurns(tx).some((turn) => {
			return turn.run.equals(run.id) && turn.branch.equals(branch.id) && turn.status.kind === "running" && turn.lease.holder !== void 0;
		})) throw new AgentCoreError("run.invalid-state", "Undo requires the in-flight Turn to be fenced first");
		validateCommitWriter(tx, commit, this.evidence);
		this.repository.insertCommit(tx, commit);
		this.repository.replaceBranch(tx, branch.revision, branch.advance(commit.id));
		this.repository.replaceRun(tx, run.revision, allowTerminal ? run.recordEvidence() : run.revise());
	}
	validateMerge(tx, commit, target) {
		if (!commit.parents[0]?.equals(target.head) || commit.parents[1] === void 0 || commit.parents[0].equals(commit.parents[1])) throw new AgentCoreError("protocol.revision-conflict", "Merge parents are not distinct ordered current heads");
		const source = this.repository.listBranches(tx).find((branch) => !branch.id.equals(target.id) && branch.run.equals(target.run) && branch.head.equals(commit.parents[1]));
		const targetCommit = this.repository.loadCommit(tx, target.head);
		const sourceCommit = this.repository.loadCommit(tx, commit.parents[1]);
		if (source === void 0 || targetCommit === void 0 || sourceCommit === void 0) throw invalidRun("Merge requires equal-pinned current heads from distinct branches");
		const parentDivergence = targetCommit.pins.divergence(sourceCommit.pins);
		if (parentDivergence.length > 0) throw invalidRun("Merge requires equal-pinned current heads; migrate the divergent pins first: " + describeDivergence(parentDivergence));
		const commitDivergence = commit.pins.divergence(targetCommit.pins);
		if (commitDivergence.length > 0) throw invalidRun("Merge commit must carry its equal-pinned parents' pins; divergent pins: " + describeDivergence(commitDivergence));
		this.validateFoldStep(tx, commit, source);
		const parentIds = commit.parents.map((parent) => parent.value);
		if (commit.resolution?.kind === "pick") {
			const pickedIndex = parentIds.indexOf(commit.resolution.parent.value);
			const picked = pickedIndex < 0 ? void 0 : [targetCommit, sourceCommit][pickedIndex];
			if (picked?.content === void 0 || commit.content === void 0 || !picked.content.equals(commit.content)) throw invalidRun("Pick resolution must copy one exact parent content");
		}
		if (commit.resolution?.kind === "concat" && requireSynchronousResult(this.merge.verifyConcat(tx, commit, targetCommit, sourceCommit)) !== true) throw invalidRun("Concat resolution does not match canonical parent-order content");
		const tree = commit.treeResolution;
		if (requireSynchronousResult(this.merge.declaredTreeMerge(tx, commit)) === void 0 && (tree !== void 0 || targetCommit.treeCheckpoint !== void 0 && sourceCommit.treeCheckpoint !== void 0)) throw invalidRun("Merging two branches over one Environment requires a declared policies.treeMerge");
		if (tree !== void 0) {
			if (tree.policy === "ours" && !tree.side.equals(commit.parents[0]) || tree.policy === "theirs" && !tree.side.equals(commit.parents[1]) || tree.policy === "perPath" && tree.resolutions.some((path) => !parentIds.includes(path.side.value))) throw invalidRun("Tree resolution sides must name the ordered merge parents");
			if (tree.policy === "ours" || tree.policy === "theirs") {
				const selected = tree.policy === "ours" ? targetCommit : sourceCommit;
				if (selected.treeCheckpoint === void 0 || commit.treeCheckpoint === void 0 || !selected.treeCheckpoint.equals(commit.treeCheckpoint)) throw invalidRun("Tree side resolution must copy the selected parent tree");
			}
			if (requireSynchronousResult(this.merge.verifyTree(tx, commit, targetCommit, sourceCommit)) !== true) throw invalidRun("Tree resolution lacks exact base, Environment, or conflict evidence");
		}
	}
	/**
	* A merge authorized by one item of a declared fold must be the step that item declared.
	* The declaration is the ordered `administer` payload (§5.2); the merge chain below this
	* commit is what the fold has done so far, so the two are compared rather than a position
	* being trusted from the record that claims it.
	*/
	validateFoldStep(tx, commit, source) {
		const fold = this.foldStepOf(tx, commit);
		if (fold === void 0) return;
		if (!Number.isSafeInteger(fold.itemIndex) || !Number.isSafeInteger(fold.itemCount) || fold.itemIndex < 0 || fold.itemIndex >= fold.itemCount) throw invalidRun("Fold item index is outside its declared payload");
		if (!fold.source.equals(source.id)) throw invalidRun("Fold step must join the exact source branch its item declared");
		const target = requireValue(commit.parents[0], "A merge names its target parent");
		const preceding = this.precedingFoldSteps(tx, target, fold.invocation);
		if (preceding.length !== fold.itemIndex || preceding.some((step, offset) => step.itemIndex !== fold.itemIndex - 1 - offset)) throw invalidRun("Fold item must extend exactly the merge its predecessor appended");
		if (preceding.some((step) => step.itemCount !== fold.itemCount)) throw invalidRun("Fold items must declare one payload length");
		if (preceding.some((step) => step.source.equals(fold.source))) throw invalidRun("A fold joins each declared source branch once");
	}
	/** The fold item a control-authored commit's Receipt carries, if it carries one. */
	foldStepOf(tx, commit) {
		const writer = commit.writer;
		if (writer.kind !== "system" || writer.cause.kind !== "control") return void 0;
		return this.evidence.control(tx, writer.cause.receipt, writer.cause.audit)?.fold;
	}
	/** Steps of the same fold already appended below a commit, nearest first. */
	precedingFoldSteps(tx, from, invocation) {
		const steps = [];
		let cursor = this.repository.loadCommit(tx, from);
		while (cursor?.kind === "merge") {
			const step = this.foldStepOf(tx, cursor);
			if (step === void 0 || !step.invocation.equals(invocation)) break;
			steps.push(step);
			const parent = cursor.parents[0];
			cursor = parent === void 0 ? void 0 : this.repository.loadCommit(tx, parent);
		}
		return steps;
	}
	updateTurnInTransaction(tx, turnId, expected, update) {
		const turn = requireValue(this.repository.loadTurn(tx, turnId), "Turn does not exist");
		requireRevision(turn.revision, expected);
		const run = this.requireActiveRun(tx, turn.run);
		const next = update(turn);
		this.repository.replaceTurn(tx, turn.revision, next);
		this.repository.replaceRun(tx, run.revision, run.revise());
		return next;
	}
	appendCancellation(tx, turn, entry, displaced) {
		const inbox = this.repository.listInbox(tx, turn.id);
		if (entry.event !== "turn.cancel" || !entry.turn.equals(turn.id) || entry.cancellationToken === void 0 || !leaseTokensEqual(entry.cancellationToken, displaced)) throw invalidTurn$1("Turn cancellation must append the next entry for the displaced token");
		const recorded = inbox.find((existing) => existing.cancellationToken !== void 0 && leaseTokensEqual(existing.cancellationToken, displaced));
		if (recorded !== void 0) {
			if (!bytesEqual(TurnInboxEntry.codec.encode(recorded), TurnInboxEntry.codec.encode(entry))) throw invalidTurn$1("Turn cancellation for this lease is already recorded");
			return;
		}
		if (entry.sequence !== inbox.length || inbox.some((existing) => existing.idempotencyKey === entry.idempotencyKey)) throw invalidTurn$1("Turn cancellation must append the next entry for the displaced token");
		this.repository.insertInbox(tx, entry);
	}
	forceCancelSiblings(tx, request, run, terminalTurn) {
		if (this.repository.listForcedCancellations(tx, run.id).length !== 0) throw invalidRun("Active Run contains preexisting forced cancellation records");
		const pending = this.repository.listTurns(tx).filter((value) => value.run.equals(run.id) && !value.id.equals(terminalTurn.id)).filter((sibling) => !isTerminalTurn(sibling) || sibling.lease.holder !== void 0);
		if (pending.length === 0) {
			if (request.forcedCancellationControl !== void 0 || request.siblingCancellations.size !== 0) throw invalidRun("Terminalization supplied unused forced cancellation evidence");
			return [];
		}
		const control = request.forcedCancellationControl;
		if (control === void 0 || request.siblingCancellations.size !== pending.length) throw invalidRun("Terminalization requires one control and exact evidence for every active sibling");
		this.requireAdministerControl(tx, run.id, terminalTurn.id, control);
		const cancellations = pending.map((sibling) => {
			const supplied = request.siblingCancellations.get(sibling.id.value);
			if (supplied === void 0) throw invalidRun("Terminalization is missing sibling cancellation evidence");
			const fenced = sibling.forceCancel();
			const cancellation = new ForcedTurnCancellation({
				run: run.id,
				terminalTurn: terminalTurn.id,
				turn: sibling.id,
				priorLeaseEpoch: sibling.lease.epoch,
				fencedLeaseEpoch: fenced.lease.epoch,
				controlReceipt: control.receipt,
				controlAudit: control.audit,
				cancellationEvent: supplied.event,
				cancellationAudit: supplied.audit
			});
			this.requireForcedCancellationEvidence(tx, cancellation);
			return {
				sibling,
				fenced,
				cancellation
			};
		});
		for (const value of cancellations) {
			this.repository.replaceTurn(tx, value.sibling.revision, value.fenced);
			this.repository.insertForcedCancellation(tx, value.cancellation);
		}
		return cancellations.map((value) => value.sibling.id);
	}
	validateTerminalSiblings(tx, run, terminalTurn, forcedSiblings) {
		const siblings = this.repository.listTurns(tx).filter((value) => value.run.equals(run) && !value.id.equals(terminalTurn));
		if (siblings.some((sibling) => !isTerminalTurn(sibling) || sibling.lease.holder !== void 0)) throw invalidRun("Run admission cannot close while a sibling is active or held");
		const records = this.repository.listForcedCancellations(tx, run);
		if (records.length !== forcedSiblings.length || forcedSiblings.some((turn) => !records.some((record) => record.turn.equals(turn)))) throw invalidRun("Every forcibly fenced sibling requires one cancellation record");
		for (const record of records) {
			const sibling = siblings.find((value) => value.id.equals(record.turn));
			if (!record.run.equals(run) || !record.terminalTurn.equals(terminalTurn) || sibling === void 0 || sibling.status.kind !== "cancelled" || sibling.lease.holder !== void 0 || sibling.lease.epoch !== record.fencedLeaseEpoch) throw invalidRun("Forced cancellation record does not match its fenced sibling");
			this.requireAdministerControl(tx, run, terminalTurn, {
				receipt: record.controlReceipt,
				audit: record.controlAudit
			});
			this.requireForcedCancellationEvidence(tx, record);
		}
	}
	requireAdministerControl(tx, run, terminalTurn, control) {
		const evidence = requireSynchronousResult(this.evidence.administer(tx, control.receipt, control.audit));
		if (evidence === void 0 || evidence.kind !== "administer" || evidence.outcome !== "succeeded" || !evidence.run.equals(run) || !evidence.terminalTurn.equals(terminalTurn) || !evidence.receipt.equals(control.receipt) || !evidence.audit.equals(control.audit)) throw new AgentCoreError("authority.denied", "Forced cancellation requires the exact successful administer Receipt and Audit");
	}
	requireForcedCancellationEvidence(tx, cancellation) {
		const evidence = requireSynchronousResult(this.evidence.forcedCancellation(tx, cancellation.cancellationEvent, cancellation.cancellationAudit));
		if (evidence === void 0 || evidence.kind !== "turnCancellation" || evidence.eventKind !== "turn.cancel" || !evidence.run.equals(cancellation.run) || !evidence.terminalTurn.equals(cancellation.terminalTurn) || !evidence.turn.equals(cancellation.turn) || evidence.priorLeaseEpoch !== cancellation.priorLeaseEpoch || evidence.fencedLeaseEpoch !== cancellation.fencedLeaseEpoch || evidence.inboxLeaseEpoch !== cancellation.priorLeaseEpoch || !evidence.controlReceipt.equals(cancellation.controlReceipt) || !evidence.controlAudit.equals(cancellation.controlAudit) || !evidence.event.equals(cancellation.cancellationEvent) || !evidence.audit.equals(cancellation.cancellationAudit)) throw invalidRun("Forced cancellation inbox and Audit evidence do not match the fence");
	}
	requireTurnAndBranch(tx, turnId, turnRevision, branchRevision) {
		const turn = requireValue(this.repository.loadTurn(tx, turnId), "Turn does not exist");
		requireRevision(turn.revision, turnRevision);
		requireRevision(requireValue(this.repository.loadBranch(tx, turn.branch), "Turn branch does not exist").revision, branchRevision);
		return turn;
	}
	requireAttenuation(tx, reservation) {
		const attenuation = this.spawn.attenuation(tx, reservation);
		if (!Digest.sha256(SpawnAttenuation.codec.encode(attenuation)).equals(reservation.attenuation)) throw new AgentCoreError("authority.denied", "Spawn attenuation does not match the digest the reservation commits");
		return attenuation;
	}
	remainingInTransaction(tx, run, now) {
		const parent = run.parent === void 0 ? void 0 : this.repository.loadRun(tx, run.parent);
		const inherited = parent === void 0 ? void 0 : this.remainingInTransaction(tx, parent, now);
		const reservation = this.repository.loadSpawnForChild(tx, run.id);
		return narrowResources(inherited, reservation === void 0 ? void 0 : this.requireAttenuation(tx, reservation).ceiling, {
			costMicros: run.costConsumed?.micros ?? 0,
			tokens: run.tokensConsumed,
			wallClockMs: reservation === void 0 ? 0 : Math.max(0, now.getTime() - reservation.recordedAt.getTime())
		});
	}
	requireNarrowingCeiling(tx, reservation, parent, now) {
		const declared = this.requireAttenuation(tx, reservation).ceiling;
		const parentRemainder = this.remainingInTransaction(tx, parent, now);
		if (declared !== void 0 && widensResourceCeiling(parentRemainder, declared)) throw new AgentCoreError("authority.denied", "Spawned ceiling exceeds the parent Run's remaining allowance");
		const exhausted = exhaustedResource(parentRemainder);
		if (exhausted !== void 0) throw new AgentCoreError("authority.denied", `Spawn exhausts the parent Run's ${exhausted} allowance`);
	}
	headTreeDigestInTransaction(tx, run) {
		const branch = requireValue(this.repository.loadBranch(tx, run.initialBranch), "Run initial branch does not exist");
		return requireValue(this.repository.loadCommit(tx, branch.head), "Run head commit does not exist").treeCheckpoint?.digest;
	}
	/**
	* Resolves a commit identity against the store, answering for `pending` itself so the
	* same derivation decides a cut a commit proposes and one it already made.
	*/
	commitLoader(tx, pending) {
		return (id) => pending !== void 0 && id.equals(pending.id) ? pending : this.repository.loadCommit(tx, id);
	}
	transcriptAt(tx, head, pending) {
		const load = this.commitLoader(tx, pending);
		return effectiveTranscript(effectiveCommitOf(load, head), load);
	}
	/**
	* A `TextId` keeps its identity in its class and its value, but every subclass has the
	* same shape, so a TurnId presented where a RunId is required is a value this signature
	* cannot refuse on its own. Storage keys are text, so such a call would load the Run
	* whose id reads the same and then compare identities that never match — a cancellation
	* that reached no published item, and nothing said so. The exact class is required here,
	* at the one gate every Run mutation passes through.
	*/
	requireActiveRun(tx, id) {
		if (id.constructor !== RunId) throw new TypeError("Run identity must be the exact Run ID class");
		const run = requireValue(this.repository.loadRun(tx, id), "Run does not exist");
		if (run.lifecycle.kind !== RunLifecycle.active.kind) throw new AgentCoreError("run.invalid-state", "Run is terminal");
		return run;
	}
	requireAdmission(tx, run) {
		const registry = this.repository.loadAdmission(tx, run);
		if (registry === void 0) throw new AgentCoreError("codec.invalid", "Run admission registry is missing");
		return registry;
	}
	requireConfigurationForPins(tx, run, pins) {
		const matching = run.configurations.map((id) => this.repository.loadConfiguration(tx, id.value)).filter((value) => value !== void 0 && value.pins.equals(pins));
		if (matching.length !== 1) throw invalidRun("Run pins do not resolve one exact configuration snapshot");
		return matching[0];
	}
};
/**
* What an `input.submitted` rewrite may do: replace the payload, and nothing else. The
* `ContentRef` constructor is part of the rule rather than a later check, because a
* malformed reference admitted here would become durable inbox history whose content can
* never resolve.
*/
var admitSubmission = (before, after) => {
	const previous = requireObject(before, "Submitted input");
	const next = requireObject(after, "Submitted input");
	requireExactFields(next, [
		"event",
		"idempotencyKey",
		"payload"
	], [], "Submitted input");
	if (next["event"] !== previous["event"] || next["idempotencyKey"] !== previous["idempotencyKey"]) throw new AgentCoreError("authority.denied", "An input.submitted rewrite may transform the payload, not the delivery identity");
	new ContentRef(requireString(next["payload"], "Submitted input payload"));
};
function requireRevision(actual, expected) {
	if (!actual.equals(expected)) throw new AgentCoreError("protocol.revision-conflict", "Expected revision is stale");
}
function requireValue(value, message) {
	if (value === void 0) throw new AgentCoreError("run.invalid-state", message);
	return value;
}
/**
* Every cut leaves each retained request holding its `invocation` commit and each retained
* `invocation` commit holding the request it answers. Providers reject either half alone, so
* a cut that would produce one is rejected before it lands rather than repaired afterwards.
*/
function requireBalancedCut(before, after, subject) {
	const unbalanced = unbalancedCut(before, after);
	if (unbalanced === void 0) return;
	throw new AgentCoreError("run.invalid-state", unbalanced.kind === "unanswered" ? `${subject} leaves Invocation ${unbalanced.invocation.value}, requested by ${unbalanced.commit.value}, unanswered` : `${subject} orphans the result of Invocation ${unbalanced.invocation.value} in ${unbalanced.commit.value} from the request that called it`);
}
function isTerminalTurn(turn) {
	return turn.status.kind === "succeeded" || turn.status.kind === "failed" || turn.status.kind === "cancelled";
}
function currentToken(turn) {
	if (turn.lease.holder === void 0) throw new AgentCoreError("lease.invalid", "Turn has no held lease to displace");
	return Object.freeze({
		turn: turn.id,
		holder: turn.lease.holder,
		epoch: turn.lease.epoch
	});
}
function optionalRefsEqual(left, right) {
	return left === void 0 ? right === void 0 : right !== void 0 && left.equals(right);
}
function invalidRun(message) {
	return new AgentCoreError("run.invalid-state", message);
}
/**
* Names the divergence a refusal refused on, so a caller reconciling before a fold migrates
* the pins this platform compared rather than pins it went looking for.
*/
function describeDivergence(divergence) {
	return divergence.map(({ dimension, identities }) => `${dimension.label}(${identities.join(" ")})`).join(", ");
}
function invalidTurn$1(message) {
	return new AgentCoreError("turn.invalid-state", message);
}
/**
* The generic reserve and complete paths serve every obligation kind uniformly, which is
* exactly why acceptance has to be carved out of them: §5.2 says an acceptance obligation
* completes *exactly when* a succeeded verifier Receipt names the current head tree
* digest, and a uniform completion would discharge one with no verdict at all.
*/
function requireNonAcceptanceObligation(obligation, message) {
	if (obligation.kind === "acceptance") throw new AgentCoreError("run.invalid-state", message);
}
//#endregion
//#region src/agents/runs/handle.ts
/**
* What a handle puts in the model's tool position (SPEC §5.6): a mediated Invocation's own
* admission identity, or the child RunRef a `delegate` spawn's Receipt carries. The two are
* different owners rather than two spellings of one, because an Invocation identity leaves
* the item owned by the issuing Run while a child RunRef names a settlement unit of its
* own, so each renders its own tool position and its own address instead of a reader
* branching on a kind field it has to remember the meaning of.
*/
var TurnAdmissionIdentity = class TurnAdmissionIdentity {
	static invocation(invocation) {
		return new InvocationAdmissionIdentity(invocation);
	}
	/**
	* The child a `delegate` spawn's Receipt names, with that Receipt and the digest of its
	* result. A child RunRef cannot exist before the Receipt carries it, so the evidence that
	* proves it belongs to this case alone: an Invocation identity commits at admission, where
	* no Receipt exists, and a handle carrying both would have to leave one of them empty.
	*/
	static childRun(run, receipt, result) {
		return new ChildRunAdmissionIdentity(run, receipt, result);
	}
	/**
	* Decodes exactly the fields the named case carries. One shared field list would admit an
	* Invocation identity holding a spawn Receipt, which is the pairing these two cases exist
	* to leave unconstructable.
	*/
	static fromData(value) {
		const object = requireObject(value, "Turn admission identity");
		const kind = requireString(object["kind"], "Turn admission identity kind");
		if (kind === "invocation") {
			requireExactFields(object, ["kind", "reference"], [], "Turn admission Invocation");
			return TurnAdmissionIdentity.invocation(new InvocationId(requireString(object["reference"], "Turn admission Invocation")));
		}
		if (kind === "childRun") {
			requireExactFields(object, [
				"kind",
				"receipt",
				"reference",
				"result"
			], [], "Turn admission child Run");
			return TurnAdmissionIdentity.childRun(new RunId(requireString(object["reference"], "Turn admission child Run")), new ReceiptId(requireString(object["receipt"], "Turn admission spawn Receipt")), digestFromData(object["result"], "Turn admission spawn result"));
		}
		throw new TypeError("Turn admission identity kind is invalid");
	}
};
var InvocationAdmissionIdentity = class InvocationAdmissionIdentity extends TurnAdmissionIdentity {
	invocation;
	kind = "invocation";
	childRun = void 0;
	constructor(invocation) {
		super();
		this.invocation = invocation;
		Object.freeze(this);
	}
	owner(issuingRun) {
		return issuingRun;
	}
	toolPosition() {
		return canonicalFacetData({ invocation: this.invocation.value });
	}
	get address() {
		return `invocation:${this.invocation.value}`;
	}
	equals(other) {
		return other instanceof InvocationAdmissionIdentity && other.invocation.equals(this.invocation);
	}
	toData() {
		return {
			kind: this.kind,
			reference: this.invocation.value
		};
	}
};
var ChildRunAdmissionIdentity = class ChildRunAdmissionIdentity extends TurnAdmissionIdentity {
	childRun;
	receipt;
	result;
	kind = "childRun";
	constructor(childRun, receipt, result) {
		super();
		this.childRun = childRun;
		this.receipt = receipt;
		this.result = result;
		if (receipt.constructor !== ReceiptId || result.constructor !== Digest) throw new TypeError("Turn admission child Run names its exact spawn evidence");
		Object.freeze(this);
	}
	owner() {
		return this.childRun;
	}
	toolPosition() {
		return canonicalFacetData({ run: this.childRun.value });
	}
	get address() {
		return `run:${this.childRun.value}`;
	}
	equals(other) {
		return other instanceof ChildRunAdmissionIdentity && other.childRun.equals(this.childRun) && other.receipt.equals(this.receipt) && other.result.equals(this.result);
	}
	toData() {
		return {
			kind: this.kind,
			receipt: this.receipt.value,
			reference: this.childRun.value,
			result: this.result.value
		};
	}
};
/**
* A durable, addressable reference to an admitted mediated item (SPEC §5.6). It is a value
* rather than a stored record on purpose: everything it names — the Invocation, the
* EffectAttempt, the child RunRef — is already owned durably elsewhere, so a table of handles
* would be a second copy of state with its own way of going stale. Its canonical bytes are
* what survive a process, and re-verifying those bytes against the same §7.4 records is what
* makes a decoded handle address exactly the work the original named. It carries no time of
* its own for the same reason: the EffectAttempt it names already records when the item was
* admitted.
*
* It names the four facts of the admitted item and no outcome. Admission is the commit point
* an Invocation identity has (§5.6), and admission leaves an EffectAttempt that no Receipt
* names yet, so a Receipt on this record would be a field one whole case could never fill.
* The one identity whose commit point is a Receipt carries that Receipt itself.
*
* The recorded `issuedEpoch` is provenance and never authority. A handle authorizes
* addressing its Turn; writing as that Turn needs the exact current lease (§5.3), which the
* caller presents separately and which this record cannot substitute for.
*/
var TurnAdmissionHandle = class TurnAdmissionHandle extends CodecRecord {
	static get codec() {
		return TurnAdmissionHandleCodec;
	}
	run;
	turn;
	issuedEpoch;
	invocation;
	itemIndex;
	itemKey;
	attempt;
	identity;
	constructor(init) {
		super();
		if (!Number.isSafeInteger(init.issuedEpoch) || init.issuedEpoch < 0) throw new TypeError("Turn admission handle epoch is invalid");
		if (!Number.isSafeInteger(init.itemIndex) || init.itemIndex < 0) throw new TypeError("Turn admission handle item index is invalid");
		if (init.itemKey.length === 0) throw new TypeError("Turn admission handle requires an item key");
		if (init.identity.childRun?.equals(init.run) === true) throw new TypeError("Turn admission handle child Run must be distinct");
		this.run = init.run;
		this.turn = init.turn;
		this.issuedEpoch = init.issuedEpoch;
		this.invocation = init.invocation;
		this.itemIndex = init.itemIndex;
		this.itemKey = init.itemKey;
		this.attempt = init.attempt;
		this.identity = init.identity;
		Object.freeze(this);
	}
	/** The exact canonical value the model reads in the tool position (SPEC §5.6). */
	toolPosition() {
		return this.identity.toolPosition();
	}
	/** The stable string a later delivery addresses this admission by. */
	get address() {
		return this.identity.address;
	}
	/**
	* The Run that governs this published item's cancellation (SPEC §5.6). §7.4 assigns
	* `aborted` to cancellation of the Turn or Run that owns an item, and leaves which of
	* the two open. Publication closes that disjunction. It closes it on a Run in both
	* cases: the issuing Run for an Invocation identity, and the child Run for a RunRef. A
	* published item therefore keeps no Turn owner for a Turn's cancellation to be.
	*/
	get owner() {
		return this.identity.owner(this.run);
	}
	/**
	* The durable message this published item's Invocation owner is owed when `scope`
	* cancels (SPEC §5.6). It answers nothing where `scope` does not own the item, which is
	* the issuing Turn's case: RunId and TurnId are different classes, so a cancelled Turn
	* never equals the owner and the prohibition holds by identity rather than by a branch
	* a host can forget.
	*
	* The message is a request and never a verdict. §7.4 builds `aborted` only from
	* cancellation that reached the attempt, and the Run observes its own end rather than
	* the target's live controller, so what travels here is the exact item and attempt the
	* Run stopped owning. The Invocation owner aborts its own controller and classifies the
	* attempt from what it observes, including observing that nothing is left to abort.
	*/
	cancellationDelivery(scope, terminalCommit) {
		const owner = this.owner;
		if (!owner.equals(scope)) return void 0;
		return new RunInvocationDelivery({
			run: owner,
			invocation: this.invocation,
			itemIndex: this.itemIndex,
			itemKey: this.itemKey,
			attempt: this.attempt,
			cause: RunInvocationDeliveryCause.cancellation(terminalCommit)
		});
	}
	/**
	* The durable message its Invocation owner is owed once publication has detached the
	* item into this Run (SPEC §5.6). An item detached to a child Run is that Run's own
	* settlement unit, so this Run owes its owner nothing and answers nothing.
	*/
	admissionDelivery() {
		if (this.identity.kind !== "invocation") return void 0;
		return new RunInvocationDelivery({
			run: this.run,
			invocation: this.invocation,
			itemIndex: this.itemIndex,
			itemKey: this.itemKey,
			attempt: this.attempt,
			cause: RunInvocationDeliveryCause.admission
		});
	}
	/**
	* The Run obligation publishing this handle detaches the item into (SPEC §5.2, §5.6).
	* Terminalization captures whatever is still reserved, so an outstanding handle withholds
	* Settled without holding any Turn.
	*/
	obligation() {
		return Object.freeze({
			kind: "invocationItem",
			invocation: this.invocation,
			itemIndex: this.itemIndex,
			itemKey: this.itemKey
		});
	}
	equals(other) {
		return bytesEqual(TurnAdmissionHandleCodec.encode(this), TurnAdmissionHandleCodec.encode(other));
	}
	toData() {
		return {
			attempt: this.attempt.value,
			identity: this.identity.toData(),
			invocation: this.invocation.value,
			issuedEpoch: this.issuedEpoch,
			itemIndex: this.itemIndex,
			itemKey: this.itemKey,
			run: this.run.value,
			turn: this.turn.value
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Turn admission handle");
		requireExactFields(object, [
			"attempt",
			"identity",
			"invocation",
			"issuedEpoch",
			"itemIndex",
			"itemKey",
			"run",
			"turn"
		], [], "Turn admission handle");
		return new TurnAdmissionHandle({
			run: new RunId(requireString(object["run"], "Turn admission handle Run")),
			turn: new TurnId(requireString(object["turn"], "Turn admission handle Turn")),
			issuedEpoch: requireInteger(object["issuedEpoch"], "Turn admission handle epoch"),
			invocation: new InvocationId(requireString(object["invocation"], "Turn admission handle Invocation")),
			itemIndex: requireInteger(object["itemIndex"], "Turn admission handle item index"),
			itemKey: requireString(object["itemKey"], "Turn admission handle item key"),
			attempt: new EffectAttemptId(requireString(object["attempt"], "Turn admission handle EffectAttempt")),
			identity: TurnAdmissionIdentity.fromData(requireObject(object["identity"] ?? null, "Turn admission handle identity"))
		});
	}
};
var AdmissionHandleCodec = class extends RecordCodec {
	constructor() {
		super([
			TurnAdmissionHandle,
			TurnAdmissionIdentity,
			Digest,
			RunId,
			TurnId,
			InvocationId,
			EffectAttemptId,
			ReceiptId,
			InvocationAdmissionIdentity,
			ChildRunAdmissionIdentity,
			TextId,
			CodecRecord
		], "turn.admission-handle", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return TurnAdmissionHandle.fromData(value);
	}
};
var TurnAdmissionHandleCodec = new AdmissionHandleCodec();
/**
* What one item's Receipt says (SPEC §7.4), reduced to what a handle is built from. Three
* shapes for three questions, because a single `succeeded` flag answered two of them at
* once: a pre-effect Receipt never attempted anything, while an attempt Receipt that failed
* or came back indeterminate attempted and did not succeed, and reporting both as "not
* succeeded" left one refusal covering two different operator actions. Only the succeeded
* case can be constructed at all, and it cannot be constructed without its result, so the
* pairings the verifier used to check are now unrepresentable.
*
* `detail` carries why a non-admitting Receipt does not admit — a pre-effect outcome and
* reason, or an unsuccessful attempt's outcome and failure kind. It exists for the refusal
* message and is deliberately unreachable from `admitted()`, so no admission decision can
* come to depend on Receipt failure state (§7.4, C13-RECEIPT-FAILURE-ORTHOGONAL).
*/
var TurnAdmissionReceiptFacts = class {
	/** A Receipt over an item that never reached an EffectAttempt, so nothing succeeded. */
	static preEffect(detail) {
		return new PreEffectFacts(detail);
	}
	/** An attempt Receipt that attempted and did not succeed; it names no result. */
	static unsucceeded(attempt, detail) {
		return new UnsucceededFacts(attempt, detail);
	}
	/** The only shape that admits a handle, and it cannot exist without its result. */
	static succeeded(attempt, result) {
		return new SucceededFacts(attempt, result);
	}
};
var PreEffectFacts = class extends TurnAdmissionReceiptFacts {
	detail;
	constructor(detail) {
		super();
		this.detail = detail;
		Object.freeze(this);
	}
	admit() {
		throw invalidAdmission(`Admission Receipt reached no EffectAttempt: ${this.detail}`);
	}
};
var UnsucceededFacts = class extends TurnAdmissionReceiptFacts {
	attempt;
	detail;
	constructor(attempt, detail) {
		super();
		this.attempt = attempt;
		this.detail = detail;
		Object.freeze(this);
	}
	admit() {
		throw invalidAdmission(`Admission EffectAttempt ${this.attempt.id.value} did not succeed: ${this.detail}`);
	}
};
var SucceededFacts = class extends TurnAdmissionReceiptFacts {
	#item;
	constructor(attempt, result) {
		super();
		this.#item = Object.freeze({
			attempt,
			result
		});
		Object.freeze(this);
	}
	admit() {
		return this.#item;
	}
};
/**
* Reads the §7.4 evidence a handle is built from. Deliberately narrow: this seam retrieves
* records and resolves content and decides nothing, so every rule about what that evidence
* must say lives in `TurnAdmissionVerifier` and no substrate can admit a handle the Turn
* layer would refuse.
*/
var TurnAdmissionRecordPort = class {};
/**
* Builds a handle at either of the two commit points §5.6 gives one, or refuses. Admission
* itself is untouched in both: this runs after the Invocation plane has recorded what it
* records, and reads that rather than adding to it.
*
* `admit` is the admission commit point. An item with a durable EffectAttempt and no Receipt
* is exactly what a detached admission leaves, so the facts of that item are all this path
* reads and there is no Receipt for it to wait on.
*
* `verify` is the Receipt commit point, which one identity genuinely needs: a child RunRef
* cannot exist before the spawn's `delegate` Receipt carries it. A spawn's Receipt has to
* carry that RunRef and nothing else, so a result naming a child alongside any other field is
* rejected instead of being read as a child handle plus extra output. A mediated result that
* names no child leaves the Invocation as the identity, and the item facts it is built from
* are the ones the Receipt's own EffectAttempt reports, so both paths end in one builder.
*/
var TurnAdmissionVerifier = class {
	records;
	constructor(records) {
		this.records = records;
	}
	/**
	* The handle an admitted item admits, with no Receipt read (SPEC §5.6). The item is the
	* whole evidence: it names the Invocation, the item index, that item's key and the exact
	* EffectAttempt admission recorded, which is what a later delivery is matched against.
	*/
	admit(scope, item) {
		this.requireIssuingScope(scope);
		return this.build(scope, item, TurnAdmissionIdentity.invocation(item.invocation));
	}
	async verify(request) {
		this.requireIssuingScope(request);
		const [receipt] = request.receipts;
		if (receipt === void 0 || request.receipts.length !== 1) throw invalidAdmission("A Turn-issued admission names exactly one item Receipt");
		const facts = await this.records.receipt(receipt);
		if (facts === void 0) throw invalidAdmission("Admission evidence names no stored Receipt");
		const admitted = facts.admit();
		if (!admitted.attempt.invocation.equals(request.invocation)) throw invalidAdmission("Admission Receipt names another Invocation's EffectAttempt");
		const bytes = await this.records.result(admitted.result);
		if (!Digest.sha256(bytes).equals(admitted.result.digest)) throw invalidAdmission("Admission result bytes do not hash to the Receipt's content");
		const item = {
			invocation: admitted.attempt.invocation,
			itemIndex: admitted.attempt.itemIndex,
			itemKey: admitted.attempt.idempotencyKey,
			attempt: admitted.attempt.id
		};
		const child = childRunOf(request, bytes);
		return this.build(request, item, child === void 0 ? TurnAdmissionIdentity.invocation(request.invocation) : TurnAdmissionIdentity.childRun(child, receipt, admitted.result.digest));
	}
	build(scope, item, identity) {
		return new TurnAdmissionHandle({
			run: scope.run,
			turn: scope.turn,
			issuedEpoch: scope.token.epoch,
			invocation: item.invocation,
			itemIndex: item.itemIndex,
			itemKey: item.itemKey,
			attempt: item.attempt,
			identity
		});
	}
	requireIssuingScope(scope) {
		if (!scope.token.turn.equals(scope.turn)) throw new AgentCoreError("lease.invalid", "A Turn admission handle names the exact Turn its lease token holds");
	}
};
/**
* An Event a handle addresses to a Turn's inbox (SPEC §5.6). Cancellation is not one of
* them: `turn.cancel` is the reserved inbox Event a fence delivers, and routing it through a
* handle would make a detached reference a way to end a Turn it no longer belongs to.
*/
var TurnAdmissionMessage = class {
	/** The awaited answer, arriving as ordinary history once admission has detached. */
	static outcome(payload) {
		return new OutcomeMessage(canonicalFacetData(payload));
	}
	/** External steering of admitted work, keyed by the caller's own nonce. */
	static steering(nonce, payload) {
		return new SteeringMessage(nonce, canonicalFacetData(payload));
	}
};
var OutcomeMessage = class extends TurnAdmissionMessage {
	payload;
	event = "admission.outcome";
	constructor(payload) {
		super();
		this.payload = payload;
		Object.freeze(this);
	}
	key(handle) {
		return JSON.stringify([handle.address, "outcome"]);
	}
};
var SteeringMessage = class extends TurnAdmissionMessage {
	nonce;
	payload;
	event = "admission.steering";
	constructor(nonce, payload) {
		super();
		this.nonce = nonce;
		this.payload = payload;
		if (nonce.length === 0) throw new TypeError("Admission steering requires a nonce");
		Object.freeze(this);
	}
	key(handle) {
		return JSON.stringify([
			handle.address,
			"steering",
			this.nonce
		]);
	}
};
/**
* Publishes handles and addresses the work they name (SPEC §5.6).
*
* Publication is the point where an item stops being awaited and becomes owned by the Run,
* so it reserves exactly the §5.2 admission obligation terminalization already knows how to
* capture — the handle's lifetime and the Run's terminalization are therefore one story:
* terminalization closes the registry with the handle's item still in the frontier, the Run
* terminalizes normally, and `isSettled` withholds Settled until that item has a terminal
* current Receipt. A handle is never a hold on a Turn, which is why ending the issuing Turn
* is the ordinary case this shape exists for.
*
* Every mutation here presents the addressed Turn's exact current lease and is refused
* without it, so a handle that outlives its Turn can still name the work and can no longer
* write as it.
*/
var TurnAdmissionPublisher = class {
	runtime;
	content;
	constructor(runtime, content) {
		this.runtime = runtime;
		this.content = content;
	}
	/**
	* Reserves the Run obligation a published handle detaches its item into, and in the same
	* transaction takes on the message its Invocation owner is owed (SPEC §5.2, §5.6).
	*
	* One transaction, because the two facts are one fact: an obligation the Run holds with
	* no message durable would leave the owner never told to start, and a message durable
	* with no obligation would let the Run settle while the item is still owed.
	*/
	publish(handle, token, now) {
		return this.runtime.repository.transaction((tx) => {
			this.requireIssuingLease(tx, handle, token, now);
			return this.runtime.publishAdmissionInTransaction(tx, handle);
		});
	}
	/** Discharges a published handle's obligation once its item is no longer outstanding. */
	settle(reservation) {
		this.runtime.completeRunObligation(reservation);
	}
	/**
	* Appends the handle's addressed Event to a Turn's inbox under that Turn's own lease. The
	* addressed Turn may be a later one than the issuing Turn — that is the shape §5.6 exists
	* for — but never one outside the Run the handle detached into, so a handle can be read
	* as history without becoming reach into an unrelated Run.
	*/
	async deliver(delivery) {
		const put = await this.content.put(encodeCanonicalJson(delivery.message.payload));
		const key = delivery.message.key(delivery.handle);
		return this.runtime.repository.transaction((tx) => {
			const addressed = this.runtime.repository.loadTurn(tx, delivery.turn);
			if (addressed === void 0 || !addressed.run.equals(delivery.handle.run)) throw new AgentCoreError("turn.invalid-state", "A Turn admission handle addresses only Turns of the Run it detached into");
			const sequence = this.runtime.repository.listInbox(tx, delivery.turn).length;
			const entry = new TurnInboxEntry(new TurnInboxEntryId(`${key}#${sequence}`), delivery.turn, sequence, delivery.message.event, put.ref, put.ref.digest, key, void 0, delivery.now);
			this.runtime.deliverEventInTransaction(tx, delivery.turn, delivery.expected, delivery.token, entry, delivery.now);
			return entry;
		});
	}
	requireIssuingLease(tx, handle, token, now) {
		const turn = this.runtime.repository.loadTurn(tx, handle.turn);
		if (turn === void 0) throw new AgentCoreError("turn.invalid-state", "A Turn admission handle names no stored Turn");
		if (!token.turn.equals(handle.turn) || token.epoch !== handle.issuedEpoch) throw new AgentCoreError("lease.invalid", "A Turn admission handle authorizes addressing its Turn, never writing as it");
		turn.requireToken(token, now);
	}
};
/**
* The child Run a verified Receipt's result names, and `undefined` where it names none.
* `decodeCanonicalJson` already refuses bytes that are not in canonical form, so canonicality
* is its answer rather than a second check here, and what remains is the §5.6 distinction: a
* delegate result that names a child Run must name only that, while every other mediated
* result leaves the Invocation as the identity the model reads.
*/
function childRunOf(request, bytes) {
	const payload = decodeCanonicalJson(bytes);
	if (request.impact !== "delegate" || !isJsonObject(payload) || !("run" in payload)) return;
	requireExactFields(payload, ["run"], [], "Delegate spawn Receipt result");
	return new RunId(requireString(payload["run"], "Delegate spawn child Run"));
}
function invalidAdmission(message) {
	return new AgentCoreError("invocation.invalid", message);
}
//#endregion
//#region src/agents/runs/executor.ts
var TurnBoundOperation = class {
	binding;
	facet;
	operation;
	descriptor;
	constructor(binding, facet, operation, descriptor) {
		this.binding = binding;
		this.facet = facet;
		this.operation = operation;
		this.descriptor = descriptor;
		const separator = facet.value.indexOf(":");
		const facetPackage = new FacetPackageId(facet.value.slice(0, separator));
		if (!operation.facet.equals(facetPackage) || !operation.operation.equals(descriptor.name)) throw new TypeError("A bound Operation Facet, reference, and descriptor must identify one operation");
		Object.freeze(this);
	}
};
var TurnOperationSource = class {};
var TurnPromptAssembler = class {};
var TurnInvocationPort = class {};
var TurnGatewaySource = class {};
var GatewayTurnInvocationPort = class extends TurnInvocationPort {
	gateways;
	admissions;
	constructor(gateways, admissions) {
		super();
		this.gateways = gateways;
		this.admissions = admissions;
	}
	async invoke(request) {
		requireNotCancelled(request.signal);
		const gateway = await this.gateways.open(Object.freeze({
			turn: request.turn,
			token: request.token,
			signal: request.signal
		}));
		requireNotCancelled(request.signal);
		let resolved;
		const releaseOnAbort = () => resolved?.[Symbol.dispose]();
		request.signal.addEventListener("abort", releaseOnAbort, { once: true });
		try {
			resolved = await gateway.resolve(request.operation.binding);
			requireNotCancelled(request.signal);
			const descriptor = resolved.descriptor(request.operation.descriptor.name);
			if (!resolved.facet.equals(request.operation.facet) || !resolved.package.equals(request.operation.operation.facet) || descriptor === void 0 || !bytesEqual(OperationDescriptor.encode(descriptor), OperationDescriptor.encode(request.operation.descriptor))) throw new AgentCoreError("binding.invalid", "Resolved operation does not match the exact bound Turn Operation");
			requireNotCancelled(request.signal);
			const result = await resolved.dispatch({
				requestKey: request.requestKey,
				operation: descriptor.name,
				payload: {
					kind: "single",
					input: canonicalFacetData(request.input)
				}
			});
			requireNotCancelled(request.signal);
			if (result.kind !== "mediated") return canonicalInvocationResult({
				tier: "direct",
				output: result.output
			});
			const evidence = canonicalFacetData(result.evidence);
			const named = admittedIdentity(evidence);
			return canonicalInvocationResult({
				tier: "mediated",
				output: result.output,
				evidence,
				admission: await this.admissions.verify({
					run: request.turn.run,
					turn: request.turn.id,
					token: request.token,
					impact: descriptor.impact,
					invocation: named.invocation,
					receipts: named.receipts
				})
			});
		} finally {
			request.signal.removeEventListener("abort", releaseOnAbort);
			resolved?.[Symbol.dispose]();
		}
	}
};
/**
* One prompt section's name, so a request records the order it was assembled in as
* nameable parts rather than as one opaque blob.
*/
var TurnPromptSectionName = class extends TextId {
	constructor(value) {
		super(value, "Prompt section name");
	}
};
/**
* How much of a value the model was NOT shown, as metadata about the bytes it WAS shown
* (SPEC §5.6). `none` withholds nothing, `exact` states a positive withheld amount, and
* `unknown` is the honest case for a host that bounded a stream it never read to the end.
* A two-case shape would force that host to report a guess as exact, and `exact` refuses
* a zero so the absence of an omission stays distinguishable from one that withheld
* nothing. An omission is always a budget decision about a value recorded whole
* elsewhere, never a report that its source had less to give (§7.4).
*/
var TurnOmission = class TurnOmission {
	kind;
	withheldBytes;
	static none = new TurnOmission("none", void 0);
	static unknown = new TurnOmission("unknown", void 0);
	static exact(withheldBytes) {
		return new TurnOmission("exact", withheldBytes);
	}
	constructor(kind, withheldBytes) {
		this.kind = kind;
		this.withheldBytes = withheldBytes;
		if (kind === "exact") {
			if (withheldBytes === void 0 || !Number.isSafeInteger(withheldBytes) || withheldBytes <= 0) throw new TypeError("An exact omission withholds at least one byte; withholding nothing is TurnOmission.none");
		} else if (withheldBytes !== void 0) throw new TypeError("Only an exact omission states a withheld amount");
		Object.freeze(this);
	}
	equals(other) {
		return this.kind === other.kind && this.withheldBytes === other.withheldBytes;
	}
	toData() {
		return this.withheldBytes === void 0 ? { kind: this.kind } : {
			kind: this.kind,
			withheldBytes: this.withheldBytes
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Turn omission");
		requireExactFields(object, ["kind"], ["withheldBytes"], "Turn omission");
		const kind = requireString(object["kind"], "Turn omission kind");
		if (kind === "exact") return TurnOmission.exact(requireInteger(object["withheldBytes"], "Turn omission withheld amount"));
		if (object["withheldBytes"] !== void 0) throw new TypeError("Only an exact omission states a withheld amount");
		if (kind === "none") return TurnOmission.none;
		if (kind === "unknown") return TurnOmission.unknown;
		throw new TypeError("Turn omission kind is unknown");
	}
};
/**
* How much of one carried commit's content the model was not shown (SPEC §5.2). A prompt
* section may render several commits at once, so the section's own omission states how much
* that section withheld, and this states which commit the withheld bytes belonged to.
* Without it a commit a surface lists in its coverage and renders as no bytes at all reads
* exactly like a commit it rendered whole. A commit no entry names was carried whole, so an
* entry withholding nothing is refused rather than recorded as `none`.
*/
var TurnCommitOmission = class TurnCommitOmission {
	commit;
	omission;
	constructor(commit, omission) {
		this.commit = commit;
		this.omission = omission;
		if (omission.kind === "none") throw new TypeError("A commit omission withholds content; a commit carried whole names no omission");
		Object.freeze(this);
	}
	toData() {
		return {
			commit: this.commit.value,
			omission: this.omission.toData()
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Commit omission");
		requireExactFields(object, ["commit", "omission"], [], "Commit omission");
		return new TurnCommitOmission(new RunCommitId(requireString(object["commit"], "Commit omission commit")), TurnOmission.fromData(requireShown(object["omission"])));
	}
};
/**
* The bytes the model observed, held inline or by a `ContentRef` that resolves to exactly
* them. Never by a digest of them: a digest proves what a value was while only a
* reference retrieves it (SPEC §1.4), and never as a derivation over some larger value,
* because ending retention of that value would leave the observed form unrebuildable.
*/
var TurnShownContent = class TurnShownContent {
	ref;
	#bytes;
	static inline(bytes) {
		return new TurnShownContent(bytes, void 0);
	}
	static reference(ref) {
		return new TurnShownContent(void 0, ref);
	}
	constructor(bytes, ref) {
		this.ref = ref;
		if (bytes === void 0 === (ref === void 0)) throw new TypeError("Shown content is held either inline or by one reference");
		if (bytes !== void 0 && !(bytes instanceof Uint8Array)) throw new TypeError("Inline shown content must be a Uint8Array");
		if (ref !== void 0 && !(ref instanceof ContentRef)) throw new TypeError("Shown content reference must be a ContentRef");
		this.#bytes = bytes?.slice();
		Object.freeze(this);
	}
	/** The inline bytes, copied, or nothing when this content is held by reference. */
	inlineBytes() {
		return this.#bytes?.slice();
	}
	toData() {
		return this.#bytes === void 0 ? { ref: required(this.ref, "Shown content requires bytes or a reference").value } : { inline: encodeBase64(this.#bytes) };
	}
	static fromData(value) {
		const object = requireObject(value, "Shown content");
		requireExactFields(object, [], ["inline", "ref"], "Shown content");
		const inline = object["inline"];
		const ref = object["ref"];
		if (inline === void 0 === (ref === void 0)) throw new TypeError("Shown content is held either inline or by one reference");
		return inline === void 0 ? TurnShownContent.reference(new ContentRef(requireString(ref, "Shown content reference"))) : TurnShownContent.inline(decodeBase64(requireString(inline, "Inline shown content")));
	}
};
/** One assembled prompt section as the model observed it, in the request's final order. */
var TurnPromptSection = class TurnPromptSection {
	name;
	shown;
	omission;
	constructor(name, shown, omission = TurnOmission.none) {
		this.name = name;
		this.shown = shown;
		this.omission = omission;
		Object.freeze(this);
	}
	toData() {
		return {
			name: this.name.value,
			omission: this.omission.toData(),
			shown: this.shown.toData()
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Prompt section");
		requireExactFields(object, [
			"name",
			"omission",
			"shown"
		], [], "Prompt section");
		return new TurnPromptSection(new TurnPromptSectionName(requireString(object["name"], "Prompt section name")), TurnShownContent.fromData(requireShown(object["shown"])), TurnOmission.fromData(requireShown(object["omission"])));
	}
};
/**
* An inbox Event the call admitted. The request names the Event's content directly, so a
* reconstruction depends on the undeletable RunCommit that carries it rather than on the
* Event record, which SPEC §6.1 declares immutable and never undeletable. Events the cut
* covered but the call did not admit are absent, and so stay releasable.
*/
var TurnAdmittedEvent = class TurnAdmittedEvent {
	entry;
	sequence;
	event;
	content;
	constructor(entry, sequence, event, content) {
		this.entry = entry;
		this.sequence = sequence;
		this.event = event;
		this.content = content;
		if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError("Admitted Event sequence must be a non-negative safe integer");
		if (event.length === 0) throw new TypeError("Admitted Event kind is required");
		Object.freeze(this);
	}
	toData() {
		return {
			content: this.content.value,
			entry: this.entry.value,
			event: this.event,
			sequence: this.sequence
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Admitted Event");
		requireExactFields(object, [
			"content",
			"entry",
			"event",
			"sequence"
		], [], "Admitted Event");
		return new TurnAdmittedEvent(new TurnInboxEntryId(requireString(object["entry"], "Admitted Event entry")), requireInteger(object["sequence"], "Admitted Event sequence"), requireString(object["event"], "Admitted Event kind"), new ContentRef(requireString(object["content"], "Admitted Event content")));
	}
};
/**
* One observation a `turn.step` interceptor left on a step, naming its author (SPEC §4.4).
* The author is part of the annotation rather than beside it because the host admits an
* appended annotation only when it names the interceptor that appended it: a supervisor
* reading a trajectory must be able to tell whose judgement it is reading, and an
* annotation an interceptor could sign with a neighbour's id would say the opposite.
*/
var TurnStepAnnotation = class TurnStepAnnotation {
	interceptor;
	note;
	constructor(interceptor, note) {
		this.interceptor = interceptor;
		this.note = note;
		if (note.length === 0) throw new TypeError("A step annotation carries a note");
		Object.freeze(this);
	}
	toData() {
		return {
			interceptor: this.interceptor.value,
			note: this.note
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Step annotation");
		requireExactFields(object, ["interceptor", "note"], [], "Step annotation");
		return new TurnStepAnnotation(new InterceptorId(requireString(object["interceptor"], "Step annotation interceptor")), requireString(object["note"], "Step annotation note"));
	}
};
/**
* The value in flight at `turn.step`: which iteration of the Turn's loop is opening, the
* branch head and inbox cut it opened on, and the annotations earlier firings of this Turn
* left. SPEC §5.3 defines a Turn step as the interval between two firings of this cut
* point, so the ordinal counts firings and nothing else.
*
* The head and the cut are host facts the interceptor may read and not change; only the
* annotations are its to extend. This is not a durable record: the annotations are Turn
* state, they do not outlive the Turn that collected them, and no later Turn reads them.
*/
var TurnStepContext = class TurnStepContext {
	ordinal;
	head;
	inboxCut;
	annotations;
	constructor(ordinal, head, inboxCut, annotations = []) {
		this.ordinal = ordinal;
		this.head = head;
		this.inboxCut = inboxCut;
		if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new TypeError("A Turn step ordinal is a non-negative safe integer");
		if (!Number.isSafeInteger(inboxCut) || inboxCut < 0) throw new TypeError("A Turn step inbox cut is a non-negative safe integer");
		this.annotations = Object.freeze([...annotations]);
		Object.freeze(this);
	}
	toData() {
		return {
			annotations: this.annotations.map((annotation) => annotation.toData()),
			head: this.head.value,
			inboxCut: this.inboxCut,
			ordinal: this.ordinal
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Turn step context");
		requireExactFields(object, [
			"annotations",
			"head",
			"inboxCut",
			"ordinal"
		], [], "Turn step context");
		return new TurnStepContext(requireInteger(object["ordinal"], "Turn step ordinal"), new RunCommitId(requireString(object["head"], "Turn step head")), requireInteger(object["inboxCut"], "Turn step inbox cut"), requireArray(object["annotations"], "Turn step annotations").map(TurnStepAnnotation.fromData));
	}
};
/**
* The complete model input one call issued, as the model observed it: the assembled
* sections in their final order, the operation catalog as offered, and the inbox
* admission cut. It is the content of a `modelInput` RunCommit, whose parent is the exact
* commit the call read, so the base of any derivation over history is fixed by ancestry
* rather than by when a reconstruction happens to run.
*
* `covers` names the transcript commits the assembled sections carry, in the order they
* carry them. It lifts that fact out of the section bytes for the same reason SPEC §5.2
* puts a message's `requests` in the graph rather than in its content: prose cannot be
* asked which commits it renders, so a claim inside it is unreadable by any check.
*
* `withheld` attributes each omission to the commit whose content it withheld, which is the
* fact the two other fields cannot state between them: `covers` is per record and a
* section's omission is per section, so a commit fully abridged inside a multi-commit
* section is otherwise indistinguishable from one carried whole. A surface that carries more
* than one commit and withholds content attributes all of it; every other surface may
* attribute nothing. The field is additive and stays absent while it says nothing, because a
* `modelInput` commit derives its identity from these bytes and a key on every record would
* fork every identity already recorded.
*/
var TurnModelInput = class TurnModelInput extends CodecRecord {
	static get codec() {
		return TurnModelInputCodec;
	}
	sections;
	catalog;
	admitted;
	admissionCut;
	covers;
	withheld;
	constructor(init) {
		super();
		if (init.sections.length === 0) throw new TypeError("A model input records at least one prompt section");
		if (!Number.isSafeInteger(init.admissionCut) || init.admissionCut < 0) throw new TypeError("An inbox admission cut is a non-negative safe integer");
		let previous = -1;
		for (const admitted of init.admitted) {
			if (admitted.sequence <= previous || admitted.sequence >= init.admissionCut) throw new TypeError("Admitted Events must ascend by sequence and fall inside the admission cut");
			previous = admitted.sequence;
		}
		if (new Set(init.covers.map((commit) => commit.value)).size !== init.covers.length) throw new TypeError("One surface carries a transcript commit at most once");
		this.sections = Object.freeze([...init.sections]);
		this.catalog = Object.freeze(validateOfferedCatalog(init.catalog));
		this.admitted = Object.freeze([...init.admitted]);
		this.admissionCut = init.admissionCut;
		this.covers = Object.freeze([...init.covers]);
		this.withheld = Object.freeze(validateCommitOmissions(init));
		Object.freeze(this);
	}
	toData() {
		const surface = {
			admissionCut: this.admissionCut,
			admitted: this.admitted.map((admitted) => admitted.toData()),
			catalog: this.catalog.map(boundOperationData),
			covers: this.covers.map((commit) => commit.value),
			sections: this.sections.map((section) => section.toData())
		};
		return this.withheld.length === 0 ? surface : {
			...surface,
			withheld: this.withheld.map((entry) => entry.toData())
		};
	}
	static fromData(value) {
		const object = requireObject(value, "Model input");
		requireExactFields(object, [
			"admissionCut",
			"admitted",
			"catalog",
			"covers",
			"sections"
		], ["withheld"], "Model input");
		const withheld = object["withheld"];
		if (withheld !== void 0 && requireArray(withheld, "Model input omissions").length === 0) throw new TypeError("A model input that attributes no omission records no list");
		return new TurnModelInput({
			sections: requireArray(object["sections"], "Model input sections").map(TurnPromptSection.fromData),
			catalog: requireArray(object["catalog"], "Model input catalog").map(boundOperationFromData),
			admitted: requireArray(object["admitted"], "Model input admitted Events").map(TurnAdmittedEvent.fromData),
			admissionCut: requireInteger(object["admissionCut"], "Model input admission cut"),
			covers: requireArray(object["covers"], "Model input coverage").map((commit) => new RunCommitId(requireString(commit, "Covered commit"))),
			withheld: withheld === void 0 ? [] : requireArray(withheld, "Model input omissions").map(TurnCommitOmission.fromData)
		});
	}
};
/**
* The version stays where it is while `withheld` joins the payload. A minor bump is the
* §8.3 signal to a reader that cannot understand a newer record, and this codec has no such
* reader: it is the only one, the field is optional, and a record that does not use it
* encodes the bytes it encoded before. The bump would cost what the field was shaped to
* avoid, because the version travels inside the encoded document that a `modelInput`
* commit's identity is derived from, so every existing identity would fork.
*/
var ModelInputCodec = class extends RecordCodec {
	constructor() {
		super([
			TurnModelInput,
			TurnPromptSection,
			TurnPromptSectionName,
			TurnBoundOperation,
			TurnAdmittedEvent,
			RunCommitId,
			TurnOmission,
			TurnCommitOmission,
			TurnShownContent,
			ContentRef,
			Digest,
			TextId,
			JsonSchema,
			BindingName,
			FacetPackageId,
			FacetRef,
			OperationDescriptor,
			OperationAvailability,
			OperationName,
			OperationRef,
			TurnInboxEntryId,
			CodecRecord
		], "turn.model-input", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(value) {
		return value.toData();
	}
	decodePayload(value) {
		return TurnModelInput.fromData(value);
	}
};
var TurnModelInputCodec = new ModelInputCodec();
var TurnModelPort = class {};
/** The canonical bytes of a request, so a replay compares byte for byte against what was sent. */
function turnModelRequestBytes(request) {
	return encodeCanonicalJson({
		admissionCut: request.admissionCut,
		admitted: request.admitted.map((admitted) => ({
			bytes: encodeBase64(admitted.bytes),
			content: admitted.content.value,
			entry: admitted.entry.value,
			event: admitted.event,
			sequence: admitted.sequence
		})),
		baseCommit: request.baseCommit.value,
		catalog: request.catalog.map(boundOperationData),
		covers: request.covers.map((commit) => commit.value),
		input: request.input.value,
		sections: request.sections.map((section) => ({
			bytes: encodeBase64(section.bytes),
			name: section.name.value,
			omission: section.omission.toData()
		}))
	});
}
/**
* The records-only reconstruction SPEC §5.6 requires. It reads a Turn's committed records
* alone — a `modelInput` RunCommit, the content that commit names, and nothing from
* executor memory — and yields the exact request the model received, which is why it
* survives a restart that discards the executor process. Content a request names that is
* no longer retained fails typed and names what is missing; it never yields a shorter
* prefix, a partial request, or a best-effort approximation.
*/
var TurnModelInputReplay = class {
	records;
	constructor(records) {
		this.records = records;
	}
	async reconstruct(input) {
		const commit = this.records.repository.transaction((transaction) => this.records.repository.loadCommit(transaction, input));
		if (commit === void 0 || commit.kind !== "modelInput") throw unrebuildable(`no model input commit ${input.value}`);
		const document = required(commit.content, "Model input commit requires content");
		const baseCommit = required(commit.parents[0], "Model input commit requires one parent");
		const record = TurnModelInput.decode(await this.resolve(document, `model input ${input.value}`));
		this.requireAccounted(input, baseCommit, record);
		const sections = [];
		for (const section of record.sections) sections.push(Object.freeze({
			name: section.name,
			bytes: await this.shown(section),
			omission: section.omission
		}));
		const admitted = [];
		for (const event of record.admitted) admitted.push(Object.freeze({
			entry: event.entry,
			sequence: event.sequence,
			event: event.event,
			content: event.content,
			bytes: await this.resolve(event.content, `admitted Event ${event.entry.value}`)
		}));
		return Object.freeze({
			input,
			baseCommit,
			sections: Object.freeze(sections),
			catalog: record.catalog,
			admitted: Object.freeze(admitted),
			admissionCut: record.admissionCut,
			covers: record.covers
		});
	}
	async shown(section) {
		const inline = section.shown.inlineBytes();
		return inline === void 0 ? this.resolve(required(section.shown.ref, "Shown content requires bytes or a reference"), `prompt section ${section.name.value}`) : inline;
	}
	/**
	* The transcript commits a surface assembled at `base` must account for, in the order it
	* must carry them. A host reads this to know what it owes the record; the check below
	* reads the same derivation, so what a host is told and what it is held to cannot differ.
	*/
	accountable(base) {
		return this.records.repository.transaction((transaction) => {
			const load = (id) => this.records.repository.loadCommit(transaction, id);
			return Object.freeze(accountableTranscript(effectiveTranscript(effectiveCommitOf(load, base), load)).map((commit) => commit.id));
		});
	}
	/**
	* Refuses a surface whose coverage is not exactly the transcript it was assembled over.
	* The comparison is a sequence equality against the effective transcript at `base`
	* restricted to the commits a surface can carry, so the only conforming way to put less
	* history in front of the model is a `rewrite` that shadows it — a reduction the host
	* kept in its own memory leaves commits this derivation still reaches and no section
	* claims. It guards both boundaries: the seam calls it before the record is appended, and
	* every reconstruction calls it again, so a surface written by any other writer is
	* refused on the way out even though nothing refused it on the way in.
	*/
	requireAccounted(input, base, record) {
		const accountable = this.accountable(base);
		const covered = record.covers;
		if (covered.length !== accountable.length) throw unaccounted(input, `it carries ${covered.length} of the ${accountable.length} commits the transcript at ${base.value} holds`);
		for (const [position, commit] of accountable.entries()) {
			const claimed = covered[position];
			if (claimed === void 0 || !claimed.equals(commit)) throw unaccounted(input, `position ${position} carries ${claimed?.value ?? "nothing"} where the transcript at ${base.value} holds ${commit.value}`);
		}
	}
	async resolve(ref, subject) {
		try {
			return (await this.records.content.get(ref)).slice();
		} catch {
			throw unrebuildable(`${subject} names unretained content ${ref.value}`);
		}
	}
};
var TurnStreamPort = class {};
var TurnContentHandle = class {};
var TurnModelHandle = class {};
var TurnModelInputHandle = class {};
var TurnStreamHandle = class {};
var TurnCommitHandle = class {};
var TurnCheckpointHandle = class {};
var TurnInvocationHandle = class {};
var TurnInboxHandle = class {};
var TurnStepHandle = class {};
var TurnOutcomeHandle = class {};
var TurnExecutor = class {};
var TurnExecutorHost = class {
	init;
	constructor(init) {
		this.init = init;
	}
	async execute(token) {
		const scope = new LeaseScopedTurn(this.init, token);
		const recovered = scope.recover();
		if (recovered !== void 0) return recovered;
		const initial = scope.active();
		const operations = await scope.resolveOperations(initial);
		const prompt = await scope.assemblePrompt({
			...initial.scope,
			operations
		});
		const replay = new TurnModelInputReplay({
			repository: this.init.runtime.repository,
			content: this.init.content
		});
		const context = Object.freeze({
			...initial.scope,
			operations,
			prompt,
			content: new ScopedContentHandle(scope),
			inbox: new ScopedInboxHandle(scope),
			commit: new ScopedCommitHandle(scope),
			checkpoint: new ScopedCheckpointHandle(scope),
			invocation: new ScopedInvocationHandle(scope, operations),
			model: new ScopedModelHandle(scope, operations, replay),
			modelInput: new ScopedModelInputHandle(scope, replay),
			step: new ScopedStepHandle(scope),
			stream: new ScopedStreamHandle(scope),
			outcome: new ScopedOutcomeHandle(scope),
			cancellation: scope.signal
		});
		let proposed;
		try {
			proposed = await this.init.executor.execute(context);
		} catch (error) {
			const committed = scope.recover();
			if (committed !== void 0) return committed;
			throw error;
		}
		const committed = scope.recover();
		if (committed === void 0 || !outcomesEqual(proposed, committed)) throw invalidTurn("Turn executor returned without its exact canonical transition");
		return committed;
	}
};
var LeaseScopedTurn = class {
	init;
	token;
	#controller = new AbortController();
	signal = this.#controller.signal;
	constructor(init, token) {
		this.init = init;
		this.token = token;
	}
	/**
	* Turn-scoped `turn.step` state: how many steps this Turn has opened, the annotations
	* its interceptors have left, and the stop one of them requested. None of it outlives
	* the Turn. A later Turn on the same branch opens at ordinal zero with no annotations
	* and no stop, because a step is an iteration of *this* Turn's loop (SPEC §5.3) and a
	* refusal aimed at this Turn's trajectory is evidence about nothing else.
	*/
	#steps = 0;
	#annotations = [];
	#stop;
	/**
	* Fires `turn.step` and hands the Turn what survived. A stop already requested refuses
	* here rather than being reported again: the executor was told once, and asking for
	* another step is not the winding down the request asked for.
	*/
	openStep() {
		const snapshot = this.active();
		this.requireNotStopped("open another Turn step");
		const proposed = new TurnStepContext(this.#steps, snapshot.head.id, this.readInbox(0).length, this.#annotations);
		const outcome = this.init.cutPoints.run("turn.step", snapshot.scope.turn.id, proposed.toData(), admitStepRewrite);
		const step = TurnStepContext.fromData(outcome.value);
		this.#steps += 1;
		this.#annotations = step.annotations;
		if (outcome.stop === void 0) return Object.freeze({
			kind: "proceed",
			step
		});
		this.#stop = outcome.stop;
		return Object.freeze({
			kind: "stopped",
			step,
			stop: outcome.stop
		});
	}
	/**
	* The stop's teeth. A `turn.step` gate authors no Turn status (SPEC §5.2's writer
	* matrix admits root, this Turn's lease, and system control evidence, and an
	* Interceptor is none of them), so the refusal has to be enforced where the Turn would
	* otherwise carry on: the two things a step does are call the model and open the next
	* step, and after a stop this Turn does neither. Terminalizing is left open, because a
	* Turn that cannot record its own transition is a Turn nothing can settle.
	*/
	requireNotStopped(attempt) {
		if (this.#stop === void 0) return;
		throw new AgentCoreError("authority.denied", `Interceptor ${this.#stop.interceptor} stopped this Turn, so it may not ${attempt}: ${this.#stop.reason}`);
	}
	/**
	* Fires `prompt.assemble` on the sections about to be recorded. It runs before the
	* model input record exists, which is what keeps SPEC §5.6's reconstruction exact: the
	* surface that gets committed is the rewritten one, so a replay rebuilds what the model
	* read rather than what the executor first assembled.
	*/
	assembleSections(turn, sections) {
		return decodeSections(this.init.cutPoints.run("prompt.assemble", turn, sections.map((section) => section.toData()), admitAssembledSections).value);
	}
	active() {
		const now = this.init.now();
		return this.init.runtime.repository.transaction((transaction) => {
			const repository = this.init.runtime.repository;
			const turn = required(repository.loadTurn(transaction, this.token.turn), "Turn executor target does not exist");
			if (findCancellation(repository.listInbox(transaction, turn.id), this.token)) this.#controller.abort();
			const joined = repository.loadExecutionScope(transaction, this.token, now);
			return Object.freeze({
				scope: Object.freeze({
					turn: joined.turn,
					token: this.token,
					effectiveCommit: joined.effectiveCommit,
					placement: joined.placement,
					resumeCheckpoint: joined.checkpoint
				}),
				branch: joined.branch,
				head: joined.head,
				now
			});
		});
	}
	async resolveOperations(snapshot) {
		const resolved = await this.init.operations.resolve(snapshot.scope);
		this.active();
		return validateOperations(snapshot.scope.placement, resolved);
	}
	async assemblePrompt(request) {
		const prompt = await this.init.prompt.assemble(Object.freeze(request));
		this.active();
		await this.requireContent(prompt);
		return prompt;
	}
	async requireContent(ref) {
		const stat = await this.withActive(() => this.init.runtime.repository.content.stat(ref));
		if (stat === void 0 || !stat.ref.equals(ref) || !stat.digest.equals(ref.digest)) throw new AgentCoreError("content.not-found", "Turn content is not available");
	}
	/**
	* The dispatch waits on this commit (SPEC §5.6). A commit the Turn's lease rejects, a
	* store that is unavailable, and a commit whose outcome the substrate cannot report
	* all refuse dispatch: the record's identity is derived from its content and its
	* parent, so an unknown outcome is settled by re-reading that exact commit rather than
	* by assuming either branch, and a further attempt at the same commit can still reach
	* durability. A durability failure is never grounds to proceed.
	*/
	commitModelInput(commit) {
		const snapshot = this.active();
		let failure;
		try {
			this.init.runtime.appendTurnCommit(commit, snapshot.branch.revision, snapshot.now);
		} catch (error) {
			failure = error instanceof Error ? error : new TypeError(String(error));
		}
		if (!this.durablyStored(commit)) throw new AgentCoreError("turn.model-input-undurable", `The model call is refused because its request is not durably recorded${failure === void 0 ? "" : `: ${failure.message}`}`);
	}
	durablyStored(commit) {
		try {
			return this.init.runtime.repository.transaction((transaction) => this.init.runtime.repository.loadCommit(transaction, commit.id))?.proposalDigest.equals(commit.proposalDigest) === true;
		} catch {
			return false;
		}
	}
	async withActive(operation) {
		this.active();
		try {
			return await operation();
		} finally {
			this.active();
		}
	}
	recover() {
		return this.init.runtime.repository.transaction((transaction) => {
			const repository = this.init.runtime.repository;
			const turn = repository.loadTurn(transaction, this.token.turn);
			if (turn === void 0) return void 0;
			const resultCommits = repository.listCommits(transaction).filter((commit) => commit.isTurnAuthored("result", this.token) && commit.content !== void 0 && turn.result?.equals(commit.content) === true);
			if (resultCommits.length > 1) throw invalidTurn("Turn executor has multiple terminal commits for one token");
			const resultCommit = resultCommits[0];
			if (turn.status.kind === "succeeded" || turn.status.kind === "failed") {
				if (resultCommit === void 0) return void 0;
				return Object.freeze({
					kind: turn.status.kind,
					result: required(turn.result, "Terminal Turn is missing its result"),
					commit: resultCommit.id
				});
			}
			if (turn.status.kind === "suspended") {
				const checkpoint = required(repository.loadCheckpoint(transaction, required(turn.checkpoint, "Suspended Turn is missing its checkpoint")), "Suspended Turn checkpoint does not exist");
				const commit = required(repository.loadCommit(transaction, checkpoint.commit), "Suspended Turn checkpoint commit does not exist");
				if (!commit.isTurnAuthored("checkpoint", this.token) || !commit.content?.equals(checkpoint.state)) return;
				return Object.freeze({
					kind: "suspended",
					checkpoint,
					commit: commit.id
				});
			}
			if (findCancellation(repository.listInbox(transaction, turn.id), this.token)) {
				this.#controller.abort();
				if (holdsCurrentLease(turn, this.token)) return void 0;
				let cancelled = { kind: "cancelled" };
				if (resultCommit?.content !== void 0) cancelled = {
					...cancelled,
					result: resultCommit.content
				};
				if (resultCommit !== void 0) cancelled = {
					...cancelled,
					commit: resultCommit.id
				};
				return Object.freeze(cancelled);
			}
		});
	}
	readInbox(afterSequence) {
		if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new TypeError("Turn inbox cursor must be a non-negative safe integer");
		return this.init.runtime.repository.transaction((transaction) => {
			const repository = this.init.runtime.repository;
			const turn = required(repository.loadTurn(transaction, this.token.turn), "Turn executor target does not exist");
			const entries = repository.listInbox(transaction, turn.id).filter((entry) => entry.sequence >= afterSequence);
			if (findCancellation(entries, this.token) !== void 0) {
				this.#controller.abort();
				return Object.freeze(entries);
			}
			turn.requireToken(this.token, this.init.now());
			return Object.freeze(entries);
		});
	}
};
var ScopedContentHandle = class extends TurnContentHandle {
	scope;
	constructor(scope) {
		super();
		this.scope = scope;
	}
	async put(bytes, hint) {
		const stored = await this.scope.withActive(() => this.scope.init.runtime.repository.content.put(bytes.slice(), hint));
		if (!stored.ref.digest.equals(stored.digest)) throw new AgentCoreError("codec.invalid", "Content store returned mismatched identity");
		return Object.freeze({
			ref: stored.ref,
			digest: stored.digest
		});
	}
	async get(ref) {
		return (await this.scope.withActive(() => this.scope.init.runtime.repository.content.get(ref))).slice();
	}
	async stat(ref) {
		return this.scope.withActive(() => this.scope.init.runtime.repository.content.stat(ref));
	}
};
var ScopedModelHandle = class extends TurnModelHandle {
	scope;
	operations;
	replay;
	constructor(scope, operations, replay) {
		super();
		this.scope = scope;
		this.operations = operations;
		this.replay = replay;
	}
	/**
	* Records the model input, then issues the reconstruction of what it recorded. Nothing
	* the model observes is assembled a second time here, so a request and its record
	* cannot drift (SPEC §5.6), and the record is durable before the request is dispatched.
	*/
	async call(assembly) {
		const snapshot = this.scope.active();
		this.scope.requireNotStopped("call the model again");
		const record = this.record({
			...assembly,
			sections: this.scope.assembleSections(snapshot.scope.turn.id, assembly.sections)
		});
		for (const section of record.sections) {
			const ref = section.shown.ref;
			if (ref !== void 0) await this.scope.requireContent(ref);
		}
		for (const admitted of record.admitted) await this.scope.requireContent(admitted.content);
		const document = await this.scope.withActive(() => this.scope.init.content.put(TurnModelInput.encode(record)));
		const commit = new RunCommit({
			id: modelInputCommitId(snapshot.head.id, document.ref),
			run: snapshot.scope.turn.run,
			branch: snapshot.scope.turn.branch,
			kind: "modelInput",
			parents: [snapshot.head.id],
			pins: snapshot.scope.turn.pins,
			writer: {
				kind: "turn",
				token: this.scope.token
			},
			subjectTurn: snapshot.scope.turn.id,
			content: document.ref
		});
		this.replay.requireAccounted(commit.id, snapshot.head.id, record);
		this.scope.commitModelInput(commit);
		const request = await this.scope.withActive(() => this.replay.reconstruct(commit.id));
		const result = await this.scope.withActive(() => this.scope.init.model.call(Object.freeze({
			...request,
			turn: snapshot.scope.turn,
			token: this.scope.token,
			signal: this.scope.signal
		})));
		requireUsage(result.usage);
		await this.scope.requireContent(result.output);
		this.scope.init.runtime.recordModelUsage(snapshot.scope.turn.run, totalTokens(result.usage), result.usage.cost);
		return Object.freeze({
			input: commit.id,
			output: result.output,
			usage: freezeUsage(result.usage)
		});
	}
	/**
	* The record an assembly names, with every claim checked against the Turn's own state: an
	* offered Operation is one the placement snapshot already resolved, and an admitted
	* Event is one this Turn's inbox carries at that exact sequence and payload. The
	* admission cut is the inbox length the host observed, not one the assembly supplies.
	*/
	record(assembly) {
		const inbox = this.scope.readInbox(0);
		for (const offered of assembly.catalog) if (!this.operations.includes(offered)) throw new AgentCoreError("operation.missing", "A model input offers an Operation outside the Turn's resolved catalog");
		const admitted = assembly.admitted.map((entry) => {
			const stored = inbox.find((candidate) => candidate.id.equals(entry.id));
			if (stored === void 0 || stored.sequence !== entry.sequence || stored.event !== entry.event || !stored.payload.equals(entry.payload)) throw invalidTurn("A model input admits an Event this Turn's inbox does not carry");
			return new TurnAdmittedEvent(stored.id, stored.sequence, stored.event, stored.payload);
		});
		return new TurnModelInput({
			sections: assembly.sections,
			catalog: assembly.catalog,
			admitted,
			admissionCut: inbox.length,
			covers: assembly.covers,
			withheld: assembly.withheld ?? []
		});
	}
};
var ScopedModelInputHandle = class extends TurnModelInputHandle {
	scope;
	replay;
	constructor(scope, replay) {
		super();
		this.scope = scope;
		this.replay = replay;
	}
	async reconstruct(input) {
		return this.scope.withActive(() => this.replay.reconstruct(input));
	}
	async accountable() {
		return this.scope.withActive(async () => this.replay.accountable(this.scope.active().head.id));
	}
};
var ScopedStepHandle = class extends TurnStepHandle {
	scope;
	constructor(scope) {
		super();
		this.scope = scope;
	}
	async open() {
		return this.scope.withActive(async () => this.scope.openStep());
	}
};
var ScopedStreamHandle = class extends TurnStreamHandle {
	scope;
	constructor(scope) {
		super();
		this.scope = scope;
	}
	async publish(event) {
		const canonical = canonicalStreamEvent(event);
		const turn = this.scope.active().scope.turn;
		await this.scope.withActive(() => this.scope.init.stream.publish(Object.freeze({
			turn,
			token: this.scope.token,
			event: canonical
		})));
	}
};
var ScopedInvocationHandle = class extends TurnInvocationHandle {
	scope;
	operations;
	constructor(scope, operations) {
		super();
		this.scope = scope;
		this.operations = operations;
	}
	async invoke(requested, requestKey, input) {
		if (!this.operations.includes(requested)) throw new AgentCoreError("operation.missing", "Turn invocation requires one exact bound Operation");
		const turn = this.scope.active().scope.turn;
		return canonicalInvocationResult(await this.scope.withActive(() => this.scope.init.invocations.invoke(Object.freeze({
			turn,
			token: this.scope.token,
			operation: requested,
			requestKey,
			input: canonicalFacetData(input),
			signal: this.scope.signal
		}))));
	}
};
var ScopedCommitHandle = class extends TurnCommitHandle {
	scope;
	constructor(scope) {
		super();
		this.scope = scope;
	}
	async append(commit) {
		if (commit.kind !== "message" && commit.kind !== "verdict") throw invalidTurn("Turn commit handle appends only message or verdict commits");
		await this.scope.requireContent(required(commit.content, "Turn commit requires content"));
		const snapshot = this.scope.active();
		this.scope.init.runtime.appendTurnCommit(commit, snapshot.branch.revision, snapshot.now);
		this.scope.active();
		return commit.id;
	}
};
var ScopedCheckpointHandle = class extends TurnCheckpointHandle {
	scope;
	constructor(scope) {
		super();
		this.scope = scope;
	}
	async current() {
		return this.scope.active().scope.resumeCheckpoint;
	}
	async persist(checkpoint, commit) {
		await this.scope.requireContent(checkpoint.state);
		if (checkpoint.tree !== void 0) await this.scope.requireContent(checkpoint.tree);
		const snapshot = this.scope.active();
		this.scope.init.runtime.suspendTurn({
			turn: snapshot.scope.turn.id,
			expectedTurnRevision: snapshot.scope.turn.revision,
			expectedBranchRevision: snapshot.branch.revision,
			token: this.scope.token,
			checkpoint,
			commit,
			now: snapshot.now
		});
		return canonicalOutcome(this.scope);
	}
};
var ScopedInboxHandle = class extends TurnInboxHandle {
	scope;
	constructor(scope) {
		super();
		this.scope = scope;
	}
	async read(afterSequence) {
		return this.scope.readInbox(afterSequence);
	}
};
var ScopedOutcomeHandle = class extends TurnOutcomeHandle {
	scope;
	constructor(scope) {
		super();
		this.scope = scope;
	}
	async succeed(commit) {
		return this.complete("succeeded", commit);
	}
	async fail(commit) {
		return this.complete("failed", commit);
	}
	async cancel(commit, cancellation) {
		await this.scope.requireContent(required(commit.content, "Turn result requires content"));
		await this.scope.requireContent(cancellation.payload);
		const snapshot = this.scope.active();
		this.scope.init.runtime.cancelHeldTurn({
			turn: snapshot.scope.turn.id,
			expectedTurnRevision: snapshot.scope.turn.revision,
			expectedBranchRevision: snapshot.branch.revision,
			token: this.scope.token,
			outcome: "cancelled",
			commit,
			now: snapshot.now
		}, cancellation);
		return canonicalOutcome(this.scope);
	}
	async cancelled() {
		const outcome = this.scope.recover();
		if (outcome?.kind !== "cancelled") throw invalidTurn("Turn token has no settled cancellation outcome");
		return outcome;
	}
	async complete(outcome, commit) {
		await this.scope.requireContent(required(commit.content, "Turn result requires content"));
		const snapshot = this.scope.active();
		this.scope.init.runtime.completeTurn({
			turn: snapshot.scope.turn.id,
			expectedTurnRevision: snapshot.scope.turn.revision,
			expectedBranchRevision: snapshot.branch.revision,
			token: this.scope.token,
			outcome,
			commit,
			now: snapshot.now
		});
		return canonicalOutcome(this.scope);
	}
};
/**
* The sections a `prompt.assemble` answer carries, decoded rather than trusted. Decoding is
* the whole of the rule at this cut point: SPEC §4.4 lets a rewrite reorder, add, and
* remove sections, and everything else the model input records — the offered catalog, the
* admitted Events, the admission cut, the transcript coverage — is simply not in flight, so
* no rewrite can reach it. What a rewrite must not do is hand the next interceptor, or the
* record, something that is not a section: an unparseable answer would otherwise become the
* committed surface and take §5.6's reconstruction with it.
*/
function decodeSections(value) {
	return Object.freeze(requireArray(value, "Assembled prompt sections").map(TurnPromptSection.fromData));
}
var admitAssembledSections = (_before, after) => {
	decodeSections(after);
};
/**
* What a `turn.step` rewrite may do: annotate, and nothing else (SPEC §4.4). The ordinal,
* the head, and the inbox cut are host facts about the step — an interceptor that could
* change them would be describing a step that did not happen — and the annotations already
* present belong to the interceptors that wrote them, so a rewrite may only append, and
* only annotations naming itself. Together these are the `turn.step` counterpart of the
* gate-fidelity clause: the shape of an admitted rewrite is declared, not discovered from
* what an interceptor turned out to do.
*/
/**
* A Turn-bound rewrite the cut point does not admit. It is an operational refusal rather
* than a shape violation — the value parsed, the host declined what it asked for — so it
* carries the same code the runner's scoped block does (SPEC §4.4 rule 4).
*/
function refusedRewrite(detail) {
	return new AgentCoreError("authority.denied", detail);
}
var admitStepRewrite = (before, after, interceptor) => {
	const previous = TurnStepContext.fromData(before);
	const next = TurnStepContext.fromData(after);
	if (next.ordinal !== previous.ordinal || !next.head.equals(previous.head) || next.inboxCut !== previous.inboxCut) throw refusedRewrite("A turn.step rewrite may annotate a step, not restate it");
	if (next.annotations.length < previous.annotations.length) throw refusedRewrite("A turn.step rewrite may not drop another interceptor's annotation");
	for (const [index, annotation] of next.annotations.entries()) {
		const kept = previous.annotations[index];
		if (kept !== void 0) {
			if (!kept.interceptor.equals(annotation.interceptor) || kept.note !== annotation.note) throw refusedRewrite("A turn.step rewrite may not rewrite another interceptor's annotation");
			continue;
		}
		if (!annotation.interceptor.equals(interceptor.id)) throw refusedRewrite("A step annotation names the interceptor that appended it");
	}
};
/**
* A Turn's bound Operations, checked against the Turn's FacetSet (SPEC §4.1, §5.3). The
* membership question goes to the captured snapshot's own predicate, so the executor has one
* composition view rather than a second reading a host could answer from the Scope's current
* install records. Capture fixes membership only: every use of a member still re-authorizes
* under §3.4, so a Grant revoked mid-Turn severs the capability without changing this set.
*/
function validateOperations(placement, operations) {
	const bindings = /* @__PURE__ */ new Set();
	const canonical = operations.map((operation) => {
		if (!(operation instanceof TurnBoundOperation)) throw new TypeError("Turn Operations must use the canonical bound Operation contract");
		if (bindings.has(operation.binding.value)) throw new TypeError("Turn Operation bindings must be unique");
		if (!placement.composes(operation.facet)) throw invalidTurn("Turn Operation is absent from the immutable placement snapshot");
		bindings.add(operation.binding.value);
		return operation;
	});
	return Object.freeze(canonical);
}
/**
* The offered catalog, checked for the one property a record must carry independently of
* the Turn it came from: a binding names at most one Operation, so a reconstruction cannot
* offer the model two meanings for one name.
*/
function validateOfferedCatalog(catalog) {
	const bindings = /* @__PURE__ */ new Set();
	for (const operation of catalog) {
		if (!(operation instanceof TurnBoundOperation)) throw new TypeError("An offered catalog holds canonical bound Operations");
		if (bindings.has(operation.binding.value)) throw new TypeError("An offered catalog binds each name once");
		bindings.add(operation.binding.value);
	}
	return [...catalog];
}
/**
* The omissions a coverage statement attributes, checked against the surface that made them.
* Each entry names one commit the surface carries, so an entry naming any other commit
* attributes an omission to content this record never carried, and a second entry for one
* commit states one commit's withholding twice.
*
* The sections bound what the entries may claim, because the omission a section states and
* the omission an entry attributes are the same withholding counted two ways. A surface
* whose sections withhold nothing withheld nothing from any commit. Where every section
* states an exact amount, the sections state one total and the attributed amounts stay
* inside it. One `unknown` section states no total, so no ceiling applies.
*
* A surface owes an attribution when it carries more than one commit and its sections
* withhold content. SPEC §5.2 attributes each omission to the commit whose content it
* withheld, and only a surface of that shape can hide one. A surface that carries one commit
* withholds from that commit and from nothing else, so the coverage attributes the omission
* on its own, and a surface that carries none names no commit an entry could attribute to.
* The check reads the surface rather than one section because no field says which commits a
* section renders — the same reason §5.2 keeps `covers` beside the sections instead of inside
* their bytes — so every section of a multi-commit surface is one that may carry several.
*
* An owed attribution is complete when it accounts for what the sections withhold. Where the
* sections state an exact total, the attributed amounts sum to exactly that total, so no
* commit outside the attribution holds the difference. Where any amount is unknown, no sum
* closes the account, so the attribution states an unknown amount too and stays open instead
* of claiming a closure it cannot show. That sum is the only thing in the record that tells
* a complete attribution from one a commit short, so an absent list and a short list both
* fail here.
*
* The entries come back ordered by commit id. Which commit an omission belonged to is a fact
* about one commit, and a set of such facts has no order of its own — unlike `covers`, whose
* order is the order the sections carry the commits in. Two hosts that state the same
* omissions therefore write the same bytes, and a `modelInput` identity derived from those
* bytes does not fork on the order a caller listed them in.
*/
function validateCommitOmissions(init) {
	const withheld = init.withheld ?? [];
	const carried = new Set(init.covers.map((commit) => commit.value));
	const attributed = /* @__PURE__ */ new Set();
	let claimed = 0;
	let unknownAmount = false;
	for (const entry of withheld) {
		if (!(entry instanceof TurnCommitOmission)) throw new TypeError("An attributed omission is a canonical commit omission");
		if (!carried.has(entry.commit.value)) throw new TypeError("An attributed omission names a commit this surface carries");
		if (attributed.has(entry.commit.value)) throw new TypeError("One surface attributes an omission to a commit at most once");
		attributed.add(entry.commit.value);
		if (entry.omission.withheldBytes === void 0) unknownAmount = true;
		else claimed += entry.omission.withheldBytes;
	}
	const omissions = init.sections.map((section) => section.omission);
	if (omissions.every((omission) => omission.kind === "none")) {
		if (withheld.length > 0) throw new TypeError("A surface whose sections withhold nothing attributes no omission to a commit");
		return [];
	}
	const stated = omissions.some((omission) => omission.kind === "unknown") ? void 0 : omissions.reduce((total, omission) => total + (omission.withheldBytes ?? 0), 0);
	if (stated !== void 0 && claimed > stated) throw new TypeError("Attributed omissions withhold no more than this surface's sections state");
	if (init.covers.length > 1 && !unknownAmount && claimed !== stated) {
		if (withheld.length === 0) throw unattributed(`it carries ${init.covers.length} commits and attributes the content it withheld to none of them`);
		if (stated === void 0) throw unattributed("its sections withhold an unknown amount while every attributed amount is exact, so the attribution closes no account");
		throw unattributed(`it attributes ${claimed} of the ${stated} bytes its sections withhold, so a commit it does not name holds the difference`);
	}
	return [...withheld].sort((left, right) => compareCanonicalText(left.commit.value, right.commit.value));
}
function boundOperationData(operation) {
	return {
		binding: operation.binding.value,
		descriptor: operation.descriptor.toData(),
		facet: operation.facet.value,
		operation: operation.operation.value
	};
}
function boundOperationFromData(value) {
	const object = requireObject(value, "Offered Operation");
	requireExactFields(object, [
		"binding",
		"descriptor",
		"facet",
		"operation"
	], [], "Offered Operation");
	return new TurnBoundOperation(new BindingName(requireString(object["binding"], "Offered Operation binding")), new FacetRef(requireString(object["facet"], "Offered Operation Facet")), new OperationRef(requireString(object["operation"], "Offered Operation reference")), OperationDescriptor.fromData(requireShown(object["descriptor"])));
}
/**
* A model input commit's identity, derived from the record it names and the commit it
* descends from. Deriving rather than minting is what makes a second attempt at a commit
* whose outcome was unknown the same commit rather than a second one.
*/
function modelInputCommitId(parent, document) {
	return new RunCommitId(`model-input:${Digest.sha256(encodeCanonicalJson({
		document: document.value,
		parent: parent.value
	})).value}`);
}
/** A field the exact-shape assertion has already proven present. */
function requireShown(value) {
	if (value === void 0) throw new TypeError("A shape-checked record field is missing");
	return value;
}
function unrebuildable(missing) {
	return new AgentCoreError("run.model-input-unrebuildable", `A committed model call request cannot be rebuilt: ${missing}`);
}
function unaccounted(input, discrepancy) {
	return new AgentCoreError("turn.model-input-unaccounted", `Model input ${input.value} does not account for its base transcript: ${discrepancy}`);
}
/**
* A surface that withholds content from more than one carried commit and does not say which.
* It carries the code `unaccounted` uses, because both refuse a surface whose own statement
* does not add up: one over the transcript the surface carries, one over the content the
* surface withheld from that transcript.
*/
function unattributed(discrepancy) {
	return new AgentCoreError("turn.model-input-unaccounted", `A model input does not attribute what its sections withhold: ${discrepancy}`);
}
/**
* The commits of a transcript a surface can carry. A commit naming no content shows the
* model nothing of its own — an `invocation`, an `eventDelivery`, an `undo`, a `migration`
* and an abandoned `rewrite` are graph facts whose model-visible material lives in the
* `message` and `result` commits they pair with, which SPEC §5.2 keeps in the graph through
* `requests` and `invocation` so no cut can strand one. A `modelInput` commit's content is a
* surface record — this rule's own subject — and never history a later call reads.
*/
function accountableTranscript(transcript) {
	return transcript.filter((commit) => commit.content !== void 0 && commit.kind !== "modelInput");
}
function canonicalInvocationResult(result) {
	return result.tier === "mediated" ? Object.freeze({
		tier: "mediated",
		output: canonicalFacetData(result.output),
		evidence: canonicalFacetData(result.evidence),
		admission: result.admission
	}) : Object.freeze({
		tier: "direct",
		output: canonicalFacetData(result.output)
	});
}
/**
* The Invocation and item Receipts a mediated dispatch's evidence names (§7.4). An awaited
* dispatch's handle is verified over the records these identify, so the seam reads the
* identity out of the evidence rather than being told it. A detached admission names no
* Receipt at all and never reaches here: its handle is built from the admitted item.
*/
function admittedIdentity(evidence) {
	const object = requireObject(evidence, "Mediated admission evidence");
	return Object.freeze({
		invocation: new InvocationId(requireString(object["invocation"], "Mediated admission Invocation")),
		receipts: Object.freeze(requireArray(object["receipts"], "Mediated admission Receipts").map((value) => new ReceiptId(requireString(value, "Mediated admission Receipt"))))
	});
}
function canonicalStreamEvent(event) {
	if (event.kind === "content") return Object.freeze({
		kind: "content",
		bytes: event.bytes.slice()
	});
	requireUsage(event.usage);
	return Object.freeze({
		kind: "usage",
		usage: freezeUsage(event.usage)
	});
}
function requireUsage(usage) {
	for (const value of [
		usage.inputTokens,
		usage.outputTokens,
		usage.cacheReadTokens,
		usage.cacheWriteTokens
	]) if (value !== void 0 && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError("Turn model usage values must be non-negative safe integers");
	if (usage.cost !== void 0 && usage.cost.constructor !== RealizedCost) throw new TypeError("Turn model usage cost must use the exact context class");
}
function totalTokens(usage) {
	return usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}
function freezeUsage(usage) {
	let frozen = {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens
	};
	if (usage.cacheReadTokens !== void 0) frozen = {
		...frozen,
		cacheReadTokens: usage.cacheReadTokens
	};
	if (usage.cacheWriteTokens !== void 0) frozen = {
		...frozen,
		cacheWriteTokens: usage.cacheWriteTokens
	};
	if (usage.cost !== void 0) frozen = {
		...frozen,
		cost: usage.cost
	};
	return Object.freeze(frozen);
}
function findCancellation(entries, token) {
	const matches = entries.filter((entry) => entry.cancellationToken !== void 0 && leaseTokensEqual(entry.cancellationToken, token));
	if (matches.length > 1) throw invalidTurn("Turn executor cancellation evidence is not canonical");
	return matches[0];
}
function holdsCurrentLease(turn, token) {
	return turn.status.kind === "running" && turn.lease.holder !== void 0 && leaseTokensEqual({
		turn: turn.id,
		holder: turn.lease.holder,
		epoch: turn.lease.epoch
	}, token);
}
function outcomesEqual(left, right) {
	return bytesEqual(encodeCanonicalJson(outcomeIdentity(left)), encodeCanonicalJson(outcomeIdentity(right)));
}
function outcomeIdentity(outcome) {
	switch (outcome.kind) {
		case "suspended": return [
			outcome.kind,
			encodeBase64(RunCheckpoint.codec.encode(outcome.checkpoint)),
			outcome.commit.value
		];
		case "cancelled": return [
			outcome.kind,
			outcome.result?.value ?? null,
			outcome.commit?.value ?? null
		];
		default: return [
			outcome.kind,
			outcome.result.value,
			outcome.commit.value
		];
	}
}
function required(value, message) {
	if (value === void 0) throw invalidTurn(message);
	return value;
}
function canonicalOutcome(scope) {
	return required(scope.recover(), "Turn transition was not durably recorded");
}
function invalidTurn(message) {
	return new AgentCoreError("turn.invalid-state", message);
}
function requireNotCancelled(signal) {
	if (signal.aborted) throw new AgentCoreError("lease.invalid", "Turn execution is cancelled");
}
//#endregion
export { RunCheckpoint as $, TurnAdmissionHandle as A, exhaustedResource as At, RunMergePort as B, AcceptanceId as Bt, TurnPromptAssembler as C, TurnLease as Ct, TurnStreamHandle as D, ResourceCeiling as Dt, TurnShownContent as E, RESOURCE_DIMENSIONS as Et, TurnAdmissionReceiptFacts as F, RunAdmissionValidationPort as Ft, RunStoragePort as G, RunSourceRevisionPort as Gt, RUN_RECORD_CODECS as H, RunCheckpointId as Ht, TurnAdmissionRecordPort as I, AcceptanceCriterion as It, targetLeaseEvidenceRecordCodec as J, ModelPolicyId as Jt, TargetLeaseEvidenceRecord as K, AgentId as Kt, TurnAdmissionVerifier as L, AcceptanceCriterionCodec as Lt, TurnAdmissionIdentity as M, widensResourceCeiling as Mt, TurnAdmissionMessage as N, RunAdmissionRegistry as Nt, TurnStreamPort as O, SpawnAttenuation as Ot, TurnAdmissionPublisher as P, RunAdmissionRegistryCodec as Pt, SpawnReservation as Q, RunRuntime as R, AcceptanceVerdict as Rt, TurnOutcomeHandle as S, RepositoryTurnLeaseVerifier as St, TurnPromptSectionName as T, RealizedCost as Tt, RUN_RECORD_KINDS as U, SpawnReservationId as Ut, MemoryRunStorage as V, RunBranchId as Vt, RunRepository as W, TurnInboxEntryId as Wt, ForcedTurnCancellationCodec as X, ForcedTurnCancellation as Y, RunSpawnPort as Z, TurnModelInputHandle as _, BlueprintPin as _t, TurnCommitHandle as a, RunInvocationDeliveryCause as at, TurnOmission as b, RunPins as bt, TurnExecutor as c, SettlementObligation as ct, TurnInboxHandle as d, PlacementPin as dt, Turn as et, TurnInvocationHandle as f, TurnPlacementSnapshot as ft, TurnModelInputCodec as g, RunCommit as gt, TurnModelInput as h, unbalancedCut as ht, TurnCheckpointHandle as i, RunInvocationDelivery as it, TurnAdmissionHandleCodec as j, narrowResources as jt, turnModelRequestBytes as k, SpawnAttenuationCodec as kt, TurnExecutorHost as l, TerminalSnapshot as lt, TurnModelHandle as m, orderedAncestry as mt, TurnAdmittedEvent as n, Run as nt, TurnCommitOmission as o, RunInvocationDeliveryCodec as ot, TurnInvocationPort as p, effectiveTranscript as pt, ownRunStorageBackend as q, AgentPolicyId as qt, TurnBoundOperation as r, RunBranch as rt, TurnContentHandle as s, SettlementEvidencePort as st, GatewayTurnInvocationPort as t, TurnInboxEntry as tt, TurnGatewaySource as u, isSettled as ut, TurnModelInputReplay as v, RunConfigurationSnapshot as vt, TurnPromptSection as w, Currency as wt, TurnOperationSource as x, MemoryTurnLeaseVerifier as xt, TurnModelPort as y, RunPinDimension as yt, RunEvidencePort as z, AcceptanceVerdictCodec as zt };

//# sourceMappingURL=runs-CRnZ9IFu.js.map