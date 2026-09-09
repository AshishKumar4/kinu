/**
 * `/context` — the actor's own working history and request evidence, as files.
 *
 * WHAT THIS IS. A projection of the two context ledgers
 * (`orchestrator/working-context.ts`, `orchestrator/actor-claims.ts`) onto the
 * file plane every surface already uses: the native `file` tool, codemode's
 * `workspace.readFile/writeFile/editFile`, and the owner's UI editor all reach
 * it through ONE dispatcher over ONE VFS (`tools/file-tool.ts`), so an edit
 * from a model and an edit from a person take the same path, hit the same
 * compare-and-set, and produce the same revision. There is no second writable
 * copy of context anywhere: the bytes below are rendered from the rows on every
 * read, and a write goes straight back into them.
 *
 * WHY A MOUNT. The mount table is the workspace plane's existing extension
 * point (`vfs/mounts.ts`): a reserved root name, routed on the first path
 * segment, absent-aware, and — like `/pc` and `/sandbox` — NOT visible to the
 * workspace shell, which runs on the Nimbus workspace tree and knows nothing of
 * mount points. Reusing it means no new addressing convention, no shadowing of
 * a real workspace file, and no second file plane to keep in step. The agent's
 * own home paths (`scaffold/agent.js`, `memory/`, `.kinu/agents/<key>/…`) keep
 * their meanings; a child's context lives under `/context/agents/<key>/`, which
 * is the same `agents/<storage-key>` segment the scaffold paths already use.
 *
 * WHAT IS WRITABLE. Exactly one path per actor: `working.jsonl`. Everything
 * else — the claim, the rendered requests, the revision history — is evidence,
 * and evidence that an ordinary context edit could rewrite would not be
 * evidence (spec §6.4). Writes elsewhere are `EACCES`, and there is no
 * `unlink`, `mkdir` or `rename`: a projection has no free-floating files to
 * create or remove, and pretending otherwise would invent state the store
 * cannot hold.
 *
 * THE LOOP SOURCE IS NOT HERE. `scaffold/agent.js[.vN]` is already the real,
 * versioned loop source with its own promotion boundary (`scaffold/surface.ts`,
 * `scaffold/shadow.ts`). Projecting a second copy of it under this mount would
 * create exactly the two-writable-copies problem this design forbids, so the
 * loop is read and edited where it already lives.
 */

import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import type { VFS, VfsEntryStat } from '../types/primitives';
import type { ContextEventRecorder } from '../orchestrator/context-plane';
import type { ActorClaimStore } from '../orchestrator/actor-claims';
import {
  createActorContextPlane, type ActorContextPlane, type ContextEditReceipt,
} from '../orchestrator/context-plane';
import type { WorkingRevisionContent } from '../orchestrator/working-context';
import { decodeModelMessages, encodeModelMessages } from '../prompting/message-codec';
import { KinuError } from '../obs/error';
import { FileRefusalError } from '../tools/file-edit';
import { isVfsError, makeVfsError } from './errno';
import type { VfsMount } from './mounts';

/** The reserved root this plane is served under. */
const CONTEXT_MOUNT_NAME = 'context';
const CONTEXT_MOUNT = `/${CONTEXT_MOUNT_NAME}`;

/** The one editable path, relative to the actor's context root. */
const WORKING_FILE = 'working.jsonl';

/**
 * The stores one actor's context is served from.
 *
 * Handle-bound, never id-bound: the claim store carries the actor's own
 * `ActorHandle`, so every statement re-validates the identity and a retired or
 * re-parented actor stops authorising writes. This is also what makes a
 * parent's edit of a child use "the same checks" (spec §6.3) rather than a
 * parallel code path — the parent acts through the CHILD's store.
 */
export interface ActorContextStores {
  readonly actorId: string;
  readonly claims: ActorClaimStore;
  /**
   * Where this actor's `context_edit` evidence goes.
   *
   * The narrow port rather than the whole recorder: this plane emits ONE
   * variant, and saying so is what lets a caller hand it the real
   * `RunEventRecorder` (which satisfies the port) without this module
   * depending on every event the recorder knows.
   */
  readonly events: ContextEventRecorder | null;
}

