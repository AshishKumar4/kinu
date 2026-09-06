import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
//#region src/core/unicode.ts
/**
* UTF-16's surrogate range, as Unicode and ECMA-262 define it: a lone code unit in
* D800-DFFF encodes half a supplementary code point and is not a scalar value, so a string
* holding one has no UTF-8 encoding. Named because the four boundaries are the definition
* of the range and nothing about this codebase; a bare hex literal in a comparison states
* neither which half it bounds nor where the number comes from.
*/
var HIGH_SURROGATE_FIRST = 55296;
var HIGH_SURROGATE_LAST = 56319;
var LOW_SURROGATE_FIRST = 56320;
var LOW_SURROGATE_LAST = 57343;
function hasOnlyUnicodeScalarValues(value) {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= HIGH_SURROGATE_FIRST && code <= HIGH_SURROGATE_LAST) {
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(index + 1);
			if (next < LOW_SURROGATE_FIRST || next > LOW_SURROGATE_LAST) return false;
			index += 1;
		} else if (code >= LOW_SURROGATE_FIRST && code <= LOW_SURROGATE_LAST) return false;
	}
	return true;
}
//#endregion
//#region src/core/json.ts
function isJsonString(value) {
	return typeof value === "string";
}
function isJsonNumber(value) {
	return typeof value === "number";
}
function isJsonBoolean(value) {
	return typeof value === "boolean";
}
function isJsonArray(value) {
	return Array.isArray(value);
}
function isJsonValue(value) {
	try {
		return isJsonValueAt(value, /* @__PURE__ */ new WeakSet());
	} catch {
		return false;
	}
}
function isJsonObject(value) {
	return value !== null && !Array.isArray(value) && typeof value === "object";
}
/**
* The `unknown` counterpart of isJsonObject. Its recursive property-value type
* covers the JavaScript value space without falsely claiming nested JSON, so
* every member still requires its own domain predicate before use.
*/
function isObjectRecord(value) {
	return value !== null && !Array.isArray(value) && typeof value === "object";
}
/** Exact own-key-set check for any object, without narrowing its member types. */
function hasExactKeys(value, expected) {
	return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
function hasExactJsonKeys(value, expected) {
	return hasExactKeys(value, expected);
}
function jsonDataParser(fail) {
	const string = (value, subject) => {
		if (!isJsonString(value)) throw fail(`${subject} must be a string`);
		return value;
	};
	return Object.freeze({
		object(value, subject) {
			if (!isJsonObject(value)) throw fail(`${subject} must be an object`);
			return value;
		},
		exact(value, fields, subject, malformed = "contains missing or unknown fields") {
			if (!hasExactJsonKeys(value, fields)) throw fail(`${subject} ${malformed}`);
			return value;
		},
		string,
		nonemptyString(value, subject) {
			if (!isJsonString(value) || value.length === 0) throw fail(`${subject} must be a non-empty string`);
			return value;
		},
		nullableString(value, subject) {
			return value === null ? void 0 : string(value, subject);
		},
		boolean(value, subject) {
			if (!isJsonBoolean(value)) throw fail(`${subject} must be a boolean`);
			return value;
		},
		safeInteger(value, subject) {
			if (!isJsonNumber(value) || !Number.isSafeInteger(value) || value < 0) throw fail(`${subject} must be a non-negative safe integer`);
			return value;
		},
		array(value, subject) {
			if (!isJsonArray(value)) throw fail(`${subject} must be an array`);
			return value;
		}
	});
}
function isJsonValueAt(value, ancestors) {
	if (value === null || isJsonBoolean(value)) return true;
	if (isJsonString(value)) return hasOnlyUnicodeScalarValues(value);
	if (isJsonNumber(value)) return Number.isFinite(value);
	if (!Array.isArray(value) && !isObjectRecord(value)) return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	const valid = Array.isArray(value) ? isJsonArrayAt(value, ancestors) : isJsonObjectAt(value, ancestors);
	ancestors.delete(value);
	return valid;
}
function isJsonArrayAt(value, ancestors) {
	if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return false;
	for (let index = 0; index < value.length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (descriptor === void 0 || !descriptor.enumerable || !("value" in descriptor) || !isJsonValueAt(descriptor.value, ancestors)) return false;
	}
	return true;
}
function isJsonObjectAt(value, ancestors) {
	if (Object.getPrototypeOf(value) !== Object.prototype) return false;
	for (const key of Reflect.ownKeys(value)) {
		if (!isStringPropertyKey(key) || !hasOnlyUnicodeScalarValues(key)) return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === void 0 || !descriptor.enumerable || !("value" in descriptor) || !isJsonValueAt(descriptor.value, ancestors)) return false;
	}
	return true;
}
function isStringPropertyKey(value) {
	return typeof value === "string";
}
//#endregion
//#region src/core/id.ts
/**
* The longest an opaque identifier or short canonical name may be. Chosen by this
* implementation rather than declared by the SPEC, which is exactly why it is named once
* and interpolated into the refusal: a bare literal repeated at the comparison and again
* in the message lets the two drift, and says nothing about which bound it is.
*/
var MAX_TEXT_VALUE_LENGTH = 256;
var TextId = class TextId {
	#value;
	#type;
	constructor(value, name) {
		if (!isJsonString(value) || value.length === 0 || value.length > MAX_TEXT_VALUE_LENGTH || !hasOnlyUnicodeScalarValues(value)) throw new TypeError(`${name} must contain between 1 and ${MAX_TEXT_VALUE_LENGTH} characters`);
		this.#value = value;
		this.#type = new.target;
	}
	get value() {
		return this.#value;
	}
	equals(other) {
		return other instanceof TextId && #value in other && this.#type === other.#type && this.#value === other.#value;
	}
	toString() {
		return this.#value;
	}
};
//#endregion
//#region src/errors.ts
var AgentCoreError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "AgentCoreError";
	}
};
function invariant(condition, code, message) {
	if (!condition) throw new AgentCoreError(code, message);
}
//#endregion
//#region src/core/canonical.ts
var encoder = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: true });
function encodeCanonicalJson(value) {
	if (!isJsonValue(value)) throw new AgentCoreError("codec.invalid", "Value is not canonical JSON data");
	try {
		return encoder.encode(canonicalString(value));
	} catch (error) {
		if (error instanceof AgentCoreError) throw error;
		throw new AgentCoreError("codec.invalid", `Invalid canonical JSON value: ${error instanceof Error ? error.message : String(error)}`);
	}
}
/**
* An injective textual key for a typed tuple. Canonical JSON preserves component
* boundaries even when a component contains a delimiter or control character.
*/
function canonicalTupleKey(namespace, components) {
	if (namespace.length === 0 || namespace !== namespace.trim()) throw new TypeError("Canonical tuple key namespace must be nonblank");
	return decoder.decode(encodeCanonicalJson([namespace, ...components]));
}
function decodeCanonicalJson(bytes) {
	let source;
	let value;
	try {
		if (!(bytes instanceof Uint8Array)) throw new TypeError("Canonical JSON input must be a Uint8Array");
		source = new Uint8Array(bytes);
		value = JSON.parse(decoder.decode(source));
	} catch (error) {
		throw new AgentCoreError("codec.invalid", `Invalid canonical JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isJsonValue(value)) throw new AgentCoreError("codec.invalid", "Decoded value is not canonical JSON data");
	if (!bytesEqual(source, encodeCanonicalJson(value))) throw new AgentCoreError("codec.invalid", "JSON bytes are not in canonical form");
	return value;
}
/**
* A detached copy of a canonical JSON value, taken by re-encoding and decoding it.
* Callers use this to own data that reached them from somewhere else, so that later
* writes through the original cannot reach the copy.
*/
function canonicalJsonCopy(value) {
	return decodeCanonicalJson(encodeCanonicalJson(value));
}
/** A canonicalJsonCopy that accepts no further writes, at any depth. */
function frozenCanonicalJson(value) {
	return deepFreezeJson(canonicalJsonCopy(value));
}
function deepFreezeJson(value) {
	if (Array.isArray(value)) for (const entry of value) deepFreezeJson(entry);
	else if (isJsonObject(value)) for (const entry of Object.values(value)) deepFreezeJson(entry);
	Object.freeze(value);
	return value;
}
function canonicalString(value) {
	if (value === null || isJsonBoolean(value) || isJsonString(value)) return JSON.stringify(value);
	if (isJsonNumber(value)) {
		if (!Number.isFinite(value)) throw new AgentCoreError("codec.invalid", "Canonical JSON numbers must be finite");
		return JSON.stringify(Object.is(value, -0) ? 0 : value);
	}
	if (isJsonArray(value)) return `[${value.map(canonicalString).join(",")}]`;
	return `{${Object.entries(value).sort(([left], [right]) => compareCanonicalText(left, right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalString(entry)}`).join(",")}}`;
}
/** Orders text by ECMAScript UTF-16 code units, independent of host locale and ICU data. */
function compareCanonicalText(left, right) {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
/** Equality by canonical bytes: the only sound way to compare two JSON values. */
function canonicalJsonEqual(left, right) {
	return bytesEqual(encodeCanonicalJson(left), encodeCanonicalJson(right));
}
function bytesEqual(left, right) {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
	return true;
}
//#endregion
//#region src/core/base64.ts
var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function encodeBase64(bytes) {
	if (!(bytes instanceof Uint8Array)) throw new TypeError("Base64 input must be a Uint8Array");
	const source = new Uint8Array(bytes);
	let encoded = "";
	for (let index = 0; index < source.length; index += 3) {
		const first = source[index];
		const second = source[index + 1];
		const third = source[index + 2];
		const bits = first << 16 | (second ?? 0) << 8 | (third ?? 0);
		encoded += alphabet[bits >>> 18 & 63];
		encoded += alphabet[bits >>> 12 & 63];
		encoded += second === void 0 ? "=" : alphabet[bits >>> 6 & 63];
		encoded += third === void 0 ? "=" : alphabet[bits & 63];
	}
	return encoded;
}
function decodeBase64(value) {
	if (!isJsonString(value) || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new TypeError("Base64 value must use canonical RFC 4648 encoding");
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	const decoded = new Uint8Array(value.length / 4 * 3 - padding);
	let output = 0;
	for (let index = 0; index < value.length; index += 4) {
		const first = decodeDigit(value[index]);
		const second = decodeDigit(value[index + 1]);
		const third = value[index + 2] === "=" ? 0 : decodeDigit(value[index + 2]);
		const fourth = value[index + 3] === "=" ? 0 : decodeDigit(value[index + 3]);
		const bits = first << 18 | second << 12 | third << 6 | fourth;
		decoded[output] = bits >>> 16 & 255;
		output += 1;
		if (output < decoded.length) {
			decoded[output] = bits >>> 8 & 255;
			output += 1;
		}
		if (output < decoded.length) {
			decoded[output] = bits & 255;
			output += 1;
		}
	}
	if (encodeBase64(decoded) !== value) throw new TypeError("Base64 value must use canonical RFC 4648 encoding");
	return decoded;
}
function decodeDigit(value) {
	const digit = alphabet.indexOf(value);
	if (digit < 0) throw new TypeError("Base64 value contains an invalid digit");
	return digit;
}
//#endregion
//#region src/core/digest.ts
var Digest = class Digest extends TextId {
	algorithm;
	constructor(value, algorithm = "sha256") {
		super(value, "Digest");
		if (algorithm !== "sha256") throw new TypeError("Digest algorithm must be sha256");
		if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError("Digest must be a lowercase SHA-256 hexadecimal value");
		this.algorithm = algorithm;
		Object.freeze(this);
	}
	static sha256(bytes) {
		requireDigestBytes(bytes);
		return new Digest(createHash("sha256").update(new Uint8Array(bytes)).digest("hex"));
	}
};
function requireDigestBytes(bytes) {
	if (!(bytes instanceof Uint8Array)) throw new TypeError("Digest input must be a Uint8Array");
}
//#endregion
//#region src/core/content-ref.ts
var CONTENT_REF_PATTERN = /^sha256:([a-f0-9]{64})$/;
var ContentRef = class ContentRef extends TextId {
	digest;
	constructor(value) {
		super(value, "Content reference");
		const match = CONTENT_REF_PATTERN.exec(value);
		if (match === null) throw new TypeError("Content reference must be a SHA-256 content address");
		this.digest = new Digest(match[1]);
		Object.freeze(this);
	}
	static fromDigest(digest) {
		requireDigest(digest);
		return new ContentRef(`${digest.algorithm}:${digest.value}`);
	}
};
function requireDigest(digest) {
	if (!(digest instanceof Digest)) throw new TypeError("Content reference digest must be a Digest");
}
/**
* The projection helper every record-adjacent retention function is written through. An
* absent optional ContentRef contributes no field rather than an empty one, so a record that
* names nothing yields no owner edge at all.
*/
function contentRetentionFields(fields) {
	return Object.freeze(fields.flatMap(([field, ref]) => ref === void 0 ? [] : [Object.freeze({
		field,
		ref
	})]));
}
//#endregion
//#region src/core/revision.ts
var exactRevisions = /* @__PURE__ */ new WeakSet();
var Revision = class Revision {
	#value;
	constructor(value) {
		if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Revision must be a non-negative safe integer");
		this.#value = value;
		if (new.target === Revision) exactRevisions.add(this);
		Object.freeze(this);
	}
	static isExact(value) {
		return value !== null && typeof value === "object" && exactRevisions.has(value);
	}
	static initial() {
		return new Revision(0);
	}
	get value() {
		return this.#value;
	}
	next() {
		if (this.#value === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("protocol.revision-conflict", "Revision cannot exceed the maximum safe integer");
		return new Revision(this.#value + 1);
	}
	equals(other) {
		return Revision.isExact(other) && this.#value === other.#value;
	}
};
//#endregion
//#region src/core/secret-ref.ts
var MAX_SECRET_COMPONENT_LENGTH = 2048;
var SecretRef = class SecretRef {
	source;
	provider;
	id;
	constructor(source, provider, id) {
		this.source = requireSecretComponent(source, "source");
		this.provider = requireSecretComponent(provider, "provider");
		this.id = requireSecretComponent(id, "id");
		Object.freeze(this);
	}
	equals(other) {
		return other instanceof SecretRef && this.source === other.source && this.provider === other.provider && this.id === other.id;
	}
};
function requireSecretComponent(value, name) {
	if (!isJsonString(value) || value.trim().length === 0 || value.length > MAX_SECRET_COMPONENT_LENGTH || !hasOnlyUnicodeScalarValues(value)) throw new TypeError(`Secret reference ${name} must not be blank or exceed ${MAX_SECRET_COMPONENT_LENGTH} characters`);
	return value;
}
//#endregion
//#region src/core/codec.ts
var functionSource = Function.prototype.toString;
var RecordCodec = class {
	kind;
	version;
	constructor(recordClasses, kind, version) {
		if (!isJsonString(kind) || kind.trim().length === 0 || kind !== kind.trim() || !hasOnlyUnicodeScalarValues(kind)) throw new TypeError("Record codec kind must be a nonblank canonical string");
		this.kind = kind;
		this.version = validateAndDetachVersion(version);
		sealRecordClasses(recordClasses);
		this.#encodePayload = this.encodePayload.bind(this);
		this.#decodePayload = this.decodePayload.bind(this);
		const encode = this.encode.bind(this);
		const decode = this.decode.bind(this);
		Object.defineProperties(this, {
			decode: {
				configurable: false,
				enumerable: false,
				value: (bytes) => decode(bytes),
				writable: false
			},
			encode: {
				configurable: false,
				enumerable: false,
				value: (record) => encode(record),
				writable: false
			},
			kind: {
				configurable: false,
				enumerable: true,
				value: this.kind,
				writable: false
			},
			version: {
				configurable: false,
				enumerable: true,
				value: this.version,
				writable: false
			}
		});
	}
	#decodePayload;
	#encodePayload;
	encode(record) {
		return encodeCanonicalJson({
			kind: this.kind,
			version: {
				major: this.version.major,
				minor: this.version.minor
			},
			payload: this.#encodePayload(record)
		});
	}
	decode(bytes) {
		const value = decodeCanonicalJson(bytes);
		if (!isEnvelope(value)) throw new AgentCoreError("codec.invalid", "Record envelope is malformed");
		if (value.kind !== this.kind) throw new AgentCoreError("codec.invalid", `Expected record kind ${this.kind}`);
		assertCompatibleRecordVersion(this.kind, value.version, this.version);
		const version = Object.freeze({
			major: value.version.major,
			minor: value.version.minor
		});
		try {
			return this.#decodePayload(value.payload, version);
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			if (!(error instanceof TypeError)) throw error;
			const message = error.message;
			throw new AgentCoreError("codec.invalid", `Invalid ${this.kind} record: ${message}`);
		}
	}
};
/**
* The single §8.3 compatibility decision. Every reader — one record's codec and a whole
* record set's declaration alike — asks this one predicate, so a record and the set that
* holds it can never disagree about whether a stored version is readable.
* Both components must already be non-negative safe integers.
*/
function supportsRecordVersion(declared, supported) {
	return declared.major === supported.major && declared.minor <= supported.minor;
}
/**
* Names the refusal `supportsRecordVersion` earned: an unknown major fails as
* codec.unknown-major and an unsupported newer minor fails as codec.invalid, while an
* older minor tolerates read within the major.
*/
function assertCompatibleRecordVersion(subject, declared, supported) {
	if (supportsRecordVersion(declared, supported)) return;
	if (declared.major !== supported.major) throw new AgentCoreError("codec.unknown-major", `Unsupported ${subject} codec major ${declared.major}`);
	throw new AgentCoreError("codec.invalid", `Unsupported ${subject} codec minor ${declared.minor}`);
}
/**
* The §8.3 verdict a reader reaches from a record set's declaration before it decodes any
* record of the set. The decision is total over declarations: the stored set is compatible,
* or it names a kind this reader does not declare, or it names a version this reader's codec
* refuses. There is no fourth answer and no undecided input.
*/
var CodecCompatibility = class {
	static get compatible() {
		return compatibleDeclaration;
	}
};
var CompatibleDeclaration = class extends CodecCompatibility {
	admit(serve) {
		serve();
	}
	requireCompatible() {}
};
var UndeclaredKind = class extends CodecCompatibility {
	kind;
	constructor(kind) {
		super();
		this.kind = kind;
		Object.freeze(this);
	}
	admit() {}
	requireCompatible() {
		throw new AgentCoreError("schema.unreadable", `Record set declares ${this.kind}, which this reader does not declare`);
	}
};
/**
* Only `compatibilityWith` constructs this, and only where `supportsRecordVersion` has
* already refused the pair, so naming the refusal is all that is left to do.
*/
var UnsupportedVersion = class extends CodecCompatibility {
	kind;
	declared;
	supported;
	constructor(kind, declared, supported) {
		super();
		this.kind = kind;
		this.declared = declared;
		this.supported = supported;
		Object.freeze(this);
	}
	admit() {}
	requireCompatible() {
		assertCompatibleRecordVersion(this.kind, this.declared, this.supported);
	}
};
var compatibleDeclaration = Object.freeze(new CompatibleDeclaration());
/**
* The codec versions the records one Actor owns were written under (§8.3). It is
* constituent data of the durable state a store already holds about its Actor, so a reader
* reaches it before it decodes any record of the set, and never a durable plane of its own.
*/
var CodecDeclaration = class CodecDeclaration {
	static get empty() {
		return emptyDeclaration;
	}
	/** The declaration a reader makes of itself, from the codecs it holds. */
	static of(codecs) {
		return new CodecDeclaration([...codecs]);
	}
	/**
	* One declaration over every reader that shares a record set (§8.3). A dispatcher's own
	* records and the records its registered commands write belong to one Actor, so the
	* declaration a reader compares against is their union. Two declarations naming one kind
	* at the same version are the same claim made twice and merge to one entry; naming it at
	* two versions is a wiring fault, because §8.4 rule 1 gives each record type exactly one
	* owning Actor and therefore exactly one writer's version.
	*/
	static merge(declarations) {
		const byKind = /* @__PURE__ */ new Map();
		for (const declaration of declarations) for (const entry of requireExactDeclaration(declaration).declared) {
			const existing = byKind.get(entry.kind);
			if (existing === void 0) {
				byKind.set(entry.kind, entry);
				continue;
			}
			if (existing.version.major !== entry.version.major || existing.version.minor !== entry.version.minor) throw new AgentCoreError("codec.invalid", `Codec declaration merges two versions of ${entry.kind}`);
		}
		return new CodecDeclaration([...byKind.values()]);
	}
	declared;
	constructor(declared) {
		this.declared = canonicalDeclared(declared);
		Object.freeze(this);
	}
	static fromData(value) {
		const declared = data.array(value, "Codec declaration");
		try {
			return new CodecDeclaration(declared.map(declaredVersionFromData));
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
			throw new AgentCoreError("codec.invalid", `Invalid Codec declaration: ${error.message}`);
		}
	}
	/**
	* The stable raw form an Actor store carries before it decodes the Actor's record set.
	* It is deliberately NOT `encode`/`decode`: those names mean "through this record's own
	* RecordCodec" everywhere else, and this carrier has no codec on purpose, because a
	* future record codec is exactly what the reader is refusing to understand. Pairs with
	* `toData`/`fromData` on the same value.
	*/
	static toBytes(declaration) {
		return encodeCanonicalJson(requireExactDeclaration(declaration).toData());
	}
	static fromBytes(bytes) {
		return CodecDeclaration.fromData(decodeCanonicalJson(bytes));
	}
	toData() {
		return this.declared.map((entry) => ({
			kind: entry.kind,
			version: {
				major: entry.version.major,
				minor: entry.version.minor
			}
		}));
	}
	versionOf(kind) {
		return this.declared.find((entry) => entry.kind === kind)?.version;
	}
	/**
	* Whether a reader declaring `reader` may serve this stored set. The version question is
	* the one `supportsRecordVersion` already answers, so a record set and a single record
	* never disagree about whether a stored version is readable.
	*/
	compatibilityWith(reader) {
		for (const entry of this.declared) {
			const supported = reader.versionOf(entry.kind);
			if (supported === void 0) return new UndeclaredKind(entry.kind);
			if (!supportsRecordVersion(entry.version, supported)) return new UnsupportedVersion(entry.kind, entry.version, supported);
		}
		return CodecCompatibility.compatible;
	}
	equals(other) {
		return this.declared.length === other.declared.length && this.declared.every((entry, index) => {
			const candidate = other.declared[index];
			return candidate !== void 0 && entry.kind === candidate.kind && entry.version.major === candidate.version.major && entry.version.minor === candidate.version.minor;
		});
	}
};
var emptyDeclaration = new CodecDeclaration([]);
var data = jsonDataParser((message) => new AgentCoreError("codec.invalid", `${message} in a codec declaration`));
/** The carrier writes only an exact CodecDeclaration; a lookalike is a caller wiring fault. */
function requireExactDeclaration(declaration) {
	if (declaration.constructor !== CodecDeclaration) throw new TypeError("Codec declaration encoding requires an exact CodecDeclaration");
	return declaration;
}
function canonicalDeclared(declared) {
	const byKind = /* @__PURE__ */ new Map();
	for (const entry of declared) {
		const kind = entry.kind;
		if (kind.trim().length === 0 || kind !== kind.trim() || !hasOnlyUnicodeScalarValues(kind) || byKind.has(kind)) throw new TypeError("Codec declaration must name distinct nonblank canonical record kinds");
		byKind.set(kind, validateAndDetachVersion(entry.version));
	}
	return Object.freeze([...byKind.entries()].sort(([left], [right]) => compareCanonicalText(left, right)).map(([kind, version]) => Object.freeze({
		kind,
		version
	})));
}
function declaredVersionFromData(entry) {
	const object = data.exact(data.object(entry, "Declared codec version"), ["kind", "version"], "Declared codec version");
	const version = data.exact(data.object(object["version"], "Declared codec version"), ["major", "minor"], "Declared codec version");
	return {
		kind: data.nonemptyString(object["kind"], "Declared codec kind"),
		version: {
			major: data.safeInteger(version["major"], "Declared codec major"),
			minor: data.safeInteger(version["minor"], "Declared codec minor")
		}
	};
}
function sealRecordClasses(recordClasses) {
	const classes = validateAndDetachRecordClasses(recordClasses);
	for (const recordClass of classes) {
		Object.freeze(recordClass.prototype);
		Object.freeze(recordClass);
	}
}
function validateAndDetachRecordClasses(recordClasses) {
	if (!Array.isArray(recordClasses) || Object.getPrototypeOf(recordClasses) !== Array.prototype || recordClasses.length === 0 || Reflect.ownKeys(recordClasses).length !== recordClasses.length + 1) throw new TypeError("Record codec must name a nonempty ordinary class tuple");
	const detached = [];
	for (let index = 0; index < recordClasses.length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(recordClasses, index);
		const candidate = descriptor?.value;
		if (descriptor === void 0 || !("value" in descriptor) || !descriptor.enumerable || !isOrdinaryRecordClass(candidate)) throw new TypeError("Record codec classes must be ordinary class constructors");
		if (!detached.includes(candidate)) detached.push(candidate);
	}
	return Object.freeze(detached);
}
function isOrdinaryRecordClass(value) {
	if (typeof value !== "function") return false;
	if (!functionSource.call(value).startsWith("class")) return false;
	const prototype = Object.getOwnPropertyDescriptor(value, "prototype")?.value;
	if (!isObjectPrototype(prototype)) return false;
	const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor");
	return constructor !== void 0 && "value" in constructor && constructor.value === value;
}
function isObjectPrototype(value) {
	return typeof value === "object" && value !== null;
}
function isEnvelope(value) {
	if (!isJsonObject(value)) return false;
	const version = value["version"];
	return hasExactJsonKeys(value, [
		"kind",
		"payload",
		"version"
	]) && isJsonString(value["kind"]) && isJsonObject(version) && hasExactJsonKeys(version, ["major", "minor"]) && Number.isSafeInteger(version["major"]) && isJsonNumber(version["major"]) && version["major"] >= 0 && Number.isSafeInteger(version["minor"]) && isJsonNumber(version["minor"]) && version["minor"] >= 0 && Object.hasOwn(value, "payload");
}
/** Detaches a caller-supplied version into a frozen pair of non-negative safe integers. */
function validateAndDetachVersion(version) {
	if (!isObjectRecord(version) || Object.getPrototypeOf(version) !== Object.prototype || !hasExactVersionKeys(version)) throw new TypeError("Record codec version must contain non-negative safe integers");
	const majorDescriptor = Object.getOwnPropertyDescriptor(version, "major");
	const minorDescriptor = Object.getOwnPropertyDescriptor(version, "minor");
	if (majorDescriptor === void 0 || minorDescriptor === void 0 || !("value" in majorDescriptor) || !("value" in minorDescriptor) || !majorDescriptor.enumerable || !minorDescriptor.enumerable) throw new TypeError("Record codec version must contain non-negative safe integers");
	const major = majorDescriptor.value;
	const minor = minorDescriptor.value;
	if (!isJsonNumber(major) || !Number.isSafeInteger(major) || major < 0 || !isJsonNumber(minor) || !Number.isSafeInteger(minor) || minor < 0) throw new TypeError("Record codec version must contain non-negative safe integers");
	return Object.freeze({
		major,
		minor
	});
}
function hasExactVersionKeys(version) {
	const keys = Reflect.ownKeys(version);
	return keys.length === 2 && keys.includes("major") && keys.includes("minor");
}
//#endregion
//#region src/core/narrow.ts
function isMember(vocabulary, candidate) {
	return typeof candidate === "string" && vocabulary.includes(candidate);
}
function isNonempty(values) {
	return values.length > 0;
}
/**
* Array.isArray narrows a JsonValue to any[], so a decoder that checks its members
* inline keeps no record of what it proved and has to assert each one back to string.
* Asking this instead carries the answer into the type.
*/
function isStringArray(candidate) {
	return Array.isArray(candidate) && candidate.every((entry) => typeof entry === "string");
}
function requireNonempty(values, subject) {
	if (!isNonempty(values)) throw new TypeError(`${subject} must not be empty`);
	return values;
}
//#endregion
//#region src/core/compat-range.ts
var CompatRangeCodec = class extends RecordCodec {
	constructor() {
		super([CompatRange], "core.compat-range", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(range) {
		return {
			host: range.host,
			spec: range.spec
		};
	}
	decodePayload(payload, _version) {
		if (!isJsonObject(payload) || !hasExactJsonKeys(payload, ["host", "spec"]) || !isJsonString(payload["host"]) || !isJsonString(payload["spec"])) throw new AgentCoreError("codec.invalid", "Compatibility range payload is malformed");
		return new CompatRange(payload["spec"], payload["host"]);
	}
};
var CompatRange = class CompatRange {
	spec;
	host;
	constructor(spec, host) {
		requireRange(spec, "Spec compatibility range");
		requireRange(host, "Host compatibility range");
		this.spec = spec;
		this.host = host;
		Object.freeze(this);
	}
	static any() {
		return anyCompatRange;
	}
	static encode(range) {
		return compatRangeCodec.encode(range);
	}
	static decode(bytes) {
		return compatRangeCodec.decode(bytes);
	}
	equals(other) {
		return other instanceof CompatRange && this.spec === other.spec && this.host === other.host;
	}
};
var compatRangeCodec = new CompatRangeCodec();
function requireRange(value, name) {
	if (!isJsonString(value) || value.trim().length === 0 || value !== value.trim() || !hasOnlyUnicodeScalarValues(value)) throw new TypeError(`${name} must be a nonblank canonical string`);
}
var anyCompatRange = new CompatRange("*", "*");
//#endregion
//#region src/core/semver.ts
var SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
var SemVerCodec = class extends RecordCodec {
	constructor() {
		super([SemVer], "core.semver", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(version) {
		return { value: version.toString() };
	}
	decodePayload(payload, _version) {
		if (!isJsonObject(payload) || !hasExactJsonKeys(payload, ["value"]) || !isJsonString(payload["value"])) throw new AgentCoreError("codec.invalid", "Semantic version payload is malformed");
		return new SemVer(payload["value"]);
	}
};
var SemVer = class SemVer {
	major;
	minor;
	patch;
	prerelease;
	build;
	constructor(...args) {
		const [valueOrMajor, minor, patch, prerelease = [], build = []] = args;
		const value = isJsonString(valueOrMajor) ? parseSemVer(valueOrMajor) : parseSemVer(validateAndFormatSemVer(valueOrMajor, minor, patch, prerelease, build));
		this.major = value.major;
		this.minor = value.minor;
		this.patch = value.patch;
		this.prerelease = Object.freeze([...value.prerelease]);
		this.build = Object.freeze([...value.build]);
		Object.freeze(this);
	}
	static parse(value) {
		if (!isJsonString(value)) throw new TypeError("Semantic version must follow SemVer 2.0.0");
		return new SemVer(value);
	}
	static encode(version) {
		return semVerCodec.encode(version);
	}
	static decode(bytes) {
		return semVerCodec.decode(bytes);
	}
	compare(other) {
		return compareNumber(this.major, other.major) || compareNumber(this.minor, other.minor) || compareNumber(this.patch, other.patch) || comparePrerelease(this.prerelease, other.prerelease);
	}
	equals(other) {
		return other instanceof SemVer && this.toString() === other.toString();
	}
	toString() {
		const prerelease = this.prerelease.length === 0 ? "" : `-${this.prerelease.join(".")}`;
		const build = this.build.length === 0 ? "" : `+${this.build.join(".")}`;
		return `${this.major}.${this.minor}.${this.patch}${prerelease}${build}`;
	}
};
var semVerCodec = new SemVerCodec();
function parseSemVer(value) {
	const match = SEMVER_PATTERN.exec(value);
	if (match === null) throw new TypeError("Semantic version must follow SemVer 2.0.0");
	return {
		major: requireSafeComponent(match[1], "major"),
		minor: requireSafeComponent(match[2], "minor"),
		patch: requireSafeComponent(match[3], "patch"),
		prerelease: match[4] === void 0 ? [] : match[4].split("."),
		build: match[5] === void 0 ? [] : match[5].split(".")
	};
}
function validateAndFormatSemVer(major, minor, patch, prerelease, build) {
	if (minor === void 0 || patch === void 0) throw new TypeError("Semantic version requires major, minor, and patch components");
	for (const [name, component] of [
		["major", major],
		["minor", minor],
		["patch", patch]
	]) if (!Number.isSafeInteger(component) || component < 0) throw new TypeError(`Semantic version ${name} must be a non-negative safe integer`);
	const prereleaseIdentifiers = copyIdentifiers(prerelease);
	const buildIdentifiers = copyIdentifiers(build);
	return `${major}.${minor}.${patch}${prereleaseIdentifiers.length === 0 ? "" : `-${prereleaseIdentifiers.join(".")}`}${buildIdentifiers.length === 0 ? "" : `+${buildIdentifiers.join(".")}`}`;
}
function copyIdentifiers(value) {
	if (!Array.isArray(value) || value.some((identifier) => typeof identifier !== "string")) throw new TypeError("Semantic version identifiers must be string arrays");
	return [...value];
}
function requireSafeComponent(value, name) {
	const component = Number(value);
	if (!Number.isSafeInteger(component)) throw new TypeError(`Semantic version ${name} exceeds the maximum safe integer`);
	return component;
}
function compareNumber(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}
function comparePrerelease(left, right) {
	if (left.length === 0 || right.length === 0) return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const leftPart = left[index];
		const rightPart = right[index];
		if (leftPart === void 0 || rightPart === void 0) return leftPart === rightPart ? 0 : leftPart === void 0 ? -1 : 1;
		if (leftPart === rightPart) continue;
		const leftNumeric = /^\d+$/.test(leftPart);
		const rightNumeric = /^\d+$/.test(rightPart);
		if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftPart, rightPart);
		if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
		return leftPart < rightPart ? -1 : 1;
	}
	return 0;
}
function compareNumericIdentifier(left, right) {
	return compareNumber(left.length, right.length) || (left < right ? -1 : left > right ? 1 : 0);
}
//#endregion
//#region src/core/schema.ts
var JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
var SUPPORTED_FORMATS = /* @__PURE__ */ new Set(["uri"]);
var StrictJsonSchemaValidator = class StrictJsonSchemaValidator {
	static #compiledLimit = 512;
	#compiled = /* @__PURE__ */ new Map();
	assertSchema(schema) {
		this.validateAndCompile(schema);
	}
	assertSupportedSchema(schema) {
		assertSupportedSchema(frozenCanonicalJson(schema));
	}
	validate(schema, value) {
		return this.validateAndCompile(schema)(frozenCanonicalJson(value));
	}
	validateAndCompile(schema) {
		const canonical = frozenCanonicalJson(schema);
		const key = new TextDecoder().decode(encodeCanonicalJson(canonical));
		const memoized = this.#compiled.get(key);
		if (memoized !== void 0) return memoized;
		assertSupportedSchema(canonical);
		let compiled;
		try {
			compiled = createAjv().compile(canonical);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new TypeError(`Unsupported JSON Schema: ${message}`);
		}
		if (this.#compiled.size >= StrictJsonSchemaValidator.#compiledLimit) {
			const oldest = this.#compiled.keys().next().value;
			if (oldest !== void 0) this.#compiled.delete(oldest);
		}
		this.#compiled.set(key, compiled);
		return compiled;
	}
};
var strictJsonSchemaValidator = new StrictJsonSchemaValidator();
var JsonSchemaCodec = class extends RecordCodec {
	constructor() {
		super([JsonSchema], "core.json-schema", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(schema) {
		return { document: schema.document };
	}
	decodePayload(payload, _version) {
		if (!isJsonObject(payload) || !hasExactJsonKeys(payload, ["document"])) throw new AgentCoreError("codec.invalid", "JSON Schema payload is malformed");
		const document = payload["document"];
		if (!isSchemaDocument(document)) throw new AgentCoreError("codec.invalid", "JSON Schema document must be an object or boolean");
		return new JsonSchema(document);
	}
};
var JsonSchema = class {
	document;
	constructor(document) {
		if (!isSchemaDocument(document)) throw new TypeError("JSON Schema document must be canonical JSON object or boolean data");
		this.document = frozenCanonicalJson(document);
		Object.freeze(this);
	}
	static any() {
		return anyJsonSchema;
	}
	static encode(schema) {
		return jsonSchemaCodec.encode(schema);
	}
	static decode(bytes) {
		return jsonSchemaCodec.decode(bytes);
	}
	accepts(value, validator = strictJsonSchemaValidator) {
		if (!isJsonValue(value) || !strictJsonSchemaValidator.validate(this.document, value)) return false;
		if (validator === strictJsonSchemaValidator) return true;
		const candidate = canonicalJsonCopy(value);
		const before = encodeCanonicalJson(candidate);
		let accepted;
		try {
			accepted = validator.validate(this.document, candidate);
		} catch (error) {
			requireUnchanged(candidate, before);
			throw error;
		}
		requireUnchanged(candidate, before);
		requireValidationResult(accepted);
		return accepted;
	}
	assertValid() {
		strictJsonSchemaValidator.assertSchema(this.document);
	}
	/**
	* The structural subset of assertValid: rejects unsupported dialects, references,
	* and formats without compiling. Declaration-time checks on first-party schemas
	* use this so module initialization stays within substrate startup CPU limits;
	* compilation still asserts the full schema on first validation.
	*/
	assertSupported() {
		strictJsonSchemaValidator.assertSupportedSchema(this.document);
	}
};
var jsonSchemaCodec = new JsonSchemaCodec();
function isSchemaDocument(value) {
	return isJsonBoolean(value) || isJsonValue(value) && isJsonObject(value);
}
var anyJsonSchema = new JsonSchema({});
function assertSupportedSchema(schema) {
	const resources = /* @__PURE__ */ new Set();
	visitSchemas(schema, void 0, (_value, base) => {
		if (base !== void 0) resources.add(withoutFragment(base));
	});
	visitSchemas(schema, void 0, (value, base) => {
		const dialect = ownValue(value, "$schema");
		if (dialect !== void 0 && dialect !== JSON_SCHEMA_2020_12) throw new TypeError("Only JSON Schema 2020-12 is supported");
		if (Object.hasOwn(value, "$async")) throw new TypeError("Asynchronous JSON Schema validation is not supported");
		if (Object.hasOwn(value, "$recursiveRef")) throw new TypeError("$recursiveRef is not supported by JSON Schema 2020-12");
		requireLocalReference(ownValue(value, "$ref"), base, resources, "$ref");
		requireDynamicReference(ownValue(value, "$dynamicRef"));
		const format = ownValue(value, "format");
		if (isJsonString(format) && !SUPPORTED_FORMATS.has(format)) throw new TypeError(`Unsupported JSON Schema format: ${format}`);
	});
}
function visitSchemas(value, inheritedBase, inspect) {
	if (!isJsonObject(value)) return;
	const base = resolveIdentifier(ownValue(value, "$id"), inheritedBase) ?? inheritedBase;
	inspect(value, base);
	for (const keyword of SCHEMA_KEYWORDS) visitSchemaValue(ownValue(value, keyword), base, inspect);
	for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
		const children = ownValue(value, keyword);
		if (!Array.isArray(children)) continue;
		for (const child of children) visitSchemaValue(child, base, inspect);
	}
	for (const keyword of SCHEMA_MAP_KEYWORDS) {
		const children = ownValue(value, keyword);
		if (!isJsonObject(children)) continue;
		for (const child of Object.values(children)) visitSchemaValue(child, base, inspect);
	}
}
function visitSchemaValue(value, base, inspect) {
	if (isJsonBoolean(value) || isJsonObject(value)) visitSchemas(value, base, inspect);
}
function resolveIdentifier(value, base) {
	if (!isJsonString(value)) return void 0;
	try {
		return new URL(value, base).href;
	} catch {
		return;
	}
}
function requireLocalReference(value, base, resources, keyword) {
	if (!isJsonString(value) || value.startsWith("#")) return;
	const resolved = resolveIdentifier(value, base);
	if (resolved === void 0 || !resources.has(withoutFragment(resolved))) throw new TypeError(`Remote JSON Schema reference is not supported: ${keyword} ${value}`);
}
function requireDynamicReference(value) {
	if (isJsonString(value) && !value.startsWith("#")) throw new TypeError(`Remote JSON Schema reference is not supported: $dynamicRef ${value}`);
}
function withoutFragment(value) {
	const index = value.indexOf("#");
	return index === -1 ? value : value.slice(0, index);
}
function ownValue(value, key) {
	return Object.hasOwn(value, key) ? value[key] : void 0;
}
function requireUnchanged(value, expected) {
	let unchanged = false;
	try {
		const actual = encodeCanonicalJson(value);
		unchanged = actual.byteLength === expected.byteLength && actual.every((entry, index) => entry === expected[index]);
	} catch {
		unchanged = false;
	}
	if (!unchanged) throw new TypeError("Injected JSON Schema validators must not mutate input");
}
function requireValidationResult(value) {
	if (typeof value !== "boolean") throw new TypeError("Injected JSON Schema validators must return a boolean synchronously");
}
function createAjv() {
	const ajv = new Ajv2020(Object.assign(Object.create(null), {
		addUsedSchema: false,
		allErrors: false,
		coerceTypes: false,
		logger: false,
		ownProperties: true,
		removeAdditional: false,
		strict: true,
		strictSchema: true,
		strictTypes: false,
		useDefaults: false,
		validateFormats: true
	}));
	ajv.addFormat("uri", fullFormats.uri);
	return ajv;
}
var SCHEMA_KEYWORDS = [
	"additionalProperties",
	"contains",
	"contentSchema",
	"else",
	"if",
	"items",
	"not",
	"propertyNames",
	"then",
	"unevaluatedItems",
	"unevaluatedProperties"
];
var SCHEMA_ARRAY_KEYWORDS = [
	"allOf",
	"anyOf",
	"oneOf",
	"prefixItems"
];
var SCHEMA_MAP_KEYWORDS = [
	"$defs",
	"dependentSchemas",
	"patternProperties",
	"properties"
];
//#endregion
export { invariant as A, canonicalJsonEqual as C, encodeCanonicalJson as D, decodeCanonicalJson as E, isJsonString as F, isJsonValue as I, isObjectRecord as L, hasExactJsonKeys as M, hasExactKeys as N, frozenCanonicalJson as O, isJsonObject as P, jsonDataParser as R, canonicalJsonCopy as S, compareCanonicalText as T, ContentRef as _, CompatRange as a, decodeBase64 as b, isStringArray as c, CodecDeclaration as d, RecordCodec as f, Revision as g, SecretRef as h, SemVer as i, TextId as j, AgentCoreError as k, requireNonempty as l, supportsRecordVersion as m, StrictJsonSchemaValidator as n, isMember as o, assertCompatibleRecordVersion as p, strictJsonSchemaValidator as r, isNonempty as s, JsonSchema as t, CodecCompatibility as u, contentRetentionFields as v, canonicalTupleKey as w, encodeBase64 as x, Digest as y };

//# sourceMappingURL=core-BjYGo1CC.js.map