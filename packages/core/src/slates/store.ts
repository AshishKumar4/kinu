import { AgentCoreError, type RecordCodec, type Revision, type TextId, type WorkspaceId } from '@agent-core/core';
import {
  Slate, SlatePublication, SlateStore, SlateVersion,
  type SlateDeployment, type SlateDeploymentReservation, type SlateId, type SlatePreview, type SlatePublicationId,
  type SlateResource, type SlateResourceReservation, type SlateVersionId,
} from '@agent-core/core/slates';
import * as v from 'valibot';
import type { SqlExec } from '../types/primitives';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';

const StoredBytes = v.object({ bytes: v.instance(ArrayBuffer) });

const StoredVersionRow = v.object({ id: v.string(), bytes: v.instance(ArrayBuffer) });

type RecordTable = 'slate_versions' | 'slate_publications';

interface OwnedRecord {
  readonly id: TextId;
  readonly workspaceId: WorkspaceId;
  readonly slateId: SlateId;
}

/** One RPC answer holds this many rows at the SQLite row ceiling. */
const SLATE_HISTORY_PAGE = Math.floor(PLATFORM_CATALOG['rpc.arg_bytes'].limit.value / PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value);

function binary(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;

  return new Uint8Array(bytes).buffer;
}

function invalid(message: string): never {
  throw new AgentCoreError('protocol.invalid-state', message);
}

function refuse(): never {
  return invalid('Slate deployments, resources and previews are not stored');
}

export class SqliteSlateStore extends SlateStore {
  constructor(private readonly db: SqlExec, private readonly atomic: <Result>(operation: () => Result) => Result) {
    super();
  }

  transaction<Result>(operation: (store: SlateStore) => Result): Result {
    return this.atomic(() => operation(this));
  }

  getSlate(id: SlateId): Slate | undefined {
    const row = this.db.exec('SELECT bytes FROM slates WHERE id = ? ORDER BY revision DESC LIMIT 1', id.value).toArray()[0];

    return row === undefined ? undefined : Slate.decode(new Uint8Array(v.parse(StoredBytes, row).bytes));
  }

  listSlates(workspaceId?: WorkspaceId): readonly Slate[] {
    const rows = workspaceId === undefined
      ? this.db.exec('SELECT s.bytes FROM slates s WHERE s.revision = (SELECT MAX(h.revision) FROM slates h WHERE h.id = s.id) ORDER BY s.id').toArray()
      : this.db.exec('SELECT s.bytes FROM slates s WHERE s.workspace_id = ? AND s.revision = (SELECT MAX(h.revision) FROM slates h WHERE h.id = s.id) ORDER BY s.id', workspaceId.value).toArray();

    return rows.map((row) => Slate.decode(new Uint8Array(v.parse(StoredBytes, row).bytes)));
  }

  getSlateRevision(id: SlateId, revision: Revision): Slate | undefined {
    const row = this.db.exec('SELECT bytes FROM slates WHERE id = ? AND revision = ?', id.value, revision.value).toArray()[0];

    return row === undefined ? undefined : Slate.decode(new Uint8Array(v.parse(StoredBytes, row).bytes));
  }

  listSlateHistory(id: SlateId): readonly Slate[] {
    return this.db.exec('SELECT bytes FROM slates WHERE id = ? ORDER BY revision', id.value).toArray()
      .map((row) => Slate.decode(new Uint8Array(v.parse(StoredBytes, row).bytes)));
  }

  compareAndSetSlate(expected: Revision | undefined, next: Slate): boolean {
    return this.atomic(() => {
      const current = this.getSlate(next.id);

      if (expected === undefined) {
        if (current !== undefined) return false;

        if (next.revision.value !== 0) invalid('A new Slate must start at revision zero');
      } else {
        if (current === undefined || !current.revision.equals(expected)) return false;

        if (next.revision.value !== expected.value + 1) invalid('A Slate update must append the next revision');

        if (!next.workspaceId.equals(current.workspaceId)) invalid('Slate workspace ownership is immutable');

        if (next.forkedFrom?.slateId.value !== current.forkedFrom?.slateId.value
          || next.forkedFrom?.versionId.value !== current.forkedFrom?.versionId.value) invalid('Slate fork origin is immutable');
      }

      if (next.headVersionId !== undefined) this.requireRecord(this.getVersion(next.headVersionId), next);

      if (next.latestPublicationId !== undefined) this.requireRecord(this.getPublication(next.latestPublicationId), next);

      if (next.activeDeploymentId !== undefined) refuse();

      if (next.forkedFrom !== undefined) {
        const origin = this.getVersion(next.forkedFrom.versionId);

        if (origin === undefined || !origin.slateId.equals(next.forkedFrom.slateId)
          || !origin.workspaceId.equals(next.workspaceId)) invalid('A fork must name a version in its workspace');
      }

      this.db.exec('INSERT INTO slates (id, workspace_id, revision, bytes) VALUES (?, ?, ?, ?)',
        next.id.value, next.workspaceId.value, next.revision.value, binary(Slate.encode(next)));

      return true;
    });
  }

