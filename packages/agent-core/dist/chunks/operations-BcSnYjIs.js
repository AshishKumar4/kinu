import { D as encodeCanonicalJson, L as isObjectRecord, P as isJsonObject, T as compareCanonicalText, j as TextId, k as AgentCoreError, w as canonicalTupleKey, y as Digest } from "./core-BjYGo1CC.js";
import { o as requireSynchronousResult } from "./actors-DJsP1nFM.js";
import { Ct as isString, Dt as requireDataObject, G as OperationDescriptor, J as CapabilitySpec, K as SurfaceDescriptor, Q as AuthoredCodeSource, R as FacetManifest, St as isNumber, at as FacetPackageId, d as InterceptorDeclaration, et as requireAuthoredCodeConsumer, f as Command, gt as canonicalFacetData, jt as requireString, m as commandInvocationSource, nt as BindingName, ot as FacetRef, p as commandAutomation, pt as SlotName, r as Operation } from "./runtime-z1yMP0an.js";
import { d as schema, f as strictObjectSchema } from "./facets-D01bKQBL.js";
//#region src/operations/interception.ts
var OperationInterceptorRunner = class {
	host;
	authority;
	constructor(host, authority) {
		this.host = host;
		this.authority = authority;
	}
	hasApplicable(resolution, target, operation) {
		return this.candidates("operation.before", resolution, target, operation).length > 0 || this.candidates("operation.after", resolution, target, operation).length > 0;
	}
	run(cutPoint, resolution, target, operation, itemIndex, input) {
		let value = canonicalFacetData(input);
		const traces = [];
		for (const candidate of this.candidates(cutPoint, resolution, target, operation)) {
			const before = Digest.sha256(encodeCanonicalJson(value));
			const context = Object.freeze({
				cutPoint,
				operation: operation.descriptor,
				target: target.ref,
				interceptor: candidate.declaration
			});
			let result;
			try {
				result = requireSynchronousResult(candidate.interceptor.intercept(context, value));
			} catch (error) {
				const detail = error instanceof Error ? error.message : "unknown interceptor failure";
				throw blocked(candidate.declaration, detail);
			}
			if (!isInterceptResult(result)) throw blocked(candidate.declaration, "Interceptor returned an invalid result");
			if (!result.proceed) throw new AgentCoreError("authority.denied", result.reason);
			const next = canonicalFacetData(result.value);
			const after = Digest.sha256(encodeCanonicalJson(next));
			if (candidate.declaration.mode === "gate" && !before.equals(after)) throw blocked(candidate.declaration, "A gate interceptor rewrote the value in flight");
			traces.push(Object.freeze({
				interceptor: candidate.declaration.id.value,
				contributor: candidate.facet.ref.value,
				itemIndex,
				cutPoint,
				before,
				after,
				outcome: before.equals(after) ? "unchanged" : "rewritten"
			}));
			value = next;
		}
		return Object.freeze({
			value,
			traces: Object.freeze(traces)
		});
	}
	candidates(cutPoint, resolution, target, operation) {
		const candidates = [];
		const domain = this.authority.cutPointDomain(resolution);
		for (const facet of this.host.facets()) for (const value of facet.manifest.contributions.get(interceptorSlot$1) ?? []) {
			const declaration = InterceptorDeclaration.fromData(value);
			if (declaration.cutPoint !== cutPoint || !matches(declaration.appliesTo.patterns, facet, target, operation)) continue;
			requireSameDomain(domain, this.authority.contributorDomain(facet.ref), declaration);
			if (!facet.ref.equals(target.ref)) {
				if (operation.descriptor.interceptable === void 0) throw new AgentCoreError("authority.denied", `Operation ${operation.descriptor.name.value} is not interceptable`);
				if (!this.authority.allowsInterception(resolution, facet.ref, declaration, target.ref, operation.descriptor)) throw new AgentCoreError("authority.denied", `Interceptor ${declaration.id.value} lacks target authority`);
			}
			const interceptor = facet.interceptor(declaration.id);
			if (interceptor === void 0) throw new AgentCoreError("facet.inactive", `Interceptor ${declaration.id.value} is no longer active`);
			candidates.push({
				facet,
				declaration,
				interceptor
			});
		}
		return orderSchedule(candidates);
	}
};
/**
* The seam the executor reaches the Turn-bound cut points through (SPEC §4.4, §5.6). It is
* value-agnostic on purpose: the records a prompt section or a step context is made of
* belong to the execution layer, so the projection to and from `FacetData` stays there and
* this port carries only the schedule.
*/
var TurnCutPointPort = class {};
var TurnInterceptorRunner = class extends TurnCutPointPort {
	host;
	domains;
	constructor(host, domains) {
		super();
		this.host = host;
		this.domains = domains;
	}
	run(cutPoint, turn, input, admit) {
		let value = canonicalFacetData(input);
		const traces = [];
		for (const candidate of this.candidates(cutPoint, turn)) {
			const before = Digest.sha256(encodeCanonicalJson(value));
			const context = Object.freeze({
				cutPoint,
				turn,
				interceptor: candidate.declaration
			});
			let result;
			try {
				result = requireSynchronousResult(candidate.interceptor.intercept(context, value));
			} catch (error) {
				const detail = error instanceof Error ? error.message : "unknown interceptor failure";
				throw turnBlocked(candidate.declaration, cutPoint, detail);
			}
			if (!isInterceptResult(result)) throw turnBlocked(candidate.declaration, cutPoint, "Interceptor returned an invalid result");
			if (!result.proceed) {
				if (cutPoint !== "turn.step") throw new AgentCoreError("authority.denied", result.reason);
				return Object.freeze({
					value,
					traces: Object.freeze(traces),
					stop: Object.freeze({
						interceptor: candidate.declaration.id.value,
						contributor: candidate.facet.ref.value,
						reason: result.reason
					})
				});
			}
			const next = canonicalFacetData(result.value);
			const after = Digest.sha256(encodeCanonicalJson(next));
			if (candidate.declaration.mode === "gate" && !before.equals(after)) throw turnBlocked(candidate.declaration, cutPoint, "A gate interceptor rewrote the value in flight");
			try {
				admit(value, next, candidate.declaration);
			} catch (error) {
				const detail = error instanceof Error ? error.message : "invalid rewrite";
				throw turnBlocked(candidate.declaration, cutPoint, detail);
			}
			traces.push(Object.freeze({
				interceptor: candidate.declaration.id.value,
				contributor: candidate.facet.ref.value,
				cutPoint,
				before,
				after,
				outcome: before.equals(after) ? "unchanged" : "rewritten"
			}));
			value = next;
		}
		return Object.freeze({
			value,
			traces: Object.freeze(traces),
			stop: void 0
		});
	}
	candidates(cutPoint, turn) {
		const domain = this.domains.turnDomain(turn);
		const candidates = [];
		for (const facet of this.host.facets()) for (const value of facet.manifest.contributions.get(interceptorSlot$1) ?? []) {
			const declaration = InterceptorDeclaration.fromData(value);
			if (declaration.cutPoint !== cutPoint) continue;
			requireSameDomain(domain, this.domains.contributorDomain(facet.ref), declaration);
			const interceptor = facet.interceptor(declaration.id);
			if (interceptor === void 0) throw new AgentCoreError("facet.inactive", `Interceptor ${declaration.id.value} is no longer active`);
			candidates.push({
				facet,
				declaration,
				interceptor
			});
		}
		return orderSchedule(candidates);
	}
};
function matches(patterns, contributor, target, operation) {
	return patterns.some((pattern) => {
		return (pattern.facet === void 0 ? contributor.ref.equals(target.ref) : prefixMatches(pattern.facet.value, target.manifest.id.value)) && prefixMatches(pattern.operation, operation.descriptor.name.value);
	});
}
function prefixMatches(pattern, value) {
	return pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}
