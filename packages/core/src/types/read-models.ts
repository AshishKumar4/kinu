import { PLATFORM_CATALOG } from '../platform-catalog';

/** A quarter of the 32 MiB structured-clone ceiling (`do.facet.rpc_bytes`), leaving clone headroom. */
export const FILE_CHUNK_BYTES = PLATFORM_CATALOG['do.facet.rpc_bytes'].limit.value / 4;
