import { PLATFORM_LIMITS } from '../platform-limits';

/** A quarter of the 32 MiB structured-clone ceiling (`do.facet.rpc_bytes`), leaving clone headroom. */
export const FILE_CHUNK_BYTES = PLATFORM_LIMITS['do.facet.rpc_bytes'].value / 4;
