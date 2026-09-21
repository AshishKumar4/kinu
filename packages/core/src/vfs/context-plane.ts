import * as v from 'valibot';
import type { VFS, VfsEntryStat, VfsRevision } from '../types/primitives';
import type { ContextEventRecorder } from '../types/context-plane';
import type { ActorClaimStore } from '../orchestrator/actor-claims';
import type { ContextEntry, ContextSelection } from '../session/context';
import type { PreparedMessage } from '../session/messages';
import type { ContextChange } from '../session/proposals';
import { JsonObjectSchema, JsonValueSchema, type JsonObject, type JsonValue } from '../utils/json';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import { KinuError } from '../obs/error';
import { FileRefusalError } from '../tools/file-edit';
import { isVfsError, makeVfsError } from './errno';
import type { VfsMount, VfsNativeReads } from './mounts';
import { toolPairingGaps } from '../session/tool-pairing';

export interface ActorContextStores { readonly claims: ActorClaimStore; readonly events: ContextEventRecorder | null }

export interface ChildContextResolver { list(): readonly string[]; resolve(storageKey: string): ActorContextStores | null }

export interface ContextMountDeps { readonly stores: () => ActorContextStores; readonly children?: ChildContextResolver | null }

export interface ContextFileHeader {
  readonly actor: string; readonly contextId: string | null; readonly revision: number; readonly proposalId: string | null;
  readonly version: string; readonly messages: number; readonly status: 'active' | 'staged' | 'empty';
  readonly effectiveAt: 'step' | 'turn'; readonly turn: string | null; readonly blocked?: string;
}

const HeaderSchema = v.object({ actor: v.string(), contextId: v.nullable(v.string()), revision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  proposalId: v.nullable(v.string()), version: v.string() });

const RevisionSchema = v.tuple([v.string(), v.nullable(v.string()), v.pipe(v.number(), v.integer(), v.minValue(0)),
  v.nullable(v.string()), v.nullable(v.string()), v.nullable(v.string()), v.nullable(v.number()), v.nullable(v.string())]);

const EntrySchema = v.union([
  v.object({ entryId: v.string(), messageId: v.string(), cutoff: v.pipe(v.number(), v.integer(), v.minValue(0)), message: JsonObjectSchema }),
  v.object({ new: v.literal(true), message: JsonObjectSchema }),
]);

const PairingView = v.object({ role: v.string(), content: v.array(v.object({ type: v.string(), toolCallId: v.optional(v.string()) })) });

const encoder = new TextEncoder();

const token = (value: JsonValue): string => `context:${bytesToBase64(encoder.encode(JSON.stringify(value)))}`;

const absent = (path: string): Error => makeVfsError('ENOENT', 'no such context path', path);

const readOnly = (path: string): Error => makeVfsError('EACCES', 'context evidence is immutable; edit working.jsonl instead', path);

function contextRevision(revision: VfsRevision): v.InferOutput<typeof RevisionSchema> {
  if (!v.is(v.string(), revision) || !revision.startsWith('context:')) throw new KinuError('bad_input', 'invalid context revision');
  const json = new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(revision.slice(8)));

  return v.parse(RevisionSchema, JSON.parse(json));
}

interface Target { readonly stores: ActorContextStores; readonly author: string; readonly segments: readonly string[]; readonly child: boolean }

interface WorkingView {
  readonly target: Target; readonly selection: ContextSelection | null; readonly entries: readonly ContextEntry[];
  readonly header: ContextFileHeader; readonly modified: number;
}

interface Document { readonly owner: ActorClaimStore; readonly writable: boolean; readonly version: string; readonly modified: number; readonly chunks: () => AsyncGenerator<string> }

