/**
 * Strategy one: an immutable base plus one cumulative delta, both squashfs
 * archives in an object store, attached as lazy FUSE layers.
 *
 * The shape and why it is this shape:
 *
 *   The first checkpoint archives the whole work directory as the BASE. It is
 *   written once and never rewritten. Every later checkpoint archives the
 *   overlay's upper directory — exactly the changed set, whiteouts included —
 *   into a single DELTA object that each checkpoint replaces atomically. So the
 *   chain is always at most two layers deep, no matter how many checkpoints
 *   have happened, and an attach mounts a fixed number of layers rather than a
 *   growing number.
 *
 *   An attach moves NO bytes in production, the delta included. The store's own
 *   subtree for this chain is mounted read-only, `squashfuse` mounts the base
 *   and the delta straight out of it, and `fuse-overlayfs` lays a fresh writable
 *   upper over BOTH: `lowerdir=<delta>:<base>`, newest first. Bytes arrive when
 *   something reads them. That is what makes an attach fit inside the
 *   container-start budget for a work directory of any size.
 *
 *   THE DELTA USED TO BE COPIED INTO THAT UPPER, and the copy was the one step
 *   that moved every byte this file claims not to move: it reads the whole
 *   cumulative changed set through squashfuse over the mounted store, on the
 *   attach path, against the container-start budget. Measured on the deployed
 *   benchmark at the size a ladder leaves behind, it did not finish inside a
 *   300 s budget. A stacked lower serves the same content in mount time, and it
 *   is equivalent rather than merely similar: a delta's deletions travel as
 *   `0/0` character devices and its emptied directories as an opaque xattr, and
 *   fuse-overlayfs honours both in ANY layer rather than only in the upper — a
 *   name whited out in the delta is gone from the merged view whatever the base
 *   still holds.
 *
 *   WHAT THE COMPOSITION COSTS, STATED RATHER THAN HIDDEN. While a delta is
 *   served as a layer the upper holds only what was written since the attach, so
 *   it is NOT the cumulative changed set and a delta commit may not archive it:
 *   that would publish a changed set missing everything the layer holds, over
 *   the one key the next attach reads. So the first commit with something to say
 *   COLLAPSES the chain onto a fresh base instead — the merged view is the one
 *   tree that expresses what is spread across two layers, and archiving it is an
 *   operation this file already performs. The record then names no delta, the
 *   upper accumulates against the new base, and delta commits resume. Whether a
 *   delta is being served as a layer is asked of `/proc/mounts`: the layer is
 *   mounted at a path named after its own generation, so the answer is the
 *   container's own fact rather than a note about one.
 *
 *   THE SAME-INSTANCE PATH IS UNCHANGED, and it is still the cheapest one. A
 *   stop does not necessarily take the container with it; when the same instance
 *   comes back, its upper already holds exactly what the last publication
 *   archived, the seed stamp proves it, and the attach mounts the base alone
 *   over the upper it kept.
 *
 * ORDERING UNDER CRASH. Two rules, both load-bearing:
 *
 *   1. The delta object is replaced by an atomic PUT, so a reader sees the old
 *      delta or the new one, never a mixture.
 *   2. The state record is written BEFORE any cleanup. A crash between the PUT
 *      and the state write leaves a complete delta the record does not yet
 *      mention, and an attach adopts it: the PUT was all-or-nothing and
 *      squashfs verifies its own superblock, so the mount is the validator. A
 *      crash the other way round — cleanup first — could delete the only copy.
 *
 * TWO GENERATIONS, TWO ROLES, so a restore is never down to one hope.
 *
 *   A rebase writes a whole new generation, and the outgoing one used to be
 *   deleted by the same commit's sweep. From that moment the box held exactly
 *   one copy of itself, so a base object that went missing — or came back at a
 *   size the record does not describe — made every later attach refuse forever
 *   with nothing left to try, and the answer on offer was "discard this box's
 *   stored state to start fresh", which is the whole workspace.
 *
 *   The record therefore names a second generation: `fallback`, the newest one
 *   an attach has PROVEN it can serve. It is retained until a NEWER generation
 *   has passed that same proof. That is what bounds the count without anyone
 *   choosing a number — current and fallback are the two roles a restore has,
 *   so the record names two generations and never a third.
 *
 *   A restore reads them newest-first, verifies a candidate before serving it,
 *   stamps the candidate it refused on the record's own failure field, and
 *   publishes which generation recovered. It never serves half of one.
 *
 * EXTRACTION IS LOCAL DEVELOPMENT ONLY, and it is stated rather than hidden.
 * A store mount needs container outbound interception, which does not exist
 * under a plain local `wrangler dev`. With no mount there is no lazy layer, so
 * the local path archives and extracts whole trees: it costs a full pass over
 * every byte on every attach, it does not scale, and it exists so that
 * development works at all. A chain that already HAS a base never degrades to
 * extraction — that would hand the caller an empty directory and call it a
 * success. Only a workspace with no base yet may fall back, once, with the
 * reason recorded.
 */

import type { BackupOptions, DirectoryBackup } from '@cloudflare/sandbox';
import * as v from 'valibot';

import { describeThrown as describe, findMount } from './lifecycle';
import {
  DEVBOX_RUNTIME_DIR,
  DEVBOX_WORKDIR,
  type AttachOutcome,
  type CheckpointKind,
  type CheckpointOutcome,
  type DevboxStorage,
  type StoredValue,
  recordCheckpointFailure,
  stampFailure,
} from './storage';

/**
 * Where this chain's own object-store subtree is mounted READ-ONLY inside the
 * container during an attach. Scoped to exactly this chain's UUID prefix, so
 * the container can see its own layers and nothing else.
 *
 * Read-only is defence rather than decoration: an attach runs `rm -rf` over its
 * own layout beside this path, and a read-write mount here would put the
 * chain's archives inside that blast radius. Publication mounts a SEPARATE
 * path — {@link CHAIN_PUBLISH_MOUNT} — for exactly that reason.
 *
 * PRIVATE, like every other path in this file's layout. The host is handed the
 * mount point it must use as an argument, so nothing outside this module has to
 * know or agree about where a chain's bytes appear; the suites that assert
 * these paths mirror them and fail on drift, which is what keeps the mirror
 * honest.
 */
const CHAIN_STORE_MOUNT = '/backups';

/**
 * Where this chain's subtree is mounted WRITABLE while one archive is
 * published, and the reason no payload byte reaches the Durable Object.
 *
 * THE MOUNT IS THE BYTE PATH. A staged archive used to leave the container as
 * base64 SSE frames, cross the owning isolate, and go back out to the store
 * through the Workers R2 binding — the archive's whole length twice through the
 * one thread every other operation on this box is queued behind. Measured on a
 * live container against a real store: 3.34 MiB/s at 64 MiB and 3.64 at 256 MiB
 * through the isolate, against 23.22 and 39.00 MiB/s for the same bytes moved
 * by the container itself. The relay was the only arm that got SLOWER as the
 * archive grew, which is what says the cost is the isolate rather than a
 * constant overhead being amortised.
 *
 * WHAT THE CONTAINER GAINS, IT GAINS WITHOUT A SECRET. This is the SDK's
 * credential-less R2 mount: s3fs is handed a dummy password file, its requests
 * are intercepted at `r2.internal`, and a Worker entrypoint — not this object —
 * resolves the binding and performs the R2 call. The authority stays where it
 * already was, and the container is handed nothing it could read, replay, or
 * point elsewhere. That is the property a presigned URL would have cost, and
 * the measurement says it costs no throughput to keep.
 *
 * A SEPARATE PATH, and never mounted while the read mount is: the SDK refuses
 * one binding mounted twice under different access, and the read path's `rm -rf`
 * protections assume nothing can be written through it. Two paths make both
 * statements structural rather than remembered.
 */
const CHAIN_PUBLISH_MOUNT = `${DEVBOX_RUNTIME_DIR}/publish`;

class ContainerChangedDuringAttach extends Error {
  constructor() {
    super('the container generation changed while snapshot-chain attached its lower layers');
    this.name = 'ContainerChangedDuringAttach';
  }
}

/**
 * One of a generation's OWN archives would not mount, or would not read.
 *
 * TYPED, because the caller has a decision to make: this generation cannot be
 * served, and the record may still name an older one that can. Every other
 * attach failure — a host with no FUSE, a store subtree that will not mount, a
 * container replaced mid-attach — says nothing about any generation's bytes, so
 * it must never cost the record a promotion or send the box down the recovery
 * path to fail there a second time.
 */
class LayerUnreadable extends Error {
  constructor(layer: string, generation: string, thrown: { readonly cause: unknown }) {
    super(`the ${layer} layer of generation ${generation} could not be read`, {
      cause: thrown.cause,
    });
    this.name = 'LayerUnreadable';
  }
}

/**
 * Archive lifetime for the EXTRACTION path, and nowhere else.
 *
 * The SDK's own backup API writes that archive and enforces this at restore
 * time, so the number has a reader. The chain path has none, and must not
 * acquire one: NEVER put a lifecycle rule on the chain's prefix. A rule deletes
 * by age since upload, the base is written once and never rewritten, and an
 * actively-used box would therefore lose its base on the rule's birthday and
 * refuse every attach afterwards with "archive object is missing". Chain
 * objects are reclaimed by the box's own `discard`, which is called when the
 * workspace is deleted; a box whose Durable Object is destroyed without that
 * call leaks its objects, and no sweep exists for that today.
 */
export const EXTRACT_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Regenerable trees never travel.
 *
 * They are reproducible from a lockfile or a build, they dominate the byte
 * count, and every byte here is paid twice: once on upload and again on every
 * attach that reads it. LOCKFILES ARE NEVER EXCLUDED — they are what makes the
 * excluded trees regenerable, so `bun.lock`, `package-lock.json`,
 * `uv.lock`, `Cargo.lock` and their siblings are ordinary files that travel
 * with the base. The contract this creates with the agent is stated in the
 * sandbox tool doctrine: a restored workspace may need one `bun install`
 * before its dependencies are back.
 *
 * GIT METADATA IS NOT REGENERABLE, and `.git` used to be on this list. It
 * holds the only copy of every commit that was never pushed, plus the index,
 * the config, the hooks, the reflog and the refs; for a linked worktree, the
 * top-level `.git` is a FILE whose one line is what makes the tree a
 * repository at all. None of it is reproducible from a lockfile or a build,
 * which is the only test this list applies, so no part of it is excluded —
 * not `objects`, not `refs`, not `index`, not `logs`, not `hooks`.
 *
 * The loss was measured rather than argued. `mksquashfs -e '.git'` dropped a
 * top-level `.git` whether it was the repository's directory or a worktree's
 * pointer file, so an agent that committed without pushing restored a tree
 * with the work in it and no history to explain it — and, for a worktree, a
 * tree that `git` no longer recognised as a repository.
 *
 * A box may replace this list — see `SnapshotChainPorts.archiveExcludes` — so a
 * workspace whose `target/` really is the work can keep it.
 *
 * Applied to whole-tree bases only: a changed set holds no derived tree that
 * was not written after the base.
 *
 * The patterns mean the same thing in both modes; see
 * {@link archiveExcludeFile} for what they match and how that is arranged.
 */
export const CHAIN_EXCLUDES = [
  'node_modules', '*.log', '.cache',
  '.bun', '__pycache__', '.venv', 'target', '.next', '.turbo', 'dist',
] as const;

/**
 * One pattern, as mksquashfs and the SDK both read it, or null when it means
 * nothing.
 *
 * THE SDK'S OWN NORMALISATION, on purpose and to the letter: the extraction
 * path hands these patterns to `@cloudflare/sandbox`, whose `BackupService`
 * strips a leading globstar segment, collapses an interior one, drops a
 * trailing one, and refuses a pattern that is empty or globstar alone — the
 * four rules the code below spells out. A chain-mode archive that normalised
 * differently would exclude a different set of files from the same policy, and
 * a box would then hold two different ideas of its own workspace depending on
 * which mode wrote the layer.
 */
export function normalizeArchiveExclude(pattern: string): string | null {
  let normalized = pattern;
  while (normalized.startsWith('**/')) normalized = normalized.slice(3);
  while (normalized.includes('/**/')) normalized = normalized.replaceAll('/**/', '/');
  if (normalized.endsWith('/**')) normalized = normalized.slice(0, -3);
  if (normalized === '' || normalized === '**') return null;
  return normalized;
}

/**
 * The exclude policy as an exclude FILE, which is the only form that says what
 * this policy means.
 *
 * TWO LINES PER PATTERN, and both are load-bearing. mksquashfs anchors an
 * exclude to the source directory unless the line is prefixed with `... `, so
 * one line alone can only ever mean "at the top level". Measured on the real
 * archiver: with anchored lines only, `node_modules` dropped
 * `<source>/node_modules` and KEPT `<source>/sub/deep/node_modules`, and
 * `*.log` matched nothing at all without `-wildcards`. With both lines and
 * `-wildcards`, every depth goes — which is what a policy about regenerable
 * trees has always claimed to mean, and what the SDK's own path already did.
 *
 * A FILE RATHER THAN ARGUMENTS. Patterns are data: they are written to a file
 * as base64 and decoded container-side, so no glob, quote or space in a
 * caller's pattern can ever reach a shell as syntax. See {@link archiveCommand}.
 */
export function archiveExcludeFile(patterns: readonly string[]): string {
  const lines: string[] = [];
  for (const pattern of patterns) {
    const normalized = normalizeArchiveExclude(pattern);
    if (normalized === null) continue;
    lines.push(normalized, `... ${normalized}`);
  }
  return lines.map(line => `${line}\n`).join('');
}

/**
 * Rebase when the delta has outgrown the base by this factor.
 *
 * DERIVED, NOT MEASURED, and the derivation is the whole justification: a
 * checkpoint uploads the WHOLE cumulative delta every time, so once the delta
 * exceeds the base, every future checkpoint is moving more bytes than a fresh
 * full base would cost. One is therefore the break-even point, and anything
 * above it means the chain is paying to stay in a shape that is more expensive
 * than starting over. No production measurement of delta growth exists yet; if
 * one lands and disagrees, this is the one number to move.
 */
export const REBASE_DELTA_RATIO = 1;