/**
 * The children an actor may manage, as the HOST resolves them.
 *
 * Authority lives here, in the host's actor directory — never in a path
 * segment and never in the file header. The plane asks for a storage key and
 * gets either the child's own stores or null; a sibling, an unrelated actor or
 * a retired child is null, which the plane reports as an absent path. Nothing
 * a caller writes can widen this: the header's actor field is CHECKED against
 * the resolved actor, and a mismatch is refused.
 */
export interface ChildContextResolver {
  list(): readonly string[];
  resolve(storageKey: string): ActorContextStores | null;
}

export interface ContextMountDeps {
  /** Read live at every call: a plane outlives one turn, and a mount must not
   *  capture a store bound to an identity that has since been retired. */
  readonly stores: () => ActorContextStores;
  readonly children?: ChildContextResolver | null;
}

/** The header line of `working.jsonl`: what the read observed, in the words the
 *  write must send back. */
export interface ContextFileHeader {
  readonly actor: string;
  readonly revision: number;
  readonly messages: number;
  /**
   * The three fields below are what a READ tells the editor, and they are
   * optional because a WRITE is not required to echo them: only `actor` and
   * `revision` decide anything, and inventing values for the rest on the way
   * back in would report a state nobody observed.
   */
  readonly status?: 'active' | 'staged' | 'empty';
  readonly effectiveAt?: 'step' | 'turn';
  readonly turn?: string | null;
  /** Why a pending edit has not landed yet, when one is pending and blocked. */
  readonly blocked?: string;
}

/** The header under construction — the same contract, writable, so an absent
 *  field is simply never assigned rather than spread in as an empty object. */
type MutableContextFileHeader = { -readonly [K in keyof ContextFileHeader]: ContextFileHeader[K] };

const StatusSchema = v.picklist(['active', 'staged', 'empty']);
const EffectSchema = v.picklist(['step', 'turn']);
const HeaderSchema = v.object({
  $context: v.object({
    actor: v.pipe(v.string(), v.nonEmpty()),
    revision: v.pipe(v.number(), v.integer(), v.minValue(0)),
    messages: v.optional(v.number()),
    status: v.optional(StatusSchema),
    effectiveAt: v.optional(EffectSchema),
    turn: v.optional(v.nullable(v.string())),
    blocked: v.optional(v.string()),
  }),
});

/**
 * `working.jsonl` as text: a header line naming the revision this content IS,
 * then one codec-encoded message per line.
 *
 * JSONL rather than one JSON document because an edit is a text edit: the
 * `file` tool's `edit` action matches literal text, and a per-line encoding
 * lets a model replace one message without re-emitting the whole array. The
 * encoding is the durable codec's, so a tool call, a tool result or an image
 * attachment survives read-edit-write byte-for-byte instead of degrading into
 * prose that would not parse back.
 */
function encodeWorkingFile(header: ContextFileHeader, messages: readonly ModelMessage[]): string {
  const encoded = v.parse(v.array(v.unknown()), JSON.parse(encodeModelMessages(messages)));
  const lines = [JSON.stringify({ $context: header }), ...encoded.map((message) => JSON.stringify(message))];
  return `${lines.join('\n')}\n`;
}

/** `working.jsonl` as a caller reads it back: the header the writer observed,
 *  and the array it carried. */
export interface ObservedWorkingFile {
  readonly header: ContextFileHeader;
  readonly messages: ModelMessage[];
}

/** The inverse. Every refusal here is `bad_input`: the writer sent something
 *  this file cannot be, and naming which line is what lets it fix it. */