function contextFiles(deps: ContextMountDeps): VFS & Pick<VfsNativeReads, 'readRange'> {
  const target = (path: string): Target => {
    const parts = path.split('/').filter(part => part !== '' && part !== '.');

    if (parts.includes('..')) throw absent(path);
    const own = deps.stores();

    if (parts[0] !== 'agents') return { stores: own, author: own.claims.actorId, segments: parts, child: false };

    if (parts.length === 1) return { stores: own, author: own.claims.actorId, segments: parts, child: false };
    const key = parts[1];
    const child = key === undefined ? null : deps.children?.resolve(key);

    if (!child || parts[2] === 'agents') throw absent(path);

    return { stores: child, author: own.claims.actorId, segments: parts.slice(2), child: true };
  };

  const working = (resolved: Target): WorkingView => {
    const history = resolved.stores.claims.history;
    const selection = history.context.selected();
    const pending = selection === null ? undefined : history.proposals.pending(selection.contextId).at(-1);
    let entries = selection === null ? [] : history.context.entries(selection);
    let blocked = pending?.deferred_reason ?? undefined;
    let staged = pending !== undefined;

    if (pending !== undefined) {
      try { entries = [...history.proposals.preview(pending.proposal_id)]; }
      catch (cause) {
        if (!(cause instanceof KinuError) || cause.code !== 'denied') throw cause;
        blocked = 'history_rewritten';
        staged = false;
      }
    }

    const claim = resolved.stores.claims.latestTurn();
    const revision = selection?.revision ?? 0;

    const version = token([resolved.stores.claims.actorId, selection?.contextId ?? null, revision, pending?.proposal_id ?? null,
      blocked ?? null, claim?.turnId ?? null, claim?.epoch ?? null, claim?.status ?? null]);

    const head = selection === null ? undefined : history.context.revisions(selection.contextId).find(row => row.revision === revision);

    const header: ContextFileHeader = {
      actor: resolved.stores.claims.actorId, contextId: selection?.contextId ?? null, revision, proposalId: pending?.proposal_id ?? null,
      version, messages: entries.length, status: staged ? 'staged' : selection === null ? 'empty' : 'active',
      effectiveAt: claim?.status === 'admitted' ? 'step' : 'turn', turn: claim?.status === 'admitted' ? claim.turnId : null,
    };

    if (blocked !== undefined) Object.assign(header, { blocked });

    return { target: resolved, selection, entries, header, modified: Math.max(head?.recorded_at ?? 0, pending?.recorded_at ?? 0) };
  };

  const entryChunks = async function* (view: WorkingView, entries: readonly ContextEntry[], jsonl: boolean): AsyncGenerator<string> {
    let first = true;

    for (const entry of entries) {
      const message = await view.target.stores.claims.history.messages.projection(entry);
      const row = { entryId: entry.entryId, messageId: entry.messageId, cutoff: entry.sequence, message };

      if (jsonl) yield `${JSON.stringify(row)}\n`;
      else { yield `${first ? '' : ','}${JSON.stringify(row)}`; first = false; }
    }
  };

  const atRevision = (resolved: Target, revision: VfsRevision): WorkingView => {
    const versionToken = v.parse(v.string(), revision);
    const [actor, contextId, version, proposalId, blocked, turn, , status] = contextRevision(versionToken);

    if (actor !== resolved.stores.claims.actorId) throw new KinuError('denied', 'context revision belongs to another actor');
    const history = resolved.stores.claims.history;
    const selection = contextId === null ? null : { contextId, revision: version };

    if (selection === null && (version !== 0 || proposalId !== null)) throw new KinuError('bad_input', 'empty context revision has content');

    const entries = selection === null ? [] : proposalId !== null && blocked !== 'history_rewritten'
      ? history.proposals.previewAt(proposalId, selection) : history.context.entries(selection);

    const metadata = selection === null ? undefined : history.context.revisions(selection.contextId).find(row => row.revision === version);
    const proposal = proposalId === null ? null : history.proposals.inspect(proposalId);

    const header: ContextFileHeader = { actor, contextId, revision: version, proposalId, version: versionToken, messages: entries.length,
        status: proposalId !== null && blocked !== 'history_rewritten' ? 'staged' : selection === null ? 'empty' : 'active',
        effectiveAt: status === 'admitted' ? 'step' : 'turn', turn: status === 'admitted' ? turn : null };

    if (blocked !== null) Object.assign(header, { blocked });

    return { target: resolved, selection, entries, modified: Math.max(metadata?.recorded_at ?? 0, proposal?.metadata.recorded_at ?? 0), header };
  };

  const workingDocument = (view: WorkingView): Document => ({
    owner: view.target.stores.claims, writable: true, version: view.header.version, modified: view.modified,
    chunks: async function* () {
      yield `${JSON.stringify({ $context: view.header })}\n`;
      yield* entryChunks(view, view.entries, true);
    },
  });

  const document = (path: string): Document => {
    const resolved = target(path);
    const [head, second, third] = resolved.segments;
    const history = resolved.stores.claims.history;
    const view = working(resolved);

    const simple = (value: string, version = view.header.version, modified = view.modified): Document => ({ owner: resolved.stores.claims, writable: false, version, modified,
      chunks: async function* () { yield `${value}\n`; } });

    if (head === 'working.jsonl' && resolved.segments.length === 1) return workingDocument(view);

    if (head === 'claim.json' && resolved.segments.length === 1) return simple(JSON.stringify(resolved.stores.claims.latestTurn(), null, 2));

    if (head === 'history.json' && resolved.segments.length === 1) return simple(JSON.stringify({ context: view.selection,
      revisions: view.selection === null ? [] : history.context.revisions(view.selection.contextId),
      proposals: view.selection === null ? [] : history.proposals.list(view.selection.contextId) }, null, 2));

    if (head === 'revisions' && second !== undefined && resolved.segments.length === 2) {
      const match = /^(\d+)\.json$/u.exec(second);

      if (!match || view.selection === null) throw absent(path);
      const revision = Number(match[1]);
      const metadata = history.context.revisions(view.selection.contextId).find(row => row.revision === revision);

      if (metadata === undefined) throw absent(path);
      const entries = history.context.entries({ contextId: view.selection.contextId, revision });

      return { owner: resolved.stores.claims, writable: false, version: token([resolved.stores.claims.actorId, view.selection.contextId, revision]), modified: metadata.recorded_at,
        chunks: async function* () { yield `{"context":${JSON.stringify({ ...metadata, contextId: view.selection?.contextId })},"entries":[`; yield* entryChunks(view, entries, false); yield ']}\n'; } };
    }

    if (head === 'proposals' && second?.endsWith('.json') && resolved.segments.length === 2) {
      const inspected = history.proposals.inspect(decodeURIComponent(second.slice(0, -5)));

      if (inspected === null) throw absent(path);

      return { owner: resolved.stores.claims, writable: false, version: token(v.parse(JsonValueSchema, inspected.metadata)), modified: inspected.metadata.recorded_at,
        chunks: async function* () { yield `{"proposal":${JSON.stringify(inspected.metadata)},"entries":[`; yield* entryChunks(view, inspected.entries, false); yield ']}\n'; } };
    }

    if (head === 'requests' && second !== undefined && third !== undefined && resolved.segments.length === 3) {
      const match = /^(\d+)-(\d+)\.json$/u.exec(third);

      if (!match) throw absent(path);
      const turnId = decodeURIComponent(second);
      const request = history.requests.forTurn(turnId).find(row => row.epoch === Number(match[1]) && row.revision === Number(match[2]));

      if (request === undefined) throw absent(path);

      return { owner: resolved.stores.claims, writable: false, version: token([resolved.stores.claims.actorId, request.id]), modified: view.modified,
        chunks: async function* () {
          const metadata = await history.messages.payloads.read(request.metadata);
          const { messages, ...header } = request;
          yield `{"request":${JSON.stringify({ ...header, metadata })},"messages":[`;

          for (const [index, reference] of messages.entries()) yield `${index === 0 ? '' : ','}${JSON.stringify(await history.messages.projection(reference))}`;
          yield ']}\n';
        } };
    }

    if (head === undefined || head === 'agents' || (head === 'requests' && third === undefined) || (head === 'revisions' && second === undefined) || (head === 'proposals' && second === undefined)) throw makeVfsError('EISDIR', 'context path is a directory', path);
    throw absent(path);
  };

  const list = (path: string): string[] => {
    const resolved = target(path);
    const [head, second] = resolved.segments;
    const history = resolved.stores.claims.history;
    const selected = history.context.selected();

    if (head === undefined) return ['working.jsonl', 'claim.json', 'history.json', 'revisions', 'requests', 'proposals', ...(!resolved.child && (deps.children?.list().length ?? 0) > 0 ? ['agents'] : [])];

    if (head === 'agents' && second === undefined && !resolved.child) return [...(deps.children?.list() ?? [])];

    if (head === 'revisions' && second === undefined) return selected === null ? [] : history.context.revisions(selected.contextId).map(row => `${row.revision}.json`);

    if (head === 'proposals' && second === undefined) return selected === null ? [] : history.proposals.list(selected.contextId).map(row => `${encodeURIComponent(row.proposal_id)}.json`);

    if (head === 'requests' && second === undefined) return resolved.stores.claims.turns().map(row => encodeURIComponent(row.turnId));

    if (head === 'requests' && second !== undefined && resolved.segments.length === 2) {
      const rows = history.requests.forTurn(decodeURIComponent(second));

      if (rows.length === 0) throw absent(path);

      return rows.map(row => `${row.epoch}-${row.revision}.json`);
    }

    throw makeVfsError('ENOTDIR', 'context path is a file', path);
  };

  const write = async (path: string, data: string | Uint8Array, expected?: VfsRevision): Promise<{ ok: true; revision: VfsRevision } | { ok: false; revision: VfsRevision }> => {
    const resolved = target(path);

    if (resolved.segments.length !== 1 || resolved.segments[0] !== 'working.jsonl') throw readOnly(path);
    const current = working(resolved);
    const observed = expected === undefined ? current : atRevision(resolved, expected);
    const observedRevision = contextRevision(observed.header.version);

    const assertBase = () => {
      const latest = working(target(path));
      const latestRevision = contextRevision(latest.header.version);

      if (latest.header.contextId !== observed.header.contextId || latest.header.proposalId !== observed.header.proposalId || latest.header.turn !== observed.header.turn) {
        throw new FileRefusalError('stale', 'context selection or pending edit changed');
      }

      if (latestRevision[5] !== observedRevision[5] || latestRevision[6] !== observedRevision[6] || latestRevision[7] !== observedRevision[7]) {
        throw new FileRefusalError('stale', 'context execution ownership changed');
      }

      for (const [position, entry] of observed.entries.entries()) {
        const now = latest.entries[position];

        if (now?.entryId !== entry.entryId || now.messageId !== entry.messageId || now.sequence !== entry.sequence) {
          throw new FileRefusalError('stale', 'observed context content changed');
        }
      }
    };

    assertBase();
    const text = v.is(v.string(), data) ? data : new TextDecoder('utf-8', { fatal: true }).decode(data);
    const lines = text.split('\n').filter(line => line.trim() !== '');
    const firstLine = lines[0];

    if (firstLine === undefined) throw new KinuError('bad_input', 'working.jsonl requires its observed $context header');
    const header = v.parse(v.object({ $context: HeaderSchema }), JSON.parse(firstLine)).$context;

    if (header.actor !== resolved.stores.claims.actorId) throw new KinuError('denied', 'the context header names another actor');

    if (header.version !== observed.header.version || header.contextId !== observed.header.contextId || header.revision !== observed.header.revision || header.proposalId !== observed.header.proposalId) throw new FileRefusalError('stale', 'context changed; read working.jsonl again before editing');
    const entries = lines.slice(1).map(line => v.parse(EntrySchema, JSON.parse(line)));
    const visible = new Map(observed.entries.map(entry => [entry.entryId, entry]));
    const desired: Array<{ entryId: string; messageId: string; sequence: number | null; message: JsonObject; prepare: boolean }> = [];
    const seen = new Set<string>();
    const beforeViews = new Map<string, v.InferOutput<typeof PairingView>>();

    for (const entry of entries) {
      if ('new' in entry) {
        const id = crypto.randomUUID();
        desired.push({ entryId: id, messageId: id, sequence: null, message: entry.message, prepare: true });
        continue;
      }

      if (seen.has(entry.entryId)) throw new KinuError('bad_input', 'a working entry appears more than once');
      seen.add(entry.entryId);
      const previous = visible.get(entry.entryId);

      if (previous === undefined || previous.messageId !== entry.messageId || previous.sequence !== entry.cutoff) throw new FileRefusalError('stale', 'entry identity or cutoff differs from the observed context');
      const original = await resolved.stores.claims.history.messages.projection(previous);

      if ((original.role === 'assistant' || original.role === 'tool') && !v.is(v.string(), original.content)) beforeViews.set(entry.entryId, v.parse(PairingView, original));
      const changed = JSON.stringify(original) !== JSON.stringify(entry.message);
      desired.push({ entryId: entry.entryId, messageId: changed ? crypto.randomUUID() : entry.messageId, sequence: entry.cutoff, message: entry.message, prepare: changed });
    }

    const calls = new Map<string, { messageId: string; part: number }>();
    const prepared: PreparedMessage[] = [];

    for (const entry of desired) {
      if (entry.message.role === 'assistant' && !v.is(v.string(), entry.message.content)) {
        let parts: readonly { partNo: number; value: JsonObject }[];

        if (entry.prepare) parts = v.parse(v.array(JsonObjectSchema), entry.message.content).map((value, partNo) => ({ partNo, value }));
        else {
          if (entry.sequence === null) throw new KinuError('io', 'existing context message has no cutoff');
          parts = await resolved.stores.claims.history.messages.materializeParts({ messageId: entry.messageId, sequence: entry.sequence });
        }

        for (const part of parts) if (part.value.type === 'tool-call') calls.set(v.parse(v.string(), part.value.toolCallId), { messageId: entry.messageId, part: part.partNo });
      }

      if (entry.prepare) {
        const message = await resolved.stores.claims.history.messages.prepareProjection(entry.message, entry.messageId, calls);
        prepared.push(message);
        entry.sequence = message.updates.length - 1;
      }
    }

    for (const entry of observed.entries) if (!seen.has(entry.entryId)) {
      const original = await resolved.stores.claims.history.messages.projection(entry);

      if ((original.role === 'assistant' || original.role === 'tool') && !v.is(v.string(), original.content)) beforeViews.set(entry.entryId, v.parse(PairingView, original));
    }

    const afterViews = desired.filter(entry => (entry.message.role === 'assistant' || entry.message.role === 'tool') && !v.is(v.string(), entry.message.content)).map(entry => v.parse(PairingView, entry.message));

    const beforePairs = toolPairingGaps(observed.entries.flatMap(entry => { const view = beforeViews.get(entry.entryId);

 return view === undefined ? [] : [view]; }));

    const afterPairs = toolPairingGaps(afterViews);

    if ([...afterPairs.calls].some(id => !beforePairs.calls.has(id)) || [...afterPairs.results].some(id => !beforePairs.results.has(id))) throw new KinuError('bad_input', 'context edit severs a tool call/result pair');
    const history = resolved.stores.claims.history;

    const assertOwner = () => {
      const current = working(target(path));

      if (current.target.author !== resolved.author) throw new KinuError('denied', 'context edit authority changed');
      assertBase();
    };

    assertOwner();
    const selection = observed.selection;
    const base = selection === null ? [] : history.context.entries(selection);
    const baseById = new Map(base.map(entry => [entry.entryId, entry]));
    const wantedIds = new Set(desired.map(entry => entry.entryId));
    const changes: ContextChange[] = base.filter(entry => !wantedIds.has(entry.entryId)).map(entry => ({ entryId: entry.entryId, expected: entry, replacement: null }));

    for (const [position, entry] of desired.entries()) {
      const previous = baseById.get(entry.entryId);

      if (entry.sequence === null) throw new KinuError('io', 'context message was not prepared');

      if (previous !== undefined && previous.messageId === entry.messageId && previous.sequence === entry.sequence && previous.position === position) continue;
      changes.push({ entryId: entry.entryId, expected: previous ?? null, replacement: { messageId: entry.messageId, sequence: entry.sequence, position } });
    }

    const proposalId = crypto.randomUUID();
    history.stagePrepared({ id: proposalId, base: selection, expectedPending: observed.header.proposalId, author: resolved.author,
      via: resolved.child ? 'owner' : 'file', cause: 'edit', turnId: observed.header.turn, changes }, prepared, assertOwner, resolved.stores.events);

    return { ok: true, revision: working(target(path)).header.version };
  };

  const readDocumentRange = async (source: Document, offset: number, length: number): Promise<Uint8Array> => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > Number.MAX_SAFE_INTEGER - length) throw new KinuError('bad_input', 'range must use nonnegative safe byte offsets');

    if (length === 0) { source.owner.history.context.selected();

 return new Uint8Array(0); }

    const chunks: Uint8Array[] = [];
    let skipped = 0;
    let kept = 0;

    for await (const chunk of source.chunks()) {
      const bytes = encoder.encode(chunk);
      const end = skipped + bytes.byteLength;

      if (end > offset && kept < length) {
        const start = Math.max(0, offset - skipped);
        const take = Math.min(bytes.byteLength - start, length - kept);
        chunks.push(bytes.slice(start, start + take));
        kept += take;
      }

      skipped = end;

      if (kept === length) break;
    }

    const result = new Uint8Array(kept);
    let position = 0;

    for (const chunk of chunks) { result.set(chunk, position); position += chunk.byteLength; }

    source.owner.history.context.selected();

    return result;
  };

  const readRange = (path: string, offset: number, length: number): Promise<Uint8Array> => readDocumentRange(document(path), offset, length);

  const files: VFS & Pick<VfsNativeReads, 'readRange'> = {
    async readFile(path) { const source = document(path); let text = '';

 for await (const chunk of source.chunks()) text += chunk; source.owner.history.context.selected();

 return text; },
    async readFileAtRevision(path, revision, range) {
      const resolved = target(path);

      if (resolved.segments.length !== 1 || resolved.segments[0] !== 'working.jsonl') throw readOnly(path);
      const view = atRevision(resolved, revision);
      const source = workingDocument(view);

      if (range !== undefined) return readDocumentRange(source, range.offset, range.length);
      let text = '';

      for await (const chunk of source.chunks()) text += chunk;
      resolved.stores.claims.history.context.selected();

      return text;
    },
    readRange,
    async readdir(path) { return list(path); },
    async stat(path): Promise<VfsEntryStat | null> {
      try { list(path);

 return { isDir: true, size: 0, mtimeMs: 0 }; }
      catch (cause) { if ((isVfsError(cause) && cause.code === 'ENOENT')) return null;

 if ((!isVfsError(cause) || cause.code !== 'ENOTDIR')) throw cause; }

      try {
        const source = document(path);
        let size = 0;

        for await (const chunk of source.chunks()) size += encoder.encode(chunk).byteLength;
        source.owner.history.context.selected();
        const stat: VfsEntryStat = { isDir: false, size, mtimeMs: source.modified };

        return source.writable ? { ...stat, revision: source.version } : stat;
      } catch (cause) { if ((isVfsError(cause) && cause.code === 'ENOENT')) return null; throw cause; }
    },
    async exists(path) { try { list(path);

 return true; } catch (cause) { if ((isVfsError(cause) && cause.code === 'ENOENT')) return false;

 if ((!isVfsError(cause) || cause.code !== 'ENOTDIR')) throw cause; }

 try { document(path);

 return true; } catch (cause) { if ((isVfsError(cause) && cause.code === 'ENOENT')) return false; throw cause; } },
    async writeFile(path, data) { await write(path, data); },
    async writeFileIfRevision(path, data, expectedRevision) { return write(path, data, expectedRevision); },
    async unlink(path) { throw readOnly(path); },
    async mkdir(path) { throw readOnly(path); },
  };

  return files;
}

export function contextMount(deps: ContextMountDeps): VfsMount {
  const files = contextFiles(deps);

  return { name: 'context', files: () => files, absentReason: () => 'actor context is unavailable' };
}
