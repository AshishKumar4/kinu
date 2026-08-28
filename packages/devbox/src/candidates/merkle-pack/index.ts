/**
 * Public surface of the merkle-pack/v1 storage candidate. One builder, one
 * reader: buildMerklePack turns an AuditedCapture into a shared
 * CandidatePublicationPlan; openMerklePack reads a committed root back through
 * digest-bearing range intents.
 */

export { MerklePackError } from './errors';

export type { ChunkParams } from './chunk';
export { DEFAULT_CHUNK_PARAMS, validateChunkParams } from './chunk';

export {
  DEFAULT_MAX_PACK_BYTES,
  buildMerklePack,
  parentFromPublishedParent,
} from './build';
export type {
  BuildOptions,
  BuildStats,
  MerklePackBuild,
  PackIndex,
  PackLocation,
  PackLocator,
  PublishedMerkleParent,
} from './build';

export { openMerklePack } from './read';
export type {
  MerkleFileExtent,
  MerklePackReader,
  MerklePackView,
  RangeIdentity,
  StatInfo,
} from './read';

export { MERKLE_PACK_FORMAT } from './wire';
export type { MerklePackRoot } from './wire';
