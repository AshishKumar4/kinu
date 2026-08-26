export const R2_OPERATION_NAMES = [
  'head', 'get', 'put', 'delete', 'list',
  'createMultipartUpload', 'resumeMultipartUpload', 'uploadPart', 'abort', 'complete',
] as const;
export type R2OperationName = (typeof R2_OPERATION_NAMES)[number];
export type R2OperationTally = Partial<Record<R2OperationName, number>>;

/** R2 operation billing classes. Deletes and aborts are counted even though
 * Cloudflare bills them as free operations. */

export const R2_CLASS_A_OPERATIONS = [
  'put', 'list', 'createMultipartUpload', 'resumeMultipartUpload', 'uploadPart', 'complete',
] as const satisfies readonly R2OperationName[];
export const R2_CLASS_B_OPERATIONS = [
  'get', 'head',
] as const satisfies readonly R2OperationName[];
export const R2_CLASS_FREE_OPERATIONS = [
  'delete', 'abort',
] as const satisfies readonly R2OperationName[];
