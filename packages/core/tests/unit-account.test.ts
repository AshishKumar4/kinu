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

  test('a fresh account — no stamp, no workspace — lands on the wizard', () => {
    expect(needsOnboarding({ onboardedAt: null, workspaceCount: 0 })).toBe(true);
  });

  test('an account that owns a workspace is established, stamp or not', () => {
    expect(needsOnboarding({ onboardedAt: null, workspaceCount: 1 })).toBe(false);
  });

  test('a stamped account is done even with no workspace yet', () => {
    expect(needsOnboarding({ onboardedAt: 1_700_000_000_000, workspaceCount: 0 })).toBe(false);
  });
});

describe('ONBOARDING_STEPS', () => {
  test('the wizard has its three steps in order', () => {
    expect(ONBOARDING_STEPS.map((s) => s.id)).toEqual(['profile', 'model', 'showcase']);
  });

  test('steps carry titles and no ledes', () => {
    for (const step of ONBOARDING_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect('lede' in step).toBe(false);
    }
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

describe('the Drive routes', () => {
  test('a folder below /drive reports as the splat, and the public blueprint page keeps its own template', () => {
    expect(routeTemplateOf('/drive')).toBe(APP_ROUTES.drive);
    expect(routeTemplateOf('/drive/blueprints')).toBe(APP_ROUTES.driveFolder);
    expect(routeTemplateOf('/drive/projects/ops/deploy')).toBe(APP_ROUTES.driveFolder);
    expect(routeTemplateOf('/shared/blueprint/abc')).toBe(APP_ROUTES.sharedBlueprint);
    expect(routeTemplateOf('/drivex/y')).toBe('/unmatched');
  });
});
