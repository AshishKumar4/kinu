/** The account's first-run read model: the onboarding gate, the wizard's steps, and display-name
 * rules, answered the same way everywhere. */
export interface AccountOnboarding {
  readonly onboardedAt: number | null;
  readonly workspaceCount: number;
}

/** Only a new account (no onboarding stamp, no workspace) is gated. A null profile is a read failure,
 * never a new account, so it never locks the app behind the wizard. */
export function needsOnboarding(profile: AccountOnboarding | null): boolean {
  return profile !== null && profile.onboardedAt === null && profile.workspaceCount === 0;
}

/** Read by both the indicator and the sliding panel so they agree on the count. */
export const ONBOARDING_STEPS = [
  { id: 'profile', title: 'Your name' },
  // Offered only where the deployment has mail and the person may have an address but has none.
  { id: 'mail', title: 'Your email address' },
  { id: 'providers', title: 'Connect a provider' },
  { id: 'model', title: 'Your default model' },
  { id: 'search', title: 'Web search' },
  { id: 'tools', title: 'Connect your tools' },
  { id: 'assistant', title: 'A personal assistant' },
  { id: 'showcase', title: 'What Kinu does' },
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]['id'];

/** Shared by the route's 400, the UserDO's refusal, and the field's maxLength. */
export const DISPLAY_NAME_MAX = 80;

/** Why `input`, trimmed, cannot be a name of at most `max` characters, or null. */
export function nameProblem(input: string, max: number): string | null {
  const name = input.trim();

  if (name === '') return 'Enter a name.';

  if (name.length > max) return `Keep the name under ${max} characters.`;

  return null;
}

/** Run by both the route and the UserDO so client and object constraints cannot disagree. */
export function displayNameProblem(input: string): string | null {
  return nameProblem(input, DISPLAY_NAME_MAX);
}

/** The typed phrase is the account's email, case-insensitive and trimmed; shared by form and route. */
export function confirmsAccountDelete(confirm: string, email: string): boolean {
  return confirm.trim().toLowerCase() === email.trim().toLowerCase();
}
