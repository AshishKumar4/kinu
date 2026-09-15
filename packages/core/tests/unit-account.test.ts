/**
 * The account read model: who needs the wizard, and what a display name may
 * be. Both are pure answers the gate and the naming surfaces share, so both
 * run on the same functions.
 */
import { describe, expect, test } from 'bun:test';
import {
  APP_ROUTES, DISPLAY_NAME_MAX, displayNameProblem, needsOnboarding,
  ONBOARDING_STEPS, routeTemplateOf,
} from '../src/index';

describe('needsOnboarding', () => {
  test('a failed profile read never locks the app behind the wizard', () => {
    expect(needsOnboarding(null)).toBe(false);
  });

  test('no stamp means the wizard', () => {
    expect(needsOnboarding({ onboardedAt: null })).toBe(true);
  });

  test('a stamped account is done', () => {
    expect(needsOnboarding({ onboardedAt: 1_700_000_000_000 })).toBe(false);
  });
});

describe('ONBOARDING_STEPS', () => {
  test('the wizard has its four steps in order', () => {
    expect(ONBOARDING_STEPS.map((s) => s.id)).toEqual(['profile', 'model', 'connections', 'showcase']);
  });
});

describe('displayNameProblem', () => {
  test('an empty name and a name of spaces are refusals', () => {
    expect(displayNameProblem('')).toBe('Enter a name.');
    expect(displayNameProblem('   ')).toBe('Enter a name.');
  });

  test('padding is not part of the name', () => {
    expect(displayNameProblem('  Ashish Rao  ')).toBeNull();
  });

  test('the limit holds: 80 is usable, 81 is a refusal', () => {
    expect(displayNameProblem('x'.repeat(DISPLAY_NAME_MAX))).toBeNull();
    expect(displayNameProblem('x'.repeat(DISPLAY_NAME_MAX + 1))).toBe(`Keep the name under ${DISPLAY_NAME_MAX} characters.`);
  });
});

describe('the welcome route', () => {
  test('is a template a render-failure report may carry', () => {
    expect(routeTemplateOf('/welcome')).toBe(APP_ROUTES.welcome);
    expect(APP_ROUTES.welcome).toBe('/welcome');
  });
});
