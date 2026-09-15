/**
 * The account's first-run read model.
 * One row in `user_onboarding` is the onboarding stamp: absent means the
 * wizard never ran to `finish()`, present carries the timestamp. The gate's
 * second input is the workspace roster's size, counted in the same profile
 * read, so the two questions every surface asks — the gate's yes/no
 * (`needsOnboarding`) and the wizard's step list (`ONBOARDING_STEPS`) — plus
 * the display-name constraint every naming surface enforces
 * (`displayNameProblem`) live in core and are answered the same way
 * everywhere.
 */
export interface AccountOnboarding {
  readonly onboardedAt: number | null;
  /** How many workspaces the account's roster lists. */
  readonly workspaceCount: number;
}

/** Whether this account must land on the setup wizard: only a new account —
 *  no onboarding stamp and not one workspace — is gated. A null profile — the
 *  read failed — never locks the app behind the wizard: the profile row
 *  exists for every signed-in account and a missing answer is a read failure,
 *  not a new account. */
export function needsOnboarding(profile: AccountOnboarding | null): boolean {
  return profile !== null && profile.onboardedAt === null && profile.workspaceCount === 0;
}

/** The wizard's steps in order — the indicator and the sliding panel both
 *  read this list, so the two can never disagree about how many there are. */
export const ONBOARDING_STEPS = [
  { id: 'profile', title: 'Your name' },
  { id: 'model', title: 'Model and providers' },
  { id: 'showcase', title: 'What Kinu does' },
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]['id'];

/** The longest display name the account accepts. Shared by the route's 400,
 *  the UserDO's own refusal, and the field's maxLength. */
export const DISPLAY_NAME_MAX = 80;

/** The one refusal a display name can earn, or null when it is usable. Both
 *  surfaces that accept a name — the route and the UserDO — run this so a
 *  client-side check and the object's own constraint cannot disagree. */
export function displayNameProblem(input: string): string | null {
  const name = input.trim();

  if (name === '') return 'Enter a name.';

  if (name.length > DISPLAY_NAME_MAX) return `Keep the name under ${DISPLAY_NAME_MAX} characters.`;

  return null;
}

/**
 * Delete-account confirmation — the typed phrase is the account's own email.
 * Case-insensitive, trimmed; anything else means the confirm step stays armed.
 * The comparison is the contract shared by the form that asks and the route
 * that checks, so it is a rule rather than a line of JSX or a `===`.
 */
export function confirmsAccountDelete(confirm: string, email: string): boolean {
  return confirm.trim().toLowerCase() === email.trim().toLowerCase();
}