function isInterceptResult(value) {
	return isObjectRecord(value) && (value["proceed"] === true || value["proceed"] === false);
}
function blocked(declaration, detail) {
	return new AgentCoreError("authority.denied", `Interceptor ${declaration.id.value} blocked the operation: ${detail}`);
}
function turnBlocked(declaration, cutPoint, detail) {
	return new AgentCoreError("authority.denied", `Interceptor ${declaration.id.value} blocked ${cutPoint}: ${detail}`);
}
/**
* SPEC §4.4 rule 3's total order, realized once for every cut point. The banded key is
* ascending `(mode, priority, facetId, interceptorId)`, and `mode` dominates: sharing one
* cut point between independently authored Facets does not mean sharing a numeric scale,
* so a later contributor's priority must not be able to reorder a semantic decision. One
* implementation is what makes the Turn-bound cut points ordered by the same relation the
* operation ones are rather than by a second one that agrees today.
*/
function orderSchedule(candidates) {
	return candidates.sort((left, right) => left.declaration.modeRank - right.declaration.modeRank || left.declaration.priority - right.declaration.priority || compareCanonicalText(left.facet.manifest.id.value, right.facet.manifest.id.value) || compareCanonicalText(left.declaration.id.value, right.declaration.id.value));
}
/**
* SPEC §4.4 rule 1: an Interceptor is a synchronous in-process hook, so it may only
* run where its contributing Facet's own code runs. A contributor placed in another
* protection domain — `provider` behind a stub, `dynamic` in a fresh isolate — has
* nothing in this process to call, and reaching whatever the stub exposes would run
* the wrong code inside the cut point's domain. The refusal is not an authority
* answer: rule 2 makes sharing a domain confer no interception rights, and holding
* a Grant confers no domain, so the two are decided separately. Crossing a domain
* is what asynchronous Events are for.
*
* Skipping instead of refusing would silently drop a veto the platform declared,
* which is the one failure this hook exists to prevent.
*/
function requireSameDomain(domain, contributed, declaration) {
	if (contributed === void 0 || !contributed.equals(domain)) throw new AgentCoreError("authority.denied", `Interceptor ${declaration.id.value} is contributed from another protection domain`);
}
var interceptorSlot$1 = new SlotName("interceptors");
//#endregion
//#region src/operations/gateway.ts
var OperationRequestKey = class extends TextId {
	constructor(value) {
		super(value, "Operation request key");
		Object.freeze(this);
	}
};
var OperationGateway = class {};
var ResolvedFacet = class {};
var OperationGatewayHost = class extends OperationGateway {
	caller;
	host;
	authority;
	invocations;
	#interceptors;
	constructor(caller, host, authority, invocations) {
		super();
		this.caller = caller;
		this.host = host;
		this.authority = authority;
		this.invocations = invocations;
		this.#interceptors = new OperationInterceptorRunner(host, authority);
	}
	async resolve(binding) {
		return this.resolveProtected(binding);
	}
	/**
	* Admits one item of a mediated dispatch and detaches its execution (SPEC §5.6).
	*
	* It reaches the item through exactly the assembly `dispatch` reaches an effect through —
	* one authority resolution, one tier decision, one interceptor pass, one preflight — and
	* differs only in the last step: the Invocation plane records the item's admission and
	* runs nothing. The admission is returned rather than handed to a callback, because the
	* caller publishes it and a handle nobody received is an admitted item no Run ever holds.
	*
	* The resolution is released here rather than by the caller: a detached admission is one
	* shot with no dispatch to follow, so nothing outlives this call to dispose.
	*/
	async admitDetached(binding, request, itemIndex, admissions) {
		const resolved = await this.resolveProtected(binding);
		try {
			return await resolved.admitDetached(request, itemIndex, admissions);
		} finally {
			resolved[Symbol.dispose]();
		}
	}
	/**
	* The one resolution both entries are built from. `resolve` widens it to the contract a
	* caller holds, while the detached admission needs the concrete facet: its entry is not on
	* `ResolvedFacet`, because that contract cannot name this host's authorization type and a
	* seam that erased it would admit a port belonging to another authority plane.
	*/
	async resolveProtected(binding) {
		const resolved = await this.authority.resolve(this.caller, binding);
		const facet = this.host.facet(resolved.facet);
		if (facet === void 0) {
			this.authority.release(resolved.resolution);
			throw inactive$1(`Binding ${binding.value} targets an inactive Facet`);
		}
		return new ProtectedResolvedFacet(facet, resolved.resolution, this.host, this.authority, this.invocations, this.#interceptors);
	}
};
var ProtectedResolvedFacet = class extends ResolvedFacet {
	runtime;
	resolution;
	host;
	authority;
	invocations;
	interceptors;
	#disposed = false;
	#inFlight = 0;
	#releasePending = false;
	constructor(runtime, resolution, host, authority, invocations, interceptors) {
		super();
		this.runtime = runtime;
		this.resolution = resolution;
		this.host = host;
		this.authority = authority;
		this.invocations = invocations;
		this.interceptors = interceptors;
	}
	get facet() {
		return this.runtime.ref;
	}
	get package() {
		return this.runtime.manifest.id;
	}
	descriptor(name) {
		return this.declaredOperation(name)?.descriptor;
	}
	async dispatch(request) {
		return this.underLease(() => this.dispatchWithLease(request));
	}
	/**
	* Admits one item of this dispatch and leaves its execution to the Invocation plane
	* (SPEC §5.6, C13-TURN-HANDLE-DETACHMENT).
	*
	* The steps before the effect are not repeated here: this is the same composition
	* `dispatch` runs, stopped one step earlier. Only the last step differs, and the
	* difference is the whole point — the item's admission becomes durable while the effect
	* has not happened, which is the fact a §5.6 handle names and the one a Receipt cannot
	* state.
	*/
	async admitDetached(request, itemIndex, admissions) {
		return this.underLease(() => this.dispatchWithLease(request, Object.freeze({
			itemIndex,
			admissions
		})));
	}
	/**
	* Holds the Facet runtime for the duration of one call, so a withdrawal drains rather
	* than cutting an in-flight dispatch, and releases the authority resolution once the last
	* in-flight call of a disposed facet has returned (§4.1, C13-FACET-DISPOSAL).
	*/
	async underLease(work) {
		this.requireActive();
		const lease = this.host.acquire(this.runtime.ref, this.runtime);
		if (lease === void 0) throw inactive$1("Resolved Facet is no longer active");
		this.#inFlight += 1;
		try {
			return await work();
		} finally {
			lease.release();
			this.#inFlight -= 1;
			if (this.#inFlight === 0 && this.#releasePending) this.releaseAuthority();
		}
	}
	async dispatchWithLease(request, detachment) {
		const operation = this.declaredOperation(request.operation);
		if (operation === void 0) throw new AgentCoreError("operation.missing", `Operation ${request.operation.value} is not declared`);
		const payload = operationPayload(request.payload);
		const inputs = payload.items.map((item) => this.validateInput(operation, item));
		const selected = this.authority.tier(this.resolution, operation.descriptor, this.interceptors.hasApplicable(this.resolution, this.runtime, operation));
		if (detachment !== void 0) requireDetachableItem(detachment.itemIndex, payload, selected);
		if (selected === "direct") {
			const prepared = inputs.map((item, itemIndex) => this.prepare(operation, item, itemIndex));
			const authorization = this.authority.authorizeDirect(this.resolution, operation.descriptor, prepared.map((item) => item.value));
			if (authorization === void 0) throw new AgentCoreError("authority.denied", "Direct operation denied");
			this.invocations.recordDirectInterceptions(interceptionEvidence(request, this.runtime, operation, payload.cardinality, prepared.map((item) => item.traces)));
			const executions = prepared.map((item, itemIndex) => executeOperation(operation, this.invocations.directContext(request.requestKey, itemIndex, payload.cardinality, authorization), item.value));
			const outputs = (await Promise.all(executions)).map((output, itemIndex) => this.present(operation, output, itemIndex));
			const value = payload.cardinality.kind === "single" ? outputs[0].value : Object.freeze(outputs.map((item) => item.value));
			this.invocations.recordDirectInterceptions(interceptionEvidence(request, this.runtime, operation, payload.cardinality, outputs.map((item) => item.traces)));
			return Object.freeze({
				kind: "direct",
				output: value
			});
		}
		const authorization = await this.authority.authorizeMediated(this.resolution, operation.descriptor, inputs);
		const replayBinding = this.authority.replayBinding(authorization, operation.descriptor);
		const preflight = await this.invocations.prepareMediated({
			requestKey: request.requestKey,
			facet: this.runtime.ref,
			descriptor: operation.descriptor,
			cardinality: payload.cardinality,
			inputs: Object.freeze(inputs),
			authorization,
			replayBinding
		}, () => {
			const prepared = inputs.map((item, itemIndex) => this.prepare(operation, item, itemIndex));
			return Object.freeze({
				inputs: Object.freeze(prepared.map((item) => item.value)),
				interceptions: Object.freeze(prepared.map((item) => item.traces))
			});
		});
		if (preflight.kind === "replay") {
			if (detachment !== void 0) throw new AgentCoreError("invocation.invalid", "A detached admission names an OperationRequestKey whose Invocation completed");
			return canonicalReplay(preflight.result, payload.cardinality);
		}
		const prepared = preflight.preparation;
		const mediated = {
			requestKey: request.requestKey,
			facet: this.runtime.ref,
			descriptor: operation.descriptor,
			cardinality: payload.cardinality,
			inputs: prepared.inputs,
			authorization,
			replayBinding,
			interceptions: prepared.interceptions,
			execute: (itemIndex, context) => {
				const item = prepared.inputs[itemIndex];
				if (item === void 0) throw new AgentCoreError("invocation.invalid", "Invocation requested an unknown item");
				return executeOperation(operation, context, item);
			}
		};
		if (detachment !== void 0) return detachment.admissions.admitDetached(mediated, detachment.itemIndex);
		const result = await this.invocations.invoke(mediated);
		if (result.outputs.length !== prepared.inputs.length) throw new AgentCoreError("invocation.invalid", "Invocation returned the wrong item count");
		const evidence = canonicalFacetData(result.evidence);
		const outputs = await this.invocations.presentMediated(evidence, result.outputs, (itemIndex, output) => this.present(operation, output, itemIndex), Object.freeze({
			requestKey: request.requestKey,
			facet: this.runtime.ref,
			descriptor: operation.descriptor,
			cardinality: payload.cardinality
		}));
		const value = payload.cardinality.kind === "single" ? outputs[0] : Object.freeze(outputs);
		return Object.freeze({
			kind: "mediated",
			output: value,
			evidence
		});
	}
	[Symbol.dispose]() {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#inFlight === 0) this.releaseAuthority();
		else this.#releasePending = true;
	}
	validateInput(operation, rawInput) {
		const input = canonicalFacetData(rawInput);
		if (!operation.descriptor.input.accepts(input)) throw new AgentCoreError("operation.invalid-input", "Operation input does not match its schema");
		return input;
	}
	prepare(operation, input, itemIndex) {
		const before = this.interceptors.run("operation.before", this.resolution, this.runtime, operation, itemIndex, input);
		if (!operation.descriptor.input.accepts(before.value)) throw new AgentCoreError("operation.invalid-input", "Intercepted input does not match its schema");
		return before;
	}
	present(operation, rawOutput, itemIndex) {
		const output = canonicalFacetData(rawOutput);
		if (!operation.descriptor.output.accepts(output)) throw new AgentCoreError("operation.invalid-output", "Operation output does not match its schema");
		const after = this.interceptors.run("operation.after", this.resolution, this.runtime, operation, itemIndex, output);
		if (!operation.descriptor.output.accepts(after.value)) throw new AgentCoreError("operation.invalid-output", "Intercepted output does not match its schema");
		return after;
	}
	declaredOperation(name) {
		this.requireActive();
		return this.runtime.operation(name);
	}
	requireActive() {
		if (this.#disposed) throw inactive$1("Resolved Facet is disposed");
		if (this.host.facet(this.runtime.ref) !== this.runtime) throw inactive$1("Resolved Facet is no longer active");
	}
	releaseAuthority() {
		this.#releasePending = false;
		this.authority.release(this.resolution);
	}
};
var ConfirmedOperationFailure = class extends AgentCoreError {
	evidence;
	constructor(message, evidence) {
		super("invocation.invalid", message);
		this.evidence = evidence;
		Object.freeze(evidence);
		Object.freeze(this);
	}
};
/**
* Refuses a detached admission the dispatch cannot answer for, before any effect runs.
*
* The mediated tier is a precondition rather than a preference: §5.6 detaches an item whose
* admission it can name, and only the mediated tier records one. The item index is checked
* against this dispatch's own payload, so a caller cannot detach an item the request never
* carried and receive an admission derived from a different item's arguments.
*/
function requireDetachableItem(itemIndex, payload, tier) {
	if (tier !== "mediated") throw new AgentCoreError("invocation.invalid", "A detached admission requires the mediated tier, which alone admits an item");
	if (!Number.isSafeInteger(itemIndex) || itemIndex < 0 || itemIndex >= payload.items.length) throw new AgentCoreError("invocation.invalid", "A detached admission names an item outside this dispatch's payload");
}
function operationPayload(payload) {
	if (payload.kind === "single") return {
		cardinality: Object.freeze({ kind: "single" }),
		items: [payload.input]
	};
	if (payload.kind === "batch" && Array.isArray(payload.inputs) && payload.inputs.length > 0) return {
		cardinality: Object.freeze({
			kind: "batch",
			itemCount: payload.inputs.length
		}),
		items: payload.inputs
	};
	throw new AgentCoreError("invocation.invalid", "Operation payload is malformed or empty");
}
function interceptionEvidence(request, runtime, operation, cardinality, traces) {
	return Object.freeze({
		requestKey: request.requestKey,
		facet: runtime.ref,
		descriptor: operation.descriptor,
		cardinality,
		traces: Object.freeze(traces.map((item) => Object.freeze([...item])))
	});
}
function canonicalReplay(result, cardinality) {
	if (result.kind !== "mediated") throw new AgentCoreError("invocation.invalid", "Mediated replay returned a direct result");
	if (cardinality.kind === "batch" && (!Array.isArray(result.output) || result.output.length !== cardinality.itemCount)) throw new AgentCoreError("invocation.invalid", "Mediated replay returned the wrong payload shape");
	return Object.freeze({
		kind: "mediated",
		output: canonicalFacetData(result.output),
		evidence: canonicalFacetData(result.evidence)
	});
}
async function executeOperation(operation, context, input) {
	try {
		return await operation.execute(context, input);
	} catch (error) {
		if (error instanceof AgentCoreError) throw error;
		throw new AgentCoreError("invocation.invalid", "Operation handler failed");
	}
}
function inactive$1(message) {
	return new AgentCoreError("facet.inactive", message);
}
//#endregion
//#region src/operations/authored-code.ts
/**
* One capability explicitly passed into an isolate: the name the loaded code addresses
* it by, the exact Facet that name must resolve to, and the Operations that Facet
* declares reachable through it. The Package is derived from the Facet reference rather
* than stated separately, so a passed capability cannot claim one Package and resolve to
* another.
*/
var AuthoredCodeCapability = class {
	name;
	facet;
	capability;
	package;
	/**
	* The declared Operations this name conveys (SPEC §4.7). They come from the
	* composition's `operations` contributions, never from the submission, because
	* availability is a property of the composition — so nothing the model writes can
	* widen what the isolate reaches.
	*/
	operations;
	constructor(name, facet, capability, operations = []) {
		this.name = name;
		this.facet = facet;
		this.capability = capability;
		this.package = new FacetPackageId(facet.value.slice(0, facet.value.indexOf(":")));
		this.operations = Object.freeze([...operations]);
		Object.freeze(this);
	}
};
/**
* The complete capability set one isolate was passed (SPEC §4.7). It is the whole of
* what the isolate can reach: a name absent from this set has no channel, because the
* isolate holds no ambient authority and the only outward call path checks membership
* here before it resolves anything.
*
* The set is also where §4.7's availability bound is discharged. An Operation declared
* `native` is not passable, and the refusal is the whole outcome: dropping it instead
* would leave the model an offered catalog the isolate cannot reach, which is the one
* disagreement between the two the declaration exists to prevent.
*/
var AuthoredCodeCapabilitySet = class {
	#capabilities;
	constructor(capabilities) {
		const indexed = /* @__PURE__ */ new Map();
		for (const capability of capabilities) {
			if (!(capability instanceof AuthoredCodeCapability)) throw new TypeError("Passed capabilities must use the canonical contract");
			if (indexed.has(capability.name.value)) throw new TypeError("Passed capability names must be unique");
			for (const operation of capability.operations) if (!operation.availability.reachableByAuthoredCode) throw new AgentCoreError("authority.denied", `Operation ${operation.name.value} is declared native and is not passable to agent-authored code`);
			indexed.set(capability.name.value, capability);
		}
		this.#capabilities = indexed;
		Object.freeze(this);
	}
	static get none() {
		return emptyCapabilitySet;
	}
	capability(name) {
		return this.#capabilities.get(name.value);
	}
	get names() {
		return Object.freeze([...this.#capabilities.values()].map((entry) => entry.name));
	}
};
/**
* The one channel out of an isolate. A backing hands the loaded code this port and
* nothing else, so every call the code makes arrives here and leaves as an ordinary
* Invocation.
*/
var AuthoredCodeInvocationPort = class {};
/**
* The isolate's calls, re-entering the ordinary Invocation pipeline under the isolate's
* own delegated authority. Three checks make the wrong call unexpressible rather than
* merely discouraged: the requested name must belong to the passed set; the gateway is
* the isolate's own, so resolution happens against the isolate's protection domain and
* never the loader's; and the resolved Facet and Package must be the exact ones the
* passed capability pinned.
*
* Unlike a Turn's bound Operations, an isolate's calls are not forced onto the mediated
* path here — §4.7 makes them ordinary Invocations tiered by §7.2, and §7.2 alone
* decides. A `dynamic` facet is never `direct`, but a `dynamic` isolate calling a
* `bundled` facet is a case the tiering rules already answer.
*/
var GatewayAuthoredCodeInvocationPort = class extends AuthoredCodeInvocationPort {
	gateway;
	capabilities;
	isolate;
	signal;
	#calls = 0;
	constructor(gateway, capabilities, isolate, signal) {
		super();
		this.gateway = gateway;
		this.capabilities = capabilities;
		this.isolate = isolate;
		this.signal = signal;
	}
	async invoke(request) {
		this.requireNotCancelled();
		const capability = this.capabilities.capability(request.binding);
		if (capability === void 0) throw new AgentCoreError("authority.denied", "Agent-authored code invoked a capability it was not passed");
		const requestKey = new OperationRequestKey(`${this.isolate}:${this.#calls += 1}`);
		const resolved = await this.gateway.resolve(request.binding);
		try {
			const descriptor = resolved.descriptor(request.operation);
			if (!resolved.facet.equals(capability.facet) || !resolved.package.equals(capability.package) || descriptor === void 0) throw new AgentCoreError("binding.invalid", "Resolved Facet does not match the exact passed capability");
			this.requireNotCancelled();
			const result = await resolved.dispatch({
				requestKey,
				operation: descriptor.name,
				payload: {
					kind: "single",
					input: canonicalFacetData(request.input)
				}
			});
			this.requireNotCancelled();
			if (Array.isArray(result.output)) throw new AgentCoreError("operation.invalid-output", "Single agent-authored code Invocation returned a batch result");
			return canonicalFacetData(result.output);
		} finally {
			resolved[Symbol.dispose]();
		}
	}
	requireNotCancelled() {
		if (this.signal.aborted) throw new AgentCoreError("lease.invalid", "Agent-authored code execution is cancelled");
	}
};
/**
* The passed capability set as the authority plane holds it: Grants delegated under
* §3.4 and Bindings in the isolate's own protection domain, plus the gateway that
* resolves them. Disposing it revokes the delegation — which severs the isolate and
* leaves the authority it was delegated from untouched, because those are different
* Grants in one lineage.
*/
var AuthoredCodeDelegation = class {};
/**
* Delegating a capability set into a fresh isolate domain. Implementations mint the
* passed Grants as attenuations of the delegator's own, which is what bounds the set at
* "equal at most, never wider" without this seam restating the §3.4 rules.
*/
var AuthoredCodeDelegationPort = class {};
/**
* A hosting mechanism for a `dynamic` domain (§4.7, §10.2). Every backing loads the
* code into a fresh isolate with zero ambient authority and zero ambient egress, gives
* it `invocations` and nothing else, runs it once against `input`, and disposes it. The
* choice between backings is operational: each satisfies those guarantees on its own,
* never by comparison with another.
*/
var AuthoredCodeBacking = class {};
/**
* The backings a substrate profile offers and the one it declares as its default. The
* default is the profile's, not the Blueprint's: §4.7 sends a consumer the Blueprint
* does not map here rather than to an arbitrary member of the offered set.
*/
var AuthoredCodeBackingSet = class {
	declaredDefault;
	#backings;
	constructor(backings, declaredDefault) {
		this.declaredDefault = declaredDefault;
		const indexed = /* @__PURE__ */ new Map();
		for (const backing of backings) {
			if (!(backing instanceof AuthoredCodeBacking)) throw new TypeError("Offered backings must implement the backing contract");
			if (indexed.has(backing.id.value)) throw new TypeError("Offered backing identifiers must be unique");
			indexed.set(backing.id.value, backing);
		}
		if (!indexed.has(declaredDefault.value)) throw new TypeError("A profile's declared default backing must be one it offers");
		this.#backings = indexed;
		Object.freeze(this);
	}
	backing(id) {
		const backing = this.#backings.get(id.value);
		if (backing === void 0) throw new AgentCoreError("operation.invalid-input", `Backing ${id.value} is not offered by this profile`);
		return backing;
	}
};
/**
* One submission of agent-authored code, run once. The host owns the whole shape §4.7
* states: delegate the passed capability set into a fresh isolate domain, resolve the
* submitted source, select the declared backing, run the code with the one outward
* channel and nothing else, and revoke the delegation when the submission ends.
*
* The three §4.7 consumers differ only in when that last step happens, which is why the
* consumer is a parameter here rather than three code paths.
*/
var AuthoredCodeHost = class {
	init;
	constructor(init) {
		this.init = init;
	}
	async run(consumer, submission, scope) {
		const code = await resolveCode(submission.source, scope.content);
		const backing = this.init.backings.backing(this.init.backingFor(consumer, this.init.backings.declaredDefault));
		const delegation = await this.init.delegations.delegate({
			consumer,
			requested: submission.capabilities,
			isolate: scope.isolate,
			signal: scope.signal
		});
		try {
			return await backing.run({
				consumer,
				isolate: scope.isolate,
				entry: submission.source.entry,
				code,
				capabilities: delegation.capabilities,
				invocations: new GatewayAuthoredCodeInvocationPort(delegation.gateway, delegation.capabilities, scope.isolate, scope.signal),
				input: canonicalFacetData(submission.input),
				signal: scope.signal
			});
		} finally {
			await delegation[Symbol.asyncDispose]();
		}
	}
};
var AUTHORED_CODE_INPUT_SCHEMA = strictObjectSchema({
	capabilities: {
		type: "array",
		items: strictObjectSchema({
			binding: {
				type: "string",
				minLength: 1
			},
			capability: { type: "object" },
			facet: {
				type: "string",
				minLength: 1
			}
		}, ["binding", "facet"]).document,
		uniqueItems: true
	},
	consumer: { const: "programmaticToolCall" },
	input: {},
	source: strictObjectSchema({
		entry: {
			type: "string",
			minLength: 1
		},
		modules: {
			type: "object",
			minProperties: 1,
			additionalProperties: {
				type: "string",
				pattern: "^sha256:[a-f0-9]{64}$"
			}
		}
	}, ["entry", "modules"]).document
}, [
	"capabilities",
	"consumer",
	"input",
	"source"
]);
/**
* Programmatic tool calling as the model sees it: one Operation invocation, code in,
* value out, with every Operation the code called in between carrying its own admission
* and evidence. Its impact is `delegate` because handing the capability set to the
* isolate is delegation, which §7.2 floors at mediated — so a submission is admitted,
* receipted, and audited exactly once whatever the code inside goes on to do.
*
* §4.7 fixes the shape and §11 declares no profile that owns it, so the Operation's
* name is the contributing Facet's to choose (P11-BASE-NAMES); the impact and the
* semantics are not.
*/
var AuthoredCodeOperation = class extends Operation {
	host;
	descriptor;
	constructor(name, host) {
		super();
		this.host = host;
		this.descriptor = new OperationDescriptor(name, "delegate", AUTHORED_CODE_INPUT_SCHEMA, schema({}), "Runs submitted agent-authored code once in a fresh isolate holding only the passed capabilities.");
	}
	async execute(context, input) {
		return this.host.run("programmaticToolCall", decodeSubmission(input), {
			isolate: context.invocation.value,
			content: context.content,
			signal: context.signal
		});
	}
};
/**
* A submission names Bindings and never Operations: `AUTHORED_CODE_INPUT_SCHEMA` admits no
* key that could carry one, so the declared Operations each passed name conveys are the
* composition's to attach (SPEC §4.7) and a submission cannot state its own availability.
*/
function decodeSubmission(input) {
	const object = requireDataObject(input, "Agent-authored code submission");
	requireAuthoredCodeConsumer(object["consumer"], "Agent-authored code consumer");
	const capabilities = object["capabilities"];
	if (!Array.isArray(capabilities)) throw new TypeError("Agent-authored code capabilities must be an array");
	return Object.freeze({
		source: AuthoredCodeSource.fromData(requireDataObject(object["source"], "Submitted source")),
		capabilities: new AuthoredCodeCapabilitySet(capabilities.map((entry) => {
			const passed = requireDataObject(entry, "Passed capability");
			const narrowing = passed["capability"];
			return new AuthoredCodeCapability(new BindingName(requireString(passed["binding"], "Passed capability name")), new FacetRef(requireString(passed["facet"], "Passed capability Facet")), narrowing === void 0 ? void 0 : CapabilitySpec.fromData(narrowing));
		})),
		input: canonicalFacetData(object["input"] ?? null)
	});
}
async function resolveCode(source, content) {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const resolved = /* @__PURE__ */ new Map();
	for (const [name, ref] of source.modules) {
		const stat = await content.stat(ref);
		if (stat === void 0 || !stat.digest.equals(ref.digest)) throw new AgentCoreError("content.not-found", `Agent-authored code module ${name} is not available`);
		resolved.set(name, decoder.decode(await content.get(ref)));
	}
	return resolved;
}
var emptyCapabilitySet = new AuthoredCodeCapabilitySet([]);
//#endregion
//#region src/operations/command-runtime.ts
var commandKeyDecoder = new TextDecoder("utf-8", { fatal: true });
var CommandRuntime = class {
	#commands = /* @__PURE__ */ new Map();
	#surfaces = /* @__PURE__ */ new Map();
	install(installation) {
		validateInstallation(installation);
		const scope = facetScope(installation.contributor);
		const id = commandInvocationSource(installation.command);
		const key = commandKey(scope, id);
		const existing = this.#commands.get(key);
		if (existing !== void 0) {
			if (sameInstallation(existing, installation)) return existing;
			throw collision(`Command ${id} conflicts with an installed command in ${scope}`);
		}
		for (const surface of installation.command.surfaces) if (this.#surfaces.has(surfaceKey(scope, surface.value, installation.command.name))) throw collision(`Command ${installation.command.name} conflicts in surface ${surface.value}`);
		const subscription = commandAutomation(installation.command);
		const installed = Object.freeze({
			id,
			scope,
			contributor: installation.contributor,
			command: installation.command,
			target: installation.target.descriptor,
			subscription
		});
		this.#commands.set(key, installed);
		for (const surface of installation.command.surfaces) this.#surfaces.set(surfaceKey(scope, surface.value, installation.command.name), installed);
		return installed;
	}
	/**
	* A Command invocation only emits `command.invoked` with the §4.3 step-4 correlation
	* (its Surface, and the Run when invoked from a conversation). Execution happens solely
	* through the derived Subscription and the workspace routing pipeline, which evaluates the
	* subscription's accepted trust, event dedupe, and initiator authority; no direct gateway
	* dispatch is permitted, as that would be an alternate authority source (§4.3). The returned
	* Event identity lets the Surface correlate the eventual `command.completed` (step 5).
	*/
	async invoke(installed, argumentsValue, origin, events) {
		this.requireInstalled(installed);
		if (!installed.command.surfaces.some((surface) => surface.value === origin.surface.value)) throw new AgentCoreError("operation.invalid-input", `Command ${installed.id} is not installed for surface ${origin.surface.value}`);
		const input = this.bind(installed.command, argumentsValue);
		if (!installed.target.input.accepts(input)) throw new AgentCoreError("operation.invalid-input", "Mapped Command input does not match the installed Operation schema");
		return events.invoked(installed, origin, { input });
	}
	bind(command, argumentsValue) {
		const canonical = canonicalFacetData(argumentsValue);
		if (!command.arguments.accepts(canonical)) throw new AgentCoreError("operation.invalid-input", "Command arguments do not match their schema");
		if (command.mapping === void 0) return canonical;
		let output = {};
		for (const move of command.mapping.moves) output = applyMove(output, canonical, move);
		return canonicalFacetData(output);
	}
	requireInstalled(installed) {
		if (this.#commands.get(commandKey(installed.scope, installed.id)) !== installed) throw new AgentCoreError("facet.inactive", `Command ${installed.id} is not installed`);
	}
};
function validateInstallation(installation) {
	const { command, target, completion } = installation;
	command.arguments.assertValid();
	target.descriptor.input.assertValid();
	target.descriptor.output.assertValid();
	if (!target.package.equals(command.operation.facet) || !target.descriptor.name.equals(command.operation.operation)) throw new AgentCoreError("operation.missing", "Command installation target does not match its Operation reference");
	validateMapping(command, target.descriptor);
	if (command.completion === void 0) {
		if (completion !== void 0) throw new AgentCoreError("operation.invalid-input", "Command installation supplied an undeclared completion Operation");
		return;
	}
	if (completion === void 0 || !completion.package.equals(command.completion.facet) || !completion.descriptor.name.equals(command.completion.operation) || completion.descriptor.impact !== "observe") throw new AgentCoreError("operation.invalid-input", "Command completion must resolve to its exact observe Operation");
}
function validateMapping(command, operation) {
	if (command.mapping === void 0) {
		if (!schemasCompatible(command.arguments.document, operation.input.document)) throw new AgentCoreError("operation.invalid-input", "Identity Command mapping is incompatible with the Operation input schema");
		return;
	}
	const destinations = /* @__PURE__ */ new Set();
	for (const move of command.mapping.moves) {
		if (destinations.has(move.to)) throw new AgentCoreError("operation.invalid-input", `Command mapping writes ${move.to} more than once`);
		destinations.add(move.to);
		const target = schemaAtPointer(operation.input.document, move.to);
		if (target === void 0) throw new AgentCoreError("operation.invalid-input", `Command mapping target ${move.to} is absent from the Operation input schema`);
		if (move.from === void 0) {
			if (!schemaAccepts(target, move.literal)) throw new AgentCoreError("operation.invalid-input", `Command mapping literal does not match target ${move.to}`);
			continue;
		}
		const source = schemaAtPointer(command.arguments.document, move.from);
		if (source === void 0) throw new AgentCoreError("operation.invalid-input", `Command mapping source ${move.from} is absent from the arguments schema`);
		if (!schemasCompatible(source, target)) throw new AgentCoreError("operation.invalid-input", `Command mapping ${move.from} to ${move.to} has incompatible schemas`);
	}
	if (!requiredTargetsCovered(operation.input.document, destinations)) throw new AgentCoreError("operation.invalid-input", "Command mapping does not produce every required Operation input");
}
function schemaAtPointer(document, pointer) {
	let current = document;
	for (const segment of pointerSegments(pointer)) {
		if (!isJsonObject(current)) return void 0;
		const properties = schemaMap(current["properties"]);
		if (properties !== void 0 && Object.hasOwn(properties, segment)) {
			current = schemaDocument(properties[segment]);
			continue;
		}
		if (/^(?:0|[1-9]\d*)$/u.test(segment)) {
			const index = Number(segment);
			const prefixItems = current["prefixItems"];
			if (Array.isArray(prefixItems) && index < prefixItems.length) {
				current = schemaDocument(prefixItems[index]);
				continue;
			}
			const items = schemaDocument(current["items"]);
			if (items !== void 0) {
				current = items;
				continue;
			}
		}
		const additional = schemaDocument(current["additionalProperties"]);
		if (additional !== void 0 && additional !== false) {
			current = additional;
			continue;
		}
		return;
	}
	return current;
}
function requiredTargetsCovered(document, destinations) {
	if (destinations.has("") || document === true || document === false) return document !== false;
	const required = document["required"];
	if (!Array.isArray(required)) return true;
	return required.every((property) => isString(property) && [...destinations].some((pointer) => {
		const requiredPointer = `/${escapePointer(property)}`;
		return pointer === requiredPointer || pointer.startsWith(`${requiredPointer}/`);
	}));
}
function schemasCompatible(source, target) {
	if (target === true) return true;
	if (source === false) return true;
	if (target === false || source === true) return source === target;
	if (Object.keys(target).length === 0) return true;
	if (sameJson(source, target)) return true;
	const sourceType = source["type"];
	const targetType = target["type"];
	if (targetType !== void 0 && (sourceType === void 0 || !sameJson(sourceType, targetType))) return false;
	const sourceConst = source["const"];
	if (sourceConst !== void 0) return schemaAccepts(target, sourceConst);
	const sourceEnum = source["enum"];
	if (Array.isArray(sourceEnum)) return sourceEnum.every((value) => schemaAccepts(target, value));
	return targetType !== void 0 && sourceType !== void 0;
}
function schemaAccepts(schema, value) {
	if (schema === true) return true;
	if (schema === false) return false;
	const constant = schema["const"];
	if (constant !== void 0 && !sameJson(constant, value)) return false;
	const enumeration = schema["enum"];
	if (Array.isArray(enumeration) && !enumeration.some((entry) => sameJson(entry, value))) return false;
	const type = schema["type"];
	if (isString(type) && !valueHasType(value, type)) return false;
	return true;
}
function valueHasType(value, type) {
	switch (type) {
		case "array": return Array.isArray(value);
		case "boolean": return value === true || value === false;
		case "integer": return Number.isInteger(value);
		case "null": return value === null;
		case "number": return isNumber(value);
		case "object": return isJsonObject(value);
		case "string": return isString(value);
		default: return false;
	}
}
function schemaDocument(value) {
	return value === true || value === false || isJsonObject(value) ? value : void 0;
}
function schemaMap(value) {
	return isJsonObject(value) ? value : void 0;
}
function facetScope(contributor) {
	return contributor.value.slice(0, contributor.value.indexOf(":"));
}
function commandKey(scope, id) {
	return commandKeyDecoder.decode(encodeCanonicalJson([scope, id]));
}
function surfaceKey(scope, surface, name) {
	return commandKeyDecoder.decode(encodeCanonicalJson([
		scope,
		surface,
		name
	]));
}
function sameInstallation(existing, installation) {
	return existing.contributor.equals(installation.contributor) && sameBytes(Command.encode(existing.command), Command.encode(installation.command)) && sameBytes(encodeCanonicalJson(existing.target.toData()), encodeCanonicalJson(installation.target.descriptor.toData()));
}
function collision(message) {
	return new AgentCoreError("protocol.duplicate", message);
}
function escapePointer(value) {
	return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}
function sameBytes(left, right) {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
function sameJson(left, right) {
	return sameBytes(encodeCanonicalJson(left), encodeCanonicalJson(right));
}
function applyMove(target, source, move) {
	const value = move.from === void 0 ? move.literal : readPointer(source, move.from);
	return writePointer(target, move.to, value);
}
function readPointer(value, pointer) {
	let current = value;
	for (const segment of pointerSegments(pointer)) if (Array.isArray(current)) {
		const index = arrayIndex(segment, current.length);
		current = current[index];
	} else if (isJsonObject(current) && Object.hasOwn(current, segment)) current = current[segment];
	else throw new AgentCoreError("operation.invalid-input", `Command mapping source ${pointer} is missing`);
	return current;
}
function writePointer(target, pointer, value) {
	if (pointer === "") return canonicalFacetData(value);
	const root = mutableCopy(target);
	const segments = pointerSegments(pointer);
	let current = root;
	for (const [index, segment] of segments.entries()) {
		const last = index === segments.length - 1;
		if (!isJsonObject(current)) throw new AgentCoreError("operation.invalid-input", `Command mapping target ${pointer} is invalid`);
		if (last) {
			defineDataProperty(current, segment, mutableCopy(value));
			continue;
		}
		rejectUnsafeSegment(segment);
		const child = Object.hasOwn(current, segment) ? current[segment] : void 0;
		if (child === void 0) {
			const next = {};
			defineDataProperty(current, segment, next);
			current = next;
		} else current = child;
	}
	return canonicalFacetData(root);
}
function pointerSegments(pointer) {
	if (pointer === "") return [];
	return pointer.slice(1).split("/").map((segment) => {
		const decoded = segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
		rejectUnsafeSegment(decoded);
		return decoded;
	});
}
function arrayIndex(value, length) {
	if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new AgentCoreError("operation.invalid-input", "Command mapping array index is invalid");
	const index = Number(value);
	if (!Number.isSafeInteger(index) || index >= length) throw new AgentCoreError("operation.invalid-input", "Command mapping array index is out of bounds");
	return index;
}
function mutableCopy(value) {
	if (Array.isArray(value)) return value.map(mutableCopy);
	if (isJsonObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mutableCopy(child)]));
	return value;
}
function defineDataProperty(target, key, value) {
	Object.defineProperty(target, key, {
		configurable: true,
		enumerable: true,
		value,
		writable: true
	});
}
function rejectUnsafeSegment(segment) {
	if (segment === "__proto__" || segment === "constructor" || segment === "prototype") throw new AgentCoreError("operation.invalid-input", "Command mapping contains an unsafe path segment");
}
//#endregion
//#region src/operations/correspondence.ts
var validatedFacetToken = Object.freeze({});
var validatedFacets = /* @__PURE__ */ new WeakSet();
var ValidatedFacet = class {
	source;
	operationMap;
	surfaceMap;
	interceptorMap;
	ref;
	manifest;
	constructor(token, source, ref, manifest, operationMap, surfaceMap, interceptorMap) {
		this.source = source;
		this.operationMap = operationMap;
		this.surfaceMap = surfaceMap;
		this.interceptorMap = interceptorMap;
		if (token !== validatedFacetToken) throw runtimeMismatch("Validated Facet must come from correspondence validation");
		this.ref = ref;
		this.manifest = manifest;
		validatedFacets.add(this);
		Object.freeze(this);
	}
	operation(name) {
		return this.operationMap.get(name.value);
	}
	surface(id) {
		return this.surfaceMap.get(id.value);
	}
	interceptor(id) {
		return this.interceptorMap.get(id.value);
	}
	start(context) {
		return this.source.start(context);
	}
	stop(context) {
		return this.source.stop(context);
	}
};
var ValidatedOperation = class extends Operation {
	source;
	descriptor;
	constructor(source, descriptor) {
		super();
		this.source = source;
		this.descriptor = descriptor;
		Object.freeze(this);
	}
	execute(context, input) {
		return this.source.execute(context, input);
	}
};
var FacetCorrespondenceValidator = class {
	static require(candidate) {
		if (!(candidate instanceof ValidatedFacet) || !validatedFacets.has(candidate)) throw runtimeMismatch("Facet has no correspondence validation evidence");
		return candidate;
	}
	validate(expectedManifests, roots) {
		const expected = expectedManifestMap(expectedManifests);
		const candidates = flattenFacets(roots);
		const seen = /* @__PURE__ */ new Set();
		const facets = [];
		for (const candidate of candidates) {
			const key = manifestKey(candidate.manifest);
			if (seen.has(key)) throw runtimeMismatch(`Runtime contains duplicate Facet manifest ${key}`);
			seen.add(key);
			const manifest = expected.get(key);
			if (manifest === void 0 || !equalBytes(FacetManifest.encode(manifest), FacetManifest.encode(candidate.manifest))) throw runtimeMismatch(`Runtime Facet ${key} does not match a pinned manifest`);
			const implementations = validateImplementations(candidate.source, manifest);
			facets.push(new ValidatedFacet(validatedFacetToken, candidate.source, candidate.ref, FacetManifest.decode(FacetManifest.encode(manifest)), implementations.operations, implementations.surfaces, implementations.interceptors));
		}
		for (const key of expected.keys()) if (!seen.has(key)) throw runtimeMismatch(`Runtime omits pinned Facet manifest ${key}`);
		return Object.freeze({ facets: Object.freeze(facets) });
	}
};
function validateImplementations(facet, manifest) {
	const operations = /* @__PURE__ */ new Map();
	for (const value of manifest.contributions.get(operationSlot) ?? []) {
		const descriptor = OperationDescriptor.fromData(value);
		requireUnique(operations, descriptor.name.value, "Operation");
		const operation = facet.operation(descriptor.name);
		requireImplementation(operation, "Operation", descriptor.name.value);
		requireEqualDeclaration(OperationDescriptor.encode(operation.descriptor), OperationDescriptor.encode(descriptor), `Operation ${descriptor.name.value}`);
		operations.set(descriptor.name.value, new ValidatedOperation(operation, OperationDescriptor.decode(OperationDescriptor.encode(descriptor))));
	}
	const surfaces = /* @__PURE__ */ new Map();
	for (const value of manifest.contributions.get(surfaceSlot) ?? []) {
		const descriptor = SurfaceDescriptor.fromData(value);
		requireUnique(surfaces, descriptor.id.value, "Surface");
		const surface = facet.surface(descriptor.id);
		requireImplementation(surface, "Surface", descriptor.id.value);
		requireEqualDeclaration(SurfaceDescriptor.encode(surface.descriptor), SurfaceDescriptor.encode(descriptor), `Surface ${descriptor.id.value}`);
		surfaces.set(descriptor.id.value, surface);
	}
	const interceptors = /* @__PURE__ */ new Map();
	for (const value of manifest.contributions.get(interceptorSlot) ?? []) {
		const declaration = InterceptorDeclaration.fromData(value);
		requireUnique(interceptors, declaration.id.value, "Interceptor");
		const interceptor = facet.interceptor(declaration.id);
		requireImplementation(interceptor, "Interceptor", declaration.id.value);
		requireEqualDeclaration(InterceptorDeclaration.encode(interceptor.declaration), InterceptorDeclaration.encode(declaration), `Interceptor ${declaration.id.value}`);
		interceptors.set(declaration.id.value, interceptor);
	}
	return Object.freeze({
		operations,
		surfaces,
		interceptors
	});
}
function flattenFacets(roots) {
	const facets = [];
	const active = /* @__PURE__ */ new Set();
	const visited = /* @__PURE__ */ new Set();
	const refs = /* @__PURE__ */ new Set();
	const visit = (facet) => {
		if (active.has(facet)) throw runtimeMismatch("Runtime child Facets contain a cycle");
		if (visited.has(facet)) throw runtimeMismatch("Runtime child Facet appears more than once");
		const ref = facet.ref;
		const manifest = facet.manifest;
		const children = [...facet.children()];
		if (refs.has(ref.value)) throw runtimeMismatch(`Duplicate Facet reference ${ref.value}`);
		active.add(facet);
		visited.add(facet);
		refs.add(ref.value);
		facets.push({
			source: facet,
			ref,
			manifest
		});
		for (const child of children) visit(child);
		active.delete(facet);
	};
	for (const root of roots) visit(root);
	return facets;
}
function expectedManifestMap(manifests) {
	const result = /* @__PURE__ */ new Map();
	const packageIds = /* @__PURE__ */ new Set();
	for (const manifest of manifests) {
		const key = manifestKey(manifest);
		if (result.get(key) !== void 0) throw runtimeMismatch(`Pinned manifests contain duplicate ${key}`);
		if (packageIds.has(manifest.id.value)) throw runtimeMismatch(`Pinned manifests contain multiple versions of ${manifest.id.value}`);
		packageIds.add(manifest.id.value);
		result.set(key, manifest);
	}
	return result;
}
function manifestKey(manifest) {
	return `${manifest.id.value}@${manifest.version.toString()}`;
}
function requireImplementation(value, kind, id) {
	if (value === void 0) throw runtimeMismatch(`${kind} ${id} has no runtime implementation`);
}
function requireUnique(values, id, subject) {
	if (values.has(id)) throw runtimeMismatch(`${subject} ${id} is declared more than once`);
}
function requireEqualDeclaration(actual, expected, subject) {
	if (!equalBytes(actual, expected)) throw runtimeMismatch(`${subject} does not match its declaration`);
}
function equalBytes(left, right) {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
function runtimeMismatch(message) {
	return new AgentCoreError("facet.inactive", message);
}
var operationSlot = new SlotName("operations");
var surfaceSlot = new SlotName("surfaces");
var interceptorSlot = new SlotName("interceptors");
//#endregion
//#region src/operations/lifecycle.ts
/**
* The seam to §3.4 Binding resolution. A declared `BindingRequirement` resolves through the
* Grant plane to an exact `FacetRef` in an exact protection domain and never to a name, so
* this answers with that ref and nothing else: the authority plane stays outside
* `src/operations`, and reliance keys on what the dependent actually reached.
*/
var FacetRequirementResolver = class {};
/**
* Resolves nothing, so a host assembled without a Grant plane refuses every manifest that
* declares a `BindingRequirement` rather than starting it degraded (SPEC §4.1). A manifest
* declaring none activates unchanged.
*/
var FailClosedFacetRequirementResolver = class extends FacetRequirementResolver {
	resolve() {}
};
var FacetRuntimeHost = class {
	#expected;
	#roots;
	#validator;
	#requirements;
	#reliance = new FacetReliance();
	#abort = new AbortController();
	#runtime;
	#state = "inactive";
	#transition;
	#inFlight = 0;
	#drain;
	#cleanup = [];
	constructor(expected, roots, validator = new FacetCorrespondenceValidator(), requirements = new FailClosedFacetRequirementResolver()) {
		this.#expected = Object.freeze([...expected]);
		this.#roots = Object.freeze([...roots]);
		this.#validator = validator;
		this.#requirements = requirements;
	}
	get active() {
		return this.#state === "active";
	}
	activate() {
		if (this.#state === "active") return Promise.resolve();
		if (this.#state === "disposed") return Promise.reject(inactive("Facet host is disposed"));
		if (this.#state === "stopping") return Promise.reject(inactive("Facet host is stopping"));
		if (this.#state === "cleanup-required") return Promise.reject(inactive("Facet host requires cleanup before reactivation"));
		if (this.#transition !== void 0) return this.#transition;
		this.#state = "starting";
		const transition = this.start();
		this.#transition = transition;
		transition.finally(() => {
			if (this.#transition === transition) this.#transition = void 0;
		}).catch(noop);
		return transition;
	}
	facet(ref) {
		if (this.#state !== "active") return void 0;
		return this.#runtime?.facets.find((facet) => facet.ref.equals(ref));
	}
	facets() {
		return this.#state === "active" || this.#state === "stopping" ? this.#runtime?.facets ?? [] : [];
	}
	/**
	* The exact provider `FacetRef` this Facet's declared requirements resolved to, one entry
	* per distinct provider in manifest binding order (SPEC §4.1). Empty for a Facet that
	* declares no requirement, and for one whose own `stop` has returned.
	*/
	relianceOf(dependent) {
		return this.#reliance.providers(dependent);
	}
	/**
	* Every Facet still holding this exact provider through a resolved requirement. A Facet
	* answering the same Binding name from another `FacetRef` is not among them, and a Facet's
	* position in the child tree never puts it here (SPEC §4.1).
	*/
	reliedUponBy(provider) {
		return this.#reliance.dependents(provider);
	}
	acquire(ref, expected) {
		const facet = this.facet(ref);
		if (facet !== expected) return void 0;
		this.#inFlight += 1;
		let released = false;
		return Object.freeze({
			facet,
			release: () => {
				if (released) return;
				released = true;
				this.#inFlight -= 1;
				if (this.#inFlight === 0) {
					this.#drain?.resolve();
					this.#drain = void 0;
				}
			}
		});
	}
	dispose() {
		if (this.#state === "disposed") return Promise.resolve();
		if (this.#state === "stopping") {
			const transition = this.#transition;
			if (transition === void 0) return Promise.reject(inactive("Facet host stopping transition is missing"));
			return transition;
		}
		const pending = this.#transition;
		const starting = this.#state === "starting";
		this.#state = "stopping";
		const transition = this.stop(pending, starting);
		this.#transition = transition;
		this.#abort.abort();
		transition.finally(() => {
			this.#transition = void 0;
		}).catch(noop);
		return transition;
	}
	async [Symbol.asyncDispose]() {
		await this.dispose();
	}
	async start() {
		const runtime = this.#validator.validate(this.#expected, this.#roots);
		const resolved = this.resolveRequirements(runtime);
		const started = [];
		const context = this.context();
		try {
			for (const resolution of resolved) {
				started.push(resolution.facet);
				this.#reliance.record(resolution);
				await resolution.facet.start(context);
				if (context.signal.aborted) throw inactive("Facet activation was cancelled");
			}
			this.#runtime = runtime;
			this.#state = "active";
		} catch (error) {
			const failed = await stopAll(started.reverse(), context, this.#reliance);
			this.#cleanup = failed;
			this.#runtime = void 0;
			if (this.#state !== "stopping") this.#state = failed.length === 0 ? "inactive" : "cleanup-required";
			throw inactive(`Facet activation failed${failed.length === 0 ? "" : `; ${failed.length} rollback stop hook(s) failed`}${error instanceof Error ? `: ${error.message}` : ""}`);
		}
	}
	/**
	* SPEC §4.1: `start` is not called until every declared `BindingRequirement` resolves to a
	* live provider. The pass covers the whole activation before any Facet starts, so an
	* unresolvable requirement is a rejected install rather than a runtime failure found after
	* a partial start, and no Facet in the activation starts degraded.
	*/
	resolveRequirements(runtime) {
		const installed = new Set(runtime.facets.map((facet) => facet.ref.value));
		const resolved = [];
		for (const facet of runtime.facets) {
			const providers = [];
			for (const requirement of facet.manifest.bindings) {
				const provider = this.#requirements.resolve(facet.ref, requirement);
				if (provider === void 0 || !installed.has(provider.value)) {
					this.#state = "inactive";
					throw rejectedInstall(facet.ref, requirement, provider);
				}
				if (!providers.some((candidate) => candidate.equals(provider))) providers.push(provider);
			}
			resolved.push({
				facet,
				providers: Object.freeze(providers)
			});
		}
		return resolved;
	}
	async stop(pending, starting) {
		if (starting) try {
			await pending;
		} catch {}
		await this.waitForDrain();
		const failures = await stopAll(uniqueFacets([...this.#runtime?.facets ?? [], ...this.#cleanup]).reverse(), this.context(), this.#reliance);
		this.#runtime = void 0;
		this.#cleanup = failures;
		this.#state = failures.length === 0 ? "disposed" : "cleanup-required";
		if (failures.length > 0) throw inactive(`${failures.length} Facet stop hook(s) failed`);
	}
	context() {
		return Object.freeze({ signal: this.#abort.signal });
	}
	waitForDrain() {
		if (this.#inFlight === 0) return Promise.resolve();
		this.#drain ??= deferred();
		return this.#drain.promise;
	}
};
var noReliance = Object.freeze([]);
/**
* The live reliance edges, keyed by the Facet holding them. SPEC §4.1 releases a Facet's edges
* only once its own `stop` has returned, so a provider that stopped first is still the provider
* that dependent reached, and reliance never outlives the dependent that recorded it.
*/
var FacetReliance = class {
	#edges = /* @__PURE__ */ new Map();
	record(resolution) {
		this.#edges.set(resolution.facet.ref.value, resolution);
	}
	release(dependent) {
		this.#edges.delete(dependent.value);
	}
	providers(dependent) {
		return this.#edges.get(dependent.value)?.providers ?? noReliance;
	}
	dependents(provider) {
		const dependents = [];
		for (const edge of this.#edges.values()) if (edge.providers.some((candidate) => candidate.equals(provider))) dependents.push(edge.facet.ref);
		return Object.freeze(dependents);
	}
};
async function stopAll(facets, context, reliance) {
	const failures = [];
	for (const facet of facets) try {
		await facet.stop(context);
	} catch {
		failures.push(facet);
	} finally {
		reliance.release(facet.ref);
	}
	return failures;
}
function uniqueFacets(facets) {
	return [...new Set(facets)];
}
function inactive(message) {
	return new AgentCoreError("facet.inactive", message);
}
/**
* SPEC §4.1: a requirement no Binding satisfies is a rejected install rather than a runtime
* failure, so it names the exact dependent and requirement and is raised before any Facet in
* the activation starts.
*
* The refusal names a composite of four ids, and two different refusals must never read as
* the same one, so the identity is a canonical tuple rather than interpolated text: a
* BindingName or a FacetRef containing a delimiter would otherwise let one rejection be
* spelled by another combination of ids.
*/
function rejectedInstall(dependent, requirement, provider) {
	return new AgentCoreError("binding.invalid", `Facet requirement ${canonicalTupleKey("agent-core.facet.rejected-install.v1", [
		dependent.value,
		requirement.name.value,
		requirement.facet.value,
		provider === void 0 ? null : provider.value
	])} is a rejected install: ${provider === void 0 ? "no Binding satisfies it" : "it resolves to a Facet this activation does not install"}`);
}
function noop() {}
function deferred() {
	let resolve;
	const promise = new Promise((complete) => {
		resolve = complete;
	});
	if (resolve === void 0) throw inactive("Facet drain completion was not initialized");
	return {
		promise,
		resolve
	};
}
//#endregion
export { TurnInterceptorRunner as C, TurnCutPointPort as S, ConfirmedOperationFailure as _, CommandRuntime as a, OperationRequestKey as b, AuthoredCodeCapability as c, AuthoredCodeDelegationPort as d, AuthoredCodeHost as f, decodeSubmission as g, GatewayAuthoredCodeInvocationPort as h, FacetCorrespondenceValidator as i, AuthoredCodeCapabilitySet as l, AuthoredCodeOperation as m, FacetRuntimeHost as n, AuthoredCodeBacking as o, AuthoredCodeInvocationPort as p, FailClosedFacetRequirementResolver as r, AuthoredCodeBackingSet as s, FacetRequirementResolver as t, AuthoredCodeDelegation as u, OperationGateway as v, ResolvedFacet as x, OperationGatewayHost as y };

//# sourceMappingURL=operations-BcSnYjIs.js.map