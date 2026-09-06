import { AgentCoreError, type RecordCodec, type Revision, type TextId, type WorkspaceId } from '@agent-core/core';
import {
  Slate, SlateDeployment, SlateDeploymentReservation, SlatePreview, SlatePublication,
  SlateResource, SlateResourceReservation, SlateStore, SlateVersion,
  type SlateDeploymentId, type SlateId, type SlatePreviewId, type SlatePublicationId,
  type SlateResourceId, type SlateVersionId,
} from '@agent-core/core/slates';
import * as v from 'valibot';
import type { SqlExec } from '../types/primitives';

const StoredBytes = v.object({ bytes: v.instance(ArrayBuffer) });
type RecordTable = 'slate_versions' | 'slate_publications' | 'slate_deployments'
  | 'slate_resources' | 'slate_previews' | 'slate_deployment_reservations' | 'slate_resource_reservations';
interface OwnedRecord {
  readonly id: TextId;
  readonly workspaceId: WorkspaceId;
  readonly slateId: SlateId;
}

function binary(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
  return new Uint8Array(bytes).buffer;
}

function invalid(message: string): never {
  throw new AgentCoreError('protocol.invalid-state', message);
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
      if (next.activeDeploymentId !== undefined) this.requireRecord(this.getDeployment(next.activeDeploymentId), next);
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
  listVersions(id: SlateId): readonly SlateVersion[] { return this.list('slate_versions', 'slate_id', id, SlateVersion.codec); }

  addPublication(publication: SlatePublication): void {
    this.requireRecord(this.getVersion(publication.versionId), publication);
    this.put('slate_publications', publication, SlatePublication.codec);
  }
  getPublication(id: SlatePublicationId): SlatePublication | undefined { return this.get('slate_publications', id, SlatePublication.codec); }
  listPublications(id: SlateId): readonly SlatePublication[] { return this.list('slate_publications', 'slate_id', id, SlatePublication.codec); }

  addDeployment(deployment: SlateDeployment): void {
    this.requireRecord(this.getPublication(deployment.publicationId), deployment);
    const reservation = this.getDeploymentReservation(deployment.id);
    if (reservation === undefined || !reservation.invocationId.equals(deployment.invocationId)
      || !reservation.publicationId.equals(deployment.publicationId) || reservation.target !== deployment.target) {
      invalid('A deployment must fulfill its reservation');
    }
    this.put('slate_deployments', deployment, SlateDeployment.codec);
  }
  getDeployment(id: SlateDeploymentId): SlateDeployment | undefined { return this.get('slate_deployments', id, SlateDeployment.codec); }
  listDeployments(id: SlateId): readonly SlateDeployment[] { return this.list('slate_deployments', 'slate_id', id, SlateDeployment.codec); }

  addResource(resource: SlateResource): void {
    this.requireRecord(this.getDeployment(resource.deploymentId), resource);
    const reservation = this.getResourceReservation(resource.id);
    if (reservation === undefined || !reservation.invocationId.equals(resource.invocationId)
      || !reservation.deploymentId.equals(resource.deploymentId) || reservation.name !== resource.name) {
      invalid('A resource must fulfill its reservation');
    }
    this.put('slate_resources', resource, SlateResource.codec, resource.deploymentId.value);
  }
  getResource(id: SlateResourceId): SlateResource | undefined { return this.get('slate_resources', id, SlateResource.codec); }
  listResources(id: SlateDeploymentId): readonly SlateResource[] { return this.list('slate_resources', 'parent_id', id, SlateResource.codec); }

  addPreview(preview: SlatePreview): void {
    if (preview.versionId !== undefined) {
      const version = this.getVersion(preview.versionId);
      this.requireRecord(version, preview);
      if (version === undefined || !version.source.equals(preview.source)) invalid('Preview source differs from its version');
    }
    this.put('slate_previews', preview, SlatePreview.codec);
  }
  getPreview(id: SlatePreviewId): SlatePreview | undefined { return this.get('slate_previews', id, SlatePreview.codec); }
  listPreviews(id: SlateId): readonly SlatePreview[] { return this.list('slate_previews', 'slate_id', id, SlatePreview.codec); }

  reserveDeployment(reservation: SlateDeploymentReservation): void {
    const publication = this.getPublication(reservation.publicationId);
    this.requireRecord(publication, reservation);
    if (publication === undefined || !publication.materialization.equals(reservation.publicationMaterialization)) {
      invalid('Deployment reservation must name the publication materialization');
    }
    const existing = this.findDeploymentReservationByExternalKey(reservation.externalKey);
    if (existing !== undefined && !existing.id.equals(reservation.id)) invalid('Deployment effect identity is already reserved');
    this.put('slate_deployment_reservations', reservation, SlateDeploymentReservation.codec, reservation.externalKey);
  }
  getDeploymentReservation(id: SlateDeploymentId): SlateDeploymentReservation | undefined {
    return this.get('slate_deployment_reservations', id, SlateDeploymentReservation.codec);
  }
  findDeploymentReservationByExternalKey(key: string): SlateDeploymentReservation | undefined {
    const row = this.db.exec('SELECT bytes FROM slate_deployment_reservations WHERE parent_id = ?', key).toArray()[0];
    return row === undefined ? undefined : SlateDeploymentReservation.decode(new Uint8Array(v.parse(StoredBytes, row).bytes));
  }

  reserveResource(reservation: SlateResourceReservation): void {
    const deployment = this.getDeployment(reservation.deploymentId);
    this.requireRecord(deployment, reservation);
    if (deployment === undefined || !deployment.materialization.equals(reservation.deploymentMaterialization)) {
      invalid('Resource reservation must name the deployment materialization');
    }
    this.put('slate_resource_reservations', reservation, SlateResourceReservation.codec);
  }
  getResourceReservation(id: SlateResourceId): SlateResourceReservation | undefined {
    return this.get('slate_resource_reservations', id, SlateResourceReservation.codec);
  }

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

  private list<Record>(table: RecordTable, column: 'slate_id' | 'parent_id', id: TextId, codec: RecordCodec<Record>): readonly Record[] {
    return this.db.exec(`SELECT bytes FROM ${table} WHERE ${column} = ? ORDER BY rowid`, id.value).toArray()
      .map((row) => codec.decode(new Uint8Array(v.parse(StoredBytes, row).bytes)));
  }

  private put<Record extends OwnedRecord>(table: RecordTable, value: Record, codec: RecordCodec<Record>, parentId: string | null = null): void {
    const slate = this.getSlate(value.slateId);
    if (slate === undefined || !slate.workspaceId.equals(value.workspaceId)) invalid('Slate record owner does not exist');
    const bytes = codec.encode(value);
    const row = this.db.exec(`SELECT bytes FROM ${table} WHERE id = ?`, value.id.value).toArray()[0];
    if (row !== undefined) {
      const previous = new Uint8Array(v.parse(StoredBytes, row).bytes);
      if (previous.length !== bytes.length || previous.some((byte, index) => byte !== bytes[index])) invalid('Slate records are immutable');
      return;
    }
    this.db.exec(`INSERT INTO ${table} (id, workspace_id, slate_id, parent_id, bytes) VALUES (?, ?, ?, ?, ?)`,
      value.id.value, value.workspaceId.value, value.slateId.value, parentId, binary(bytes));
  }
}
