/** Shared read-model transfer contracts, declared at the platform layer: the
 *  execution plane chunks uploads to the same ceiling the file read-model
 *  enforces, without importing the read-model. */

import { PLATFORM_CATALOG } from '../platform-catalog';

/** One Worker↔actor RPC payload of a chunked file transfer. A quarter of the
 *  catalogued 32 MiB structured-clone ceiling (`do.facet.rpc_bytes`) — far
 *  under it, with headroom for clone metadata, and small enough that one
 *  chunk never dominates isolate memory. */
export const FILE_CHUNK_BYTES = PLATFORM_CATALOG['do.facet.rpc_bytes'].limit.value / 4;