  addVersion(version: SlateVersion): void {
    if (version.parentVersionId !== undefined) this.requireRecord(this.getVersion(version.parentVersionId), version);
    this.put('slate_versions', version, SlateVersion.codec);
  }
  getVersion(id: SlateVersionId): SlateVersion | undefined { return this.get('slate_versions', id, SlateVersion.codec); }
  listVersions(id: SlateId): readonly SlateVersion[] { return this.list('slate_versions', id, SlateVersion.codec); }

  versionPage(id: SlateId, after?: string) {
    return settleSync(Effect.map(this.cursorRow(id, after), (from) => this.versionsFrom(id, from)));
  }

  private cursorRow(id: SlateId, after: string | undefined): Effect.Effect<number, KinuError> {
    if (after === undefined) return Effect.succeed(0);
    const row = this.db.exec('SELECT rowid AS at FROM slate_versions WHERE id = ? AND slate_id = ?', after, id.value).toArray()[0];

    return row === undefined
      ? Effect.fail(new KinuError('missing', 'The history cursor names no version of this slate'))
      : Effect.succeed(v.parse(v.object({ at: v.number() }), row).at);
  }

  private versionsFrom(id: SlateId, from: number) {
    const rows = this.db.exec(
      'SELECT id, bytes FROM slate_versions WHERE slate_id = ? AND rowid > ? ORDER BY rowid LIMIT ?',
      id.value, from, SLATE_HISTORY_PAGE + 1,
    ).toArray().map((row) => v.parse(StoredVersionRow, row));

    const page = rows.slice(0, SLATE_HISTORY_PAGE);

    return {
      versions: page.map((row) => SlateVersion.codec.decode(new Uint8Array(row.bytes))),
      next: rows.length > SLATE_HISTORY_PAGE ? page.at(-1)?.id ?? null : null,
    };
  }

  addPublication(publication: SlatePublication): void {
    this.requireRecord(this.getVersion(publication.versionId), publication);
    this.put('slate_publications', publication, SlatePublication.codec);
  }
  getPublication(id: SlatePublicationId): SlatePublication | undefined { return this.get('slate_publications', id, SlatePublication.codec); }
  listPublications(id: SlateId): readonly SlatePublication[] { return this.list('slate_publications', id, SlatePublication.codec); }

  addDeployment(): void { refuse(); }
  getDeployment(): SlateDeployment | undefined { return undefined; }
  listDeployments(): readonly SlateDeployment[] { return []; }
  addResource(): void { refuse(); }
  getResource(): SlateResource | undefined { return undefined; }
  listResources(): readonly SlateResource[] { return []; }
  addPreview(): void { refuse(); }
  getPreview(): SlatePreview | undefined { return undefined; }
  listPreviews(): readonly SlatePreview[] { return []; }
  reserveDeployment(): void { refuse(); }
  getDeploymentReservation(): SlateDeploymentReservation | undefined { return undefined; }
  findDeploymentReservationByExternalKey(): SlateDeploymentReservation | undefined { return undefined; }
  reserveResource(): void { refuse(); }
  getResourceReservation(): SlateResourceReservation | undefined { return undefined; }

  private requireRecord(record: OwnedRecord | undefined, owner: OwnedRecord | Slate): void {
    const slateId = owner instanceof Slate ? owner.id : owner.slateId;

    if (record === undefined || !record.workspaceId.equals(owner.workspaceId) || !record.slateId.equals(slateId)) {
      invalid('Slate references must resolve inside the same Slate and workspace');
    }
  }

  private get<Record>(table: RecordTable, id: TextId, codec: RecordCodec<Record>): Record | undefined {
    const row = this.db.exec(`SELECT bytes FROM ${table} WHERE id = ?`, id.value).toArray()[0];

    return row === undefined ? undefined : codec.decode(new Uint8Array(v.parse(StoredBytes, row).bytes));
  }

  private list<Record>(table: RecordTable, id: SlateId, codec: RecordCodec<Record>): readonly Record[] {
    return this.db.exec(`SELECT bytes FROM ${table} WHERE slate_id = ? ORDER BY rowid`, id.value).toArray()
      .map((row) => codec.decode(new Uint8Array(v.parse(StoredBytes, row).bytes)));
  }

  private put<Record extends OwnedRecord>(table: RecordTable, value: Record, codec: RecordCodec<Record>): void {
    const slate = this.getSlate(value.slateId);

    if (slate === undefined || !slate.workspaceId.equals(value.workspaceId)) invalid('Slate record owner does not exist');
    const bytes = codec.encode(value);
    const row = this.db.exec(`SELECT bytes FROM ${table} WHERE id = ?`, value.id.value).toArray()[0];

    if (row !== undefined) {
      const previous = new Uint8Array(v.parse(StoredBytes, row).bytes);

      if (previous.length !== bytes.length || previous.some((byte, index) => byte !== bytes[index])) invalid('Slate records are immutable');

      return;
    }

    this.db.exec(`INSERT INTO ${table} (id, slate_id, bytes) VALUES (?, ?, ?)`, value.id.value, value.slateId.value, binary(bytes));
  }
}