function decodeWorkingFile(text: string): ObservedWorkingFile {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const first = lines[0];
  if (first === undefined) {
    throw new KinuError('bad_input',
      `${WORKING_FILE} must begin with its {"$context":{…}} header line — the revision an edit is written against `
      + 'is in that line, and without it the write has nothing to compare against');
  }
  let parsedHeader: unknown;
  try {
    parsedHeader = JSON.parse(first);
  } catch (error) {
    throw new KinuError('bad_input',
      `line 1 of ${WORKING_FILE} is not JSON, so it cannot be the $context header`, { cause: error });
  }
  const header = v.safeParse(HeaderSchema, parsedHeader);
  if (!header.success) {
    throw new KinuError('bad_input',
      `line 1 of ${WORKING_FILE} is not the $context header: it needs {"$context":{"actor":"…","revision":N}}`);
  }
  const messages = decodeModelMessages(`[${lines.slice(1).join(',')}]`);
  const observed = header.output.$context;
  // Passed through, never filled in: what the writer sent back is what this
  // says it observed.
  const decoded: MutableContextFileHeader = {
    actor: observed.actor,
    revision: observed.revision,
    messages: observed.messages ?? messages.length,
  };
  if (observed.status !== undefined) decoded.status = observed.status;
  if (observed.effectiveAt !== undefined) decoded.effectiveAt = observed.effectiveAt;
  if (observed.turn !== undefined) decoded.turn = observed.turn;
  if (observed.blocked !== undefined) decoded.blocked = observed.blocked;
  return { header: decoded, messages };
}

/** The header a read serves, from the plane's own state. */
function headerOf(state: {
  readonly actorId: string;
  readonly head: WorkingRevisionContent | null;
  readonly staged: WorkingRevisionContent | null;
  readonly liveTurnId: string | null;
  readonly effectiveAt: 'step' | 'turn';
}): ContextFileHeader {
  const head = state.head;
  const header: ContextFileHeader = {
    actor: state.actorId,
    revision: head?.revision ?? 0,
    messages: head?.messageCount ?? 0,
    status: head === null ? 'empty' : head.status === 'staged' ? 'staged' : 'active',
    effectiveAt: state.effectiveAt,
    turn: state.liveTurnId,
  };
  const blocked = state.staged?.deferredReason ?? null;
  return blocked === null ? header : { ...header, blocked };
}

/** What a revision looks like as a file: metadata, then its array. */
function revisionDocument(revision: WorkingRevisionContent): string {
  return `${JSON.stringify({
    revision: revision.revision,
    baseRevision: revision.baseRevision,
    baseMessageCount: revision.baseMessageCount,
    source: revision.source,
    status: revision.status,
    via: revision.via,
    author: revision.author,
    digest: revision.digest,
    messageCount: revision.messageCount,
    turnId: revision.turnId,
    activatedTurnId: revision.activatedTurnId,
    activatedStep: revision.activatedStep,
    activatedAt: revision.activatedAt,
    deferredReason: revision.deferredReason,
    closedReason: revision.closedReason,
    recordedAt: revision.recordedAt,
    messages: JSON.parse(encodeModelMessages(revision.messages)),
  }, null, 2)}\n`;
}

/** Where a path inside the mount points. */
type ContextRoute =
  | { readonly kind: 'root' }
  | { readonly kind: 'working' }
  | { readonly kind: 'claim' }
  | { readonly kind: 'history' }
  | { readonly kind: 'revisions' }
  | { readonly kind: 'revision'; readonly revision: number }
  | { readonly kind: 'requests' }
  | { readonly kind: 'turn'; readonly turnId: string }
  | { readonly kind: 'request'; readonly turnId: string; readonly revision: number }
  | { readonly kind: 'agents' }
  | { readonly kind: 'child'; readonly storageKey: string; readonly rest: string };

const NUMBERED = /^(\d+)\.json$/;

