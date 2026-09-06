/**
 * Matches a whole string by scanning forward. Compiling stored `*` patterns to repeated
 * `.*` groups permits exponential regex backtracking on a failed match.
 */
export declare function matchesGlob(pattern: string, value: string): boolean;
