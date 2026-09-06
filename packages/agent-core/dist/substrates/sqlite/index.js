import { D as encodeCanonicalJson, L as isObjectRecord, P as isJsonObject, T as compareCanonicalText, _ as ContentRef, f as RecordCodec, g as Revision, j as TextId, k as AgentCoreError, o as isMember, y as Digest } from "../../chunks/core-BjYGo1CC.js";
import { i as ActorActivation, o as requireSynchronousResult, s as ActorRecoveryState } from "../../chunks/actors-DJsP1nFM.js";
import { I as PackageId } from "../../chunks/runtime-z1yMP0an.js";
import { u as WriteRecordId } from "../../chunks/facets-D01bKQBL.js";
import { A as Tenant, B as WorkspaceId, E as encodeScopeRef, F as ProjectId, I as RoleName, L as ShareOfferId, M as GuestTrustId, N as MembershipId, O as Project, P as PrincipalId, R as TeamId, a as ShareOffer, h as Role, i as GuestTrust, j as Principal, k as Team, r as Workspace, t as IdentityRepository, u as Membership, x as encodeSubjectRef, z as TenantId } from "../../chunks/identity-CoqhjOFj.js";
import { A as Binding, D as InvalidationWatermark, E as Grant, F as subjectKey, I as GrantId, N as domainKey, P as scopeKey, _ as TargetAuthorityPermitDenial, a as watermarkKey, c as AuthorityChangeSet, g as requireAuthenticatedAuthorityPermit, k as ScopeEpoch, l as assertAuthorityClosure, s as createTenantControlBootstrapPlan, t as TenantAuthorityTransactionPort, v as TargetAuthorityPermitRequest, w as AuthorityPermit, y as TargetLeaseEvidence } from "../../chunks/authority-BbHaDuhf.js";
import { G as RunStoragePort, U as RUN_RECORD_KINDS, q as ownRunStorageBackend } from "../../chunks/runs-CRnZ9IFu.js";
import { i as InvocationId, n as CorrelationId, t as AuditRecordId } from "../../chunks/interaction-references-D9spp037.js";
import { At as PackageLock, Nt as PackageRelease, jt as MetadataSnapshot } from "../../chunks/definition-COokGikL.js";
import { F as PreEffectReceipt, H as DetachedEffectExecution, P as AttemptReceipt, R as receiptContentRetention, Y as InvocationPublicationOutbox, dt as InvocationError, g as MediatedReplayRecord } from "../../chunks/invocations-Cpv8tzSW.js";
import { _ as ByteRange, a as TransientContentAccess, c as ContentStore, d as ContentRecordCustody, f as ContentRetention, g as requireOperationTime, h as requireCollectionTime, l as ContentStat, o as TransientContentLease, s as TransientContentLeaseState, u as ContentOwnerEdge, v as MediaHint } from "../../chunks/content-DYlOXpyu.js";
import { C as TenantBootstrapAnchorRecord, d as ProtocolRecordStorage, g as CommandDispatcher, m as CommandIngress, u as ProtocolPersistenceAdapter, w as createTenantBootstrapCommand } from "../../chunks/public-B8XBKjQB.js";
import "../../chunks/protocol-COrEPSqG.js";
import { _ as DELETABLE_WORKSPACE_RECORD_KINDS, b as validateWorkspacePointerAdvance, g as authorityPermitReferenceCodec, o as mediationInvocationCodecs, t as TargetPermitMediationAggregate, v as WORKSPACE_RECORD_KINDS, x as validateWorkspaceUnique, y as validateStoredWorkspaceRecord } from "../../chunks/composition-CxmTB6HT.js";
//#region src/substrates/sqlite/sqlite.ts
var sqliteMutationCapabilityBrand = Symbol("agent-core.sqlite-mutation");
var sqliteMutationCapabilityMarker = true;
var sqliteProvenance = /* @__PURE__ */ new WeakMap();
var sqliteDatabaseProvenance = /* @__PURE__ */ new WeakMap();
var sqliteCapabilities = /* @__PURE__ */ new WeakMap();
function isSqliteText(value) {
	return typeof value === "string";
}
function isSqliteNumber(value) {
	return typeof value === "number";
}
var ReadableSqlite = class {
	#reader;
	all;
	constructor(construction) {
		let source;
		let view;
		let sourceReader;
		if ("source" in construction) {
			source = construction.source;
			view = construction.view;
			sourceReader = source.#reader;
		} else sourceReader = construction.read;
		const reader = source === void 0 ? sourceReader : (statement, bindings) => {
			view?.beforeRead?.(statement, bindings);
			const rows = sourceReader(statement, bindings);
			return view?.projectRows?.(statement, rows) ?? rows;
		};
		this.#reader = reader;
		sqliteProvenance.set(this, provenance(construction, source));
		if (view?.capability !== void 0) sqliteCapabilities.set(this, view.capability);
		this.all = (statement, bindings) => {
			requireReadAccess(this);
			return this.#reader(statement, bindings);
		};
		Object.defineProperty(this, "all", {
			configurable: false,
			enumerable: false,
			writable: false
		});
	}
};
var TransactionalSqlite = class extends ReadableSqlite {
	#writer;
	run;
	constructor(construction) {
		super(readConstruction(construction));
		let writer;
		if ("source" in construction) writer = construction.view === void 0 ? construction.source.#writer : derivedWriter(construction.source.#writer, construction.view);
		else writer = construction.write;
		this.#writer = writer;
		this.run = (statement, bindings) => {
			requireMutationAccess(this);
			this.#writer(statement, bindings);
		};
		Object.defineProperty(this, "run", {
			configurable: false,
			enumerable: false,
			writable: false
		});
	}
};
function hasSameSqliteProvenance(left, right) {
	const owner = sqliteProvenance.get(left);
	return owner !== void 0 && owner === sqliteProvenance.get(right);
}
function ownSqliteMutations(database) {
	const owner = requireProvenance(database);
	const arbiter = owner.arbiter ?? (owner.arbiter = {
		capability: Object.freeze({ [sqliteMutationCapabilityBrand]: sqliteMutationCapabilityMarker }),
		active: void 0
	});
	if (sqliteCapabilities.get(database) === arbiter.capability) return database;
	return new MutationOwnedSqlite(database, arbiter.capability);
}
function withExclusiveSqliteMutation(database, operation, ...guard) {
	const arbiter = requireProvenance(database).arbiter;
	if (arbiter === void 0 || sqliteCapabilities.get(database) !== arbiter.capability) throw invalidMutation("SQLite mutation authority is not owned by this database view");
	if (arbiter.active !== void 0) throw poison(arbiter.active, "Nested exclusive SQLite mutations are not supported");
	const authority = { failure: void 0 };
	const scope = new MutationScopedSqlite(database, arbiter.capability);
	arbiter.active = authority;
	try {
		return database.transaction(() => {
			const result = operation(scope);
			if (authority.failure !== void 0) throw authority.failure;
			return result;
		}, ...guard);
	} finally {
		arbiter.active = void 0;
	}
}
var MutationOwnedSqlite = class extends TransactionalSqlite {
	#source;
	constructor(source, capability) {
		super({
			source,
			view: { capability }
		});
		this.#source = source;
	}
	transaction(operation, ...guard) {
		return this.#source.transaction(operation, ...guard);
	}
};
var MutationScopedSqlite = class extends TransactionalSqlite {
	constructor(source, capability) {
		super({
			source,
			view: { capability }
		});
	}
	transaction(_operation, ..._guard) {
		throw invalidMutation("Nested exclusive SQLite mutations are not supported");
	}
};
function readConstruction(construction) {
	if ("source" in construction) return construction.view === void 0 ? { source: construction.source } : {
		source: construction.source,
		view: construction.view
	};
	return construction.identity === void 0 ? { read: construction.read } : {
		read: construction.read,
		identity: construction.identity
	};
}
function derivedWriter(source, view) {
	return (statement, bindings) => {
		view.beforeRun?.(statement, bindings);
		source(statement, bindings);
	};
}
function requireReadAccess(database) {
	const owner = requireProvenance(database);
	const active = owner.arbiter?.active;
	if (active === void 0) return;
	requireCapability(database, owner, active);
}
function requireMutationAccess(database) {
	const arbiter = requireProvenance(database).arbiter;
	if (arbiter === void 0) return;
	const active = arbiter.active;
	if (sqliteCapabilities.get(database) !== arbiter.capability) {
		if (active !== void 0) throw poison(active, "SQLite access outside the active storage mutation authority is forbidden");
		throw invalidMutation("SQLite mutation requires its database-owned authority");
	}
	if (active?.failure !== void 0) throw active.failure;
}
function requireCapability(database, owner, active) {
	if (sqliteCapabilities.get(database) !== owner.arbiter?.capability) throw poison(active, "SQLite access outside the active storage mutation authority is forbidden");
	if (active.failure !== void 0) throw active.failure;
}
function poison(authority, message) {
	authority.failure ??= invalidMutation(message);
	return authority.failure;
}
function invalidMutation(message) {
	return new AgentCoreError("protocol.invalid-state", message);
}
function requireProvenance(database) {
	const value = sqliteProvenance.get(database);
	if (value === void 0) throw invalidMutation("SQLite capability is not initialized");
	return value;
}
function provenance(construction, source) {
	if (source !== void 0) return requireProvenance(source);
	if (!("identity" in construction) || construction.identity === void 0) return { arbiter: void 0 };
	const existing = sqliteDatabaseProvenance.get(construction.identity);
	if (existing !== void 0) return existing;
	const created = { arbiter: void 0 };
	sqliteDatabaseProvenance.set(construction.identity, created);
	return created;
}
//#endregion
//#region src/substrates/sqlite/actor.ts
var CREATE_ACTOR_STATE = `CREATE TABLE IF NOT EXISTS actor_recovery_state (
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    state BLOB NOT NULL,
    PRIMARY KEY (actor_kind, actor_id)
)`;
/**
* Separate from actor_recovery_state on purpose. Recovery is the stable bootstrap carrier
* a rollback must decode to construct and fence the Actor; these raw declaration bytes are
* read by the current Actor before it starts any record-owning work and can therefore defer
* a malformed or future declaration to every operation rather than construction.
*/
var CREATE_ACTOR_RECORD_SET_DECLARATION = `CREATE TABLE IF NOT EXISTS actor_record_set_declaration (
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    declaration BLOB NOT NULL,
    PRIMARY KEY (actor_kind, actor_id)
)`;
var CREATE_ACTOR_IDENTITY = `CREATE TABLE IF NOT EXISTS actor_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    UNIQUE (actor_kind, actor_id)
)`;
var activeActorTransactions = /* @__PURE__ */ new WeakSet();
var activeActorTransactionScopes = /* @__PURE__ */ new WeakSet();
function isActiveSqliteActorTransaction(transaction) {
	return activeActorTransactionScopes.has(transaction);
}
var SqliteActorStore = class {
	database;
	#actor;
	#activeActor;
	#activeTransaction;
	constructor(database) {
		this.database = database;
		this.database.transaction(() => {
			this.database.run(CREATE_ACTOR_IDENTITY, []);
			this.database.run(CREATE_ACTOR_STATE, []);
			this.database.run(CREATE_ACTOR_RECORD_SET_DECLARATION, []);
		});
	}
	bindActor(actor) {
		const bound = this.#activeTransaction === void 0 ? this.#actor : this.#activeActor;
		if (bound !== void 0 && !bound.equals(actor)) throw actorIsolationError();
		if (this.#activeTransaction !== void 0) {
			this.bindIdentity(this.#activeTransaction, actor);
			this.#activeActor = actor;
			return;
		}
		if (activeActorTransactions.has(this.database)) throw invalidState("Nested actor transactions are not supported");
		this.database.transaction(() => {
			this.bindIdentity(this.database, actor);
		});
		this.#actor = actor;
	}
	activateActor(actor, start) {
		return this.transaction((transaction) => {
			const existing = this.storedIdentity(transaction) !== void 0;
			this.bindActor(actor);
			const previous = this.loadRecoveryState(transaction, actor);
			if (existing && previous === void 0) throw missingRecoveryState();
			if (!existing && previous !== void 0) throw new AgentCoreError("codec.invalid", "Unbound Actor storage cannot contain recovery state");
			const next = previous === void 0 ? ActorRecoveryState.initial(actor) : previous.recover();
			this.saveRecoveryState(transaction, next);
			requireSynchronousResult(start(transaction, previous === void 0 ? ActorActivation.created(next) : ActorActivation.recovered(next)));
			return next;
		});
	}
	transaction(operation, ..._guard) {
		return this.transact(operation);
	}
	/** Runtime-guarded form for ports whose interface cannot express the conditional tuple. */
	transact(operation) {
		if (this.#activeTransaction !== void 0 || activeActorTransactions.has(this.database)) throw invalidState("Nested actor transactions are not supported");
		activeActorTransactions.add(this.database);
		let committedActor = this.#actor;
		try {
			const outcome = this.database.transaction(() => {
				const transaction = new SqliteTransactionScope(this.database);
				activeActorTransactionScopes.add(transaction);
				this.#activeTransaction = transaction;
				this.#activeActor = this.#actor;
				try {
					return { result: requireSynchronousResult(operation(transaction)) };
				} finally {
					committedActor = this.#activeActor;
					this.#activeTransaction = void 0;
					this.#activeActor = void 0;
					transaction.close();
				}
			});
			this.#actor = committedActor;
			return outcome.result;
		} finally {
			activeActorTransactions.delete(this.database);
		}
	}
	read(transaction, operation, ..._guard) {
		if (transaction !== this.#activeTransaction) throw staleTransaction("Protocol reads require the active SQLite actor transaction");
		return this.#activeTransaction.read(operation);
	}
	loadRecoveryState(transaction, actor) {
		this.requireActiveTransaction(transaction);
		this.requireBoundActor(actor);
		const row = transaction.all(`SELECT state
             FROM actor_recovery_state
             WHERE actor_kind = ? AND actor_id = ?`, [actor.kind, actor.id.value])[0];
		if (row === void 0) return;
		const state = ActorRecoveryState.codec.decode(bytes$9(row, "state"));
		if (!state.actor.equals(actor)) throw new AgentCoreError("codec.invalid", "Actor recovery state does not match its storage key");
		return state;
	}
	saveRecoveryState(transaction, state) {
		this.requireActiveTransaction(transaction);
		this.requireBoundActor(state.actor);
		transaction.run(`INSERT INTO actor_recovery_state (actor_kind, actor_id, state)
             VALUES (?, ?, ?)
             ON CONFLICT(actor_kind, actor_id) DO UPDATE SET
                state = excluded.state`, [
			state.actor.kind,
			state.actor.id.value,
			ActorRecoveryState.codec.encode(state)
		]);
	}
	loadRecordSetDeclaration(transaction, actor) {
		this.requireActiveTransaction(transaction);
		this.requireBoundActor(actor);
		const row = transaction.all(`SELECT declaration
             FROM actor_record_set_declaration
             WHERE actor_kind = ? AND actor_id = ?`, [actor.kind, actor.id.value])[0];
		return row === void 0 ? void 0 : bytes$9(row, "declaration");
	}
	saveRecordSetDeclaration(transaction, actor, declaration) {
		this.requireActiveTransaction(transaction);
		this.requireBoundActor(actor);
		transaction.run(`INSERT INTO actor_record_set_declaration (actor_kind, actor_id, declaration)
             VALUES (?, ?, ?)
             ON CONFLICT(actor_kind, actor_id) DO UPDATE SET
                declaration = excluded.declaration`, [
			actor.kind,
			actor.id.value,
			declaration.slice()
		]);
	}
	requireBoundActor(actor) {
		const bound = this.#activeTransaction === void 0 ? this.#actor : this.#activeActor;
		if (bound === void 0 || !bound.equals(actor)) throw actorIsolationError();
	}
	bindIdentity(transaction, actor) {
		transaction.run(`INSERT OR IGNORE INTO actor_identity (singleton, actor_kind, actor_id)
             VALUES (1, ?, ?)`, [actor.kind, actor.id.value]);
		const stored = this.storedIdentity(transaction);
		if (stored?.["actor_kind"] !== actor.kind || stored["actor_id"] !== actor.id.value) throw actorIsolationError();
	}
	storedIdentity(transaction) {
		return transaction.all("SELECT actor_kind, actor_id FROM actor_identity WHERE singleton = 1", [])[0];
	}
	requireActiveTransaction(transaction) {
		if (transaction !== this.#activeTransaction) throw staleTransaction("Actor recovery state requires the active SQLite transaction");
	}
};
var SqliteTransactionScope = class extends TransactionalSqlite {
	#state;
	constructor(database) {
		const state = { open: true };
		super({
			source: database,
			view: {
				beforeRead: () => requireOpen(state, "Actor transaction is no longer active"),
				beforeRun: () => requireOpen(state, "Actor transaction is no longer active")
			}
		});
		this.#state = state;
	}
	transaction(_operation, ..._guard) {
		this.requireOpen();
		throw invalidState("Nested actor transactions are not supported");
	}
	close() {
		this.#state.open = false;
		activeActorTransactionScopes.delete(this);
	}
	read(operation) {
		this.requireOpen();
		const scope = new SqliteReadScope(this);
		try {
			return requireSynchronousResult(operation(scope));
		} finally {
			scope.close();
		}
	}
	requireOpen() {
		requireOpen(this.#state, "Actor transaction is no longer active");
	}
};
var SqliteReadScope = class extends ReadableSqlite {
	#state;
	constructor(database) {
		const state = { open: true };
		super({
			source: database,
			view: { beforeRead: (statement) => {
				requireOpen(state, "Protocol read transaction is no longer active");
				requireReadOnlyStatement(statement);
			} }
		});
		this.#state = state;
	}
	close() {
		this.#state.open = false;
	}
};
function requireOpen(state, message) {
	if (!state.open) throw new AgentCoreError("actor.closed", message);
}
function requireReadOnlyStatement(statement) {
	const normalized = statement.trim();
	if (!/^SELECT\b/i.test(normalized) || normalized.slice(0, -1).includes(";")) throw invalidState("Actor read scopes accept one SELECT statement only");
}
function actorIsolationError() {
	return invalidState("SQLite ActorStore is bound to a different Actor");
}
function invalidState(message) {
	return new AgentCoreError("protocol.invalid-state", message);
}
function staleTransaction(message) {
	return new AgentCoreError("actor.stale-callback", message);
}
function missingRecoveryState() {
	return new AgentCoreError("codec.invalid", "Existing Actor storage is missing recovery state");
}
function bytes$9(row, column) {
	const value = row[column];
	if (!(value instanceof Uint8Array)) throw new AgentCoreError("codec.invalid", "Actor recovery state storage is malformed");
	return value;
}
//#endregion
//#region src/substrates/sqlite/protocol.ts
var PROTOCOL_SCHEMA_VERSION = 4;
var SCHEMA_OBJECTS = [
	"protocol_schema",
	"protocol_audit_records",
	"protocol_write_records",
	"protocol_principal_identity",
	"protocol_actor_identity",
	"protocol_command_identities"
];
var CREATE_SCHEMA$1 = `CREATE TABLE protocol_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version > 0)
) STRICT`;
var CREATE_AUDITS = `CREATE TABLE protocol_audit_records (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    evidence_identity TEXT NOT NULL UNIQUE,
    evidence_kind TEXT NOT NULL,
    write_id TEXT,
    write_outcome TEXT,
    record BLOB NOT NULL,
    CHECK (
        (evidence_kind = 'write' AND write_id IS NOT NULL AND write_outcome IS NOT NULL)
        OR (evidence_kind <> 'write' AND write_id IS NULL AND write_outcome IS NULL)
    )
) STRICT`;
var CREATE_WRITES = `CREATE TABLE protocol_write_records (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    audit_id TEXT NOT NULL UNIQUE,
    outcome TEXT NOT NULL,
    caller_kind TEXT,
    principal_tenant_id TEXT,
    principal_id TEXT,
    actor_kind TEXT,
    actor_id TEXT,
    idempotency_key TEXT,
    record BLOB NOT NULL,
    CHECK (
        (caller_kind IS NULL AND principal_tenant_id IS NULL AND principal_id IS NULL
            AND actor_kind IS NULL
            AND actor_id IS NULL AND idempotency_key IS NULL)
        OR (caller_kind = 'principal' AND principal_tenant_id IS NOT NULL
            AND principal_id IS NOT NULL
            AND actor_kind IS NULL AND actor_id IS NULL AND idempotency_key IS NOT NULL)
        OR (caller_kind = 'actor' AND principal_tenant_id IS NULL AND principal_id IS NULL
            AND actor_kind IS NOT NULL AND actor_id IS NOT NULL AND idempotency_key IS NOT NULL)
    )
) STRICT`;
var CREATE_PRINCIPAL_IDENTITY_INDEX = `CREATE UNIQUE INDEX protocol_principal_identity
    ON protocol_write_records (principal_tenant_id, principal_id, idempotency_key)
    WHERE caller_kind = 'principal'`;
var CREATE_ACTOR_IDENTITY_INDEX = `CREATE UNIQUE INDEX protocol_actor_identity
    ON protocol_write_records (actor_kind, actor_id, idempotency_key)
    WHERE caller_kind = 'actor'`;
var CREATE_IDENTITY_VIEW = `CREATE VIEW protocol_command_identities AS
    SELECT sequence, caller_kind, principal_tenant_id, principal_id, actor_kind, actor_id,
           idempotency_key, id AS write_id
    FROM protocol_write_records
    WHERE caller_kind IS NOT NULL`;
var SqliteProtocolPersistence = class extends ProtocolPersistenceAdapter {
	constructor(database) {
		super();
		database.transaction(() => {
			initializeSchema(database);
			rebuildIdentityView(database);
			validateSchema(database);
			this.repair(database);
		});
	}
	storage(transaction) {
		return new SqliteProtocolRecords(transaction);
	}
};
var SqliteProtocolRecords = class extends ProtocolRecordStorage {
	database;
	constructor(database) {
		super();
		this.database = database;
	}
	findAudit(id) {
		const row = this.database.all(`SELECT id, evidence_identity, evidence_kind, write_id, write_outcome, record
             FROM protocol_audit_records
             WHERE id = ?`, [id])[0];
		if (row === void 0) return void 0;
		return storedAudit(row);
	}
	findAuditByEvidence(identity) {
		const row = this.database.all(`SELECT id, evidence_identity, evidence_kind, write_id, write_outcome, record
             FROM protocol_audit_records
             WHERE evidence_identity = ?`, [identity])[0];
		return row === void 0 ? void 0 : storedAudit(row);
	}
	findWrite(id) {
		const row = this.database.all(`SELECT id, audit_id, outcome, record
             FROM protocol_write_records
             WHERE id = ?`, [id])[0];
		return row === void 0 ? void 0 : storedWrite(row);
	}
	scanAudits() {
		return this.database.all(`SELECT id, evidence_identity, evidence_kind, write_id, write_outcome, record
             FROM protocol_audit_records
             ORDER BY sequence`, []).map(storedAudit);
	}
	scanWrites() {
		return this.database.all(`SELECT id, audit_id, outcome, record
             FROM protocol_write_records
             ORDER BY sequence`, []).map(storedWrite);
	}
	insertAudit(record) {
		this.database.run(`INSERT INTO protocol_audit_records (
                id, evidence_identity, evidence_kind, write_id, write_outcome, record
             ) VALUES (?, ?, ?, ?, ?, ?)`, [
			record.id,
			record.evidenceIdentity,
			record.evidenceKind,
			record.writeId?.value ?? null,
			record.writeOutcome ?? null,
			record.bytes
		]);
	}
	insertWrite(record, identity) {
		const projection = identityBindings(identity);
		this.database.run(`INSERT INTO protocol_write_records (
                id, audit_id, outcome, caller_kind, principal_tenant_id, principal_id,
                actor_kind, actor_id, idempotency_key, record
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
			record.id,
			record.auditId.value,
			record.outcome,
			...projection,
			record.bytes
		]);
	}
	synchronizeIdentityProjection(entries) {
		dropIdentityIndexes(this.database);
		this.database.run(`UPDATE protocol_write_records SET
                caller_kind = NULL, principal_tenant_id = NULL, principal_id = NULL,
                actor_kind = NULL,
                actor_id = NULL, idempotency_key = NULL`, []);
		for (const entry of entries) this.database.run(`UPDATE protocol_write_records SET
                    caller_kind = ?, principal_tenant_id = ?, principal_id = ?,
                    actor_kind = ?, actor_id = ?, idempotency_key = ?
                 WHERE id = ?`, [...identityBindings(entry.identity), entry.writeId.value]);
		rebuildIdentityIndexes(this.database);
	}
};
function initializeSchema(database) {
	const existing = database.all(`SELECT name, type FROM sqlite_schema
         WHERE name IN (${SCHEMA_OBJECTS.map(() => "?").join(", ")})`, [...SCHEMA_OBJECTS]);
	if (existing.length === 0) {
		database.run(CREATE_SCHEMA$1, []);
		database.run("INSERT INTO protocol_schema (singleton, version) VALUES (1, ?)", [PROTOCOL_SCHEMA_VERSION]);
		database.run(CREATE_AUDITS, []);
		database.run(CREATE_WRITES, []);
		database.run(CREATE_PRINCIPAL_IDENTITY_INDEX, []);
		database.run(CREATE_ACTOR_IDENTITY_INDEX, []);
		return;
	}
	if (!existing.some((row) => row["name"] === "protocol_schema" && row["type"] === "table")) throw corruptProtocolRow("Legacy protocol persistence schema is not accepted");
}
function validateSchema(database) {
	const required = /* @__PURE__ */ new Map([
		["protocol_schema", "table"],
		["protocol_audit_records", "table"],
		["protocol_write_records", "table"],
		["protocol_command_identities", "view"]
	]);
	const rows = database.all(`SELECT name, type FROM sqlite_schema
         WHERE name IN (${SCHEMA_OBJECTS.map(() => "?").join(", ")})`, [...SCHEMA_OBJECTS]);
	for (const row of rows) {
		const name = text$9(row, "name");
		if (!required.has(name)) continue;
		if (required.get(name) !== text$9(row, "type")) throw corruptProtocolRow(`SQLite protocol schema object is invalid: ${name}`);
		required.delete(name);
	}
	if (required.size !== 0) throw corruptProtocolRow("SQLite protocol schema is incomplete");
	for (const table of [
		"protocol_schema",
		"protocol_audit_records",
		"protocol_write_records"
	]) if (database.all("PRAGMA table_list", []).find((row) => row["name"] === table)?.["strict"] !== 1) throw corruptProtocolRow(`SQLite protocol table is not STRICT: ${table}`);
	requireColumns(database, "protocol_schema", ["singleton", "version"]);
	requireColumns(database, "protocol_audit_records", [
		"sequence",
		"id",
		"evidence_identity",
		"evidence_kind",
		"write_id",
		"write_outcome",
		"record"
	]);
	requireColumns(database, "protocol_write_records", [
		"sequence",
		"id",
		"audit_id",
		"outcome",
		"caller_kind",
		"principal_tenant_id",
		"principal_id",
		"actor_kind",
		"actor_id",
		"idempotency_key",
		"record"
	]);
	requireColumns(database, "protocol_command_identities", [
		"sequence",
		"caller_kind",
		"principal_tenant_id",
		"principal_id",
		"actor_kind",
		"actor_id",
		"idempotency_key",
		"write_id"
	]);
	requireIdentityViewProjection(database);
	const versionRows = database.all("SELECT singleton, version FROM protocol_schema", []);
	if (versionRows.length !== 1 || versionRows[0]?.["singleton"] !== 1 || versionRows[0]?.["version"] !== PROTOCOL_SCHEMA_VERSION) throw corruptProtocolRow("SQLite protocol schema version is unsupported");
}
function rebuildIdentityView(database) {
	const row = database.all("SELECT name, type FROM sqlite_schema WHERE name = ?", ["protocol_command_identities"])[0];
	if (row !== void 0) {
		if (text$9(row, "type") !== "view") throw corruptProtocolRow("SQLite protocol schema object is invalid: protocol_command_identities");
		database.run("DROP VIEW protocol_command_identities", []);
	}
	database.run(CREATE_IDENTITY_VIEW, []);
}
function requireIdentityViewProjection(database) {
	if (database.all(`SELECT
            EXISTS (
                SELECT sequence, caller_kind, principal_tenant_id, principal_id, actor_kind, actor_id,
                       idempotency_key, id AS write_id
                FROM protocol_write_records
                WHERE caller_kind IS NOT NULL
                EXCEPT
                SELECT sequence, caller_kind, principal_tenant_id, principal_id, actor_kind, actor_id,
                       idempotency_key, write_id
                FROM protocol_command_identities
            ) OR EXISTS (
                SELECT sequence, caller_kind, principal_tenant_id, principal_id, actor_kind, actor_id,
                       idempotency_key, write_id
                FROM protocol_command_identities
                EXCEPT
                SELECT sequence, caller_kind, principal_tenant_id, principal_id, actor_kind, actor_id,
                       idempotency_key, id AS write_id
                FROM protocol_write_records
                WHERE caller_kind IS NOT NULL
            ) AS mismatched`, [])[0]?.["mismatched"] !== 0) throw corruptProtocolRow("SQLite protocol identity view projection is invalid");
}
function requireColumns(database, table, expected) {
	const columns = database.all(`PRAGMA table_info(${table})`, []).map((row) => text$9(row, "name"));
	if (columns.length !== expected.length || columns.some((column, index) => column !== expected[index])) throw corruptProtocolRow(`SQLite protocol table columns are invalid: ${table}`);
}
function rebuildIdentityIndexes(database) {
	try {
		database.run(CREATE_PRINCIPAL_IDENTITY_INDEX, []);
		database.run(CREATE_ACTOR_IDENTITY_INDEX, []);
	} catch (error) {
		throw new AgentCoreError("protocol.invalid-state", `Cannot rebuild protocol identity projection: ${error instanceof Error ? error.message : String(error)}`);
	}
}
function dropIdentityIndexes(database) {
	database.run("DROP INDEX IF EXISTS protocol_principal_identity", []);
	database.run("DROP INDEX IF EXISTS protocol_actor_identity", []);
}
function identityBindings(identity) {
	if (identity === void 0) return [
		null,
		null,
		null,
		null,
		null,
		null
	];
	return identity.caller.kind === "principal" ? [
		identity.caller.kind,
		identity.caller.tenantId.value,
		identity.caller.id,
		null,
		null,
		identity.idempotencyKey
	] : [
		identity.caller.kind,
		null,
		null,
		identity.caller.actorKind,
		identity.caller.id,
		identity.idempotencyKey
	];
}
function storedWrite(row) {
	return {
		id: text$9(row, "id"),
		auditId: new AuditRecordId(text$9(row, "audit_id")),
		outcome: commandOutcome(text$9(row, "outcome")),
		bytes: bytes$8(row, "record")
	};
}
function storedAudit(row) {
	const writeId = nullableText$3(row, "write_id");
	const writeOutcome = nullableText$3(row, "write_outcome");
	let audit = {
		id: text$9(row, "id"),
		evidenceIdentity: text$9(row, "evidence_identity"),
		evidenceKind: auditKind(text$9(row, "evidence_kind")),
		bytes: bytes$8(row, "record")
	};
	if (writeId !== void 0) audit = {
		...audit,
		writeId: new WriteRecordId(writeId)
	};
	if (writeOutcome !== void 0) audit = {
		...audit,
		writeOutcome: commandOutcome(writeOutcome)
	};
	return audit;
}
function auditKind(value) {
	if (value === "invocation" || value === "approval" || value === "attempt" || value === "receipt" || value === "receiptSuperseded" || value === "write" || value === "event" || value === "routeReserved" || value === "routeProjected" || value === "delivery" || value === "commit") return value;
	throw corruptProtocolRow("Stored protocol audit kind is invalid");
}
function commandOutcome(value) {
	if (value === "committed" || value === "rejectedMalformed" || value === "rejectedAuthentication" || value === "rejectedAuthority" || value === "rejectedLifecycle" || value === "rejectedRevision" || value === "rejectedLease" || value === "duplicate") return value;
	throw corruptProtocolRow("Stored protocol write outcome is invalid");
}
function bytes$8(row, column) {
	const value = row[column];
	if (!(value instanceof Uint8Array)) throw corruptProtocolRow(`Expected byte column: ${column}`);
	return value.slice();
}
function text$9(row, column) {
	const value = row[column];
	if (!isSqliteText(value)) throw corruptProtocolRow(`Expected text column: ${column}`);
	return value;
}
function nullableText$3(row, column) {
	const value = row[column];
	if (value === null) return void 0;
	if (!isSqliteText(value)) throw corruptProtocolRow(`Expected nullable text column: ${column}`);
	return value;
}
function corruptProtocolRow(message) {
	return new AgentCoreError("codec.invalid", message);
}
//#endregion
//#region src/substrates/sqlite/authority.ts
var CREATE_GRANTS = `CREATE TABLE IF NOT EXISTS tenant_grants (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    scope_key TEXT NOT NULL CHECK (length(scope_key) > 0),
    subject_key TEXT NOT NULL CHECK (length(subject_key) > 0),
    effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
    parent_grant_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
    record BLOB NOT NULL,
    CHECK (effect = 'allow' OR parent_grant_id IS NULL)
) STRICT`;
var CREATE_GRANT_SCOPE_INDEX = `CREATE INDEX IF NOT EXISTS tenant_grants_scope_subject
    ON tenant_grants (scope_key, subject_key, state)`;
var CREATE_BINDINGS = `CREATE TABLE IF NOT EXISTS tenant_bindings (
    binding_key TEXT PRIMARY KEY CHECK (length(binding_key) > 0),
    scope_key TEXT NOT NULL CHECK (length(scope_key) > 0),
    subject_key TEXT NOT NULL CHECK (length(subject_key) > 0),
    domain_key TEXT NOT NULL CHECK (length(domain_key) > 0),
    name TEXT NOT NULL CHECK (length(name) > 0),
    grant_id TEXT NOT NULL CHECK (length(grant_id) > 0),
    facet_ref TEXT NOT NULL CHECK (length(facet_ref) > 0),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'inactive')),
    record BLOB NOT NULL
) STRICT`;
var CREATE_BINDING_LOOKUP = `CREATE UNIQUE INDEX IF NOT EXISTS tenant_binding_lookup
    ON tenant_bindings (scope_key, subject_key, domain_key, name)`;
var CREATE_SCOPE_EPOCHS = `CREATE TABLE IF NOT EXISTS tenant_scope_epochs (
    scope_key TEXT PRIMARY KEY CHECK (length(scope_key) > 0),
    epoch INTEGER NOT NULL CHECK (epoch >= 0),
    record BLOB NOT NULL
) STRICT`;
function initializeSqliteAuthoritySchema(database) {
	runAuthorityWrite(database, CREATE_GRANTS, []);
	runAuthorityWrite(database, CREATE_GRANT_SCOPE_INDEX, []);
	runAuthorityWrite(database, CREATE_BINDINGS, []);
	runAuthorityWrite(database, CREATE_BINDING_LOOKUP, []);
	runAuthorityWrite(database, CREATE_SCOPE_EPOCHS, []);
}
function loadSqliteGrant(database, id) {
	const row = readAuthority(database, "SELECT * FROM tenant_grants WHERE id = ?", [id.value])[0];
	return row === void 0 ? void 0 : decodeGrant(row, id);
}
function listSqliteGrants(database) {
	return Object.freeze(readAuthority(database, "SELECT * FROM tenant_grants ORDER BY id", []).map((row) => decodeGrant(row, new GrantId(text$8(row, "id")))));
}
function saveSqliteGrant(database, grant) {
	const previous = loadSqliteGrant(database, grant.id);
	if (previous !== void 0) {
		if (equalBytes$4(Grant.encode(previous), Grant.encode(grant))) return;
		previous.assertCanReplace(grant);
	}
	runAuthorityWrite(database, `INSERT INTO tenant_grants (
            id, scope_key, subject_key, effect, parent_grant_id, state, record
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET scope_key = excluded.scope_key,
            subject_key = excluded.subject_key, effect = excluded.effect,
            parent_grant_id = excluded.parent_grant_id, state = excluded.state,
            record = excluded.record`, [
		grant.id.value,
		scopeKey(grant.scope),
		subjectKey(grant.subject),
		grant.effect,
		grant.attenuationOf?.value ?? null,
		grant.state.name,
		Grant.encode(grant)
	]);
	const stored = loadSqliteGrant(database, grant.id);
	if (stored === void 0 || !equalBytes$4(Grant.encode(stored), Grant.encode(grant))) throw new AgentCoreError("protocol.revision-conflict", "Grant changed concurrently");
}
function loadSqliteBinding(database, key) {
	const row = readAuthority(database, "SELECT * FROM tenant_bindings WHERE binding_key = ?", [key])[0];
	return row === void 0 ? void 0 : decodeBinding(row, key);
}
function listSqliteBindings(database) {
	return Object.freeze(readAuthority(database, "SELECT * FROM tenant_bindings ORDER BY binding_key", []).map((row) => decodeBinding(row, text$8(row, "binding_key"))));
}
function saveSqliteBinding(database, binding) {
	const previous = loadSqliteBinding(database, binding.key);
	if (previous === void 0) {
		if (binding.generation !== 0 || binding.revision.value !== 0) throw new AgentCoreError("protocol.revision-conflict", "New Bindings require generation and revision zero");
		runAuthorityWrite(database, `INSERT INTO tenant_bindings (
                binding_key, scope_key, subject_key, domain_key, name, grant_id, facet_ref,
                generation, revision, state, record
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, bindingProjections(binding));
	} else {
		const previousBytes = Binding.encode(previous);
		const nextBytes = Binding.encode(binding);
		if (equalBytes$4(previousBytes, nextBytes)) return;
		previous.assertCanReplace(binding);
		runAuthorityWrite(database, `UPDATE tenant_bindings SET grant_id = ?, facet_ref = ?, generation = ?,
                revision = ?, state = ?, record = ?
             WHERE binding_key = ? AND generation = ? AND revision = ?`, [
			binding.grantId.value,
			binding.facet.value,
			binding.generation,
			binding.revision.value,
			binding.state,
			nextBytes,
			binding.key,
			previous.generation,
			previous.revision.value
		]);
	}
	const stored = loadSqliteBinding(database, binding.key);
	if (stored === void 0 || !equalBytes$4(Binding.encode(stored), Binding.encode(binding))) throw new AgentCoreError("protocol.revision-conflict", "Binding changed concurrently");
}
function loadSqliteEpoch(database, scope) {
	const key = scopeKey(scope);
	const row = readAuthority(database, "SELECT * FROM tenant_scope_epochs WHERE scope_key = ?", [key])[0];
	if (row === void 0) return ScopeEpoch.initial(scope);
	const epoch = ScopeEpoch.decode(bytes$7(row, "record").slice());
	if (scopeKey(epoch.scope) !== key || scopeKey(epoch.scope) !== text$8(row, "scope_key") || epoch.epoch !== integer$7(row, "epoch")) throw corruptAuthority();
	return epoch;
}
function listSqliteEpochs(database) {
	return Object.freeze(readAuthority(database, "SELECT * FROM tenant_scope_epochs ORDER BY scope_key", []).map((row) => {
		const epoch = ScopeEpoch.decode(bytes$7(row, "record").slice());
		if (scopeKey(epoch.scope) !== text$8(row, "scope_key") || epoch.epoch !== integer$7(row, "epoch")) throw corruptAuthority();
		return epoch;
	}));
}
function saveSqliteEpoch(database, epoch) {
	const previous = loadSqliteEpoch(database, epoch.scope);
	if (epoch.epoch === previous.epoch) return;
	if (epoch.epoch !== previous.epoch + 1) throw new AgentCoreError("protocol.revision-conflict", "Scope epoch writes must advance exactly once");
	runAuthorityWrite(database, `INSERT INTO tenant_scope_epochs (scope_key, epoch, record) VALUES (?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET epoch = excluded.epoch, record = excluded.record
         WHERE tenant_scope_epochs.epoch = excluded.epoch - 1`, [
		scopeKey(epoch.scope),
		epoch.epoch,
		ScopeEpoch.encode(epoch)
	]);
	if (!loadSqliteEpoch(database, epoch.scope).equals(epoch)) throw new AgentCoreError("protocol.revision-conflict", "Scope epoch changed concurrently");
}
function decodeGrant(row, expectedId) {
	const grant = Grant.decode(bytes$7(row, "record").slice());
	if (!grant.id.equals(expectedId) || expectedId.value !== text$8(row, "id") || scopeKey(grant.scope) !== text$8(row, "scope_key") || subjectKey(grant.subject) !== text$8(row, "subject_key") || grant.effect !== text$8(row, "effect") || (grant.attenuationOf?.value ?? null) !== nullableText$2(row, "parent_grant_id") || grant.state.name !== text$8(row, "state")) throw corruptAuthority();
	return grant;
}
function bindingProjections(binding) {
	return [
		binding.key,
		scopeKey(binding.scope),
		subjectKey(binding.subject),
		domainKey(binding.domain),
		binding.name.value,
		binding.grantId.value,
		binding.facet.value,
		binding.generation,
		binding.revision.value,
		binding.state,
		Binding.encode(binding)
	];
}
function decodeBinding(row, expectedKey) {
	const binding = Binding.decode(bytes$7(row, "record").slice());
	if (binding.key !== expectedKey || binding.key !== text$8(row, "binding_key") || scopeKey(binding.scope) !== text$8(row, "scope_key") || subjectKey(binding.subject) !== text$8(row, "subject_key") || domainKey(binding.domain) !== text$8(row, "domain_key") || binding.name.value !== text$8(row, "name") || binding.grantId.value !== text$8(row, "grant_id") || binding.facet.value !== text$8(row, "facet_ref") || binding.generation !== integer$7(row, "generation") || binding.revision.value !== integer$7(row, "revision") || binding.state !== text$8(row, "state")) throw corruptAuthority();
	return binding;
}
function text$8(row, column) {
	const value = row[column];
	if (!isSqliteText(value) || value.length === 0) throw corruptAuthority();
	return value;
}
function nullableText$2(row, column) {
	const value = row[column];
	if (value === null) return null;
	if (!isSqliteText(value) || value.length === 0) throw corruptAuthority();
	return value;
}
function integer$7(row, column) {
	const value = row[column];
	if (!isSqliteNumber(value) || !Number.isSafeInteger(value) || value < 0) throw corruptAuthority();
	return value;
}
function bytes$7(row, column) {
	const value = row[column];
	if (!(value instanceof Uint8Array)) throw corruptAuthority();
	return value;
}
function equalBytes$4(left, right) {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
function runAuthorityWrite(database, statement, bindings) {
	try {
		database.run(statement, bindings);
	} catch (error) {
		if (error instanceof AgentCoreError) throw error;
		throw new AgentCoreError("protocol.revision-conflict", "Authority write failed");
	}
}
function readAuthority(database, statement, bindings) {
	try {
		return database.all(statement, bindings);
	} catch (error) {
		if (error instanceof AgentCoreError) throw error;
		throw new AgentCoreError("codec.invalid", "Authority read failed");
	}
}
function corruptAuthority() {
	return new AgentCoreError("codec.invalid", "Stored Tenant authority state is malformed");
}
//#endregion
//#region src/substrates/sqlite/identity.ts
var CREATE_TENANTS = `CREATE TABLE IF NOT EXISTS tenant_identities (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'organization', 'service')),
    status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'deleted')),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL
) STRICT`;
var CREATE_PRINCIPALS = `CREATE TABLE IF NOT EXISTS tenant_principals (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    kind TEXT NOT NULL CHECK (kind IN ('user', 'service', 'agent')),
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    record BLOB NOT NULL
) STRICT`;
var CREATE_TEAMS = `CREATE TABLE IF NOT EXISTS tenant_teams (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL
) STRICT`;
var CREATE_PROJECTS = `CREATE TABLE IF NOT EXISTS tenant_projects (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL
) STRICT`;
var CREATE_WORKSPACES = `CREATE TABLE IF NOT EXISTS tenant_workspaces (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0),
    project_id TEXT CHECK (project_id IS NULL OR length(project_id) > 0),
    revision INTEGER NOT NULL CHECK (revision = 0),
    record BLOB NOT NULL
) STRICT`;
var CREATE_GUEST_TRUSTS = `CREATE TABLE IF NOT EXISTS tenant_guest_trusts (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    host_tenant_id TEXT NOT NULL CHECK (length(host_tenant_id) > 0),
    home_tenant_id TEXT NOT NULL CHECK (length(home_tenant_id) > 0),
    verifier_kind TEXT NOT NULL CHECK (verifier_kind IN ('token', 'callback')),
    state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL,
    CHECK (host_tenant_id <> home_tenant_id)
) STRICT`;
var CREATE_ROLES = `CREATE TABLE IF NOT EXISTS tenant_roles (
    name TEXT PRIMARY KEY CHECK (length(name) > 0),
    record BLOB NOT NULL
) STRICT`;
var CREATE_MEMBERSHIPS = `CREATE TABLE IF NOT EXISTS tenant_memberships (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    scope_key TEXT NOT NULL CHECK (length(scope_key) > 0),
    subject_key TEXT NOT NULL CHECK (length(subject_key) > 0),
    role_name TEXT NOT NULL CHECK (length(role_name) > 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'suspended', 'revoked')),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL
) STRICT`;
var CREATE_MEMBERSHIP_INDEX = `CREATE INDEX IF NOT EXISTS tenant_memberships_subject
    ON tenant_memberships (subject_key, scope_key, state)`;
var CREATE_SHARE_OFFERS = `CREATE TABLE IF NOT EXISTS tenant_share_offers (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    scope_key TEXT NOT NULL CHECK (length(scope_key) > 0),
    role_name TEXT NOT NULL CHECK (length(role_name) > 0),
    role_digest TEXT NOT NULL CHECK (length(role_digest) > 0),
    secret_digest TEXT NOT NULL CHECK (length(secret_digest) > 0),
    state TEXT NOT NULL CHECK (state IN ('open', 'revoked')),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    redemption_bound INTEGER NOT NULL CHECK (redemption_bound > 0),
    redemption_count INTEGER NOT NULL CHECK (redemption_count >= 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL,
    CHECK (redemption_count <= redemption_bound)
) STRICT`;
function initializeSqliteIdentitySchema(database) {
	runIdentityWrite(database, CREATE_TENANTS);
	runIdentityWrite(database, CREATE_PRINCIPALS);
	runIdentityWrite(database, CREATE_TEAMS);
	runIdentityWrite(database, CREATE_PROJECTS);
	runIdentityWrite(database, CREATE_WORKSPACES);
	runIdentityWrite(database, CREATE_GUEST_TRUSTS);
	runIdentityWrite(database, CREATE_ROLES);
	runIdentityWrite(database, CREATE_MEMBERSHIPS);
	runIdentityWrite(database, CREATE_MEMBERSHIP_INDEX);
	runIdentityWrite(database, CREATE_SHARE_OFFERS);
}
var SqliteIdentityReader = class extends IdentityRepository {
	readDatabase;
	constructor(readDatabase) {
		super();
		this.readDatabase = readDatabase;
	}
	loadPrincipal(id) {
		const row = select(this.readDatabase, "tenant_principals", "id", id.value);
		if (row === void 0) return void 0;
		const principal = Principal.decode(bytes$6(row, "record").slice());
		if (!principal.id.equals(id) || principal.id.value !== text$7(row, "id") || principal.kind !== text$7(row, "kind") || principal.status !== text$7(row, "status")) throw corruptIdentity();
		return principal;
	}
	loadTenant(id) {
		const row = select(this.readDatabase, "tenant_identities", "id", id.value);
		if (row === void 0) return void 0;
		const tenant = Tenant.decode(bytes$6(row, "record").slice());
		if (!tenant.id.equals(id) || tenant.id.value !== text$7(row, "id") || tenant.kind !== text$7(row, "kind") || tenant.status !== text$7(row, "status") || tenant.authorizationRevision.value !== integer$6(row, "revision")) throw corruptIdentity();
		return tenant;
	}
	loadTeam(id) {
		const row = select(this.readDatabase, "tenant_teams", "id", id.value);
		if (row === void 0) return void 0;
		const team = Team.decode(bytes$6(row, "record").slice());
		if (!team.id.equals(id) || team.id.value !== text$7(row, "id") || team.tenantId.value !== text$7(row, "tenant_id") || team.revision.value !== integer$6(row, "revision")) throw corruptIdentity();
		return team;
	}
	loadProject(id) {
		const row = select(this.readDatabase, "tenant_projects", "id", id.value);
		if (row === void 0) return void 0;
		const project = Project.decode(bytes$6(row, "record").slice());
		if (!project.id.equals(id) || project.id.value !== text$7(row, "id") || project.tenantId.value !== text$7(row, "tenant_id") || project.revision.value !== integer$6(row, "revision")) throw corruptIdentity();
		return project;
	}
	loadWorkspace(id) {
		const row = select(this.readDatabase, "tenant_workspaces", "id", id.value);
		if (row === void 0) return void 0;
		const workspace = Workspace.decode(bytes$6(row, "record").slice());
		if (!workspace.id.equals(id) || workspace.id.value !== text$7(row, "id") || workspace.tenantId.value !== text$7(row, "tenant_id") || (workspace.projectId?.value ?? null) !== nullableText$1(row, "project_id") || workspace.revision.value !== integer$6(row, "revision")) throw corruptIdentity();
		return workspace;
	}
	loadGuestTrust(id) {
		const row = select(this.readDatabase, "tenant_guest_trusts", "id", id.value);
		if (row === void 0) return void 0;
		const trust = GuestTrust.decode(bytes$6(row, "record").slice());
		if (!trust.id.equals(id) || trust.id.value !== text$7(row, "id") || trust.hostTenant.value !== text$7(row, "host_tenant_id") || trust.homeTenant.value !== text$7(row, "home_tenant_id") || trust.verifier.kind !== text$7(row, "verifier_kind") || trust.state !== text$7(row, "state") || trust.revision.value !== integer$6(row, "revision")) throw corruptIdentity();
		return trust;
	}
	loadRole(name) {
		const row = select(this.readDatabase, "tenant_roles", "name", name.value);
		if (row === void 0) return void 0;
		const role = Role.decode(bytes$6(row, "record").slice());
		if (!role.name.equals(name) || role.name.value !== text$7(row, "name")) throw corruptIdentity();
		return role;
	}
	loadMembership(id) {
		const row = select(this.readDatabase, "tenant_memberships", "id", id.value);
		if (row === void 0) return void 0;
		const membership = Membership.decode(bytes$6(row, "record").slice());
		if (!membership.id.equals(id) || membership.id.value !== text$7(row, "id") || sqliteScopeKey(membership.scope) !== text$7(row, "scope_key") || sqliteSubjectKey(membership.subject) !== text$7(row, "subject_key") || membership.role.value !== text$7(row, "role_name") || membership.state !== text$7(row, "state") || membership.revision.value !== integer$6(row, "revision")) throw corruptIdentity();
		return membership;
	}
	loadShareOffer(id) {
		const row = select(this.readDatabase, "tenant_share_offers", "id", id.value);
		if (row === void 0) return void 0;
		const offer = ShareOffer.decode(bytes$6(row, "record").slice());
		if (!offer.id.equals(id) || offer.id.value !== text$7(row, "id") || sqliteScopeKey(offer.scope) !== text$7(row, "scope_key") || offer.role.value !== text$7(row, "role_name") || offer.roleDigest.value !== text$7(row, "role_digest") || offer.secretDigest.value !== text$7(row, "secret_digest") || offer.state !== text$7(row, "state") || offer.createdAt.getTime() !== integer$6(row, "created_at") || offer.expiresAt.getTime() !== integer$6(row, "expires_at") || offer.bound !== integer$6(row, "redemption_bound") || offer.redemptions.length !== integer$6(row, "redemption_count") || offer.revision.value !== integer$6(row, "revision")) throw corruptIdentity();
		return offer;
	}
	teams() {
		return Object.freeze(readIdentity(this.readDatabase, "SELECT id FROM tenant_teams ORDER BY id", []).map((row) => projectedRecord(this.loadTeam(projectedId(TeamId, text$7(row, "id"))))));
	}
	projects() {
		return Object.freeze(readIdentity(this.readDatabase, "SELECT id FROM tenant_projects ORDER BY id", []).map((row) => projectedRecord(this.loadProject(projectedId(ProjectId, text$7(row, "id"))))));
	}
	workspaces() {
		return Object.freeze(readIdentity(this.readDatabase, "SELECT id FROM tenant_workspaces ORDER BY id", []).map((row) => projectedRecord(this.loadWorkspace(projectedId(WorkspaceId, text$7(row, "id"))))));
	}
	memberships() {
		return Object.freeze(readIdentity(this.readDatabase, "SELECT id FROM tenant_memberships ORDER BY id", []).map((row) => projectedRecord(this.loadMembership(projectedId(MembershipId, text$7(row, "id"))))));
	}
	guestTrusts() {
		return Object.freeze(readIdentity(this.readDatabase, "SELECT id FROM tenant_guest_trusts ORDER BY id", []).map((row) => projectedRecord(this.loadGuestTrust(projectedId(GuestTrustId, text$7(row, "id"))))));
	}
	shareOffers() {
		return Object.freeze(readIdentity(this.readDatabase, "SELECT id FROM tenant_share_offers ORDER BY id", []).map((row) => projectedRecord(this.loadShareOffer(projectedId(ShareOfferId, text$7(row, "id"))))));
	}
};
function sqliteScopeKey(scope) {
	return canonicalKey(encodeScopeRef(scope));
}
function sqliteSubjectKey(subject) {
	return canonicalKey(encodeSubjectRef(subject));
}
function select(database, table, keyColumn, key) {
	return readIdentity(database, `SELECT * FROM ${table} WHERE ${keyColumn} = ?`, [key])[0];
}
function readIdentity(database, statement, bindings) {
	try {
		return database.all(statement, bindings);
	} catch (error) {
		if (error instanceof AgentCoreError) throw error;
		throw new AgentCoreError("codec.invalid", "Tenant identity read failed");
	}
}
function runIdentityWrite(database, statement) {
	try {
		database.run(statement, []);
	} catch (error) {
		if (error instanceof AgentCoreError) throw error;
		throw new AgentCoreError("protocol.revision-conflict", "Tenant identity schema write failed");
	}
}
function text$7(row, column) {
	const value = row[column];
	if (!isSqliteText(value) || value.length === 0) throw corruptIdentity();
	return value;
}
function nullableText$1(row, column) {
	const value = row[column];
	if (value === null) return null;
	if (!isSqliteText(value) || value.length === 0) throw corruptIdentity();
	return value;
}
function integer$6(row, column) {
	const value = row[column];
	if (!isSqliteNumber(value) || !Number.isSafeInteger(value) || value < 0) throw corruptIdentity();
	return value;
}
function bytes$6(row, column) {
	const value = row[column];
	if (!(value instanceof Uint8Array)) throw corruptIdentity();
	return value;
}
function canonicalKey(value) {
	return new TextDecoder().decode(encodeCanonicalJson(value));
}
function projectedId(Constructor, value) {
	try {
		return new Constructor(value);
	} catch {
		throw corruptIdentity();
	}
}
function projectedRecord(record) {
	if (record === void 0) throw corruptIdentity();
	return record;
}
function corruptIdentity() {
	return new AgentCoreError("codec.invalid", "Stored Tenant identity state is malformed");
}
//#endregion
//#region src/substrates/sqlite/tenant.ts
var BootstrapMarkerCodec = class extends RecordCodec {
	constructor() {
		super([
			TenantBootstrapMarker,
			Revision,
			TextId,
			TenantId,
			PrincipalId
		], "protocol.tenant-bootstrap-marker", {
			major: 1,
			minor: 0
		});
	}
	encodePayload(marker) {
		return {
			ownerPrincipalId: marker.ownerPrincipalId.value,
			revision: marker.revision.value,
			tenantId: marker.tenantId.value
		};
	}
	decodePayload(payload) {
		if (!isJsonObject(payload) || Object.keys(payload).length !== MARKER_FIELD_COUNT) throw new TypeError("Tenant bootstrap marker payload is malformed");
		if (!isMarkerText(payload["tenantId"]) || !isMarkerText(payload["ownerPrincipalId"]) || !isMarkerNumber(payload["revision"])) throw new TypeError("Tenant bootstrap marker payload is malformed");
		return new TenantBootstrapMarker(new TenantId(payload["tenantId"]), new PrincipalId(payload["ownerPrincipalId"]), new Revision(payload["revision"]));
	}
};
var TenantBootstrapMarker = class TenantBootstrapMarker {
	tenantId;
	ownerPrincipalId;
	revision;
	static get codec() {
		return tenantBootstrapMarkerCodecInstance;
	}
	constructor(tenantId, ownerPrincipalId, revision) {
		this.tenantId = tenantId;
		this.ownerPrincipalId = ownerPrincipalId;
		this.revision = revision;
		Object.freeze(this);
	}
	static encode(marker) {
		return TenantBootstrapMarker.codec.encode(marker);
	}
	static decode(bytes) {
		return TenantBootstrapMarker.codec.decode(bytes);
	}
};
var tenantBootstrapMarkerCodecInstance = new BootstrapMarkerCodec();
var CREATE_BOOTSTRAP_ANCHOR = `CREATE TABLE IF NOT EXISTS tenant_bootstrap_anchor (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    actor_id TEXT NOT NULL UNIQUE CHECK (length(actor_id) > 0),
    tenant_id TEXT NOT NULL UNIQUE CHECK (length(tenant_id) > 0),
    principal_id TEXT NOT NULL CHECK (length(principal_id) > 0),
    tenant_kind TEXT NOT NULL CHECK (tenant_kind IN ('personal', 'organization', 'service')),
    trust_anchor BLOB NOT NULL CHECK (length(trust_anchor) > 0),
    record BLOB NOT NULL
) STRICT`;
var CREATE_BOOTSTRAP_MARKER = `CREATE TABLE IF NOT EXISTS tenant_bootstrap_marker (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    tenant_id TEXT NOT NULL UNIQUE CHECK (length(tenant_id) > 0),
    owner_principal_id TEXT NOT NULL CHECK (length(owner_principal_id) > 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL
) STRICT`;
/** The fields `encodePayload` writes: `ownerPrincipalId`, `revision`, `tenantId`. */
var MARKER_FIELD_COUNT = 3;
var SqliteTenantControlStore = class extends SqliteIdentityReader {
	database;
	tenantId;
	#activeWrite;
	constructor(database, anchor) {
		super(database);
		this.database = database;
		try {
			database.transaction(() => {
				initializeSqliteIdentitySchema(database);
				initializeSqliteAuthoritySchema(database);
				database.run(CREATE_BOOTSTRAP_ANCHOR, []);
				database.run(CREATE_BOOTSTRAP_MARKER, []);
				if (anchor !== void 0) this.bindBootstrapAnchor(anchor);
			});
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw new AgentCoreError("protocol.revision-conflict", "Tenant control schema initialization failed");
		}
		const storedAnchor = this.bootstrapAnchor();
		if (storedAnchor === void 0) throw new AgentCoreError("protocol.invalid-state", "Tenant control storage requires an immutable Tenant bootstrap anchor");
		this.tenantId = storedAnchor.tenantId;
		if (this.bootstrapMarker() === void 0) {
			if (!this.isBootstrapEligible()) throw corruptTenantControl();
		} else this.assertCompleteClosure();
	}
	transaction(operation) {
		if (this.bootstrapMarker() === void 0) throw new AgentCoreError("protocol.invalid-state", "Tenant authority mutations require completed bootstrap");
		if (this.#activeWrite !== void 0) throw new AgentCoreError("protocol.invalid-state", "Nested SQLite Tenant control transactions are not supported");
		try {
			return this.database.transaction(() => {
				const changes = new AuthorityChangeSet();
				this.#activeWrite = {
					database: this.database,
					changes
				};
				try {
					const result = requireSynchronousResult(operation(this));
					this.assertCompleteClosure(changes);
					return { result };
				} finally {
					this.#activeWrite = void 0;
				}
			}).result;
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw new AgentCoreError("protocol.revision-conflict", "Tenant control write failed");
		}
	}
	bootstrapTenant(transaction, anchor, expectedRevision) {
		if (transaction !== this.database) throw new AgentCoreError("protocol.invalid-state", "Tenant bootstrap transaction belongs to another store");
		const storedAnchor = this.bootstrapAnchor();
		if (storedAnchor === void 0) throw new AgentCoreError("protocol.invalid-state", "Tenant bootstrap anchor is missing");
		if (!anchorsEqual(storedAnchor, anchor)) throw new AgentCoreError("protocol.invalid-state", "Tenant bootstrap request does not match its immutable anchor");
		if (!this.isBootstrapEligible()) throw new AgentCoreError("protocol.invalid-state", "Tenant control is not bootstrap eligible");
		if (this.#activeWrite !== void 0) throw new AgentCoreError("protocol.invalid-state", "Nested SQLite Tenant control transactions are not supported");
		try {
			this.#activeWrite = {
				database: transaction,
				changes: new AuthorityChangeSet()
			};
			try {
				const plan = createTenantControlBootstrapPlan(anchor, expectedRevision);
				this.saveTenant(plan.tenant);
				this.savePrincipal(plan.owner);
				for (const role of plan.roles) this.saveRole(role);
				this.saveMembership(plan.ownerMembership);
				for (const grant of plan.grants) this.saveGrant(grant);
				for (const epoch of plan.epochs) this.saveEpoch(epoch);
				this.saveMarker(anchor);
				this.assertCompleteClosure(this.activeWrite().changes);
			} finally {
				this.#activeWrite = void 0;
			}
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw new AgentCoreError("protocol.revision-conflict", "Tenant bootstrap write failed");
		}
	}
	bootstrapAnchor() {
		return loadBootstrapAnchor(this.database);
	}
	bootstrapMarker() {
		const row = readTenant(this.database, "SELECT * FROM tenant_bootstrap_marker WHERE singleton = 1", [])[0];
		if (row === void 0) return void 0;
		const marker = TenantBootstrapMarker.decode(bytes$5(row, "record").slice());
		if (marker.tenantId.value !== text$6(row, "tenant_id") || marker.ownerPrincipalId.value !== text$6(row, "owner_principal_id") || marker.revision.value !== integer$5(row, "revision")) throw corruptTenantControl();
		return marker;
	}
	isBootstrapEligible() {
		return this.bootstrapAnchor() !== void 0 && readTenant(this.database, `SELECT 1 AS present FROM tenant_bootstrap_marker
             UNION ALL SELECT 1 AS present FROM tenant_identities
             UNION ALL SELECT 1 AS present FROM tenant_principals
             UNION ALL SELECT 1 AS present FROM tenant_teams
             UNION ALL SELECT 1 AS present FROM tenant_projects
             UNION ALL SELECT 1 AS present FROM tenant_workspaces
             UNION ALL SELECT 1 AS present FROM tenant_guest_trusts
             UNION ALL SELECT 1 AS present FROM tenant_roles
             UNION ALL SELECT 1 AS present FROM tenant_memberships
             UNION ALL SELECT 1 AS present FROM tenant_grants
             UNION ALL SELECT 1 AS present FROM tenant_bindings
             UNION ALL SELECT 1 AS present FROM tenant_share_offers
             UNION ALL SELECT 1 AS present FROM tenant_scope_epochs
             LIMIT 1`, []).length === 0;
	}
	principal(id) {
		return this.loadPrincipal(id);
	}
	putPrincipal(principal) {
		this.savePrincipal(principal);
	}
	team(id) {
		return this.loadTeam(id);
	}
	project(id) {
		return this.loadProject(id);
	}
	putProject(project) {
		this.saveProject(project);
	}
	workspace(id) {
		return this.loadWorkspace(id);
	}
	putWorkspace(workspace) {
		this.saveWorkspace(workspace);
	}
	guestTrust(id) {
		return this.loadGuestTrust(id);
	}
	guestTrusts() {
		return super.guestTrusts();
	}
	putGuestTrust(trust) {
		this.saveGuestTrust(trust);
	}
	putTeam(team) {
		this.saveTeam(team);
	}
	role(name) {
		return this.loadRole(name);
	}
	putRole(role) {
		this.saveRole(role);
	}
	membership(id) {
		return this.loadMembership(id);
	}
	putMembership(membership) {
		this.saveMembership(membership);
	}
	grant(id) {
		return loadSqliteGrant(this.database, id);
	}
	grants() {
		return listSqliteGrants(this.database);
	}
	putGrant(grant) {
		requireCanonicalScope(this, grant.scope);
		const write = this.activeWrite();
		const presence = recordPresence(this.grant(grant.id));
		saveSqliteGrant(write.database, grant);
		write.changes.grants.record(grant.id.value, grant, presence);
	}
	binding(key) {
		return loadSqliteBinding(this.database, key);
	}
	bindings() {
		return listSqliteBindings(this.database);
	}
	putBinding(binding) {
		requireCanonicalScope(this, binding.scope);
		const write = this.activeWrite();
		const presence = recordPresence(this.binding(binding.key));
		saveSqliteBinding(write.database, binding);
		write.changes.bindings.record(binding.key, binding, presence);
	}
	shareOffer(id) {
		return this.loadShareOffer(id);
	}
	putShareOffer(offer) {
		this.saveShareOffer(offer);
	}
	epochs() {
		return listSqliteEpochs(this.database);
	}
	epoch(scope) {
		return loadSqliteEpoch(this.database, scope);
	}
	putEpoch(epoch) {
		requireCanonicalScope(this, epoch.scope);
		const write = this.activeWrite();
		saveSqliteEpoch(write.database, epoch);
		write.changes.epochs.record(sqliteScopeKey(epoch.scope), epoch, "replaced");
	}
	saveTenant(tenant) {
		if (!tenant.id.equals(this.tenantId)) throw new AgentCoreError("protocol.invalid-state", "Tenant record belongs to another Tenant");
		this.writeDatabase().run(`INSERT INTO tenant_identities (id, kind, status, revision, record)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, status = excluded.status,
                revision = excluded.revision, record = excluded.record`, [
			tenant.id.value,
			tenant.kind,
			tenant.status,
			tenant.authorizationRevision.value,
			Tenant.encode(tenant)
		]);
		requireSaved(this.loadTenant(tenant.id), tenant, Tenant.encode);
	}
	savePrincipal(principal) {
		const database = this.writeDatabase();
		const previous = this.loadPrincipal(principal.id);
		if (previous !== void 0) {
			if (previous.kind !== principal.kind) throw new AgentCoreError("protocol.invalid-state", "Principal kind is immutable");
			if (previous.status === "disabled" && principal.status !== "disabled") throw new AgentCoreError("protocol.invalid-state", "Disabled Principals cannot be reactivated");
		}
		database.run(`INSERT INTO tenant_principals (id, kind, status, record) VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                kind = excluded.kind, status = excluded.status, record = excluded.record`, [
			principal.id.value,
			principal.kind,
			principal.status,
			Principal.encode(principal)
		]);
		requireSaved(this.loadPrincipal(principal.id), principal, Principal.encode);
	}
	saveTeam(team) {
		if (!team.tenantId.equals(this.tenantId)) throw new AgentCoreError("protocol.invalid-state", "Team belongs to another Tenant");
		const database = this.writeDatabase();
		const previous = this.loadTeam(team.id);
		if (previous === void 0) {
			if (team.revision.value !== 0) throw new AgentCoreError("protocol.invalid-state", "New Teams require revision zero");
		} else if (!previous.tenantId.equals(team.tenantId) || team.revision.value !== previous.revision.value + 1) throw new AgentCoreError("protocol.revision-conflict", "Team updates require the stored Tenant identity and next revision");
		database.run(`INSERT INTO tenant_teams (id, tenant_id, revision, record) VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id,
                revision = excluded.revision, record = excluded.record`, [
			team.id.value,
			team.tenantId.value,
			team.revision.value,
			Team.encode(team)
		]);
		requireSaved(this.loadTeam(team.id), team, Team.encode);
		this.activeWrite().changes.teams.record(team.id.value, team, recordPresence(previous));
	}
	saveProject(project) {
		if (!project.tenantId.equals(this.tenantId)) throw new AgentCoreError("protocol.invalid-state", "Project belongs to another Tenant");
		const previous = this.loadProject(project.id);
		if (previous === void 0) {
			if (project.revision.value !== 0) throw new AgentCoreError("protocol.invalid-state", "New Projects require revision zero");
			this.writeDatabase().run("INSERT INTO tenant_projects (id, tenant_id, revision, record) VALUES (?, ?, ?, ?)", [
				project.id.value,
				project.tenantId.value,
				project.revision.value,
				Project.encode(project)
			]);
		} else {
			if (project.revision.value !== previous.revision.value + 1) throw new AgentCoreError("protocol.revision-conflict", "Project updates require the next revision");
			this.writeDatabase().run(`UPDATE tenant_projects SET revision = ?, record = ?
                 WHERE id = ? AND tenant_id = ? AND revision = ?`, [
				project.revision.value,
				Project.encode(project),
				project.id.value,
				project.tenantId.value,
				previous.revision.value
			]);
		}
		requireSaved(this.loadProject(project.id), project, Project.encode);
		this.activeWrite().changes.projects.record(project.id.value, project, recordPresence(previous));
	}
	saveWorkspace(workspace) {
		if (!workspace.tenantId.equals(this.tenantId)) throw new AgentCoreError("protocol.invalid-state", "Workspace belongs to another Tenant");
		if (this.loadWorkspace(workspace.id) !== void 0) throw new AgentCoreError("protocol.invalid-state", "Workspace topology is immutable");
		if (workspace.revision.value !== 0 || workspace.projectId !== void 0 && this.loadProject(workspace.projectId) === void 0) throw new AgentCoreError("protocol.invalid-state", "Workspace requires revision zero and an existing Project");
		this.writeDatabase().run(`INSERT INTO tenant_workspaces (id, tenant_id, project_id, revision, record)
             VALUES (?, ?, ?, ?, ?)`, [
			workspace.id.value,
			workspace.tenantId.value,
			workspace.projectId?.value ?? null,
			workspace.revision.value,
			Workspace.encode(workspace)
		]);
		requireSaved(this.loadWorkspace(workspace.id), workspace, Workspace.encode);
		this.activeWrite().changes.workspaces.record(workspace.id.value, workspace, "created");
	}
	saveGuestTrust(trust) {
		if (!trust.hostTenant.equals(this.tenantId)) throw new AgentCoreError("protocol.invalid-state", "Guest trust belongs to another Tenant");
		const previous = this.loadGuestTrust(trust.id);
		if (previous === void 0) {
			if (trust.revision.value !== 0 || !trust.isActive) throw new AgentCoreError("protocol.invalid-state", "New guest trust requires revision zero and active state");
			this.writeDatabase().run(`INSERT INTO tenant_guest_trusts (
                    id, host_tenant_id, home_tenant_id, verifier_kind, state, revision, record
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
				trust.id.value,
				trust.hostTenant.value,
				trust.homeTenant.value,
				trust.verifier.kind,
				trust.state,
				trust.revision.value,
				GuestTrust.encode(trust)
			]);
		} else {
			if (equalBytes$3(GuestTrust.encode(previous), GuestTrust.encode(trust))) return;
			previous.assertCanReplace(trust);
			this.writeDatabase().run(`UPDATE tenant_guest_trusts SET verifier_kind = ?, state = ?, revision = ?, record = ?
                 WHERE id = ? AND revision = ?`, [
				trust.verifier.kind,
				trust.state,
				trust.revision.value,
				GuestTrust.encode(trust),
				trust.id.value,
				previous.revision.value
			]);
		}
		requireSaved(this.loadGuestTrust(trust.id), trust, GuestTrust.encode);
		this.activeWrite().changes.guestTrusts.record(trust.id.value, trust, recordPresence(previous));
	}
	saveRole(role) {
		const write = this.activeWrite();
		const presence = recordPresence(this.loadRole(role.name));
		write.database.run(`INSERT INTO tenant_roles (name, record) VALUES (?, ?)
             ON CONFLICT(name) DO UPDATE SET record = excluded.record`, [role.name.value, Role.encode(role)]);
		requireSaved(this.loadRole(role.name), role, Role.encode);
		write.changes.roles.record(role.name.value, role, presence);
	}
	saveMembership(membership) {
		requireCanonicalScope(this, membership.scope);
		const database = this.writeDatabase();
		const previous = this.loadMembership(membership.id);
		if (previous === void 0) {
			if (membership.revision.value !== 0 || membership.state !== "active") throw new AgentCoreError("protocol.invalid-state", "New Memberships must be active at revision zero");
		} else if (sqliteScopeKey(previous.scope) !== sqliteScopeKey(membership.scope) || sqliteSubjectKey(previous.subject) !== sqliteSubjectKey(membership.subject)) throw new AgentCoreError("protocol.invalid-state", "Membership subject and Scope are immutable");
		else if (membership.revision.value !== previous.revision.value + 1) throw new AgentCoreError("protocol.revision-conflict", "Membership updates require the next stored revision");
		else if (previous.state === "revoked" && membership.state !== "revoked") throw new AgentCoreError("protocol.invalid-state", "Revoked Memberships cannot reactivate");
		else if (previous.state === "suspended" && membership.state === "active") throw new AgentCoreError("protocol.invalid-state", "Suspended Memberships require replacement rather than reactivation");
		database.run(`INSERT INTO tenant_memberships (
                id, scope_key, subject_key, role_name, state, revision, record
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET scope_key = excluded.scope_key,
                subject_key = excluded.subject_key, role_name = excluded.role_name,
                state = excluded.state, revision = excluded.revision, record = excluded.record`, [
			membership.id.value,
			sqliteScopeKey(membership.scope),
			sqliteSubjectKey(membership.subject),
			membership.role.value,
			membership.state,
			membership.revision.value,
			Membership.encode(membership)
		]);
		requireSaved(this.loadMembership(membership.id), membership, Membership.encode);
		this.activeWrite().changes.memberships.record(membership.id.value, membership, recordPresence(previous));
	}
	saveShareOffer(offer) {
		requireCanonicalScope(this, offer.scope);
		const previous = this.loadShareOffer(offer.id);
		if (previous === void 0) {
			if (offer.revision.value !== 0 || !offer.isOpen || offer.redemptions.length !== 0) throw new AgentCoreError("protocol.invalid-state", "New share offers must be open and unredeemed at revision zero");
		} else {
			if (equalBytes$3(ShareOffer.encode(previous), ShareOffer.encode(offer))) return;
			previous.assertCanReplace(offer);
		}
		this.writeDatabase().run(`INSERT INTO tenant_share_offers (
                id, scope_key, role_name, role_digest, secret_digest, state, created_at,
                expires_at, redemption_bound, redemption_count, revision, record
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET scope_key = excluded.scope_key,
                role_name = excluded.role_name, role_digest = excluded.role_digest,
                secret_digest = excluded.secret_digest, state = excluded.state,
                created_at = excluded.created_at, expires_at = excluded.expires_at,
                redemption_bound = excluded.redemption_bound,
                redemption_count = excluded.redemption_count, revision = excluded.revision,
                record = excluded.record`, [
			offer.id.value,
			sqliteScopeKey(offer.scope),
			offer.role.value,
			offer.roleDigest.value,
			offer.secretDigest.value,
			offer.state,
			offer.createdAt.getTime(),
			offer.expiresAt.getTime(),
			offer.bound,
			offer.redemptions.length,
			offer.revision.value,
			ShareOffer.encode(offer)
		]);
		requireSaved(this.loadShareOffer(offer.id), offer, ShareOffer.encode);
		this.activeWrite().changes.shareOffers.record(offer.id.value, offer, recordPresence(previous));
	}
	saveGrant(grant) {
		this.putGrant(grant);
	}
	saveEpoch(epoch) {
		this.putEpoch(epoch);
	}
	saveMarker(anchor) {
		const storedAnchor = this.bootstrapAnchor();
		const tenant = this.loadTenant(anchor.tenantId);
		if (storedAnchor === void 0 || !anchorsEqual(storedAnchor, anchor)) throw new AgentCoreError("protocol.invalid-state", "Bootstrap marker does not match its anchor");
		if (tenant === void 0) throw new AgentCoreError("protocol.invalid-state", "Bootstrap Tenant is not stored");
		this.saveBootstrapMarker(anchor.tenantId, anchor.principalId, tenant.authorizationRevision);
	}
	saveBootstrapMarker(tenantId, ownerPrincipalId, revision) {
		const marker = new TenantBootstrapMarker(tenantId, ownerPrincipalId, revision);
		const anchor = this.bootstrapAnchor();
		if (anchor === void 0 || !anchor.tenantId.equals(marker.tenantId) || !anchor.principalId.equals(marker.ownerPrincipalId)) throw new AgentCoreError("protocol.invalid-state", "Bootstrap marker does not match its anchor");
		this.writeDatabase().run(`INSERT INTO tenant_bootstrap_marker (
                singleton, tenant_id, owner_principal_id, revision, record
             ) VALUES (1, ?, ?, ?, ?)`, [
			marker.tenantId.value,
			marker.ownerPrincipalId.value,
			marker.revision.value,
			TenantBootstrapMarker.encode(marker)
		]);
		this.bootstrapMarker();
	}
	writeDatabase() {
		return this.activeWrite().database;
	}
	activeWrite() {
		if (this.#activeWrite === void 0) throw new AgentCoreError("protocol.invalid-state", "Tenant control records require an active owned transaction");
		return this.#activeWrite;
	}
	assertCompleteClosure(changed) {
		try {
			this.assertCompleteClosureUnchecked(changed);
		} catch (error) {
			if (error instanceof TypeError) throw corruptTenantControl();
			throw error;
		}
	}
	assertCompleteClosureUnchecked(changed) {
		const anchor = this.bootstrapAnchor();
		const marker = this.bootstrapMarker();
		const tenant = anchor === void 0 ? void 0 : this.loadTenant(anchor.tenantId);
		if (anchor === void 0 || marker === void 0 || !anchor.tenantId.equals(marker.tenantId) || !anchor.principalId.equals(marker.ownerPrincipalId) || marker.revision.value !== Revision.initial().value || tenant === void 0 || tenant.kind !== anchor.tenantKind || tenant.authorizationRevision.value < marker.revision.value || this.loadPrincipal(anchor.principalId) === void 0) throw corruptTenantControl();
		const plan = createTenantControlBootstrapPlan(anchor, Revision.initial());
		if (this.loadMembership(plan.ownerMembership.id) === void 0 || plan.roles.some((role) => this.loadRole(role.name) === void 0) || plan.grants.some((grant) => this.grant(grant.id) === void 0) || this.epoch(plan.epochs[0].scope).epoch < plan.epochs[0].epoch) throw corruptTenantControl();
		if (changed === void 0) this.assertStoredRows();
		assertAuthorityClosure(this, changed);
	}
	/**
	* The row-level closure the shared record closure cannot see: every projected row has
	* to decode back to the record it projects, and exactly one Tenant may own the file.
	*/
	assertStoredRows() {
		const tenantRows = readTenant(this.database, "SELECT id FROM tenant_identities ORDER BY id", []);
		if (tenantRows.length !== 1) throw corruptTenantControl();
		for (const row of tenantRows) {
			const tenant = this.loadTenant(new TenantId(text$6(row, "id")));
			if (tenant === void 0 || !tenant.id.equals(this.tenantId)) throw corruptTenantControl();
		}
		for (const row of readTenant(this.database, "SELECT id FROM tenant_principals ORDER BY id", [])) if (this.loadPrincipal(new PrincipalId(text$6(row, "id"))) === void 0) throw corruptTenantControl();
		for (const row of readTenant(this.database, "SELECT name FROM tenant_roles ORDER BY name", [])) if (this.loadRole(new RoleName(text$6(row, "name"))) === void 0) throw corruptTenantControl();
	}
	bindBootstrapAnchor(anchor) {
		const detached = new TenantBootstrapAnchorRecord(anchor);
		this.database.run(`INSERT OR IGNORE INTO tenant_bootstrap_anchor (
                singleton, actor_id, tenant_id, principal_id, tenant_kind, trust_anchor, record
             ) VALUES (1, ?, ?, ?, ?, ?, ?)`, [
			detached.actorId.value,
			detached.tenantId.value,
			detached.principalId.value,
			detached.tenantKind,
			detached.trustAnchor,
			TenantBootstrapAnchorRecord.encode(detached)
		]);
		const stored = this.bootstrapAnchor();
		if (stored === void 0 || !anchorsEqual(stored, detached)) throw new AgentCoreError("protocol.invalid-state", "The immutable Tenant bootstrap anchor is already bound differently");
	}
};
function createSqliteTenantControlStore(database, anchor) {
	return new SqliteTenantControlStore(database, anchor);
}
function recordPresence(previous) {
	return previous === void 0 ? "created" : "replaced";
}
function requireSaved(actual, expected, encode) {
	if (actual === void 0 || !equalBytes$3(encode(actual), encode(expected))) throw new AgentCoreError("protocol.revision-conflict", "Tenant control record changed concurrently");
}
function loadBootstrapAnchor(database) {
	const row = readTenant(database, `SELECT actor_id, tenant_id, principal_id, tenant_kind, trust_anchor, record
         FROM tenant_bootstrap_anchor WHERE singleton = 1`, [])[0];
	if (row === void 0) return void 0;
	const anchor = TenantBootstrapAnchorRecord.decode(bytes$5(row, "record").slice());
	if (anchor.actorId.value !== text$6(row, "actor_id") || anchor.tenantId.value !== text$6(row, "tenant_id") || anchor.principalId.value !== text$6(row, "principal_id") || anchor.tenantKind !== text$6(row, "tenant_kind") || !equalBytes$3(anchor.trustAnchor, bytes$5(row, "trust_anchor"))) throw corruptTenantControl();
	return anchor;
}
function readTenant(database, statement, bindings) {
	try {
		return database.all(statement, bindings);
	} catch (error) {
		if (error instanceof AgentCoreError) throw error;
		throw new AgentCoreError("codec.invalid", "Tenant control read failed");
	}
}
function text$6(row, column) {
	const value = row[column];
	if (!isSqliteText(value) || value.length === 0) throw corruptTenantControl();
	return value;
}
function integer$5(row, column) {
	const value = row[column];
	if (!isSqliteNumber(value) || !Number.isSafeInteger(value) || value < 0) throw corruptTenantControl();
	return value;
}
function isMarkerText(value) {
	return typeof value === "string";
}
function isMarkerNumber(value) {
	return typeof value === "number";
}
function bytes$5(row, column) {
	const value = row[column];
	if (!(value instanceof Uint8Array)) throw corruptTenantControl();
	return value;
}
function anchorsEqual(left, right) {
	return left.actorId.equals(right.actorId) && left.tenantId.equals(right.tenantId) && left.principalId.equals(right.principalId) && (left.tenantKind ?? "personal") === (right.tenantKind ?? "personal") && equalBytes$3(left.trustAnchor, right.trustAnchor);
}
function equalBytes$3(left, right) {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
function requireCanonicalScope(store, scope) {
	if (!scope.tenantId.equals(store.tenantId)) throw new AgentCoreError("protocol.invalid-state", "Authority Scope belongs to another Tenant");
	if (scope.kind === "project" && (scope.projectId === void 0 || store.loadProject(scope.projectId) === void 0)) throw new AgentCoreError("protocol.invalid-state", "Authority Project Scope is not canonical");
	if (scope.kind === "workspace") {
		const workspace = scope.workspaceId === void 0 ? void 0 : store.loadWorkspace(scope.workspaceId);
		if (workspace === void 0 || !workspace.scope.equals(scope)) throw new AgentCoreError("protocol.invalid-state", "Authority Workspace Scope is not canonical");
	}
}
function corruptTenantControl() {
	return new AgentCoreError("codec.invalid", "Stored Tenant control state is malformed");
}
//#endregion
//#region src/substrates/sqlite/bootstrap.ts
var CREATE_IDS = `CREATE TABLE IF NOT EXISTS tenant_bootstrap_protocol_ids (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    next_id INTEGER NOT NULL CHECK (next_id >= 0)
) STRICT`;
var SqliteTenantBootstrap = class {
	#ingress;
	#control;
	tenantId;
	constructor(init) {
		this.#control = createSqliteTenantControlStore(init.database, init.anchor);
		const anchor = this.#control.bootstrapAnchor();
		if (anchor === void 0) throw new AgentCoreError("protocol.invalid-state", "SQLite Tenant bootstrap anchor is missing");
		this.tenantId = anchor.tenantId;
		try {
			init.database.transaction(() => {
				init.database.run(CREATE_IDS, []);
				init.database.run("INSERT OR IGNORE INTO tenant_bootstrap_protocol_ids (singleton, next_id) VALUES (1, 0)", []);
			});
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw new AgentCoreError("protocol.revision-conflict", "Tenant bootstrap protocol ID initialization failed");
		}
		readNextId(init.database);
		try {
			const dispatcher = new CommandDispatcher({
				store: new SqliteActorStore(init.database),
				persistence: new SqliteProtocolPersistence(init.database),
				ids: {
					writeRecordId: (transaction) => new WriteRecordId(nextId(transaction, "write")),
					auditRecordId: (transaction) => new AuditRecordId(nextId(transaction, "audit")),
					correlationId: (transaction) => new CorrelationId(nextId(transaction, "correlation")),
					invocationId: (transaction) => new InvocationId(nextId(transaction, "invocation"))
				},
				actor: init.actor,
				tenant: anchor.tenantId,
				readOnly: (transaction) => transaction,
				commands: [createTenantBootstrapCommand({
					anchor: () => this.#control.bootstrapAnchor(),
					anchorInTransaction: () => this.#control.bootstrapAnchor(),
					eligible: () => this.#control.isBootstrapEligible(),
					currentRevision: () => Revision.initial(),
					bootstrapTenant: (_transaction, verifiedAnchor, expectedRevision) => this.#control.bootstrapTenant(init.database, verifiedAnchor, expectedRevision)
				}, {
					actor: init.actor,
					tenantId: anchor.tenantId
				})],
				limits: {
					envelopeBytes: 16384,
					payloadBytes: 16384
				}
			});
			this.#ingress = new CommandIngress({
				dispatcher,
				content: init.content,
				authenticator: init.authenticator,
				leaseForMilliseconds: 6e4
			});
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw new AgentCoreError("protocol.invalid-state", "Tenant bootstrap Actor state is invalid");
		}
	}
	accept(envelope, transport, submittedBytes) {
		return this.#ingress.accept(envelope, transport, submittedBytes);
	}
	async dispatch(envelope, transport, submittedBytes) {
		const result = await this.accept(envelope, transport, submittedBytes);
		if (result.kind === "preDispatchFailure") throw result.cause;
		return result;
	}
};
function createSqliteTenantBootstrap(init) {
	return new SqliteTenantBootstrap(init);
}
function nextId(transaction, prefix) {
	const current = readNextId(transaction);
	if (current === Number.MAX_SAFE_INTEGER) throw new AgentCoreError("protocol.invalid-state", "Tenant bootstrap protocol ID is exhausted");
	try {
		transaction.run("UPDATE tenant_bootstrap_protocol_ids SET next_id = next_id + 1 WHERE singleton = 1", []);
	} catch (error) {
		if (error instanceof AgentCoreError) throw error;
		throw new AgentCoreError("protocol.revision-conflict", "Tenant bootstrap protocol ID write failed");
	}
	const value = readNextId(transaction);
	if (value !== current + 1) throw new AgentCoreError("protocol.revision-conflict", "Tenant bootstrap protocol ID changed concurrently");
	return `${prefix}-${value}`;
}
function readNextId(database) {
	let rows;
	try {
		rows = database.all("SELECT next_id FROM tenant_bootstrap_protocol_ids WHERE singleton = 1", []);
	} catch (error) {
		if (error instanceof AgentCoreError) throw error;
		throw new AgentCoreError("codec.invalid", "Tenant bootstrap protocol ID read failed");
	}
	const value = rows[0]?.["next_id"];
	if (!isSqliteNumber(value) || !Number.isSafeInteger(value) || value < 0) throw new AgentCoreError("codec.invalid", "Tenant bootstrap protocol ID state is malformed");
	return value;
}
//#endregion
//#region src/substrates/sqlite/content-retention.ts
var CREATE_BINDING = `CREATE TABLE IF NOT EXISTS content_retention_binding (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    tenant TEXT NOT NULL CHECK (length(tenant) > 0),
    actor_kind TEXT NOT NULL CHECK (
        actor_kind IN ('tenant', 'workspace', 'run', 'environment', 'slate')
    ),
    actor_id TEXT NOT NULL CHECK (length(actor_id) > 0),
    UNIQUE (tenant, actor_kind, actor_id)
) STRICT`;
var CREATE_EDGES = `CREATE TABLE IF NOT EXISTS content_owner_edges (
    owner_key TEXT PRIMARY KEY CHECK (length(owner_key) BETWEEN 1 AND 512),
    tenant TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    record BLOB NOT NULL
) STRICT`;
var CREATE_RELATIONS = `CREATE TABLE IF NOT EXISTS content_relations (
    ref TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    unowned_since INTEGER CHECK (unowned_since IS NULL OR unowned_since >= 0)
) STRICT`;
var CREATE_LEASES = `CREATE TABLE IF NOT EXISTS content_transient_leases (
    lease_key TEXT PRIMARY KEY CHECK (
        length(lease_key) = 64
        AND lease_key NOT GLOB '*[^0-9a-f]*'
    ),
    tenant TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    digest TEXT NOT NULL,
    acquired_at INTEGER NOT NULL CHECK (acquired_at >= 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > acquired_at),
    closed_at INTEGER CHECK (closed_at IS NULL OR closed_at >= acquired_at),
    record BLOB NOT NULL
) STRICT`;
var CREATE_EDGE_REF_INDEX = `CREATE INDEX IF NOT EXISTS content_owner_edges_ref
    ON content_owner_edges (ref)`;
var CREATE_LEASE_REF_INDEX = `CREATE INDEX IF NOT EXISTS content_transient_leases_ref
    ON content_transient_leases (ref)`;
var SqliteContentRetention = class extends ContentRetention {
	database;
	constructor(database, tenant, actor) {
		super(tenant, actor);
		this.database = database;
		database.transaction(() => initializeSqliteContentOwner(database, tenant, actor));
	}
	retain(transaction, edge, operationAtValue) {
		this.requireTransaction(transaction);
		this.requireOwner(edge);
		requireOperationTime(operationAtValue);
		validateSqliteState(transaction, this.tenant, this.actor);
		const existing = loadEdge(transaction, this.tenant, this.actor, edge.ownerKey);
		if (existing !== void 0) {
			if (!existing.equals(edge)) throw ownerCollision(edge.ownerKey);
			return;
		}
		if (loadSqliteContent(transaction, edge.ref) === void 0) throw contentNotFound$1(edge.ref);
		transaction.run(`INSERT INTO content_owner_edges
                (owner_key, tenant, actor_kind, actor_id, ref, record)
             VALUES (?, ?, ?, ?, ?, ?)`, [
			edge.ownerKey,
			edge.tenant.value,
			edge.actor.kind,
			edge.actor.id.value,
			edge.ref.value,
			ContentOwnerEdge.encode(edge)
		]);
		if (loadRelation(transaction, this.tenant, this.actor, edge.ref) === void 0) insertRelation(transaction, this.tenant, this.actor, edge.ref, null);
		else transaction.run("UPDATE content_relations SET unowned_since = NULL WHERE ref = ?", [edge.ref.value]);
		const stored = loadEdge(transaction, this.tenant, this.actor, edge.ownerKey);
		if (stored === void 0 || !stored.equals(edge)) throw corruptRetention();
	}
	holds(transaction, ref) {
		this.requireTransaction(transaction);
		return loadSqliteContent(transaction, ref) !== void 0;
	}
	release(transaction, edge, operationAtValue) {
		this.requireTransaction(transaction);
		this.requireOwner(edge);
		const operationAt = requireOperationTime(operationAtValue);
		validateSqliteState(transaction, this.tenant, this.actor);
		const existing = loadEdge(transaction, this.tenant, this.actor, edge.ownerKey);
		if (existing === void 0) return;
		if (!existing.equals(edge)) throw ownerCollision(edge.ownerKey);
		transaction.run("DELETE FROM content_owner_edges WHERE owner_key = ?", [edge.ownerKey]);
		if (!hasSqliteOwner(transaction, this.tenant, this.actor, edge.ref)) {
			requireRelation(transaction, this.tenant, this.actor, edge.ref);
			transaction.run("UPDATE content_relations SET unowned_since = ? WHERE ref = ?", [operationAt.getTime(), edge.ref.value]);
		}
	}
	collect(transaction, policy, observedAtValue) {
		this.requireTransaction(transaction);
		const observedAt = requireCollectionTime(observedAtValue);
		validateSqliteState(transaction, this.tenant, this.actor);
		const activeLeaseRefs = normalizeSqliteLeases(transaction, this.tenant, this.actor, observedAt);
		const approved = [];
		for (const relation of listRelations(transaction, this.tenant, this.actor)) {
			if (relation.unownedSince === null || hasSqliteOwner(transaction, this.tenant, this.actor, relation.ref) || activeLeaseRefs.has(relation.ref.value)) continue;
			const content = loadSqliteContent(transaction, relation.ref);
			if (content === void 0) throw corruptRetention("Related content is missing");
			if (policy.allowsCollection(transaction, {
				tenant: this.tenant,
				actor: this.actor,
				stat: sqliteContentStat(content),
				unownedSince: new Date(relation.unownedSince),
				observedAt: new Date(observedAt.getTime())
			}) === true) approved.push(relation);
		}
		const collected = [];
		for (const candidate of approved) {
			validateSqliteState(transaction, this.tenant, this.actor);
			const active = normalizeSqliteLeases(transaction, this.tenant, this.actor, observedAt);
			if (loadRelation(transaction, this.tenant, this.actor, candidate.ref)?.unownedSince !== candidate.unownedSince || hasSqliteOwner(transaction, this.tenant, this.actor, candidate.ref) || active.has(candidate.ref.value)) continue;
			deleteRelatedContent(transaction, candidate.ref);
			collected.push(candidate.ref);
		}
		return Object.freeze(collected);
	}
	listOwnerEdges(transaction) {
		this.requireTransaction(transaction);
		validateSqliteState(transaction, this.tenant, this.actor);
		return transaction.all(`SELECT owner_key, tenant, actor_kind, actor_id, ref, record
                 FROM content_owner_edges ORDER BY owner_key`, []).map((row) => decodeEdge(row, this.tenant, this.actor));
	}
	requireTransaction(transaction) {
		requireExactDatabase(transaction, this.database, this.tenant, this.actor);
	}
};
var SqliteTransientContentAccess = class extends TransientContentAccess {
	database;
	tenant;
	actor;
	now;
	constructor(database, tenant, actor, now = () => /* @__PURE__ */ new Date()) {
		super();
		this.database = database;
		this.tenant = tenant;
		this.actor = actor;
		this.now = now;
		database.transaction(() => initializeSqliteContentOwner(database, tenant, actor));
	}
	async acquire(binding, bytes, hint) {
		requireLeaseBinding(binding, this.tenant, this.actor);
		return this.database.transaction(() => this.acquireInTransaction(this.database, binding, this.now(), bytes, hint));
	}
	acquireInTransaction(transaction, binding, operationAtValue, bytes, hint) {
		requireExactDatabase(transaction, this.database, this.tenant, this.actor);
		requireLeaseBinding(binding, this.tenant, this.actor);
		const operationAt = requireOperationTime(operationAtValue, "Lease acquisition time");
		validateSqliteState(transaction, this.tenant, this.actor);
		const existing = loadLease(transaction, this.tenant, this.actor, binding.envelopeDigest);
		let replaced;
		if (existing !== void 0) {
			if (existing.isActive(operationAt)) {
				if (!existing.matches(binding)) throw leaseCollision();
				if (bytes !== void 0) validateBindingBytes(binding, bytes);
				return this.lease(existing);
			}
			replaced = existing;
		}
		const candidate = new TransientContentLeaseState(this.tenant, this.actor, binding.envelopeDigest, binding.ref, binding.digest, operationAt, binding.expiresAt);
		const stored = loadSqliteContent(transaction, binding.ref);
		if (bytes === void 0) {
			if (stored === void 0) return void 0;
		} else {
			validateBindingBytes(binding, bytes);
			insertSqliteContent(transaction, binding.ref, binding.digest, bytes.slice(), hint);
		}
		const persisted = loadSqliteContent(transaction, binding.ref);
		if (persisted === void 0 || bytes !== void 0 && !equalBytes$2(persisted.bytes, bytes)) throw corruptRetention("Leased content was not stored");
		if (replaced !== void 0 && !hasSqliteOwner(transaction, this.tenant, this.actor, replaced.ref)) advanceSqliteUnownedSince(transaction, this.tenant, this.actor, replaced.ref, inactiveBoundary(replaced, operationAt));
		const relation = loadRelation(transaction, this.tenant, this.actor, binding.ref);
		const unownedSince = hasSqliteOwner(transaction, this.tenant, this.actor, binding.ref) ? null : relation === void 0 ? operationAt.getTime() : Math.max(requireUnownedTimestamp(relation), operationAt.getTime());
		if (relation === void 0) insertRelation(transaction, this.tenant, this.actor, binding.ref, unownedSince);
		else transaction.run("UPDATE content_relations SET unowned_since = ? WHERE ref = ?", [unownedSince, binding.ref.value]);
		if (replaced === void 0) insertLease(transaction, candidate);
		else updateLease(transaction, candidate);
		return this.lease(candidate);
	}
	readInTransaction(transaction, expected) {
		const content = loadSqliteContent(transaction, this.requireGeneration(transaction, expected).ref);
		if (content === void 0) throw corruptRetention("Leased content is missing");
		return content.bytes.slice();
	}
	matchesInTransaction(transaction, expected, binding, now) {
		requireLeaseBinding(binding, this.tenant, this.actor);
		const lease = this.requireGeneration(transaction, expected);
		return lease.matches(binding) && lease.isActive(now);
	}
	closeInTransaction(transaction, expected, operationAt) {
		const lease = this.requireGeneration(transaction, expected);
		const closed = lease.close(operationAt);
		if (closed === lease) return;
		updateLease(transaction, closed);
		if (!hasSqliteOwner(transaction, this.tenant, this.actor, lease.ref)) advanceSqliteUnownedSince(transaction, this.tenant, this.actor, lease.ref, inactiveBoundary(closed, closed.closedAt));
	}
	requireLease(transaction, key) {
		requireExactDatabase(transaction, this.database, this.tenant, this.actor);
		validateSqliteState(transaction, this.tenant, this.actor);
		const lease = loadLease(transaction, this.tenant, this.actor, key);
		if (lease === void 0) throw corruptRetention("Transient content lease is missing");
		return lease;
	}
	requireGeneration(transaction, expected) {
		const lease = this.requireLease(transaction, expected.envelopeDigest);
		if (!sameLeaseGeneration(lease, expected)) throw new AgentCoreError("protocol.invalid-state", "Transient content lease handle refers to a replaced generation");
		return lease;
	}
	lease(state) {
		return new SqliteTransientContentLease(this, this.database, state, this.now);
	}
};
var SqliteTransientContentLease = class extends TransientContentLease {
	access;
	database;
	state;
	now;
	constructor(access, database, state, now) {
		super();
		this.access = access;
		this.database = database;
		this.state = state;
		this.now = now;
	}
	read() {
		return this.database.transaction(() => this.access.readInTransaction(this.database, this.state));
	}
	matches(binding, now) {
		return this.database.transaction(() => this.access.matchesInTransaction(this.database, this.state, binding, now));
	}
	async close() {
		this.database.transaction(() => this.access.closeInTransaction(this.database, this.state, this.now()));
	}
};
function initializeSqliteContentOwner(database, tenant, actor) {
	initializeSqliteContent(database);
	database.run(CREATE_BINDING, []);
	database.run(CREATE_EDGES, []);
	database.run(CREATE_RELATIONS, []);
	database.run(CREATE_LEASES, []);
	database.run(CREATE_EDGE_REF_INDEX, []);
	database.run(CREATE_LEASE_REF_INDEX, []);
	database.run(`INSERT OR IGNORE INTO content_retention_binding
            (singleton, tenant, actor_kind, actor_id)
         VALUES (1, ?, ?, ?)`, [
		tenant.value,
		actor.kind,
		actor.id.value
	]);
	requireBoundDatabase(database, tenant, actor);
	validateSqliteState(database, tenant, actor);
}
function requireBoundDatabase(transaction, tenant, actor) {
	const row = transaction.all(`SELECT tenant, actor_kind, actor_id
         FROM content_retention_binding WHERE singleton = 1`, [])[0];
	if (row === void 0 || sqliteText(row, "tenant") !== tenant.value || sqliteText(row, "actor_kind") !== actor.kind || sqliteText(row, "actor_id") !== actor.id.value) throw invalidContentState("SQLite content storage is bound to a different Actor or Tenant");
}
function requireExactDatabase(transaction, database, tenant, actor) {
	if (!hasSameSqliteProvenance(transaction, database)) throw invalidContentState("SQLite content transaction belongs to a different database capability");
	requireBoundDatabase(transaction, tenant, actor);
}
function validateSqliteState(transaction, tenant, actor) {
	for (const row of transaction.all(`SELECT owner_key, tenant, actor_kind, actor_id, ref, record
         FROM content_owner_edges ORDER BY owner_key`, [])) {
		const edge = decodeEdge(row, tenant, actor);
		const relation = loadRelation(transaction, tenant, actor, edge.ref);
		if (loadSqliteContent(transaction, edge.ref) === void 0 || relation?.unownedSince !== null) throw corruptRetention("Owned content relation is malformed");
	}
	for (const relation of listRelations(transaction, tenant, actor)) {
		const owned = hasSqliteOwner(transaction, tenant, actor, relation.ref);
		if (loadSqliteContent(transaction, relation.ref) === void 0 || owned !== (relation.unownedSince === null)) throw corruptRetention("Content relation is malformed");
	}
	for (const row of leaseRows(transaction)) decodeLease(row, tenant, actor, transaction);
	for (const content of listSqliteContent(transaction));
}
function loadEdge(transaction, tenant, actor, ownerKey) {
	const row = transaction.all(`SELECT owner_key, tenant, actor_kind, actor_id, ref, record
         FROM content_owner_edges WHERE owner_key = ?`, [ownerKey])[0];
	return row === void 0 ? void 0 : decodeEdge(row, tenant, actor);
}
function decodeEdge(row, tenant, actor) {
	try {
		const edge = ContentOwnerEdge.decode(sqliteBytes(row, "record").slice());
		if (!edge.tenant.equals(tenant) || !edge.actor.equals(actor) || edge.ownerKey !== sqliteText(row, "owner_key") || edge.tenant.value !== sqliteText(row, "tenant") || edge.actor.kind !== sqliteText(row, "actor_kind") || edge.actor.id.value !== sqliteText(row, "actor_id") || edge.ref.value !== sqliteText(row, "ref")) throw corruptRetention();
		return edge;
	} catch (error) {
		if (error instanceof AgentCoreError) throw error;
		throw corruptRetention();
	}
}
function insertRelation(transaction, tenant, actor, ref, unownedSince) {
	transaction.run(`INSERT INTO content_relations
            (ref, tenant, actor_kind, actor_id, unowned_since)
         VALUES (?, ?, ?, ?, ?)`, [
		ref.value,
		tenant.value,
		actor.kind,
		actor.id.value,
		unownedSince
	]);
}
function loadRelation(transaction, tenant, actor, ref) {
	const row = transaction.all(`SELECT ref, tenant, actor_kind, actor_id, unowned_since
         FROM content_relations WHERE ref = ?`, [ref.value])[0];
	return row === void 0 ? void 0 : decodeRelation(row, tenant, actor);
}
function requireRelation(transaction, tenant, actor, ref) {
	const relation = loadRelation(transaction, tenant, actor, ref);
	if (relation === void 0) throw corruptRetention("Authenticated content relation is missing");
	return relation;
}
function listRelations(transaction, tenant, actor) {
	return transaction.all(`SELECT ref, tenant, actor_kind, actor_id, unowned_since
         FROM content_relations ORDER BY ref`, []).map((row) => decodeRelation(row, tenant, actor));
}
function decodeRelation(row, tenant, actor) {
	try {
		const ref = new ContentRef(sqliteText(row, "ref"));
		const unownedSince = nullableInteger(row, "unowned_since");
		if (sqliteText(row, "tenant") !== tenant.value || sqliteText(row, "actor_kind") !== actor.kind || sqliteText(row, "actor_id") !== actor.id.value) throw corruptRetention();
		return {
			ref,
			unownedSince
		};
	} catch (error) {
		if (error instanceof AgentCoreError) throw error;
		throw corruptRetention("Stored content relation is malformed");
	}
}
function hasSqliteOwner(transaction, tenant, actor, ref) {
	const rows = transaction.all(`SELECT owner_key, tenant, actor_kind, actor_id, ref, record
         FROM content_owner_edges WHERE ref = ?`, [ref.value]);
	for (const row of rows) decodeEdge(row, tenant, actor);
	return rows.length > 0;
}
function leaseRows(transaction, key) {
	return key === void 0 ? transaction.all(`SELECT lease_key, tenant, actor_kind, actor_id, ref, digest,
                    acquired_at, expires_at, closed_at, record
             FROM content_transient_leases ORDER BY lease_key`, []) : transaction.all(`SELECT lease_key, tenant, actor_kind, actor_id, ref, digest,
                    acquired_at, expires_at, closed_at, record
             FROM content_transient_leases WHERE lease_key = ?`, [key.value]);
}
function loadLease(transaction, tenant, actor, key) {
	const row = leaseRows(transaction, key)[0];
	return row === void 0 ? void 0 : decodeLease(row, tenant, actor, transaction);
}
function decodeLease(row, tenant, actor, transaction) {
	try {
		const lease = TransientContentLeaseState.decode(sqliteBytes(row, "record").slice());
		const closedAt = nullableInteger(row, "closed_at");
		if (!lease.tenant.equals(tenant) || !lease.actor.equals(actor) || lease.envelopeDigest.value !== sqliteText(row, "lease_key") || lease.tenant.value !== sqliteText(row, "tenant") || lease.actor.kind !== sqliteText(row, "actor_kind") || lease.actor.id.value !== sqliteText(row, "actor_id") || lease.ref.value !== sqliteText(row, "ref") || lease.digest.value !== sqliteText(row, "digest") || lease.acquiredAt.getTime() !== sqliteInteger(row, "acquired_at") || lease.expiresAt.getTime() !== sqliteInteger(row, "expires_at") || (lease.closedAt?.getTime() ?? null) !== closedAt || loadSqliteContent(transaction, lease.ref) === void 0 || loadRelation(transaction, tenant, actor, lease.ref) === void 0) throw corruptRetention();
		return lease;
	} catch (error) {
		if (error instanceof AgentCoreError) throw error;
		throw corruptRetention("Stored transient content lease is malformed");
	}
}
function insertLease(transaction, lease) {
	transaction.run(`INSERT INTO content_transient_leases
            (lease_key, tenant, actor_kind, actor_id, ref, digest,
             acquired_at, expires_at, closed_at, record)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, leaseBindings(lease));
}
function updateLease(transaction, lease) {
	transaction.run(`UPDATE content_transient_leases SET
            tenant = ?, actor_kind = ?, actor_id = ?, ref = ?, digest = ?,
            acquired_at = ?, expires_at = ?, closed_at = ?, record = ?
         WHERE lease_key = ?`, [
		lease.tenant.value,
		lease.actor.kind,
		lease.actor.id.value,
		lease.ref.value,
		lease.digest.value,
		lease.acquiredAt.getTime(),
		lease.expiresAt.getTime(),
		lease.closedAt?.getTime() ?? null,
		TransientContentLeaseState.encode(lease),
		lease.envelopeDigest.value
	]);
}
function leaseBindings(lease) {
	return [
		lease.envelopeDigest.value,
		lease.tenant.value,
		lease.actor.kind,
		lease.actor.id.value,
		lease.ref.value,
		lease.digest.value,
		lease.acquiredAt.getTime(),
		lease.expiresAt.getTime(),
		lease.closedAt?.getTime() ?? null,
		TransientContentLeaseState.encode(lease)
	];
}
function normalizeSqliteLeases(transaction, tenant, actor, observedAt) {
	const active = /* @__PURE__ */ new Set();
	for (const row of leaseRows(transaction)) {
		const lease = decodeLease(row, tenant, actor, transaction);
		if (lease.isActive(observedAt)) active.add(lease.ref.value);
		else if (!hasSqliteOwner(transaction, tenant, actor, lease.ref)) advanceSqliteUnownedSince(transaction, tenant, actor, lease.ref, inactiveBoundary(lease, observedAt));
	}
	return active;
}
function advanceSqliteUnownedSince(transaction, tenant, actor, ref, boundary) {
	const current = requireUnownedTimestamp(requireRelation(transaction, tenant, actor, ref));
	transaction.run("UPDATE content_relations SET unowned_since = ? WHERE ref = ?", [Math.max(current, boundary.getTime()), ref.value]);
}
function inactiveBoundary(lease, observedAt) {
	const closedAt = lease.closedAt;
	if (closedAt !== void 0) return new Date(Math.min(closedAt.getTime(), lease.expiresAt.getTime()));
	if (lease.isActive(observedAt)) throw corruptRetention("Active lease has no inactive boundary");
	return lease.expiresAt;
}
function requireUnownedTimestamp(relation) {
	if (relation.unownedSince === null) throw corruptRetention("Unowned content has an owned relation");
	return relation.unownedSince;
}
function deleteRelatedContent(transaction, ref) {
	transaction.run("DELETE FROM content_transient_leases WHERE ref = ?", [ref.value]);
	transaction.run("DELETE FROM content_relations WHERE ref = ?", [ref.value]);
	deleteSqliteContent(transaction, ref);
}
function requireLeaseBinding(binding, tenant, actor) {
	if (!binding.tenant.equals(tenant)) throw invalidContentState("Transient content binding belongs to a different Tenant");
	if (!binding.actor.equals(actor)) throw invalidContentState("Transient content binding belongs to a different Actor");
}
function validateBindingBytes(binding, bytes) {
	const digest = Digest.sha256(bytes);
	if (!binding.ref.digest.equals(binding.digest) || !binding.digest.equals(digest)) throw new AgentCoreError("codec.invalid", "Transient content binding does not match bytes");
}
function nullableInteger(row, column) {
	const value = row[column];
	if (value === null) return null;
	if (!isSqliteNumber(value) || !Number.isSafeInteger(value) || value < 0) throw new AgentCoreError("codec.invalid", `Expected nullable non-negative integer column: ${column}`);
	return value;
}
function equalBytes$2(left, right) {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
function ownerCollision(ownerKey) {
	return contentCollision(`Content owner key is already retained: ${ownerKey}`);
}
function leaseCollision() {
	return contentCollision("Active transient lease key is bound to different content");
}
function sameLeaseGeneration(left, right) {
	return left.tenant.equals(right.tenant) && left.actor.equals(right.actor) && left.envelopeDigest.equals(right.envelopeDigest) && left.ref.equals(right.ref) && left.digest.equals(right.digest) && left.acquiredAt.getTime() === right.acquiredAt.getTime() && left.expiresAt.getTime() === right.expiresAt.getTime();
}
function contentCollision(message) {
	return invalidContentState(message);
}
function invalidContentState(message) {
	return new AgentCoreError("protocol.invalid-state", message);
}
function contentNotFound$1(ref) {
	return new AgentCoreError("content.not-found", `Content not found: ${ref.value}`);
}
function corruptRetention(message = "Stored content retention state is malformed") {
	return new AgentCoreError("codec.invalid", message);
}
//#endregion
//#region src/substrates/sqlite/content.ts
var CREATE_CONTENT = `CREATE TABLE IF NOT EXISTS content_blobs (
    ref TEXT PRIMARY KEY CHECK (
        length(ref) = 71
        AND substr(ref, 1, 7) = 'sha256:'
        AND substr(ref, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    digest TEXT NOT NULL CHECK (
        length(digest) = 64
        AND digest NOT GLOB '*[^0-9a-f]*'
    ),
    bytes BLOB NOT NULL,
    media_type TEXT CHECK (media_type IS NULL OR length(media_type) BETWEEN 1 AND 255),
    size INTEGER NOT NULL CHECK (size >= 0)
) STRICT`;
var SqliteContentStore = class extends ContentStore {
	database;
	static initializeOwner(database, tenant, actor) {
		initializeSqliteContentOwner(database, tenant, actor);
	}
	constructor(database) {
		super();
		this.database = database;
		this.database.transaction(() => {
			initializeSqliteContent(this.database);
		});
	}
	retention(tenant, actor) {
		return new SqliteContentRetention(this.database, tenant, actor);
	}
	transient(tenant, actor, now) {
		return new SqliteTransientContentAccess(this.database, tenant, actor, now);
	}
	async put(bytesValue, hint) {
		const detached = bytesValue.slice();
		const digest = Digest.sha256(detached);
		const ref = ContentRef.fromDigest(digest);
		this.database.transaction(() => {
			insertSqliteContent(this.database, ref, digest, detached, hint);
			const content = loadSqliteContent(this.database, ref);
			if (content === void 0 || !equalBytes$1(content.bytes, detached)) throw corruptContent();
		});
		return {
			ref,
			digest
		};
	}
	async get(ref, range = ByteRange.all()) {
		const content = loadSqliteContent(this.database, ref);
		if (content === void 0) throw contentNotFound(ref);
		return range.read(content.bytes.slice()).slice();
	}
	async stat(ref) {
		const content = loadSqliteContent(this.database, ref);
		return content === void 0 ? void 0 : sqliteContentStat(content);
	}
};
function initializeSqliteContent(database) {
	database.run(CREATE_CONTENT, []);
}
function loadSqliteContent(database, ref) {
	const row = database.all(`SELECT ref, digest, bytes, media_type, size
         FROM content_blobs WHERE ref = ?`, [ref.value])[0];
	return row === void 0 ? void 0 : validateContentRow(row, ref);
}
function listSqliteContent(database) {
	return database.all(`SELECT ref, digest, bytes, media_type, size
         FROM content_blobs ORDER BY ref`, []).map((row) => validateContentRow(row, new ContentRef(sqliteText(row, "ref"))));
}
function deleteSqliteContent(database, ref) {
	database.run("DELETE FROM content_blobs WHERE ref = ?", [ref.value]);
}
function sqliteContentStat(content) {
	return new ContentStat(content.ref, content.digest, content.size, content.hint);
}
function insertSqliteContent(database, ref, digest, contentBytes, hint) {
	database.run(`INSERT OR IGNORE INTO content_blobs (ref, digest, bytes, media_type, size)
         VALUES (?, ?, ?, ?, ?)`, [
		ref.value,
		digest.value,
		contentBytes,
		hint?.mediaType ?? null,
		contentBytes.byteLength
	]);
}
function validateContentRow(row, expectedRef) {
	try {
		const ref = new ContentRef(sqliteText(row, "ref"));
		const digest = new Digest(sqliteText(row, "digest"));
		const contentBytes = sqliteBytes(row, "bytes");
		const size = sqliteInteger(row, "size");
		const mediaType = sqliteNullableText(row, "media_type");
		if (!ref.equals(expectedRef) || !ref.digest.equals(digest) || !digest.equals(Digest.sha256(contentBytes)) || size !== contentBytes.byteLength) throw corruptContent();
		return {
			ref,
			digest,
			bytes: contentBytes,
			hint: mediaType === void 0 ? void 0 : new MediaHint(mediaType),
			size
		};
	} catch (error) {
		if (error instanceof AgentCoreError) throw error;
		throw corruptContent();
	}
}
function sqliteBytes(row, column) {
	const value = row[column];
	if (!(value instanceof Uint8Array)) throw invalidSqliteColumn("byte", column);
	return value;
}
function sqliteText(row, column) {
	const value = row[column];
	if (!isSqliteText(value)) throw invalidSqliteColumn("string", column);
	return value;
}
function sqliteNullableText(row, column) {
	const value = row[column];
	if (value === null) return void 0;
	if (!isSqliteText(value)) throw invalidSqliteColumn("nullable string", column);
	return value;
}
function sqliteInteger(row, column) {
	const value = row[column];
	if (!isSqliteNumber(value) || !Number.isSafeInteger(value) || value < 0) throw invalidSqliteColumn("non-negative safe integer", column);
	return value;
}
function equalBytes$1(left, right) {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
function contentNotFound(ref) {
	return new AgentCoreError("content.not-found", `Content not found: ${ref.value}`);
}
function corruptContent() {
	return new AgentCoreError("codec.invalid", "Stored content is malformed");
}
function invalidSqliteColumn(expected, column) {
	return new AgentCoreError("codec.invalid", `Expected ${expected} column: ${column}`);
}
//#endregion
//#region src/substrates/sqlite/package.ts
var CREATE_RELEASES = `CREATE TABLE IF NOT EXISTS definition_package_releases (
    package_id TEXT NOT NULL CHECK (length(package_id) > 0),
    version TEXT NOT NULL CHECK (length(version) > 0),
    manifest_digest TEXT NOT NULL CHECK (
        length(manifest_digest) = 64
        AND manifest_digest NOT GLOB '*[^0-9a-f]*'
    ),
    code_digest TEXT NOT NULL CHECK (
        length(code_digest) = 64
        AND code_digest NOT GLOB '*[^0-9a-f]*'
    ),
    record BLOB NOT NULL,
    PRIMARY KEY (package_id, version)
) STRICT`;
var CREATE_SNAPSHOTS = `CREATE TABLE IF NOT EXISTS definition_metadata_snapshots (
    digest TEXT PRIMARY KEY CHECK (
        length(digest) = 64
        AND digest NOT GLOB '*[^0-9a-f]*'
    ),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL
) STRICT`;
var CREATE_LOCKS = `CREATE TABLE IF NOT EXISTS definition_package_locks (
    lock_digest TEXT PRIMARY KEY CHECK (
        length(lock_digest) = 64
        AND lock_digest NOT GLOB '*[^0-9a-f]*'
    ),
    snapshot_digest TEXT NOT NULL CHECK (
        length(snapshot_digest) = 64
        AND snapshot_digest NOT GLOB '*[^0-9a-f]*'
    ),
    snapshot_revision INTEGER NOT NULL CHECK (snapshot_revision >= 0),
    record BLOB NOT NULL
) STRICT`;
var SqlitePackageStore = class {
	database;
	constructor(database) {
		this.database = database;
		database.transaction(() => {
			database.run(CREATE_RELEASES, []);
			database.run(CREATE_SNAPSHOTS, []);
			database.run(CREATE_LOCKS, []);
		});
	}
	add(release) {
		const candidateBytes = PackageRelease.encode(release);
		const candidate = PackageRelease.decode(candidateBytes);
		const stored = this.database.transaction(() => {
			this.database.run(`INSERT OR IGNORE INTO definition_package_releases (
                    package_id, version, manifest_digest, code_digest, record
                 ) VALUES (?, ?, ?, ?, ?)`, [
				candidate.id.value,
				candidate.version.toString(),
				candidate.manifestDigest.value,
				candidate.codeDigest.value,
				candidateBytes
			]);
			return this.findRelease(candidate.id, candidate.version.toString());
		});
		if (stored === void 0) throw corruptPackage("Package release insert did not produce a durable row");
		this.decodeRelease(stored, candidate.id, candidate.version);
		if (!equalBytes(stored.bytes, candidateBytes)) throw new AgentCoreError("protocol.invalid-state", `Package release ${candidate.id.value}@${candidate.version.toString()} is immutable`);
	}
	get(id, version) {
		const stored = this.findRelease(id, version.toString());
		return stored === void 0 ? void 0 : this.decodeRelease(stored, id, version);
	}
	list(id) {
		const releases = this.listReleases(id).map((stored) => this.decodeRelease(stored, id)).sort(compareReleases);
		for (let index = 1; index < releases.length; index += 1) if (releaseKey(releases[index - 1]) === releaseKey(releases[index])) throw corruptPackage("Stored package releases contain a duplicate immutable key");
		return Object.freeze(releases);
	}
	addSnapshot(snapshot) {
		const candidateBytes = MetadataSnapshot.encode(snapshot);
		const candidate = MetadataSnapshot.decode(candidateBytes);
		const stored = this.database.transaction(() => {
			this.database.run(`INSERT OR IGNORE INTO definition_metadata_snapshots (digest, revision, record)
                 VALUES (?, ?, ?)`, [
				candidate.digest.value,
				candidate.revision.value,
				candidateBytes
			]);
			return this.findSnapshot(candidate.digest.value);
		});
		if (stored === void 0) throw corruptPackage("Metadata snapshot insert did not produce a durable row");
		this.decodeSnapshot(stored, candidate.digest);
		if (!equalBytes(stored.bytes, candidateBytes)) throw new AgentCoreError("protocol.invalid-state", `Metadata snapshot ${candidate.digest.value} is immutable`);
	}
	getSnapshot(digest) {
		const stored = this.findSnapshot(digest.value);
		return stored === void 0 ? void 0 : this.decodeSnapshot(stored, digest);
	}
	listSnapshots() {
		return Object.freeze(this.database.all(`SELECT digest, revision, record FROM definition_metadata_snapshots
             ORDER BY revision, digest`, []).map(storedSnapshot).map((stored) => this.decodeSnapshot(stored)));
	}
	addLock(lock) {
		const candidateBytes = PackageLock.encode(lock);
		const candidate = PackageLock.decode(candidateBytes);
		const stored = this.database.transaction(() => {
			this.database.run(`INSERT OR IGNORE INTO definition_package_locks (
                    lock_digest, snapshot_digest, snapshot_revision, record
                 ) VALUES (?, ?, ?, ?)`, [
				candidate.digest.value,
				candidate.snapshotDigest.value,
				candidate.snapshotRevision.value,
				candidateBytes
			]);
			return this.findLock(candidate.digest.value);
		});
		if (stored === void 0) throw corruptPackage("Package lock insert did not produce a durable row");
		this.decodeLock(stored, candidate.digest);
		if (!equalBytes(stored.bytes, candidateBytes)) throw new AgentCoreError("protocol.invalid-state", `Package lock ${candidate.digest.value} is immutable`);
	}
	getLock(lockDigest) {
		const stored = this.findLock(lockDigest.value);
		return stored === void 0 ? void 0 : this.decodeLock(stored, lockDigest);
	}
	findRelease(packageId, version) {
		const row = this.database.all(`SELECT package_id, version, manifest_digest, code_digest, record
             FROM definition_package_releases
             WHERE package_id = ? AND version = ?`, [packageId.value, version])[0];
		return row === void 0 ? void 0 : storedRelease(row);
	}
	listReleases(packageId) {
		return (packageId === void 0 ? this.database.all(`SELECT package_id, version, manifest_digest, code_digest, record
                 FROM definition_package_releases
                 ORDER BY package_id, version`, []) : this.database.all(`SELECT package_id, version, manifest_digest, code_digest, record
                 FROM definition_package_releases
                 WHERE package_id = ?
                 ORDER BY package_id, version`, [packageId.value])).map(storedRelease);
	}
	findSnapshot(digest) {
		const row = this.database.all(`SELECT digest, revision, record FROM definition_metadata_snapshots WHERE digest = ?`, [digest])[0];
		return row === void 0 ? void 0 : storedSnapshot(row);
	}
	findLock(lockDigest) {
		const row = this.database.all(`SELECT lock_digest, snapshot_digest, snapshot_revision, record
             FROM definition_package_locks
             WHERE lock_digest = ?`, [lockDigest])[0];
		return row === void 0 ? void 0 : storedLock(row);
	}
	decodeSnapshot(stored, expectedDigest) {
		const snapshot = MetadataSnapshot.decode(stored.bytes.slice());
		if (stored.digest !== snapshot.digest.value || stored.revision !== snapshot.revision.value || expectedDigest !== void 0 && !snapshot.digest.equals(expectedDigest)) throw corruptPackage("Stored metadata snapshot key or projection does not match codec bytes");
		return snapshot;
	}
	decodeRelease(stored, expectedId, expectedVersion) {
		const release = PackageRelease.decode(stored.bytes.slice());
		if (!stored.packageId.equals(release.id) || stored.version !== release.version.toString() || stored.manifestDigest !== release.manifestDigest.value || stored.codeDigest !== release.codeDigest.value || expectedId !== void 0 && !release.id.equals(expectedId) || expectedVersion !== void 0 && !release.version.equals(expectedVersion)) throw corruptPackage("Stored package release key or projection does not match its codec bytes");
		return release;
	}
	decodeLock(stored, expectedDigest) {
		const lock = PackageLock.decode(stored.bytes.slice());
		if (stored.lockDigest !== lock.digest.value || stored.snapshotDigest !== lock.snapshotDigest.value || stored.snapshotRevision !== lock.snapshotRevision.value || !lock.digest.equals(expectedDigest)) throw corruptPackage("Stored package lock key or projection does not match its codec bytes");
		return lock;
	}
};
function storedRelease(row) {
	return {
		packageId: new PackageId(text$5(row, "package_id")),
		version: text$5(row, "version"),
		manifestDigest: text$5(row, "manifest_digest"),
		codeDigest: text$5(row, "code_digest"),
		bytes: bytes$4(row, "record")
	};
}
function storedLock(row) {
	return {
		lockDigest: text$5(row, "lock_digest"),
		snapshotDigest: text$5(row, "snapshot_digest"),
		snapshotRevision: integer$4(row, "snapshot_revision"),
		bytes: bytes$4(row, "record")
	};
}
function storedSnapshot(row) {
	return {
		digest: text$5(row, "digest"),
		revision: integer$4(row, "revision"),
		bytes: bytes$4(row, "record")
	};
}
function text$5(row, column) {
	const value = row[column];
	if (!isSqliteText(value) || value.length === 0) throw corruptPackage(`Stored package ${column} projection is malformed`);
	return value;
}
function integer$4(row, column) {
	const value = row[column];
	if (!isSqliteNumber(value) || !Number.isSafeInteger(value) || value < 0) throw corruptPackage(`Stored package ${column} projection is malformed`);
	return value;
}
function bytes$4(row, column) {
	const value = row[column];
	if (!(value instanceof Uint8Array)) throw corruptPackage(`Stored package ${column} bytes are malformed`);
	return value.slice();
}
function compareReleases(left, right) {
	return compareCanonicalText(left.id.value, right.id.value) || compareCanonicalText(left.version.toString(), right.version.toString());
}
function releaseKey(release) {
	return `${release.id.value}\0${release.version.toString()}`;
}
function equalBytes(left, right) {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
function corruptPackage(message) {
	return new AgentCoreError("codec.invalid", message);
}
//#endregion
//#region src/substrates/sqlite/workspace-records.ts
var CREATE_RECORDS$1 = `CREATE TABLE IF NOT EXISTS workspace_records (
    kind TEXT NOT NULL CHECK (kind IN (${WORKSPACE_RECORD_KINDS.map((kind) => `'${kind}'`).join(", ")})),
    id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 2048),
    bytes BLOB NOT NULL,
    PRIMARY KEY (kind, id)
) STRICT`;
var CREATE_UNIQUES = `CREATE TABLE IF NOT EXISTS workspace_uniques (
    namespace TEXT NOT NULL CHECK (length(namespace) BETWEEN 1 AND 512),
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 2048),
    record_id TEXT NOT NULL CHECK (length(record_id) BETWEEN 1 AND 2048),
    PRIMARY KEY (namespace, key)
) STRICT`;
var CREATE_POINTERS = `CREATE TABLE IF NOT EXISTS workspace_pointers (
    namespace TEXT NOT NULL CHECK (length(namespace) BETWEEN 1 AND 512),
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 2048),
    record_id TEXT NOT NULL CHECK (length(record_id) BETWEEN 1 AND 2048),
    PRIMARY KEY (namespace, key)
) STRICT`;
var SqliteWorkspaceRecords = class {
	database;
	constructor(database) {
		this.database = database;
		this.database.transaction(() => {
			this.database.run(CREATE_RECORDS$1, []);
			this.database.run(CREATE_UNIQUES, []);
			this.database.run(CREATE_POINTERS, []);
			this.requireSchema("workspace_records", CREATE_RECORDS$1);
			this.requireSchema("workspace_uniques", CREATE_UNIQUES);
			this.requireSchema("workspace_pointers", CREATE_POINTERS);
		});
	}
	findRecord(kind, id) {
		const row = this.database.all(`SELECT kind, id, bytes FROM workspace_records
             WHERE kind = ? AND id = ?`, [kind, id])[0];
		return row === void 0 ? void 0 : decodeRecord$1(row);
	}
	listRecords(kind) {
		return this.database.all(`SELECT kind, id, bytes FROM workspace_records
             WHERE kind = ? ORDER BY id`, [kind]).map(decodeRecord$1);
	}
	insertRecord(record) {
		validateStoredWorkspaceRecord(record);
		if (this.findRecord(record.kind, record.id) !== void 0) throw new AgentCoreError("protocol.duplicate", "Workspace records are append-only");
		try {
			this.database.run(`INSERT INTO workspace_records (kind, id, bytes) VALUES (?, ?, ?)`, [
				record.kind,
				record.id,
				record.bytes.slice()
			]);
		} catch (error) {
			if (this.findRecord(record.kind, record.id) !== void 0) throw new AgentCoreError("protocol.duplicate", "Workspace records are append-only");
			throw new AgentCoreError("protocol.invalid-state", `Workspace record insert failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const stored = this.findRecord(record.kind, record.id);
		if (stored === void 0 || !sameBytes(stored.bytes, record.bytes)) throw new AgentCoreError("protocol.invalid-state", "Workspace record insert did not persist exact bytes");
	}
	deleteRecords(kind, ids) {
		if (!isDeletableRecordKind(kind)) throw new AgentCoreError("protocol.invalid-state", "Record kind is not deletable");
		for (const id of ids) this.database.run(`DELETE FROM workspace_records WHERE kind = ? AND id = ?`, [kind, id]);
	}
	findUnique(namespace, key) {
		const row = this.database.all(`SELECT namespace, key, record_id FROM workspace_uniques
             WHERE namespace = ? AND key = ?`, [namespace, key])[0];
		return row === void 0 ? void 0 : decodeUnique(row);
	}
	insertUnique(unique) {
		validateWorkspaceUnique(unique);
		if (this.findUnique(unique.namespace, unique.key) !== void 0) throw new AgentCoreError("protocol.duplicate", "Workspace unique key is already reserved");
		try {
			this.database.run(`INSERT INTO workspace_uniques (namespace, key, record_id)
                 VALUES (?, ?, ?)`, [
				unique.namespace,
				unique.key,
				unique.recordKey
			]);
		} catch (error) {
			if (this.findUnique(unique.namespace, unique.key) !== void 0) throw new AgentCoreError("protocol.duplicate", "Workspace unique key is already reserved");
			throw new AgentCoreError("protocol.invalid-state", `Workspace unique insert failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (this.findUnique(unique.namespace, unique.key)?.recordKey !== unique.recordKey) throw new AgentCoreError("protocol.invalid-state", "Workspace unique insert did not persist");
	}
	findPointer(namespace, key) {
		const row = this.database.all(`SELECT namespace, key, record_id FROM workspace_pointers
             WHERE namespace = ? AND key = ?`, [namespace, key])[0];
		return row === void 0 ? void 0 : decodePointer(row);
	}
	compareAndSetPointer(pointer, expectedRecordKey) {
		validateWorkspacePointerAdvance(pointer, expectedRecordKey);
		const current = this.findPointer(pointer.namespace, pointer.key);
		if (current?.recordKey !== expectedRecordKey || current === void 0 && expectedRecordKey !== void 0) throw new AgentCoreError("protocol.revision-conflict", "Workspace pointer compare-and-set failed");
		if (current === void 0) this.database.run(`INSERT INTO workspace_pointers (namespace, key, record_id)
                 VALUES (?, ?, ?)`, [
			pointer.namespace,
			pointer.key,
			pointer.recordKey
		]);
		else this.database.run(`UPDATE workspace_pointers SET record_id = ?
                 WHERE namespace = ? AND key = ? AND record_id = ?`, [
			pointer.recordKey,
			pointer.namespace,
			pointer.key,
			current.recordKey
		]);
		if (this.findPointer(pointer.namespace, pointer.key)?.recordKey !== pointer.recordKey) throw new AgentCoreError("protocol.revision-conflict", "Workspace pointer compare-and-set lost a concurrent race");
	}
	deletePointer(namespace, key, expectedRecordKey) {
		if (this.findPointer(namespace, key)?.recordKey !== expectedRecordKey) throw new AgentCoreError("protocol.revision-conflict", "Workspace pointer compare-and-delete failed");
		this.database.run(`DELETE FROM workspace_pointers
             WHERE namespace = ? AND key = ? AND record_id = ?`, [
			namespace,
			key,
			expectedRecordKey
		]);
		if (this.findPointer(namespace, key) !== void 0) throw new AgentCoreError("protocol.revision-conflict", "Workspace pointer compare-and-delete lost a concurrent race");
	}
	requireSchema(table, expectedSql) {
		const sql = this.database.all("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table])[0]?.["sql"];
		if (!isSqliteText(sql)) throw new TypeError(`Missing SQLite schema: ${table}`);
		if (normalizeSql$1(sql) !== normalizeSql$1(expectedSql)) throw new TypeError(`SQLite schema is incompatible: ${table}`);
	}
};
function isDeletableRecordKind(kind) {
	return isMember(DELETABLE_WORKSPACE_RECORD_KINDS, kind);
}
function normalizeSql$1(value) {
	return value.replace(/CREATE TABLE IF NOT EXISTS/iu, "CREATE TABLE").replaceAll(/\s+/gu, " ").trim();
}
function decodeRecord$1(row) {
	return {
		kind: decodeRecordKind(row["kind"]),
		id: readText(row, "id"),
		bytes: readBytes(row, "bytes")
	};
}
function decodeUnique(row) {
	return {
		namespace: readText(row, "namespace"),
		key: readText(row, "key"),
		recordKey: readText(row, "record_id")
	};
}
function decodePointer(row) {
	return {
		namespace: readText(row, "namespace"),
		key: readText(row, "key"),
		recordKey: readText(row, "record_id")
	};
}
function decodeRecordKind(value) {
	if (isMember(WORKSPACE_RECORD_KINDS, value)) return value;
	throw new TypeError("Stored workspace record kind is invalid");
}
function readText(row, column) {
	const value = row[column];
	if (!isSqliteText(value)) throw new TypeError(`Expected text column: ${column}`);
	return value;
}
function readBytes(row, column) {
	const value = row[column];
	if (!(value instanceof Uint8Array)) throw new TypeError(`Expected byte column: ${column}`);
	return value.slice();
}
function sameBytes(left, right) {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
//#endregion
//#region src/substrates/sqlite/invocations/detached-execution.ts
var CREATE_DETACHED_EXECUTIONS = `CREATE TABLE IF NOT EXISTS invocation_detached_executions (
    attempt_id TEXT PRIMARY KEY,
    invocation_id TEXT NOT NULL,
    item_index INTEGER NOT NULL CHECK (item_index >= 0),
    state TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL,
    UNIQUE (invocation_id, item_index, attempt_id)
)`;
var CREATE_RELEASED_INDEX = `CREATE INDEX IF NOT EXISTS invocation_detached_released
    ON invocation_detached_executions (state, attempt_id)`;
var RELEASED_STATE = "released";
var SELECT_COLUMNS = "attempt_id, invocation_id, item_index, state, revision, record";
/**
* The SQLite store for detached execution records (§8.4's substrate implementation of one
* Invocation-owned seam).
*
* The table is added rather than folded into the existing invocation tables: the record has no
* reference type parameters, so it needs no projection callbacks, and no existing table's shape
* changes. One row per EffectAttempt is the whole concurrency rule — an attempt is detached at
* most once — so the primary key states it instead of a check in application code, and the
* stored revision makes an out-of-order transition a refusal rather than a last write that
* wins.
*/
var SqliteDetachedEffectExecutionPersistence = class {
	constructor(database) {
		database.transaction(() => {
			database.run(CREATE_DETACHED_EXECUTIONS, []);
			database.run(CREATE_RELEASED_INDEX, []);
		});
	}
	detachedExecution(transaction, attempt) {
		const [row] = transaction.all(`SELECT ${SELECT_COLUMNS} FROM invocation_detached_executions WHERE attempt_id = ?`, [attempt.value]);
		if (row === void 0) return void 0;
		const record = decode(row);
		if (!record.attempt.equals(attempt)) corrupt$4();
		return record;
	}
	releasedDetachedExecutions(transaction, limit) {
		if (!Number.isSafeInteger(limit) || limit <= 0) throw new AgentCoreError("invocation.invalid", "Released detached execution query requires a positive limit");
		return Object.freeze(transaction.all(`SELECT ${SELECT_COLUMNS} FROM invocation_detached_executions
                     WHERE state = ? ORDER BY attempt_id LIMIT ?`, [RELEASED_STATE, limit]).map((row) => {
			const record = decode(row);
			if (!record.state.executable) corrupt$4();
			return record;
		}));
	}
	appendDetachedExecution(transaction, record) {
		const current = this.detachedExecution(transaction, record.attempt);
		if (current === void 0 && record.revision.value !== 0 || current !== void 0 && !record.follows(current)) throw new InvocationError("store.duplicate-record", "Detached execution revision is not the next transition");
		const bytes = DetachedEffectExecution.encode(record);
		if (current === void 0) {
			transaction.run(`INSERT INTO invocation_detached_executions
                 (attempt_id, invocation_id, item_index, state, revision, record)
                 VALUES (?, ?, ?, ?, ?, ?)`, [
				record.attempt.value,
				record.invocation.value,
				record.itemIndex,
				record.state.kind,
				record.revision.value,
				bytes
			]);
			return;
		}
		transaction.run(`UPDATE invocation_detached_executions
             SET state = ?, revision = ?, record = ?
             WHERE attempt_id = ? AND revision = ?`, [
			record.state.kind,
			record.revision.value,
			bytes,
			record.attempt.value,
			current.revision.value
		]);
		const stored = this.detachedExecution(transaction, record.attempt);
		if (stored === void 0 || !stored.state.equals(record.state)) throw new InvocationError("store.duplicate-record", "Detached execution transition did not replace its exact previous revision");
	}
};
function decode(row) {
	const record = DetachedEffectExecution.decode(bytes$3(row, "record"));
	if (record.attempt.value !== text$4(row, "attempt_id") || record.invocation.value !== text$4(row, "invocation_id") || record.itemIndex !== integer$3(row, "item_index") || record.state.kind !== text$4(row, "state") || record.revision.value !== integer$3(row, "revision")) corrupt$4();
	return record;
}
function text$4(row, column) {
	const value = row[column];
	return isSqliteText(value) ? value : corrupt$4();
}
function integer$3(row, column) {
	const value = row[column];
	return isSqliteNumber(value) && Number.isSafeInteger(value) ? value : corrupt$4();
}
function bytes$3(row, column) {
	const value = row[column];
	return value instanceof Uint8Array ? value : corrupt$4();
}
function corrupt$4() {
	throw new AgentCoreError("codec.invalid", "Stored detached execution projection does not match codec bytes");
}
//#endregion
//#region src/substrates/sqlite/invocations/persistence.ts
var CREATE_PREPARED = `CREATE TABLE IF NOT EXISTS invocation_prepared_records (
    id TEXT PRIMARY KEY,
    record BLOB NOT NULL
)`;
var CREATE_APPROVAL_IDENTITIES = `CREATE TABLE IF NOT EXISTS invocation_approval_identities (
    invocation_id TEXT PRIMARY KEY,
    approval_id TEXT NOT NULL UNIQUE
)`;
var CREATE_APPROVALS = `CREATE TABLE IF NOT EXISTS invocation_approval_revisions (
    approval_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    phase TEXT NOT NULL,
    record BLOB NOT NULL,
    PRIMARY KEY (approval_id, revision)
)`;
var CREATE_CLAIMS = `CREATE TABLE IF NOT EXISTS invocation_item_claims (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    invocation_id TEXT NOT NULL,
    item_index INTEGER NOT NULL CHECK (item_index >= 0),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    record BLOB NOT NULL
)`;
var CREATE_CONTINUATIONS = `CREATE TABLE IF NOT EXISTS invocation_continuations (
    invocation_id TEXT PRIMARY KEY,
    record BLOB NOT NULL
)`;
var CREATE_ATTEMPTS = `CREATE TABLE IF NOT EXISTS invocation_effect_attempts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    invocation_id TEXT NOT NULL,
    item_index INTEGER NOT NULL CHECK (item_index >= 0),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    claim_id TEXT NOT NULL UNIQUE,
    record BLOB NOT NULL,
    UNIQUE (invocation_id, item_index, ordinal)
)`;
var CREATE_RECEIPTS = `CREATE TABLE IF NOT EXISTS invocation_receipts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    variant TEXT NOT NULL CHECK (variant IN ('preEffect', 'attempt')),
    invocation_id TEXT NOT NULL,
    item_index INTEGER NOT NULL CHECK (item_index >= 0),
    attempt_id TEXT,
    previous_id TEXT UNIQUE,
    outcome TEXT NOT NULL,
    record BLOB NOT NULL,
    CHECK (
        (variant = 'preEffect' AND attempt_id IS NULL AND previous_id IS NULL)
        OR (variant = 'attempt' AND attempt_id IS NOT NULL)
    )
)`;
var CREATE_PRE_EFFECT_UNIQUE = `CREATE UNIQUE INDEX IF NOT EXISTS invocation_pre_effect_item
    ON invocation_receipts (invocation_id, item_index)
    WHERE variant = 'preEffect'`;
var CREATE_INITIAL_ATTEMPT_RECEIPT_UNIQUE = `CREATE UNIQUE INDEX IF NOT EXISTS invocation_initial_attempt_receipt
    ON invocation_receipts (attempt_id)
    WHERE variant = 'attempt' AND previous_id IS NULL`;
var SqliteInvocationPersistence = class {
	codecs;
	custody;
	constructor(database, codecs, custody) {
		this.codecs = codecs;
		this.custody = custody;
		database.transaction(() => {
			for (const statement of [
				CREATE_PREPARED,
				CREATE_APPROVAL_IDENTITIES,
				CREATE_APPROVALS,
				CREATE_CONTINUATIONS,
				CREATE_CLAIMS,
				CREATE_ATTEMPTS,
				CREATE_RECEIPTS,
				CREATE_PRE_EFFECT_UNIQUE,
				CREATE_INITIAL_ATTEMPT_RECEIPT_UNIQUE
			]) database.run(statement, []);
		});
	}
	prepared(transaction, id) {
		const row = this.one(transaction, "SELECT id, record FROM invocation_prepared_records WHERE id = ?", [id.value]);
		if (row === void 0) return void 0;
		const record = this.codecs.prepared.decode(bytes$2(row, "record"));
		const projection = this.codecs.projectPrepared(record);
		if (text$3(row, "id") !== id.value || projection.id !== id.value) corrupt$3();
		return record;
	}
	insertPrepared(transaction, record) {
		appendRecord(transaction, "INSERT INTO invocation_prepared_records (id, record) VALUES (?, ?)", [this.codecs.projectPrepared(record).id, this.codecs.prepared.encode(record)]);
	}
	approval(transaction, id) {
		const row = this.one(transaction, `SELECT approval_id, invocation_id, revision, phase, record
             FROM invocation_approval_revisions WHERE approval_id = ?
             ORDER BY revision DESC LIMIT 1`, [id.value]);
		return row === void 0 ? void 0 : this.decodeApproval(row);
	}
	approvalForInvocation(transaction, invocation) {
		const row = this.one(transaction, "SELECT approval_id FROM invocation_approval_identities WHERE invocation_id = ?", [invocation.value]);
		if (row === void 0) return void 0;
		const approval = this.approval(transaction, { value: text$3(row, "approval_id") });
		return approval === void 0 || this.codecs.projectApproval(approval).invocation !== invocation.value ? corrupt$3() : approval;
	}
	approvalRevision(transaction, id, revision) {
		const row = this.one(transaction, `SELECT approval_id, invocation_id, revision, phase, record
             FROM invocation_approval_revisions WHERE approval_id = ? AND revision = ?`, [id.value, revision]);
		return row === void 0 ? void 0 : this.decodeApproval(row);
	}
	appendApproval(transaction, record) {
		const projection = this.codecs.projectApproval(record);
		if (projection.revision === 0) appendRecord(transaction, `INSERT INTO invocation_approval_identities (invocation_id, approval_id)
                 VALUES (?, ?)`, [projection.invocation, projection.id]);
		else {
			const identity = this.one(transaction, "SELECT approval_id FROM invocation_approval_identities WHERE invocation_id = ?", [projection.invocation]);
			if (identity === void 0 || text$3(identity, "approval_id") !== projection.id) corrupt$3();
		}
		appendRecord(transaction, `INSERT INTO invocation_approval_revisions
             (approval_id, invocation_id, revision, phase, record) VALUES (?, ?, ?, ?, ?)`, [
			projection.id,
			projection.invocation,
			projection.revision,
			projection.phase,
			this.codecs.approval.encode(record)
		]);
	}
	continuation(transaction, invocation) {
		const row = this.one(transaction, "SELECT invocation_id, record FROM invocation_continuations WHERE invocation_id = ?", [invocation.value]);
		if (row === void 0) return void 0;
		const record = this.codecs.continuation.decode(bytes$2(row, "record"));
		if (text$3(row, "invocation_id") !== invocation.value || this.codecs.projectContinuation(record).invocation !== invocation.value) corrupt$3();
		return record;
	}
	insertContinuation(transaction, record) {
		appendRecord(transaction, "INSERT INTO invocation_continuations (invocation_id, record) VALUES (?, ?)", [this.codecs.projectContinuation(record).invocation, this.codecs.continuation.encode(record)]);
	}
	claim(transaction, id) {
		const row = this.one(transaction, `SELECT id, invocation_id, item_index, ordinal, record
             FROM invocation_item_claims WHERE id = ?`, [id.value]);
		return row === void 0 ? void 0 : this.decodeClaim(row);
	}
	claimsForItem(transaction, invocation, itemIndex) {
		return transaction.all(`SELECT id, invocation_id, item_index, ordinal, record
             FROM invocation_item_claims WHERE invocation_id = ? AND item_index = ?
             ORDER BY sequence`, [invocation.value, itemIndex]).map((row) => this.decodeClaim(row));
	}
	appendClaim(transaction, record) {
		const projection = this.codecs.projectClaim(record);
		appendRecord(transaction, `INSERT INTO invocation_item_claims
             (id, invocation_id, item_index, ordinal, record) VALUES (?, ?, ?, ?, ?)`, [
			projection.id,
			projection.invocation,
			projection.itemIndex,
			projection.ordinal,
			this.codecs.claim.encode(record)
		]);
	}
	attempt(transaction, id) {
		const row = this.one(transaction, `SELECT id, invocation_id, item_index, ordinal, claim_id, record
             FROM invocation_effect_attempts WHERE id = ?`, [id.value]);
		return row === void 0 ? void 0 : this.decodeAttempt(row);
	}
	attemptForClaim(transaction, claim) {
		const row = this.one(transaction, `SELECT id, invocation_id, item_index, ordinal, claim_id, record
             FROM invocation_effect_attempts WHERE claim_id = ?`, [claim.value]);
		return row === void 0 ? void 0 : this.decodeAttempt(row);
	}
	attemptsForItem(transaction, invocation, itemIndex) {
		return transaction.all(`SELECT id, invocation_id, item_index, ordinal, claim_id, record
             FROM invocation_effect_attempts WHERE invocation_id = ? AND item_index = ?
             ORDER BY ordinal`, [invocation.value, itemIndex]).map((row) => this.decodeAttempt(row));
	}
	appendAttempt(transaction, record) {
		const projection = this.codecs.projectAttempt(record);
		appendRecord(transaction, `INSERT INTO invocation_effect_attempts
             (id, invocation_id, item_index, ordinal, claim_id, record)
             VALUES (?, ?, ?, ?, ?, ?)`, [
			projection.id,
			projection.invocation,
			projection.itemIndex,
			projection.ordinal,
			projection.claim,
			this.codecs.attempt.encode(record)
		]);
	}
	receipt(transaction, id) {
		const row = this.one(transaction, `SELECT id, variant, invocation_id, item_index, attempt_id, previous_id, outcome, record
             FROM invocation_receipts WHERE id = ?`, [id.value]);
		return row === void 0 ? void 0 : this.decodeReceipt(transaction, row);
	}
	receiptsForItem(transaction, invocation, itemIndex) {
		return transaction.all(`SELECT id, variant, invocation_id, item_index, attempt_id, previous_id, outcome, record
             FROM invocation_receipts WHERE invocation_id = ? AND item_index = ?
             ORDER BY sequence`, [invocation.value, itemIndex]).map((row) => this.decodeReceipt(transaction, row));
	}
	receiptsForAttempt(transaction, attempt) {
		return transaction.all(`SELECT id, variant, invocation_id, item_index, attempt_id, previous_id, outcome, record
             FROM invocation_receipts WHERE attempt_id = ? ORDER BY sequence`, [attempt.value]).map((row) => this.decodeReceipt(transaction, row));
	}
	/**
	* §8.4: the result bytes an attempt produced are retained in the same transaction that
	* appends the Receipt naming them. An audited Receipt is append-only, so this store owes
	* retention on write and never a release.
	*/
	appendReceipt(transaction, record) {
		const projection = this.codecs.projectReceipt(record);
		let invocation;
		let itemIndex;
		if (projection.variant === "preEffect") {
			invocation = projection.invocation;
			itemIndex = projection.itemIndex;
		} else {
			const attempt = this.attempt(transaction, { value: projection.attempt });
			if (attempt === void 0) throw new InvocationError("store.missing-evidence", "Attempt Receipt requires an existing EffectAttempt");
			const attemptProjection = this.codecs.projectAttempt(attempt);
			invocation = attemptProjection.invocation;
			itemIndex = attemptProjection.itemIndex;
		}
		appendRecord(transaction, `INSERT INTO invocation_receipts
             (id, variant, invocation_id, item_index, attempt_id, previous_id, outcome, record)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
			projection.id,
			projection.variant,
			invocation,
			itemIndex,
			projection.variant === "attempt" ? projection.attempt : null,
			projection.variant === "attempt" ? projection.previous ?? null : null,
			projection.outcome,
			this.codecs.receipt.encode(record)
		]);
		this.custody.retain(transaction, {
			kind: this.codecs.receipt.kind,
			key: projection.id,
			fields: this.codecs.projectReceiptContent(record)
		});
	}
	decodeApproval(row) {
		const record = this.codecs.approval.decode(bytes$2(row, "record"));
		const projection = this.codecs.projectApproval(record);
		if (projection.id !== text$3(row, "approval_id") || projection.invocation !== text$3(row, "invocation_id") || projection.revision !== integer$2(row, "revision") || projection.phase !== text$3(row, "phase")) corrupt$3();
		return record;
	}
	decodeClaim(row) {
		const record = this.codecs.claim.decode(bytes$2(row, "record"));
		const projection = this.codecs.projectClaim(record);
		if (projection.id !== text$3(row, "id") || projection.invocation !== text$3(row, "invocation_id") || projection.itemIndex !== integer$2(row, "item_index") || projection.ordinal !== integer$2(row, "ordinal")) corrupt$3();
		return record;
	}
	decodeAttempt(row) {
		const record = this.codecs.attempt.decode(bytes$2(row, "record"));
		const projection = this.codecs.projectAttempt(record);
		if (projection.id !== text$3(row, "id") || projection.invocation !== text$3(row, "invocation_id") || projection.itemIndex !== integer$2(row, "item_index") || projection.ordinal !== integer$2(row, "ordinal") || projection.claim !== text$3(row, "claim_id")) corrupt$3();
		return record;
	}
	decodeReceipt(transaction, row) {
		const record = this.codecs.receipt.decode(bytes$2(row, "record"));
		const projection = this.codecs.projectReceipt(record);
		const attempt = nullableText(row, "attempt_id");
		const previous = nullableText(row, "previous_id");
		if (projection.id !== text$3(row, "id") || projection.variant !== text$3(row, "variant") || projection.outcome !== text$3(row, "outcome") || (projection.variant === "preEffect" ? projection.invocation !== text$3(row, "invocation_id") || projection.itemIndex !== integer$2(row, "item_index") || attempt !== void 0 || previous !== void 0 : projection.attempt !== attempt || projection.previous !== previous)) corrupt$3();
		if (projection.variant === "attempt") {
			const source = this.attempt(transaction, { value: projection.attempt });
			if (source === void 0) corrupt$3();
			const sourceProjection = this.codecs.projectAttempt(source);
			if (sourceProjection.invocation !== text$3(row, "invocation_id") || sourceProjection.itemIndex !== integer$2(row, "item_index")) corrupt$3();
		}
		return record;
	}
	one(transaction, statement, bindings) {
		return transaction.all(statement, bindings)[0];
	}
};
function text$3(row, column) {
	const value = row[column];
	if (!isSqliteText(value)) corrupt$3();
	return value;
}
function nullableText(row, column) {
	const value = row[column];
	if (value === null) return void 0;
	if (!isSqliteText(value)) corrupt$3();
	return value;
}
function integer$2(row, column) {
	const value = row[column];
	if (!isSqliteNumber(value) || !Number.isSafeInteger(value)) corrupt$3();
	return value;
}
function bytes$2(row, column) {
	const value = row[column];
	if (!(value instanceof Uint8Array)) corrupt$3();
	return value.slice();
}
function corrupt$3() {
	throw new AgentCoreError("codec.invalid", "Stored invocation projection does not match codec bytes");
}
function appendRecord(transaction, statement, bindings) {
	try {
		transaction.run(statement, bindings);
	} catch (error) {
		if (error instanceof AgentCoreError) throw error;
		if (!isConstraintFailure(error)) throw error;
		throw new InvocationError("store.duplicate-record", "Invocation record append conflicted");
	}
}
/**
* SQLite extended result codes. Both drivers report the same numbers -- bun:sqlite as
* `errno`, node:sqlite as `errcode` -- while their string `code` disagrees: node:sqlite
* answers ERR_SQLITE_ERROR for every failure, so the string test never matched there and
* a substring search of the driver's prose was left deciding. That search read "NOT NULL
* constraint failed" and even the column name in "no such column: unique_key" as an
* append race, which reports the schema's own corruption backstops as a benign conflict.
* Only a uniqueness violation is a duplicate append.
*/
var SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
var SQLITE_CONSTRAINT_UNIQUE = 2067;
function isConstraintFailure(error) {
	if (!isObjectRecord(error)) return false;
	const result = error["errcode"] ?? error["errno"];
	return result === SQLITE_CONSTRAINT_PRIMARYKEY || result === SQLITE_CONSTRAINT_UNIQUE;
}
//#endregion
//#region src/substrates/sqlite/invocations/mediation.ts
var CREATE_REPLAY_IDENTITIES = `CREATE TABLE IF NOT EXISTS invocation_mediated_replay_identities (
    scope TEXT NOT NULL,
    request_key TEXT NOT NULL,
    replay_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY (scope, request_key)
)`;
var CREATE_REPLAY_REVISIONS = `CREATE TABLE IF NOT EXISTS invocation_mediated_replay_revisions (
    replay_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL,
    PRIMARY KEY (replay_id, revision)
)`;
var CREATE_PUBLICATIONS = `CREATE TABLE IF NOT EXISTS invocation_publication_outbox (
    id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'published')),
    record BLOB NOT NULL,
    PRIMARY KEY (id, revision)
)`;
var SqliteInvocationMediationPersistence = class {
	audits;
	constructor(database, audits) {
		this.audits = audits;
		database.transaction(() => {
			for (const statement of [
				CREATE_REPLAY_IDENTITIES,
				CREATE_REPLAY_REVISIONS,
				CREATE_PUBLICATIONS
			]) database.run(statement, []);
		});
	}
	replay(transaction, scope, requestKey) {
		const identity = one(transaction, `SELECT replay_id FROM invocation_mediated_replay_identities
             WHERE scope = ? AND request_key = ?`, [scope, requestKey]);
		return identity === void 0 ? void 0 : this.replayById(transaction, new Digest(text$2(identity, "replay_id")));
	}
	replayById(transaction, id) {
		const row = one(transaction, `SELECT replay_id, revision, record FROM invocation_mediated_replay_revisions
             WHERE replay_id = ? ORDER BY revision DESC LIMIT 1`, [id.value]);
		if (row === void 0) return void 0;
		const record = MediatedReplayRecord.decode(bytes$1(row, "record"));
		if (!record.id.equals(id) || text$2(row, "replay_id") !== id.value || integer$1(row, "revision") !== record.revision.value) corrupt$2();
		return record;
	}
	appendReplay(transaction, record) {
		const current = this.replayById(transaction, record.id);
		if (record.revision.value === 0) {
			if (current !== void 0) conflict$1("Replay reservation already exists");
			append(transaction, `INSERT INTO invocation_mediated_replay_identities
                 (scope, request_key, replay_id) VALUES (?, ?, ?)`, [
				record.scope,
				record.requestKey,
				record.id.value
			]);
		} else if (current?.revision.value !== record.revision.value - 1 || current.scope !== record.scope || current.requestKey !== record.requestKey) conflict$1("Replay revision is not the next reserved transition");
		append(transaction, `INSERT INTO invocation_mediated_replay_revisions
             (replay_id, revision, record) VALUES (?, ?, ?)`, [
			record.id.value,
			record.revision.value,
			MediatedReplayRecord.encode(record)
		]);
	}
	appendAudit(transaction, record, context) {
		this.audits.appendAudit(transaction, record, context);
	}
	audit(transaction, id) {
		return this.audits.findAudit(transaction, id);
	}
	findAuditByEvidence(transaction, actor, kind) {
		return this.audits.findAuditByEvidence(transaction, actor, kind);
	}
	publication(transaction, id) {
		const row = one(transaction, `SELECT id, revision, state, record FROM invocation_publication_outbox
             WHERE id = ? ORDER BY revision DESC LIMIT 1`, [id.value]);
		return row === void 0 ? void 0 : decodePublication(row, id);
	}
	pendingPublications(transaction) {
		return Object.freeze(transaction.all(`SELECT current.id, current.revision, current.state, current.record
             FROM invocation_publication_outbox AS current
             WHERE current.state = 'pending'
               AND NOT EXISTS (
                   SELECT 1 FROM invocation_publication_outbox AS later
                   WHERE later.id = current.id AND later.revision > current.revision
               )
             ORDER BY current.id`, []).map((row) => decodePublication(row)));
	}
	appendPublication(transaction, record) {
		const current = this.publication(transaction, record.id);
		if (current === void 0 && record.revision.value !== 0 || current !== void 0 && !record.follows(current)) conflict$1("Publication revision is not the next transition");
		append(transaction, `INSERT INTO invocation_publication_outbox
             (id, revision, state, record) VALUES (?, ?, ?, ?)`, [
			record.id.value,
			record.revision.value,
			record.state.kind,
			InvocationPublicationOutbox.encode(record)
		]);
	}
};
function decodePublication(row, expected) {
	const record = InvocationPublicationOutbox.decode(bytes$1(row, "record"));
	if (expected !== void 0 && !record.id.equals(expected) || text$2(row, "id") !== record.id.value || integer$1(row, "revision") !== record.revision.value || text$2(row, "state") !== record.state.kind) corrupt$2();
	return record;
}
function one(transaction, statement, bindings) {
	return transaction.all(statement, bindings)[0];
}
function append(transaction, statement, bindings) {
	try {
		transaction.run(statement, bindings);
	} catch (error) {
		if (error instanceof AgentCoreError) throw error;
		conflict$1("Invocation mediation append conflicted");
	}
}
function text$2(row, column) {
	const value = row[column];
	if (!isSqliteText(value)) corrupt$2();
	return value;
}
function integer$1(row, column) {
	const value = row[column];
	if (!isSqliteNumber(value) || !Number.isSafeInteger(value)) corrupt$2();
	return value;
}
function bytes$1(row, column) {
	const value = row[column];
	if (!(value instanceof Uint8Array)) corrupt$2();
	return value.slice();
}
function conflict$1(message) {
	throw new AgentCoreError("invocation.invalid", message);
}
function corrupt$2() {
	throw new AgentCoreError("codec.invalid", "Stored invocation mediation projection is corrupt");
}
//#endregion
//#region src/substrates/sqlite/run.ts
var SCHEMA_VERSION = 3;
var SCHEMA_TABLE = "agent_run_storage_schema";
var RECORD_TABLE = "agent_run_records";
var PARENT_TABLE = "agent_run_commit_parents";
var KIND_CHECK = RUN_RECORD_KINDS.map((kind) => `'${kind}'`).join(", ");
var CREATE_SCHEMA = `CREATE TABLE ${SCHEMA_TABLE} (
    version INTEGER PRIMARY KEY CHECK (version = ${SCHEMA_VERSION}),
    tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('workspace', 'run')),
    owner_id TEXT NOT NULL CHECK (length(owner_id) > 0)
) STRICT`;
var CREATE_RECORDS = `CREATE TABLE ${RECORD_TABLE} (
    kind TEXT NOT NULL CHECK (kind IN (${KIND_CHECK})),
    record_key TEXT NOT NULL CHECK (length(record_key) > 0),
    revision INTEGER CHECK (revision IS NULL OR revision >= 0),
    record BLOB NOT NULL,
    PRIMARY KEY (kind, record_key)
) STRICT`;
var CREATE_PARENTS = `CREATE TABLE ${PARENT_TABLE} (
    commit_id TEXT NOT NULL CHECK (length(commit_id) > 0),
    ordinal INTEGER NOT NULL CHECK (ordinal IN (0, 1)),
    parent_id TEXT NOT NULL CHECK (length(parent_id) > 0),
    PRIMARY KEY (commit_id, ordinal)
) STRICT`;
var CREATE_PARENT_INDEX = `CREATE INDEX agent_run_commit_parent_reverse
    ON ${PARENT_TABLE} (parent_id, commit_id)`;
var EXPECTED_SCHEMA = /* @__PURE__ */ new Map([
	[SCHEMA_TABLE, {
		type: "table",
		sql: CREATE_SCHEMA
	}],
	[RECORD_TABLE, {
		type: "table",
		sql: CREATE_RECORDS
	}],
	[PARENT_TABLE, {
		type: "table",
		sql: CREATE_PARENTS
	}],
	["agent_run_commit_parent_reverse", {
		type: "index",
		sql: CREATE_PARENT_INDEX
	}]
]);
var SqliteRunStorage = class SqliteRunStorage extends RunStoragePort {
	constructor(database, tenant, owner, now, recordConstraint) {
		if (owner.kind !== "workspace" && owner.kind !== "run") throw new TypeError("Run storage must belong to a Workspace or dedicated Run Actor");
		const ownedDatabase = ownSqliteMutations(database);
		ownedDatabase.transaction(() => {
			initializeRunStorage(ownedDatabase, tenant, owner);
			SqliteContentStore.initializeOwner(ownedDatabase, tenant, owner);
		});
		const contentStore = new SqliteContentStore(ownedDatabase);
		const retention = new SqliteContentRetention(ownedDatabase, tenant, owner);
		super(tenant, owner, contentStore, ownRunStorageBackend(new SqliteRunStorageBackend(ownedDatabase, retention, () => SqliteRunStorage.createTransaction(), recordConstraint)), now);
		if (new.target === SqliteRunStorage) Object.freeze(this);
	}
};
Object.freeze(SqliteRunStorage.prototype);
Object.freeze(SqliteRunStorage);
var SqliteRunStorageBackend = class {
	database;
	retention;
	createTransaction;
	recordConstraint;
	#active;
	constructor(database, retention, createTransaction, recordConstraint) {
		this.database = database;
		this.retention = retention;
		this.createTransaction = createTransaction;
		this.recordConstraint = recordConstraint;
	}
	transaction(operation, ...guard) {
		const current = this.#active;
		if (current !== void 0) {
			current.failure ??= invalidTransaction("Nested Run storage transactions are not supported");
			throw current.failure;
		}
		return withExclusiveSqliteMutation(this.database, (database) => {
			const transaction = this.createTransaction();
			const active = {
				transaction,
				database,
				failure: void 0
			};
			this.#active = active;
			try {
				const result = requireSynchronousResult(operation(transaction));
				if (active.failure !== void 0) throw active.failure;
				return result;
			} finally {
				this.#active = void 0;
			}
		}, ...guard);
	}
	get(transaction, kind, key) {
		return readStoredRecord(this.require(transaction), kind, key);
	}
	list(transaction, kind) {
		return listStoredRecords(this.require(transaction), kind);
	}
	validate(record) {
		validateRecord(record);
		this.recordConstraint?.(record);
	}
	poison(transaction, failure) {
		this.require(transaction);
		const state = this.#active;
		if (state === void 0) throw invalidTransaction("Run transaction is inactive");
		state.failure ??= failure;
		throw state.failure;
	}
	insert(transaction, record) {
		const database = this.require(transaction);
		const existing = readStoredRecord(database, record.kind, record.key);
		if (existing !== void 0) {
			if (recordsEqual(existing, record)) return;
			throw invalidStorage("Run records are immutable unless replaced by revision CAS");
		}
		database.run(`INSERT INTO ${RECORD_TABLE} (kind, record_key, revision, record)
             VALUES (?, ?, ?, ?)`, [
			record.kind,
			record.key,
			record.revision,
			record.bytes.slice()
		]);
	}
	replace(transaction, record, expectedRevision) {
		const database = this.require(transaction);
		if (readStoredRecord(database, record.kind, record.key)?.revision !== expectedRevision || record.revision !== expectedRevision + 1) throw new AgentCoreError("protocol.revision-conflict", "Run record revision changed");
		database.run(`UPDATE ${RECORD_TABLE} SET revision = ?, record = ?
             WHERE kind = ? AND record_key = ? AND revision = ?`, [
			record.revision,
			record.bytes.slice(),
			record.kind,
			record.key,
			expectedRevision
		]);
	}
	insertParent(transaction, edge) {
		const database = this.require(transaction);
		validateParent(edge);
		const rows = database.all(`SELECT commit_id, ordinal, parent_id FROM ${PARENT_TABLE}
             WHERE commit_id = ? AND ordinal = ?`, [edge.commit, edge.ordinal]);
		if (rows[0] !== void 0) {
			if (decodeParent(rows[0]).parent === edge.parent) return;
			throw invalidStorage("Run commit parent edges are immutable");
		}
		database.run(`INSERT INTO ${PARENT_TABLE} (commit_id, ordinal, parent_id) VALUES (?, ?, ?)`, [
			edge.commit,
			edge.ordinal,
			edge.parent
		]);
	}
	parents(transaction, commit) {
		return this.require(transaction).all(`SELECT commit_id, ordinal, parent_id FROM ${PARENT_TABLE}
             WHERE commit_id = ? ORDER BY ordinal`, [commit]).map(decodeParent);
	}
	retain(transaction, edge, operationAt) {
		this.retention.retain(this.require(transaction), edge, operationAt);
	}
	release(transaction, edge, operationAt) {
		this.retention.release(this.require(transaction), edge, operationAt);
	}
	verify(transaction, ownerPrefixes, expected) {
		this.retention.verifyExactNamespace(this.require(transaction), ownerPrefixes, expected);
	}
	require(transaction) {
		const active = this.#active;
		if (active === void 0 || active.transaction !== transaction) throw invalidTransaction("Run transaction is inactive or belongs to a different database capability");
		if (active.failure !== void 0) throw active.failure;
		return active.database;
	}
};
function initializeRunStorage(database, tenant, owner) {
	const objects = new Map(database.all("SELECT name, type, sql FROM sqlite_schema WHERE name LIKE 'agent_run_%' ORDER BY name", []).map((row) => [requiredText(row, "name"), row]));
	if (!objects.has(SCHEMA_TABLE)) {
		if (objects.size !== 0) throw corrupt$1("Unmarked Run storage objects require explicit replacement");
		database.run(CREATE_SCHEMA, []);
		database.run(CREATE_RECORDS, []);
		database.run(CREATE_PARENTS, []);
		database.run(CREATE_PARENT_INDEX, []);
		database.run(`INSERT INTO ${SCHEMA_TABLE}
                (version, tenant_id, owner_kind, owner_id) VALUES (?, ?, ?, ?)`, [
			SCHEMA_VERSION,
			tenant.value,
			owner.kind,
			owner.id.value
		]);
	}
	validateRunSchema(database, tenant, owner);
}
function validateRunSchema(database, tenant, owner) {
	const rows = database.all("SELECT name, type, sql FROM sqlite_schema WHERE name LIKE 'agent_run_%' ORDER BY name", []);
	const names = new Set(rows.map((row) => requiredText(row, "name")));
	if (names.size !== EXPECTED_SCHEMA.size || [...EXPECTED_SCHEMA.keys()].some((name) => !names.has(name))) throw corrupt$1("Run storage schema is incomplete or contains unexpected objects");
	for (const row of rows) {
		const name = requiredText(row, "name");
		const expected = EXPECTED_SCHEMA.get(name);
		const type = requiredText(row, "type");
		const sql = requiredText(row, "sql");
		if (expected === void 0 || type !== expected.type || normalizeSql(sql) !== normalizeSql(expected.sql)) throw corrupt$1(`Run storage object ${name} does not match its exact schema`);
	}
	const markerRows = database.all(`SELECT version, tenant_id, owner_kind, owner_id FROM ${SCHEMA_TABLE}`, []);
	const marker = markerRows[0];
	if (markerRows.length !== 1 || marker === void 0 || requiredInteger(marker, "version") !== SCHEMA_VERSION || requiredText(marker, "tenant_id") !== tenant.value || !matchesOwner(marker, owner)) throw corrupt$1("Run storage schema version, Tenant, or owner does not match");
	for (const kind of RUN_RECORD_KINDS) listStoredRecords(database, kind);
	database.all(`SELECT commit_id, ordinal, parent_id FROM ${PARENT_TABLE} ORDER BY commit_id, ordinal`, []).forEach((row) => validateParent(decodeParent(row)));
}
function readStoredRecord(database, kind, key) {
	validateKind(kind);
	const rows = database.all(`SELECT kind, record_key, revision, record FROM ${RECORD_TABLE}
         WHERE kind = ? AND record_key = ?`, [kind, key]);
	if (rows.length > 1) throw corrupt$1("Run record primary key returned multiple rows");
	return rows[0] === void 0 ? void 0 : decodeRecord(rows[0], kind, key);
}
function listStoredRecords(database, kind) {
	validateKind(kind);
	return database.all(`SELECT kind, record_key, revision, record FROM ${RECORD_TABLE}
             WHERE kind = ? ORDER BY record_key`, [kind]).map((row) => decodeRecord(row, kind));
}
function matchesOwner(row, owner) {
	return requiredText(row, "owner_kind") === owner.kind && requiredText(row, "owner_id") === owner.id.value;
}
function decodeRecord(row, expectedKind, expectedKey) {
	const kind = requiredText(row, "kind");
	const key = requiredText(row, "record_key");
	const revision = row["revision"];
	const bytes = row["record"];
	if (kind !== expectedKind || expectedKey !== void 0 && key !== expectedKey || revision !== null && (!isSqliteNumber(revision) || !Number.isSafeInteger(revision) || revision < 0) || !(bytes instanceof Uint8Array)) throw corrupt$1("Stored Run record projection is malformed");
	return Object.freeze({
		kind: expectedKind,
		key,
		revision,
		bytes: bytes.slice()
	});
}
function decodeParent(row) {
	const edge = Object.freeze({
		commit: requiredText(row, "commit_id"),
		ordinal: requiredInteger(row, "ordinal"),
		parent: requiredText(row, "parent_id")
	});
	validateParent(edge);
	return edge;
}
function validateRecord(record) {
	validateKind(record.kind);
	if (record.key.length === 0 || !(record.bytes instanceof Uint8Array) || record.revision !== null && (!Number.isSafeInteger(record.revision) || record.revision < 0)) throw corrupt$1("Stored Run record is malformed");
}
function validateKind(kind) {
	if (!isMember(RUN_RECORD_KINDS, kind)) throw corrupt$1("Stored Run record kind is invalid");
}
function validateParent(edge) {
	if (edge.commit.length === 0 || edge.parent.length === 0 || !Number.isSafeInteger(edge.ordinal) || edge.ordinal < 0 || edge.ordinal > 1) throw corrupt$1("Stored Run parent edge is malformed");
}
function recordsEqual(left, right) {
	return left.revision === right.revision && left.bytes.byteLength === right.bytes.byteLength && left.bytes.every((value, index) => value === right.bytes[index]);
}
function requiredText(row, column) {
	const value = row[column];
	if (!isSqliteText(value) || value.length === 0) throw corrupt$1(`SQLite ${column} is invalid`);
	return value;
}
function requiredInteger(row, column) {
	const value = row[column];
	if (!isSqliteNumber(value) || !Number.isSafeInteger(value)) throw corrupt$1(`SQLite ${column} is invalid`);
	return value;
}
function corrupt$1(message) {
	return new AgentCoreError("codec.invalid", message);
}
function invalidStorage(message) {
	return new AgentCoreError("run.invalid-state", message);
}
function invalidTransaction(message) {
	return new AgentCoreError("protocol.invalid-state", message);
}
function normalizeSql(value) {
	return value.trim().replaceAll(/\s+/g, " ");
}
//#endregion
//#region src/substrates/sqlite/permit.ts
var CREATE_PERMITS = `CREATE TABLE IF NOT EXISTS authority_permit_nonces (
    nonce TEXT PRIMARY KEY CHECK (length(nonce) > 0),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('tenant', 'workspace', 'run', 'environment', 'slate')),
    owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
    state TEXT NOT NULL CHECK (state IN ('requested', 'issued')),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    record BLOB NOT NULL
) STRICT`;
var CREATE_CONSUMPTIONS = `CREATE TABLE IF NOT EXISTS authority_permit_consumptions (
    nonce TEXT PRIMARY KEY CHECK (length(nonce) > 0),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('tenant', 'workspace', 'run', 'environment', 'slate')),
    owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    permit BLOB NOT NULL
) STRICT`;
var CREATE_DENIALS = `CREATE TABLE IF NOT EXISTS authority_permit_denials (
    nonce TEXT PRIMARY KEY CHECK (length(nonce) > 0),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('tenant', 'workspace', 'run', 'environment', 'slate')),
    owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    denial BLOB NOT NULL
) STRICT`;
var CREATE_LEASE_EVIDENCE_PROJECTIONS = `CREATE TABLE IF NOT EXISTS authority_permit_lease_evidence (
    source_kind TEXT NOT NULL CHECK (source_kind IN ('tenant', 'workspace', 'run', 'environment', 'slate')),
    source_id TEXT NOT NULL CHECK (length(source_id) > 0),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    evidence BLOB NOT NULL,
    PRIMARY KEY (source_kind, source_id, idempotency_key)
) STRICT`;
/**
* One bounded page of this owner's rows, and the deletes a settled expired nonce implies.
* Expiry is read from the stored record rather than from a column: these tables are created
* lazily with IF NOT EXISTS and no migrator owns them, so adding a column would leave every
* database that already exists without it. Decoding a bounded page per sweep costs a known
* amount and keeps the schema exactly as every release before it wrote.
*/
var PRUNE_CANDIDATES = `SELECT * FROM authority_permit_nonces
    WHERE owner_kind = ? AND owner_id = ? AND nonce > ? ORDER BY nonce LIMIT ?`;
var PRUNE_CONSUMPTION = "DELETE FROM authority_permit_consumptions WHERE nonce = ?";
var PRUNE_DENIAL = "DELETE FROM authority_permit_denials WHERE nonce = ?";
var PRUNE_NONCE = "DELETE FROM authority_permit_nonces WHERE nonce = ?";
/**
* Proves a prune sweep is bounded and its horizon is a real instant, returning that instant.
* Both are construction shape rather than operational conditions, so both refuse with
* TypeError, and they refuse in one named place so no call site re-states the rule.
*/
function requirePruneBounds(before, limit) {
	const horizon = before.getTime();
	if (!Number.isSafeInteger(horizon) || horizon < 0) throw new TypeError("Authority permit prune horizon must be a valid time");
	if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("Authority permit prune limit must be a positive safe integer");
	return horizon;
}
var SqliteAuthorityPermitStore = class {
	database;
	owner;
	#actors;
	constructor(database, owner) {
		this.database = database;
		this.owner = owner;
		try {
			this.#actors = new SqliteActorStore(database);
			database.transaction(() => {
				database.run(CREATE_PERMITS, []);
				database.run(CREATE_CONSUMPTIONS, []);
				database.run(CREATE_DENIALS, []);
				database.run(CREATE_LEASE_EVIDENCE_PROJECTIONS, []);
			});
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw corrupt("Authority permit schema initialization failed");
		}
	}
	transaction(operation, ...guard) {
		return this.#actors.transaction(operation, ...guard);
	}
	issued(transaction, nonce) {
		const row = this.row(transaction, nonce);
		if (row === void 0 || this.ownedByAnother(row)) return void 0;
		if (this.requireNonceState(row, nonce) !== "issued") return void 0;
		return this.decodeIssued(row, nonce);
	}
	projectedEvidence(transaction, reference) {
		this.requireTransaction(transaction);
		const row = transaction.all(`SELECT * FROM authority_permit_lease_evidence
             WHERE source_kind = ? AND source_id = ? AND idempotency_key = ?`, [
			reference.key.source.kind,
			reference.key.source.id.value,
			reference.key.idempotencyKey
		])[0];
		if (row === void 0) return void 0;
		const bytes = row["evidence"];
		if (!(bytes instanceof Uint8Array) || text$1(row, "digest") !== reference.digest.value) throw corrupt();
		const evidence = TargetLeaseEvidence.decode(bytes.slice());
		if (!evidence.key.equals(reference.key) || !evidence.digest().equals(reference.digest)) throw corrupt();
		return evidence;
	}
	projectEvidence(transaction, evidence) {
		this.requireTransaction(transaction);
		try {
			transaction.run(`INSERT OR IGNORE INTO authority_permit_lease_evidence
                    (source_kind, source_id, idempotency_key, digest, evidence)
                 VALUES (?, ?, ?, ?, ?)`, [
				evidence.key.source.kind,
				evidence.key.source.id.value,
				evidence.key.idempotencyKey,
				evidence.digest().value,
				TargetLeaseEvidence.encode(evidence)
			]);
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw denied("Target lease evidence could not be projected atomically");
		}
		const row = transaction.all(`SELECT * FROM authority_permit_lease_evidence
             WHERE source_kind = ? AND source_id = ? AND idempotency_key = ?`, [
			evidence.key.source.kind,
			evidence.key.source.id.value,
			evidence.key.idempotencyKey
		])[0];
		const bytes = row?.["evidence"];
		if (row === void 0 || !(bytes instanceof Uint8Array)) throw conflict("Target lease evidence projection did not persist");
		const stored = TargetLeaseEvidence.decode(bytes.slice());
		if (!stored.key.equals(evidence.key) || !stored.digest().equals(evidence.digest()) || text$1(row, "digest") !== stored.digest().value) throw denied("Target lease evidence projection key is bound to another attestation");
		return stored;
	}
	requested(transaction, nonce) {
		const row = this.row(transaction, nonce);
		if (row === void 0 || this.ownedByAnother(row)) return void 0;
		if (this.requireNonceState(row, nonce) !== "requested") return void 0;
		return this.decodeRequested(row, nonce);
	}
	consumed(transaction, nonce) {
		const row = this.consumptionRow(transaction, nonce);
		if (row === void 0) return void 0;
		if (this.denialRow(transaction, nonce) !== void 0) throw corrupt();
		return this.decodeConsumed(transaction, row, nonce).digest();
	}
	denied(transaction, nonce) {
		const row = this.denialRow(transaction, nonce);
		if (row === void 0) return void 0;
		if (this.consumptionRow(transaction, nonce) !== void 0) throw corrupt();
		return this.decodeDenied(transaction, row, nonce);
	}
	request(transaction, request) {
		this.requireTransaction(transaction);
		if (!request.expectation.target.actor.equals(this.owner)) throw denied("Authority permit request targets another Actor owner");
		const bytes = TargetAuthorityPermitRequest.encode(request);
		try {
			transaction.run(`INSERT OR IGNORE INTO authority_permit_nonces
                    (nonce, owner_kind, owner_id, state, digest, record)
                 VALUES (?, ?, ?, 'requested', ?, ?)`, [
				request.nonce,
				this.owner.kind,
				this.owner.id.value,
				request.digest().value,
				bytes
			]);
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw denied("Authority permit target request could not be recorded atomically");
		}
		const stored = this.requested(transaction, request.nonce);
		if (stored === void 0) throw this.occupancyDenial(transaction, request.nonce, "Authority permit target request could not be recorded atomically");
		if (!stored.digest().equals(request.digest())) throw denied("Authority permit nonce is bound to another target request");
		return stored;
	}
	deny(transaction, denial) {
		this.requireTransaction(transaction);
		if (!denial.request.expectation.target.actor.equals(this.owner)) throw denied("Authority permit denial targets another Actor owner");
		const request = this.requested(transaction, denial.request.nonce);
		if (request === void 0 || !request.digest().equals(denial.request.digest())) throw denied("Authority denial does not match its exact durable target request");
		const existing = this.denied(transaction, denial.request.nonce);
		if (existing !== void 0) {
			if (!existing.digest().equals(denial.digest())) throw denied("Authority permit nonce is bound to another Tenant denial");
			return existing;
		}
		if (this.consumptionRow(transaction, denial.request.nonce) !== void 0) throw denied("Authority permit nonce was already consumed by this Actor owner");
		try {
			transaction.run(`INSERT INTO authority_permit_denials
                    (nonce, owner_kind, owner_id, digest, denial)
                 VALUES (?, ?, ?, ?, ?)`, [
				denial.request.nonce,
				this.owner.kind,
				this.owner.id.value,
				denial.digest().value,
				TargetAuthorityPermitDenial.encode(denial)
			]);
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw denied("Authority permit denial could not be recorded atomically");
		}
		const stored = this.denied(transaction, denial.request.nonce);
		if (stored === void 0 || !stored.digest().equals(denial.digest())) throw conflict("Authority permit denial did not persist exactly");
		return stored;
	}
	issue(transaction, permit) {
		this.requireTransaction(transaction);
		if (!permit.issuer.equals(this.owner)) throw denied("Authority permit was issued by another Actor owner");
		const bytes = AuthorityPermit.encode(permit);
		try {
			transaction.run(`INSERT OR IGNORE INTO authority_permit_nonces
                    (nonce, owner_kind, owner_id, state, digest, record)
                 VALUES (?, ?, ?, 'issued', ?, ?)`, [
				permit.nonce,
				this.owner.kind,
				this.owner.id.value,
				permit.digest().value,
				bytes
			]);
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw denied("Authority permit nonce could not be issued atomically");
		}
		const stored = this.issued(transaction, permit.nonce);
		if (stored === void 0) throw this.occupancyDenial(transaction, permit.nonce, "Authority permit nonce could not be issued atomically");
		if (!stored.expectation.equals(permit.expectation) || !stored.requestDigest.equals(permit.requestDigest)) throw denied("Authority permit nonce is bound to another issuance expectation");
		return stored;
	}
	consume(transaction, authentication, permit, expected, now) {
		this.requireTransaction(transaction);
		requireAuthenticatedAuthorityPermit(authentication, permit);
		if (!permit.target.actor.equals(this.owner)) throw denied("Authority permit targets another Actor owner");
		permit.assertConsumable(expected, now);
		const occupant = this.row(transaction, permit.nonce);
		if (occupant !== void 0 && this.ownedByAnother(occupant)) throw denied("Authority permit nonce is already held by another Actor owner");
		const requested = this.requested(transaction, permit.nonce);
		if (requested === void 0) {
			if (occupant !== void 0) throw denied("Authority permit nonce was already used by this Actor owner");
			throw denied("Authority permit has no durable target request");
		}
		if (!requested.expectation.equals(expected)) throw denied("Authority permit does not match its exact target request");
		if (!permit.requestDigest.equals(requested.digest())) throw denied("Authority permit was issued for another target request");
		if (this.denialRow(transaction, permit.nonce) !== void 0) throw denied("Authority permit request was denied by its Tenant");
		if (this.consumptionRow(transaction, permit.nonce) !== void 0) throw denied("Authority permit nonce was already used by this Actor owner");
		const digest = permit.digest();
		try {
			transaction.run(`INSERT INTO authority_permit_consumptions
                    (nonce, owner_kind, owner_id, digest, permit)
                 VALUES (?, ?, ?, ?, ?)`, [
				permit.nonce,
				this.owner.kind,
				this.owner.id.value,
				digest.value,
				AuthorityPermit.encode(permit)
			]);
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw denied("Authority permit nonce could not be consumed exactly once");
		}
		if (!this.consumed(transaction, permit.nonce)?.equals(digest)) throw conflict("Authority permit consumption did not persist exactly");
	}
	row(transaction, nonce) {
		this.requireTransaction(transaction);
		try {
			return transaction.all("SELECT * FROM authority_permit_nonces WHERE nonce = ?", [nonce])[0];
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw corrupt("Authority permit read failed");
		}
	}
	consumptionRow(transaction, nonce) {
		this.requireTransaction(transaction);
		try {
			return transaction.all("SELECT * FROM authority_permit_consumptions WHERE nonce = ?", [nonce])[0];
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw corrupt("Authority permit consumption read failed");
		}
	}
	denialRow(transaction, nonce) {
		this.requireTransaction(transaction);
		try {
			return transaction.all("SELECT * FROM authority_permit_denials WHERE nonce = ?", [nonce])[0];
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw corrupt("Authority permit denial read failed");
		}
	}
	/**
	* Deletes rows whose permit expiry precedes `before`, reading at most `limit` candidates
	* after the `after` cursor, and reports where the next page resumes.
	*
	* Time settles a permit, not the consumption ledger. An expired permit can decide nothing
	* on either side: issuance refuses a request whose expiry is not after the issuance clock,
	* and assertConsumable refuses a permit outside its window, so a row whose expiry has
	* passed buys nothing whether or not it was ever consumed or denied. Keying retention on
	* settled rows left every unsettled row — an abandoned request, an issuance the target
	* never came back for — resident forever, which is the unbounded growth this exists to
	* stop. The caller subtracts its retention from the horizon, so `before` already means
	* expiry plus retention.
	*
	* The page is a keyset, not an offset. A fixed `ORDER BY nonce LIMIT n` window is occupied
	* by whatever sorts first, so a run of rows too young to prune at the head of the ordering
	* would fill every page forever and no later row would ever be reached. The cursor moves
	* past everything examined, pruned or not, so the sweep always advances.
	*
	* Excluded on purpose: authority_permit_lease_evidence. Its rows are keyed by source and
	* idempotency key rather than by nonce, so this nonce-ordered walk cannot reach them
	* coherently, and a source may legitimately re-project an attestation after the permit it
	* attested expired. Sweeping it needs its own source-keyed pass; the exclusion is recorded
	* on the conformance row rather than left for a reader to infer.
	*/
	prune(transaction, before, limit, after = "") {
		this.requireTransaction(transaction);
		const horizon = requirePruneBounds(before, limit);
		let candidates;
		try {
			candidates = transaction.all(PRUNE_CANDIDATES, [
				this.owner.kind,
				this.owner.id.value,
				after,
				limit
			]);
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw corrupt("Authority permit prune read failed");
		}
		let removed = 0;
		let cursor = after;
		for (const row of candidates) {
			const nonce = text$1(row, "nonce");
			cursor = nonce;
			const expiresAt = this.storedExpiry(row);
			if (expiresAt === void 0 || expiresAt >= horizon) continue;
			try {
				transaction.run(PRUNE_CONSUMPTION, [nonce]);
				transaction.run(PRUNE_DENIAL, [nonce]);
				transaction.run(PRUNE_NONCE, [nonce]);
			} catch (error) {
				if (error instanceof AgentCoreError) throw error;
				throw corrupt("Authority permit prune failed");
			}
			removed += 1;
		}
		return Object.freeze({
			removed,
			examined: candidates.length,
			more: candidates.length >= limit,
			cursor
		});
	}
	decodeRequested(row, expectedNonce) {
		this.validateOwner(row);
		const record = row["record"];
		if (!(record instanceof Uint8Array)) throw corrupt();
		let request;
		try {
			request = TargetAuthorityPermitRequest.decode(record.slice());
		} catch {
			throw corrupt();
		}
		if (request.nonce !== expectedNonce || text$1(row, "nonce") !== expectedNonce || text$1(row, "state") !== "requested" || text$1(row, "digest") !== request.digest().value || !request.expectation.target.actor.equals(this.owner)) throw corrupt();
		return request;
	}
	decodeIssued(row, expectedNonce) {
		this.validateOwner(row);
		const record = row["record"];
		if (!(record instanceof Uint8Array)) throw corrupt();
		let permit;
		try {
			permit = AuthorityPermit.decode(record.slice());
		} catch {
			throw corrupt();
		}
		if (permit.nonce !== expectedNonce || text$1(row, "nonce") !== expectedNonce || text$1(row, "state") !== "issued" || text$1(row, "digest") !== permit.digest().value || !permit.issuer.equals(this.owner)) throw corrupt();
		return permit;
	}
	decodeConsumed(transaction, row, expectedNonce) {
		this.validateOwner(row);
		const bytes = row["permit"];
		if (!(bytes instanceof Uint8Array)) throw corrupt();
		let permit;
		try {
			permit = AuthorityPermit.decode(bytes.slice());
		} catch {
			throw corrupt();
		}
		const request = this.requested(transaction, expectedNonce);
		if (request === void 0 || permit.nonce !== expectedNonce || text$1(row, "nonce") !== expectedNonce || text$1(row, "digest") !== permit.digest().value || !permit.target.actor.equals(this.owner) || !permit.expectation.equals(request.expectation) || !permit.requestDigest.equals(request.digest())) throw corrupt();
		return permit;
	}
	decodeDenied(transaction, row, expectedNonce) {
		this.validateOwner(row);
		const bytes = row["denial"];
		if (!(bytes instanceof Uint8Array)) throw corrupt();
		let denial;
		try {
			denial = TargetAuthorityPermitDenial.decode(bytes.slice());
		} catch {
			throw corrupt();
		}
		const request = this.requested(transaction, expectedNonce);
		if (request === void 0 || denial.request.nonce !== expectedNonce || text$1(row, "nonce") !== expectedNonce || text$1(row, "digest") !== denial.digest().value || !denial.request.expectation.target.actor.equals(this.owner) || !denial.request.digest().equals(request.digest())) throw corrupt();
		return denial;
	}
	/**
	* The state a nonce row declares, refused when it is not one this store writes or when
	* the stored record does not match it.
	*
	* A reader must not filter on state and return nothing: an unknown state, or a record of
	* the wrong kind for its state, is corruption and silently reading past it hands a caller
	* "no such nonce" for a row that exists. Recovery caught this by decoding every row on
	* construction; the read that meets the row catches it now, which is the same refusal
	* without the unbounded startup scan.
	*/
	requireNonceState(row, nonce) {
		this.validateOwner(row);
		const state = text$1(row, "state");
		if (state !== "requested" && state !== "issued") throw corrupt();
		const record = row["record"];
		if (!(record instanceof Uint8Array)) throw corrupt();
		try {
			if (state === "issued") AuthorityPermit.decode(record.slice());
			else TargetAuthorityPermitRequest.decode(record.slice());
		} catch {
			throw corrupt();
		}
		if (text$1(row, "nonce") !== nonce) throw corrupt();
		return state;
	}
	/**
	* The expiry a stored nonce row carries, for a store on either side of the permit.
	*
	* `decodeIssued` cannot serve this: it asserts the permit's issuer IS this store's owner,
	* which holds on the Tenant side and never on the target side, so a target's prune would
	* find nothing prunable at all.
	*/
	storedExpiry(row) {
		const record = row["record"];
		if (!(record instanceof Uint8Array)) throw corrupt();
		const state = text$1(row, "state");
		if (state !== "requested" && state !== "issued") throw corrupt();
		try {
			return state === "issued" ? AuthorityPermit.decode(record.slice()).expiresAt.getTime() : TargetAuthorityPermitRequest.decode(record.slice()).expiresAt.getTime();
		} catch {
			throw corrupt();
		}
	}
	/**
	* The refusal a nonce that would not take a write deserves, named for who actually holds
	* it. `INSERT OR IGNORE` no-ops silently against a row another Actor owns, and the
	* read-back then sees nothing; reporting that as this Actor having used the nonce blames
	* the wrong party and hides a shared-database collision behind a replay message.
	*/
	occupancyDenial(transaction, nonce, vanished) {
		const occupant = this.row(transaction, nonce);
		if (occupant === void 0) return denied(vanished);
		if (this.ownedByAnother(occupant)) return denied("Authority permit nonce is already held by another Actor owner");
		return denied("Authority permit nonce was already used by this Actor owner");
	}
	/** Whether this row's owner columns name an Actor other than this store's owner. */
	ownedByAnother(row) {
		return text$1(row, "owner_kind") !== this.owner.kind || text$1(row, "owner_id") !== this.owner.id.value;
	}
	validateOwner(row) {
		if (text$1(row, "owner_kind") !== this.owner.kind || text$1(row, "owner_id") !== this.owner.id.value) throw corrupt();
	}
	requireTransaction(transaction) {
		if (!(transaction instanceof TransactionalSqlite) || !hasSameSqliteProvenance(this.database, transaction)) throw new TypeError("Authority permit transaction belongs to another SQLite owner");
		if (!isActiveSqliteActorTransaction(transaction)) throw new AgentCoreError("actor.stale-callback", "Authority permit writes require the active SQLite Actor transaction");
	}
};
/** Binds a Tenant's current authority view and issued permits to one SQLite transaction. */
var SqliteTenantAuthorityPermitStore = class extends TenantAuthorityTransactionPort {
	database;
	owner;
	#permits;
	#authority;
	#actors;
	constructor(database, owner) {
		super();
		this.database = database;
		this.owner = owner;
		if (owner.kind !== "tenant") throw new TypeError("SQLite Tenant authority permit store requires a Tenant Actor");
		this.#authority = createSqliteTenantControlStore(database);
		this.#permits = new SqliteAuthorityPermitStore(database, owner);
		this.#actors = new SqliteActorStore(database);
	}
	bindActor(actor) {
		this.#actors.bindActor(actor);
	}
	activateActor(actor, start) {
		return this.#actors.activateActor(actor, start);
	}
	loadRecoveryState(transaction, actor) {
		return this.#actors.loadRecoveryState(transaction, actor);
	}
	saveRecoveryState(transaction, state) {
		this.#actors.saveRecoveryState(transaction, state);
	}
	loadRecordSetDeclaration(transaction, actor) {
		return this.#actors.loadRecordSetDeclaration(transaction, actor);
	}
	saveRecordSetDeclaration(transaction, actor, declaration) {
		this.#actors.saveRecordSetDeclaration(transaction, actor, declaration);
	}
	authority(transaction) {
		this.requireTransaction(transaction);
		return this.#authority;
	}
	transaction(operation, ...guard) {
		return this.#actors.transaction(operation, ...guard);
	}
	read(transaction, operation, ...guard) {
		return this.#actors.read(transaction, operation, ...guard);
	}
	projectedEvidence(transaction, reference) {
		return this.#permits.projectedEvidence(transaction, reference);
	}
	projectEvidence(transaction, evidence) {
		return this.#permits.projectEvidence(transaction, evidence);
	}
	issued(transaction, nonce) {
		return this.#permits.issued(transaction, nonce);
	}
	issue(transaction, permit) {
		return this.#permits.issue(transaction, permit);
	}
	requireTransaction(transaction) {
		if (!(transaction instanceof TransactionalSqlite) || !hasSameSqliteProvenance(this.database, transaction)) throw new TypeError("Tenant authority transaction belongs to another SQLite owner");
		if (!isActiveSqliteActorTransaction(transaction)) throw new AgentCoreError("actor.stale-callback", "Tenant authority writes require the active SQLite Actor transaction");
	}
};
function text$1(row, column) {
	const value = row[column];
	if (!isSqliteText(value) || value.length === 0) throw corrupt();
	return value;
}
function denied(message) {
	return new AgentCoreError("authority.denied", message);
}
function conflict(message) {
	return new AgentCoreError("protocol.revision-conflict", message);
}
function corrupt(message = "Stored authority permit ownership is malformed") {
	return new AgentCoreError("codec.invalid", message);
}
//#endregion
//#region src/substrates/sqlite/watermark.ts
var CREATE_WATERMARKS = `CREATE TABLE IF NOT EXISTS actor_invalidation_watermarks (
    watermark_key TEXT PRIMARY KEY CHECK (length(watermark_key) > 0),
    owner_tenant_id TEXT NOT NULL CHECK (length(owner_tenant_id) > 0),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('tenant', 'workspace', 'run', 'environment', 'slate')),
    owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
    holder_tenant_id TEXT NOT NULL CHECK (length(holder_tenant_id) > 0),
    holder_principal_id TEXT NOT NULL CHECK (length(holder_principal_id) > 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL
) STRICT`;
var SqliteInvalidationWatermarkStore = class {
	database;
	ownerTenant;
	owner;
	constructor(database, ownerTenant, owner) {
		this.database = database;
		this.ownerTenant = ownerTenant;
		this.owner = owner;
		try {
			database.transaction(() => database.run(CREATE_WATERMARKS, []));
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw new AgentCoreError("protocol.revision-conflict", "Watermark schema initialization failed");
		}
		for (const row of readWatermarks(database, "SELECT * FROM actor_invalidation_watermarks ORDER BY watermark_key", [])) {
			const watermark = decodeWatermark(row, text(row, "watermark_key"));
			if (!watermark.ownerTenant.equals(ownerTenant) || !watermark.owner.equals(owner)) throw corruptWatermark();
		}
	}
	load(key) {
		const row = readWatermarks(this.database, "SELECT * FROM actor_invalidation_watermarks WHERE watermark_key = ?", [key])[0];
		if (row === void 0) return void 0;
		const watermark = decodeWatermark(row, key);
		if (!watermark.ownerTenant.equals(this.ownerTenant) || !watermark.owner.equals(this.owner)) throw corruptWatermark();
		return watermark;
	}
	save(watermark) {
		try {
			this.database.transaction(() => this.saveUsing(this.database, watermark));
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw new AgentCoreError("protocol.revision-conflict", "Watermark write failed");
		}
	}
	loadInTransaction(transaction, key) {
		this.requireTransaction(transaction);
		return this.loadUsing(transaction, key);
	}
	saveInTransaction(transaction, watermark) {
		this.requireTransaction(transaction);
		this.saveUsing(transaction, watermark);
	}
	joinInTransaction(transaction, key, entries) {
		this.requireTransaction(transaction);
		const current = this.loadUsing(transaction, key);
		if (current === void 0) throw new AgentCoreError("protocol.invalid-state", "Watermark must be initialized before join");
		const joined = current.join(entries);
		this.saveUsing(transaction, joined);
		return joined;
	}
	saveUsing(transaction, watermark) {
		if (!watermark.ownerTenant.equals(this.ownerTenant) || !watermark.owner.equals(this.owner)) throw new AgentCoreError("protocol.invalid-state", "Watermark belongs to another Actor store");
		const key = watermarkKey(watermark);
		const previous = this.loadUsing(transaction, key);
		if (previous === void 0) {
			if (watermark.revision.value !== 0) throw new AgentCoreError("protocol.revision-conflict", "New watermarks require revision zero");
			transaction.run(`INSERT INTO actor_invalidation_watermarks (
                    watermark_key, owner_tenant_id, owner_kind, owner_id,
                    holder_tenant_id, holder_principal_id, revision, record
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, projections(watermark));
		} else {
			const previousBytes = InvalidationWatermark.encode(previous);
			const nextBytes = InvalidationWatermark.encode(watermark);
			if (bytesEqual(previousBytes, nextBytes)) return;
			if (watermark.revision.value !== previous.revision.value + 1 || !watermark.dominates(previous)) throw new AgentCoreError("protocol.revision-conflict", "Watermark updates require monotonic entries and the next revision");
			transaction.run(`UPDATE actor_invalidation_watermarks SET revision = ?, record = ?
                 WHERE watermark_key = ? AND revision = ?`, [
				watermark.revision.value,
				nextBytes,
				key,
				previous.revision.value
			]);
		}
		const stored = this.loadUsing(transaction, key);
		if (stored === void 0 || !bytesEqual(InvalidationWatermark.encode(stored), InvalidationWatermark.encode(watermark))) throw new AgentCoreError("protocol.revision-conflict", "Watermark changed concurrently");
	}
	join(key, entries) {
		try {
			return this.database.transaction(() => {
				const current = this.load(key);
				if (current === void 0) throw new AgentCoreError("protocol.invalid-state", "Watermark must be initialized before join");
				const joined = current.join(entries);
				this.saveUsing(this.database, joined);
				return joined;
			});
		} catch (error) {
			if (error instanceof AgentCoreError) throw error;
			throw new AgentCoreError("protocol.revision-conflict", "Watermark join failed");
		}
	}
	loadUsing(transaction, key) {
		const row = readWatermarks(transaction, "SELECT * FROM actor_invalidation_watermarks WHERE watermark_key = ?", [key])[0];
		if (row === void 0) return void 0;
		const watermark = decodeWatermark(row, key);
		if (!watermark.ownerTenant.equals(this.ownerTenant) || !watermark.owner.equals(this.owner)) throw corruptWatermark();
		return watermark;
	}
	requireTransaction(transaction) {
		if (!(transaction instanceof TransactionalSqlite) || !hasSameSqliteProvenance(this.database, transaction)) throw new TypeError("Watermark transaction belongs to another SQLite owner");
		if (!isActiveSqliteActorTransaction(transaction)) throw new AgentCoreError("actor.stale-callback", "Watermark writes require the active SQLite Actor transaction");
	}
};
function projections(watermark) {
	return [
		watermarkKey(watermark),
		watermark.ownerTenant.value,
		watermark.owner.kind,
		watermark.owner.id.value,
		watermark.holder.tenantId.value,
		watermark.holder.principalId.value,
		watermark.revision.value,
		InvalidationWatermark.encode(watermark)
	];
}
function decodeWatermark(row, expectedKey) {
	const watermark = InvalidationWatermark.decode(bytes(row, "record").slice());
	if (watermarkKey(watermark) !== expectedKey || watermarkKey(watermark) !== text(row, "watermark_key") || watermark.ownerTenant.value !== text(row, "owner_tenant_id") || watermark.owner.kind !== text(row, "owner_kind") || watermark.owner.id.value !== text(row, "owner_id") || watermark.holder.tenantId.value !== text(row, "holder_tenant_id") || watermark.holder.principalId.value !== text(row, "holder_principal_id") || watermark.revision.value !== integer(row, "revision")) throw corruptWatermark();
	return watermark;
}
function text(row, column) {
	const value = row[column];
	if (!isSqliteText(value) || value.length === 0) throw corruptWatermark();
	return value;
}
function integer(row, column) {
	const value = row[column];
	if (!isSqliteNumber(value) || !Number.isSafeInteger(value) || value < 0) throw corruptWatermark();
	return value;
}
function bytes(row, column) {
	const value = row[column];
	if (!(value instanceof Uint8Array)) throw corruptWatermark();
	return value;
}
function bytesEqual(left, right) {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
function readWatermarks(database, statement, bindings) {
	try {
		return database.all(statement, bindings);
	} catch (error) {
		if (error instanceof AgentCoreError) throw error;
		throw new AgentCoreError("codec.invalid", "Watermark read failed");
	}
}
function corruptWatermark() {
	return new AgentCoreError("codec.invalid", "Stored invalidation watermark is malformed");
}
//#endregion
//#region src/substrates/sqlite/target-mediation.ts
var SqliteTargetResolutionInvalidationPort = class {};
/** One physical SQLite Actor store behind the complete target mediation surface. */
var SqliteTargetPermitMediationAggregate = class extends TargetPermitMediationAggregate {
	tenant;
	actor;
	invalidations;
	persistence;
	evidence;
	permitRequests;
	permitDenials;
	permitAdmission;
	#actors;
	#watermarks;
	#active;
	constructor(database, tenant, actor, invalidations) {
		super();
		this.tenant = tenant;
		this.actor = actor;
		this.invalidations = invalidations;
		if (actor.kind === "tenant") throw new TypeError("Target permit mediation requires a non-Tenant Actor");
		this.#actors = new SqliteActorStore(database);
		this.#actors.bindActor(actor);
		const permits = new SqliteAuthorityPermitStore(database, actor);
		const protocol = new SqliteProtocolPersistence(database);
		this.persistence = createTargetInvocationPersistence(database, tenant, actor);
		this.evidence = new SqliteInvocationMediationPersistence(database, protocol);
		this.#watermarks = new SqliteInvalidationWatermarkStore(database, tenant, actor);
		const requireActive = (transaction) => this.requireActive(transaction);
		this.permitRequests = new TargetRequestView(this, permits, requireActive);
		this.permitDenials = new TargetDenialView(actor, permits, requireActive);
		this.permitAdmission = new TargetAdmissionView(actor, permits, requireActive);
	}
	transact(operation) {
		return this.#actors.transact((transaction) => {
			this.#active = transaction;
			try {
				return operation(transaction);
			} finally {
				this.#active = void 0;
			}
		});
	}
	joinDeniedEpochs(transaction, principal, entries) {
		this.requireActive(transaction);
		if (!principal.tenantId.equals(this.tenant) || entries.length === 0) throw new AgentCoreError("protocol.invalid-state", "Target denial epochs require an exact nonempty Tenant path");
		const empty = InvalidationWatermark.empty(this.tenant, this.actor, principal);
		const key = watermarkKey(empty);
		if (this.#watermarks.loadInTransaction(transaction, key) === void 0) this.#watermarks.saveInTransaction(transaction, empty);
		this.#watermarks.joinInTransaction(transaction, key, entries);
	}
	invalidateResolution(transaction, expectation) {
		this.requireActive(transaction);
		if (!expectation.tenant.equals(this.tenant) || !expectation.target.actor.equals(this.actor)) throw new AgentCoreError("authority.denied", "Target resolution invalidation has the wrong owner");
		this.invalidations.invalidate(transaction, expectation);
	}
	requireActive(transaction) {
		if (transaction !== this.#active) throw new AgentCoreError("actor.stale-callback", "Target mediation requires its exact active Actor transaction");
	}
};
var TargetRequestView = class {
	aggregate;
	permits;
	requireActive;
	owner;
	constructor(aggregate, permits, requireActive) {
		this.aggregate = aggregate;
		this.permits = permits;
		this.requireActive = requireActive;
		this.owner = aggregate.actor;
	}
	transaction(operation, ..._guard) {
		return this.aggregate.transact(operation);
	}
	requested(transaction, nonce) {
		this.requireActive(transaction);
		return this.permits.requested(transaction, nonce);
	}
	request(transaction, request) {
		this.requireActive(transaction);
		return this.permits.request(transaction, request);
	}
};
var TargetDenialView = class {
	owner;
	permits;
	requireActive;
	constructor(owner, permits, requireActive) {
		this.owner = owner;
		this.permits = permits;
		this.requireActive = requireActive;
	}
	requested(transaction, nonce) {
		this.requireActive(transaction);
		return this.permits.requested(transaction, nonce);
	}
	denied(transaction, nonce) {
		this.requireActive(transaction);
		return this.permits.denied(transaction, nonce);
	}
	deny(transaction, denial) {
		this.requireActive(transaction);
		return this.permits.deny(transaction, denial);
	}
};
var TargetAdmissionView = class {
	owner;
	permits;
	requireActive;
	constructor(owner, permits, requireActive) {
		this.owner = owner;
		this.permits = permits;
		this.requireActive = requireActive;
	}
	consumed(transaction, nonce) {
		this.requireActive(transaction);
		return this.permits.consumed(transaction, nonce);
	}
	consume(transaction, authentication, permit, expected, now) {
		this.requireActive(transaction);
		this.permits.consume(transaction, authentication, permit, expected, now);
	}
};
function createTargetInvocationPersistence(database, tenant, actor) {
	const codecs = mediationInvocationCodecs(authorityPermitReferenceCodec);
	const custody = new ContentRecordCustody(new SqliteContentRetention(database, tenant, actor));
	return new SqliteInvocationPersistence(database, {
		...codecs,
		projectPrepared: (record) => ({ id: record.header.id.value }),
		projectApproval: (record) => ({
			id: record.id.value,
			invocation: record.invocation.value,
			revision: record.revision.value,
			phase: record.state.kind
		}),
		projectClaim: (record) => ({
			id: record.id.value,
			invocation: record.invocation.value,
			itemIndex: record.itemIndex,
			ordinal: record.attemptOrdinal
		}),
		projectAttempt: (record) => ({
			id: record.id.value,
			invocation: record.invocation.value,
			itemIndex: record.itemIndex,
			ordinal: record.ordinal,
			claim: record.claim.value
		}),
		projectReceipt,
		projectReceiptContent: receiptContentRetention,
		projectContinuation: (record) => ({ invocation: record.invocation.value })
	}, custody);
}
function projectReceipt(record) {
	if (record instanceof PreEffectReceipt) return {
		id: record.id.value,
		variant: record.variant,
		invocation: record.invocation.value,
		itemIndex: record.itemIndex,
		outcome: record.outcome
	};
	if (record instanceof AttemptReceipt) {
		const projected = {
			id: record.id.value,
			variant: record.variant,
			attempt: record.attempt.value,
			outcome: record.outcome
		};
		return record.previous === void 0 ? projected : {
			...projected,
			previous: record.previous.value
		};
	}
	throw new AgentCoreError("codec.invalid", "Stored Receipt record has an unknown variant");
}
//#endregion
export { ReadableSqlite, SqliteActorStore, SqliteAuthorityPermitStore, SqliteContentRetention, SqliteContentStore, SqliteDetachedEffectExecutionPersistence, SqliteIdentityReader, SqliteInvalidationWatermarkStore, SqliteInvocationMediationPersistence, SqliteInvocationPersistence, SqlitePackageStore, SqliteProtocolPersistence, SqliteRunStorage, SqliteTargetPermitMediationAggregate, SqliteTargetResolutionInvalidationPort, SqliteTenantAuthorityPermitStore, SqliteTenantBootstrap, SqliteTransientContentAccess, SqliteWorkspaceRecords, TransactionalSqlite, createSqliteTenantBootstrap, ownSqliteMutations };

//# sourceMappingURL=index.js.map