function routeOf(path: string): ContextRoute | null {
  const segments = path.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.some((segment) => segment === '..')) return null;
  const [head, second, third] = segments;
  if (head === undefined) return { kind: 'root' };
  if (segments.length === 1) {
    if (head === WORKING_FILE) return { kind: 'working' };
    if (head === 'claim.json') return { kind: 'claim' };
    if (head === 'history.json') return { kind: 'history' };
    if (head === 'revisions') return { kind: 'revisions' };
    if (head === 'requests') return { kind: 'requests' };
    if (head === 'agents') return { kind: 'agents' };
    return null;
  }
  if (head === 'revisions' && segments.length === 2 && second !== undefined) {
    const matched = NUMBERED.exec(second);
    return matched?.[1] === undefined ? null : { kind: 'revision', revision: Number(matched[1]) };
  }
  if (head === 'requests' && second !== undefined) {
    if (segments.length === 2) return { kind: 'turn', turnId: second };
    if (segments.length === 3 && third !== undefined) {
      const matched = NUMBERED.exec(third);
      return matched?.[1] === undefined
        ? null
        : { kind: 'request', turnId: second, revision: Number(matched[1]) };
    }
    return null;
  }
  if (head === 'agents' && second !== undefined) {
    return { kind: 'child', storageKey: second, rest: segments.slice(2).join('/') };
  }
  return null;
}

const DIRECTORY: VfsEntryStat = { size: 0, mtimeMs: 0, isDir: true };

function absent(path: string): Error {
  return makeVfsError('ENOENT', 'no such path under the context plane', path);
}

function readOnly(path: string): Error {
  return makeVfsError('EACCES',
    `${path} is context evidence and is not writable — the working history is the one editable path `
    + `(${CONTEXT_MOUNT}/${WORKING_FILE})`, path);
}

/**
 * What a path resolved to: the actor whose context it names, that actor's
 * plane, the route inside its tree, and the actor doing the writing.
 *
 * `stores.actorId` and `author` differ exactly when a parent is managing a
 * child: the target is the child's own handle-bound store, and the author is
 * the actor that actually wrote — which is what the revision row and the run
 * event record.
 */
interface ContextTarget {
  readonly stores: ActorContextStores;
  readonly plane: ActorContextPlane;
  readonly route: ContextRoute;
  readonly author: string;
}


/**
 * One actor's context plane, plus the planes of the children it may manage.
 *
 * `writeFileIfRevision` is declared, so the owner's UI editor gets a real
 * compare-and-write instead of the read-only refusal the read model shows for
 * planes that cannot protect an in-place save. It maps onto the same
 * compare-and-set the header does: `expectedRevision` IS the working revision.
 */
