/**
 * Every refusal the merkle-pack candidate makes, tagged so callers can branch
 * on the cause. Decode failures carry the underlying error as `cause`.
 */

export class MerklePackError extends Error {
  constructor(
    readonly reason:
      | 'hostile-path'
      | 'ino-reuse'
      | 'inconsistent-hardlink'
      | 'invalid-parameter'
      | 'corrupt-root'
      | 'corrupt-index'
      | 'missing-digest'
      | 'node-digest-mismatch'
      | 'chunk-digest-mismatch'
      | 'malformed-node'
      | 'no-entry'
      | 'not-a-directory'
      | 'is-a-directory'
      | 'symlink-refused'
      | 'symlink-traversal'
      | 'invalid-range',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MerklePackError';
  }
}