/**
 * Should this checkpoint collapse the chain onto a fresh base?
 *
 * ONLY AT A QUIESCE, and that restriction is the design rather than caution. A
 * rebase replaces the base with an archive of the merged view, which only pays
 * for itself if the upper is then empty — and emptying a live upper races every
 * writer in the container, which is how a pivot loses the seconds of work it
 * was archiving. At a quiesce there are no writers: the box is stopping, and
 * the next attach mounts the new base under a fresh upper anyway. Every box
 * reaches a quiesce, so the collapse is reliable without ever being destructive.
 *
 * A tick therefore keeps appending to the delta however large it grows; the
 * cost of that is bounded by the next stop.
 */
export function shouldRebase(state: ChainState | null, kind: CheckpointKind): boolean {
  if (kind !== 'quiesce' || state === null || state.mode !== 'chain') return false;
  if (state.delta === undefined) return false;
  return state.delta.bytes > REBASE_DELTA_RATIO * state.base.bytes;
}

/**
 * The two generation roles, after a publication supersedes the one the record
 * names.
 *
 * ONE POLICY, ONE PLACE, AND NO NUMBER IN IT. A record retains exactly one
 * older generation because a restore has exactly two roles for one: the
 * generation it serves, and the generation it falls back to.
 *
 *   - An empty slot means an attach has PROVEN the current generation — see
 *     {@link ChainState.fallback} — so the outgoing generation is the newest
 *     proven one, and it takes the slot.
 *   - A full slot means the outgoing generation was never proven. The proven
 *     occupant stays and the unproven outgoing generation becomes an orphan,
 *     which loses no work: the publication superseding it archives the same
 *     live work directory, so nothing still in the workspace goes with it.
 *
 * The second arm is what stops a run of publications with no restart between
 * them from evicting the only proven copy, and it needs no history — after any
 * number of them the record still names one proven generation and one current
 * one.
 */
export function supersedeGeneration(
  previous: ChainState,
): Pick<ChainState, 'fallback' | 'orphans'> {
  if (previous.fallback === undefined) {
    return {
      fallback: { base: previous.base, delta: previous.delta },
      orphans: previous.orphans,
    };
  }
  return {
    fallback: previous.fallback,
    orphans: [...(previous.orphans ?? []), previous.base.id],
  };
}

// ── identity and keys ───────────────────────────────────────────────────────

/**
 * A chain id is a UUID, full stop.
 *
 * Every object key is built from one, so anything that is not a UUID — `..`, a
 * path separator, another box's guess — has to die before it can become a key.
 * It dies here, loudly, at every call site that builds a key.
 */
const CHAIN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isChainId(id: string): boolean {
  return CHAIN_ID_RE.test(id);
}

/** Validate a chain id or refuse the operation, naming the refusal. */
export function assertChainId(id: string): string {
  if (!isChainId(id)) {
    throw new Error(
      `chain id ${JSON.stringify(id.slice(0, 64))} is not a UUID; refusing to build `
      + 'storage keys from it',
    );
  }
  return id;
}

/** The immutable full base layer. */
export function baseObjectKey(chainId: string): string {
  assertChainId(chainId);
  return `backups/${chainId}/data.sqsh`;
}

/** The cumulative changed set. ONE key, atomically replaced by every checkpoint
 *  after the base exists: supersession is a PUT, never a delete. */
export function deltaObjectKey(chainId: string): string {
  assertChainId(chainId);
  return `backups/${chainId}/delta.sqsh`;
}

/** The SDK's own metadata object, written only by its backup API. A chain
 *  records its sizes in the box's own state instead, so this key exists for
 *  extraction-mode handles and for discard to clean up after them. */
export function metadataObjectKey(chainId: string): string {
  assertChainId(chainId);
  return `backups/${chainId}/meta.json`;
}

// ── mount facts ─────────────────────────────────────────────────────────────

/**
 * Is `dir` an overlay mount?
 *
 * MECHANISM, NOT OPTIONS. The production image attaches with `fuse-overlayfs`,
 * and fuse-overlayfs does NOT publish `lowerdir`, `upperdir` or `workdir` in
 * `/proc/mounts`. Kernel overlay does, which is why an earlier version of this
 * file parsed them and why that version passed every local proof and then failed
 * on a deployed container with "produced an overlay whose upper directory
 * (unnamed) does not exist".
 *
 * So this asks only what the mount line can answer: is something mounted at
 * `dir`, and is it overlay-family. `fuse.fuse-overlayfs` and kernel `overlay`
 * both satisfy it. Anything that needs the upper directory uses the path this
 * strategy CHOSE and passed to the mount command, and verifies it with a direct
 * existence probe.
 */
export function isOverlayMounted(procMounts: string, dir: string): boolean {
  const line = findMount(procMounts, dir);
  return line !== undefined && line.fstype.includes('overlay');
}

// ── integrity ───────────────────────────────────────────────────────────────

/**
 * Why a stored layer must not be attached from, or null when it is sound.
 *
 * A PRE-attach probe. Objects can vanish under a lifecycle rule or a
 * half-finished delete, and attaching from one used to fail quietly. The size
 * recorded when the layer was written is compared against what the store holds
 * now, so a mismatch refuses the attach before the container-start budget is
 * spent on a transfer that cannot succeed.
 *
 * A SIZE IS NOT AN IDENTITY, which is the whole reason the digest and the
 * version are here. Two different archives of the same length pass every
 * byte-count check ever written, and a squashfs that is still structurally
 * valid mounts and serves the wrong content.
 *
 * TWO INDEPENDENT IDENTITIES, and they fail over for each other. `digest` is
 * the SHA-256 of the bytes the store holds, which the store itself can confirm
 * only for an object it was handed a checksum for, meaning a single-request
 * PUT. `objectVersion` is the store's OWN name for the upload
 * that wrote the object: R2 mints one per upload, hands it back from `put` and
 * from multipart `complete`, and reports it from `head` forever after. So a
 * large archive, which the Workers multipart API will not checksum, still has
 * an identity the store will answer for — and a replacement written to look
 * identical, right down to matching metadata, is a different upload and cannot
 * carry the recorded version.
 *
 * WHAT THE RECORD DOES NOT KNOW, IT DOES NOT CLAIM. Either identity may be
 * absent on either side: a row written before this code existed carries
 * neither, and the store answers no digest for a multipart object. Absent means
 * UNKNOWN, so that comparison is skipped and the size check stands alone —
 * weaker, and said out loud rather than passed off as sound.
 */
export function layerIntegrityFailure(input: {
  /** What the record says this layer is, or undefined when it names none. */
  declared: ChainLayer | undefined;
  /** What the store answers for the object, or undefined when it holds none. */
  stored: ChainLayer | undefined;
  label: string;
}): string | null {
  const { declared, stored, label } = input;
  if (declared === undefined) return `${label} declares no size`;
  if (stored === undefined) return `${label} archive object is missing from the store`;
  if (declared.bytes <= 0) return `${label} declares ${declared.bytes} bytes`;
  if (stored.bytes !== declared.bytes) {
    return `${label} archive is ${stored.bytes} bytes, state declares ${declared.bytes}`;
  }
  // THE DIGEST DECIDES WHEN BOTH SIDES HAVE ONE, and the version only speaks
  // when it cannot. A store version is minted per UPLOAD, not per content: an
  // archive re-put with byte-identical content — which this chain can do, since
  // a change under an excluded path moves the skip-gate fingerprint while the
  // archive bytes stay the same — gets a new version under the same key. If a
  // crash then loses that commit's state write, the record still names the old
  // version, and refusing on version alone would burn the fallback on a healthy
  // object. So agreement on content is the stronger answer and it wins.
  if (declared.digest !== undefined && stored.digest !== undefined) {
    if (stored.digest === declared.digest) return null;
    return `${label} archive is ${stored.bytes} bytes, exactly as recorded, and its content `
      + `digest is ${stored.digest}, while the record describes ${declared.digest}. That is a `
      + 'different archive of the same length, so the count proves nothing about it.';
  }
  if (declared.objectVersion !== undefined && stored.objectVersion !== undefined
    && stored.objectVersion !== declared.objectVersion) {
    return `${label} archive is ${stored.bytes} bytes, exactly as recorded, and the store holds `
      + `version ${stored.objectVersion} where the record describes `
      + `${declared.objectVersion}. Nothing here can compare content — the Workers multipart `
      + 'API carries no checksum — and the object under this key was written by a different '
      + 'upload, so it is a different archive of the same length however its metadata reads.';
  }
  return null;
}

// ── the box's own chain record ──────────────────────────────────────────────

/** How a chain's bytes move. `chain` is the production lazy-mount path;
 *  `extract` is local development. Decided once and persisted: a box always
 *  attaches the way it was checkpointed. */
export type ChainMode = 'chain' | 'extract';

/** What the container's retained change state says about a directory since a
 *  previous check. Mirrors the SDK's `CheckChangesResult.status`. `resync`
 *  means that state was itself lost — it expired, or the container restarted —
 *  so the directory has to be treated as changed. */
export type ChangeStatus = 'unchanged' | 'changed' | 'resync';

/**
 * ONE LAYER, as the record declares it and as the store answers for it.
 *
 * The same three facts either way, so the same type either way: a comparison
 * between a record's claim and a store's answer that had to enumerate fields at
 * every call site is a comparison that silently stops covering the field
 * somebody adds next. A layer is now only ever CONSTRUCTED by the parse or by
 * `objectFacts` — the store's own answer, which is what a publication records
 * too — and {@link layerIntegrityFailure} takes whole layers rather than loose
 * parts.
 *
 * `digest` and `objectVersion` are both optional and both mean UNKNOWN when
 * absent, never "sound" \u2014 see the note below this interface.
 */
export interface ChainLayer {
  readonly bytes: number;
  /** Lowercase hex SHA-256 of the bytes that landed, when it is known. */
  readonly digest: string | undefined;
  /** The store's own name for the upload that wrote the object, when it is
   *  known. R2 mints one per upload and reports it from `head` forever after. */
  readonly objectVersion: string | undefined;
}

/** The base layer, which additionally NAMES the generation: its UUID is the
 *  store prefix every key in that generation is built from. */
export interface ChainBaseLayer extends ChainLayer {
  readonly id: string;
}

/**
 * ONE GENERATION of the chain: the immutable base, and the cumulative changed
 * set on top of it once one has landed. Both live under a single
 * `backups/<uuid>/` prefix, which is what makes a generation either wholly
 * referenced or wholly garbage.
 *
 * ONE SHAPE, TWO ROLES. A record names the generation it serves and the
 * generation it falls back to, and those are the same thing described twice, so
 * they are the same type. `ChainState` IS its current generation rather than
 * holding one under a name: every reader keeps the fields it already spells,
 * and promoting the fallback is a spread rather than a rewrite.
 */
export interface ChainGeneration {
  /** The full base. Immutable once written. */
  readonly base: ChainBaseLayer;
  /** The cumulative changed set, or undefined until the first delta lands. */
  readonly delta: ChainLayer | undefined;
}

/**
 * WHY AN IDENTITY MAY BE ABSENT, and it is not a compatibility shim.
 *
 * A layer's digest is known only while its bytes are being uploaded, and its
 * store version only from the reply to that upload: recovering either
 * afterwards means reading or re-heading the object, and the digest cannot be
 * recovered at all without reading every byte back — the cost this strategy
 * exists to avoid. So a record written before these fields existed carries
 * neither, and a deployed box holding such a record is a real box with a real
 * workspace: `Devbox.strategy` defaults to the chain and the product's own
 * sandbox class is deployed on it, so those rows exist and refusing them would
 * be the data loss this file is otherwise about.
 *
 * Absent therefore means UNKNOWN, never "sound": the size check stands, the
 * comparison that has nothing to compare is skipped for that layer only, and
 * the record heals itself as layers are rewritten — every delta commit records
 * both, and a base's pair arrives with the rebase that writes the next base.
 * Nothing backfills by re-reading an object, and nothing carries a version
 * flag: one path, one record, two optional facts.
 */

/** Everything a box needs to know about its own chain. One record, one writer,
 *  replaced whole. */
export interface ChainState extends ChainGeneration {
  readonly mode: ChainMode;
  /** Monotonic revision. Every publication bumps it, and so does a restore that
   *  promotes the fallback, because that replaces the pointer too. */
  readonly rev: number;
  /** Epoch ms the checkpoint completed. The interval gate reads this. */
  readonly at: number;
  /** The change version this checkpoint is relative to. Advanced when a
   *  checkpoint succeeds, and when the directory was reported unchanged.
   *  NEVER advanced after a change that was not archived: that would discard
   *  the change signal and the next tick would believe it was already saved. */
  readonly changeVersion: string | undefined;
  /** The changed set's fingerprint at the last successful commit. The skip gate
   *  compares against it; see `chainShell.upperFingerprint`. */
  readonly upperMark: string | undefined;
  /**
   * The generation a restore falls back to, or undefined when the current one
   * needs no fallback.
   *
   * ONE ROLE, ONE SLOT, AND ITS ABSENCE IS ALSO A FACT. A publication that
   * supersedes a generation puts the outgoing one here. The attach that PROVES
   * the current generation — by verifying it against the store and mounting it
   * — moves this one to `orphans` and clears the slot. So an empty slot says
   * "nothing older is retained, because the current generation has been
   * served", and a publication that finds the slot already full therefore knows
   * its own outgoing generation was never proven: it keeps the proven one and
   * orphans the unproven one instead. That is what stops a second unproven
   * publication from evicting the only proven copy, and it needs no count and
   * no history array — current and fallback are the two roles a restore has.
   *
   * Its sizes are here for the same reason the current generation's are: the
   * integrity probe compares what the record declares against what the store
   * holds, and a candidate nobody can check is not a candidate.
   */
  readonly fallback: ChainGeneration | undefined;
  /**
   * Generations this box has superseded and no longer retains.
   *
   * WRITTEN BEFORE THE DELETE, cleared after it, for the same reason the record
   * is written before any other cleanup: a crash between the rebase's state
   * flip and the old generation's deletion used to orphan that generation
   * forever, because nothing anywhere still named it. Chain objects live under
   * a GLOBAL `backups/<uuid>/` namespace shared by every box, so a sweep cannot
   * discover this box's own orphans by listing — it would see other boxes'
   * live generations. The box therefore remembers them, and the sweep is
   * re-runnable: a crash mid-sweep leaves the ids in place for the next one.
   */
  readonly orphans: readonly string[] | undefined;
  /** The last attempt that failed. Kept because a thrown scheduled callback is
   *  reduced to a console line by the alarm loop, so durable state is the only
   *  way a repeatedly failing checkpoint stays visible. A restore that refused
   *  a generation and recovered from an older one records it here too: the box
   *  is running afterwards, so nothing else would say what it lost. */
  readonly lastFailure: { readonly at: number; readonly reason: string } | undefined;
}

