export type PublicationWriteObserver = (key: string, bytes: number) => Promise<void>;

/** Boot configuration selects the instrument before any object request starts. */
export function publicationBucket(
  bucket: R2Bucket,
  enabled: string | undefined,
  observe: PublicationWriteObserver,
): R2Bucket {
  if (enabled !== '1') return bucket;
  const multipart = (upload: R2MultipartUpload): R2MultipartUpload => ({
    key: upload.key,
    uploadId: upload.uploadId,
    uploadPart: (part, value, options) => upload.uploadPart(part, value, options),
    abort: () => upload.abort(),
    complete: async (parts) => {
      const written = await upload.complete(parts);
      await observe(upload.key, written.size);
      return written;
    },
  });
  const delegate: R2Bucket = Object.create(bucket);
  return Object.assign(delegate, {
    put: async (
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
      options?: R2PutOptions,
    ) => {
      const written = await bucket.put(key, value, options);
      if (written !== null) await observe(key, written.size);
      return written;
    },
    createMultipartUpload: async (key: string, options?: R2MultipartOptions) =>
      multipart(await bucket.createMultipartUpload(key, options)),
    resumeMultipartUpload: (key: string, uploadId: string) => multipart(bucket.resumeMultipartUpload(key, uploadId)),
  });
}
