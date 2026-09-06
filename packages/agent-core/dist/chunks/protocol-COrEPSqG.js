import { D as encodeCanonicalJson, E as decodeCanonicalJson, M as hasExactJsonKeys, d as CodecDeclaration, g as Revision, k as AgentCoreError, x as encodeBase64 } from "./core-BjYGo1CC.js";
import { A as SlotEntry, N as SlotDeclaration, gt as canonicalFacetData, j as InstalledSlot } from "./runtime-z1yMP0an.js";
import "./facets-D01bKQBL.js";
import "./authority-BbHaDuhf.js";
import { D as requireObject, E as requireNonnegativeInteger } from "./public-B8XBKjQB.js";
Object.freeze({
	install: "facet.slot.install",
	contribute: "facet.slot.contribute",
	withdraw: "facet.slot.withdraw"
});
CodecDeclaration.of([InstalledSlot.codec, SlotEntry.codec]);
Object.freeze({
	install(declaration) {
		return encodeCanonicalJson({ record: encodeBase64(SlotDeclaration.encode(declaration)) });
	},
	withdraw(attribution) {
		return encodeCanonicalJson(attribution.encodeFields());
	},
	contribute(request) {
		if (!Number.isSafeInteger(request.ordinal) || request.ordinal < 0) throw new AgentCoreError("protocol.invalid-state", "Slot contribution ordinal must be a non-negative safe integer");
		return encodeCanonicalJson({
			ordinal: request.ordinal,
			slot: request.slot.value,
			value: canonicalFacetData(request.value)
		});
	}
});
var FacetSlotReplyCodec = class {
	encode(reply) {
		return encodeCanonicalJson({ revision: reply.revision.value });
	}
	decode(bytes) {
		const payload = requireObject(decodeCanonicalJson(bytes), "Facet Slot command reply");
		if (!hasExactJsonKeys(payload, ["revision"])) throw new TypeError("Facet Slot command reply contains missing or unknown fields");
		try {
			return Object.freeze({ revision: new Revision(requireNonnegativeInteger(payload["revision"], "Facet Slot command reply revision")) });
		} catch {
			throw new TypeError("Facet Slot command reply revision is invalid");
		}
	}
};
new FacetSlotReplyCodec();
//#endregion
//#region src/protocol/run-commands.ts
var RUN_COMMANDS = Object.freeze({
	create: "run.create",
	createBranch: "run.branch.create",
	appendSystem: "run.commit.system",
	appendTurn: "run.commit.turn",
	merge: "run.merge",
	undo: "run.undo",
	migrate: "run.migrate",
	terminalize: "run.terminalize",
	spawn: "run.spawn",
	createTurn: "turn.create",
	claimTurn: "turn.claim",
	renewTurn: "turn.renew",
	reclaimTurn: "turn.reclaim",
	suspendTurn: "turn.suspend",
	completeTurn: "turn.complete",
	cancelHeldTurn: "turn.cancelHeld",
	cancelUnheldTurn: "turn.cancelUnheld",
	deliverTurnEvent: "turn.deliverEvent"
});
Object.freeze([
	{
		command: RUN_COMMANDS.create,
		requestKind: "createRun",
		caller: "principal",
		expectedRevision: "forbidden",
		lease: "forbidden"
	},
	{
		command: RUN_COMMANDS.createBranch,
		requestKind: "createBranch",
		caller: "owner",
		expectedRevision: "required",
		lease: "forbidden"
	},
	{
		command: RUN_COMMANDS.appendSystem,
		requestKind: "appendSystem",
		caller: "owner",
		expectedRevision: "required",
		lease: "forbidden"
	},
	{
		command: RUN_COMMANDS.appendTurn,
		requestKind: "appendTurn",
		caller: "principal",
		expectedRevision: "required",
		lease: "required"
	},
	{
		command: RUN_COMMANDS.merge,
		requestKind: "merge",
		caller: "owner",
		expectedRevision: "required",
		lease: "forbidden"
	},
	{
		command: RUN_COMMANDS.undo,
		requestKind: "undo",
		caller: "owner",
		expectedRevision: "required",
		lease: "forbidden"
	},
	{
		command: RUN_COMMANDS.migrate,
		requestKind: "migrate",
		caller: "owner",
		expectedRevision: "required",
		lease: "forbidden"
	},
	{
		command: RUN_COMMANDS.terminalize,
		requestKind: "terminalize",
		caller: "principal",
		expectedRevision: "required",
		lease: "required"
	},
	{
		command: RUN_COMMANDS.spawn,
		requestKind: "spawn",
		caller: "principal",
		expectedRevision: "required",
		lease: "required"
	},
	{
		command: RUN_COMMANDS.createTurn,
		requestKind: "createTurn",
		caller: "principal",
		expectedRevision: "required",
		lease: "forbidden"
	},
	{
		command: RUN_COMMANDS.claimTurn,
		requestKind: "claimTurn",
		caller: "principal",
		expectedRevision: "required",
		lease: "forbidden"
	},
	{
		command: RUN_COMMANDS.renewTurn,
		requestKind: "renewTurn",
		caller: "principal",
		expectedRevision: "required",
		lease: "required"
	},
	{
		command: RUN_COMMANDS.reclaimTurn,
		requestKind: "reclaimTurn",
		caller: "principal",
		expectedRevision: "required",
		lease: "forbidden"
	},
	{
		command: RUN_COMMANDS.suspendTurn,
		requestKind: "suspendTurn",
		caller: "principal",
		expectedRevision: "required",
		lease: "required"
	},
	{
		command: RUN_COMMANDS.completeTurn,
		requestKind: "completeTurn",
		caller: "principal",
		expectedRevision: "required",
		lease: "required"
	},
	{
		command: RUN_COMMANDS.cancelHeldTurn,
		requestKind: "cancelHeldTurn",
		caller: "principal",
		expectedRevision: "required",
		lease: "required"
	},
	{
		command: RUN_COMMANDS.cancelUnheldTurn,
		requestKind: "cancelUnheldTurn",
		caller: "owner",
		expectedRevision: "required",
		lease: "forbidden"
	},
	{
		command: RUN_COMMANDS.deliverTurnEvent,
		requestKind: "deliverTurnEvent",
		caller: "owner",
		expectedRevision: "required",
		lease: "required"
	}
]);
Object.freeze({ encode(request) {
	return encodeCanonicalJson(requestData(request));
} });
function requestData(request) {
	switch (request.kind) {
		case "createRun": return { run: request.run.value };
		case "createBranch": return {
			branch: request.branch.value,
			run: request.run.value
		};
		case "appendSystem":
		case "appendTurn":
		case "merge":
		case "undo":
		case "migrate": return {
			branch: request.branch.value,
			commit: request.commit.value,
			run: request.run.value
		};
		case "terminalize": return {
			commit: request.commit.value,
			outcome: request.outcome,
			run: request.run.value,
			turn: request.turn.value
		};
		case "spawn": return {
			child: request.child.value,
			reservation: request.reservation.value,
			run: request.run.value,
			turn: request.turn.value
		};
		case "createTurn": return {
			branch: request.branch.value,
			run: request.run.value,
			turn: request.turn.value
		};
		case "claimTurn":
		case "renewTurn":
		case "reclaimTurn": return {
			expiresAt: request.expiresAt.getTime(),
			turn: request.turn.value
		};
		case "suspendTurn": return {
			commit: request.commit.value,
			turn: request.turn.value
		};
		case "completeTurn": return {
			commit: request.commit.value,
			outcome: request.outcome,
			turn: request.turn.value
		};
		case "cancelHeldTurn":
		case "cancelUnheldTurn": return { turn: request.turn.value };
		case "deliverTurnEvent": return {
			entry: request.entry.value,
			turn: request.turn.value
		};
	}
}
//#endregion

//# sourceMappingURL=protocol-COrEPSqG.js.map