/**
 * The stored record, as a schema.
 *
 * A durable row is untrusted input: it was written by some release of this
 * package, and the reader has to establish what it is rather than assume. A row
 * this code did not write reads as ABSENT, which makes a fresh box, rather than
 * as a chain whose base cannot be found, which makes a box that refuses to
 * start forever.
 *
 * The generation's fields are spread into the row rather than restated, so the
 * schema has the same one authority for a generation's shape that the types do.
 */
const DigestSchema = v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)));
/** The store's own version string. Its FORM is the store's business, not this
 *  record's, so this asks only that it be a non-empty string: inventing a shape
 *  rule for a value another system mints is how a reader refuses a row that is
 *  perfectly good. */
const ObjectVersionSchema = v.optional(v.pipe(v.string(), v.minLength(1)));

const ChainGenerationSchema = v.object({
  base: v.object({
    id: v.pipe(v.string(), v.regex(CHAIN_ID_RE)),
    bytes: v.number(),
    digest: DigestSchema,
    objectVersion: ObjectVersionSchema,
  }),
  delta: v.optional(v.object({
    bytes: v.number(),
    digest: DigestSchema,
    objectVersion: ObjectVersionSchema,
  })),
});

const ChainStateSchema = v.object({
  ...ChainGenerationSchema.entries,
  mode: v.picklist(['chain', 'extract']),
  rev: v.number(),
  at: v.number(),
  changeVersion: v.optional(v.string()),
  upperMark: v.optional(v.string()),
  fallback: v.optional(ChainGenerationSchema),
  orphans: v.optional(v.array(v.pipe(v.string(), v.regex(CHAIN_ID_RE)))),
  lastFailure: v.optional(v.object({ at: v.number(), reason: v.string() })),
});

/** One parsed generation, written out rather than spread so an absent delta, an
 *  absent digest or an absent version becomes present-and-undefined: what the
 *  contract declares, and what every reader checks. */
function generationOf(row: v.InferOutput<typeof ChainGenerationSchema>): ChainGeneration {
  return {
    base: {
      id: row.base.id,
      bytes: row.base.bytes,
      digest: row.base.digest,
      objectVersion: row.base.objectVersion,
    },
    delta: row.delta === undefined ? undefined : {
      bytes: row.delta.bytes,
      digest: row.delta.digest,
      objectVersion: row.delta.objectVersion,
    },
  };
}

export function normalizeChainState(raw: StoredValue): ChainState | null {
  const parsed = v.safeParse(ChainStateSchema, raw);
  if (!parsed.success) return null;
  // Written out rather than spread, so the parse produces EXACTLY the contract.
  // The schema's optional fields become present-and-undefined here, which is
  // what the record declares and what every reader checks.
  const row = parsed.output;
  return {
    mode: row.mode,
    rev: row.rev,
    ...generationOf(row),
    at: row.at,
    changeVersion: row.changeVersion,
    upperMark: row.upperMark,
    fallback: row.fallback === undefined ? undefined : generationOf(row.fallback),
    orphans: row.orphans,
    lastFailure: row.lastFailure,
  };
}

/** Commit only when the directory actually changed AND the period elapsed.
 *
 *  `unchanged` is the whole efficiency argument: a work directory is idle for
 *  most of its wall-clock life, and an unchanged tick costs no archive, no
 *  upload and no new object. */
export function shouldCheckpoint(
  change: ChangeStatus,
  lastCheckpointAt: number,
  now: number,
  minIntervalMs: number,
): boolean {
  if (change === 'unchanged') return false;
  return now - lastCheckpointAt >= minIntervalMs;
}

// ── ports ───────────────────────────────────────────────────────────────────

/**
 * Everything the strategy needs from the world. The adapter implements it and
 * decides nothing; every entry maps to one public Sandbox SDK primitive, one
 * object-store binding call, or the box's own durable storage.
 */
export interface SnapshotChainPorts {
  /** Is the container up right now? A scheduled tick can outlive it, and waking
   *  a sleeping container to ask whether it changed would keep it alive
   *  forever. */
  containerRunning(): boolean;
  /**
   * May this box archive and extract whole trees instead of mounting layers?
   *
   * DECLARED BY THE HOST, never discovered. Extraction exists because a plain
   * local `wrangler dev` has no container outbound interception and therefore
   * no store mount. It costs a full pass over every byte on every attach, it
   * does not scale, and a deployed box that quietly took it is a box whose
   * changed set is never archived: `/workspace` is a plain directory, so there
   * is no overlay upper to capture, and every write after the base is lost on
   * the next restore.
   *
   * That is not hypothetical. It was measured on a deployed probe, where a
   * failed mount was converted into extraction and the loss only surfaced as
   * "delta content lost across restore" two phases later. So a mount failure
   * where extraction is not permitted is a FAILURE, and it carries the mount's
   * own reason to whoever is watching.
   */
  allowExtraction(): boolean;
  /** What a whole-tree base leaves behind, for THIS box. Defaults to
   *  {@link CHAIN_EXCLUDES}; a workspace whose regenerable-looking tree is
   *  really the work replaces it. */
  archiveExcludes(): readonly string[];
  readState(): Promise<ChainState | null>;
  writeState(state: ChainState): Promise<void>;
  clearState(): Promise<void>;
  /** Minimum gap between two commits. Supplied by the host's policy so one
   *  place decides the cadence for both the schedule and this gate. */
  checkpointIntervalMs(): number;
  /** Has the work directory changed since `since`, per the container's own
   *  retained change state? */
  checkChanges(dir: string, since: string | undefined):
    Promise<{ status: ChangeStatus; version: string }>;
  /**
   * Run one shell command container-side, and answer what it did.
   *
   * THE ONLY CONTAINER-SHELL PORT. The mount flags, the squashfs options, the
   * seeding copy and the mount probes are this strategy's own vocabulary, so it
   * builds them itself rather than taking eight command templates a host would
   * have to keep correct. A host supplies the ability to run a command; what to
   * run is not its business.
   */
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Ephemeral generation id, when the host can observe one. */
  containerGeneration?(): Promise<string | undefined>;
  /**
   * Mount this chain's store subtree at `at`, for reading or for writing.
   *
   * ONE PORT FOR BOTH ROLES, because they are one SDK primitive asked for two
   * accesses, and the strategy — not the host — owns which path carries which:
   * {@link CHAIN_STORE_MOUNT} read-only for an attach, {@link CHAIN_PUBLISH_MOUNT}
   * writable for one publication. A host that had to remember the pairing could
   * get it wrong in one place only.
   *
   * The subtree is scoped to this chain's own UUID prefix, so the container sees
   * its own generation and nothing else, and CREDENTIALS NEVER LEAVE THE
   * DURABLE OBJECT: the container's s3fs holds a dummy password file and its
   * requests are resolved against the binding by a Worker entrypoint. Writable
   * therefore hands the container no capability it can read or replay.
   */
  mountStore(chainId: string, at: string, access: 'read' | 'write'): Promise<void>;
  /**
   * Release the mount at `at` THROUGH THE SDK, not through the kernel.
   *
   * The SDK keeps its own registry of the bucket mounts it made and refuses a
   * mount whose path it still believes is in use. Releasing one with a raw
   * `fusermount3` unmounts the filesystem and leaves that registry claiming the
   * path forever, so the NEXT attach is refused for a mount that no longer
   * exists. Deployed symptom: a chain that could be written and then never
   * attached again, with every operation refused because the attach failed.
   *
   * A RELEASE IS NOT A FLUSH, and a publication must not rely on it as one: a
   * lazy unmount returns as soon as the mount leaves the namespace, so bytes
   * still held by s3fs would be lost while the record already named them. See
   * {@link chainShell}'s `publishArchive`, which flushes and CHECKS the flush
   * before anything here runs.
   */
  unmountStore(at: string): Promise<void>;
  /**
   * What the store currently holds for one object, or undefined when it holds
   * nothing.
   *
   * `digest` and `objectVersion` are the store's OWN answers, not the record's,
   * and either may be undefined when the store has none to give — see
   * {@link layerIntegrityFailure}. This is one metadata read, the same call the
   * byte count always cost.
   *
   * IT IS ALSO HOW A PUBLICATION LEARNS WHAT LANDED. The container writes the
   * archive through a mount, so this side never sees the bytes and cannot count
   * them; the store is asked instead. That makes the record describe THE OBJECT
   * rather than the intention — which is what the deployed disagreement
   * `delta archive is 702791680 bytes, state declares 700387328` cost, and it
   * is now the only reading there is.
   */
  objectFacts(key: string): Promise<ChainLayer | undefined>;
  /** Delete objects. Used by discard, and to drop a superseded extraction
   *  archive after its replacement is durably recorded. */
  deleteObjects(keys: readonly string[]): Promise<void>;
  /**
   * The seed stamp: which delta the upper on THIS container disk already holds.
   *
   * Kept beside the upper rather than inside it, so no archive ever carries it,
   * and on the container's own disk rather than in durable storage, because the
   * fact it records — "these bytes are already in this upper" — dies with the
   * disk. A replaced container has no stamp and is seeded from the store, which
   * is the whole point: see {@link snapshotChainStorage}'s attach.
   */
  readSeedStamp(): Promise<string | undefined>;
  writeSeedStamp(stamp: string): Promise<void>;
  /** Entry count of the work directory. The extraction-mode postcondition. */
  countEntries(dir: string): Promise<number>;
  /** Extraction-mode attach, through the SDK's own local-store path. */
  restoreExtract(backup: DirectoryBackup): Promise<{ success: boolean }>;
  /** Extraction-mode checkpoint: the SDK archives a whole tree and moves it
   *  through the binding. LOCAL DEVELOPMENT ONLY. */
  createExtractSnapshot(options: BackupOptions): Promise<DirectoryBackup>;
  now(): number;
  log(message: string): void;
}

/** Canonical archive options for the extraction path. The TTL is HERE and only
 *  here: the SDK enforces it at restore time on archives its own backup API
 *  wrote, which is exactly this path. See {@link EXTRACT_TTL_SECONDS}.
 *
 *  THE EXCLUDES ARE THE CALLER'S, and they are a parameter for a reason: this
 *  used to spell {@link CHAIN_EXCLUDES} itself while the chain path asked
 *  `SnapshotChainPorts.archiveExcludes`, so a box that replaced the policy was
 *  obeyed in one mode and ignored in the other. One question, one authority.
 *
 *  The patterns are passed on RAW, because the SDK normalises them itself and
 *  {@link normalizeArchiveExclude} is that same normalisation: one list, one
 *  meaning, whichever mode writes the layer. See {@link archiveExcludeFile} for
 *  what a pattern matches. */
export function chainBackupOptions(
  localBucket: boolean,
  excludes: readonly string[],
): BackupOptions {
  return {
    dir: DEVBOX_WORKDIR,
    localBucket,
    gitignore: true,
    excludes: [...excludes],
    ttl: EXTRACT_TTL_SECONDS,
    // zstd because every byte is paid twice: once on upload, again on every
    // attach that reads it.
    compression: { format: 'zstd' },
  };
}

// ── the layout inside the container ─────────────────────────────────────────
//
// Where the overlay's parts live. Module scope because the shell below builds
// commands from them and the strategy reasons about them: one declaration, one
// meaning, and no path spelled twice.

/** The overlay's writable upper. Everything the caller writes lands here, and
 *  archiving it archives the whole changed set since the base. */
const upperDir = `${DEVBOX_RUNTIME_DIR}/upper`;
/** fuse-overlayfs's own scratch directory. Not the upper, and not readable as
 *  content. */
const workDir = `${DEVBOX_RUNTIME_DIR}/work`;
/** Where an archive is built before it is streamed into the store. */
const stageDir = `${DEVBOX_RUNTIME_DIR}/stage`;
/** Mount point for the base layer. It stays mounted for as long as the overlay
 *  above it does: it is that overlay's bottom lower, not a staging path. */
const lowerBase = `${DEVBOX_RUNTIME_DIR}/lower-base`;
/** Where delta layers are mounted, one directory per generation. */
const lowerDeltaRoot = `${DEVBOX_RUNTIME_DIR}/lower-delta`;
/** The lower a box with no chain yet attaches over: an empty directory.
 *
 *  See {@link snapshotChainStorage}'s attach. It exists so that "this box is in
 *  chain mode" and "`/workspace` is a plain directory" can never both be true. */
const lowerEmpty = `${DEVBOX_RUNTIME_DIR}/lower-empty`;

/**
 * Where THIS generation's delta layer is mounted.
 *
 * NAMED AFTER THE GENERATION, because the name is what a later checkpoint reads
 * to answer "is the changed set this record names being served as a layer, or
 * does the upper hold it?". One fixed path could not tell those apart: after the
 * collapse that ends a composition, the same mount is still there serving a
 * generation the record no longer names, and every commit afterwards would read
 * it as a reason to collapse again.
 *
 * The id is a validated UUID — see {@link assertChainId} — so it contributes no
 * path syntax of its own.
 */
function deltaLayerMountPoint(chainId: string): string {
  return `${lowerDeltaRoot}/${assertChainId(chainId)}`;
}

/**
 * Where one generation's object appears inside a mount scoped to that
 * generation's prefix.
 *
 * ONE DERIVATION FOR BOTH MOUNTS. A store subtree mounted at `backups/<uuid>/`
 * shows each object as a file named by the last segment of its key, so the read
 * path's `squashfuse` source and the write path's `dd` target are the same
 * question asked twice. Spelling it twice is how the two would drift into
 * writing one name and mounting another.
 */
function mountedLayerPath(mountPoint: string, objectKey: string): string {
  return `${mountPoint}/${objectKey.split('/').pop() ?? objectKey}`;
}

