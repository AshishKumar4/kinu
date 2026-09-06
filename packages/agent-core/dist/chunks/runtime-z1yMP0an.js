import { C as canonicalJsonEqual, D as encodeCanonicalJson, E as decodeCanonicalJson, I as isJsonValue, M as hasExactJsonKeys, P as isJsonObject, T as compareCanonicalText, _ as ContentRef, a as CompatRange, f as RecordCodec, h as SecretRef, i as SemVer, j as TextId, l as requireNonempty, o as isMember, s as isNonempty, t as JsonSchema, w as canonicalTupleKey, y as Digest } from "./core-BjYGo1CC.js";
//#region src/facets/data.ts
function isFacetData(value) {
	return isJsonValue(value);
}
function isFacetDataMap(value) {
	return isJsonValue(value) && isJsonObject(value);
}
function canonicalFacetData(value) {
	return freezeFacetData(decodeCanonicalJson(encodeCanonicalJson(value)));
}
function canonicalFacetDataMap(value) {
	return requireDataObject(canonicalFacetData(value), "Canonical data map");
}
var DataRecordCodec = class extends RecordCodec {
	#encodeRecord;
	#decodeRecord;
	constructor(recordClasses, kind, encodeRecord, decodeRecord, version = {
		major: 1,
		minor: 0
	}) {
		super(recordClasses, kind, version);
		this.#encodeRecord = encodeRecord.bind(void 0);
		this.#decodeRecord = decodeRecord.bind(void 0);
		Object.freeze(this);
	}
	encodePayload(record) {
		return this.#encodeRecord(record);
	}
	decodePayload(payload, version) {
		return this.#decodeRecord(payload, version);
	}
};
function requireDataObject(value, subject) {
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
	return value;
}
/**
* A declaration's schema field, which JSON Schema states either as a document or as the
* boolean that admits or rejects everything.
*/
function requireSchemaDocument(value, subject) {
	if (value === true || value === false) return value;
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object or boolean`);
	return value;
}
/**
* Builds a data record from named fields, dropping every field whose value is absent. An
* optional field has to be missing rather than null: `requireExactFields` admits only the
* fields a declaration names, and canonical JSON distinguishes an omitted key from an
* explicit null, so encoding an absent field as null would change the record's identity.
*/
function dataRecord(fields) {
	return Object.fromEntries(Object.entries(fields).filter((entry) => entry[1] !== void 0));
}
function requireExactFields(value, required, optional = []) {
	const admitted = /* @__PURE__ */ new Set([...required, ...optional]);
	if (required.some((field) => !(field in value)) || Object.keys(value).some((field) => !admitted.has(field))) throw new TypeError("Declaration contains missing or unknown fields");
}
function isString(value) {
	return typeof value === "string";
}
function requireString$1(value, subject) {
	if (!isString(value)) throw new TypeError(`${subject} must be a string`);
	return value;
}
function requireOptionalString(value, subject) {
	return value === void 0 ? void 0 : requireString$1(value, subject);
}
function requireBoolean$1(value, subject) {
	if (value !== true && value !== false) throw new TypeError(`${subject} must be a boolean`);
	return value;
}
/**
* SPEC §4.1 (C13-FACET-CAPABILITY-ABSENCE): a declared field that carries a capability
* rather than a datum is present exactly when the capability is offered, absent otherwise,
* and a present negative form is refused rather than read as absence. The returned
* `true | undefined` is what keeps the two encodings from collapsing: a reader asking this
* field whether the capability is offered cannot get the same answer for a host that never
* declared it and for one that declared a refusal, and there is no second value a later
* edit could flip. Every reader and every writer of such a field goes through this one
* function, so no path exists on which the negative form survives.
*/
function requireOfferedCapability(value, subject) {
	if (value === void 0) return;
	if (value !== true) throw new TypeError(`${subject} must be absent rather than a negative or null value`);
	return value;
}
/**
* The declared names an Operation's `input` schema may not offer (SPEC §4.1,
* C13-FACET-CANCELLATION-REACH). Cancellation reaches a handler through its
* `OperationContext` and never through the declared input, so a schema offering a field
* that claims to carry it is refused where the declaration is read rather than where an
* invocation would fail: the input schema is the surface a model authors against, and a
* cancellation nameable there is omittable and shadowable by an ordinary field.
*
* The screen is exact rather than by substring, because the defect is the claim and not the
* spelling: `cancelReason` states a datum a caller authors, while `cancellation` states the
* thing only the host owns. Names are compared with separators and case removed, so
* `abort_signal` and `abortSignal` are one name.
*/
var CANCELLATION_FIELD_NAMES = {
	abort: true,
	abortcontroller: true,
	abortsignal: true,
	cancel: true,
	cancellation: true,
	cancellationsignal: true,
	cancellationtoken: true,
	cancelsignal: true,
	canceltoken: true,
	signal: true
};
/** The keywords whose value is itself one schema, so a nested claim is reached too. */
var SCHEMA_VALUED_KEYWORDS = [
	"additionalProperties",
	"contains",
	"else",
	"if",
	"items",
	"not",
	"propertyNames",
	"then",
	"unevaluatedItems",
	"unevaluatedProperties"
];
/** The keywords whose value maps or lists schemas, each of which is screened in turn. */
var SCHEMA_COLLECTION_KEYWORDS = [
	"$defs",
	"allOf",
	"anyOf",
	"definitions",
	"dependentSchemas",
	"oneOf",
	"patternProperties",
	"prefixItems",
	"properties"
];
/**
* SPEC §4.1 (C13-FACET-CANCELLATION-REACH): refuses a declared schema that offers a
* cancellation-carrying field, at any depth. A nested object is the same authored surface
* one level down, so screening only the top level would leave the claim expressible. A
* schema requires a name it never declares is screened as well, because a name required
* where additional properties are admitted is still offered.
*/
function requireCancellationFreeSchema(document, subject) {
	if (document === true || document === false) return document;
	const properties = document["properties"];
	const required = document["required"];
	const declared = [...isJsonObject(properties) ? Object.keys(properties) : [], ...isArray(required) ? required.filter(isString) : []];
	for (const name of declared) {
		const canonical = name.replaceAll(/[\s_-]+/gu, "").toLowerCase();
		if (Object.hasOwn(CANCELLATION_FIELD_NAMES, canonical)) throw new TypeError(`${subject} must not declare ${name}: cancellation reaches a handler through its OperationContext and never through a declared input`);
	}
	for (const keyword of SCHEMA_VALUED_KEYWORDS) {
		const nested = document[keyword];
		if (isSchemaDocument(nested)) requireCancellationFreeSchema(nested, subject);
	}
	for (const keyword of SCHEMA_COLLECTION_KEYWORDS) {
		const nested = document[keyword];
		const entries = isArray(nested) ? nested : isJsonObject(nested) ? Object.values(nested) : void 0;
		for (const entry of entries ?? []) if (isSchemaDocument(entry)) requireCancellationFreeSchema(entry, subject);
	}
	return document;
}
function isSchemaDocument(value) {
	return value === true || value === false || isJsonObject(value);
}
function requireSafeInteger(value, subject) {
	if (!isSafeInteger(value)) throw new TypeError(`${subject} must be a safe integer`);
	return value;
}
function requireArray(value, subject) {
	if (!isArray(value)) throw new TypeError(`${subject} must be an array`);
	return value;
}
/**
* Reads the array of numbers that carries binary content through canonical JSON. The
* caller supplies the whole message because the profile owning the field names it, not
* this parser.
*/
function requireBytes(value, message) {
	if (!isArray(value)) throw new TypeError(message);
	const bytes = new Uint8Array(value.length);
	for (const [index, entry] of value.entries()) {
		if (!isNumber(entry)) throw new TypeError(message);
		bytes[index] = entry;
	}
	return bytes;
}
/**
* Restates a chosen set of vocabulary values in the vocabulary's own canonical order, so
* that two declarations naming the same values encode identically. Unknown, repeated, and
* empty selections are rejected here rather than reaching a comparison downstream.
*/
function canonicalOrder(values, order, subject) {
	if (values.length === 0 || values.some((value) => !order.includes(value))) throw new TypeError(`${subject} must contain known values`);
	if (new Set(values).size !== values.length) throw new TypeError(`${subject} must be unique`);
	return requireNonempty(Object.freeze(order.filter((value) => values.includes(value))), subject);
}
function requireNonblank(value, subject) {
	if (value.length === 0 || value !== value.trim()) throw new TypeError(`${subject} must be a nonblank canonical string`);
}
/** Freezes a data value and everything beneath it in place, keeping the caller's type. */
function freezeFacetData(value) {
	if (isArray(value) || isJsonObject(value)) {
		for (const entry of Object.values(value)) freezeFacetData(entry);
		Object.freeze(value);
	}
	return value;
}
function isSafeInteger(value) {
	return typeof value === "number" && Number.isSafeInteger(value);
}
function isNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}
function isArray(value) {
	return Array.isArray(value);
}
//#endregion
//#region src/facets/id.ts
var FacetPackageId = class extends TextId {
	constructor(value) {
		super(value, "Facet package ID");
		requireCanonicalId(value, "Facet package ID");
		Object.freeze(this);
	}
};
var FacetRef = class extends TextId {
	packageId;
	constructor(value) {
		super(value, "Facet reference");
		requireFacetRef(value);
		this.packageId = new FacetPackageId(value.slice(0, value.indexOf(":")));
		Object.freeze(this);
	}
};
var BindingName = class extends TextId {
	constructor(value) {
		super(value, "Binding name");
		requireCanonicalId(value, "Binding name");
		requireBindingName(value);
		Object.freeze(this);
	}
};
var AuthoredCodeBackingId = class extends TextId {
	constructor(value) {
		super(value, "Agent-authored code backing ID");
		requireCanonicalId(value, "Agent-authored code backing ID");
		Object.freeze(this);
	}
};
var OperationName = class extends TextId {
	constructor(value) {
		super(value, "Operation name");
		requireCanonicalId(value, "Operation name");
		Object.freeze(this);
	}
};
var OperationRef = class extends TextId {
	facet;
	operation;
	constructor(value) {
		super(value, "Operation reference");
		requireCanonicalId(value, "Operation reference");
		const separator = value.indexOf(":");
		if (separator <= 0 || separator !== value.lastIndexOf(":") || separator === value.length - 1) throw new TypeError("Operation reference must be '<facet-package-id>:<operation-name>'");
		this.facet = new FacetPackageId(value.slice(0, separator));
		this.operation = new OperationName(value.slice(separator + 1));
		Object.freeze(this);
	}
};
var EventKind = class extends TextId {
	constructor(value) {
		super(value, "Event kind");
		requireCanonicalId(value, "Event kind");
		Object.freeze(this);
	}
};
var SurfaceId = class extends TextId {
	constructor(value) {
		super(value, "Surface ID");
		requireCanonicalId(value, "Surface ID");
		Object.freeze(this);
	}
};
var SlotName = class extends TextId {
	constructor(value) {
		super(value, "Slot name");
		requireCanonicalId(value, "Slot name");
		Object.freeze(this);
	}
};
var InterceptorId = class extends TextId {
	constructor(value) {
		super(value, "Interceptor ID");
		requireCanonicalId(value, "Interceptor ID");
		Object.freeze(this);
	}
};
var SlotEntryId = class extends TextId {
	constructor(value) {
		super(value, "Slot entry ID");
		requireCanonicalId(value, "Slot entry ID");
		Object.freeze(this);
	}
};
var PromptSectionId = class extends TextId {
	constructor(value) {
		super(value, "Prompt section ID");
		requireCanonicalId(value, "Prompt section ID");
		Object.freeze(this);
	}
};
var SettingsLayerId = class extends TextId {
	constructor(value) {
		super(value, "Settings layer ID");
		requireCanonicalId(value, "Settings layer ID");
		Object.freeze(this);
	}
};
var CatalogEntryId = class extends TextId {
	constructor(value) {
		super(value, "Catalog entry ID");
		requireCanonicalId(value, "Catalog entry ID");
		Object.freeze(this);
	}
};
function requireCanonicalId(value, subject) {
	if (value.length === 0 || value !== value.trim()) throw new TypeError(`${subject} must be a nonblank canonical string`);
}
var CANONICAL_SEGMENT = "[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*";
var BINDING_NAME = new RegExp(`^${CANONICAL_SEGMENT}$`, "u");
var FACET_REF = new RegExp(`^${CANONICAL_SEGMENT}:${CANONICAL_SEGMENT}$`, "u");
function requireBindingName(value) {
	if (!BINDING_NAME.test(value)) throw new TypeError("Binding name must be one canonical segment");
}
function requireFacetRef(value) {
	requireCanonicalId(value, "Facet reference");
	if (!FACET_REF.test(value)) throw new TypeError("Facet reference must be '<facet-package-id>:<instance>' with canonical segments");
}
//#endregion
//#region src/facets/authored-code.ts
var AUTHORED_CODE_CONSUMERS = Object.freeze([
	"programmaticToolCall",
	"slateBackend",
	"agentAuthoredFacet"
]);
function requireAuthoredCodeConsumer(value, subject) {
	if (!isMember(AUTHORED_CODE_CONSUMERS, value)) throw new TypeError(`${subject} must name a §4.7 agent-authored code consumer`);
	return value;
}
/**
* Which caller an Operation is declared for (SPEC §4.7): `native` offers it to the model
* as a tool call, `code` to agent-authored code, `both` to either. Availability belongs to
* the composition rather than to a submission, so the catalog §5.6 reconstructs and the
* passed Binding set an isolate enforces read this one declaration instead of two a host
* keeps in agreement.
*
* The three cases are singletons and equality is identity, so nothing can mint a fourth
* availability or hold two unequal copies of one meaning.
*/
var OperationAvailability = class {
	static get native() {
		return nativeAvailability;
	}
	static get code() {
		return codeAvailability;
	}
	static get both() {
		return bothAvailability;
	}
	/**
	* An absent declaration reads as `native` (SPEC §4.7), so an author who never
	* considered code mode offers it nothing.
	*/
	static fromData(value) {
		if (value === void 0) return nativeAvailability;
		const declared = OPERATION_AVAILABILITIES.find((candidate) => candidate.label === value);
		if (declared === void 0) throw new TypeError("Operation availability must be native, code, or both");
		return declared;
	}
	/**
	* SPEC §4.1's presence rule: `native` is already what an absent declaration means, so
	* its canonical wire form is the absent key. Writing the label too would give one
	* meaning two `manifestDigest` values (§5.2) for the same Operation.
	*/
	toData() {
		return this.equals(nativeAvailability) ? void 0 : this.label;
	}
	equals(other) {
		return this === other;
	}
};
var NativeAvailability = class extends OperationAvailability {
	label = "native";
	get reachableByAuthoredCode() {
		return false;
	}
	get offeredToModel() {
		return true;
	}
};
var CodeAvailability = class extends OperationAvailability {
	label = "code";
	get reachableByAuthoredCode() {
		return true;
	}
	get offeredToModel() {
		return false;
	}
};
var BothAvailability = class extends OperationAvailability {
	label = "both";
	get reachableByAuthoredCode() {
		return true;
	}
	get offeredToModel() {
		return true;
	}
};
var nativeAvailability = Object.freeze(new NativeAvailability());
var codeAvailability = Object.freeze(new CodeAvailability());
var bothAvailability = Object.freeze(new BothAvailability());
var OPERATION_AVAILABILITIES = Object.freeze([
	nativeAvailability,
	codeAvailability,
	bothAvailability
]);
/**
* Agent-authored code as the submission carries it: content-addressed modules and the
* one they enter through. Nothing here says where the code will run — that is the
* backing's business (§10.2) — and nothing here carries authority, because a §4.7
* isolate holds only what is separately passed to it as Bindings.
*/
var AuthoredCodeSource = class AuthoredCodeSource {
	entry;
	modules;
	constructor(entry, modules) {
		this.entry = entry;
		this.modules = canonicalModules(modules);
		if (!this.modules.has(entry)) throw new TypeError("Agent-authored code entry must name one of its own modules");
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Agent-authored code source");
		requireExactFields(object, ["entry", "modules"]);
		const modules = requireDataObject(object["modules"], "Agent-authored code modules");
		return new AuthoredCodeSource(requireString$1(object["entry"], "Agent-authored code entry"), new Map(Object.entries(modules).map(([name, ref]) => [name, new ContentRef(requireString$1(ref, `Agent-authored code module ${name}`))])));
	}
	toData() {
		return {
			entry: this.entry,
			modules: Object.fromEntries([...this.modules].map(([name, ref]) => [name, ref.value]))
		};
	}
};
function canonicalModules(modules) {
	if (modules.size === 0) throw new TypeError("Agent-authored code must carry at least one module");
	const canonical = /* @__PURE__ */ new Map();
	for (const [name, ref] of [...modules].sort(([left], [right]) => compareCanonicalText(left, right))) {
		if (name.length === 0 || name !== name.trim()) throw new TypeError("Agent-authored code module names must be nonblank and canonical");
		if (!(ref instanceof ContentRef)) throw new TypeError("Agent-authored code modules must be content-addressed");
		canonical.set(name, ref);
	}
	return canonical;
}
//#endregion
//#region src/facets/glob.ts
var highSurrogateStart = 55296;
var highSurrogateEnd = 56319;
var lowSurrogateStart = 56320;
var lowSurrogateEnd = 57343;
/**
* Matches a whole string by scanning forward. Compiling stored `*` patterns to repeated
* `.*` groups permits exponential regex backtracking on a failed match.
*/
function matchesGlob(pattern, value) {
	const segments = pattern.split("*");
	const first = segments[0];
	const last = segments.at(-1);
	if (first === void 0 || last === void 0) return false;
	if (segments.length === 1) return value === pattern;
	if (first.length + last.length > value.length || !value.startsWith(first) || !value.endsWith(last) || !isCodePointBoundary(value, first.length)) return false;
	const end = value.length - last.length;
	if (!isCodePointBoundary(value, end)) return false;
	let cursor = first.length;
	for (const segment of segments.slice(1, -1)) {
		cursor = findSegmentEnd(value, segment, cursor, end);
		if (cursor < 0) return false;
	}
	return true;
}
function findSegmentEnd(value, segment, cursor, end) {
	for (let found = value.indexOf(segment, cursor); found >= 0;) {
		const after = found + segment.length;
		if (after > end) return -1;
		if (isCodePointBoundary(value, found) && isCodePointBoundary(value, after)) return after;
		found = value.indexOf(segment, found + 1);
	}
	return -1;
}
function isCodePointBoundary(value, index) {
	if (index <= 0 || index >= value.length) return true;
	const before = value.charCodeAt(index - 1);
	const after = value.charCodeAt(index);
	return before < highSurrogateStart || before > highSurrogateEnd || after < lowSurrogateStart || after > lowSurrogateEnd;
}
//#endregion
//#region src/facets/capability.ts
var impacts = [
	"observe",
	"mutate",
	"externalSend",
	"execute",
	"delegate",
	"administer"
];
function isCapabilityEffect(value) {
	return value === "allow" || value === "deny";
}
var CapabilitySpecCodecV1 = class extends RecordCodec {
	constructor() {
		super([CapabilitySpec], "authority.capability-spec", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(spec) {
		return spec.toData();
	}
	decodePayload(payload, _version) {
		return CapabilitySpec.fromData(payload);
	}
};
var CapabilitySpec = class CapabilitySpec {
	static get codec() {
		return capabilitySpecCodecInstance;
	}
	facetPattern;
	operations;
	impacts;
	argumentConstraints;
	constructor(init) {
		validatePattern(init.facetPattern);
		this.facetPattern = init.facetPattern;
		this.operations = canonicalStrings(init.operations ?? [], "Capability operations");
		this.impacts = canonicalImpacts(init.impacts);
		this.argumentConstraints = canonicalConstraints(init.argumentConstraints ?? {});
		Object.freeze(this);
	}
	static encode(spec) {
		return CapabilitySpec.codec.encode(spec);
	}
	static decode(bytes) {
		return CapabilitySpec.codec.decode(bytes);
	}
	matches(intent) {
		return matchesGlob(this.facetPattern, intent.facet) && (this.operations.length === 0 || this.operations.includes(intent.operation)) && this.impacts.includes(intent.impact) && Object.entries(this.argumentConstraints).every(([path, expected]) => {
			const actual = valueAtPath(intent.arguments, path);
			return actual !== void 0 && canonicalJsonEqual(actual, expected);
		});
	}
	/**
	* SPEC §3.4 rule 2: the candidate admits no Invocation this capability would refuse.
	*
	* A pattern covers another exactly when it matches the other pattern's own text —
	* `'*'` is the only metacharacter and a validated pattern never contains one as a
	* literal, so a parent literal can never absorb a child wildcard. That equivalence
	* with glob language containment is proved in both directions by the formal model
	* (`AgentCore.glob_covering_iff_containment`).
	*/
	covers(candidate) {
		return matchesGlob(this.facetPattern, candidate.facetPattern) && (this.operations.length === 0 || candidate.operations.length > 0 && candidate.operations.every((operation) => this.operations.includes(operation))) && candidate.impacts.every((impact) => this.impacts.includes(impact)) && Object.entries(this.argumentConstraints).every(([path, expected]) => {
			const actual = candidate.argumentConstraints[path];
			return actual !== void 0 && canonicalJsonEqual(actual, expected);
		});
	}
	grantsElevation() {
		return this.impacts.includes("delegate") || this.impacts.includes("administer");
	}
	/**
	* SPEC §4.1: true exactly when every Facet this capability reaches is the one named, so
	* a withdrawal can retire it as one of the withdrawing Facet's own solely-naming Grants.
	* `'*'` is the only metacharacter and a validated pattern never carries one literally, so
	* a pattern reaches only the named Facet exactly when it is that Facet's own text; any
	* wildcard would also reach whatever else the Scope installs.
	*/
	namesOnly(facet) {
		return this.facetPattern === facet;
	}
	equals(other) {
		return other instanceof CapabilitySpec && canonicalJsonEqual(this.toData(), other.toData());
	}
	toData() {
		return {
			argumentConstraints: this.argumentConstraints,
			facetPattern: this.facetPattern,
			impacts: this.impacts,
			operations: this.operations
		};
	}
	static fromData(value) {
		const object = requireDataObject(value ?? null, "Capability spec");
		if (!hasExactJsonKeys(object, [
			"argumentConstraints",
			"facetPattern",
			"impacts",
			"operations"
		])) throw new TypeError("Capability spec contains missing or unknown fields");
		const operationValues = requireArray(object["operations"], "Capability operations");
		const impacts = requireNonempty(requireArray(object["impacts"], "Capability impacts").map(requireImpact$2), "Capability impacts");
		return new CapabilitySpec({
			facetPattern: requireString$1(object["facetPattern"], "Facet pattern"),
			operations: operationValues.map((entry, index) => requireString$1(entry, `Operation ${index}`)),
			impacts,
			argumentConstraints: requireDataObject(object["argumentConstraints"] ?? null, "Argument constraints")
		});
	}
};
var capabilitySpecCodecInstance = new CapabilitySpecCodecV1();
function canonicalStrings(values, name) {
	for (const value of values) if (value.length === 0 || value !== value.trim()) throw new TypeError(`${name} must contain canonical nonblank strings`);
	return Object.freeze([...new Set(values)].sort());
}
function canonicalImpacts(values) {
	return canonicalOrder(values, impacts, "Capability impacts");
}
function canonicalConstraints(constraints) {
	for (const path of Object.keys(constraints)) if (!isConstraintPath(path)) throw new TypeError(`Invalid argument constraint path ${path}`);
	return canonicalFacetDataMap(constraints);
}
function validatePattern(pattern) {
	if (pattern.length === 0 || pattern !== pattern.trim() || /[^a-zA-Z0-9._:/@*-]/u.test(pattern)) throw new TypeError("Facet pattern must be a canonical glob containing only '*' wildcards");
}
function valueAtPath(value, path) {
	let current = value;
	for (const segment of path.split(".")) {
		if (!isJsonObject(current)) return void 0;
		current = current[segment];
	}
	return current;
}
function isConstraintPath(path) {
	return path.length > 0 && path.split(".").every((segment) => /^[a-zA-Z0-9_-]+$/u.test(segment));
}
function requireImpact$2(value) {
	if (isMember(impacts, value)) return value;
	throw new TypeError("Capability impact is invalid");
}
//#endregion
//#region src/facets/generated/enforcement/AgentCore/Facets/Enforcement.ts
/**
* Whether this impact may ever be served directly (SPEC §7.2): `observe` always may;
* `execute` only inside a Turn-owned Session; `mutate` only against that Session's own
* filesystem; `externalSend`, `delegate`, and `administer` never may.
*/
function admitsDirect(impact, turnOwnedSession, sessionFilesystemTarget) {
	if (impact === "observe") return true;
	if (impact === "mutate") return turnOwnedSession && sessionFilesystemTarget;
	if (impact === "externalSend") return false;
	if (impact === "execute") return turnOwnedSession;
	if (impact === "delegate") return false;
	return false;
}
/**
* SPEC §7.2's enforcement floor: the weakest tier this impact admits under the given
* session conditions. Policy only tightens this floor; it never lowers it.
*/
function enforcementFloor(impact, turnOwnedSession, sessionFilesystemTarget) {
	if (admitsDirect(impact, turnOwnedSession, sessionFilesystemTarget)) return "direct";
	return "mediated";
}
function requireImpact$1(value, name) {
	if (value === "observe" || value === "mutate" || value === "externalSend" || value === "execute" || value === "delegate" || value === "administer") return value;
	throw new TypeError(`${name} must name a Impact`);
}
Object.freeze({ fromData(value) {
	return requireImpact$1(value, "Impact");
} });
//#endregion
//#region src/facets/contribution.ts
var OperationDescriptor = class OperationDescriptor {
	name;
	impact;
	input;
	output;
	help;
	/**
	* SPEC §4.1 (C13-FACET-CAPABILITY-ABSENCE): §4.4's target consent is a capability the
	* manifest offers by declaring it, so `true` and absence are the only two forms. A
	* mandatory boolean would answer "did the author consider interception" with the same
	* value it answers "did the author refuse it", give one meaning two `manifestDigest`
	* values under §5.2, and leave a field a later edit could flip.
	*/
	interceptable;
	/**
	* SPEC §4.7 (C13-FACET-CODE-AVAILABILITY): which caller this Operation is declared
	* for. Always present in memory and absent on the wire for `native`, so the offered
	* catalog and the set an isolate can reach are one declared fact.
	*/
	availability;
	constructor(name, impact, input, output, help, interceptable, availability) {
		this.name = name;
		this.impact = impact;
		this.input = input;
		this.output = output;
		if (help !== void 0) requireNonblank(help, "Operation help");
		this.help = help;
		this.interceptable = requireOfferedCapability(interceptable, "Operation interceptable declaration");
		this.availability = availability ?? OperationAvailability.native;
		requireCancellationFreeSchema(input.document, `Operation ${name.value} input schema`);
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Operation descriptor");
		requireExactFields(object, [
			"impact",
			"input",
			"name",
			"output"
		], [
			"availability",
			"help",
			"interceptable"
		]);
		return new OperationDescriptor(new OperationName(requireString$1(object["name"], "Operation name")), requireImpact(object["impact"]), new JsonSchema(requireSchemaDocument(object["input"], "Operation input schema")), new JsonSchema(requireSchemaDocument(object["output"], "Operation output schema")), requireOptionalString(object["help"], "Operation help"), requireOfferedCapability(object["interceptable"], "Operation interceptable declaration"), OperationAvailability.fromData(object["availability"]));
	}
	static encode(descriptor) {
		return operationDescriptorCodec.encode(descriptor);
	}
	static decode(bytes) {
		return operationDescriptorCodec.decode(bytes);
	}
	toData() {
		return dataRecord({
			availability: this.availability.toData(),
			impact: this.impact,
			input: this.input.document,
			interceptable: this.interceptable,
			name: this.name.value,
			output: this.output.document,
			help: this.help
		});
	}
};
var operationDescriptorCodec = new DataRecordCodec([
	OperationDescriptor,
	TextId,
	JsonSchema,
	OperationName,
	OperationAvailability
], "facet.operation-descriptor", (descriptor) => descriptor.toData(), (payload) => OperationDescriptor.fromData(payload));
var SurfaceDescriptor = class SurfaceDescriptor {
	id;
	title;
	help;
	constructor(id, title, help) {
		this.id = id;
		this.title = title;
		requireNonblank(title, "Surface title");
		if (help !== void 0) requireNonblank(help, "Surface help");
		this.help = help;
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Surface descriptor");
		requireExactFields(object, ["id", "title"], ["help"]);
		return new SurfaceDescriptor(new SurfaceId(requireString$1(object["id"], "Surface ID")), requireString$1(object["title"], "Surface title"), requireOptionalString(object["help"], "Surface help"));
	}
	static encode(descriptor) {
		return surfaceDescriptorCodec.encode(descriptor);
	}
	static decode(bytes) {
		return surfaceDescriptorCodec.decode(bytes);
	}
	toData() {
		return dataRecord({
			id: this.id.value,
			title: this.title,
			help: this.help
		});
	}
};
var surfaceDescriptorCodec = new DataRecordCodec([
	SurfaceDescriptor,
	TextId,
	SurfaceId
], "facet.surface-descriptor", (descriptor) => descriptor.toData(), (payload) => SurfaceDescriptor.fromData(payload));
var Contribution = class Contribution {
	slot;
	entries;
	constructor(slot, entries) {
		this.slot = slot;
		if (entries.length === 0) throw new TypeError("Contribution must contain at least one entry");
		this.entries = Object.freeze(entries.map(canonicalFacetData));
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Contribution");
		requireExactFields(object, ["entries", "slot"]);
		return new Contribution(new SlotName(requireString$1(object["slot"], "Contribution slot")), requireArray(object["entries"], "Contribution entries"));
	}
	static encode(contribution) {
		return contributionCodec.encode(contribution);
	}
	static decode(bytes) {
		return contributionCodec.decode(bytes);
	}
	toData() {
		return {
			entries: this.entries,
			slot: this.slot.value
		};
	}
};
var contributionCodec = new DataRecordCodec([
	Contribution,
	TextId,
	SlotName
], "facet.contribution", (contribution) => contribution.toData(), (payload) => Contribution.fromData(payload));
var Contributions = class Contributions {
	entries;
	constructor(entries) {
		const ordered = [...entries].sort((left, right) => compareCanonicalText(left.slot.value, right.slot.value));
		if (new Set(ordered.map((entry) => entry.slot.value)).size !== ordered.length) throw new TypeError("Contribution slots must be unique");
		this.entries = Object.freeze(ordered);
		Object.freeze(this);
	}
	static empty() {
		return emptyContributions;
	}
	static encode(contributions) {
		return contributionsCodec.encode(contributions);
	}
	static decode(bytes) {
		return contributionsCodec.decode(bytes);
	}
	static fromMap(entries) {
		return new Contributions(Object.entries(entries).map(([slot, values]) => new Contribution(new SlotName(slot), values)));
	}
	get(slot) {
		return this.entries.find((entry) => entry.slot.equals(slot))?.entries;
	}
	toData() {
		return canonicalFacetData(Object.fromEntries(this.entries.map((entry) => [entry.slot.value, entry.entries])));
	}
};
var contributionsCodec = new DataRecordCodec([
	Contributions,
	SlotName,
	TextId,
	Contribution
], "facet.contributions", (contributions) => contributions.toData(), (payload) => Contributions.fromMap(requireContributionMap$1(payload)), {
	major: 2,
	minor: 0
});
function requireContributionMap$1(payload) {
	const object = requireDataObject(payload, "Contributions");
	return Object.fromEntries(Object.entries(object).map(([slot, values]) => [slot, requireArray(values, `Contribution ${slot}`)]));
}
function requireImpact(value) {
	if (value === "observe" || value === "mutate" || value === "externalSend" || value === "execute" || value === "delegate" || value === "administer") return value;
	throw new TypeError("Operation impact is invalid");
}
var emptyContributions = new Contributions([]);
//#endregion
//#region src/facets/generated/placement/AgentCore/Extract/Placement.ts
/**
* The modes admitted by all four independently derived sets (SPEC §9.2): what the Facet's
* manifest declares, what the Blueprint's policy allows, what the substrate profile offers,
* and what the trust policy admits for the Package. Carrying the intersection as its own
* value is what keeps "admissible" and "preferred" separate: the intersection is derived
* once, and the preference order is applied to it once.
*/
var PlacementIntersection = class PlacementIntersection {
	dynamic;
	provider;
	bundled;
	constructor(init) {
		this.dynamic = init.dynamic;
		this.provider = init.provider;
		this.bundled = init.bundled;
		Object.freeze(this);
	}
	static fromData(value) {
		const data = requireDataFields(value, "PlacementIntersection", [
			"dynamic",
			"provider",
			"bundled"
		]);
		return new PlacementIntersection({
			dynamic: requireBoolean(data["dynamic"], "PlacementIntersection dynamic"),
			provider: requireBoolean(data["provider"], "PlacementIntersection provider"),
			bundled: requireBoolean(data["bundled"], "PlacementIntersection bundled")
		});
	}
	/**
	* The mode served, as SPEC §9.2's one fixed preference order decides it: the first member of
	* the intersection in the order `dynamic`, `provider`, `bundled`. There is no second ordering
	* and no fallback for an empty intersection — that case has no answer, and the caller rejects.
	*/
	preferred() {
		if (this.dynamic) return {
			kind: "some",
			value: "dynamic"
		};
		if (this.provider) return {
			kind: "some",
			value: "provider"
		};
		if (this.bundled) return {
			kind: "some",
			value: "bundled"
		};
		return { kind: "none" };
	}
	toData() {
		return {
			dynamic: this.dynamic,
			provider: this.provider,
			bundled: this.bundled
		};
	}
	equals(other) {
		return this.dynamic === other.dynamic && this.provider === other.provider && this.bundled === other.bundled;
	}
};
/**
* Whether this mode is `dynamic`.
*/
function isDynamicMode(mode) {
	if (mode === "dynamic") return true;
	if (mode === "provider") return false;
	return false;
}
/**
* Whether this mode is `provider`.
*/
function isProviderMode(mode) {
	if (mode === "dynamic") return false;
	if (mode === "provider") return true;
	return false;
}
/**
* Whether this mode is `bundled`.
*/
function isBundledMode(mode) {
	if (mode === "dynamic") return false;
	if (mode === "provider") return false;
	return true;
}
/**
* Whether a source's admissible-mode set contains this mode. A source arrives as the list of
* modes it admits, which is how every caller already holds it, and membership is decided per
* mode so the answer never depends on the order a source happened to list its modes in.
*/
function admitsMode(modes, mode) {
	if (mode === "dynamic") return modes.some((argument0) => isDynamicMode(argument0));
	if (mode === "provider") return modes.some((argument0$2) => isProviderMode(argument0$2));
	return modes.some((argument0$3) => isBundledMode(argument0$3));
}
/**
* The intersection of the four independently derived admissible-mode sets (SPEC §9.2).
*/
function placementIntersection(manifest, policy, substrate, trust) {
	return new PlacementIntersection({
		dynamic: admitsMode(manifest, "dynamic") && admitsMode(policy, "dynamic") && admitsMode(substrate, "dynamic") && admitsMode(trust, "dynamic"),
		provider: admitsMode(manifest, "provider") && admitsMode(policy, "provider") && admitsMode(substrate, "provider") && admitsMode(trust, "provider"),
		bundled: admitsMode(manifest, "bundled") && admitsMode(policy, "bundled") && admitsMode(substrate, "bundled") && admitsMode(trust, "bundled")
	});
}
/**
* SPEC §9.2's placement decision end to end: intersect the four admissible-mode sets, then
* serve the first member of the intersection in the fixed preference order.
*/
function preferredPlacement(manifest, policy, substrate, trust) {
	return placementIntersection(manifest, policy, substrate, trust).preferred();
}
function requireIsolationMode$1(value, name) {
	if (value === "dynamic" || value === "provider" || value === "bundled") return value;
	throw new TypeError(`${name} must name a IsolationMode`);
}
Object.freeze({ fromData(value) {
	return requireIsolationMode$1(value, "IsolationMode");
} });
function isDataObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireDataFields(value, name, fields) {
	if (!isDataObject(value)) throw new TypeError(`${name} data must be an object`);
	if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) throw new TypeError(`${name} data fields must be exactly ${fields.join(", ")}`);
	return value;
}
function requireBoolean(value, name) {
	if (value === true || value === false) return value;
	throw new TypeError(`${name} must be a boolean`);
}
//#endregion
//#region src/facets/manifest.ts
var PLACEMENT_PREFERENCE = Object.freeze([
	"dynamic",
	"provider",
	"bundled"
]);
var BindingRequirement = class BindingRequirement {
	name;
	facet;
	compat;
	constructor(name, facet, compat) {
		this.name = name;
		this.facet = facet;
		this.compat = compat;
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Binding requirement");
		requireExactFields(object, [
			"compat",
			"facet",
			"name"
		]);
		const compat = requireDataObject(object["compat"], "Binding compatibility range");
		requireExactFields(compat, ["host", "spec"]);
		return new BindingRequirement(new BindingName(requireString$1(object["name"], "Binding name")), new FacetPackageId(requireString$1(object["facet"], "Binding facet")), new CompatRange(requireString$1(compat["spec"], "Binding spec compatibility"), requireString$1(compat["host"], "Binding host compatibility")));
	}
	static encode(requirement) {
		return bindingRequirementCodec.encode(requirement);
	}
	static decode(bytes) {
		return bindingRequirementCodec.decode(bytes);
	}
	toData() {
		return {
			compat: {
				host: this.compat.host,
				spec: this.compat.spec
			},
			facet: this.facet.value,
			name: this.name.value
		};
	}
};
var bindingRequirementCodec = new DataRecordCodec([
	BindingRequirement,
	TextId,
	CompatRange,
	BindingName,
	FacetPackageId
], "facet.binding-requirement", (requirement) => requirement.toData(), (payload) => BindingRequirement.fromData(payload));
var FacetManifest = class FacetManifest {
	id;
	version;
	compat;
	isolation;
	bindings;
	configSchema;
	contributions;
	constructor(init) {
		const bindings = [...init.bindings].sort((left, right) => compareCanonicalText(left.name.value, right.name.value));
		if (new Set(bindings.map((binding) => binding.name.value)).size !== bindings.length) throw new TypeError("Manifest binding names must be unique");
		this.id = init.id;
		this.version = init.version;
		this.compat = init.compat;
		this.isolation = canonicalIsolationModes(init.isolation);
		this.bindings = Object.freeze(bindings);
		this.configSchema = init.configSchema;
		this.contributions = init.contributions;
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Facet manifest");
		requireExactFields(object, [
			"bindings",
			"compat",
			"contributions",
			"id",
			"isolation",
			"version"
		], ["configSchema"]);
		const compat = requireDataObject(object["compat"], "Manifest compatibility range");
		requireExactFields(compat, ["host", "spec"]);
		const isolation = requireArray(object["isolation"], "Manifest isolation modes").map(requireIsolationMode);
		if (!isNonempty(isolation)) throw new TypeError("Manifest isolation modes must not be empty");
		const configSchema = object["configSchema"];
		const decodedConfigSchema = configSchema === void 0 ? void 0 : new JsonSchema(requireSchemaDocument(configSchema, "Manifest config schema"));
		return new FacetManifest({
			id: new FacetPackageId(requireString$1(object["id"], "Facet package ID")),
			version: new SemVer(requireString$1(object["version"], "Facet version")),
			compat: new CompatRange(requireString$1(compat["spec"], "Manifest spec compatibility"), requireString$1(compat["host"], "Manifest host compatibility")),
			isolation,
			bindings: requireArray(object["bindings"], "Manifest bindings").map(BindingRequirement.fromData),
			contributions: Contributions.fromMap(requireContributionMap(object["contributions"])),
			configSchema: decodedConfigSchema
		});
	}
	static encode(manifest) {
		return facetManifestCodec.encode(manifest);
	}
	static decode(bytes) {
		return facetManifestCodec.decode(bytes);
	}
	toData() {
		return dataRecord({
			bindings: this.bindings.map((binding) => binding.toData()),
			compat: {
				host: this.compat.host,
				spec: this.compat.spec
			},
			contributions: this.contributions.toData(),
			id: this.id.value,
			isolation: this.isolation,
			version: this.version.toString(),
			configSchema: this.configSchema?.document
		});
	}
};
function requireContributionMap(value) {
	const object = requireDataObject(value ?? null, "Manifest contributions");
	return Object.fromEntries(Object.entries(object).map(([slot, entries]) => [slot, requireArray(entries, `Manifest contribution ${slot}`)]));
}
var facetManifestCodec = new DataRecordCodec([
	FacetManifest,
	BindingRequirement,
	TextId,
	SemVer,
	CompatRange,
	JsonSchema,
	Contributions,
	FacetPackageId,
	BindingName,
	SlotName,
	Contribution
], "facet.manifest", (manifest) => manifest.toData(), (payload) => FacetManifest.fromData(payload), {
	major: 2,
	minor: 0
});
function canonicalIsolationModes(modes) {
	return canonicalOrder(modes, PLACEMENT_PREFERENCE, "Manifest isolation modes");
}
function requireIsolationMode(value) {
	if (isMember(PLACEMENT_PREFERENCE, value)) return value;
	throw new TypeError("Manifest isolation mode is invalid");
}
//#endregion
//#region src/definition-references/id.ts
var PackageId = class extends TextId {
	constructor(value) {
		super(value, "Package ID");
		if (value.length === 0 || value !== value.trim()) throw new TypeError("Package ID must be a nonblank canonical string");
		Object.freeze(this);
	}
};
//#endregion
//#region src/definition-references/pin.ts
var PackagePin = class PackagePin {
	id;
	version;
	manifestDigest;
	codeDigest;
	constructor(id, version, manifestDigest, codeDigest) {
		this.id = id;
		this.version = version;
		this.manifestDigest = manifestDigest;
		this.codeDigest = codeDigest;
		Object.freeze(this);
	}
	static fromData(value) {
		const object = requireObject(value, "Package pin");
		requireFields(object, [
			"codeDigest",
			"id",
			"manifestDigest",
			"version"
		], "Package pin");
		return new PackagePin(new PackageId(requireString(object["id"], "Package pin ID")), new SemVer(requireString(object["version"], "Package pin version")), new Digest(requireString(object["manifestDigest"], "Package manifest digest")), new Digest(requireString(object["codeDigest"], "Package code digest")));
	}
	equals(other) {
		return this.id.equals(other.id) && this.version.equals(other.version) && this.manifestDigest.equals(other.manifestDigest) && this.codeDigest.equals(other.codeDigest);
	}
	toData() {
		return {
			codeDigest: this.codeDigest.value,
			id: this.id.value,
			manifestDigest: this.manifestDigest.value,
			version: this.version.toString()
		};
	}
};
function requireObject(value, subject) {
	if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
	return value;
}
function requireFields(value, fields, subject) {
	if (!hasExactJsonKeys(value, fields)) throw new TypeError(`${subject} contains missing or unknown fields`);
}
function requireString(value, subject) {
	if (!isStringValue(value)) throw new TypeError(`${subject} must be a string`);
	return value;
}
function isStringValue(value) {
	return typeof value === "string";
}
//#endregion
//#region src/facets/attribution.ts
/**
* SPEC §4.2 (C13-FACET-CONTRIBUTION-ATTRIBUTION): the pair every record a contribution
* materializes into carries — the exact Facet that contributed it and the release the
* contribution was read from. It is one value object rather than two loose fields so that
* every attributed record spells the pair the same way on the wire and the withdrawal
* query of §4.1 reads one shape across record kinds.
*/
var ContributionAttribution = class ContributionAttribution {
	/** The field names an attributed record's own declared fields absorb. */
	static fields = Object.freeze(["contributor", "package"]);
	contributor;
	package;
	constructor(contributor, pin) {
		if (!(contributor instanceof FacetRef) || !(pin instanceof PackagePin)) throw new TypeError("A materialized contribution carries its contributing FacetRef and source PackagePin");
		this.contributor = contributor;
		this.package = pin;
		Object.freeze(this);
	}
	static decodeFields(object, subject) {
		const pin = object["package"];
		if (pin === void 0) throw new TypeError(`${subject} carries no source Package pin`);
		return new ContributionAttribution(new FacetRef(requireString$1(object["contributor"], `${subject} contributor`)), PackagePin.fromData(pin));
	}
	equals(other) {
		return this.contributor.equals(other.contributor) && this.package.equals(other.package);
	}
	encodeFields() {
		return {
			contributor: this.contributor.value,
			package: this.package.toData()
		};
	}
};
//#endregion
//#region src/facets/slot.ts
var SlotAuthorityPolicy = class SlotAuthorityPolicy {
	contribute;
	visibility;
	constructor(contribute, visibility) {
		this.contribute = canonicalSelectors(contribute, "Slot contribute authority");
		this.visibility = canonicalSelectors(visibility, "Slot visibility authority");
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Slot authority policy");
		requireExactFields(object, ["contribute", "visibility"]);
		return new SlotAuthorityPolicy(requireArray(object["contribute"], "Slot contribute authority").map((value) => requireString$1(value, "Slot contribute selector")), requireArray(object["visibility"], "Slot visibility authority").map((value) => requireString$1(value, "Slot visibility selector")));
	}
	static encode(policy) {
		return slotAuthorityPolicyCodec.encode(policy);
	}
	static decode(bytes) {
		return slotAuthorityPolicyCodec.decode(bytes);
	}
	toData() {
		return {
			contribute: this.contribute,
			visibility: this.visibility
		};
	}
};
var slotAuthorityPolicyCodec = new DataRecordCodec([SlotAuthorityPolicy], "facet.slot-authority-policy", (policy) => policy.toData(), (payload) => SlotAuthorityPolicy.fromData(payload));
var SlotDeclaration = class SlotDeclaration {
	name;
	entrySchema;
	authority;
	constructor(name, entrySchema, authority) {
		this.name = name;
		this.entrySchema = entrySchema;
		this.authority = authority;
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Slot declaration");
		requireExactFields(object, [
			"authority",
			"entrySchema",
			"name"
		]);
		return new SlotDeclaration(new SlotName(requireString$1(object["name"], "Slot name")), new JsonSchema(requireSchemaDocument(object["entrySchema"], "Slot entry schema")), SlotAuthorityPolicy.fromData(object["authority"]));
	}
	static encode(slot) {
		return slotDeclarationCodec.encode(slot);
	}
	static decode(bytes) {
		return slotDeclarationCodec.decode(bytes);
	}
	toData() {
		return {
			authority: this.authority.toData(),
			entrySchema: this.entrySchema.document,
			name: this.name.value
		};
	}
};
var slotDeclarationCodec = new DataRecordCodec([
	SlotDeclaration,
	SlotAuthorityPolicy,
	TextId,
	JsonSchema,
	SlotName
], "facet.slot-declaration", (slot) => slot.toData(), (payload) => SlotDeclaration.fromData(payload));
/**
* A Slot declaration as a Scope holds it: the manifest's declaration plus the §4.2
* attribution of the Facet whose `slots` contribution materialized it. The manifest half
* is authored before a release exists, so the pin lives here rather than on
* `SlotDeclaration`, and an installed Slot the host cannot attribute cannot be built.
*/
var InstalledSlot = class InstalledSlot {
	declaration;
	attribution;
	constructor(declaration, attribution) {
		this.declaration = declaration;
		this.attribution = attribution;
		if (!(declaration instanceof SlotDeclaration) || !(attribution instanceof ContributionAttribution)) throw new TypeError("An installed Slot carries its declaration and its attribution");
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Installed Slot");
		requireExactFields(object, [
			"contributor",
			"declaration",
			"package"
		]);
		const declaration = object["declaration"];
		if (declaration === void 0) throw new TypeError("Installed Slot carries no Slot declaration");
		return new InstalledSlot(SlotDeclaration.fromData(declaration), ContributionAttribution.decodeFields(object, "Installed Slot"));
	}
	/**
	* The record's own codec, so a reader that must declare the kinds it can decode names
	* this one from the record rather than restating its version (§8.3).
	*/
	static get codec() {
		return installedSlotCodec;
	}
	static encode(slot) {
		return installedSlotCodec.encode(slot);
	}
	static decode(bytes) {
		return installedSlotCodec.decode(bytes);
	}
	toData() {
		return {
			...this.attribution.encodeFields(),
			declaration: this.declaration.toData()
		};
	}
};
var installedSlotCodec = new DataRecordCodec([
	InstalledSlot,
	SlotDeclaration,
	ContributionAttribution,
	SlotAuthorityPolicy,
	TextId,
	JsonSchema,
	SlotName,
	FacetRef,
	FacetPackageId,
	Digest,
	SemVer,
	PackageId,
	PackagePin
], "facet.installed-slot", (slot) => slot.toData(), (payload) => InstalledSlot.fromData(payload));
function canonicalSelectors(values, subject) {
	if (values.length === 0) throw new TypeError(`${subject} must not be empty`);
	for (const value of values) requireNonblank(value, `${subject} selector`);
	const ordered = [...values].sort(compareCanonicalText);
	if (new Set(ordered).size !== ordered.length) throw new TypeError(`${subject} selectors must be unique`);
	return Object.freeze(ordered);
}
//#endregion
//#region src/facets/slot-entry.ts
/**
* SPEC §4.2: the position a contribution occupies — the exact triple a slot holds at most
* one entry for. It is deliberately a different shape from `SlotEntryId`, because the two
* answer different questions. The id digests every declared field, so it answers whether
* two materializations are the same record; the origin names the position a changed
* contribution supersedes. Collapsing them makes a contribution re-read from a later
* release indistinguishable from an illegal rewrite of the record it replaces.
*/
var SlotContributionOrigin = class {
	slot;
	contributor;
	ordinal;
	/** Lookup key for the at-most-one-entry-per-contributor-per-ordinal index. */
	key;
	constructor(slot, contributor, ordinal) {
		this.slot = slot;
		this.contributor = contributor;
		this.ordinal = ordinal;
		if (!(slot instanceof SlotName) || !(contributor instanceof FacetRef)) throw new TypeError("A slot contribution origin names its slot and contributor");
		if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new TypeError("Slot contribution origin ordinal must be a non-negative safe integer");
		this.key = `${slot.value}\0${contributor.value}\0${ordinal}`;
		Object.freeze(this);
	}
	equals(other) {
		return this.key === other.key;
	}
};
/**
* Major 3 carries the §4.2 source `PackagePin` alongside the contributing FacetRef. The
* pin is a declared field, so it moves the entry's identity digest, and bytes written
* before it existed decode as an unsupported major rather than as an unpinned entry.
*/
var SlotEntryCodecV3 = class extends RecordCodec {
	constructor() {
		super([
			SlotEntry,
			SlotContributionOrigin,
			ContributionAttribution,
			TextId,
			FacetRef,
			Digest,
			SlotName,
			SlotEntryId,
			FacetPackageId,
			SemVer,
			PackageId,
			PackagePin
		], "facet.slot-entry", {
			major: 3,
			minor: 0
		});
		Object.freeze(this.version);
		Object.freeze(this);
	}
	encodePayload(entry) {
		return entry.toData();
	}
	decodePayload(payload, _version) {
		return SlotEntry.fromData(payload);
	}
};
var SlotEntry = class SlotEntry {
	slot;
	attribution;
	ordinal;
	static get codec() {
		return slotEntryCodecInstance;
	}
	value;
	id;
	/**
	* The §4.2 position this entry occupies. It is derived from declared fields rather than
	* stored, so it adds nothing to the record's shape and cannot drift from it.
	*/
	origin;
	constructor(slot, attribution, ordinal, value, id) {
		this.slot = slot;
		this.attribution = attribution;
		this.ordinal = ordinal;
		if (!(attribution instanceof ContributionAttribution)) throw new TypeError("Slot entry requires its contribution attribution");
		if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new TypeError("Slot entry ordinal must be a non-negative safe integer");
		this.value = canonicalFacetData(value);
		this.origin = new SlotContributionOrigin(slot, attribution.contributor, ordinal);
		const expectedId = slotEntryId(slot, attribution, ordinal, this.value);
		if (id !== void 0 && !id.equals(expectedId)) throw new TypeError("Slot entry ID does not match its canonical contents");
		this.id = expectedId;
		Object.freeze(this);
	}
	static encode(entry) {
		return SlotEntry.codec.encode(entry);
	}
	static decode(bytes) {
		return SlotEntry.codec.decode(bytes);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Slot entry");
		requireExactFields(object, [
			"contributor",
			"id",
			"ordinal",
			"package",
			"slot",
			"value"
		]);
		return new SlotEntry(new SlotName(requireString$1(object["slot"], "Slot entry slot")), ContributionAttribution.decodeFields(object, "Slot entry"), requireSafeInteger(object["ordinal"], "Slot entry ordinal"), object["value"], new SlotEntryId(requireString$1(object["id"], "Slot entry ID")));
	}
	toData() {
		return {
			...this.attribution.encodeFields(),
			id: this.id.value,
			ordinal: this.ordinal,
			slot: this.slot.value,
			value: this.value
		};
	}
};
var slotEntryCodecInstance = new SlotEntryCodecV3();
function slotEntryId(slot, attribution, ordinal, value) {
	return new SlotEntryId(`slot:${Digest.sha256(encodeCanonicalJson({
		...attribution.encodeFields(),
		ordinal,
		slot: slot.value,
		value
	})).value}`);
}
//#endregion
//#region src/facets/mapping.ts
var JsonPointer = class {
	value;
	tokens;
	constructor(value) {
		this.value = value;
		if (value !== "" && (!value.startsWith("/") || /~(?:[^01]|$)/.test(value))) throw new TypeError("Value must be an RFC 6901 JSON Pointer");
		this.tokens = Object.freeze(value === "" ? [] : value.slice(1).split("/").map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~")));
		Object.freeze(this);
	}
};
var FieldMove = class FieldMove {
	to;
	from;
	literal;
	constructor(to, init) {
		this.to = to;
		new JsonPointer(to);
		const keys = Object.keys(init);
		if (keys.length !== 1 || keys[0] !== "from" && keys[0] !== "literal") throw new TypeError("Field move requires exactly one of from or literal");
		if ("from" in init) {
			new JsonPointer(init.from);
			this.from = init.from;
			this.literal = void 0;
		} else {
			this.from = void 0;
			this.literal = canonicalFacetData(init.literal);
		}
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Field move");
		requireExactFields(object, ["to"], ["from", "literal"]);
		const hasFrom = "from" in object;
		if (hasFrom === "literal" in object) throw new TypeError("Field move requires exactly one of from or literal");
		const to = requireString$1(object["to"], "Field move target");
		return hasFrom ? new FieldMove(to, { from: requireString$1(object["from"], "Field move source") }) : new FieldMove(to, { literal: object["literal"] });
	}
	static encode(move) {
		return fieldMoveCodec.encode(move);
	}
	static decode(bytes) {
		return fieldMoveCodec.decode(bytes);
	}
	toData() {
		return this.from === void 0 ? {
			literal: this.literal,
			to: this.to
		} : {
			from: this.from,
			to: this.to
		};
	}
};
var MappingRecord = class {
	moves;
	constructor(moves) {
		this.moves = Object.freeze([...moves]);
	}
	toData() {
		return this.moves.map((move) => move.toData());
	}
};
var FieldMapping = class extends MappingRecord {
	constructor(moves) {
		super(moves);
		Object.freeze(this);
	}
	static encode(mapping) {
		return fieldMappingCodec.encode(mapping);
	}
	static decode(bytes) {
		return fieldMappingCodec.decode(bytes);
	}
};
var fieldMappingCodec = new DataRecordCodec([
	FieldMapping,
	FieldMove,
	MappingRecord,
	JsonPointer
], "facet.field-mapping", (mapping) => mapping.toData(), (payload) => new FieldMapping(decodeMoves(payload, "Field mapping")));
var PayloadMapping = class extends MappingRecord {
	static get identity() {
		return identityPayloadMapping;
	}
	constructor(moves) {
		super(moves);
		Object.freeze(this);
	}
	static encode(mapping) {
		return payloadMappingCodec.encode(mapping);
	}
	static decode(bytes) {
		return payloadMappingCodec.decode(bytes);
	}
};
var identityPayloadMapping = new PayloadMapping([new FieldMove("", { from: "" })]);
var payloadMappingCodec = new DataRecordCodec([
	PayloadMapping,
	FieldMove,
	MappingRecord,
	JsonPointer
], "facet.payload-mapping", (mapping) => mapping.toData(), (payload) => new PayloadMapping(decodeMoves(payload, "Payload mapping")));
var ProvenanceMapping = class extends MappingRecord {
	constructor(moves) {
		super(moves);
		Object.freeze(this);
	}
	static encode(mapping) {
		return provenanceMappingCodec.encode(mapping);
	}
	static decode(bytes) {
		return provenanceMappingCodec.decode(bytes);
	}
};
var provenanceMappingCodec = new DataRecordCodec([
	ProvenanceMapping,
	FieldMove,
	MappingRecord,
	JsonPointer
], "facet.provenance-mapping", (mapping) => mapping.toData(), (payload) => new ProvenanceMapping(decodeMoves(payload, "Provenance mapping")));
var OperationPattern = class OperationPattern {
	operation;
	facet;
	constructor(operation, facet) {
		this.operation = operation;
		requirePrefixPattern$1(operation, "Operation selector operation");
		this.facet = facet;
		Object.freeze(this);
	}
	static own(operation = "*") {
		return new OperationPattern(operation);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Operation pattern");
		requireExactFields(object, ["operation"], ["facet"]);
		const facet = requireOptionalString(object["facet"], "Operation pattern facet");
		return new OperationPattern(requireString$1(object["operation"], "Operation pattern operation"), facet === void 0 ? void 0 : new FacetPackageId(facet));
	}
	static encode(pattern) {
		return operationPatternCodec.encode(pattern);
	}
	static decode(bytes) {
		return operationPatternCodec.decode(bytes);
	}
	toData() {
		return this.facet === void 0 ? { operation: this.operation } : {
			facet: this.facet.value,
			operation: this.operation
		};
	}
};
var operationPatternCodec = new DataRecordCodec([
	OperationPattern,
	TextId,
	FacetPackageId
], "facet.operation-pattern", (pattern) => pattern.toData(), (payload) => OperationPattern.fromData(payload));
var OperationSelector = class OperationSelector {
	patterns;
	constructor(patterns) {
		if (patterns.length === 0) throw new TypeError("Operation selector must contain at least one pattern");
		const ordered = [...patterns].sort((left, right) => compareCanonicalText(patternKey(left), patternKey(right)));
		ensureUnique(ordered.map(patternKey), "Operation selector patterns must be unique");
		this.patterns = Object.freeze(ordered);
		Object.freeze(this);
	}
	static own(operation = "*") {
		return new OperationSelector([OperationPattern.own(operation)]);
	}
	static encode(selector) {
		return operationSelectorCodec.encode(selector);
	}
	static decode(bytes) {
		return operationSelectorCodec.decode(bytes);
	}
	toData() {
		return this.patterns.map((pattern) => pattern.toData());
	}
};
var operationSelectorCodec = new DataRecordCodec([
	OperationSelector,
	OperationPattern,
	FacetPackageId,
	TextId
], "facet.operation-selector", (selector) => selector.toData(), (payload) => new OperationSelector(requireArray(payload, "Operation selector").map(OperationPattern.fromData)));
function decodeMoves(payload, subject) {
	return requireArray(payload, subject).map(FieldMove.fromData);
}
var patternKeyDecoder = new TextDecoder();
function patternKey(pattern) {
	return patternKeyDecoder.decode(encodeCanonicalJson([pattern.facet?.value ?? "", pattern.operation]));
}
function ensureUnique(values, message) {
	if (new Set(values).size !== values.length) throw new TypeError(message);
}
var fieldMoveCodec = new DataRecordCodec([FieldMove, JsonPointer], "facet.field-move", (move) => move.toData(), (payload) => FieldMove.fromData(payload));
function requirePrefixPattern$1(value, subject) {
	if (value.length === 0 || value.trim() !== value || value.slice(0, -1).includes("*")) throw new TypeError(`${subject} must be a literal or suffix-wildcard pattern`);
}
//#endregion
//#region src/facets/event.ts
var trustOrder = [
	"owner",
	"authenticated",
	"external",
	"self"
];
var EventPattern = class EventPattern {
	kind;
	source;
	acceptedTrust;
	constructor(kind, acceptedTrust, source) {
		this.kind = kind;
		requirePrefixPattern(kind, "Event pattern kind");
		if (source !== void 0) requirePrefixPattern(source, "Event pattern source");
		this.source = source;
		this.acceptedTrust = canonicalTrustTiers(acceptedTrust);
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Event pattern");
		requireExactFields(object, ["acceptedTrust", "kind"], ["source"]);
		const trust = requireArray(object["acceptedTrust"], "Accepted trust tiers").map(requireTrustTier$1);
		if (!isNonempty(trust)) throw new TypeError("Accepted trust tiers must not be empty");
		return new EventPattern(requireString$1(object["kind"], "Event pattern kind"), trust, requireOptionalString(object["source"], "Event pattern source"));
	}
	static encode(pattern) {
		return eventPatternCodec.encode(pattern);
	}
	static decode(bytes) {
		return eventPatternCodec.decode(bytes);
	}
	toData() {
		return dataRecord({
			acceptedTrust: this.acceptedTrust,
			kind: this.kind,
			source: this.source
		});
	}
};
var eventPatternCodec = new DataRecordCodec([EventPattern], "facet.event-pattern", (pattern) => pattern.toData(), (payload) => EventPattern.fromData(payload));
var EventDeclaration = class EventDeclaration {
	kind;
	description;
	payload;
	visibility;
	constructor(kind, description, payload, visibility) {
		this.kind = kind;
		this.description = description;
		this.payload = payload;
		this.visibility = visibility;
		requireNonblank(description, "Event description");
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Event declaration");
		requireExactFields(object, [
			"description",
			"kind",
			"payload",
			"visibility"
		]);
		return new EventDeclaration(new EventKind(requireString$1(object["kind"], "Event kind")), requireString$1(object["description"], "Event description"), new JsonSchema(requireSchemaDocument(object["payload"], "Event payload schema")), requireVisibility(object["visibility"]));
	}
	static encode(event) {
		return eventDeclarationCodec.encode(event);
	}
	static decode(bytes) {
		return eventDeclarationCodec.decode(bytes);
	}
	toData() {
		return {
			description: this.description,
			kind: this.kind.value,
			payload: this.payload.document,
			visibility: this.visibility
		};
	}
};
var eventDeclarationCodec = new DataRecordCodec([
	EventDeclaration,
	TextId,
	JsonSchema,
	EventKind
], "facet.event-declaration", (event) => event.toData(), (payload) => EventDeclaration.fromData(payload));
var IngressVerification = class IngressVerification {
	scheme;
	secret;
	constructor(scheme, secret) {
		this.scheme = scheme;
		this.secret = Object.freeze(new SecretRef(secret.source, secret.provider, secret.id));
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Ingress verification");
		requireExactFields(object, ["scheme", "secret"]);
		const secret = requireDataObject(object["secret"], "Ingress verification secret");
		requireExactFields(secret, [
			"id",
			"provider",
			"source"
		]);
		return new IngressVerification(requireVerificationScheme(object["scheme"]), new SecretRef(requireString$1(secret["source"], "Secret source"), requireString$1(secret["provider"], "Secret provider"), requireString$1(secret["id"], "Secret ID")));
	}
	static encode(verification) {
		return ingressVerificationCodec.encode(verification);
	}
	static decode(bytes) {
		return ingressVerificationCodec.decode(bytes);
	}
	toData() {
		return {
			scheme: this.scheme,
			secret: {
				id: this.secret.id,
				provider: this.secret.provider,
				source: this.secret.source
			}
		};
	}
};
var ingressVerificationCodec = new DataRecordCodec([IngressVerification, SecretRef], "facet.ingress-verification", (verification) => verification.toData(), (payload) => IngressVerification.fromData(payload));
var IngressDeclaration = class IngressDeclaration {
	path;
	verification;
	provenance;
	constructor(path, verification, provenance) {
		this.path = path;
		this.verification = verification;
		this.provenance = provenance;
		requireNonblank(path, "Ingress path");
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Ingress declaration");
		requireExactFields(object, [
			"path",
			"provenance",
			"verification"
		]);
		return new IngressDeclaration(requireString$1(object["path"], "Ingress path"), IngressVerification.fromData(object["verification"]), new ProvenanceMapping(requireArray(object["provenance"], "Ingress provenance mapping").map(FieldMove.fromData)));
	}
	static encode(ingress) {
		return ingressDeclarationCodec.encode(ingress);
	}
	static decode(bytes) {
		return ingressDeclarationCodec.decode(bytes);
	}
	toData() {
		return {
			path: this.path,
			provenance: this.provenance.toData(),
			verification: this.verification.toData()
		};
	}
};
var ingressDeclarationCodec = new DataRecordCodec([
	IngressDeclaration,
	IngressVerification,
	SecretRef,
	MappingRecord,
	FieldMove,
	ProvenanceMapping,
	JsonPointer
], "facet.ingress-declaration", (ingress) => ingress.toData(), (payload) => IngressDeclaration.fromData(payload));
function canonicalTrustTiers(values) {
	return canonicalOrder(values, trustOrder, "Trust tiers");
}
function requireTrustTier$1(value) {
	if (value === "owner" || value === "authenticated" || value === "external" || value === "self") return value;
	throw new TypeError("Trust tier is invalid");
}
function requireVisibility(value) {
	if (value === "workspace" || value === "private") return value;
	throw new TypeError("Event visibility is invalid");
}
function requireVerificationScheme(value) {
	if (value === "hmac" || value === "signature" || value === "oauth" || value === "mtls") return value;
	throw new TypeError("Ingress verification scheme is invalid");
}
function requirePrefixPattern(value, subject) {
	if (value.length === 0 || value.trim() !== value || value.slice(0, -1).includes("*")) throw new TypeError(`${subject} must be a literal or suffix-wildcard pattern`);
}
//#endregion
//#region src/facets/operation.ts
var BoundOperationRef = class BoundOperationRef {
	binding;
	operation;
	static get codec() {
		return boundOperationRefCodec;
	}
	constructor(binding, operation) {
		this.binding = binding;
		this.operation = operation;
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Bound operation reference");
		requireExactFields(object, ["binding", "operation"]);
		return new BoundOperationRef(new BindingName(requireString$1(object["binding"], "Operation binding")), new OperationName(requireString$1(object["operation"], "Operation name")));
	}
	equals(other) {
		return this.binding.equals(other.binding) && this.operation.equals(other.operation);
	}
	toData() {
		return {
			binding: this.binding.value,
			operation: this.operation.value
		};
	}
};
var FacetOperationRef = class FacetOperationRef {
	facet;
	operation;
	static get codec() {
		return facetOperationRefCodec;
	}
	constructor(facet, operation) {
		this.facet = facet;
		this.operation = operation;
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Facet operation reference");
		requireExactFields(object, ["facet", "operation"]);
		return new FacetOperationRef(new FacetRef(requireString$1(object["facet"], "Operation Facet reference")), new OperationName(requireString$1(object["operation"], "Operation name")));
	}
	equals(other) {
		return this.facet.equals(other.facet) && this.operation.equals(other.operation);
	}
	toData() {
		return {
			facet: this.facet.value,
			operation: this.operation.value
		};
	}
};
var boundOperationRefCodec = new DataRecordCodec([
	BoundOperationRef,
	TextId,
	BindingName,
	OperationName
], "facet.bound-operation-ref", (reference) => reference.toData(), (payload) => BoundOperationRef.fromData(payload));
var facetOperationRefCodec = new DataRecordCodec([
	FacetOperationRef,
	TextId,
	FacetRef,
	OperationName,
	FacetPackageId
], "facet.operation-ref", (reference) => reference.toData(), (payload) => FacetOperationRef.fromData(payload));
//#endregion
//#region src/facets/automation.ts
var Automation = class Automation {
	source;
	target;
	binding;
	mapping;
	dedupe;
	authority;
	operation;
	constructor(init) {
		this.source = init.source;
		this.target = init.target;
		this.binding = init.binding;
		this.operation = new BoundOperationRef(init.binding, init.target.operation);
		this.mapping = init.mapping;
		this.dedupe = init.dedupe;
		this.authority = init.authority;
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Automation");
		requireExactFields(object, [
			"binding",
			"source",
			"target"
		], [
			"authority",
			"dedupe",
			"mapping"
		]);
		const mapping = object["mapping"];
		const dedupe = requireOptionalString(object["dedupe"], "Automation dedupe policy");
		const authority = requireOptionalString(object["authority"], "Automation authority");
		const decodedMapping = mapping === void 0 ? void 0 : new PayloadMapping(requireArray(mapping, "Automation mapping").map(FieldMove.fromData));
		return new Automation({
			source: EventPattern.fromData(object["source"]),
			target: new OperationRef(requireString$1(object["target"], "Automation target")),
			binding: new BindingName(requireString$1(object["binding"], "Automation binding")),
			mapping: decodedMapping,
			dedupe: dedupe === void 0 ? void 0 : requireDedupePolicy(dedupe),
			authority: authority === void 0 ? void 0 : requireAuthority(authority)
		});
	}
	static encode(automation) {
		return automationCodec.encode(automation);
	}
	static decode(bytes) {
		return automationCodec.decode(bytes);
	}
	toData() {
		return dataRecord({
			binding: this.binding.value,
			source: this.source.toData(),
			target: this.target.value,
			authority: this.authority,
			dedupe: this.dedupe,
			mapping: this.mapping?.toData()
		});
	}
};
var automationCodec = new DataRecordCodec([
	Automation,
	TextId,
	MappingRecord,
	FieldMove,
	EventPattern,
	OperationRef,
	BindingName,
	FacetPackageId,
	OperationName,
	BoundOperationRef,
	PayloadMapping,
	JsonPointer
], "facet.automation", (automation) => automation.toData(), (payload) => Automation.fromData(payload));
function requireDedupePolicy(value) {
	if (value === "none" || value === "event" || value === "causation" || value === "payload") return value;
	throw new TypeError("Automation dedupe policy is invalid");
}
function requireAuthority(value) {
	if (value === "initiator" || value === "delegated") return value;
	throw new TypeError("Automation authority is invalid");
}
//#endregion
//#region src/facets/command.ts
var Command = class Command {
	name;
	title;
	help;
	arguments;
	operation;
	binding;
	mapping;
	acceptedTrust;
	completion;
	surfaces;
	target;
	constructor(init) {
		requireNonblank(init.name, "Command name");
		requireNonblank(init.title, "Command title");
		if (init.help !== void 0) requireNonblank(init.help, "Command help");
		if (init.surfaces.length === 0) throw new TypeError("Command surfaces must not be empty");
		const surfaces = [...init.surfaces].sort((left, right) => compareCanonicalText(left.value, right.value));
		if (new Set(surfaces.map((surface) => surface.value)).size !== surfaces.length) throw new TypeError("Command surfaces must be unique");
		this.name = init.name;
		this.title = init.title;
		this.help = init.help;
		this.arguments = init.arguments;
		this.operation = init.operation;
		this.binding = init.binding;
		this.target = new BoundOperationRef(init.binding, init.operation.operation);
		this.mapping = init.mapping;
		this.acceptedTrust = init.acceptedTrust === void 0 ? void 0 : canonicalTrustTiers(init.acceptedTrust);
		this.completion = init.completion;
		this.surfaces = Object.freeze(surfaces);
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Command");
		requireExactFields(object, [
			"arguments",
			"binding",
			"name",
			"operation",
			"surfaces",
			"title"
		], [
			"acceptedTrust",
			"completion",
			"help",
			"mapping"
		]);
		const acceptedTrustValue = object["acceptedTrust"];
		const acceptedTrust = acceptedTrustValue === void 0 ? void 0 : decodeTrustTiers(acceptedTrustValue);
		const mappingValue = object["mapping"];
		const completion = requireOptionalString(object["completion"], "Command completion");
		const help = requireOptionalString(object["help"], "Command help");
		const mapping = mappingValue === void 0 ? void 0 : new FieldMapping(requireArray(mappingValue, "Command mapping").map(FieldMove.fromData));
		return new Command({
			name: requireString$1(object["name"], "Command name"),
			title: requireString$1(object["title"], "Command title"),
			arguments: new JsonSchema(requireSchemaDocument(object["arguments"], "Command arguments schema")),
			operation: new OperationRef(requireString$1(object["operation"], "Command operation")),
			binding: new BindingName(requireString$1(object["binding"], "Command binding")),
			surfaces: requireArray(object["surfaces"], "Command surfaces").map((value) => new SlotName(requireString$1(value, "Command surface"))),
			help,
			mapping,
			acceptedTrust,
			completion: completion === void 0 ? void 0 : new OperationRef(completion)
		});
	}
	static encode(command) {
		return commandCodec.encode(command);
	}
	static decode(bytes) {
		return commandCodec.decode(bytes);
	}
	toData() {
		return dataRecord({
			arguments: this.arguments.document,
			binding: this.binding.value,
			name: this.name,
			operation: this.operation.value,
			surfaces: this.surfaces.map((surface) => surface.value),
			title: this.title,
			acceptedTrust: this.acceptedTrust,
			completion: this.completion?.value,
			help: this.help,
			mapping: this.mapping?.toData()
		});
	}
};
function commandInvocationSource(command) {
	return canonicalTupleKey("command.invoked.source", [command.operation.facet.value, command.name]);
}
function commandAutomation(command) {
	return new Automation({
		source: new EventPattern("command.invoked", command.acceptedTrust ?? [
			"owner",
			"authenticated",
			"self"
		], commandInvocationSource(command)),
		target: command.operation,
		binding: command.binding,
		mapping: new PayloadMapping([new FieldMove("", { from: "/input" })]),
		dedupe: "event",
		authority: "initiator"
	});
}
var commandCodec = new DataRecordCodec([
	Command,
	TextId,
	JsonSchema,
	MappingRecord,
	FieldMove,
	OperationRef,
	BindingName,
	FacetPackageId,
	OperationName,
	BoundOperationRef,
	FieldMapping,
	SlotName,
	JsonPointer
], "facet.command", (command) => command.toData(), (payload) => Command.fromData(payload));
function decodeTrustTiers(value) {
	const values = requireArray(value, "Command accepted trust").map(requireTrustTier);
	if (!isNonempty(values)) throw new TypeError("Command accepted trust must not be empty");
	return values;
}
function requireTrustTier(value) {
	if (value === "owner" || value === "authenticated" || value === "external" || value === "self") return value;
	throw new TypeError("Command trust tier is invalid");
}
//#endregion
//#region src/facets/interceptor.ts
var TURN_BOUND_CUT_POINTS = Object.freeze([
	"prompt.assemble",
	"input.submitted",
	"turn.step"
]);
function isTurnBoundCutPoint(cutPoint) {
	return TURN_BOUND_CUT_POINTS.some((candidate) => candidate === cutPoint);
}
/**
* SPEC §4.4 rule 3's leading ordering component. A declared mode dominates local
* priority, so this array — not a number a contributor picks — decides which band an
* interceptor runs in, and rule 10 makes the `gate` band's read-only claim enforceable.
*/
var interceptorModeOrder = Object.freeze(["rewrite", "gate"]);
var InterceptorDeclaration = class InterceptorDeclaration {
	id;
	cutPoint;
	mode;
	modeRank;
	appliesTo;
	priority;
	constructor(id, cutPoint, mode, ...selection) {
		const [appliesToOrPriority, priority] = selection;
		const selected = appliesToOrPriority instanceof OperationSelector;
		const resolvedPriority = selected ? priority : appliesToOrPriority;
		if (resolvedPriority === void 0 || !Number.isSafeInteger(resolvedPriority)) throw new TypeError("Interceptor priority must be a safe integer");
		const modeRank = interceptorModeOrder.indexOf(mode);
		if (modeRank < 0) throw new TypeError("Interceptor mode is invalid");
		this.id = id;
		this.cutPoint = cutPoint;
		this.mode = mode;
		this.modeRank = modeRank;
		this.appliesTo = selected ? appliesToOrPriority : OperationSelector.own();
		this.priority = resolvedPriority;
		const [only] = this.appliesTo.patterns;
		if (isTurnBoundCutPoint(cutPoint) && (this.appliesTo.patterns.length !== 1 || only?.facet !== void 0 || only?.operation !== "*")) throw new TypeError("A Turn-bound cut point selects no Operation, so its interceptor declares no operation selector");
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Interceptor declaration");
		requireExactFields(object, [
			"cutPoint",
			"id",
			"mode",
			"priority"
		], ["appliesTo"]);
		const appliesToValue = object["appliesTo"];
		if (appliesToValue !== void 0 && !Array.isArray(appliesToValue)) throw new TypeError("Interceptor operation selector must be an array");
		const id = new InterceptorId(requireString$1(object["id"], "Interceptor ID"));
		const cutPoint = requireCutPoint(object["cutPoint"]);
		const mode = requireMode(object["mode"]);
		const priority = requireSafeInteger(object["priority"], "Interceptor priority");
		return appliesToValue === void 0 ? new InterceptorDeclaration(id, cutPoint, mode, priority) : new InterceptorDeclaration(id, cutPoint, mode, new OperationSelector(appliesToValue.map(OperationPattern.fromData)), priority);
	}
	static encode(interceptor) {
		return interceptorDeclarationCodec.encode(interceptor);
	}
	static decode(bytes) {
		return interceptorDeclarationCodec.decode(bytes);
	}
	toData() {
		return {
			appliesTo: this.appliesTo.toData(),
			cutPoint: this.cutPoint,
			id: this.id.value,
			mode: this.mode,
			priority: this.priority
		};
	}
};
var interceptorDeclarationCodec = new DataRecordCodec([
	InterceptorDeclaration,
	TextId,
	OperationPattern,
	OperationSelector,
	InterceptorId,
	FacetPackageId
], "facet.interceptor-declaration", (interceptor) => interceptor.toData(), (payload) => InterceptorDeclaration.fromData(payload));
function requireCutPoint(value) {
	if (value === "operation.before" || value === "operation.after" || value === "prompt.assemble" || value === "input.submitted" || value === "turn.step") return value;
	throw new TypeError("Interceptor cut point is invalid");
}
function requireMode(value) {
	const mode = interceptorModeOrder.find((candidate) => candidate === value);
	if (mode === void 0) throw new TypeError("Interceptor mode is invalid");
	return mode;
}
//#endregion
//#region src/facets/prompt-section.ts
/**
* SPEC §4.2: the position one contributed prompt section occupies — the exact pair a
* contribution holds at most one section for. It mirrors `SlotContributionOrigin`: the id
* digests every declared field and answers whether two materializations are the same
* record, the origin names the slot a changed contribution supersedes. Collapsing them
* makes a contribution re-read from a later release indistinguishable from an illegal
* rewrite of the record it replaces.
*/
var PromptSectionContributionOrigin = class {
	contributor;
	position;
	/** Lookup key for the at-most-one-section-per-contributor-per-position index. */
	key;
	constructor(contributor, position) {
		this.contributor = contributor;
		this.position = position;
		if (!(contributor instanceof FacetRef)) throw new TypeError("A prompt contribution origin names its contributor");
		if (!Number.isSafeInteger(position) || position < 0) throw new TypeError("Prompt contribution origin position must be a non-negative safe integer");
		this.key = canonicalTupleKey("prompt-section.origin", [contributor.value, position]);
		Object.freeze(this);
	}
	equals(other) {
		return this.key === other.key;
	}
};
/**
* Major 1 is the initial shape: every declared field plus the §4.2 attribution. The pin
* is a declared field, so it moves the section's identity digest, and a host that
* materialized an unpinned section would decode as unsupported rather than as
* unattributed.
*/
var PromptSectionCodecV1 = class extends RecordCodec {
	constructor() {
		super([
			PromptSection,
			PromptSectionContributionOrigin,
			ContributionAttribution,
			TextId,
			FacetRef,
			Digest,
			PromptSectionId,
			FacetPackageId,
			SemVer,
			PackageId,
			PackagePin
		], "facet.prompt-section", {
			major: 1,
			minor: 0
		});
		Object.freeze(this.version);
		Object.freeze(this);
	}
	encodePayload(section) {
		return section.toData();
	}
	decodePayload(payload, _version) {
		return PromptSection.fromData(payload);
	}
};
/**
* SPEC §4.2 (C13-FACET-CONTRIBUTION-ATTRIBUTION): one prompt-assembly section as the owning
* Workspace holds it, carrying the exact `FacetRef` whose `prompt` contribution materialized
* it and the `PackagePin` of the release it was read from. The declaration half is authored
* in a manifest before any release exists, so the pin lives here rather than on `Prompt` —
* the same split `SurfaceRegistration` makes for Surfaces — and a section the host cannot
* attribute cannot be built. That is what lets a host answer from records alone which Facet
* is responsible for a prompt section, what puts the section in that Facet's §4.1 withdrawal
* set, and what keeps unrelated sections' order stable while one contributor's set retires.
*/
var PromptSection = class PromptSection {
	title;
	body;
	priority;
	attribution;
	position;
	static get codec() {
		return promptSectionCodecInstance;
	}
	/**
	* The order a host assembles stored sections in: declared priority first, then the
	* declared text, then the origin. Every key is a declared field or the origin, so two
	* stores of the same records list them in the same order without consulting anything
	* outside this record.
	*/
	static compare(left, right) {
		return left.priority - right.priority || compareCanonicalText(left.title, right.title) || compareCanonicalText(left.body, right.body) || compareCanonicalText(left.origin.contributor.value, right.origin.contributor.value) || left.origin.position - right.origin.position;
	}
	id;
	/**
	* The §4.2 position this section occupies. It is derived from declared fields rather
	* than stored, so it adds nothing to the record's shape and cannot drift from it.
	*/
	origin;
	constructor(title, body, priority, attribution, position, id) {
		this.title = title;
		this.body = body;
		this.priority = priority;
		this.attribution = attribution;
		this.position = position;
		requireNonblank(title, "Prompt section title");
		requireNonblank(body, "Prompt section body");
		if (!Number.isSafeInteger(priority)) throw new TypeError("Prompt section priority must be a safe integer");
		if (!(attribution instanceof ContributionAttribution)) throw new TypeError("Prompt section requires its contribution attribution");
		if (!Number.isSafeInteger(position) || position < 0) throw new TypeError("Prompt section position must be a non-negative safe integer");
		this.origin = new PromptSectionContributionOrigin(attribution.contributor, position);
		const expectedId = promptSectionId(this.title, this.body, this.priority, attribution, position);
		if (id !== void 0 && !id.equals(expectedId)) throw new TypeError("Prompt section ID does not match its canonical contents");
		this.id = expectedId;
		Object.freeze(this);
	}
	static encode(section) {
		return PromptSection.codec.encode(section);
	}
	static decode(bytes) {
		return PromptSection.codec.decode(bytes);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Prompt section");
		requireExactFields(object, [
			"body",
			"contributor",
			"id",
			"package",
			"position",
			"priority",
			"title"
		]);
		return new PromptSection(requireString$1(object["title"], "Prompt section title"), requireString$1(object["body"], "Prompt section body"), requireSafeInteger(object["priority"], "Prompt section priority"), ContributionAttribution.decodeFields(object, "Prompt section"), requireSafeInteger(object["position"], "Prompt section position"), new PromptSectionId(requireString$1(object["id"], "Prompt section ID")));
	}
	toData() {
		return {
			...this.attribution.encodeFields(),
			body: this.body,
			id: this.id.value,
			position: this.position,
			priority: this.priority,
			title: this.title
		};
	}
};
var promptSectionCodecInstance = new PromptSectionCodecV1();
function promptSectionId(title, body, priority, attribution, position) {
	return new PromptSectionId(`prompt:${Digest.sha256(encodeCanonicalJson({
		...attribution.encodeFields(),
		body,
		position,
		priority,
		title
	})).value}`);
}
//#endregion
//#region src/facets/prompt.ts
var Prompt = class Prompt {
	title;
	body;
	priority;
	constructor(title, body, priority) {
		this.title = title;
		this.body = body;
		this.priority = priority;
		requireNonblank(title, "Prompt title");
		requireNonblank(body, "Prompt body");
		if (!Number.isSafeInteger(priority)) throw new TypeError("Prompt priority must be a safe integer");
		Object.freeze(this);
	}
	static fromData(payload) {
		const object = requireDataObject(payload, "Prompt");
		requireExactFields(object, [
			"body",
			"priority",
			"title"
		]);
		return new Prompt(requireString$1(object["title"], "Prompt title"), requireString$1(object["body"], "Prompt body"), requireSafeInteger(object["priority"], "Prompt priority"));
	}
	static encode(prompt) {
		return promptCodec.encode(prompt);
	}
	static decode(bytes) {
		return promptCodec.decode(bytes);
	}
	toData() {
		return {
			body: this.body,
			priority: this.priority,
			title: this.title
		};
	}
};
var promptCodec = new DataRecordCodec([Prompt], "facet.prompt", (prompt) => prompt.toData(), (payload) => Prompt.fromData(payload));
var PromptContribution = class PromptContribution {
	sections;
	constructor(sections) {
		const ordered = [...sections].sort(comparePrompts);
		this.sections = Object.freeze(ordered);
		Object.freeze(this);
	}
	static empty() {
		return emptyPromptContribution;
	}
	static fromData(payload) {
		return new PromptContribution(requireArray(payload, "Prompt contribution").map(Prompt.fromData));
	}
	static encode(contribution) {
		return promptContributionCodec.encode(contribution);
	}
	static decode(bytes) {
		return promptContributionCodec.decode(bytes);
	}
	toData() {
		return this.sections.map((section) => section.toData());
	}
};
var promptContributionCodec = new DataRecordCodec([PromptContribution, Prompt], "facet.prompt-contribution", (contribution) => contribution.toData(), (payload) => PromptContribution.fromData(payload));
function comparePrompts(left, right) {
	return left.priority - right.priority || compareCanonicalText(left.title, right.title) || compareCanonicalText(left.body, right.body);
}
var emptyPromptContribution = new PromptContribution([]);
//#endregion
//#region src/facets/protection.ts
var MIN_PROTECTION_DOMAIN_LABEL_LENGTH = 1;
var MAX_PROTECTION_DOMAIN_LABEL_LENGTH = 128;
var ProtectionDomain = class {
	kind;
	label;
	secretPolicy;
	constructor(kind, label, secretPolicy) {
		this.kind = kind;
		this.label = label;
		this.secretPolicy = secretPolicy;
		if (label.length < MIN_PROTECTION_DOMAIN_LABEL_LENGTH || label.length > MAX_PROTECTION_DOMAIN_LABEL_LENGTH) throw new TypeError("Protection domain label must contain between 1 and 128 characters");
		if (kind === "frontend" && secretPolicy === "may-hold-secrets") throw new TypeError("Frontend protection domains cannot hold secrets");
	}
	get canHoldSecrets() {
		return this.secretPolicy === "may-hold-secrets";
	}
	equals(other) {
		return this.kind === other.kind && this.label === other.label && this.secretPolicy === other.secretPolicy;
	}
};
//#endregion
//#region src/facets/installation.ts
/**
* The authenticated installation a materializing host reads a contribution under. It
* carries the §4.2 attribution rather than a bare FacetRef, so a host that cannot name
* both the contributing Facet and the release it was read from cannot build one — which
* is what makes refusal, not unattributed materialization, the only other outcome.
*/
var PackageInstallationRef = class {
	attribution;
	packageFacet;
	constructor(attribution, packageFacet) {
		this.attribution = attribution;
		this.packageFacet = packageFacet;
		if (!(attribution instanceof ContributionAttribution) || !(packageFacet instanceof FacetPackageId)) throw new TypeError("Package installation reference requires canonical Facet identities");
		Object.freeze(this);
	}
};
//#endregion
//#region src/facets/runtime.ts
var Operation = class {};
var ProtectedOperationPort = class {};
var Interceptor = class {};
var Surface = class {};
var Facet = class {};
//#endregion
export { OperationAvailability as $, SlotEntry as A, requireSchemaDocument as At, canonicalIsolationModes as B, FieldMove as C, isString as Ct, OperationSelector as D, requireDataObject as Dt, OperationPattern as E, requireBytes as Et, PackagePin as F, OperationDescriptor as G, preferredPlacement as H, PackageId as I, CapabilitySpec as J, SurfaceDescriptor as K, BindingRequirement as L, SlotAuthorityPolicy as M, SlotDeclaration as N, PayloadMapping as O, requireExactFields as Ot, ContributionAttribution as P, AuthoredCodeSource as Q, FacetManifest as R, FieldMapping as S, isNumber as St, MappingRecord as T, requireBoolean$1 as Tt, Contribution as U, PlacementIntersection as V, Contributions as W, matchesGlob as X, isCapabilityEffect as Y, AUTHORED_CODE_CONSUMERS as Z, EventDeclaration as _, canonicalFacetDataMap as _t, Surface as a, FacetPackageId as at, IngressVerification as b, isFacetData as bt, Prompt as c, OperationName as ct, InterceptorDeclaration as d, SettingsLayerId as dt, requireAuthoredCodeConsumer as et, Command as f, SlotEntryId as ft, BoundOperationRef as g, canonicalFacetData as gt, Automation as h, DataRecordCodec as ht, ProtectedOperationPort as i, EventKind as it, InstalledSlot as j, requireString$1 as jt, ProvenanceMapping as k, requireSafeInteger as kt, PromptContribution as l, OperationRef as lt, commandInvocationSource as m, SurfaceId as mt, Interceptor as n, BindingName as nt, PackageInstallationRef as o, FacetRef as ot, commandAutomation as p, SlotName as pt, enforcementFloor as q, Operation as r, CatalogEntryId as rt, ProtectionDomain as s, InterceptorId as st, Facet as t, AuthoredCodeBackingId as tt, PromptSection as u, PromptSectionId as ut, EventPattern as v, dataRecord as vt, JsonPointer as w, requireArray as wt, canonicalTrustTiers as x, isFacetDataMap as xt, IngressDeclaration as y, freezeFacetData as yt, PLACEMENT_PREFERENCE as z };

//# sourceMappingURL=runtime-z1yMP0an.js.map