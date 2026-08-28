/**
 * The instruction-trust contract, as types alone (KINU-N028).
 *
 * A leaf on purpose, importing nothing. The prompt-assembly layer needs to SAY
 * what trust a file has and to ASK for a verdict; it must not reach the trust
 * authority's implementation to do either, because that authority owns the
 * digest primitive and lives in the safety layer. Splitting the vocabulary out
 * here is what lets `prompting/agents-md.ts` and `skills/loader.ts` speak it
 * without importing across a layer boundary — the layer gate enforces exactly
 * that, and caught this when the types lived beside the store.
 */

/** What placement a set of instruction bytes has earned. */
export type InstructionTrust = 'builtin' | 'approved' | 'unverified';

/** The two answers a lookup can give about bytes that are not built in. */
export type VerifiedInstructionTrust = Extract<InstructionTrust, 'approved' | 'unverified'>;

/**
 * How a caller answers "has the owner approved THESE bytes at THIS path".
 * `InstructionApprovalStore.trustOf` satisfies it.
 *
 * It takes CONTENT, not a digest, so only the authority ever knows how bytes
 * become a digest. Assembly hands over the bytes it just read and gets back a
 * verdict; it never computes, stores or compares a hash.
 *
 * Every discovery path takes one, and none of them takes it optionally: a
 * default would be a second, untrusted-by-omission code path, which is exactly
 * the shape of the bug this exists to close.
 */
export type InstructionTrustResolver =
  (path: string, content: string) => VerifiedInstructionTrust;