/**
 * Is `chainId`'s delta being served as a layer under this container's overlay?
 *
 * THE ONE QUESTION A COMMIT MUST ASK BEFORE ARCHIVING THE UPPER. True means the
 * cumulative changed set is spread across the layer and the upper, so archiving
 * the upper alone would publish a delta missing everything the layer holds; the
 * chain collapses onto a fresh base instead. False means the upper is the whole
 * changed set, which is what every delta commit relies on.
 *
 * Asked of `/proc/mounts` rather than of a durable note, for the same reason the
 * overlay itself is: the mount is the fact, and a note about it can outlive the
 * container that made it true.
 */
function deltaLayerServed(procMounts: string, chainId: string): boolean {
  return findMount(procMounts, deltaLayerMountPoint(chainId)) !== undefined;
}

/**
 * How many times an attach asks the store mount for a layer it cannot see yet.
 *
 * A COUNT, NEVER A DEADLINE. The mount itself is already established when this
 * runs — the SDK proves the FUSE mount before returning — so the only thing
 * outstanding is the store's first metadata answer for one key. That either
 * arrives promptly or is being served from a negative cache, and neither is
 * improved by waiting longer against a budget that belongs to the whole
 * restoration. An attach that has asked this many times says which layer it
 * cannot see and what the subtree does hold, and the ordinary recovery ladder
 * asks again on a fresh mount.
 */
const LAYER_VISIBILITY_PROBES = 20;

/**
 * How many times a release is attempted before the mount is called stuck.
 *
 * The loop used to be unbounded — `while grep -qs …; do fusermount3 -u; done` —
 * inside a single container command, so a mount something still held turned an
 * attach into a hang with no diagnosis, and the container-start budget was the
 * only thing that ended it. A release either succeeds or is refused by
 * something holding the mount, and that is not a condition more attempts fix on
 * the attach path.
 */
const MOUNT_RELEASE_ATTEMPTS = 20;

// ── the container shell ─────────────────────────────────────────────────────
//
// Every command this strategy runs, in this file. The mount flags, the squashfs
// options and the seeding copy are the strategy's own vocabulary; they were
// eight templates in the host adapter, so a reader had to hold two files open
// to answer "what does an attach actually run", and a change to the overlay
// flags meant editing the layer that does not own them.

type ContainerExec = SnapshotChainPorts['exec'];

