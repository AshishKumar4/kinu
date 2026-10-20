/**
 * Whom a program's request leaves Kinu for: one model for every egress, the container's, a Nimbus workspace's, a
 * codemode program's and a slate's (audit SelfishJaguar #6). The workspace's owner, or a share's viewer; what each may do
 * with a request is decided here, and by nothing about which egress carries it.
 */

export type EgressPrincipal =
  /** The owner's: an agent's program, the owner's own process or slate. `ownerUserId` null: a workspace with no owner yet. */
  | { readonly as: 'owner'; readonly workspace: string; readonly actorId: string | null; readonly ownerUserId: string | null }
  /** A share's viewer's: a process they started, a program run for them, a slate shared with others. */
  | { readonly as: 'viewer'; readonly workspace: string; readonly actorId: string | null };

export interface EgressAuthority {
  /** Whose secrets a request naming a placeholder spends, for which workspace; null: none, and such a request is refused. */
  readonly vault: { readonly ownerUserId: string; readonly workspaceName: string } | null;
  /** The workspace's own previews open with the workspace's pass, as its owner's. */
  readonly selfPass: boolean;
  /** Its GitHub work is recorded as the owner's, for the agent it names. */
  readonly recordsGitHub: boolean;
}

export function egressAuthority(principal: EgressPrincipal): EgressAuthority {
  if (principal.as === 'viewer') return { vault: null, selfPass: false, recordsGitHub: false };

  return {
    vault: principal.ownerUserId === null ? null : { ownerUserId: principal.ownerUserId, workspaceName: principal.workspace },
    selfPass: true,
    recordsGitHub: true,
  };
}
