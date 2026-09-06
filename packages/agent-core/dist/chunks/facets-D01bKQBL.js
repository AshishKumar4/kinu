import { C as canonicalJsonEqual, D as encodeCanonicalJson, E as decodeCanonicalJson, I as isJsonValue, P as isJsonObject, T as compareCanonicalText, _ as ContentRef, h as SecretRef, i as SemVer, j as TextId, k as AgentCoreError, n as StrictJsonSchemaValidator, o as isMember, p as assertCompatibleRecordVersion, t as JsonSchema, w as canonicalTupleKey, y as Digest } from "./core-BjYGo1CC.js";
import "./actors-DJsP1nFM.js";
import { $ as OperationAvailability, At as requireSchemaDocument, C as FieldMove, Ct as isString, D as OperationSelector, Dt as requireDataObject, E as OperationPattern, Et as requireBytes, F as PackagePin, G as OperationDescriptor, I as PackageId, K as SurfaceDescriptor, M as SlotAuthorityPolicy, N as SlotDeclaration, Ot as requireExactFields, P as ContributionAttribution, S as FieldMapping, T as MappingRecord, Tt as requireBoolean$1, U as Contribution, W as Contributions, _ as EventDeclaration, at as FacetPackageId, c as Prompt, ct as OperationName, d as InterceptorDeclaration, dt as SettingsLayerId, f as Command, g as BoundOperationRef, gt as canonicalFacetData, ht as DataRecordCodec, it as EventKind, jt as requireString, kt as requireSafeInteger, l as PromptContribution, lt as OperationRef, mt as SurfaceId, nt as BindingName, ot as FacetRef, pt as SlotName, rt as CatalogEntryId, st as InterceptorId, t as Facet, v as EventPattern, vt as dataRecord, w as JsonPointer, wt as requireArray, xt as isFacetDataMap, yt as freezeFacetData } from "./runtime-z1yMP0an.js";
//#region src/facets/catalog-entry.ts
var CATALOG_KINDS = [
	"command",
	"event",
	"interceptor",
	"operation"
];
/**
* SPEC §4.2: the position one catalog entry occupies — the declaring Facet, or no Facet
* for a host's direct declaration, together with the declared kind and name. It is
* deliberately a different shape from `CatalogEntryId`, because the two answer different
* questions. The id digests every declared field including the source pin, so it answers
* whether two materializations are the same record; the origin names the position a
* changed contribution supersedes. Collapsing them makes a contribution re-read from a
* later release indistinguishable from an illegal rewrite of the record it replaces.
*/
var CatalogOrigin = class {
	kind;
	name;
	owner;
	/** Lookup key for the at-most-one-owner-per-kind-per-name index. */
	key;
	constructor(kind, name, owner) {
		this.kind = kind;
		this.name = name;
		this.owner = owner;
		this.key = canonicalTupleKey("catalog.origin", [
			kind,
			name,
			owner?.value ?? null
		]);
		Object.freeze(this);
	}
	equals(other) {
		return this.key === other.key;
	}
	toData() {
		return dataRecord({
			kind: this.kind,
			name: this.name,
			owner: this.owner?.value
		});
	}
};
/**
* A catalog entry as a Scope holds it: SPEC §4.1 materializes an `operations` or
* `commands` contribution as one, and §4.2 requires every such record to carry the exact
* `FacetRef` of the contributing Facet and the `PackagePin` of the release the
* contribution was read from. A host also offers operations imperatively through the same
* paths (§4.2), so the attribution is what separates a contribution-materialized entry
* from a direct declaration: a direct declaration carries none and may never claim one,
* while a contribution-materialized entry carries exactly the authenticated pair and is
* invalid without it. That split is what makes withdrawal exact — the withdrawal set is a
* query over these fields alone, so it never reaches a host-direct record or another
* Facet's entry.
*/
var CatalogEntry = class CatalogEntry {
	kind;
	name;
	declaration;
	attribution;
	static get codec() {
		return catalogEntryCodec;
	}
	origin;
	id;
	constructor(kind, name, declaration, attribution) {
		this.kind = kind;
		this.name = name;
		this.declaration = declaration;
		this.attribution = attribution;
		const declared = declarationKind(declaration);
		if (declared === void 0) throw new TypeError(`A catalog entry carries one of ${CATALOG_KINDS.join(", ")} declarations`);
		if (declared !== kind) throw new TypeError(`A ${kind} catalog entry declares a different record`);
		const declaredName = catalogName(declaration);
		if (name !== declaredName) throw new TypeError(`Catalog entry name must be its declaration's own name ${declaredName}`);
		if (attribution !== void 0 && !(attribution instanceof ContributionAttribution)) throw new TypeError("A contribution-materialized catalog entry requires attribution");
		this.origin = new CatalogOrigin(kind, name, attribution?.contributor);
		this.id = catalogEntryId(kind, name, declaration, attribution);
		Object.freeze(this);
	}
	/**
	* A wire payload names its attribution fields only when one exists. Absence is the
	* encoding of a direct declaration, so a lone contributor or pin is malformed rather
	* than an unattributed record.
	*/
	static fromData(payload) {
		const object = requireDataObject(payload, "Catalog entry");
		requireExactFields(object, [
			"declaration",
			"id",
			"kind",
			"name"
		], ["contributor", "package"]);
		if (!(object["contributor"] !== void 0 === (object["package"] !== void 0))) throw new TypeError("Catalog entry attribution requires its contributing FacetRef and source Package pin together");
		return new CatalogEntry(requireKind(object["kind"]), requireString(object["name"], "Catalog entry name"), decodeDeclaration(requireKind(object["kind"]), object["declaration"]), object["contributor"] === void 0 ? void 0 : ContributionAttribution.decodeFields(object, "Catalog entry")).requireId(new CatalogEntryId(requireString(object["id"], "Catalog entry ID")));
	}
	static encode(entry) {
		return catalogEntryCodec.encode(entry);
	}
	static decode(bytes) {
		return catalogEntryCodec.decode(bytes);
	}
	toData() {
		return dataRecord({
			...this.attribution?.encodeFields(),
			declaration: this.declaration.toData(),
			id: this.id.value,
			kind: this.kind,
			name: this.name
		});
	}
	requireId(expected) {
		if (!this.id.equals(expected)) throw new TypeError("Catalog entry ID does not match its canonical contents");
		return this;
	}
};
function requireKind(value) {
	const kind = CATALOG_KINDS.find((candidate) => candidate === value);
	if (kind === void 0) throw new TypeError(`Catalog entry kind must be one of ${CATALOG_KINDS.join(", ")}`);
	return kind;
}
/** The kind a declaration is, or nothing when the value declares no catalog record. */
function declarationKind(declaration) {
	if (declaration instanceof Command) return "command";
	if (declaration instanceof EventDeclaration) return "event";
	if (declaration instanceof InterceptorDeclaration) return "interceptor";
	if (declaration instanceof OperationDescriptor) return "operation";
}
/**
* The name a declaration answers to inside its kind. Each kind carries its own declared
* identity — an Event kind, an interceptor id, an Operation or Command name — so the
* catalog never invents one and an entry cannot be filed under a name its declaration
* does not state.
*/
function catalogName(declaration) {
	if (declaration instanceof Command) return declaration.name;
	if (declaration instanceof EventDeclaration) return declaration.kind.value;
	if (declaration instanceof InterceptorDeclaration) return declaration.id.value;
	return declaration.name.value;
}
function decodeDeclaration(kind, payload) {
	if (payload === void 0) throw new TypeError("Catalog entry carries no declaration");
	switch (kind) {
		case "command": return Command.fromData(payload);
		case "event": return EventDeclaration.fromData(payload);
		case "interceptor": return InterceptorDeclaration.fromData(payload);
		case "operation": return OperationDescriptor.fromData(payload);
	}
}
function catalogEntryId(kind, name, declaration, attribution) {
	return new CatalogEntryId(`catalog:${Digest.sha256(encodeCanonicalJson({
		...attribution?.encodeFields(),
		declaration: declaration.toData(),
		kind,
		name
	})).value}`);
}
var catalogEntryCodec = new DataRecordCodec([
	CatalogEntry,
	CatalogOrigin,
	ContributionAttribution,
	OperationDescriptor,
	OperationAvailability,
	Command,
	EventDeclaration,
	EventKind,
	InterceptorDeclaration,
	InterceptorId,
	OperationPattern,
	OperationSelector,
	BindingName,
	SlotName,
	JsonSchema,
	JsonPointer,
	OperationName,
	OperationRef,
	BoundOperationRef,
	MappingRecord,
	FieldMapping,
	FieldMove,
	CatalogEntryId,
	TextId,
	FacetRef,
	FacetPackageId,
	Digest,
	SemVer,
	PackageId,
	PackagePin
], "facet.catalog-entry", (entry) => entry.toData(), (payload) => CatalogEntry.fromData(payload));
//#endregion
//#region src/facets/surface.ts
/**
* A Surface as a Scope holds it: SPEC §6.3's stable UI contribution from a Facet, paired
* with the §4.2 attribution of the Facet whose `surfaces` contribution materialized it. The
* declaration half is authored in a manifest before any release exists, so the pin lives
* here rather than on `SurfaceDescriptor` — the same split `InstalledSlot` makes for Slots —
* and a registration the host cannot attribute cannot be built. That is what lets a host
* answer from records alone which Facet is responsible for a rendered Surface, and what puts
* the Surface in that Facet's §4.1 withdrawal set.
*/
var SurfaceRegistration = class SurfaceRegistration {
	descriptor;
	attribution;
	static get codec() {
		return surfaceRegistrationCodec;
	}
	constructor(descriptor, attribution) {
		this.descriptor = descriptor;
		this.attribution = attribution;
		if (!(descriptor instanceof SurfaceDescriptor) || !(attribution instanceof ContributionAttribution)) throw new TypeError("A Surface registration carries its descriptor and its attribution");
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Surface registration");
		requireExactFields(object, [
			"contributor",
			"descriptor",
			"package"
		]);
		const descriptor = object["descriptor"];
		if (descriptor === void 0) throw new TypeError("Surface registration carries no Surface descriptor");
		return new SurfaceRegistration(SurfaceDescriptor.fromData(descriptor), ContributionAttribution.decodeFields(object, "Surface registration"));
	}
	static encode(registration) {
		return surfaceRegistrationCodec.encode(registration);
	}
	static decode(bytes) {
		return surfaceRegistrationCodec.decode(bytes);
	}
	toData() {
		return {
			...this.attribution.encodeFields(),
			descriptor: this.descriptor.toData()
		};
	}
};
var surfaceRegistrationCodec = new DataRecordCodec([
	SurfaceRegistration,
	SurfaceDescriptor,
	ContributionAttribution,
	TextId,
	SurfaceId,
	FacetRef,
	FacetPackageId,
	Digest,
	SemVer,
	PackageId,
	PackagePin
], "facet.surface-registration", (registration) => registration.toData(), (payload) => SurfaceRegistration.fromData(payload));
//#endregion
//#region src/facets/settings.ts
/**
* SPEC §4.2: the position one settings layer occupies in the merged platform config
* view — the contributing Facet and the declared order of its fragment among that
* Facet's own `settings` contributions. It is deliberately a different shape from
* `SettingsLayerId`, because the two answer different questions: the id digests every
* declared field, so it answers whether two materializations are the same record; the
* origin names the position a changed contribution supersedes.
*/
var SettingsLayerOrigin = class {
	contributor;
	ordinal;
	/** Lookup key for the at-most-one-layer-per-contributor-per-ordinal index. */
	key;
	constructor(contributor, ordinal) {
		this.contributor = contributor;
		this.ordinal = ordinal;
		if (!(contributor instanceof FacetRef)) throw new TypeError("A settings layer origin names its contributor");
		if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new TypeError("Settings layer origin ordinal must be a non-negative safe integer");
		this.key = canonicalTupleKey("settings-layer.origin", [contributor.value, ordinal]);
		Object.freeze(this);
	}
	equals(other) {
		return this.key === other.key;
	}
};
/**
* SPEC §4.2: one Facet's contributed settings fragment as a Scope holds it — the declared
* JSON-schema fragment paired with the §4.2 attribution of the release it was read from.
* The declaration half is authored in a manifest before any release exists, so the pin
* lives here rather than beside the fragment — the same split an InstalledSlot or a
* SurfaceRegistration makes — and a layer the host cannot attribute cannot be built.
* That is what lets a host answer from records alone which Facet contributed any part of
* the merged config schema, and what puts the layer in that Facet's §4.1 withdrawal set.
*/
var SettingsLayer = class SettingsLayer {
	attribution;
	ordinal;
	static get codec() {
		return settingsLayerCodec;
	}
	schema;
	origin;
	/**
	* Derived from the declared fields rather than stored, so it adds nothing to the
	* record's shape and cannot drift from it.
	*/
	id;
	constructor(attribution, ordinal, schema) {
		this.attribution = attribution;
		this.ordinal = ordinal;
		if (!(attribution instanceof ContributionAttribution)) throw new TypeError("Settings layer requires its contribution attribution");
		if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new TypeError("Settings layer ordinal must be a non-negative safe integer");
		const declared = new JsonSchema(requireSchemaDocument(schema, "Settings fragment"));
		declared.assertSupported();
		this.schema = declared;
		this.origin = new SettingsLayerOrigin(attribution.contributor, ordinal);
		this.id = settingsLayerId(attribution, ordinal, declared.document);
		Object.freeze(this);
	}
	static encode(layer) {
		return settingsLayerCodec.encode(layer);
	}
	static decode(bytes) {
		return settingsLayerCodec.decode(bytes);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Settings layer");
		requireExactFields(object, [
			"contributor",
			"ordinal",
			"package",
			"schema"
		]);
		const schema = object["schema"];
		if (schema === void 0) throw new TypeError("Settings layer schema is absent");
		return new SettingsLayer(ContributionAttribution.decodeFields(object, "Settings layer"), requireSafeInteger(object["ordinal"], "Settings layer ordinal"), schema);
	}
	toData() {
		return {
			...this.attribution.encodeFields(),
			ordinal: this.ordinal,
			schema: this.schema.document
		};
	}
};
var settingsLayerCodec = new DataRecordCodec([
	SettingsLayer,
	SettingsLayerOrigin,
	ContributionAttribution,
	TextId,
	FacetRef,
	Digest,
	SettingsLayerId,
	JsonSchema,
	StrictJsonSchemaValidator,
	FacetPackageId,
	SemVer,
	PackageId,
	PackagePin
], "facet.settings-layer", (layer) => layer.toData(), (payload) => SettingsLayer.fromData(payload));
function settingsLayerId(attribution, ordinal, schema) {
	return new SettingsLayerId(`settings:${Digest.sha256(encodeCanonicalJson({
		...attribution.encodeFields(),
		ordinal,
		schema: canonicalFacetData(schema)
	})).value}`);
}
//#endregion
//#region src/facets/profile-runtime/contract.ts
var ProfileOperationContract = class ProfileOperationContract {
	name;
	descriptor;
	inputCodec;
	outputCodec;
	resultMode;
	constructor(name, descriptor, inputCodec, outputCodec, resultMode) {
		this.name = name;
		this.descriptor = descriptor;
		this.inputCodec = inputCodec;
		this.outputCodec = outputCodec;
		this.resultMode = resultMode;
		if (descriptor.name.value !== name) throw new TypeError("Profile operation contract name must match its descriptor");
		descriptor.input.assertSupported();
		descriptor.output.assertSupported();
		Object.freeze(this);
	}
	encodeInput(input) {
		return this.inputCodec.encode(input);
	}
	decodeInput(data) {
		return this.inputCodec.decode(data);
	}
	encodeOutput(output) {
		return this.outputCodec.encode(output);
	}
	decodeOutput(data) {
		return this.outputCodec.decode(data);
	}
	alias(name) {
		return new ProfileOperationContract(name, new OperationDescriptor(new OperationName(name), this.descriptor.impact, this.descriptor.input, this.descriptor.output, this.descriptor.help, this.descriptor.interceptable, this.descriptor.availability), this.inputCodec, this.outputCodec, this.resultMode);
	}
};
var ProfileEventContract = class {
	kind;
	declaration;
	payloadCodec;
	constructor(kind, declaration, payloadCodec) {
		this.kind = kind;
		this.declaration = declaration;
		this.payloadCodec = payloadCodec;
		if (declaration.kind.value !== kind) throw new TypeError("Profile Event contract kind must match its declaration");
		declaration.payload.assertSupported();
		Object.freeze(this);
	}
	encodePayload(payload) {
		return this.payloadCodec.encode(payload);
	}
	decodePayload(data) {
		return this.payloadCodec.decode(data);
	}
};
var ProfileControlContract = class {
	name;
	input;
	output;
	inputCodec;
	outputCodec;
	constructor(name, input, output, inputCodec, outputCodec) {
		this.name = name;
		this.input = input;
		this.output = output;
		this.inputCodec = inputCodec;
		this.outputCodec = outputCodec;
		if (name.length === 0 || name !== name.trim()) throw new TypeError("Profile control contract name must be canonical");
		input.assertSupported();
		output.assertSupported();
		Object.freeze(this);
	}
	encodeInput(input) {
		return this.inputCodec.encode(input);
	}
	decodeInput(data) {
		return this.inputCodec.decode(data);
	}
	encodeOutput(output) {
		return this.outputCodec.encode(output);
	}
	decodeOutput(data) {
		return this.outputCodec.decode(data);
	}
};
//#endregion
//#region src/facets/profile-runtime/error.ts
var DetailedProfileError = class extends AgentCoreError {
	detailCode;
	detail;
	constructor(code, detailCode, message) {
		super(code, message);
		this.detailCode = detailCode;
		this.name = "DetailedProfileError";
		this.detail = Object.freeze({ code: detailCode });
	}
};
//#endregion
//#region src/facets/profile-runtime/facet.ts
var ProfileFacetRuntime = class extends Facet {};
var InternalProfileFacetRuntime = class extends ProfileFacetRuntime {
	init;
	#operations;
	#surfaces;
	#interceptors;
	#children;
	#started = false;
	#starting;
	#stopping;
	constructor(init) {
		super();
		this.init = init;
		this.#operations = uniqueMap(init.operations, (operation) => operation.descriptor.name.value, "Operation");
		this.#surfaces = uniqueMap(init.surfaces ?? [], (surface) => surface.descriptor.id.value, "Surface");
		this.#interceptors = uniqueMap(init.interceptors ?? [], (interceptor) => interceptor.declaration.id.value, "Interceptor");
		this.#children = Object.freeze([...init.children ?? []]);
		init.runtime.deactivate();
		requireExactDeclarations(init.manifest.contributions.get(new SlotName("operations"))?.map(OperationDescriptor.fromData) ?? [], [...this.#operations.values()].map((operation) => operation.descriptor), "Operation");
		requireExactDeclarations(init.manifest.contributions.get(new SlotName("surfaces"))?.map(SurfaceDescriptor.fromData) ?? [], [...this.#surfaces.values()].map((surface) => surface.descriptor), "Surface");
	}
	get ref() {
		return this.init.runtime.host.facet;
	}
	get manifest() {
		return this.init.manifest;
	}
	get active() {
		return this.#started && this.init.runtime.active;
	}
	operation(name) {
		return this.#operations.get(name.value);
	}
	surface(id) {
		return this.#surfaces.get(id.value);
	}
	interceptor(id) {
		return this.#interceptors.get(id.value);
	}
	children() {
		return this.#children;
	}
	async start(context) {
		if (this.#stopping !== void 0) await this.#stopping;
		if (this.#started) return;
		if (this.#starting !== void 0) return this.#starting;
		this.#starting = this.startOnce(context);
		return this.#starting;
	}
	async stop(context) {
		if (this.#starting !== void 0) await this.#starting;
		if (this.#stopping !== void 0) return this.#stopping;
		if (!this.#started) return;
		this.#stopping = this.stopOnce(context);
		return this.#stopping;
	}
	async startOnce(context) {
		try {
			await this.init.start?.(context);
			if (context.signal.aborted) return;
			this.init.runtime.activate();
			this.#started = true;
		} finally {
			this.#starting = void 0;
		}
	}
	async stopOnce(context) {
		this.#started = false;
		this.init.runtime.deactivate();
		try {
			await this.init.stop?.(context);
		} finally {
			this.#stopping = void 0;
		}
	}
};
function uniqueMap(values, key, subject) {
	const result = new Map(values.map((value) => [key(value), value]));
	if (result.size !== values.length) throw invalidRuntime(`Internal profile ${subject} implementations must be unique`);
	return result;
}
function requireExactDeclarations(declared, implemented, subject) {
	const data = (values) => values.map((value) => declarationDecoder.decode(encodeCanonicalJson(value.toData()))).sort(compareCanonicalText);
	if (!canonicalJsonEqual(data(declared), data(implemented))) throw invalidRuntime(`Internal profile ${subject} declarations do not match its runtime`);
}
var declarationDecoder = new TextDecoder("utf-8", { fatal: true });
function invalidRuntime(message) {
	return new DetailedProfileError("protocol.invalid-state", "runtime.declaration", message);
}
schema({
	type: "object",
	additionalProperties: false
});
JsonSchema.any();
function schema(document) {
	const value = new JsonSchema(document);
	value.assertSupported();
	return value;
}
function strictObjectSchema(properties, required = []) {
	return schema({
		type: "object",
		properties,
		required,
		additionalProperties: false
	});
}
//#endregion
//#region src/invocation-references/id.ts
var ApprovalId = class extends TextId {
	constructor(value) {
		super(value, "Approval ID");
		Object.freeze(this);
	}
};
var ReceiptId = class extends TextId {
	constructor(value) {
		super(value, "Receipt ID");
		Object.freeze(this);
	}
};
var EffectAttemptId = class extends TextId {
	constructor(value) {
		super(value, "Effect attempt ID");
		Object.freeze(this);
	}
};
var ItemClaimId = class extends TextId {
	constructor(value) {
		super(value, "Item claim ID");
		Object.freeze(this);
	}
};
var ClaimWorkerId = class extends TextId {
	constructor(value) {
		super(value, "Claim worker ID");
		Object.freeze(this);
	}
};
var WriteRecordId = class extends TextId {
	constructor(value) {
		super(value, "Write record ID");
		Object.freeze(this);
	}
};
//#endregion
//#region src/facets/profile-runtime/wire.ts
var ProfileWireCodec = class ProfileWireCodec {
	encodeValue;
	decodeValue;
	constructor(encodeValue, decodeValue) {
		this.encodeValue = encodeValue;
		this.decodeValue = decodeValue;
		if (new.target === ProfileWireCodec) Object.freeze(this);
	}
	encode(value) {
		return canonicalFacetData(this.encodeValue(value));
	}
	decode(data) {
		return this.decodeValue(canonicalFacetData(data));
	}
};
var VersionedProfileWireCodec = class extends ProfileWireCodec {
	major;
	minor;
	supported;
	constructor(encodeValue, decodeValue, major = 1, minor = 0) {
		super(encodeValue, decodeValue);
		this.major = major;
		this.minor = minor;
		if (!Number.isSafeInteger(major) || major < 1 || !Number.isSafeInteger(minor) || minor < 0) throw new TypeError("Profile wire codec version is invalid");
		this.supported = Object.freeze({
			major,
			minor
		});
		Object.freeze(this);
	}
	decodeVersion(version, data) {
		if (!Number.isSafeInteger(version.major) || version.major < 0 || !Number.isSafeInteger(version.minor) || version.minor < 0) throw new DetailedProfileError("codec.invalid", "wire.input", "Profile input codec version is invalid");
		try {
			assertCompatibleRecordVersion("profile input", version, this.supported);
		} catch (error) {
			if (!(error instanceof AgentCoreError)) throw error;
			throw new DetailedProfileError(error.code, "wire.input", error.message);
		}
		return this.decode(data);
	}
};
function profileWireCodec(encode, decode) {
	return new ProfileWireCodec(encode, decode);
}
function versionedProfileWireCodec(encode, decode) {
	return new VersionedProfileWireCodec(encode, decode);
}
function facetDataWireCodec() {
	return profileWireCodec((value) => value, (data) => data);
}
var voidProfileWireCodec = profileWireCodec(() => null, (data) => {
	if (data !== null) throw new DetailedProfileError("operation.invalid-input", "wire.input", "Void profile wire value must be null");
});
//#endregion
//#region src/facets/approval-gateway/facet.ts
var inputSchema = strictObjectSchema({ resource: {
	type: "string",
	minLength: 1
} }, ["resource"]);
var inputCodec = profileWireCodec((input) => ({ resource: input.resource }), (data) => ({ resource: requireString(requireDataObject(data, "Gateway input")["resource"], "Gateway resource") }));
var APPROVAL_GATEWAY_OPERATION_CONTRACTS = Object.freeze({
	observe: new ProfileOperationContract("observe", new OperationDescriptor(new OperationName("observe"), "externalSend", inputSchema, schema({})), inputCodec, facetDataWireCodec(), "output"),
	applyAction: new ProfileOperationContract("applyAction", new OperationDescriptor(new OperationName("applyAction"), "externalSend", inputSchema, schema({})), inputCodec, facetDataWireCodec(), "output")
});
var APPROVAL_GATEWAY_OPERATIONS = Object.freeze(Object.values(APPROVAL_GATEWAY_OPERATION_CONTRACTS).map((contract) => contract.descriptor));
var APPROVAL_GATEWAY_SURFACE = new SurfaceDescriptor(new SurfaceId("approval.gateway"), "Approvals", "Renders whole-intent approval requests and outcomes.");
new Contributions([new Contribution(new SlotName("operations"), APPROVAL_GATEWAY_OPERATIONS.map((operation) => operation.toData())), new Contribution(new SlotName("surfaces"), [APPROVAL_GATEWAY_SURFACE.toData()])]);
Object.freeze(["provider"]);
//#endregion
//#region src/facets/device/id.ts
var DeviceId = class extends TextId {
	constructor(value) {
		super(value, "Device ID");
		if (value.trim() !== value) throw new TypeError("Device ID must be canonical");
	}
};
var DeviceCommandId = class extends TextId {
	constructor(value) {
		super(value, "Device command ID");
		if (value.trim() !== value) throw new TypeError("Device command ID must be canonical");
	}
};
//#endregion
//#region src/facets/device/facet.ts
var LIVE_DEVICE_OPERATIONS = Object.freeze([
	"camera",
	"location",
	"sms",
	"screen",
	"system.run"
]);
var idProperty$3 = {
	type: "string",
	minLength: 1
};
var jsonOutput = schema({});
function liveOperation(name, argumentsSchema) {
	const inputSchema = strictObjectSchema({
		deviceId: idProperty$3,
		arguments: argumentsSchema
	}, ["deviceId", "arguments"]);
	return new ProfileOperationContract(name, new OperationDescriptor(new OperationName(name), "externalSend", inputSchema, jsonOutput), versionedProfileWireCodec((input) => ({
		deviceId: input.deviceId.value,
		arguments: input.arguments
	}), (data) => {
		const object = requireDataObject(data, `Device ${name} input`);
		return {
			deviceId: new DeviceId(requireString(object["deviceId"], "Device ID")),
			arguments: requireDataObject(object["arguments"], `Device ${name} arguments`)
		};
	}), facetDataWireCodec(), "output");
}
var DEVICE_OPERATION_CONTRACTS = Object.freeze({
	camera: liveOperation("camera", {
		type: "object",
		properties: { facing: { enum: ["front", "rear"] } },
		required: ["facing"],
		additionalProperties: false
	}),
	location: liveOperation("location", {
		type: "object",
		properties: { accuracyMeters: {
			type: "number",
			minimum: 0
		} },
		additionalProperties: false
	}),
	sms: liveOperation("sms", {
		type: "object",
		properties: {
			to: idProperty$3,
			message: {
				type: "string",
				minLength: 1
			}
		},
		required: ["to", "message"],
		additionalProperties: false
	}),
	screen: liveOperation("screen", {
		type: "object",
		properties: { mode: { enum: ["capture", "stream"] } },
		required: ["mode"],
		additionalProperties: false
	}),
	systemRun: liveOperation("system.run", {
		type: "object",
		properties: {
			command: {
				type: "string",
				minLength: 1
			},
			arguments: {
				type: "array",
				items: { type: "string" }
			}
		},
		required: ["command"],
		additionalProperties: false
	}),
	readCached: new ProfileOperationContract("readCached", new OperationDescriptor(new OperationName("readCached"), "observe", strictObjectSchema({
		deviceId: idProperty$3,
		key: idProperty$3
	}, ["deviceId", "key"]), schema({ anyOf: [{}, { type: "null" }] })), versionedProfileWireCodec((input) => ({
		deviceId: input.deviceId.value,
		key: input.key
	}), (data) => {
		const object = requireDataObject(data, "Device cache input");
		return {
			deviceId: new DeviceId(requireString(object["deviceId"], "Device ID")),
			key: requireString(object["key"], "Device cache key")
		};
	}), profileWireCodec((value) => value ?? null, (data) => data === null ? void 0 : data), "output")
});
var DEVICE_OPERATIONS = Object.freeze(Object.values(DEVICE_OPERATION_CONTRACTS).map((contract) => contract.descriptor));
var DEVICE_PAIR_CONTROL = new ProfileControlContract("device.pair", strictObjectSchema({
	deviceId: idProperty$3,
	publicKey: idProperty$3,
	operatorApproval: idProperty$3
}, [
	"deviceId",
	"publicKey",
	"operatorApproval"
]), schema({ type: "null" }), profileWireCodec((input) => ({
	...input,
	deviceId: input.deviceId.value
}), (data) => {
	const object = requireDataObject(data, "Device pair input");
	return {
		deviceId: new DeviceId(requireString(object["deviceId"], "Device ID")),
		publicKey: requireString(object["publicKey"], "Device public key"),
		operatorApproval: requireString(object["operatorApproval"], "Operator approval")
	};
}), voidProfileWireCodec);
var DEVICE_COMMAND_SURFACE = new SurfaceDescriptor(new SurfaceId("device.commands"), "Device commands", "Invokes typed commands on a paired device.");
var DEVICE_COMMAND_SLOT = new SlotDeclaration(new SlotName("device.commands"), schema({ type: "object" }), new SlotAuthorityPolicy(["installed"], ["scope.read"]));
var DEVICE_COMMANDS = Object.freeze(LIVE_DEVICE_OPERATIONS.map((operation) => new Command({
	name: operation,
	title: operation,
	arguments: DEVICE_OPERATIONS.find((descriptor) => descriptor.name.value === operation).input,
	operation: new OperationRef(`profile.device:${operation}`),
	binding: new BindingName("device"),
	surfaces: [new SlotName("device.commands")]
})));
var DEVICE_COMMAND_EVENTS = Object.freeze({
	invoked: new EventDeclaration(new EventKind("command.invoked"), "A typed device command was invoked.", strictObjectSchema({
		commandId: idProperty$3,
		operation: { enum: LIVE_DEVICE_OPERATIONS },
		deviceId: idProperty$3,
		arguments: {}
	}, [
		"commandId",
		"operation",
		"deviceId",
		"arguments"
	]), "workspace"),
	completed: new EventDeclaration(new EventKind("command.completed"), "A typed device command completed.", strictObjectSchema({
		commandId: idProperty$3,
		succeeded: { type: "boolean" },
		result: {}
	}, ["commandId", "succeeded"]), "workspace")
});
var DEVICE_COMMAND_EVENT_CONTRACTS = Object.freeze({
	invoked: new ProfileEventContract("command.invoked", DEVICE_COMMAND_EVENTS.invoked, profileWireCodec((event) => ({
		commandId: event.commandId.value,
		operation: event.operation,
		deviceId: event.deviceId.value,
		arguments: event.arguments
	}), (data) => {
		const event = requireDataObject(data, "Device command invoked Event");
		return {
			kind: "command.invoked",
			commandId: new DeviceCommandId(requireString(event["commandId"], "Device command ID")),
			operation: requireLiveOperation(event["operation"]),
			deviceId: new DeviceId(requireString(event["deviceId"], "Device ID")),
			arguments: event["arguments"]
		};
	})),
	completed: new ProfileEventContract("command.completed", DEVICE_COMMAND_EVENTS.completed, profileWireCodec((event) => dataRecord({
		commandId: event.commandId.value,
		succeeded: event.succeeded,
		result: event.result
	}), (data) => {
		const event = requireDataObject(data, "Device command completed Event");
		const succeeded = requireBoolean(event["succeeded"], "Device command completion state");
		const result = event["result"];
		const completed = {
			kind: "command.completed",
			commandId: new DeviceCommandId(requireString(event["commandId"], "Device command ID")),
			succeeded
		};
		return result === void 0 ? completed : {
			...completed,
			result
		};
	}))
});
new Contributions([
	new Contribution(new SlotName("operations"), DEVICE_OPERATIONS.map((operation) => operation.toData())),
	new Contribution(new SlotName("commands"), DEVICE_COMMANDS.map((command) => command.toData())),
	new Contribution(new SlotName("events"), Object.values(DEVICE_COMMAND_EVENTS).map((event) => event.toData())),
	new Contribution(new SlotName("slots"), [DEVICE_COMMAND_SLOT.toData()]),
	new Contribution(new SlotName("surfaces"), [DEVICE_COMMAND_SURFACE.toData()])
]);
(class {
	runtime;
	backend;
	static operations = DEVICE_OPERATIONS;
	static commands = DEVICE_COMMANDS;
	static events = Object.freeze(Object.values(DEVICE_COMMAND_EVENTS));
	constructor(runtime, backend) {
		this.runtime = runtime;
		this.backend = backend;
	}
	asInternalRuntime(manifest) {
		return new InternalProfileFacetRuntime({
			manifest,
			runtime: this.runtime,
			operations: [
				this.runtime.operation(DEVICE_OPERATION_CONTRACTS.camera, (input, context) => this.backend.execute("camera", input, context)),
				this.runtime.operation(DEVICE_OPERATION_CONTRACTS.location, (input, context) => this.backend.execute("location", input, context)),
				this.runtime.operation(DEVICE_OPERATION_CONTRACTS.sms, (input, context) => this.backend.execute("sms", input, context)),
				this.runtime.operation(DEVICE_OPERATION_CONTRACTS.screen, (input, context) => this.backend.execute("screen", input, context)),
				this.runtime.operation(DEVICE_OPERATION_CONTRACTS.systemRun, (input, context) => this.backend.execute("system.run", input, context)),
				this.runtime.operation(DEVICE_OPERATION_CONTRACTS.readCached, (input) => this.backend.readCached(input))
			],
			surfaces: [this.runtime.surface(DEVICE_COMMAND_SURFACE)]
		});
	}
	pair(input) {
		return this.runtime.control(DEVICE_PAIR_CONTROL, input, (admitted) => this.backend.pair(admitted));
	}
	camera(input) {
		return this.runtime.invoke(DEVICE_OPERATION_CONTRACTS.camera, input, (admitted, context) => this.backend.execute("camera", admitted, context));
	}
	location(input) {
		return this.runtime.invoke(DEVICE_OPERATION_CONTRACTS.location, input, (admitted, context) => this.backend.execute("location", admitted, context));
	}
	sms(input) {
		return this.runtime.invoke(DEVICE_OPERATION_CONTRACTS.sms, input, (admitted, context) => this.backend.execute("sms", admitted, context));
	}
	screen(input) {
		return this.runtime.invoke(DEVICE_OPERATION_CONTRACTS.screen, input, (admitted, context) => this.backend.execute("screen", admitted, context));
	}
	systemRun(input) {
		return this.runtime.invoke(DEVICE_OPERATION_CONTRACTS.systemRun, input, (admitted, context) => this.backend.execute("system.run", admitted, context));
	}
	readCached(input) {
		return this.runtime.invoke(DEVICE_OPERATION_CONTRACTS.readCached, input, (admitted) => this.backend.readCached(admitted));
	}
	async command(input) {
		const source = await this.invokeCommand(input);
		await this.runtime.emit(DEVICE_COMMAND_EVENT_CONTRACTS.invoked, Object.freeze({
			kind: "command.invoked",
			commandId: input.commandId,
			operation: input.operation,
			deviceId: input.deviceId,
			arguments: canonicalFacetData(input.arguments)
		}), source.receipt);
		await this.runtime.emit(DEVICE_COMMAND_EVENT_CONTRACTS.completed, Object.freeze({
			kind: "command.completed",
			commandId: input.commandId,
			succeeded: true,
			result: source.output
		}), source.receipt);
		return source.output;
	}
	invokeCommand(input) {
		const encoded = {
			deviceId: input.deviceId.value,
			arguments: input.arguments
		};
		switch (input.operation) {
			case "camera": return this.invokeLiveCommand(DEVICE_OPERATION_CONTRACTS.camera, DEVICE_OPERATION_CONTRACTS.camera.decodeInput(encoded), "camera");
			case "location": return this.invokeLiveCommand(DEVICE_OPERATION_CONTRACTS.location, DEVICE_OPERATION_CONTRACTS.location.decodeInput(encoded), "location");
			case "sms": return this.invokeLiveCommand(DEVICE_OPERATION_CONTRACTS.sms, DEVICE_OPERATION_CONTRACTS.sms.decodeInput(encoded), "sms");
			case "screen": return this.invokeLiveCommand(DEVICE_OPERATION_CONTRACTS.screen, DEVICE_OPERATION_CONTRACTS.screen.decodeInput(encoded), "screen");
			case "system.run": return this.invokeLiveCommand(DEVICE_OPERATION_CONTRACTS.systemRun, DEVICE_OPERATION_CONTRACTS.systemRun.decodeInput(encoded), "system.run");
		}
	}
	invokeLiveCommand(contract, input, operation) {
		return this.runtime.invokeWithReceipt(contract, input, (admitted, context) => this.backend.execute(operation, admitted, context));
	}
});
function requireBoolean(value, subject) {
	if (value !== true && value !== false) throw new TypeError(`${subject} is invalid`);
	return value;
}
function requireLiveOperation(value) {
	if (isMember(LIVE_DEVICE_OPERATIONS, value)) return value;
	throw new TypeError("Device command operation is invalid");
}
Object.freeze(["provider"]);
Object.freeze([]);
Object.freeze([]);
Contributions.empty();
var EnvironmentSessionBinding = class {
	session;
	generation;
	children;
	constructor(session, generation, children) {
		this.session = session;
		this.generation = generation;
		if (session.length === 0 || session !== session.trim()) throw new TypeError("Environment session binding ID must be canonical");
		if (!Number.isSafeInteger(generation) || generation < 0) throw new TypeError("Environment session binding generation must be a non-negative safe integer");
		if (new Set(children).size !== children.length) throw new TypeError("Environment session child binding names must be unique");
		this.children = Object.freeze([...children]);
		Object.freeze(this);
	}
};
var idProperty$2 = {
	type: "string",
	minLength: 1
};
var contentRefProperty$1 = {
	type: "string",
	pattern: "^sha256:[a-f0-9]{64}$"
};
var sessionSchema = schema({
	type: "object",
	properties: {
		session: idProperty$2,
		generation: {
			type: "integer",
			minimum: 0
		},
		children: {
			type: "array",
			items: { type: "string" },
			uniqueItems: true
		}
	},
	required: [
		"session",
		"generation",
		"children"
	],
	additionalProperties: false
});
var sessionInput = strictObjectSchema({ session: idProperty$2 }, ["session"]);
var sessionInputCodec = profileWireCodec((input) => ({ session: input.session }), (data) => ({ session: requireString(requireDataObject(data, "Environment session input")["session"], "Session ID") }));
var sessionBindingCodec = profileWireCodec((binding) => ({
	session: binding.session,
	generation: binding.generation,
	children: [...binding.children]
}), (data) => {
	const object = requireDataObject(data, "Environment session binding");
	return new EnvironmentSessionBinding(requireString(object["session"], "Environment session ID"), requireSafeInteger(object["generation"], "Environment generation"), requireArray(object["children"], "Environment child bindings").map((value) => requireString(value, "Environment child binding")));
});
var snapshotInputCodec = profileWireCodec((input) => ({
	session: input.session,
	snapshot: input.snapshot
}), (data) => {
	const object = requireDataObject(data, "Environment snapshot input");
	return {
		session: requireString(object["session"], "Environment session ID"),
		snapshot: requireString(object["snapshot"], "Environment snapshot ID")
	};
});
var contentRefCodec = profileWireCodec((content) => content.value, (data) => new ContentRef(requireString(data, "Content reference")));
Object.freeze({
	open: new ProfileControlContract("environment.open", strictObjectSchema({
		environment: idProperty$2,
		restoreFrom: idProperty$2
	}, ["environment"]), sessionSchema, profileWireCodec((input) => dataRecord({
		environment: input.environment,
		restoreFrom: input.restoreFrom
	}), (data) => {
		const object = requireDataObject(data, "Environment open input");
		const restoreFrom = object["restoreFrom"];
		const input = { environment: requireString(object["environment"], "Environment ID") };
		return restoreFrom === void 0 ? input : {
			...input,
			restoreFrom: requireString(restoreFrom, "Environment snapshot ID")
		};
	}), sessionBindingCodec),
	use: new ProfileControlContract("environment.use", sessionInput, sessionSchema, sessionInputCodec, sessionBindingCodec),
	close: new ProfileControlContract("environment.close", sessionInput, schema({ type: "null" }), sessionInputCodec, voidProfileWireCodec),
	snapshot: new ProfileControlContract("environment.snapshot", strictObjectSchema({
		session: idProperty$2,
		snapshot: idProperty$2
	}, ["session", "snapshot"]), schema(contentRefProperty$1), snapshotInputCodec, contentRefCodec),
	restore: new ProfileControlContract("environment.restore", strictObjectSchema({
		environment: idProperty$2,
		snapshot: idProperty$2
	}, ["environment", "snapshot"]), sessionSchema, profileWireCodec((input) => ({
		environment: input.environment,
		snapshot: input.snapshot
	}), (data) => {
		const object = requireDataObject(data, "Environment restore input");
		return {
			environment: requireString(object["environment"], "Environment ID"),
			snapshot: requireString(object["snapshot"], "Environment snapshot ID")
		};
	}), sessionBindingCodec),
	backupEphemeral: new ProfileControlContract("environment.backupEphemeral", sessionInput, schema(contentRefProperty$1), sessionInputCodec, contentRefCodec),
	restoreEphemeral: new ProfileControlContract("environment.restoreEphemeral", strictObjectSchema({
		session: idProperty$2,
		snapshot: idProperty$2
	}, ["session", "snapshot"]), schema({ type: "null" }), snapshotInputCodec, voidProfileWireCodec),
	exposePreview: new ProfileControlContract("environment.exposePreview", strictObjectSchema({
		session: idProperty$2,
		port: {
			type: "integer",
			minimum: 1,
			maximum: 65535
		}
	}, ["session", "port"]), schema({
		type: "string",
		format: "uri"
	}), profileWireCodec((input) => ({
		session: input.session,
		port: input.port
	}), (data) => {
		const object = requireDataObject(data, "Environment preview input");
		return {
			session: requireString(object["session"], "Environment session ID"),
			port: requireSafeInteger(object["port"], "Environment preview port")
		};
	}), profileWireCodec((value) => value, (data) => requireString(data, "Environment preview URL"))),
	forwardCredential: new ProfileControlContract("environment.forwardCredential", strictObjectSchema({
		session: idProperty$2,
		credential: {
			type: "object",
			properties: {
				source: idProperty$2,
				provider: idProperty$2,
				id: idProperty$2
			},
			required: [
				"source",
				"provider",
				"id"
			],
			additionalProperties: false
		},
		request: contentRefProperty$1
	}, [
		"session",
		"credential",
		"request"
	]), schema(contentRefProperty$1), profileWireCodec((input) => ({
		session: input.session,
		credential: {
			source: input.credential.source,
			provider: input.credential.provider,
			id: input.credential.id
		},
		request: input.request.value
	}), (data) => {
		const object = requireDataObject(data, "Environment credential input");
		const credential = requireDataObject(object["credential"], "Environment credential");
		return {
			session: requireString(object["session"], "Environment session ID"),
			credential: new SecretRef(requireString(credential["source"], "Credential source"), requireString(credential["provider"], "Credential provider"), requireString(credential["id"], "Credential ID")),
			request: new ContentRef(requireString(object["request"], "Credential request"))
		};
	}), contentRefCodec)
});
Object.freeze(["provider"]);
//#endregion
//#region src/facets/filesystem/error.ts
var FILESYSTEM_ERROR_CODES = Object.freeze([
	"not-found",
	"exists",
	"not-a-directory",
	"is-a-directory",
	"path.invalid",
	"too-large",
	"content-mismatch"
]);
var FilesystemError = class extends DetailedProfileError {
	path;
	constructor(code, path, message) {
		if (!FILESYSTEM_ERROR_CODES.includes(code)) throw new TypeError("Filesystem error code is outside the fixed profile set");
		super("operation.invalid-input", code, message);
		this.path = path;
		this.name = "FilesystemError";
	}
};
//#endregion
//#region src/facets/filesystem/facet.ts
/**
* What the store found at the write target when it reached its atomic step. `absent` and
* `present` are separate shapes rather than a nullable content field, so a backing store
* cannot report a present target without naming the content it holds: the state that would
* let a guarded write pass against content nobody looked at is unconstructable rather than
* checked. `fold` is total, so every consumer answers both cases or does not compile.
*/
var FilesystemTargetState = class {
	static get absent() {
		return absentTargetState;
	}
	static present(content) {
		return new PresentTargetState(content);
	}
};
var AbsentTargetState = class extends FilesystemTargetState {
	fold(cases) {
		return cases.absent();
	}
};
var PresentTargetState = class extends FilesystemTargetState {
	content;
	constructor(content) {
		super();
		this.content = content;
		Object.freeze(this);
	}
	fold(cases) {
		return cases.present(this.content);
	}
};
var absentTargetState = Object.freeze(new AbsentTargetState());
/**
* A write mode owns the precondition that makes it distinct: `create` requires the target
* absent, `replace` requires it present and holding the content the request names, `upsert`
* requires nothing. The precondition is a per-case method rather than a caller-side branch,
* so no write path can reach the store without discharging it.
*
* `replace` is the one parameterized case, and it is a factory taking its guard rather than a
* singleton: a `replace` that names no content is unconstructable, which is what makes the
* request carry its own proof of observation instead of the profile keeping a per-session
* observed-state ledger. `create` and `upsert` carry no guard and stay argument-less getters,
* so the illegal pairings — a guarded `create`, an unguarded `replace` — are unrepresentable.
*/
var FilesystemWriteMode = class {
	static get create() {
		return createWriteMode;
	}
	static replace(expected) {
		return new ReplaceWriteMode(expected);
	}
	static get upsert() {
		return upsertWriteMode;
	}
};
var CreateWriteMode = class extends FilesystemWriteMode {
	name = "create";
	requireWritable(path, target) {
		target.fold({
			absent: () => {},
			present: () => {
				throw new FilesystemError("exists", path, "Path already exists");
			}
		});
	}
	toData() {
		return { name: this.name };
	}
};
var ReplaceWriteMode = class extends FilesystemWriteMode {
	expected;
	name = "replace";
	constructor(expected) {
		super();
		this.expected = expected;
		if (!(expected instanceof Digest)) throw new TypeError("Replace guard must be a Digest");
		Object.freeze(this);
	}
	requireWritable(path, target) {
		target.fold({
			absent: () => {
				throw new FilesystemError("not-found", path, "Path does not exist");
			},
			present: (content) => {
				if (!Digest.sha256(content).equals(this.expected)) throw new FilesystemError("content-mismatch", path, "Path content differs from the digest the write names");
			}
		});
	}
	toData() {
		return {
			name: this.name,
			expected: this.expected.value
		};
	}
};
/**
* The profile's one write over content the caller never read. Its precondition is empty by
* design rather than by omission: `create` requires absence and `replace` requires the
* content it names, so `upsert` is the single unobserved overwrite, and because a mode is
* always declared it is a `mutate` intent a Workspace policy can refuse by name instead of
* the shape a write falls back to.
*/
var UpsertWriteMode = class extends FilesystemWriteMode {
	name = "upsert";
	requireWritable() {}
	toData() {
		return { name: this.name };
	}
};
var createWriteMode = Object.freeze(new CreateWriteMode());
var upsertWriteMode = Object.freeze(new UpsertWriteMode());
/**
* Every mode the wire admits, paired with the decoder that owns its exact field set. The
* unguarded cases refuse a guard and `replace` requires one, so the illegal pairings the
* domain makes unconstructable — a guarded `create`, an unguarded `replace` — are equally
* unrepresentable on the wire rather than normalized on the way in.
*/
var FILESYSTEM_WRITE_MODE_TERMS = Object.freeze([
	Object.freeze({
		name: "create",
		decode: (mode) => {
			requireExactWriteModeFields(mode, ["name"]);
			return createWriteMode;
		}
	}),
	Object.freeze({
		name: "replace",
		decode: (mode) => {
			requireExactWriteModeFields(mode, ["name", "expected"]);
			return FilesystemWriteMode.replace(new Digest(requireString(mode["expected"], "Filesystem replace guard")));
		}
	}),
	Object.freeze({
		name: "upsert",
		decode: (mode) => {
			requireExactWriteModeFields(mode, ["name"]);
			return upsertWriteMode;
		}
	})
]);
var FILESYSTEM_WRITE_MODE_NAMES = Object.freeze(FILESYSTEM_WRITE_MODE_TERMS.map((term) => term.name));
var pathProperty = {
	type: "string",
	minLength: 1
};
var nonNegativeInteger = {
	type: "integer",
	minimum: 0
};
var statSchema = {
	type: "object",
	properties: {
		path: pathProperty,
		kind: { enum: ["file", "directory"] },
		size: nonNegativeInteger,
		modifiedAt: nonNegativeInteger
	},
	required: [
		"path",
		"kind",
		"size",
		"modifiedAt"
	],
	additionalProperties: false
};
var writeModeSchema = {
	type: "object",
	properties: {
		name: { enum: FILESYSTEM_WRITE_MODE_NAMES },
		expected: {
			type: "string",
			pattern: "^[a-f0-9]{64}$"
		}
	},
	required: ["name"],
	additionalProperties: false
};
var voidSchema$1 = schema({ type: "null" });
function operation$2(name, impact, input, output, inputCodec, outputCodec, resultMode) {
	return new ProfileOperationContract(name, new OperationDescriptor(new OperationName(name), impact, input, output), inputCodec, outputCodec, resultMode);
}
var FILESYSTEM_OPERATION_CONTRACTS = Object.freeze({
	read: operation$2("read", "observe", strictObjectSchema({
		path: pathProperty,
		range: {
			type: "object",
			properties: {
				offset: nonNegativeInteger,
				length: nonNegativeInteger
			},
			additionalProperties: false
		}
	}, ["path"]), schema({
		type: "array",
		items: {
			type: "integer",
			minimum: 0,
			maximum: 255
		}
	}), profileWireCodec((input) => dataRecord({
		path: input.path,
		range: input.range === void 0 ? void 0 : dataRecord({
			offset: input.range.offset,
			length: input.range.length
		})
	}), (data) => {
		const object = requireDataObject(data, "Filesystem read input");
		const range = object["range"];
		const input = { path: requireString(object["path"], "Filesystem read path") };
		return range === void 0 ? input : {
			...input,
			range: decodeRange(range)
		};
	}), byteCodec(), "output"),
	stat: operation$2("stat", "observe", strictObjectSchema({ path: pathProperty }, ["path"]), schema(statSchema), pathInputCodec((path) => ({ path })), statCodec(), "output"),
	list: operation$2("list", "observe", strictObjectSchema({
		path: pathProperty,
		cursor: pathProperty,
		limit: {
			type: "integer",
			minimum: 1
		}
	}, ["path"]), schema({
		type: "object",
		properties: {
			entries: {
				type: "array",
				items: statSchema
			},
			cursor: pathProperty
		},
		required: ["entries"],
		additionalProperties: false
	}), profileWireCodec((input) => dataRecord({
		path: input.path,
		cursor: input.cursor,
		limit: input.limit
	}), (data) => {
		const object = requireDataObject(data, "Filesystem list input");
		const cursor = object["cursor"];
		const limit = object["limit"];
		let input = { path: requireString(object["path"], "Filesystem list path") };
		if (cursor !== void 0) input = {
			...input,
			cursor: requireString(cursor, "Filesystem list cursor")
		};
		if (limit !== void 0) input = {
			...input,
			limit: requireSafeInteger(limit, "Filesystem list limit")
		};
		return input;
	}), pageCodec(), "output"),
	write: operation$2("write", "mutate", strictObjectSchema({
		path: pathProperty,
		content: {
			type: "array",
			items: {
				type: "integer",
				minimum: 0,
				maximum: 255
			}
		},
		mode: writeModeSchema
	}, [
		"path",
		"content",
		"mode"
	]), voidSchema$1, profileWireCodec((input) => dataRecord({
		path: input.path,
		content: [...input.content],
		mode: input.mode.toData()
	}), decodeWriteInput), voidProfileWireCodec, "receipt"),
	remove: operation$2("remove", "mutate", strictObjectSchema({ path: pathProperty }, ["path"]), voidSchema$1, pathInputCodec((path) => ({ path })), voidProfileWireCodec, "receipt"),
	move: operation$2("move", "mutate", strictObjectSchema({
		source: pathProperty,
		destination: pathProperty
	}, ["source", "destination"]), voidSchema$1, profileWireCodec((input) => ({
		source: input.source,
		destination: input.destination
	}), (data) => {
		const object = requireDataObject(data, "Filesystem move input");
		return {
			source: requireString(object["source"], "Filesystem move source"),
			destination: requireString(object["destination"], "Filesystem move destination")
		};
	}), voidProfileWireCodec, "receipt"),
	mkdir: operation$2("mkdir", "mutate", strictObjectSchema({
		path: pathProperty,
		recursive: { type: "boolean" }
	}, ["path"]), voidSchema$1, profileWireCodec((input) => dataRecord({
		path: input.path,
		recursive: input.recursive
	}), (data) => {
		const object = requireDataObject(data, "Filesystem mkdir input");
		const recursive = object["recursive"];
		const input = { path: requireString(object["path"], "Filesystem mkdir path") };
		return recursive === void 0 ? input : {
			...input,
			recursive: recursive === true
		};
	}), voidProfileWireCodec, "receipt")
});
var FILESYSTEM_OPERATIONS = Object.freeze(Object.values(FILESYSTEM_OPERATION_CONTRACTS).map((contract) => contract.descriptor));
new Contributions([new Contribution(new SlotName("operations"), FILESYSTEM_OPERATIONS.map((operation) => operation.toData()))]);
function pathInputCodec(build) {
	return profileWireCodec((input) => ({ path: input.path }), (data) => build(requireString(requireDataObject(data, "Filesystem path input")["path"], "Filesystem path")));
}
function byteCodec() {
	return profileWireCodec((value) => [...value], decodeBytes$1);
}
function statCodec() {
	return profileWireCodec((value) => ({ ...value }), decodeStat);
}
function pageCodec() {
	return profileWireCodec((value) => dataRecord({
		entries: value.entries.map((entry) => statCodec().encode(entry)),
		cursor: value.cursor
	}), decodePage);
}
function decodeRange(data) {
	const object = requireDataObject(data, "Filesystem read range");
	const offset = object["offset"];
	const length = object["length"];
	let range = {};
	if (offset !== void 0) range = {
		...range,
		offset: requireSafeInteger(offset, "Read offset")
	};
	if (length !== void 0) range = {
		...range,
		length: requireSafeInteger(length, "Read length")
	};
	return range;
}
function decodeWriteInput(data) {
	const object = requireDataObject(data, "Filesystem write input");
	return {
		path: requireString(object["path"], "Filesystem write path"),
		content: decodeBytes$1(object["content"]),
		mode: requireWriteMode(object["mode"])
	};
}
function decodeBytes$1(data) {
	return requireBytes(data, "Filesystem bytes are invalid");
}
/**
* The single parse-at-the-edge: the wire carries a mode label and, for `replace`, the digest
* it guards against; the domain carries a mode object. An unrecognised label never reaches a
* write path, and neither does a `replace` that names no digest — the term's own decoder owns
* its exact field set, so an unguarded `replace` produces no mode rather than a permissive one.
* An omitted mode takes the same exit: the decoder refuses it rather than choosing one, which
* is what keeps `upsert` a declaration instead of the shape a write falls back to.
*/
function requireWriteMode(value) {
	if (isFacetDataMap(value)) {
		const term = FILESYSTEM_WRITE_MODE_TERMS.find((candidate) => candidate.name === value["name"]);
		if (term !== void 0) return term.decode(value);
	}
	throw new DetailedProfileError("operation.invalid-input", "operation.invalid-input", "Write mode must be create, replace, or upsert");
}
function requireExactWriteModeFields(mode, admitted) {
	if (Object.keys(mode).length !== admitted.length || admitted.some((field) => !(field in mode))) throw new DetailedProfileError("operation.invalid-input", "operation.invalid-input", `Write mode ${String(mode["name"])} admits exactly ${admitted.join(", ")}`);
}
function decodePage(data) {
	const object = requireDataObject(data, "Filesystem page");
	const entries = object["entries"];
	if (!Array.isArray(entries)) throw new TypeError("Filesystem page entries must be an array");
	const page = { entries: Object.freeze(entries.map(decodeStat)) };
	const cursor = object["cursor"];
	return Object.freeze(cursor === void 0 ? page : {
		...page,
		cursor: requireString(cursor, "Filesystem page cursor")
	});
}
function decodeStat(data) {
	const object = requireDataObject(data, "Filesystem stat");
	const kind = requireString(object["kind"], "Filesystem entry kind");
	if (kind !== "file" && kind !== "directory") throw new TypeError("Filesystem entry kind is invalid");
	return Object.freeze({
		path: requireString(object["path"], "Filesystem stat path"),
		kind,
		size: requireSafeInteger(object["size"], "Filesystem stat size"),
		modifiedAt: requireSafeInteger(object["modifiedAt"], "Filesystem modified time")
	});
}
Object.freeze(["provider", "bundled"]);
Object.freeze([]);
var McpDiscoveryRegistration = class {
	document;
	digest;
	constructor(document, expectedDigest) {
		const bytes = canonicalDiscoveryBytes(document);
		const digest = Digest.sha256(bytes);
		if (expectedDigest !== void 0 && !digest.equals(expectedDigest)) throw new TypeError("MCP discovery registration digest does not match its document");
		const decoded = decodeCanonicalJson(bytes);
		requireDiscoveryDocument(decoded);
		this.document = freezeDiscoveryDocument(decoded);
		this.digest = digest;
		Object.freeze(this);
	}
	static encode(registration) {
		return mcpDiscoveryRegistrationCodec.encode(registration);
	}
	static decode(bytes) {
		return mcpDiscoveryRegistrationCodec.decode(bytes);
	}
	toData() {
		return {
			digest: this.digest.value,
			document: this.document
		};
	}
};
var mcpDiscoveryRegistrationCodec = new DataRecordCodec([
	McpDiscoveryRegistration,
	TextId,
	Digest
], "facet.mcp-discovery-registration", (registration) => registration.toData(), (payload) => {
	const object = requireDataObject(payload, "MCP discovery registration");
	requireExactFields(object, ["digest", "document"]);
	const document = object["document"];
	requireDiscoveryDocument(document);
	return new McpDiscoveryRegistration(document, new Digest(requireString(object["digest"], "MCP discovery digest")));
});
var emptySchema = strictObjectSchema({});
var voidSchema = schema({ type: "null" });
var emptyInputCodec = profileWireCodec(() => ({}), (data) => {
	requireDataObject(data, "MCP control input");
	return {};
});
var MCP_CONTROL_CONTRACTS = Object.freeze({
	start: new ProfileControlContract("mcp.start", emptySchema, voidSchema, emptyInputCodec, voidProfileWireCodec),
	health: new ProfileControlContract("mcp.health", emptySchema, schema({ type: "boolean" }), emptyInputCodec, profileWireCodec((value) => value, (data) => requireBoolean$1(data, "MCP health"))),
	stop: new ProfileControlContract("mcp.stop", emptySchema, voidSchema, emptyInputCodec, voidProfileWireCodec),
	discover: new ProfileControlContract("mcp.discover", emptySchema, schema({
		type: "object",
		properties: {
			operations: {
				type: "array",
				items: { type: "object" }
			},
			prompts: {
				type: "array",
				items: { type: "object" }
			},
			promptContribution: {
				type: "array",
				items: { type: "object" }
			},
			contributions: { type: "object" }
		},
		required: [
			"operations",
			"prompts",
			"promptContribution",
			"contributions"
		],
		additionalProperties: false
	}), emptyInputCodec, profileWireCodec((result) => ({
		operations: result.operations.map((operation) => operation.toData()),
		prompts: result.prompts.map((prompt) => ({ ...prompt })),
		promptContribution: result.promptContribution.toData(),
		contributions: result.contributions.toData()
	}), decodeDiscoveryResult))
});
Object.freeze({
	lifecycle: Object.freeze([
		MCP_CONTROL_CONTRACTS.start,
		MCP_CONTROL_CONTRACTS.health,
		MCP_CONTROL_CONTRACTS.stop
	]),
	discovery: MCP_CONTROL_CONTRACTS.discover
});
var MCP_PARENT_SLOT = new SlotDeclaration(new SlotName("mcp.parent"), strictObjectSchema({
	lifecycle: {
		type: "array",
		prefixItems: [
			{ const: "mcp.start" },
			{ const: "mcp.health" },
			{ const: "mcp.stop" }
		],
		minItems: 3,
		maxItems: 3
	},
	discovery: { const: "mcp.discover" },
	promptBounds: {
		type: "object",
		properties: {
			maximumPrompts: { const: "config.maximumPrompts" },
			maximumBytes: { const: "config.maximumPromptBytes" }
		},
		required: ["maximumPrompts", "maximumBytes"],
		additionalProperties: false
	}
}, [
	"lifecycle",
	"discovery",
	"promptBounds"
]), new SlotAuthorityPolicy(["installed"], ["scope.read"]));
var MCP_PARENT_CONTRIBUTION = Object.freeze({
	lifecycle: Object.freeze([
		"mcp.start",
		"mcp.health",
		"mcp.stop"
	]),
	discovery: "mcp.discover",
	promptBounds: Object.freeze({
		maximumPrompts: "config.maximumPrompts",
		maximumBytes: "config.maximumPromptBytes"
	})
});
new Contributions([new Contribution(new SlotName("slots"), [MCP_PARENT_SLOT.toData()]), new Contribution(new SlotName("mcp.parent"), [MCP_PARENT_CONTRIBUTION])]);
Object.freeze([
	"observe",
	"mutate",
	"externalSend",
	"execute",
	"delegate",
	"administer"
]);
var McpDiscoveryError = class extends DetailedProfileError {
	constructor(detailCode, message) {
		super(detailCode === "operation.missing" ? "operation.missing" : "operation.invalid-input", detailCode, message);
		this.name = "McpDiscoveryError";
	}
};
function requireDiscoveryDocument(document) {
	if (!isJsonValue(document) || !isJsonObject(document)) throw malformedDiscovery();
	const tools = document["tools"];
	const resources = document["resources"];
	const prompts = document["prompts"];
	if (!isString(document["revision"]) || !Array.isArray(tools) || !Array.isArray(resources) || !Array.isArray(prompts)) throw malformedDiscovery();
	for (const tool of tools) if (!isJsonObject(tool) || !isString(tool["name"]) || tool["inputSchema"] === void 0 || tool["outputSchema"] === void 0) throw malformedDiscovery();
	for (const resource of resources) if (!isJsonObject(resource) || !isString(resource["name"]) || resource["outputSchema"] === void 0) throw malformedDiscovery();
	for (const prompt of prompts) if (!isJsonObject(prompt) || !isString(prompt["title"]) || !isString(prompt["body"])) throw malformedDiscovery();
}
function malformedDiscovery() {
	return new McpDiscoveryError("schema.invalid", "MCP discovery document is malformed");
}
function canonicalDiscoveryBytes(document) {
	return encodeCanonicalJson(document);
}
function freezeDiscoveryDocument(document) {
	return freezeFacetData(document);
}
function decodeDiscoveryResult(data) {
	const object = requireDataObject(data, "MCP discovery result");
	const prompts = Object.freeze(requireArray(object["prompts"], "MCP prompts").map((value) => {
		const prompt = requireDataObject(value, "MCP prompt");
		return Object.freeze({
			title: requireString(prompt["title"], "MCP prompt title"),
			body: requireString(prompt["body"], "MCP prompt body")
		});
	}));
	return Object.freeze({
		operations: Object.freeze(requireArray(object["operations"], "MCP operations").map(OperationDescriptor.fromData)),
		prompts,
		promptContribution: new PromptContribution(requireArray(object["promptContribution"], "MCP prompt contribution").map(Prompt.fromData)),
		contributions: Contributions.fromMap(Object.fromEntries(Object.entries(requireDataObject(object["contributions"] ?? null, "MCP contributions")).map(([slot, entries]) => [slot, requireArray(entries ?? null, `MCP contribution ${slot}`)])))
	});
}
Object.freeze(["provider", "bundled"]);
new JsonSchema({
	type: "object",
	properties: {
		remote: { type: "boolean" },
		maximumPrompts: {
			type: "integer",
			minimum: 1,
			maximum: 32
		},
		maximumPromptBytes: {
			type: "integer",
			minimum: 1,
			maximum: 262144
		}
	},
	required: [
		"remote",
		"maximumPrompts",
		"maximumPromptBytes"
	],
	additionalProperties: false
});
//#endregion
//#region src/facets/memory/facet.ts
var MemoryEntry = class {
	id;
	content;
	authority;
	createdAt;
	retainUntil;
	constructor(id, content, authority, createdAt, retainUntil) {
		this.id = id;
		this.content = content;
		this.authority = authority;
		this.createdAt = createdAt;
		this.retainUntil = retainUntil;
		if (id.length === 0 || id !== id.trim()) throw new TypeError("Memory ID must be canonical");
		if (authority.trim().length === 0) throw new TypeError("Memory authority must be nonblank");
		if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError("Memory creation time is invalid");
		if (retainUntil !== void 0 && (!Number.isSafeInteger(retainUntil) || retainUntil < createdAt)) throw new TypeError("Memory retention must not predate creation");
		Object.freeze(this);
	}
};
var idProperty$1 = {
	type: "string",
	minLength: 1
};
var contentRefProperty = {
	type: "string",
	pattern: "^sha256:[a-f0-9]{64}$"
};
var timeProperty = {
	type: "integer",
	minimum: 0
};
var entrySchema = schema({
	type: "object",
	properties: {
		id: idProperty$1,
		content: contentRefProperty,
		authority: idProperty$1,
		createdAt: timeProperty,
		retainUntil: timeProperty
	},
	required: [
		"id",
		"content",
		"authority",
		"createdAt"
	],
	additionalProperties: false
});
var entryCodec = profileWireCodec((entry) => dataRecord({
	id: entry.id,
	content: entry.content.value,
	authority: entry.authority,
	createdAt: entry.createdAt,
	retainUntil: entry.retainUntil
}), decodeMemoryEntry);
var MEMORY_OPERATION_CONTRACTS = Object.freeze({
	remember: new ProfileOperationContract("remember", new OperationDescriptor(new OperationName("remember"), "mutate", strictObjectSchema({
		id: idProperty$1,
		content: contentRefProperty,
		createdAt: timeProperty,
		retainUntil: timeProperty
	}, [
		"id",
		"content",
		"createdAt"
	]), entrySchema), profileWireCodec((input) => dataRecord({
		id: input.id,
		content: input.content.value,
		createdAt: input.createdAt,
		retainUntil: input.retainUntil
	}), (data) => {
		const object = requireDataObject(data, "Remember input");
		const retainUntil = object["retainUntil"];
		const input = {
			id: requireString(object["id"], "Memory ID"),
			content: new ContentRef(requireString(object["content"], "Memory content")),
			createdAt: requireSafeInteger(object["createdAt"], "Memory created time")
		};
		return retainUntil === void 0 ? input : {
			...input,
			retainUntil: requireSafeInteger(retainUntil, "Memory retention")
		};
	}), entryCodec, "output"),
	recall: new ProfileOperationContract("recall", new OperationDescriptor(new OperationName("recall"), "observe", strictObjectSchema({
		query: { type: "string" },
		limit: {
			type: "integer",
			minimum: 0
		}
	}, ["query"]), schema({
		type: "array",
		items: entrySchema.document
	})), recallInputCodec(), profileWireCodec((entries) => entries.map((entry) => entryCodec.encode(entry)), (data) => Object.freeze(requireArray(data, "Memory recall output").map(decodeMemoryEntry))), "output"),
	forget: new ProfileOperationContract("forget", new OperationDescriptor(new OperationName("forget"), "mutate", strictObjectSchema({ id: idProperty$1 }, ["id"]), schema({ type: "boolean" })), profileWireCodec((input) => ({ id: input.id }), (data) => ({ id: requireString(requireDataObject(data, "Forget input")["id"], "Memory ID") })), profileWireCodec((value) => value, (data) => data === true), "output")
});
var MEMORY_OPERATIONS = Object.freeze(Object.values(MEMORY_OPERATION_CONTRACTS).map((contract) => contract.descriptor));
var MEMORY_PROMPT_CONTRIBUTION_DESCRIPTOR = new PromptContribution([new Prompt("Relevant memory", "Materialize only bounded memory content readable through the protected recall Operation.", 0)]);
new ProfileControlContract("memory.prompt", strictObjectSchema({
	query: { type: "string" },
	limit: {
		type: "integer",
		minimum: 0
	}
}, ["query"]), schema({
	type: "array",
	items: {
		type: "object",
		properties: {
			title: {
				type: "string",
				minLength: 1
			},
			body: {
				type: "string",
				minLength: 1
			},
			priority: { type: "integer" }
		},
		required: [
			"title",
			"body",
			"priority"
		],
		additionalProperties: false
	}
}), recallInputCodec(), profileWireCodec((contribution) => contribution.toData(), (data) => new PromptContribution(requireArray(data, "Memory prompt contribution").map(Prompt.fromData))));
new Contributions([new Contribution(new SlotName("operations"), MEMORY_OPERATIONS.map((operation) => operation.toData())), new Contribution(new SlotName("prompt"), [MEMORY_PROMPT_CONTRIBUTION_DESCRIPTOR.toData()])]);
function recallInputCodec() {
	return profileWireCodec((input) => dataRecord({
		query: input.query,
		limit: input.limit
	}), (data) => {
		const object = requireDataObject(data, "Memory query input");
		const limit = object["limit"];
		const input = { query: requireString(object["query"], "Memory query") };
		return limit === void 0 ? input : {
			...input,
			limit: requireSafeInteger(limit, "Memory query limit")
		};
	});
}
function decodeMemoryEntry(data) {
	const object = requireDataObject(data, "Memory entry");
	return new MemoryEntry(requireString(object["id"], "Memory ID"), new ContentRef(requireString(object["content"], "Memory content")), requireString(object["authority"], "Memory authority"), requireSafeInteger(object["createdAt"], "Memory created time"), object["retainUntil"] === void 0 ? void 0 : requireSafeInteger(object["retainUntil"], "Memory retention"));
}
Object.freeze(["provider", "bundled"]);
//#endregion
//#region src/facets/self/facet.ts
function operation$1(name, impact, property, build) {
	const input = strictObjectSchema({ [property]: {} }, [property]);
	return new ProfileOperationContract(name, new OperationDescriptor(new OperationName(name), impact, input, schema({})), profileWireCodec((value) => ({ [property]: value[property] }), (data) => build(requireField(requireDataObject(data, `Self ${name} input`), property, `Self ${name} input`))), facetDataWireCodec(), "output");
}
function requireField(input, property, subject) {
	const value = input[property];
	if (value === void 0) throw new TypeError(`${subject} must carry ${property}`);
	return value;
}
var SELF_OPERATION_CONTRACTS = Object.freeze({
	checkpoint: operation$1("checkpoint", "mutate", "checkpoint", (checkpoint) => ({ checkpoint })),
	commitMessage: operation$1("commitMessage", "mutate", "message", (message) => ({ message })),
	spawn: operation$1("spawn", "delegate", "child", (child) => ({ child })),
	finish: operation$1("finish", "mutate", "result", (result) => ({ result })),
	proposeMigration: operation$1("proposeMigration", "administer", "migration", (migration) => ({ migration }))
});
var SELF_OPERATIONS = Object.freeze(Object.values(SELF_OPERATION_CONTRACTS).map((contract) => contract.descriptor));
new Contributions([new Contribution(new SlotName("operations"), SELF_OPERATIONS.map((operation) => operation.toData()))]);
Object.freeze(["bundled"]);
//#endregion
//#region src/facets/shell/id.ts
var ShellExecutionId = class extends TextId {
	constructor(value) {
		super(value, "Shell execution ID");
		if (value.trim() !== value) throw new TypeError("Shell execution ID must be canonical");
	}
};
//#endregion
//#region src/facets/shell/facet.ts
var runInputSchema = strictObjectSchema({
	executionId: {
		type: "string",
		minLength: 1
	},
	commandLine: { type: "string" }
}, ["executionId", "commandLine"]);
var cancelInputSchema = strictObjectSchema({ executionId: {
	type: "string",
	minLength: 1
} }, ["executionId"]);
var exitCodeSchema = schema({ type: "integer" });
var booleanSchema = schema({ type: "boolean" });
var runInputCodec = profileWireCodec((input) => ({
	executionId: input.executionId.value,
	commandLine: input.commandLine
}), (data) => {
	const object = requireDataObject(data, "Shell run input");
	return {
		executionId: new ShellExecutionId(requireString(object["executionId"], "Shell execution ID")),
		commandLine: requireString(object["commandLine"], "Shell command line")
	};
});
var cancelInputCodec = profileWireCodec((input) => ({ executionId: input.executionId.value }), (data) => ({ executionId: new ShellExecutionId(requireString(requireDataObject(data, "Shell cancel input")["executionId"], "Shell execution ID")) }));
var SHELL_OPERATION_CONTRACTS = Object.freeze({
	run: new ProfileOperationContract("run", new OperationDescriptor(new OperationName("run"), "execute", runInputSchema, exitCodeSchema), runInputCodec, profileWireCodec((value) => value, (data) => requireSafeInteger(data, "Exit code")), "output"),
	cancel: new ProfileOperationContract("cancel", new OperationDescriptor(new OperationName("cancel"), "mutate", cancelInputSchema, booleanSchema), cancelInputCodec, profileWireCodec((value) => value, (data) => data === true), "output")
});
var SHELL_OPERATIONS = Object.freeze(Object.values(SHELL_OPERATION_CONTRACTS).map((contract) => contract.descriptor));
new Contributions([new Contribution(new SlotName("operations"), SHELL_OPERATIONS.map((operation) => operation.toData()))]);
Object.freeze(["provider", "bundled"]);
Object.freeze([]);
Object.freeze([]);
Contributions.empty();
//#endregion
//#region src/facets/slate/facet.ts
function operation(name, impact, inputSchema, inputCodec) {
	return new ProfileOperationContract(name, new OperationDescriptor(new OperationName(name), impact, inputSchema, schema({ type: "object" })), inputCodec, facetDataWireCodec(), "output");
}
var SLATE_OPERATION_CONTRACTS = Object.freeze({
	update: operation("update", "mutate", strictObjectSchema({
		slateId: {
			type: "string",
			minLength: 1
		},
		source: {
			type: "string",
			pattern: "^sha256:[a-f0-9]{64}$"
		},
		expectedRevision: {
			type: "integer",
			minimum: 0
		}
	}, ["slateId", "source"]), profileWireCodec((input) => dataRecord({
		slateId: input.slate,
		source: input.source,
		expectedRevision: input.expectedRevision
	}), (data) => {
		const object = requireDataObject(data, "Slate update input");
		const expectedRevision = decodeExpectedRevision(object);
		const input = {
			slate: requireString(object["slateId"], "Slate ID"),
			source: requireString(object["source"], "Slate source")
		};
		return expectedRevision === void 0 ? input : {
			...input,
			expectedRevision
		};
	})),
	commit: operation("commit", "mutate", strictObjectSchema({
		slateId: {
			type: "string",
			minLength: 1
		},
		expectedRevision: {
			type: "integer",
			minimum: 0
		}
	}, ["slateId"]), profileWireCodec((input) => dataRecord({
		slateId: input.slate,
		expectedRevision: input.expectedRevision
	}), (data) => {
		const object = requireDataObject(data, "Slate commit input");
		const expectedRevision = decodeExpectedRevision(object);
		const input = { slate: requireString(object["slateId"], "Slate ID") };
		return expectedRevision === void 0 ? input : {
			...input,
			expectedRevision
		};
	})),
	fork: operation("fork", "mutate", strictObjectSchema({
		sourceVersionId: {
			type: "string",
			minLength: 1
		},
		workspaceId: {
			type: "string",
			minLength: 1
		}
	}, ["sourceVersionId", "workspaceId"]), profileWireCodec((input) => ({
		sourceVersionId: input.sourceVersion,
		workspaceId: input.workspace
	}), (data) => {
		const input = requireDataObject(data, "Slate fork input");
		return {
			sourceVersion: requireString(input["sourceVersionId"], "Slate source version ID"),
			workspace: requireString(input["workspaceId"], "Slate Workspace ID")
		};
	})),
	publish: operation("publish", "mutate", strictObjectSchema({
		versionId: {
			type: "string",
			minLength: 1
		},
		materialization: {
			type: "string",
			pattern: "^sha256:[a-f0-9]{64}$"
		}
	}, ["versionId", "materialization"]), profileWireCodec((input) => ({
		versionId: input.version,
		materialization: input.materialization
	}), (data) => {
		const input = requireDataObject(data, "Slate publish input");
		return {
			version: requireString(input["versionId"], "Slate version ID"),
			materialization: requireString(input["materialization"], "Slate materialization")
		};
	})),
	deploy: operation("deploy", "externalSend", strictObjectSchema({
		publicationId: {
			type: "string",
			minLength: 1
		},
		target: {
			type: "string",
			minLength: 1
		}
	}, ["publicationId", "target"]), profileWireCodec((input) => ({
		publicationId: input.publication,
		target: input.target
	}), (data) => {
		const input = requireDataObject(data, "Slate deploy input");
		return {
			publication: requireString(input["publicationId"], "Slate publication ID"),
			target: requireString(input["target"], "Slate deployment target")
		};
	})),
	rollback: operation("rollback", "mutate", strictObjectSchema({
		slateId: {
			type: "string",
			minLength: 1
		},
		deploymentId: {
			type: "string",
			minLength: 1
		},
		expectedActiveDeploymentId: {
			type: "string",
			minLength: 1
		}
	}, ["slateId", "deploymentId"]), profileWireCodec((input) => dataRecord({
		slateId: input.slate,
		deploymentId: input.deployment,
		expectedActiveDeploymentId: input.expectedActiveDeployment
	}), (data) => {
		const object = requireDataObject(data, "Slate rollback input");
		const expected = object["expectedActiveDeploymentId"];
		const input = {
			slate: requireString(object["slateId"], "Slate ID"),
			deployment: requireString(object["deploymentId"], "Slate deployment ID")
		};
		return expected === void 0 ? input : {
			...input,
			expectedActiveDeployment: requireString(expected, "Expected active Slate deployment ID")
		};
	}))
});
var SLATE_OPERATIONS = Object.freeze(Object.values(SLATE_OPERATION_CONTRACTS).map((contract) => contract.descriptor));
Object.freeze(["dynamic"]);
var SLATE_SURFACES = Object.freeze([new SurfaceDescriptor(new SurfaceId("slate.publication"), "Published Slate", "Renders an immutable published Slate version."), new SurfaceDescriptor(new SurfaceId("slate.embed"), "Embedded Slate", "Embeds an immutable published Slate version in another Surface.")]);
new Contributions([new Contribution(new SlotName("operations"), SLATE_OPERATIONS.map((operation) => operation.toData())), new Contribution(new SlotName("surfaces"), SLATE_SURFACES.map((surface) => surface.toData()))]);
function decodeExpectedRevision(input) {
	const expected = input["expectedRevision"];
	if (expected === void 0) return void 0;
	const revision = requireSafeInteger(expected, "Expected Slate revision");
	if (revision < 0) throw new TypeError("Expected Slate revision must not be negative");
	return revision;
}
new JsonSchema({
	type: "object",
	properties: {
		backendIsolation: { const: "dynamic" },
		ambientAuthority: { const: false }
	},
	required: ["backendIsolation", "ambientAuthority"]
});
//#endregion
//#region src/execution-references/id.ts
var RunId = class extends TextId {
	constructor(value) {
		super(value, "Run ID");
	}
};
var TurnId = class extends TextId {
	constructor(value) {
		super(value, "Turn ID");
	}
};
var RunCommitId = class extends TextId {
	constructor(value) {
		super(value, "Run commit ID");
	}
};
//#endregion
//#region src/facets/task/id.ts
var TaskId = class extends TextId {
	constructor(value) {
		super(value, "Task ID");
		Object.freeze(this);
	}
};
//#endregion
//#region src/facets/task/facet.ts
var TaskEntry = class TaskEntry {
	id;
	parentId;
	runId;
	attributes;
	constructor(id, parentId, runId, attributes) {
		this.id = id;
		this.parentId = parentId;
		this.runId = runId;
		if (!(id instanceof TaskId) || parentId !== void 0 && !(parentId instanceof TaskId)) throw new TypeError("Task identifiers must use their context-owned classes");
		if (id.value.length === 0 || id.value !== id.value.trim()) throw new TypeError("Task ID must be canonical");
		if (parentId?.equals(id)) throw new TypeError("A task cannot be its own parent");
		this.attributes = canonicalFacetData(attributes);
		Object.freeze(this);
	}
	revise(update) {
		return new TaskEntry(this.id, update.parentId === void 0 ? this.parentId : update.parentId ?? void 0, update.runId === void 0 ? this.runId : update.runId ?? void 0, update.attributes === void 0 ? this.attributes : update.attributes);
	}
};
var idProperty = {
	type: "string",
	minLength: 1
};
var taskSchema = schema({
	type: "object",
	properties: {
		id: idProperty,
		parentId: { type: ["string", "null"] },
		runId: { type: ["string", "null"] },
		attributes: {}
	},
	required: ["id", "attributes"],
	additionalProperties: false
});
var updateSchema = {
	type: "object",
	properties: {
		parentId: { type: ["string", "null"] },
		runId: { type: ["string", "null"] },
		attributes: {}
	},
	additionalProperties: false
};
var taskEntryCodec = profileWireCodec((task) => ({
	id: task.id.value,
	parentId: task.parentId?.value ?? null,
	runId: task.runId?.value ?? null,
	attributes: task.attributes
}), decodeTaskEntry);
var TASK_OPERATION_CONTRACTS = Object.freeze({
	create: new ProfileOperationContract("create", new OperationDescriptor(new OperationName("create"), "mutate", strictObjectSchema({ task: taskSchema.document }, ["task"]), schema({ type: "null" })), profileWireCodec((input) => ({ task: taskEntryCodec.encode(input.task) }), (data) => ({ task: decodeTaskEntry(requireDataObject(data, "Task create input")["task"]) })), voidProfileWireCodec, "output"),
	update: new ProfileOperationContract("update", new OperationDescriptor(new OperationName("update"), "mutate", strictObjectSchema({
		id: idProperty,
		update: updateSchema
	}, ["id", "update"]), taskSchema), profileWireCodec((input) => ({
		id: input.id.value,
		update: encodeTaskUpdate(input.update)
	}), (data) => {
		const object = requireDataObject(data, "Task update input");
		return {
			id: new TaskId(requireString(object["id"], "Task ID")),
			update: decodeTaskUpdate(object["update"])
		};
	}), taskEntryCodec, "output"),
	list: new ProfileOperationContract("list", new OperationDescriptor(new OperationName("list"), "observe", strictObjectSchema({}), schema({
		type: "array",
		items: taskSchema.document
	})), profileWireCodec(() => ({}), (data) => {
		requireDataObject(data, "Task list input");
		return {};
	}), profileWireCodec((tasks) => tasks.map((task) => taskEntryCodec.encode(task)), (data) => Object.freeze(requireArray(data, "Task list output").map(decodeTaskEntry))), "output")
});
var TASK_OPERATIONS = Object.freeze(Object.values(TASK_OPERATION_CONTRACTS).map((contract) => contract.descriptor));
var TASK_BOARD_SURFACE = new SurfaceDescriptor(new SurfaceId("task.board"), "Tasks", "Renders the task hierarchy and submits task actions.");
var TASK_ACTION_EVENT = new EventDeclaration(new EventKind("task.actionSubmitted"), "A task-board action was submitted.", strictObjectSchema({
	taskId: idProperty,
	action: {}
}, ["taskId", "action"]), "workspace");
var TASK_ACTION_EVENT_CONTRACT = new ProfileEventContract("task.actionSubmitted", TASK_ACTION_EVENT, profileWireCodec((event) => ({
	taskId: event.taskId.value,
	action: event.action
}), (data) => {
	const object = requireDataObject(data, "Task action Event");
	return {
		kind: "task.actionSubmitted",
		taskId: new TaskId(requireString(object["taskId"], "Task action ID")),
		action: object["action"]
	};
}));
var TASK_ACTION_CONTROL = new ProfileControlContract("task.submitAction", TASK_ACTION_EVENT.payload, schema({ type: "null" }), profileWireCodec((input) => ({
	taskId: input.taskId.value,
	action: input.action
}), (data) => {
	const object = requireDataObject(data, "Task action input");
	return {
		taskId: new TaskId(requireString(object["taskId"], "Task action ID")),
		action: object["action"]
	};
}), voidProfileWireCodec);
var TASK_ACTION_SOURCE_OPERATION = new ProfileOperationContract("task.submitAction", new OperationDescriptor(new OperationName("task.submitAction"), "mutate", TASK_ACTION_EVENT.payload, schema({ type: "null" })), TASK_ACTION_CONTROL.inputCodec, voidProfileWireCodec, "output");
var TASK_ACTION_SUBSCRIPTION = Object.freeze({
	source: new EventPattern("task.actionSubmitted", [
		"owner",
		"authenticated",
		"self"
	]),
	target: new OperationName("update")
});
new Contributions([
	new Contribution(new SlotName("operations"), TASK_OPERATIONS.map((operation) => operation.toData())),
	new Contribution(new SlotName("surfaces"), [TASK_BOARD_SURFACE.toData()]),
	new Contribution(new SlotName("events"), [TASK_ACTION_EVENT.toData()])
]);
(class {
	runtime;
	backend;
	static operations = TASK_OPERATIONS;
	static surface = TASK_BOARD_SURFACE;
	static events = Object.freeze([TASK_ACTION_EVENT]);
	static subscriptions = Object.freeze([TASK_ACTION_SUBSCRIPTION]);
	constructor(runtime, backend) {
		this.runtime = runtime;
		this.backend = backend;
	}
	asInternalRuntime(manifest) {
		return new InternalProfileFacetRuntime({
			manifest,
			runtime: this.runtime,
			operations: [
				this.runtime.operation(TASK_OPERATION_CONTRACTS.create, (input) => this.backend.create(input.task)),
				this.runtime.operation(TASK_OPERATION_CONTRACTS.update, (input) => this.backend.update(input.id, input.update)),
				this.runtime.operation(TASK_OPERATION_CONTRACTS.list, () => this.backend.list())
			],
			surfaces: [this.runtime.surface(TASK_BOARD_SURFACE)]
		});
	}
	create(input) {
		return this.runtime.invoke(TASK_OPERATION_CONTRACTS.create, input, (admitted) => this.backend.create(admitted.task));
	}
	update(input) {
		return this.runtime.invoke(TASK_OPERATION_CONTRACTS.update, input, (admitted) => this.backend.update(admitted.id, admitted.update));
	}
	list(input = {}) {
		return this.runtime.invoke(TASK_OPERATION_CONTRACTS.list, input, () => this.backend.list());
	}
	submitAction(input) {
		return this.runtime.control(TASK_ACTION_CONTROL, input, async (admitted) => {
			const source = await this.runtime.invokeWithReceipt(TASK_ACTION_SOURCE_OPERATION, admitted, (sourceInput) => this.backend.assertExists(sourceInput.taskId));
			await this.runtime.emit(TASK_ACTION_EVENT_CONTRACT, Object.freeze({
				kind: "task.actionSubmitted",
				taskId: admitted.taskId,
				action: canonicalFacetData(admitted.action)
			}), source.receipt);
		});
	}
});
function encodeTaskUpdate(update) {
	return dataRecord({
		parentId: update.parentId === null ? null : update.parentId?.value,
		runId: update.runId === null ? null : update.runId?.value,
		attributes: update.attributes
	});
}
function decodeTaskUpdate(data) {
	const object = requireDataObject(data, "Task update");
	const parentId = object["parentId"];
	const runId = object["runId"];
	const attributes = object["attributes"];
	let update = {};
	if (parentId !== void 0) update = {
		...update,
		parentId: parentId === null ? null : new TaskId(requireString(parentId, "Task parent ID"))
	};
	if (runId !== void 0) update = {
		...update,
		runId: runId === null ? null : new RunId(requireString(runId, "Task Run ID"))
	};
	if (attributes !== void 0) update = {
		...update,
		attributes
	};
	return update;
}
function decodeTaskEntry(data) {
	const object = requireDataObject(data, "Task entry");
	const parentId = object["parentId"];
	const runId = object["runId"];
	return new TaskEntry(new TaskId(requireString(object["id"], "Task ID")), parentId === null ? void 0 : new TaskId(requireString(parentId, "Task parent ID")), runId === null ? void 0 : new RunId(requireString(runId, "Task Run ID")), object["attributes"]);
}
Object.freeze(["provider", "bundled"]);
//#endregion
//#region src/facets/web/facet.ts
var headersSchema = {
	type: "object",
	additionalProperties: { type: "string" }
};
var bodySchema = {
	type: "array",
	items: {
		type: "integer",
		minimum: 0,
		maximum: 255
	}
};
var responseSchema = schema({
	type: "object",
	properties: {
		url: {
			type: "string",
			format: "uri"
		},
		status: { type: "integer" },
		headers: headersSchema,
		body: bodySchema
	},
	required: [
		"url",
		"status",
		"headers",
		"body"
	],
	additionalProperties: false
});
var WEB_OPERATION_CONTRACTS = Object.freeze({
	fetch: new ProfileOperationContract("fetch", new OperationDescriptor(new OperationName("fetch"), "externalSend", strictObjectSchema({
		url: {
			type: "string",
			format: "uri"
		},
		method: {
			type: "string",
			minLength: 1
		},
		headers: headersSchema,
		body: bodySchema
	}, ["url"]), responseSchema), profileWireCodec((request) => dataRecord({
		url: request.url,
		method: request.method,
		headers: request.headers === void 0 ? void 0 : { ...request.headers },
		body: request.body === void 0 ? void 0 : [...request.body]
	}), decodeWebRequest), profileWireCodec(encodeWebResponse, decodeWebResponse), "output"),
	search: new ProfileOperationContract("search", new OperationDescriptor(new OperationName("search"), "externalSend", strictObjectSchema({
		query: {
			type: "string",
			minLength: 1
		},
		limit: {
			type: "integer",
			minimum: 1
		}
	}, ["query"]), responseSchema), profileWireCodec((input) => dataRecord({
		query: input.query,
		limit: input.limit
	}), (data) => {
		const object = requireDataObject(data, "Web search input");
		const limit = object["limit"];
		const input = { query: requireString(object["query"], "Web search query") };
		return limit === void 0 ? input : {
			...input,
			limit: requireSafeInteger(limit, "Web search limit")
		};
	}), profileWireCodec(encodeWebResponse, decodeWebResponse), "output"),
	readCached: new ProfileOperationContract("readCached", new OperationDescriptor(new OperationName("readCached"), "observe", strictObjectSchema({ key: {
		type: "string",
		minLength: 1
	} }, ["key"]), schema({ anyOf: [responseSchema.document, { type: "null" }] })), profileWireCodec((input) => ({ key: input.key }), (data) => ({ key: requireString(requireDataObject(data, "Web cache input")["key"], "Web cache key") })), profileWireCodec((response) => response === void 0 ? null : encodeWebResponse(response), (data) => data === null ? void 0 : decodeWebResponse(data)), "output")
});
var WEB_OPERATIONS = Object.freeze(Object.values(WEB_OPERATION_CONTRACTS).map((contract) => contract.descriptor));
new Contributions([new Contribution(new SlotName("operations"), WEB_OPERATIONS.map((operation) => operation.toData()))]);
function decodeWebRequest(data) {
	const object = requireDataObject(data, "Web request");
	const method = object["method"];
	const headers = object["headers"];
	const body = object["body"];
	let request = { url: requireString(object["url"], "Web request URL") };
	if (method !== void 0) request = {
		...request,
		method: requireString(method, "Web method")
	};
	if (headers !== void 0) request = {
		...request,
		headers: decodeHeaders(headers)
	};
	if (body !== void 0) request = {
		...request,
		body: decodeBytes(body)
	};
	return request;
}
function encodeWebResponse(response) {
	return {
		url: response.url,
		status: response.status,
		headers: { ...response.headers },
		body: [...response.body]
	};
}
function decodeWebResponse(data) {
	const object = requireDataObject(data, "Web response");
	return Object.freeze({
		url: requireString(object["url"], "Web response URL"),
		status: requireSafeInteger(object["status"], "Web response status"),
		headers: decodeHeaders(object["headers"]),
		body: decodeBytes(object["body"])
	});
}
function decodeHeaders(data) {
	const object = requireDataObject(data, "Web headers");
	return Object.freeze(Object.fromEntries(Object.entries(object).map(([name, value]) => [name, requireString(value, `Web header ${name}`)])));
}
function decodeBytes(data) {
	return requireBytes(data, "Web body must be bytes");
}
Object.freeze(["provider"]);
//#endregion
export { ApprovalId as a, ItemClaimId as c, schema as d, strictObjectSchema as f, TurnId as i, ReceiptId as l, RunCommitId as n, ClaimWorkerId as o, RunId as r, EffectAttemptId as s, TaskId as t, WriteRecordId as u };

//# sourceMappingURL=facets-D01bKQBL.js.map