function chainShell(exec: ContainerExec) {
  /** Run a command and refuse on a non-zero exit, naming what was attempted.
   *  The container's own words are the diagnosis; this code has no better one. */
  const must = async (doing: string, command: string): Promise<string> => {
    const result = await exec(command);
    if (result.exitCode !== 0) {
      throw new Error(`${doing} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  };
  return {
    /** `/proc/mounts` as the container sees it. */
    readMounts: async (): Promise<string> => (await exec('cat /proc/mounts')).stdout,
    /** Does this container path exist? The attach postcondition asks for the
     *  overlay's upper directory by name: a mount line without a usable upper
     *  is a box whose writes have nowhere to land. */
    pathExists: async (path: string): Promise<boolean> =>
      (await exec(`test -e ${shellPath(path)} && echo yes || echo no`)).stdout.trim() === 'yes',
    /** Release a FUSE mount this strategy made itself, or say it is stuck.
     *
     *  The squashfuse layers only: the SDK did not create those and has no
     *  registry entry for them, and releasing a mount the SDK DID make this way
     *  leaves its registry claiming the path forever.
     *
     *  BOUNDED — see {@link MOUNT_RELEASE_ATTEMPTS}. Absent is success; still
     *  mounted after the last attempt is a NAMED failure, because an attach that
     *  proceeds over a mount it could not release would mount on top of it, and
     *  one that waits forever spends a budget belonging to the whole
     *  restoration and reports nothing.
     *
     *  NOT ONE `exit` — see {@link awaitLayer}. */
    unmountPath: async (path: string): Promise<void> => {
      await must(`releasing the mount at ${path}`,
        `for _ in $(seq 1 ${String(MOUNT_RELEASE_ATTEMPTS)}); do `
          + `grep -qs ${shellPath(` ${path} `)} /proc/mounts || break; `
          + `/usr/bin/fusermount3 -u ${shellPath(path)} 2>/dev/null || true; sleep 0.1; done; `
          + `if grep -qs ${shellPath(` ${path} `)} /proc/mounts; then `
          + `echo "still mounted after ${String(MOUNT_RELEASE_ATTEMPTS)} release attempts" >&2; `
          + 'false; fi');
    },
    /** Release every delta layer this container is still serving, whichever
     *  generation mounted it.
     *
     *  ONE COMMAND OVER `/proc/mounts`, because the mount points are named after
     *  generations and a container that was re-driven can hold one this attach
     *  did not make. Deepest first, so a nested path is released before its
     *  parent. Reached only where `/workspace` is NOT an overlay — the attach
     *  early-returns otherwise — so nothing can still be reading them.
     *
     *  EVERY STUCK LAYER IS NAMED, not the first: the walk records the failure
     *  and carries on, so one command answers "which layers would not go" rather
     *  than one of them. See {@link awaitLayer} for why it cannot `exit`. */
    releaseDeltaLayers: async (): Promise<void> => {
      await must('releasing delta layers',
        `stuck=; for p in $(awk -v r=${shellPath(`${lowerDeltaRoot}/`)} `
          + `'index($2, r) == 1 {print $2}' /proc/mounts | sort -r); do `
          + `for _ in $(seq 1 ${String(MOUNT_RELEASE_ATTEMPTS)}); do `
          + `grep -qs " $p " /proc/mounts || break; `
          + `/usr/bin/fusermount3 -u "$p" 2>/dev/null || true; sleep 0.1; done; `
          + `if grep -qs " $p " /proc/mounts; then `
          + `echo "delta layer $p is still mounted" >&2; stuck=1; fi; done; [ -z "$stuck" ]`);
    },
    /**
     * Wait for one layer to become visible through the store mount, BY COUNT.
     *
     * The mount is established before this runs, so what is outstanding is the
     * store's first metadata answer for one key. Each probe re-lists the mounted
     * subtree, because a listing is what repopulates a stat cache that answered
     * "no such object" once and would otherwise keep saying so.
     *
     * ONE container command rather than a poll over RPC: the pacing happens
     * inside the container, so a slow answer costs one round trip instead of one
     * per probe, and the count cannot become an unbounded wait. What comes back
     * when it never appears is what the subtree DOES hold, which is the sentence
     * an operator needs.
     *
     * IT MUST NEVER SAY `exit`, AND THAT IS THE WHOLE DEFECT THIS SHAPE FIXES.
     * Every command this strategy runs is fed to the SDK's PERSISTENT shell
     * session, so `exit 0` on the success branch ended the shell itself: the
     * probe that had just found the layer came back as
     * `SessionTerminatedError: Session 'sandbox-default' shell exited (exit code:
     * 0)`, the attach died on its own success, and every wake with a chain
     * repeated it — 1,054 times in probe `wakeprobe09010702`. A flag and one
     * `break` answer the same question and leave the shell alive.
     */
    awaitLayer: async (path: string): Promise<{ ready: boolean; holds: string }> => {
      const probed = await exec(
        `seen=; for _ in $(seq 1 ${String(LAYER_VISIBILITY_PROBES)}); do `
          + `if test -e ${shellPath(path)}; then seen=1; break; fi; `
          + `ls -1A ${shellPath(CHAIN_STORE_MOUNT)} >/dev/null 2>&1; sleep 0.25; done; `
          + 'if [ -n "$seen" ]; then printf ready; else '
          + `printf 'missing '; ls -1A ${shellPath(CHAIN_STORE_MOUNT)} 2>&1 | head -20 | tr '\n' ' '; fi`,
      );
      const answer = probed.stdout.trim();
      return {
        ready: answer === 'ready',
        holds: answer.startsWith('missing') ? answer.slice('missing'.length).trim() : answer,
      };
    },
    /**
     * Mount one squashfs layer read-only. squashfuse reads lazily THROUGH the
     * mounted store subtree: bytes arrive on demand over the intercepted
     * egress, never as a download.
     *
     * THE MOUNTPOINT IS CREATED IN THE SAME COMMAND THAT USES IT. The attach is
     * several RPCs apart, and a spot container can be replaced between two of
     * them — measured live at roughly once per phase under churn — leaving the
     * next command on a blank disk. A mountpoint prepared by an earlier exec
     * then does not exist, and fuse refuses with `bad mount point`. One
     * `mkdir -p &&` inside the command has no gap to lose. `nonempty` is safe
     * here because this private runtime directory is reset before every mount;
     * it tolerates kernel-delayed FUSE cleanup and never hides user files.
     */
    mountLayer: async (objectKey: string, mountPoint: string): Promise<void> => {
      await must('squashfuse mount', `mkdir -p ${shellPath(mountPoint)} && /usr/bin/squashfuse `
        + `${shellPath(mountedLayerPath(CHAIN_STORE_MOUNT, objectKey))} ${shellPath(mountPoint)} `
        + '-o allow_other,ro,nonempty');
    },
    /** Attach `lowers` (first entry is newest) with a fresh writable upper. Its
     *  upper and work directories are created in the same command, for the same
     *  reason as {@link mountLayer}'s mount point. */
    overlayAttach: async (dir: string, lowers: readonly string[]): Promise<void> => {
      await must('fuse-overlayfs attach', `mkdir -p ${shellPath(upperDir)} `
        + `${shellPath(workDir)} && /usr/bin/fuse-overlayfs `
        + `-o lowerdir=${lowers.map(shellPath).join(':')}`
        + `,upperdir=${shellPath(upperDir)},workdir=${shellPath(workDir)} ${shellPath(dir)}`);
    },
    /**
     * Build a squashfs of `sourceDir` at `archivePath` and answer its size.
     *
     * BUILD AND MEASURE IN ONE COMMAND. They were two execs, and a spot
     * container can be replaced between two RPCs: the build reported exit 0 on
     * one container and the stat found no file on the next, which surfaced as
     * "the archiver did not land" three times in one deployed run while
     * mksquashfs had in fact succeeded. One command cannot be split by a
     * replacement, so a missing archive after a successful build is no longer
     * representable.
     *
     * STDERR IS KEPT. It used to go to /dev/null, so the one run that needed
     * mksquashfs's own words to explain itself did not have them.
     */
    makeSquashfs: async (
      sourceDir: string, archivePath: string, excludes: readonly string[],
    ): Promise<number> => {
      const result = await exec(archiveCommand({
        sourceDir, archivePath, excludeFile: `${stageDir}/excludes.txt`, excludes,
      }));
      const [code, size] = result.stdout.trim().split(/\s+/);
      if (code !== '0') {
        throw new Error(
          `staging the exclude list or building the squashfs failed (${code ?? '?'}): `
          + `${result.stderr.trim() || 'no output'}`,
        );
      }
      const bytes = Number(size);
      if (!Number.isFinite(bytes) || bytes <= 0) {
        throw new Error(
          `mksquashfs reported success but ${archivePath} is ${size ?? 'absent'}: `
          + `${result.stderr.trim() || 'the archiver left no diagnostics'}`,
        );
      }
      return bytes;
    },
    /**
     * Move one staged archive into the store THROUGH THE MOUNT, and answer what
     * the mount then holds.
     *
     * THIS IS THE WHOLE BYTE PATH. The container reads its own disk and writes
     * an object; the Durable Object is not on the wire. See
     * {@link CHAIN_PUBLISH_MOUNT} for the measurement that moved it here.
     *
     * `dd` RATHER THAN A REDIRECT, and the reason is the only way this step can
     * lose data. s3fs uploads on flush, so the upload's failure surfaces at
     * close — and a shell redirect's close error is reported by no exit code,
     * so `cat archive > mount/layer` would report success over a store that got
     * nothing. `conv=fsync` makes the flush part of the command and its failure
     * the command's own exit, which is what lets the release that follows be a
     * release rather than a gamble: a lazy unmount returns before s3fs has
     * finished, and the tail of an archive the record already names would be
     * gone with it.
     *
     * WRITTEN STRAIGHT TO THE FINAL NAME. A temporary name plus a rename is the
     * usual way to make a write appear atomically, and on s3fs it is a
     * server-side COPY of every byte — the one shape that would pay the whole
     * archive twice again. It is not needed: the object under this key becomes
     * visible only when s3fs completes its upload, so a reader sees the previous
     * archive or this one, never a partial.
     *
     * dd's own transfer summary is left on stderr deliberately: it is this
     * path's only throughput reading, and the failure message carries it.
     */
    publishArchive: async (archivePath: string, mountedPath: string): Promise<number> => {
      const result = await exec(publishCommand({ archivePath, mountedPath }));
      const [code, size] = result.stdout.trim().split(/\s+/);
      if (code !== '0') {
        throw new Error(
          `publishing ${archivePath} through ${mountedPath} failed (${code ?? '?'}): `
          + `${result.stderr.trim() || 'no output'}`,
        );
      }
      const bytes = Number(size);
      if (!Number.isFinite(bytes) || bytes <= 0) {
        throw new Error(
          `the store mount reports ${mountedPath} as ${size ?? 'absent'} after a publication `
          + `that reported success: ${result.stderr.trim() || 'no diagnostics'}`,
        );
      }
      return bytes;
    },
    /**
     * Why there is not room to stage an archive of `sourceDir`, or null.
     *
     * THE ESTIMATE WALKS WHAT THE ARCHIVE WILL WALK. The requirement is the
     * archive's true worst case — squashfs never exceeds its uncompressed
     * input — rather than a number anyone chose, and that only holds while the
     * two agree about which files travel. They used to disagree: this pruned
     * `-name` at every depth while the archiver excluded the top level only, so
     * the estimate was under the truth for exactly the trees that dominate a
     * work directory. Both sides now come from {@link archiveSizeCommand} and
     * {@link archiveExcludeFile}, off one policy list.
     *
     * `df` reports what the staging filesystem has. Both readings in one
     * command, so a container replacement cannot land between them and make
     * them describe different disks.
     */
    stagingShortfall: async (
      sourceDir: string,
      excludes: readonly string[],
    ): Promise<string | null> => {
      const measured = await exec(
        `mkdir -p ${shellPath(stageDir)}; `
        + `need=$(${archiveSizeCommand(sourceDir, excludes)}); `
        + `free=$(df -Pk ${shellPath(stageDir)} | awk 'NR==2 {print $4*1024}'); `
        + `echo "$need $free"`,
      );
      const [need, free] = measured.stdout.trim().split(/\s+/).map(Number);
      // An unreadable answer is NOT a refusal: refusing every checkpoint because
      // a probe could not parse would lose more work than a full disk would.
      if (!Number.isFinite(need) || !Number.isFinite(free)) return null;
      if (free! >= need!) return null;
      return `staging ${sourceDir} needs up to ${need} bytes and ${stageDir} has ${free} free. `
        + 'Refusing to archive rather than filling the container disk and taking the box '
        + 'down mid-checkpoint.';
    },
    /**
     * A cheap fingerprint of the changed set: entry count, total bytes, newest
     * mtime. Empty string when it cannot be taken.
     *
     * THIS REPLACES ASKING THE MERGED MOUNT. The SDK's change check was asked
     * about `/workspace` while a delta archives `upperDir`, and on a deployed
     * run it answered `unchanged` five ticks running while npm wrote 400 MiB
     * into that upper — then the next workload's first tick committed 487 MiB
     * of it. A gate that can say "unchanged" about a workspace that changed is
     * a data-loss window, so the question is now asked of the bytes that would
     * be archived, and it walks metadata rather than content: O(entries), not
     * O(bytes).
     */
    upperFingerprint: async (): Promise<string> => {
      const measured = await exec(upperFingerprintCommand(upperDir));
      return measured.exitCode === 0 ? measured.stdout.trim() : '';
    },
    /** Byte length of a container file, or undefined when it does not exist. */
    statBytes: async (path: string): Promise<number | undefined> => {
      const raw = (await exec(`stat -c %s ${shellPath(path)} 2>/dev/null || echo ''`)).stdout.trim();
      return raw.length > 0 ? Number.parseInt(raw, 10) : undefined;
    },
    /** Reset a set of directories to empty, and make sure each exists.
     *  THROUGH must(): a failed reset used to pass silently — its exit code
     *  was discarded — so the attach then ran against whatever the container
     *  happened to still hold, one reorder away from serving a stale tree. */
    resetDirs: async (paths: readonly string[]): Promise<void> => {
      await must('resetting directories',
        `rm -rf ${shellPaths(paths)} && mkdir -p ${shellPaths(paths)}`);
    },
  };
}

// ── the strategy ────────────────────────────────────────────────────────────

export function snapshotChainStorage(ports: SnapshotChainPorts): DevboxStorage {
  const shell = chainShell(ports.exec);

  /**
   * Why a stored layer must not be attached from, or null when it is sound.
   *
   * THE BASE AND THE DELTA ARE JUDGED DIFFERENTLY, and the asymmetry is the
   * design's own. A base is written ONCE and never rewritten, so a size that
   * disagrees with the record means the object is not the one the record
   * describes — genuinely unsound, refuse.
   *
   * A delta is REPLACED by an atomic PUT on every checkpoint, and this file's
   * header already states what a mismatch there means: "a crash between the PUT
   * and the state write leaves a complete delta the record does not yet
   * mention, and an attach adopts it — the PUT was all-or-nothing and squashfs
   * verifies its own superblock, so the mount is the validator."
   *
   * That adoption was unreachable. The probe refused on the byte count before
   * the mount could validate anything, and `fail()` then re-wrote the state
   * carrying the OLD size, so the disagreement was permanent: the object never
   * shrinks back to the declared number. Measured across two deployed runs as
   * `archive 506834944, state declares 506494976` and twice more, each
   * difference an exact multiple of 4096 because every squashfs archive is
   * padded to it — the signature of two DIFFERENT archives, not of one archive
   * measured twice. One occurrence cost an arm fourteen of its twenty segments.
   *
   * So a delta the store still holds is adopted and its size re-recorded. A
   * delta the record names and the store does NOT hold is still a refusal:
   * that is real content loss, not a stale number.
   *
   * TWO IDENTITIES SPLIT THAT ADOPTION IN TWO, which is what closes same-length
   * corruption without reopening the brick. A delta whose SIZE disagrees is the
   * crash-window delta the header describes — a different, complete archive the
   * record does not mention yet — so it is adopted whole: size, digest and
   * store version together. A delta whose size matches EXACTLY while its digest
   * or its store version does not is not that: it is a different archive of
   * identical length under the key the record already describes, and no count
   * can tell them apart. That is refused, and because the record retains a
   * fallback generation the refusal is a recovery rather than a dead end.
   *
   * The base is judged as it always was: immutable, so any disagreement of any
   * kind means the object is not the one the record describes.
   */
  const probe = async (
    mode: ChainMode,
    generation: ChainGeneration,
  ): Promise<
    { refusal: string } | { refusal: null; delta: ChainLayer | undefined }
  > => {
    if (mode === 'extract') return { refusal: null, delta: undefined };
    const unsound = layerIntegrityFailure({
      declared: generation.base,
      stored: await ports.objectFacts(baseObjectKey(generation.base.id)),
      label: 'base',
    });
    if (unsound !== null) return { refusal: unsound };
    if (generation.delta === undefined) return { refusal: null, delta: undefined };
    const stored = await ports.objectFacts(deltaObjectKey(generation.base.id));
    if (stored === undefined) {
      return {
        refusal: `delta archive is missing from the store, but the record names one of `
          + `${generation.delta.bytes} bytes. Refusing rather than attaching a chain whose `
          + 'changed set is gone.',
      };
    }
    if (stored.bytes === generation.delta.bytes) {
      const corrupt = layerIntegrityFailure({
        declared: generation.delta,
        stored,
        label: 'delta',
      });
      if (corrupt !== null) return { refusal: corrupt };
    }
    return { refusal: null, delta: stored };
  };

  const attachExtract = async (generation: ChainGeneration): Promise<AttachOutcome> => {
    const result = await ports.restoreExtract({
      id: generation.base.id, dir: DEVBOX_WORKDIR, localBucket: true,
    });
    // AN ARCHIVE THAT WILL NOT EXTRACT is that generation's own failure, so it
    // travels as one: a box with an older generation may still start.
    if (!result.success) {
      throw new LayerUnreadable('extraction', generation.base.id, {
        cause: new Error(`extraction of ${DEVBOX_WORKDIR} reported failure.`),
      });
    }
    if ((await ports.countEntries(DEVBOX_WORKDIR)) === 0) {
      throw new LayerUnreadable('extraction', generation.base.id, {
        cause: new Error(
          `extraction of ${DEVBOX_WORKDIR} reported success, but the directory is empty.`,
        ),
      });
    }
    ports.log(`${DEVBOX_WORKDIR} extracted from ${generation.base.id}`);
    return { kind: 'attached', detail: `extract ${generation.base.id}` };
  };

  /**
   * The identity of the delta an upper holds: this chain's generation and the
   * exact object whose content is in it.
   *
   * All three halves are load-bearing. A generation id alone would match after a
   * rebase onto a new base; a size alone would match a different archive of the
   * same length; `objectVersion` is the store's own name for the upload that
   * wrote the delta, so a replaced delta of identical size never matches a stamp
   * written for its predecessor.
   *
   * THE DIGEST IS DELIBERATELY ABSENT. Nothing gives the store a checksum for
   * a layer: the container writes the archive through the mount, and R2 reports
   * none for what it took that way. A stamp carrying a digest would therefore
   * never match the store's own answer, and the skip would be dead code.
   */
  const seedStampOf = (chainId: string, delta: ChainLayer): string =>
    `${chainId}:${delta.bytes}:${delta.objectVersion ?? 'no-version'}`;

  /** Record what the upper now holds.
   *
   *  BEST EFFORT, because everything a missing stamp costs is work, never
   *  correctness: the next attach on this container cannot prove the upper holds
   *  the delta, so it composes the delta as a layer instead of serving it from
   *  the upper, and the first commit after that collapses the chain onto a fresh
   *  base. Both are correct; both are more expensive than the stamp. */
  const stampSeededUpper = async (chainId: string, delta: ChainLayer): Promise<void> => {
    try {
      await ports.writeSeedStamp(seedStampOf(chainId, delta));
    } catch (error) {
      ports.log(
        `${upperDir} holds delta ${chainId} and the seed stamp could not be written, so the `
        + `next attach on this container composes it as a layer instead: `
        + `${describe({ cause: error })}`,
      );
    }
  };

  const attachChainOnce = async (generation: ChainGeneration): Promise<AttachOutcome> => {
    const containerGeneration = await ports.containerGeneration?.();
    // Release any mount the SDK still believes it holds at this path before
    // asking for a new one. A previous container generation's entry survives in
    // that registry, and it refuses the mount rather than replacing it.
    await ports.unmountStore(CHAIN_STORE_MOUNT);
    // A chain whose layers EXIST cannot be served by extraction, so a mount
    // failure here fails the start rather than degrading. Degrading would hand
    // the caller an empty tree and report success. The thrown reason travels as
    // it came: the platform's own words are the diagnosis, and this code has no
    // better one.
    try {
      await ports.mountStore(generation.base.id, CHAIN_STORE_MOUNT, 'read');
    } catch (error) {
      throw new Error(
        `chain ${generation.base.id} is stored as lazy layers and its store subtree could not `
        + `be mounted here: ${describe({ cause: error })}`,
        { cause: error },
      );
    }
    const mountedGeneration = await ports.containerGeneration?.();
    if (containerGeneration !== undefined && mountedGeneration !== containerGeneration) {
      throw new ContainerChangedDuringAttach();
    }
    /** A layer that will not mount, or will not read, is THIS generation's own
     *  failure — unless the container was replaced underneath, which is the
     *  attach's failure and is retried on the replacement. */
    const layerFailed = async (
      layer: string,
      thrown: { readonly cause: unknown },
    ): Promise<never> => {
      const failedGeneration = await ports.containerGeneration?.();
      if (mountedGeneration !== undefined && failedGeneration !== mountedGeneration) {
        throw new ContainerChangedDuringAttach();
      }
      throw new LayerUnreadable(layer, generation.base.id, thrown);
    };
    const mountedBase = mountedLayerPath(CHAIN_STORE_MOUNT, baseObjectKey(generation.base.id));
    // WAIT BY COUNT, THEN SAY WHAT IS THERE. The wait used to be an unbounded
    // poll in the host adapter: one `test -e` per RPC, every 100 ms, with no
    // exit except the path appearing — and its container-replacement exit was
    // disabled on exactly the container that needs it, because a fresh instance
    // has no generation id to compare yet. A store subtree that never exposes
    // the base then consumed the whole container-start budget and reported
    // nothing at all. See {@link LAYER_VISIBILITY_PROBES}.
    const visible = await shell.awaitLayer(mountedBase);
    if (!visible.ready) {
      if ((await ports.containerGeneration?.()) !== mountedGeneration) {
        throw new ContainerChangedDuringAttach();
      }
      throw new Error(
        `chain ${generation.base.id} store mount does not expose ${mountedBase} after `
        + `${LAYER_VISIBILITY_PROBES} probes; ${CHAIN_STORE_MOUNT} holds: `
        + `${visible.holds.length === 0 ? '(nothing)' : visible.holds}`,
      );
    }
    // The delta this generation would serve, as the STORE describes it: the
    // layer is mounted from the stored object, so the stored object's identity
    // is the one a stamp may claim. An unreferenced but complete delta — a
    // previous run crashed between the atomic PUT and the state write — is
    // adopted, as this file's header describes.
    const storedDelta = await ports.objectFacts(deltaObjectKey(generation.base.id));
    const haveDelta = generation.delta !== undefined || storedDelta !== undefined;

    // IS THIS UPPER ALREADY THIS DELTA?
    //
    // A stop does not necessarily take the container with it, and when the same
    // instance comes back its upper still holds exactly the bytes the last
    // publication archived. The stamp is what makes that provable: it is written
    // only by the commit that archived this upper, or by a copy that finished,
    // and it names the delta object it describes — so a superseded delta never
    // matches one, and a replaced container, a blank disk, has none at all. The
    // upper is asked for as well as the stamp, because a stamp beside a missing
    // upper claims nothing.
    //
    // A MATCH IS THE ONLY WAY THE UPPER SURVIVES AN ATTACH, and it is the only
    // shape in which the delta needs no layer of its own: the changed set is
    // already in the writable layer, which is what every delta commit relies on.
    const held = storedDelta !== undefined
      && (await ports.readSeedStamp()) === seedStampOf(generation.base.id, storedDelta)
      && (await shell.pathExists(upperDir));
    const composing = haveDelta && !held;

    await shell.unmountPath(DEVBOX_WORKDIR);
    await shell.unmountPath(lowerBase);
    // EVERY delta layer, not one path: the mount points are named after the
    // generations that made them, and a re-driven attach on a live container can
    // find one this attempt did not mount.
    await shell.releaseDeltaLayers();
    // CHAIN_STORE_MOUNT is deliberately NOT here. mountStore owns that
    // mountpoint, and it is already mounted read-only by the time this runs:
    // `rm -rf` on it exits non-zero, which used to short-circuit the `&&` so
    // NO directory was recreated — correctness hung on every later command
    // re-creating its own path. Worse, had the mount ever been read-write,
    // rm -rf would have deleted the chain's archives through it.
    //
    // THE UPPER IS EMPTIED HERE, before anything is mounted over it, so the
    // writable layer of a composed attach holds exactly what is written after
    // it — which is what makes "the upper is not the cumulative changed set"
    // a statement with a boundary rather than a guess.
    //
    // AN UPPER THAT HOLDS THIS DELTA IS THE ONE EXCEPTION. Emptying it would
    // throw away the delta AND every change made since the publication that
    // stamped it, then buy both back over the network.
    await shell.resetDirs(held
      ? [lowerBase, lowerDeltaRoot, workDir]
      : [lowerBase, lowerDeltaRoot, upperDir, workDir]);
    try {
      await shell.mountLayer(baseObjectKey(generation.base.id), lowerBase);
    } catch (error) {
      await layerFailed('base', { cause: error });
    }

    // THE DELTA IS A LAYER, NOT A COPY.
    //
    // MEASURED COST THIS REMOVES. The copy that used to be here read the whole
    // cumulative delta through squashfuse over the mounted store — the only full
    // read of an archive anywhere on this path — and it ran on every attach a
    // replaced container made. On the deployed benchmark the ladder leaves tens
    // of megabytes, and a wake spent its entire 300 s attach budget inside that
    // copy. Mounting the archive instead costs one `squashfuse` call whatever it
    // holds, and the bytes arrive when something reads them, which is the
    // promise the rest of this file already makes.
    //
    // A LAYER CARRIES EVERYTHING THE COPY CARRIED. `cp -a` was preserving
    // whiteout device nodes and symlinks; a mount preserves them because they
    // are simply what the archive holds, and fuse-overlayfs resolves a `0/0`
    // character device or an opaque directory in any layer it is given, not only
    // in the upper. The composition is therefore the same merged view, without
    // the pass over every byte.
    //
    // MOUNTED BEFORE THE OVERLAY, like the base: the overlay takes its lowers as
    // parameters, so both have to exist before the mount that composes them, and
    // a mounted overlay then proves the whole composition landed. That is what
    // the `already-attached` early return assumes, and it needs no durable
    // marker — idempotence is still asked of the container, not stored.
    const deltaLayer = deltaLayerMountPoint(generation.base.id);
    if (composing) {
      try {
        await shell.mountLayer(deltaObjectKey(generation.base.id), deltaLayer);
      } catch (error) {
        await layerFailed('delta', { cause: error });
      }

    }
    // NEWEST LOWER FIRST. fuse-overlayfs resolves `lowerdir` left to right, so
    // the delta must precede the base: it holds the newer version of every path
    // it names, and the whiteouts that hide what the base still has.
    await shell.overlayAttach(DEVBOX_WORKDIR, composing ? [deltaLayer, lowerBase] : [lowerBase]);
    await assertOverlayLanded(`chain ${generation.base.id}`);
    await ports.unmountStore(CHAIN_STORE_MOUNT);

    const bytes = generation.base.bytes + (generation.delta?.bytes ?? 0);
    // WHICH SHAPE THIS BOX IS IN, because the next commit's behaviour follows
    // from it: `base+delta layered` means the upper is not the cumulative
    // changed set and the first commit with anything to say collapses the chain.
    const restored = !haveDelta
      ? 'base'
      : held ? 'base+delta already in this upper' : 'base+delta layered';
    ports.log(
      `${DEVBOX_WORKDIR} attached from ${generation.base.id} `
      + `(chain, ${bytes} bytes, ${restored})`,
    );
    return {
      kind: 'attached',
      detail: `chain ${generation.base.id} ${bytes}B ${restored}`,
    };
  };

  const attachChain = async (generation: ChainGeneration): Promise<AttachOutcome> => {
    for (;;) {
      try {
        return await attachChainOnce(generation);
      } catch (error) {
        if (!(error instanceof ContainerChangedDuringAttach)) throw error;
        ports.log(
          `container changed while chain ${generation.base.id} attached; `
          + 'retrying on its replacement',
        );
      }
    }
  };

  /**
   * A box with no chain yet still gets an overlay, over an empty lower.
   *
   * THE STATE THIS REMOVES: chain mode with a plain `/workspace`. A box used to
   * be born plain, and its first checkpoint wrote `mode:'chain'` without
   * attaching anything — so from that moment every later checkpoint and every
   * quiesce hit the "not an overlay mount" gate and refused, the box could not
   * stop gracefully, it filed a checkpoint incident every interval, and
   * everything written after the base was lost when the platform evicted the
   * container. Being born with the overlay makes that state unrepresentable:
   * the changed set has somewhere to accumulate from the first write.
   *
   * It also makes a re-run of the attach harmless. A Durable Object can be
   * evicted while its container keeps running; the next operation re-drives the
   * restoration, and on a plain first generation that used to mount the base
   * OVER the caller's live tree and hide every byte written since.
   *
   * A host with no fuse-overlayfs — a plain local `wrangler dev` — cannot do
   * this, and says so by failing. That is the same host extraction exists for,
   * so the box stays plain and the first checkpoint decides its mode as before.
   */
  const attachFresh = async (): Promise<AttachOutcome> => {
    await shell.resetDirs([lowerEmpty, upperDir, workDir]);
    try {
      await shell.overlayAttach(DEVBOX_WORKDIR, [lowerEmpty]);
      await assertOverlayLanded('a fresh box');
    } catch (error) {
      ports.log(
        `${DEVBOX_WORKDIR} stays a plain directory: this host cannot attach an overlay `
        + `(${describe({ cause: error })}). The first checkpoint decides the mode.`,
      );
      return { kind: 'empty', detail: 'no chain recorded' };
    }
    return { kind: 'empty', detail: 'no chain recorded; an empty overlay is attached' };
  };

  /** A successful call is not a landed mount. Both halves are read back from the
   *  container, and each asks the question its mechanism can answer: the mount
   *  line for the mount, a direct existence probe for the upper. A live
   *  container once reported every attach step as fine while /proc/mounts held
   *  no overlay line at all, so neither half is decoration. */
  const assertOverlayLanded = async (what: string): Promise<void> => {
    if (!isOverlayMounted(await shell.readMounts(), DEVBOX_WORKDIR)) {
      throw new Error(
        `attach of ${DEVBOX_WORKDIR} for ${what} reported success, but ${DEVBOX_WORKDIR} `
        + 'is not an overlay mount.',
      );
    }
    if (!(await shell.pathExists(upperDir))) {
      throw new Error(
        `attach of ${DEVBOX_WORKDIR} for ${what} produced an overlay whose upper directory `
        + `${upperDir} does not exist, so nothing the caller writes could be checkpointed.`,
      );
    }
  };

  /**
   * Serve one candidate generation, or answer why its own bytes cannot be
   * served.
   *
   * A REFUSAL IS ALWAYS ABOUT THIS GENERATION. The integrity probe compares
   * what the record declares against what the store holds, and the layer mounts
   * are the only thing that reads an archive at all: squashfuse parses the
   * superblock, and a delta is read end to end by the seeding copy. Everything
   * else — a host with no FUSE, a store subtree that will not mount, a
   * container replaced mid-attach — is not this generation's fault and travels
   * as a throw, because trying an older generation against a broken host would
   * only fail twice and hide the reason.
   *
   * That pair is the strongest proof this path can make, and it is not a
   * content digest: a base whose bytes rot after a successful mount surfaces on
   * the read that needs them. Hashing every byte on every start is the cost
   * this strategy exists to avoid — see {@link stageAndPut}.
   */
  const serve = async (
    mode: ChainMode,
    candidate: ChainGeneration,
  ): Promise<{ served: AttachOutcome; generation: ChainGeneration } | { refusal: string }> => {
    const sound = await probe(mode, candidate);
    if (sound.refusal !== null) return { refusal: sound.refusal };
    // ADOPT a delta whose recorded size went stale, so the disagreement cannot
    // outlive this attach. A size that disagrees is a DIFFERENT archive — the
    // crash-window delta this file's header describes — so its digest is
    // adopted with it. Same size, different digest never reaches here: `probe`
    // refuses it, because that is corruption rather than supersession.
    let generation = candidate;
    if (candidate.delta !== undefined && sound.delta !== undefined
      && sound.delta.bytes !== candidate.delta.bytes) {
      const drift = sound.delta.bytes - candidate.delta.bytes;
      ports.log(
        `delta record was stale by ${drift} bytes (${Math.abs(drift) / 4096} squashfs blocks); `
        + `adopting the stored archive of ${sound.delta.bytes} bytes`,
      );
      generation = { ...candidate, delta: sound.delta };
    }
    try {
      const served = mode === 'chain'
        ? await attachChain(generation)
        : await attachExtract(generation);
      return { served, generation };
    } catch (error) {
      if (!(error instanceof LayerUnreadable)) throw error;
      return { refusal: describe({ cause: error }) };
    }
  };

  /**
   * The attach landed, so the generation the record names is PROVEN.
   *
   * Nothing older can serve this box better from here, so the retained fallback
   * becomes garbage and the slot is cleared for the next publication to fill.
   * Named before deleted, like every other generation this file drops: the
   * sweep is the next commit's, and it is re-runnable.
   *
   * One write, and only when there is something to write: a box whose current
   * generation was already proven and whose delta size was accurate leaves the
   * record untouched, which is every ordinary start.
   *
   * BEST EFFORT, LIKE EVERY OTHER NOTE ABOUT SOMETHING THAT ALREADY HAPPENED.
   * The workspace is mounted by the time this runs, so a failed write must not
   * fail the start: the container-start hook would report a failure over a
   * container that is serving correctly, and the retry would find the overlay
   * up and take the already-attached path anyway. Nothing is lost by deferring
   * it — the ids are still named, so the next attach retires the fallback and
   * the next probe re-adopts the delta's size.
   */
  const recordProven = async (record: ChainState, served: ChainGeneration): Promise<void> => {
    const adopted = served.delta?.bytes !== record.delta?.bytes
      || served.delta?.digest !== record.delta?.digest;
    if (record.fallback === undefined && !adopted) return;
    try {
      await ports.writeState({
        ...record,
        ...served,
        fallback: undefined,
        orphans: record.fallback === undefined
          ? record.orphans
          : [...(record.orphans ?? []), record.fallback.base.id],
      });
    } catch (error) {
      ports.log(
        `${DEVBOX_WORKDIR} is attached from generation ${served.base.id} and the record could `
        + `not be updated to say so, so the next attach repeats it: `
        + `${describe({ cause: error })}`,
      );
    }
  };

  /**
   * Serve the newest generation this record can prove, and publish which one it
   * was.
   *
   * A REFUSAL IS NO LONGER A DEAD END. The refused generation is stamped on the
   * record's own failure field, the retained fallback is tried, and the
   * promotion is ONE state write that swaps the two roles: the proven fallback
   * becomes the generation this box serves, and the refused one takes the
   * fallback slot. It takes the slot rather than the bin because a broken
   * generation is still a generation whose objects have exactly one name, and
   * the sweep that finally removes it runs only after its replacement has been
   * proven — the ordinary verified-attach transition, not a special case.
   *
   * PROMOTED BEFORE SERVED, and that order is the correctness. Serving first
   * and writing after leaves a window where a crash has the box running on the
   * fallback's bytes under a record that still names the generation it refused
   * — and the next checkpoint would write a delta into a generation whose base
   * is gone.
   *
   * When both generations refuse, the start fails carrying both causes and
   * NOTHING is deleted. Two bad generations are two chances for an operator;
   * one bad generation and a tidy bucket is none.
   */
  const attachStored = async (state: ChainState): Promise<AttachOutcome> => {
    // THE PERSISTED MODE IS THE CONTRACT. A chain-mode record must end as an
    // overlay or the attach throws; an extract-mode record is only legal where
    // extraction is permitted. A deployed box holding an extract record is a box
    // that took a silent fallback, and serving it would hide that a second time.
    if (state.mode === 'extract' && !ports.allowExtraction()) {
      throw new Error(
        `chain ${state.base.id} was archived by extraction, which is not permitted here. `
        + 'That record can only have come from a host that allowed it, so this box is '
        + 'refusing rather than serving a work directory whose changes are never archived.',
      );
    }
    const current = await serve(state.mode, state);
    if ('served' in current) {
      await recordProven(state, current.generation);
      return current.served;
    }
    if (state.fallback === undefined) {
      throw new Error(
        `Cannot attach ${DEVBOX_WORKDIR} from chain ${state.base.id}: ${current.refusal}. The `
        + 'record names no earlier generation to fall back to, so this box is refusing to '
        + 'start rather than serve an empty work directory. Nothing has been deleted.',
      );
    }
    const reason = `chain ${state.base.id} was refused at attach: ${current.refusal}`;
    const promoted: ChainState = {
      ...state,
      ...state.fallback,
      rev: state.rev + 1,
      // The mark described the changed set of a generation this box is not
      // serving any more, and a mark that cannot describe the upper must never
      // be able to match it: an undefined mark never does, so the next tick
      // archives rather than skips.
      upperMark: undefined,
      fallback: { base: state.base, delta: state.delta },
      lastFailure: { at: ports.now(), reason },
    };
    ports.log(`${DEVBOX_WORKDIR} ${reason}; falling back to generation ${promoted.base.id}`);
    await ports.writeState(promoted);
    const fallback = await serve(promoted.mode, promoted);
    if (!('served' in fallback)) {
      throw new Error(
        `Cannot attach ${DEVBOX_WORKDIR}: ${reason}, and the fallback generation `
        + `${promoted.base.id} cannot be served either: ${fallback.refusal}. Refusing to `
        + 'start, and deleting neither generation.',
      );
    }
    await recordProven(promoted, fallback.generation);
    ports.log(
      `${DEVBOX_WORKDIR} recovered from generation ${promoted.base.id}; `
      + `${state.base.id} is superseded and kept for cleanup`,
    );
    return {
      kind: fallback.served.kind,
      detail: `recovered ${fallback.served.detail}`,
    };
  };

  const attach = async (): Promise<AttachOutcome> => {
    const state = await ports.readState();

    // Idempotence without a marker: ask the container. The container-start hook
    // fires at least once per start, and a stored "attached" marker is exactly
    // what latched the last time. An overlay that already landed is visible in
    // /proc/mounts, which is the fact rather than a note about the fact.
    //
    // It is NOT a proof of the current generation: the overlay may have been
    // mounted from the generation a later rebase superseded, so the fallback
    // stays exactly where it is until an attach really mounts what the record
    // now names.
    if (isOverlayMounted(await shell.readMounts(), DEVBOX_WORKDIR)) {
      ports.log(`${DEVBOX_WORKDIR} already attached — attach skipped`);
      return {
        kind: 'already-attached',
        detail: state === null ? 'no chain recorded' : `chain ${state.base.id}`,
      };
    }
    if (state === null) return await attachFresh();
    return await attachStored(state);
  };

  /**
   * Build a squashfs of `sourceDir`, publish it as `key`, and return what the
   * store then holds for it.
   *
   * THE BYTES NEVER REACH THIS ISOLATE. The archive is staged on the container's
   * own disk, and the container copies it into the store through a writable,
   * prefix-scoped mount — see {@link CHAIN_PUBLISH_MOUNT} for the measurement
   * that put it there and for why the mount needs no credential. This side
   * mounts, asks the container to publish, releases the mount, and then asks the
   * STORE what it holds. Three round trips and one metadata read; no payload.
   *
   * THE RECORD DESCRIBES WHAT THE STORE HOLDS, and it is CHECKED against the
   * container's own reading of the same object rather than against the staged
   * count. Those are two independent measurements of one finished upload —
   * what the mount reports after the flush, and what the store reports for the
   * key — so a disagreement is the one failure this step can have: a flush that
   * did not carry every byte. The staged count is deliberately NOT the
   * comparison: it is taken before the copy, a deployed run recorded exactly
   * that drift (`delta archive is 702791680 bytes, state declares 700387328`)
   * and every later wake refused, and `dd` copies the file to its end whatever
   * an earlier `stat` said about it.
   *
   * NO CONTENT DIGEST IS COMPUTED HERE. There was one once: a `sha256sum` over
   * the whole staged archive, recorded by nothing and compared by nothing —
   * a full CPU pass over every byte of every checkpoint, bought for nothing.
   * What the record carries is whatever identity the STORE has for the object,
   * which for an archive written through the mount is its upload version; R2
   * mints one per upload, so a same-length replacement is still refusable. See
   * {@link layerIntegrityFailure}, which treats an absent digest as unknown
   * rather than as sound.
   */
  const stageAndPut = async (
    chainId: string,
    key: string,
    sourceDir: string,
    excludes: readonly string[],
  ): Promise<ChainLayer> => {
    const archivePath = `${stageDir}/layer.sqsh`;
    // ROOM TO WRITE IT, ASKED BEFORE WRITING IT. An archiver that fills the
    // container's disk takes the whole box down with it, and a box that dies
    // mid-checkpoint is the one shape this package exists to prevent. The
    // budget is not a constant anyone guessed: the worst case for a squashfs is
    // the UNCOMPRESSED size of what it is archiving, so the tree measures its
    // own requirement and the container reports what it has. Refusing here is a
    // returned failure, which the caller turns into an incident; it is never a
    // crash.
    //
    // STILL THE STAGING DISK, because the archive is still staged there. The
    // publication reads that file and streams it out; it does not need a second
    // copy, and mksquashfs cannot write into the mount directly — it seeks back
    // to its own superblock at the end, which is not a thing an object store's
    // filesystem can be asked to do.
    const short = await shell.stagingShortfall(sourceDir, excludes);
    if (short !== null) throw new Error(short);
    await shell.makeSquashfs(sourceDir, archivePath, excludes);
    await ports.mountStore(chainId, CHAIN_PUBLISH_MOUNT, 'write');
    let published: number;
    try {
      published = await shell.publishArchive(
        archivePath, mountedLayerPath(CHAIN_PUBLISH_MOUNT, key),
      );
    } finally {
      // RELEASED WHETHER OR NOT IT WORKED. A writable mount left behind is
      // refused by the SDK's own registry on the next publication — one binding
      // cannot be mounted twice under different access — so a failure that kept
      // the mount would turn one bad checkpoint into every later one.
      await ports.unmountStore(CHAIN_PUBLISH_MOUNT);
    }
    const landed = await ports.objectFacts(key);
    if (landed === undefined) {
      throw new Error(
        `the container published ${key} through ${CHAIN_PUBLISH_MOUNT} and the store holds no `
        + 'such object, so nothing has been recorded.',
      );
    }
    if (landed.bytes !== published) {
      throw new Error(
        `the store holds ${landed.bytes} bytes for ${key} where the container flushed `
        + `${published}. Refusing to record a layer whose upload did not carry every byte.`,
      );
    }
    return landed;
  };

  const commitExtract = async (
    previous: ChainState | null,
    version: string,
  ): Promise<CheckpointOutcome> => {
    // LOCAL DEVELOPMENT ONLY. The SDK archives the whole tree and the binding
    // moves it.
    const backup = await ports.createExtractSnapshot(
      chainBackupOptions(true, ports.archiveExcludes()),
    );
    const stored = await ports.objectFacts(baseObjectKey(backup.id));
    if (stored === undefined || stored.bytes <= 0) {
      throw new Error(`archive ${backup.id} is not sound: the object is missing or empty`);
    }
    const storedBytes = stored.bytes;
    const committed: ChainState = {
      mode: 'extract',
      rev: (previous?.rev ?? 0) + 1,
      // THE SDK WROTE THIS ARCHIVE, so its identity is whatever the store
      // itself reports — which is no digest at all when the SDK uploaded it in
      // parts, though the store's version is always there. Recording the
      // store's own answer keeps the record honest either way: absent means
      // unknown, and the probe skips the comparison it cannot make rather than
      // inventing one.
      base: { id: backup.id, ...stored },
      delta: undefined,
      at: ports.now(),
      changeVersion: version,
      upperMark: undefined,
      // The superseded archive is NAMED by the new record before anything
      // deletes it, and it is RETAINED as the fallback rather than deleted
      // outright — the same two roles the chain path publishes, decided by the
      // same policy. This path used to delete it inline, so a crash in that
      // window stranded it forever: `backups/<uuid>/` is shared by every box,
      // and an id no record carries can never be swept.
      ...(previous !== null && previous.base.id !== backup.id
        ? supersedeGeneration(previous)
        : { fallback: previous?.fallback, orphans: previous?.orphans }),
      lastFailure: undefined,
    };
    await publish(committed);
    ports.log(`${DEVBOX_WORKDIR} archived as ${backup.id} (${storedBytes} bytes, extract)`);
    return { kind: 'committed', reason: undefined, bytes: storedBytes, movedBytes: storedBytes };
  };

  /**
   * Delete every generation this box has superseded, then forget them.
   *
   * THE STATE ROW IS THE TRUTH, which is what makes this safe against the very
   * crash that created the orphan: the ids were recorded before the delete, the
   * referenced generation is never among them, and a crash mid-sweep simply
   * leaves the remainder for the next run. It cannot be done by listing —
   * `backups/<uuid>/` is a namespace shared by every box, so a sweep that
   * enumerated it would be looking at other boxes' live generations.
   */
  const sweepOrphans = async (state: ChainState): Promise<void> => {
    const orphans = state.orphans ?? [];
    if (orphans.length === 0) return;
    for (const generation of orphans) {
      await ports.deleteObjects([
        baseObjectKey(generation),
        deltaObjectKey(generation),
        metadataObjectKey(generation),
      ]);
    }
    await ports.writeState({ ...state, orphans: undefined });
    ports.log(`${orphans.length} superseded generation(s) deleted`);
  };

  /**
   * Write the record, then delete everything the new record supersedes.
   *
   * THE POINTER IS THE COMMIT, and this is the only function that crosses it.
   * `writeState(committed)` is therefore the ONLY step here that may throw: a
   * failure there committed nothing, so the caller's catch is right to stamp the
   * record it read. Every step below that line deletes bytes the committed
   * record no longer names, none of them can un-commit anything, and NONE OF
   * THEM MAY THROW — the caller's catch is bound to the PRE-COMMIT record, and
   * re-writing that over the committed pointer means, after a rebase, a record
   * naming the generation the sweep had just begun deleting: every later attach
   * then refuses on a base the store no longer holds, and `orphans` is dropped
   * so the generation this commit had just written becomes unnameable and
   * therefore unsweepable.
   *
   * So a cleanup failure is stamped on the PUBLISHED revision, and the stamp is
   * best effort — see {@link stampFailure}, which is that policy for every
   * strategy. Letting the stamp's own failure travel is the reversion this
   * boundary exists to make unrepresentable.
   *
   * The sweep is re-runnable and it runs on every commit, not just the rebase
   * that created an orphan, so the next checkpoint finishes what this one could
   * not — the stamp included, which the next failure rewrites and the next
   * commit clears.
   */
  const publish = async (
    committed: ChainState,
    cleanup?: () => Promise<void>,
  ): Promise<void> => {
    await ports.writeState(committed);
    let reason: string;
    try {
      await cleanup?.();
      await sweepOrphans(committed);
      return;
    } catch (error) {
      reason = `chain ${committed.base.id} rev ${committed.rev} is committed and its `
        + `cleanup is not: ${describe({ cause: error })}`;
    }
    ports.log(`${DEVBOX_WORKDIR} ${reason}`);
    await stampFailure(ports, committed, reason);
  };

  /**
   * Commit a delta, a first base, or a REBASE onto a fresh generation.
   *
   * `rebasing` collapses the chain: the merged work directory is archived as a
   * new base under a NEW generation id, and the old generation's objects are
   * deleted only after the new record is durable. A generation is therefore a
   * prefix that is either wholly referenced or wholly garbage, which is what
   * makes an orphan sweep possible at all and why no lifecycle rule is needed
   * to bound growth.
   */
  const commitChain = async (
    previous: ChainState | null,
    version: string,
    rebasing = false,
    upperMark?: string,
  ): Promise<CheckpointOutcome> => {
    const first = previous === null;
    const fresh = first || rebasing;
    const chainId = fresh ? crypto.randomUUID() : previous.base.id;

    // PROVE IT BEFORE WRITING IT.
    //
    // A chain the platform cannot mount is worse than extraction: it is
    // written, recorded, and then unreadable for the rest of the box's life,
    // because a box attaches the way it was checkpointed. The mode is decided
    // once, here, at the only moment it becomes permanent — and it is decided by
    // performing the mount rather than by asking the platform whether it thinks
    // it could. A capability that reports itself present and then refuses is
    // exactly the shape that produced a silent no-op on a live container.
    //
    // One mount and one unmount, once per box.
    if (first) {
      try {
        await ports.mountStore(chainId, CHAIN_STORE_MOUNT, 'read');
        await ports.unmountStore(CHAIN_STORE_MOUNT);
      } catch (error) {
        // Where extraction is not permitted, a failed proof is a FAILED
        // CHECKPOINT carrying the platform's own reason. Converting it into
        // extraction is what hid a real mount failure on a deployed probe until
        // it resurfaced as lost data two phases later.
        if (!ports.allowExtraction()) {
          throw new Error(
            'this box cannot serve a lazy layer chain and extraction is not permitted here, '
            + `so nothing has been archived: ${describe({ cause: error })}`,
            { cause: error },
          );
        }
        ports.log(
          'extraction is permitted and the lazy layer chain could not be served, so this '
          + `box archives whole trees from here: ${describe({ cause: error })}`,
        );
        return await commitExtract(previous, version);
      }
    }

    await shell.resetDirs([stageDir]);
    let layer: ChainLayer;
    if (fresh) {
      layer = await stageAndPut(
        chainId, baseObjectKey(chainId), DEVBOX_WORKDIR, ports.archiveExcludes(),
      );
    } else {
      // The upper is the path THIS strategy passed to the mount command, not one
      // re-derived from mount options: fuse-overlayfs publishes no `upperdir`, so
      // re-deriving it would find nothing and refuse every delta on the
      // production image. The mount line is still what proves an overlay exists
      // to have a changed set at all.
      if (!isOverlayMounted(await shell.readMounts(), DEVBOX_WORKDIR)) {
        throw new Error(
          `${DEVBOX_WORKDIR} is not an overlay mount, so there is no changed set to archive. `
          + 'Refusing to checkpoint rather than silently archiving the whole tree.',
        );
      }
      // THE SAME EXCLUDES AS THE BASE, and the reason is measured rather than
      // argued. This used to pass `[]`, on the reasoning that "an exclude here
      // would drop a file the caller really did write" — sound in isolation and
      // wrong in combination, because it left the policy applied to ONE side of
      // two comparisons.
      //
      // It delivered no saving: a base excludes `node_modules`, and the delta
      // then carried it again on EVERY tick, which is the archive that actually
      // repeats. The policy's whole promise was kept exactly once.
      //
      // And it cost, through the rebase trigger. `shouldRebase` asks
      // `delta > k * base`, so an excludes-applied base (small) against a
      // delta measured without them (large) satisfies it essentially always: a
      // full re-archive at every quiesce, which the unexcluded arm never
      // performs. Verdict-2 measured the excluded chain arm at 1.42x tick time
      // and 1.34x class-A of the plain one — the excludes were paying for
      // rebases, not for filtering.
      //
      // Applying them to both sides makes the two archives commensurable and
      // finally delivers the saving. It also makes durability HONEST: a tree
      // the base drops was already lost at the next rebase, so "durable in the
      // delta" was true only until one happened. A box whose `dist/` really is
      // the work overrides `archiveExcludes` and keeps it in both.
      layer = await stageAndPut(
        chainId, deltaObjectKey(chainId), upperDir, ports.archiveExcludes(),
      );
    }

    // State first, cleanup second. A delta's key was replaced by a publication
    // that is complete or absent — the object becomes visible only when the
    // store finishes taking it — and a rebase wrote a whole new generation and
    // leaves the old one standing until the record naming its replacement is
    // durable, so a crash leaves two generations and never zero.
    const committed: ChainState = {
      mode: 'chain',
      rev: (previous?.rev ?? 0) + 1,
      base: fresh ? { id: chainId, ...layer } : previous.base,
      delta: fresh ? undefined : layer,
      at: ports.now(),
      changeVersion: version,
      upperMark,
      // A REBASE SUPERSEDES A GENERATION, so the two roles move — see
      // {@link supersedeGeneration}, which is the whole retention policy. A
      // delta commit stays inside the generation it is relative to and moves
      // neither role.
      ...(rebasing && previous !== null
        ? supersedeGeneration(previous)
        : { fallback: previous?.fallback, orphans: previous?.orphans }),
      lastFailure: undefined,
    };
    await publish(committed, async () => {
      await ports.exec(`rm -rf ${shellPath(stageDir)}`);
    });
    // THIS UPPER *IS* THE DELTA THAT WAS JUST PUBLISHED, so the stamp says so
    // where the next attach reads it: the archive was built FROM this upper, so
    // copying the object back over it would move the whole changed set to
    // reproduce bytes already on the disk. A base or a rebase stamps nothing —
    // its generation has no delta object at all, and the next attach resets the
    // upper, which is what a fresh base requires.
    if (!fresh && committed.delta !== undefined) {
      await stampSeededUpper(chainId, committed.delta);
    }
    ports.log(
      `${DEVBOX_WORKDIR} ${rebasing ? 'rebase' : first ? 'base' : 'delta'} ${chainId} `
      + `(${layer.bytes} bytes)`,
    );
    return {
      kind: 'committed',
      reason: undefined,
      bytes: committed.base.bytes + (committed.delta?.bytes ?? 0),
      // The landed count from this commit's own upload, which the chain knows
      // exactly because it has a commit boundary. Not derivable from `bytes`:
      // a rebase supersedes a generation, so held bytes can fall while this
      // rises.
      movedBytes: layer.bytes,
    };
  };

  const checkpoint = async (kind: CheckpointKind): Promise<CheckpointOutcome> => {
    const idle = { reason: undefined, bytes: undefined, movedBytes: 0 };
    if (!ports.containerRunning()) {
      return { kind: 'skipped', reason: 'container is not running', bytes: undefined, movedBytes: 0 };
    }
    const state = await ports.readState();

    // ATTACHMENT COMES FIRST, ahead of the change gate, and this order is the
    // point. A chain that already has a base keeps its changed set in the
    // overlay's upper directory; with no overlay there is no changed set, so
    // every later answer would be about the wrong thing. A live container
    // answered a forced checkpoint 'unchanged' while its work directory was not
    // attached at all — a broken box wearing a healthy answer. Asked here, that
    // box reports a failure, which is what it is.
    const procMounts = await shell.readMounts();
    const overlayMounted = isOverlayMounted(procMounts, DEVBOX_WORKDIR);
    if (state !== null && state.mode === 'chain' && !overlayMounted) {
      return await recordCheckpointFailure(
        ports,
        state,
        `${DEVBOX_WORKDIR} is not an overlay mount, so chain ${state.base.id} has no changed `
        + 'set to archive. Refusing to report a checkpoint for a work directory that is not '
        + 'attached.',
      );
    }

    let change: ChangeStatus;
    let version: string;
    try {
      const checked = await ports.checkChanges(DEVBOX_WORKDIR, state?.changeVersion);
      change = checked.status;
      version = checked.version;
    } catch (error) {
      return await recordCheckpointFailure(ports, state, `checkChanges failed: ${describe({ cause: error })}`);
    }

    // THE CHANGE GATE NEEDS SOMETHING TO BE RELATIVE TO.
    //
    // `checkChanges` answers "has this path changed since the version you hold".
    // A box that has never checkpointed holds no version, and the SDK's answer
    // to a call with no `since` is `unchanged`: it is ESTABLISHING a baseline,
    // not reporting on one. Consulting the gate there is how a fresh box writes
    // files, stops, and saves nothing while every call reports success — which
    // is what a live container did, answering a forced checkpoint `unchanged`
    // seconds after a file was created.
    //
    // So with no baseline, content IS the change, and the only question left is
    // whether there is any content at all.
    // THE CHANGED SET IS THE UPPER, so that is what the skip gate asks about.
    //
    // A chain-mode box with an overlay archives `upperDir`, and the SDK's change
    // check was being asked about the merged `/workspace` instead. On a deployed
    // run it answered `unchanged` for five consecutive ticks while npm wrote 400
    // MiB into that upper, and the next workload's first tick then committed 487
    // MiB of it — five ticks of real work that only survived because a later
    // tick happened to catch it. A tick that CANNOT DECIDE must commit: an
    // unreadable fingerprint is empty, an empty fingerprint never matches, and
    // the gate falls through to archiving.
    const mark = overlayMounted ? await shell.upperFingerprint() : '';
    if (overlayMounted) {
      // IS THE CUMULATIVE CHANGED SET SPREAD ACROSS TWO LAYERS?
      //
      // A wake that composed the delta as a layer left the upper empty, so the
      // upper is everything written SINCE the attach and archiving it as the
      // delta would replace the one durable changed set with a fragment of it.
      // The layer's own mount point names the generation it serves, so this is
      // the same `/proc/mounts` read the overlay gate above already made.
      const layered = state !== null && deltaLayerServed(procMounts, state.base.id);
      if (mark !== '' && mark === state?.upperMark) {
        return { kind: 'skipped', ...idle, reason: 'work directory is unchanged' };
      }
      // NOTHING WRITTEN SINCE A COMPOSED ATTACH IS NOTHING TO SAY. The collapse
      // below archives the merged view, which is the whole workspace, so a box
      // that woke and did nothing must not pay for one: the durable chain
      // already holds every byte the layers serve. An empty upper is the proof —
      // a deletion leaves a whiteout in it, and a metadata change copies its
      // file up, so "empty" cannot hide a change.
      if (layered && (await ports.countEntries(upperDir)) === 0) {
        return { kind: 'skipped', ...idle, reason: 'nothing has been written since the attach' };
      }
      if (kind === 'tick'
        && !shouldCheckpoint('changed', state?.at ?? 0, ports.now(), ports.checkpointIntervalMs())) {
        return { kind: 'skipped', ...idle, reason: 'within the minimum checkpoint interval' };
      }
      try {
        // COLLAPSE RATHER THAN APPEND while a delta is served as a layer. The
        // merged view is the one tree that expresses what the layer and the
        // upper hold together, and archiving it as a fresh base is how the
        // record gets back to a shape whose upper IS the changed set. Every
        // commit after it is an ordinary delta again.
        return await commitChain(state, version, layered || shouldRebase(state, kind), mark);
      } catch (error) {
        return await recordCheckpointFailure(ports, state, describe({ cause: error }));
      }
    }
    const comparable = state?.changeVersion !== undefined;
    const effective: ChangeStatus = comparable ? change : 'changed';
    if (comparable && change === 'unchanged') {
      // ADVANCE THE WATERMARK, AND IT IS ADVISORY BY CONSTRUCTION. The next
      // check is then relative to now. The hazard is the opposite one, which is
      // why it is stated in the negative: a change this code DECLINED to archive
      // must never advance it, or it is forgotten.
      //
      // So a rejection here is a console line and the skip still stands. An
      // unadvanced watermark makes the next check ask about a WIDER window,
      // which can only over-report change, and over-reporting means archiving —
      // the safe direction; a token the platform has lost answers `resync`,
      // which this strategy already treats as changed. Answering `failed`
      // instead would be a false claim about work at risk, and it would refuse
      // the quiesce this may be running under: `Devbox.quiesce` declines to
      // stop a box on a failed checkpoint, so a flaky durable write would hold
      // open a box whose work directory has nothing to archive.
      try {
        await ports.writeState({ ...state, changeVersion: version });
      } catch (error) {
        ports.log(
          `${DEVBOX_WORKDIR} is unchanged and its change watermark could not be advanced, so `
          + `the next check asks about a wider window: ${describe({ cause: error })}`,
        );
      }
      return { kind: 'skipped', ...idle, reason: 'work directory is unchanged' };
    }
    if (!comparable && (await ports.countEntries(DEVBOX_WORKDIR)) === 0) {
      return { kind: 'skipped', ...idle, reason: 'work directory is empty' };
    }
    // The interval is an efficiency rule, so only a periodic tick obeys it. A
    // quiesce is the last chance these bytes have.
    if (kind === 'tick'
      && !shouldCheckpoint(effective, state?.at ?? 0, ports.now(), ports.checkpointIntervalMs())) {
      return { kind: 'skipped', ...idle, reason: 'within the minimum checkpoint interval' };
    }

    try {
      // A box attaches the way it was checkpointed, so the mode comes from the
      // record. A box with no record has its mode DECIDED by commitChain, which
      // proves the platform can serve a chain before writing one.
      if (state?.mode === 'extract') return await commitExtract(state, version);
      return await commitChain(state, version, shouldRebase(state, kind));
    } catch (error) {
      return await recordCheckpointFailure(ports, state, describe({ cause: error }));
    }
  };

  const discard = async (): Promise<void> => {
    const state = await ports.readState();
    if (state === null) return;
    // Objects first, then the pointer. Reversed, a crash orphans both: nothing
    // would name the objects and nothing would delete them.
    // Every generation the record still NAMES goes with it — the retained
    // fallback and the orphans a rebase crash left behind included. clearState
    // erases the only record naming them, and `backups/<uuid>/` is shared by
    // every box, so a leak here was permanent by construction: no sweep may
    // ever list them.
    await ports.deleteObjects([
      state.base.id,
      ...(state.fallback === undefined ? [] : [state.fallback.base.id]),
      ...(state.orphans ?? []),
    ].flatMap(
      (generation) => [
        baseObjectKey(generation),
        deltaObjectKey(generation),
        metadataObjectKey(generation),
      ],
    ));
    await ports.clearState();
  };

  return { attach, checkpoint, discard };
}

function shellPath(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

function shellPaths(paths: readonly string[]): string {
  return paths.map(shellPath).join(' ');
}

/**
 * The archiver command: stage the exclude list, build the squashfs, and report
 * `<exit> <bytes>`.
 *
 * ONE COMMAND, and every part of that is a defect this file already paid for.
 * Build and measure were two execs, and a spot container can be replaced
 * between two RPCs: the build reported exit 0 on one container and the stat
 * found no file on the next, which surfaced as "the archiver did not land"
 * three times in one deployed run while mksquashfs had in fact succeeded. The
 * exclude list is written here for the same reason — a list staged by an
 * earlier exec is a list the next container does not have, and mksquashfs would
 * then archive a tree with no policy applied.
 *
 * PATTERNS ARE DATA, NEVER SYNTAX. The list travels as base64 and is decoded
 * container-side, so a pattern containing a quote, a space or a semicolon
 * cannot become shell syntax. `-wildcards` is what makes a glob a glob, and
 * `-ef` is the only exclude form that can carry the non-anchored lines
 * {@link archiveExcludeFile} writes.
 *
 * STDERR IS KEPT by the caller. It used to go to /dev/null, so the one run that
 * needed mksquashfs's own words to explain itself did not have them.
 */
export function archiveCommand(input: {
  sourceDir: string;
  archivePath: string;
  excludeFile: string;
  excludes: readonly string[];
}): string {
  let bytes = '';
  for (const byte of new TextEncoder().encode(archiveExcludeFile(input.excludes))) {
    bytes += String.fromCharCode(byte);
  }
  const encoded = btoa(bytes);
  return `printf %s ${shellPath(encoded)} | base64 -d > ${shellPath(input.excludeFile)} `
    + `&& /usr/bin/mksquashfs ${shellPath(input.sourceDir)} ${shellPath(input.archivePath)} `
    + `-comp zstd -no-progress -wildcards -ef ${shellPath(input.excludeFile)} >/dev/null; `
    + `rc=$?; printf '%s %s' "$rc" `
    + `"$(stat -c %s ${shellPath(input.archivePath)} 2>/dev/null || echo 0)"`;
}

/**
 * Copy a staged archive onto the store mount, flush it, and print
 * `<exit> <bytes>`.
 *
 * ONE COMMAND, for the reason {@link archiveCommand} states: a spot container
 * can be replaced between two RPCs, so the write and the read-back of what
 * landed cannot be two of them.
 *
 * `conv=fsync` IS THE CORRECTNESS. s3fs uploads on flush, and a flush that
 * fails has nowhere to report itself unless something asks: a shell redirect
 * drops the close error entirely, and an unmount can return before the upload
 * finishes. With the fsync inside the command, a store that did not take the
 * bytes is a non-zero exit HERE — before the record names the object, and
 * before the mount is released.
 *
 * `bs=4M` is a read/write size, not a buffer this side holds: the bytes never
 * leave the container. It is large enough that s3fs sees whole multipart parts
 * — its default part size on an R2 mount is 5 MB — and small enough to be
 * ordinary container memory.
 */
export function publishCommand(input: { archivePath: string; mountedPath: string }): string {
  return `dd if=${shellPath(input.archivePath)} of=${shellPath(input.mountedPath)} `
    + 'bs=4M conv=fsync; '
    + `rc=$?; printf '%s %s' "$rc" `
    + `"$(stat -c %s ${shellPath(input.mountedPath)} 2>/dev/null || echo 0)"`;
}

/**
 * The uncompressed size of what an archive of `sourceDir` would hold, as a
 * command that prints one number.
 *
 * THE SAME MATCHER AS THE ARCHIVE, expressed in the only vocabulary `find` has.
 * {@link archiveExcludeFile} writes each pattern twice, anchored to the source
 * directory and non-anchored, so the policy means "at any depth". Here that is
 * two `-path` predicates per pattern: one anchored at `<source>` for the top
 * level, and one under a wildcard segment for everything below it. find's
 * `-path` glob lets a wildcard cross a directory separator, so the pair covers
 * every depth exactly as the exclude file does. `-prune` then keeps the walk
 * out of an excluded tree rather than merely skipping its files, which is what
 * makes the number the archive's own worst case.
 *
 * A failed walk prints 0, which reads as "no requirement" and lets the
 * checkpoint proceed: refusing every checkpoint because a probe could not walk
 * would lose more work than a full disk would.
 */
export function archiveSizeCommand(sourceDir: string, excludes: readonly string[]): string {
  const pruned: string[] = [];
  for (const pattern of excludes) {
    const normalized = normalizeArchiveExclude(pattern);
    if (normalized === null) continue;
    pruned.push(
      `-path ${shellPath(`${sourceDir}/${normalized}`)} -prune -o`,
      `-path ${shellPath(`${sourceDir}/*/${normalized}`)} -prune -o`,
    );
  }
  return `find ${shellPath(sourceDir)} ${pruned.join(' ')} -type f -printf '%s\\n' 2>/dev/null `
    + `| awk '{t+=$1} END {print t+0}'`;
}

/**
 * The skip-gate fingerprint command over `sourceDir`.
 *
 * The prior count/bytes/newest-mtime summary could collide for distinct trees:
 * a rename preserved every field, and a same-path rewrite whose mtime was
 * restored preserved them too — both skipped forever while content changed.
 * This hashes a canonical per-path record of inode, type, mode, size,
 * sub-second mtime, sub-second CHANGE time, symlink target and path instead.
 * It stays O(entries), not O(bytes), while any of those moves changes the mark;
 * an mtime restoration cannot hide a write, because the write itself moved
 * ctime.
 *
 * A failed walk returns no mark. Callers must treat that as undecidable and
 * checkpoint; `pipefail` prevents `sort` or `sha256sum` from hiding `find`'s
 * failure.
 */
export function upperFingerprintCommand(sourceDir: string): string {
  const walk = `find ${shellPath(sourceDir)} -mindepth 1 `
    + `-printf '%i\\0%y\\0%m\\0%s\\0%T@\\0%C@\\0%l\\0%p\\0' 2>/dev/null `
    + '| LC_ALL=C sort -z | sha256sum | cut -c1-64';
  return `bash -o pipefail -c ${shellPath(walk)}`;
}
