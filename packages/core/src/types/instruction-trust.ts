/** Instruction-trust contract as types alone (KINU-N028); a leaf so prompting avoids the safety layer. */

export type InstructionTrust = 'builtin' | 'approved' | 'unverified';

export type VerifiedInstructionTrust = Extract<InstructionTrust, 'approved' | 'unverified'>;

/**
 * Takes content, not a digest, so only the authority knows how bytes become one. Required on every
 * discovery path: a default would be an untrusted-by-omission path.
 */
export type InstructionTrustResolver =
  (path: string, content: string) => VerifiedInstructionTrust;