function createContextPlane(deps: ContextMountDeps): VFS {
  const planes = new Map<string, ActorContextPlane>();
  const planeFor = (stores: ActorContextStores): ActorContextPlane => {
    const existing = planes.get(stores.actorId);
    if (existing !== undefined) return existing;
    const created = createActorContextPlane({ claims: stores.claims, events: stores.events });
    planes.set(stores.actorId, created);
    return created;
  };

  /** Resolve a path to the actor whose context it names, and the route inside
   *  that actor's own tree. A child's subtree is the SAME routes over the
   *  child's own stores — one implementation, one set of checks. */
  const target = (path: string): ContextTarget => {
    const own = deps.stores();
    const route = routeOf(path);
    if (route === null) throw absent(path);
    const resolver = deps.children ?? null;
    if (route.kind === 'agents' || route.kind === 'child') {
      // An actor with no managed children has no `agents` tree at all, rather
      // than an empty directory that would read as "no children right now".
      if (resolver === null) throw absent(path);
    }
    if (route.kind !== 'child') {
      return { stores: own, plane: planeFor(own), route, author: own.actorId };
    }
    const child = resolver?.resolve(route.storageKey) ?? null;
    if (child === null) throw absent(path);
    const inner = routeOf(route.rest);
    if (inner === null || inner.kind === 'child') throw absent(path);
    // The AUTHOR of a child edit is this actor, and the target is the child's
    // own store: authority came from the resolver, the recorded author is the
    // actor that actually wrote, and neither is taken from the path.
    return { stores: child, plane: planeFor(child), route: inner, author: own.actorId };
  };

  const requestNames = (stores: ActorContextStores, turnId: string): string[] =>
    stores.claims.revisions(turnId).map((revision) => `${revision.revision}.json`);

  const readRoute = async (path: string): Promise<string> => {
    const { stores, plane, route } = target(path);
    switch (route.kind) {
      case 'working': {
        const state = plane.read();
        return encodeWorkingFile(headerOf(state), state.head?.messages ?? []);
      }
      case 'claim': {
        const state = plane.read();
        const latest = stores.claims.latestTurn();
        return `${JSON.stringify({
          actor: stores.actorId,
          turn: latest,
          liveTurnId: state.liveTurnId,
          workingRevision: state.active?.revision ?? null,
          headRevision: state.head?.revision ?? 0,
          stagedRevision: state.staged?.revision ?? null,
          stagedBlockedBy: state.staged?.deferredReason ?? null,
          editsTakeEffect: state.effectiveAt,
        }, null, 2)}\n`;
      }
      case 'history':
        return `${JSON.stringify(stores.claims.working.history(), null, 2)}\n`;
      case 'revision': {
        const revision = stores.claims.working.revision(route.revision);
        if (revision === null) throw absent(path);
        return revisionDocument(revision);
      }
      case 'request': {
        const consumed = stores.claims.consumedContext(route.turnId, route.revision);
        if (consumed === null) throw absent(path);
        return `${JSON.stringify({
          turnId: route.turnId,
          revision: consumed.revision,
          epoch: consumed.epoch,
          stepIndex: consumed.stepIndex,
          workingRevision: consumed.workingRevision,
          digest: consumed.digest,
          messageCount: consumed.messageCount,
          request: JSON.parse(encodeModelMessages(consumed.messages)),
        }, null, 2)}\n`;
      }
      default:
        throw makeVfsError('EISDIR', 'this context path is a directory', path);
    }
  };

  const listRoute = async (path: string): Promise<string[]> => {
    const { stores, route } = target(path);
    switch (route.kind) {
      case 'root': {
        const entries = [WORKING_FILE, 'claim.json', 'history.json', 'revisions', 'requests'];
        return (deps.children?.list().length ?? 0) > 0 ? [...entries, 'agents'] : entries;
      }
      case 'revisions':
        return stores.claims.working.history().map((revision) => `${revision.revision}.json`);
      case 'requests':
        return stores.claims.turns().map((claim) => claim.turnId);
      case 'turn': {
        const entries = requestNames(stores, route.turnId);
        if (entries.length === 0) throw absent(path);
        return [...entries];
      }
      case 'agents':
        return [...(deps.children?.list() ?? [])];
      default:
        throw makeVfsError('ENOTDIR', 'this context path is a file', path);
    }
  };

  /** `mtimeMs` per route: the moment the row it projects was recorded, never a
   *  wall clock read at stat time — a projection whose mtime moves on its own
   *  would make every reader's cached read look stale. */
  const modifiedAt = (resolved: ContextTarget): number => {
    const { stores, plane, route } = resolved;
    switch (route.kind) {
      case 'working':
        return plane.read().head?.recordedAt ?? 0;
      case 'revision':
        return stores.claims.working.revision(route.revision)?.recordedAt ?? 0;
      case 'request':
        return stores.claims.revisions(route.turnId)
          .find((row) => row.revision === route.revision)?.recordedAt ?? 0;
      default:
        return stores.claims.latestTurn()?.claimedAt ?? 0;
    }
  };

  const statRoute = async (path: string): Promise<VfsEntryStat | null> => {
    let resolved: ContextTarget;
    try {
      resolved = target(path);
    } catch (err) {
      // ONLY absence becomes null, because null is `stat`'s word for absent.
      // Anything else — a retired handle refusing at `assertCurrent`, a decode
      // failure — is a real failure and must not read as "no such path".
      if (isVfsError(err) && err.code === 'ENOENT') return null;
      throw err;
    }
    const { stores, plane, route } = resolved;
    switch (route.kind) {
      case 'root': case 'revisions': case 'requests': case 'agents':
        return DIRECTORY;
      case 'turn':
        return requestNames(stores, route.turnId).length === 0 ? null : DIRECTORY;
      case 'working': {
        const state = plane.read();
        const text = encodeWorkingFile(headerOf(state), state.head?.messages ?? []);
        return {
          size: text.length,
          mtimeMs: state.head?.recordedAt ?? 0,
          isDir: false,
          // The authoritative revision, which is what makes a conditional write
          // possible for the UI editor: not a size or an mtime, which two
          // different edits can share.
          revision: state.head?.revision ?? 0,
        };
      }
      default: {
        // Same rule as above: an absent revision or request is null, and every
        // other failure propagates rather than being flattened into absence.
        try {
          const text = await readRoute(path);
          return { size: text.length, mtimeMs: modifiedAt(resolved), isDir: false };
        } catch (err) {
          if (isVfsError(err) && err.code === 'ENOENT') return null;
          throw err;
        }
      }
    }
  };

  /**
   * The one write.
   *
   * Order matters and is the spec's own checklist (§6.3): the array is decoded
   * and schema-validated by the codec, the header's actor must be the actor
   * whose plane this is, the observed revision must still be current, and only
   * then is a revision staged. A stale write is refused with the word the file
   * ledger already uses for it — `stale` — and leaves the active version
   * untouched.
   */
  const write = async (path: string, data: string | Uint8Array, expected?: number): Promise<ContextEditReceipt> => {
    const { stores, plane, route, author } = target(path);
    if (route.kind !== 'working') throw readOnly(path);
    const asText = v.safeParse(v.string(), data);
    const text = asText.success ? asText.output : new TextDecoder().decode(v.parse(v.instance(Uint8Array), data));
    const decoded = decodeWorkingFile(text);
    const state = plane.read();
    if (decoded.header.actor !== stores.actorId) {
      // The header names a different actor. Refused rather than retargeted: a
      // caller-supplied id is not authority, and writing this array into
      // whatever actor the path resolved to would be the opposite of what the
      // writer asked for.
      throw makeVfsError('EACCES',
        `this working history is addressed to actor ${decoded.header.actor}, and ${path} is actor `
        + `${stores.actorId}'s context`, path);
    }
    const observed = expected ?? decoded.header.revision;
    const current = state.head?.revision ?? 0;
    if (observed !== current) {
      throw new FileRefusalError('stale',
        `${path} moved on: you wrote against working revision ${observed}, and revision ${current} is current. `
        + 'Read it again and re-apply your change, so you can see the progress you would otherwise replace.');
    }
    return plane.edit({
      base: current,
      messages: decoded.messages,
      author,
      via: author === stores.actorId ? 'file' : 'owner',
    });
  };

  return {
    async readFile(path, opts) {
      const text = await readRoute(path);
      return opts?.encoding === undefined ? new TextEncoder().encode(text) : text;
    },
    async writeFile(path, data) {
      await write(path, data);
    },
    async writeFileIfRevision(path, data, expectedRevision) {
      const receipt = await write(path, data, expectedRevision);
      return { ok: true, revision: receipt.revision };
    },
    readdir: listRoute,
    stat: statRoute,
    async exists(path) {
      return (await statRoute(path)) !== null;
    },
    async unlink(path) {
      throw readOnly(path);
    },
    async mkdir(path, opts) {
      // The one write path in the file surface calls `ensureDir` on the parent
      // before it writes (`tools/file-tool.ts`), so a directory that already
      // exists must answer success under `recursive` — otherwise every write
      // through the native `file` tool fails on its own preflight. Creating a
      // directory that does NOT exist stays refused: this plane's shape follows
      // the revision ledger and has no free-floating directories.
      const existing = await statRoute(path);
      if (existing?.isDir === true && opts?.recursive === true) return;
      throw makeVfsError('EACCES',
        'the context plane has no directories to create — its shape follows the revision ledger', path);
    },
  };
}

/**
 * The mount entry both backends compose next to `standardMounts`.
 *
 * Always live: unlike a device or a container, an actor's own context is never
 * absent — a fresh actor has revision 0 and an empty working history, which is
 * an answer rather than an outage. `absentReason` therefore states the one
 * thing that could make it unreachable at all.
 */
export function contextMount(deps: ContextMountDeps): VfsMount {
  const files = createContextPlane(deps);
  return {
    name: CONTEXT_MOUNT_NAME,
    files: () => files,
    absentReason: () => 'this actor has no context store bound',
  };
}
